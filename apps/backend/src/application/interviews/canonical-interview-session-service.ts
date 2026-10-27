import { createHash, randomUUID } from 'node:crypto';

import {
  canonicalTranscriptSchema,
  DEFAULT_LOCALE,
  guideStructureSchema,
  mvpRealtimeContextUpdateSchema,
  type GuideQuestionReference,
  type ModelMetadata,
  type MonitoringEvent,
  type MvpInterviewSession,
  type MvpPartialTranscriptRequest,
  type MvpParticipantTurnRequest,
  type MvpRealtimeAiTurnRequest,
  type MvpRealtimeAppendResponse,
  type MvpRealtimeCommandResponse,
  type MvpRealtimeContextUpdate,
  type MvpRealtimeGapRequest,
  type MvpRealtimeInterruptedAiTurnRequest,
  type MvpRealtimeTurnIntentRequest,
  type MvpRealtimePlanningMetadata,
  type MvpRealtimeTurnPlan,
  type MvpSessionCommandResponse,
  type MvpTranscriptTurn,
  type SectionMemory,
  type StructuredAgentOutput,
  type SupportedLocale,
  type VoiceState,
  voiceDiagnosticSchema,
  type VoiceDiagnostic,
} from '@orgscience/contracts';
import {
  appendAiTranscriptTurn,
  applyCoverageUpdates,
  buildGuideQuestionCatalog,
  detectGuideSectionTransition,
  ingestFinalParticipantSegment,
  ingestPartialParticipantSegment,
  recordTranscriptTechnicalGap,
  transitionInterview,
  validateFinalTranscript,
  validateSectionMemoryAgainstSource,
  type AiTranscriptTurn,
  type AiTurnType,
  type CoverageUpdate,
  type FinalizedParticipantSegment,
  type FollowUpGuideQuestionCatalogEntry,
  type InterviewGuideSnapshot,
  type ParticipantTranscriptTurn,
  type TranscriptAggregate,
  type TranscriptGuideReference,
  type TranscriptTechnicalGap,
} from '@orgscience/domain';

import {
  transcriptFinalizationPromptInputSchema,
  type InterviewAgentExecutor,
} from '../agents/index.js';
import {
  failure,
  success,
  type AppTransaction,
  type AppUnitOfWork,
  type DurableJob,
  type MonitoringEventDraft,
  type PersistedInterview,
  type RepositoryError,
  type RepositoryResult,
  type StoredAiDelivery,
  type StoredAgentInput,
  type StoredAgentRun,
  type StoredContradiction,
  type StoredFinalization,
  type StoredWorkflowAttempt,
} from '../persistence/index.js';
import { readClock, type Clock } from '../runtime.js';
import {
  createInterviewTurnWorkflow,
  PersistedInterviewTurnAgentRunner,
  type InterviewTurnWorkflowInput,
  type InterviewTurnWorkflowOutput,
} from '../workflows/index.js';
import { resolveCanonicalIngressTiming } from './canonical-ingress-timing.js';
import { projectCanonicalSession } from './canonical-session-projection.js';
import { projectInterviewView } from './interview-view.js';
import { REALTIME_QUESTION_LIMITS, realtimeQuestionHistory } from './realtime-question-history.js';
import {
  buildRealtimeInterviewInstructions,
  selectRealtimeTranscriptTurns,
} from './realtime-interview-instructions.js';
import {
  compactSectionWithTimeout,
  deterministicSectionMemoryCompactor,
  type SectionMemoryCompactor,
} from './section-memory-compactor.js';

const WORKER_ID = 'inline-realtime-worker';
const JOB_LEASE_MS = 5 * 60_000;
const INTERVIEW_UTTERANCES = {
  de: {
    greeting: 'Guten Tag und vielen Dank, dass Sie sich Zeit fuer dieses Interview nehmen.',
    closing: 'Vielen Dank fuer das Gespraech und Ihre Zeit.',
  },
  en: {
    greeting: 'Hello, and thank you for taking the time to participate in this interview.',
    closing: 'Thank you for the conversation and for your time.',
  },
} as const satisfies Readonly<
  Record<SupportedLocale, { readonly greeting: string; readonly closing: string }>
>;
const DEFAULT_SECTION_MEMORY_TIMEOUT_MS = 250;
type TechnicalGapDescriptionKind =
  | 'exact_utterance_mismatch'
  | 'partial_not_finalized'
  | 'pending_ai_cancelled'
  | 'unconfirmed_interruption';
const TECHNICAL_GAP_DESCRIPTIONS = {
  de: {
    exact_utterance_mismatch:
      'Der Anbieter hat die exakt serverseitig geplante Aussage nicht bestaetigt.',
    partial_not_finalized:
      'Ein begonnenes partielles Spracherkennungssegment wurde beim Interviewabschluss nicht mehr final bestaetigt.',
    pending_ai_cancelled: 'Die ausstehende AI-Ausgabe wurde durch das Interviewende abgebrochen.',
    unconfirmed_interruption:
      'Die AI-Audioausgabe wurde unterbrochen, bevor ein gesprochener Teil bestaetigt werden konnte.',
  },
  en: {
    exact_utterance_mismatch: 'The provider did not confirm the exact server-planned utterance.',
    partial_not_finalized:
      'A partial speech recognition segment was not finally confirmed before the interview ended.',
    pending_ai_cancelled: 'The pending AI output was cancelled when the interview ended.',
    unconfirmed_interruption:
      'The AI audio output was interrupted before a spoken prefix could be confirmed.',
  },
} as const satisfies Readonly<
  Record<SupportedLocale, Readonly<Record<TechnicalGapDescriptionKind, string>>>
>;

export class MvpSessionError extends Error {
  public constructor(
    public readonly code: 'not_found' | 'invalid_state' | 'invalid_request' | 'conflict',
    message: string,
  ) {
    super(message);
    this.name = 'MvpSessionError';
  }
}

export function interviewGreetingText(language: SupportedLocale = DEFAULT_LOCALE): string {
  return INTERVIEW_UTTERANCES[language].greeting;
}

export function interviewClosingText(language: SupportedLocale = DEFAULT_LOCALE): string {
  return INTERVIEW_UTTERANCES[language].closing;
}

export function interviewTechnicalGapDescription(
  language: SupportedLocale,
  kind: TechnicalGapDescriptionKind,
): string {
  return TECHNICAL_GAP_DESCRIPTIONS[language][kind];
}

export interface CanonicalInterviewSessionServiceOptions {
  readonly model: ModelMetadata;
  readonly sectionMemoryTimeoutMs?: number;
}

interface ProjectionSource {
  readonly guide: InterviewGuideSnapshot;
  readonly interview: PersistedInterview;
  readonly transcript: TranscriptAggregate;
  readonly finalization: StoredFinalization | null;
}

interface WorkflowScope {
  readonly job: DurableJob;
  readonly workflow: StoredWorkflowAttempt;
  readonly state: PersistedInterview;
  readonly guide: InterviewGuideSnapshot;
  readonly transcript: TranscriptAggregate;
}

export class CanonicalInterviewSessionService {
  public constructor(
    private readonly unitOfWork: AppUnitOfWork,
    private readonly clock: Clock,
    private readonly agentExecutor: InterviewAgentExecutor,
    private readonly options: CanonicalInterviewSessionServiceOptions,
    private readonly sectionMemoryCompactor: SectionMemoryCompactor = deterministicSectionMemoryCompactor,
  ) {}

  public async get(interviewId: string): Promise<MvpInterviewSession> {
    return projectSource(await this.loadSource(interviewId));
  }

