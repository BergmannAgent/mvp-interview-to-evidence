import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';

import {
  interviewCreateResponseSchema,
  interviewGuideSchema,
  interviewSettingsResponseSchema,
  MVP_REALTIME_CLIENT_PROTOCOL_HEADER,
  MVP_REALTIME_CLIENT_PROTOCOL_VERSION,
  mvpInterviewSessionSchema,
  mvpRealtimeAppendResponseSchema,
  mvpRealtimeCommandResponseSchema,
  mvpRealtimeTurnIntentRequestSchema,
  voiceSessionResponseSchema,
  type MvpInterviewSession,
  type MvpRealtimeTurnIntentRequest,
  type MvpRealtimeTurnPlan,
} from '@orgscience/contracts';
import { z } from 'zod';

import { exactSpeechInstructions } from '../apps/interview/src/voice-instructions.js';
import { RealtimeResponseError, RealtimeSimulationClient } from './realtime-simulation-client.js';
import {
  SYNTHETIC_PARTICIPANT_LABEL,
  SyntheticParticipant,
} from './realtime-synthetic-participant.js';

const MODEL = 'gpt-realtime-2.1';
const MAXIMUM_QUESTIONS = 80;
const MAXIMUM_RESPONSES = 200;
const API_TIMEOUT_MS = 60_000;
const MAXIMUM_RUN_DURATION_MS = 15 * 60_000;
const RATE_LIMIT_WAIT_MS = 65_000;
const runStartedAt = performance.now();
const API_ORIGIN = (process.env['API_BASE_URL'] ?? 'http://localhost:3100').replace(/\/$/u, '');
const resumeRunId = process.argv[3] === '--resume' ? process.argv[4] : undefined;
const runId =
  resumeRunId ?? `${new Date().toISOString().replace(/[:.]/gu, '-')}-${randomUUID().slice(0, 8)}`;
const interviewId = `synthetic-realtime-de-${runId}`;
const interviewPath = `/api/v1/interviews/${encodeURIComponent(interviewId)}`;
const reportDirectory = resolve('examples/realtime-default-guide-test', runId);
const audioDirectory = resolve('data/realtime-synthetic-audio', runId);
const recordSchema = z.record(z.string(), z.unknown());
const outputSchema = z.array(recordSchema);

interface PlanningRecord {
  readonly intent: MvpRealtimeTurnIntentRequest;
  readonly acceptedPlan: MvpRealtimeTurnPlan | null;
  readonly rejection: string | null;
  readonly latencyMs: number;
}

interface AudioRecord {
  readonly deliveryId: string;
  readonly transcript: string;
  readonly byteCount: number;
  readonly latencyMs: number;
  readonly file: string;
}

const planning: PlanningRecord[] = [];
const audio: AudioRecord[] = [];
let client: RealtimeSimulationClient | null = null;
let session: MvpInterviewSession | null = null;
let providerResponses = 0;
let failure: string | null = null;
let guideQuestions: readonly string[] = [];
let connectionCount = 0;
const recoveredInterruptions: string[] = [];

if (
  process.argv[2] !== '--confirm-provider-calls' ||
  !(
    process.argv.length === 3 ||
    (process.argv.length === 5 &&
      resumeRunId !== undefined &&
      /^[0-9TZ-]+-[a-f0-9]{8}$/u.test(resumeRunId))
  )
) {
  throw new Error(
    'Usage: node --import tsx scripts/run-realtime-synthetic-interview.ts --confirm-provider-calls [--resume RUN_ID] (real paid Realtime requests; no scoring)',
  );
}

try {
  await run();
} catch (error: unknown) {
  failure = error instanceof Error ? error.message : 'SYNTHETIC_INTERVIEW_FAILED';
  if (session !== null) {
    try {
      session = await api(`${interviewPath}/session`, mvpInterviewSessionSchema);
    } catch {
      /* Keep the last acknowledged canonical snapshot. */
    }
  }
  process.exitCode = 1;
  process.stderr.write(`${failure}\n`);
} finally {
  closeClient();
  if (session !== null) await saveReport(session);
}

