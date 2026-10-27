import { strict as assert } from 'node:assert';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

// Exercise the actual UI and hooks against an isolated API, never the user's database or model.
const screenshotDirectory =
  process.env['SCREENSHOT_DIRECTORY'] ?? 'test-results/interview-settings-browser';
const now = '2026-10-01T09:00:00.000Z';
const settings = [
  { language: 'de', guideId: 'settings-guide-de', updatedAt: now },
  { language: 'en', guideId: 'settings-guide-en', updatedAt: now },
];
const guides = new Map([
  ['settings-guide-de', makeGuide('de', 'settings-guide-de', 'Gespeicherter deutscher Leitfaden')],
  ['settings-guide-en', makeGuide('en', 'settings-guide-en', 'Configured English guide')],
]);
const requests = [];
const unexpectedRequests = [];
let currentSession = null;
let createCount = 0;
let browser;

const server = await createServer({
  configFile: false,
  server: { host: '127.0.0.1', port: 0 },
  plugins: [
    {
      name: 'interview-settings-ui-harness',
      resolveId: (id) =>
        ['virtual:settings-ui', 'virtual:locale-controls'].includes(id) ? `\0${id}` : undefined,
      load: (id) => {
        if (id === '\0virtual:settings-ui')
          return `
        import { createElement } from 'react';
        import { createRoot } from 'react-dom/client';
        import { InterviewRoot } from '/apps/interview/src/app/InterviewRoot.tsx';
        import '/apps/interview/src/styles.css';
        createRoot(document.getElementById('root')).render(createElement(InterviewRoot));
      `;
        if (id === '\0virtual:locale-controls')
          return `
        import { createElement } from 'react';
        import { createRoot } from 'react-dom/client';
        import { LocaleProvider, LanguageSwitcher } from '@orgscience/frontend-i18n';
        createRoot(document.getElementById('root')).render(createElement(LocaleProvider, {}, createElement(LanguageSwitcher)));
      `;
        return undefined;
      },
    },
  ],
});

