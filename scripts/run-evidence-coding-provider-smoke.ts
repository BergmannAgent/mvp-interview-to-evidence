import { performance } from 'node:perf_hooks';

import {
  evaluationProfileDocumentSchema,
  mvpInterviewSessionSchema,
  profileEvaluationProviderCodingOutputSchema,
  type EvaluationProfileDocument,
  type MvpInterviewSession,
  type ProfileEvaluationCodingOutput,
} from '../packages/contracts/src/index.js';
import { validateEvaluationCodingOutput } from '../apps/backend/src/application/evaluations/evaluation-guardrails.js';
import { MastraEvaluationCoder } from '../apps/backend/src/infrastructure/mastra/mastra-evaluation-coder.js';
import {
  MastraStructuredGenerator,
  type StructuredGenerationRequest,
  type StructuredGenerationResult,
  type StructuredGenerator,
} from '../apps/backend/src/infrastructure/mastra/mastra-agent-executor.js';
import { loadModelRuntimeConfig } from '../apps/backend/src/runtime/model-config.js';

interface SmokeCase {
  readonly caseId: string;
  readonly profile: EvaluationProfileDocument;
  readonly session: MvpInterviewSession;
  readonly check: (output: ProfileEvaluationCodingOutput) => void;
}

if (!process.env['OPENAI_API_KEY']?.trim()) {
  throw new Error('OPENAI_API_KEY is required for this optional provider smoke test.');
}