async function run(): Promise<void> {
  const settings = await api('/api/v1/interview-settings', interviewSettingsResponseSchema);
  const setting = settings.settings.find((entry) => entry.language === 'de');
  if (setting === undefined) throw new Error('NO_CONFIGURED_GERMAN_DEFAULT_GUIDE');
  const { interviewGuide: guide } = await api(
    `/api/v1/guides/${encodeURIComponent(setting.guideId)}`,
    z.strictObject({ interviewGuide: interviewGuideSchema }),
  );
  const canonicalSource = await readFile(
    'guides/interviewleitfaden-organizational-resilience-9-items.md',
    'utf8',
  );
  if (
    guide.sourceMarkdown.replace(/\r\n?/gu, '\n').trim() !==
    canonicalSource.replace(/\r\n?/gu, '\n').trim()
  )
    throw new Error('GERMAN_DEFAULT_DIFFERS_FROM_SYNTHETIC_FIXTURE_GUIDE');
  const participant = new SyntheticParticipant(guide);
  guideQuestions = guide.sections.flatMap((section) =>
    section.mainQuestions.flatMap((question) => [
      question.text,
      ...question.followUpQuestions.map((followUp) => followUp.text),
    ]),
  );
  if (resumeRunId === undefined) {
    await api('/api/v1/interviews', interviewCreateResponseSchema, {
      interviewId,
      guideId: guide.id,
      language: 'de',
    });
    await api(
      interviewPath,
      z.unknown(),
      { displayName: `${SYNTHETIC_PARTICIPANT_LABEL} - Realtime 2.1 (${runId})` },
      'PATCH',
    );
  } else {
    const previous = recordSchema.parse(
      JSON.parse(await readFile(resolve(reportDirectory, 'run.json'), 'utf8')) as unknown,
    );
    if (previous['interviewId'] !== interviewId || previous['model'] !== MODEL)
      throw new Error('RESUME_REPORT_DOES_NOT_MATCH_SYNTHETIC_INTERVIEW');
    planning.push(
      ...z
        .array(
          z.object({
            intent: mvpRealtimeTurnIntentRequestSchema,
            acceptedPlan: mvpRealtimeCommandResponseSchema.shape.nextAiTurn,
            rejection: z.string().nullable(),
            latencyMs: z.number(),
          }),
        )
        .parse(previous['planning']),
    );
    audio.push(
      ...z
        .array(
          z.object({
            deliveryId: z.string(),
            transcript: z.string(),
            byteCount: z.number(),
            latencyMs: z.number(),
            file: z.string(),
          }),
        )
        .parse(previous['audio']),
    );
    providerResponses = z.number().int().nonnegative().parse(previous['providerResponses']);
    connectionCount = z
      .number()
      .int()
      .nonnegative()
      .parse(previous['connectionCount'] ?? 1);
    recoveredInterruptions.push(
      ...z.array(z.string()).parse(previous['recoveredInterruptions'] ?? []),
    );
    if (typeof previous['failure'] === 'string') recoveredInterruptions.push(previous['failure']);
    const existing = await api(`${interviewPath}/session`, mvpInterviewSessionSchema);
    if (existing.guideId !== guide.id || existing.status !== 'active')
      throw new Error('RESUME_REQUIRES_THE_SAME_RUNNING_SYNTHETIC_INTERVIEW');
  }
  process.stdout.write(`Synthetic interview: ${interviewId}\nDefault guide: ${guide.title}\n`);
  const started = await api(
    `${interviewPath}/realtime/start`,
    mvpRealtimeCommandResponseSchema,
    {},
    'POST',
  );
  session = started.session;
  const secret = await api(
    `${interviewPath}/voice/session`,
    voiceSessionResponseSchema,
    {},
    'POST',
  );
  if (secret.model !== MODEL)
    throw new Error(
      'Configure OPENAI_REALTIME_MODEL=gpt-realtime-2.1; refusing model substitution.',
    );
  client = await RealtimeSimulationClient.connect({
    model: MODEL,
    clientSecret: secret.clientSecret,
  });
  connectionCount += 1;
  let next = started.nextAiTurn;
  let questionCount = session.transcript.filter((turn) => turn.speaker === 'participant').length;
  let missingAspect: string | null = null;
  if (resumeRunId !== undefined && next === null) {
    const last = session.transcript.at(-1);
    if (last?.speaker !== 'participant')
      throw new Error('RESUME_HAS_NO_PENDING_PARTICIPANT_ANSWER');
    await client.createConversationItem({
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: last.text }],
    });
    const selected = await selectNextTurn();
    next = selected.plan;
    missingAspect = selected.missingAspect;
  }
  while (next !== null) {
    const plan = next;
    const appended = await deliver(plan);
    session = appended.session;
    process.stdout.write(`AI [${plan.turnType}]: ${plan.text}\n`);
    await saveReport(session);
    if (session.status === 'completed') break;
    if (appended.nextAiTurn !== null) {
      next = appended.nextAiTurn;
      continue;
    }
    if (plan.questionId === null) throw new Error('A_NON_QUESTION_DELIVERY_HAS_NO_CONTINUATION');
    if (++questionCount > MAXIMUM_QUESTIONS) throw new Error('SYNTHETIC_QUESTION_BUDGET_EXCEEDED');
    const answer = participant.responseFor(plan.questionId, plan.turnType, missingAspect);
    const itemId = await client.createConversationItem({
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: answer }],
    });
    const participantResult = await api(
      `${interviewPath}/realtime/participant-turns`,
      mvpRealtimeAppendResponseSchema,
      {
        clientEventId: itemId,
        text: answer,
        occurredAt: new Date().toISOString(),
        sourceProvider: 'openai_realtime',
      },
    );
    session = participantResult.session;
    process.stdout.write(`Participant [mocked text]: ${answer}\n`);
    if (participantResult.nextAiTurn !== null) {
      next = participantResult.nextAiTurn;
      missingAspect = null;
    } else {
      const selected = await selectNextTurn();
      next = selected.plan;
      missingAspect = selected.missingAspect;
    }
  }
  if (session.status !== 'completed' || session.finalizedAt === null)
    throw new Error('SYNTHETIC_INTERVIEW_NOT_FINALIZED');
  process.stdout.write(`Completed. No scoring started. Report: ${reportDirectory}/interview.md\n`);
}

