import {
  TranscriptDomainError,
  validateFinalTranscript,
  type CanonicalTranscriptEntry,
  type TranscriptAggregate,
  type TranscriptInvariantIssueCode,
} from './aggregate.js';

const EXPORT_BLOCKING_ISSUES: ReadonlySet<TranscriptInvariantIssueCode> = new Set([
  'invalid_interview_id',
  'invalid_guide_id',
  'invalid_next_sequence',
  'non_monotonic_sequence',
  'duplicate_entry_id',
  'interview_mismatch',
  'guide_mismatch',
  'invalid_timestamp',
  'timestamp_regression',
  'invalid_text',
  'invalid_speaker_turn_type',
  'invalid_interruption',
  'duplicate_segment_id',
  'duplicate_utterance_id',
  'duplicate_provider_event_id',
  'duplicate_delivery_event_id',
  'duplicate_source_event_id',
  'duplicate_participant_source_segment',
  'missing_finalization_record',
  'orphan_finalization_record',
  'conflicting_finalization_record',
  'late_partial_segment',
  'unresolved_partial_segment',
  'invalid_guide_reference',
  'participant_question_reference_mismatch',
  'invalid_guide_question_index',
  'unknown_guide_question',
  'guide_question_mismatch',
]);

export interface CanonicalTranscriptSnapshot {
  readonly interviewId: string;
  readonly guideId: string;
  readonly entries: readonly CanonicalTranscriptEntry[];
  readonly finalizedAt: string;
}

export function toCanonicalTranscriptSnapshot(
  aggregate: TranscriptAggregate,
  finalizedAt: string,
): CanonicalTranscriptSnapshot {
  if (finalizedAt.trim().length === 0 || !Number.isFinite(Date.parse(finalizedAt))) {
    throw new TranscriptDomainError('invalid_timestamp', 'finalizedAt must be a valid timestamp');
  }
  const lastEntry = aggregate.entries.at(-1);
  if (lastEntry !== undefined && Date.parse(finalizedAt) < Date.parse(lastEntry.occurredAt)) {
    throw new TranscriptDomainError(
      'timestamp_regression',
      'A transcript cannot be finalized before its final canonical entry',
    );
  }

  const blockingIssues = validateFinalTranscript(aggregate).issues.filter((issue) =>
    EXPORT_BLOCKING_ISSUES.has(issue.code),
  );
  if (blockingIssues.length > 0) {
    throw new TranscriptDomainError(
      'invalid_transcript',
      `Cannot snapshot a structurally invalid transcript: ${blockingIssues
        .map((issue) => issue.code)
        .join(', ')}`,
    );
  }

  return {
    interviewId: aggregate.interviewId,
    guideId: aggregate.guideId,
    entries: aggregate.entries,
    finalizedAt,
  };
}
