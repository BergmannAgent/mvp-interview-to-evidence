import { createHash } from 'node:crypto';

import type { InterviewState, MonitoringEvent } from '@orgscience/contracts';
import {
  createReadyInterview,
  initializeGuideCoverage,
  parseInterviewGuideMarkdown,
  toInterviewGuideSnapshot,
  type GuideCoverageState,
  type InterviewGuideSnapshot,
  type InterviewLifecycleState,
  type TranscriptAggregate,
} from '@orgscience/domain';
import { describe, expect, it } from 'vitest';

import { GetGuideService } from './guides/get-guide.js';
import { ImportGuideService } from './guides/import-guide.js';
import { CreateInterviewService } from './interviews/create-interview.js';
import { GetInterviewService } from './interviews/get-interview.js';
import { projectInterviewView } from './interviews/interview-view.js';
import { ListInterviewsService } from './interviews/list-interviews.js';
import {
  failure,
  success,
  type AppReadContext,
  type AppTransaction,
  type AppUnitOfWork,
  type GuideRepository,
  type ImportedGuideRecord,
  type InterviewRepository,
  type InterviewSummaryPage,
  type MonitoringEventDraft,
  type OutboxRepository,
  type PersistedInterview,
  type RepositoryError,
  type RepositoryResult,
  type Result,
  type TranscriptRepository,
} from './persistence/index.js';
import type { Clock, Sha256 } from './runtime.js';

const T0 = '2026-08-08T10:00:00.000Z';
const T1 = '2026-08-08T10:01:00.000Z';
const T2 = '2026-08-08T10:02:00.000Z';
const T3 = '2026-08-08T10:03:00.000Z';
const INTERVIEW_ID = 'interview-application-1';
const GUIDE_MARKDOWN = `# Interviewleitfaden: Organizational Resilience

## Einführung

### Hauptfrage
Welche Rolle haben Sie im Unternehmen?

#### Vertiefungsfragen

- Seit wann arbeiten Sie in dieser Position?
- Für welche Bereiche tragen Sie Verantwortung?

## Ereignisse

### Hauptfrage
Bitte beschreiben Sie eine unerwartete Situation.

## Abschluss

### Hauptfrage
Gibt es noch etwas Wichtiges?
`;
const ENGLISH_GUIDE_MARKDOWN = `# Interview guide: Organizational Resilience

## Introduction

### Main question
What is your role in the organization?

## Closing

### Main question
Is there anything else that matters?`;

const clock: Clock = { now: () => T0 };
const hasher: Sha256 = {
  digestUtf8: (value) => createHash('sha256').update(value, 'utf8').digest('hex'),
};

interface FakeHandlers {
  readonly getGuide?: GuideRepository['getById'];
  readonly importGuide?: GuideRepository['import'];
  readonly loadInterview?: InterviewRepository['load'];
  readonly listInterviews?: InterviewRepository['listSummaries'];
  readonly createInterview?: InterviewRepository['create'];
  readonly initializeTranscript?: TranscriptRepository['initialize'];
  readonly appendOutbox?: OutboxRepository['append'];
}

class FakeUnitOfWork implements AppUnitOfWork {
  public transactionCount = 0;
  public readCount = 0;
  public commitCount = 0;
  public rollbackCount = 0;

  readonly #transactionContext: AppTransaction;
  readonly #readContext: AppReadContext;

  public constructor(handlers: FakeHandlers) {
    const guides = {
      getById: handlers.getGuide ?? (async () => unexpectedCall('guides.getById')),
      import: handlers.importGuide ?? (async () => unexpectedCall('guides.import')),
    };
    const interviews = {
      load:
        handlers.loadInterview ??
        (async (interviewId: string) =>
          failure({ code: 'not_found', resource: 'interview', id: interviewId })),
      listSummaries:
        handlers.listInterviews ?? (async () => unexpectedCall('interviews.listSummaries')),
      create: handlers.createInterview ?? (async () => unexpectedCall('interviews.create')),
    };
    const transcripts = {
      initialize:
        handlers.initializeTranscript ?? (async () => unexpectedCall('transcripts.initialize')),
    };
    const outbox = {
      append: handlers.appendOutbox ?? (async () => unexpectedCall('outbox.append')),
    };

    const supported = { guides, interviews, transcripts, outbox };
    this.#transactionContext = supported as unknown as AppTransaction;
    this.#readContext = supported as unknown as AppReadContext;
  }

