import {
  idSchema,
  interviewRenameRequestSchema,
  interviewSummarySchema,
  type InterviewSummary,
} from '@orgscience/contracts';

import type { ApplicationResult } from '../errors.js';
import { failure, success, type AppUnitOfWork } from '../persistence/index.js';

export class ManageInterviewsService {
  public constructor(private readonly unitOfWork: AppUnitOfWork) {}

  public async rename(
    interviewId: string,
    displayName: string | null,
  ): Promise<ApplicationResult<InterviewSummary>> {
    const request = interviewRenameRequestSchema.safeParse({ displayName });
    if (!idSchema.safeParse(interviewId).success || !request.success) {
      return failure({
        code: 'application_validation',
        field: 'displayName',
        message:
          'Provide a valid interview ID and a non-empty interview name, or null to reset it.',
      });
    }
    return this.unitOfWork.transaction(async ({ interviews }) => {
      const renamed = await interviews.rename(interviewId, request.data.displayName);
      if (!renamed.ok) return renamed;
      const parsed = interviewSummarySchema.safeParse(renamed.value);
      return parsed.success
        ? success(parsed.data)
        : failure({
            code: 'application_invariant' as const,
            resource: 'interview_summary' as const,
            id: interviewId,
            message: 'The renamed interview does not satisfy the summary contract.',
          });
    });
  }

  public async delete(interviewId: string): Promise<ApplicationResult<void>> {
    if (!idSchema.safeParse(interviewId).success)
      return failure({
        code: 'application_validation',
        field: 'interviewId',
        message: 'Invalid interview ID.',
      });
    return this.unitOfWork.transaction(({ interviews }) => interviews.delete(interviewId));
  }
}
