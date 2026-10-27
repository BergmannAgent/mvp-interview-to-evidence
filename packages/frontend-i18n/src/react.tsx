import type { SupportedLocale } from '@orgscience/contracts';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ChangeEvent,
  type ReactNode,
} from 'react';

import {
  DEFAULT_UI_LOCALE,
  DEFAULT_UI_LOCALE_STORAGE_KEY,
  formatDateTime,
  formatNumber,
  formatPercent,
  readLocalePreference,
  writeLocalePreference,
} from './locale.js';
import { translate, type MessageKey, type MessageVariables, type Translate } from './messages.js';

export interface I18nContextValue {
  readonly locale: SupportedLocale;
  readonly hasLocaleOverride: boolean;
  readonly setLocale: (locale: SupportedLocale) => void;
  readonly clearLocaleOverride: () => void;
  readonly t: Translate;
  readonly formatDateTime: (
    value: Date | number | string | null,
    options?: Intl.DateTimeFormatOptions,
  ) => string;
  readonly formatNumber: (value: number, options?: Intl.NumberFormatOptions) => string;
  readonly formatPercent: (value: number, options?: Intl.NumberFormatOptions) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function LocaleConsumer({
  children,
}: {
  readonly children: (value: I18nContextValue) => ReactNode;
}): ReactNode {
  return children(useI18n());
}

export interface LocaleProviderProps {
  readonly children: ReactNode;
  readonly fallbackLocale?: SupportedLocale;
  readonly lockedLocale?: SupportedLocale | null;
  readonly storageKey?: string;
  readonly reportMissing?: (description: string) => void;
}

export function LocaleProvider({
  children,
  fallbackLocale = DEFAULT_UI_LOCALE,
  lockedLocale,
  storageKey = DEFAULT_UI_LOCALE_STORAGE_KEY,
  reportMissing,
}: LocaleProviderProps): ReactNode {
  const [localeOverride, setLocaleOverride] = useState<SupportedLocale | null>(() =>
    readLocalePreference(storageKey),
  );
  const locale = lockedLocale ?? localeOverride ?? fallbackLocale;

  const setLocale = useCallback(
    (nextLocale: SupportedLocale): void => {
      if (lockedLocale != null) return;
      setLocaleOverride(nextLocale);
      writeLocalePreference(nextLocale, storageKey);
    },
    [lockedLocale, storageKey],
  );
  const clearLocaleOverride = useCallback((): void => {
    if (lockedLocale != null) return;
    setLocaleOverride(null);
    writeLocalePreference(null, storageKey);
  }, [lockedLocale, storageKey]);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  useEffect(() => {
    const handleStorage = (event: StorageEvent): void => {
      if (event.key === storageKey) setLocaleOverride(readLocalePreference(storageKey));
    };
    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, [storageKey]);

  const t = useCallback<Translate>(
    (key: MessageKey, variables?: MessageVariables) =>
      translate(locale, key, variables, {
        ...(reportMissing === undefined ? {} : { reportMissing }),
      }),
    [locale, reportMissing],
  );
  const contextValue = useMemo<I18nContextValue>(
    () => ({
      locale,
      hasLocaleOverride: localeOverride !== null,
      setLocale,
      clearLocaleOverride,
      t,
      formatDateTime: (value, options) => formatDateTime(locale, value, options),
      formatNumber: (value, options) => formatNumber(locale, value, options),
      formatPercent: (value, options) => formatPercent(locale, value, options),
    }),
    [clearLocaleOverride, locale, localeOverride, setLocale, t],
  );

  return <I18nContext.Provider value={contextValue}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const value = useContext(I18nContext);
  if (value === null) throw new Error('useI18n must be used within a LocaleProvider');
  return value;
}

export interface LanguageSwitcherProps {
  readonly className?: string;
  readonly disabled?: boolean;
  readonly label?: string;
}

export function LanguageSwitcher({
  className = '',
  disabled = false,
  label,
}: LanguageSwitcherProps): ReactNode {
  const { locale, setLocale, t } = useI18n();
  const accessibleLabel = label ?? t('common.language.label');

  const handleChange = (event: ChangeEvent<HTMLSelectElement>): void => {
    setLocale(event.target.value === 'en' ? 'en' : 'de');
  };

  return (
    <label className={`language-switcher ${className}`.trim()}>
      <span className="language-switcher__label">{accessibleLabel}</span>
      <select
        aria-label={accessibleLabel}
        disabled={disabled}
        value={locale}
        onChange={handleChange}
      >
        <option value="de">{t('common.language.de')}</option>
        <option value="en">{t('common.language.en')}</option>
      </select>
    </label>
  );
}
