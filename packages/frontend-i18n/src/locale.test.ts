import { describe, expect, it, vi } from 'vitest';

import {
  formatDateTime,
  readLocalePreference,
  resolveBrowserLocale,
  writeLocalePreference,
  type LocaleStorage,
} from './locale.js';
import { translate, type MessageKey } from './messages.js';

describe('frontend locale foundation', () => {
  it('resolves supported browser language subtags and falls back to English', () => {
    expect(resolveBrowserLocale(['en-US', 'de-DE'])).toBe('en');
    expect(resolveBrowserLocale(['de-AT'])).toBe('de');
    expect(resolveBrowserLocale(['fr-FR'])).toBe('en');
  });

  it('reads and writes a supported preference without requiring browser storage', () => {
    const values = new Map<string, string>();
    const storage: LocaleStorage = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => void values.set(key, value),
      removeItem: (key) => void values.delete(key),
    };
    writeLocalePreference('en', 'locale', storage);
    expect(readLocalePreference('locale', storage)).toBe('en');
    values.set('locale', 'fr');
    expect(readLocalePreference('locale', storage)).toBeNull();
  });

  it('tolerates blocked browser storage', () => {
    const storage: LocaleStorage = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    };
    expect(readLocalePreference('locale', storage)).toBeNull();
    expect(() => writeLocalePreference('de', 'locale', storage)).not.toThrow();
  });

  it('formats dates by locale and handles invalid timestamps', () => {
    const timestamp = '2026-08-31T13:05:00.000Z';
    expect(formatDateTime('de', timestamp, { timeZone: 'UTC', dateStyle: 'medium' })).toBe(
      '31.08.2026',
    );
    expect(formatDateTime('en', timestamp, { timeZone: 'UTC', dateStyle: 'medium' })).toBe(
      '31 Aug 2026',
    );
    expect(formatDateTime('en', 'invalid')).toBe('–');
  });

  it('interpolates messages and exposes missing runtime keys in development', () => {
    expect(translate('en', 'interview.meeting.progress', { current: 2, total: 5 })).toBe(
      'Question 2 of 5',
    );
    const reportMissing = vi.fn();
    expect(translate('de', 'missing.key' as MessageKey, {}, { reportMissing })).toBe(
      '⟦missing.key⟧',
    );
    expect(reportMissing).toHaveBeenCalledOnce();
  });
});
