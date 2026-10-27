import { describe, expect, it } from 'vitest';

import { PostgresInterviewSettingsRepository } from './interview-settings-repository.js';
import type { SqlExecutor, SqlQueryResult } from './sql.js';

const SETTING = {
  language: 'de',
  guideId: 'guide-user-selected',
  updatedAt: '2026-10-01T10:00:00.000Z',
} as const;

describe('PostgresInterviewSettingsRepository', () => {
  it('lists only the requested language and orders by name, not newest upload', async () => {
    const executor = new ScriptedExecutor([
      {
        rows: [
          {
            id: 'guide-a',
            title: 'A',
            sourceLanguage: 'de',
            createdAt: SETTING.updatedAt,
            mainQuestionCount: 12,
            followUpQuestionCount: 39,
          },
        ],
        rowCount: 1,
      },
    ]);
    const result = await new PostgresInterviewSettingsRepository(executor).listGuides('de');
    expect(result.ok).toBe(true);
    expect(executor.calls[0]?.parameters).toEqual(['de']);
    expect(executor.calls[0]?.statement).toContain('where g.source_language = $1');
    expect(executor.calls[0]?.statement).toContain('order by g.title, g.id');
    expect(executor.calls[0]?.statement).not.toContain('created_at desc');
  });

  it('does not overwrite a saved user selection during seed', async () => {
    const executor = new ScriptedExecutor([
      { rows: [], rowCount: 0 },
      { rows: [SETTING], rowCount: 1 },
    ]);
    const result = await new PostgresInterviewSettingsRepository(executor).saveSetting(
      { ...SETTING, guideId: 'guide-built-in' },
      true,
    );
    expect(result).toEqual({ ok: true, value: SETTING });
    expect(executor.calls[0]?.statement).toContain('on conflict (language) do nothing');
  });

  it('updates only the requested language with parameterized values', async () => {
    const executor = new ScriptedExecutor([
      { rows: [], rowCount: 1 },
      { rows: [SETTING], rowCount: 1 },
    ]);
    expect(await new PostgresInterviewSettingsRepository(executor).saveSetting(SETTING)).toEqual({
      ok: true,
      value: SETTING,
    });
    expect(executor.calls[0]?.statement).toContain('do update set guide_id = excluded.guide_id');
    expect(executor.calls[0]?.parameters).toEqual(['de', 'guide-user-selected', SETTING.updatedAt]);
  });

  it('rejects corrupt database data instead of returning an invalid guide setting', async () => {
    const executor = new ScriptedExecutor([
      { rows: [{ ...SETTING, language: 'fr' }], rowCount: 1 },
    ]);
    expect(await new PostgresInterviewSettingsRepository(executor).getSettings()).toMatchObject({
      ok: false,
    });
  });
});

class ScriptedExecutor implements SqlExecutor {
  readonly calls: { readonly statement: string; readonly parameters: readonly unknown[] }[] = [];
  constructor(private readonly results: readonly SqlQueryResult[]) {}
  async query(statement: string, parameters: readonly unknown[] = []): Promise<SqlQueryResult> {
    this.calls.push({ statement, parameters });
    const result = this.results[this.calls.length - 1];
    if (result === undefined) throw new Error('Unexpected query');
    return result;
  }
}
