import type { MvpInterviewSession } from '@orgscience/contracts';

export function isAuthoritativeTranscriptFinalized(
  session: MvpInterviewSession | null,
  interviewId: string,
): boolean {
  return (
    session !== null &&
    session.interviewId === interviewId &&
    session.status === 'completed' &&
    session.endedAt !== null &&
    session.finalizedAt !== null
  );
}
