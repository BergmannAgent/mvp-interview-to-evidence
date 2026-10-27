import { z } from 'zod';

import { idSchema, nonBlankTextSchema, timestampSchema } from './primitives.js';

export const SECTION_MEMORY_MAX_SERIALIZED_CHARACTERS = 12_000;

export const sectionMemoryEvidenceSchema = z
  .strictObject({
    statement: nonBlankTextSchema.max(800),
    transcriptTurnIds: z.array(idSchema).min(1).max(20),
  })
  .superRefine((evidence, context) => {
    if (new Set(evidence.transcriptTurnIds).size !== evidence.transcriptTurnIds.length) {
      context.addIssue({
        code: 'custom',
        path: ['transcriptTurnIds'],
        message: 'Section-memory transcript references must be unique',
      });
    }
  });

export const sectionMemoryOpenAspectSchema = z.strictObject({
  questionId: idSchema,
  description: nonBlankTextSchema.max(500),
});

export const sectionMemorySchema = z
  .strictObject({
    interviewId: idSchema,
    guideId: idSchema,
    sectionId: idSchema,
    sectionTitle: nonBlankTextSchema.max(300),
    coveredQuestionIds: z.array(idSchema).max(500),
    partiallyCoveredQuestionIds: z.array(idSchema).max(500),
    facts: z.array(sectionMemoryEvidenceSchema).max(40),
    examples: z.array(sectionMemoryEvidenceSchema).max(20),
    limitations: z.array(sectionMemoryEvidenceSchema).max(20),
    openAspects: z.array(sectionMemoryOpenAspectSchema).max(500),
    possibleContradictions: z.array(sectionMemoryEvidenceSchema).max(20),
    sourceThroughSequenceNumber: z.number().int().positive(),
    compactedAt: timestampSchema,
  })
  .superRefine((memory, context) => {
    const covered = new Set(memory.coveredQuestionIds);
    const partial = new Set(memory.partiallyCoveredQuestionIds);
    if (covered.size !== memory.coveredQuestionIds.length) {
      addUniqueIssue(context, ['coveredQuestionIds']);
    }
    if (partial.size !== memory.partiallyCoveredQuestionIds.length) {
      addUniqueIssue(context, ['partiallyCoveredQuestionIds']);
    }
    if (memory.partiallyCoveredQuestionIds.some((questionId) => covered.has(questionId))) {
      context.addIssue({
        code: 'custom',
        path: ['partiallyCoveredQuestionIds'],
        message: 'Covered and partially covered section-memory questions must be disjoint',
      });
    }
    const openQuestionIds = memory.openAspects.map((aspect) => aspect.questionId);
    if (new Set(openQuestionIds).size !== openQuestionIds.length) {
      addUniqueIssue(context, ['openAspects']);
    }
    if (JSON.stringify(memory).length > SECTION_MEMORY_MAX_SERIALIZED_CHARACTERS) {
      context.addIssue({
        code: 'custom',
        message: 'Section memory exceeds the total serialized character limit',
      });
    }
  });

function addUniqueIssue(context: z.RefinementCtx, path: readonly PropertyKey[]): void {
  context.addIssue({
    code: 'custom',
    path: [...path],
    message: 'Section-memory references must be unique',
  });
}

export type SectionMemoryEvidence = z.infer<typeof sectionMemoryEvidenceSchema>;
export type SectionMemoryOpenAspect = z.infer<typeof sectionMemoryOpenAspectSchema>;
export type SectionMemory = z.infer<typeof sectionMemorySchema>;