const config = loadModelRuntimeConfig();
const selectedCaseIds = process.argv.slice(2);
const maximumProviderCalls = Math.min(selectedCaseIds.length || 3, 3);
const delegate = new MastraStructuredGenerator();
let providerCalls = 0;
const budgetedGenerator: StructuredGenerator = {
  async generate<Output>(
    request: StructuredGenerationRequest<Output>,
  ): Promise<StructuredGenerationResult> {
    if (providerCalls >= maximumProviderCalls)
      throw new Error('Provider smoke call budget exhausted.');
    providerCalls += 1;
    return delegate.generate(request);
  },
};
const coder = new MastraEvaluationCoder({
  model: config.evaluationModel,
  timeoutMs: Math.min(config.evaluationTimeoutMs, 60_000),
  generator: budgetedGenerator,
});
const cases: readonly SmokeCase[] = [
  {
    caseId: 'indirect-only',
    profile: profile(
      'operative-autonomy',
      'Lokal ausgeuebte dezentrale Entscheidungsbefugnisse',
      'Bewerte die im beschriebenen Vorfall tatsaechlich ausgeuebten dezentralen Entscheidungsbefugnisse der Schichtleitung. Formale organisationsweite Delegation ist kein Gegenstand dieses Items. Eine ausdrueckliche Aussage ueber die vorhandenen Befugnisse ist direkte Evidenz; aus einem beschriebenen konkreten Handeln abgeleitete Befugnisse sind indirekte Evidenz. Beurteile nur den belegten Vorgang.',
      [
        'Die Schichtleitung konnte im beschriebenen Fall keine operative Aenderung vornehmen.',
        'Sie durfte lediglich einen Vorschlag weitergeben.',
        'Sie setzte eine zuvor einzeln freigegebene Aenderung um.',
        'Sie waehlt innerhalb einer bereits einzeln genehmigten Massnahme Details aus.',
        'Sie aenderte den Ablauf selbst; eine nachtraegliche Genehmigung blieb erforderlich.',
        'Sie aenderte den Ablauf selbst; im beschriebenen Fall musste keine andere Stelle genehmigen.',
        'Sie aenderte den Ablauf selbst und konnte dabei auch Ressourcen zwischen mehreren Bereichen neu zuordnen, ohne Einzelgenehmigung.',
      ],
    ),
    session: session('indirect-only', [
      'Bei der Stoerung am Dienstag legte unsere Schichtleiterin die Wartung von Linie A auf den Nachmittag und liess die beiden Techniker derselben Schicht zuerst Linie B instand setzen, ohne dass in diesem Vorgang eine andere Stelle die Aenderung genehmigen musste.',
    ]),
    check: (output) => {
      const item = output.items[0];
      if (
        item?.status !== 'scored' ||
        item.supportingEvidence.length === 0 ||
        item.counterEvidence.length !== 0 ||
        item.supportingEvidence.some((evidence) => !evidence.inference)
      ) {
        throw new Error('Contextual evidence case did not produce an adequately sourced score.');
      }
    },
  },
  {
    caseId: 'distinct-support-and-counter',
    profile: profile(
      'approval-recording',
      'Zuverlaessigkeit der Freigabedokumentation',
      'Bewerte die belegte Zuverlaessigkeit der Dokumentation von Freigaben in den drei beschriebenen Faellen. Waehle inhaltlich unterschiedliche Quellen aus, wenn sie relevant sind. Fehlende Dokumentation einer ausdruecklich genannten Freigabe ist Gegenevidenz. Schliesslich behobene Luecken duerfen nicht als von Anfang an korrekt dokumentiert dargestellt werden.',
      [
        'Keine der drei Freigaben wurde dokumentiert.',
        'Nur eine der drei Freigaben wurde dokumentiert, und es gibt keine weitere Kontrolle.',
        'Nur eine der drei Freigaben wurde dokumentiert, aber Luecken werden nachgeprueft.',
        'Zwei der drei Freigaben wurden dokumentiert; eine belegte Luecke blieb offen.',
        'Zwei der drei Freigaben wurden unmittelbar dokumentiert; die dritte wurde spaeter nachvollziehbar nachgetragen.',
        'Alle drei Freigaben wurden dokumentiert, aber ein Eintrag war unvollstaendig.',
        'Alle drei Freigaben wurden unmittelbar und vollstaendig dokumentiert.',
      ],
    ),
    session: session('distinct-support-and-counter', [
      'Am 2. Mai gab die Leiterin die Beschaffung frei. Am selben Tag trug ich ihren Namen, Betrag und Datum in das Freigabeprotokoll ein.',
      'Am 9. Mai genehmigte der Bereichsleiter den Schichtwechsel. Seine Freigabe, Name und Datum stehen seit diesem Tag im Protokoll.',
      'Am 16. Mai erlaubte der Bereichsleiter eine weitere Beschaffung. Diese Freigabe fehlt im Protokoll. Wir haben die Luecke am 20. Mai bei der Kontrolle gefunden. Bis heute wurde sie nicht nachgetragen.',
    ]),
    check: (output) => {
      const item = output.items[0];
      if (
        item?.status !== 'scored' ||
        item.score !== 4 ||
        item.supportingEvidence.length < 2 ||
        item.counterEvidence.length === 0
      ) {
        throw new Error('Mixed case did not retain the distinct real support and counter sources.');
      }
    },
  },
];
const indirectCase = cases[0];
if (!indirectCase) throw new Error('Missing indirect smoke case.');
const speculativeCase: SmokeCase = {
  caseId: 'speculative-only',
  profile: indirectCase.profile,
  session: session('speculative-only', [
    'Einen solchen Vorfall haben wir noch nicht erlebt. Wenn eine Stoerung kaeme, wuerde wohl die Schichtleitung selbst den Ablauf aendern. Das ist nur meine Vermutung; ich kenne weder einen tatsaechlichen Vorgang noch eine entsprechende Regelung.',
  ]),
  check: (output) => {
    const item = output.items[0];
    if (
      item?.status !== 'insufficient_evidence' ||
      item.score !== null ||
      item.missingInformation.length === 0
    ) {
      throw new Error('Speculation-only case forced a score without observed item evidence.');
    }
  },
};

