import {
  guideListResponseSchema,
  guideResponseSchema,
  interviewSettingsResponseSchema,
  type SupportedLocale,
} from '@orgscience/contracts';

export interface ValidatedApiRequest {
  <T>(
    path: string,
    schema: {
      readonly safeParse: (value: unknown) => { success: true; data: T } | { success: false };
    },
    init?: RequestInit,
  ): Promise<T>;
}

export class InterviewSettingsApiClient {
  public constructor(private readonly request: ValidatedApiRequest) {}

  public getSettings() {
    return this.request('/api/v1/interview-settings', interviewSettingsResponseSchema);
  }

  public listGuides(language: SupportedLocale) {
    return this.request(`/api/v1/guides?sourceLanguage=${language}`, guideListResponseSchema);
  }

  public getGuide(guideId: string) {
    return this.request(`/api/v1/guides/${encodeURIComponent(guideId)}`, guideResponseSchema);
  }

  public updateSetting(language: SupportedLocale, guideId: string) {
    return this.request(`/api/v1/interview-settings/${language}`, interviewSettingsResponseSchema, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ guideId }),
    });
  }
}
