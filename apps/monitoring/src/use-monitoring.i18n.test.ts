import { translate, type SupportedLocale, type Translate } from '@orgscience/frontend-i18n';
import { describe, expect, it } from 'vitest';

import { monitoringErrorMessage, type MonitoringErrorKind } from './use-monitoring.js';

const errorKinds: readonly MonitoringErrorKind[] = [
  'backend_unavailable',
  'event_history_gap',
  'generic',
  'invalid_json',
  'invalid_response',
  'live_event_gap',
  'request_failed',
  'stream_reset',
];

describe('monitoring error localization', () => {
  it.each(['de', 'en'] as const)('maps every public error state in %s', (locale) => {
    const messages = errorKinds.map((kind) => monitoringErrorMessage(translator(locale), kind));

    expect(messages).toHaveLength(errorKinds.length);
    expect(messages.every((message) => message.trim().length > 0)).toBe(true);
    expect(new Set(messages).size).toBe(errorKinds.length);
  });

  it('does not render provider diagnostics as monitoring reasoning', () => {
    expect(monitoringErrorMessage(translator('en'), 'generic')).not.toContain('stack');
    expect(monitoringErrorMessage(translator('de'), 'generic')).not.toContain('provider');
  });
});

function translator(locale: SupportedLocale): Translate {
  return (key, variables) => translate(locale, key, variables);
}
