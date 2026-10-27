import { createHash } from 'node:crypto';

import { interviewGuideSchema } from '@orgscience/contracts';
import {
  STABLE_GUIDE_ID_VERSION,
  type InterviewGuideSnapshot,
  type ParsedFollowUpQuestion,
  type ParsedGuideSection,
  type ParsedMainQuestion,
} from '@orgscience/domain';
import { z } from 'zod';

import {
  failure,
  success,
  type GuideRepository as GuideRepositoryPort,
  type IdempotentWrite,
  type ImportedGuideRecord,
  type RepositoryResult,
} from '../../../application/persistence/index.js';
import { corruptData, mapDatabaseError } from './repository-errors.js';
import type { SqlExecutor } from './sql.js';

const databaseTimestampSchema = z
  .union([z.string(), z.date()])
  .transform((value) => (typeof value === 'string' ? value : value.toISOString()))
  .pipe(z.iso.datetime({ offset: true }));

const guideRowSchema = z.strictObject({
  guide_id: z.string().min(1),
  source_language: z.enum(['de', 'en']).default('de'),
  guide_title: z.string().min(1),
  source_markdown: z.string().min(1),
  stable_id_version: z.literal(STABLE_GUIDE_ID_VERSION),
  guide_created_at: databaseTimestampSchema,
  section_id: z.string().min(1).nullable(),
  section_position: z.number().int().nonnegative().nullable(),
  section_title: z.string().min(1).nullable(),
  question_id: z.string().min(1).nullable(),
  question_kind: z.enum(['main_question', 'follow_up_question']).nullable(),
  main_question_id: z.string().min(1).nullable(),
  main_position: z.number().int().nonnegative().nullable(),
  question_position: z.number().int().nonnegative().nullable(),
  question_text: z.string().min(1).nullable(),
});

type GuideRow = z.infer<typeof guideRowSchema>;

type CompleteQuestionRow = Omit<
  GuideRow,
  | 'section_id'
  | 'question_id'
  | 'main_question_id'
  | 'main_position'
  | 'question_position'
  | 'question_text'
> & {
  readonly section_id: string;
  readonly question_id: string;
  readonly main_question_id: string;
  readonly main_position: number;
  readonly question_position: number;
  readonly question_text: string;
};

const insertedGuideRowSchema = z.strictObject({ id: z.string().min(1) });
const noRowsSchema = z.array(z.never());

const LOAD_GUIDE_SQL = `
  select
    g.id as guide_id,
    g.source_language,
    g.title as guide_title,
    g.source_markdown,
    g.stable_id_version,
    g.created_at as guide_created_at,
    s.id as section_id,
    s.position as section_position,
    s.title as section_title,
    q.id as question_id,
    q.kind as question_kind,
    q.main_question_id,
    main_q.position as main_position,
    q.position as question_position,
    q.text as question_text
  from app.guides g
  left join app.guide_sections s
    on s.guide_id = g.id
  left join app.guide_questions q
    on q.guide_id = s.guide_id
   and q.section_id = s.id
  left join app.guide_questions main_q
    on main_q.guide_id = q.guide_id
   and main_q.id = q.main_question_id
   and main_q.section_id = q.section_id
   and main_q.kind = 'main_question'
  where g.id = $1
  order by
    s.position asc,
    main_q.position asc,
    case q.kind when 'main_question' then 0 else 1 end asc,
    q.position asc
`;

export class PostgresGuideRepository implements GuideRepositoryPort {
  readonly #executor: SqlExecutor;

  public constructor(executor: SqlExecutor) {
    this.#executor = executor;
  }

  public async getById(guideId: string): Promise<RepositoryResult<InterviewGuideSnapshot>> {
    try {
      const result = await this.#executor.query(LOAD_GUIDE_SQL, [guideId]);
      if (result.rowCount === 0) {
        return failure({ code: 'not_found', resource: 'guide', id: guideId });
      }

      const parsedRows = z.array(guideRowSchema).safeParse(result.rows);
      if (!parsedRows.success) {
        return failure(corruptData('guide', guideId, formatZodIssues(parsedRows.error)));
      }
      if (parsedRows.data.length !== result.rowCount) {
        return failure(corruptData('guide', guideId, 'Guide row count is inconsistent'));
      }
      return reconstructGuide(guideId, parsedRows.data);
    } catch (error: unknown) {
      return failure(mapDatabaseError(error, { resource: 'guide', identity: guideId }));
    }
  }