  public async recordVoiceDiagnostic(interviewId: string, input: VoiceDiagnostic): Promise<void> {
    const diagnostic = voiceDiagnosticSchema.parse(input);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await this.unitOfWork.transaction(async (transaction) => {
        const interview = await transaction.interviews.load(interviewId);
        if (!interview.ok) return interview;
        return transaction.outbox.append(interviewId, {
          eventId: diagnostic.diagnosticId,
          interviewId,
          runId: diagnostic.responseId ?? diagnostic.diagnosticId,
          occurredAt: diagnostic.occurredAt,
          category: 'error',
          type: 'error.occurred',
          payload: {
            source: 'voice',
            code: (diagnostic.code ?? 'VOICE_CLIENT_ERROR').slice(0, 100),
            message: diagnostic.message,
            retryable: false,
            diagnostic,
          },
        });
      });
      if (result.ok) return;
      if (result.error.code !== 'serialization_failure' || attempt === 2) {
        requireRepositoryResult(result, 'Voice diagnostics could not be stored.');
        return;
      }
      await delay(25 * (attempt + 1));
    }
  }

  public async getRealtimeContext(interviewId: string): Promise<{
    readonly session: MvpInterviewSession;
    readonly guide: InterviewGuideSnapshot;
    readonly sectionMemories: readonly SectionMemory[];
  }> {
    const source = await this.loadSource(interviewId);
    return {
      session: projectSource(source),
      guide: source.guide,
      sectionMemories: source.interview.sectionMemories ?? [],
    };
  }

  public async getTurn(interviewId: string, turnId: string): Promise<MvpTranscriptTurn> {
    const turn = (await this.get(interviewId)).transcript.find(
      (candidate) => candidate.turnId === turnId,
    );
    if (turn === undefined)
      throw new MvpSessionError('not_found', 'The transcript turn was not found.');
    return turn;
  }

  public async startRealtime(interviewId: string): Promise<MvpRealtimeCommandResponse> {
    const existing = await this.loadSource(interviewId);
    if (existing.interview.lifecycle.status === 'completed') {
      throw new MvpSessionError('invalid_state', 'A completed interview cannot be restarted.');
    }
    if (existing.interview.lifecycle.status !== 'ready') {
      return this.commandResponse(interviewId);
    }

    const now = this.now();
    const result = await this.unitOfWork.transaction(async (transaction) => {
      const current = await transaction.interviews.lock(interviewId);
      if (!current.ok) return current;
      if (current.value.lifecycle.status !== 'ready') return success(undefined);
      const guide = await transaction.guides.getById(current.value.guideId);
      if (!guide.ok) return guide;
      const catalog = buildGuideQuestionCatalog(guide.value);
      const firstQuestion = catalog.find((question) => question.kind === 'main');
      if (firstQuestion === undefined) return constraint('interview_guide_has_main_question');

      const identifiers = commandIdentifiers('start', interviewId);
      const job = await enqueueAndClaim(transaction, interviewId, {
        jobId: identifiers.jobId,
        kind: 'start_interview',
        idempotencyKey: identifiers.jobId,
        sourceTurnId: null,
        expectedInterviewVersion: current.value.version,
        maximumAttempts: 1,
        initialDelayMs: 0,
        resultDeliveryId: identifiers.deliveryId,
      });
      if (!job.ok) return job;
      const running = runningWorkflow(current.value, job.value, identifiers, now);
      const workflowWrite = await transaction.runs.startWorkflow(interviewId, running);
      if (!workflowWrite.ok) return workflowWrite;

      let coverage;
      try {
        coverage = applyCoverageUpdates(guide.value, current.value.coverage, {
          interviewId,
          guideId: guide.value.id,
          expectedRevision: current.value.coverage.revision,
          updates: [
            {
              questionId: firstQuestion.questionId,
              status: 'current',
              referencedTurnIds: [],
              at: now,
            },
          ],
        });
      } catch {
        return constraint('interview_start_coverage');
      }
      const lifecycle = transitionInterview(current.value.lifecycle, { type: 'start', at: now });
      if (!lifecycle.ok) return constraint('interview_start_lifecycle');
      const nextState: PersistedInterview = {
        ...current.value,
        lifecycle: lifecycle.state,
        coverage,
        version: current.value.version + 1,
        activeWorkflowRunId: null,
        updatedAt: now,
      };
      const stateWrite = await transaction.interviews.compareAndSwap(
        interviewId,
        current.value.version,
        nextState,
      );
      if (!stateWrite.ok) return stateWrite;
      const aggregate = await transaction.transcripts.lockAggregate(interviewId);
      if (!aggregate.ok) return aggregate;
      const reservation = reserveDeliveryInput(
        identifiers.deliveryId,
        identifiers.jobId,
        identifiers.workflowRunId,
        'greeting',
        null,
        interviewGreetingText(current.value.language ?? DEFAULT_LOCALE),
        now,
      );
      const delivery = await transaction.transcripts.reserveAiDelivery(
        interviewId,
        aggregate.value.nextSequenceNumber,
        reservation,
      );
      if (!delivery.ok) return delivery;
      const completed = completedWorkflow(running, now);
      const workflowFinish = await transaction.runs.finishWorkflow(
        interviewId,
        running.workflowRunId,
        'running',
        completed,
      );
      if (!workflowFinish.ok) return workflowFinish;
      const jobFinish = await transaction.jobs.complete(
        interviewId,
        job.value.jobId,
        requireLeaseToken(job.value),
        nextState.version,
      );
      if (!jobFinish.ok) return jobFinish;
      const stateView = projectInterviewView(nextState, guide.value);
      if (!stateView.ok) return constraint('interview_start_projection');
      const events = await transaction.outbox.appendMany(interviewId, [
        workflowStartedEvent(running),
        statusChangedEvent(interviewId, running.workflowRunId, 'ready', 'active', now),
        stateUpdatedEvent(
          interviewId,
          running.workflowRunId,
          current.value.version,
          stateView.value,
          now,
        ),
        workflowCompletedEvent(completed),
      ]);
      return events.ok ? success(undefined) : events;
    });
    requireRepositoryResult(result, 'The interview could not be started.');
    return this.commandResponse(interviewId);
  }

  public async getPendingRealtimePlan(interviewId: string): Promise<MvpRealtimeCommandResponse> {
    return this.commandResponse(interviewId);
  }

  public async recoverRealtimeParticipantTurn(
    interviewId: string,
  ): Promise<MvpRealtimeCommandResponse> {
    return this.commandResponse(interviewId);
  }

  public async reserveRealtimeTurnIntent(
    interviewId: string,
    input: MvpRealtimeTurnIntentRequest,
  ): Promise<MvpRealtimeCommandResponse> {
    const receivedAt = this.now();
    const identifiers = realtimeTurnIntentIdentifiers(interviewId, input.clientEventId);
    const result = await this.unitOfWork.transaction(async (transaction) => {
      const current = await transaction.interviews.lock(interviewId);
      if (!current.ok) return current;
      if (
        current.value.lifecycle.status !== 'active' ||
        current.value.activeWorkflowRunId !== null
      ) {
        return constraint('realtime_turn_intent_state');
      }

      const existing = await transaction.transcripts.loadAiDelivery(
        interviewId,
        identifiers.deliveryId,
      );
      if (existing.ok) return success(undefined);
      if (existing.error.code !== 'not_found') return existing;

      const pending = await transaction.transcripts.listPendingAiDeliveries(interviewId);
      if (!pending.ok) return pending;
      if (pending.value.length > 0) return constraint('realtime_turn_intent_pending_delivery');

      const guide = await transaction.guides.getById(current.value.guideId);
      if (!guide.ok) return guide;
      const aggregate = await transaction.transcripts.lockAggregate(interviewId);
      if (!aggregate.ok) return aggregate;
      const now = resolveCanonicalIngressTiming(
        undefined,
        receivedAt,
        monotonicTimestamp(current.value.updatedAt, aggregate.value),
      ).occurredAt;
      const participantTurn = latestCanonicalParticipantTurn(aggregate.value);
      if (participantTurn === null) return constraint('realtime_turn_intent_requires_answer');

      const restored = restoreParticipantQuestionForWorkflow(
        guide.value,
        current.value,
        participantTurn,
        now,
      );
      if (!restored.ok) return restored;
      const currentCoverage = restored.value.coverage.questions.find(
        (question) => question.status === 'current',
      );
      if (currentCoverage === undefined) return constraint('realtime_turn_intent_current_question');
      const deliveries = await transaction.transcripts.listQuestionAiDeliveries(
        interviewId,
        currentCoverage.questionId,
      );
      if (!deliveries.ok) return deliveries;
      const planned = resolveRealtimeTurnIntent(guide.value, restored.value, input, {
        latestParticipantText: participantTurn.text,
        ...realtimeQuestionHistory(aggregate.value, currentCoverage.questionId, deliveries.value),
      });
      if (!planned.ok) return planned;
      const coverage = applyRealtimeTurnIntentCoverage(
        guide.value,
        restored.value,
        participantTurn,
        planned.value,
        now,
      );
      if (!coverage.ok) return coverage;

      const sectionTransition = detectGuideSectionTransition(
        guide.value,
        currentCoverage.questionId,
        planned.value,
      );
      let compactedMemory: SectionMemory | null = null;
      let sectionMemories = current.value.sectionMemories ?? [];
      if (
        sectionTransition !== null &&
        !sectionMemories.some((memory) => memory.sectionId === sectionTransition.fromSectionId)
      ) {
        try {
          compactedMemory = await compactSectionWithTimeout(
            this.sectionMemoryCompactor,
            {
              interviewId,
              guide: guide.value,
              coverage: coverage.value,
              transcript: aggregate.value,
              sectionId: sectionTransition.fromSectionId,
              sourceThroughSequenceNumber: participantTurn.sequenceNumber,
              compactedAt: now,
            },
            this.options.sectionMemoryTimeoutMs ?? DEFAULT_SECTION_MEMORY_TIMEOUT_MS,
          );
          sectionMemories = [...sectionMemories, compactedMemory];
        } catch (error: unknown) {
          console.warn(
            JSON.stringify({
              event: 'interview.section_compaction_skipped',
              interviewId,
              guideId: guide.value.id,
              sectionId: sectionTransition.fromSectionId,
              reason: error instanceof Error ? error.name : 'unknown_error',
            }),
          );
        }
      }

      const job = await enqueueAndClaim(transaction, interviewId, {
        jobId: identifiers.jobId,
        kind: 'participant_turn',
        idempotencyKey: identifiers.jobId,
        sourceTurnId: participantTurn.turnId,
        expectedInterviewVersion: current.value.version,
        maximumAttempts: 1,
        initialDelayMs: 0,
        resultDeliveryId: identifiers.deliveryId,
      });
      if (!job.ok) return job;
      const running = runningWorkflow(current.value, job.value, identifiers, now);
      const workflowWrite = await transaction.runs.startWorkflow(interviewId, running);
      if (!workflowWrite.ok) return workflowWrite;

      const lifecycle =
        planned.value.turnType === 'closing'
          ? transitionInterview(current.value.lifecycle, { type: 'begin_ending', at: now })
          : {
              ok: true as const,
              state: { ...current.value.lifecycle, revision: current.value.version + 1 },
            };
      if (!lifecycle.ok) return constraint('realtime_turn_intent_lifecycle');
      const nextState: PersistedInterview = {
        ...current.value,
        lifecycle: lifecycle.state,
        coverage: coverage.value,
        sectionMemories,
        version: current.value.version + 1,
        activeWorkflowRunId: null,
        updatedAt: now,
      };
      const stateWrite = await transaction.interviews.compareAndSwap(
        interviewId,
        current.value.version,
        nextState,
      );
      if (!stateWrite.ok) return stateWrite;

      const reservation = await transaction.transcripts.reserveAiDelivery(
        interviewId,
        aggregate.value.nextSequenceNumber,
        reserveDeliveryInput(
          identifiers.deliveryId,
          identifiers.jobId,
          identifiers.workflowRunId,
          planned.value.turnType,
          planned.value.guideReference,
          planned.value.text,
          now,
          planned.value.turnType === 'clarification_question'
            ? {
                purpose: input.action === 'repeat_question' ? 'repeat' : 'clarification',
                sourceParticipantTurnId: participantTurn.turnId,
                answerDisposition: input.answerDisposition,
                missingAspect: input.missingAspect,
                requestedEvidenceType: input.requestedEvidenceType,
              }
            : null,
        ),
      );
      if (!reservation.ok) return reservation;

      const completed = completedWorkflow(running, now);
      const workflowFinish = await transaction.runs.finishWorkflow(
        interviewId,
        running.workflowRunId,
        'running',
        completed,
      );
      if (!workflowFinish.ok) return workflowFinish;
      const jobFinish = await transaction.jobs.complete(
        interviewId,
        job.value.jobId,
        requireLeaseToken(job.value),
        nextState.version,
      );
      if (!jobFinish.ok) return jobFinish;

      const stateView = projectInterviewView(nextState, guide.value);
      if (!stateView.ok) return constraint('realtime_turn_intent_projection');
      const events: MonitoringEventDraft[] = [
        workflowStartedEvent(running),
        stateUpdatedEvent(
          interviewId,
          running.workflowRunId,
          current.value.version,
          stateView.value,
          now,
        ),
        workflowCompletedEvent(completed),
      ];
      if (compactedMemory !== null) {
        events.splice(1, 0, sectionCompactedEvent(compactedMemory, running.workflowRunId));
      }
      if (planned.value.turnType === 'closing') {
        events.splice(
          1,
          0,
          statusChangedEvent(interviewId, running.workflowRunId, 'active', 'ending', now),
        );
      }
      const eventWrite = await transaction.outbox.appendMany(interviewId, events);
      return eventWrite.ok ? success(undefined) : eventWrite;
    });
    if (
      !result.ok &&
      result.error.code === 'constraint_violation' &&
      result.error.constraint.startsWith(REALTIME_REJECTION_PREFIX)
    ) {
      return {
        ...(await this.commandResponse(interviewId)),
        rejection: { reason: result.error.constraint.slice(REALTIME_REJECTION_PREFIX.length) },
      };
    }
    requireRepositoryResult(result, 'The Realtime interviewer turn could not be planned.');
    return this.commandResponse(interviewId);
  }

  public async appendRealtimeAiTurn(
    interviewId: string,
    input: MvpRealtimeAiTurnRequest,
  ): Promise<MvpRealtimeAppendResponse> {
    const now = this.now();
    let finalizedTerminalClosingGap = false;
    const result = await this.unitOfWork.transaction(async (transaction) => {
      const delivery = await transaction.transcripts.loadAiDelivery(interviewId, input.deliveryId);
      if (!delivery.ok) return delivery;
      const aggregate = await transaction.transcripts.lockAggregate(interviewId);
      if (!aggregate.ok) return aggregate;
      if (delivery.value.status !== 'pending') {
        const existing = findAiTurn(aggregate.value, delivery.value.turnId);
        return success({ turn: existing, inserted: false });
      }
      if (!deliveryMatchesInput(delivery.value, input)) {
        const shouldReissue = shouldReissueExactUtterance(aggregate.value);
        const reissued = await gapAndReissue(
          transaction,
          aggregate.value,
          delivery.value,
          now,
          input.clientEventId,
          'exact_utterance_mismatch',
          shouldReissue,
        );
        if (!reissued.ok) return reissued;
        if (!shouldReissue) {
          if (delivery.value.turnType === 'greeting') {
            const recovered = await recoverAfterTerminalGreetingGap(
              transaction,
              delivery.value,
              reissued.value.resolvedAt,
            );
            if (!recovered.ok) return recovered;
          } else if (delivery.value.turnType === 'closing') {
            const recovered = await completeAfterTerminalClosingGap(
              transaction,
              delivery.value,
              reissued.value.resolvedAt,
            );
            if (!recovered.ok) return recovered;
            finalizedTerminalClosingGap = true;
          } else {
            const restored = await restoreRealtimeStateAfterTerminalDeliveryGap(
              transaction,
              aggregate.value,
              delivery.value.workflowRunId,
              reissued.value.resolvedAt,
            );
            if (!restored.ok) return restored;
          }
        }
        return success({ turn: null, inserted: false });
      }

      const timing = resolveCanonicalIngressTiming(
        input.occurredAt,
        now,
        monotonicTimestamp(delivery.value.createdAt, aggregate.value),
      );
      let appended;
      try {
        appended = appendAiTranscriptTurn(
          aggregateAtReservedSequence(aggregate.value, delivery.value),
          {
            interviewId,
            turnId: delivery.value.turnId,
            deliveryEventId: input.clientEventId,
            spokenText: input.text,
            occurredAt: timing.occurredAt,
            delivery: { status: 'complete' },
            turnType: delivery.value.turnType,
            guideReference: delivery.value.guideReference,
          } as Parameters<typeof appendAiTranscriptTurn>[1],
        );
      } catch {
        return constraint('realtime_ai_turn_domain');
      }
      const resolved = await transaction.transcripts.resolveAiDelivery(interviewId, {
        deliveryId: delivery.value.deliveryId,
        provider: 'openai_realtime',
        providerDeliveryEventId: input.clientEventId,
        resolvedAt: timing.resolvedAt,
        turn: appended.turn,
      });
      if (!resolved.ok) return resolved;
      const presentation = await presentationStartedEvents(
        transaction,
        delivery.value,
        timing.resolvedAt,
      );
      if (!presentation.ok) return presentation;
      const events: MonitoringEventDraft[] = [
        ...presentation.value.events,
        aiStreamCompletedEvent(
          appended.turn,
          delivery.value,
          presentation.value.lastDeltaSequenceNumber,
          timing.resolvedAt,
        ),
        canonicalTurnEvent(appended.turn, delivery.value.workflowRunId, timing.resolvedAt),
        voiceCompletedEvent(appended.turn, delivery.value, timing.resolvedAt),
      ];

      if (delivery.value.turnType === 'greeting') {
        const guide = await transaction.guides.getById(aggregate.value.guideId);
        if (!guide.ok) return guide;
        const state = await transaction.interviews.load(interviewId);
        if (!state.ok) return state;
        const currentQuestion = currentCatalogQuestion(guide.value, state.value);
        if (currentQuestion === null) return constraint('realtime_current_question');
        const nextDelivery = nextDeliveryFor();
        const reserve = await transaction.transcripts.reserveAiDelivery(
          interviewId,
          delivery.value.reservedSequenceNumber + 1,
          reserveDeliveryInput(
            nextDelivery,
            delivery.value.jobId,
            delivery.value.workflowRunId,
            currentQuestion.kind === 'main' ? 'main_question' : 'follow_up_question',
            currentQuestion.reference,
            currentQuestion.text,
            timing.resolvedAt,
          ),
        );
        if (!reserve.ok) return reserve;
      } else if (delivery.value.turnType === 'closing') {
        const closingAggregate = await transaction.transcripts.lockAggregate(interviewId);
        if (!closingAggregate.ok) return closingAggregate;
        const partialGaps = await gapUnresolvedParticipantPartials(
          transaction,
          closingAggregate.value,
          timing.resolvedAt,
          delivery.value.workflowRunId,
        );
        if (!partialGaps.ok) return partialGaps;
        events.push(...partialGaps.value.events);
        const completed = await completeLifecycle(
          transaction,
          interviewId,
          delivery.value.workflowRunId,
          timing.resolvedAt,
        );
        if (!completed.ok) return completed;
        events.push(...completed.value.events);
      }
      const eventWrite = await transaction.outbox.appendMany(interviewId, events);
      return eventWrite.ok
        ? success({ turn: resolved.value.value, inserted: resolved.value.outcome === 'inserted' })
        : eventWrite;
    });
    const append = requireRepositoryResult(result, 'The spoken AI turn could not be persisted.');
    if (input.turnType === 'closing' && (append.turn !== null || finalizedTerminalClosingGap)) {
      await this.finalizeCompletedInterview(interviewId);
    }
    return this.appendResponse(interviewId, append.turn, append.inserted);
  }

  public async interruptRealtimeAiTurn(
    interviewId: string,
    input: MvpRealtimeInterruptedAiTurnRequest,
  ): Promise<MvpRealtimeAppendResponse> {
    const now = this.now();
    const result = await this.unitOfWork.transaction(async (transaction) => {
      const delivery = await transaction.transcripts.loadAiDelivery(interviewId, input.deliveryId);
      if (!delivery.ok) return delivery;
      const aggregate = await transaction.transcripts.lockAggregate(interviewId);
      if (!aggregate.ok) return aggregate;
      if (delivery.value.status !== 'pending') {
        return success({
          turn: findAiTurn(aggregate.value, delivery.value.turnId),
          inserted: false,
        });
      }
      const spoken = confirmedInterruptedUtterance(
        delivery.value.proposedText,
        input.generatedText,
        input.confirmedSpokenText,
      );
      if (spoken === null) {
        const shouldReissue =
          delivery.value.turnType !== 'closing' &&
          shouldReissueTechnicalGap(aggregate.value, 'unconfirmed_interruption');
        const reissued = await gapAndReissue(
          transaction,
          aggregate.value,
          delivery.value,
          now,
          input.clientEventId,
          'unconfirmed_interruption',
          shouldReissue,
        );
        if (!reissued.ok) return reissued;
        if (!shouldReissue && delivery.value.turnType === 'greeting') {
          const recovered = await recoverAfterTerminalGreetingGap(
            transaction,
            delivery.value,
            reissued.value.resolvedAt,
          );
          if (!recovered.ok) return recovered;
        } else if (!shouldReissue && delivery.value.turnType === 'closing') {
          const closingAggregate = await transaction.transcripts.lockAggregate(interviewId);
          if (!closingAggregate.ok) return closingAggregate;
          const partialGaps = await gapUnresolvedParticipantPartials(
            transaction,
            closingAggregate.value,
            reissued.value.resolvedAt,
            delivery.value.workflowRunId,
          );
          if (!partialGaps.ok) return partialGaps;
          const completed = await completeLifecycle(
            transaction,
            interviewId,
            delivery.value.workflowRunId,
            reissued.value.resolvedAt,
          );
          if (!completed.ok) return completed;
          const completionEvents = await transaction.outbox.appendMany(interviewId, [
            ...partialGaps.value.events,
            ...completed.value.events,
          ]);
          if (!completionEvents.ok) return completionEvents;
        } else if (!shouldReissue) {
          const restored = await restoreRealtimeStateAfterTerminalDeliveryGap(
            transaction,
            aggregate.value,
            delivery.value.workflowRunId,
            reissued.value.resolvedAt,
          );
          if (!restored.ok) return restored;
        }
        return success({ turn: null, inserted: false });
      }
      const timing = resolveCanonicalIngressTiming(
        input.occurredAt,
        now,
        monotonicTimestamp(delivery.value.createdAt, aggregate.value),
      );
      let appended;
      try {
        appended = appendAiTranscriptTurn(
          aggregateAtReservedSequence(aggregate.value, delivery.value),
          {
            interviewId,
            turnId: delivery.value.turnId,
            deliveryEventId: input.clientEventId,
            spokenText: spoken,
            occurredAt: timing.occurredAt,
            delivery: { status: 'interrupted', interruptedAt: timing.resolvedAt },
            turnType: delivery.value.turnType,
            guideReference: delivery.value.guideReference,
          } as Parameters<typeof appendAiTranscriptTurn>[1],
        );
      } catch {
        return constraint('realtime_interrupted_ai_turn_domain');
      }
      const resolved = await transaction.transcripts.resolveAiDelivery(interviewId, {
        deliveryId: delivery.value.deliveryId,
        provider: 'openai_realtime',
        providerDeliveryEventId: input.clientEventId,
        resolvedAt: timing.resolvedAt,
        turn: appended.turn,
      });
      if (!resolved.ok) return resolved;
      const presentation = await presentationStartedEvents(
        transaction,
        delivery.value,
        timing.resolvedAt,
      );
      if (!presentation.ok) return presentation;
      const events: MonitoringEventDraft[] = [
        ...presentation.value.events,
        aiStreamInterruptedEvent(
          appended.turn,
          delivery.value,
          presentation.value.lastDeltaSequenceNumber,
          timing.resolvedAt,
        ),
        canonicalTurnEvent(appended.turn, delivery.value.workflowRunId, timing.resolvedAt),
        voiceInterruptedEvent(appended.turn, delivery.value, timing.resolvedAt),
      ];
      if (delivery.value.turnType === 'greeting') {
        const guide = await transaction.guides.getById(aggregate.value.guideId);
        if (!guide.ok) return guide;
        const state = await transaction.interviews.load(interviewId);
        if (!state.ok) return state;
        const currentQuestion = currentCatalogQuestion(guide.value, state.value);
        if (currentQuestion === null) return constraint('realtime_current_question');
        const reserve = await transaction.transcripts.reserveAiDelivery(
          interviewId,
          delivery.value.reservedSequenceNumber + 1,
          reserveDeliveryInput(
            nextDeliveryFor(),
            delivery.value.jobId,
            delivery.value.workflowRunId,
            currentQuestion.kind === 'main' ? 'main_question' : 'follow_up_question',
            currentQuestion.reference,
            currentQuestion.text,
            timing.resolvedAt,
          ),
        );
        if (!reserve.ok) return reserve;
      } else if (delivery.value.turnType === 'closing') {
        const closingAggregate = await transaction.transcripts.lockAggregate(interviewId);
        if (!closingAggregate.ok) return closingAggregate;
        const partialGaps = await gapUnresolvedParticipantPartials(
          transaction,
          closingAggregate.value,
          timing.resolvedAt,
          delivery.value.workflowRunId,
        );
        if (!partialGaps.ok) return partialGaps;
        events.push(...partialGaps.value.events);
        const completed = await completeLifecycle(
          transaction,
          interviewId,
          delivery.value.workflowRunId,
          timing.resolvedAt,
        );
        if (!completed.ok) return completed;
        events.push(...completed.value.events);
      }
      const eventWrite = await transaction.outbox.appendMany(interviewId, events);
      return eventWrite.ok
        ? success({ turn: resolved.value.value, inserted: resolved.value.outcome === 'inserted' })
        : eventWrite;
    });
    const append = requireRepositoryResult(
      result,
      'The interrupted AI turn could not be persisted.',
    );
    let response = await this.appendResponse(interviewId, append.turn, append.inserted);
    if (response.session.status === 'completed') {
      await this.finalizeCompletedInterview(interviewId);
      response = await this.appendResponse(interviewId, append.turn, append.inserted);
    }
    return response;
  }

  public async updatePartial(
    interviewId: string,
    input: MvpPartialTranscriptRequest,
  ): Promise<MvpInterviewSession> {
    const partialText = input.text;
    if (partialText === null) return this.get(interviewId);
    const now = this.now();
    const result = await this.unitOfWork.transaction(async (transaction) => {
      const aggregate = await transaction.transcripts.lockAggregate(interviewId);
      if (!aggregate.ok) return aggregate;
      const itemId = input.itemId ?? `partial:${interviewId}`;
      const existing = aggregate.value.partials.find(
        (partial) => partial.sourceProvider === 'openai_realtime' && partial.segmentId === itemId,
      );
      const revision = input.revision ?? (existing?.revision ?? 0) + 1;
      let ingestion;
      try {
        ingestion = ingestPartialParticipantSegment(aggregate.value, {
          interviewId,
          sourceProvider: 'openai_realtime',
          utteranceId: itemId,
          providerEventId: input.providerEventId ?? `${itemId}:partial:${revision}`,
          segmentId: itemId,
          text: partialText,
          revision,
          observedAt: now,
        });
      } catch {
        return constraint('realtime_partial_domain');
      }
      const partial = ingestion.aggregate.partials.find(
        (candidate) =>
          candidate.sourceProvider === 'openai_realtime' && candidate.segmentId === itemId,
      );
      if (partial === undefined) return success(undefined);
      const write = await transaction.transcripts.upsertPartial(
        interviewId,
        { provider: 'openai_realtime', utteranceId: itemId },
        partial,
      );
      if (!write.ok) return write;
      const event = await transaction.outbox.append(
        interviewId,
        partialEvent(partial, input.providerEventId ?? partial.providerEventId),
      );
      return event.ok ? success(undefined) : event;
    });
    requireRepositoryResult(result, 'The partial transcription could not be persisted.');
    return this.get(interviewId);
  }

  public async appendRealtimeParticipantTurn(
    interviewId: string,
    input: MvpParticipantTurnRequest,
  ): Promise<MvpRealtimeAppendResponse> {
    const persisted = await this.persistParticipantTurn(interviewId, input);
    if (!persisted.inserted) return this.appendResponse(interviewId, persisted.turn, false);
    if (input.sourceProvider === 'openai_realtime') {
      return this.appendResponse(interviewId, persisted.turn, true);
    }
    const plan = await this.runParticipantWorkflow(interviewId, persisted.turn);
    const session = await this.get(interviewId);
    return { session, turn: toMvpTurn(persisted.turn), inserted: true, nextAiTurn: plan };
  }

  public async recordRealtimeGap(
    interviewId: string,
    input: MvpRealtimeGapRequest,
  ): Promise<MvpRealtimeCommandResponse> {
    const now = this.now();
    const result = await this.unitOfWork.transaction(async (transaction) => {
      const aggregate = await transaction.transcripts.lockAggregate(interviewId);
      if (!aggregate.ok) return aggregate;
      const itemId = input.itemId ?? `gap-item:${input.sourceEventId}`;
      const timing = resolveCanonicalIngressTiming(
        input.occurredAt,
        now,
        aggregate.value.entries.at(-1)?.occurredAt,
      );
      let recorded;
      try {
        recorded = recordTranscriptTechnicalGap(aggregate.value, {
          interviewId,
          gapId: `gap:${input.sourceEventId}`,
          sourceEventId: input.sourceEventId,
          source: input.source,
          sourceProvider: input.source === 'speech_to_text' ? 'openai_realtime' : null,
          relatedUtteranceId: input.source === 'speech_to_text' ? itemId : null,
          relatedSegmentId: input.source === 'speech_to_text' ? itemId : null,
          description: input.description,
          occurredAt: timing.occurredAt,
        } as Parameters<typeof recordTranscriptTechnicalGap>[1]);
      } catch {
        return constraint('realtime_gap_domain');
      }
      const write = await transaction.transcripts.appendTechnicalGap(
        interviewId,
        aggregate.value.nextSequenceNumber,
        recorded.gap,
      );
      if (!write.ok) return write;
      const event = await transaction.outbox.append(
        interviewId,
        gapEvent(recorded.gap, input.sourceEventId, timing.resolvedAt),
      );
      return event.ok ? success(undefined) : event;
    });
    requireRepositoryResult(result, 'The technical transcript gap could not be persisted.');
    return this.commandResponse(interviewId);
  }

  public async completeRealtimeInterview(
    interviewId: string,
    occurredAt?: string,
  ): Promise<MvpRealtimeCommandResponse> {
    const source = await this.loadSource(interviewId);
    if (source.interview.lifecycle.status === 'completed') {
      await this.finalizeCompletedInterview(interviewId);
      return this.commandResponse(interviewId);
    }
    if (source.interview.lifecycle.status === 'ending') return this.commandResponse(interviewId);
    if (
      source.interview.lifecycle.status !== 'active' &&
      source.interview.lifecycle.status !== 'paused'
    ) {
      throw new MvpSessionError('invalid_state', 'Only a running interview can be completed.');
    }
    const receivedAt = this.now();
    const now = resolveCanonicalIngressTiming(occurredAt, receivedAt).occurredAt;
    const result = await this.unitOfWork.transaction(async (transaction) => {
      const current = await transaction.interviews.lock(interviewId);
      if (!current.ok) return current;
      if (
        current.value.lifecycle.status === 'ending' ||
        current.value.lifecycle.status === 'completed'
      ) {
        return success(undefined);
      }
      const aggregate = await transaction.transcripts.lockAggregate(interviewId);
      if (!aggregate.ok) return aggregate;
      const pending = await transaction.transcripts.listPendingAiDeliveries(interviewId);
      if (!pending.ok) return pending;
      let completionAt = monotonicTimestamp(now, aggregate.value);
      let completionAggregate = aggregate.value;
      const completionEvents: MonitoringEventDraft[] = [];
      for (const delivery of pending.value) {
        completionAt = maxTimestamp(completionAt, delivery.createdAt);
        let recorded;
        try {
          recorded = recordTranscriptTechnicalGap(
            aggregateAtReservedSequence(completionAggregate, delivery),
            {
              interviewId,
              gapId: `gap:${randomUUID()}`,
              sourceEventId: `finish:${randomUUID()}`,
              source: 'audio_output',
              sourceProvider: null,
              relatedUtteranceId: null,
              relatedSegmentId: null,
              description: interviewTechnicalGapDescription(
                current.value.language ?? DEFAULT_LOCALE,
                'pending_ai_cancelled',
              ),
              occurredAt: completionAt,
            },
          );
        } catch {
          return constraint('finish_pending_ai_delivery_gap');
        }
        const gapWrite = await transaction.transcripts.gapAiDelivery(interviewId, {
          deliveryId: delivery.deliveryId,
          resolvedAt: completionAt,
          status: 'cancelled',
          gap: recorded.gap,
        });
        if (!gapWrite.ok) return gapWrite;
        completionAggregate = recorded.aggregate;
        completionEvents.push(gapEvent(recorded.gap, delivery.workflowRunId, completionAt));
      }

      const partialGaps = await gapUnresolvedParticipantPartials(
        transaction,
        completionAggregate,
        completionAt,
        `finish:${current.value.version}`,
      );
      if (!partialGaps.ok) return partialGaps;
      completionAggregate = partialGaps.value.aggregate;
      completionEvents.push(...partialGaps.value.events);

      if (current.value.activeWorkflowRunId !== null) {
        const activeWorkflow = await transaction.runs.loadWorkflow(
          interviewId,
          current.value.activeWorkflowRunId,
        );
        if (!activeWorkflow.ok) return activeWorkflow;
        if (activeWorkflow.value.status === 'running') {
          const failureRecord = {
            code: 'interview_ended',
            message: 'The active participant workflow was superseded by interview completion.',
            retryable: false,
            occurredAt: completionAt,
          };
          const cancelledWorkflow: StoredWorkflowAttempt = {
            ...activeWorkflow.value,
            status: 'failed',
            endedAt: completionAt,
            durationMs: elapsed(activeWorkflow.value.startedAt, completionAt),
            failure: failureRecord,
          };
          const workflowCancel = await transaction.runs.finishWorkflow(
            interviewId,
            activeWorkflow.value.workflowRunId,
            'running',
            cancelledWorkflow,
          );
          if (!workflowCancel.ok) return workflowCancel;
          const jobCancel = await transaction.jobs.cancel(
            interviewId,
            activeWorkflow.value.jobId,
            'interview_ended',
          );
          if (!jobCancel.ok) return jobCancel;
          completionEvents.push(workflowFailedEvent(cancelledWorkflow));
        }
      }
      const identifiers = commandIdentifiers(`finish:${current.value.version}`, interviewId);
      const job = await enqueueAndClaim(transaction, interviewId, {
        jobId: identifiers.jobId,
        kind: 'finish_interview',
        idempotencyKey: identifiers.jobId,
        sourceTurnId: null,
        expectedInterviewVersion: current.value.version,
        maximumAttempts: 1,
        initialDelayMs: 0,
        resultDeliveryId: identifiers.deliveryId,
      });
      if (!job.ok) return job;
      const running = runningWorkflow(current.value, job.value, identifiers, completionAt);
      const workflowWrite = await transaction.runs.startWorkflow(interviewId, running);
      if (!workflowWrite.ok) return workflowWrite;
      const transition = transitionInterview(current.value.lifecycle, {
        type: 'begin_ending',
        at: completionAt,
      });
      if (!transition.ok) return constraint('finish_interview_lifecycle');
      const nextState: PersistedInterview = {
        ...current.value,
        lifecycle: transition.state,
        version: current.value.version + 1,
        activeWorkflowRunId: null,
        updatedAt: completionAt,
      };
      const stateWrite = await transaction.interviews.compareAndSwap(
        interviewId,
        current.value.version,
        nextState,
      );
      if (!stateWrite.ok) return stateWrite;
      const reserve = await transaction.transcripts.reserveAiDelivery(
        interviewId,
        completionAggregate.nextSequenceNumber,
        reserveDeliveryInput(
          identifiers.deliveryId,
          identifiers.jobId,
          identifiers.workflowRunId,
          'closing',
          null,
          interviewClosingText(current.value.language ?? DEFAULT_LOCALE),
          completionAt,
        ),
      );
      if (!reserve.ok) return reserve;
      const completed = completedWorkflow(running, completionAt);
      const workflowFinish = await transaction.runs.finishWorkflow(
        interviewId,
        running.workflowRunId,
        'running',
        completed,
      );
      if (!workflowFinish.ok) return workflowFinish;
      const jobFinish = await transaction.jobs.complete(
        interviewId,
        job.value.jobId,
        requireLeaseToken(job.value),
        nextState.version,
      );
      if (!jobFinish.ok) return jobFinish;
      const guide = await transaction.guides.getById(current.value.guideId);
      if (!guide.ok) return guide;
      const stateView = projectInterviewView(nextState, guide.value);
      if (!stateView.ok) return constraint('finish_interview_projection');
      const events = await transaction.outbox.appendMany(interviewId, [
        ...completionEvents,
        workflowStartedEvent(running),
        statusChangedEvent(
          interviewId,
          running.workflowRunId,
          current.value.lifecycle.status,
          'ending',
          completionAt,
        ),
        stateUpdatedEvent(
          interviewId,
          running.workflowRunId,
          current.value.version,
          stateView.value,
          completionAt,
        ),
        workflowCompletedEvent(completed),
      ]);
      return events.ok ? success(undefined) : events;
    });
    requireRepositoryResult(result, 'The interview closing could not be scheduled.');
    return this.commandResponse(interviewId);
  }

  public async start(interviewId: string): Promise<MvpSessionCommandResponse> {
    const response = await this.startRealtime(interviewId);
    return this.resolvePlansAsText(interviewId, response);
  }

  public async submitParticipantTurn(
    interviewId: string,
    input: MvpParticipantTurnRequest,
  ): Promise<MvpSessionCommandResponse> {
    const response = await this.appendRealtimeParticipantTurn(interviewId, input);
    return this.resolvePlansAsText(interviewId, response);
  }

  public async pause(interviewId: string): Promise<MvpSessionCommandResponse> {
    await this.changeLifecycle(interviewId, 'pause');
    return { session: await this.get(interviewId), newAiTurns: [] };
  }

  public async resume(interviewId: string): Promise<MvpSessionCommandResponse> {
    await this.changeLifecycle(interviewId, 'resume');
    return { session: await this.get(interviewId), newAiTurns: [] };
  }

  public async end(interviewId: string): Promise<MvpSessionCommandResponse> {
    return this.resolvePlansAsText(interviewId, await this.completeRealtimeInterview(interviewId));
  }

  private async persistParticipantTurn(
    interviewId: string,
    input: MvpParticipantTurnRequest,
  ): Promise<{ readonly turn: ParticipantTranscriptTurn; readonly inserted: boolean }> {
    const now = this.now();
    const result = await this.unitOfWork.transaction(async (transaction) => {
      const state = await transaction.interviews.lock(interviewId);
      if (!state.ok) return state;
      if (state.value.lifecycle.status !== 'active')
        return constraint('participant_turn_requires_active');
      if (state.value.activeWorkflowRunId !== null)
        return constraint('participant_turn_workflow_active');
      const aggregate = await transaction.transcripts.lockAggregate(interviewId);
      if (!aggregate.ok) return aggregate;
      const pending = await transaction.transcripts.listPendingAiDeliveries(interviewId);
      if (!pending.ok) return pending;
      if (pending.value.length > 0) return constraint('participant_turn_during_ai_delivery');
      const question = latestOpenQuestion(aggregate.value);
      if (question === null) return constraint('participant_turn_without_question');
      const timing = resolveCanonicalIngressTiming(
        input.occurredAt,
        now,
        aggregate.value.entries.at(-1)?.occurredAt,
      );
      const occurredAt = timing.occurredAt;
      const itemId = input.clientEventId;
      let ingested;
      try {
        ingested = ingestFinalParticipantSegment(aggregate.value, {
          interviewId,
          sourceProvider: input.sourceProvider,
          utteranceId: itemId,
          providerEventId: itemId,
          segmentId: itemId,
          turnId: `participant-turn:${itemId}`,
          text: input.text,
          occurredAt,
          observedAt: timing.resolvedAt,
          finalizedAt: timing.resolvedAt,
          guideReference: question.guideReference,
        });
      } catch {
        return constraint('participant_turn_domain');
      }
      const final = ingested.aggregate.finals.find(
        (candidate) => candidate.turnId === ingested.turn.turnId,
      );
      if (final === undefined) return constraint('participant_final_segment');
      const write = await transaction.transcripts.appendParticipantFinal(
        interviewId,
        aggregate.value.nextSequenceNumber,
        { provider: input.sourceProvider, utteranceId: itemId },
        final,
        ingested.turn,
      );
      if (!write.ok) return write;
      if (write.value.outcome === 'existing') {
        return success({ turn: write.value.value, inserted: false });
      }
      const events = await transaction.outbox.appendMany(interviewId, [
        finalSegmentEvent(final, ingested.turn.turnId),
        canonicalTurnEvent(ingested.turn, ingested.turn.turnId, timing.resolvedAt),
      ]);
      return events.ok ? success({ turn: write.value.value, inserted: true }) : events;
    });
    return requireRepositoryResult(result, 'The final participant turn could not be persisted.');
  }

  private async runParticipantWorkflow(
    interviewId: string,
    participantTurn: ParticipantTranscriptTurn,
  ): Promise<MvpRealtimeTurnPlan> {
    const scope = await this.beginParticipantWorkflow(interviewId, participantTurn);
    return this.executeParticipantWorkflow(scope, participantTurn);
  }

  private async executeParticipantWorkflow(
    scope: WorkflowScope,
    participantTurn: ParticipantTranscriptTurn,
  ): Promise<MvpRealtimeTurnPlan> {
    const interviewId = participantTurn.interviewId;
    try {
      const stateView = projectInterviewView(scope.state, scope.guide);
      if (!stateView.ok) throw new Error('The workflow state is invalid.');
      if (participantTurn.guideReference === null) {
        throw new Error('The participant answer has no guide reference.');
      }
      const transcript = canonicalTranscriptSchema.parse({
        interviewId,
        guideId: scope.guide.id,
        entries: scope.transcript.entries,
        finalizedAt: null,
      });
      const catalog = buildGuideQuestionCatalog(scope.guide);
      const candidateQuestionIds = workflowCandidateQuestionIds(
        catalog,
        scope.state,
        participantTurn.guideReference.mainQuestionId,
      );
      const contradictions = await this.readContradictions(interviewId);
      const guideContract = toAgentGuideContract(scope.guide);
      const workflowInput: InterviewTurnWorkflowInput = {
        coverageInput: {
          agentName: 'coverage_analysis',
          interviewId,
          interviewStateVersion: stateView.value.version,
          guide: guideContract,
          interviewState: stateView.value,
          transcript,
          latestParticipantTurnId: participantTurn.turnId,
          currentQuestion: participantTurn.guideReference,
          candidateQuestionIds,
        },
        consistencyInput: {
          agentName: 'consistency_analysis',
          interviewId,
          interviewStateVersion: stateView.value.version,
          guide: guideContract,
          interviewState: stateView.value,
          transcript,
          latestParticipantTurnId: participantTurn.turnId,
          currentQuestion: participantTurn.guideReference,
          allowedContradictionIds: Array.from({ length: 8 }, () => randomUUID()),
          existingContradictionIds: contradictions.map((item) => item.contradictionId),
        },
        questionTextById: Object.fromEntries(
          catalog.map((question) => [question.questionId, question.text]),
        ),
        allowTransition: false,
      };
      const runner = new PersistedInterviewTurnAgentRunner(
        this.unitOfWork,
        this.clock,
        this.agentExecutor,
        this.options.model,
        {
          interviewId,
          workflowRunId: scope.workflow.workflowRunId,
          attemptId: scope.workflow.attemptId,
          attemptNumber: scope.workflow.attemptNumber,
        },
      );
      const workflow = createInterviewTurnWorkflow(runner);
      const run = await workflow.createRun({
        runId: scope.workflow.workflowRunId,
        resourceId: interviewId,
        disableScorers: true,
      });
      const execution = await run.start({ inputData: workflowInput });
      if (execution.status !== 'success') {
        throw new Error('Mastra workflow failed.');
      }
      return await this.applyWorkflowResult(scope, participantTurn, execution.result);
    } catch (error: unknown) {
      await this.failParticipantWorkflow(scope, error);
      throw new MvpSessionError(
        'conflict',
        error instanceof Error ? error.message : 'The interview workflow failed.',
      );
    }
  }

  private async beginParticipantWorkflow(
    interviewId: string,
    participantTurn: ParticipantTranscriptTurn,
  ): Promise<WorkflowScope> {
    const receivedAt = this.now();
    const identifiers = commandIdentifiers(`participant:${participantTurn.turnId}`, interviewId);
    const result = await this.unitOfWork.transaction(async (transaction) => {
      const current = await transaction.interviews.lock(interviewId);
      if (!current.ok) return current;
      if (
        current.value.lifecycle.status !== 'active' ||
        current.value.activeWorkflowRunId !== null
      ) {
        return constraint('participant_workflow_state');
      }
      const guide = await transaction.guides.getById(current.value.guideId);
      if (!guide.ok) return guide;
      const transcript = await transaction.transcripts.lockAggregate(interviewId);
      if (!transcript.ok) return transcript;
      const now = resolveCanonicalIngressTiming(
        undefined,
        receivedAt,
        monotonicTimestamp(current.value.updatedAt, transcript.value),
      ).occurredAt;
      return startParticipantWorkflow(
        transaction,
        current.value,
        guide.value,
        transcript.value,
        participantTurn,
        identifiers,
        now,
      );
    });
    return requireRepositoryResult(result, 'The participant workflow could not be started.');
  }

  private async applyWorkflowResult(
    scope: WorkflowScope,
    participantTurn: ParticipantTranscriptTurn,
    output: InterviewTurnWorkflowOutput,
  ): Promise<MvpRealtimeTurnPlan> {
    const receivedAt = this.now();
    const result = await this.unitOfWork.transaction(async (transaction) => {
      const current = await transaction.interviews.lock(scope.state.interviewId);
      if (!current.ok) return current;
      if (current.value.activeWorkflowRunId !== scope.workflow.workflowRunId) {
        return constraint('participant_workflow_ownership');
      }
      const guide = await transaction.guides.getById(current.value.guideId);
      if (!guide.ok) return guide;
      const aggregate = await transaction.transcripts.lockAggregate(current.value.interviewId);
      if (!aggregate.ok) return aggregate;
      const now = resolveCanonicalIngressTiming(
        undefined,
        receivedAt,
        monotonicTimestamp(current.value.updatedAt, aggregate.value),
      ).occurredAt;
      const coverage = applyWorkflowCoverage(
        guide.value,
        current.value,
        participantTurn,
        output,
        now,
      );
      if (!coverage.ok) return coverage;
      const isClosing = output.conductor.action === 'close';
      const lifecycle = isClosing
        ? transitionInterview(current.value.lifecycle, { type: 'begin_ending', at: now })
        : {
            ok: true as const,
            state: { ...current.value.lifecycle, revision: current.value.version + 1 },
          };
      if (!lifecycle.ok) return constraint('participant_workflow_lifecycle');
      const nextState: PersistedInterview = {
        ...current.value,
        lifecycle: lifecycle.state,
        coverage: coverage.value,
        version: current.value.version + 1,
        activeWorkflowRunId: null,
        updatedAt: now,
      };
      const stateWrite = await transaction.interviews.compareAndSwap(
        current.value.interviewId,
        current.value.version,
        nextState,
      );
      if (!stateWrite.ok) return stateWrite;
      const planned = plannedConductorTurn(output);
      if (scope.job.resultDeliveryId === null) {
        return constraint('participant_workflow_delivery');
      }
      const reserve = await transaction.transcripts.reserveAiDelivery(
        current.value.interviewId,
        aggregate.value.nextSequenceNumber,
        reserveDeliveryInput(
          scope.job.resultDeliveryId,
          scope.job.jobId,
          scope.workflow.workflowRunId,
          planned.turnType,
          planned.guideReference,
          planned.text,
          now,
        ),
      );
      if (!reserve.ok) return reserve;
      const completed = completedWorkflow(scope.workflow, now);
      const workflowWrite = await transaction.runs.finishWorkflow(
        current.value.interviewId,
        scope.workflow.workflowRunId,
        'running',
        completed,
      );
      if (!workflowWrite.ok) return workflowWrite;
      const jobWrite = await transaction.jobs.complete(
        current.value.interviewId,
        scope.job.jobId,
        requireLeaseToken(scope.job),
        nextState.version,
      );
      if (!jobWrite.ok) return jobWrite;
      const contradictions = await storeContradictions(
        transaction,
        current.value.interviewId,
        scope.workflow.workflowRunId,
        output,
        now,
      );
      if (!contradictions.ok) return contradictions;
      const stateView = projectInterviewView(nextState, guide.value);
      if (!stateView.ok) return constraint('participant_workflow_result_projection');
      const events: MonitoringEventDraft[] = [
        stateUpdatedEvent(
          current.value.interviewId,
          scope.workflow.workflowRunId,
          current.value.version,
          stateView.value,
          now,
        ),
        workflowCompletedEvent(completed),
      ];
      if (isClosing) {
        events.unshift(
          statusChangedEvent(
            current.value.interviewId,
            scope.workflow.workflowRunId,
            'active',
            'ending',
            now,
          ),
        );
      }
      const eventWrite = await transaction.outbox.appendMany(current.value.interviewId, events);
      return eventWrite.ok ? success(toTurnPlan(reserve.value.value)) : eventWrite;
    });
    return requireRepositoryResult(result, 'The workflow result could not be applied.');
  }

  private async failParticipantWorkflow(scope: WorkflowScope, error: unknown): Promise<void> {
    const receivedAt = this.now();
    await this.unitOfWork.transaction(async (transaction) => {
      const current = await transaction.interviews.lock(scope.state.interviewId);
      if (!current.ok) return current;
      if (current.value.activeWorkflowRunId !== scope.workflow.workflowRunId)
        return success(undefined);
      const now = resolveCanonicalIngressTiming(
        undefined,
        receivedAt,
        maxTimestamp(current.value.updatedAt, scope.workflow.startedAt ?? current.value.updatedAt),
      ).occurredAt;
      const failureRecord = {
        code: 'workflow_failed',
        message: error instanceof Error ? error.message : 'The interview workflow failed.',
        retryable: false,
        occurredAt: now,
      };
      const nextState = sameLifecycleUpdate(current.value, {
        activeWorkflowRunId: null,
        updatedAt: now,
      });
      const stateWrite = await transaction.interviews.compareAndSwap(
        current.value.interviewId,
        current.value.version,
        nextState,
      );
      if (!stateWrite.ok) return stateWrite;
      const failedWorkflow: StoredWorkflowAttempt = {
        ...scope.workflow,
        status: 'failed',
        endedAt: now,
        durationMs: elapsed(scope.workflow.startedAt, now),
        failure: failureRecord,
      };
      const workflowWrite = await transaction.runs.finishWorkflow(
        current.value.interviewId,
        scope.workflow.workflowRunId,
        'running',
        failedWorkflow,
      );
      if (!workflowWrite.ok) return workflowWrite;
      const jobWrite = await transaction.jobs.fail(
        current.value.interviewId,
        scope.job.jobId,
        requireLeaseToken(scope.job),
        failureRecord,
      );
      if (!jobWrite.ok) return jobWrite;
      const eventWrite = await transaction.outbox.append(
        current.value.interviewId,
        workflowFailedEvent(failedWorkflow),
      );
      return eventWrite.ok ? success(undefined) : eventWrite;
    });
  }

  private async finalizeCompletedInterview(interviewId: string): Promise<void> {
    const source = await this.loadSource(interviewId);
    if (source.finalization !== null || source.interview.lifecycle.status !== 'completed') return;
    const deterministicValidation = validateFinalTranscript(source.transcript);
    if (!deterministicValidation.valid) return;
    const now = resolveCanonicalIngressTiming(
      undefined,
      this.now(),
      monotonicTimestamp(source.interview.updatedAt, source.transcript),
    ).occurredAt;
    const identifiers = commandIdentifiers(`finalize:${source.interview.version}`, interviewId);
    const setup = await this.unitOfWork.transaction(async (transaction) => {
      const job = await enqueueAndClaim(transaction, interviewId, {
        jobId: identifiers.jobId,
        kind: 'finish_interview',
        idempotencyKey: identifiers.jobId,
        sourceTurnId: null,
        expectedInterviewVersion: source.interview.version,
        maximumAttempts: 1,
        initialDelayMs: 0,
        resultDeliveryId: null,
      });
      if (!job.ok) return job;
      const workflow = runningWorkflow(source.interview, job.value, identifiers, now);
      const workflowWrite = await transaction.runs.startWorkflow(interviewId, workflow);
      return workflowWrite.ok ? success({ job: job.value, workflow }) : workflowWrite;
    });
    if (!setup.ok) return;
    const state = projectInterviewView(source.interview, source.guide);
    if (!state.ok) return;
    const transcript = canonicalTranscriptSchema.parse({
      interviewId,
      guideId: source.guide.id,
      entries: source.transcript.entries,
      finalizedAt: now,
    });
    const input = transcriptFinalizationPromptInputSchema.parse({
      agentName: 'transcript_finalization',
      interviewId,
      interviewStateVersion: state.value.version,
      guide: toAgentGuideContract(source.guide),
      interviewState: state.value,
      transcript,
      deterministicValidation,
    });
    const agentRunId = randomUUID();
    const storedInput = storedAgentInput(source.interview.version, source.guide, source.transcript);
    const runningAgent: StoredAgentRun = {
      interviewId,
      workflowRunId: setup.value.workflow.workflowRunId,
      attemptId: setup.value.workflow.attemptId,
      agentRunId,
      agentName: 'transcript_finalization',
      invocationNumber: 1,
      status: 'running',
      model: this.options.model,
      validatedInput: storedInput,
      validatedOutput: null,
      startedAt: now,
      endedAt: null,
      durationMs: null,
      retryCount: 0,
      failure: null,
    };
    const startAgent = await this.unitOfWork.transaction(async (transaction) => {
      const write = await transaction.runs.startAgent(interviewId, runningAgent);
      return write.ok ? success(undefined) : write;
    });
    if (!startAgent.ok) return;
    const execution = await this.agentExecutor.executeTranscriptFinalization(input, {
      runId: agentRunId,
      workflowRunId: setup.value.workflow.workflowRunId,
      signal: new AbortController().signal,
    });
    if (!execution.ok) return;
    const endedAt = resolveCanonicalIngressTiming(undefined, this.now(), now).occurredAt;
    const output: StructuredAgentOutput = {
      agentName: 'transcript_finalization',
      output: execution.output,
    };
    await this.unitOfWork.transaction(async (transaction) => {
      const completedAgent: StoredAgentRun = {
        ...runningAgent,
        status: 'succeeded',
        validatedOutput: output,
        endedAt,
        durationMs: elapsed(now, endedAt),
        retryCount: execution.repairCount,
      };
      const agentWrite = await transaction.runs.finishAgent(
        interviewId,
        agentRunId,
        'running',
        completedAgent,
      );
      if (!agentWrite.ok) return agentWrite;
      const workflow = completedWorkflow(setup.value.workflow, endedAt);
      const workflowWrite = await transaction.runs.finishWorkflow(
        interviewId,
        workflow.workflowRunId,
        'running',
        workflow,
      );
      if (!workflowWrite.ok) return workflowWrite;
      const jobWrite = await transaction.jobs.complete(
        interviewId,
        setup.value.job.jobId,
        requireLeaseToken(setup.value.job),
        source.interview.version,
      );
      if (!jobWrite.ok) return jobWrite;
      const finalization = await transaction.finalizations.store(interviewId, {
        interviewId,
        finalizationId: `finalization:${interviewId}`,
        stateVersion: source.interview.version,
        agentRunId,
        finalizedAt: endedAt,
        deterministicValidation,
        agentReport: execution.output,
      });
      if (!finalization.ok) return finalization;
      const eventWrite = await transaction.outbox.append(interviewId, {
        eventId: randomUUID(),
        interviewId,
        runId: agentRunId,
        occurredAt: endedAt,
        category: 'transcript',
        type: 'transcript.finalized',
        payload: {
          entryCount: source.transcript.entries.length,
          technicalGapCount: source.transcript.entries.filter(
            (entry) => entry.kind === 'technical_gap',
          ).length,
          finalizedAt: endedAt,
        },
      });
      return eventWrite.ok ? success(undefined) : eventWrite;
    });
  }

  private async changeLifecycle(interviewId: string, action: 'pause' | 'resume'): Promise<void> {
    const now = this.now();
    const result = await this.unitOfWork.transaction(async (transaction) => {
      const current = await transaction.interviews.lock(interviewId);
      if (!current.ok) return current;
      const transitioned = transitionInterview(current.value.lifecycle, { type: action, at: now });
      if (!transitioned.ok) return constraint(`interview_${action}_lifecycle`);
      const next: PersistedInterview = {
        ...current.value,
        lifecycle: transitioned.state,
        version: current.value.version + 1,
        updatedAt: now,
      };
      const write = await transaction.interviews.compareAndSwap(
        interviewId,
        current.value.version,
        next,
      );
      if (!write.ok) return write;
      const event = await transaction.outbox.append(
        interviewId,
        statusChangedEvent(
          interviewId,
          `lifecycle:${randomUUID()}`,
          current.value.lifecycle.status,
          next.lifecycle.status,
          now,
        ),
      );
      return event.ok ? success(undefined) : event;
    });
    requireRepositoryResult(result, `The interview could not ${action}.`);
  }

  private async resolvePlansAsText(
    interviewId: string,
    initial: MvpRealtimeCommandResponse | MvpRealtimeAppendResponse,
  ): Promise<MvpSessionCommandResponse> {
    const turns: MvpTranscriptTurn[] = [];
    let plan = initial.nextAiTurn;
    while (plan !== null) {
      const response = await this.appendRealtimeAiTurn(interviewId, {
        deliveryId: plan.deliveryId,
        clientEventId: randomUUID(),
        text: plan.text,
        occurredAt: this.now(),
        turnType: plan.turnType,
        questionId: plan.questionId,
      });
      if (response.turn !== null) turns.push(response.turn);
      plan = response.nextAiTurn;
    }
    return { session: await this.get(interviewId), newAiTurns: turns };
  }

  private async commandResponse(interviewId: string): Promise<MvpRealtimeCommandResponse> {
    const source = await this.loadSource(interviewId);
    const pending = await this.readPendingDelivery(interviewId);
    return {
      session: projectSource(source),
      newAiTurns: [],
      nextAiTurn: pending === null ? null : toTurnPlan(pending),
      contextUpdate: buildRealtimeContextUpdate(source),
    };
  }

  private async appendResponse(
    interviewId: string,
    turn: AiTranscriptTurn | ParticipantTranscriptTurn | null,
    inserted: boolean,
  ): Promise<MvpRealtimeAppendResponse> {
    const command = await this.commandResponse(interviewId);
    return {
      session: command.session,
      turn: turn === null ? null : toMvpTurn(turn),
      inserted,
      nextAiTurn: command.nextAiTurn,
    };
  }

  private async loadSource(interviewId: string): Promise<ProjectionSource> {
    const result = await this.unitOfWork.read(async (context) => {
      const interview = await context.interviews.load(interviewId);
      if (!interview.ok) return interview;
      const guide = await context.guides.getById(interview.value.guideId);
      if (!guide.ok) return guide;
      const transcript = await context.transcripts.loadAggregate(interviewId);
      if (!transcript.ok) return transcript;
      const finalization = await context.finalizations.loadLatest(interviewId);
      if (!finalization.ok) return finalization;
      return success({
        guide: guide.value,
        interview: interview.value,
        transcript: transcript.value,
        finalization: finalization.value,
      });
    });
    const source = requireRepositoryResult(result, 'The interview session could not be loaded.');
    try {
      for (const memory of source.interview.sectionMemories ?? []) {
        validateSectionMemoryAgainstSource(
          memory,
          {
            interviewId,
            guide: source.guide,
            coverage: source.interview.coverage,
            transcript: source.transcript,
            sectionId: memory.sectionId,
            sourceThroughSequenceNumber: memory.sourceThroughSequenceNumber,
            compactedAt: source.interview.updatedAt,
          },
          { requireCoverageSnapshot: false, requireExactCompactedAt: false },
        );
      }
    } catch {
      throw new MvpSessionError('invalid_state', 'Stored section memory is inconsistent.');
    }
    return source;
  }

  private async readPendingDelivery(interviewId: string): Promise<StoredAiDelivery | null> {
    const result = await this.unitOfWork.read(async (context) => {
      const pending = await context.transcripts.listPendingAiDeliveries(interviewId);
      return pending.ok ? success(pending.value[0] ?? null) : pending;
    });
    return requireRepositoryResult(result, 'The pending AI turn could not be loaded.');
  }

  private async readContradictions(interviewId: string): Promise<readonly StoredContradiction[]> {
    const result = await this.unitOfWork.read((context) =>
      context.consistency.listContradictions(interviewId),
    );
    return requireRepositoryResult(result, 'Contradictions could not be loaded.');
  }

  private now(): string {
    const now = readClock(this.clock);
    if (!now.ok) throw new MvpSessionError('invalid_state', now.error.message);
    return now.value;
  }
}

