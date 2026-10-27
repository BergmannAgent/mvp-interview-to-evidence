import type {
  DisplayTranscriptTurn,
  InterviewInputMode,
  InterviewPhase,
  RestoredInterviewSession,
} from './model.js';

const STORAGE_KEY = 'orgscience.interview.session.v1';

export function persistInterviewSession(session: RestoredInterviewSession): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  } catch {
    // A blocked browser store must not interrupt the interview.
  }
}

export function restoreInterviewSession(): RestoredInterviewSession | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isRestoredSession(parsed)) return null;
    return {
      ...parsed,
      guide: {
        ...parsed.guide,
        sourceLanguage: parsed.guide.sourceLanguage === 'en' ? 'en' : 'de',
      },
    };
  } catch {
    return null;
  }
}

export function clearInterviewSession(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // A blocked browser store must not prevent starting another interview.
  }
}

function isRestoredSession(value: unknown): value is RestoredInterviewSession {
  if (!isRecord(value)) return false;
  return (
    typeof value.interviewId === 'string' &&
    isRecord(value.guide) &&
    typeof value.guide.id === 'string' &&
    typeof value.guide.title === 'string' &&
    (value.guide.sourceLanguage === undefined ||
      value.guide.sourceLanguage === 'de' ||
      value.guide.sourceLanguage === 'en') &&
    Array.isArray(value.guide.sections) &&
    isInterviewPhase(value.phase) &&
    isInputMode(value.inputMode) &&
    Number.isInteger(value.promptIndex) &&
    Number(value.promptIndex) >= 0 &&
    Array.isArray(value.turns) &&
    value.turns.every(isDisplayTurn) &&
    typeof value.startedAt === 'string' &&
    (typeof value.endedAt === 'string' || value.endedAt === null)
  );
}

function isInputMode(value: unknown): value is InterviewInputMode {
  return value === 'text' || value === 'voice';
}

function isDisplayTurn(value: unknown): value is DisplayTranscriptTurn {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    Number.isInteger(value.sequenceNumber) &&
    (value.speaker === 'ai_interviewer' || value.speaker === 'participant') &&
    typeof value.turnType === 'string' &&
    typeof value.text === 'string' &&
    typeof value.occurredAt === 'string' &&
    typeof value.interrupted === 'boolean'
  );
}

function isInterviewPhase(value: unknown): value is InterviewPhase {
  return (
    value === 'ready' ||
    value === 'listening' ||
    value === 'processing' ||
    value === 'speaking' ||
    value === 'paused' ||
    value === 'completed'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
