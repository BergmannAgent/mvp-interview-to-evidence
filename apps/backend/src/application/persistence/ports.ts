import type {
  AiTranscriptTurn,
  FinalizedParticipantSegment,
  InterviewGuideSnapshot,
  ParticipantTranscriptTurn,
  PartialTranscriptSegment,
  TranscriptAggregate,
  TranscriptTechnicalGap,
} from '@orgscience/domain';
import type {
  GuideSummary,
  InterviewGuideSetting,
  MonitoringLiveState,
  SupportedLocale,
} from '@orgscience/contracts';

import type {
  DurableJob,
  EnqueueJobInput,
  GappedAiDeliveryWrite,
  EvaluationRunCompletion,
  EvaluationRunFailure,
  EvaluationRunStart,
  EvaluationRunRestart,
  IdempotentWrite,
  IdempotentTransition,
  ImportedGuideRecord,
  InterviewSummaryPage,
  MonitoringEventDraft,
  OutboxBatchWrite,
  OutboxEventWrite,
  OutboxReplayPage,
  PartialWrite,
  PersistedInterview,
  PersistedInterviewSummary,
  RepositoryError,
  RepositoryResult,
  ResolvedAiTurnWrite,
  Result,
  AiDeliveryReservation,
  SpeechRecognitionSource,
  StoredAiDelivery,
  StoredAgentRun,
  StoredContradiction,
  StoredCompletedEvaluationRun,
  StoredEvaluationProfile,
  StoredEvaluationRun,
  StoredFailedEvaluationRun,
  StoredFailure,
  StoredFinalization,
  StoredStepCheckpoint,
  StoredWorkflowAttempt,
  TranscriptFinalizationCandidate,
} from './model.js';

export interface GuideReader {
  getById(guideId: string): Promise<RepositoryResult<InterviewGuideSnapshot>>;
}

export interface GuideWriter {
  import(
    guideId: string,
    record: ImportedGuideRecord,
  ): Promise<RepositoryResult<IdempotentWrite<ImportedGuideRecord>>>;
}

export interface GuideRepository extends GuideReader, GuideWriter {}

export interface InterviewSettingsReader {
  listGuides(language: SupportedLocale): Promise<RepositoryResult<readonly GuideSummary[]>>;
  getSettings(): Promise<RepositoryResult<readonly InterviewGuideSetting[]>>;
}

export interface InterviewSettingsRepository extends InterviewSettingsReader {
  saveSetting(
    setting: InterviewGuideSetting,
    onlyIfAbsent?: boolean,
  ): Promise<RepositoryResult<InterviewGuideSetting>>;
}

export interface InterviewReader {
  load(interviewId: string): Promise<RepositoryResult<PersistedInterview>>;

  listSummaries(query: {
    readonly after: string | null;
    readonly limit: number;
  }): Promise<RepositoryResult<InterviewSummaryPage>>;
}

export interface InterviewWriter {
  rename(
    interviewId: string,
    displayName: string | null,
  ): Promise<RepositoryResult<PersistedInterviewSummary>>;

  delete(interviewId: string): Promise<RepositoryResult<void>>;

  create(
    interviewId: string,
    interview: PersistedInterview,
  ): Promise<RepositoryResult<IdempotentWrite<PersistedInterview>>>;

  lock(interviewId: string): Promise<RepositoryResult<PersistedInterview>>;

  compareAndSwap(
    interviewId: string,
    expectedVersion: number,
    next: PersistedInterview,
  ): Promise<RepositoryResult<PersistedInterview>>;
}

export interface InterviewRepository extends InterviewReader, InterviewWriter {}

export interface TranscriptReader {
  loadAggregate(interviewId: string): Promise<RepositoryResult<TranscriptAggregate>>;

  loadAiDelivery(
    interviewId: string,
    deliveryId: string,
  ): Promise<RepositoryResult<StoredAiDelivery>>;

  listPendingAiDeliveries(
    interviewId: string,
  ): Promise<RepositoryResult<readonly StoredAiDelivery[]>>;

  listQuestionAiDeliveries(
    interviewId: string,
    questionId: string,
  ): Promise<RepositoryResult<readonly StoredAiDelivery[]>>;
}