function projectSource(source: ProjectionSource): MvpInterviewSession {
  const projected = projectCanonicalSession(source);
  if (!projected.ok) {
    throw new MvpSessionError('conflict', 'The canonical interview session is inconsistent.');
  }
  return projected.value;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function buildRealtimeContextUpdate(source: ProjectionSource): MvpRealtimeContextUpdate | null {
  const sectionMemories = source.interview.sectionMemories ?? [];
  if (sectionMemories.length === 0) return null;
  const session = projectSource(source);
  const instructionContext = { session, guide: source.guide, sectionMemories };
  const retainedTurnIds = new Set(
    selectRealtimeTranscriptTurns(instructionContext).map((turn) => turn.turnId),
  );
  const removeConversationItemIds = source.transcript.entries.flatMap((entry) => {
    if (entry.kind !== 'turn' || retainedTurnIds.has(entry.turnId)) return [];
    if (entry.speaker === 'participant') {
      return entry.sourceProvider === 'openai_realtime' ? [entry.sourceSegmentId] : [];
    }
    return [entry.deliveryEventId];
  });
  const revision = createHash('sha256')
    .update(
      JSON.stringify(
        sectionMemories.map((memory) => ({
          sectionId: memory.sectionId,
          sourceThroughSequenceNumber: memory.sourceThroughSequenceNumber,
          compactedAt: memory.compactedAt,
        })),
      ),
    )
    .digest('hex')
    .slice(0, 32);
  const update = mvpRealtimeContextUpdateSchema.safeParse({
    revision: `section-memory:${revision}`,
    instructions: buildRealtimeInterviewInstructions(instructionContext),
    removeConversationItemIds: [...new Set(removeConversationItemIds)],
  });
  return update.success ? update.data : null;
}

export function toAgentGuideContract(guide: InterviewGuideSnapshot) {
  return guideStructureSchema.parse({
    id: guide.id,
    sourceLanguage: guide.sourceLanguage,
    title: guide.title,
    sections: guide.sections,
  });
}

function requireRepositoryResult<T>(
  result:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: RepositoryError },
  message: string,
): T {
  if (result.ok) return result.value;
  console.error(
    JSON.stringify({
      event: 'canonical_interview.repository_error',
      repositoryError: result.error,
    }),
  );
  if (result.error.code === 'not_found') throw new MvpSessionError('not_found', message);
  if (
    result.error.code === 'duplicate_conflict' ||
    result.error.code === 'stale_version' ||
    result.error.code === 'sequence_conflict' ||
    result.error.code === 'active_job_exists' ||
    result.error.code === 'pending_ai_delivery'
  ) {
    throw new MvpSessionError('conflict', message);
  }
  throw new MvpSessionError('invalid_state', message);
}

