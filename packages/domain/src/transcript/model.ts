import type {
  FollowUpGuideQuestionReference,
  MainGuideQuestionReference,
} from '../guide/catalog.js';

export type TranscriptTimestamp = string;

export type TranscriptSpeaker = 'ai_interviewer' | 'participant';

export type AiTurnType =
  | 'greeting'
  | 'main_question'
  | 'follow_up_question'
  | 'clarification_question'
  | 'transition'
  | 'closing';

export type QuestionTurnType = 'main_question' | 'follow_up_question' | 'clarification_question';

export type TranscriptTurnType = AiTurnType | 'participant_answer';

export type MainQuestionGuideReference = MainGuideQuestionReference;

export type FollowUpQuestionGuideReference = FollowUpGuideQuestionReference;

export type TranscriptGuideReference = MainQuestionGuideReference | FollowUpQuestionGuideReference;

interface TranscriptEntryBase {
  readonly interviewId: string;
  readonly sequenceNumber: number;
  readonly occurredAt: TranscriptTimestamp;
}

export type AiTurnDelivery =
  | { readonly status: 'complete' }
  | {
      readonly status: 'interrupted';
      readonly interruptedAt: TranscriptTimestamp;
    };

interface AiTranscriptTurnBase extends TranscriptEntryBase {
  readonly kind: 'turn';
  readonly turnId: string;
  readonly deliveryEventId: string;
  readonly speaker: 'ai_interviewer';
  /** Exact text confirmed as heard by the participant. */
  readonly text: string;
  readonly delivery: AiTurnDelivery;
}

export type AiTranscriptTurn =
  | (AiTranscriptTurnBase & {
      readonly turnType: 'greeting' | 'closing';
      readonly guideReference: null;
    })
  | (AiTranscriptTurnBase & {
      readonly turnType: 'main_question';
      readonly guideReference: MainQuestionGuideReference;
    })
  | (AiTranscriptTurnBase & {
      readonly turnType: 'follow_up_question';
      readonly guideReference: FollowUpQuestionGuideReference;
    })
  | (AiTranscriptTurnBase & {
      readonly turnType: 'clarification_question';
      readonly guideReference: TranscriptGuideReference;
    })
  | (AiTranscriptTurnBase & {
      readonly turnType: 'transition';
      readonly guideReference: TranscriptGuideReference | null;
    });

export interface ParticipantTranscriptTurn extends TranscriptEntryBase {
  readonly kind: 'turn';
  readonly turnId: string;
  readonly sourceProvider: string;
  readonly providerEventId: string;
  readonly speaker: 'participant';
  readonly turnType: 'participant_answer';
  /** Exact provider-finalized text; never normalized or rewritten. */
  readonly text: string;
  readonly guideReference: TranscriptGuideReference | null;
  readonly sourceSegmentId: string;
}

export type TranscriptTurn = AiTranscriptTurn | ParticipantTranscriptTurn;

export type TechnicalGapSource = 'speech_to_text' | 'audio_output' | 'transport';

interface TranscriptTechnicalGapBase extends TranscriptEntryBase {
  readonly kind: 'technical_gap';
  readonly gapId: string;
  readonly sourceEventId: string;
  readonly description: string;
  readonly relatedSegmentId: string | null;
}

export type TranscriptTechnicalGap = TranscriptTechnicalGapBase &
  (
    | {
        readonly source: 'speech_to_text';
        readonly sourceProvider: string;
        readonly relatedUtteranceId: string;
      }
    | {
        readonly source: 'audio_output' | 'transport';
        readonly sourceProvider: null;
        readonly relatedUtteranceId: null;
      }
  );

export type CanonicalTranscriptEntry = TranscriptTurn | TranscriptTechnicalGap;

export interface PartialTranscriptSegment {
  readonly interviewId: string;
  readonly sourceProvider: string;
  readonly utteranceId: string;
  readonly providerEventId: string;
  readonly segmentId: string;
  readonly text: string;
  readonly revision: number;
  readonly observedAt: TranscriptTimestamp;
}

export interface FinalizedParticipantSegment {
  readonly interviewId: string;
  readonly sourceProvider: string;
  readonly utteranceId: string;
  readonly providerEventId: string;
  readonly segmentId: string;
  readonly turnId: string;
  readonly text: string;
  readonly occurredAt: TranscriptTimestamp;
  readonly observedAt: TranscriptTimestamp;
  readonly finalizedAt: TranscriptTimestamp;
  readonly guideReference: TranscriptGuideReference | null;
}

export type TranscriptGuideQuestionIndexInput = readonly TranscriptGuideReference[];

export interface TranscriptAggregate {
  readonly interviewId: string;
  readonly guideId: string;
  readonly guideQuestionIndex: TranscriptGuideQuestionIndexInput;
  readonly nextSequenceNumber: number;
  readonly entries: readonly CanonicalTranscriptEntry[];
  readonly partials: readonly PartialTranscriptSegment[];
  readonly finals: readonly FinalizedParticipantSegment[];
}

export interface PartialSegmentInput {
  readonly interviewId: string;
  readonly sourceProvider: string;
  readonly utteranceId: string;
  readonly providerEventId: string;
  readonly segmentId: string;
  readonly text: string;
  readonly revision: number;
  readonly observedAt: TranscriptTimestamp;
}

