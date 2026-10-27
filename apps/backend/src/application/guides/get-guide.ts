import type { InterviewGuideSnapshot } from '@orgscience/domain';

import type { ApplicationResult } from '../errors.js';
import type { AppUnitOfWork } from '../persistence/index.js';

export class GetGuideService {
  public constructor(private readonly unitOfWork: AppUnitOfWork) {}

  public execute(guideId: string): Promise<ApplicationResult<InterviewGuideSnapshot>> {
    return this.unitOfWork.read(({ guides }) => guides.getById(guideId));
  }
}