function constraint(name: string) {
  return failure<RepositoryError>({ code: 'constraint_violation', constraint: name });
}

function commandIdentifiers(identity: string, interviewId: string) {
  const suffix = `${identity}:${interviewId}`;
  return {
    jobId: `job:${suffix}`,
    workflowRunId: `workflow:${suffix}`,
    attemptId: `attempt:${suffix}`,
    deliveryId: `delivery:${suffix}`,
  };
}

function realtimeTurnIntentIdentifiers(interviewId: string, clientEventId: string) {
  const digest = createHash('sha256')
    .update(`${interviewId}\u0000${clientEventId}`)
    .digest('hex')
    .slice(0, 32);
  const suffix = `realtime-intent:${digest}`;
  return {
    jobId: `job:${suffix}`,
    workflowRunId: `workflow:${suffix}`,
    attemptId: `attempt:${suffix}`,
    deliveryId: `delivery:${suffix}`,
  };
}

async function enqueueAndClaim(
  transaction: AppTransaction,
  interviewId: string,
  input: Parameters<AppTransaction['jobs']['enqueue']>[1],
) {
  const queued = await transaction.jobs.enqueue(interviewId, input);
  if (!queued.ok) return queued;
  const claimed = await transaction.jobs.claim(interviewId, input.jobId, {
    workerId: WORKER_ID,
    leaseDurationMs: JOB_LEASE_MS,
  });
  if (!claimed.ok) return claimed;
  return claimed.value === null ? constraint('durable_job_claim') : success(claimed.value);
}

