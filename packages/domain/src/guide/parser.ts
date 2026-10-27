import type { SupportedLocale } from '@orgscience/contracts';

import { createStableGuideEntityId, normalizeGuideIdentityPart } from './stable-id.js';
import type {
  GuideParseIssue,
  GuideParseIssueCode,
  GuideParseResult,
  ParsedGuideSection,
  ParsedInterviewGuide,
  ParsedMainQuestion,
} from './types.js';
import { INTERVIEW_GUIDE_LIMITS } from './types.js';

interface RawTitle {
  readonly line: number;
  readonly value: string;
}

interface RawSection {
  readonly line: number;
  readonly title: string;
  readonly mainQuestions: RawMainQuestion[];
}

interface RawMainQuestion {
  readonly line: number;
  readonly text: string;
  readonly followUps: RawFollowUp[];
}

interface RawFollowUp {
  readonly line: number;
  readonly text: string;
}

interface PendingMainQuestion {
  readonly line: number;
  readonly section: RawSection | undefined;
}

type ClassifiedLine =
  | { readonly kind: 'title'; readonly value: string }
  | { readonly kind: 'section'; readonly value: string }
  | { readonly kind: 'main-question-heading' }
  | { readonly kind: 'follow-up-heading' }
  | { readonly kind: 'bullet'; readonly value: string }
  | { readonly kind: 'unexpected-heading' }
  | { readonly kind: 'content'; readonly value: string };

const GERMAN_ISSUE_MESSAGES: Readonly<Record<GuideParseIssueCode, string>> = {
  TITLE_MISSING: 'Der Leitfaden benötigt genau eine Titelzeile im Format "# Titel".',
  TITLE_EMPTY: 'Der Titel nach "#" darf nicht leer sein.',
  TITLE_TOO_LONG: 'Der Titel darf höchstens 300 Zeichen enthalten.',
  DUPLICATE_TITLE: 'Der Leitfaden darf nur eine Titelzeile enthalten.',
  TITLE_OUT_OF_ORDER: 'Die Titelzeile muss vor allen Abschnitten und Fragen stehen.',
  SECTION_BEFORE_TITLE: 'Ein Abschnitt darf erst nach der Titelzeile beginnen.',
  SECTION_TITLE_EMPTY: 'Der Abschnittstitel nach "##" darf nicht leer sein.',
  SECTION_TITLE_TOO_LONG: 'Ein Abschnittstitel darf höchstens 300 Zeichen enthalten.',
  SECTION_WITHOUT_MAIN_QUESTION: 'Jeder Abschnitt muss mindestens eine Hauptfrage enthalten.',
  MAIN_QUESTION_BEFORE_TITLE: 'Eine Hauptfrage darf erst nach der Titelzeile beginnen.',
  MAIN_QUESTION_BEFORE_SECTION: 'Eine Hauptfrage muss innerhalb eines Abschnitts stehen.',
  MAIN_QUESTION_TEXT_MISSING:
    'Auf "### Hauptfrage" muss eine nicht leere Textzeile mit der Frage folgen.',
  MAIN_QUESTION_TEXT_TOO_LONG: 'Eine Hauptfrage darf höchstens 2.000 Zeichen enthalten.',
  FOLLOW_UP_BEFORE_MAIN_QUESTION:
    'Vertiefungsfragen müssen zu einer zuvor definierten Hauptfrage gehören.',
  DUPLICATE_FOLLOW_UP_HEADING:
    'Eine Hauptfrage darf nur einen Block "#### Vertiefungsfragen" enthalten.',
  FOLLOW_UP_LIST_EMPTY:
    'Auf "#### Vertiefungsfragen" muss mindestens ein nicht leerer Listenpunkt folgen.',
  FOLLOW_UP_OUTSIDE_LIST:
    'Ein Vertiefungsfragen-Listenpunkt benötigt zuvor die Überschrift "#### Vertiefungsfragen".',
  FOLLOW_UP_TEXT_EMPTY: 'Der Text einer Vertiefungsfrage darf nicht leer sein.',
  FOLLOW_UP_TEXT_TOO_LONG: 'Eine Vertiefungsfrage darf höchstens 2.000 Zeichen enthalten.',
  UNEXPECTED_HEADING:
    'Erlaubt sind nur "# Titel", "## Abschnitt", "### Hauptfrage" und "#### Vertiefungsfragen".',
  UNEXPECTED_CONTENT: 'Diese Zeile ist an dieser Position im Leitfaden nicht erlaubt.',
  NO_MAIN_QUESTION: 'Der Leitfaden muss mindestens eine Hauptfrage enthalten.',
  SOURCE_TOO_LONG: 'Der Leitfaden darf höchstens 1.000.000 Zeichen enthalten.',
  TOO_MANY_LINES: 'Der Leitfaden darf höchstens 20.000 Zeilen enthalten.',
  TOO_MANY_SECTIONS: `Der Leitfaden darf höchstens ${formatGermanInteger(INTERVIEW_GUIDE_LIMITS.maximumSections)} Abschnitte enthalten.`,
  TOO_MANY_MAIN_QUESTIONS: `Der Leitfaden darf höchstens ${formatGermanInteger(INTERVIEW_GUIDE_LIMITS.maximumMainQuestions)} Hauptfragen enthalten.`,
  TOO_MANY_FOLLOW_UP_QUESTIONS: `Der Leitfaden darf höchstens ${formatGermanInteger(INTERVIEW_GUIDE_LIMITS.maximumFollowUpQuestions)} Vertiefungsfragen enthalten.`,
  TOO_MANY_QUESTIONS: `Der Leitfaden darf insgesamt höchstens ${formatGermanInteger(INTERVIEW_GUIDE_LIMITS.maximumTotalQuestions)} Fragen enthalten.`,
  TOO_MANY_ISSUES:
    'Weitere Strukturfehler wurden ausgelassen; korrigieren Sie zunächst die gemeldeten Fehler.',
};

