import { strict as assert } from 'node:assert';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const origin = process.env['STUDIO_URL'] ?? 'http://localhost:5275';
const screenshots = 'test-results/studio-management-browser';
const errors = [];
const blockedWrites = [];
let page;
const browser = await chromium.launch({
  executablePath:
    process.env['BROWSER_EXECUTABLE_PATH'] ??
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});

try {
  await mkdir(screenshots, { recursive: true });
  const context = await browser.newContext({
    locale: 'de-DE',
    viewport: { width: 1440, height: 900 },
  });
  // Read the deployed app, but never modify interviews or invoke a provider.
  await context.route('**/api/**', async (route) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(route.request().method())) {
      blockedWrites.push(`${route.request().method()} ${route.request().url()}`);
      return route.abort();
    }
    return route.continue();
  });
  await context.route('https://api.openai.com/**', (route) => {
    blockedWrites.push('Provider call');
    return route.abort();
  });
  page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('dialog', (dialog) => dialog.accept());
  await page.goto(origin, { waitUntil: 'networkidle' });
  const language = page.locator('.language-switcher select');
  await language.selectOption('en');
  await page.getByRole('heading', { name: /Interviews with answers/ }).waitFor();
  await page.reload({ waitUntil: 'networkidle' });
  assert.equal(await language.inputValue(), 'en');
  await waitForManagement(page);

  await page
    .getByRole('button', { name: /^Rename interview:/ })
    .first()
    .click();
  await page.getByRole('dialog', { name: 'Rename interview', exact: true }).waitFor();
  await page.locator('#rename-interview-name').fill('Read-only rename preview');
  assert.equal(await page.getByRole('button', { name: 'Save', exact: true }).isEnabled(), true);
  await page.screenshot({ path: join(screenshots, 'rename-desktop-en.png'), fullPage: true });
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();

  await page.locator('button[aria-label^="Delete interview:"]:not(:disabled)').first().click();
  const deletion = page.getByRole('dialog', { name: 'Delete interview', exact: true });
  await deletion.waitFor();
  assert.equal(await deletion.getByText('The guide and evaluation profiles are kept.').count(), 1);
  assert.equal(
    await deletion
      .getByRole('button', { name: 'Cancel' })
      .evaluate((el) => el === document.activeElement),
    true,
  );
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();

  await page
    .getByRole('button', { name: 'Select or manage evaluation profile', exact: true })
    .click();
  await page.getByRole('button', { name: 'Manage profile', exact: true }).click();
  const name = page.locator('#profile-name');
  await name.waitFor();
  await name.fill('Unsaved language-switch test');
  await language.selectOption('de');
  assert.equal(await name.inputValue(), 'Unsaved language-switch test');
  await page.getByRole('button', { name: 'Auswertungen', exact: true }).waitFor();
  await language.selectOption('en');
  assert.equal(await name.inputValue(), 'Unsaved language-switch test');
  await page.getByRole('button', { name: 'Evaluations', exact: true }).click();
  await page.getByRole('heading', { name: /Interviews with answers/ }).waitFor();
  await waitForManagement(page);
  await page.screenshot({ path: join(screenshots, 'directory-desktop-en.png'), fullPage: true });
  await assertNoOverflow(page);

  await language.selectOption('de');
  await page.getByRole('heading', { name: /Interviews mit Antworten/ }).waitFor();
  await page
    .getByRole('button', { name: /^Interview umbenennen:/ })
    .first()
    .click();
  await page.getByRole('dialog', { name: 'Interview umbenennen', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Abbrechen', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Interview ausw\u00e4hlen', exact: true }).click();
  await assertNoOverflow(page);
  await page.screenshot({ path: join(screenshots, 'directory-mobile-de.png'), fullPage: true });
  await page
    .getByRole('button', { name: /^Interview umbenennen:/ })
    .first()
    .click();
  await page.getByRole('dialog', { name: 'Interview umbenennen', exact: true }).waitFor();
  await assertNoOverflow(page);
  await page.screenshot({ path: join(screenshots, 'rename-mobile-de.png'), fullPage: true });
  await page.getByRole('button', { name: 'Abbrechen', exact: true }).click();
  assert.deepEqual(errors, []);
  assert.deepEqual(blockedWrites, []);
  console.log(
    JSON.stringify({
      localePersists: true,
      draftPreserved: true,
      renameDialog: true,
      deleteConfirmation: true,
      responsive: true,
      databaseWrites: 0,
      providerCalls: 0,
      errors,
    }),
  );
} catch (error) {
  if (page) {
    await page.screenshot({ path: join(screenshots, 'failure.png'), fullPage: true });
    console.error(
      await page.evaluate(() => ({
        language: document.documentElement.lang,
        dialogs: [...document.querySelectorAll('[role=dialog]')].map((el) =>
          el.getAttribute('aria-labelledby'),
        ),
        busy: [...document.querySelectorAll('[aria-busy=true]')].map((el) => el.className),
        managementButtons: [...document.querySelectorAll('.interview-directory-actions button')]
          .slice(0, 4)
          .map((el) => ({ disabled: el.disabled, label: el.getAttribute('aria-label') })),
      })),
    );
  }
  throw error;
} finally {
  await browser.close();
}

async function assertNoOverflow(page) {
  const dimensions = await page.evaluate(() => ({
    viewport: window.innerWidth,
    width: document.documentElement.scrollWidth,
  }));
  assert.ok(dimensions.width <= dimensions.viewport, JSON.stringify(dimensions));
}

async function waitForManagement(page) {
  await page.waitForFunction(() => {
    const button = document.querySelector('.interview-directory-actions button');
    return button !== null && !button.disabled;
  });
}
