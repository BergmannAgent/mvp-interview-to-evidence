import {
  interviewSummaryPageSchema,
  type InterviewListQuery,
  type InterviewSummaryPage,
} from '@orgscience/contracts';

import type { ApplicationResult } from '../errors.js';
import { failure, success, type AppUnitOfWork } from '../persistence/index.js';

export type ListInterviewsInput = InterviewListQuery;

export class ListInterviewsService {
  public constructor(private readonly unitOfWork: AppUnitOfWork) {}

  public async execute(
    input: ListInterviewsInput,
  ): Promise<ApplicationResult<InterviewSummaryPage>> {
    const page = await this.unitOfWork.read(({ interviews }) => interviews.listSummaries(input));
    if (!page.ok) {
      if (
        page.error.code === 'constraint_violation' &&
        page.error.constraint === 'interview_summary_cursor'
      ) {
        return failure({
          code: 'application_validation',
          field: 'after',
          message: 'The interview list cursor is invalid or no longer supported',
        });
      }
      return page;
    }

    const validated = interviewSummaryPageSchema.safeParse(page.value);
    return validated.success
      ? success(validated.data)
      : failure({
          code: 'application_invariant',
          resource: 'interview_summary',
          id: 'summary-page',
          message: 'Interview summary page does not satisfy the shared HTTP contract',
        });
  }
}
