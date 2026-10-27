import {
  evaluationProfileDocumentSchema,
  type EvaluationProfile,
  type EvaluationProfileContent,
} from '@orgscience/contracts';
import { describe, expect, it, vi } from 'vitest';

import type {
  AppReadContext,
  AppTransaction,
  AppUnitOfWork,
  EvaluationProfileRepository,
  RepositoryError,
  RepositoryResult,
  Result,
} from '../persistence/index.js';
import { failure, success } from '../persistence/index.js';
import { NodeSha256 } from '../../runtime/system-adapters.js';
import {
  EvaluationProfileService,
  EvaluationProfileServiceError,
} from './evaluation-profile-service.js';

const CREATED_AT = '2026-08-21T10:00:00.000Z';
const UPDATED_AT = '2026-08-21T10:00:01.000Z';

describe('EvaluationProfileService', () => {
  it.each(['weighted_mean', 'formula'] as const)(
    'preserves %s configuration through storage, duplication, and JSON import/export',
    async (mode) => {
      const repository = new MemoryEvaluationProfileRepository();
      const service = createService(repository, async () => undefined, [CREATED_AT, UPDATED_AT]);
      const original = profileContent();
      const configured: EvaluationProfileContent = {
        ...original,
        calculation:
          mode === 'formula'
            ? { mode, expression: `item("${original.items[0]!.itemId}") * 10` }
            : { mode },
        dimensions: original.dimensions.map((dimension) => ({ ...dimension, weight: 2.5 })),
        items: original.items.map((item) => ({ ...item, weight: 0.5 })),
      };
      const created = await service.create(configured);
      const copied = await service.duplicate(created.profileId, 'Weighted copy');
      expect(copied.calculation).toEqual(configured.calculation);
      expect(copied.items).toEqual(configured.items);
      expect(copied.dimensions).toEqual(configured.dimensions);
      const artifact = await service.exportJson(created.profileId);
      const document = evaluationProfileDocumentSchema.parse(JSON.parse(artifact.body));
      expect(document.schemaVersion).toBe(2);
      if (document.schemaVersion !== 2) throw new Error('Expected a v2 export');
      expect(document.profile.calculation).toEqual(configured.calculation);
      const target = createService(new MemoryEvaluationProfileRepository(), async () => undefined, [
        UPDATED_AT,
      ]);
      const imported = await target.importJson({ mode: 'create', document });
      expect(imported.calculation).toEqual(configured.calculation);
      expect(imported.items).toEqual(configured.items);
      expect(imported.dimensions).toEqual(configured.dimensions);
      expect((await target.exportJson(imported.profileId)).body).toBe(artifact.body);
    },
  );

  it('creates, updates, duplicates, lists, and deletes mutable profiles', async () => {
    const repository = new MemoryEvaluationProfileRepository([storedProfile()]);
    const ensureDefault = vi.fn(async () => undefined);
    const service = createService(repository, ensureDefault, [CREATED_AT, UPDATED_AT, UPDATED_AT]);

    const created = await service.create(profileContent({ name: 'Service quality' }));
    const updated = await service.update(
      created.profileId,
      created.updatedAt,
      profileContent({ name: 'Service quality revised' }),
    );
    await expect(service.delete(updated.profileId, created.updatedAt)).rejects.toMatchObject({
      code: 'conflict',
    });
    const duplicate = await service.duplicate(updated.profileId, 'Service quality copy');
    const listed = await service.list();
    const deleted = await service.delete(duplicate.profileId, duplicate.updatedAt);

    expect(created.isDefault).toBe(false);
    expect(updated).toMatchObject({
      profileId: created.profileId,
      name: 'Service quality revised',
      createdAt: created.createdAt,
      updatedAt: UPDATED_AT,
    });
    expect(duplicate).toMatchObject({ name: 'Service quality copy', isDefault: false });
    expect(listed.map(({ profileId }) => profileId)).toEqual([
      'profile-default',
      created.profileId,
      duplicate.profileId,
    ]);
    expect(deleted.profileId).toBe(duplicate.profileId);
    expect(ensureDefault).toHaveBeenCalledTimes(6);
  });

  it('exports and reimports the same editable configuration without system fields', async () => {
    const sourceRepository = new MemoryEvaluationProfileRepository([storedProfile()]);
    const sourceService = createService(sourceRepository, async () => undefined, [CREATED_AT]);
    const artifact = await sourceService.exportJson('profile-default');
    const document = evaluationProfileDocumentSchema.parse(JSON.parse(artifact.body));

    expect(artifact.body.endsWith('\n')).toBe(true);
    expect(document.profile).not.toHaveProperty('isDefault');
    expect(document.profile).not.toHaveProperty('createdAt');
    expect(document.profile).not.toHaveProperty('guardrails');

    const targetRepository = new MemoryEvaluationProfileRepository();
    const targetService = createService(targetRepository, async () => undefined, [UPDATED_AT]);
    expect(targetService.previewImport(document)).toEqual({
      valid: true,
      profile: document.profile,
    });
    const imported = await targetService.importJson({ mode: 'create', document });

    expect(stripStorageFields(imported)).toEqual(document.profile);
    expect((await targetService.exportJson(imported.profileId)).body).toBe(artifact.body);
  });

  it('replaces only the selected profile while preserving identity and default status', async () => {
    const repository = new MemoryEvaluationProfileRepository([storedProfile()]);
    const service = createService(repository, async () => undefined, [UPDATED_AT]);
    const replacement = evaluationProfileDocumentSchema.parse({
      schemaVersion: 1,
      profile: {
        profileId: 'profile-external',
        ...profileContent({ name: 'Imported content' }),
      },
    });

    const replaced = await service.importJson({
      mode: 'replace',
      targetProfileId: 'profile-default',
      expectedUpdatedAt: CREATED_AT,
      document: replacement,
    });

    expect(replaced).toMatchObject({
      profileId: 'profile-default',
      name: 'Imported content',
      isDefault: true,
      createdAt: CREATED_AT,
      updatedAt: UPDATED_AT,
    });
    await expect(service.get('profile-external')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('provides a generic seven-anchor template and rejects mutable guardrails or default deletion', async () => {
    const repository = new MemoryEvaluationProfileRepository([storedProfile()]);
    const service = createService(repository, async () => undefined, [CREATED_AT]);
    const template = evaluationProfileDocumentSchema.parse(JSON.parse(service.template().body));

    expect(template.profile.items[0]?.anchors.map(({ score }) => score)).toEqual([
      1, 2, 3, 4, 5, 6, 7,
    ]);
    expect(JSON.stringify(template).toLowerCase()).not.toContain('resilience');
    expect(service.guardrails()).toMatchObject({
      exactQuotesRequired: true,
      hiddenChainOfThoughtForbidden: true,
      scoreRangeLocked: 'integer_1_7_or_non_score',
    });
    await expect(
      service.create({ ...profileContent(), guardrails: { exactQuotesRequired: false } }),
    ).rejects.toBeInstanceOf(EvaluationProfileServiceError);
    await expect(service.delete('profile-default', CREATED_AT)).rejects.toMatchObject({
      code: 'default_required',
    });
  });
});

function createService(
  repository: EvaluationProfileRepository,
  ensureDefault: () => Promise<void>,
  timestamps: readonly string[],
): EvaluationProfileService {
  let index = 0;
  return new EvaluationProfileService(
    new MemoryUnitOfWork(repository),
    {
      now: () => {
        const value = timestamps[Math.min(index, timestamps.length - 1)];
        index += 1;
        if (value === undefined) throw new Error('Test clock requires a timestamp');
        return value;
      },
    },
    new NodeSha256(),
    ensureDefault,
  );
}

function profileContent(
  overrides: Partial<EvaluationProfileContent> = {},
): EvaluationProfileContent {
  return {
    name: 'Generic assessment',
    description: 'A guide-independent assessment profile.',
    coderPrompt: 'Assess each item using only exact evidence from participant turns.',
    scale: { minimum: 1, maximum: 7 },
    dimensions: [{ dimensionId: 'dimension-a', name: 'Dimension A', order: 0 }],
    items: [
      {
        itemId: 'item-a',
        dimensionId: 'dimension-a',
        name: 'Item A',
        codingInstruction: 'Assess the observable evidence for item A.',
        order: 0,
        anchors: [1, 2, 3, 4, 5, 6, 7].map((score) => ({
          score,
          criterion: `Observable criterion ${String(score)}.`,
        })) as EvaluationProfileContent['items'][number]['anchors'],
      },
    ],
    ...overrides,
  };
}

function storedProfile(overrides: Partial<EvaluationProfile> = {}): EvaluationProfile {
  return {
    profileId: 'profile-default',
    ...profileContent({ name: 'default' }),
    isDefault: true,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  };
}

function stripStorageFields(profile: EvaluationProfile) {
  return {
    profileId: profile.profileId,
    name: profile.name,
    description: profile.description,
    coderPrompt: profile.coderPrompt,
    scale: profile.scale,
    dimensions: profile.dimensions,
    items: profile.items,
  };
}

class MemoryUnitOfWork implements AppUnitOfWork {
  public constructor(private readonly evaluationProfiles: EvaluationProfileRepository) {}

  public async read<T>(
    operation: (context: AppReadContext) => Promise<RepositoryResult<T>>,
  ): Promise<RepositoryResult<T>> {
    return operation({ evaluationProfiles: this.evaluationProfiles } as unknown as AppReadContext);
  }

  public async transaction<T, E = never>(
    operation: (transaction: AppTransaction) => Promise<Result<T, E | RepositoryError>>,
  ): Promise<Result<T, E | RepositoryError>> {
    return operation({ evaluationProfiles: this.evaluationProfiles } as AppTransaction);
  }
}

class MemoryEvaluationProfileRepository implements EvaluationProfileRepository {
  readonly #profiles = new Map<string, EvaluationProfile>();

  public constructor(profiles: readonly EvaluationProfile[] = []) {
    for (const profile of profiles) this.#profiles.set(profile.profileId, profile);
  }

  public async list(): Promise<RepositoryResult<readonly EvaluationProfile[]>> {
    return success(
      [...this.#profiles.values()].toSorted(
        (left, right) => Number(right.isDefault) - Number(left.isDefault),
      ),
    );
  }

  public async load(profileId: string): Promise<RepositoryResult<EvaluationProfile>> {
    const profile = this.#profiles.get(profileId);
    return profile === undefined
      ? failure({ code: 'not_found', resource: 'evaluation_profile', id: profileId })
      : success(profile);
  }

  public async loadDefault(): Promise<RepositoryResult<EvaluationProfile>> {
    const profile = [...this.#profiles.values()].find(({ isDefault }) => isDefault);
    return profile === undefined
      ? failure({ code: 'not_found', resource: 'evaluation_profile', id: 'default' })
      : success(profile);
  }

  public async create(profile: EvaluationProfile): Promise<RepositoryResult<EvaluationProfile>> {
    if (
      this.#profiles.has(profile.profileId) ||
      [...this.#profiles.values()].some(
        ({ name }) => name.toLocaleLowerCase() === profile.name.toLocaleLowerCase(),
      )
    ) {
      return failure({
        code: 'duplicate_conflict',
        resource: 'evaluation_profile',
        identity: profile.profileId,
      });
    }
    this.#profiles.set(profile.profileId, profile);
    return success(profile);
  }

  public async duplicate(
    sourceProfileId: string,
    profile: EvaluationProfile,
  ): Promise<RepositoryResult<EvaluationProfile>> {
    if (!this.#profiles.has(sourceProfileId)) {
      return failure({
        code: 'not_found',
        resource: 'evaluation_profile',
        id: sourceProfileId,
      });
    }
    return this.create(profile);
  }

  public async seedDefault(
    profile: EvaluationProfile,
  ): Promise<RepositoryResult<{ outcome: 'inserted' | 'existing'; value: EvaluationProfile }>> {
    const existing = [...this.#profiles.values()].find(({ isDefault }) => isDefault);
    if (existing !== undefined) return success({ outcome: 'existing', value: existing });
    this.#profiles.set(profile.profileId, profile);
    return success({ outcome: 'inserted', value: profile });
  }

  public async update(
    profileId: string,
    expectedUpdatedAt: string,
    profile: EvaluationProfile,
  ): Promise<RepositoryResult<EvaluationProfile>> {
    const current = this.#profiles.get(profileId);
    if (current === undefined) {
      return failure({ code: 'not_found', resource: 'evaluation_profile', id: profileId });
    }
    if (current.updatedAt !== expectedUpdatedAt) {
      return failure({
        code: 'duplicate_conflict',
        resource: 'evaluation_profile',
        identity: profileId,
      });
    }
    if (
      [...this.#profiles.values()].some(
        (candidate) =>
          candidate.profileId !== profileId &&
          candidate.name.toLocaleLowerCase() === profile.name.toLocaleLowerCase(),
      )
    ) {
      return failure({
        code: 'duplicate_conflict',
        resource: 'evaluation_profile',
        identity: profile.name,
      });
    }
    this.#profiles.set(profileId, profile);
    return success(profile);
  }

  public async delete(
    profileId: string,
    expectedUpdatedAt: string,
  ): Promise<RepositoryResult<EvaluationProfile>> {
    const current = this.#profiles.get(profileId);
    if (current === undefined) {
      return failure({ code: 'not_found', resource: 'evaluation_profile', id: profileId });
    }
    if (current.isDefault) {
      return failure({
        code: 'constraint_violation',
        constraint: 'evaluation_profiles_default_required',
      });
    }
    if (current.updatedAt !== expectedUpdatedAt) {
      return failure({
        code: 'duplicate_conflict',
        resource: 'evaluation_profile',
        identity: `${profileId}:${expectedUpdatedAt}`,
      });
    }
    this.#profiles.delete(profileId);
    return success(current);
  }
}
