import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import {
  deriveOrganizationalResilienceScoreDistribution,
  isOrganizationalResilienceCalibrationFixtureCompatible,
  mvpInterviewSessionSchema,
  organizationalResilienceCalibrationFixtureSchema,
} from '../packages/contracts/src/index.js';
import { parseInterviewGuideMarkdown } from '../packages/domain/src/guide/parser.js';
import { ORGANIZATIONAL_RESILIENCE_CODING_PROMPT_VERSION } from '../apps/backend/src/application/evaluations/evaluation-coder.js';
import { buildOrganizationalResilienceReport } from '../apps/backend/src/application/evaluations/organizational-resilience-report.js';
import { deriveOrganizationalResilienceRubric } from '../apps/backend/src/application/evaluations/organizational-resilience-rubric.js';
import { loadOrganizationalResilienceEvaluationAssets } from '../apps/backend/src/infrastructure/research/evaluation-assets.js';
import { MastraEvaluationCoder } from '../apps/backend/src/infrastructure/mastra/mastra-evaluation-coder.js';
import { loadModelRuntimeConfig } from '../apps/backend/src/runtime/model-config.js';

if (
  process.env['OPENAI_API_KEY']?.trim().length === 0 ||
  process.env['OPENAI_API_KEY'] === undefined
) {
  throw new Error('OPENAI_API_KEY is required for the provider calibration smoke test.');
}

const fixture = organizationalResilienceCalibrationFixtureSchema.parse(
  JSON.parse(
    readFileSync(
      'research/instruments/organizational-resilience/calibration-cases-v1.json',
      'utf8',
    ),
  ) as unknown,
);
const sourceMarkdown = readFileSync(
  'guides/fixtures/Interview Leitfaden_Test Voice Agent.docx.md',
  'utf8',
);
const parsedGuide = parseInterviewGuideMarkdown(sourceMarkdown);
if (!parsedGuide.success) throw new Error('The calibration interview guide is invalid.');
const guide = {
  ...parsedGuide.guide,
  sourceMarkdown,
  createdAt: '2026-08-20T10:00:00.000Z',
};
const hasher = {
  digestUtf8: (value: string): string => createHash('sha256').update(value).digest('hex'),
};
const assets = loadOrganizationalResilienceEvaluationAssets();
const rubric = deriveOrganizationalResilienceRubric(guide, assets, hasher);
if (
  !isOrganizationalResilienceCalibrationFixtureCompatible(
    fixture,
    assets.interpolationCodebook,
    assets.interpolationCodebookFingerprint,
  )
) {
  throw new Error('Calibration fixture does not match the derived rubric assets.');
}
const modelConfig = loadModelRuntimeConfig();
const coder = new MastraEvaluationCoder({
  model: modelConfig.evaluationModel,
  timeoutMs: modelConfig.evaluationTimeoutMs,
});
const requestedScoreCandidates = process.argv
  .slice(2)
  .map((candidate) => Number.parseInt(candidate, 10));
if (
  requestedScoreCandidates.some((score) => score !== 2 && score !== 3 && score !== 5 && score !== 6)
) {
  throw new Error('Calibration score selection accepts only 2, 3, 5, and 6.');
}
const requestedScores = new Set(requestedScoreCandidates);
const cases = fixture.cases.filter((calibrationCase) => {
  const score = calibrationCase.expectedScore;
  return (
    (score === 2 || score === 3 || score === 5 || score === 6) &&
    (requestedScores.size === 0 || requestedScores.has(score))
  );
});
if (cases.length === 0) {
  throw new Error('Select at least one calibration score from 2, 3, 5, and 6.');
}
const results: {
  readonly caseId: string;
  readonly expectedScore: number;
  readonly actualScore: number;
  readonly durationMs: number;
  readonly referenceAnchorRatio: number | null;
}[] = [];