async function startParticipantWorkflow(
  transaction: AppTransaction,
  current: PersistedInterview,
  guide: InterviewGuideSnapshot,
  transcript: TranscriptAggregate,
  participantTurn: ParticipantTranscriptTurn,
  identifiers: ReturnType<typeof commandIdentifiers>,
  now: string,
): Promise<RepositoryResult<WorkflowScope>> {
  const interviewId = current.interviewId;
  const workflowState = restoreParticipantQuestionForWorkflow(guide, current, participantTurn, now);
  if (!workflowState.ok) return workflowState;
  const job = await enqueueAndClaim(transaction, interviewId, {
    jobId: identifiers.jobId,
    kind: 'participant_turn',
    idempotencyKey: identifiers.jobId,
    sourceTurnId: participantTurn.turnId,
    expectedInterviewVersion: current.version,
    maximumAttempts: 1,
    initialDelayMs: 0,
    resultDeliveryId: identifiers.deliveryId,
  });
  if (!job.ok) return job;
  const workflow = runningWorkflow(current, job.value, identifiers, now);
  const workflowWrite = await transaction.runs.startWorkflow(interviewId, workflow);
  if (!workflowWrite.ok) return workflowWrite;
  const nextState = sameLifecycleUpdate(workflowState.value, {
    activeWorkflowRunId: workflow.workflowRunId,
    updatedAt: now,
  });
  const stateWrite = await transaction.interviews.compareAndSwap(
    interviewId,
    current.version,
    nextState,
  );
  if (!stateWrite.ok) return stateWrite;
  const stateView = projectInterviewView(nextState, guide);
  if (!stateView.ok) return constraint('participant_workflow_projection');
  const events = await transaction.outbox.appendMany(interviewId, [
    workflowStartedEvent(workflow),
    stateUpdatedEvent(interviewId, workflow.workflowRunId, current.version, stateView.value, now),
  ]);
  return events.ok
    ? success({ job: job.value, workflow, state: nextState, guide, transcript })
    : events;
}

export function restoreParticipantQuestionForWorkflow(
  guide: InterviewGuideSnapshot,
  state: PersistedInterview,
  participantTurn: ParticipantTranscriptTurn,
  now: string,
): RepositoryResult<PersistedInterview> {
  const reference = participantTurn.guideReference;
  const targetId = questionId(reference);
  if (reference === null || targetId === null) {
    return constraint('participant_workflow_question_reference');
  }

  const current = state.coverage.questions.find((question) => question.status === 'current');
  if (current?.questionId === targetId) return success(state);
  if (current !== undefined) return constraint('participant_workflow_question_mismatch');

  const target = state.coverage.questions.find((question) => question.questionId === targetId);
  if (
    target === undefined ||
    target.status === 'answered' ||
    target.status === 'skipped_already_answered'
  ) {
    return constraint('participant_workflow_question_state');
  }

  try {
    const coverage = applyCoverageUpdates(guide, state.coverage, {
      interviewId: state.interviewId,
      guideId: state.guideId,
      expectedRevision: state.coverage.revision,
      updates: [
        {
          questionId: targetId,
          status: 'current',
          referencedTurnIds: target.referencedTurnIds,
          at: now,
        },
      ],
    });
    return success({ ...state, coverage });
  } catch {
    return constraint('participant_workflow_question_recovery');
  }
}

function runningWorkflow(
  state: PersistedInterview,
  job: DurableJob,
  identifiers: ReturnType<typeof commandIdentifiers>,
  startedAt: string,
): StoredWorkflowAttempt {
  return {
    interviewId: state.interviewId,
    workflowRunId: identifiers.workflowRunId,
    attemptId: identifiers.attemptId,
    jobId: job.jobId,
    expectedInterviewVersion: state.version,
    attemptNumber: job.attemptCount,
    status: 'running',
    retryCount: 0,
    startedAt,
    endedAt: null,
    durationMs: null,
    failure: null,
    rejectionReason: null,
    appliedAt: null,
  };
}

function completedWorkflow(
  workflow: StoredWorkflowAttempt,
  endedAt: string,
): StoredWorkflowAttempt {
  return {
    ...workflow,
    status: 'succeeded',
    endedAt,
    durationMs: elapsed(workflow.startedAt, endedAt),
    appliedAt: endedAt,
    rejectionReason: null,
    failure: null,
    expectedInterviewVersion: workflow.expectedInterviewVersion,
  } satisfies StoredWorkflowAttempt & { readonly _appliedVersion?: number };
}

function requireLeaseToken(job: DurableJob): string {
  if (job.leaseToken === null)
    throw new MvpSessionError('conflict', 'The durable job lease was lost.');
  return job.leaseToken;
}

function reserveDeliveryInput(
  deliveryId: string,
  jobId: string,
  workflowRunId: string,
  turnType: AiTurnType,
  guideReference: TranscriptGuideReference | null,
  proposedText: string,
  createdAt: string,
  planningMetadata?: MvpRealtimePlanningMetadata | null,
) {
  return {
    deliveryId,
    jobId,
    workflowRunId,
    turnId: `turn:${deliveryId}`,
    utteranceId: `utterance:${deliveryId}`,
    turnType,
    guideReference,
    proposedText,
    createdAt,
    ...(planningMetadata == null ? {} : { planningMetadata }),
  };
}

function nextDeliveryFor(): string {
  return `delivery:${randomUUID()}`;
}

function toTurnPlan(delivery: StoredAiDelivery): MvpRealtimeTurnPlan {
  return {
    deliveryId: delivery.deliveryId,
    workflowRunId: delivery.workflowRunId,
    text: delivery.proposedText,
    turnType: delivery.turnType,
    questionId: questionId(delivery.guideReference),
    guideReference: toContractGuideReference(delivery.guideReference),
  };
}

function questionId(reference: TranscriptGuideReference | null): string | null {
  return reference === null
    ? null
    : reference.kind === 'main_question'
      ? reference.mainQuestionId
      : reference.followUpQuestionId;
}

function toContractGuideReference(
  reference: TranscriptGuideReference | null,
): GuideQuestionReference | null {
  return reference;
}

function deliveryMatchesInput(
  delivery: StoredAiDelivery,
  input: MvpRealtimeAiTurnRequest,
): boolean {
  return (
    delivery.turnType === input.turnType &&
    questionId(delivery.guideReference) === (input.questionId ?? null) &&
    confirmedUtterancesMatch(delivery.proposedText, input.text)
  );
}

export function confirmedUtterancesMatch(expected: string, actual: string): boolean {
  return expected === actual;
}

export function confirmedInterruptedUtterance(
  expectedGeneratedText: string,
  providerGeneratedText: string,
  providerConfirmedSpokenText: string,
): string | null {
  return providerGeneratedText === expectedGeneratedText &&
    providerConfirmedSpokenText.length > 0 &&
    expectedGeneratedText.startsWith(providerConfirmedSpokenText)
    ? providerConfirmedSpokenText
    : null;
}

function shouldReissueExactUtterance(aggregate: TranscriptAggregate): boolean {
  return shouldReissueTechnicalGap(aggregate, 'exact_utterance_mismatch');
}

export function shouldReissueTechnicalGap(
  aggregate: TranscriptAggregate,
  descriptionKind: Extract<
    TechnicalGapDescriptionKind,
    'exact_utterance_mismatch' | 'unconfirmed_interruption'
  >,
): boolean {
  const latestEntry = aggregate.entries.at(-1);
  return !(
    latestEntry?.kind === 'technical_gap' &&
    Object.values(TECHNICAL_GAP_DESCRIPTIONS).some(
      (copy) => copy[descriptionKind] === latestEntry.description,
    )
  );
}

async function recoverAfterTerminalGreetingGap(
  transaction: AppTransaction,
  delivery: StoredAiDelivery,
  now: string,
): Promise<RepositoryResult<void>> {
  const state = await transaction.interviews.lock(delivery.interviewId);
  if (!state.ok) return state;
  if (state.value.lifecycle.status !== 'active') {
    return constraint('realtime_greeting_gap_lifecycle');
  }
  const guide = await transaction.guides.getById(state.value.guideId);
  if (!guide.ok) return guide;
  const currentQuestion = currentCatalogQuestion(guide.value, state.value);
  if (currentQuestion === null) return constraint('realtime_greeting_gap_question');
  const reservation = await transaction.transcripts.reserveAiDelivery(
    delivery.interviewId,
    delivery.reservedSequenceNumber + 1,
    reserveDeliveryInput(
      nextDeliveryFor(),
      delivery.jobId,
      delivery.workflowRunId,
      currentQuestion.kind === 'main' ? 'main_question' : 'follow_up_question',
      currentQuestion.reference,
      currentQuestion.text,
      now,
    ),
  );
  return reservation.ok ? success(undefined) : reservation;
}

async function completeAfterTerminalClosingGap(
  transaction: AppTransaction,
  delivery: StoredAiDelivery,
  now: string,
): Promise<RepositoryResult<void>> {
  const aggregate = await transaction.transcripts.lockAggregate(delivery.interviewId);
  if (!aggregate.ok) return aggregate;
  const partialGaps = await gapUnresolvedParticipantPartials(
    transaction,
    aggregate.value,
    now,
    delivery.workflowRunId,
  );
  if (!partialGaps.ok) return partialGaps;
  const completed = await completeLifecycle(
    transaction,
    delivery.interviewId,
    delivery.workflowRunId,
    now,
  );
  if (!completed.ok) return completed;
  const events = await transaction.outbox.appendMany(delivery.interviewId, [
    ...partialGaps.value.events,
    ...completed.value.events,
  ]);
  return events.ok ? success(undefined) : events;
}

async function restoreRealtimeStateAfterTerminalDeliveryGap(
  transaction: AppTransaction,
  aggregate: TranscriptAggregate,
  workflowRunId: string,
  now: string,
): Promise<RepositoryResult<void>> {
  const participantTurn = latestCanonicalParticipantTurn(aggregate);
  const sourceQuestionId = questionId(participantTurn?.guideReference ?? null);
  if (participantTurn === null || sourceQuestionId === null) {
    return constraint('realtime_terminal_gap_participant');
  }
  const current = await transaction.interviews.lock(aggregate.interviewId);
  if (!current.ok) return current;
  if (current.value.lifecycle.status !== 'active') {
    return constraint('realtime_terminal_gap_lifecycle');
  }
  const currentQuestion = current.value.coverage.questions.find(
    (coverage) => coverage.status === 'current',
  );
  if (currentQuestion === undefined || currentQuestion.questionId === sourceQuestionId) {
    return success(undefined);
  }
  if (
    !current.value.coverage.questions.some((coverage) => coverage.questionId === sourceQuestionId)
  ) {
    return constraint('realtime_terminal_gap_source_question');
  }

  const version = current.value.version + 1;
  const coverage = {
    ...current.value.coverage,
    revision: current.value.coverage.revision + 1,
    questions: current.value.coverage.questions.map((coverage) => {
      if (coverage.questionId === sourceQuestionId) {
        return { ...coverage, status: 'current' as const, updatedAt: now };
      }
      if (coverage.questionId === currentQuestion.questionId) {
        return {
          ...coverage,
          status:
            coverage.referencedTurnIds.length === 0
              ? ('not_addressed' as const)
              : ('partially_answered' as const),
          updatedAt: now,
        };
      }
      return coverage;
    }),
  };
  const nextState: PersistedInterview = {
    ...current.value,
    lifecycle: { ...current.value.lifecycle, revision: version },
    coverage,
    version,
    updatedAt: now,
  };
  const guide = await transaction.guides.getById(current.value.guideId);
  if (!guide.ok) return guide;
  const stateView = projectInterviewView(nextState, guide.value);
  if (!stateView.ok) return constraint('realtime_terminal_gap_projection');
  const stateWrite = await transaction.interviews.compareAndSwap(
    aggregate.interviewId,
    current.value.version,
    nextState,
  );
  if (!stateWrite.ok) return stateWrite;
  const eventWrite = await transaction.outbox.append(
    aggregate.interviewId,
    stateUpdatedEvent(
      aggregate.interviewId,
      workflowRunId,
      current.value.version,
      stateView.value,
      now,
    ),
  );
  return eventWrite.ok ? success(undefined) : eventWrite;
}

