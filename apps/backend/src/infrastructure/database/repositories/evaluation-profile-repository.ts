import {
  evaluationProfileSchema,
  idSchema,
  timestampSchema,
  type EvaluationProfile,
} from '@orgscience/contracts';
import { z } from 'zod';

import {
  failure,
  success,
  type EvaluationProfileRepository as EvaluationProfileRepositoryPort,
  type IdempotentWrite,
  type RepositoryResult,
} from '../../../application/persistence/index.js';
import { corruptData, mapDatabaseError } from './repository-errors.js';
import type { SqlExecutor, SqlQueryResult } from './sql.js';

const databaseTimestampSchema = z
  .union([z.string(), z.date()])
  .transform((value) => (typeof value === 'string' ? value : value.toISOString()))
  .pipe(timestampSchema);

const profileRowSchema = z.strictObject({
  profile_id: idSchema,
  name: z.string(),
  is_default: z.boolean(),
  profile: z.unknown(),
  created_at: databaseTimestampSchema,
  updated_at: databaseTimestampSchema,
});

const identityRowSchema = z.strictObject({ profile_id: idSchema });

const PROFILE_COLUMNS = 'profile_id, name, is_default, profile, created_at, updated_at' as const;

export class PostgresEvaluationProfileRepository implements EvaluationProfileRepositoryPort {
  public constructor(private readonly executor: SqlExecutor) {}

  public async list(): Promise<RepositoryResult<readonly EvaluationProfile[]>> {
    try {
      const result = await this.executor.query(
        `select ${PROFILE_COLUMNS}
           from app.evaluation_profiles
          order by is_default desc, lower(name) asc, profile_id asc`,
      );
      return parseProfileRows(result, 'evaluation-profiles');
    } catch (error: unknown) {
      return failure(
        mapDatabaseError(error, {
          resource: 'evaluation_profile',
          identity: 'evaluation-profiles',
        }),
      );
    }
  }

  public async load(profileId: string): Promise<RepositoryResult<EvaluationProfile>> {
    if (!idSchema.safeParse(profileId).success) {
      return failure({ code: 'constraint_violation', constraint: 'evaluation_profile_identity' });
    }
    try {
      const result = await this.executor.query(
        `select ${PROFILE_COLUMNS}
           from app.evaluation_profiles
          where profile_id = $1`,
        [profileId],
      );
      return parseSingleProfile(result, profileId);
    } catch (error: unknown) {
      return failure(
        mapDatabaseError(error, { resource: 'evaluation_profile', identity: profileId }),
      );
    }
  }

  public async loadDefault(): Promise<RepositoryResult<EvaluationProfile>> {
    try {
      const result = await this.executor.query(
        `select ${PROFILE_COLUMNS}
           from app.evaluation_profiles
          where is_default = true`,
      );
      return parseSingleProfile(result, 'default');
    } catch (error: unknown) {
      return failure(
        mapDatabaseError(error, { resource: 'evaluation_profile', identity: 'default' }),
      );
    }
  }

  public async create(profile: EvaluationProfile): Promise<RepositoryResult<EvaluationProfile>> {
    const validated = evaluationProfileSchema.safeParse(profile);
    if (!validated.success || validated.data.isDefault) {
      return failure({ code: 'constraint_violation', constraint: 'evaluation_profile_create' });
    }
    try {
      const result = await this.executor.query(
        `insert into app.evaluation_profiles (
           profile_id, name, is_default, profile, created_at, updated_at
         ) values ($1, $2, false, $3::jsonb, $4, $5)
         returning profile_id`,
        profileParameters(validated.data),
      );
      const identity = parseIdentity(result, validated.data.profileId);
      return identity.ok ? success(validated.data) : identity;
    } catch (error: unknown) {
      return failure(
        mapDatabaseError(error, {
          resource: 'evaluation_profile',
          identity: validated.data.profileId,
        }),
      );
    }
  }