export interface TranscriptWriter {
  initialize(
    interviewId: string,
    aggregate: TranscriptAggregate,
  ): Promise<RepositoryResult<IdempotentWrite<TranscriptAggregate>>>;

  lockAggregate(interviewId: string): Promise<RepositoryResult<TranscriptAggregate>>;

  upsertPartial(
    interviewId: string,
    source: SpeechRecognitionSource,
    partial: PartialTranscriptSegment,
  ): Promise<RepositoryResult<PartialWrite<PartialTranscriptSegment>>>;

  appendParticipantFinal(
    interviewId: string,
    expectedSequenceNumber: number,
    source: SpeechRecognitionSource,
    final: FinalizedParticipantSegment,
    turn: ParticipantTranscriptTurn,
  ): Promise<RepositoryResult<IdempotentWrite<ParticipantTranscriptTurn>>>;

  reserveAiDelivery(
    interviewId: string,
    expectedSequenceNumber: number,
    reservation: AiDeliveryReservation,
  ): Promise<RepositoryResult<IdempotentWrite<StoredAiDelivery>>>;

  resolveAiDelivery(
    interviewId: string,
    write: ResolvedAiTurnWrite,
  ): Promise<RepositoryResult<IdempotentWrite<AiTranscriptTurn>>>;

  gapAiDelivery(
    interviewId: string,
    write: GappedAiDeliveryWrite,
  ): Promise<RepositoryResult<IdempotentWrite<TranscriptTechnicalGap>>>;

  appendTechnicalGap(
    interviewId: string,
    expectedSequenceNumber: number,
    gap: TranscriptTechnicalGap,
  ): Promise<RepositoryResult<IdempotentWrite<TranscriptTechnicalGap>>>;
}

export interface TranscriptRepository extends TranscriptReader, TranscriptWriter {}

export interface OutboxReader {
  highWater(interviewId: string): Promise<RepositoryResult<number>>;

  replay(
    interviewId: string,
    query: {
      readonly afterSequence: number;
      readonly throughSequence?: number;
      readonly limit: number;
    },
  ): Promise<RepositoryResult<OutboxReplayPage>>;
}

export interface OutboxLiveStateReader {
  loadLiveState(
    interviewId: string,
    throughSequence: number,
  ): Promise<RepositoryResult<MonitoringLiveState>>;
}

export interface OutboxWriter {
  append(
    interviewId: string,
    event: MonitoringEventDraft,
  ): Promise<RepositoryResult<OutboxEventWrite>>;

  appendMany(
    interviewId: string,
    events: readonly MonitoringEventDraft[],
  ): Promise<RepositoryResult<OutboxBatchWrite>>;
}

export interface OutboxRepository extends OutboxReader, OutboxLiveStateReader, OutboxWriter {}

export interface JobReader {
  load(interviewId: string, jobId: string): Promise<RepositoryResult<DurableJob>>;
}

export interface JobWriter {
  enqueue(
    interviewId: string,
    job: EnqueueJobInput,
  ): Promise<RepositoryResult<IdempotentWrite<DurableJob>>>;

  /** Global by necessity: the worker does not know the interview before claiming work. */
  claimNext(input: {
    readonly workerId: string;
    readonly leaseDurationMs: number;
  }): Promise<RepositoryResult<DurableJob | null>>;

  claim(
    interviewId: string,
    jobId: string,
    input: {
      readonly workerId: string;
      readonly leaseDurationMs: number;
    },
  ): Promise<RepositoryResult<DurableJob | null>>;

  renewLease(
    interviewId: string,
    jobId: string,
    leaseToken: string,
    leaseDurationMs: number,
  ): Promise<RepositoryResult<DurableJob>>;

  requireOwnedLease(
    interviewId: string,
    jobId: string,
    leaseToken: string,
  ): Promise<RepositoryResult<DurableJob>>;

  requeue(
    interviewId: string,
    jobId: string,
    leaseToken: string,
    failure: StoredFailure,
    retryDelayMs: number,
  ): Promise<RepositoryResult<DurableJob>>;

  complete(
    interviewId: string,
    jobId: string,
    leaseToken: string,
    appliedStateVersion: number,
  ): Promise<RepositoryResult<IdempotentWrite<DurableJob>>>;