export interface FinalParticipantSegmentInput {
  readonly interviewId: string;
  readonly sourceProvider: string;
  readonly utteranceId: string;
  readonly providerEventId: string;
  readonly segmentId: string;
  readonly turnId: string;
  readonly text: string;
  readonly occurredAt: TranscriptTimestamp;
  readonly observedAt: TranscriptTimestamp;
  readonly finalizedAt: TranscriptTimestamp;
  readonly guideReference: TranscriptGuideReference | null;
}

interface AppendAiTurnInputBase {
  readonly interviewId: string;
  readonly turnId: string;
  readonly deliveryEventId: string;
  readonly spokenText: string;
  readonly occurredAt: TranscriptTimestamp;
  readonly delivery: AiTurnDelivery;
}

export type AppendAiTurnInput =
  | (AppendAiTurnInputBase & {
      readonly turnType: 'greeting' | 'closing';
      readonly guideReference: null;
    })
  | (AppendAiTurnInputBase & {
      readonly turnType: 'main_question';
      readonly guideReference: MainQuestionGuideReference;
    })
  | (AppendAiTurnInputBase & {
      readonly turnType: 'follow_up_question';
      readonly guideReference: FollowUpQuestionGuideReference;
    })
  | (AppendAiTurnInputBase & {
      readonly turnType: 'clarification_question';
      readonly guideReference: TranscriptGuideReference;
    })
  | (AppendAiTurnInputBase & {
      readonly turnType: 'transition';
      readonly guideReference: TranscriptGuideReference | null;
    });

interface RecordTechnicalGapInputBase {
  readonly interviewId: string;
  readonly gapId: string;
  readonly sourceEventId: string;
  readonly description: string;
  readonly occurredAt: TranscriptTimestamp;
  readonly relatedSegmentId: string | null;
}

export type RecordTechnicalGapInput = RecordTechnicalGapInputBase &
  (
    | {
        readonly source: 'speech_to_text';
        readonly sourceProvider: string;
        readonly relatedUtteranceId: string;
      }
    | {
        readonly source: 'audio_output' | 'transport';
        readonly sourceProvider: null;
        readonly relatedUtteranceId: null;
      }
  );

export type PartialIngestionStatus = 'accepted' | 'updated' | 'ignored_stale' | 'ignored_finalized';

export interface PartialIngestionResult {
  readonly status: PartialIngestionStatus;
  readonly aggregate: TranscriptAggregate;
}

export type FinalIngestionResult =
  | {
      readonly status: 'appended';
      readonly aggregate: TranscriptAggregate;
      readonly turn: ParticipantTranscriptTurn;
    }
  | {
      readonly status: 'duplicate';
      readonly aggregate: TranscriptAggregate;
      readonly turn: ParticipantTranscriptTurn;
    };

export type AiTurnAppendResult =
  | {
      readonly status: 'appended';
      readonly aggregate: TranscriptAggregate;
      readonly turn: AiTranscriptTurn;
    }
  | {
      readonly status: 'duplicate';
      readonly aggregate: TranscriptAggregate;
      readonly turn: AiTranscriptTurn;
    };

export type TechnicalGapRecordResult =
  | {
      readonly status: 'appended';
      readonly aggregate: TranscriptAggregate;
      readonly gap: TranscriptTechnicalGap;
    }
  | {
      readonly status: 'duplicate';
      readonly aggregate: TranscriptAggregate;
      readonly gap: TranscriptTechnicalGap;
    };

export type TranscriptDomainErrorCode =
  | 'invalid_identifier'
  | 'invalid_text'
  | 'invalid_timestamp'
  | 'timestamp_regression'
  | 'invalid_revision'
  | 'interview_mismatch'
  | 'guide_mismatch'
  | 'duplicate_entry_id'
  | 'conflicting_partial_event'
  | 'conflicting_partial_segment'
  | 'conflicting_final_segment'
  | 'participant_without_question'
  | 'participant_question_reference_mismatch'
  | 'conflicting_ai_turn'
  | 'conflicting_gap'
  | 'invalid_transcript'
  | 'invalid_guide_index'
  | 'unknown_guide_question'
  | 'guide_question_mismatch'
  | 'invalid_delivery'
  | 'invalid_guide_reference';

export class TranscriptDomainError extends Error {
  public readonly code: TranscriptDomainErrorCode;

  public constructor(code: TranscriptDomainErrorCode, message: string) {
    super(message);
    this.name = 'TranscriptDomainError';
    this.code = code;
  }
}

export const TRANSCRIPT_INVARIANT_ISSUE_CODES = [
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
  'invalid_guide_question_index',
  'unknown_guide_question',
  'guide_question_mismatch',
  'missing_greeting',
  'multiple_greetings',
  'greeting_not_first',
  'missing_main_question',
  'participant_without_question',
  'participant_question_reference_mismatch',
  'unanswered_question_before_next_question',
  'consecutive_participant_answers',
  'missing_closing',
  'multiple_closings',
  'closing_not_terminal',
  'unanswered_last_question',
  'missing_required_main_question',
  'unanswered_required_main_question',
] as const;

export type TranscriptInvariantIssueCode = (typeof TRANSCRIPT_INVARIANT_ISSUE_CODES)[number];

export interface TranscriptInvariantIssue {
  readonly code: TranscriptInvariantIssueCode;
  readonly message: string;
  readonly entryId: string | null;
}

export interface TranscriptValidationResult {
  readonly valid: boolean;
  readonly issues: readonly TranscriptInvariantIssue[];
}

export interface TranscriptValidationOptions {
  readonly requiredMainQuestionIds?: readonly string[];
  readonly requireAnswersForRequiredMainQuestions?: boolean;
}