  public async import(
    guideId: string,
    record: ImportedGuideRecord,
  ): Promise<RepositoryResult<IdempotentWrite<ImportedGuideRecord>>> {
    const inputError = validateImportInput(guideId, record);
    if (inputError !== null) {
      return failure({ code: 'constraint_violation', constraint: inputError });
    }

    try {
      const inserted = await this.#executor.query(
        `
          insert into app.guides (
            id, source_language, title, source_markdown, stable_id_version, created_at
          )
          values ($1, $2, $3, $4, $5, $6)
          on conflict (id) do nothing
          returning id
        `,
        [
          guideId,
          record.guide.sourceLanguage ?? 'de',
          record.guide.title,
          record.guide.sourceMarkdown,
          STABLE_GUIDE_ID_VERSION,
          record.guide.createdAt,
        ],
      );

      const insertedRows = z.array(insertedGuideRowSchema).safeParse(inserted.rows);
      if (!insertedRows.success || insertedRows.data.length !== inserted.rowCount) {
        return failure(
          corruptData('guide', guideId, 'Guide insert returned an invalid row projection'),
        );
      }

      if (inserted.rowCount === 0) {
        return this.#resolveExistingImport(guideId, record);
      }
      if (inserted.rowCount !== 1 || insertedRows.data[0]?.id !== guideId) {
        return failure(
          corruptData('guide', guideId, 'Guide insert returned an unexpected identity'),
        );
      }

      const sectionWrite = await insertSections(this.#executor, guideId, record.guide.sections);
      if (!sectionWrite.ok) {
        return sectionWrite;
      }
      const questionWrite = await insertQuestions(this.#executor, guideId, record.guide.sections);
      if (!questionWrite.ok) {
        return questionWrite;
      }

      return success({ outcome: 'inserted', value: record });
    } catch (error: unknown) {
      return failure(mapDatabaseError(error, { resource: 'guide', identity: guideId }));
    }
  }

  async #resolveExistingImport(
    guideId: string,
    requested: ImportedGuideRecord,
  ): Promise<RepositoryResult<IdempotentWrite<ImportedGuideRecord>>> {
    const loaded = await this.getById(guideId);
    if (!loaded.ok) {
      return loaded;
    }

    const existingHash = hashSource(loaded.value.sourceMarkdown);
    if (
      existingHash !== requested.sourceHash ||
      serializeGuideStructure(loaded.value) !== serializeGuideStructure(requested.guide)
    ) {
      return failure({ code: 'duplicate_conflict', resource: 'guide', identity: guideId });
    }

    return success({
      outcome: 'existing',
      value: {
        guideId,
        guide: loaded.value,
        sourceHash: existingHash,
        importedAt: loaded.value.createdAt,
      },
    });
  }
}