const ENGLISH_ISSUE_MESSAGES: Readonly<Record<GuideParseIssueCode, string>> = {
  TITLE_MISSING: 'The guide requires exactly one title line in the format "# Title".',
  TITLE_EMPTY: 'The title after "#" must not be empty.',
  TITLE_TOO_LONG: 'The title must not exceed 300 characters.',
  DUPLICATE_TITLE: 'The guide may contain only one title line.',
  TITLE_OUT_OF_ORDER: 'The title line must precede all sections and questions.',
  SECTION_BEFORE_TITLE: 'A section may only begin after the title line.',
  SECTION_TITLE_EMPTY: 'The section title after "##" must not be empty.',
  SECTION_TITLE_TOO_LONG: 'A section title must not exceed 300 characters.',
  SECTION_WITHOUT_MAIN_QUESTION: 'Every section must contain at least one main question.',
  MAIN_QUESTION_BEFORE_TITLE: 'A main question may only begin after the title line.',
  MAIN_QUESTION_BEFORE_SECTION: 'A main question must be inside a section.',
  MAIN_QUESTION_TEXT_MISSING: 'A non-empty question line must follow "### Main question".',
  MAIN_QUESTION_TEXT_TOO_LONG: 'A main question must not exceed 2,000 characters.',
  FOLLOW_UP_BEFORE_MAIN_QUESTION:
    'Follow-up questions must belong to a previously defined main question.',
  DUPLICATE_FOLLOW_UP_HEADING:
    'A main question may contain only one "#### Follow-up questions" block.',
  FOLLOW_UP_LIST_EMPTY: 'At least one non-empty list item must follow "#### Follow-up questions".',
  FOLLOW_UP_OUTSIDE_LIST:
    'A follow-up list item requires a preceding "#### Follow-up questions" heading.',
  FOLLOW_UP_TEXT_EMPTY: 'The text of a follow-up question must not be empty.',
  FOLLOW_UP_TEXT_TOO_LONG: 'A follow-up question must not exceed 2,000 characters.',
  UNEXPECTED_HEADING:
    'Only "# Title", "## Section", "### Main question" and "#### Follow-up questions" are allowed.',
  UNEXPECTED_CONTENT: 'This line is not allowed at this position in the guide.',
  NO_MAIN_QUESTION: 'The guide must contain at least one main question.',
  SOURCE_TOO_LONG: 'The guide must not exceed 1,000,000 characters.',
  TOO_MANY_LINES: 'The guide must not exceed 20,000 lines.',
  TOO_MANY_SECTIONS: `The guide must not contain more than ${formatInteger(INTERVIEW_GUIDE_LIMITS.maximumSections, 'en')} sections.`,
  TOO_MANY_MAIN_QUESTIONS: `The guide must not contain more than ${formatInteger(INTERVIEW_GUIDE_LIMITS.maximumMainQuestions, 'en')} main questions.`,
  TOO_MANY_FOLLOW_UP_QUESTIONS: `The guide must not contain more than ${formatInteger(INTERVIEW_GUIDE_LIMITS.maximumFollowUpQuestions, 'en')} follow-up questions.`,
  TOO_MANY_QUESTIONS: `The guide must not contain more than ${formatInteger(INTERVIEW_GUIDE_LIMITS.maximumTotalQuestions, 'en')} questions in total.`,
  TOO_MANY_ISSUES: 'Additional structural errors were omitted; fix the reported errors first.',
};