const allCases = [...cases, speculativeCase];
if (selectedCaseIds.some((caseId) => !allCases.some((candidate) => candidate.caseId === caseId))) {
  throw new Error('Select only declared evidence smoke case IDs.');
}
for (const smokeCase of allCases.filter(
  (candidate) => selectedCaseIds.length === 0 || selectedCaseIds.includes(candidate.caseId),
)) {
  const started = performance.now();
  const result = await coder.code(
    { profile: smokeCase.profile, session: smokeCase.session },
    { runId: `provider-evidence-${smokeCase.caseId}`, signal: AbortSignal.timeout(125_000) },
  );
  const durationMs = Math.round(performance.now() - started);
  if (!result.ok) {
    process.stdout.write(
      `${JSON.stringify({ caseId: smokeCase.caseId, status: 'failed', code: result.error.code, durationMs, model: coder.model })}\n`,
    );
    process.exitCode = 1;
    continue;
  }
  const parsed = profileEvaluationProviderCodingOutputSchema.parse(result.output);
  const guarded = validateEvaluationCodingOutput(
    { profile: smokeCase.profile, session: smokeCase.session },
    parsed,
    { requireProviderEvidence: true },
  );
  if (!guarded.ok) throw new Error('Returned output failed exact-source guardrails.');
  const item = parsed.items[0];
  if (!item) throw new Error('Missing scored smoke item.');
  let semanticStatus: 'passed' | 'failed' = 'passed';
  let semanticFailure: string | null = null;
  try {
    smokeCase.check(parsed);
  } catch (error: unknown) {
    semanticStatus = 'failed';
    semanticFailure = error instanceof Error ? error.message : 'Semantic smoke check failed.';
    process.exitCode = 1;
  }
  process.stdout.write(
    `${JSON.stringify({
      caseId: smokeCase.caseId,
      status: semanticStatus,
      semanticFailure,
      durationMs,
      providerCalls,
      model: coder.model,
      score: item.score,
      supportingCount: item.supportingEvidence.length,
      counterCount: item.counterEvidence.length,
      evidence: [...item.supportingEvidence, ...item.counterEvidence].map((evidence) => ({
        inference: evidence.inference,
        turnId: evidence.turnId,
        verbatimExcerpt: evidence.verbatimExcerpt,
      })),
    })}\n`,
  );
}

function profile(
  itemId: string,
  name: string,
  codingInstruction: string,
  criteria: readonly string[],
): EvaluationProfileDocument {
  return evaluationProfileDocumentSchema.parse({
    schemaVersion: 1,
    profile: {
      profileId: `profile-smoke-${itemId}`,
      name: 'Generic evidence smoke',
      description: 'Synthetic provider-only evidence selection cases; no interview data is saved.',
      coderPrompt: 'Bewerte die beschriebenen konkreten Faelle anhand der gelieferten Anker.',
      scale: { minimum: 1, maximum: 7 },
      dimensions: [{ dimensionId: 'practice', name: 'Praxis', order: 0 }],
      items: [
        {
          itemId,
          dimensionId: 'practice',
          name,
          codingInstruction,
          order: 0,
          anchors: criteria.map((criterion, index) => ({ score: index + 1, criterion })),
        },
      ],
    },
  });
}

function session(caseId: string, participantTexts: readonly string[]): MvpInterviewSession {
  const interviewId = `interview-evidence-smoke-${caseId}`;
  return mvpInterviewSessionSchema.parse({
    interviewId,
    guideId: 'guide-evidence-smoke',
    guideTitle: 'Synthetic generic evidence case',
    language: 'de',
    status: 'completed',
    currentQuestionIndex: 1,
    totalQuestions: 1,
    currentQuestion: null,
    startedAt: '2026-09-14T10:00:00.000Z',
    endedAt: '2026-09-14T10:05:00.000Z',
    updatedAt: '2026-09-14T10:05:01.000Z',
    finalizedAt: '2026-09-14T10:05:01.000Z',
    partialTranscript: null,
    technicalGaps: [],
    transcript: [
      {
        turnId: `ai-${caseId}`,
        interviewId,
        sequenceNumber: 1,
        speaker: 'ai_interviewer',
        turnType: 'main_question',
        text: 'Bitte beschreiben Sie einen tatsaechlichen Vorgang.',
        occurredAt: '2026-09-14T10:00:00.000Z',
        guideReference: null,
        interrupted: false,
      },
      ...participantTexts.map((text, index) => ({
        turnId: `participant-${caseId}-${String(index + 1)}`,
        interviewId,
        sequenceNumber: index + 2,
        speaker: 'participant',
        turnType: 'participant_answer',
        text,
        occurredAt: `2026-09-14T10:0${String(index + 1)}:00.000Z`,
        guideReference: null,
        interrupted: false,
      })),
    ],
  });
}
