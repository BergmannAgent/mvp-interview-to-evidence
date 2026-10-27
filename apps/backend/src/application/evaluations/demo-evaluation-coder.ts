import {
  DEFAULT_LOCALE,
  type ProfileEvaluationCodingOutput,
  type SupportedLocale,
} from '@orgscience/contracts';

import {
  validateEvaluationCodingOutput,
  type EvaluationGuardrailIssue,
} from './evaluation-guardrails.js';
import type {
  EvaluationCoder,
  EvaluationCodingContext,
  EvaluationCodingInput,
  EvaluationCodingResult,
} from './evaluation-coder.js';

const DEMO_MODEL = Object.freeze({
  mode: 'demo',
  provider: null,
  model: null,
} as const);

interface DemoEvaluationText {
  readonly missingInformation: string;
  readonly itemRationale: string;
  readonly overallRationale: string;
  readonly aborted: string;
  readonly guardrailFailure: string;
}

const DEMO_EVALUATION_TEXT = {
  de: {
    missingInformation: 'Der Demo-Modus nimmt keine fachliche Klassifikation vor.',
    itemRationale:
      'Der deterministische Demo-Coder behaelt jedes Profilitem bei, ohne eine unbelegte Bewertung zu vergeben.',
    overallRationale:
      'Die deterministische profilgesteuerte Demo-Codierung prueft den technischen Ablauf, ohne eine fachliche Bewertung zu erzeugen.',
    aborted: 'Die Auswertungscodierung wurde abgebrochen.',
    guardrailFailure: 'Die Auswertungsausgabe hat die Guardrails nicht bestanden',
  },
  en: {
    missingInformation: 'Demo mode does not perform subject-matter classification.',
    itemRationale:
      'The deterministic demo coder preserves every profile item without assigning an unsupported score.',
    overallRationale:
      'Deterministic profile-driven demo coding verifies the technical flow without producing a subject-matter assessment.',
    aborted: 'Evaluation coding was aborted.',
    guardrailFailure: 'Evaluation output failed guardrails',
  },
} as const satisfies Readonly<Record<SupportedLocale, DemoEvaluationText>>;

export class DemoEvaluationCoder implements EvaluationCoder {
  readonly model = DEMO_MODEL;

  async code(
    input: EvaluationCodingInput,
    context: EvaluationCodingContext,
  ): Promise<EvaluationCodingResult> {
    const messages = demoEvaluationText(input);
    if (context.signal.aborted) return aborted(messages);

    const output: ProfileEvaluationCodingOutput = {
      items: input.profile.profile.items.map((item) => {
        return {
          itemId: item.itemId,
          dimensionId: item.dimensionId,
          status: 'insufficient_evidence',
          score: null,
          confidence: 0,
          supportingEvidence: [],
          counterEvidence: [],
          missingInformation: [messages.missingInformation],
          rationale: messages.itemRationale,
        };
      }),
      rationale: messages.overallRationale,
    };
    const validated = validateEvaluationCodingOutput(input, output);
    if (!validated.ok) return guardrailFailure(validated.issues, messages);
    return { ok: true, output: validated.value };
  }
}

function aborted(messages: DemoEvaluationText): EvaluationCodingResult {
  return {
    ok: false,
    error: {
      code: 'aborted',
      message: messages.aborted,
      retryable: false,
    },
  };
}

function guardrailFailure(
  issues: readonly EvaluationGuardrailIssue[],
  messages: DemoEvaluationText,
): EvaluationCodingResult {
  return {
    ok: false,
    error: {
      code: 'guardrail_rejected',
      message: `${messages.guardrailFailure}: ${issues
        .slice(0, 5)
        .map((issue) => `${issue.code}@${issue.path}`)
        .join(', ')}`,
      retryable: false,
    },
  };
}

export function createDemoEvaluationCoder(): EvaluationCoder {
  return new DemoEvaluationCoder();
}

function demoEvaluationText(input: EvaluationCodingInput): DemoEvaluationText {
  const language = input.session.language === 'en' ? 'en' : DEFAULT_LOCALE;
  return DEMO_EVALUATION_TEXT[language];
}
