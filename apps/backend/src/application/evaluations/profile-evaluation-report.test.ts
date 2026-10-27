import {
  evaluationProfileSchema,
  calculateProfileScores,
  mvpInterviewSessionSchema,
  type ProfileEvaluationCodingOutput,
} from '@orgscience/contracts';
import { describe, expect, it } from 'vitest';

import {
  aggregate,
  buildProfileEvaluationReport,
  ProfileEvaluationReportAuditError,
} from './profile-evaluation-report.js';

const INTERVIEW_ID = 'interview-generic-report';
const NOW = '2026-08-21T16:00:00.000Z';

describe('profile evaluation report assembler', () => {
  it('snapshots item and dimension weights and replaces the old overall mean', () => {
    const selected = profile();
    selected.dimensions[0]!.weight = 2;
    selected.items[0]!.weight = 3;
    const source = session();
    source.transcript[1]!.text += ' We learn from prior incidents.';
    const output = coding();
    Object.assign(output.items[1]!, {
      status: 'scored',
      score: 1,
      missingInformation: [],
      supportingEvidence: [
        {
          turnId: 'turn-participant-report',
          sequenceNumber: 2,
          verbatimExcerpt: 'We learn from prior incidents.',
        },
      ],
    });
    const report = buildProfileEvaluationReport(selected, source, output, metadata());
    expect(report.schemaVersion).toBe(5);
    expect(report.overallAggregate).toMatchObject({ status: 'complete', score: 4.43 });
    expect(report.dimensions.map(({ aggregate }) => aggregate.score)).toEqual([5, 1]);
    expect(report.dimensions[0]!.weight).toBe(2);
    expect(report.dimensions[0]!.items[0]!.weight).toBe(3);
    expect(report.calculation).toEqual(
      calculateProfileScores(selected, { 'decision-1': 5, 'learning-1': 1 }).calculation,
    );
    expect(report.calculation.items[0]).toMatchObject({
      itemWeight: 3,
      dimensionWeight: 2,
      effectiveWeight: 6,
      included: true,
    });
  });

  it('keeps source coverage separate from zero-weight exclusions', () => {
    const selected = profile();
    selected.dimensions[0]!.weight = 0;
    const report = buildProfileEvaluationReport(selected, session(), coding(), metadata());
    expect(report.overallAggregate).toMatchObject({
      status: 'partial',
      score: null,
      scoredItemCount: 1,
      totalItemCount: 2,
    });
    expect(report.dimensions[0]!.aggregate.score).toBe(5);
    expect(report.calculation.status).toBe('not_calculated');
    expect(report.calculation.items.map(({ exclusion }) => exclusion)).toEqual([
      'zero_weight',
      'missing_score',
    ]);
    expect(report.calculation.weightSum).toBe(0);
  });

  it('records item zero weights without treating the item as unscored evidence', () => {
    const selected = profile();
    selected.items[0]!.weight = 0;
    const report = buildProfileEvaluationReport(selected, session(), coding(), metadata());
    expect(report.dimensions[0]!.aggregate).toMatchObject({
      status: 'complete',
      score: null,
      scoredItemCount: 1,
    });
    expect(report.overallAggregate.score).toBeNull();
    expect(report.dimensions[0]!.items[0]).toMatchObject({
      status: 'scored',
      score: 5,
      appliedAnchor: { score: 5 },
    });
    expect(report.calculation.items[0]).toMatchObject({
      included: false,
      exclusion: 'zero_weight',
      effectiveWeight: 0,
    });
  });

  it('records formula results outside the anchor scale and missing reference substitutions', () => {
    const selected = profile();
    selected.calculation = {
      mode: 'formula',
      expression: 'item("decision-1") * 2 + dimension("learning")',
    };
    const report = buildProfileEvaluationReport(selected, session(), coding(), metadata());
    expect(report.overallAggregate).toMatchObject({ status: 'partial', score: 10 });
    expect(report.calculation).toMatchObject({
      mode: 'formula',
      status: 'calculated',
      result: 10,
      expression: selected.calculation.expression,
    });
    expect(report.calculation.references).toContainEqual({
      function: 'dimension',
      id: 'learning',
      value: 0,
      zeroSubstituted: true,
    });
    expect(report.dimensions[1]!.items[0]!.score).toBeNull();
    expect(report.dimensions[0]!.aggregate.score).toBe(5);
  });

  it('can calculate a formula from entirely missing scores without claiming evidence coverage', () => {
    const selected = profile();
    selected.calculation = {
      mode: 'formula',
      expression: 'item("decision-1") + dimension("learning") + 2',
    };
    const output = coding();
    Object.assign(output.items[0]!, {
      status: 'insufficient_evidence',
      score: null,
      supportingEvidence: [],
      missingInformation: ['No decision details.'],
    });
    const report = buildProfileEvaluationReport(selected, session(), output, metadata());
    expect(report.overallAggregate).toMatchObject({
      status: 'not_scored',
      score: 2,
      scoredItemCount: 0,
    });
    expect(report.calculation.status).toBe('calculated');
    expect(report.calculation.references.every(({ zeroSubstituted }) => zeroSubstituted)).toBe(
      true,
    );
    expect(report.dimensions.every(({ aggregate }) => aggregate.score === null)).toBe(true);
  });

  it.each(['item("decision-1") / 0', 'pow(10, 1000)'])(
    'persists the math error for %s without falling back to an old score',
    (expression) => {
      const selected = profile();
      selected.calculation = { mode: 'formula', expression };
      const report = buildProfileEvaluationReport(selected, session(), coding(), metadata());
      expect(report.overallAggregate).toMatchObject({
        status: 'partial',
        score: null,
        scoredItemCount: 1,
      });
      expect(report.calculation).toMatchObject({
        status: 'error',
        result: null,
        unroundedResult: null,
        expression,
      });
      expect(report.calculation.error).not.toBeNull();
      expect(report.dimensions[0]!.items[0]!.score).toBe(5);
      expect(report.dimensions[0]!.aggregate.score).toBe(5);
    },
  );

  it('records a paused source snapshot without pretending the interview was completed', () => {
    const source = { ...session(), status: 'paused' as const, endedAt: null, finalizedAt: null };
    const report = buildProfileEvaluationReport(profile(), source, coding(), {
      evaluationId: 'evaluation-paused-report',
      interviewId: INTERVIEW_ID,
      profileFingerprint: 'a'.repeat(64),
      transcriptFingerprint: 'b'.repeat(64),
      language: 'de',
      profileTranslation: null,
      promptVersion: 'profile-evidence-coding-v4',
      model: { mode: 'demo', provider: null, model: null },
      evaluatedAt: NOW,
      ignoredPartialTranscript: true,
    });
    expect(report.sourceTranscript).toEqual({
      interviewStatus: 'paused',
      finalized: false,
      snapshotAt: source.updatedAt,
      turnCount: source.transcript.length,
      ignoredPartial: true,
    });
    expect(source.status).toBe('paused');
    expect(source.finalizedAt).toBeNull();
    expect(report.dimensions[1]?.items[0]?.score).toBeNull();
  });
  it('preserves sourced participant details separately from unchanged scores', () => {
    const source = session();
    const participant = source.transcript.find((turn) => turn.speaker === 'participant');
    if (participant === undefined) throw new Error('Missing participant');
    participant.text += ' Ich bin 48 Jahre alt und war Bereichsleiterin.';
    const output = coding();
    const metadata = {
      evaluationId: 'evaluation-generic-report',
      interviewId: INTERVIEW_ID,
      profileFingerprint: 'a'.repeat(64),
      transcriptFingerprint: 'b'.repeat(64),
      language: 'de' as const,
      profileTranslation: null,
      promptVersion: 'profile-evidence-coding-v4',
      model: { mode: 'demo' as const, provider: null, model: null },
      evaluatedAt: NOW,
    };
    const baseline = buildProfileEvaluationReport(profile(), source, output, metadata);
    const reference = {
      turnId: participant.turnId,
      sequenceNumber: participant.sequenceNumber,
      verbatimExcerpt: 'Ich bin 48 Jahre alt und war Bereichsleiterin.',
    };
    output.participantDetails = {
      age: { value: '48 Jahre', source: reference },
      position: { value: 'war Bereichsleiterin', source: reference },
    };
    const report = buildProfileEvaluationReport(profile(), source, output, metadata);
    expect(report.participantDetails).toEqual(output.participantDetails);
    expect(report.dimensions).toEqual(baseline.dimensions);
    expect(report.overallAggregate).toEqual(baseline.overallAggregate);
  });
  it('snapshots arbitrary profile content and derives partial aggregates and exact anchors', () => {
    const report = buildProfileEvaluationReport(profile(), session(), coding(), {
      evaluationId: 'evaluation-generic-report',
      interviewId: INTERVIEW_ID,
      profileFingerprint: 'a'.repeat(64),
      transcriptFingerprint: 'b'.repeat(64),
      language: 'de',
      profileTranslation: null,
      promptVersion: 'profile-evidence-coding-v1',
      model: { mode: 'demo', provider: null, model: null },
      evaluatedAt: NOW,
    });

    expect(report.profileName).toBe('Cross-guide evidence profile');
    expect(report.dimensions.map((dimension) => dimension.name)).toEqual([
      'Decision quality',
      'Team learning',
    ]);
    expect(report.dimensions[0]?.items[0]?.score).toBe(5);
    expect(report.dimensions[0]?.items[0]?.appliedAnchor).toEqual({
      score: 5,
      criterion: 'Decision criterion 5',
    });
    expect(report.dimensions[1]?.aggregate).toEqual({
      status: 'not_scored',
      score: null,
      scoredItemCount: 0,
      unscoredItemCount: 1,
      totalItemCount: 1,
    });
    expect(report.overallAggregate).toEqual({
      status: 'partial',
      score: 5,
      scoredItemCount: 1,
      unscoredItemCount: 1,
      totalItemCount: 2,
    });
  });

  it('rejects output whose item identity does not match the selected profile', () => {
    const invalid = structuredClone(coding());
    invalid.items[0]!.itemId = 'unknown-item';
    expect(() =>
      buildProfileEvaluationReport(profile(), session(), invalid, {
        evaluationId: 'evaluation-generic-report',
        interviewId: INTERVIEW_ID,
        profileFingerprint: 'a'.repeat(64),
        transcriptFingerprint: 'b'.repeat(64),
        language: 'de',
        profileTranslation: null,
        promptVersion: 'profile-evidence-coding-v1',
        model: { mode: 'demo', provider: null, model: null },
        evaluatedAt: NOW,
      }),
    ).toThrow(ProfileEvaluationReportAuditError);
  });

  it('preserves a score seven based on one indirect evidence entry and its additional source', () => {
    const source = session();
    source.transcript[1]!.text =
      'The shift lead changed the schedule. No management approval was required.';
    const output = coding();
    const firstItem = output.items[0]!;
    firstItem.score = 7;
    firstItem.supportingEvidence = [
      {
        turnId: 'turn-participant-report',
        sequenceNumber: 2,
        verbatimExcerpt: 'The shift lead changed the schedule.',
        evidenceType: 'indirect',
        inference: 'The local decision without management approval indicates delegated authority.',
        additionalSources: [
          {
            turnId: 'turn-participant-report',
            sequenceNumber: 2,
            verbatimExcerpt: 'No management approval was required.',
          },
        ],
      },
    ];
    const report = buildProfileEvaluationReport(profile(), source, output, {
      evaluationId: 'evaluation-generic-report',
      interviewId: INTERVIEW_ID,
      profileFingerprint: 'a'.repeat(64),
      transcriptFingerprint: 'b'.repeat(64),
      language: 'de',
      profileTranslation: null,
      promptVersion: 'profile-evidence-coding-v3',
      model: { mode: 'demo', provider: null, model: null },
      evaluatedAt: NOW,
    });

    expect(report.dimensions[0]?.items[0]).toMatchObject({
      score: 7,
      appliedAnchor: { score: 7, criterion: 'Decision criterion 7' },
      supportingEvidence: firstItem.supportingEvidence,
      counterEvidence: [],
    });
    expect(report.dimensions[0]?.items[0]?.supportingEvidence).toHaveLength(1);
    expect(report.overallAggregate.score).toBe(7);
  });

  it('rejects report metadata for a different interview than the audited session', () => {
    expect(() =>
      buildProfileEvaluationReport(profile(), session(), coding(), {
        evaluationId: 'evaluation-generic-report',
        interviewId: 'another-interview',
        profileFingerprint: 'a'.repeat(64),
        transcriptFingerprint: 'b'.repeat(64),
        language: 'de',
        profileTranslation: null,
        promptVersion: 'profile-evidence-coding-v1',
        model: { mode: 'demo', provider: null, model: null },
        evaluatedAt: NOW,
      }),
    ).toThrow('interview_scope_mismatch');
  });

  it('never converts missing values into numeric aggregates', () => {
    expect(aggregate([null, null])).toEqual({
      status: 'not_scored',
      score: null,
      scoredItemCount: 0,
      unscoredItemCount: 2,
      totalItemCount: 2,
    });
    expect(aggregate([2, 3, 5, 6])).toMatchObject({ status: 'complete', score: 4 });
  });
});