for (const calibrationCase of cases) {
  const session = calibrationSession(calibrationCase.caseId, calibrationCase.participantTurns);
  const startedAt = Date.now();
  const result = await coder.code(
    { rubric, session },
    {
      runId: `provider-calibration-${calibrationCase.caseId}`,
      signal: new AbortController().signal,
    },
  );
  const durationMs = Date.now() - startedAt;
  if (!result.ok) {
    throw new Error(
      `${calibrationCase.caseId} failed: ${result.error.code}: ${result.error.message}`,
    );
  }
  const target = result.output.items[0];
  if (
    target?.status !== 'scored' ||
    target.score !== calibrationCase.expectedScore ||
    target.matchedAnchors.map((anchor) => anchor.score).join(',') !==
      calibrationCase.expectedMatchedReferenceScores.join(',') ||
    calibrationCase.expectedRuleId === null ||
    target.appliedInterpolationRuleId !== calibrationCase.expectedRuleId
  ) {
    throw new Error(
      `${calibrationCase.caseId} expected score ${String(calibrationCase.expectedScore)} with rule ${String(calibrationCase.expectedRuleId)}, received ${JSON.stringify(target)}`,
    );
  }
  for (const expectedEvidence of calibrationCase.evidence) {
    const references =
      expectedEvidence.direction === 'supporting'
        ? target.supportingEvidence
        : target.counterEvidence;
    const expectedTurnId = `participant-${calibrationCase.caseId}-${String(expectedEvidence.turnIndex + 1)}`;
    if (!references.some((reference) => reference.turnId === expectedTurnId)) {
      throw new Error(
        `${calibrationCase.caseId} omitted ${expectedEvidence.direction} evidence from ${expectedTurnId}; received ${JSON.stringify(
          {
            supportingEvidence: target.supportingEvidence.map((reference) => ({
              turnId: reference.turnId,
              verbatimExcerpt: reference.verbatimExcerpt,
            })),
            counterEvidence: target.counterEvidence.map((reference) => ({
              turnId: reference.turnId,
              verbatimExcerpt: reference.verbatimExcerpt,
            })),
          },
        )}.`,
      );
    }
  }
  const report = buildOrganizationalResilienceReport(rubric, session, result.output, {
    evaluationId: `provider-calibration-${calibrationCase.caseId}`,
    interviewId: session.interviewId,
    guideId: session.guideId,
    rubricFingerprint: digest(rubric),
    transcriptFingerprint: digest(session),
    promptVersion: ORGANIZATIONAL_RESILIENCE_CODING_PROMPT_VERSION,
    model: coder.model,
    evaluatedAt: session.finalizedAt ?? '2026-08-20T10:02:01.000Z',
  });
  const distribution = deriveOrganizationalResilienceScoreDistribution(report.items);
  results.push({
    caseId: calibrationCase.caseId,
    expectedScore: calibrationCase.expectedScore,
    actualScore: target.score,
    durationMs,
    referenceAnchorRatio: distribution.referenceAnchorRatio,
  });
  process.stdout.write(`${JSON.stringify(results.at(-1))}\n`);
}

process.stdout.write(
  `${JSON.stringify({
    status: 'passed',
    model: coder.model,
    promptVersion: ORGANIZATIONAL_RESILIENCE_CODING_PROMPT_VERSION,
    rubricVersion: rubric.version,
    interpolationCodebook: rubric.scale.interpolationCodebook,
    cases: results,
  })}\n`,
);

function calibrationSession(caseId: string, participantTurns: readonly string[]) {
  const interviewId = `interview-${caseId}`;
  return mvpInterviewSessionSchema.parse({
    interviewId,
    guideId: guide.id,
    guideTitle: guide.title,
    status: 'completed',
    currentQuestionIndex: 1,
    totalQuestions: 1,
    currentQuestion: null,
    startedAt: '2026-08-20T10:00:00.000Z',
    endedAt: '2026-08-20T10:02:00.000Z',
    updatedAt: '2026-08-20T10:02:01.000Z',
    finalizedAt: '2026-08-20T10:02:01.000Z',
    partialTranscript: null,
    technicalGaps: [],
    transcript: [
      {
        turnId: `ai-${caseId}`,
        interviewId,
        sequenceNumber: 1,
        speaker: 'ai_interviewer',
        turnType: 'main_question',
        text: rubric.items[0].elicitationQuestion,
        occurredAt: '2026-08-20T10:00:00.000Z',
        guideReference: null,
        interrupted: false,
      },
      ...participantTurns.map((text, index) => ({
        turnId: `participant-${caseId}-${String(index + 1)}`,
        interviewId,
        sequenceNumber: index + 2,
        speaker: 'participant' as const,
        turnType: 'participant_answer' as const,
        text,
        occurredAt: `2026-08-20T10:0${String(index + 1)}:00.000Z`,
        guideReference: null,
        interrupted: false,
      })),
    ],
  });
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
