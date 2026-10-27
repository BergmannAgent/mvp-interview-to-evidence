import {
  guideSummarySchema,
  interviewGuideSettingSchema,
  type GuideSummary,
  type InterviewGuideSetting,
  type SupportedLocale,
} from '@orgscience/contracts';
import { z } from 'zod';

import {
  failure,
  success,
  type InterviewSettingsRepository,
  type RepositoryResult,
} from '../../../application/persistence/index.js';
import { mapDatabaseError } from './repository-errors.js';
import type { SqlExecutor } from './sql.js';

export class PostgresInterviewSettingsRepository implements InterviewSettingsRepository {
  public constructor(private readonly executor: SqlExecutor) {}

  public async listGuides(
    language: SupportedLocale,
  ): Promise<RepositoryResult<readonly GuideSummary[]>> {
    try {
      const result = await this.executor.query(
        `
        select g.id, g.title, g.source_language as "sourceLanguage",
          to_char(g.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "createdAt",
          count(q.id) filter (where q.kind = 'main_question')::integer as "mainQuestionCount",
          count(q.id) filter (where q.kind = 'follow_up_question')::integer as "followUpQuestionCount"
        from app.guides g left join app.guide_questions q on q.guide_id = g.id
        where g.source_language = $1 group by g.id order by g.title, g.id
      `,
        [language],
      );
      return success(z.array(guideSummarySchema).parse(result.rows));
    } catch (error: unknown) {
      return failure(mapDatabaseError(error, { resource: 'guide', identity: language }));
    }
  }

  public async getSettings(): Promise<RepositoryResult<readonly InterviewGuideSetting[]>> {
    try {
      const result = await this.executor.query(`
        select language, guide_id as "guideId",
          to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "updatedAt"
        from app.interview_settings order by language
      `);
      return success(z.array(interviewGuideSettingSchema).parse(result.rows));
    } catch (error: unknown) {
      return failure(
        mapDatabaseError(error, { resource: 'guide', identity: 'interview-settings' }),
      );
    }
  }

  public async saveSetting(
    setting: InterviewGuideSetting,
    onlyIfAbsent = false,
  ): Promise<RepositoryResult<InterviewGuideSetting>> {
    try {
      await this.executor.query(
        `
        insert into app.interview_settings (language, guide_id, updated_at) values ($1, $2, $3)
        on conflict (language) ${onlyIfAbsent ? 'do nothing' : 'do update set guide_id = excluded.guide_id, updated_at = excluded.updated_at'}
      `,
        [setting.language, setting.guideId, setting.updatedAt],
      );
      const stored = await this.getSettings();
      if (!stored.ok) return stored;
      const saved = stored.value.find((value) => value.language === setting.language);
      return saved === undefined ? failure({ code: 'internal', retryable: false }) : success(saved);
    } catch (error: unknown) {
      return failure(mapDatabaseError(error, { resource: 'guide', identity: setting.guideId }));
    }
  }
}