function metadata() {
  return {
    evaluationId: 'evaluation-calculation-report',
    interviewId: INTERVIEW_ID,
    profileFingerprint: 'a'.repeat(64),
    transcriptFingerprint: 'b'.repeat(64),
    language: 'de' as const,
    profileTranslation: null,
    promptVersion: 'profile-evidence-coding-v7',
    model: { mode: 'demo' as const, provider: null, model: null },
    evaluatedAt: NOW,
  };
}

function profile() {
  return evaluationProfileSchema.parse({
    profileId: 'profile-generic-report',
    name: 'Cross-guide evidence profile',
    description: 'The guide is deliberately irrelevant to this profile.',
    coderPrompt: 'Evaluate every item from final participant turns.',
    scale: { minimum: 1, maximum: 7 },
    dimensions: [
      { dimensionId: 'decisions', name: 'Decision quality', order: 0 },
      { dimensionId: 'learning', name: 'Team learning', order: 1 },
    ],
    items: [
      item('decision-1', 'decisions', 'Decision', 0),
      item('learning-1', 'learning', 'Learning', 0),
    ],
    isDefault: false,
    createdAt: '2026-08-21T15:00:00.000Z',
    updatedAt: '2026-08-21T15:30:00.000Z',
  });
}

function coding(): ProfileEvaluationCodingOutput {
  return {
    items: [
      {
        itemId: 'decision-1',
        dimensionId: 'decisions',
        status: 'scored',
        score: 5,
        confidence: 0.8,
        supportingEvidence: [
          {
            turnId: 'turn-participant-report',
            sequenceNumber: 2,
            verbatimExcerpt: 'We document every consequential decision.',
          },
        ],
        counterEvidence: [],
        missingInformation: [],
        rationale: 'The observed practice matches criterion five.',
      },
      {
        itemId: 'learning-1',
        dimensionId: 'learning',
        status: 'insufficient_evidence',
        score: null,
        confidence: 0.2,
        supportingEvidence: [],
        counterEvidence: [],
        missingInformation: ['No learning routine was described.'],
        rationale: 'The transcript does not contain enough evidence for a score.',
      },
    ],
    rationale: 'Only observed participant evidence is represented.',
  };
}

