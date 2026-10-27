import {
  DEFAULT_LOCALE,
  EVALUATION_RUN_STALE_AFTER_MS,
  evaluationExportFormatSchema,
  evaluationProfileDocumentSchema,
  evaluationProfileCodingDocumentOf,
  evaluationProfileFingerprintDocumentOf,
  evaluationProfilePortableOf,
  EVALUATION_PROFILE_DOCUMENT_SCHEMA_VERSION,
  evaluationSnapshotSchema,
  type EvaluationExportFormat,
  type EvaluationProfile,
  type EvaluationProfileDocument,
  type EvaluationReport,
  type EvaluationSnapshot,
  type MvpInterviewSession,
  type ProfileEvaluationTranslationMetadata,
  type SupportedLocale,
} from '@orgscience/contracts';
import type { InterviewGuideSnapshot, TranscriptAggregate } from '@orgscience/domain';

import { projectCanonicalSession } from '../interviews/index.js';
import {
  success,
  type AppUnitOfWork,
  type PersistedInterview,
  type RepositoryError,
  type StoredEvaluationRun,
  type StoredFinalization,
} from '../persistence/index.js';
import { deterministicId, readClock, sha256, type Clock, type Sha256 } from '../runtime.js';
import {
  PROFILE_EVALUATION_CODING_PROMPT_VERSION,
  type EvaluationCoder,
  type EvaluationCodingResult,
} from './evaluation-coder.js';
import {
  exportEvaluationReport,
  type EvaluationReportExportArtifact,
} from './evaluation-report-export.js';
import { validateEvaluationTranscript } from './evaluation-guardrails.js';
import {
  buildProfileEvaluationReport,
  ProfileEvaluationReportAuditError,
} from './profile-evaluation-report.js';

export type EvaluationServiceErrorCode =
  'not_found' | 'invalid_state' | 'conflict' | 'unavailable' | 'internal';

export class EvaluationServiceError extends Error {
  constructor(
    readonly code: EvaluationServiceErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'EvaluationServiceError';
  }
}

export type EvaluationExportArtifact = EvaluationReportExportArtifact;

interface EvaluationSource {
  readonly guide: InterviewGuideSnapshot;
  readonly interview: PersistedInterview;
  readonly transcript: TranscriptAggregate;
  readonly finalization: StoredFinalization | null;
  readonly session: MvpInterviewSession;
  readonly transcriptFingerprint: string;
  readonly ignoredPartialTranscript: boolean;
}

interface EvaluationSourceState {
  readonly language: SupportedLocale;
  readonly source: EvaluationSource | null;
}

interface PreparedEvaluation {
  readonly profile: EvaluationProfile;
  readonly profileDocument: EvaluationProfileDocument;
  readonly profileFingerprint: string;
  readonly evaluationId: string;
  readonly language: SupportedLocale;
  readonly profileTranslation: ProfileEvaluationTranslationMetadata | null;
}

export interface EvaluationProfileLocalizationResult {
  readonly profile: EvaluationProfile;
  readonly translation: ProfileEvaluationTranslationMetadata | null;
}

export type EvaluationProfileLocalizer = (
  profile: EvaluationProfile,
  language: SupportedLocale,
) => EvaluationProfileLocalizationResult;

export class EvaluationService {
  readonly #activeRuns = new Map<
    string,
    {
      readonly profileFingerprint: string;
      readonly transcriptFingerprint: string;
      readonly promise: Promise<EvaluationSnapshot>;
    }
  >();

  constructor(
    private readonly unitOfWork: AppUnitOfWork,
    private readonly clock: Clock,
    private readonly hasher: Sha256,
    private readonly coder: EvaluationCoder,
    private readonly localizeProfile: EvaluationProfileLocalizer = identityProfileLocalizer,
  ) {}

  async get(interviewId: string, profileId?: string): Promise<EvaluationSnapshot> {
    const persistedProfile = await this.#loadProfile(profileId);
    const sourceState = await this.#loadSource(interviewId);
    const { language, source } = sourceState;
    const localized = this.localizeProfile(persistedProfile, language);
    const prepared = prepareEvaluation(interviewId, localized, language, this.hasher);
    const current = await this.#findRun(interviewId, persistedProfile.profileId);
    if (
      current === null ||
      source === null ||
      current.profileFingerprint !== prepared.profileFingerprint ||
      current.transcriptFingerprint !== source.transcriptFingerprint
    ) {
      return notStartedSnapshot(interviewId, prepared);
    }
    return toSnapshot(current);
  }

