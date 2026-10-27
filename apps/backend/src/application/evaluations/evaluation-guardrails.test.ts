import {
  ORGANIZATIONAL_RESILIENCE_ITEM_IDS,
  mvpInterviewSessionSchema,
  organizationalResilienceCodingOutputSchema,
  organizationalResilienceRubricSchema,
  type OrganizationalResilienceCodingOutput,
  type OrganizationalResilienceRubric,
} from '@orgscience/contracts';
import { describe, expect, it } from 'vitest';

import {
  validateOrganizationalResilienceCodingOutput,
  validateEvaluationRubricAgainstGuide,
  validateEvaluationTranscript,
} from './evaluation-guardrails.js';
import { buildOrganizationalResilienceReport } from './organizational-resilience-report.js';

const START = '2026-08-14T08:00:00.000Z';
const ANSWER = '2026-08-14T08:01:00.000Z';
const END = '2026-08-14T08:02:00.000Z';
const PARTICIPANT_TEXT =
  'Wir haben noch keine Krise erlebt. Wir testen unsere Notfallplaene jedes Quartal. Die Zustaendigkeit ist manchmal unklar.';

const guide = {
  id: 'guide-1',
  title: 'Interviewleitfaden',
  sections: [
    {
      id: 'section-1',
      position: 0,
      title: 'Vor der Krise',
      mainQuestions: [
        {
          id: 'main-1',
          position: 0,
          text: 'Wie bereiten Sie Entscheidungen vor?',
          followUpQuestions: [{ id: 'follow-1', position: 0, text: 'Wie werden Plaene getestet?' }],
        },
      ],
    },
  ],
};

const ITEM_DIMENSIONS = [
  'robustness',
  'robustness',
  'robustness',
  'robustness',
  'agility',
  'agility',
  'agility',
  'integrity',
  'integrity',
] as const;

function rubric(): OrganizationalResilienceRubric {
  return organizationalResilienceRubricSchema.parse({
    schemaVersion: 1,
    kind: 'organizational_resilience_evidence_1_7',
    rubricId: 'rubric-1',
    guideId: guide.id,
    version: 1,
    title: 'Organizational-Resilience-Evidenzrating',
    description: 'Kleine validierte Neun-Item-Rubrik fuer Guardrail-Tests.',
    instrument: {
      instrumentId: 'kantur-iseri-say-evidence-rating',
      instrumentVersion: '1.0.0',
      instrumentFingerprint: 'a'.repeat(64),
      classification: 'derived_evidence_rating',
    },
    mapping: {
      mappingId: 'guide-mapping-1',
      mappingVersion: '1.0.0',
      mappingFingerprint: 'b'.repeat(64),
    },
    scale: {
      kind: 'ordinal_1_7',
      minimum: 1,
      maximum: 7,
      referenceScores: [1, 4, 7],
    },
    dimensions: [
      {
        dimensionId: 'robustness',
        label: 'Robustness',
        itemIds: ['rob-01', 'rob-02', 'rob-03', 'rob-04'],
      },
      {
        dimensionId: 'agility',
        label: 'Agility',
        itemIds: ['agi-01', 'agi-02', 'agi-03'],
      },
      {
        dimensionId: 'integrity',
        label: 'Integrity',
        itemIds: ['int-01', 'int-02'],
      },
    ],
    items: ORGANIZATIONAL_RESILIENCE_ITEM_IDS.map((itemId, index) => ({
      itemId,
      dimensionId: ITEM_DIMENSIONS[index],
      position: index + 1,
      label: `Testitem ${itemId}`,
      originalStatementEn: `Original statement ${itemId}`,
      elicitationQuestion: `Testfrage fuer ${itemId}?`,
      codingInstruction: 'Nur finale, woertliche Teilnehmeraussagen verwenden.',
      guideQuestionIds: ['main-1', 'follow-1'],
      phases: ['pre_adversity', 'during_adversity', 'post_adversity'],
      anchors: ([1, 4, 7] as const).map((score) => ({
        score,
        interpretation: `Freigegebene Interpretation ${itemId} Stufe ${String(score)}`,
        approvedExamples: [1, 2].map((example) => ({
          exampleId: `${itemId}-${String(score)}-${String(example)}`,
          behavioralAnchor: `Verhaltensanker ${itemId} ${String(score)} ${String(example)}`,
          typicalEvidence: `Typische Evidenz ${itemId} ${String(score)} ${String(example)}`,
          empiricalEvidence: `Empirische Evidenz ${itemId} ${String(score)} ${String(example)}`,
          sourceId: 'source-1',
          sourceLocator: `Tabelle ${String(example)}, Seite ${String(score)}`,
        })),
      })),
    })),
  });
}

