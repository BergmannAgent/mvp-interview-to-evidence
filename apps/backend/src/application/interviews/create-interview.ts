import {
  idSchema,
  supportedLocaleSchema,
  type InterviewState,
  type SupportedLocale,
} from '@orgscience/contracts';
import {
  createReadyInterview,
  createTranscriptAggregate,
  buildGuideQuestionCatalog,
  initializeGuideCoverage,
  type InterviewGuideSnapshot,
  type TranscriptGuideReference,
} from '@orgscience/domain';

import {
  failure,
  success,
  type AppUnitOfWork,
  type MonitoringEventDraft,
  type PersistedInterview,
} from '../persistence/index.js';
import { deterministicId, readClock, type Clock, type Sha256 } from '../runtime.js';
import type { ApplicationError, ApplicationResult } from '../errors.js';
import { projectInterviewView } from './interview-view.js';

export interface CreateInterviewInput {
  readonly interviewId: string;
  readonly guideId: string;
  readonly language?: SupportedLocale;
}

interface NormalizedCreateInterviewInput extends CreateInterviewInput {
  readonly language: SupportedLocale;
}

export interface CreateInterviewOutput {
  readonly outcome: 'inserted' | 'existing';
  readonly interviewState: InterviewState;
}

export class CreateInterviewService {
  public constructor(
    private readonly unitOfWork: AppUnitOfWork,
    private readonly clock: Clock,
    private readonly hasher: Sha256,
  ) {}

  public async execute(
    input: CreateInterviewInput,
  ): Promise<ApplicationResult<CreateInterviewOutput>> {
    const language = input.language ?? 'de';
    if (!idSchema.safeParse(input.interviewId).success) {
      return failure({
        code: 'application_validation',
        field: 'interviewId',
        message: 'Interview ID does not satisfy the shared ID contract',
      });
    }
    if (!idSchema.safeParse(input.guideId).success) {
      return failure({
        code: 'application_validation',
        field: 'guideId',
        message: 'Guide ID does not satisfy the shared ID contract',
      });
    }
    if (!supportedLocaleSchema.safeParse(language).success) {
      return failure({
        code: 'application_validation',
        field: 'language',
        message: 'Interview language must be de or en',
      });
    }

    const normalizedInput: NormalizedCreateInterviewInput = { ...input, language };
    const firstAttempt = await this.#executeTransaction(normalizedInput);
    if (!firstAttempt.ok && firstAttempt.error.code === 'serialization_failure') {
      return this.#executeTransaction(normalizedInput);
    }
    return firstAttempt;
  }

  async #executeTransaction(
    input: NormalizedCreateInterviewInput,
  ): Promise<ApplicationResult<CreateInterviewOutput>> {
    return this.unitOfWork.transaction<CreateInterviewOutput, ApplicationError>(
      async (transaction) => {
        const guideResult = await transaction.guides.getById(input.guideId);
        if (!guideResult.ok) {
          return guideResult;
        }
        if ((guideResult.value.sourceLanguage ?? 'de') !== input.language) {
          return failure({
            code: 'application_validation',
            field: 'language',
            message: 'Interview and guide language must match',
          });
        }

        const existingInterview = await transaction.interviews.load(input.interviewId);
        if (
          !existingInterview.ok &&
          !(
            existingInterview.error.code === 'not_found' &&
            existingInterview.error.resource === 'interview' &&
            existingInterview.error.id === input.interviewId
          )
        ) {
          return existingInterview;
        }
        if (
          existingInterview.ok &&
          (existingInterview.value.guideId !== input.guideId ||
            (existingInterview.value.language ?? 'de') !== (input.language ?? 'de'))
        ) {
          return failure({
            code: 'duplicate_conflict',
            resource: 'interview',
            identity: input.interviewId,
          });
        }
        if (existingInterview.ok) {
          const interviewState = projectInterviewView(existingInterview.value, guideResult.value);
          return interviewState.ok
            ? success({ outcome: 'existing', interviewState: interviewState.value })
            : interviewState;
        }

        const createdAt = readClock(this.clock);
        if (!createdAt.ok) {
          return createdAt;
        }

        const initialized = initializeInterview(input, guideResult.value, createdAt.value);
        if (!initialized.ok) {
          return initialized;
        }

        const interviewWrite = await transaction.interviews.create(
          input.interviewId,
          initialized.value.interview,
        );
        if (!interviewWrite.ok) {
          return interviewWrite;
        }

        if (interviewWrite.value.outcome === 'existing') {
          const interviewState = projectInterviewView(
            interviewWrite.value.value,
            guideResult.value,
          );
          return interviewState.ok
            ? success({ outcome: 'existing', interviewState: interviewState.value })
            : interviewState;
        }

        const transcriptWrite = await transaction.transcripts.initialize(
          input.interviewId,
          initialized.value.transcript,
        );
        if (!transcriptWrite.ok) {
          return transcriptWrite;
        }

        const event = createInitialStatusEvent(input.interviewId, createdAt.value, this.hasher);
        if (!event.ok) {
          return event;
        }
        const eventWrite = await transaction.outbox.append(input.interviewId, event.value);
        if (!eventWrite.ok) {
          return eventWrite;
        }

        const interviewState = projectInterviewView(interviewWrite.value.value, guideResult.value);
        return interviewState.ok
          ? success({
              outcome: interviewWrite.value.outcome,
              interviewState: interviewState.value,
            })
          : interviewState;
      },
    );
  }
}

function initializeInterview(
  input: NormalizedCreateInterviewInput,
  guide: InterviewGuideSnapshot,
  createdAt: string,
): ApplicationResult<{
  readonly interview: PersistedInterview;
  readonly transcript: ReturnType<typeof createTranscriptAggregate>;
}> {
  try {
    const lifecycle = createReadyInterview({
      interviewId: input.interviewId,
      guideId: input.guideId,
      createdAt,
    });
    const coverage = initializeGuideCoverage(guide, input.interviewId);
    const interview: PersistedInterview = {
      interviewId: input.interviewId,
      guideId: input.guideId,
      language: input.language,
      lifecycle,
      coverage,
      version: 0,
      activeWorkflowRunId: null,
      createdAt,
      updatedAt: createdAt,
    };
    return success({
      interview,
      transcript: createTranscriptAggregate(
        input.interviewId,
        input.guideId,
        toTranscriptGuideReferences(guide),
      ),
    });
  } catch {
    return failure({
      code: 'application_invariant',
      resource: 'guide',
      id: guide.id,
      message: 'Persisted guide cannot initialize interview state',
    });
  }
}

function toTranscriptGuideReferences(
  guide: InterviewGuideSnapshot,
): readonly TranscriptGuideReference[] {
  return buildGuideQuestionCatalog(guide).map((question) => question.reference);
}

function createInitialStatusEvent(
  interviewId: string,
  createdAt: string,
  hasher: Sha256,
): ApplicationResult<MonitoringEventDraft> {
  const eventId = deterministicId('event.interview-created.v1', interviewId, hasher);
  if (!eventId.ok) {
    return eventId;
  }
  const runId = deterministicId('run.interview-create.v1', interviewId, hasher);
  if (!runId.ok) {
    return runId;
  }

  const event = {
    eventId: eventId.value,
    interviewId,
    runId: runId.value,
    occurredAt: createdAt,
    category: 'interview',
    type: 'interview.status_changed',
    payload: {
      previousStatus: null,
      nextStatus: 'ready',
      changedAt: createdAt,
    },
  } satisfies MonitoringEventDraft;
  return success(event);
}