async function selectNextTurn(): Promise<{
  plan: MvpRealtimeTurnPlan;
  missingAspect: string | null;
}> {
  const connection = requireClient();
  const requestId = randomUUID();
  for (const repairAttempt of [0, 1] as const) {
    const result = await providerResponse({
      output_modalities: ['text'],
      max_output_tokens: 512,
      tool_choice: 'required',
      metadata: {
        client_request_id: requestId,
        request_kind: 'turn_plan',
        repair_attempt: String(repairAttempt),
      },
    });
    const calls = outputSchema
      .parse(result.response['output'])
      .filter((item) => item['type'] === 'function_call');
    const call = calls[0];
    if (calls.length !== 1 || call?.['name'] !== 'plan_interview_turn')
      throw new Error('EXPECTED_ONE_INTERVIEW_TOOL_CALL');
    const callId = z.string().parse(call['call_id']);
    const argumentsValue: unknown = JSON.parse(z.string().parse(call['arguments']));
    const intent = mvpRealtimeTurnIntentRequestSchema.parse({
      ...recordSchema.parse(argumentsValue),
      clientEventId: callId,
      repairAttempt,
    });
    const reserved = await api(
      `${interviewPath}/realtime/turn-intents`,
      mvpRealtimeCommandResponseSchema,
      intent,
    );
    session = reserved.session;
    planning.push({
      intent,
      acceptedPlan: reserved.nextAiTurn,
      rejection: reserved.rejection?.reason ?? null,
      latencyMs: result.elapsedMs,
    });
    if (reserved.contextUpdate != null) {
      await connection.updateSession({ instructions: reserved.contextUpdate.instructions });
      for (const id of reserved.contextUpdate.removeConversationItemIds)
        await connection.deleteConversationItem(id);
    }
    const plan = reserved.nextAiTurn;
    await connection.createConversationItem({
      type: 'function_call_output',
      call_id: callId,
      output: JSON.stringify(
        reserved.rejection === undefined
          ? {
              accepted: true,
              deliveryId: plan?.deliveryId ?? null,
              questionId: plan?.questionId ?? null,
              turnType: plan?.turnType ?? null,
              text: plan?.text ?? null,
            }
          : { accepted: false, reason: reserved.rejection.reason },
      ),
    });
    if (reserved.rejection !== undefined) continue;
    if (plan === null) throw new Error('NO_APPROVED_NEXT_TURN');
    return {
      plan,
      missingAspect:
        intent.action === 'ask_clarification_question' &&
        plan.turnType === 'clarification_question' &&
        plan.text === intent.spokenText
          ? intent.missingAspect
          : null,
    };
  }
  throw new Error('INTERVIEW_PLAN_REJECTED_AFTER_ONE_REPAIR');
}

