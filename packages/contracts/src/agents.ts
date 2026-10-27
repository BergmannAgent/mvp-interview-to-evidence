import { z } from 'zod';

import {
  INTERVIEW_GUIDE_LIMITS,
  followUpQuestionReferenceSchema,
  guideQuestionReferenceSchema,
  mainQuestionReferenceSchema,
} from './guide.js';
import { idSchema, nonBlankTextSchema, shortRationaleSchema } from './primitives.js';

export const AGENT_DATA_LIMITS = Object.freeze({
  maximumTranscriptEntries: INTERVIEW_GUIDE_LIMITS.maximumTotalQuestions * 4 + 2,
  maximumTranscriptCodePoints: 500_000,
  maximumCoverageFindings: INTERVIEW_GUIDE_LIMITS.maximumTotalQuestions,
  maximumOpenAspectsPerFinding: 100,
  maximumContradictions: 100,
  maximumConsideredQuestions: INTERVIEW_GUIDE_LIMITS.maximumTotalQuestions,
  maximumFinalizationEntries: INTERVIEW_GUIDE_LIMITS.maximumTotalQuestions * 4 + 2,
  maximumFinalizationIssues: INTERVIEW_GUIDE_LIMITS.maximumTotalQuestions * 4 + 2,
});

const uniqueIdArraySchema = z
  .array(idSchema)
  .max(AGENT_DATA_LIMITS.maximumTranscriptEntries)
  .refine((ids) => new Set(ids).size === ids.length, 'References must be unique');

const singleQuestionSchema = nonBlankTextSchema
  .max(600)
  .refine(
    (text) => text.trim().endsWith('?') && (text.match(/\?/g) ?? []).length === 1,
    'A conductor question must contain exactly one question mark and end with it',
  );

const singleGuidePromptSchema = nonBlankTextSchema.max(600).refine((text) => {
  const questionMarkCount = (text.match(/\?/g) ?? []).length;
  return !text.includes('\n') && !text.includes('\r') && questionMarkCount <= 1;
}, 'A guide prompt must be a single prompt rather than multiple questions');

const openAspectSchema = nonBlankTextSchema
  .max(300)
  .refine(
    (text) => !text.includes('\n') && !text.includes('\r'),
    'An open aspect must be a single-line statement or prompt',
  );

const coverageFindingBaseShape = {
  question: guideQuestionReferenceSchema,
  rationale: shortRationaleSchema,
};

export const coverageFindingSchema = z.union([
  z.strictObject({
    ...coverageFindingBaseShape,
    status: z.enum(['not_addressed', 'current']),
    transcriptTurnIds: z.array(idSchema).max(0),
    openAspects: z
      .array(openAspectSchema)
      .min(1)
      .max(AGENT_DATA_LIMITS.maximumOpenAspectsPerFinding),
  }),
  z.strictObject({
    ...coverageFindingBaseShape,
    status: z.literal('partially_answered'),
    transcriptTurnIds: uniqueIdArraySchema.min(1),
    openAspects: z
      .array(openAspectSchema)
      .min(1)
      .max(AGENT_DATA_LIMITS.maximumOpenAspectsPerFinding),
  }),
  z.strictObject({
    ...coverageFindingBaseShape,
    status: z.enum(['answered', 'skipped_already_answered']),
    transcriptTurnIds: uniqueIdArraySchema.min(1),
    openAspects: z.array(nonBlankTextSchema.max(300)).max(0),
  }),
]);

export const coverageAnalysisOutputSchema = z
  .strictObject({
    findings: z.array(coverageFindingSchema).max(AGENT_DATA_LIMITS.maximumCoverageFindings),
    referencedTranscriptTurnIds: uniqueIdArraySchema,
    rationale: shortRationaleSchema,
  })
  .superRefine((output, context) => {
    const questions = new Set<string>();
    const referencedTurns = new Set(output.referencedTranscriptTurnIds);
    const evidencedTurns = new Set<string>();
    for (const [index, finding] of output.findings.entries()) {
      const key = questionReferenceKey(finding.question);
      if (questions.has(key)) {
        context.addIssue({
          code: 'custom',
          message: 'A coverage analysis may contain only one finding per question',
          path: ['findings', index, 'question'],
        });
      }
      questions.add(key);
      for (const turnId of finding.transcriptTurnIds) {
        evidencedTurns.add(turnId);
        if (!referencedTurns.has(turnId)) {
          context.addIssue({
            code: 'custom',
            message: 'Finding evidence must be listed in referencedTranscriptTurnIds',
            path: ['findings', index, 'transcriptTurnIds'],
          });
        }
      }
    }
    if (evidencedTurns.size > 0 && referencedTurns.size === 0) {
      context.addIssue({
        code: 'custom',
        message: 'Coverage evidence must be listed in referencedTranscriptTurnIds',
        path: ['referencedTranscriptTurnIds'],
      });
    }
  });

