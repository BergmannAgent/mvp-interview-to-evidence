import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import {
  mvpInterviewSessionSchema,
  organizationalResilienceCalibrationFixtureSchema,
  organizationalResilienceCodingOutputSchema,
  organizationalResilienceReportSchema,
  type OrganizationalResilienceCalibrationFixture,
  type OrganizationalResilienceEvidenceReference,
} from '@orgscience/contracts';
import { parseInterviewGuideMarkdown } from '@orgscience/domain';
import { describe, expect, it } from 'vitest';

import { loadOrganizationalResilienceEvaluationAssets } from '../../infrastructure/research/index.js';
import { validateOrganizationalResilienceCodingOutput } from './evaluation-guardrails.js';
import { buildOrganizationalResilienceReport } from './organizational-resilience-report.js';
import { deriveOrganizationalResilienceRubric } from './organizational-resilience-rubric.js';

const fixture = organizationalResilienceCalibrationFixtureSchema.parse(
  JSON.parse(
    readFileSync(
      'research/instruments/organizational-resilience/calibration-cases-v1.json',
      'utf8',
    ),
  ) as unknown,
);
const parsedGuide = parseInterviewGuideMarkdown(
  readFileSync('guides/fixtures/Interview Leitfaden_Test Voice Agent.docx.md', 'utf8'),
);
if (!parsedGuide.success) throw new Error('Expected calibration guide to parse');
const guide = {
  ...parsedGuide.guide,
  sourceMarkdown: readFileSync(
    'guides/fixtures/Interview Leitfaden_Test Voice Agent.docx.md',
    'utf8',
  ),
  createdAt: '2026-08-20T10:00:00.000Z',
};
const evaluationAssets = loadOrganizationalResilienceEvaluationAssets();
const rubric = deriveOrganizationalResilienceRubric(guide, evaluationAssets, {
  digestUtf8: (value) => createHash('sha256').update(value).digest('hex'),
});

