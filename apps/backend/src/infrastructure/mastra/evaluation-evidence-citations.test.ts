import {
  mvpInterviewSessionSchema,
  profileEvaluationProviderCodingOutputSchema,
  type MvpInterviewSession,
} from '@orgscience/contracts';
import { describe, expect, it } from 'vitest';

import { restoreEvaluationEvidenceCitations } from './evaluation-evidence-citations.js';

const NOW = '2026-08-21T10:00:00.000Z';
const INTERVIEW_ID = 'interview-citation-restoration';
const BUCKETS = ['supportingEvidence', 'counterEvidence'] as const;

function session(text: string, additionalText = 'Weitere Angaben fehlen.'): MvpInterviewSession {
  return mvpInterviewSessionSchema.parse({
    interviewId: INTERVIEW_ID,
    guideId: 'guide-citation-restoration',
    guideTitle: 'Citation restoration',
    status: 'completed',
    currentQuestionIndex: 1,
    totalQuestions: 1,
    currentQuestion: null,
    startedAt: NOW,
    endedAt: NOW,
    updatedAt: NOW,
    finalizedAt: NOW,
    partialTranscript: null,
    technicalGaps: [],
    transcript: [
      {
        turnId: 'turn-ai',
        interviewId: INTERVIEW_ID,
        sequenceNumber: 1,
        speaker: 'ai_interviewer',
        turnType: 'main_question',
        text,
        occurredAt: NOW,
        guideReference: null,
      },
      {
        turnId: 'turn-participant',
        interviewId: INTERVIEW_ID,
        sequenceNumber: 2,
        speaker: 'participant',
        turnType: 'participant_answer',
        text,
        occurredAt: NOW,
        guideReference: null,
      },
      {
        turnId: 'turn-additional',
        interviewId: INTERVIEW_ID,
        sequenceNumber: 3,
        speaker: 'participant',
        turnType: 'participant_answer',
        text: additionalText,
        occurredAt: NOW,
        guideReference: null,
      },
    ],
  });
}

function output(excerpt: string) {
  return profileEvaluationProviderCodingOutputSchema.parse({
    participantDetails: { age: null, position: null },
    items: [
      {
        itemId: 'process-review',
        dimensionId: 'process',
        status: 'scored',
        score: 4,
        confidence: 0.8,
        supportingEvidence: [
          {
            turnId: 'turn-participant',
            sequenceNumber: 2,
            verbatimExcerpt: excerpt,
            inference: null,
            additionalSources: [],
          },
        ],
        counterEvidence: [],
        missingInformation: [],
        rationale: 'The cited participant statement describes the review process.',
      },
    ],
    rationale: 'The profile was evaluated using participant evidence.',
  });
}

function restored(source: MvpInterviewSession, candidate: unknown) {
  return profileEvaluationProviderCodingOutputSchema.parse(
    restoreEvaluationEvidenceCitations(source, candidate),
  );
}

