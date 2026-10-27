import { z } from 'zod';

import { idSchema, nonBlankTextSchema, timestampSchema } from './primitives.js';
import { supportedLocaleSchema } from './locale.js';

export const guideSummarySchema = z.strictObject({
  id: idSchema,
  title: nonBlankTextSchema.max(300),
  sourceLanguage: supportedLocaleSchema,
  createdAt: timestampSchema,
  mainQuestionCount: z.number().int().positive(),
  followUpQuestionCount: z.number().int().nonnegative(),
});

export const guideListQuerySchema = z.strictObject({ sourceLanguage: supportedLocaleSchema });
export const guideListResponseSchema = z.strictObject({ guides: z.array(guideSummarySchema) });
export const interviewGuideSettingSchema = z.strictObject({
  language: supportedLocaleSchema,
  guideId: idSchema,
  updatedAt: timestampSchema,
});
export const interviewSettingsResponseSchema = z.strictObject({
  settings: z.array(interviewGuideSettingSchema).max(2),
});
export const updateInterviewGuideSettingSchema = z.strictObject({ guideId: idSchema });

export type GuideSummary = z.infer<typeof guideSummarySchema>;
export type InterviewGuideSetting = z.infer<typeof interviewGuideSettingSchema>;