  public async read<T>(
    operation: (context: AppReadContext) => Promise<RepositoryResult<T>>,
  ): Promise<RepositoryResult<T>> {
    this.readCount += 1;
    return operation(this.#readContext);
  }

  public async transaction<T, E = never>(
    operation: (transaction: AppTransaction) => Promise<Result<T, E | RepositoryError>>,
  ): Promise<Result<T, E | RepositoryError>> {
    this.transactionCount += 1;
    const result = await operation(this.#transactionContext);
    if (result.ok) {
      this.commitCount += 1;
    } else {
      this.rollbackCount += 1;
    }
    return result;
  }
}

describe('guide application services', () => {
  it('returns deterministic parser issues without opening a transaction', async () => {
    const unitOfWork = new FakeUnitOfWork({});
    const result = await new ImportGuideService(unitOfWork, clock, hasher).execute({
      markdown: '# Incomplete',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('guide_invalid');
      if (result.error.code === 'guide_invalid') {
        expect(result.error.issues.map((issue) => issue.code)).toContain('NO_MAIN_QUESTION');
      }
    }
    expect(unitOfWork.transactionCount).toBe(0);
  });

  it('reports overlong guide fields as user-correctable parser issues', async () => {
    const unitOfWork = new FakeUnitOfWork({});
    const result = await new ImportGuideService(unitOfWork, clock, hasher).execute({
      markdown: `# ${'x'.repeat(301)}\n\n## Abschnitt\n\n### Hauptfrage\nFrage?`,
    });

    expect(result.ok).toBe(false);
    if (!result.ok && result.error.code === 'guide_invalid') {
      expect(result.error.issues).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: 'TITLE_TOO_LONG', line: 1 })]),
      );
    }
    expect(unitOfWork.transactionCount).toBe(0);
  });

  it('returns bounded parser diagnostics without opening a transaction', async () => {
    const unitOfWork = new FakeUnitOfWork({});
    const result = await new ImportGuideService(unitOfWork, clock, hasher).execute({
      markdown: [
        '# Leitfaden',
        '## Abschnitt',
        ...Array.from({ length: 250 }, () => 'ungueltig'),
      ].join('\n'),
    });

    expect(result.ok).toBe(false);
    if (!result.ok && result.error.code === 'guide_invalid') {
      expect(result.error.issues).toHaveLength(100);
      expect(result.error.issues.at(-1)?.code).toBe('TOO_MANY_ISSUES');
    }
    expect(unitOfWork.transactionCount).toBe(0);
  });

  it('imports a BOM-prefixed guide at the exact shared source limit', async () => {
    const base = '# Leitfaden\n## Abschnitt\n### Hauptfrage\nFrage?';
    const markdown = `\uFEFF${base}\n${' '.repeat(1_000_000 - base.length - 2)}`;
    const unitOfWork = new FakeUnitOfWork({
      importGuide: async (_guideId, record) => success({ outcome: 'inserted', value: record }),
    });

    const result = await new ImportGuideService(unitOfWork, clock, hasher).execute({ markdown });

    expect(markdown).toHaveLength(1_000_000);
    expect(result.ok).toBe(true);
    expect(unitOfWork.transactionCount).toBe(1);
    expect(unitOfWork.commitCount).toBe(1);
  });

  it('contains invalid or throwing runtime adapters before persistence', async () => {
    const invalidClockUnit = new FakeUnitOfWork({});
    const invalidClock = await new ImportGuideService(
      invalidClockUnit,
      {
        now: () => {
          throw new Error('clock unavailable');
        },
      },
      hasher,
    ).execute({ markdown: GUIDE_MARKDOWN });
    expect(invalidClock).toEqual({
      ok: false,
      error: {
        code: 'runtime_dependency_invalid',
        dependency: 'clock',
        message: 'Clock must return an ISO 8601 timestamp with millisecond precision',
      },
    });

    const invalidHashUnit = new FakeUnitOfWork({});
    const invalidHash = await new ImportGuideService(invalidHashUnit, clock, {
      digestUtf8: () => 'NOT-A-SHA256',
    }).execute({ markdown: GUIDE_MARKDOWN });
    expect(invalidHash).toEqual({
      ok: false,
      error: {
        code: 'runtime_dependency_invalid',
        dependency: 'sha256',
        message: 'SHA-256 provider must return a lowercase 64-character hexadecimal digest',
      },
    });
    expect(invalidClockUnit.transactionCount).toBe(0);
    expect(invalidHashUnit.transactionCount).toBe(0);
  });

  it('imports a valid guide and returns the repository-owned idempotent value', async () => {
    const captured: ImportedGuideRecord[] = [];
    const unitOfWork = new FakeUnitOfWork({
      importGuide: async (guideId, record) => {
        expect(guideId).toBe(record.guide.id);
        captured.push(record);
        return success({ outcome: 'inserted', value: record });
      },
    });

    const result = await new ImportGuideService(unitOfWork, clock, hasher).execute({
      markdown: GUIDE_MARKDOWN,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.outcome).toBe('inserted');
      expect(result.value.guide.createdAt).toBe(T0);
    }
    expect(captured).toHaveLength(1);
    expect(captured[0]?.sourceHash).toBe(hasher.digestUtf8(GUIDE_MARKDOWN));
    expect(captured[0]?.importedAt).toBe(T0);
    expect(unitOfWork.commitCount).toBe(1);
    expect(unitOfWork.rollbackCount).toBe(0);
  });

  it('imports an English guide with an explicit persisted source language', async () => {
    let captured: ImportedGuideRecord | undefined;
    const unitOfWork = new FakeUnitOfWork({
      importGuide: async (_guideId, record) => {
        captured = record;
        return success({ outcome: 'inserted', value: record });
      },
    });

    const result = await new ImportGuideService(unitOfWork, clock, hasher).execute({
      markdown: ENGLISH_GUIDE_MARKDOWN,
      sourceLanguage: 'en',
    });

    expect(result).toMatchObject({
      ok: true,
      value: { guide: { sourceLanguage: 'en' } },
    });
    expect(captured?.guide.sourceLanguage).toBe('en');
  });

  it('preserves an existing guide value and rolls back unchanged repository failures', async () => {
    const stored = guideSnapshot('2026-08-01T08:00:00.000Z');
    const existingUnitOfWork = new FakeUnitOfWork({
      importGuide: async (_guideId, record) =>
        success({
          outcome: 'existing',
          value: { ...record, guide: stored, importedAt: stored.createdAt },
        }),
    });
    const existing = await new ImportGuideService(existingUnitOfWork, clock, hasher).execute({
      markdown: GUIDE_MARKDOWN,
    });
    expect(existing).toEqual({ ok: true, value: { outcome: 'existing', guide: stored } });

    const repositoryError = { code: 'unavailable', retryable: true } as const;
    const failingUnitOfWork = new FakeUnitOfWork({
      importGuide: async () => failure(repositoryError),
    });
    const failed = await new ImportGuideService(failingUnitOfWork, clock, hasher).execute({
      markdown: GUIDE_MARKDOWN,
    });
    expect(failed).toEqual({ ok: false, error: repositoryError });
    expect(failingUnitOfWork.rollbackCount).toBe(1);
  });

  it('gets a guide and propagates the exact repository failure', async () => {
    const guide = guideSnapshot();
    const found = await new GetGuideService(
      new FakeUnitOfWork({ getGuide: async () => success(guide) }),
    ).execute(guide.id);
    expect(found).toEqual({ ok: true, value: guide });

    const repositoryError = { code: 'not_found', resource: 'guide', id: guide.id } as const;
    const missing = await new GetGuideService(
      new FakeUnitOfWork({ getGuide: async () => failure(repositoryError) }),
    ).execute(guide.id);
    expect(missing).toEqual({ ok: false, error: repositoryError });
  });
});