  public async seedDefault(
    profile: EvaluationProfile,
  ): Promise<RepositoryResult<IdempotentWrite<EvaluationProfile>>> {
    const validated = evaluationProfileSchema.safeParse(profile);
    if (!validated.success || !validated.data.isDefault) {
      return failure({ code: 'constraint_violation', constraint: 'evaluation_profile_seed' });
    }
    try {
      await this.executor.query('lock table app.evaluation_profiles in share row exclusive mode');
      const currentDefault = await this.loadDefault();
      if (currentDefault.ok) {
        return success({ outcome: 'existing', value: currentDefault.value });
      }
      if (currentDefault.error.code !== 'not_found') return currentDefault;

      const result = await this.executor.query(
        `insert into app.evaluation_profiles (
           profile_id, name, is_default, profile, created_at, updated_at
         ) values ($1, $2, true, $3::jsonb, $4, $5)
         on conflict do nothing
         returning profile_id`,
        profileParameters(validated.data),
      );
      if (result.rowCount === 1) {
        const identity = parseIdentity(result, validated.data.profileId);
        return identity.ok ? success({ outcome: 'inserted', value: validated.data }) : identity;
      }
      if (result.rowCount !== 0) {
        return failure(
          corruptData(
            'evaluation_profile',
            validated.data.profileId,
            'Default profile insert returned an unexpected row count',
          ),
        );
      }
      const existing = await this.loadDefault();
      if (!existing.ok) {
        return failure({
          code: 'duplicate_conflict',
          resource: 'evaluation_profile',
          identity: validated.data.profileId,
        });
      }
      return success({ outcome: 'existing', value: existing.value });
    } catch (error: unknown) {
      return failure(
        mapDatabaseError(error, {
          resource: 'evaluation_profile',
          identity: validated.data.profileId,
        }),
      );
    }
  }

  public async duplicate(
    sourceProfileId: string,
    profile: EvaluationProfile,
  ): Promise<RepositoryResult<EvaluationProfile>> {
    const validated = evaluationProfileSchema.safeParse(profile);
    if (
      !idSchema.safeParse(sourceProfileId).success ||
      !validated.success ||
      validated.data.isDefault ||
      validated.data.profileId === sourceProfileId
    ) {
      return failure({ code: 'constraint_violation', constraint: 'evaluation_profile_duplicate' });
    }
    try {
      const result = await this.executor.query(
        `insert into app.evaluation_profiles (
           profile_id, name, is_default, profile, created_at, updated_at
         )
         select $2, $3, false, $4::jsonb, $5, $6
           from app.evaluation_profiles
          where profile_id = $1
         returning profile_id`,
        [sourceProfileId, ...profileParameters(validated.data)],
      );
      if (result.rowCount === 1) {
        const identity = parseIdentity(result, validated.data.profileId);
        return identity.ok ? success(validated.data) : identity;
      }
      if (result.rowCount !== 0) {
        return failure(
          corruptData(
            'evaluation_profile',
            validated.data.profileId,
            'Profile duplicate returned an unexpected row count',
          ),
        );
      }
      return failure({ code: 'not_found', resource: 'evaluation_profile', id: sourceProfileId });
    } catch (error: unknown) {
      return failure(
        mapDatabaseError(error, {
          resource: 'evaluation_profile',
          identity: validated.data.profileId,
        }),
      );
    }
  }

  public async update(
    profileId: string,
    expectedUpdatedAt: string,
    profile: EvaluationProfile,
  ): Promise<RepositoryResult<EvaluationProfile>> {
    const validated = evaluationProfileSchema.safeParse(profile);
    if (
      !validated.success ||
      validated.data.profileId !== profileId ||
      !timestampSchema.safeParse(expectedUpdatedAt).success ||
      Date.parse(validated.data.updatedAt) <= Date.parse(expectedUpdatedAt)
    ) {
      return failure({ code: 'constraint_violation', constraint: 'evaluation_profile_update' });
    }
    try {
      const result = await this.executor.query(
        `update app.evaluation_profiles
            set name = $2,
                profile = $3::jsonb,
                updated_at = $4
          where profile_id = $1
            and updated_at = $5
            and $4 > updated_at
            and is_default = $6
          returning ${PROFILE_COLUMNS}`,
        [
          validated.data.profileId,
          validated.data.name,
          JSON.stringify(validated.data),
          validated.data.updatedAt,
          expectedUpdatedAt,
          validated.data.isDefault,
        ],
      );
      if (result.rowCount === 1) {
        return parseSingleProfile(result, profileId);
      }
      if (result.rowCount !== 0) {
        return failure(
          corruptData(
            'evaluation_profile',
            profileId,
            'Profile update returned an unexpected row count',
          ),
        );
      }
      const current = await this.load(profileId);
      if (!current.ok) return current;
      return failure({
        code: 'duplicate_conflict',
        resource: 'evaluation_profile',
        identity: `${profileId}:${expectedUpdatedAt}`,
      });
    } catch (error: unknown) {
      return failure(
        mapDatabaseError(error, { resource: 'evaluation_profile', identity: profileId }),
      );
    }
  }