function reconstructGuide(
  guideId: string,
  rows: readonly GuideRow[],
): RepositoryResult<InterviewGuideSnapshot> {
  const first = rows[0];
  if (first === undefined || first.guide_id !== guideId) {
    return failure(corruptData('guide', guideId, 'Guide query returned the wrong identity'));
  }
  if (
    rows.some(
      (row) =>
        row.guide_id !== first.guide_id ||
        row.source_language !== first.source_language ||
        row.guide_title !== first.guide_title ||
        row.source_markdown !== first.source_markdown ||
        row.stable_id_version !== first.stable_id_version ||
        row.guide_created_at !== first.guide_created_at,
    )
  ) {
    return failure(corruptData('guide', guideId, 'Guide rows contain inconsistent metadata'));
  }

  const sections = new Map<
    string,
    {
      readonly id: string;
      readonly position: number;
      readonly title: string;
      readonly mainQuestions: Map<string, MutableMainQuestion>;
    }
  >();
  const questionIds = new Set<string>();

  for (const row of rows) {
    if (row.section_id === null) {
      if (!hasNullQuestion(row)) {
        return failure(corruptData('guide', guideId, 'A question has no parent section'));
      }
      continue;
    }
    if (row.section_position === null || row.section_title === null) {
      return failure(corruptData('guide', guideId, 'A guide section is incomplete'));
    }
    if (row.question_kind === null && !hasNullQuestion(row)) {
      return failure(corruptData('guide', guideId, 'A guide question is incomplete'));
    }
    const existing = sections.get(row.section_id);
    if (existing === undefined) {
      sections.set(row.section_id, {
        id: row.section_id,
        position: row.section_position,
        title: row.section_title,
        mainQuestions: new Map(),
      });
    } else if (existing.position !== row.section_position || existing.title !== row.section_title) {
      return failure(corruptData('guide', guideId, `Section ${row.section_id} is inconsistent`));
    }
  }

  for (const row of rows) {
    if (row.question_kind !== 'main_question') {
      continue;
    }
    const question = completeQuestionRow(row);
    if (question === null || row.question_id !== row.main_question_id) {
      return failure(
        corruptData(
          'guide',
          guideId,
          question === null
            ? 'A guide question is incomplete'
            : 'Main-question hierarchy is invalid',
        ),
      );
    }
    const section = sections.get(question.section_id);
    if (section === undefined) {
      return failure(corruptData('guide', guideId, 'A main question has no section'));
    }
    if (questionIds.has(question.question_id)) {
      return failure(
        corruptData('guide', guideId, `Guide question ${question.question_id} is duplicated`),
      );
    }
    questionIds.add(question.question_id);
    section.mainQuestions.set(question.question_id, {
      id: question.question_id,
      position: question.question_position,
      text: question.question_text,
      followUpQuestions: [],
    });
  }

  for (const row of rows) {
    if (row.question_kind !== 'follow_up_question') {
      continue;
    }
    const question = completeQuestionRow(row);
    if (question === null) {
      return failure(corruptData('guide', guideId, 'A guide question is incomplete'));
    }
    if (question.question_id === question.main_question_id) {
      return failure(corruptData('guide', guideId, 'Follow-up hierarchy is invalid'));
    }
    if (questionIds.has(question.question_id)) {
      return failure(
        corruptData('guide', guideId, `Guide question ${question.question_id} is duplicated`),
      );
    }
    const section = sections.get(question.section_id);
    const mainQuestion = section?.mainQuestions.get(question.main_question_id);
    if (mainQuestion === undefined || mainQuestion.position !== question.main_position) {
      return failure(corruptData('guide', guideId, 'A follow-up has no valid main question'));
    }
    questionIds.add(question.question_id);
    mainQuestion.followUpQuestions.push({
      id: question.question_id,
      position: question.question_position,
      text: question.question_text,
    });
  }

  const materializedSections: ParsedGuideSection[] = [...sections.values()]
    .sort((left, right) => left.position - right.position)
    .map((section) => ({
      id: section.id,
      position: section.position,
      title: section.title,
      mainQuestions: [...section.mainQuestions.values()]
        .sort((left, right) => left.position - right.position)
        .map((question) => ({
          ...question,
          followUpQuestions: [...question.followUpQuestions].sort(
            (left, right) => left.position - right.position,
          ),
        })),
    }));
  const snapshot = {
    id: first.guide_id,
    sourceLanguage: first.source_language,
    title: first.guide_title,
    sourceMarkdown: first.source_markdown,
    createdAt: first.guide_created_at,
    sections: materializedSections,
  };
  const validated = interviewGuideSchema.safeParse(snapshot);
  return validated.success
    ? success(validated.data)
    : failure(corruptData('guide', guideId, formatZodIssues(validated.error)));
}

interface MutableMainQuestion extends Omit<ParsedMainQuestion, 'followUpQuestions'> {
  readonly followUpQuestions: ParsedFollowUpQuestion[];
}

function completeQuestionRow(row: GuideRow): CompleteQuestionRow | null {
  const {
    section_id,
    question_id,
    main_question_id,
    main_position,
    question_position,
    question_text,
  } = row;
  if (
    section_id === null ||
    question_id === null ||
    main_question_id === null ||
    main_position === null ||
    question_position === null ||
    question_text === null
  ) {
    return null;
  }
  return {
    ...row,
    section_id,
    question_id,
    main_question_id,
    main_position,
    question_position,
    question_text,
  };
}

