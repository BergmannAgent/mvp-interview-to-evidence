import type {
  AgentName,
  EvaluationProfile,
  ModelMetadata,
  MvpRealtimePlanningMetadata,
  MonitoringEvent,
  ProfileEvaluationFailure,
  ProfileEvaluationReport,
  RunStatus,
  SectionMemory,
  StructuredAgentOutput,
  SupportedLocale,
  TranscriptFinalizationReport,
  WorkflowStepName,
} from '@orgscience/contracts';
import type {
  AiTurnType,
  AiTranscriptTurn,
  GuideCoverageState,
  InterviewGuideSnapshot,
  InterviewLifecycleState,
  TranscriptGuideReference,
  TranscriptTechnicalGap,
  TranscriptValidationResult,
} from '@orgscience/domain';

export type Result<T, E> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

export function success<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function failure<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

export type RepositoryError =
  | {
      readonly code: 'interview_busy';
      readonly interviewId: string;
      readonly reason: 'active_interview' | 'active_job' | 'active_evaluation';
    }
  | {
      readonly code: 'not_found';
      readonly resource: RepositoryResource;
      readonly id: string;
    }
  | {
      readonly code: 'duplicate_conflict';
      readonly resource: RepositoryResource;
      readonly identity: string;
    }
  | {
      readonly code: 'stale_version';
      readonly interviewId: string;
      readonly expected: number;
      readonly actual: number;
    }
  | {
      readonly code: 'sequence_conflict';
      readonly interviewId: string;
      readonly expected: number;
      readonly actual: number;
    }
  | {
      readonly code: 'lease_lost';
      readonly interviewId: string;
      readonly jobId: string;
      readonly leaseToken: string;
    }
  | {
      readonly code: 'active_job_exists';
      readonly interviewId: string;
      readonly jobId: string;
    }
  | {
      readonly code: 'constraint_violation';
      readonly constraint: string;
    }
  | {
      readonly code: 'serialization_failure';
      readonly retryable: true;
    }
  | {
      readonly code: 'unavailable';
      readonly retryable: true;
    }
  | {
      readonly code: 'internal';
      readonly retryable: false;
    }
  | {
      readonly code: 'transcript_finalized';
      readonly interviewId: string;
    }
  | {
      readonly code: 'pending_ai_delivery';
      readonly interviewId: string;
      readonly deliveryId: string;
      readonly reservedSequenceNumber: number;
    }
  | {
      readonly code: 'unresolved_transcript_partial';
      readonly interviewId: string;
      readonly provider: string;
      readonly segmentId: string;
      readonly utteranceId: string;
    }
  | {
      readonly code: 'corrupt_data';
      readonly resource: RepositoryResource;
      readonly id: string;
      readonly reason: string;
    };

export type RepositoryResource =
  | 'guide'
  | 'interview'
  | 'transcript'
  | 'outbox_event'
  | 'job'
  | 'workflow_run'
  | 'agent_run'
  | 'contradiction'
  | 'finalization'
  | 'evaluation_profile'
  | 'evaluation_run';

export type RepositoryResult<T> = Result<T, RepositoryError>;

export type IdempotentWrite<T> =
  | { readonly outcome: 'inserted'; readonly value: T }
  | { readonly outcome: 'existing'; readonly value: T };

export type IdempotentTransition<T> =
  | { readonly outcome: 'updated'; readonly value: T }
  | { readonly outcome: 'existing'; readonly value: T };

export interface ImportedGuideRecord {
  readonly guideId: string;
  readonly guide: InterviewGuideSnapshot;
  readonly sourceHash: string;
  readonly importedAt: string;
}