  fail(
    interviewId: string,
    jobId: string,
    leaseToken: string,
    failure: StoredFailure,
  ): Promise<RepositoryResult<DurableJob>>;

  cancel(
    interviewId: string,
    jobId: string,
    reason: string,
  ): Promise<RepositoryResult<IdempotentWrite<DurableJob>>>;

  /** Global maintenance operation; returned jobs remain interview identified. */
  reclaimExpired(): Promise<RepositoryResult<number>>;
}

export interface JobRepository extends JobReader, JobWriter {}

export interface RunReader {
  loadWorkflow(
    interviewId: string,
    workflowRunId: string,
  ): Promise<RepositoryResult<StoredWorkflowAttempt>>;

  listForInterview(
    interviewId: string,
  ): Promise<RepositoryResult<readonly StoredWorkflowAttempt[]>>;

  loadStep(interviewId: string, stepRunId: string): Promise<RepositoryResult<StoredStepCheckpoint>>;

  listStepsForWorkflow(
    interviewId: string,
    workflowRunId: string,
  ): Promise<RepositoryResult<readonly StoredStepCheckpoint[]>>;

  listStepsForInterview(
    interviewId: string,
  ): Promise<RepositoryResult<readonly StoredStepCheckpoint[]>>;

  loadAgent(interviewId: string, agentRunId: string): Promise<RepositoryResult<StoredAgentRun>>;

  listAgentsForWorkflow(
    interviewId: string,
    workflowRunId: string,
  ): Promise<RepositoryResult<readonly StoredAgentRun[]>>;

  listAgentsForInterview(interviewId: string): Promise<RepositoryResult<readonly StoredAgentRun[]>>;
}

export interface RunWriter {
  startWorkflow(
    interviewId: string,
    run: StoredWorkflowAttempt,
  ): Promise<RepositoryResult<IdempotentWrite<StoredWorkflowAttempt>>>;

  finishWorkflow(
    interviewId: string,
    workflowRunId: string,
    expectedStatus: 'running',
    next: StoredWorkflowAttempt,
  ): Promise<RepositoryResult<StoredWorkflowAttempt>>;

  saveStepCheckpoint(
    interviewId: string,
    attemptId: string,
    checkpoint: StoredStepCheckpoint,
  ): Promise<RepositoryResult<IdempotentWrite<StoredStepCheckpoint>>>;

  finishStep(
    interviewId: string,
    stepRunId: string,
    expectedStatus: 'running',
    next: StoredStepCheckpoint,
  ): Promise<RepositoryResult<StoredStepCheckpoint>>;

  startAgent(
    interviewId: string,
    run: StoredAgentRun,
  ): Promise<RepositoryResult<IdempotentWrite<StoredAgentRun>>>;

  finishAgent(
    interviewId: string,
    agentRunId: string,
    expectedStatus: 'running',
    next: StoredAgentRun,
  ): Promise<RepositoryResult<StoredAgentRun>>;
}

export interface RunRepository extends RunReader, RunWriter {}

export interface FinalizationReader {
  loadLatest(interviewId: string): Promise<RepositoryResult<StoredFinalization | null>>;
}

export interface FinalizationWriter {
  store(
    interviewId: string,
    finalization: TranscriptFinalizationCandidate,
  ): Promise<RepositoryResult<IdempotentWrite<StoredFinalization>>>;
}

export interface FinalizationRepository extends FinalizationReader, FinalizationWriter {}

export interface ConsistencyReader {
  loadContradiction(
    interviewId: string,
    contradictionId: string,
  ): Promise<RepositoryResult<StoredContradiction>>;

  listContradictions(
    interviewId: string,
  ): Promise<RepositoryResult<readonly StoredContradiction[]>>;
}

export interface ConsistencyWriter {
  createContradiction(
    interviewId: string,
    contradiction: StoredContradiction,
  ): Promise<RepositoryResult<IdempotentWrite<StoredContradiction>>>;

  transitionContradiction(
    interviewId: string,
    contradictionId: string,
    expectedStatus: StoredContradiction['status'],
    next: StoredContradiction,
  ): Promise<RepositoryResult<StoredContradiction>>;
}

export interface ConsistencyRepository extends ConsistencyReader, ConsistencyWriter {}

