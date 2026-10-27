import type { MvpInterviewSession } from '@orgscience/contracts';

/**
 * Compares server snapshots so an older polling response cannot overwrite a
 * newer command response in the browser.
 */
export function shouldApplyAuthoritativeSession(
  current: MvpInterviewSession | null,
  candidate: MvpInterviewSession,
): boolean {
  if (current === null) return true;
  if (candidate.interviewId !== current.interviewId) return false;
  if (current.status === 'completed' && candidate.status !== 'completed') return false;
  return compareAuthoritativeSession(candidate, current) >= 0;
}

export function compareAuthoritativeSession(
  left: MvpInterviewSession,
  right: MvpInterviewSession,
): number {
  const version = left.stateVersion - right.stateVersion;
  if (version !== 0) return version;

  const lastTranscriptSequence =
    lastTranscriptSequenceNumber(left) - lastTranscriptSequenceNumber(right);
  if (lastTranscriptSequence !== 0) return lastTranscriptSequence;

  const finalized = Number(left.finalizedAt !== null) - Number(right.finalizedAt !== null);
  if (finalized !== 0) return finalized;

  const updatedAt = Date.parse(left.updatedAt) - Date.parse(right.updatedAt);
  if (updatedAt !== 0) return updatedAt;

  return sessionStatusRank(left.status) - sessionStatusRank(right.status);
}

function lastTranscriptSequenceNumber(session: MvpInterviewSession): number {
  return Math.max(
    0,
    ...session.transcript.map((turn) => turn.sequenceNumber),
    ...session.technicalGaps.map((gap) => gap.sequenceNumber),
  );
}

function sessionStatusRank(status: MvpInterviewSession['status']): number {
  return status === 'completed' ? 1 : 0;
}