const ISSUE_MESSAGES = Object.freeze({
  de: GERMAN_ISSUE_MESSAGES,
  en: ENGLISH_ISSUE_MESSAGES,
} satisfies Readonly<Record<SupportedLocale, Readonly<Record<GuideParseIssueCode, string>>>>);

const MAXIMUM_GUIDE_SOURCE_CHARACTERS = 1_000_000;
const MAXIMUM_GUIDE_TITLE_CHARACTERS = 300;
const MAXIMUM_QUESTION_CHARACTERS = 2_000;
const MAXIMUM_GUIDE_LINES = 20_000;
const MAXIMUM_REPORTED_ISSUES = 100;

function formatGermanInteger(value: number): string {
  return formatInteger(value, 'de');
}

function formatInteger(value: number, locale: SupportedLocale): string {
  return new Intl.NumberFormat(locale === 'de' ? 'de-DE' : 'en-GB', {
    maximumFractionDigits: 0,
  }).format(value);
}

export function parseInterviewGuideMarkdown(
  markdown: string,
  sourceLanguage: SupportedLocale = 'de',
): GuideParseResult {
  const messages = ISSUE_MESSAGES[sourceLanguage];
  if (markdown.length > MAXIMUM_GUIDE_SOURCE_CHARACTERS) {
    return {
      success: false,
      issues: [{ line: 1, code: 'SOURCE_TOO_LONG', message: messages.SOURCE_TOO_LONG }],
    };
  }
  const source = markdown.startsWith('\uFEFF') ? markdown.slice(1) : markdown;
  if (countSourceLines(source) > MAXIMUM_GUIDE_LINES) {
    return {
      success: false,
      issues: [
        {
          line: MAXIMUM_GUIDE_LINES + 1,
          code: 'TOO_MANY_LINES',
          message: messages.TOO_MANY_LINES,
        },
      ],
    };
  }
  const lines = source.replace(/\r\n?/gu, '\n').split('\n');
  const cardinalityIssue = validateGuideCardinality(lines, sourceLanguage);
  if (cardinalityIssue !== undefined) {
    return { success: false, issues: [cardinalityIssue] };
  }
  const issues: GuideParseIssue[] = [];
  const sections: RawSection[] = [];

  let title: RawTitle | undefined;
  let titleHeadingLine: number | undefined;
  let sawContentBeforeTitle = false;
  let currentSection: RawSection | undefined;
  let currentQuestion: RawMainQuestion | undefined;
  let pendingMainQuestion: PendingMainQuestion | undefined;
  let followUpHeadingLine: number | undefined;
  let followUpCountAtHeading = 0;
  let issuesTruncated = false;

  const addIssue = (line: number, code: GuideParseIssueCode): void => {
    if (issuesTruncated) return;
    if (issues.length === MAXIMUM_REPORTED_ISSUES - 1) {
      issues.push({ line, code: 'TOO_MANY_ISSUES', message: messages.TOO_MANY_ISSUES });
      issuesTruncated = true;
      return;
    }
    issues.push({ line, code, message: messages[code] });
  };

  const finishPendingMainQuestion = (): void => {
    if (pendingMainQuestion === undefined) {
      return;
    }

    addIssue(pendingMainQuestion.line, 'MAIN_QUESTION_TEXT_MISSING');
    pendingMainQuestion = undefined;
    currentQuestion = undefined;
  };

  const finishFollowUpBlock = (): void => {
    if (followUpHeadingLine === undefined) {
      return;
    }

    if (
      currentQuestion === undefined ||
      currentQuestion.followUps.length === followUpCountAtHeading
    ) {
      addIssue(followUpHeadingLine, 'FOLLOW_UP_LIST_EMPTY');
    }

    followUpHeadingLine = undefined;
    followUpCountAtHeading = 0;
  };

  const finishSection = (): void => {
    finishPendingMainQuestion();
    finishFollowUpBlock();

    if (currentSection !== undefined && currentSection.mainQuestions.length === 0) {
      addIssue(currentSection.line, 'SECTION_WITHOUT_MAIN_QUESTION');
    }

    currentQuestion = undefined;
  };

  for (const [lineIndex, originalLine] of lines.entries()) {
    const lineNumber = lineIndex + 1;
    const line = originalLine.trimEnd();

    if (line.trim().length === 0) {
      continue;
    }

    const token = classifyLine(line, sourceLanguage);

    switch (token.kind) {
      case 'title': {
        if (titleHeadingLine !== undefined) {
          addIssue(lineNumber, 'DUPLICATE_TITLE');
          break;
        }

        titleHeadingLine = lineNumber;
        if (sawContentBeforeTitle) {
          addIssue(lineNumber, 'TITLE_OUT_OF_ORDER');
        }

        if (token.value.length === 0) {
          addIssue(lineNumber, 'TITLE_EMPTY');
          break;
        }
        if (token.value.length > MAXIMUM_GUIDE_TITLE_CHARACTERS) {
          addIssue(lineNumber, 'TITLE_TOO_LONG');
        }

        title = { line: lineNumber, value: token.value };
        break;
      }

      case 'section': {
        sawContentBeforeTitle = titleHeadingLine === undefined;
        finishSection();

        if (titleHeadingLine === undefined) {
          addIssue(lineNumber, 'SECTION_BEFORE_TITLE');
        }

        if (token.value.length === 0) {
          addIssue(lineNumber, 'SECTION_TITLE_EMPTY');
          currentSection = undefined;
          break;
        }
        if (token.value.length > MAXIMUM_GUIDE_TITLE_CHARACTERS) {
          addIssue(lineNumber, 'SECTION_TITLE_TOO_LONG');
        }

        currentSection = {
          line: lineNumber,
          title: token.value,
          mainQuestions: [],
        };
        sections.push(currentSection);
        break;
      }

      case 'main-question-heading': {
        sawContentBeforeTitle = titleHeadingLine === undefined;
        finishPendingMainQuestion();
        finishFollowUpBlock();
        currentQuestion = undefined;

        if (titleHeadingLine === undefined) {
          addIssue(lineNumber, 'MAIN_QUESTION_BEFORE_TITLE');
        }
        if (currentSection === undefined) {
          addIssue(lineNumber, 'MAIN_QUESTION_BEFORE_SECTION');
        }

        pendingMainQuestion = { line: lineNumber, section: currentSection };
        break;
      }

      case 'follow-up-heading': {
        sawContentBeforeTitle = titleHeadingLine === undefined;
        finishPendingMainQuestion();

        if (followUpHeadingLine !== undefined) {
          addIssue(lineNumber, 'DUPLICATE_FOLLOW_UP_HEADING');
          break;
        }

        if (currentQuestion === undefined) {
          addIssue(lineNumber, 'FOLLOW_UP_BEFORE_MAIN_QUESTION');
          break;
        }

        followUpHeadingLine = lineNumber;
        followUpCountAtHeading = currentQuestion.followUps.length;
        break;
      }

      case 'bullet': {
        sawContentBeforeTitle = titleHeadingLine === undefined;
        finishPendingMainQuestion();

        if (followUpHeadingLine === undefined || currentQuestion === undefined) {
          addIssue(lineNumber, 'FOLLOW_UP_OUTSIDE_LIST');
          break;
        }

        if (token.value.length === 0) {
          addIssue(lineNumber, 'FOLLOW_UP_TEXT_EMPTY');
          break;
        }
        if (token.value.length > MAXIMUM_QUESTION_CHARACTERS) {
          addIssue(lineNumber, 'FOLLOW_UP_TEXT_TOO_LONG');
        }

        currentQuestion.followUps.push({ line: lineNumber, text: token.value });
        break;
      }

      case 'unexpected-heading': {
        sawContentBeforeTitle = titleHeadingLine === undefined;
        finishPendingMainQuestion();
        addIssue(lineNumber, 'UNEXPECTED_HEADING');
        break;
      }

      case 'content': {
        sawContentBeforeTitle = titleHeadingLine === undefined;

        if (pendingMainQuestion !== undefined) {
          const pending = pendingMainQuestion;
          pendingMainQuestion = undefined;

          if (token.value.length > MAXIMUM_QUESTION_CHARACTERS) {
            addIssue(lineNumber, 'MAIN_QUESTION_TEXT_TOO_LONG');
          }

          if (pending.section !== undefined) {
            currentQuestion = {
              line: pending.line,
              text: token.value,
              followUps: [],
            };
            pending.section.mainQuestions.push(currentQuestion);
          }
          break;
        }

        addIssue(lineNumber, 'UNEXPECTED_CONTENT');
        break;
      }
    }
  }

  finishSection();

  if (titleHeadingLine === undefined) {
    addIssue(1, 'TITLE_MISSING');
  }

  const mainQuestionCount = sections.reduce(
    (count, section) => count + section.mainQuestions.length,
    0,
  );
  if (mainQuestionCount === 0) {
    addIssue(title?.line ?? 1, 'NO_MAIN_QUESTION');
  }

  if (issues.length > 0 || title === undefined) {
    return { success: false, issues };
  }

  return { success: true, guide: materializeGuide(title.value, sections, sourceLanguage) };
}

