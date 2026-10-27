import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  EVALUATION_PROFILE_DOCUMENT_SCHEMA_VERSION,
  evaluationProfilePortableOf,
  evaluationProfileSchema,
} from '@orgscience/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { LocaleProvider } from '@orgscience/frontend-i18n';
import { chromium, type Browser } from 'playwright-core';
import { createServer } from 'vite';
import { describe, expect, it } from 'vitest';

import { App, readStudioView, studioViewFromQuery } from './App.js';
import { starterProfileContent, updateCalculation, updateItemWeight } from './profile-draft.js';

const browserExecutablePath =
  process.env['BROWSER_EXECUTABLE_PATH'] ??
  (process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : chromium.executablePath());

describe('Evaluation Studio primary workspace', () => {
  it('opens evaluations without an explicit profile-management deep link', () => {
    expect(readStudioView()).toBe('evaluation');
    const html = renderToStaticMarkup(
      <LocaleProvider fallbackLocale="de">
        <App />
      </LocaleProvider>,
    );
    expect(html).toContain('Interviews mit Antworten');
    expect(html).toContain('Bewertungsprofil auswählen oder verwalten');
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).not.toContain('class="profile-sidebar"');
    expect(html).not.toContain('Fachlicher Coder-Prompt');
    expect(html).not.toContain('id="evaluation-profile"');
  });
  it('offers an English interface without changing persisted profile or interview content', () => {
    const html = renderToStaticMarkup(
      <LocaleProvider fallbackLocale="en">
        <App />
      </LocaleProvider>,
    );
    expect(html).toContain('Select or manage evaluation profile');
    expect(html).toContain('aria-label="Language"');
    expect(html).toContain('value="en" selected');
    expect(html).not.toContain('Bewertungsprofil auswählen oder verwalten');
  });
  it('keeps profile management explicit and supports previous evaluation deep links', () => {
    expect(studioViewFromQuery('profiles')).toBe('profiles');
    for (const value of [null, 'evaluation', 'runner', 'unexpected']) {
      expect(studioViewFromQuery(value)).toBe('evaluation');
    }
  });

  // Real hook state requires Chrome/Chromium; all profile API calls use an isolated fake.
  it.skipIf(!existsSync(browserExecutablePath))(
    'clears cached formulas and test scores after a same-ID replacement import',
    async () => {
      const profile = evaluationProfileSchema.parse({
        profileId: 'profile-import-reset',
        ...updateCalculation(starterProfileContent(), {
          mode: 'formula',
          expression: 'item("item-1") + 5',
        }),
        isDefault: false,
        createdAt: '2026-10-01T10:00:00.000Z',
        updatedAt: '2026-10-01T10:00:00.000Z',
      });
      const replacement = evaluationProfileSchema.parse({
        ...profile,
        ...updateCalculation(updateItemWeight(starterProfileContent(), 0, 3), {
          mode: 'weighted_mean',
        }),
        updatedAt: '2026-10-01T11:00:00.000Z',
      });
      const server = await createServer({
        root: fileURLToPath(new URL('../../../', import.meta.url)),
        configFile: false,
        server: { host: '127.0.0.1', port: 0 },
        plugins: [
          {
            name: 'profile-import-state-test',
            resolveId: (id) => (id === 'virtual:profile-import-state-test' ? `\0${id}` : undefined),
            load: (id) =>
              id === '\0virtual:profile-import-state-test'
                ? `
                  import { createElement } from 'react';
                  import { createRoot } from 'react-dom/client';
                  import { LocaleProvider } from '@orgscience/frontend-i18n';
                  import { App } from '/apps/evaluation-studio/src/App.tsx';
                  import { studioApi } from '/apps/evaluation-studio/src/studio-api.ts';
                  import '/apps/evaluation-studio/src/styles.css';
                  let current = ${JSON.stringify(profile)};
                  const replacement = ${JSON.stringify(replacement)};
                  const api = {
                    ...studioApi,
                    listProfiles: async () => ({ profiles: [current] }),
                    getProfile: async () => ({ profile: current }),
                    getLockedGuardrails: async () => { throw new Error('Isolated guardrails'); },
                    previewJsonImport: async (document) => ({ valid: true, profile: document.profile }),
                    confirmJsonImport: async (request) => {
                      if (request.mode !== 'replace' || request.targetProfileId !== current.profileId)
                        throw new Error('Expected same-ID replacement');
                      current = replacement;
                      return { profile: current };
                    },
                  };
                  createRoot(document.getElementById('root')).render(
                    createElement(LocaleProvider, { lockedLocale: 'en' }, createElement(App, { api })),
                  );
                `
                : undefined,
          },
        ],
      });
      let browser: Browser | undefined;
      try {
        await server.listen();
        browser = await chromium.launch({ headless: true, executablePath: browserExecutablePath });
        const context = await browser.newContext();
        const unexpectedApiCalls: string[] = [];
        await context.route('**/api/v1/**', (route) => {
          unexpectedApiCalls.push(route.request().url());
          return route.abort();
        });
        await context.route('https://**/*', (route) => route.abort());
        await context.route('**/profile-import-state-test?*', (route) =>
          route.fulfill({
            contentType: 'text/html',
            body: '<div id="root"></div><script type="module" src="/@id/virtual:profile-import-state-test"></script>',
          }),
        );
        const page = await context.newPage();
        page.on('dialog', (dialog) => void dialog.accept());
        const origin = server.resolvedUrls?.local[0];
        if (origin === undefined) throw new Error('Missing isolated Vite origin');
        await page.goto(
          `${origin}profile-import-state-test?view=profiles&profileId=${profile.profileId}`,
        );
        const expression = page.getByRole('textbox', { name: 'Formula expression' });
        await expression.waitFor();
        await expression.fill('item("item-1") + 10');
        const testScore = page.getByRole('spinbutton', { name: 'Test score: Item 1' });
        await testScore.fill('6');
        expect(await page.locator('.calculation-preview output strong').textContent()).toBe('16');
        await page.getByRole('button', { name: 'Import profile', exact: true }).click();
        await page.locator('input[type=file]').setInputFiles({
          name: 'weighted.json',
          mimeType: 'application/json',
          buffer: Buffer.from(
            JSON.stringify({
              schemaVersion: EVALUATION_PROFILE_DOCUMENT_SCHEMA_VERSION,
              profile: evaluationProfilePortableOf(replacement),
            }),
          ),
        });
        await page.getByRole('radio', { name: /Replace selected profile/u }).check();
        await page.getByRole('button', { name: 'Confirm import', exact: true }).click();
        await page.getByRole('dialog').waitFor({ state: 'hidden' });
        expect(await testScore.inputValue()).toBe('');
        expect(await page.locator('#item-0-weight').inputValue()).toBe('3');
        expect(
          await page
            .getByRole('button', { name: 'Weighted mean', exact: true })
            .getAttribute('aria-pressed'),
        ).toBe('true');
        expect(await page.locator('.calculation-preview output strong').textContent()).toBe(
          'Not calculated',
        );
        await page.getByRole('button', { name: 'Formula', exact: true }).click();
        expect(await expression.inputValue()).toBe('');
        expect(unexpectedApiCalls).toEqual([]);
      } finally {
        await browser?.close();
        await server.close();
      }
    },
    30_000,
  );
});