export const possibleContradictionSchema = z.strictObject({
  id: idSchema,
  transcriptTurnIds: uniqueIdArraySchema.min(2),
  description: nonBlankTextSchema.max(800),
  suggestedClarificationQuestion: singleQuestionSchema,
  shouldClarify: z.boolean(),
  rationale: shortRationaleSchema,
});

export const consistencyAnalysisOutputSchema = z
  .strictObject({
    contradictions: z
      .array(possibleContradictionSchema)
      .max(AGENT_DATA_LIMITS.maximumContradictions),
    referencedTranscriptTurnIds: uniqueIdArraySchema,
    rationale: shortRationaleSchema,
  })
  .superRefine((output, context) => {
    const contradictionIds = new Set<string>();
    const referencedTurns = new Set(output.referencedTranscriptTurnIds);
    for (const [index, contradiction] of output.contradictions.entries()) {
      if (contradictionIds.has(contradiction.id)) {
        context.addIssue({
          code: 'custom',
          message: 'Contradiction IDs must be unique',
          path: ['contradictions', index, 'id'],
        });
      }
      contradictionIds.add(contradiction.id);
      for (const turnId of contradiction.transcriptTurnIds) {
        if (!referencedTurns.has(turnId)) {
          context.addIssue({
            code: 'custom',
            message: 'Contradiction evidence must be listed in referencedTranscriptTurnIds',
            path: ['contradictions', index, 'transcriptTurnIds'],
          });
        }
      }
    }
  });

const askMainQuestionActionSchema = z.strictObject({
  action: z.literal('ask_main_question'),
  target: mainQuestionReferenceSchema,
});

const askFollowUpQuestionActionSchema = z.strictObject({
  action: z.literal('ask_follow_up_question'),
  target: followUpQuestionReferenceSchema,
});

const clarificationBasisSchema = z.strictObject({
  kind: z.literal('contradiction'),
  contradictionId: idSchema,
  sourceQuestion: singleQuestionSchema,
});

const askClarificationQuestionActionSchema = z.strictObject({
  action: z.literal('ask_clarification_question'),
  target: guideQuestionReferenceSchema,
  basis: clarificationBasisSchema,
  clarificationObjective: nonBlankTextSchema.max(400),
});

const completeInterviewActionSchema = z.strictObject({
  action: z.literal('complete_interview'),
});

export const interviewDecisionActionSchema = z.union([
  askMainQuestionActionSchema,
  askFollowUpQuestionActionSchema,
  askClarificationQuestionActionSchema,
  completeInterviewActionSchema,
]);

export const interviewDecisionOutputSchema = z
  .strictObject({
    selectedAction: interviewDecisionActionSchema,
    referencedTranscriptTurnIds: uniqueIdArraySchema,
    consideredQuestions: z
      .array(guideQuestionReferenceSchema)
      .max(AGENT_DATA_LIMITS.maximumConsideredQuestions),
    rationale: shortRationaleSchema,
  })
  .superRefine((output, context) => {
    const considered = new Set<string>();
    for (const [index, question] of output.consideredQuestions.entries()) {
      const key = questionReferenceKey(question);
      if (considered.has(key)) {
        context.addIssue({
          code: 'custom',
          message: 'Considered question references must be unique',
          path: ['consideredQuestions', index],
        });
      }
      considered.add(key);
    }

    if (
      output.selectedAction.action !== 'complete_interview' &&
      !considered.has(questionReferenceKey(output.selectedAction.target))
    ) {
      context.addIssue({
        code: 'custom',
        message: 'The selected question must be listed among consideredQuestions',
        path: ['selectedAction', 'target'],
      });
    }
  });

const conductorMainQuestionSchema = z.strictObject({
  turnType: z.literal('main_question'),
  text: singleGuidePromptSchema,
  guideReference: mainQuestionReferenceSchema,
});

