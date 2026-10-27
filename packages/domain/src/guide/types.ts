import type { SupportedLocale } from '@orgscience/contracts';

/**
 * Deterministic parser output before persistence metadata is attached.
 * Its structural fields intentionally match the shared interview-guide contract.
 */
export interface ParsedInterviewGuide {
  readonly id: string;
  readonly sourceLanguage: SupportedLocale;
  readonly title: string;
  readonly sections: readonly ParsedGuideSection[];
}

export interface ParsedGuideSection {
  readonly id: string;
  readonly position: number;
  readonly title: string;
  readonly mainQuestions: readonly ParsedMainQuestion[];
}

export interface ParsedMainQuestion {
  readonly id: string;
  readonly position: number;
  readonly text: string;
  readonly followUpQuestions: readonly ParsedFollowUpQuestion[];
}

export interface ParsedFollowUpQuestion {
  readonly id: string;
  readonly position: number;
  readonly text: string;
}

export const INTERVIEW_GUIDE_LIMITS = Object.freeze({
  maximumSections: 100,
  maximumMainQuestions: 500,
  maximumFollowUpQuestions: 1_500,
  maximumTotalQuestions: 1_750,
});

export const GUIDE_PARSE_ISSUE_CODES = [
  'TITLE_MISSING',
  'TITLE_EMPTY',
  'TITLE_TOO_LONG',
  'DUPLICATE_TITLE',
  'TITLE_OUT_OF_ORDER',
  'SECTION_BEFORE_TITLE',
  'SECTION_TITLE_EMPTY',
  'SECTION_TITLE_TOO_LONG',
  'SECTION_WITHOUT_MAIN_QUESTION',
  'MAIN_QUESTION_BEFORE_TITLE',
  'MAIN_QUESTION_BEFORE_SECTION',
  'MAIN_QUESTION_TEXT_MISSING',
  'MAIN_QUESTION_TEXT_TOO_LONG',
  'FOLLOW_UP_BEFORE_MAIN_QUESTION',
  'DUPLICATE_FOLLOW_UP_HEADING',
  'FOLLOW_UP_LIST_EMPTY',
  'FOLLOW_UP_OUTSIDE_LIST',
  'FOLLOW_UP_TEXT_EMPTY',
  'FOLLOW_UP_TEXT_TOO_LONG',
  'UNEXPECTED_HEADING',
  'UNEXPECTED_CONTENT',
  'NO_MAIN_QUESTION',
  'SOURCE_TOO_LONG',
  'TOO_MANY_LINES',
  'TOO_MANY_SECTIONS',
  'TOO_MANY_MAIN_QUESTIONS',
  'TOO_MANY_FOLLOW_UP_QUESTIONS',
  'TOO_MANY_QUESTIONS',
  'TOO_MANY_ISSUES',
] as const;

export type GuideParseIssueCode = (typeof GUIDE_PARSE_ISSUE_CODES)[number];

export interface GuideParseIssue {
  readonly line: number;
  readonly code: GuideParseIssueCode;
  readonly message: string;
}

export type GuideParseResult =
  | {
      readonly success: true;
      readonly guide: ParsedInterviewGuide;
    }
  | {
      readonly success: false;
      readonly issues: readonly GuideParseIssue[];
    };