async function deliver(
  plan: MvpRealtimeTurnPlan,
): Promise<z.infer<typeof mvpRealtimeAppendResponseSchema>> {
  const generated = await providerResponse({
    conversation: 'none',
    input: [],
    output_modalities: ['audio'],
    max_output_tokens: 512,
    tools: [],
    tool_choice: 'none',
    instructions: exactSpeechInstructions(plan.text, 'de'),
    metadata: {
      client_request_id: randomUUID(),
      delivery_id: plan.deliveryId,
      workflow_run_id: plan.workflowRunId,
      turn_type: plan.turnType,
    },
  });
  const messages = outputSchema
    .parse(generated.response['output'])
    .filter((item) => item['type'] === 'message');
  const message = messages[0];
  if (messages.length !== 1 || message === undefined)
    throw new Error('EXPECTED_ONE_SPOKEN_MESSAGE');
  const content = outputSchema.parse(message['content']);
  const transcript = content
    .filter((item) => ['audio', 'output_audio'].includes(String(item['type'])))
    .map((item) => z.string().parse(item['transcript']))
    .join('');
  const bytes = Buffer.concat(generated.audioChunks);
  if (bytes.length === 0) throw new Error('NO_REALTIME_AUDIO_GENERATED');
  await mkdir(audioDirectory, { recursive: true });
  const file = resolve(audioDirectory, `${String(audio.length + 1).padStart(3, '0')}.wav`);
  await writeFile(file, wav(bytes), { flag: 'wx' });
  audio.push({
    deliveryId: plan.deliveryId,
    transcript,
    byteCount: bytes.length,
    latencyMs: generated.elapsedMs,
    file,
  });
  if (transcript !== plan.text)
    throw new Error('ACTUAL_AUDIO_TRANSCRIPT_DIFFERS_FROM_APPROVED_TEXT');
  return api(`${interviewPath}/realtime/ai-turns`, mvpRealtimeAppendResponseSchema, {
    deliveryId: plan.deliveryId,
    clientEventId: z.string().parse(message['id']),
    text: transcript,
    occurredAt: new Date().toISOString(),
    turnType: plan.turnType,
    questionId: plan.questionId,
  });
}

function requireClient(): RealtimeSimulationClient {
  if (client === null) throw new Error('REALTIME_NOT_CONNECTED');
  return client;
}

function closeClient(): void {
  client?.close();
}

async function providerResponse(response: Readonly<Record<string, unknown>>) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (
      providerResponses >= MAXIMUM_RESPONSES ||
      performance.now() - runStartedAt > MAXIMUM_RUN_DURATION_MS
    )
      throw new Error('PROVIDER_RESPONSE_BUDGET_EXCEEDED');
    providerResponses += 1;
    try {
      return await requireClient().respond(response);
    } catch (error: unknown) {
      if (
        !(error instanceof RealtimeResponseError) ||
        error.code !== 'rate_limit_exceeded' ||
        attempt === 2
      )
        throw error;
      process.stdout.write('Realtime rate limit: waiting 65 seconds before a bounded retry.\n');
      await wait(RATE_LIMIT_WAIT_MS);
    }
  }
  throw new Error('REALTIME_RATE_LIMIT_RETRIES_EXHAUSTED');
}