async function gapAndReissue(
  transaction: AppTransaction,
  aggregate: TranscriptAggregate,
  delivery: StoredAiDelivery,
  now: string,
  sourceEventId: string,
  descriptionKind: Extract<
    TechnicalGapDescriptionKind,
    'exact_utterance_mismatch' | 'unconfirmed_interruption'
  >,
  shouldReissue = true,
) {
  const interview = await transaction.interviews.load(aggregate.interviewId);
  if (!interview.ok) return interview;
  let recorded;
  try {
    const gapOccurredAt = monotonicTimestamp(maxTimestamp(now, delivery.createdAt), aggregate);
    recorded = recordTranscriptTechnicalGap(aggregateAtReservedSequence(aggregate, delivery), {
      interviewId: aggregate.interviewId,
      gapId: `gap:${delivery.deliveryId}`,
      sourceEventId,
      source: 'audio_output',
      sourceProvider: null,
      relatedUtteranceId: null,
      relatedSegmentId: null,
      description: interviewTechnicalGapDescription(
        interview.value.language ?? DEFAULT_LOCALE,
        descriptionKind,
      ),
      occurredAt: gapOccurredAt,
    });
  } catch {
    return constraint('ai_delivery_gap_domain');
  }
  const resolutionAt = maxTimestamp(now, recorded.gap.occurredAt);
  const gapWrite = await transaction.transcripts.gapAiDelivery(aggregate.interviewId, {
    deliveryId: delivery.deliveryId,
    resolvedAt: resolutionAt,
    status: 'gapped',
    gap: recorded.gap,
  });
  if (!gapWrite.ok) return gapWrite;
  let nextDelivery: StoredAiDelivery | null = null;
  if (shouldReissue) {
    const reserve = await transaction.transcripts.reserveAiDelivery(
      aggregate.interviewId,
      delivery.reservedSequenceNumber + 1,
      reserveDeliveryInput(
        nextDeliveryFor(),
        delivery.jobId,
        delivery.workflowRunId,
        delivery.turnType,
        delivery.guideReference,
        delivery.proposedText,
        resolutionAt,
        delivery.planningMetadata,
      ),
    );
    if (!reserve.ok) return reserve;
    nextDelivery = reserve.value.value;
  }
  const event = await transaction.outbox.append(
    aggregate.interviewId,
    gapEvent(recorded.gap, delivery.workflowRunId, resolutionAt),
  );
  return event.ok ? success({ nextDelivery, resolvedAt: resolutionAt }) : event;
}

async function gapUnresolvedParticipantPartials(
  transaction: AppTransaction,
  aggregate: TranscriptAggregate,
  now: string,
  runId: string,
) {
  let current = aggregate;
  const events: MonitoringEventDraft[] = [];
  if (aggregate.partials.length === 0) return success({ aggregate: current, events });
  const interview = await transaction.interviews.load(aggregate.interviewId);
  if (!interview.ok) return interview;
  const description = interviewTechnicalGapDescription(
    interview.value.language ?? DEFAULT_LOCALE,
    'partial_not_finalized',
  );
  for (const partial of aggregate.partials) {
    const occurredAt = monotonicTimestamp(maxTimestamp(now, partial.observedAt), current);
    let recorded;
    try {
      recorded = recordTranscriptTechnicalGap(current, {
        interviewId: aggregate.interviewId,
        gapId: `gap:${randomUUID()}`,
        sourceEventId: `finish-partial:${randomUUID()}`,
        source: 'speech_to_text',
        sourceProvider: partial.sourceProvider,
        relatedUtteranceId: partial.utteranceId,
        relatedSegmentId: partial.segmentId,
        description,
        occurredAt,
      });
    } catch {
      return constraint('finish_partial_gap_domain');
    }
    const write = await transaction.transcripts.appendTechnicalGap(
      aggregate.interviewId,
      current.nextSequenceNumber,
      recorded.gap,
    );
    if (!write.ok) return write;
    current = recorded.aggregate;
    events.push(gapEvent(recorded.gap, runId, occurredAt));
  }
  return success({ aggregate: current, events });
}

function aggregateAtReservedSequence(
  aggregate: TranscriptAggregate,
  delivery: StoredAiDelivery,
): TranscriptAggregate {
  return {
    ...aggregate,
    nextSequenceNumber: delivery.reservedSequenceNumber,
  };
}

function latestOpenQuestion(aggregate: TranscriptAggregate): AiTranscriptTurn | null {
  for (let index = aggregate.entries.length - 1; index >= 0; index -= 1) {
    const entry = aggregate.entries[index];
    if (entry?.kind !== 'turn') continue;
    if (entry.speaker === 'participant') return null;
    if (
      entry.turnType === 'main_question' ||
      entry.turnType === 'follow_up_question' ||
      entry.turnType === 'clarification_question'
    ) {
      return entry;
    }
  }
  return null;
}

function latestCanonicalParticipantTurn(
  aggregate: TranscriptAggregate,
): ParticipantTranscriptTurn | null {
  for (let index = aggregate.entries.length - 1; index >= 0; index -= 1) {
    const entry = aggregate.entries[index];
    if (entry?.kind !== 'turn') continue;
    return entry.speaker === 'participant' ? entry : null;
  }
  return null;
}

function findAiTurn(aggregate: TranscriptAggregate, turnId: string): AiTranscriptTurn | null {
  return (
    aggregate.entries.find(
      (entry): entry is AiTranscriptTurn =>
        entry.kind === 'turn' && entry.speaker === 'ai_interviewer' && entry.turnId === turnId,
    ) ?? null
  );
}

interface PlannedRealtimeTurnIntent {
  readonly turnType: AiTurnType;
  readonly guideReference: TranscriptGuideReference | null;
  readonly targetQuestionId: string | null;
  readonly text: string;
  readonly currentQuestionResolution:
    'answered' | 'partially_answered' | 'skipped_already_answered';
}

export interface RealtimeTurnIntentHistory {
  readonly latestParticipantText: string;
  readonly priorClarificationTexts: readonly string[];
  readonly priorClarificationAspects?: readonly string[];
  readonly repetitionCount?: number;
}

const REALTIME_REJECTION_PREFIX = 'realtime_turn_intent_rejected:';

export function resolveRealtimeTurnIntent(
  guide: InterviewGuideSnapshot,
  state: PersistedInterview,
  input: MvpRealtimeTurnIntentRequest,
  history: RealtimeTurnIntentHistory = {
    latestParticipantText: '',
    priorClarificationTexts: [],
  },
): RepositoryResult<PlannedRealtimeTurnIntent> {
  if (state.guideId !== guide.id) return constraint('realtime_turn_intent_guide');
  if (input.spokenText.trim().length === 0) {
    return constraint('realtime_turn_intent_text');
  }
  const catalog = buildGuideQuestionCatalog(guide);
  const current = state.coverage.questions.find((coverage) => coverage.status === 'current');
  if (current === undefined) return constraint('realtime_turn_intent_current_question');
  const currentQuestion = catalog.find((question) => question.questionId === current.questionId);
  if (currentQuestion === undefined) return constraint('realtime_turn_intent_current_question');
  const language = state.language ?? DEFAULT_LOCALE;
  const answerDisposition = resolveAnswerDisposition(
    currentQuestion.text,
    history.latestParticipantText,
    input.answerDisposition,
    language,
  );
  const currentQuestionResolution = coverageResolution(answerDisposition);
  const currentMainIndex = catalog.findIndex(
    (question) => question.kind === 'main' && question.mainQuestionId === current.mainQuestionId,
  );
  const nextMainQuestion = catalog.slice(Math.max(0, currentMainIndex + 1)).find((question) => {
    if (question.kind !== 'main' || question.mainQuestionId === current.mainQuestionId)
      return false;
    const coverage = state.coverage.questions.find(
      (candidate) => candidate.questionId === question.questionId,
    );
    return (
      coverage !== undefined &&
      coverage.status !== 'answered' &&
      coverage.status !== 'skipped_already_answered'
    );
  });
  const advance = () =>
    nextRealtimeTurn(catalog, state, currentQuestion.questionId, currentQuestionResolution);
  const advanceToNextMain = () =>
    nextMainQuestion === undefined
      ? {
          turnType: 'closing' as const,
          guideReference: null,
          targetQuestionId: null,
          text: interviewClosingText(state.language ?? DEFAULT_LOCALE),
          currentQuestionResolution,
        }
      : {
          turnType: 'main_question' as const,
          guideReference: nextMainQuestion.reference,
          targetQuestionId: nextMainQuestion.questionId,
          text: nextMainQuestion.text,
          currentQuestionResolution,
        };

  const reject = (reason: string): RepositoryResult<PlannedRealtimeTurnIntent> =>
    input.repairAttempt === 1
      ? success(advance())
      : constraint(`${REALTIME_REJECTION_PREFIX}${reason}`);

  if (requiresTopicAdvance(answerDisposition)) return success(advanceToNextMain());

  if (answerDisposition === 'off_topic' || answerDisposition === 'question_misunderstood') {
    if ((history.repetitionCount ?? 0) >= REALTIME_QUESTION_LIMITS.repetitions)
      return success(advance());
    if (input.action !== 'repeat_question' || input.questionId !== currentQuestion.questionId) {
      return reject(
        'Repeat the current guide question once using repeat_question and its current questionId; the answer did not address it.',
      );
    }
    return success({
      turnType: 'clarification_question',
      guideReference: currentQuestion.reference,
      targetQuestionId: currentQuestion.questionId,
      text: `${language === 'en' ? 'Let me ask that again: ' : 'Ich stelle die Frage noch einmal: '}${currentQuestion.text}`,
      currentQuestionResolution: 'partially_answered',
    });
  }

  if (input.action === 'complete_interview') {
    if (nextMainQuestion !== undefined) {
      return success({
        turnType: 'main_question',
        guideReference: nextMainQuestion.reference,
        targetQuestionId: nextMainQuestion.questionId,
        text: nextMainQuestion.text,
        currentQuestionResolution,
      });
    }
    return success({
      turnType: 'closing',
      guideReference: null,
      targetQuestionId: null,
      text: interviewClosingText(state.language ?? DEFAULT_LOCALE),
      currentQuestionResolution,
    });
  }

  const requestedTarget = catalog.find((question) => question.questionId === input.questionId);
  switch (input.action) {
    case 'ask_main_question': {
      if (nextMainQuestion === undefined) {
        return success({
          turnType: 'closing',
          guideReference: null,
          targetQuestionId: null,
          text: interviewClosingText(state.language ?? DEFAULT_LOCALE),
          currentQuestionResolution,
        });
      }
      return success({
        turnType: 'main_question',
        guideReference: nextMainQuestion.reference,
        targetQuestionId: nextMainQuestion.questionId,
        text: nextMainQuestion.text,
        currentQuestionResolution,
      });
    }
    case 'ask_follow_up_question': {
      const target = resolveRealtimeFollowUpTarget(
        catalog,
        state,
        current.questionId,
        current.mainQuestionId,
        requestedTarget,
        input.spokenText,
      );
      if (target === null) return success(advance());
      return success({
        turnType: 'follow_up_question',
        guideReference: target.reference,
        targetQuestionId: target.questionId,
        text: target.text,
        currentQuestionResolution,
      });
    }
    case 'ask_clarification_question': {
      const contradiction = input.requestedEvidenceType === 'contradiction';
      if (history.priorClarificationTexts.length >= REALTIME_QUESTION_LIMITS.clarifications)
        return success(advance());
      if (answerDisposition === 'answered' && !contradiction) return success(advance());
      if (answerDisposition !== 'partial' && !contradiction) {
        return reject(
          'A clarification requires an incomplete answer or a specific contradiction. Do not probe a complete answer.',
        );
      }
      if (input.questionId !== currentQuestion.questionId) {
        return reject(
          `Use the current questionId ${currentQuestion.questionId} for a clarification, not a different guide question.`,
        );
      }
      if (input.missingAspect === null || input.requestedEvidenceType === null) {
        return reject(
          'Name one missingAspect and its requestedEvidenceType before asking a clarification.',
        );
      }
      if (isGenericClarificationText(input.spokenText, language)) {
        return reject(
          'The clarification is generic. Ask explicitly about one missing action, responsibility, example, time, sequence, or outcome.',
        );
      }
      if (!clarificationMentionsMissingAspect(input.spokenText, input.missingAspect, language)) {
        return reject(
          'The spoken question does not identify missingAspect. Include the specific missing aspect in the question itself.',
        );
      }
      if (
        !clarificationStaysWithinTopic(
          catalog,
          currentQuestion.mainQuestionId,
          input.spokenText,
          input.missingAspect,
          history.latestParticipantText,
          language,
        )
      ) {
        return reject(
          "The clarification is not grounded in the current guide topic. Ask only about the current main question and the participant's relevant answer.",
        );
      }
      if (
        history.priorClarificationTexts.some((prior) =>
          areNearDuplicateQuestions(prior, input.spokenText),
        ) ||
        (history.priorClarificationAspects ?? []).some((prior) =>
          areNearDuplicateQuestions(prior, input.missingAspect ?? ''),
        )
      ) {
        return reject(
          'This question or missingAspect was already probed. Choose a different unresolved aspect or advance to the next open guide question.',
        );
      }
      return success({
        turnType: 'clarification_question',
        guideReference: currentQuestion.reference,
        targetQuestionId: currentQuestion.questionId,
        text: input.spokenText,
        currentQuestionResolution: 'partially_answered',
      });
    }
    case 'repeat_question':
      return reject(
        'repeat_question is only allowed when the current question was misunderstood or the answer was off-topic. Otherwise answer the next open guide question or ask a specific clarification.',
      );
  }
}

function nextRealtimeTurn(
  catalog: ReturnType<typeof buildGuideQuestionCatalog>,
  state: PersistedInterview,
  currentQuestionId: string,
  currentQuestionResolution: PlannedRealtimeTurnIntent['currentQuestionResolution'],
): PlannedRealtimeTurnIntent {
  const currentIndex = catalog.findIndex((question) => question.questionId === currentQuestionId);
  const nextQuestion = catalog
    .slice(Math.max(0, currentIndex + 1))
    .find((question) => isOpenRealtimeQuestion(state, question.questionId));
  if (nextQuestion === undefined) {
    return {
      turnType: 'closing',
      guideReference: null,
      targetQuestionId: null,
      text: interviewClosingText(state.language ?? DEFAULT_LOCALE),
      currentQuestionResolution,
    };
  }
  return {
    turnType: nextQuestion.kind === 'main' ? 'main_question' : 'follow_up_question',
    guideReference: nextQuestion.reference,
    targetQuestionId: nextQuestion.questionId,
    text: nextQuestion.text,
    currentQuestionResolution,
  };
}

function resolveAnswerDisposition(
  currentQuestionText: string,
  participantText: string,
  proposed: MvpRealtimeTurnIntentRequest['answerDisposition'],
  language: SupportedLocale,
): MvpRealtimeTurnIntentRequest['answerDisposition'] {
  const answer = normalizeComparableText(participantText);
  const question = normalizeComparableText(currentQuestionText);
  return language === 'en'
    ? resolveEnglishAnswerDisposition(question, answer, proposed)
    : resolveGermanAnswerDisposition(question, answer, proposed);
}

function resolveGermanAnswerDisposition(
  question: string,
  answer: string,
  proposed: MvpRealtimeTurnIntentRequest['answerDisposition'],
): MvpRealtimeTurnIntentRequest['answerDisposition'] {
  if (
    /\b(?:habe|hatte|wurde) (?:ich )?(?:bereits|schon) (?:gesagt|beantwortet|erklart)\b/u.test(
      answer,
    ) ||
    /\b(?:schon|bereits)(?: noch)?(?: einmal)?(?: genauer)? (?:gesagt|beantwortet|erklart)\b/u.test(
      answer,
    )
  ) {
    return 'already_answered';
  }
  if (
    /\b(?:mochte|moechte|will|kann) ich (?:das |dazu )?nicht (?:antworten|beantworten|sagen)\b/u.test(
      answer,
    ) ||
    /\bich (?:mochte|moechte|will|kann) (?:das |dazu )?nicht (?:antworten|beantworten|sagen)\b/u.test(
      answer,
    ) ||
    /\bkeine angabe\b/u.test(answer)
  ) {
    return 'declined';
  }
  if (/\b(?:weiss|weis) ich nicht\b/u.test(answer) || /\bkeine ahnung\b/u.test(answer)) {
    return 'dont_know';
  }
  if (
    /^(?:nein|ne|nope)$/u.test(answer) &&
    /^(?:gibt|haben|hat|ist|sind|werden|wird|wurde|wurden|konnen|kann)\b/u.test(question)
  )
    return 'answered';
  if (
    /^(?:nein|ne|nope)$/u.test(answer) ||
    /\b(?:trifft nicht zu|nicht relevant|nicht anwendbar|gibt es bei uns nicht|gab es bei uns nicht)\b/u.test(
      answer,
    )
  ) {
    return 'not_applicable';
  }
  if (
    (/\b(?:wie lange|seit wann)\b/u.test(question) &&
      /\b(?:seit |vor )?(?:\d+(?:[.,]\d+)?|ein(?:e|em|en|er|es)?|zwei|drei|vier|funf|sechs|sieben|acht|neun|zehn|elf|zwolf) (?:jahr|jahre|jahren|monat|monate|monaten|woche|wochen|tag|tage|tagen)\b/u.test(
        answer,
      )) ||
    (/\bwie viele\b/u.test(question) &&
      /\b(?:\d+(?:[.,]\d+)?|ein(?:e|em|en|er|es)?|zwei|drei|vier|funf|sechs|sieben|acht|neun|zehn|elf|zwolf|dreizehn|vierzehn|funfzehn|zwanzig)\b/u.test(
        answer,
      )) ||
    (/\b(?:welche|was ist ihre) rolle\b/u.test(question) &&
      /(?:\bich (?:bin|arbeite als) (?:der |die |das |ein |eine )?(?:teamleiter|leiter|manager|geschaftsfuhrer|vorstand|berater|forscher)\b|\bmeine rolle ist\b|^(?:(?:der|die) )?(?:teamleiter|leiter|manager|geschaftsfuhrer|vorstand|berater|forscher)\b)/u.test(
        answer,
      ))
  ) {
    return 'answered';
  }
  return proposed;
}

