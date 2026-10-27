import { z } from 'zod';

export const supportedLocaleSchema = z.enum(['de', 'en']);

export const DEFAULT_LOCALE = 'de' as const;

export const localeTagBySupportedLocale = Object.freeze({
  de: 'de-DE',
  en: 'en-GB',
} satisfies Readonly<Record<SupportedLocale, string>>);

export type SupportedLocale = z.infer<typeof supportedLocaleSchema>;

export function localeTag(locale: SupportedLocale): string {
  return localeTagBySupportedLocale[locale];
}
