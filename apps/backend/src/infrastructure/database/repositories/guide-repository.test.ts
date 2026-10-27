import { createHash } from 'node:crypto';

import { INTERVIEW_GUIDE_LIMITS } from '@orgscience/contracts';
import type { InterviewGuideSnapshot } from '@orgscience/domain';
import { describe, expect, it } from 'vitest';

import type { ImportedGuideRecord } from '../../../application/persistence/index.js';
import { PostgresGuideRepository } from './guide-repository.js';
import type { SqlExecutor, SqlQueryResult } from './sql.js';

const CREATED_AT = '2026-08-06T10:00:00.000Z';
const SOURCE = `# Leitfaden
## Einführung
### Hauptfrage
Welche Rolle haben Sie?
#### Vertiefungsfragen
- Seit wann?
## Abschluss
### Hauptfrage
Was ist noch wichtig?`;

const GUIDE: InterviewGuideSnapshot = {
  id: 'guide:v1:test',
  sourceLanguage: 'de',
  title: 'Leitfaden',
  sourceMarkdown: SOURCE,
  createdAt: CREATED_AT,
  sections: [
    {
      id: 'section:v1:intro',
      position: 0,
      title: 'Einführung',
      mainQuestions: [
        {
          id: 'main-question:v1:role',
          position: 0,
          text: 'Welche Rolle haben Sie?',
          followUpQuestions: [{ id: 'follow-up:v1:since', position: 0, text: 'Seit wann?' }],
        },
      ],
    },
    {
      id: 'section:v1:closing',
      position: 1,
      title: 'Abschluss',
      mainQuestions: [
        {
          id: 'main-question:v1:closing',
          position: 0,
          text: 'Was ist noch wichtig?',
          followUpQuestions: [],
        },
      ],
    },
  ],
};

const RECORD: ImportedGuideRecord = {
  guideId: GUIDE.id,
  guide: GUIDE,
  sourceHash: sha256(SOURCE),
  importedAt: CREATED_AT,
};

describe('PostgresGuideRepository', () => {
  it('reconstructs a complete snapshot in persisted position order', async () => {
    const executor = new ScriptedSqlExecutor([
      query(/from app\.guides g/u, { rows: guideRows(), rowCount: 3 }),
    ]);

    const result = await new PostgresGuideRepository(executor).getById(GUIDE.id);

    expect(result).toEqual({ ok: true, value: GUIDE });
    expect(executor.calls).toHaveLength(1);
    expect(executor.calls[0]?.parameters).toEqual([GUIDE.id]);
    expect(executor.calls[0]?.statement).toContain('where g.id = $1');
    executor.assertComplete();
  });

  it('writes guide, sections, main questions, then follow-ups in the surrounding UoW', async () => {
    const executor = new ScriptedSqlExecutor([
      query(/insert into app\.guides/u, { rows: [{ id: GUIDE.id }], rowCount: 1 }),
      query(/insert into app\.guide_sections/u, { rows: [], rowCount: 2 }),
      query(/insert into app\.guide_questions/u, { rows: [], rowCount: 2 }),
      query(/insert into app\.guide_questions/u, { rows: [], rowCount: 1 }),
    ]);

    const result = await new PostgresGuideRepository(executor).import(GUIDE.id, RECORD);

    expect(result).toEqual({ ok: true, value: { outcome: 'inserted', value: RECORD } });
    expect(executor.calls[1]?.parameters).toEqual([
      GUIDE.id,
      'section:v1:intro',
      0,
      'Einführung',
      GUIDE.id,
      'section:v1:closing',
      1,
      'Abschluss',
    ]);
    expect(executor.calls[2]?.parameters).toContain('main_question');
    expect(executor.calls[3]?.parameters).toContain('follow_up_question');
    executor.assertComplete();
  });

  it('rejects oversized guide structure before issuing a PostgreSQL batch insert', async () => {
    const firstSectionCount = 250;
    const oversizedGuide: InterviewGuideSnapshot = {
      ...GUIDE,
      sections: [
        {
          id: 'section-limit-a',
          position: 0,
          title: 'Abschnitt A',
          mainQuestions: makeMainQuestions(firstSectionCount, 0),
        },
        {
          id: 'section-limit-b',
          position: 1,
          title: 'Abschnitt B',
          mainQuestions: makeMainQuestions(
            INTERVIEW_GUIDE_LIMITS.maximumMainQuestions - firstSectionCount + 1,
            firstSectionCount,
          ),
        },
      ],
    };
    const executor = new ScriptedSqlExecutor([]);

    const result = await new PostgresGuideRepository(executor).import(GUIDE.id, {
      ...RECORD,
      guide: oversizedGuide,
    });

    expect(result).toEqual({
      ok: false,
      error: { code: 'constraint_violation', constraint: 'guide_repository_input_schema' },
    });
    expect(executor.calls).toHaveLength(0);
  });

  it('returns the original persisted record for an identical concurrent import', async () => {
    const executor = new ScriptedSqlExecutor([
      query(/insert into app\.guides/u, { rows: [], rowCount: 0 }),
      query(/from app\.guides g/u, { rows: guideRows(), rowCount: 3 }),
    ]);

    const result = await new PostgresGuideRepository(executor).import(GUIDE.id, RECORD);

    expect(result).toEqual({ ok: true, value: { outcome: 'existing', value: RECORD } });
    executor.assertComplete();
  });

  it('rejects reuse of a structural guide ID with a different source hash', async () => {
    const changedGuide = { ...GUIDE, sourceMarkdown: `${SOURCE}\n` };
    const executor = new ScriptedSqlExecutor([
      query(/insert into app\.guides/u, { rows: [], rowCount: 0 }),
      query(/from app\.guides g/u, { rows: guideRows(), rowCount: 3 }),
    ]);

    const result = await new PostgresGuideRepository(executor).import(GUIDE.id, {
      ...RECORD,
      guide: changedGuide,
      sourceHash: sha256(changedGuide.sourceMarkdown),
    });

    expect(result).toEqual({
      ok: false,
      error: { code: 'duplicate_conflict', resource: 'guide', identity: GUIDE.id },
    });
  });

  it('returns typed not-found, corrupt-row, and duplicate database errors', async () => {
    const missing = new PostgresGuideRepository(
      new ScriptedSqlExecutor([query(/from app\.guides g/u, { rows: [], rowCount: 0 })]),
    );
    await expect(missing.getById(GUIDE.id)).resolves.toEqual({
      ok: false,
      error: { code: 'not_found', resource: 'guide', id: GUIDE.id },
    });

    const corruptRows = guideRows();
    corruptRows[0] = { ...corruptRows[0]!, section_position: 4 };
    const corrupt = new PostgresGuideRepository(
      new ScriptedSqlExecutor([
        query(/from app\.guides g/u, { rows: corruptRows, rowCount: corruptRows.length }),
      ]),
    );
    const corruptResult = await corrupt.getById(GUIDE.id);
    expect(corruptResult.ok).toBe(false);
    if (!corruptResult.ok) {
      expect(corruptResult.error.code).toBe('corrupt_data');
    }

    const duplicate = new PostgresGuideRepository(
      new ScriptedSqlExecutor([failure(/insert into app\.guides/u, postgresError('23505'))]),
    );
    await expect(duplicate.import(GUIDE.id, RECORD)).resolves.toEqual({
      ok: false,
      error: { code: 'duplicate_conflict', resource: 'guide', identity: GUIDE.id },
    });
  });
});

