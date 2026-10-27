import { z } from 'zod';

import { timestampSchema } from './primitives.js';

const diagnosticToken = z
  .string()
  .max(128)
  .regex(/^[A-Za-z0-9_.:-]+$/)
  .nullable();

export function sanitizeVoiceDiagnosticMessage(message: string): string {
  return message
    .replace(/\b(?:sk-|ek_|sess_|ghp_)[A-Za-z0-9_-]+/g, '[secret]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [secret]')
    .replace(/https?:\/\/\S+/g, '[url]')
    .replace(/"[^"\n]*"|'[^'\n]*'|`[^`]*`/g, '[quoted value]')
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, 1000);
}

export const voiceDiagnosticSchema = z.strictObject({
  diagnosticId: z.uuid(),
  occurredAt: timestampSchema,
  source: z.enum(['provider', 'client']),
  eventType: diagnosticToken,
  code: diagnosticToken,
  errorType: diagnosticToken,
  responseId: diagnosticToken,
  providerEventId: diagnosticToken,
  message: z.string().min(1).max(4000).transform(sanitizeVoiceDiagnosticMessage),
});

export type VoiceDiagnostic = z.infer<typeof voiceDiagnosticSchema>;
