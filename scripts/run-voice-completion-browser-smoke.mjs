import { strict as assert } from 'node:assert';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

// Mount the real React hook. The transport and media are deterministic; no provider key is used.
const harnessModule = `
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { useOpenAiVoice } from '/apps/interview/src/hooks/use-openai-voice.ts';
window.voiceHarness = { transcripts: [], errors: [], results: [], planningIntents: [], plannerRejections: 0 };
function Harness() {
  const h = window.voiceHarness;
  h.voice = useOpenAiVoice({
    onFinalTurn: () => {},
    onTurnIntent: async (intent) => {
      h.planningIntents.push(intent);
      if (h.plannerRejections > 0) {
        h.plannerRejections -= 1;
        return { reason: 'Ask about one specific missing responsibility.' };
      }
      return null;
    },
    onAiTranscriptDone: (transcript) => h.transcripts.push(transcript),
    onError: (error) => h.errors.push(error.message),
  });
  return createElement('div', {}, h.voice.state);
}
createRoot(document.getElementById('root')).render(createElement(Harness));
`;

const server = await createServer({
  configFile: false,
  server: { host: '127.0.0.1', port: 0 },
  plugins: [
    {
      name: 'voice-regression-harness',
      resolveId: (id) => (id === 'virtual:voice-harness' ? '\0voice-harness' : undefined),
      load: (id) => (id === '\0voice-harness' ? harnessModule : undefined),
    },
  ],
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env['BROWSER_EXECUTABLE_PATH'] ??
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  });
  const page = await browser.newPage();
  await page.route('**/voice-regression', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<div id="root"></div><script type="module" src="/@id/virtual:voice-harness"></script>',
    }),
  );
  await page.route('**/voice/session', (route) =>
    route.fulfill({
      json: {
        clientSecret: 'mock-secret',
        expiresAt: 9999999999,
        sessionId: 'mock-session',
        model: 'mock-realtime',
      },
    }),
  );
  await page.route('https://api.openai.com/**', (route) => route.fulfill({ body: 'mock-sdp' }));
  await page.addInitScript(() => {
    class Channel extends EventTarget {
      readyState = 'open';
      sent = [];
      send(data) {
        this.sent.push(JSON.parse(data));
      }
      close() {
        this.readyState = 'closed';
      }
      emit(event) {
        this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(event) }));
      }
    }
    window.RTCPeerConnection = class extends EventTarget {
      connectionState = 'connected';
      createDataChannel() {
        window.voiceChannel = new Channel();
        return window.voiceChannel;
      }
      addTrack() {}
      createOffer() {
        return Promise.resolve({ type: 'offer', sdp: 'mock-sdp' });
      }
      setLocalDescription() {
        return Promise.resolve();
      }
      setRemoteDescription() {
        window.voiceChannel.dispatchEvent(new Event('open'));
        return Promise.resolve();
      }
      close() {
        this.connectionState = 'closed';
      }
    };
    HTMLMediaElement.prototype.play = () => Promise.resolve();
  });
  await page.goto(`${server.resolvedUrls.local[0]}voice-regression`);
  await page.waitForFunction(() => window.voiceHarness?.voice !== undefined);
  await page.evaluate(() => window.voiceHarness.voice.connect('test-interview'));

  // Concurrent planner callers must share one provider request.
  const shared = await page.evaluate(() => {
    const h = window.voiceHarness;
    const first = h.voice.requestTurnPlan();
    const second = h.voice.requestTurnPlan();
    void first.then((value) => h.results.push(value));
    return first === second;
  });
  assert.equal(shared, true);
  await page.waitForFunction(() =>
    window.voiceChannel.sent.some((e) => e.type === 'response.create'),
  );
  assert.equal(
    await page.evaluate(
      () => window.voiceChannel.sent.filter((e) => e.type === 'response.create').length,
    ),
    1,
  );

  // A queued old question must never start after stopPlayback invalidates it.
  await page.evaluate(() => {
    const h = window.voiceHarness;
    void h.voice
      .requestResponse({
        deliveryId: 'old',
        turnType: 'main_question',
        instructions: 'Old question?',
      })
      .then((value) => h.results.push(value));
    h.voice.stopPlayback();
  });
  await page.waitForFunction(() => window.voiceHarness.results.length === 2);
  assert.deepEqual(await page.evaluate(() => window.voiceHarness.results), [null, false]);
  assert.equal(
    await page.evaluate(
      () => window.voiceChannel.sent.filter((e) => e.type === 'response.create').length,
    ),
    1,
  );

  await page.evaluate(() => {
    const h = window.voiceHarness;
    void h.voice
      .requestResponse({
        deliveryId: 'closing',
        turnType: 'closing',
        instructions: 'Speak only: Vielen Dank.',
      })
      .then((value) => h.results.push(value));
  });
  await page.waitForFunction(
    () => window.voiceChannel.sent.filter((e) => e.type === 'response.create').length === 2,
  );
  await page.evaluate(() => {
    const channel = window.voiceChannel;
    const response = channel.sent.filter((e) => e.type === 'response.create').at(-1).response;
    channel.emit({
      type: 'response.created',
      response: { id: 'closing-response', metadata: response.metadata },
    });
    channel.emit({ type: 'output_audio_buffer.started', response_id: 'closing-response' });
    channel.emit({ type: 'output_audio_buffer.cleared', response_id: 'old-response' });
    channel.emit({
      type: 'response.done',
      response: { id: 'old-response', status: 'completed', output: [] },
    });
  });
  assert.equal(await page.evaluate(() => window.voiceHarness.results.length), 2);
  await page.evaluate(() => {
    const channel = window.voiceChannel;
    channel.emit({
      type: 'response.output_audio_transcript.done',
      response_id: 'closing-response',
      item_id: 'closing-item',
      transcript: 'Vielen Dank.',
    });
    channel.emit({
      type: 'response.done',
      response: { id: 'closing-response', status: 'completed', output: [] },
    });
    channel.emit({ type: 'output_audio_buffer.stopped', response_id: 'closing-response' });
  });
  await page.waitForFunction(() => window.voiceHarness.results.length === 3);
  const result = await page.evaluate(() => ({
    transcripts: window.voiceHarness.transcripts,
    errors: window.voiceHarness.errors,
    results: window.voiceHarness.results,
  }));
  assert.equal(result.transcripts.length, 1);
  assert.equal(result.transcripts[0].text, 'Vielen Dank.');
  assert.equal(result.transcripts[0].deliveryId, 'closing');
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.results, [null, false, true]);

  // A rejected clarification gets one repair; delayed original events cannot own that repair.
  await page.evaluate(() => {
    const h = window.voiceHarness;
    h.plannerRejections = 1;
    void h.voice.requestTurnPlan().then((value) => h.results.push(value));
  });
  await page.waitForFunction(
    () => window.voiceChannel.sent.filter((e) => e.type === 'response.create').length === 3,
  );
  await page.evaluate(() => {
    const channel = window.voiceChannel;
    const response = channel.sent.filter((e) => e.type === 'response.create').at(-1).response;
    const original = {
      id: 'plan-original',
      status: 'completed',
      metadata: response.metadata,
      output: [
        {
          type: 'function_call',
          name: 'plan_interview_turn',
          call_id: 'plan-call-original',
          arguments: JSON.stringify({
            action: 'ask_clarification_question',
            questionId: 'main',
            spokenText: 'Wer ist fuer diese Massnahme verantwortlich?',
            answerDisposition: 'partial',
            missingAspect: 'Verantwortung fuer diese Massnahme',
            requestedEvidenceType: 'responsibility',
          }),
        },
      ],
    };
    window.originalPlanResponse = original;
    channel.emit({ type: 'response.created', response: original });
    channel.emit({ type: 'response.done', response: original });
  });
  await page.waitForFunction(
    () => window.voiceChannel.sent.filter((e) => e.type === 'response.create').length === 4,
  );
  await page.evaluate(() => {
    const channel = window.voiceChannel;
    channel.emit({ type: 'response.created', response: window.originalPlanResponse });
    channel.emit({ type: 'response.done', response: window.originalPlanResponse });
    const repair = channel.sent.filter((e) => e.type === 'response.create').at(-1).response;
    channel.emit({
      type: 'response.created',
      response: { id: 'plan-repair', metadata: repair.metadata },
    });
    channel.emit({
      type: 'response.done',
      response: {
        ...window.originalPlanResponse,
        id: 'plan-repair',
        metadata: repair.metadata,
        output: [{ ...window.originalPlanResponse.output[0], call_id: 'plan-call-repair' }],
      },
    });
  });
  await page.waitForFunction(() => window.voiceHarness.results.length === 4);
  assert.deepEqual(
    await page.evaluate(() =>
      window.voiceHarness.planningIntents.map((intent) => intent.repairAttempt),
    ),
    [0, 1],
  );
  assert.deepEqual(await page.evaluate(() => window.voiceHarness.errors), []);
  await page.evaluate(() => window.voiceHarness.voice.disconnect());
  console.log(
    'Voice browser regression passed: shared planning, cancelled queue, stale events, one confirmed closing, one bounded clarification repair.',
  );
} finally {
  await browser?.close();
  await server.close();
}