function session() {
  return mvpInterviewSessionSchema.parse({
    interviewId: INTERVIEW_ID,
    guideId: 'unrelated-guide',
    guideTitle: 'Unrelated interview guide',
    status: 'completed',
    currentQuestionIndex: 1,
    totalQuestions: 1,
    currentQuestion: null,
    startedAt: '2026-08-21T15:40:00.000Z',
    endedAt: '2026-08-21T15:50:00.000Z',
    updatedAt: NOW,
    partialTranscript: null,
    transcript: [
      {
        turnId: 'turn-ai-report',
        interviewId: INTERVIEW_ID,
        sequenceNumber: 1,
        speaker: 'ai_interviewer',
        turnType: 'main_question',
        text: 'How are decisions handled?',
        occurredAt: '2026-08-21T15:41:00.000Z',
        guideReference: null,
        interrupted: false,
      },
      {
        turnId: 'turn-participant-report',
        interviewId: INTERVIEW_ID,
        sequenceNumber: 2,
        speaker: 'participant',
        turnType: 'participant_answer',
        text: 'We document every consequential decision.',
        occurredAt: '2026-08-21T15:42:00.000Z',
        guideReference: null,
        interrupted: false,
      },
    ],
    technicalGaps: [],
    finalizedAt: '2026-08-21T15:51:00.000Z',
  });
}

function item(itemId: string, dimensionId: string, name: string, order: number) {
  return {
    itemId,
    dimensionId,
    name,
    codingInstruction: `Evaluate ${name}.`,
    order,
    anchors: ([1, 2, 3, 4, 5, 6, 7] as const).map((score) => ({
      score,
      criterion: `${name} criterion ${String(score)}`,
    })),
  };
}
