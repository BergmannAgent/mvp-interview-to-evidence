import {
  EVALUATION_PROFILE_DOCUMENT_SCHEMA_VERSION,
  type SupportedLocale,
} from '@orgscience/contracts';
import { LocaleProvider } from '@orgscience/frontend-i18n';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  starterProfileContent,
  updateAnchor,
  updateCalculation,
  updateDimensionWeight,
  updateItemWeight,
  updateMetadata,
} from '../profile-draft.js';
import type { EvaluationStudioApi, ImportPreview } from '../studio-api.js';
import { ImportDialog, ImportPreviewPanel } from './ImportDialog.js';

describe('ImportDialog', () => {
  it('shows the replacement snapshot immediately and identifies the initial file focus target', () => {
    const html = renderLocalized(
      <ImportDialog
        api={{} as EvaluationStudioApi}
        replaceTarget={{
          profileId: 'profile-captured',
          name: 'Captured profile',
          updatedAt: '2026-08-21T18:42:00.000Z',
        }}
        onImported={() => undefined}
        onClose={() => undefined}
      />,
    );

    expect(html.match(/role="dialog"/gu) ?? []).toHaveLength(1);
    expect(html).toContain('Captured profile');
    expect(html).toContain('profile-captured');
    expect(html).toContain('2026-08-21T18:42:00.000Z');
    expect(html).toContain('data-modal-initial-focus="true"');
    expect(html).toContain('aria-label="JSON-Profil auswählen"');
  });

  it('renders description, full coder prompt, coding instruction, and all real anchors read-only', () => {
    let content = starterProfileContent();
    content = updateMetadata(content, 'description', 'Sentinel profile description.');
    content = updateMetadata(
      content,
      'coderPrompt',
      'Sentinel full coder prompt\nwith an intentional second line.',
    );
    for (let anchorIndex = 0; anchorIndex < 7; anchorIndex += 1) {
      content = updateAnchor(
        content,
        0,
        anchorIndex,
        `Sentinel criterion ${String(anchorIndex + 1)}`,
      );
    }
    const preview: ImportPreview = {
      kind: 'json',
      fileName: 'sentinel.json',
      document: {
        schemaVersion: EVALUATION_PROFILE_DOCUMENT_SCHEMA_VERSION,
        profile: { profileId: 'profile-sentinel', ...content },
      },
    };

    const html = renderLocalized(<ImportPreviewPanel preview={preview} />);

    expect(html).toContain('Sentinel profile description.');
    expect(html).toContain('Sentinel full coder prompt');
    expect(html).toContain('with an intentional second line.');
    expect(html).toContain(content.items[0]?.codingInstruction);
    for (let score = 1; score <= 7; score += 1) {
      expect(html).toContain(`Score ${String(score)}`);
      expect(html).toContain(`Sentinel criterion ${String(score)}`);
    }
    expect(html).not.toContain('<input');
    expect(html).not.toContain('<textarea');
    expect(html).not.toContain('contenteditable');
  });

  it('localizes import actions and replacement labels in English', () => {
    const html = renderLocalized(
      <ImportDialog
        api={{} as EvaluationStudioApi}
        replaceTarget={{
          profileId: 'profile-fixed',
          name: 'Deutscher Profilname',
          updatedAt: '2026-10-01T10:00:00.000Z',
        }}
        onImported={() => undefined}
        onClose={() => undefined}
      />,
      'en',
    );
    expect(html).toContain('Import profile');
    expect(html).toContain('Confirm import');
    expect(html).toContain('Generic template');
    expect(html).toContain('Replace selected profile');
    expect(html).toContain('aria-label="Choose JSON profile"');
    expect(html).toContain('aria-label="Close dialog"');
    expect(html).toContain('Deutscher Profilname');
    expect(html).not.toContain('Profil importieren');
  });

  it('localizes preview labels but preserves German coder instructions and anchors verbatim', () => {
    const content = updateAnchor(
      updateMetadata(
        starterProfileContent(),
        'coderPrompt',
        'Bewerte ausschließlich das belegte Verhalten.',
      ),
      0,
      3,
      'Aufgaben werden im Team besprochen.',
    );
    const preview: ImportPreview = {
      kind: 'json',
      fileName: 'profil.json',
      document: {
        schemaVersion: EVALUATION_PROFILE_DOCUMENT_SCHEMA_VERSION,
        profile: { profileId: 'profile-german', ...content },
      },
    };
    const html = renderLocalized(<ImportPreviewPanel preview={preview} />, 'en');
    expect(html).toContain('Validated preview');
    expect(html).toContain('Complete coder prompt');
    expect(html).toContain('Anchor criteria 1 to 7');
    expect(html).toContain('Bewerte ausschließlich das belegte Verhalten.');
    expect(html).toContain('Aufgaben werden im Team besprochen.');
    expect(html).toContain(content.items[0]?.codingInstruction);
    expect(html).not.toContain('<input');
  });

  it('previews the imported formula and both weight levels without editable controls', () => {
    const content = updateCalculation(
      updateDimensionWeight(updateItemWeight(starterProfileContent(), 0, 3), 0, 2),
      {
        mode: 'formula',
        expression: 'item("item-1") * itemWeight("item-1") + 8',
      },
    );
    const preview: ImportPreview = {
      kind: 'json',
      fileName: 'weighted.json',
      document: {
        schemaVersion: EVALUATION_PROFILE_DOCUMENT_SCHEMA_VERSION,
        profile: { profileId: 'profile-weighted', ...content },
      },
    };
    const english = renderLocalized(<ImportPreviewPanel preview={preview} />, 'en');
    const german = renderLocalized(<ImportPreviewPanel preview={preview} />);
    expect(english).toContain('Formula');
    expect(english).toContain('aria-label="Formula expression"');
    expect(english).toContain('item(&quot;item-1&quot;) * itemWeight(&quot;item-1&quot;) + 8');
    expect(english).toContain('Dimension weight: 2');
    expect(english).toContain('<dt>Item weight</dt><dd>3</dd>');
    expect(english).toContain('<dt>Effective weight</dt><dd>6</dd>');
    expect(german).toContain('Formelausdruck');
    expect(german).toContain('Dimensionsgewicht: 2');
    expect(english).not.toContain('<input');
    expect(english).not.toContain('<textarea');
  });

  it('previews legacy omissions as weighted mean and weights of one', () => {
    const preview: ImportPreview = {
      kind: 'json',
      fileName: 'legacy.json',
      document: {
        schemaVersion: 1,
        profile: { profileId: 'profile-legacy', ...starterProfileContent() },
      },
    };
    const html = renderLocalized(<ImportPreviewPanel preview={preview} />, 'en');
    expect(html).toContain('Weighted mean');
    expect(html).toContain('Dimension weight: 1');
    expect(html).toContain('<dt>Item weight</dt><dd>1</dd>');
    expect(html).toContain('<dt>Effective weight</dt><dd>1</dd>');
  });
});

function renderLocalized(node: ReactNode, locale: SupportedLocale = 'de'): string {
  return renderToStaticMarkup(<LocaleProvider lockedLocale={locale}>{node}</LocaleProvider>);
}
