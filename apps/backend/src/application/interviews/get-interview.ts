import type { InterviewState } from '@orgscience/contracts';

import type { ApplicationResult } from '../errors.js';
import { success, type AppUnitOfWork } from '../persistence/index.js';
import { projectInterviewView } from './interview-view.js';

export class GetInterviewService {
  public constructor(private readonly unitOfWork: AppUnitOfWork) {}

  public async execute(interviewId: string): Promise<ApplicationResult<InterviewState>> {
    const loaded = await this.unitOfWork.read(async (context) => {
      const interview = await context.interviews.load(interviewId);
      if (!interview.ok) {
        return interview;
      }
      const guide = await context.guides.getById(interview.value.guideId);
      return guide.ok ? success({ interview: interview.value, guide: guide.value }) : guide;
    });
    return loaded.ok ? projectInterviewView(loaded.value.interview, loaded.value.guide) : loaded;
  }
}
