import { sectionMemorySchema, type SectionMemory } from '@orgscience/contracts';

import { buildGuideQuestionCatalog, type InterviewGuideSnapshot } from '../guide/index.js';
import type { GuideCoverageState } from './coverage.js';
import type {
  ParticipantTranscriptTurn,
  TranscriptAggregate,
  TranscriptGuideReference,
} from '../transcript/index.js';

const MAXIMUM_MEMORY_FACTS = 12;
const MAXIMUM_FACT_LENGTH = 320;
const MAXIMUM_MEMORY_FACT_CHARACTERS = 2_400;

export interface SectionTransition {
  readonly fromSectionId: string;
  readonly fromSectionTitle: string;
  readonly toSectionId: string;
}

export interface SectionMemorySource {
  readonly interviewId: string;
  readonly guide: InterviewGuideSnapshot;
  readonly coverage: GuideCoverageState;
  readonly transcript: TranscriptAggregate;
  readonly sectionId: string;
  readonly sourceThroughSequenceNumber: number;
  readonly compactedAt: string;
}

export interface SectionMemoryValidationOptions {
  readonly requireCoverageSnapshot?: boolean;
  readonly requireExactCompactedAt?: boolean;
}

export class SectionMemoryValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'SectionMemoryValidationError';
  }
}

export function detectGuideSectionTransition(
  guide: InterviewGuideSnapshot,
  currentQuestionId: string,
  nextTurn: {
    readonly turnType: string;
    readonly guideReference: TranscriptGuideReference | null;
  },
): SectionTransition | null {
  if (nextTurn.turnType !== 'main_question' || nextTurn.guideReference === null) return null;
  const catalog = buildGuideQuestionCatalog(guide);
  const current = catalog.find((question) => question.questionId === currentQuestionId);
  const next = catalog.find(
    (question) =>
      question.kind === 'main' && question.questionId === nextTurn.guideReference?.mainQuestionId,
  );
  if (current === undefined || next === undefined || current.sectionId === next.sectionId) {
    return null;
  }
  return {
    fromSectionId: current.sectionId,
    fromSectionTitle: current.sectionTitle,
    toSectionId: next.sectionId,
  };
}

export function createDeterministicSectionMemory(source: SectionMemorySource): SectionMemory {
  const catalog = buildGuideQuestionCatalog(source.guide);
  const section = source.guide.sections.find((candidate) => candidate.id === source.sectionId);
  if (
    section === undefined ||
    source.interviewId !== source.coverage.interviewId ||
    source.interviewId !== source.transcript.interviewId ||
    source.guide.id !== source.coverage.guideId ||
    source.guide.id !== source.transcript.guideId
  ) {
    throw new SectionMemoryValidationError('Section-memory source scopes are inconsistent');
  }

  const sectionQuestionIds = new Set(
    catalog
      .filter((question) => question.sectionId === source.sectionId)
      .map((question) => question.questionId),
  );
  const sectionCoverage = source.coverage.questions.filter((question) =>
    sectionQuestionIds.has(question.questionId),
  );
  const participantTurns = source.transcript.entries.filter(
    (entry): entry is ParticipantTranscriptTurn =>
      entry.kind === 'turn' &&
      entry.speaker === 'participant' &&
      entry.sequenceNumber <= source.sourceThroughSequenceNumber &&
      entry.guideReference?.sectionId === source.sectionId,
  );
  const memory = sectionMemorySchema.parse({
    interviewId: source.interviewId,
    guideId: source.guide.id,
    sectionId: source.sectionId,
    sectionTitle: section.title,
    coveredQuestionIds: sectionCoverage.flatMap((question) =>
      question.status === 'answered' || question.status === 'skipped_already_answered'
        ? [question.questionId]
        : [],
    ),
    partiallyCoveredQuestionIds: sectionCoverage.flatMap((question) =>
      question.status === 'partially_answered' ? [question.questionId] : [],
    ),
    facts: compactParticipantFacts(participantTurns),
    examples: [],
    limitations: [],
    openAspects: sectionCoverage.flatMap((coverage) => {
      if (coverage.status !== 'not_addressed' && coverage.status !== 'partially_answered')
        return [];
      const question = catalog.find((candidate) => candidate.questionId === coverage.questionId);
      return question === undefined
        ? []
        : [{ questionId: question.questionId, description: question.text }];
    }),
    possibleContradictions: [],
    sourceThroughSequenceNumber: source.sourceThroughSequenceNumber,
    compactedAt: source.compactedAt,
  });
  return validateSectionMemoryAgainstSource(memory, source);
}