function validateGuideCardinality(
  lines: readonly string[],
  sourceLanguage: SupportedLocale,
): GuideParseIssue | undefined {
  const messages = ISSUE_MESSAGES[sourceLanguage];
  let sectionCount = 0;
  let mainQuestionCount = 0;
  let followUpQuestionCount = 0;
  for (const [lineIndex, originalLine] of lines.entries()) {
    const token = classifyLine(originalLine.trimEnd(), sourceLanguage);
    if (token.kind === 'section') sectionCount += 1;
    if (token.kind === 'main-question-heading') mainQuestionCount += 1;
    if (token.kind === 'bullet') followUpQuestionCount += 1;

    const line = lineIndex + 1;
    if (sectionCount > INTERVIEW_GUIDE_LIMITS.maximumSections) {
      return { line, code: 'TOO_MANY_SECTIONS', message: messages.TOO_MANY_SECTIONS };
    }
    if (mainQuestionCount > INTERVIEW_GUIDE_LIMITS.maximumMainQuestions) {
      return {
        line,
        code: 'TOO_MANY_MAIN_QUESTIONS',
        message: messages.TOO_MANY_MAIN_QUESTIONS,
      };
    }
    if (followUpQuestionCount > INTERVIEW_GUIDE_LIMITS.maximumFollowUpQuestions) {
      return {
        line,
        code: 'TOO_MANY_FOLLOW_UP_QUESTIONS',
        message: messages.TOO_MANY_FOLLOW_UP_QUESTIONS,
      };
    }
    if (mainQuestionCount + followUpQuestionCount > INTERVIEW_GUIDE_LIMITS.maximumTotalQuestions) {
      return { line, code: 'TOO_MANY_QUESTIONS', message: messages.TOO_MANY_QUESTIONS };
    }
  }
  return undefined;
}

