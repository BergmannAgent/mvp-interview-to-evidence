import type { GuideSummary, InterviewGuideSetting, SupportedLocale } from '@orgscience/contracts';

import type { ApplicationResult } from '../errors.js';
import { failure, type AppUnitOfWork } from '../persistence/index.js';
import { readClock, type Clock } from '../runtime.js';

export class InterviewSettingsService {
  public constructor(
    private readonly unitOfWork: AppUnitOfWork,
    private readonly clock: Clock,
    private readonly ensureDefaults: () => Promise<void>,
  ) {}

  public async listGuides(
    language: SupportedLocale,
  ): Promise<ApplicationResult<readonly GuideSummary[]>> {
    await this.ensureDefaults();
    return this.unitOfWork.read(({ interviewSettings }) => interviewSettings.listGuides(language));
  }

  public async get(): Promise<ApplicationResult<readonly InterviewGuideSetting[]>> {
    await this.ensureDefaults();
    return this.unitOfWork.read(({ interviewSettings }) => interviewSettings.getSettings());
  }

  public async update(
    language: SupportedLocale,
    guideId: string,
  ): Promise<ApplicationResult<InterviewGuideSetting>> {
    await this.ensureDefaults();
    const now = readClock(this.clock);
    if (!now.ok) return now;
    return this.unitOfWork.transaction(async ({ guides, interviewSettings }) => {
      const guide = await guides.getById(guideId);
      if (!guide.ok) return guide;
      if (guide.value.sourceLanguage !== language)
        return failure({
          code: 'application_validation',
          field: 'guideId',
          message: 'The guide language must match the interview language.',
        });
      return interviewSettings.saveSetting({ language, guideId, updatedAt: now.value });
    });
  }
}
