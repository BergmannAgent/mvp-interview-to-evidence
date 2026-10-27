import { mkdir } from 'node:fs/promises';
import { strict as assert } from 'node:assert';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const interviewOrigin = process.env['INTERVIEW_ORIGIN'] ?? 'http://localhost:5273';
const monitoringOrigin = process.env['MONITORING_ORIGIN'] ?? 'http://localhost:5274';
const backendOrigin = process.env['BACKEND_ORIGIN'] ?? 'http://localhost:3100';
const screenshotDirectory = process.env['SCREENSHOT_DIRECTORY'] ?? 'docs/screenshots';
const browserExecutablePath =
  process.env['BROWSER_EXECUTABLE_PATH'] ??
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const enableScoring = process.env['BILINGUAL_ENABLE_SCORING'] === '1';
let context;
let originalEnglishSetting;
let uploadedGuideId;

await mkdir(screenshotDirectory, { recursive: true });

const browser = await chromium.launch({
  headless: true,
  executablePath: browserExecutablePath,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});

try {
  context = await browser.newContext({
    permissions: ['microphone', 'camera'],
    locale: 'de-DE',
    viewport: { width: 1440, height: 900 },
  });
  const interview = await context.newPage();
  const monitoring = await context.newPage();
  const browserErrors = [];
  let interviewCreateRequests = 0;
  interview.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/v1/interviews') {
      interviewCreateRequests += 1;
    }
  });
  const settingsResponse = await context.request.get(`${backendOrigin}/api/v1/interview-settings`);
  assert.equal(settingsResponse.status(), 200);
  originalEnglishSetting = (await settingsResponse.json()).settings.find(
    (setting) => setting.language === 'en',
  );
  assert.ok(
    originalEnglishSetting,
    'An explicit English guide setting is required for this smoke test.',
  );

  for (const [name, page] of [
    ['interview', interview],
    ['monitoring', monitoring],
  ]) {
    page.on('pageerror', (error) => browserErrors.push(`${name}: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error' && !message.text().startsWith('Failed to load resource:')) {
        browserErrors.push(`${name}: ${message.text()}`);
      }
    });
  }

  await interview.goto(interviewOrigin, { waitUntil: 'networkidle' });
  assert.equal(await interview.locator('html').getAttribute('lang'), 'de');
  await interview.getByRole('button', { name: 'Mikrofon einschalten' }).waitFor();
  await interview.screenshot({
    path: join(screenshotDirectory, 'interview-premeeting-de.png'),
    fullPage: true,
  });

  const languageSelect = interview.locator('.language-switcher select');
  await interview.getByRole('button', { name: 'Interview starten' }).waitFor({ state: 'visible' });
  await interview.waitForFunction(
    () => !document.querySelector('.language-switcher select')?.disabled,
  );
  await languageSelect.focus();
  await languageSelect.selectOption('en');
  await interview.waitForFunction(() => document.documentElement.lang === 'en');
  assert.equal(await languageSelect.inputValue(), 'en');
  assert.equal(await interview.locator('html').getAttribute('lang'), 'en');
  await interview.reload({ waitUntil: 'networkidle' });
  assert.equal(await interview.getByLabel('Interview language').inputValue(), 'en');
  assert.equal(await interview.locator('html').getAttribute('lang'), 'en');
  await interview.getByRole('button', { name: 'Turn microphone on' }).waitFor();
  await interview.getByRole('button', { name: 'Interview settings', exact: true }).click();
  await interview.getByRole('dialog', { name: 'Interview settings' }).waitFor();

  const invalidGuide = [
    '# Interviewleitfaden: Falsche Sprache',
    '',
    '## Abschnitt',
    '',
    '### Hauptfrage',
    'Was passiert?',
  ].join('\n');
  await interview.locator('input[type=file]').setInputFiles({
    name: 'invalid-language.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from(invalidGuide),
  });
  await interview.getByText('The guide does not match the expected Markdown structure.').waitFor();

  const guide = [
    '# Interview guide: Bilingual Browser Acceptance',
    '',
    '## Resilience under pressure',
    '',
    '### Main question',
    'How does your organization respond when difficult conditions threaten operations?',
    '',
  ].join('\n');
  const importResponsePromise = interview.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === '/api/v1/guides',
  );
  await interview.locator('input[type=file]').setInputFiles({
    name: 'browser-acceptance.en.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from(guide),
  });
  const importResponse = await importResponsePromise;
  assert.ok(importResponse.ok());
  uploadedGuideId = (await importResponse.json()).interviewGuide.id;
  await interview.waitForFunction(
    (guideId) => document.querySelector('.settings-guide-select select')?.value === guideId,
    uploadedGuideId,
  );
  assert.equal(interviewCreateRequests, 0, 'Uploading a guide must not create an interview.');
  const saveResponsePromise = interview.waitForResponse(
    (response) =>
      response.request().method() === 'PUT' &&
      new URL(response.url()).pathname === '/api/v1/interview-settings/en',
  );
  await interview.getByRole('button', { name: 'Save selection', exact: true }).click();
  assert.equal((await saveResponsePromise).status(), 200);
  await interview.getByRole('dialog', { name: 'Interview settings' }).waitFor({ state: 'hidden' });
  assert.equal(interviewCreateRequests, 0, 'Saving a guide setting must not create an interview.');
  await interview.reload({ waitUntil: 'networkidle' });
  await interview
    .locator('.configured-guide')
    .filter({ hasText: guide.split('\n')[0].slice(2) })
    .waitFor();
  await interview.getByRole('button', { name: 'Start interview' }).waitFor({ state: 'visible' });
  await interview.evaluate(() => window.scrollTo(0, 0));
  await interview.screenshot({
    path: join(screenshotDirectory, 'interview-premeeting-en.png'),
    fullPage: true,
  });

  const createResponsePromise = interview.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === '/api/v1/interviews',
  );
  const startResponsePromise = interview.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      /^\/api\/v1\/interviews\/[^/]+\/start$/u.test(new URL(response.url()).pathname),
  );
  await interview.getByRole('button', { name: 'Start interview' }).click();
  const createPayload = await (await createResponsePromise).json();
  const interviewId = createPayload.interviewState.interviewId;
  assert.equal(createPayload.interviewState.language, 'en');
  assert.equal(interviewCreateRequests, 1);
  const startResponse = await startResponsePromise;
  assert.equal(startResponse.status(), 200);
  assert.equal(new URL(startResponse.url()).pathname, `/api/v1/interviews/${interviewId}/start`);
  const startPayload = await startResponse.json();
  const firstAiTurn = startPayload.newAiTurns.at(-1);
  assert.ok(firstAiTurn);
  await monitoring.goto(`${monitoringOrigin}/?interview=${interviewId}`, {
    waitUntil: 'domcontentloaded',
  });
  await monitoring.getByText('LIVE MONITOR').waitFor();
  await monitoring.getByText(guide.split('\n')[0].slice(2), { exact: true }).first().waitFor();
  await monitoring.getByText(firstAiTurn.text, { exact: true }).first().waitFor();
  await interview.getByRole('button', { name: 'Send answer' }).waitFor();
  assert.equal(await interview.locator('html').getAttribute('lang'), 'en');
  assert.equal(
    await interview.locator('.language-switcher').count(),
    0,
    'Language switching is hidden in the active meeting.',
  );

  const firstAnswer = 'We remain stable.';
  await submitAnswer(interview, interviewId, firstAnswer);
  await monitoring.getByText(firstAnswer, { exact: true }).first().waitFor();
  let session = await readSession(context, interviewId);
  const clarification = [...session.transcript]
    .reverse()
    .find((turn) => turn.speaker === 'ai_interviewer');
  if (clarification?.turnType === 'clarification_question') {
    assert.match(clarification.text, /example|specifically|concrete|what|how|which|who/i);
    await submitAnswer(
      interview,
      interviewId,
      'For example, during a supplier outage last year, we reassigned production work within two hours, kept customer service running, and our operations director coordinated procurement and logistics.',
    );
    session = await readSession(context, interviewId);
  } else {
    assert.equal(clarification?.turnType, 'closing');
  }
  if (session.status !== 'completed') {
    const endResponsePromise = interview.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === `/api/v1/interviews/${interviewId}/end`,
    );
    await interview.getByRole('button', { name: 'End interview' }).click();
    assert.equal((await endResponsePromise).status(), 200);
    session = await readSession(context, interviewId);
  }
  assert.equal(session.status, 'completed');
  assert.ok(session.finalizedAt);
  assert.ok(session.transcript.some((turn) => turn.turnType === 'closing'));
  await interview.getByText('Final transcript').waitFor();
  await interview.getByLabel('Interface language').waitFor();

  await monitoring.getByText(session.guideTitle, { exact: true }).first().waitFor();
  await monitoring.waitForFunction(
    ({ id, text }) =>
      document.body.innerText.includes(id) && document.body.innerText.includes(text),
    { id: interviewId, text: session.transcript.at(-1).text },
  );
  assert.equal(await monitoring.locator('html').getAttribute('lang'), 'en');
  const pickerBox = await monitoring.locator('.interview-picker').boundingBox();
  const actionsBox = await monitoring.locator('.topbar-actions').boundingBox();
  assert.ok(pickerBox !== null && actionsBox !== null);
  assert.ok(
    pickerBox.x + pickerBox.width <= actionsBox.x,
    JSON.stringify({ pickerBox, actionsBox }),
  );
  const canonicalTexts = session.transcript.map((turn) => turn.text);
  const interviewText = await interview.locator('body').innerText();
  const monitoringText = await monitoring.locator('body').innerText();
  for (const text of canonicalTexts) {
    assert.ok(interviewText.includes(text));
    assert.ok(monitoringText.includes(text));
  }
  await monitoring.screenshot({
    path: join(screenshotDirectory, 'monitoring-en.png'),
    fullPage: true,
  });

  const monitoringLanguage = monitoring.getByLabel('Interface language');
  await monitoringLanguage.selectOption('de');
  await monitoring.waitForFunction(() => document.documentElement.lang === 'de');
  const germanMonitoringText = await monitoring.locator('body').innerText();
  for (const text of canonicalTexts) assert.ok(germanMonitoringText.includes(text));
  await monitoring.screenshot({
    path: join(screenshotDirectory, 'monitoring-de.png'),
    fullPage: true,
  });
  await monitoring.reload({ waitUntil: 'domcontentloaded' });
  assert.equal(await monitoring.locator('html').getAttribute('lang'), 'de');
  assert.equal(await monitoring.getByLabel('Oberflächensprache').inputValue(), 'de');

  await monitoring.setViewportSize({ width: 390, height: 844 });
  await monitoring.waitForTimeout(500);
  const overflow = await monitoring.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
  }));
  assert.ok(overflow.document <= overflow.viewport, JSON.stringify(overflow));
  await monitoring.screenshot({
    path: join(screenshotDirectory, 'monitoring-mobile-de.png'),
    fullPage: true,
  });

  let evaluation = null;
  if (enableScoring) {
    const evaluationStart = await context.request.post(
      `${backendOrigin}/api/v1/interviews/${interviewId}/evaluation`,
      { data: {} },
    );
    assert.equal(evaluationStart.status(), 200);
    evaluation = (await evaluationStart.json()).evaluation;
    for (let attempt = 0; evaluation.status !== 'completed' && attempt < 30; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      evaluation = (
        await (
          await context.request.get(`${backendOrigin}/api/v1/interviews/${interviewId}/evaluation`)
        ).json()
      ).evaluation;
    }
    assert.equal(evaluation.status, 'completed');
    assert.equal(evaluation.report.language, 'en');
    for (const format of ['json', 'csv', 'markdown', 'html']) {
      const response = await context.request.get(
        `${backendOrigin}/api/v1/interviews/${interviewId}/evaluation/export?format=${format}`,
      );
      assert.equal(response.status(), 200);
      assert.ok((await response.body()).byteLength > 0);
    }

    await monitoring.setViewportSize({ width: 1440, height: 900 });
    await monitoring.goto(
      `${monitoringOrigin}/?interview=${interviewId}&view=report&profileId=${evaluation.profileId}`,
      { waitUntil: 'domcontentloaded' },
    );
    await monitoring.getByLabel('Oberflächensprache').selectOption('en');
    await monitoring.getByText('Evaluation report').waitFor();
    await monitoring.screenshot({
      path: join(screenshotDirectory, 'evaluation-report-en.png'),
      fullPage: true,
    });
  }

  assert.deepEqual(browserErrors, []);
  console.log(
    JSON.stringify({
      interviewId,
      language: session.language,
      turns: session.transcript.length,
      clarification:
        clarification?.turnType === 'clarification_question' ? clarification.text : null,
      monitoringLiveTwoTab: true,
      localeRefresh: true,
      mobileOverflow: overflow,
      evaluationStatus: evaluation?.status ?? 'not_requested',
      evaluationProfileId: evaluation?.profileId ?? null,
      browserErrors,
    }),
  );
} finally {
  try {
    if (
      context !== undefined &&
      originalEnglishSetting !== undefined &&
      uploadedGuideId !== undefined
    ) {
      const response = await context.request.get(`${backendOrigin}/api/v1/interview-settings`);
      assert.equal(
        response.status(),
        200,
        'Read settings before restoring the previous English guide.',
      );
      if (response.ok()) {
        const current = (await response.json()).settings.find(
          (setting) => setting.language === 'en',
        );
        if (current?.guideId === uploadedGuideId) {
          const restored = await context.request.put(
            `${backendOrigin}/api/v1/interview-settings/en`,
            { data: { guideId: originalEnglishSetting.guideId } },
          );
          assert.equal(restored.status(), 200, 'Restore the previously configured English guide.');
        }
      }
    }
  } finally {
    await browser.close();
  }
}

async function submitAnswer(page, interviewId, answer) {
  const responsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname === `/api/v1/interviews/${interviewId}/turns`,
  );
  const textarea = page.locator('textarea');
  await textarea.fill(answer);
  await page.getByRole('button', { name: 'Send answer' }).click();
  assert.equal((await responsePromise).status(), 200);
  await page.waitForTimeout(500);
}

async function readSession(context, interviewId) {
  const response = await context.request.get(
    `${backendOrigin}/api/v1/interviews/${interviewId}/session`,
  );
  assert.equal(response.status(), 200);
  return response.json();
}