function hasNullQuestion(row: GuideRow): boolean {
  return (
    row.question_id === null &&
    row.question_kind === null &&
    row.main_question_id === null &&
    row.main_position === null &&
    row.question_position === null &&
    row.question_text === null
  );
}

function validateImportInput(guideId: string, record: ImportedGuideRecord): string | null {
  const guide = interviewGuideSchema.safeParse(record.guide);
  if (!guide.success) {
    return 'guide_repository_input_schema';
  }
  if (guideId !== record.guideId || guideId !== record.guide.id) {
    return 'guide_repository_input_identity';
  }
  if (record.importedAt !== record.guide.createdAt) {
    return 'guide_repository_import_timestamp';
  }
  if (hashSource(record.guide.sourceMarkdown) !== record.sourceHash) {
    return 'guide_repository_source_hash';
  }
  return null;
}

async function insertSections(
  executor: SqlExecutor,
  guideId: string,
  sections: readonly ParsedGuideSection[],
): Promise<RepositoryResult<void>> {
  const rows = sections.map((section) => [guideId, section.id, section.position, section.title]);
  return executeBatchInsert(
    executor,
    'guide_sections',
    ['guide_id', 'id', 'position', 'title'],
    rows,
    guideId,
  );
}

async function insertQuestions(
  executor: SqlExecutor,
  guideId: string,
  sections: readonly ParsedGuideSection[],
): Promise<RepositoryResult<void>> {
  const mainRows = sections.flatMap((section) =>
    section.mainQuestions.map((question) => [
      guideId,
      question.id,
      section.id,
      'main_question',
      question.id,
      question.position,
      question.text,
    ]),
  );
  const followUpRows = sections.flatMap((section) =>
    section.mainQuestions.flatMap((question) =>
      question.followUpQuestions.map((followUp) => [
        guideId,
        followUp.id,
        section.id,
        'follow_up_question',
        question.id,
        followUp.position,
        followUp.text,
      ]),
    ),
  );
  const columns = [
    'guide_id',
    'id',
    'section_id',
    'kind',
    'main_question_id',
    'position',
    'text',
  ] as const;
  const mainWrite = await executeBatchInsert(
    executor,
    'guide_questions',
    columns,
    mainRows,
    guideId,
  );
  return mainWrite.ok
    ? executeBatchInsert(executor, 'guide_questions', columns, followUpRows, guideId)
    : mainWrite;
}

async function executeBatchInsert(
  executor: SqlExecutor,
  table: 'guide_sections' | 'guide_questions',
  columns: readonly string[],
  rows: readonly (readonly unknown[])[],
  guideId: string,
): Promise<RepositoryResult<void>> {
  if (rows.length === 0) {
    return success(undefined);
  }
  const parameters = rows.flat();
  const values = rows
    .map(
      (row, rowIndex) =>
        `(${row.map((_, columnIndex) => `$${String(rowIndex * columns.length + columnIndex + 1)}`).join(', ')})`,
    )
    .join(', ');
  try {
    const result = await executor.query(
      `insert into app.${table} (${columns.join(', ')}) values ${values}`,
      parameters,
    );
    if (!noRowsSchema.safeParse(result.rows).success || result.rowCount !== rows.length) {
      return failure(corruptData('guide', guideId, `${table} insert count is inconsistent`));
    }
    return success(undefined);
  } catch (error: unknown) {
    return failure(mapDatabaseError(error, { resource: 'guide', identity: guideId }));
  }
}

function hashSource(sourceMarkdown: string): string {
  return createHash('sha256').update(sourceMarkdown, 'utf8').digest('hex');
}

function serializeGuideStructure(guide: InterviewGuideSnapshot): string {
  return JSON.stringify({
    id: guide.id,
    sourceLanguage: guide.sourceLanguage ?? 'de',
    title: guide.title,
    sections: guide.sections.map((section) => ({
      id: section.id,
      position: section.position,
      title: section.title,
      mainQuestions: section.mainQuestions.map((question) => ({
        id: question.id,
        position: question.position,
        text: question.text,
        followUpQuestions: question.followUpQuestions.map((followUp) => ({
          id: followUp.id,
          position: followUp.position,
          text: followUp.text,
        })),
      })),
    })),
  });
}

function formatZodIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join('.') || '<row>'}: ${issue.message}`)
    .join('; ');
}
