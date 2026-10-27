import {
  DEFAULT_LOCALE,
  type ConductorOutput,
  type InterviewDecisionOutput,
  type SupportedLocale,
} from '@orgscience/contracts';

import type { InterviewConductorPromptInput } from './input-schemas.js';

interface DeterministicConductorText {
  readonly closing: string;
  readonly greeting: string;
  readonly transition: string;
  readonly closingRationale: string;
  readonly questionRationale: string;
}

const DETERMINISTIC_CONDUCTOR_TEXT = {
  de: {
    closing: 'Vielen Dank fuer das Gespraech und Ihre Zeit.',
    greeting: 'Guten Tag und vielen Dank fuer Ihre Teilnahme.',
    transition: 'Vielen Dank. Lassen Sie uns zum naechsten Punkt kommen.',
    closingRationale: 'Der Leitfaden ist abgeschlossen und das Interview wird kurz beendet.',
    questionRationale:
      'Die validierte Entscheidung wird unveraendert als eine Frage wiedergegeben.',
  },
  en: {
    closing: 'Thank you for the conversation and for your time.',
    greeting: 'Hello, and thank you for participating.',
    transition: 'Thank you. Let us move on to the next topic.',
    closingRationale: 'The guide is complete, so the interview is closed briefly.',
    questionRationale: 'The validated decision is reproduced unchanged as one question.',
  },
} as const satisfies Readonly<Record<SupportedLocale, DeterministicConductorText>>;

export function createDeterministicConductorOutput(
  input: InterviewConductorPromptInput,
): ConductorOutput {
  const textForLanguage =
    DETERMINISTIC_CONDUCTOR_TEXT[
      input.interviewState.language ?? input.guide.sourceLanguage ?? DEFAULT_LOCALE
    ];
  const action = input.decision.selectedAction;
  if (action.action === 'complete_interview') {
    return {
      action: 'close',
      closingText: textForLanguage.closing,
      referencedTranscriptTurnIds: [...input.decision.referencedTranscriptTurnIds],
      rationale: textForLanguage.closingRationale,
    };
  }

  const text =
    action.action === 'ask_clarification_question'
      ? input.requiredClarificationQuestion
      : input.selectedQuestionText;
  if (text === null) {
    throw new Error('A validated question decision must supply question text.');
  }

  return {
    action: 'ask',
    preface: input.allowGreeting
      ? { turnType: 'greeting', text: textForLanguage.greeting }
      : input.allowTransition
        ? { turnType: 'transition', text: textForLanguage.transition }
        : null,
    question: createQuestion(action, text),
    referencedTranscriptTurnIds: [...input.decision.referencedTranscriptTurnIds],
    rationale: textForLanguage.questionRationale,
  };
}

function createQuestion(
  action: Exclude<
    InterviewDecisionOutput['selectedAction'],
    { readonly action: 'complete_interview' }
  >,
  text: string,
): Extract<ConductorOutput, { readonly action: 'ask' }>['question'] {
  switch (action.action) {
    case 'ask_main_question':
      return { turnType: 'main_question', text, guideReference: action.target };
    case 'ask_follow_up_question':
      return { turnType: 'follow_up_question', text, guideReference: action.target };
    case 'ask_clarification_question':
      return { turnType: 'clarification_question', text, guideReference: action.target };
  }
}
