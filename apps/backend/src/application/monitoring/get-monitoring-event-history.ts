import {
  monitoringEventHistoryPageSchema,
  type MonitoringEventHistoryPage,
  type MonitoringEventHistoryQuery,
} from '@orgscience/contracts';

import type { ApplicationResult } from '../errors.js';
import { failure, success, type AppUnitOfWork } from '../persistence/index.js';

export interface GetMonitoringEventHistoryInput extends MonitoringEventHistoryQuery {
  readonly interviewId: string;
}

export class GetMonitoringEventHistoryService {
  public constructor(private readonly unitOfWork: AppUnitOfWork) {}

  public async execute(
    input: GetMonitoringEventHistoryInput,
  ): Promise<ApplicationResult<MonitoringEventHistoryPage>> {
    if (!Number.isSafeInteger(input.afterSequence) || input.afterSequence < 0) {
      return failure({
        code: 'application_validation',
        field: 'afterSequence',
        message: 'The history cursor must be a nonnegative safe integer',
      });
    }
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 500) {
      return failure({
        code: 'application_validation',
        field: 'limit',
        message: 'The history page limit must be between 1 and 500',
      });
    }
    if (
      input.throughSequence !== null &&
      (!Number.isSafeInteger(input.throughSequence) || input.throughSequence < input.afterSequence)
    ) {
      return failure({
        code: 'application_validation',
        field: 'throughSequence',
        message: 'The stable history boundary must not precede the page cursor',
      });
    }

    const result = await this.unitOfWork.read(async ({ interviews, outbox }) => {
      const interview = await interviews.load(input.interviewId);
      if (!interview.ok) return interview;
      const replay = await outbox.replay(input.interviewId, {
        afterSequence: input.afterSequence,
        ...(input.throughSequence === null ? {} : { throughSequence: input.throughSequence }),
        limit: input.limit,
      });
      if (!replay.ok) return replay;

      const lastSequence = replay.value.events.at(-1)?.sequenceNumber ?? null;
      const page = monitoringEventHistoryPageSchema.safeParse({
        interviewId: input.interviewId,
        afterSequence: input.afterSequence,
        highWaterSequence: replay.value.highWaterSequence,
        events: replay.value.events,
        hasMore: replay.value.hasMore,
        nextAfterSequence: replay.value.hasMore ? lastSequence : null,
      });
      return page.success
        ? success(page.data)
        : failure({
            code: 'corrupt_data' as const,
            resource: 'outbox_event' as const,
            id: input.interviewId,
            reason: 'Persisted event history does not satisfy its shared page contract',
          });
    });

    if (!result.ok && result.error.code === 'sequence_conflict') {
      return failure({
        code: 'monitoring_cursor_ahead',
        interviewId: input.interviewId,
        cursor: input.afterSequence,
        highWaterSequence: result.error.expected,
      });
    }
    return result;
  }
}