function resolveEnglishAnswerDisposition(
  question: string,
  answer: string,
  proposed: MvpRealtimeTurnIntentRequest['answerDisposition'],
): MvpRealtimeTurnIntentRequest['answerDisposition'] {
  if (
    /\b(?:i (?:have )?(?:already|previously) (?:answered|said|mentioned|explained)(?: (?:that|this|it))?|i answered (?:that|this|it) already|as i (?:already )?(?:said|mentioned|explained))\b/u.test(
      answer,
    )
  ) {
    return 'already_answered';
  }
  if (
    /\b(?:i (?:d|would) rather not (?:answer|say|discuss|share)|i (?:prefer|choose) not to (?:answer|say|discuss|share)|i (?:do not|don t|will not|won t) want to (?:answer|say|discuss|share)|no comment)\b/u.test(
      answer,
    )
  ) {
    return 'declined';
  }
  if (/\b(?:i (?:do not|don t) know|i am not sure|i m not sure|no idea)\b/u.test(answer)) {
    return 'dont_know';
  }
  if (
    /^(?:no|nope)$/u.test(answer) &&
    /^(?:do|does|did|is|are|was|were|have|has|can|could|will|would)\b/u.test(question)
  )
    return 'answered';
  if (
    /^(?:no|nope)$/u.test(answer) ||
    /\b(?:does not apply|doesn t apply|not applicable|not relevant|there is no such|that has never happened|we have not experienced (?:that|this|it))\b/u.test(
      answer,
    )
  ) {
    return 'not_applicable';
  }
  if (
    (/\b(?:how long|since when)\b/u.test(question) &&
      (/\b(?:for )?(?:\d+(?:[.,]\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve) (?:year|years|month|months|week|weeks|day|days)\b/u.test(
        answer,
      ) ||
        /\bsince (?:\d{4}|last (?:year|month|week))\b/u.test(answer))) ||
    (/\b(?:how many|what number of)\b/u.test(question) &&
      /\b(?:\d+(?:[.,]\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|twenty)\b/u.test(
        answer,
      )) ||
    (/\b(?:what|which) (?:is )?(?:your )?role\b/u.test(question) &&
      /(?:\bi (?:am|work as|serve as|act as) (?:the |a |an )?(?:manager|director|head|lead|officer|consultant|researcher|professor|engineer|owner|founder|ceo|cfo|cto)\b|\bmy role (?:is|includes|involves)\b|^(?:(?:the|a|an) )?(?:manager|director|head|lead|officer|consultant|researcher|professor|engineer|owner|founder|ceo|cfo|cto)\b)/u.test(
        answer,
      ))
  ) {
    return 'answered';
  }
  return proposed;
}

function coverageResolution(
  disposition: MvpRealtimeTurnIntentRequest['answerDisposition'],
): PlannedRealtimeTurnIntent['currentQuestionResolution'] {
  if (disposition === 'answered') return 'answered';
  if (disposition === 'already_answered') return 'skipped_already_answered';
  return 'partially_answered';
}

function requiresTopicAdvance(
  disposition: MvpRealtimeTurnIntentRequest['answerDisposition'],
): boolean {
  return (
    disposition === 'dont_know' ||
    disposition === 'declined' ||
    disposition === 'not_applicable' ||
    disposition === 'already_answered'
  );
}

function isGenericClarificationText(text: string, language: SupportedLocale): boolean {
  const normalized = normalizeComparableText(text);
  return language === 'en'
    ? /^(?:(?:could|can|would) you (?:please )?(?:(?:elaborate|explain|describe)(?: more| in more detail)?|(?:say|tell me) (?:a bit |some )?more(?: about (?:it|that))?)|please elaborate)$/u.test(
        normalized,
      )
    : /^(?:konnen|konnten|wurden) sie (?:ihre letzte antwort )?(?:bitte )?(?:noch )?(?:etwas )?(?:genauer|naher|ausfuhrlicher) (?:erlautern|beschreiben|ausfuhren)$/u.test(
        normalized,
      ) || /^(?:konnen|konnten) sie (?:bitte )?(?:noch )?mehr dazu sagen$/u.test(normalized);
}

function clarificationMentionsMissingAspect(
  question: string,
  missingAspect: string,
  language: SupportedLocale,
): boolean {
  const questionTokens = specificClarificationTokens(question, language);
  const aspectTokens = specificClarificationTokens(missingAspect, language);
  return aspectTokens.some((aspect) =>
    questionTokens.some((questionToken) =>
      questionToken.length >= 5 && aspect.length >= 5
        ? questionToken.slice(0, 5) === aspect.slice(0, 5)
        : questionToken === aspect,
    ),
  );
}

function clarificationStaysWithinTopic(
  catalog: ReturnType<typeof buildGuideQuestionCatalog>,
  mainQuestionId: string,
  question: string,
  missingAspect: string,
  participantText: string,
  language: SupportedLocale,
): boolean {
  const requestedTokens = new Set([
    ...specificClarificationTokens(question, language),
    ...specificClarificationTokens(missingAspect, language),
  ]);
  const guideTopicText = catalog
    .filter((candidate) => candidate.mainQuestionId === mainQuestionId)
    .map((candidate) => candidate.text)
    .join(' ');
  const guideTopicTokens = new Set(topicClarificationTokens(guideTopicText, language));
  const participantTokens = new Set(specificClarificationTokens(participantText, language));
  const topicTokens = new Set([...guideTopicTokens, ...participantTokens]);
  const supportedTokens = [...requestedTokens].filter((token) =>
    [...topicTokens].some((topicToken) => clarificationTokensMatch(token, topicToken)),
  );
  const hasGuideTopicAnchor = [...requestedTokens].some((token) =>
    [...guideTopicTokens].some((guideToken) => clarificationTokensMatch(token, guideToken)),
  );
  return hasGuideTopicAnchor && supportedTokens.length / requestedTokens.size >= 0.34;
}

function clarificationTokensMatch(left: string, right: string): boolean {
  return left.length >= 5 && right.length >= 5
    ? left.slice(0, 5) === right.slice(0, 5)
    : left === right;
}

function topicClarificationTokens(value: string, language: SupportedLocale): string[] {
  const tokens = [...specificClarificationTokens(value, language)];
  const normalized = normalizeComparableText(value);
  if (language === 'de' && /\brolle\b/u.test(normalized)) {
    tokens.push('aufgaben', 'verantwortung', 'entscheidungen', 'tatigkeit');
  }
  if (language === 'de' && /\b(?:verantwortung|verantwortlich)\b/u.test(normalized)) {
    tokens.push('rolle', 'aufgaben', 'zustandigkeit', 'entscheidungen');
  }
  if (language === 'en' && /\brole\b/u.test(normalized)) {
    tokens.push('responsibilities', 'tasks', 'decisions', 'duties');
  }
  if (language === 'en' && /\bresponsibilit\w*\b/u.test(normalized)) {
    tokens.push('role', 'tasks', 'duties', 'accountability', 'ownership');
  }
  if (
    language === 'de' &&
    /\b(?:bedingung|herausforder|krise|ereignis|situation|reagier|handeln|umgang|vorgehen|schwierigkeit)\w*\b/u.test(
      normalized,
    )
  ) {
    tokens.push(
      'massnahme',
      'handlung',
      'reaktion',
      'reagiert',
      'entscheidung',
      'beteiligte',
      'verantwortung',
      'schritt',
      'ablauf',
      'ergebnis',
    );
  }
  if (
    language === 'en' &&
    /\b(?:condition|challenge|crisis|event|situation|react|response|respond|act|approach|difficult|handle)\w*\b/u.test(
      normalized,
    )
  ) {
    tokens.push(
      'action',
      'measure',
      'response',
      'decision',
      'actor',
      'responsibility',
      'step',
      'sequence',
      'outcome',
      'result',
    );
  }
  return tokens;
}

function specificClarificationTokens(value: string, language: SupportedLocale): string[] {
  const ignoredGerman = new Set([
    'antworten',
    'aspekt',
    'bitte',
    'dazu',
    'diese',
    'diesem',
    'diesen',
    'dieser',
    'dieses',
    'detail',
    'details',
    'einen',
    'einer',
    'einem',
    'etwas',
    'fehlende',
    'fehlenden',
    'genauer',
    'geben',
    'haben',
    'information',
    'informationen',
    'ihnen',
    'ihre',
    'ihren',
    'ihrem',
    'ihrer',
    'fuer',
    'konkret',
    'konkrete',
    'konkreten',
    'konkretes',
    'konkreter',
    'konkretem',
    'konnen',
    'konnten',
    'mehr',
    'nennen',
    'organisation',
    'rolle',
    'antwort',
    'erlautern',
    'beschreiben',
    'sagen',
    'selbst',
    'welche',
    'welcher',
    'welches',
    'unternehmen',
    'uebernehmen',
    'ubernehmen',
    'wurden',
    'beispiel',
  ]);
  const ignoredEnglish = new Set([
    'about',
    'answer',
    'aspect',
    'because',
    'could',
    'would',
    'please',
    'more',
    'detail',
    'details',
    'missing',
    'information',
    'give',
    'provide',
    'tell',
    'explain',
    'describe',
    'elaborate',
    'specific',
    'specifically',
    'concrete',
    'example',
    'which',
    'what',
    'when',
    'where',
    'whose',
    'your',
    'personally',
    'have',
    'does',
    'this',
    'that',
    'these',
    'those',
    'organization',
    'company',
    'role',
    'handle',
  ]);
  const ignored = language === 'en' ? ignoredEnglish : ignoredGerman;
  return normalizeComparableText(value)
    .split(' ')
    .filter((token) => token.length >= 4 && !ignored.has(token));
}

function areNearDuplicateQuestions(left: string, right: string): boolean {
  const normalizedLeft = normalizeComparableText(left);
  const normalizedRight = normalizeComparableText(right);
  if (normalizedLeft === normalizedRight) return true;
  const leftTokens = meaningfulQuestionTokens(normalizedLeft);
  const rightTokens = meaningfulQuestionTokens(normalizedRight);
  if (leftTokens.size === 0 || rightTokens.size === 0) return false;
  let intersection = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) intersection += 1;
  }
  return intersection / Math.max(leftTokens.size, rightTokens.size) >= 0.75;
}

function normalizeComparableText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/\u00df/gu, 'ss')
    .replace(/[^a-z0-9]+/gu, ' ')
    .trim();
}

function resolveRealtimeFollowUpTarget(
  catalog: ReturnType<typeof buildGuideQuestionCatalog>,
  state: PersistedInterview,
  currentQuestionId: string,
  currentMainQuestionId: string,
  requestedTarget: (typeof catalog)[number] | undefined,
  spokenText: string,
): FollowUpGuideQuestionCatalogEntry | null {
  if (
    requestedTarget?.kind === 'follow_up' &&
    requestedTarget.mainQuestionId === currentMainQuestionId &&
    requestedTarget.questionId !== currentQuestionId &&
    isOpenRealtimeQuestion(state, requestedTarget.questionId)
  ) {
    return requestedTarget;
  }

  const openFollowUps = catalog.filter(
    (question): question is FollowUpGuideQuestionCatalogEntry =>
      question.kind === 'follow_up' &&
      question.mainQuestionId === currentMainQuestionId &&
      question.questionId !== currentQuestionId &&
      isOpenRealtimeQuestion(state, question.questionId),
  );
  if (openFollowUps.length === 0) return null;

  const spokenTokens = meaningfulQuestionTokens(spokenText);
  let closest: FollowUpGuideQuestionCatalogEntry | null = null;
  let closestScore = 0;
  for (const candidate of openFollowUps) {
    const candidateTokens = meaningfulQuestionTokens(candidate.text);
    if (candidateTokens.size === 0) continue;
    let matchingTokens = 0;
    for (const token of candidateTokens) {
      if (spokenTokens.has(token)) matchingTokens += 1;
    }
    const score = matchingTokens / candidateTokens.size;
    if (score > closestScore) {
      closest = candidate;
      closestScore = score;
    }
  }
  return closest !== null && closestScore >= 0.5 ? closest : (openFollowUps[0] ?? null);
}

function isOpenRealtimeQuestion(state: PersistedInterview, questionId: string): boolean {
  const coverage = state.coverage.questions.find(
    (candidate) => candidate.questionId === questionId,
  );
  return (
    coverage !== undefined &&
    coverage.status !== 'answered' &&
    coverage.status !== 'skipped_already_answered'
  );
}

function meaningfulQuestionTokens(text: string): ReadonlySet<string> {
  const normalized = text
    .toLowerCase()
    .replace(/\u00e4/gu, 'ae')
    .replace(/\u00f6/gu, 'oe')
    .replace(/\u00fc/gu, 'ue')
    .replace(/\u00df/gu, 'ss')
    .replace(/[^a-z0-9]+/gu, ' ');
  return new Set(normalized.split(/\s+/u).filter((token) => token.length >= 4));
}

export function applyRealtimeTurnIntentCoverage(
  guide: InterviewGuideSnapshot,
  state: PersistedInterview,
  participantTurn: ParticipantTranscriptTurn,
  planned: PlannedRealtimeTurnIntent,
  now: string,
) {
  const current = state.coverage.questions.find((coverage) => coverage.status === 'current');
  if (current === undefined) return constraint('realtime_turn_intent_current_coverage');
  const updates: CoverageUpdate[] = [];
  if (planned.targetQuestionId === current.questionId) {
    updates.push({
      questionId: current.questionId,
      status: 'current',
      referencedTurnIds: [participantTurn.turnId],
      at: now,
    });
  } else {
    updates.push({
      questionId: current.questionId,
      status: planned.currentQuestionResolution,
      referencedTurnIds: [participantTurn.turnId],
      at: now,
    });
    if (planned.targetQuestionId !== null) {
      const target = state.coverage.questions.find(
        (coverage) => coverage.questionId === planned.targetQuestionId,
      );
      if (
        target === undefined ||
        target.status === 'answered' ||
        target.status === 'skipped_already_answered'
      ) {
        return constraint('realtime_turn_intent_target_coverage');
      }
      updates.push({
        questionId: target.questionId,
        status: 'current',
        referencedTurnIds: target.referencedTurnIds,
        at: now,
      });
    }
  }
  try {
    return success(
      applyCoverageUpdates(guide, state.coverage, {
        interviewId: state.interviewId,
        guideId: state.guideId,
        expectedRevision: state.coverage.revision,
        updates,
      }),
    );
  } catch {
    return constraint('realtime_turn_intent_coverage');
  }
}

function currentCatalogQuestion(guide: InterviewGuideSnapshot, state: PersistedInterview) {
  const current = state.coverage.questions.find((coverage) => coverage.status === 'current');
  if (current === undefined) return null;
  return (
    buildGuideQuestionCatalog(guide).find(
      (question) => question.questionId === current.questionId,
    ) ?? null
  );
}

export function workflowCandidateQuestionIds(
  catalog: ReturnType<typeof buildGuideQuestionCatalog>,
  state: PersistedInterview,
  currentMainQuestionId: string,
): string[] {
  const openQuestionIds = new Set(
    state.coverage.questions.flatMap((coverage) =>
      coverage.status === 'answered' || coverage.status === 'skipped_already_answered'
        ? []
        : [coverage.questionId],
    ),
  );
  const currentTopicIds = catalog.flatMap((question) =>
    question.mainQuestionId === currentMainQuestionId && openQuestionIds.has(question.questionId)
      ? [question.questionId]
      : [],
  );
  const nextMainQuestion = catalog.find(
    (question) =>
      question.kind === 'main' &&
      question.mainQuestionId !== currentMainQuestionId &&
      openQuestionIds.has(question.questionId),
  );
  return nextMainQuestion === undefined
    ? currentTopicIds
    : [...currentTopicIds, nextMainQuestion.questionId];
}

function sameLifecycleUpdate(
  current: PersistedInterview,
  updates: Pick<PersistedInterview, 'activeWorkflowRunId' | 'updatedAt'>,
): PersistedInterview {
  const version = current.version + 1;
  return {
    ...current,
    ...updates,
    version,
    lifecycle: { ...current.lifecycle, revision: version },
  };
}

export function applyWorkflowCoverage(
  guide: InterviewGuideSnapshot,
  state: PersistedInterview,
  participantTurn: ParticipantTranscriptTurn,
  output: InterviewTurnWorkflowOutput,
  now: string,
) {
  const updates = new Map<string, CoverageUpdate>();
  const action = output.decision.selectedAction;
  const targetId =
    action.action === 'ask_main_question'
      ? action.target.mainQuestionId
      : action.action === 'ask_follow_up_question'
        ? action.target.followUpQuestionId
        : action.action === 'ask_clarification_question'
          ? questionId(action.target)
          : null;
  for (const finding of output.coverageAnalysis.findings) {
    const findingId = questionId(finding.question);
    if (findingId === null) continue;
    const existing = state.coverage.questions.find((coverage) => coverage.questionId === findingId);
    if (existing === undefined) continue;
    if (targetId === findingId) {
      updates.set(findingId, {
        questionId: findingId,
        status: 'current',
        referencedTurnIds: finding.transcriptTurnIds,
        at: now,
      });
      continue;
    }
    updates.set(findingId, {
      questionId: findingId,
      status: finding.status,
      referencedTurnIds: finding.transcriptTurnIds,
      at: now,
    });
  }
  const current = state.coverage.questions.find((coverage) => coverage.status === 'current');
  if (
    current !== undefined &&
    targetId !== current.questionId &&
    !updates.has(current.questionId)
  ) {
    updates.set(current.questionId, {
      questionId: current.questionId,
      status: 'partially_answered',
      referencedTurnIds: [participantTurn.turnId],
      at: now,
    });
  }
  if (targetId !== null) {
    const target = state.coverage.questions.find((coverage) => coverage.questionId === targetId);
    if (
      target !== undefined &&
      target.status !== 'answered' &&
      target.status !== 'skipped_already_answered'
    ) {
      const pendingUpdate = updates.get(targetId);
      updates.set(targetId, {
        questionId: targetId,
        status: 'current',
        referencedTurnIds: pendingUpdate?.referencedTurnIds ?? target.referencedTurnIds,
        at: now,
      });
    }
  }
  try {
    return success(
      applyCoverageUpdates(guide, state.coverage, {
        interviewId: state.interviewId,
        guideId: state.guideId,
        expectedRevision: state.coverage.revision,
        updates: [...updates.values()],
      }),
    );
  } catch {
    return constraint('participant_workflow_coverage');
  }
}

