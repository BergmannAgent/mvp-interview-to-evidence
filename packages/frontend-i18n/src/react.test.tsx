import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LanguageSwitcher, LocaleProvider, useI18n } from './react.js';

describe('LocaleProvider', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('defaults to English for a new visitor even with a German browser language', () => {
    vi.stubGlobal('navigator', { languages: ['de-DE'], language: 'de-DE' });
    const html = renderToStaticMarkup(
      <LocaleProvider storageKey="new-visitor-test">
        <Probe />
      </LocaleProvider>,
    );
    expect(html).toContain('data-locale="en"');
    expect(html).toContain('>Language</output>');
  });

  it('keeps a saved German preference ahead of the English default', () => {
    vi.stubGlobal('window', { localStorage: { getItem: () => 'de' } });
    const html = renderToStaticMarkup(
      <LocaleProvider storageKey="saved-german-test">
        <Probe />
      </LocaleProvider>,
    );
    expect(html).toContain('data-locale="de"');
    expect(html).toContain('>Sprache</output>');
  });

  it('keeps a locked German interview ahead of an English UI preference', () => {
    vi.stubGlobal('window', { localStorage: { getItem: () => 'en' } });
    const html = renderToStaticMarkup(
      <LocaleProvider lockedLocale="de" storageKey="locked-german-test">
        <Probe />
      </LocaleProvider>,
    );
    expect(html).toContain('data-locale="de"');
  });

  it.each([
    ['de', 'Sprache', '1.234,5'],
    ['en', 'Language', '1,234.5'],
  ] as const)(
    'provides typed %s messages, hooks, switcher, and formatting',
    (locale, label, number) => {
      const html = renderToStaticMarkup(
        <LocaleProvider fallbackLocale={locale} storageKey={`provider-test-${locale}`}>
          <Probe />
          <LanguageSwitcher disabled />
        </LocaleProvider>,
      );

      expect(html).toContain(`data-locale="${locale}"`);
      expect(html).toContain(`>${label}</output>`);
      expect(html).toContain(`>${number}</data>`);
      expect(html).toContain(`aria-label="${label}"`);
      expect(html).toContain('disabled=""');
    },
  );

  it('rejects hook use outside the provider boundary', () => {
    expect(() => renderToStaticMarkup(<Probe />)).toThrow(
      'useI18n must be used within a LocaleProvider',
    );
  });

  it('keeps the active interview locale ahead of a different UI preference', () => {
    const html = renderToStaticMarkup(
      <LocaleProvider fallbackLocale="de" lockedLocale="en" storageKey="locked-interview-test">
        <Probe />
      </LocaleProvider>,
    );
    expect(html).toContain('data-locale="en"');
    expect(html).toContain('>Language</output>');
  });
});

function Probe() {
  const { locale, t, formatNumber } = useI18n();
  return (
    <div data-locale={locale}>
      <output>{t('common.language.label')}</output>
      <data>{formatNumber(1_234.5)}</data>
    </div>
  );
}