try {
  await mkdir(screenshotDirectory, { recursive: true });
  await server.listen();
  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env['BROWSER_EXECUTABLE_PATH'] ??
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  });
  const context = await browser.newContext({
    permissions: ['camera', 'microphone'],
    locale: 'de-DE',
    viewport: { width: 1440, height: 900 },
  });
  await context.addInitScript(() => {
    window.testStorageObserved = false;
    window.addEventListener('storage', () => {
      window.testStorageObserved = true;
    });
  });
  await context.route('**/settings-ui', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<div id="root"></div><script type="module" src="/@id/virtual:settings-ui"></script>',
    }),
  );
  await context.route('**/locale-controls', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<div id="root"></div><script type="module" src="/@id/virtual:locale-controls"></script>',
    }),
  );
  await context.route('**/api/v1/**', mockApi);
  await context.route('https://api.openai.com/**', (route) => {
    unexpectedRequests.push('External provider call');
    return route.abort();
  });

  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const origin = server.resolvedUrls.local[0];
  await page.goto(`${origin}settings-ui`, { waitUntil: 'networkidle' });
  await page
    .locator('.configured-guide')
    .filter({ hasText: 'Gespeicherter deutscher Leitfaden' })
    .waitFor();
  assert.equal(createCount, 0);
  await page.waitForFunction(() => !document.querySelector('.language-switcher select').disabled);
  await page.locator('.language-switcher select').selectOption('en');
  await page.locator('.configured-guide').filter({ hasText: 'Configured English guide' }).waitFor();
  assert.equal(createCount, 0);
  await page.getByRole('button', { name: 'Interview settings', exact: true }).click();
  await page.getByRole('dialog', { name: 'Interview settings' }).waitFor();
  await page.locator('input[type=file]').setInputFiles({
    name: 'uploaded-test.en.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from(
      '# Interview guide: Uploaded English guide\n\n## Background\n\n### Main question\nWhat changed during the disruption?\n',
    ),
  });
  await page.waitForFunction(
    () =>
      document.querySelector('.settings-guide-select select').value ===
      'settings-guide-uploaded-en',
  );
  assert.equal(createCount, 0, 'Upload is not interview creation.');
  await page.getByRole('button', { name: 'Save selection', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  assert.equal(
    settings.find((setting) => setting.language === 'en').guideId,
    'settings-guide-uploaded-en',
  );
  assert.equal(createCount, 0, 'Saving settings is not interview creation.');
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('.configured-guide').filter({ hasText: 'Uploaded English guide' }).waitFor();
  assert.equal(await page.locator('.language-switcher select').inputValue(), 'en');
  await page.screenshot({
    path: join(screenshotDirectory, 'interview-settings-premeeting-en.png'),
    fullPage: true,
  });

  await page.getByRole('button', { name: 'Start interview', exact: true }).click();
  await page.locator('.meeting-page').waitFor();
  assert.equal(createCount, 1);
  assert.equal(currentSession.language, 'en');
  assert.equal(currentSession.guideId, 'settings-guide-uploaded-en');
  assert.equal(await page.locator('.language-switcher').count(), 0);
  assert.equal(await page.locator('html').getAttribute('lang'), 'en');
  const otherTab = await context.newPage();
  await otherTab.goto(`${origin}locale-controls`, { waitUntil: 'networkidle' });
  await otherTab.locator('.language-switcher select').selectOption('de');
  await page.waitForFunction(() => window.testStorageObserved);
  assert.equal(
    await page.locator('html').getAttribute('lang'),
    'en',
    'Another tab must not change the active interview language.',
  );
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('.meeting-page').waitFor();
  assert.equal(createCount, 1, 'Refresh must restore, not recreate, the interview.');
  assert.equal(await page.locator('html').getAttribute('lang'), 'en');
  assert.equal(await page.locator('.language-switcher').count(), 0);
  await page.screenshot({
    path: join(screenshotDirectory, 'interview-settings-active-en.png'),
    fullPage: true,
  });

  await page.getByRole('button', { name: 'End interview', exact: true }).click();
  await page.locator('.completion-page').waitFor();
  await page.locator('.language-switcher select').waitFor();
  assert.equal(await page.locator('html').getAttribute('lang'), 'de');
  await page.locator('.language-switcher select').selectOption('en');
  await page.getByRole('button', { name: 'New interview', exact: true }).click();
  await page.locator('.configured-guide').filter({ hasText: 'Uploaded English guide' }).waitFor();
  assert.equal(createCount, 1);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Interview settings', exact: true }).click();
  await page.getByRole('dialog').waitFor();
  const overflow = await page.evaluate(() => ({
    viewport: window.innerWidth,
    width: document.documentElement.scrollWidth,
  }));
  assert.ok(overflow.width <= overflow.viewport, JSON.stringify(overflow));
  await page.screenshot({
    path: join(screenshotDirectory, 'interview-settings-mobile-en.png'),
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(unexpectedRequests, []);
  console.log(
    JSON.stringify({
      settingsSavedAndRestored: true,
      uploadCreatesInterview: false,
      interviewCreateCount: createCount,
      activeLanguageLocked: true,
      crossTabLanguageLocked: true,
      refreshRestoresLanguage: true,
      completionUnlocksLanguage: true,
      responsive: true,
      realApiCalls: 0,
      realDatabaseWrites: 0,
      requests: requests.length,
      errors,
    }),
  );
} finally {
  await browser?.close();
  await server.close();
}

function makeGuide(language, id, title) {
  const question =
    language === 'en'
      ? 'What changed during the disruption?'
      : 'Was änderte sich während der Störung?';
  return {
    id,
    sourceLanguage: language,
    title,
    sourceMarkdown:
      language === 'en'
        ? `# ${title}\n\n## Background\n\n### Main question\n${question}\n`
        : `# ${title}\n\n## Allgemeines\n\n### Hauptfrage\n${question}\n`,
    createdAt: now,
    sections: [
      {
        id: `${id}-section`,
        position: 0,
        title: language === 'en' ? 'Background' : 'Allgemeines',
        mainQuestions: [
          { id: `${id}-question`, position: 0, text: question, followUpQuestions: [] },
        ],
      },
    ],
  };
}

function guideReference(guide) {
  return {
    kind: 'main_question',
    guideId: guide.id,
    sectionId: guide.sections[0].id,
    mainQuestionId: guide.sections[0].mainQuestions[0].id,
  };
}

function turn(speaker, turnType, text, reference = null) {
  return {
    turnId: `settings-turn-${currentSession.transcript.length + 1}`,
    interviewId: currentSession.interviewId,
    sequenceNumber: currentSession.transcript.length + 1,
    speaker,
    turnType,
    text,
    occurredAt: now,
    guideReference: reference,
    interrupted: false,
  };
}

async function mockApi(route) {
  const request = route.request();
  const url = new URL(request.url());
  const path = url.pathname;
  const method = request.method();
  requests.push(`${method} ${path}`);
  if (method === 'GET' && path === '/api/v1/interview-settings')
    return route.fulfill({ json: { settings } });
  if (method === 'PUT' && path.startsWith('/api/v1/interview-settings/')) {
    const language = path.split('/').at(-1);
    const { guideId } = request.postDataJSON();
    assert.equal(guides.get(guideId).sourceLanguage, language);
    settings.find((setting) => setting.language === language).guideId = guideId;
    return route.fulfill({ json: { settings } });
  }
  if (method === 'GET' && path === '/api/v1/guides') {
    const language = url.searchParams.get('sourceLanguage');
    return route.fulfill({
      json: {
        guides: [...guides.values()]
          .filter((guide) => guide.sourceLanguage === language)
          .map(({ id, title, sourceLanguage, createdAt }) => ({
            id,
            title,
            sourceLanguage,
            createdAt,
            mainQuestionCount: 1,
            followUpQuestionCount: 0,
          })),
      },
    });
  }
  if (method === 'GET' && path.startsWith('/api/v1/guides/'))
    return route.fulfill({
      json: { interviewGuide: guides.get(decodeURIComponent(path.split('/').at(-1))) },
    });
  if (method === 'POST' && path === '/api/v1/guides') {
    const guide = makeGuide('en', 'settings-guide-uploaded-en', 'Uploaded English guide');
    guides.set(guide.id, guide);
    return route.fulfill({ status: 201, json: { outcome: 'inserted', interviewGuide: guide } });
  }
  if (method === 'POST' && path === '/api/v1/interviews') {
    const { interviewId, guideId, language } = request.postDataJSON();
    const guide = guides.get(guideId);
    assert.equal(language, guide.sourceLanguage);
    createCount += 1;
    currentSession = {
      interviewId,
      guideId,
      language,
      guideTitle: guide.title,
      status: 'ready',
      stateVersion: 0,
      currentQuestionIndex: 0,
      totalQuestions: 1,
      currentQuestion: null,
      startedAt: null,
      endedAt: null,
      updatedAt: now,
      partialTranscript: null,
      transcript: [],
      technicalGaps: [],
      finalizedAt: null,
    };
    return route.fulfill({
      status: 201,
      json: {
        outcome: 'inserted',
        interviewState: {
          interviewId,
          guideId,
          language,
          lifecycle: { status: 'ready' },
          currentMainQuestion: null,
          coverage: [],
          activeWorkflowRunId: null,
          version: 0,
          createdAt: now,
          updatedAt: now,
        },
      },
    });
  }
  if (method === 'GET' && path.endsWith('/session')) return route.fulfill({ json: currentSession });
  if (method === 'POST' && path.endsWith('/start')) {
    const guide = guides.get(currentSession.guideId);
    const reference = guideReference(guide);
    currentSession.status = 'active';
    currentSession.stateVersion = 1;
    currentSession.startedAt = now;
    currentSession.currentQuestion = {
      questionId: reference.mainQuestionId,
      sectionId: reference.sectionId,
      sectionTitle: 'Background',
      kind: 'main',
      text: guide.sections[0].mainQuestions[0].text,
      reference,
    };
    const greeting = turn('ai_interviewer', 'greeting', 'Hello, and thank you for taking part.');
    currentSession.transcript.push(greeting);
    const question = turn(
      'ai_interviewer',
      'main_question',
      guide.sections[0].mainQuestions[0].text,
      reference,
    );
    currentSession.transcript.push(question);
    return route.fulfill({ json: { session: currentSession, newAiTurns: [greeting, question] } });
  }
  if (method === 'POST' && path.endsWith('/end')) {
    const closing = turn('ai_interviewer', 'closing', 'Thank you. The interview is now complete.');
    currentSession.transcript.push(closing);
    Object.assign(currentSession, {
      status: 'completed',
      stateVersion: 2,
      currentQuestionIndex: 1,
      currentQuestion: null,
      endedAt: now,
      finalizedAt: now,
    });
    return route.fulfill({ json: { session: currentSession, newAiTurns: [closing] } });
  }
  unexpectedRequests.push(`${method} ${path}`);
  return route.fulfill({ status: 500, json: { error: 'Unexpected mock API request' } });
}