  public async delete(
    profileId: string,
    expectedUpdatedAt: string,
  ): Promise<RepositoryResult<EvaluationProfile>> {
    if (
      !idSchema.safeParse(profileId).success ||
      !timestampSchema.safeParse(expectedUpdatedAt).success
    ) {
      return failure({ code: 'constraint_violation', constraint: 'evaluation_profile_identity' });
    }
    try {
      const result = await this.executor.query(
        `delete from app.evaluation_profiles
          where profile_id = $1
            and updated_at = $2
            and is_default = false
          returning ${PROFILE_COLUMNS}`,
        [profileId, expectedUpdatedAt],
      );
      if (result.rowCount === 1) return parseSingleProfile(result, profileId);
      if (result.rowCount !== 0) {
        return failure(
          corruptData(
            'evaluation_profile',
            profileId,
            'Profile delete returned an unexpected row count',
          ),
        );
      }
      const current = await this.load(profileId);
      if (!current.ok) return current;
      return current.value.isDefault
        ? failure({
            code: 'constraint_violation',
            constraint: 'evaluation_profiles_default_required',
          })
        : failure({
            code: 'duplicate_conflict',
            resource: 'evaluation_profile',
            identity: `${profileId}:${expectedUpdatedAt}`,
          });
    } catch (error: unknown) {
      return failure(
        mapDatabaseError(error, { resource: 'evaluation_profile', identity: profileId }),
      );
    }
  }
}

function profileParameters(profile: EvaluationProfile): readonly unknown[] {
  return [
    profile.profileId,
    profile.name,
    JSON.stringify(profile),
    profile.createdAt,
    profile.updatedAt,
  ];
}

function parseIdentity(result: SqlQueryResult, expectedProfileId: string): RepositoryResult<true> {
  const parsed = z.array(identityRowSchema).safeParse(result.rows);
  if (
    !parsed.success ||
    parsed.data.length !== result.rowCount ||
    result.rowCount !== 1 ||
    parsed.data[0]?.profile_id !== expectedProfileId
  ) {
    return failure(
      corruptData(
        'evaluation_profile',
        expectedProfileId,
        'Profile write returned an invalid identity',
      ),
    );
  }
  return success(true);
}

function parseSingleProfile(
  result: SqlQueryResult,
  identity: string,
): RepositoryResult<EvaluationProfile> {
  if (result.rowCount === 0) {
    return failure({ code: 'not_found', resource: 'evaluation_profile', id: identity });
  }
  const profiles = parseProfileRows(result, identity);
  if (!profiles.ok) return profiles;
  const profile = profiles.value[0];
  return result.rowCount === 1 && profile !== undefined
    ? success(profile)
    : failure(
        corruptData(
          'evaluation_profile',
          identity,
          'Profile query returned an unexpected row count',
        ),
      );
}

function parseProfileRows(
  result: SqlQueryResult,
  identity: string,
): RepositoryResult<readonly EvaluationProfile[]> {
  const parsedRows = z.array(profileRowSchema).safeParse(result.rows);
  if (!parsedRows.success || parsedRows.data.length !== result.rowCount) {
    return failure(
      corruptData('evaluation_profile', identity, 'Profile query returned invalid rows'),
    );
  }
  const profiles: EvaluationProfile[] = [];
  for (const row of parsedRows.data) {
    const parsedProfile = evaluationProfileSchema.safeParse(row.profile);
    if (
      !parsedProfile.success ||
      parsedProfile.data.profileId !== row.profile_id ||
      parsedProfile.data.name !== row.name ||
      parsedProfile.data.isDefault !== row.is_default ||
      Date.parse(parsedProfile.data.createdAt) !== Date.parse(row.created_at) ||
      Date.parse(parsedProfile.data.updatedAt) !== Date.parse(row.updated_at)
    ) {
      return failure(
        corruptData(
          'evaluation_profile',
          row.profile_id,
          'Stored profile JSON does not match its relational scope',
        ),
      );
    }
    profiles.push(parsedProfile.data);
  }
  return success(profiles);
}