export interface EvaluationReader {
  loadRun(
    interviewId: string,
    evaluationId: string,
  ): Promise<RepositoryResult<StoredEvaluationRun>>;

  findRunByProfile(input: {
    readonly interviewId: string;
    readonly profileId: string;
  }): Promise<RepositoryResult<StoredEvaluationRun | null>>;
}

export interface EvaluationWriter {
  startRun(
    interviewId: string,
    run: EvaluationRunStart,
  ): Promise<RepositoryResult<IdempotentWrite<StoredEvaluationRun>>>;

  completeRun(
    interviewId: string,
    evaluationId: string,
    completion: EvaluationRunCompletion,
  ): Promise<RepositoryResult<IdempotentTransition<StoredCompletedEvaluationRun>>>;

  failRun(
    interviewId: string,
    evaluationId: string,
    failed: EvaluationRunFailure,
  ): Promise<RepositoryResult<IdempotentTransition<StoredFailedEvaluationRun>>>;

  restartRun(
    interviewId: string,
    evaluationId: string,
    restart: EvaluationRunRestart,
  ): Promise<RepositoryResult<IdempotentTransition<StoredEvaluationRun>>>;
}

export interface EvaluationRepository extends EvaluationReader, EvaluationWriter {}

export interface EvaluationProfileReader {
  list(): Promise<RepositoryResult<readonly StoredEvaluationProfile[]>>;

  load(profileId: string): Promise<RepositoryResult<StoredEvaluationProfile>>;

  loadDefault(): Promise<RepositoryResult<StoredEvaluationProfile>>;
}

export interface EvaluationProfileWriter {
  create(profile: StoredEvaluationProfile): Promise<RepositoryResult<StoredEvaluationProfile>>;

  duplicate(
    sourceProfileId: string,
    profile: StoredEvaluationProfile,
  ): Promise<RepositoryResult<StoredEvaluationProfile>>;

  seedDefault(
    profile: StoredEvaluationProfile,
  ): Promise<RepositoryResult<IdempotentWrite<StoredEvaluationProfile>>>;

  update(
    profileId: string,
    expectedUpdatedAt: string,
    profile: StoredEvaluationProfile,
  ): Promise<RepositoryResult<StoredEvaluationProfile>>;

  delete(
    profileId: string,
    expectedUpdatedAt: string,
  ): Promise<RepositoryResult<StoredEvaluationProfile>>;
}

export interface EvaluationProfileRepository
  extends EvaluationProfileReader, EvaluationProfileWriter {}

export interface AppReadContext {
  readonly interviewSettings: InterviewSettingsReader;
  readonly guides: GuideReader;
  readonly interviews: InterviewReader;
  readonly transcripts: TranscriptReader;
  readonly outbox: OutboxReader & OutboxLiveStateReader;
  readonly jobs: JobReader;
  readonly runs: RunReader;
  readonly finalizations: FinalizationReader;
  readonly consistency: ConsistencyReader;
  readonly evaluations: EvaluationReader;
  readonly evaluationProfiles: EvaluationProfileReader;
}

export interface AppTransaction {
  readonly interviewSettings: InterviewSettingsRepository;
  readonly guides: GuideRepository;
  readonly interviews: InterviewRepository;
  readonly transcripts: TranscriptRepository;
  readonly outbox: OutboxRepository;
  readonly jobs: JobRepository;
  readonly runs: RunRepository;
  readonly finalizations: FinalizationRepository;
  readonly consistency: ConsistencyRepository;
  readonly evaluations: EvaluationRepository;
  readonly evaluationProfiles: EvaluationProfileRepository;
}

export interface AppUnitOfWork {
  read<T>(
    operation: (context: AppReadContext) => Promise<RepositoryResult<T>>,
  ): Promise<RepositoryResult<T>>;

  /**
   * Commits only when the callback resolves to `{ ok: true }`. An `{ ok: false }`
   * result or rejection rolls the transaction back. Transaction-scoped repositories
   * must not escape the callback.
   */
  transaction<T, E = never>(
    operation: (transaction: AppTransaction) => Promise<Result<T, E | RepositoryError>>,
  ): Promise<Result<T, E | RepositoryError>>;
}
