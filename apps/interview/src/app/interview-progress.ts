import type { MvpInterviewSession } from '@orgscience/contracts';

// Guide position is not progress: the interviewer may revisit an earlier open question.
export function interviewProgress(session: MvpInterviewSession): number {
  const visited = new Set<string>();
  for (const turn of session.transcript) {
    const reference = turn.guideReference;
    if (reference === null || reference.guideId !== session.guideId) continue;
    if (
      turn.turnType === 'greeting' ||
      turn.turnType === 'transition' ||
      turn.turnType === 'closing'
    )
      continue;
    visited.add(
      reference.kind === 'follow_up_question'
        ? reference.followUpQuestionId
        : reference.mainQuestionId,
    );
  }
  if (session.currentQuestion !== null) visited.add(session.currentQuestion.questionId);
  return Math.min(visited.size, session.totalQuestions);
}