describe('restoreEvaluationEvidenceCitations', () => {
  it.each([
    [
      'Wir  dokumentieren\n jede\tFreigabe.',
      'dokumentieren jede Freigabe',
      'dokumentieren\n jede\tFreigabe',
    ],
    [
      'Wir dokumentieren jede Freigabe.',
      'dokumentieren\n jede\tFreigabe',
      'dokumentieren jede Freigabe',
    ],
    [
      'Wir nutzen\u00a0ein\u202fReview\u2003pro Woche.',
      'ein Review pro Woche',
      'ein\u202fReview\u2003pro Woche',
    ],
    ['Es gilt [A+B] (v1.2)?\tJa* exakt.', '[A+B] (v1.2)? Ja* exakt.', '[A+B] (v1.2)?\tJa* exakt.'],
    [
      'Es gibt informelle Abstimmung, kein formaler Prozess.',
      'Kein formaler Prozess',
      'kein formaler Prozess',
    ],
    [
      'Es gibt informelle Abstimmung, kein\tformaler  Prozess.',
      'Kein formaler Prozess',
      'kein\tformaler  Prozess',
    ],
  ])('restores only the original contiguous source span in %j', (text, excerpt, expected) => {
    const candidate = output(excerpt);
    const result = restored(session(text), candidate);

    expect(result).toEqual({
      ...candidate,
      items: [
        {
          ...candidate.items[0],
          supportingEvidence: [
            { ...candidate.items[0]!.supportingEvidence[0], verbatimExcerpt: expected },
          ],
        },
      ],
    });
  });

  it.each(BUCKETS)('restores primary and additional citations in %s', (bucket) => {
    const source = session('Es gibt kein\tformaler Prozess.', 'Wir pruefen\n jede Freigabe.');
    const candidate = output('Es gibt');
    const evidence = {
      turnId: 'turn-participant',
      sequenceNumber: 2,
      verbatimExcerpt: 'Kein formaler Prozess',
      inference: 'Die Angaben zeigen eine informelle Pruefung.',
      additionalSources: [
        {
          turnId: 'turn-additional',
          sequenceNumber: 3,
          verbatimExcerpt: 'pruefen jede Freigabe',
        },
      ],
    };
    candidate.items[0]![bucket] = [evidence];

    expect(restored(source, candidate).items[0]![bucket]).toEqual([
      {
        ...evidence,
        verbatimExcerpt: 'kein\tformaler Prozess',
        additionalSources: [
          { ...evidence.additionalSources[0], verbatimExcerpt: 'pruefen\n jede Freigabe' },
        ],
      },
    ]);
  });

  it('preserves exact excerpts even when other occurrences normalize to the same text', () => {
    const source = session('kein formaler Prozess; kein\tformaler Prozess; kein formaler Prozess.');
    const candidate = output('kein formaler Prozess');

    expect(restoreEvaluationEvidenceCitations(source, candidate)).toEqual(candidate);
  });

  it.each([
    ['foreign-turn', 2],
    ['turn-participant', 3],
    ['turn-additional', 2],
    ['turn-ai', 1],
  ])('does not repair an ineligible reference %s at sequence %s', (turnId, sequenceNumber) => {
    const source = session('Wir\tpruefen Freigaben.');
    const candidate = output('Wir pruefen Freigaben');
    Object.assign(candidate.items[0]!.supportingEvidence[0]!, { turnId, sequenceNumber });

    expect(restoreEvaluationEvidenceCitations(source, candidate)).toEqual(candidate);
  });

  it('does not search other turns for the proposed excerpt', () => {
    const source = session('Wir dokumentieren Freigaben.', 'Wir\tpruefen Freigaben.');
    const candidate = output('Wir pruefen Freigaben');

    expect(restoreEvaluationEvidenceCitations(source, candidate)).toEqual(candidate);
  });

  it('applies the same source identity restrictions to additional sources', () => {
    const source = session('Wir\tpruefen Freigaben.');
    const candidate = output('Freigaben');
    candidate.items[0]!.supportingEvidence[0]!.additionalSources = [
      { turnId: 'turn-ai', sequenceNumber: 1, verbatimExcerpt: 'Wir pruefen Freigaben' },
      { turnId: 'turn-participant', sequenceNumber: 3, verbatimExcerpt: 'Wir pruefen Freigaben' },
      { turnId: 'foreign-turn', sequenceNumber: 2, verbatimExcerpt: 'Wir pruefen Freigaben' },
    ];

    expect(restoreEvaluationEvidenceCitations(source, candidate)).toEqual(candidate);
  });

  it.each([
    ['Wir pruefen jede Freigabe.', 'Wir dokumentieren jede Freigabe'],
    ['Es gibt keinen formalen Prozess.', 'Es gibt einen formalen Prozess'],
    ['Wir pruefen 12 Freigaben.', 'Wir pruefen 21 Freigaben'],
    ['Wir pruefen Freigaben.', 'Wir pruefen Freigaben!'],
    ['Wir pruefen Freigaben.', 'Wir pruefen freigaben'],
    ['Kein formaler Prozess.', 'kein formaler Prozess'],
    ['Es gibt kein formaler Prozess.', 'KEIN formaler Prozess'],
    ['i\u0307st dokumentiert.', '\u0130st dokumentiert'],
    ['\u00df ist dokumentiert.', 'S ist dokumentiert'],
    ['Wir pruefen Freigaben.', 'Wir prufen Freigaben'],
    ['Wir pruefen Freigaben.', 'Freigaben pruefen Wir'],
    ['Wir pruefen heute alle Freigaben.', 'Wir pruefen Freigaben'],
    ['Wir pruefen. Danach dokumentieren wir Freigaben.', 'Wir pruefen Freigaben'],
    ['Es gilt AAB\t(v1x2)? Ja* exakt.', 'A+B (v1.2)? Ja* exakt.'],
  ])('does not repair changed content %j to %j', (text, excerpt) => {
    const candidate = output(excerpt);

    expect(restoreEvaluationEvidenceCitations(session(text), candidate)).toEqual(candidate);
  });

  it.each([
    ['Wir\tpruefen Freigaben; Wir\npruefen Freigaben.', 'Wir pruefen Freigaben'],
    ['kein\tformaler Prozess; kein\nformaler Prozess.', 'Kein formaler Prozess'],
    ['Kein\tformaler Prozess; kein\nformaler Prozess.', 'Kein formaler Prozess'],
    ['a a a', 'A a'],
  ])('leaves ambiguous normalized matches untouched in %j', (text, excerpt) => {
    const candidate = output(excerpt);

    expect(restoreEvaluationEvidenceCitations(session(text), candidate)).toEqual(candidate);
  });

  it('does not combine spans across participant turns', () => {
    const source = session('Wir pruefen', 'jede Freigabe.');
    const candidate = output('Wir pruefen jede Freigabe');

    expect(restoreEvaluationEvidenceCitations(source, candidate)).toEqual(candidate);
  });

  it('does not mutate the candidate or interview transcript', () => {
    const source = session('Es gibt kein\tformaler Prozess.');
    const candidate = output('Kein formaler Prozess');
    const originalSource = structuredClone(source);
    const originalCandidate = structuredClone(candidate);

    const result = restored(source, candidate);

    expect(result.items[0]!.supportingEvidence[0]!.verbatimExcerpt).toBe('kein\tformaler Prozess');
    expect(source).toEqual(originalSource);
    expect(candidate).toEqual(originalCandidate);
  });

  it.each(['bucket', 'additionalSources'] as const)(
    'leaves restoration-created duplicates in %s for strict schema validation',
    (location) => {
      const source = session('Es gibt kein formaler Prozess.');
      const candidate = output('Kein formaler Prozess');
      const evidence = candidate.items[0]!.supportingEvidence[0]!;
      const duplicate = {
        turnId: evidence.turnId,
        sequenceNumber: evidence.sequenceNumber,
        verbatimExcerpt: 'kein formaler Prozess',
      };
      if (location === 'bucket') {
        candidate.items[0]!.supportingEvidence.push({ ...evidence, ...duplicate });
      } else {
        evidence.additionalSources.push(duplicate);
      }
      expect(profileEvaluationProviderCodingOutputSchema.safeParse(candidate).success).toBe(true);

      const result = restoreEvaluationEvidenceCitations(source, candidate);

      expect(result).toHaveProperty(
        'items.0.supportingEvidence.0.verbatimExcerpt',
        'kein formaler Prozess',
      );
      expect(profileEvaluationProviderCodingOutputSchema.safeParse(result).success).toBe(false);
    },
  );

  it('leaves restored excerpts exceeding the length limit for strict schema validation', () => {
    const original = `Wir${' '.repeat(2_000)}pruefen`;
    const source = session(`${original} Freigaben.`);
    const candidate = output('Wir pruefen');

    const result = restoreEvaluationEvidenceCitations(source, candidate);

    expect(result).toMatchObject({
      items: [{ supportingEvidence: [{ verbatimExcerpt: original }] }],
    });
    expect(profileEvaluationProviderCodingOutputSchema.safeParse(result).success).toBe(false);
  });

  it.each([undefined, null, 'invalid', {}, { items: [], rationale: 'No items' }])(
    'returns invalid candidate %j unchanged',
    (candidate) => {
      expect(restoreEvaluationEvidenceCitations(session('Wir arbeiten.'), candidate)).toBe(
        candidate,
      );
    },
  );

  it('does not repair citations in an otherwise invalid classified output', () => {
    const source = session('Wir\tpruefen Freigaben.');
    const candidate = output('Wir pruefen Freigaben');
    const invalid = { ...candidate, unexpected: true };

    expect(restoreEvaluationEvidenceCitations(source, invalid)).toBe(invalid);
    expect(invalid.items[0]!.supportingEvidence[0]!.verbatimExcerpt).toBe('Wir pruefen Freigaben');
  });
});
