import { z } from 'zod';

import { monitoringEventSchema } from './monitoring.js';
import { idSchema } from './primitives.js';
import { monitoringEventCursorSchema } from './realtime.js';

const historyLimitSchema = z
  .union([
    z.number().int(),
    z
      .string()
      .regex(/^[1-9][0-9]{0,2}$/u, 'Limit must be a positive decimal integer')
      .transform(Number),
  ])
  .pipe(z.number().int().min(1).max(500));

export const monitoringEventHistoryQuerySchema = z
  .strictObject({
    afterSequence: monitoringEventCursorSchema.default(0),
    throughSequence: monitoringEventCursorSchema.nullable().default(null),
    limit: historyLimitSchema.default(100),
  })
  .superRefine((query, context) => {
    if (query.throughSequence !== null && query.afterSequence > query.throughSequence) {
      context.addIssue({
        code: 'custom',
        path: ['throughSequence'],
        message: 'The stable history boundary must not precede the page cursor',
      });
    }
  });

export const monitoringEventHistoryPageSchema = z
  .strictObject({
    interviewId: idSchema,
    afterSequence: monitoringEventCursorSchema,
    highWaterSequence: monitoringEventCursorSchema,
    events: z.array(monitoringEventSchema).max(500),
    hasMore: z.boolean(),
    nextAfterSequence: monitoringEventCursorSchema.nullable(),
  })
  .superRefine((page, context) => {
    if (page.afterSequence > page.highWaterSequence) {
      context.addIssue({
        code: 'custom',
        path: ['afterSequence'],
        message: 'The history cursor must not exceed the captured high-water mark',
      });
    }

    let expectedSequence = page.afterSequence + 1;
    for (const [index, event] of page.events.entries()) {
      if (
        event.interviewId !== page.interviewId ||
        event.sequenceNumber !== expectedSequence ||
        event.sequenceNumber > page.highWaterSequence
      ) {
        context.addIssue({
          code: 'custom',
          path: ['events', index],
          message: 'History events must be contiguous and interview-scoped',
        });
      }
      expectedSequence += 1;
    }

    const lastSequence = page.events.at(-1)?.sequenceNumber ?? null;
    const expectedNext = page.hasMore ? lastSequence : null;
    if (page.nextAfterSequence !== expectedNext || (page.hasMore && lastSequence === null)) {
      context.addIssue({
        code: 'custom',
        path: ['nextAfterSequence'],
        message: 'The next history cursor must identify the last event of a non-final page',
      });
    }
    const deliveredThroughSequence = lastSequence ?? page.afterSequence;
    if (page.hasMore !== deliveredThroughSequence < page.highWaterSequence) {
      context.addIssue({
        code: 'custom',
        path: ['hasMore'],
        message: 'History page completion must match the captured high-water mark',
      });
    }
  });

export type MonitoringEventHistoryQuery = z.infer<typeof monitoringEventHistoryQuerySchema>;
export type MonitoringEventHistoryPage = z.infer<typeof monitoringEventHistoryPageSchema>;