const conductorFollowUpQuestionSchema = z.strictObject({
  turnType: z.literal('follow_up_question'),
  text: singleGuidePromptSchema,
  guideReference: followUpQuestionReferenceSchema,
});

const conductorClarificationQuestionSchema = z.strictObject({
  turnType: z.literal('clarification_question'),
  text: singleQuestionSchema,
  guideReference: guideQuestionReferenceSchema,
});

export const conductorQuestionSchema = z.union([
  conductorMainQuestionSchema,
  conductorFollowUpQuestionSchema,
  conductorClarificationQuestionSchema,
]);

const conductorPrefaceSchema = z.strictObject({
  turnType: z.enum(['greeting', 'transition']),
  text: nonBlankTextSchema
    .max(600)
    .refine((text) => !text.includes('?'), 'A conductor preface must not contain a question'),
});

export const conductorOutputSchema = z.union([
  z.strictObject({
    action: z.literal('ask'),
    preface: conductorPrefaceSchema.nullable(),
    question: conductorQuestionSchema,
    referencedTranscriptTurnIds: uniqueIdArraySchema,
    rationale: shortRationaleSchema,
  }),
  z.strictObject({
    action: z.literal('close'),
    closingText: nonBlankTextSchema
      .max(600)
      .refine((text) => !text.includes('?'), 'A closing must not contain a question'),
    referencedTranscriptTurnIds: uniqueIdArraySchema,
    rationale: shortRationaleSchema,
  }),
]);

export const conductorGenerationOutputSchema = z
  .strictObject({
    action: z.enum(['ask', 'close']),
    preface: conductorPrefaceSchema.nullable(),
    question: conductorQuestionSchema.nullable(),
    closingText: nonBlankTextSchema
      .max(600)
      .refine((text) => !text.includes('?'), 'A closing must not contain a question')
      .nullable(),
    referencedTranscriptTurnIds: uniqueIdArraySchema,
    rationale: shortRationaleSchema,
  })
  .superRefine((output, context) => {
    const validAsk =
      output.action === 'ask' && output.question !== null && output.closingText === null;
    const validClose =
      output.action === 'close' && output.question === null && output.closingText !== null;
    if (!validAsk && !validClose) {
      context.addIssue({
        code: 'custom',
        message: 'The conductor action must match exactly one question or closing text',
      });
    }
  });

export const transcriptFinalizationIssueSchema = z.strictObject({
  code: z.enum([
    'missing_turn',
    'duplicate_turn',
    'speaker_mismatch',
    'sequence_error',
    'timestamp_error',
    'technical_gap',
  ]),
  severity: z.enum(['warning', 'error']),
  canonicalEntryIds: uniqueIdArraySchema,
  description: nonBlankTextSchema.max(800),
});

const checkedCanonicalEntrySchema = z.strictObject({
  entryId: idSchema,
  kind: z.enum(['turn', 'technical_gap']),
});