describe('interview application services', () => {
  it('persists English as the immutable language of an English guide interview', async () => {
    const parsed = parseInterviewGuideMarkdown(ENGLISH_GUIDE_MARKDOWN, 'en');
    if (!parsed.success) throw new Error('English test guide must parse');
    const guide = toInterviewGuideSnapshot(parsed.guide, ENGLISH_GUIDE_MARKDOWN, T0);
    let created: PersistedInterview | undefined;
    const unitOfWork = new FakeUnitOfWork({
      getGuide: async () => success(guide),
      createInterview: async (_interviewId, interview) => {
        created = interview;
        return success({ outcome: 'inserted', value: interview });
      },
      initializeTranscript: async (_interviewId, transcript) =>
        success({ outcome: 'inserted', value: transcript }),
      appendOutbox: async (_interviewId, event) =>
        success({
          outcome: 'inserted',
          value: { ...event, language: 'en', sequenceNumber: 1 } as MonitoringEvent,
        }),
    });

    const result = await new CreateInterviewService(unitOfWork, clock, hasher).execute({
      interviewId: INTERVIEW_ID,
      guideId: guide.id,
      language: 'en',
    });

    expect(result).toMatchObject({
      ok: true,
      value: { interviewState: { language: 'en' } },
    });
    expect(created?.language).toBe('en');
  });

  it('rejects a guide/interview language mismatch before creating interview state', async () => {
    const guide = guideSnapshot();
    let createCalls = 0;
    const unitOfWork = new FakeUnitOfWork({
      getGuide: async () => success(guide),
      createInterview: async () => {
        createCalls += 1;
        return failure({ code: 'internal', retryable: false });
      },
    });

    const result = await new CreateInterviewService(unitOfWork, clock, hasher).execute({
      interviewId: INTERVIEW_ID,
      guideId: guide.id,
      language: 'en',
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'application_validation',
        field: 'language',
        message: 'Interview and guide language must match',
      },
    });
    expect(createCalls).toBe(0);
    expect(unitOfWork.rollbackCount).toBe(1);
  });

  it('creates all initial state atomically and emits one stable status event across a retry', async () => {
    const guide = guideSnapshot();
    const calls: string[] = [];
    const persistedInterviews: PersistedInterview[] = [];
    const transcripts: TranscriptAggregate[] = [];
    const events: MonitoringEventDraft[] = [];
    const unitOfWork = new FakeUnitOfWork({
      getGuide: async (guideId) => {
        calls.push('guide.get');
        expect(guideId).toBe(guide.id);
        return success(guide);
      },
      loadInterview: async (interviewId) => {
        calls.push('interview.load');
        const existing = persistedInterviews[0];
        return existing === undefined
          ? failure({ code: 'not_found', resource: 'interview', id: interviewId })
          : success(existing);
      },
      createInterview: async (interviewId, interview) => {
        calls.push('interview.create');
        expect(interviewId).toBe(INTERVIEW_ID);
        persistedInterviews.push(interview);
        return success({
          outcome: 'inserted',
          value: interview,
        });
      },
      initializeTranscript: async (_interviewId, aggregate) => {
        calls.push('transcript.initialize');
        transcripts.push(aggregate);
        return success({
          outcome: 'inserted',
          value: aggregate,
        });
      },
      appendOutbox: async (_interviewId, event) => {
        calls.push('outbox.append');
        events.push(event);
        return success({
          outcome: 'inserted',
          value: { ...event, sequenceNumber: 1 } as MonitoringEvent,
        });
      },
    });
    const service = new CreateInterviewService(unitOfWork, clock, hasher);

    const first = await service.execute({ interviewId: INTERVIEW_ID, guideId: guide.id });
    const retry = await service.execute({ interviewId: INTERVIEW_ID, guideId: guide.id });

    expect(first.ok).toBe(true);
    expect(retry.ok).toBe(true);
    if (first.ok && retry.ok) {
      expect(first.value.outcome).toBe('inserted');
      expect(retry.value.outcome).toBe('existing');
      expect(retry.value.interviewState).toEqual(first.value.interviewState);
    }
    expect(calls).toEqual([
      'guide.get',
      'interview.load',
      'interview.create',
      'transcript.initialize',
      'outbox.append',
      'guide.get',
      'interview.load',
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      interviewId: INTERVIEW_ID,
      occurredAt: T0,
      category: 'interview',
      type: 'interview.status_changed',
      payload: { previousStatus: null, nextStatus: 'ready', changedAt: T0 },
    });
    expect(events[0]?.eventId).toMatch(/^event\.interview-created\.v1:[a-f0-9]{64}$/u);
    expect(events[0]?.runId).toMatch(/^run\.interview-create\.v1:[a-f0-9]{64}$/u);
    expect(events[0]?.eventId.length).toBeLessThanOrEqual(128);
    expect(events[0]?.runId.length).toBeLessThanOrEqual(128);

    const persisted = persistedInterviews[0]!;
    expect(persistedInterviews).toHaveLength(1);
    expect(persisted.lifecycle).toEqual({
      status: 'ready',
      interviewId: INTERVIEW_ID,
      guideId: guide.id,
      createdAt: T0,
      revision: 0,
    });
    expect(persisted.coverage.questions).toHaveLength(5);
    expect(persisted.coverage.questions.every((item) => item.status === 'not_addressed')).toBe(
      true,
    );
    expect(transcripts[0]?.guideQuestionIndex).toEqual(expectedTranscriptReferences(guide));
    expect(unitOfWork.commitCount).toBe(2);
    expect(unitOfWork.rollbackCount).toBe(0);
  });

  it('returns a progressed existing interview without runtime or write dependencies', async () => {
    const guide = guideSnapshot();
    const existing: PersistedInterview = {
      ...readyInterview(guide),
      lifecycle: lifecycle('active', 1),
      version: 1,
      updatedAt: T1,
    };
    const unitOfWork = new FakeUnitOfWork({
      getGuide: async () => success(guide),
      loadInterview: async () => success(existing),
    });
    const service = new CreateInterviewService(
      unitOfWork,
      { now: () => unexpectedCall('clock.now') },
      { digestUtf8: () => unexpectedCall('sha256.digestUtf8') },
    );

    const result = await service.execute({ interviewId: INTERVIEW_ID, guideId: guide.id });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.outcome).toBe('existing');
      expect(result.value.interviewState.lifecycle.status).toBe('active');
      expect(result.value.interviewState.version).toBe(1);
    }
    expect(unitOfWork.commitCount).toBe(1);
  });

  it('retries one serialization race and resolves the committed interview as existing', async () => {
    const guide = guideSnapshot();
    let concurrentWinner: PersistedInterview | undefined;
    let createCalls = 0;
    const unitOfWork = new FakeUnitOfWork({
      getGuide: async () => success(guide),
      loadInterview: async (interviewId) =>
        concurrentWinner === undefined
          ? failure({ code: 'not_found', resource: 'interview', id: interviewId })
          : success(concurrentWinner),
      createInterview: async (_interviewId, interview) => {
        createCalls += 1;
        concurrentWinner = interview;
        return failure({ code: 'serialization_failure', retryable: true });
      },
    });

    const result = await new CreateInterviewService(unitOfWork, clock, hasher).execute({
      interviewId: INTERVIEW_ID,
      guideId: guide.id,
    });

    expect(result).toMatchObject({ ok: true, value: { outcome: 'existing' } });
    expect(createCalls).toBe(1);
    expect(unitOfWork.transactionCount).toBe(2);
    expect(unitOfWork.rollbackCount).toBe(1);
    expect(unitOfWork.commitCount).toBe(1);
  });

  it('rejects reuse of an interview ID with a different guide before writes', async () => {
    const requestedGuide = guideSnapshot();
    const otherGuide = guideSnapshotFrom(
      GUIDE_MARKDOWN.replace('Organizational Resilience', 'Other'),
    );
    const existing = readyInterview(otherGuide);
    let createCalls = 0;
    let transcriptCalls = 0;
    const unitOfWork = new FakeUnitOfWork({
      getGuide: async () => success(requestedGuide),
      loadInterview: async () => success(existing),
      createInterview: async () => {
        createCalls += 1;
        return failure({ code: 'internal', retryable: false });
      },
      initializeTranscript: async () => {
        transcriptCalls += 1;
        return failure({ code: 'internal', retryable: false });
      },
    });

    const result = await new CreateInterviewService(unitOfWork, clock, hasher).execute({
      interviewId: INTERVIEW_ID,
      guideId: requestedGuide.id,
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'duplicate_conflict',
        resource: 'interview',
        identity: INTERVIEW_ID,
      },
    });
    expect(createCalls).toBe(0);
    expect(transcriptCalls).toBe(0);
    expect(unitOfWork.rollbackCount).toBe(1);
  });

  it('rolls back the whole create operation and preserves a late outbox error', async () => {
    const guide = guideSnapshot();
    const repositoryError = { code: 'serialization_failure', retryable: true } as const;
    const unitOfWork = new FakeUnitOfWork({
      getGuide: async () => success(guide),
      createInterview: async (_id, interview) => success({ outcome: 'inserted', value: interview }),
      initializeTranscript: async (_id, aggregate) =>
        success({ outcome: 'inserted', value: aggregate }),
      appendOutbox: async () => failure(repositoryError),
    });

    const result = await new CreateInterviewService(unitOfWork, clock, hasher).execute({
      interviewId: INTERVIEW_ID,
      guideId: guide.id,
    });

    expect(result).toEqual({ ok: false, error: repositoryError });
    expect(unitOfWork.commitCount).toBe(0);
    expect(unitOfWork.rollbackCount).toBe(2);
  });

  it('stops at each failed repository boundary without replacing its typed error', async () => {
    const guide = guideSnapshot();
    const repositoryError = { code: 'internal', retryable: false } as const;
    const cases: readonly FakeHandlers[] = [
      { getGuide: async () => failure(repositoryError) },
      {
        getGuide: async () => success(guide),
        loadInterview: async () => failure(repositoryError),
      },
      {
        getGuide: async () => success(guide),
        createInterview: async () => failure(repositoryError),
      },
      {
        getGuide: async () => success(guide),
        createInterview: async (_id, interview) =>
          success({ outcome: 'inserted', value: interview }),
        initializeTranscript: async () => failure(repositoryError),
      },
    ];

    for (const handlers of cases) {
      const unitOfWork = new FakeUnitOfWork(handlers);
      const result = await new CreateInterviewService(unitOfWork, clock, hasher).execute({
        interviewId: INTERVIEW_ID,
        guideId: guide.id,
      });
      expect(result).toEqual({ ok: false, error: repositoryError });
      expect(unitOfWork.rollbackCount).toBe(1);
    }
  });

  it('rejects invalid command IDs before reading runtime or persistence', async () => {
    let clockReads = 0;
    const unitOfWork = new FakeUnitOfWork({});
    const result = await new CreateInterviewService(
      unitOfWork,
      { now: () => ((clockReads += 1), T0) },
      hasher,
    ).execute({ interviewId: 'invalid interview', guideId: 'guide-1' });

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'application_validation',
        field: 'interviewId',
        message: 'Interview ID does not satisfy the shared ID contract',
      },
    });
    expect(clockReads).toBe(0);
    expect(unitOfWork.transactionCount).toBe(0);
  });

  it('gets an interview with its guide-backed view and lists repository summaries', async () => {
    const guide = guideSnapshot();
    const interview = readyInterview(guide);
    const getUnitOfWork = new FakeUnitOfWork({
      loadInterview: async () => success(interview),
      getGuide: async () => success(guide),
    });
    const found = await new GetInterviewService(getUnitOfWork).execute(INTERVIEW_ID);
    expect(found.ok).toBe(true);
    expect(getUnitOfWork.readCount).toBe(1);

    const page: InterviewSummaryPage = {
      interviews: [
        {
          interviewId: INTERVIEW_ID,
          guideId: guide.id,
          guideTitle: guide.title,
          language: 'de',
          status: 'ready',
          currentMainQuestionId: null,
          activeWorkflowRunId: null,
          createdAt: T0,
          updatedAt: T0,
          startedAt: null,
        },
      ],
      nextCursor: 'cursor-2',
    };
    const listUnitOfWork = new FakeUnitOfWork({
      listInterviews: async (query) => {
        expect(query).toEqual({ after: 'cursor-1', limit: 20 });
        return success(page);
      },
    });
    const listed = await new ListInterviewsService(listUnitOfWork).execute({
      after: 'cursor-1',
      limit: 20,
    });
    expect(listed).toEqual({ ok: true, value: page });
  });

  it('propagates get and list failures without changing repository details', async () => {
    const interviewError = {
      code: 'not_found',
      resource: 'interview',
      id: INTERVIEW_ID,
    } as const;
    const getResult = await new GetInterviewService(
      new FakeUnitOfWork({ loadInterview: async () => failure(interviewError) }),
    ).execute(INTERVIEW_ID);
    expect(getResult).toEqual({ ok: false, error: interviewError });

    const listError = { code: 'unavailable', retryable: true } as const;
    const listResult = await new ListInterviewsService(
      new FakeUnitOfWork({ listInterviews: async () => failure(listError) }),
    ).execute({ after: null, limit: 20 });
    expect(listResult).toEqual({ ok: false, error: listError });

    const cursorResult = await new ListInterviewsService(
      new FakeUnitOfWork({
        listInterviews: async () =>
          failure({ code: 'constraint_violation', constraint: 'interview_summary_cursor' }),
      }),
    ).execute({ after: 'abc', limit: 20 });
    expect(cursorResult).toEqual({
      ok: false,
      error: {
        code: 'application_validation',
        field: 'after',
        message: 'The interview list cursor is invalid or no longer supported',
      },
    });
  });

  it('fails closed when a persisted interview summary violates the HTTP contract', async () => {
    const guide = guideSnapshot();
    const invalidPage: InterviewSummaryPage = {
      interviews: [
        {
          interviewId: INTERVIEW_ID,
          guideId: guide.id,
          guideTitle: guide.title,
          status: 'active',
          currentMainQuestionId: null,
          activeWorkflowRunId: null,
          createdAt: T2,
          updatedAt: T1,
          startedAt: T0,
        },
      ],
      nextCursor: null,
    };
    const result = await new ListInterviewsService(
      new FakeUnitOfWork({ listInterviews: async () => success(invalidPage) }),
    ).execute({ after: null, limit: 20 });

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'application_invariant',
        resource: 'interview_summary',
        id: 'summary-page',
        message: 'Interview summary page does not satisfy the shared HTTP contract',
      },
    });
  });
});