  async run(interviewId: string, profileId?: string): Promise<EvaluationSnapshot> {
    const persistedProfile = await this.#loadProfile(profileId);
    const source = (await this.#loadSource(interviewId)).source;
    if (source === null) {
      throw new EvaluationServiceError(
        'invalid_state',
        'An interview with confirmed interviewer and participant turns is required before evaluation.',
      );
    }
    const language = sessionLanguage(source.session);
    const localized = this.localizeProfile(persistedProfile, language);
    const prepared = prepareEvaluation(interviewId, localized, language, this.hasher);
    return this.#runExclusive(interviewId, source, prepared, () => this.#run(source, prepared));
  }

  retry(interviewId: string, profileId?: string): Promise<EvaluationSnapshot> {
    return this.run(interviewId, profileId);
  }

  async export(
    interviewId: string,
    formatCandidate: unknown,
    profileId?: string,
  ): Promise<EvaluationExportArtifact> {
    const format = evaluationExportFormatSchema.safeParse(formatCandidate);
    if (!format.success) {
      throw new EvaluationServiceError('invalid_state', 'Evaluation export format is invalid.');
    }
    const snapshot = await this.get(interviewId, profileId);
    if (snapshot.status !== 'completed') {
      throw new EvaluationServiceError(
        'invalid_state',
        'A completed evaluation is required before export.',
        snapshot.status === 'running' ||
          (snapshot.status === 'failed' && snapshot.failure.retryable),
      );
    }
    return exportEvaluationReport(snapshot.report, format.data);
  }

  #runExclusive(
    interviewId: string,
    source: EvaluationSource,
    prepared: PreparedEvaluation,
    operation: () => Promise<EvaluationSnapshot>,
  ): Promise<EvaluationSnapshot> {
    const key = `${interviewId}\u0000${prepared.profile.profileId}`;
    const running = this.#activeRuns.get(key);
    if (running !== undefined) {
      if (
        running.profileFingerprint !== prepared.profileFingerprint ||
        running.transcriptFingerprint !== source.transcriptFingerprint
      ) {
        throw new EvaluationServiceError(
          'conflict',
          'The selected profile or transcript changed while an evaluation is still running.',
          true,
        );
      }
      return running.promise;
    }

    const started = operation().finally(() => {
      if (this.#activeRuns.get(key)?.promise === started) this.#activeRuns.delete(key);
    });
    this.#activeRuns.set(key, {
      profileFingerprint: prepared.profileFingerprint,
      transcriptFingerprint: source.transcriptFingerprint,
      promise: started,
    });
    return started;
  }

  async #run(source: EvaluationSource, prepared: PreparedEvaluation): Promise<EvaluationSnapshot> {
    const interviewId = source.interview.interviewId;
    const profile = prepared.profile;
    const projectedSession = source.session;
    const language = sessionLanguage(projectedSession);
    const transcriptValidation = validateEvaluationTranscript(projectedSession);
    if (!transcriptValidation.ok) {
      throw new EvaluationServiceError(
        'invalid_state',
        `The confirmed transcript snapshot cannot be evaluated (${transcriptValidation.issues[0]?.code ?? 'invalid'}).`,
      );
    }

    const current = await this.#findRun(interviewId, profile.profileId);
    if (current === null) {
      const startedAt = nowOrThrow(this.clock);
      const started = await this.unitOfWork.transaction(async ({ evaluations, interviews }) => {
        const locked = await interviews.lock(interviewId);
        if (!locked.ok) return locked;
        return evaluations.startRun(interviewId, {
          evaluationId: prepared.evaluationId,
          interviewId,
          profileId: profile.profileId,
          profileFingerprint: prepared.profileFingerprint,
          transcriptFingerprint: source.transcriptFingerprint,
          language,
          promptVersion: PROFILE_EVALUATION_CODING_PROMPT_VERSION,
          model: this.coder.model,
          startedAt,
        });
      });
      if (!started.ok) throw repositoryError(started.error);
      if (started.value.outcome !== 'inserted' || started.value.value.status !== 'running') {
        return toSnapshot(started.value.value);
      }
      return this.#executeCoder(source, prepared, transcriptValidation.value, started.value.value);
    }

    const now = nowOrThrow(this.clock);
    const staleBefore = new Date(Date.parse(now) - EVALUATION_RUN_STALE_AFTER_MS).toISOString();
    const isCurrentSource =
      current.profileFingerprint === prepared.profileFingerprint &&
      current.transcriptFingerprint === source.transcriptFingerprint;
    if (
      current.status === 'running' &&
      isCurrentSource &&
      Date.parse(current.startedAt) > Date.parse(staleBefore)
    ) {
      return toSnapshot(current);
    }
    if (current.status === 'running' && Date.parse(current.startedAt) > Date.parse(staleBefore)) {
      throw new EvaluationServiceError(
        'conflict',
        'The selected profile or transcript changed while an evaluation is still running.',
        true,
      );
    }

    const restartedAt = timestampAfter(current.startedAt, now);
    const restarted = await this.unitOfWork.transaction(async ({ evaluations, interviews }) => {
      const locked = await interviews.lock(interviewId);
      if (!locked.ok) return locked;
      return evaluations.restartRun(interviewId, prepared.evaluationId, {
        expectedStartedAt: current.startedAt,
        startedAt: restartedAt,
        staleBefore,
        profileFingerprint: prepared.profileFingerprint,
        transcriptFingerprint: source.transcriptFingerprint,
        language,
        promptVersion: PROFILE_EVALUATION_CODING_PROMPT_VERSION,
        model: this.coder.model,
      });
    });
    if (!restarted.ok) throw repositoryError(restarted.error);
    if (restarted.value.outcome !== 'updated' || restarted.value.value.status !== 'running') {
      return toSnapshot(restarted.value.value);
    }
    return this.#executeCoder(source, prepared, transcriptValidation.value, restarted.value.value);
  }

  async #executeCoder(
    source: EvaluationSource,
    prepared: PreparedEvaluation,
    session: Parameters<EvaluationCoder['code']>[0]['session'],
    running: Extract<StoredEvaluationRun, { readonly status: 'running' }>,
  ): Promise<EvaluationSnapshot> {
    const interviewId = source.interview.interviewId;
    const coding = await safelyCode(this.coder, prepared.evaluationId, {
      profile: evaluationProfileCodingDocumentOf(prepared.profile),
      session,
    });
    const terminalAt = terminalTimestamp(running.startedAt, this.clock);
    const durationMs = Date.parse(terminalAt) - Date.parse(running.startedAt);

    if (!coding.ok) {
      const failed = await this.unitOfWork.transaction(({ evaluations }) =>
        evaluations.failRun(interviewId, prepared.evaluationId, {
          attemptStartedAt: running.startedAt,
          failedAt: terminalAt,
          durationMs,
          failure: coding.error,
        }),
      );
      if (!failed.ok) throw repositoryError(failed.error);
      return toSnapshot(failed.value.value);
    }

    let report: EvaluationReport;
    try {
      report = buildProfileEvaluationReport(prepared.profile, session, coding.output, {
        evaluationId: prepared.evaluationId,
        interviewId,
        profileFingerprint: prepared.profileFingerprint,
        transcriptFingerprint: source.transcriptFingerprint,
        ignoredPartialTranscript: source.ignoredPartialTranscript,
        language: sessionLanguage(session),
        profileTranslation: prepared.profileTranslation,
        promptVersion: PROFILE_EVALUATION_CODING_PROMPT_VERSION,
        model: this.coder.model,
        evaluatedAt: terminalAt,
      });
    } catch (error: unknown) {
      const failed = await this.unitOfWork.transaction(({ evaluations }) =>
        evaluations.failRun(interviewId, prepared.evaluationId, {
          attemptStartedAt: running.startedAt,
          failedAt: terminalAt,
          durationMs,
          failure: {
            code: 'guardrail_rejected',
            message:
              error instanceof ProfileEvaluationReportAuditError
                ? error.message
                : 'The profile evaluation report failed deterministic validation.',
            retryable: true,
          },
        }),
      );
      if (!failed.ok) throw repositoryError(failed.error);
      return toSnapshot(failed.value.value);
    }

    const completed = await this.unitOfWork.transaction(({ evaluations }) =>
      evaluations.completeRun(interviewId, prepared.evaluationId, {
        attemptStartedAt: running.startedAt,
        completedAt: terminalAt,
        durationMs,
        report,
      }),
    );
    if (!completed.ok) throw repositoryError(completed.error);
    return toSnapshot(completed.value.value);
  }

  async #loadProfile(profileId?: string): Promise<EvaluationProfile> {
    const loaded = await this.unitOfWork.read(({ evaluationProfiles }) =>
      profileId === undefined
        ? evaluationProfiles.loadDefault()
        : evaluationProfiles.load(profileId),
    );
    if (!loaded.ok) {
      if (loaded.error.code === 'not_found') {
        throw new EvaluationServiceError('not_found', 'The evaluation profile was not found.');
      }
      throw repositoryError(loaded.error);
    }
    return loaded.value;
  }

  async #findRun(interviewId: string, profileId: string): Promise<StoredEvaluationRun | null> {
    const loaded = await this.unitOfWork.read(({ evaluations }) =>
      evaluations.findRunByProfile({ interviewId, profileId }),
    );
    if (!loaded.ok) throw repositoryError(loaded.error);
    return loaded.value;
  }

  async #loadSource(interviewId: string): Promise<EvaluationSourceState> {
    const loaded = await this.unitOfWork.read(async (context) => {
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
    if (!loaded.ok) throw repositoryError(loaded.error);
    const language = loaded.value.interview.language ?? DEFAULT_LOCALE;
    const projected = projectSessionOrThrow(loaded.value);
    if (
      projected.status === 'ready' ||
      projected.startedAt === null ||
      !projected.transcript.some((turn) => turn.speaker === 'participant') ||
      !projected.transcript.some((turn) => turn.speaker === 'ai_interviewer')
    ) {
      return { language, source: null };
    }
    // Partials remain stored for the live UI; only this detached evaluation snapshot excludes them.
    const session: MvpInterviewSession = { ...projected, partialTranscript: null };
    const persistedFingerprint =
      projected.status === 'completed'
        ? loaded.value.finalization?.transcriptFingerprint
        : undefined;
    const transcriptFingerprint =
      persistedFingerprint ??
      digestOrThrow(
        canonicalJson({
          interviewId: session.interviewId,
          guideId: session.guideId,
          language,
          status: session.status,
          startedAt: session.startedAt,
          endedAt: session.endedAt,
          transcript: session.transcript,
          technicalGaps: session.technicalGaps,
        }),
        this.hasher,
      );
    return {
      language,
      source: {
        ...loaded.value,
        session,
        transcriptFingerprint,
        ignoredPartialTranscript: projected.partialTranscript !== null,
      },
    };
  }
}

