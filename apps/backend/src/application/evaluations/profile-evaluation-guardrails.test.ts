import {
  evaluationProfileDocumentSchema,
  mvpInterviewSessionSchema,
  profileEvaluationCodingOutputSchema,
  type MvpInterviewSession,
  type ProfileEvaluationCodingOutput,
} from '@orgscience/contracts';
import { describe, expect, it } from 'vitest';

import { DemoEvaluationCoder } from './demo-evaluation-coder.js';
import { validateEvaluationCodingOutput } from './evaluation-guardrails.js';

const START = '2026-08-21T08:00:00.000Z';
const ANSWER = '2026-08-21T08:01:00.000Z';
const END = '2026-08-21T08:02:00.000Z';
const PARTICIPANT_TEXT =
  'Freigaben werden dokumentiert. Bei Abweichungen entscheiden wir gemeinsam im Review.';

const profile = evaluationProfileDocumentSchema.parse({
  schemaVersion: 1,
  profile: {
    profileId: 'profile-generic-guardrail',
    name: 'Generic guardrail profile',
    description: '',
    coderPrompt: 'Evaluate documented practices using the supplied anchors.',
    scale: { minimum: 1, maximum: 7 },
    dimensions: [
      { dimensionId: 'governance', name: 'Governance', order: 0 },
      { dimensionId: 'adaptation', name: 'Adaptation', order: 1 },
    ],
    items: [
      {
        itemId: 'approval',
        dimensionId: 'governance',
        name: 'Approval process',
        codingInstruction: 'Assess observed approval practices.',
        order: 0,
        anchors: anchors('approval'),
      },
      {
        itemId: 'review',
        dimensionId: 'adaptation',
        name: 'Review process',
        codingInstruction: 'Assess observed review practices.',
        order: 0,
        anchors: anchors('review'),
      },
    ],
  },
});

function anchors(subject: string) {
  return ([1, 2, 3, 4, 5, 6, 7] as const).map((score) => ({
    score,
    criterion: `${subject} anchor ${String(score)}`,
  }));
}

function session(guideId = 'guide-unrelated-a'): MvpInterviewSession {
  return mvpInterviewSessionSchema.parse({
    interviewId: `interview-${guideId}`,
    guideId,
    guideTitle: 'Guide content is irrelevant to profile selection',
    status: 'completed',
    currentQuestionIndex: 1,
    totalQuestions: 1,
    currentQuestion: null,
    startedAt: START,
    endedAt: END,
    updatedAt: END,
    finalizedAt: END,
    partialTranscript: null,
    technicalGaps: [],
    transcript: [
      {
        turnId: `ai-${guideId}`,
        interviewId: `interview-${guideId}`,
        sequenceNumber: 1,
        speaker: 'ai_interviewer',
        turnType: 'main_question',
        text: 'Wie arbeiten Sie?',
        occurredAt: START,
        guideReference: null,
      },
      {
        turnId: `participant-${guideId}`,
        interviewId: `interview-${guideId}`,
        sequenceNumber: 2,
        speaker: 'participant',
        turnType: 'participant_answer',
        text: PARTICIPANT_TEXT,
        occurredAt: ANSWER,
        guideReference: null,
      },
    ],
  });
}

function evidence(guideId = 'guide-unrelated-a', excerpt = 'Freigaben werden dokumentiert') {
  return {
    turnId: `participant-${guideId}`,
    sequenceNumber: 2,
    verbatimExcerpt: excerpt,
  };
}

function output(
  guideId = 'guide-unrelated-a',
  score: 1 | 2 | 3 | 4 | 5 | 6 | 7 = 4,
): ProfileEvaluationCodingOutput {
  return profileEvaluationCodingOutputSchema.parse({
    items: profile.profile.items.map((item) => ({
      itemId: item.itemId,
      dimensionId: item.dimensionId,
      status: 'scored',
      score,
      confidence: 0.75,
      supportingEvidence: [evidence(guideId)],
      counterEvidence: [],
      missingInformation: [],
      rationale: `The cited participant statement supports ${item.itemId}.`,
    })),
    rationale: 'Every generic profile item was evaluated in profile order.',
  });
}

function classifiedOutput(): ProfileEvaluationCodingOutput {
  const candidate = output('guide-unrelated-a', 6);
  candidate.participantDetails = { age: null, position: null };
  for (const item of candidate.items) {
    item.supportingEvidence = [
      {
        ...evidence('guide-unrelated-a', 'entscheiden wir gemeinsam im Review'),
        inference:
          'Die gemeinsame Entscheidung im Review mit dokumentierten Freigaben deutet auf eine nachvollziehbare Entscheidungspraxis hin.',
        additionalSources: [evidence('guide-unrelated-a', 'Freigaben werden dokumentiert')],
      },
    ];
    item.counterEvidence = [
      {
        ...evidence('guide-unrelated-a', 'Bei Abweichungen'),
        inference: null,
        additionalSources: [],
      },
    ];
  }
  return candidate;
}

