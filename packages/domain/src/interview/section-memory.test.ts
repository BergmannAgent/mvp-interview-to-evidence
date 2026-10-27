import { describe, expect, it } from 'vitest';

import { SECTION_MEMORY_MAX_SERIALIZED_CHARACTERS } from '@orgscience/contracts';

import { applyCoverageUpdates, initializeGuideCoverage } from './coverage.js';
import {
  createDeterministicSectionMemory,
  detectGuideSectionTransition,
  validateSectionMemoryAgainstSource,
} from './section-memory.js';
import type { InterviewGuideSnapshot } from '../guide/index.js';
import type { ParticipantTranscriptTurn, TranscriptAggregate } from '../transcript/index.js';

const AT = '2026-09-11T12:00:00.000Z';
const INTERVIEW_ID = 'interview-memory-1';
const GUIDE_ID = 'guide-memory-1';
const SECTION_A = 'section-markt';
const SECTION_B = 'section-nachsorge';
const MAIN_A = 'question-markt-main';
const FOLLOW_A = 'question-markt-follow';
const MAIN_B = 'question-nachsorge-main';

const guide: InterviewGuideSnapshot = {
  id: GUIDE_ID,
  sourceLanguage: 'de',
  title: 'Beliebige Abschnitte',
  sourceMarkdown: '# Beliebige Abschnitte',
  createdAt: AT,
  sections: [
    {
      id: SECTION_A,
      position: 0,
      title: 'Marktbeobachtung',
      mainQuestions: [
        {
          id: MAIN_A,
          position: 0,
          text: 'Was beobachten Sie?',
          followUpQuestions: [
            { id: FOLLOW_A, position: 0, text: 'Welches Beispiel ist relevant?' },
          ],
        },
      ],
    },
    {
      id: SECTION_B,
      position: 1,
      title: 'Nachsorge',
      mainQuestions: [
        {
          id: MAIN_B,
          position: 0,
          text: 'Was geschieht danach?',
          followUpQuestions: [],
        },
      ],
    },
  ],
};

const mainAReference = {
  kind: 'main_question',
  guideId: GUIDE_ID,
  sectionId: SECTION_A,
  mainQuestionId: MAIN_A,
} as const;
const mainBReference = {
  kind: 'main_question',
  guideId: GUIDE_ID,
  sectionId: SECTION_B,
  mainQuestionId: MAIN_B,
} as const;

