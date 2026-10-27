import {
  mvpInterviewSessionSchema,
  type MvpInterviewSession,
  type MvpTranscriptGap,
  type MvpTranscriptTurn,
} from '@orgscience/contracts';
import {
  buildGuideQuestionCatalog,
  selectNextOpenMainQuestion,
  type CanonicalTranscriptEntry,
  type GuideQuestionCatalogEntry,
  type InterviewGuideSnapshot,
  type InterviewLifecycleState,
  type PartialTranscriptSegment,
  type TranscriptAggregate,
  type TranscriptTurn,
} from '@orgscience/domain';

import type { ApplicationResult } from '../errors.js';
import {
  failure,
  success,
  type PersistedInterview,
  type StoredFinalization,
} from '../persistence/index.js';
import { projectInterviewView } from './interview-view.js';

export interface CanonicalSessionProjectionInput {
  readonly guide: InterviewGuideSnapshot;
  readonly interview: PersistedInterview;
  readonly transcript: TranscriptAggregate;
  readonly finalization: StoredFinalization | null;
}

export function projectCanonicalSession(
  input: CanonicalSessionProjectionInput,
): ApplicationResult<MvpInterviewSession> {
  const interviewView = projectInterviewView(input.interview, input.guide);
  if (!interviewView.ok) return interviewView;
  if (!hasConsistentScope(input)) {
    return invalidProjection(
      input.interview.interviewId,
      'Canonical session scopes are inconsistent',
    );
  }

  const catalog = buildGuideQuestionCatalog(input.guide);
  const lifecycle = input.interview.lifecycle;
  const current = isQuestionSelectionClosed(lifecycle)
    ? null
    : selectCurrentQuestion(input, catalog);
  const orderedEntries = [...input.transcript.entries].sort(
    (left, right) => left.sequenceNumber - right.sequenceNumber,
  );
  const transcript = orderedEntries
    .filter((entry): entry is TranscriptTurn => entry.kind === 'turn')
    .map(toMvpTurn);
  const technicalGaps = orderedEntries
    .filter(
      (entry): entry is Extract<CanonicalTranscriptEntry, { kind: 'technical_gap' }> =>
        entry.kind === 'technical_gap',
    )
    .map(toMvpGap);
  const finalizedAt = input.finalization?.finalizedAt ?? null;
  const candidate = {
    interviewId: input.interview.interviewId,
    guideId: input.guide.id,
    language: input.interview.language ?? 'de',
    guideTitle: input.guide.title,
    status: toMvpStatus(lifecycle),
    stateVersion: input.interview.version,
    currentQuestionIndex:
      current === null ? catalog.length : catalog.findIndex((entry) => entry === current),
    totalQuestions: catalog.length,
    currentQuestion:
      current === null
        ? null
        : {
            questionId: current.questionId,
            sectionId: current.sectionId,
            sectionTitle: current.sectionTitle,
            kind: current.kind,
            text: current.text,
            reference: current.reference,
          },
    startedAt: lifecycleStartedAt(lifecycle),
    endedAt: lifecycleEndedAt(lifecycle),
    updatedAt: latestActivityTimestamp(input),
    partialTranscript: latestUnresolvedPartialText(input.transcript, finalizedAt !== null),
    transcript,
    technicalGaps,
    finalizedAt,
  };
  const parsed = mvpInterviewSessionSchema.safeParse(candidate);
  return parsed.success
    ? success(parsed.data)
    : invalidProjection(
        input.interview.interviewId,
        'Canonical state does not satisfy the MVP session contract',
      );
}

function hasConsistentScope(input: CanonicalSessionProjectionInput): boolean {
  const { interview, guide, transcript, finalization } = input;
  return (
    (interview.language ?? 'de') === (guide.sourceLanguage ?? 'de') &&
    transcript.interviewId === interview.interviewId &&
    transcript.guideId === guide.id &&
    transcript.guideQuestionIndex.every((reference) => reference.guideId === guide.id) &&
    transcript.entries.every(
      (entry) =>
        entry.interviewId === interview.interviewId &&
        (entry.kind === 'technical_gap' ||
          entry.guideReference === null ||
          entry.guideReference.guideId === guide.id),
    ) &&
    transcript.partials.every((partial) => partial.interviewId === interview.interviewId) &&
    transcript.finals.every(
      (final) =>
        final.interviewId === interview.interviewId &&
        (final.guideReference === null || final.guideReference.guideId === guide.id),
    ) &&
    (finalization === null || finalization.interviewId === interview.interviewId)
  );
}