export const transcriptFinalizationReportSchema = z
  .strictObject({
    status: z.enum(['valid', 'valid_with_gaps', 'invalid']),
    checkedCanonicalEntries: z
      .array(checkedCanonicalEntrySchema)
      .max(AGENT_DATA_LIMITS.maximumFinalizationEntries),
    checks: z.strictObject({
      chronologyValid: z.boolean(),
      sequenceValid: z.boolean(),
      speakerAssignmentsValid: z.boolean(),
      noDuplicateTurns: z.boolean(),
    }),
    issues: z
      .array(transcriptFinalizationIssueSchema)
      .max(AGENT_DATA_LIMITS.maximumFinalizationIssues),
    rationale: shortRationaleSchema,
  })
  .superRefine((report, context) => {
    const checkedEntries = new Map(
      report.checkedCanonicalEntries.map((entry) => [entry.entryId, entry.kind]),
    );
    if (checkedEntries.size !== report.checkedCanonicalEntries.length) {
      context.addIssue({
        code: 'custom',
        message: 'Checked canonical entry IDs must be unique',
        path: ['checkedCanonicalEntries'],
      });
    }
    const allChecksPass = Object.values(report.checks).every(Boolean);
    const hasError = report.issues.some((issue) => issue.severity === 'error');
    const onlyGapWarnings = report.issues.every(
      (issue) => issue.code === 'technical_gap' && issue.severity === 'warning',
    );

    if (report.status === 'valid' && (!allChecksPass || report.issues.length > 0)) {
      addReportIssue(context, 'A valid report requires all checks to pass and no issues');
    }
    if (
      report.status === 'valid_with_gaps' &&
      (!allChecksPass || report.issues.length === 0 || !onlyGapWarnings)
    ) {
      addReportIssue(
        context,
        'A valid_with_gaps report requires passing checks and technical-gap warnings only',
      );
    }
    if (report.status === 'invalid' && allChecksPass && !hasError) {
      addReportIssue(context, 'An invalid report requires a failed check or an error issue');
    }
    for (const [index, issue] of report.issues.entries()) {
      for (const entryId of issue.canonicalEntryIds) {
        const checkedKind = checkedEntries.get(entryId);
        if (checkedKind === undefined) {
          context.addIssue({
            code: 'custom',
            message: 'Issue references must be part of checkedCanonicalEntries',
            path: ['issues', index, 'canonicalEntryIds'],
          });
        } else if (issue.code === 'technical_gap' && checkedKind !== 'technical_gap') {
          context.addIssue({
            code: 'custom',
            message: 'A technical-gap issue must reference a checked technical-gap entry',
            path: ['issues', index, 'canonicalEntryIds'],
          });
        }
      }
      if (issue.code === 'technical_gap' && issue.canonicalEntryIds.length === 0) {
        context.addIssue({
          code: 'custom',
          message: 'A technical-gap issue must reference its canonical gap entry',
          path: ['issues', index, 'canonicalEntryIds'],
        });
      }
      if (issue.code === 'technical_gap' && issue.severity !== 'warning') {
        context.addIssue({
          code: 'custom',
          message: 'Technical transcript gaps are warnings, not invented transcript errors',
          path: ['issues', index, 'severity'],
        });
      }
    }
  })
  .readonly();

export const agentNameSchema = z.enum([
  'coverage_analysis',
  'consistency_analysis',
  'interview_decision',
  'interview_conductor',
  'transcript_finalization',
]);

export const structuredAgentOutputSchema = z.discriminatedUnion('agentName', [
  z.strictObject({
    agentName: z.literal('coverage_analysis'),
    output: coverageAnalysisOutputSchema,
  }),
  z.strictObject({
    agentName: z.literal('consistency_analysis'),
    output: consistencyAnalysisOutputSchema,
  }),
  z.strictObject({
    agentName: z.literal('interview_decision'),
    output: interviewDecisionOutputSchema,
  }),
  z.strictObject({
    agentName: z.literal('interview_conductor'),
    output: conductorOutputSchema,
  }),
  z.strictObject({
    agentName: z.literal('transcript_finalization'),
    output: transcriptFinalizationReportSchema,
  }),
]);

function questionReferenceKey(reference: z.infer<typeof guideQuestionReferenceSchema>): string {
  return reference.kind === 'main_question'
    ? `${reference.guideId}:${reference.sectionId}:${reference.mainQuestionId}`
    : `${reference.guideId}:${reference.sectionId}:${reference.mainQuestionId}:${reference.followUpQuestionId}`;
}

function addReportIssue(context: z.RefinementCtx, message: string): void {
  context.addIssue({ code: 'custom', message, path: ['status'] });
}

export type CoverageFinding = z.infer<typeof coverageFindingSchema>;
export type CoverageAnalysisOutput = z.infer<typeof coverageAnalysisOutputSchema>;
export type PossibleContradiction = z.infer<typeof possibleContradictionSchema>;
export type ConsistencyAnalysisOutput = z.infer<typeof consistencyAnalysisOutputSchema>;
export type InterviewDecisionAction = z.infer<typeof interviewDecisionActionSchema>;
export type InterviewDecisionOutput = z.infer<typeof interviewDecisionOutputSchema>;
export type ConductorQuestion = z.infer<typeof conductorQuestionSchema>;
export type ConductorOutput = z.infer<typeof conductorOutputSchema>;
export type ConductorGenerationOutput = z.infer<typeof conductorGenerationOutputSchema>;
export type TranscriptFinalizationIssue = z.infer<typeof transcriptFinalizationIssueSchema>;
export type TranscriptFinalizationReport = z.infer<typeof transcriptFinalizationReportSchema>;
export type AgentName = z.infer<typeof agentNameSchema>;
export type StructuredAgentOutput = z.infer<typeof structuredAgentOutputSchema>;