describe('section memory', () => {
  it('detects only a main-question transition across dynamic guide sections', () => {
    expect(
      detectGuideSectionTransition(guide, MAIN_A, {
        turnType: 'main_question',
        guideReference: mainBReference,
      }),
    ).toEqual({
      fromSectionId: SECTION_A,
      fromSectionTitle: 'Marktbeobachtung',
      toSectionId: SECTION_B,
    });
    expect(
      detectGuideSectionTransition(guide, MAIN_A, {
        turnType: 'clarification_question',
        guideReference: mainAReference,
      }),
    ).toBeNull();
    expect(
      detectGuideSectionTransition(guide, MAIN_A, {
        turnType: 'closing',
        guideReference: null,
      }),
    ).toBeNull();
  });

  it('creates a bounded verbatim memory with valid question and turn references', () => {
    const source = memorySource();
    const memory = createDeterministicSectionMemory(source);

    expect(memory).toMatchObject({
      interviewId: INTERVIEW_ID,
      guideId: GUIDE_ID,
      sectionId: SECTION_A,
      sectionTitle: 'Marktbeobachtung',
      coveredQuestionIds: [MAIN_A],
      partiallyCoveredQuestionIds: [],
      facts: [
        { statement: 'Wir beobachten Lieferzeiten taeglich.', transcriptTurnIds: ['turn-a'] },
      ],
      openAspects: [{ questionId: FOLLOW_A, description: 'Welches Beispiel ist relevant?' }],
      sourceThroughSequenceNumber: 2,
    });
  });

  it('keeps long section evidence within the global fact and character budgets', () => {
    const source = memorySource();
    const participantTemplate = source.transcript.entries.find(
      (entry): entry is ParticipantTranscriptTurn =>
        entry.kind === 'turn' && entry.speaker === 'participant',
    );
    if (participantTemplate === undefined) throw new Error('Participant fixture is missing');
    const participantEntries = Array.from({ length: 20 }, (_, index) => ({
      ...participantTemplate,
      turnId: `turn-long-${index + 1}`,
      sequenceNumber: index + 2,
      providerEventId: `item-long-${index + 1}`,
      sourceSegmentId: `item-long-${index + 1}`,
      text: `${String(index + 1).padStart(2, '0')}: ${'Evidenz '.repeat(100)}`,
    }));
    const boundarySequenceNumber = participantEntries.at(-1)?.sequenceNumber ?? 0;
    const memory = createDeterministicSectionMemory({
      ...source,
      transcript: {
        ...source.transcript,
        nextSequenceNumber: boundarySequenceNumber + 1,
        entries: [source.transcript.entries[0]!, ...participantEntries],
      },
      sourceThroughSequenceNumber: boundarySequenceNumber,
    });

    expect(memory.facts.length).toBeLessThanOrEqual(12);
    expect(
      memory.facts.reduce((total, fact) => total + fact.statement.length, 0),
    ).toBeLessThanOrEqual(2_400);
    expect(memory.facts.every((fact) => fact.statement.length <= 320)).toBe(true);
    expect(JSON.stringify(memory).length).toBeLessThanOrEqual(
      SECTION_MEMORY_MAX_SERIALIZED_CHARACTERS,
    );
  });

  it('rejects foreign evidence, unknown questions, and scoring fields', () => {
    const source = memorySource();
    const valid = createDeterministicSectionMemory(source);
    expect(() =>
      validateSectionMemoryAgainstSource(
        {
          ...valid,
          facts: [{ statement: 'Erfundene Aussage', transcriptTurnIds: ['foreign-turn'] }],
        },
        source,
      ),
    ).toThrow(/evidence/u);
    expect(() =>
      validateSectionMemoryAgainstSource(
        { ...valid, openAspects: [{ questionId: MAIN_B, description: 'Falscher Abschnitt' }] },
        source,
      ),
    ).toThrow(/question references/u);
    expect(() => validateSectionMemoryAgainstSource({ ...valid, score: 7 }, source)).toThrow(
      /contract/u,
    );
    expect(() =>
      validateSectionMemoryAgainstSource(
        { ...valid, sourceThroughSequenceNumber: 999 },
        { ...source, sourceThroughSequenceNumber: 999 },
      ),
    ).toThrow(/boundary/u);
    expect(() =>
      validateSectionMemoryAgainstSource(valid, {
        ...source,
        transcript: { ...source.transcript, interviewId: 'foreign-interview' },
      }),
    ).toThrow(/interview boundary/u);
    expect(() =>
      validateSectionMemoryAgainstSource(
        { ...valid, compactedAt: '2030-01-01T00:00:00.000Z' },
        source,
      ),
    ).toThrow(/interview boundary/u);
    expect(() =>
      validateSectionMemoryAgainstSource(
        { ...valid, compactedAt: '2026-09-11T11:59:00.000Z' },
        { ...source, compactedAt: '2026-09-11T12:01:00.000Z' },
        { requireExactCompactedAt: false },
      ),
    ).toThrow(/predates/u);
  });

  it('restores a valid snapshot after later coverage progress without weakening creation checks', () => {
    const source = memorySource();
    const memory = createDeterministicSectionMemory(source);
    const progressedCoverage = applyCoverageUpdates(guide, source.coverage, {
      interviewId: INTERVIEW_ID,
      guideId: GUIDE_ID,
      expectedRevision: source.coverage.revision,
      updates: [
        {
          questionId: FOLLOW_A,
          status: 'answered',
          referencedTurnIds: ['turn-a'],
          at: AT,
        },
      ],
    });
    const progressedSource = { ...source, coverage: progressedCoverage };

    expect(() => validateSectionMemoryAgainstSource(memory, progressedSource)).toThrow(
      /question references/u,
    );
    expect(
      validateSectionMemoryAgainstSource(
        memory,
        { ...progressedSource, compactedAt: '2026-09-11T12:01:00.000Z' },
        {
          requireCoverageSnapshot: false,
          requireExactCompactedAt: false,
        },
      ),
    ).toEqual(memory);
  });

  it('does not compact a guide that never crosses into another section', () => {
    const singleSectionGuide = { ...guide, sections: guide.sections.slice(0, 1) };
    expect(
      detectGuideSectionTransition(singleSectionGuide, MAIN_A, {
        turnType: 'closing',
        guideReference: null,
      }),
    ).toBeNull();
  });
});

function memorySource() {
  const initialized = initializeGuideCoverage(guide, INTERVIEW_ID);
  const coverage = applyCoverageUpdates(guide, initialized, {
    interviewId: INTERVIEW_ID,
    guideId: GUIDE_ID,
    expectedRevision: initialized.revision,
    updates: [
      { questionId: MAIN_A, status: 'answered', referencedTurnIds: ['turn-a'], at: AT },
      { questionId: MAIN_B, status: 'current', referencedTurnIds: [], at: AT },
    ],
  });
  const transcript: TranscriptAggregate = {
    interviewId: INTERVIEW_ID,
    guideId: GUIDE_ID,
    guideQuestionIndex: [mainAReference, mainBReference],
    nextSequenceNumber: 3,
    partials: [],
    finals: [],
    entries: [
      {
        kind: 'turn',
        turnId: 'question-a',
        interviewId: INTERVIEW_ID,
        sequenceNumber: 1,
        occurredAt: AT,
        deliveryEventId: 'item-question-a',
        speaker: 'ai_interviewer',
        turnType: 'main_question',
        text: 'Was beobachten Sie?',
        delivery: { status: 'complete' },
        guideReference: mainAReference,
      },
      {
        kind: 'turn',
        turnId: 'turn-a',
        interviewId: INTERVIEW_ID,
        sequenceNumber: 2,
        occurredAt: AT,
        sourceProvider: 'openai_realtime',
        providerEventId: 'item-answer-a',
        sourceSegmentId: 'item-answer-a',
        speaker: 'participant',
        turnType: 'participant_answer',
        text: 'Wir beobachten Lieferzeiten taeglich.',
        guideReference: mainAReference,
      },
    ],
  };
  return {
    interviewId: INTERVIEW_ID,
    guide,
    coverage,
    transcript,
    sectionId: SECTION_A,
    sourceThroughSequenceNumber: 2,
    compactedAt: AT,
  } as const;
}
