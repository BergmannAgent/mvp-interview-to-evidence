import { localeTag, supportedLocaleSchema, type SupportedLocale } from '@orgscience/contracts';

export const DEFAULT_UI_LOCALE = 'en' as const satisfies SupportedLocale;
export const DEFAULT_UI_LOCALE_STORAGE_KEY = 'orgscience.ui.locale.v1';

export interface LocaleStorage {
  getItem(key: string): string | null;
  removeItem(key: string): void;
  setItem(key: string, value: string): void;
}

export function resolveBrowserLocale(
  languages: readonly string[] = browserLanguages(),
): SupportedLocale {
  for (const language of languages) {
    const candidate = language.trim().split('-')[0]?.toLocaleLowerCase('en-US');
    const parsed = supportedLocaleSchema.safeParse(candidate);
    if (parsed.success) return parsed.data;
  }
  return DEFAULT_UI_LOCALE;
}

export function readLocalePreference(
  storageKey = DEFAULT_UI_LOCALE_STORAGE_KEY,
  storage: LocaleStorage | null = browserStorage(),
): SupportedLocale | null {
  if (storage === null) return null;
  try {
    const parsed = supportedLocaleSchema.safeParse(storage.getItem(storageKey));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function writeLocalePreference(
  locale: SupportedLocale | null,
  storageKey = DEFAULT_UI_LOCALE_STORAGE_KEY,
  storage: LocaleStorage | null = browserStorage(),
): void {
  if (storage === null) return;
  try {
    if (locale === null) storage.removeItem(storageKey);
    else storage.setItem(storageKey, locale);
  } catch {
    // Browser storage is optional; the UI remains usable when it is blocked.
  }
}

export function formatDateTime(
  locale: SupportedLocale,
  value: Date | number | string | null,
  options: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'medium' },
): string {
  if (value === null) return '–';
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return '–';
  return new Intl.DateTimeFormat(localeTag(locale), options).format(date);
}

export function formatNumber(
  locale: SupportedLocale,
  value: number,
  options: Intl.NumberFormatOptions = {},
): string {
  return new Intl.NumberFormat(localeTag(locale), options).format(value);
}

export function formatPercent(
  locale: SupportedLocale,
  value: number,
  options: Intl.NumberFormatOptions = { maximumFractionDigits: 0 },
): string {
  return formatNumber(locale, value, { ...options, style: 'percent' });
}

function browserLanguages(): readonly string[] {
  if (typeof navigator === 'undefined') return [];
  return navigator.languages.length > 0 ? navigator.languages : [navigator.language];
}

function browserStorage(): LocaleStorage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