describe('interview view projection', () => {
  it('projects every lifecycle variant through the shared interview contract', () => {
    const guide = guideSnapshot();
    const lifecycleCases: readonly InterviewLifecycleState[] = [
      lifecycle('ready', 0),
      lifecycle('active', 1),
      lifecycle('paused', 2),
      lifecycle('ending', 2),
      lifecycle('completed', 3),
      lifecycle('failed', 1),
    ];

    for (const candidate of lifecycleCases) {
      const interview: PersistedInterview = {
        ...readyInterview(guide),
        lifecycle: candidate,
        version: candidate.revision,
        updatedAt: candidate.status === 'ready' ? T0 : T3,
      };
      const projected = projectInterviewView(interview, guide);
      expect(projected.ok).toBe(true);
      if (projected.ok) {
        expect(projected.value.lifecycle.status).toBe(candidate.status);
      }
    }
  });

  it('maps every coverage status and complete main/follow-up references in guide order', () => {
    const guide = guideSnapshot();
    const base = readyInterview(guide);
    const statuses = [
      'current',
      'partially_answered',
      'answered',
      'skipped_already_answered',
      'not_addressed',
    ] as const;
    const coverage: GuideCoverageState = {
      ...base.coverage,
      revision: 1,
      questions: base.coverage.questions.map((question, index) => {
        const status = statuses[index]!;
        const hasEvidence = status !== 'current' && status !== 'not_addressed';
        return {
          ...question,
          status,
          referencedTurnIds: hasEvidence ? [`turn-${String(index)}`] : [],
          updatedAt: T1,
        };
      }),
    };
    const projected = projectInterviewView({ ...base, coverage }, guide);

    expect(projected.ok).toBe(true);
    if (!projected.ok) return;
    expect(projected.value.coverage.map((item) => item.status)).toEqual(statuses);
    expect(projected.value.coverage.map((item) => item.question)).toEqual(
      expectedContractReferences(guide),
    );
    expect(projected.value.currentMainQuestion).toEqual(expectedContractReferences(guide)[0]);
  });

  it('projects a current follow-up through its parent main question', () => {
    const guide = guideSnapshot();
    const base = readyInterview(guide);
    const followUp = base.coverage.questions.find((question) => question.kind === 'follow_up');
    if (followUp === undefined) throw new Error('Test guide requires a follow-up question');
    const coverage: GuideCoverageState = {
      ...base.coverage,
      questions: base.coverage.questions.map((question) =>
        question.questionId === followUp.questionId
          ? { ...question, status: 'current', updatedAt: T1 }
          : question,
      ),
    };

    const projected = projectInterviewView({ ...base, coverage }, guide);

    expect(projected.ok).toBe(true);
    if (!projected.ok) return;
    expect(projected.value.currentMainQuestion).toEqual({
      kind: 'main_question',
      guideId: guide.id,
      sectionId: guide.sections[0]?.id,
      mainQuestionId: followUp.mainQuestionId,
    });
  });

  it('fails closed when persisted coverage no longer matches the loaded guide', () => {
    const guide = guideSnapshot();
    const interview = readyInterview(guide);
    const invalid: PersistedInterview = {
      ...interview,
      coverage: {
        ...interview.coverage,
        questions: interview.coverage.questions.slice(1),
      },
    };

    const result = projectInterviewView(invalid, guide);
    expect(result).toEqual({
      ok: false,
      error: {
        code: 'application_invariant',
        resource: 'interview_view',
        id: INTERVIEW_ID,
        message: 'Coverage must contain every guide question once',
      },
    });
  });
});