function makeMainQuestions(count: number, offset: number) {
  return Array.from({ length: count }, (_, position) => ({
    id: `main-question-limit-${String(offset + position)}`,
    position,
    text: `Frage ${String(offset + position)}?`,
    followUpQuestions: [],
  }));
}

interface GuideDatabaseRow {
  guide_id: string;
  source_language: 'de' | 'en';
  guide_title: string;
  source_markdown: string;
  stable_id_version: 'v1';
  guide_created_at: string;
  section_id: string;
  section_position: number;
  section_title: string;
  question_id: string;
  question_kind: 'main_question' | 'follow_up_question';
  main_question_id: string;
  main_position: number;
  question_position: number;
  question_text: string;
}

function guideRows(): GuideDatabaseRow[] {
  const base = {
    guide_id: GUIDE.id,
    source_language: GUIDE.sourceLanguage,
    guide_title: GUIDE.title,
    source_markdown: SOURCE,
    stable_id_version: 'v1' as const,
    guide_created_at: CREATED_AT,
  };
  return [
    {
      ...base,
      section_id: 'section:v1:intro',
      section_position: 0,
      section_title: 'Einführung',
      question_id: 'main-question:v1:role',
      question_kind: 'main_question',
      main_question_id: 'main-question:v1:role',
      main_position: 0,
      question_position: 0,
      question_text: 'Welche Rolle haben Sie?',
    },
    {
      ...base,
      section_id: 'section:v1:intro',
      section_position: 0,
      section_title: 'Einführung',
      question_id: 'follow-up:v1:since',
      question_kind: 'follow_up_question',
      main_question_id: 'main-question:v1:role',
      main_position: 0,
      question_position: 0,
      question_text: 'Seit wann?',
    },
    {
      ...base,
      section_id: 'section:v1:closing',
      section_position: 1,
      section_title: 'Abschluss',
      question_id: 'main-question:v1:closing',
      question_kind: 'main_question',
      main_question_id: 'main-question:v1:closing',
      main_position: 0,
      question_position: 0,
      question_text: 'Was ist noch wichtig?',
    },
  ];
}

interface ScriptedQuery {
  readonly pattern: RegExp;
  readonly result?: SqlQueryResult;
  readonly error?: unknown;
}

class ScriptedSqlExecutor implements SqlExecutor {
  public readonly calls: { readonly statement: string; readonly parameters: readonly unknown[] }[] =
    [];

  readonly #scripts: ScriptedQuery[];

  public constructor(scripts: readonly ScriptedQuery[]) {
    this.#scripts = [...scripts];
  }

  public async query(
    statement: string,
    parameters: readonly unknown[] = [],
  ): Promise<SqlQueryResult> {
    const script = this.#scripts.shift();
    if (script === undefined || !script.pattern.test(statement)) {
      throw new Error(`Unexpected SQL: ${statement}`);
    }
    this.calls.push({ statement, parameters });
    if (script.error !== undefined) {
      throw script.error;
    }
    if (script.result === undefined) {
      throw new Error('Script has neither a result nor an error');
    }
    return script.result;
  }

  public assertComplete(): void {
    expect(this.#scripts).toHaveLength(0);
  }
}

function query(pattern: RegExp, result: SqlQueryResult): ScriptedQuery {
  return { pattern, result };
}

function failure(pattern: RegExp, error: unknown): ScriptedQuery {
  return { pattern, error };
}

function postgresError(code: string): Error & { readonly code: string } {
  return Object.assign(new Error(`PostgreSQL ${code}`), { code });
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
