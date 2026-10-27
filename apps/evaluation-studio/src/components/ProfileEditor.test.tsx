import type {
  EvaluationProfileLockedGuardrails,
  EvaluationProfileSummary,
  SupportedLocale,
} from '@orgscience/contracts';
import { LocaleProvider } from '@orgscience/frontend-i18n';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  starterProfileContent,
  updateAnchor,
  updateDimension,
  updateItem,
  updateItemWeight,
  updateDimensionWeight,
  validateDraft,
} from '../profile-draft.js';
import { GuardrailsPanel } from './GuardrailsPanel.js';
import { dimensionEditorKey, itemEditorKey, ProfileEditor } from './ProfileEditor.js';
import { ProfileMenu } from './ProfileMenu.js';

describe('Evaluation Studio components', () => {
  it('renders the complete editable profile content and every score anchor', () => {
    const content = starterProfileContent();
    const html = renderLocalized(
      <ProfileEditor
        content={content}
        validation={validateDraft(content)}
        disabled={false}
        onChange={() => undefined}
      />,
    );

    expect(html).toContain('Fachlicher Coder-Prompt');
    expect(html).toContain('Stabile Dimensions-ID');
    expect(html).toContain('Stabile Item-ID');
    expect(html).toContain('Dimensionsgewicht');
    expect(html).toContain('Itemgewicht');
    expect(html).toContain('id="dimension-0-weight"');
    expect(html).toContain('id="item-0-weight"');
    expect(html).toContain('Berechnungsmodus');
    for (let score = 1; score <= 7; score += 1) {
      expect(html).toContain(`id="item-0-anchor-${String(score)}"`);
    }
    expect(html).not.toContain('name="language"');
    expect(html).not.toContain('name="model"');
    expect(html).not.toContain('name="apiKey"');
  });

  it('connects inline anchor errors to the invalid field', () => {
    const content = updateAnchor(starterProfileContent(), 0, 2, '');
    const html = renderLocalized(
      <ProfileEditor
        content={content}
        validation={validateDraft(content)}
        disabled={false}
        onChange={() => undefined}
      />,
    );

    expect(html).toContain('id="item-0-anchor-3"');
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('aria-describedby="item-0-anchor-3-error"');
    expect(html).toContain('id="item-0-anchor-3-error"');
  });

  it('connects localized invalid weight errors to dimension and item inputs', () => {
    const content = updateDimensionWeight(updateItemWeight(starterProfileContent(), 0, -1), 0, NaN);
    const html = renderLocalized(
      <ProfileEditor
        content={content}
        validation={validateDraft(content)}
        disabled={false}
        onChange={() => undefined}
      />,
      'en',
    );
    expect(html).toContain('Dimension weight');
    expect(html).toContain('Item weight');
    expect(html).toContain('aria-describedby="dimension-0-weight-error"');
    expect(html).toContain('aria-describedby="item-0-weight-error"');
    expect(html).toContain('The weight must be a finite number greater than or equal to 0.');
    expect(html).not.toContain('Das Gewicht');
  });

  it('keeps UI keys and input positions stable while editable ids are typed', () => {
    const initial = starterProfileContent();
    const editedDimension = updateDimension(initial, 0, 'dimensionId', 'd');
    const edited = updateItem(editedDimension, 0, 'itemId', 'i');
    const before = renderEditor(initial);
    const after = renderEditor(edited);

    expect(editorKeys(before)).toEqual(editorKeys(after));
    expect(editorKeys(after)).toEqual([dimensionEditorKey(0), itemEditorKey(0)]);
    expect(after).toContain('id="dimension-0-id" value="d"');
    expect(after).toContain('id="item-0-id" value="i"');
    expect(after).not.toContain('data-editor-key="d"');
    expect(after).not.toContain('data-editor-key="i"');
  });

  it('marks the default profile and filters the profile dialog directory', () => {
    const profiles: EvaluationProfileSummary[] = [
      summary('profile-default', 'Default profile', true),
      summary('profile-special', 'Special profile', false),
    ];
    const html = renderLocalized(
      <ProfileMenu
        profiles={profiles}
        selectedProfileId="profile-default"
        search="default"
        loading={false}
        disabled={false}
        error={null}
        onSearch={() => undefined}
        onSelect={() => undefined}
        onCreate={() => undefined}
        onManage={() => undefined}
        onClose={() => undefined}
      />,
    );

    expect(html).toContain('Default profile');
    expect(html).toContain('default-badge');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('role="dialog"');
    expect(html).toContain('Profil verwalten');
    expect(html).not.toContain('Special profile');
  });

  it('presents locked system guardrails without editable controls', () => {
    const html = renderLocalized(
      <GuardrailsPanel
        guardrails={guardrails()}
        loading={false}
        error={null}
        onRetry={() => undefined}
      />,
    );

    expect(html).toContain('Gesperrte System-Guardrails');
    expect(html).toContain('Scorebereich 1 bis 7');
    expect(html).toContain('Nicht editierbar');
    expect(html).not.toContain('<input');
    expect(html).not.toContain('<textarea');
  });

  it('keeps the profile dialog dismissible while read-only profile loading disables actions', () => {
    const html = renderLocalized(
      <ProfileMenu
        profiles={[summary('profile-default', 'Default profile', true)]}
        selectedProfileId="profile-default"
        search=""
        loading
        disabled
        error={null}
        onSearch={() => undefined}
        onSelect={() => undefined}
        onCreate={() => undefined}
        onManage={() => undefined}
        onClose={() => undefined}
      />,
    );
    const buttons = [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/gu)].map(
      (match) => match[0],
    );
    const close = buttons.find((button) => button.includes('aria-label="Dialog schließen"'));
    const option = buttons.find((button) => button.includes('class="profile-menu-option"'));
    const create = buttons.find((button) => button.includes('Neues Profil'));
    expect(close).toBeDefined();
    expect(close).not.toContain('disabled');
    expect(option).toContain('disabled');
    expect(create).toContain('disabled');
    expect(html).toContain('class="profile-menu-list" aria-busy="true"');
  });

  it('localizes editor labels and validation errors without translating editable content', () => {
    let content = starterProfileContent();
    content = updateAnchor(content, 0, 0, 'Das Team bespricht Vorfälle gemeinsam.');
    content = updateAnchor(content, 0, 2, '');
    const html = renderLocalized(
      <ProfileEditor
        content={content}
        validation={validateDraft(content)}
        disabled={false}
        onChange={() => undefined}
      />,
      'en',
    );

    expect(html).toContain('Evaluation coder prompt');
    expect(html).toContain('Stable dimension ID');
    expect(html).toContain('Anchor criteria 1 to 7');
    expect(html).toContain('Technical settings are locked');
    expect(html).toContain('Move Item');
    expect(html).toContain('This field must not be blank.');
    expect(html).not.toContain('Dieses Feld darf nicht leer sein.');
    expect(html).toContain('Das Team bespricht Vorfälle gemeinsam.');
    expect(html).toContain(content.coderPrompt);
  });

  it('localizes guardrail explanations while keeping them read-only', () => {
    const html = renderLocalized(
      <GuardrailsPanel
        guardrails={guardrails()}
        loading={false}
        error={null}
        onRetry={() => undefined}
      />,
      'en',
    );
    expect(html).toContain('Locked system guardrails');
    expect(html).toContain('Score range 1 to 7');
    expect(html).toContain('Only final participant turns may be used as evidence.');
    expect(html).toContain('aria-label="Not editable"');
    expect(html).not.toContain('<input');
  });

  it('localizes the profile menu and close action without altering profile names', () => {
    const html = renderLocalized(
      <ProfileMenu
        profiles={[summary('profile-default', 'Mein Standardprofil', true)]}
        selectedProfileId="profile-default"
        search=""
        loading={false}
        disabled={false}
        error={null}
        onSearch={() => undefined}
        onSelect={() => undefined}
        onCreate={() => undefined}
        onManage={() => undefined}
        onClose={() => undefined}
      />,
      'en',
    );
    expect(html).toContain('Evaluation profile');
    expect(html).toContain('Manage profile');
    expect(html).toContain('New profile');
    expect(html).toContain('aria-label="Close dialog"');
    expect(html).toContain('Mein Standardprofil');
    expect(html).toContain('default-badge');
  });
});