function selectCurrentQuestion(
  input: CanonicalSessionProjectionInput,
  catalog: readonly GuideQuestionCatalogEntry[],
): GuideQuestionCatalogEntry | null {
  const explicitlyCurrent = input.interview.coverage.questions.find(
    (question) => question.status === 'current',
  );
  const nextMain =
    explicitlyCurrent === undefined
      ? selectNextOpenMainQuestion(input.guide, input.interview.coverage)
      : null;
  const questionId = explicitlyCurrent?.questionId ?? nextMain?.questionId;
  return questionId === undefined
    ? null
    : (catalog.find((question) => question.questionId === questionId) ?? null);
}

function toMvpTurn(turn: TranscriptTurn): MvpTranscriptTurn {
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

function toMvpGap(
  gap: Extract<CanonicalTranscriptEntry, { kind: 'technical_gap' }>,
): MvpTranscriptGap {
  return {
    gapId: gap.gapId,
    interviewId: gap.interviewId,
    sequenceNumber: gap.sequenceNumber,
    source: gap.source,
    description: gap.description,
    occurredAt: gap.occurredAt,
  };
}

function latestUnresolvedPartialText(
  transcript: TranscriptAggregate,
  isFinalized: boolean,
): string | null {
  if (isFinalized) return null;

  let latest: PartialTranscriptSegment | undefined;
  for (const partial of transcript.partials) {
    if (isResolvedPartial(partial, transcript) || !isLaterPartial(partial, latest)) continue;
    latest = partial;
  }
  return latest === undefined || latest.text.trim().length === 0 ? null : latest.text;
}

function isResolvedPartial(
  partial: PartialTranscriptSegment,
  transcript: TranscriptAggregate,
): boolean {
  const finalized = transcript.finals.some(
    (segment) =>
      segment.sourceProvider === partial.sourceProvider &&
      (segment.segmentId === partial.segmentId || segment.utteranceId === partial.utteranceId),
  );
  if (finalized) return true;
  return transcript.entries.some(
    (entry) =>
      entry.kind === 'technical_gap' &&
      entry.source === 'speech_to_text' &&
      entry.sourceProvider === partial.sourceProvider &&
      (entry.relatedSegmentId === partial.segmentId ||
        entry.relatedUtteranceId === partial.utteranceId),
  );
}

function isLaterPartial(
  candidate: PartialTranscriptSegment,
  current: PartialTranscriptSegment | undefined,
): boolean {
  if (current === undefined) return true;
  const timestampDifference = Date.parse(candidate.observedAt) - Date.parse(current.observedAt);
  if (timestampDifference !== 0) return timestampDifference > 0;
  if (candidate.revision !== current.revision) return candidate.revision > current.revision;
  return candidate.providerEventId.localeCompare(current.providerEventId) > 0;
}

function latestActivityTimestamp(input: CanonicalSessionProjectionInput): string {
  const timestamps = [
    input.interview.updatedAt,
    ...input.transcript.entries.flatMap((entry) => [
      entry.occurredAt,
      ...(entry.kind === 'turn' &&
      entry.speaker === 'ai_interviewer' &&
      entry.delivery.status === 'interrupted'
        ? [entry.delivery.interruptedAt]
        : []),
    ]),
    ...input.transcript.partials.map((partial) => partial.observedAt),
    ...input.transcript.finals.map((final) => final.finalizedAt),
    ...(input.finalization === null ? [] : [input.finalization.finalizedAt]),
  ];
  return timestamps.reduce((latest, timestamp) =>
    Date.parse(timestamp) > Date.parse(latest) ? timestamp : latest,
  );
}

function toMvpStatus(lifecycle: InterviewLifecycleState): MvpInterviewSession['status'] {
  switch (lifecycle.status) {
    case 'ready':
    case 'active':
    case 'paused':
    case 'completed':
      return lifecycle.status;
    case 'ending':
      return 'active';
    case 'failed':
      return 'completed';
  }
}

function lifecycleStartedAt(lifecycle: InterviewLifecycleState): string | null {
  return lifecycle.status === 'ready' ? null : lifecycle.startedAt;
}

function lifecycleEndedAt(lifecycle: InterviewLifecycleState): string | null {
  switch (lifecycle.status) {
    case 'completed':
      return lifecycle.endedAt;
    case 'failed':
      return lifecycle.failedAt;
    case 'ready':
    case 'active':
    case 'paused':
    case 'ending':
      return null;
  }
}

function isQuestionSelectionClosed(lifecycle: InterviewLifecycleState): boolean {
  return (
    lifecycle.status === 'ending' ||
    lifecycle.status === 'completed' ||
    lifecycle.status === 'failed'
  );
}

function invalidProjection(interviewId: string, message: string): ApplicationResult<never> {
  return failure({
    code: 'application_invariant',
    resource: 'interview_view',
    id: interviewId,
    message,
  });
}