function countSourceLines(source: string): number {
  let lines = 1;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === '\n') {
      lines += 1;
    } else if (character === '\r') {
      lines += 1;
      if (source[index + 1] === '\n') index += 1;
    }
    if (lines > MAXIMUM_GUIDE_LINES) return lines;
  }
  return lines;
}

function classifyLine(line: string, sourceLanguage: SupportedLocale): ClassifiedLine {
  const mainQuestionHeading =
    sourceLanguage === 'de' ? /^###[ \t]+Hauptfrage$/u : /^###[ \t]+Main question$/u;
  if (mainQuestionHeading.test(line)) {
    return { kind: 'main-question-heading' };
  }

  const followUpHeading =
    sourceLanguage === 'de' ? /^####[ \t]+Vertiefungsfragen$/u : /^####[ \t]+Follow-up questions$/u;
  if (followUpHeading.test(line)) {
    return { kind: 'follow-up-heading' };
  }

  const title = /^#(?:[ \t]+(.*))?$/u.exec(line);
  if (title !== null) {
    return { kind: 'title', value: (title[1] ?? '').trim() };
  }

  const section = /^##(?:[ \t]+(.*))?$/u.exec(line);
  if (section !== null) {
    return { kind: 'section', value: (section[1] ?? '').trim() };
  }

  const bullet = /^-(?:[ \t]+(.*))?$/u.exec(line);
  if (bullet !== null) {
    return { kind: 'bullet', value: (bullet[1] ?? '').trim() };
  }

  if (/^#+(?:[ \t]|$)/u.test(line)) {
    return { kind: 'unexpected-heading' };
  }

  return { kind: 'content', value: line.trim() };
}