export interface PersistedInterview {
  readonly interviewId: string;
  readonly guideId: string;
  readonly language?: SupportedLocale;
  readonly lifecycle: InterviewLifecycleState;
  readonly coverage: GuideCoverageState;
  readonly version: number;
  readonly activeWorkflowRunId: string | null;
  readonly sectionMemories?: readonly SectionMemory[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PersistedInterviewSummary {
  readonly interviewId: string;
  readonly guideId: string;
  readonly language?: SupportedLocale;
  readonly guideTitle: string;
  readonly displayName?: string | null;
  readonly status: InterviewLifecycleState['status'];
  readonly currentMainQuestionId: string | null;
  readonly activeWorkflowRunId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly startedAt: string | null;
}

export interface InterviewSummaryPage {
  readonly interviews: readonly PersistedInterviewSummary[];
  readonly nextCursor: string | null;
}

export type PartialWrite<T> =
  | { readonly outcome: 'inserted'; readonly value: T }
  | { readonly outcome: 'updated'; readonly value: T }
  | { readonly outcome: 'existing'; readonly value: T }
  | { readonly outcome: 'ignored_stale'; readonly value: T }
  | { readonly outcome: 'ignored_finalized'; readonly value: T };

export interface SpeechRecognitionSource {
  readonly provider: string;
  readonly utteranceId: string;
}

export interface AiDeliveryReservation {
  readonly deliveryId: string;
  readonly jobId: string;
  readonly workflowRunId: string;
  readonly turnId: string;
  readonly utteranceId: string;
  readonly turnType: AiTurnType;
  readonly guideReference: TranscriptGuideReference | null;
  readonly proposedText: string;
  readonly createdAt: string;
  readonly planningMetadata?: MvpRealtimePlanningMetadata | null;
}

export interface StoredAiDelivery extends AiDeliveryReservation {
  readonly interviewId: string;
  readonly reservedSequenceNumber: number;
  readonly status: 'pending' | 'complete' | 'interrupted' | 'gapped' | 'cancelled';
  readonly provider: string | null;
  readonly providerDeliveryEventId: string | null;
  readonly confirmedSpokenText: string | null;
  readonly resolvedAt: string | null;
  readonly interruptedAt: string | null;
}

export interface ResolvedAiTurnWrite {
  readonly deliveryId: string;
  readonly provider: string;
  readonly providerDeliveryEventId: string;
  readonly resolvedAt: string;
  readonly turn: AiTranscriptTurn;
}

export interface GappedAiDeliveryWrite {
  readonly deliveryId: string;
  readonly resolvedAt: string;
  readonly status: 'gapped' | 'cancelled';
  readonly gap: TranscriptTechnicalGap;
}

export type MonitoringEventDraft = MonitoringEvent extends infer Event
  ? Event extends MonitoringEvent
    ? Omit<Event, 'sequenceNumber' | 'language'>
    : never
  : never;

export type OutboxEventWrite = IdempotentWrite<MonitoringEvent>;
export type OutboxBatchWrite = readonly OutboxEventWrite[];

export interface OutboxReplayPage {
  readonly events: readonly MonitoringEvent[];
  readonly highWaterSequence: number;
  readonly hasMore: boolean;
}

export type DurableJobKind = 'start_interview' | 'participant_turn' | 'finish_interview';

export type DurableJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface StoredFailure {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly occurredAt: string;
}

export interface EnqueueJobInput {
  readonly jobId: string;
  readonly kind: DurableJobKind;
  readonly idempotencyKey: string;
  readonly sourceTurnId: string | null;
  readonly expectedInterviewVersion: number;
  readonly maximumAttempts: number;
  readonly initialDelayMs: number;
  readonly resultDeliveryId: string | null;
}

export interface DurableJob {
  readonly interviewId: string;
  readonly jobId: string;
  readonly kind: DurableJobKind;
  readonly idempotencyKey: string;
  readonly sourceTurnId: string | null;
  readonly expectedInterviewVersion: number;
  readonly status: DurableJobStatus;
  readonly attemptCount: number;
  readonly maximumAttempts: number;
  readonly initialDelayMs: number;
  readonly availableAt: string;
  readonly leaseOwner: string | null;
  /** Current running lease token or the last fencing token retained for exact retries. */
  readonly leaseToken: string | null;
  readonly leaseExpiresAt: string | null;
  readonly appliedStateVersion: number | null;
  readonly cancellationReason: string | null;
  readonly resultDeliveryId: string | null;
  readonly lastError: StoredFailure | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
}

export interface StoredWorkflowAttempt {
  readonly interviewId: string;
  readonly workflowRunId: string;
  readonly attemptId: string;
  readonly jobId: string;
  readonly expectedInterviewVersion: number;
  readonly attemptNumber: number;
  readonly status: RunStatus;
  readonly retryCount: number;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly durationMs: number | null;
  readonly failure: StoredFailure | null;
  readonly rejectionReason: string | null;
  readonly appliedAt: string | null;
}

export interface StoredAgentInput {
  readonly interviewStateVersion: number;
  readonly transcriptTurnIds: readonly string[];
  readonly canonicalEntryIds: readonly string[];
  readonly guideQuestionIds: readonly string[];
}

export interface StoredStepCheckpoint {
  readonly interviewId: string;
  readonly workflowRunId: string;
  readonly attemptId: string;
  readonly stepRunId: string;
  readonly agentRunId: string | null;
  readonly step: WorkflowStepName;
  readonly attemptNumber: number;
  readonly status: RunStatus;
  readonly retryCount: number;
  readonly referencedTranscriptTurnIds: readonly string[];
  readonly referencedGuideQuestionIds: readonly string[];
  readonly structuredOutput: StructuredAgentOutput | null;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly durationMs: number | null;
  readonly failure: StoredFailure | null;
}

export interface StoredAgentRun {
  readonly interviewId: string;
  readonly workflowRunId: string;
  readonly attemptId: string;
  readonly agentRunId: string;
  readonly agentName: AgentName;
  readonly invocationNumber: number;
  readonly status: RunStatus;
  readonly model: ModelMetadata;
  readonly validatedInput: StoredAgentInput;
  readonly validatedOutput: StructuredAgentOutput | null;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly durationMs: number | null;
  readonly retryCount: number;
  readonly failure: StoredFailure | null;
}

export interface TranscriptFinalizationCandidate {
  readonly interviewId: string;
  readonly finalizationId: string;
  readonly stateVersion: number;
  readonly agentRunId: string;
  readonly finalizedAt: string;
  readonly deterministicValidation: TranscriptValidationResult;
  readonly agentReport: TranscriptFinalizationReport;
}

export interface StoredFinalization extends TranscriptFinalizationCandidate {
  readonly transcriptFingerprint: string;
  readonly entryCount: number;
  readonly technicalGapCount: number;
}

export type StoredEvaluationProfile = EvaluationProfile;

export interface EvaluationRunStart {
  readonly evaluationId: string;
  readonly interviewId: string;
  readonly profileId: string;
  readonly profileFingerprint: string;
  readonly transcriptFingerprint: string;
  readonly language: SupportedLocale;
  readonly promptVersion: string;
  readonly model: ModelMetadata;
  readonly startedAt: string;
}

interface StoredEvaluationRunBase extends Omit<EvaluationRunStart, 'language'> {
  readonly language: SupportedLocale;
  readonly endedAt: string | null;
  readonly durationMs: number | null;
  readonly report: ProfileEvaluationReport | null;
  readonly failure: ProfileEvaluationFailure | null;
}

export interface StoredRunningEvaluationRun extends StoredEvaluationRunBase {
  readonly status: 'running';
  readonly endedAt: null;
  readonly durationMs: null;
  readonly report: null;
  readonly failure: null;
}

export interface StoredCompletedEvaluationRun extends StoredEvaluationRunBase {
  readonly status: 'completed';
  readonly endedAt: string;
  readonly durationMs: number;
  readonly report: ProfileEvaluationReport;
  readonly failure: null;
}

export interface StoredFailedEvaluationRun extends StoredEvaluationRunBase {
  readonly status: 'failed';
  readonly endedAt: string;
  readonly durationMs: number;
  readonly report: null;
  readonly failure: ProfileEvaluationFailure;
}

export type StoredEvaluationRun =
  StoredRunningEvaluationRun | StoredCompletedEvaluationRun | StoredFailedEvaluationRun;

export interface EvaluationRunCompletion {
  readonly attemptStartedAt: string;
  readonly completedAt: string;
  readonly durationMs: number;
  readonly report: ProfileEvaluationReport;
}

export interface EvaluationRunFailure {
  readonly attemptStartedAt: string;
  readonly failedAt: string;
  readonly durationMs: number;
  readonly failure: ProfileEvaluationFailure;
}

export interface EvaluationRunRestart {
  readonly expectedStartedAt: string;
  readonly startedAt: string;
  readonly staleBefore: string;
  readonly profileFingerprint: string;
  readonly transcriptFingerprint: string;
  readonly language: SupportedLocale;
  readonly promptVersion: string;
  readonly model: ModelMetadata;
}

export type ContradictionStatus = 'detected' | 'asked' | 'dismissed' | 'resolved';

export interface StoredContradiction {
  readonly interviewId: string;
  readonly contradictionId: string;
  readonly workflowRunId: string;
  readonly agentRunId: string;
  readonly description: string;
  readonly suggestedClarificationQuestion: string;
  readonly shouldClarify: boolean;
  readonly rationale: string;
  readonly referencedTranscriptTurnIds: readonly string[];
  readonly status: ContradictionStatus;
  readonly askedTurnId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}