export function validateSectionMemoryAgainstSource(
  candidate: unknown,
  source: SectionMemorySource,
  options: SectionMemoryValidationOptions = {},
): SectionMemory {
  const parsed = sectionMemorySchema.safeParse(candidate);
  if (!parsed.success) {
    throw new SectionMemoryValidationError('Section memory does not satisfy its contract');
  }
  const memory = parsed.data;
  const catalog = buildGuideQuestionCatalog(source.guide);
  const section = source.guide.sections.find(
    (candidateSection) => candidateSection.id === source.sectionId,
  );
  if (
    section === undefined ||
    source.coverage.interviewId !== source.interviewId ||
    source.transcript.interviewId !== source.interviewId ||
    source.coverage.guideId !== source.guide.id ||
    source.transcript.guideId !== source.guide.id ||
    memory.interviewId !== source.interviewId ||
    memory.guideId !== source.guide.id ||
    memory.sectionId !== section.id ||
    memory.sectionTitle !== section.title ||
    memory.sourceThroughSequenceNumber !== source.sourceThroughSequenceNumber ||
    (options.requireExactCompactedAt !== false
      ? memory.compactedAt !== source.compactedAt
      : Date.parse(memory.compactedAt) > Date.parse(source.compactedAt))
  ) {
    throw new SectionMemoryValidationError('Section memory does not match its interview boundary');
  }

  const questions = new Map(
    catalog
      .filter((question) => question.sectionId === section.id)
      .map((question) => [question.questionId, question] as const),
  );
  const expectedCovered = source.coverage.questions.flatMap((question) =>
    questions.has(question.questionId) &&
    (question.status === 'answered' || question.status === 'skipped_already_answered')
      ? [question.questionId]
      : [],
  );
  const expectedPartial = source.coverage.questions.flatMap((question) =>
    questions.has(question.questionId) && question.status === 'partially_answered'
      ? [question.questionId]
      : [],
  );
  const coverageMatches =
    options.requireCoverageSnapshot !== false
      ? sameIdentifiers(memory.coveredQuestionIds, expectedCovered) &&
        sameIdentifiers(memory.partiallyCoveredQuestionIds, expectedPartial)
      : memory.coveredQuestionIds.every((questionId) => expectedCovered.includes(questionId)) &&
        memory.partiallyCoveredQuestionIds.every((questionId) =>
          [...expectedCovered, ...expectedPartial].includes(questionId),
        );
  if (!coverageMatches || memory.openAspects.some((aspect) => !questions.has(aspect.questionId))) {
    throw new SectionMemoryValidationError('Section memory contains invalid question references');
  }

  const participantTurns = new Map(
    source.transcript.entries.flatMap((entry) =>
      entry.kind === 'turn' &&
      entry.speaker === 'participant' &&
      entry.sequenceNumber <= source.sourceThroughSequenceNumber &&
      entry.guideReference?.sectionId === section.id
        ? [[entry.turnId, entry] as const]
        : [],
    ),
  );
  const boundaryTurn = [...participantTurns.values()].find(
    (turn) => turn.sequenceNumber === source.sourceThroughSequenceNumber,
  );
  if (boundaryTurn === undefined) {
    throw new SectionMemoryValidationError(
      'Section-memory boundary does not reference a final participant turn',
    );
  }
  if (Date.parse(memory.compactedAt) < Date.parse(boundaryTurn.occurredAt)) {
    throw new SectionMemoryValidationError(
      'Section-memory compaction predates its final participant turn',
    );
  }
  for (const evidence of [
    ...memory.facts,
    ...memory.examples,
    ...memory.limitations,
    ...memory.possibleContradictions,
  ]) {
    const referenced = evidence.transcriptTurnIds.map((turnId) => participantTurns.get(turnId));
    if (
      referenced.some((turn) => turn === undefined) ||
      !referenced.some((turn) => turn?.text.includes(evidence.statement))
    ) {
      throw new SectionMemoryValidationError(
        'Section-memory evidence is not supported by referenced participant turns',
      );
    }
  }
  return memory;
}

function compactParticipantFacts(
  participantTurns: readonly ParticipantTranscriptTurn[],
): SectionMemory['facts'] {
  const reverseChronologicalFacts: SectionMemory['facts'][number][] = [];
  let remainingCharacters = MAXIMUM_MEMORY_FACT_CHARACTERS;
  for (const turn of participantTurns.toReversed()) {
    if (reverseChronologicalFacts.length >= MAXIMUM_MEMORY_FACTS || remainingCharacters === 0) {
      break;
    }
    const statement = verbatimExcerpt(
      turn.text,
      Math.min(MAXIMUM_FACT_LENGTH, remainingCharacters),
    );
    if (statement.length === 0) continue;
    reverseChronologicalFacts.push({ statement, transcriptTurnIds: [turn.turnId] });
    remainingCharacters -= statement.length;
  }
  return reverseChronologicalFacts.reverse();
}

function verbatimExcerpt(text: string, maximumLength: number): string {
  const trimmed = text.trim();
  return trimmed.length <= maximumLength ? trimmed : trimmed.slice(0, maximumLength).trimEnd();
}

function sameIdentifiers(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length && left.every((identifier, index) => identifier === right[index])
  );
}