async function api<T>(
  path: string,
  schema: z.ZodType<T>,
  body?: unknown,
  method = body === undefined ? 'GET' : 'POST',
): Promise<T> {
  const response = await fetch(`${API_ORIGIN}${path}`, {
    method,
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
    headers: {
      'content-type': 'application/json',
      [MVP_REALTIME_CLIENT_PROTOCOL_HEADER]: MVP_REALTIME_CLIENT_PROTOCOL_VERSION,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`BACKEND_REQUEST_FAILED:${path}:${response.status}`);
  const payload: unknown = await response.json();
  return schema.parse(payload);
}

function wav(pcm: Uint8Array): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(24_000, 24);
  header.writeUInt32LE(48_000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

async function saveReport(snapshot: MvpInterviewSession): Promise<void> {
  await mkdir(reportDirectory, { recursive: true });
  const clarifications = planning.filter(
    ({ intent, acceptedPlan, rejection }) =>
      rejection === null &&
      intent.action === 'ask_clarification_question' &&
      acceptedPlan?.turnType === 'clarification_question' &&
      acceptedPlan.text === intent.spokenText &&
      !guideQuestions.includes(acceptedPlan.text),
  );
  const markdown = [
    '# Synthetisches Interview: Deutscher Default-Leitfaden',
    '',
    '**Synthetischer Probelauf mit simulierten Teilnehmerantworten. Keine Forschungsdaten.**',
    '',
    `- Interview-ID: \`${interviewId}\``,
    `- Modell: \`${MODEL}\``,
    `- Gespeicherter Leitfaden: ${snapshot.guideTitle} (\`${snapshot.guideId}\`)`,
    `- Status: ${snapshot.status}; finalisiert: ${snapshot.finalizedAt ?? 'nein'}`,
    `- Realtime-Responses: ${providerResponses}; freie akzeptierte Nachfragen: ${clarifications.length}`,
    `- Realtime-Verbindungen: ${connectionCount} (Fortsetzungen behalten denselben Datensatz und verwenden den persistierten Interviewkontext).`,
    '- Planungsbudget: 512 Output-Tokens; Sprachbudget: 512 Output-Tokens, wie im Browser-Client.',
    `- Eval Studio: <http://localhost:5275/?interviewId=${encodeURIComponent(interviewId)}&profileId=profile-default>`,
    `- Fehler: ${failure ?? 'keiner'}`,
    `- Fruehere fortgesetzte Unterbrechungen: ${recoveredInterruptions.join(', ') || 'keine'}`,
    '',
    '## Testgrenzen',
    '',
    `Das Skript simuliert den Teilnehmer aus festen erfundenen Fakten per input_text. Fuer den Interviewer verwendet es die echte Realtime API, den gespeicherten Default-Leitfaden, die bestehenden Session-Instructions und das plan_interview_turn-Tool. Jede erfolgreich gespeicherte AI-Ausgabe wird durch das normale Backend validiert, reserviert und erst nach echter Audioerzeugung mit unveraendertem Audiotranskript gespeichert. In diesem Durchlauf wurden ${audio.length} Audioantworten empfangen. Audio wird automatisch empfangen, nicht durch einen Menschen angehoert. Mikrofon, STT, VAD, Unterbrechungen und Browser-Playback sind nicht Teil dieses Tests. Keine Auswertung wurde gestartet.`,
    '',
    'Automatisierte Antworten folgen schneller als menschliche Sprachturns. Bei einem Provider-Rate-Limit wartet der Test 65 Sekunden und versucht denselben Request hoechstens zweimal erneut. Die Gesamtzahl ist auf 200 Responses und 80 Teilnehmerantworten begrenzt; je Verbindung wird vor einem Response ein Laufzeitbudget von 15 Minuten geprueft. Ein laufender Request oder eine Wartezeit kann noch enden. Nach einem Abbruch kann derselbe eigene synthetische Datensatz ausdruecklich mit --resume RUN_ID fortgesetzt werden; eine neue Realtime-Verbindung wird im Bericht gezaehlt. Andere Providerfehler werden nicht verdeckt.',
    '',
    'Nur unveraendert akzeptierte ask_clarification_question-Vorschlaege zaehlen als freie Nachfragen. Wiederholungen und Backend-Fallbacks zaehlen nicht. Der Wortlaut wird mit allen Leitfadenfragen verglichen; eine moegliche inhaltliche Umformulierung einer Leitfaden-Unterfrage muss zusaetzlich manuell geprueft werden. Das Ergebnis gilt fuer diesen Durchlauf, nicht als Garantie fuer jedes Interview.',
    '',
    '## Frei formulierte Nachfragen',
    '',
    ...clarifications.flatMap(({ intent, acceptedPlan }) => [
      `- **${acceptedPlan?.text ?? ''}**`,
      `  Fehlender Aspekt laut explizitem Tool-Output: ${intent.missingAspect ?? 'nicht angegeben'}`,
    ]),
    '',
    '## Vollstaendiges kanonisches Transkript',
    '',
    ...snapshot.transcript.flatMap((turn) => [
      `### ${turn.sequenceNumber}. ${turn.speaker === 'ai_interviewer' ? 'AI-Interviewer' : 'Simulierter Teilnehmer'} (${turn.turnType})`,
      '',
      `Zeit: ${turn.occurredAt}; Turn-ID: \`${turn.turnId}\``,
      '',
      turn.text,
      '',
    ]),
    ...(snapshot.technicalGaps.length === 0
      ? []
      : [
          '## Technische Luecken',
          '',
          ...snapshot.technicalGaps.map((gap) => `- ${gap.occurredAt}: ${gap.description}`),
        ]),
    '## Reproduktion',
    '',
    'Bei laufender Docker-Anwendung: `node --import tsx scripts/run-realtime-synthetic-interview.ts --confirm-provider-calls`. Das erzeugt ein neues synthetisches Interview und kostenpflichtige echte Realtime-Responses, aber keine Auswertung. Einstellungen und bestehende Interviews werden nicht geaendert.',
    '',
  ].join('\n');
  await writeFile(resolve(reportDirectory, 'interview.md'), markdown);
  await writeFile(
    resolve(reportDirectory, 'run.json'),
    JSON.stringify(
      {
        runId,
        interviewId,
        model: MODEL,
        participantInput: 'mocked_text',
        audioOutput: 'real_generated_audio_automatically_received',
        failure,
        providerResponses,
        connectionCount,
        recoveredInterruptions,
        planning,
        audio,
        session: snapshot,
      },
      null,
      2,
    ) + '\n',
  );
}