describe('organizational-resilience semantic calibration fixtures', () => {
  it('derives an English rubric and maps an English elicitation question adaptively', () => {
    const translatedItem = evaluationAssets.englishDefaultProfileOverlay.profile.items[0];
    const parsedEnglishGuide = parseInterviewGuideMarkdown(
      `# Interview guide: Organizational Resilience\n\n## Robustness\n\n### Main question\n${translatedItem.name}\n`,
      'en',
    );
    expect(parsedEnglishGuide.success).toBe(true);
    if (!parsedEnglishGuide.success) return;
    const englishGuide = {
      ...parsedEnglishGuide.guide,
      sourceMarkdown: '# English calibration guide',
      createdAt: '2026-09-02T10:00:00.000Z',
    };

    const englishRubric = deriveOrganizationalResilienceRubric(englishGuide, evaluationAssets, {
      digestUtf8: (value) => createHash('sha256').update(value).digest('hex'),
    });
    const firstItem = englishRubric.items[0];
    const sourceFirstItem = evaluationAssets.instrument.dimensions[0]?.items[0];

    expect(englishRubric.title).toBe(evaluationAssets.englishDefaultProfileOverlay.rubric.title);
    expect(firstItem?.elicitationQuestion).toBe(translatedItem.name);
    expect(firstItem?.codingInstruction).toBe(translatedItem.codingInstruction);
    expect(firstItem?.guideQuestionIds).toEqual([
      parsedEnglishGuide.guide.sections[0]?.mainQuestions[0]?.id,
    ]);
    expect(firstItem?.originalStatementEn).toBe(sourceFirstItem?.originalStatementEn);
    expect(firstItem?.anchors.map(({ interpretation }) => interpretation)).toEqual(
      translatedItem.anchors
        .filter(({ score }) => score === 1 || score === 4 || score === 7)
        .map(({ criterion }) => criterion),
    );
    expect(firstItem?.anchors.flatMap(({ approvedExamples }) => approvedExamples)).toHaveLength(6);
    expect(firstItem?.anchors[0]?.approvedExamples[0]).toMatchObject({
      exampleId: evaluationAssets.englishDefaultProfileOverlay.rubric.examples[0]?.exampleId,
      sourceId: sourceFirstItem?.anchors[0]?.approvedExamples[0]?.sourceReference.sourceId,
      sourceLocator: sourceFirstItem?.anchors[0]?.approvedExamples[0]?.sourceReference.locator,
    });
    expect(firstItem?.interpolationRules).toHaveLength(4);
    expect(firstItem?.interpolationRules?.[0]?.decisionCriterion).not.toContain('Abgrenzung');
  });

  it.each(fixture.cases)(
    'preserves $caseId through transcript audit, coding audit, report, and export',
    (calibrationCase) => {
      const session = calibrationSession(calibrationCase);
      const output = calibrationOutput(calibrationCase, session);
      const validated = validateOrganizationalResilienceCodingOutput({ rubric, session }, output);

      expect(validated.ok).toBe(true);
      if (!validated.ok) return;
      const target = validated.value.items[0];
      expect(target?.status).toBe(calibrationCase.expectedStatus);
      expect(target?.score).toBe(calibrationCase.expectedScore);
      expect(target?.matchedAnchors.map((anchor) => anchor.score)).toEqual(
        calibrationCase.expectedMatchedReferenceScores,
      );
      if (calibrationCase.expectedRuleId !== null) {
        expect(target?.appliedInterpolationRuleId).toBe(calibrationCase.expectedRuleId);
      }

      const evaluatedAt = session.finalizedAt;
      if (evaluatedAt === null) throw new Error('Calibration transcript must be finalized');
      const report = buildOrganizationalResilienceReport(rubric, session, validated.value, {
        evaluationId: `evaluation-${calibrationCase.caseId}`,
        interviewId: session.interviewId,
        guideId: session.guideId,
        rubricFingerprint: 'a'.repeat(64),
        transcriptFingerprint: 'b'.repeat(64),
        promptVersion: 'or-evidence-coding-v2',
        model: { mode: 'demo', provider: null, model: null },
        evaluatedAt,
      });
      expect(report.items[0]?.score).toBe(calibrationCase.expectedScore);
      expect(report.methodology.evidenceScale.interpolationCodebook).toEqual(
        rubric.scale.interpolationCodebook,
      );
    },
  );

  it.each([2, 3, 5, 6] as const)(
    'rejects score %s when its structured interpolation rule is missing or wrong',
    (score) => {
      const calibrationCase = fixture.cases.find((candidate) => candidate.expectedScore === score);
      if (calibrationCase === undefined) throw new Error('Expected intermediate calibration case');
      const candidateSession = calibrationSession(calibrationCase);
      const missing = structuredClone(calibrationOutput(calibrationCase, candidateSession));
      delete missing.items[0]!.appliedInterpolationRuleId;
      missing.items[0]!.rationale = `The text mentions ${calibrationCase.expectedRuleId ?? ''}, but does not apply it structurally.`;

      const missingResult = validateOrganizationalResilienceCodingOutput(
        { rubric, session: candidateSession },
        missing,
      );
      expect(missingResult.ok).toBe(false);
      if (!missingResult.ok) {
        expect(missingResult.issues.map((issue) => issue.code)).toContain(
          'invalid_interpolation_rule',
        );
      }

      const wrong = structuredClone(calibrationOutput(calibrationCase, candidateSession));
      wrong.items[0]!.appliedInterpolationRuleId =
        score === 2 ? 'rob-01-score-3' : 'rob-01-score-2';
      const wrongResult = validateOrganizationalResilienceCodingOutput(
        { rubric, session: candidateSession },
        wrong,
      );
      expect(wrongResult.ok).toBe(false);
      if (!wrongResult.ok) {
        expect(wrongResult.issues.map((issue) => issue.code)).toContain(
          'invalid_interpolation_rule',
        );
      }
    },
  );

  it('requires codebook provenance in every rubric-v2 report while keeping v1 compatibility', () => {
    const calibrationCase = fixture.cases[1];
    const candidateSession = calibrationSession(calibrationCase);
    const output = calibrationOutput(calibrationCase, candidateSession);
    const report = buildOrganizationalResilienceReport(rubric, candidateSession, output, {
      evaluationId: 'evaluation-provenance',
      interviewId: candidateSession.interviewId,
      guideId: candidateSession.guideId,
      rubricFingerprint: 'a'.repeat(64),
      transcriptFingerprint: 'b'.repeat(64),
      promptVersion: 'or-evidence-coding-v2',
      model: { mode: 'demo', provider: null, model: null },
      evaluatedAt: candidateSession.finalizedAt ?? '2026-08-20T10:04:01.000Z',
    });
    const withoutCodebook = structuredClone(report) as typeof report & {
      methodology: {
        evidenceScale: { interpolationCodebook?: unknown };
      };
    };
    delete withoutCodebook.methodology.evidenceScale.interpolationCodebook;

    expect(organizationalResilienceReportSchema.safeParse(withoutCodebook).success).toBe(false);
  });
});