function plannedConductorTurn(output: InterviewTurnWorkflowOutput): {
  readonly turnType: AiTurnType;
  readonly guideReference: TranscriptGuideReference | null;
  readonly text: string;
} {
  return output.conductor.action === 'close'
    ? { turnType: 'closing', guideReference: null, text: output.conductor.closingText }
    : {
        turnType: output.conductor.question.turnType,
        guideReference: output.conductor.question.guideReference,
        text: output.conductor.question.text,
      };
}

async function storeContradictions(
  transaction: AppTransaction,
  interviewId: string,
  workflowRunId: string,
  output: InterviewTurnWorkflowOutput,
  now: string,
) {
  if (output.consistencyAnalysis.contradictions.length === 0) return success(undefined);
  const agents = await transaction.runs.listAgentsForWorkflow(interviewId, workflowRunId);
  if (!agents.ok) return agents;
  const consistency = agents.value.find((agent) => agent.agentName === 'consistency_analysis');
  if (consistency === undefined) return constraint('consistency_agent_provenance');
  for (const contradiction of output.consistencyAnalysis.contradictions) {
    const write = await transaction.consistency.createContradiction(interviewId, {
      interviewId,
      contradictionId: contradiction.id,
      workflowRunId,
      agentRunId: consistency.agentRunId,
      description: contradiction.description,
      suggestedClarificationQuestion: contradiction.suggestedClarificationQuestion,
      shouldClarify: contradiction.shouldClarify,
      rationale: contradiction.rationale,
      referencedTranscriptTurnIds: contradiction.transcriptTurnIds,
      status: 'detected',
      askedTurnId: null,
      createdAt: now,
      updatedAt: now,
    });
    if (!write.ok) return write;
  }
  return success(undefined);
}

async function completeLifecycle(
  transaction: AppTransaction,
  interviewId: string,
  runId: string,
  now: string,
) {
  const current = await transaction.interviews.lock(interviewId);
  if (!current.ok) return current;
  if (current.value.lifecycle.status === 'completed')
    return success({ events: [] as MonitoringEventDraft[] });
  const transition = transitionInterview(current.value.lifecycle, { type: 'complete', at: now });
  if (!transition.ok) return constraint('complete_interview_lifecycle');
  const next: PersistedInterview = {
    ...current.value,
    lifecycle: transition.state,
    version: current.value.version + 1,
    activeWorkflowRunId: null,
    updatedAt: now,
  };
  const write = await transaction.interviews.compareAndSwap(
    interviewId,
    current.value.version,
    next,
  );
  if (!write.ok) return write;
  const guide = await transaction.guides.getById(current.value.guideId);
  if (!guide.ok) return guide;
  const view = projectInterviewView(next, guide.value);
  if (!view.ok) return constraint('complete_interview_projection');
  return success({
    events: [
      statusChangedEvent(interviewId, runId, 'ending', 'completed', now),
      stateUpdatedEvent(interviewId, runId, current.value.version, view.value, now),
    ],
  });
}

function storedAgentInput(
  version: number,
  guide: InterviewGuideSnapshot,
  transcript: TranscriptAggregate,
): StoredAgentInput {
  return {
    interviewStateVersion: version,
    transcriptTurnIds: transcript.entries.flatMap((entry) =>
      entry.kind === 'turn' ? [entry.turnId] : [],
    ),
    canonicalEntryIds: transcript.entries.map((entry) =>
      entry.kind === 'turn' ? entry.turnId : entry.gapId,
    ),
    guideQuestionIds: buildGuideQuestionCatalog(guide).map((question) => question.questionId),
  };
}

function toMvpTurn(turn: AiTranscriptTurn | ParticipantTranscriptTurn): MvpTranscriptTurn {
  return {
    turnId: turn.turnId,
    interviewId: turn.interviewId,
    sequenceNumber: turn.sequenceNumber,
    speaker: turn.speaker,
    turnType: turn.turnType,
    text: turn.text,
    occurredAt: turn.occurredAt,
    guideReference: turn.guideReference,
    interrupted: turn.speaker === 'ai_interviewer' && turn.delivery.status === 'interrupted',
  };
}

function monotonicTimestamp(candidate: string, aggregate: TranscriptAggregate): string {
  const last = aggregate.entries.at(-1)?.occurredAt;
  return last === undefined ? candidate : maxTimestamp(candidate, last);
}

function maxTimestamp(left: string, right: string): string {
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

function elapsed(startedAt: string | null, endedAt: string): number {
  return startedAt === null ? 0 : Math.max(0, Date.parse(endedAt) - Date.parse(startedAt));
}

function workflowStartedEvent(workflow: StoredWorkflowAttempt): MonitoringEventDraft {
  return {
    eventId: randomUUID(),
    interviewId: workflow.interviewId,
    runId: workflow.workflowRunId,
    occurredAt: workflow.startedAt!,
    category: 'workflow',
    type: 'workflow.started',
    payload: {
      workflowRunId: workflow.workflowRunId,
      status: 'running',
      startedAt: workflow.startedAt!,
      endedAt: null,
      durationMs: null,
      errorCode: null,
    },
  };
}

function workflowCompletedEvent(workflow: StoredWorkflowAttempt): MonitoringEventDraft {
  return {
    eventId: randomUUID(),
    interviewId: workflow.interviewId,
    runId: workflow.workflowRunId,
    occurredAt: workflow.endedAt!,
    category: 'workflow',
    type: 'workflow.completed',
    payload: {
      workflowRunId: workflow.workflowRunId,
      status: 'succeeded',
      startedAt: workflow.startedAt!,
      endedAt: workflow.endedAt!,
      durationMs: workflow.durationMs!,
      errorCode: null,
    },
  };
}

function workflowFailedEvent(workflow: StoredWorkflowAttempt): MonitoringEventDraft {
  return {
    eventId: randomUUID(),
    interviewId: workflow.interviewId,
    runId: workflow.workflowRunId,
    occurredAt: workflow.endedAt!,
    category: 'workflow',
    type: 'workflow.failed',
    payload: {
      workflowRunId: workflow.workflowRunId,
      status: 'failed',
      startedAt: workflow.startedAt!,
      endedAt: workflow.endedAt!,
      durationMs: workflow.durationMs!,
      errorCode: workflow.failure!.code,
    },
  };
}

function statusChangedEvent(
  interviewId: string,
  runId: string,
  previousStatus: Extract<
    MonitoringEvent,
    { type: 'interview.status_changed' }
  >['payload']['previousStatus'],
  nextStatus: Extract<
    MonitoringEvent,
    { type: 'interview.status_changed' }
  >['payload']['nextStatus'],
  occurredAt: string,
): MonitoringEventDraft {
  return {
    eventId: randomUUID(),
    interviewId,
    runId,
    occurredAt,
    category: 'interview',
    type: 'interview.status_changed',
    payload: { previousStatus, nextStatus, changedAt: occurredAt },
  };
}

function sectionCompactedEvent(memory: SectionMemory, runId: string): MonitoringEventDraft {
  return {
    eventId: randomUUID(),
    interviewId: memory.interviewId,
    runId,
    occurredAt: memory.compactedAt,
    category: 'interview',
    type: 'interview.section_compacted',
    payload: {
      guideId: memory.guideId,
      sectionId: memory.sectionId,
      sectionTitle: memory.sectionTitle,
      sourceThroughSequenceNumber: memory.sourceThroughSequenceNumber,
      factCount: memory.facts.length,
      compactedAt: memory.compactedAt,
    },
  };
}

function stateUpdatedEvent(
  interviewId: string,
  runId: string,
  previousVersion: number,
  state: Extract<MonitoringEvent, { type: 'state.updated' }>['payload']['state'],
  occurredAt: string,
): MonitoringEventDraft {
  return {
    eventId: randomUUID(),
    interviewId,
    runId,
    occurredAt,
    category: 'state_update',
    type: 'state.updated',
    payload: { previousVersion, nextVersion: state.version, state },
  };
}

function canonicalTurnEvent(
  turn: AiTranscriptTurn | ParticipantTranscriptTurn,
  runId: string,
  occurredAt: string,
): MonitoringEventDraft {
  return {
    eventId: randomUUID(),
    interviewId: turn.interviewId,
    runId,
    occurredAt,
    category: 'transcript',
    type: 'transcript.turn_persisted',
    payload: turn,
  };
}

function finalSegmentEvent(
  final: FinalizedParticipantSegment,
  runId: string,
): MonitoringEventDraft {
  return {
    eventId: randomUUID(),
    interviewId: final.interviewId,
    runId,
    occurredAt: final.finalizedAt,
    category: 'transcript',
    type: 'transcript.final_received',
    payload: {
      segmentId: final.segmentId,
      interviewId: final.interviewId,
      provider: final.sourceProvider,
      providerEventId: final.providerEventId,
      utteranceId: final.utteranceId,
      speaker: 'participant',
      text: final.text,
      observedAt: final.observedAt,
      status: 'final',
      finalizedAt: final.finalizedAt,
    },
  };
}

function partialEvent(
  partial: TranscriptAggregate['partials'][number],
  runId: string,
): MonitoringEventDraft {
  return {
    eventId: randomUUID(),
    interviewId: partial.interviewId,
    runId,
    occurredAt: partial.observedAt,
    category: 'transcript',
    type: 'transcript.partial_received',
    payload: {
      segmentId: partial.segmentId,
      interviewId: partial.interviewId,
      provider: partial.sourceProvider,
      providerEventId: partial.providerEventId,
      utteranceId: partial.utteranceId,
      speaker: 'participant',
      text: partial.text,
      observedAt: partial.observedAt,
      status: 'partial',
      revision: partial.revision,
    },
  };
}

function gapEvent(
  gap: TranscriptTechnicalGap,
  runId: string,
  occurredAt: string,
): MonitoringEventDraft {
  return {
    eventId: randomUUID(),
    interviewId: gap.interviewId,
    runId,
    occurredAt,
    category: 'transcript',
    type: 'transcript.gap_persisted',
    payload: gap,
  };
}

async function presentationStartedEvents(
  transaction: AppTransaction,
  delivery: StoredAiDelivery,
  occurredAt: string,
) {
  const highWater = await transaction.outbox.highWater(delivery.interviewId);
  if (!highWater.ok) return highWater;
  const liveState = await transaction.outbox.loadLiveState(delivery.interviewId, highWater.value);
  if (!liveState.ok) return liveState;
  if (liveState.value.activeAiTextStream !== null || liveState.value.voiceState === 'speaking') {
    return constraint('realtime_presentation_already_active');
  }

  const chunks = textChunks(delivery.proposedText, 4_000);
  const events: MonitoringEventDraft[] = [aiStreamStartedEvent(delivery, occurredAt)];
  chunks.forEach((chunk, index) => {
    events.push(aiStreamDeltaEvent(delivery, index + 1, chunk, occurredAt));
  });

  let voiceState = liveState.value.voiceState;
  if (voiceState === 'failed') {
    events.push(voiceStateChangedEvent(delivery, 'failed', 'idle', occurredAt));
    voiceState = 'idle';
  }
  if (voiceState === 'listening' || voiceState === 'interrupted') {
    events.push(voiceStateChangedEvent(delivery, voiceState, 'processing', occurredAt));
    voiceState = 'processing';
  }
  if (voiceState !== 'idle' && voiceState !== 'processing') {
    return constraint('realtime_voice_state');
  }
  events.push(voicePlaybackStartedEvent(delivery, voiceState, occurredAt));
  return success({ events, lastDeltaSequenceNumber: chunks.length });
}

function aiStreamStartedEvent(
  delivery: StoredAiDelivery,
  occurredAt: string,
): MonitoringEventDraft {
  return {
    eventId: randomUUID(),
    interviewId: delivery.interviewId,
    runId: delivery.workflowRunId,
    occurredAt,
    category: 'transcript',
    type: 'transcript.ai_text_stream_started',
    payload: {
      utteranceId: delivery.utteranceId,
      turnId: delivery.turnId,
      nextDeltaSequenceNumber: 1,
      startedAt: occurredAt,
    },
  };
}

function aiStreamDeltaEvent(
  delivery: StoredAiDelivery,
  deltaSequenceNumber: number,
  textDelta: string,
  occurredAt: string,
): MonitoringEventDraft {
  return {
    eventId: randomUUID(),
    interviewId: delivery.interviewId,
    runId: delivery.workflowRunId,
    occurredAt,
    category: 'transcript',
    type: 'transcript.ai_text_delta',
    payload: {
      utteranceId: delivery.utteranceId,
      turnId: delivery.turnId,
      deltaSequenceNumber,
      textDelta,
    },
  };
}

function aiStreamCompletedEvent(
  turn: AiTranscriptTurn,
  delivery: StoredAiDelivery,
  lastDeltaSequenceNumber: number,
  occurredAt: string,
): MonitoringEventDraft {
  return {
    eventId: randomUUID(),
    interviewId: turn.interviewId,
    runId: delivery.workflowRunId,
    occurredAt,
    category: 'transcript',
    type: 'transcript.ai_text_stream_completed',
    payload: {
      utteranceId: delivery.utteranceId,
      turnId: turn.turnId,
      lastDeltaSequenceNumber,
      generatedText: delivery.proposedText,
      confirmedSpokenText: turn.text,
      completedAt: occurredAt,
    },
  };
}

function aiStreamInterruptedEvent(
  turn: AiTranscriptTurn,
  delivery: StoredAiDelivery,
  lastDeltaSequenceNumber: number,
  occurredAt: string,
): MonitoringEventDraft {
  return {
    eventId: randomUUID(),
    interviewId: turn.interviewId,
    runId: delivery.workflowRunId,
    occurredAt,
    category: 'transcript',
    type: 'transcript.ai_text_stream_interrupted',
    payload: {
      utteranceId: delivery.utteranceId,
      turnId: turn.turnId,
      lastDeltaSequenceNumber,
      generatedText: delivery.proposedText,
      confirmedSpokenText: turn.text,
      interruptedAt: occurredAt,
    },
  };
}

function voiceCompletedEvent(
  turn: AiTranscriptTurn,
  delivery: StoredAiDelivery,
  occurredAt: string,
): MonitoringEventDraft {
  return {
    eventId: randomUUID(),
    interviewId: turn.interviewId,
    runId: delivery.workflowRunId,
    occurredAt,
    category: 'voice',
    type: 'voice.playback_completed',
    payload: {
      previousState: 'speaking',
      nextState: 'listening',
      utteranceId: delivery.utteranceId,
      turnId: turn.turnId,
      provider: 'openai_realtime',
    },
  };
}

function voiceStateChangedEvent(
  delivery: StoredAiDelivery,
  previousState: VoiceState,
  nextState: VoiceState,
  occurredAt: string,
): MonitoringEventDraft {
  return {
    eventId: randomUUID(),
    interviewId: delivery.interviewId,
    runId: delivery.workflowRunId,
    occurredAt,
    category: 'voice',
    type: 'voice.state_changed',
    payload: {
      previousState,
      nextState,
      utteranceId: null,
      turnId: null,
      provider: 'openai_realtime',
    },
  };
}

function voicePlaybackStartedEvent(
  delivery: StoredAiDelivery,
  previousState: 'idle' | 'processing',
  occurredAt: string,
): MonitoringEventDraft {
  return {
    eventId: randomUUID(),
    interviewId: delivery.interviewId,
    runId: delivery.workflowRunId,
    occurredAt,
    category: 'voice',
    type: 'voice.playback_started',
    payload: {
      previousState,
      nextState: 'speaking',
      utteranceId: delivery.utteranceId,
      turnId: delivery.turnId,
      provider: 'openai_realtime',
    },
  };
}

function textChunks(text: string, maximumCodePoints: number): string[] {
  const codePoints = Array.from(text);
  const chunks: string[] = [];
  for (let index = 0; index < codePoints.length; index += maximumCodePoints) {
    chunks.push(codePoints.slice(index, index + maximumCodePoints).join(''));
  }
  return chunks;
}

function voiceInterruptedEvent(
  turn: AiTranscriptTurn,
  delivery: StoredAiDelivery,
  occurredAt: string,
): MonitoringEventDraft {
  return {
    eventId: randomUUID(),
    interviewId: turn.interviewId,
    runId: delivery.workflowRunId,
    occurredAt,
    category: 'voice',
    type: 'voice.playback_interrupted',
    payload: {
      previousState: 'speaking',
      nextState: 'interrupted',
      utteranceId: delivery.utteranceId,
      turnId: turn.turnId,
      provider: 'openai_realtime',
    },
  };
}
