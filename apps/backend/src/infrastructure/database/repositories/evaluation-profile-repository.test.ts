import { evaluationProfileSchema, type EvaluationProfile } from '@orgscience/contracts';
import { describe, expect, it } from 'vitest';

import { PostgresPersistenceContextFactory } from '../persistence-context.js';
import { PostgresEvaluationProfileRepository } from './evaluation-profile-repository.js';
import type { SqlExecutor, SqlQueryResult } from './sql.js';

const CREATED_AT = '2026-08-21T10:00:00.000Z';
const UPDATED_AT = '2026-08-21T11:00:00.000Z';

function profile(overrides: Partial<EvaluationProfile> = {}): EvaluationProfile {
  return evaluationProfileSchema.parse({
    profileId: 'profile-default',
    name: 'default',
    description: 'Generic profile',
    coderPrompt: 'Code every item from canonical participant evidence.',
    scale: { minimum: 1, maximum: 7 },
    dimensions: [{ dimensionId: 'dimension-a', name: 'Dimension A', order: 0 }],
    items: [
      {
        itemId: 'item-a',
        dimensionId: 'dimension-a',
        name: 'Item A',
        codingInstruction: 'Assess item A.',
        order: 0,
        anchors: [1, 2, 3, 4, 5, 6, 7].map((score) => ({
          score,
          criterion: `Criterion ${String(score)}`,
        })),
      },
    ],
    isDefault: true,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  });
}

function row(value: EvaluationProfile) {
  return {
    profile_id: value.profileId,
    name: value.name,
    is_default: value.isDefault,
    profile: value,
    created_at: value.createdAt,
    updated_at: value.updatedAt,
  };
}

class ScriptedExecutor implements SqlExecutor {
  public readonly calls: Array<{
    readonly statement: string;
    readonly parameters: readonly unknown[];
  }> = [];

  public constructor(private readonly results: readonly SqlQueryResult[]) {}

  public async query(
    statement: string,
    parameters: readonly unknown[] = [],
  ): Promise<SqlQueryResult> {
    this.calls.push({ statement, parameters });
    const result = this.results[this.calls.length - 1];
    if (result === undefined) throw new Error('Unexpected query');
    return result;
  }
}

describe('PostgresEvaluationProfileRepository', () => {
  it('lists complete profiles with the default first', async () => {
    const secondary = profile({
      profileId: 'profile-secondary',
      name: 'Secondary',
      isDefault: false,
    });
    const executor = new ScriptedExecutor([
      { rows: [row(profile()), row(secondary)], rowCount: 2 },
    ]);

    const result = await new PostgresEvaluationProfileRepository(executor).list();

    expect(result).toEqual({ ok: true, value: [profile(), secondary] });
    expect(executor.calls[0]?.statement).toContain('order by is_default desc');
  });

  it('seeds once and returns a user-modified default without overwriting it', async () => {
    const modified = profile({ name: 'My default', description: 'Changed by the user' });
    const executor = new ScriptedExecutor([
      { rows: [], rowCount: 0 },
      { rows: [row(modified)], rowCount: 1 },
    ]);

    const result = await new PostgresEvaluationProfileRepository(executor).seedDefault(profile());

    expect(result).toEqual({ ok: true, value: { outcome: 'existing', value: modified } });
    expect(executor.calls[0]?.statement).toContain('lock table app.evaluation_profiles');
    expect(executor.calls).toHaveLength(2);
  });

  it('updates the current profile with optimistic timestamp protection', async () => {
    const updated = profile({ name: 'Updated default', updatedAt: UPDATED_AT });
    const executor = new ScriptedExecutor([{ rows: [row(updated)], rowCount: 1 }]);

    const result = await new PostgresEvaluationProfileRepository(executor).update(
      updated.profileId,
      CREATED_AT,
      updated,
    );

    expect(result).toEqual({ ok: true, value: updated });
    expect(executor.calls[0]?.parameters).toEqual([
      updated.profileId,
      updated.name,
      JSON.stringify(updated),
      updated.updatedAt,
      CREATED_AT,
      true,
    ]);
  });

  it('rejects updates that do not advance the optimistic token', async () => {
    const current = profile();
    const executor = new ScriptedExecutor([]);

    const result = await new PostgresEvaluationProfileRepository(executor).update(
      current.profileId,
      current.updatedAt,
      current,
    );

    expect(result).toEqual({
      ok: false,
      error: { code: 'constraint_violation', constraint: 'evaluation_profile_update' },
    });
    expect(executor.calls).toHaveLength(0);
  });

  it('duplicates an existing profile with a new identity and no default flag', async () => {
    const duplicate = profile({
      profileId: 'profile-copy',
      name: 'Copy',
      isDefault: false,
    });
    const executor = new ScriptedExecutor([
      { rows: [{ profile_id: duplicate.profileId }], rowCount: 1 },
    ]);

    const result = await new PostgresEvaluationProfileRepository(executor).duplicate(
      'profile-default',
      duplicate,
    );

    expect(result).toEqual({ ok: true, value: duplicate });
    expect(executor.calls[0]?.statement).toContain('from app.evaluation_profiles');
  });

  it('protects the sole default profile from deletion', async () => {
    const current = profile();
    const executor = new ScriptedExecutor([
      { rows: [], rowCount: 0 },
      { rows: [row(current)], rowCount: 1 },
    ]);

    const result = await new PostgresEvaluationProfileRepository(executor).delete(
      current.profileId,
      current.updatedAt,
    );

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'constraint_violation',
        constraint: 'evaluation_profiles_default_required',
      },
    });
    expect(executor.calls[0]?.parameters).toEqual([current.profileId, current.updatedAt]);
  });

  it('rejects a stale delete token without deleting the current profile', async () => {
    const current = profile({
      profileId: 'profile-current',
      isDefault: false,
      updatedAt: UPDATED_AT,
    });
    const executor = new ScriptedExecutor([
      { rows: [], rowCount: 0 },
      { rows: [row(current)], rowCount: 1 },
    ]);

    const result = await new PostgresEvaluationProfileRepository(executor).delete(
      current.profileId,
      CREATED_AT,
    );

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'duplicate_conflict',
        resource: 'evaluation_profile',
        identity: `${current.profileId}:${CREATED_AT}`,
      },
    });
    expect(executor.calls[0]?.statement).toContain('and updated_at = $2');
  });

  it('is available from every PostgreSQL persistence context', () => {
    const executor = new ScriptedExecutor([]);
    const factory = new PostgresPersistenceContextFactory();

    expect(factory.createReadContext(executor).evaluationProfiles).toBeInstanceOf(
      PostgresEvaluationProfileRepository,
    );
    expect(factory.createTransaction(executor).evaluationProfiles).toBeInstanceOf(
      PostgresEvaluationProfileRepository,
    );
  });
});