function calibrationSession(
  calibrationCase: OrganizationalResilienceCalibrationFixture['cases'][number],
) {
  const interviewId = `interview-${calibrationCase.caseId}`;
  const transcript = [
    {
      turnId: `ai-${calibrationCase.caseId}`,
      interviewId,
      sequenceNumber: 1,
      speaker: 'ai_interviewer' as const,
      turnType: 'main_question' as const,
      text: rubric.items[0].elicitationQuestion,
      occurredAt: '2026-08-20T10:00:00.000Z',
      guideReference: null,
      interrupted: false,
    },
    ...calibrationCase.participantTurns.map((text, index) => ({
      turnId: `participant-${calibrationCase.caseId}-${String(index + 1)}`,
      interviewId,
      sequenceNumber: index + 2,
      speaker: 'participant' as const,
      turnType: 'participant_answer' as const,
      text,
      occurredAt: `2026-08-20T10:0${String(index + 1)}:00.000Z`,
      guideReference: null,
      interrupted: false,
    })),
  ];
  return mvpInterviewSessionSchema.parse({
    interviewId,
    guideId: guide.id,
    guideTitle: guide.title,
    status: 'completed',
    currentQuestionIndex: 1,
    totalQuestions: 1,
    currentQuestion: null,
    startedAt: '2026-08-20T10:00:00.000Z',
    endedAt: '2026-08-20T10:04:00.000Z',
    updatedAt: '2026-08-20T10:04:01.000Z',
    finalizedAt: '2026-08-20T10:04:01.000Z',
    partialTranscript: null,
    technicalGaps: [],
    transcript,
  });
}