function issueCodes(
  candidate: unknown,
  sourceSession: MvpInterviewSession = session(),
): readonly string[] {
  const result = validateEvaluationCodingOutput({ profile, session: sourceSession }, candidate);
  expect(result.ok).toBe(false);
  return result.ok ? [] : result.issues.map((issue) => issue.code);
}

describe('profile evaluation guardrails', () => {
  it('accepts participant details grounded in final participant turns', () => {
    const source = session();
    const turn = source.transcript.find((turn) => turn.speaker === 'participant');
    if (turn === undefined) throw new Error('Missing participant fixture');
    turn.text += ' Ich bin 48 Jahre alt und war Bereichsleiterin.';
    const candidate = classifiedOutput();
    const reference = {
      turnId: turn.turnId,
      sequenceNumber: turn.sequenceNumber,
      verbatimExcerpt: 'Ich bin 48 Jahre alt und war Bereichsleiterin.',
    };
    candidate.participantDetails = {
      age: { value: '48 Jahre', source: reference },
      position: { value: 'war Bereichsleiterin', source: reference },
    };
    expect(
      validateEvaluationCodingOutput({ profile, session: source }, candidate, {
        requireProviderEvidence: true,
      }),
    ).toEqual({ ok: true, value: candidate });
  });

  it.each(['invented', 'wrong-turn', 'wrong-sequence', 'interviewer'] as const)(
    'rejects %s participant detail sources',
    (kind) => {
      const source = session();
      const turn = source.transcript.find(
        (turn) => turn.speaker === (kind === 'interviewer' ? 'ai_interviewer' : 'participant'),
      );
      if (turn === undefined) throw new Error('Missing fixture');
      const candidate = classifiedOutput();
      candidate.participantDetails = {
        age: null,
        position: {
          value: kind === 'invented' ? 'Erfundene Position' : turn.text,
          source: {
            turnId: kind === 'wrong-turn' ? 'foreign-turn' : turn.turnId,
            sequenceNumber: kind === 'wrong-sequence' ? 999 : turn.sequenceNumber,
            verbatimExcerpt: kind === 'invented' ? 'Erfundene Position' : turn.text,
          },
        },
      };
      expect(validateEvaluationCodingOutput({ profile, session: source }, candidate).ok).toBe(
        false,
      );
    },
  );
  it('preserves multiple classified evidence directions and checks all sources of an inference', () => {
    const candidate = classifiedOutput();
    const result = validateEvaluationCodingOutput({ profile, session: session() }, candidate, {
      requireProviderEvidence: true,
    });
    expect(result).toEqual({ ok: true, value: candidate });
  });

  it.each([
    { change: { turnId: 'another-interview-turn' }, code: 'invalid_evidence_turn' },
    {
      change: {
        turnId: 'ai-guide-unrelated-a',
        sequenceNumber: 1,
        verbatimExcerpt: 'Wie arbeiten Sie?',
      },
      code: 'invalid_evidence_turn',
    },
    { change: { sequenceNumber: 99 }, code: 'evidence_sequence_mismatch' },
    { change: { verbatimExcerpt: 'Invented supporting context' }, code: 'non_verbatim_evidence' },
  ])('rejects invalid additional sources: $code', ({ change, code }) => {
    const candidate = classifiedOutput();
    const item = candidate.items[0];
    const reference = item?.supportingEvidence[0];
    if (reference === undefined) throw new Error('Missing classified fixture');
    reference.additionalSources = [
      { ...evidence('guide-unrelated-a', 'Freigaben werden dokumentiert'), ...change },
    ];
    const result = validateEvaluationCodingOutput({ profile, session: session() }, candidate);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toContainEqual(
        expect.objectContaining({
          code,
          path: expect.stringContaining('additionalSources.0.'),
        }),
      );
    }
  });

  it('does not treat legacy unclassified evidence as classified new output', () => {
    const candidate = output();
    expect(validateEvaluationCodingOutput({ profile, session: session() }, candidate).ok).toBe(
      true,
    );
    const result = validateEvaluationCodingOutput({ profile, session: session() }, candidate, {
      requireProviderEvidence: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.issues.some((issue) => issue.code === 'schema_invalid')).toBe(true);
  });

  it('rejects the same primary quote assigned to different directions under different evidence types', () => {
    const candidate = classifiedOutput();
    const item = candidate.items[0];
    const reference = item?.supportingEvidence[0];
    if (item === undefined || reference === undefined)
      throw new Error('Missing classified fixture');
    item.counterEvidence = [
      { ...reference, evidenceType: 'direct', inference: null, additionalSources: [] },
    ];
    expect(issueCodes(candidate)).toContain('duplicate_evidence_direction');
  });

  it('accepts every integer score from 1 through 7 for arbitrary profile items', () => {
    for (const score of [1, 2, 3, 4, 5, 6, 7] as const) {
      const candidate = output('guide-unrelated-a', score);
      expect(validateEvaluationCodingOutput({ profile, session: session() }, candidate)).toEqual({
        ok: true,
        value: candidate,
      });
    }
  });

  it.each([0, 1.5, 8])('rejects out-of-range or non-integer score %s', (score) => {
    const source = output();
    const candidate = {
      ...source,
      items: source.items.map((item, index) => (index === 0 ? { ...item, score } : item)),
    };

    expect(issueCodes(candidate)).toContain('schema_invalid');
  });

  it('uses the same profile independently of an interview guide', () => {
    const otherSession = session('guide-entirely-different');
    const candidate = output('guide-entirely-different', 6);

    expect(validateEvaluationCodingOutput({ profile, session: otherSession }, candidate)).toEqual({
      ok: true,
      value: candidate,
    });
  });

  it('rejects a third evidence direction instead of relabeling it as indirect evidence', () => {
    const source = output();
    const candidate = {
      ...source,
      items: source.items.map((item) => ({ ...item, ambiguousEvidence: [evidence()] })),
    };
    expect(issueCodes(candidate)).toContain('schema_invalid');
  });

  it('accepts defined non-score outcomes without coercing them to one', () => {
    const candidate = profileEvaluationCodingOutputSchema.parse({
      items: [
        {
          itemId: 'approval',
          dimensionId: 'governance',
          status: 'insufficient_evidence',
          score: null,
          confidence: 0.1,
          supportingEvidence: [],
          counterEvidence: [],
          missingInformation: ['A concrete approval example is missing.'],
          rationale: 'No numeric score is assigned without observed evidence.',
        },
        {
          itemId: 'review',
          dimensionId: 'adaptation',
          status: 'conflicting',
          score: null,
          confidence: 0.4,
          supportingEvidence: [evidence()],
          counterEvidence: [evidence('guide-unrelated-a', 'Bei Abweichungen')],
          missingInformation: ['The conflict cannot be resolved from this interview.'],
          rationale: 'The statements do not support a reliable numeric score.',
        },
      ],
      rationale: 'Non-score states remain explicit.',
    });

    expect(validateEvaluationCodingOutput({ profile, session: session() }, candidate)).toEqual({
      ok: true,
      value: candidate,
    });
  });

  it('rejects unknown, reordered, and wrong-dimension item results', () => {
    const source = output();
    expect(issueCodes({ ...source, items: source.items.toReversed() })).toContain(
      'item_set_mismatch',
    );
    expect(
      issueCodes({
        ...source,
        items: source.items.map((item, index) =>
          index === 0 ? { ...item, itemId: 'unknown-item' } : item,
        ),
      }),
    ).toContain('item_set_mismatch');
    expect(
      issueCodes({
        ...source,
        items: source.items.map((item, index) =>
          index === 0 ? { ...item, dimensionId: 'adaptation' } : item,
        ),
      }),
    ).toContain('item_dimension_mismatch');
  });

  it.each([
    {
      name: 'AI turn',
      reference: {
        turnId: 'ai-guide-unrelated-a',
        sequenceNumber: 1,
        verbatimExcerpt: 'Wie arbeiten Sie',
      },
      code: 'invalid_evidence_turn',
    },
    {
      name: 'wrong sequence',
      reference: {
        turnId: 'participant-guide-unrelated-a',
        sequenceNumber: 1,
        verbatimExcerpt: 'Freigaben werden dokumentiert',
      },
      code: 'evidence_sequence_mismatch',
    },
    {
      name: 'invented excerpt',
      reference: {
        turnId: 'participant-guide-unrelated-a',
        sequenceNumber: 2,
        verbatimExcerpt: 'This excerpt was invented.',
      },
      code: 'non_verbatim_evidence',
    },
  ] as const)('rejects $name as evidence', ({ reference, code }) => {
    const source = output();
    const candidate = {
      ...source,
      items: source.items.map((item, index) =>
        index === 0 ? { ...item, supportingEvidence: [reference] } : item,
      ),
    };
    expect(issueCodes(candidate)).toContain(code);
  });

  it('rejects one excerpt assigned to multiple evidence buckets', () => {
    const source = output();
    const candidate = {
      ...source,
      items: source.items.map((item, index) =>
        index === 0 ? { ...item, counterEvidence: item.supportingEvidence } : item,
      ),
    };
    expect(issueCodes(candidate)).toContain('duplicate_evidence_direction');
  });

  it('rejects a numeric score without observed participant evidence', () => {
    const source = output();
    const candidate = {
      ...source,
      items: source.items.map((item, index) =>
        index === 0 ? { ...item, supportingEvidence: [] } : item,
      ),
    };
    expect(issueCodes(candidate)).toContain('schema_invalid');
  });

  it('keeps arbitrary profile items explicit without inventing demo scores', async () => {
    const result = await new DemoEvaluationCoder().code(
      { profile, session: session() },
      { runId: 'demo-run-generic-profile', signal: new AbortController().signal },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.output.items.map(({ itemId, dimensionId, status, score }) => ({
        itemId,
        dimensionId,
        status,
        score,
      })),
    ).toEqual([
      {
        itemId: 'approval',
        dimensionId: 'governance',
        status: 'insufficient_evidence',
        score: null,
      },
      {
        itemId: 'review',
        dimensionId: 'adaptation',
        status: 'insufficient_evidence',
        score: null,
      },
    ]);
  });
});
