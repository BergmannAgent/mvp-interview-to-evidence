import type { SupportedLocale } from '@orgscience/contracts';

export function exactSpeechInstructions(text: string, language: SupportedLocale): string {
  const rules =
    language === 'en'
      ? [
          'Speak only the delimited text below.',
          'Repeat it verbatim, completely, and exactly once.',
          'Do not add a greeting, explanation, answer, or another question.',
        ]
      : [
          'Sprich ausschließlich den nachfolgend abgegrenzten Text.',
          'Gib ihn wortgetreu, vollständig und genau einmal wieder.',
          'Füge keine Begrüßung, Erklärung, Antwort oder weitere Frage hinzu.',
        ];
  return [...rules, '<spoken_text>', text, '</spoken_text>'].join('\n');
}