function calibrationOutput(
  calibrationCase: OrganizationalResilienceCalibrationFixture['cases'][number],
  session: ReturnType<typeof calibrationSession>,
) {
  const evidence = calibrationCase.evidence.map((entry) => {
    const turn = session.transcript[entry.turnIndex + 1];
    if (turn === undefined || turn.speaker !== 'participant') {
      throw new Error('Calibration evidence turn is unavailable');
    }
    return {
      turnId: turn.turnId,
      sequenceNumber: turn.sequenceNumber,
      verbatimExcerpt: entry.excerpt,
      phase: 'during_adversity' as const,
      direction: entry.direction,
      specificity: 'concrete_event' as const,
    };
  });
  const supportingEvidence = evidence.filter(isSupporting);
  const counterEvidence = evidence.filter(isCounter);
  const targetItem = rubric.items[0];

  return organizationalResilienceCodingOutputSchema.parse({
    crisisContext:
      calibrationCase.expectedStatus === 'insufficient_evidence'
        ? {
            mode: 'mixed_or_unclear',
            summary: 'Die belastbare Ereignisevidenz reicht für keine Einordnung aus.',
            eventLabel: null,
            evidence: [],
          }
        : {
            mode: 'actual_event',
            summary: 'Ein konkreter Lieferausfall wurde als Kalibrierungsfall beschrieben.',
            eventLabel: 'Lieferausfall',
            evidence: evidence.slice(0, 1),
          },
    processPhases: [
      emptyPhase('pre_adversity'),
      emptyPhase('during_adversity'),
      emptyPhase('post_adversity'),
    ],
    items: rubric.items.map((item, index) => {
      if (index !== 0) return insufficientItem(item);
      if (calibrationCase.expectedStatus === 'insufficient_evidence') {
        return insufficientItem(item);
      }
      if (calibrationCase.expectedStatus === 'conflicting') {
        return {
          ...itemBase(item),
          status: 'conflicting' as const,
          score: null,
          supportingEvidence,
          counterEvidence,
          matchedAnchors: [],
          missingInformation: ['Die widersprüchlichen Ereignisaussagen müssen geklärt werden.'],
          rationale: calibrationCase.calibrationRationaleDe,
        };
      }
      const score = calibrationCase.expectedScore;
      if (score === null) throw new Error('Scored calibration requires a numeric score');
      return {
        ...itemBase(item),
        status: 'scored' as const,
        score,
        supportingEvidence,
        counterEvidence,
        matchedAnchors: calibrationCase.expectedMatchedReferenceScores.map((anchorScore) => {
          const anchor = targetItem.anchors.find((candidate) => candidate.score === anchorScore);
          if (anchor === undefined) throw new Error('Calibration reference anchor is unavailable');
          return {
            score: anchorScore,
            relationship:
              score === anchorScore
                ? ('exact' as const)
                : anchorScore < score
                  ? ('lower_bound' as const)
                  : ('upper_bound' as const),
            interpretation: anchor.interpretation,
          };
        }),
        missingInformation: [],
        appliedInterpolationRuleId: calibrationCase.expectedRuleId,
        rationale:
          calibrationCase.expectedRuleId === null
            ? calibrationCase.calibrationRationaleDe
            : `Applied ${calibrationCase.expectedRuleId}: ${calibrationCase.calibrationRationaleDe}`,
      };
    }),
    rationale: 'Versionierte synthetische Kalibrierungsfälle wurden einzeln geprüft.',
  });
}

function itemBase(item: (typeof rubric.items)[number]) {
  return {
    itemId: item.itemId,
    dimensionId: item.dimensionId,
    confidence: 0.9,
    supportingEvidence: [],
    counterEvidence: [],
    ambiguousEvidence: [],
    missingInformation: [],
    appliedInterpolationRuleId: null,
    rationale: 'Kalibrierungsfall.',
  };
}

function insufficientItem(item: (typeof rubric.items)[number]) {
  return {
    ...itemBase(item),
    status: 'insufficient_evidence' as const,
    score: null,
    matchedAnchors: [],
    missingInformation: [
      'Für dieses Item liegt im isolierten Kalibrierungsfall keine Evidenz vor.',
    ],
    rationale: 'Fehlende Evidenz wird nicht in einen Ersatzwert umgewandelt.',
  };
}

function emptyPhase(phase: 'pre_adversity' | 'during_adversity' | 'post_adversity') {
  return {
    phase,
    status: 'not_covered' as const,
    summary: 'Die Phase ist für den isolierten Item-Kalibrierungsfall nicht separat codiert.',
    evidence: [],
  };
}

function isSupporting(
  evidence: OrganizationalResilienceEvidenceReference,
): evidence is Extract<OrganizationalResilienceEvidenceReference, { direction: 'supporting' }> {
  return evidence.direction === 'supporting';
}

function isCounter(
  evidence: OrganizationalResilienceEvidenceReference,
): evidence is Extract<OrganizationalResilienceEvidenceReference, { direction: 'counter' }> {
  return evidence.direction === 'counter';
}