function materializeGuide(
  title: string,
  rawSections: readonly RawSection[],
  sourceLanguage: SupportedLocale,
): ParsedInterviewGuide {
  const normalizedTitle = normalizeGuideIdentityPart(title);
  const normalizedStructure = JSON.stringify({
    ...(sourceLanguage === 'en' ? { sourceLanguage } : {}),
    title: normalizedTitle,
    sections: rawSections.map((section, position) => ({
      position,
      title: normalizeGuideIdentityPart(section.title),
      mainQuestions: section.mainQuestions.map((question, questionPosition) => ({
        position: questionPosition,
        text: normalizeGuideIdentityPart(question.text),
        followUpQuestions: question.followUps.map((followUp, followUpPosition) => ({
          position: followUpPosition,
          text: normalizeGuideIdentityPart(followUp.text),
        })),
      })),
    })),
  });
  const guideId = createStableGuideEntityId('guide', [normalizedStructure], 1);

  const sections: ParsedGuideSection[] = rawSections.map((rawSection, sectionPosition) => {
    const normalizedSectionTitle = normalizeGuideIdentityPart(rawSection.title);
    const sectionHierarchy = [guideId, String(sectionPosition), normalizedSectionTitle];
    const sectionId = createStableGuideEntityId('section', sectionHierarchy, 1);

    const mainQuestions: ParsedMainQuestion[] = rawSection.mainQuestions.map(
      (rawQuestion, questionPosition) => {
        const normalizedQuestionText = normalizeGuideIdentityPart(rawQuestion.text);
        const questionHierarchy = [
          guideId,
          sectionId,
          String(questionPosition),
          normalizedQuestionText,
        ];
        const questionId = createStableGuideEntityId('main-question', questionHierarchy, 1);

        return {
          id: questionId,
          position: questionPosition,
          text: rawQuestion.text,
          followUpQuestions: rawQuestion.followUps.map((rawFollowUp, followUpPosition) => {
            const normalizedFollowUpText = normalizeGuideIdentityPart(rawFollowUp.text);

            return {
              id: createStableGuideEntityId(
                'follow-up',
                [guideId, questionId, String(followUpPosition), normalizedFollowUpText],
                1,
              ),
              position: followUpPosition,
              text: rawFollowUp.text,
            };
          }),
        };
      },
    );

    return {
      id: sectionId,
      position: sectionPosition,
      title: rawSection.title,
      mainQuestions,
    };
  });

  return { id: guideId, sourceLanguage, title, sections };
}
