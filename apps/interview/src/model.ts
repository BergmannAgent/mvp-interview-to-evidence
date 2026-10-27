import type {
  GuideQuestionReference,
  InterviewGuide,
  TranscriptSpeaker,
  TranscriptTurnType,
} from '@orgscience/contracts';

export type InterviewPhase =
  'ready' | 'listening' | 'processing' | 'speaking' | 'paused' | 'completed';

export type InterviewInputMode = 'text' | 'voice';

export interface DisplayTranscriptTurn {
  readonly id: string;
  readonly sequenceNumber: number;
  readonly speaker: TranscriptSpeaker;
  readonly turnType: TranscriptTurnType;
  readonly text: string;
  readonly occurredAt: string;
  readonly guideReference: GuideQuestionReference | null;
  readonly interrupted: boolean;
}

export interface PreparedInterview {
  readonly guide: InterviewGuide;
  readonly interviewId: string;
}

export interface RestoredInterviewSession {
  readonly guide: InterviewGuide;
  readonly interviewId: string;
  readonly phase: InterviewPhase;
  readonly inputMode: InterviewInputMode;
  readonly promptIndex: number;
  readonly turns: readonly DisplayTranscriptTurn[];
  readonly startedAt: string;
  readonly endedAt: string | null;
}
