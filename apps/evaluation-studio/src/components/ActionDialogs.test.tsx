import type { EvaluationProfile, SupportedLocale } from '@orgscience/contracts';
import { LocaleProvider } from '@orgscience/frontend-i18n';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { starterProfileContent } from '../profile-draft.js';
import { DeleteProfileDialog, DuplicateProfileDialog } from './ActionDialogs.js';

const profile: EvaluationProfile = {
  ...starterProfileContent(),
  profileId: 'profile-actions',
  name: 'Mein Profil',
  isDefault: false,
  createdAt: '2026-10-01T10:00:00.000Z',
  updatedAt: '2026-10-01T10:00:00.000Z',
};

describe('localized profile actions', () => {
  it.each(['de', 'en'] as const)(
    'renders duplicate controls in %s without translating the source name',
    (locale) => {
      const html = renderLocalized(
        <DuplicateProfileDialog
          profile={profile}
          busy={false}
          error={null}
          onConfirm={() => undefined}
          onClose={() => undefined}
        />,
        locale,
      );
      expect(html).toContain(locale === 'en' ? 'Duplicate profile' : 'Profil duplizieren');
      expect(html).toContain(
        locale === 'en' ? 'value="Mein Profil Copy"' : 'value="Mein Profil Kopie"',
      );
      expect(html).toContain(
        locale === 'en' ? 'aria-label="Close dialog"' : 'aria-label="Dialog schließen"',
      );
    },
  );

  it.each(['de', 'en'] as const)('renders irreversible delete warning in %s', (locale) => {
    const html = renderLocalized(
      <DeleteProfileDialog
        profile={profile}
        busy
        error={null}
        onConfirm={() => undefined}
        onClose={() => undefined}
      />,
      locale,
    );
    expect(html).toContain(locale === 'en' ? 'Delete permanently' : 'Endgültig löschen');
    expect(html).toContain(
      locale === 'en'
        ? 'This action cannot be undone.'
        : 'Diese Aktion kann nicht rückgängig gemacht werden.',
    );
    expect(html).toContain('Mein Profil');
    expect(html).toContain('profile-actions');
    expect(html).toContain('aria-busy="true"');
  });
});

function renderLocalized(node: ReactNode, locale: SupportedLocale): string {
  return renderToStaticMarkup(<LocaleProvider lockedLocale={locale}>{node}</LocaleProvider>);
}