async function safelyCode(
  coder: EvaluationCoder,
  runId: string,
  input: Parameters<EvaluationCoder['code']>[0],
): Promise<EvaluationCodingResult> {
  try {
    return await coder.code(input, {
      runId,
      signal: new AbortController().signal,
    });
  } catch {
    return {
      ok: false,
      error: {
        code: 'provider_error',
        message: 'Evaluation coder failed unexpectedly.',
        retryable: true,
      },
    };
  }
}

export function exportReport(
  _interviewId: string,
  report: EvaluationReport,
  format: EvaluationExportFormat,
): EvaluationExportArtifact {
  return exportEvaluationReport(report, format);
}

function prepareEvaluation(
  interviewId: string,
  localized: EvaluationProfileLocalizationResult,
  language: SupportedLocale,
  hasher: Sha256,
): PreparedEvaluation {
  const { profile } = localized;
  const profileDocument = evaluationProfileDocumentSchema.parse({
    schemaVersion: EVALUATION_PROFILE_DOCUMENT_SCHEMA_VERSION,
    profile: evaluationProfilePortableOf(profile),
  });
  return {
    profile,
    profileDocument,
    profileFingerprint: digestOrThrow(
      canonicalJson(evaluationProfileFingerprintDocumentOf(profile)),
      hasher,
    ),
    evaluationId: idOrThrow('evaluation', `${interviewId}:${profile.profileId}`, hasher),
    language,
    profileTranslation: localized.translation,
  };
}

