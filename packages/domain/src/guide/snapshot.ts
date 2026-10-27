import type { ParsedInterviewGuide } from './types.js';

export interface InterviewGuideSnapshot extends ParsedInterviewGuide {
  readonly sourceMarkdown: string;
  readonly createdAt: string;
}

export function toInterviewGuideSnapshot(
  guide: ParsedInterviewGuide,
  sourceMarkdown: string,
  createdAt: string,
): InterviewGuideSnapshot {
  if (sourceMarkdown.trim().length === 0) {
    throw new TypeError('sourceMarkdown must not be blank');
  }
  if (createdAt.trim().length === 0 || !Number.isFinite(Date.parse(createdAt))) {
    throw new TypeError('createdAt must be a valid timestamp');
  }

  return { ...guide, sourceMarkdown, createdAt };
}