function renderEditor(content: ReturnType<typeof starterProfileContent>): string {
  return renderLocalized(
    <ProfileEditor
      content={content}
      validation={validateDraft(content)}
      disabled={false}
      onChange={() => undefined}
    />,
  );
}

function renderLocalized(node: ReactNode, locale: SupportedLocale = 'de'): string {
  return renderToStaticMarkup(<LocaleProvider lockedLocale={locale}>{node}</LocaleProvider>);
}

function editorKeys(html: string): string[] {
  return [...html.matchAll(/data-editor-key="([^"]+)"/gu)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  );
}

function summary(profileId: string, name: string, isDefault: boolean): EvaluationProfileSummary {
  return {
    profileId,
    name,
    description: `${name} description`,
    isDefault,
    createdAt: '2026-08-21T10:00:00.000Z',
    updatedAt: '2026-08-21T10:00:00.000Z',
  };
}

function guardrails(): EvaluationProfileLockedGuardrails {
  return {
    evidenceSource: 'final_participant_turns_only',
    exactQuotesRequired: true,
    validTurnReferencesRequired: true,
    fabricatedContentForbidden: true,
    hiddenChainOfThoughtForbidden: true,
    structuredOutputLocked: true,
    scoreRangeLocked: 'integer_1_7_or_non_score',
    aggregationLocked: true,
  };
}