function identityProfileLocalizer(profile: EvaluationProfile): EvaluationProfileLocalizationResult {
  return { profile, translation: null };
}

function sessionLanguage(session: { readonly language?: SupportedLocale }): SupportedLocale {
  return session.language ?? DEFAULT_LOCALE;
}

function projectSessionOrThrow(
  source: Pick<EvaluationSource, 'guide' | 'interview' | 'transcript' | 'finalization'>,
) {
  const projected = projectCanonicalSession(source);
  if (!projected.ok) {
    throw new EvaluationServiceError('internal', 'Canonical evaluation session is invalid.');
  }
  return projected.value;
}

function notStartedSnapshot(interviewId: string, prepared: PreparedEvaluation): EvaluationSnapshot {
  return evaluationSnapshotSchema.parse({
    status: 'not_started',
    interviewId,
    profileId: prepared.profile.profileId,
    profileFingerprint: prepared.profileFingerprint,
    language: prepared.language,
    report: null,
    failure: null,
  });
}

function toSnapshot(run: StoredEvaluationRun): EvaluationSnapshot {
  const identity = {
    evaluationId: run.evaluationId,
    interviewId: run.interviewId,
    profileId: run.profileId,
    profileFingerprint: run.profileFingerprint,
    language: run.language ?? DEFAULT_LOCALE,
  };
  switch (run.status) {
    case 'running':
      return evaluationSnapshotSchema.parse({
        status: 'running',
        ...identity,
        startedAt: run.startedAt,
        report: null,
        failure: null,
      });
    case 'completed':
      return evaluationSnapshotSchema.parse({
        status: 'completed',
        ...identity,
        startedAt: run.startedAt,
        completedAt: run.endedAt,
        report: run.report,
        failure: null,
      });
    case 'failed':
      return evaluationSnapshotSchema.parse({
        status: 'failed',
        ...identity,
        startedAt: run.startedAt,
        failedAt: run.endedAt,
        report: null,
        failure: run.failure,
      });
  }
}

