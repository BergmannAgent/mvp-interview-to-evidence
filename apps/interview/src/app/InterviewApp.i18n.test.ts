import { translate, type SupportedLocale, type Translate } from '@orgscience/frontend-i18n';
import { describe, expect, it } from 'vitest';

import { InterviewApiError } from '../api/interview-api.js';
import { readErrorMessage } from './InterviewApp.js';

describe('interview error localization', () => {
  it.each([
    [
      'de',
      'OpenAI Voice ist nicht konfiguriert. Hinterlegen Sie OPENAI_API_KEY und starten Sie den Stack neu.',
    ],
    ['en', 'OpenAI Voice is not configured. Set OPENAI_API_KEY and restart the stack.'],
  ] as const)('renders a missing Voice key clearly in %s', (locale, expected) => {
    const providerMessage = 'internal provider configuration detail';
    const error = new InterviewApiError({
      kind: 'http',
      status: 503,
      code: 'VOICE_CONFIGURATION_MISSING',
      message: providerMessage,
    });

    const message = readErrorMessage(error, translator(locale));
    expect(message).toBe(expected);
    expect(message).not.toContain(providerMessage);
  });

  it.each([
    ['de', 'Die OpenAI-Voice-Konfiguration ist ungültig.'],
    ['en', 'The OpenAI Voice configuration is invalid.'],
  ] as const)('renders an invalid Voice configuration clearly in %s', (locale, expected) => {
    const message = readErrorMessage(
      new InterviewApiError({
        kind: 'http',
        status: 503,
        code: 'VOICE_CONFIGURATION_INVALID',
        message: 'internal provider configuration detail',
      }),
      translator(locale),
    );

    expect(message).toContain(expected);
    expect(message).not.toContain('internal provider configuration detail');
  });

  it.each([
    ['de', 'OpenAI Voice ist wegen eines API-Limits nicht verfügbar.'],
    ['en', 'OpenAI Voice is unavailable because of an API limit.'],
  ] as const)('maps browser and API rate limits to a localized %s message', (locale, expected) => {
    const t = translator(locale);
    expect(readErrorMessage(new Error('VOICE_RATE_LIMITED'), t)).toContain(expected);
    expect(
      readErrorMessage(
        new InterviewApiError({
          kind: 'http',
          status: 503,
          code: 'RATE_LIMITED',
          message: 'secret upstream message',
        }),
        t,
      ),
    ).toContain(expected);
  });

  it('contains unknown internal details behind the generic localized boundary', () => {
    expect(readErrorMessage(new Error('sensitive internal detail'), translator('en'))).toBe(
      'The request could not be completed.',
    );
  });
});

function translator(locale: SupportedLocale): Translate {
  return (key, variables) => translate(locale, key, variables);
}