function session() {
  return mvpInterviewSessionSchema.parse({
    interviewId: 'interview-1',
    guideId: guide.id,
    guideTitle: guide.title,
    status: 'completed',
    currentQuestionIndex: 1,
    totalQuestions: 2,
    currentQuestion: null,
    startedAt: START,
    endedAt: END,
    updatedAt: END,
    finalizedAt: END,
    partialTranscript: null,
    technicalGaps: [],
    transcript: [
      {
        turnId: 'ai-1',
        interviewId: 'interview-1',
        sequenceNumber: 1,
        speaker: 'ai_interviewer',
        turnType: 'main_question',
        text: 'Wie bereiten Sie Entscheidungen vor?',
        occurredAt: START,
        guideReference: null,
      },
      {
        turnId: 'participant-1',
        interviewId: 'interview-1',
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

type EvidenceDirection = 'supporting' | 'counter' | 'ambiguous';
type EvidenceSpecificity =
  | 'general_statement'
  | 'concrete_practice'
  | 'concrete_event'
  | 'hypothetical_statement'
  | 'absence_of_crisis_experience';
type AdversityPhase = 'pre_adversity' | 'during_adversity' | 'post_adversity';

function evidence<Direction extends EvidenceDirection>(
  direction: Direction,
  verbatimExcerpt: string,
  specificity: EvidenceSpecificity = 'concrete_practice',
  phase: AdversityPhase = 'pre_adversity',
) {
  return {
    turnId: 'participant-1',
    sequenceNumber: 2,
    verbatimExcerpt,
    phase,
    direction,
    specificity,
  };
}

function matchedAnchor(
  source: OrganizationalResilienceRubric,
  itemIndex: number,
  score: 1 | 4 | 7,
  relationship: 'exact' | 'lower_bound' | 'upper_bound',
) {
  const anchor = source.items[itemIndex]?.anchors.find((candidate) => candidate.score === score);
  if (anchor === undefined) throw new Error('Test rubric is missing an expected reference anchor.');
  return { score, relationship, interpretation: anchor.interpretation };
}

function output(): OrganizationalResilienceCodingOutput {
  const source = rubric();
  const itemBase = (index: number) => ({
    itemId: source.items[index]?.itemId,
    dimensionId: source.items[index]?.dimensionId,
    confidence: 0.8,
    supportingEvidence: [],
    counterEvidence: [],
    ambiguousEvidence: [],
    missingInformation: [],
    rationale: `Kurze auditierbare Begruendung fuer ${source.items[index]?.itemId ?? 'item'}.`,
  });
  const supporting = evidence('supporting', 'Wir testen unsere Notfallplaene jedes Quartal');
  const counter = evidence(
    'counter',
    'Die Zustaendigkeit ist manchmal unklar',
    'general_statement',
    'during_adversity',
  );
  const ambiguous = evidence('ambiguous', 'manchmal unklar', 'general_statement', 'post_adversity');
  const absentCrisis = evidence(
    'ambiguous',
    'Wir haben noch keine Krise erlebt',
    'absence_of_crisis_experience',
  );

  return organizationalResilienceCodingOutputSchema.parse({
    crisisContext: {
      mode: 'no_crisis_experience',
      summary: 'Die Person berichtet keine eigene Krisenerfahrung.',
      eventLabel: null,
      evidence: [absentCrisis],
    },
    processPhases: [
      {
        phase: 'pre_adversity',
        status: 'covered',
        summary: 'Vorbereitung wurde konkret beschrieben.',
        evidence: [supporting],
      },
      {
        phase: 'during_adversity',
        status: 'partially_covered',
        summary: 'Verantwortung blieb teilweise offen.',
        evidence: [counter],
      },
      {
        phase: 'post_adversity',
        status: 'partially_covered',
        summary: 'Die Aussage bleibt mehrdeutig.',
        evidence: [ambiguous],
      },
    ],
    items: [
      {
        ...itemBase(0),
        status: 'scored',
        score: 1,
        supportingEvidence: [supporting],
        matchedAnchors: [matchedAnchor(source, 0, 1, 'exact')],
      },
      {
        ...itemBase(1),
        status: 'scored',
        score: 2,
        supportingEvidence: [supporting],
        matchedAnchors: [
          matchedAnchor(source, 1, 1, 'lower_bound'),
          matchedAnchor(source, 1, 4, 'upper_bound'),
        ],
      },
      {
        ...itemBase(2),
        status: 'scored',
        score: 4,
        supportingEvidence: [supporting],
        matchedAnchors: [matchedAnchor(source, 2, 4, 'exact')],
      },
      {
        ...itemBase(3),
        status: 'scored',
        score: 5,
        supportingEvidence: [supporting],
        counterEvidence: [counter],
        matchedAnchors: [
          matchedAnchor(source, 3, 4, 'lower_bound'),
          matchedAnchor(source, 3, 7, 'upper_bound'),
        ],
      },
      {
        ...itemBase(4),
        status: 'scored',
        score: 7,
        counterEvidence: [counter],
        matchedAnchors: [matchedAnchor(source, 4, 7, 'exact')],
      },
      {
        ...itemBase(5),
        status: 'insufficient_evidence',
        score: null,
        ambiguousEvidence: [ambiguous],
        missingInformation: ['Ein konkretes Beispiel fehlt.'],
        matchedAnchors: [],
      },
      {
        ...itemBase(6),
        status: 'not_applicable',
        score: null,
        ambiguousEvidence: [absentCrisis],
        matchedAnchors: [],
      },
      {
        ...itemBase(7),
        status: 'conflicting',
        score: null,
        supportingEvidence: [supporting],
        counterEvidence: [counter],
        matchedAnchors: [],
      },
      {
        ...itemBase(8),
        status: 'scored',
        score: 6,
        supportingEvidence: [supporting],
        ambiguousEvidence: [ambiguous],
        matchedAnchors: [
          matchedAnchor(source, 8, 4, 'lower_bound'),
          matchedAnchor(source, 8, 7, 'upper_bound'),
        ],
      },
    ],
    rationale: 'Alle neun Items wurden getrennt und nur mit finaler Evidenz codiert.',
  });
}

function issueCodes(candidate: unknown): readonly string[] {
  const result = validateOrganizationalResilienceCodingOutput(
    { rubric: rubric(), session: session() },
    candidate,
  );
  expect(result.ok).toBe(false);
  return result.ok ? [] : result.issues.map((issue) => issue.code);
}

describe('evaluation transcript validation', () => {
  it('accepts a completed, ordered transcript with final interviewer and participant turns', () => {
    expect(validateEvaluationTranscript(session())).toEqual({ ok: true, value: session() });
  });

  it('accepts technical gaps inside the shared canonical entry sequence', () => {
    const source = session();
    const withGap = mvpInterviewSessionSchema.parse({
      ...source,
      transcript: [source.transcript[0], { ...source.transcript[1], sequenceNumber: 3 }],
      technicalGaps: [
        {
          gapId: 'gap-1',
          interviewId: source.interviewId,
          sequenceNumber: 2,
          source: 'speech_to_text',
          description: 'Ein nicht finalisiertes Segment bleibt als technische Luecke sichtbar.',
          occurredAt: '2026-08-14T08:00:30.000Z',
        },
      ],
    });

    expect(validateEvaluationTranscript(withGap)).toEqual({ ok: true, value: withGap });
  });

  it('rejects unresolved partials and missing participant evidence even for an active snapshot', () => {
    const invalid = {
      ...session(),
      status: 'active',
      currentQuestion: {
        questionId: 'main-1',
        sectionId: 'section-1',
        sectionTitle: 'Vor der Krise',
        kind: 'main',
        text: 'Wie bereiten Sie Entscheidungen vor?',
        reference: {
          kind: 'main_question',
          guideId: 'guide-1',
          sectionId: 'section-1',
          mainQuestionId: 'main-1',
        },
      },
      endedAt: null,
      finalizedAt: null,
      partialTranscript: 'Noch nicht final',
      transcript: session().transcript.slice(0, 1),
    };
    const result = validateEvaluationTranscript(invalid);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((issue) => issue.code)).toEqual(
        expect.arrayContaining(['partial_transcript_unresolved', 'missing_participant_turn']),
      );
    }
  });

  it('accepts confirmed turns from a completed but unfinalized interview', () => {
    const result = validateEvaluationTranscript({ ...session(), finalizedAt: null });
    expect(result).toEqual({ ok: true, value: { ...session(), finalizedAt: null } });
  });

  it.each(['active', 'paused'] as const)(
    'accepts a %s confirmed snapshot without fabricated end or finalization',
    (status) => {
      const candidate = { ...session(), status, endedAt: null, finalizedAt: null };
      expect(validateEvaluationTranscript(candidate)).toEqual({ ok: true, value: candidate });
    },
  );

  it('rejects a ready interview or a snapshot without an actual start time', () => {
    for (const candidate of [
      { ...session(), status: 'ready', startedAt: null, endedAt: null, finalizedAt: null },
      { ...session(), status: 'active', startedAt: null, endedAt: null, finalizedAt: null },
    ]) {
      expect(validateEvaluationTranscript(candidate).ok).toBe(false);
    }
  });

  it('checks active snapshot time bounds, scope, speakers and contiguous sequences', () => {
    const active = { ...session(), status: 'active', endedAt: null, finalizedAt: null };
    for (const update of [
      { ...active.transcript[1], occurredAt: '2026-08-14T09:00:00.000Z' },
      { ...active.transcript[1], occurredAt: '2026-08-14T07:00:00.000Z' },
      { ...active.transcript[1], interviewId: 'foreign-interview' },
      { ...active.transcript[1], sequenceNumber: 4 },
      { ...active.transcript[1], turnType: 'main_question' },
    ]) {
      expect(
        validateEvaluationTranscript({ ...active, transcript: [active.transcript[0], update] }).ok,
      ).toBe(false);
    }
  });

  it('rejects sequence, chronology, scope, and speaker corruption', () => {
    const invalid = session();
    const result = validateEvaluationTranscript({
      ...invalid,
      transcript: [
        invalid.transcript[0],
        {
          ...invalid.transcript[1],
          turnId: invalid.transcript[0]?.turnId,
          interviewId: 'another-interview',
          sequenceNumber: 3,
          turnType: 'closing',
          occurredAt: '2026-08-14T07:59:00.000Z',
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((issue) => issue.code)).toEqual(
        expect.arrayContaining([
          'sequence_error',
          'duplicate_turn',
          'scope_mismatch',
          'chronology_error',
          'speaker_mismatch',
        ]),
      );
    }
  });
});

describe('organizational-resilience rubric and evidence guardrails', () => {
  it('accepts the ordered nine-item rubric only for its mapped guide questions', () => {
    expect(validateEvaluationRubricAgainstGuide(rubric(), guide)).toEqual({
      ok: true,
      value: rubric(),
    });
    const source = rubric();
    const invalid = {
      ...source,
      items: source.items.map((item, index) =>
        index === 0 ? { ...item, guideQuestionIds: ['unknown-question'] } : item,
      ),
    };
    const result = validateEvaluationRubricAgainstGuide(invalid, guide);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]?.code).toBe('unknown_guide_question');
  });

  it('accepts all evidence buckets, null statuses, and exact/intermediate anchor sets', () => {
    const candidate = output();
    expect(
      validateOrganizationalResilienceCodingOutput(
        { rubric: rubric(), session: session() },
        candidate,
      ),
    ).toEqual({ ok: true, value: candidate });
    expect(candidate.items.map((item) => item.status)).toEqual(
      expect.arrayContaining(['scored', 'insufficient_evidence', 'not_applicable', 'conflicting']),
    );
    expect(candidate.items.flatMap((item) => item.supportingEvidence)).not.toHaveLength(0);
    expect(candidate.items.flatMap((item) => item.counterEvidence)).not.toHaveLength(0);
    expect(candidate.items.flatMap((item) => item.ambiguousEvidence)).not.toHaveLength(0);
    expect(
      candidate.items[1]!.matchedAnchors.map(({ score, relationship }) => ({
        score,
        relationship,
      })),
    ).toEqual([
      { score: 1, relationship: 'lower_bound' },
      { score: 4, relationship: 'upper_bound' },
    ]);
  });

  it.each([
    {
      score: 1 as const,
      text: 'Unter der Belastung brach unsere operative Position bis zur Existenzgefaehrdung ein.',
    },
    {
      score: 4 as const,
      text: 'Einzelne zentrale Funktionen blieben erhalten, aber die Kontinuitaet war nicht organisationsweit integriert.',
    },
    {
      score: 7 as const,
      text: 'Auch unter schwerer Belastung hielten wir Position, zentrale Funktionen und Stabilitaet nachweislich aufrecht.',
    },
  ])('accepts the curated rob-01 calibration fixture near anchor $score', ({ score, text }) => {
    const sourceSession = session();
    const calibratedSession = mvpInterviewSessionSchema.parse({
      ...sourceSession,
      transcript: sourceSession.transcript.map((turn) =>
        turn.speaker === 'participant'
          ? {
              ...turn,
              text: `Wir testen unsere Notfallplaene jedes Quartal. Die Zustaendigkeit ist manchmal unklar. ${text}`,
            }
          : turn,
      ),
    });
    const sourceRubric = rubric();
    const sourceOutput = output();
    const calibrationEvidence = evidence('supporting', text, 'concrete_event', 'during_adversity');
    const candidate = {
      ...sourceOutput,
      crisisContext: {
        mode: 'actual_event' as const,
        summary: 'Eine konkrete Belastung wurde fuer den Kalibrierungsfall beschrieben.',
        eventLabel: 'Belastungsereignis',
        evidence: [calibrationEvidence],
      },
      items: sourceOutput.items.map((item, index) => {
        if (index === 0) {
          return {
            ...item,
            status: 'scored' as const,
            score,
            supportingEvidence: [calibrationEvidence],
            counterEvidence: [],
            ambiguousEvidence: [],
            missingInformation: [],
            matchedAnchors: [matchedAnchor(sourceRubric, 0, score, 'exact')],
          };
        }
        return index === 6 ? { ...item, ambiguousEvidence: [] } : item;
      }),
    };

    const result = validateOrganizationalResilienceCodingOutput(
      { rubric: sourceRubric, session: calibratedSession },
      candidate,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.items[0]?.score).toBe(score);
      expect(result.value.items[0]?.supportingEvidence[0]?.verbatimExcerpt).toBe(text);
      const report = buildOrganizationalResilienceReport(
        sourceRubric,
        calibratedSession,
        result.value,
        {
          evaluationId: `evaluation-calibration-${String(score)}`,
          interviewId: calibratedSession.interviewId,
          guideId: calibratedSession.guideId,
          rubricFingerprint: 'a'.repeat(64),
          transcriptFingerprint: 'b'.repeat(64),
          promptVersion: 'calibration-fixture-v1',
          model: { mode: 'demo', provider: null, model: null },
          evaluatedAt: END,
        },
      );
      expect(report.items[0]?.matchedAnchors).toEqual([
        matchedAnchor(sourceRubric, 0, score, 'exact'),
      ]);
      expect(report.items[0]?.supportingEvidence[0]?.turnId).toBe('participant-1');
    }
  });

  it.each([
    {
      name: 'AI turn',
      reference: {
        turnId: 'ai-1',
        sequenceNumber: 1,
        verbatimExcerpt: 'Wie bereiten',
        phase: 'pre_adversity',
        direction: 'supporting',
        specificity: 'general_statement',
      },
      code: 'invalid_evidence_turn',
    },
    {
      name: 'wrong sequence',
      reference: {
        turnId: 'participant-1',
        sequenceNumber: 1,
        verbatimExcerpt: 'Wir testen unsere Notfallplaene',
        phase: 'pre_adversity',
        direction: 'supporting',
        specificity: 'concrete_practice',
      },
      code: 'evidence_sequence_mismatch',
    },
    {
      name: 'invented excerpt',
      reference: {
        turnId: 'participant-1',
        sequenceNumber: 2,
        verbatimExcerpt: 'Diese Aussage steht nicht im Transkript.',
        phase: 'pre_adversity',
        direction: 'supporting',
        specificity: 'concrete_practice',
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

  it('rejects the same excerpt assigned to two evidence directions', () => {
    const source = output();
    const duplicate = evidence('counter', 'Wir testen unsere Notfallplaene jedes Quartal');
    const candidate = {
      ...source,
      items: source.items.map((item, index) =>
        index === 0 ? { ...item, counterEvidence: [duplicate] } : item,
      ),
    };
    expect(issueCodes(candidate)).toContain('duplicate_evidence_direction');
  });

  it('does not allow absence of crisis experience to justify a numeric score', () => {
    const source = output();
    const absence = evidence(
      'supporting',
      'Wir haben noch keine Krise erlebt',
      'absence_of_crisis_experience',
    );
    const candidate = {
      ...source,
      items: source.items.map((item, index) =>
        index === 0 ? { ...item, supportingEvidence: [absence], counterEvidence: [] } : item,
      ),
    };
    expect(issueCodes(candidate)).toContain('absence_as_low_score');
  });

  it('rejects absence evidence even when mixed with score evidence or relabeled', () => {
    const source = output();
    const absence = evidence(
      'supporting',
      'Wir haben noch keine Krise erlebt',
      'absence_of_crisis_experience',
    );
    const regular = evidence('supporting', 'Wir testen unsere Notfallplaene jedes Quartal');
    const mixed = {
      ...source,
      items: source.items.map((item, index) =>
        index === 0
          ? { ...item, supportingEvidence: [absence, regular], counterEvidence: [] }
          : item,
      ),
    };
    expect(issueCodes(mixed)).toContain('absence_as_low_score');

    const relabeledAbsence = {
      ...source,
      items: source.items.map((item, index) =>
        index === 0
          ? {
              ...item,
              supportingEvidence: [
                evidence('supporting', 'Wir haben noch keine Krise erlebt', 'general_statement'),
              ],
              counterEvidence: [],
            }
          : item,
      ),
    };
    expect(issueCodes(relabeledAbsence)).toContain('absence_as_low_score');
  });

  it('does not allow exclusively hypothetical evidence to justify an observed score', () => {
    const source = output();
    const hypothetical = {
      ...source,
      items: source.items.map((item, index) =>
        index === 0
          ? {
              ...item,
              supportingEvidence: [
                evidence(
                  'supporting',
                  'Wir testen unsere Notfallplaene jedes Quartal',
                  'hypothetical_statement',
                ),
              ],
              counterEvidence: [],
            }
          : item,
      ),
    };
    expect(issueCodes(hypothetical)).toContain('hypothetical_as_observed_score');
  });

  it('requires an explicit absence reference for no-crisis context', () => {
    const source = output();
    const candidate = {
      ...source,
      crisisContext: {
        ...source.crisisContext,
        evidence: [evidence('supporting', 'Wir testen unsere Notfallplaene jedes Quartal')],
      },
    };
    expect(issueCodes(candidate)).toContain('invalid_crisis_context');
  });

  it('requires mode-specific evidence for actual and hypothetical crisis context', () => {
    const source = output();
    const actualWithoutEventEvidence = {
      ...source,
      crisisContext: {
        mode: 'actual_event' as const,
        summary: 'Ein Ereignis wird behauptet, aber nicht belegt.',
        eventLabel: 'Krise',
        evidence: [],
      },
    };
    expect(issueCodes(actualWithoutEventEvidence)).toContain('invalid_crisis_context');

    const hypotheticalWithoutHypotheticalEvidence = {
      ...source,
      crisisContext: {
        mode: 'hypothetical' as const,
        summary: 'Eine hypothetische Lage wird behauptet, aber nicht passend belegt.',
        eventLabel: null,
        evidence: [evidence('ambiguous', 'Die Zustaendigkeit ist manchmal unklar')],
      },
    };
    expect(issueCodes(hypotheticalWithoutHypotheticalEvidence)).toContain('invalid_crisis_context');
  });

  it('requires evidence for every covered or partially covered process phase', () => {
    const source = output();
    const candidate = {
      ...source,
      processPhases: source.processPhases.map((phase, index) =>
        index === 0 ? { ...phase, evidence: [] } : phase,
      ),
    };
    expect(issueCodes(candidate)).toContain('unsupported_process_phase');
  });

  it('rejects a changed anchor interpretation and incorrect bound relationships', () => {
    const source = output();
    const changedInterpretation = {
      ...source,
      items: source.items.map((item, index) =>
        index === 0
          ? {
              ...item,
              matchedAnchors: item.matchedAnchors.map((anchor) => ({
                ...anchor,
                interpretation: 'Nicht freigegebene Interpretation',
              })),
            }
          : item,
      ),
    };
    expect(issueCodes(changedInterpretation)).toContain('invalid_anchor_reference');

    const incorrectRelationships = {
      ...source,
      items: source.items.map((item, index) =>
        index === 1
          ? {
              ...item,
              matchedAnchors: item.matchedAnchors.map((anchor) => ({
                ...anchor,
                relationship: 'exact' as const,
              })),
            }
          : item,
      ),
    };
    expect(issueCodes(incorrectRelationships)).toContain('invalid_anchor_reference');
  });

  it('rejects invalid anchor sets and reordered item tuples at the strict schema boundary', () => {
    const source = output();
    const invalidAnchorSet = {
      ...source,
      items: source.items.map((item, index) =>
        index === 1 ? { ...item, matchedAnchors: item.matchedAnchors.slice(0, 1) } : item,
      ),
    };
    expect(issueCodes(invalidAnchorSet)).toContain('schema_invalid');

    const reordered = {
      ...source,
      items: [source.items[1], source.items[0], ...source.items.slice(2)],
    };
    expect(issueCodes(reordered)).toContain('schema_invalid');
  });
});