function nowOrThrow(clock: Clock): string {
  const now = readClock(clock);
  if (!now.ok) {
    throw new EvaluationServiceError('internal', 'Evaluation clock is invalid.');
  }
  return now.value;
}

function terminalTimestamp(startedAt: string, clock: Clock): string {
  const candidate = nowOrThrow(clock);
  return Date.parse(candidate) >= Date.parse(startedAt) ? candidate : startedAt;
}

function timestampAfter(previous: string, candidate: string): string {
  return Date.parse(candidate) > Date.parse(previous)
    ? candidate
    : new Date(Date.parse(previous) + 1).toISOString();
}

function idOrThrow(prefix: string, identity: string, hasher: Sha256): string {
  const id = deterministicId(prefix, identity, hasher);
  if (!id.ok) throw new EvaluationServiceError('internal', 'Evaluation ID creation failed.');
  return id.value;
}

function digestOrThrow(value: string, hasher: Sha256): string {
  const digest = sha256(hasher, value);
  if (!digest.ok) {
    throw new EvaluationServiceError('internal', 'Evaluation fingerprint creation failed.');
  }
  return digest.value;
}

function repositoryError(error: RepositoryError): EvaluationServiceError {
  switch (error.code) {
    case 'not_found':
      return new EvaluationServiceError('not_found', 'The interview was not found.');
    case 'duplicate_conflict':
    case 'stale_version':
    case 'sequence_conflict':
    case 'active_job_exists':
    case 'lease_lost':
    case 'transcript_finalized':
    case 'pending_ai_delivery':
    case 'unresolved_transcript_partial':
    case 'interview_busy':
      return new EvaluationServiceError('conflict', 'Evaluation persistence conflicted.', true);
    case 'serialization_failure':
    case 'unavailable':
      return new EvaluationServiceError(
        'unavailable',
        'Evaluation persistence is temporarily unavailable.',
        true,
      );
    case 'constraint_violation':
    case 'corrupt_data':
    case 'internal':
      return new EvaluationServiceError('internal', 'Evaluation persistence failed.');
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.entries(value)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(',')}}`;
}