function guideSnapshot(createdAt = T0): InterviewGuideSnapshot {
  return guideSnapshotFrom(GUIDE_MARKDOWN, createdAt);
}

function guideSnapshotFrom(markdown: string, createdAt = T0): InterviewGuideSnapshot {
  const parsed = parseInterviewGuideMarkdown(markdown);
  if (!parsed.success) {
    throw new Error('Test guide must parse');
  }
  return toInterviewGuideSnapshot(parsed.guide, markdown, createdAt);
}

function readyInterview(guide: InterviewGuideSnapshot): PersistedInterview {
  return {
    interviewId: INTERVIEW_ID,
    guideId: guide.id,
    lifecycle: createReadyInterview({
      interviewId: INTERVIEW_ID,
      guideId: guide.id,
      createdAt: T0,
    }),
    coverage: initializeGuideCoverage(guide, INTERVIEW_ID),
    version: 0,
    activeWorkflowRunId: null,
    createdAt: T0,
    updatedAt: T0,
  };
}

function lifecycle(
  status: InterviewLifecycleState['status'],
  revision: number,
): InterviewLifecycleState {
  const base = {
    interviewId: INTERVIEW_ID,
    guideId: guideSnapshot().id,
    createdAt: T0,
    revision,
  };
  switch (status) {
    case 'ready':
      return { ...base, status };
    case 'active':
      return { ...base, status, startedAt: T1, activeSince: T1 };
    case 'paused':
      return { ...base, status, startedAt: T1, pausedAt: T2 };
    case 'ending':
      return { ...base, status, startedAt: T1, endingAt: T2, endingFrom: 'active' };
    case 'completed':
      return { ...base, status, startedAt: T1, endingAt: T2, endedAt: T3 };
    case 'failed':
      return {
        ...base,
        status,
        startedAt: null,
        failedAt: T1,
        failedFrom: 'ready',
        failure: { code: 'provider_error', message: 'Provider failed' },
      };
  }
}

function expectedTranscriptReferences(
  guide: InterviewGuideSnapshot,
): TranscriptAggregate['guideQuestionIndex'] {
  return guide.sections.flatMap((section) =>
    section.mainQuestions.flatMap((mainQuestion) => [
      {
        kind: 'main_question' as const,
        guideId: guide.id,
        sectionId: section.id,
        mainQuestionId: mainQuestion.id,
      },
      ...mainQuestion.followUpQuestions.map((followUp) => ({
        kind: 'follow_up_question' as const,
        guideId: guide.id,
        sectionId: section.id,
        mainQuestionId: mainQuestion.id,
        followUpQuestionId: followUp.id,
      })),
    ]),
  );
}

function expectedContractReferences(
  guide: InterviewGuideSnapshot,
): InterviewState['coverage'][number]['question'][] {
  return [...expectedTranscriptReferences(guide)];
}

function unexpectedCall(name: string): never {
  throw new Error(`Unexpected fake repository call: ${name}`);
}
