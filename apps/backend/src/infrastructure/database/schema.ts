import { sql } from 'drizzle-orm';
import type { SectionMemory } from '@orgscience/contracts';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  type PgTableExtraConfigValue,
} from 'drizzle-orm/pg-core';

export const appSchema = pgSchema('app');

const timestampOptions = { withTimezone: true, mode: 'string', precision: 3 } as const;

export const schemaMetadata = appSchema.table(
  'schema_metadata',
  {
    component: text('component').primaryKey(),
    version: integer('version').notNull(),
    appliedAt: timestamp('applied_at', timestampOptions).notNull().defaultNow(),
  },
  (table) => [
    check('schema_metadata_component_not_blank', sql`btrim(${table.component}) <> ''`),
    check('schema_metadata_version_positive', sql`${table.version} > 0`),
  ],
);

export const guides = appSchema.table(
  'guides',
  {
    id: text('id').primaryKey(),
    sourceLanguage: text('source_language').$type<'de' | 'en'>().notNull().default('de'),
    title: text('title').notNull(),
    sourceMarkdown: text('source_markdown').notNull(),
    stableIdVersion: text('stable_id_version').notNull(),
    createdAt: timestamp('created_at', timestampOptions).notNull(),
  },
  (table) => [
    unique('guides_id_language_unique').on(table.id, table.sourceLanguage),
    check('guides_id_not_blank', sql`btrim(${table.id}) <> ''`),
    check('guides_source_language_valid', sql`${table.sourceLanguage} in ('de', 'en')`),
    check('guides_title_not_blank', sql`btrim(${table.title}) <> ''`),
    check('guides_source_not_blank', sql`btrim(${table.sourceMarkdown}) <> ''`),
    check('guides_stable_id_version_v1', sql`${table.stableIdVersion} = 'v1'`),
  ],
);

export const interviewSettings = appSchema.table(
  'interview_settings',
  {
    language: text('language').$type<'de' | 'en'>().primaryKey(),
    guideId: text('guide_id').notNull(),
    updatedAt: timestamp('updated_at', timestampOptions).notNull(),
  },
  (table) => [
    check('interview_settings_language_valid', sql`${table.language} in ('de', 'en')`),
    foreignKey({
      columns: [table.guideId, table.language],
      foreignColumns: [guides.id, guides.sourceLanguage],
      name: 'interview_settings_guide_language_fk',
    }).onDelete('restrict'),
  ],
);

export const guideSections = appSchema.table(
  'guide_sections',
  {
    guideId: text('guide_id').notNull(),
    id: text('id').notNull(),
    position: integer('position').notNull(),
    title: text('title').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.guideId, table.id], name: 'guide_sections_pk' }),
    unique('guide_sections_position_unique').on(table.guideId, table.position),
    foreignKey({
      columns: [table.guideId],
      foreignColumns: [guides.id],
      name: 'guide_sections_guide_fk',
    }).onDelete('cascade'),
    check('guide_sections_id_not_blank', sql`btrim(${table.id}) <> ''`),
    check('guide_sections_position_nonnegative', sql`${table.position} >= 0`),
    check('guide_sections_title_not_blank', sql`btrim(${table.title}) <> ''`),
  ],
);

export const guideQuestions = appSchema.table(
  'guide_questions',
  {
    guideId: text('guide_id').notNull(),
    id: text('id').notNull(),
    sectionId: text('section_id').notNull(),
    kind: text('kind').$type<'main_question' | 'follow_up_question'>().notNull(),
    mainQuestionId: text('main_question_id').notNull(),
    position: integer('position').notNull(),
    text: text('text').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.guideId, table.id], name: 'guide_questions_pk' }),
    unique('guide_questions_scope_unique').on(table.guideId, table.id, table.sectionId),
    foreignKey({
      columns: [table.guideId, table.sectionId],
      foreignColumns: [guideSections.guideId, guideSections.id],
      name: 'guide_questions_section_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.guideId, table.mainQuestionId, table.sectionId],
      foreignColumns: [table.guideId, table.id, table.sectionId],
      name: 'guide_questions_main_question_fk',
    }).onDelete('cascade'),
    uniqueIndex('guide_questions_main_position_unique')
      .on(table.guideId, table.sectionId, table.position)
      .where(sql`${table.kind} = 'main_question'`),
    uniqueIndex('guide_questions_follow_up_position_unique')
      .on(table.guideId, table.mainQuestionId, table.position)
      .where(sql`${table.kind} = 'follow_up_question'`),
    check(
      'guide_questions_kind_valid',
      sql`${table.kind} in ('main_question', 'follow_up_question')`,
    ),
    check(
      'guide_questions_hierarchy_valid',
      sql`(${table.kind} = 'main_question' and ${table.mainQuestionId} = ${table.id}) or (${table.kind} = 'follow_up_question' and ${table.mainQuestionId} <> ${table.id})`,
    ),
    check('guide_questions_position_nonnegative', sql`${table.position} >= 0`),
    check('guide_questions_text_not_blank', sql`btrim(${table.text}) <> ''`),
  ],
);

export const interviews = appSchema.table(
  'interviews',
  {
    id: text('id').primaryKey(),
    guideId: text('guide_id').notNull(),
    displayName: text('display_name'),
    language: text('language').$type<'de' | 'en'>().notNull().default('de'),
    createdAt: timestamp('created_at', timestampOptions).notNull(),
  },
  (table) => [
    unique('interviews_id_guide_unique').on(table.id, table.guideId),
    foreignKey({
      columns: [table.guideId],
      foreignColumns: [guides.id],
      name: 'interviews_guide_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.guideId, table.language],
      foreignColumns: [guides.id, guides.sourceLanguage],
      name: 'interviews_guide_language_fk',
    }).onDelete('restrict'),
    check('interviews_id_not_blank', sql`btrim(${table.id}) <> ''`),
    check(
      'interviews_display_name_valid',
      sql`${table.displayName} is null or (length(${table.displayName}) between 1 and 200 and btrim(${table.displayName}) <> '')`,
    ),
    check('interviews_language_valid', sql`${table.language} in ('de', 'en')`),
  ],
);

export const interviewState = appSchema.table(
  'interview_state',
  {
    interviewId: text('interview_id').primaryKey(),
    guideId: text('guide_id').notNull(),
    status: text('status')
      .$type<'ready' | 'active' | 'paused' | 'ending' | 'completed' | 'failed'>()
      .notNull(),
    stateVersion: integer('state_version').notNull().default(0),
    coverageVersion: integer('coverage_version').notNull().default(0),
    currentMainQuestionId: text('current_main_question_id'),
    activeWorkflowRunId: text('active_workflow_run_id'),
    sectionMemories: jsonb('section_memories')
      .$type<readonly SectionMemory[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    createdAt: timestamp('created_at', timestampOptions).notNull(),
    updatedAt: timestamp('updated_at', timestampOptions).notNull(),
    startedAt: timestamp('started_at', timestampOptions),
    activeSince: timestamp('active_since', timestampOptions),
    pausedAt: timestamp('paused_at', timestampOptions),
    endingAt: timestamp('ending_at', timestampOptions),
    endingFrom: text('ending_from').$type<'active' | 'paused'>(),
    endedAt: timestamp('ended_at', timestampOptions),
    failedAt: timestamp('failed_at', timestampOptions),
    failedFrom: text('failed_from').$type<'ready' | 'active' | 'paused' | 'ending'>(),
    failureCode: text('failure_code'),
    failureMessage: text('failure_message'),
  },
  (table) => [
    index('interview_state_summary_pagination_idx').on(
      table.createdAt.desc(),
      table.interviewId.desc(),
    ),
    foreignKey({
      columns: [table.interviewId, table.guideId],
      foreignColumns: [interviews.id, interviews.guideId],
      name: 'interview_state_interview_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.guideId, table.currentMainQuestionId],
      foreignColumns: [guideQuestions.guideId, guideQuestions.id],
      name: 'interview_state_current_question_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.interviewId, table.activeWorkflowRunId],
      foreignColumns: [workflowRuns.interviewId, workflowRuns.id],
      name: 'interview_state_active_workflow_fk',
    }).onDelete('restrict'),
    check(
      'interview_state_status_valid',
      sql`${table.status} in ('ready', 'active', 'paused', 'ending', 'completed', 'failed')`,
    ),
    check(
      'interview_state_versions_nonnegative',
      sql`${table.stateVersion} >= 0 and ${table.coverageVersion} >= 0`,
    ),
    check(
      'interview_state_section_memories_array',
      sql`jsonb_typeof(${table.sectionMemories}) = 'array'`,
    ),
    check('interview_state_time_order', sql`${table.updatedAt} >= ${table.createdAt}`),
    check(
      'interview_state_lifecycle_shape',
      sql`
        (${table.status} = 'ready' and ${table.startedAt} is null and ${table.activeSince} is null and ${table.pausedAt} is null and ${table.endingAt} is null and ${table.endingFrom} is null and ${table.endedAt} is null and ${table.failedAt} is null and ${table.failedFrom} is null and ${table.failureCode} is null and ${table.failureMessage} is null)
        or (${table.status} = 'active' and ${table.startedAt} is not null and ${table.activeSince} is not null and ${table.pausedAt} is null and ${table.endingAt} is null and ${table.endingFrom} is null and ${table.endedAt} is null and ${table.failedAt} is null and ${table.failedFrom} is null and ${table.failureCode} is null and ${table.failureMessage} is null)
        or (${table.status} = 'paused' and ${table.startedAt} is not null and ${table.activeSince} is null and ${table.pausedAt} is not null and ${table.endingAt} is null and ${table.endingFrom} is null and ${table.endedAt} is null and ${table.failedAt} is null and ${table.failedFrom} is null and ${table.failureCode} is null and ${table.failureMessage} is null)
        or (${table.status} = 'ending' and ${table.startedAt} is not null and ${table.activeSince} is null and ${table.pausedAt} is null and ${table.endingAt} is not null and ${table.endingFrom} is not null and ${table.endingFrom} in ('active', 'paused') and ${table.endedAt} is null and ${table.failedAt} is null and ${table.failedFrom} is null and ${table.failureCode} is null and ${table.failureMessage} is null)
        or (${table.status} = 'completed' and ${table.startedAt} is not null and ${table.activeSince} is null and ${table.pausedAt} is null and ${table.endingAt} is not null and ${table.endingFrom} is null and ${table.endedAt} is not null and ${table.failedAt} is null and ${table.failedFrom} is null and ${table.failureCode} is null and ${table.failureMessage} is null)
        or (${table.status} = 'failed' and ${table.activeSince} is null and ${table.pausedAt} is null and ${table.endingAt} is null and ${table.endingFrom} is null and ${table.endedAt} is null and ${table.failedAt} is not null and ${table.failedFrom} is not null and ${table.failedFrom} in ('ready', 'active', 'paused', 'ending') and ${table.failureCode} is not null and btrim(${table.failureCode}) <> '' and ${table.failureMessage} is not null and btrim(${table.failureMessage}) <> '')
      `,
    ),
    check(
      'interview_state_lifecycle_time_order',
      sql`
        (${table.status} = 'ready')
        or (${table.status} = 'active' and ${table.startedAt} >= ${table.createdAt} and ${table.activeSince} >= ${table.startedAt} and ${table.updatedAt} >= ${table.activeSince})
        or (${table.status} = 'paused' and ${table.startedAt} >= ${table.createdAt} and ${table.pausedAt} >= ${table.startedAt} and ${table.updatedAt} >= ${table.pausedAt})
        or (${table.status} = 'ending' and ${table.startedAt} >= ${table.createdAt} and ${table.endingAt} >= ${table.startedAt} and ${table.updatedAt} >= ${table.endingAt})
        or (${table.status} = 'completed' and ${table.startedAt} >= ${table.createdAt} and ${table.endingAt} >= ${table.startedAt} and ${table.endedAt} >= ${table.endingAt} and ${table.updatedAt} >= ${table.endedAt})
        or (${table.status} = 'failed' and ${table.failedAt} >= ${table.createdAt} and ${table.updatedAt} >= ${table.failedAt} and ((${table.failedFrom} = 'ready' and ${table.startedAt} is null) or (${table.failedFrom} <> 'ready' and ${table.startedAt} is not null and ${table.startedAt} >= ${table.createdAt} and ${table.failedAt} >= ${table.startedAt})))
      `,
    ),
  ],
);

export const interviewCounters = appSchema.table(
  'interview_counters',
  {
    interviewId: text('interview_id').primaryKey(),
    nextTranscriptSequence: integer('next_transcript_sequence').notNull().default(1),
    nextEventSequence: integer('next_event_sequence').notNull().default(1),
    transcriptMutationVersion: integer('transcript_mutation_version').notNull().default(0),
  },
  (table) => [
    foreignKey({
      columns: [table.interviewId],
      foreignColumns: [interviews.id],
      name: 'interview_counters_interview_fk',
    }).onDelete('cascade'),
    check(
      'interview_counters_sequences_positive',
      sql`${table.nextTranscriptSequence} > 0 and ${table.nextEventSequence} > 0`,
    ),
    check(
      'interview_counters_transcript_mutation_nonnegative',
      sql`${table.transcriptMutationVersion} >= 0`,
    ),
  ],
);

export const commandReceipts = appSchema.table(
  'command_receipts',
  {
    interviewId: text('interview_id').notNull(),
    commandType: text('command_type').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    requestFingerprint: text('request_fingerprint').notNull(),
    resultResourceId: text('result_resource_id'),
    resultStateVersion: integer('result_state_version'),
    createdAt: timestamp('created_at', timestampOptions).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.interviewId, table.commandType, table.idempotencyKey],
      name: 'command_receipts_pk',
    }),
    foreignKey({
      columns: [table.interviewId],
      foreignColumns: [interviews.id],
      name: 'command_receipts_interview_fk',
    }).onDelete('cascade'),
    check('command_receipts_type_not_blank', sql`btrim(${table.commandType}) <> ''`),
    check('command_receipts_key_not_blank', sql`btrim(${table.idempotencyKey}) <> ''`),
    check(
      'command_receipts_fingerprint_sha256',
      sql`${table.requestFingerprint} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'command_receipts_result_version_nonnegative',
      sql`${table.resultStateVersion} is null or ${table.resultStateVersion} >= 0`,
    ),
  ],
);

export const durableJobs = appSchema.table(
  'durable_jobs',
  {
    id: text('id').primaryKey(),
    interviewId: text('interview_id').notNull(),
    type: text('type')
      .$type<'start_interview' | 'participant_turn' | 'finish_interview'>()
      .notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    sourceTurnId: text('source_turn_id'),
    expectedStateVersion: integer('expected_state_version').notNull(),
    status: text('status')
      .$type<'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'>()
      .notNull(),
    attemptCount: integer('attempt_count').notNull().default(0),
    maximumAttempts: integer('maximum_attempts').notNull().default(3),
    initialDelayMs: integer('initial_delay_ms').notNull().default(0),
    availableAt: timestamp('available_at', timestampOptions).notNull(),
    leaseOwner: text('lease_owner'),
    leaseToken: text('lease_token'),
    leaseExpiresAt: timestamp('lease_expires_at', timestampOptions),
    lastErrorCode: text('last_error_code'),
    lastErrorMessage: text('last_error_message'),
    lastErrorRetryable: boolean('last_error_retryable'),
    lastErrorOccurredAt: timestamp('last_error_occurred_at', timestampOptions),
    cancellationReason: text('cancellation_reason'),
    resultDeliveryId: text('result_delivery_id'),
    appliedStateVersion: integer('applied_state_version'),
    createdAt: timestamp('created_at', timestampOptions).notNull(),
    updatedAt: timestamp('updated_at', timestampOptions).notNull(),
    completedAt: timestamp('completed_at', timestampOptions),
  },
  (table): PgTableExtraConfigValue[] => [
    unique('durable_jobs_interview_id_unique').on(table.interviewId, table.id),
    unique('durable_jobs_idempotency_unique').on(table.interviewId, table.idempotencyKey),
    unique('durable_jobs_lease_token_unique').on(table.leaseToken),
    foreignKey({
      columns: [table.interviewId],
      foreignColumns: [interviews.id],
      name: 'durable_jobs_interview_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.interviewId, table.sourceTurnId],
      foreignColumns: [transcriptFinalSegments.interviewId, transcriptFinalSegments.turnId],
      name: 'durable_jobs_source_final_segment_fk',
    }).onDelete('restrict'),
    uniqueIndex('durable_jobs_one_active_per_interview')
      .on(table.interviewId)
      .where(sql`${table.status} in ('queued', 'running')`),
    index('durable_jobs_claim_idx').on(table.status, table.availableAt, table.createdAt),
    check(
      'durable_jobs_type_valid',
      sql`${table.type} in ('start_interview', 'participant_turn', 'finish_interview')`,
    ),
    check(
      'durable_jobs_source_shape',
      sql`(${table.type} = 'participant_turn' and ${table.sourceTurnId} is not null) or (${table.type} in ('start_interview', 'finish_interview') and ${table.sourceTurnId} is null)`,
    ),
    check(
      'durable_jobs_status_valid',
      sql`${table.status} in ('queued', 'running', 'succeeded', 'failed', 'cancelled')`,
    ),
    check(
      'durable_jobs_attempts_valid',
      sql`${table.attemptCount} >= 0 and ${table.maximumAttempts} > 0 and ${table.attemptCount} <= ${table.maximumAttempts}`,
    ),
    check(
      'durable_jobs_initial_delay_valid',
      sql`${table.initialDelayMs} >= 0 and ${table.initialDelayMs} <= 900000`,
    ),
    check('durable_jobs_expected_version_nonnegative', sql`${table.expectedStateVersion} >= 0`),
    check(
      'durable_jobs_lease_shape',
      sql`(${table.status} = 'running' and ${table.leaseOwner} is not null and ${table.leaseToken} is not null and ${table.leaseExpiresAt} is not null) or (${table.status} <> 'running' and ${table.leaseOwner} is null and ${table.leaseExpiresAt} is null)`,
    ),
    check(
      'durable_jobs_initial_lease_token_null',
      sql`${table.status} <> 'queued' or ${table.attemptCount} > 0 or ${table.leaseToken} is null`,
    ),
    check(
      'durable_jobs_terminal_shape',
      sql`(${table.status} in ('queued', 'running') and ${table.completedAt} is null) or (${table.status} in ('succeeded', 'failed', 'cancelled') and ${table.completedAt} is not null)`,
    ),
    check(
      'durable_jobs_cancellation_shape',
      sql`(${table.status} = 'cancelled' and ${table.cancellationReason} is not null) or (${table.status} <> 'cancelled' and ${table.cancellationReason} is null)`,
    ),
    check(
      'durable_jobs_applied_version_shape',
      sql`(${table.status} = 'succeeded' and ${table.appliedStateVersion} is not null and ${table.appliedStateVersion} >= 0) or (${table.status} <> 'succeeded' and ${table.appliedStateVersion} is null)`,
    ),
    check(
      'durable_jobs_last_error_shape',
      sql`(${table.lastErrorCode} is null and ${table.lastErrorMessage} is null and ${table.lastErrorRetryable} is null and ${table.lastErrorOccurredAt} is null) or (${table.lastErrorCode} is not null and ${table.lastErrorMessage} is not null and ${table.lastErrorRetryable} is not null and ${table.lastErrorOccurredAt} is not null)`,
    ),
    check('durable_jobs_time_order', sql`${table.updatedAt} >= ${table.createdAt}`),
  ],
);

export const workflowRuns = appSchema.table(
  'workflow_runs',
  {
    id: text('id').primaryKey(),
    interviewId: text('interview_id').notNull(),
    jobId: text('job_id').notNull(),
    mastraAttemptId: text('mastra_attempt_id').notNull(),
    attemptNumber: integer('attempt_number').notNull(),
    expectedStateVersion: integer('expected_state_version').notNull(),
    status: text('status')
      .$type<'waiting' | 'running' | 'succeeded' | 'failed' | 'retrying' | 'skipped'>()
      .notNull(),
    retryCount: integer('retry_count').notNull().default(0),
    startedAt: timestamp('started_at', timestampOptions),
    endedAt: timestamp('ended_at', timestampOptions),
    durationMs: integer('duration_ms'),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    errorRetryable: boolean('error_retryable'),
    rejectionReason: text('rejection_reason'),
    appliedAt: timestamp('applied_at', timestampOptions),
    createdAt: timestamp('created_at', timestampOptions).notNull(),
  },
  (table) => [
    unique('workflow_runs_interview_id_unique').on(table.interviewId, table.id),
    unique('workflow_runs_delivery_scope_unique').on(table.interviewId, table.id, table.jobId),
    unique('workflow_runs_job_attempt_unique').on(table.jobId, table.attemptNumber),
    unique('workflow_runs_mastra_attempt_unique').on(table.mastraAttemptId),
    foreignKey({
      columns: [table.interviewId, table.jobId],
      foreignColumns: [durableJobs.interviewId, durableJobs.id],
      name: 'workflow_runs_job_fk',
    }).onDelete('cascade'),
    uniqueIndex('workflow_runs_one_applied_per_job')
      .on(table.jobId)
      .where(sql`${table.appliedAt} is not null`),
    index('workflow_runs_interview_created_idx').on(table.interviewId, table.createdAt),
    check(
      'workflow_runs_status_valid',
      sql`${table.status} in ('waiting', 'running', 'succeeded', 'failed', 'retrying', 'skipped')`,
    ),
    check(
      'workflow_runs_numbers_valid',
      sql`${table.attemptNumber} > 0 and ${table.expectedStateVersion} >= 0 and ${table.retryCount} >= 0`,
    ),
    check(
      'workflow_runs_timing_valid',
      sql`
        (${table.status} = 'waiting' and ${table.startedAt} is null and ${table.endedAt} is null and ${table.durationMs} is null)
        or (${table.status} in ('running', 'retrying') and ${table.startedAt} is not null and ${table.endedAt} is null and ${table.durationMs} is null)
        or (${table.status} in ('succeeded', 'failed', 'skipped') and ${table.startedAt} is not null and ${table.endedAt} is not null and ${table.durationMs} is not null and ${table.durationMs} >= 0)
      `,
    ),
    check(
      'workflow_runs_apply_shape',
      sql`${table.appliedAt} is null or (${table.status} = 'succeeded' and ${table.rejectionReason} is null)`,
    ),
    check(
      'workflow_runs_error_shape',
      sql`(${table.status} = 'failed' and ${table.errorCode} is not null and ${table.errorMessage} is not null and ${table.errorRetryable} is not null) or (${table.status} <> 'failed' and ${table.errorCode} is null and ${table.errorMessage} is null and ${table.errorRetryable} is null)`,
    ),
    check(
      'workflow_runs_time_order',
      sql`${table.endedAt} is null or (${table.startedAt} is not null and ${table.endedAt} >= ${table.startedAt})`,
    ),
  ],
);

export const agentRuns = appSchema.table(
  'agent_runs',
  {
    id: text('id').primaryKey(),
    interviewId: text('interview_id').notNull(),
    workflowRunId: text('workflow_run_id').notNull(),
    agentName: text('agent_name').notNull(),
    invocationNumber: integer('invocation_number').notNull().default(1),
    status: text('status').notNull(),
    retryCount: integer('retry_count').notNull().default(0),
    modelMode: text('model_mode').$type<'demo' | 'provider'>().notNull(),
    modelProvider: text('model_provider'),
    modelName: text('model_name'),
    startedAt: timestamp('started_at', timestampOptions),
    endedAt: timestamp('ended_at', timestampOptions),
    durationMs: integer('duration_ms'),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    errorRetryable: boolean('error_retryable'),
    input: jsonb('input').$type<Record<string, unknown>>().notNull(),
    output: jsonb('output').$type<Record<string, unknown>>(),
  },
  (table) => [
    unique('agent_runs_interview_id_unique').on(table.interviewId, table.id),
    unique('agent_runs_workflow_scope_unique').on(table.interviewId, table.workflowRunId, table.id),
    unique('agent_runs_invocation_unique').on(
      table.workflowRunId,
      table.agentName,
      table.invocationNumber,
    ),
    foreignKey({
      columns: [table.interviewId, table.workflowRunId],
      foreignColumns: [workflowRuns.interviewId, workflowRuns.id],
      name: 'agent_runs_workflow_fk',
    }).onDelete('cascade'),
    index('agent_runs_workflow_idx').on(table.workflowRunId, table.startedAt),
    check(
      'agent_runs_name_valid',
      sql`${table.agentName} in ('coverage_analysis', 'consistency_analysis', 'interview_decision', 'interview_conductor', 'transcript_finalization')`,
    ),
    check(
      'agent_runs_status_valid',
      sql`${table.status} in ('waiting', 'running', 'succeeded', 'failed', 'retrying', 'skipped')`,
    ),
    check(
      'agent_runs_numbers_valid',
      sql`${table.invocationNumber} > 0 and ${table.retryCount} >= 0`,
    ),
    check(
      'agent_runs_timing_valid',
      sql`
        (${table.status} = 'waiting' and ${table.startedAt} is null and ${table.endedAt} is null and ${table.durationMs} is null)
        or (${table.status} in ('running', 'retrying') and ${table.startedAt} is not null and ${table.endedAt} is null and ${table.durationMs} is null)
        or (${table.status} in ('succeeded', 'failed', 'skipped') and ${table.startedAt} is not null and ${table.endedAt} is not null and ${table.endedAt} >= ${table.startedAt} and ${table.durationMs} is not null and ${table.durationMs} >= 0)
      `,
    ),
    check(
      'agent_runs_error_shape',
      sql`(${table.status} = 'failed' and ${table.errorCode} is not null and ${table.errorMessage} is not null and ${table.errorRetryable} is not null) or (${table.status} <> 'failed' and ${table.errorCode} is null and ${table.errorMessage} is null and ${table.errorRetryable} is null)`,
    ),
    check(
      'agent_runs_output_shape',
      sql`(${table.status} = 'succeeded' and ${table.output} is not null) or (${table.status} <> 'succeeded')`,
    ),
    check(
      'agent_runs_model_valid',
      sql`(${table.modelMode} = 'demo' and ${table.modelProvider} is null and ${table.modelName} is null) or (${table.modelMode} = 'provider' and ${table.modelProvider} is not null and ${table.modelName} is not null)`,
    ),
    check(
      'agent_runs_json_objects',
      sql`jsonb_typeof(${table.input}) = 'object' and (${table.output} is null or jsonb_typeof(${table.output}) = 'object')`,
    ),
  ],
);

export const workflowStepRuns = appSchema.table(
  'workflow_step_runs',
  {
    id: text('id').primaryKey(),
    interviewId: text('interview_id').notNull(),
    workflowRunId: text('workflow_run_id').notNull(),
    agentRunId: text('agent_run_id'),
    step: text('step').notNull(),
    attemptNumber: integer('attempt_number').notNull().default(1),
    status: text('status').notNull(),
    retryCount: integer('retry_count').notNull().default(0),
    startedAt: timestamp('started_at', timestampOptions),
    endedAt: timestamp('ended_at', timestampOptions),
    durationMs: integer('duration_ms'),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    errorRetryable: boolean('error_retryable'),
    input: jsonb('input').$type<Record<string, unknown>>(),
    output: jsonb('output').$type<Record<string, unknown>>(),
  },
  (table) => [
    unique('workflow_step_runs_identity_unique').on(
      table.workflowRunId,
      table.step,
      table.attemptNumber,
    ),
    foreignKey({
      columns: [table.interviewId, table.workflowRunId],
      foreignColumns: [workflowRuns.interviewId, workflowRuns.id],
      name: 'workflow_step_runs_workflow_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.interviewId, table.workflowRunId, table.agentRunId],
      foreignColumns: [agentRuns.interviewId, agentRuns.workflowRunId, agentRuns.id],
      name: 'workflow_step_runs_agent_fk',
    }),
    index('workflow_step_runs_workflow_idx').on(table.workflowRunId, table.startedAt),
    check('workflow_step_runs_attempt_positive', sql`${table.attemptNumber} > 0`),
    check('workflow_step_runs_retry_nonnegative', sql`${table.retryCount} >= 0`),
    check(
      'workflow_step_runs_step_valid',
      sql`${table.step} in ('receive_user_turn', 'finalize_user_turn', 'load_interview_state', 'coverage_analysis', 'consistency_analysis', 'interview_decision', 'conductor_question_generation', 'validation', 'persistence', 'text_streaming', 'audio_streaming', 'state_update')`,
    ),
    check(
      'workflow_step_runs_status_valid',
      sql`${table.status} in ('waiting', 'running', 'succeeded', 'failed', 'retrying', 'skipped')`,
    ),
    check(
      'workflow_step_runs_timing_valid',
      sql`
        (${table.status} = 'waiting' and ${table.startedAt} is null and ${table.endedAt} is null and ${table.durationMs} is null)
        or (${table.status} in ('running', 'retrying') and ${table.startedAt} is not null and ${table.endedAt} is null and ${table.durationMs} is null)
        or (${table.status} in ('succeeded', 'failed', 'skipped') and ${table.startedAt} is not null and ${table.endedAt} is not null and ${table.endedAt} >= ${table.startedAt} and ${table.durationMs} is not null and ${table.durationMs} >= 0)
      `,
    ),
    check(
      'workflow_step_runs_error_shape',
      sql`(${table.status} = 'failed' and ${table.errorCode} is not null and ${table.errorMessage} is not null and ${table.errorRetryable} is not null) or (${table.status} <> 'failed' and ${table.errorCode} is null and ${table.errorMessage} is null and ${table.errorRetryable} is null)`,
    ),
    check(
      'workflow_step_runs_agent_shape',
      sql`
        (${table.step} in ('coverage_analysis', 'consistency_analysis', 'interview_decision', 'conductor_question_generation')
          and ((${table.status} = 'succeeded' and ${table.agentRunId} is not null and ${table.output} is not null)
            or (${table.status} <> 'succeeded' and ${table.agentRunId} is null and ${table.output} is null)))
        or (${table.step} not in ('coverage_analysis', 'consistency_analysis', 'interview_decision', 'conductor_question_generation')
          and ${table.agentRunId} is null and ${table.output} is null)
      `,
    ),
    check(
      'workflow_step_runs_json_objects',
      sql`(${table.input} is null or jsonb_typeof(${table.input}) = 'object') and (${table.output} is null or jsonb_typeof(${table.output}) = 'object')`,
    ),
  ],
);

export const aiTurnDeliveries = appSchema.table(
  'ai_turn_deliveries',
  {
    id: text('id').notNull(),
    interviewId: text('interview_id').notNull(),
    jobId: text('job_id').notNull(),
    workflowRunId: text('workflow_run_id').notNull(),
    turnId: text('turn_id').notNull(),
    utteranceId: text('utterance_id').notNull(),
    reservedSequenceNumber: integer('reserved_sequence_number').notNull(),
    turnType: text('turn_type').notNull(),
    guideId: text('guide_id'),
    questionId: text('question_id'),
    proposedText: text('proposed_text').notNull(),
    planningMetadata: jsonb('planning_metadata'),
    status: text('status')
      .$type<'pending' | 'complete' | 'interrupted' | 'gapped' | 'cancelled'>()
      .notNull(),
    provider: text('provider'),
    providerDeliveryEventId: text('provider_delivery_event_id'),
    confirmedSpokenText: text('confirmed_spoken_text'),
    createdAt: timestamp('created_at', timestampOptions).notNull(),
    resolvedAt: timestamp('resolved_at', timestampOptions),
    interruptedAt: timestamp('interrupted_at', timestampOptions),
  },
  (table): PgTableExtraConfigValue[] => [
    primaryKey({ columns: [table.interviewId, table.id], name: 'ai_turn_deliveries_pk' }),
    unique('ai_turn_deliveries_turn_scope_unique').on(table.interviewId, table.id, table.turnId),
    unique('ai_turn_deliveries_sequence_unique').on(
      table.interviewId,
      table.reservedSequenceNumber,
    ),
    unique('ai_turn_deliveries_turn_unique').on(table.interviewId, table.turnId),
    unique('ai_turn_deliveries_utterance_unique').on(table.interviewId, table.utteranceId),
    foreignKey({
      columns: [table.interviewId, table.jobId],
      foreignColumns: [durableJobs.interviewId, durableJobs.id],
      name: 'ai_turn_deliveries_job_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.interviewId, table.workflowRunId, table.jobId],
      foreignColumns: [workflowRuns.interviewId, workflowRuns.id, workflowRuns.jobId],
      name: 'ai_turn_deliveries_workflow_job_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.interviewId, table.guideId],
      foreignColumns: [interviews.id, interviews.guideId],
      name: 'ai_turn_deliveries_interview_guide_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.guideId, table.questionId],
      foreignColumns: [guideQuestions.guideId, guideQuestions.id],
      name: 'ai_turn_deliveries_question_fk',
    }).onDelete('restrict'),
    uniqueIndex('ai_turn_deliveries_provider_event_unique')
      .on(table.interviewId, table.provider, table.providerDeliveryEventId)
      .where(sql`${table.providerDeliveryEventId} is not null`),
    uniqueIndex('ai_turn_deliveries_one_pending_per_interview')
      .on(table.interviewId)
      .where(sql`${table.status} = 'pending'`),
    index('ai_turn_deliveries_pending_idx').on(table.status, table.createdAt),
    check('ai_turn_deliveries_sequence_positive', sql`${table.reservedSequenceNumber} > 0`),
    check(
      'ai_turn_deliveries_planning_metadata_object',
      sql`${table.planningMetadata} is null or jsonb_typeof(${table.planningMetadata}) = 'object'`,
    ),
    check(
      'ai_turn_deliveries_internal_ids_valid',
      sql`
        ${table.id} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
        and ${table.jobId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
        and ${table.workflowRunId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
        and ${table.turnId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
        and ${table.utteranceId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
      `,
    ),
    check(
      'ai_turn_deliveries_text_valid',
      sql`${table.proposedText} !~ U&'^[\\0009-\\000D\\0020\\00A0\\1680\\2000-\\200A\\2028\\2029\\202F\\205F\\3000\\FEFF]*$' and char_length(${table.proposedText}) <= 20000`,
    ),
    check(
      'ai_turn_deliveries_provider_identifiers_valid',
      sql`
        (${table.provider} is null or (${table.provider} !~ U&'^[\\0009-\\000D\\0020\\00A0\\1680\\2000-\\200A\\2028\\2029\\202F\\205F\\3000\\FEFF]' and ${table.provider} !~ U&'[\\0009-\\000D\\0020\\00A0\\1680\\2000-\\200A\\2028\\2029\\202F\\205F\\3000\\FEFF]$' and char_length(${table.provider}) between 1 and 100))
        and (${table.providerDeliveryEventId} is null or (${table.providerDeliveryEventId} !~ U&'^[\\0009-\\000D\\0020\\00A0\\1680\\2000-\\200A\\2028\\2029\\202F\\205F\\3000\\FEFF]' and ${table.providerDeliveryEventId} !~ U&'[\\0009-\\000D\\0020\\00A0\\1680\\2000-\\200A\\2028\\2029\\202F\\205F\\3000\\FEFF]$' and char_length(${table.providerDeliveryEventId}) between 1 and 300))
      `,
    ),
    check(
      'ai_turn_deliveries_confirmed_text_valid',
      sql`${table.confirmedSpokenText} is null or (${table.confirmedSpokenText} !~ U&'^[\\0009-\\000D\\0020\\00A0\\1680\\2000-\\200A\\2028\\2029\\202F\\205F\\3000\\FEFF]*$' and char_length(${table.confirmedSpokenText}) <= 20000)`,
    ),
    check(
      'ai_turn_deliveries_turn_type_valid',
      sql`${table.turnType} in ('greeting', 'main_question', 'follow_up_question', 'clarification_question', 'transition', 'closing')`,
    ),
    check(
      'ai_turn_deliveries_guide_reference_shape',
      sql`
        (${table.turnType} in ('greeting', 'closing') and ${table.guideId} is null and ${table.questionId} is null)
        or (${table.turnType} in ('main_question', 'follow_up_question', 'clarification_question') and ${table.guideId} is not null and ${table.questionId} is not null)
        or (${table.turnType} = 'transition' and ((${table.guideId} is null and ${table.questionId} is null) or (${table.guideId} is not null and ${table.questionId} is not null)))
      `,
    ),
    check(
      'ai_turn_deliveries_resolution_shape',
      sql`
        (${table.status} = 'pending' and ${table.provider} is null and ${table.providerDeliveryEventId} is null and ${table.confirmedSpokenText} is null and ${table.resolvedAt} is null and ${table.interruptedAt} is null)
        or (${table.status} = 'complete' and ${table.provider} is not null and btrim(${table.provider}) <> '' and ${table.providerDeliveryEventId} is not null and btrim(${table.providerDeliveryEventId}) <> '' and ${table.confirmedSpokenText} is not null and btrim(${table.confirmedSpokenText}) <> '' and ${table.resolvedAt} is not null and ${table.interruptedAt} is null)
        or (${table.status} = 'interrupted' and ${table.provider} is not null and btrim(${table.provider}) <> '' and ${table.providerDeliveryEventId} is not null and btrim(${table.providerDeliveryEventId}) <> '' and ${table.confirmedSpokenText} is not null and ${table.resolvedAt} is not null and ${table.interruptedAt} is not null)
        or (${table.status} in ('gapped', 'cancelled') and ${table.provider} is null and ${table.providerDeliveryEventId} is null and ${table.confirmedSpokenText} is null and ${table.resolvedAt} is not null and ${table.interruptedAt} is null)
      `,
    ),
    check(
      'ai_turn_deliveries_time_order',
      sql`(${table.resolvedAt} is null or ${table.resolvedAt} >= ${table.createdAt}) and (${table.interruptedAt} is null or (${table.interruptedAt} >= ${table.createdAt} and ${table.resolvedAt} is not null and ${table.interruptedAt} <= ${table.resolvedAt}))`,
    ),
    check(
      'ai_turn_deliveries_confirmed_prefix',
      sql`${table.confirmedSpokenText} is null or ${table.status} = 'complete' or left(${table.proposedText}, char_length(${table.confirmedSpokenText})) = ${table.confirmedSpokenText}`,
    ),
  ],
);

export const transcriptPartialEvents = appSchema.table(
  'transcript_partial_events',
  {
    interviewId: text('interview_id').notNull(),
    provider: text('provider').notNull(),
    providerEventId: text('provider_event_id').notNull(),
    segmentId: text('segment_id').notNull(),
    utteranceId: text('utterance_id').notNull(),
    revision: integer('revision').notNull(),
    text: text('text').notNull(),
    disposition: text('disposition')
      .$type<'accepted' | 'updated' | 'ignored_stale' | 'ignored_finalized'>()
      .notNull(),
    observedAt: timestamp('observed_at', timestampOptions).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.interviewId, table.provider, table.providerEventId],
      name: 'transcript_partial_events_pk',
    }),
    unique('transcript_partial_segment_revision_unique').on(
      table.interviewId,
      table.provider,
      table.segmentId,
      table.revision,
    ),
    foreignKey({
      columns: [table.interviewId],
      foreignColumns: [interviews.id],
      name: 'transcript_partial_events_interview_fk',
    }).onDelete('cascade'),
    index('transcript_partial_segment_idx').on(
      table.interviewId,
      table.provider,
      table.segmentId,
      table.revision,
    ),
    check(
      'transcript_partial_internal_ids_valid',
      sql`
        ${table.segmentId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
        and ${table.utteranceId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
      `,
    ),
    check(
      'transcript_partial_provider_identifiers_valid',
      sql`
        ${table.provider} !~ U&'^[\\0009-\\000D\\0020\\00A0\\1680\\2000-\\200A\\2028\\2029\\202F\\205F\\3000\\FEFF]'
        and ${table.provider} !~ U&'[\\0009-\\000D\\0020\\00A0\\1680\\2000-\\200A\\2028\\2029\\202F\\205F\\3000\\FEFF]$'
        and char_length(${table.provider}) between 1 and 100
        and ${table.providerEventId} !~ U&'^[\\0009-\\000D\\0020\\00A0\\1680\\2000-\\200A\\2028\\2029\\202F\\205F\\3000\\FEFF]'
        and ${table.providerEventId} !~ U&'[\\0009-\\000D\\0020\\00A0\\1680\\2000-\\200A\\2028\\2029\\202F\\205F\\3000\\FEFF]$'
        and char_length(${table.providerEventId}) between 1 and 300
      `,
    ),
    check('transcript_partial_text_valid', sql`char_length(${table.text}) <= 20000`),
    check('transcript_partial_revision_nonnegative', sql`${table.revision} >= 0`),
    check(
      'transcript_partial_disposition_valid',
      sql`${table.disposition} in ('accepted', 'updated', 'ignored_stale', 'ignored_finalized')`,
    ),
  ],
);

export const transcriptEntries = appSchema.table(
  'transcript_entries',
  {
    interviewId: text('interview_id').notNull(),
    sequenceNumber: integer('sequence_number').notNull(),
    entryId: text('entry_id').notNull(),
    kind: text('kind').$type<'turn' | 'technical_gap'>().notNull(),
    occurredAt: timestamp('occurred_at', timestampOptions).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.interviewId, table.sequenceNumber],
      name: 'transcript_entries_pk',
    }),
    unique('transcript_entries_id_unique').on(table.interviewId, table.entryId),
    unique('transcript_entries_subtype_unique').on(table.interviewId, table.entryId, table.kind),
    foreignKey({
      columns: [table.interviewId],
      foreignColumns: [interviews.id],
      name: 'transcript_entries_interview_fk',
    }).onDelete('cascade'),
    check('transcript_entries_sequence_positive', sql`${table.sequenceNumber} > 0`),
    check('transcript_entries_kind_valid', sql`${table.kind} in ('turn', 'technical_gap')`),
  ],
);

export const transcriptTurns = appSchema.table(
  'transcript_turns',
  {
    interviewId: text('interview_id').notNull(),
    turnId: text('turn_id').notNull(),
    entryKind: text('entry_kind').$type<'turn'>().notNull().default('turn'),
    speaker: text('speaker').$type<'ai_interviewer' | 'participant'>().notNull(),
    turnType: text('turn_type').notNull(),
    text: text('text').notNull(),
    guideId: text('guide_id'),
    questionId: text('question_id'),
    sourceProvider: text('source_provider'),
    providerEventId: text('provider_event_id'),
    sourceSegmentId: text('source_segment_id'),
    deliveryId: text('delivery_id'),
    deliveryEventId: text('delivery_event_id'),
    deliveryStatus: text('delivery_status').$type<'complete' | 'interrupted'>(),
    interruptedAt: timestamp('interrupted_at', timestampOptions),
  },
  (table): PgTableExtraConfigValue[] => [
    primaryKey({ columns: [table.interviewId, table.turnId], name: 'transcript_turns_pk' }),
    unique('transcript_turns_source_scope_unique').on(
      table.interviewId,
      table.turnId,
      table.sourceProvider,
    ),
    foreignKey({
      columns: [table.interviewId, table.turnId, table.entryKind],
      foreignColumns: [
        transcriptEntries.interviewId,
        transcriptEntries.entryId,
        transcriptEntries.kind,
      ],
      name: 'transcript_turns_entry_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.interviewId, table.deliveryId, table.turnId],
      foreignColumns: [aiTurnDeliveries.interviewId, aiTurnDeliveries.id, aiTurnDeliveries.turnId],
      name: 'transcript_turns_delivery_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.interviewId, table.guideId],
      foreignColumns: [interviews.id, interviews.guideId],
      name: 'transcript_turns_interview_guide_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.guideId, table.questionId],
      foreignColumns: [guideQuestions.guideId, guideQuestions.id],
      name: 'transcript_turns_question_fk',
    }).onDelete('restrict'),
    uniqueIndex('transcript_turns_participant_provider_event_unique')
      .on(table.interviewId, table.sourceProvider, table.providerEventId)
      .where(sql`${table.providerEventId} is not null`),
    uniqueIndex('transcript_turns_source_segment_unique')
      .on(table.interviewId, table.sourceProvider, table.sourceSegmentId)
      .where(sql`${table.sourceSegmentId} is not null`),
    uniqueIndex('transcript_turns_delivery_event_unique')
      .on(table.interviewId, table.deliveryEventId)
      .where(sql`${table.deliveryEventId} is not null`),
    check('transcript_turns_entry_kind_turn', sql`${table.entryKind} = 'turn'`),
    check(
      'transcript_turns_internal_ids_valid',
      sql`
        ${table.turnId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
        and (${table.sourceSegmentId} is null or ${table.sourceSegmentId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$')
        and (${table.deliveryId} is null or ${table.deliveryId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$')
      `,
    ),
    check(
      'transcript_turns_provider_identifiers_valid',
      sql`
        (${table.sourceProvider} is null or (${table.sourceProvider} !~ U&'^[\\0009-\\000D\\0020\\00A0\\1680\\2000-\\200A\\2028\\2029\\202F\\205F\\3000\\FEFF]' and ${table.sourceProvider} !~ U&'[\\0009-\\000D\\0020\\00A0\\1680\\2000-\\200A\\2028\\2029\\202F\\205F\\3000\\FEFF]$' and char_length(${table.sourceProvider}) between 1 and 100))
        and (${table.providerEventId} is null or (${table.providerEventId} !~ U&'^[\\0009-\\000D\\0020\\00A0\\1680\\2000-\\200A\\2028\\2029\\202F\\205F\\3000\\FEFF]' and ${table.providerEventId} !~ U&'[\\0009-\\000D\\0020\\00A0\\1680\\2000-\\200A\\2028\\2029\\202F\\205F\\3000\\FEFF]$' and char_length(${table.providerEventId}) between 1 and 300))
        and (${table.deliveryEventId} is null or (${table.deliveryEventId} !~ U&'^[\\0009-\\000D\\0020\\00A0\\1680\\2000-\\200A\\2028\\2029\\202F\\205F\\3000\\FEFF]' and ${table.deliveryEventId} !~ U&'[\\0009-\\000D\\0020\\00A0\\1680\\2000-\\200A\\2028\\2029\\202F\\205F\\3000\\FEFF]$' and char_length(${table.deliveryEventId}) between 1 and 300))
      `,
    ),
    check(
      'transcript_turns_text_valid',
      sql`${table.text} !~ U&'^[\\0009-\\000D\\0020\\00A0\\1680\\2000-\\200A\\2028\\2029\\202F\\205F\\3000\\FEFF]*$' and char_length(${table.text}) <= 20000`,
    ),
    check(
      'transcript_turns_turn_type_valid',
      sql`${table.turnType} in ('greeting', 'main_question', 'follow_up_question', 'clarification_question', 'participant_answer', 'transition', 'closing')`,
    ),
    check(
      'transcript_turns_speaker_shape',
      sql`
        (${table.speaker} = 'participant' and ${table.turnType} = 'participant_answer' and ${table.sourceProvider} is not null and btrim(${table.sourceProvider}) <> '' and ${table.providerEventId} is not null and ${table.sourceSegmentId} is not null and ${table.deliveryId} is null and ${table.deliveryEventId} is null and ${table.deliveryStatus} is null and ${table.interruptedAt} is null)
        or (${table.speaker} = 'ai_interviewer' and ${table.turnType} <> 'participant_answer' and ${table.sourceProvider} is null and ${table.providerEventId} is null and ${table.sourceSegmentId} is null and ${table.deliveryId} is not null and ${table.deliveryEventId} is not null and ${table.deliveryStatus} is not null and ${table.deliveryStatus} in ('complete', 'interrupted'))
      `,
    ),
    check(
      'transcript_turns_interruption_shape',
      sql`(${table.deliveryStatus} = 'interrupted' and ${table.interruptedAt} is not null) or (${table.deliveryStatus} is distinct from 'interrupted' and ${table.interruptedAt} is null)`,
    ),
    check(
      'transcript_turns_guide_reference_shape',
      sql`
        (${table.turnType} in ('greeting', 'closing') and ${table.guideId} is null and ${table.questionId} is null)
        or (${table.turnType} in ('main_question', 'follow_up_question', 'clarification_question') and ${table.guideId} is not null and ${table.questionId} is not null)
        or (${table.turnType} in ('participant_answer', 'transition') and ((${table.guideId} is null and ${table.questionId} is null) or (${table.guideId} is not null and ${table.questionId} is not null)))
      `,
    ),
  ],
);

export const transcriptFinalSegments = appSchema.table(
  'transcript_final_segments',
  {
    interviewId: text('interview_id').notNull(),
    provider: text('provider').notNull(),
    providerEventId: text('provider_event_id').notNull(),
    segmentId: text('segment_id').notNull(),
    utteranceId: text('utterance_id').notNull(),
    turnId: text('turn_id').notNull(),
    text: text('text').notNull(),
    observedAt: timestamp('observed_at', timestampOptions).notNull(),
    finalizedAt: timestamp('finalized_at', timestampOptions).notNull(),
  },
  (table): PgTableExtraConfigValue[] => [
    primaryKey({
      columns: [table.interviewId, table.provider, table.providerEventId],
      name: 'transcript_final_segments_pk',
    }),
    unique('transcript_final_segments_segment_unique').on(
      table.interviewId,
      table.provider,
      table.segmentId,
    ),
    unique('transcript_final_segments_turn_unique').on(table.interviewId, table.turnId),
    unique('transcript_final_segments_utterance_unique').on(
      table.interviewId,
      table.provider,
      table.utteranceId,
    ),
    foreignKey({
      columns: [table.interviewId, table.turnId, table.provider],
      foreignColumns: [
        transcriptTurns.interviewId,
        transcriptTurns.turnId,
        transcriptTurns.sourceProvider,
      ],
      name: 'transcript_final_segments_turn_fk',
    }).onDelete('cascade'),
    check(
      'transcript_final_segments_internal_ids_valid',
      sql`
        ${table.segmentId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
        and ${table.utteranceId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
        and ${table.turnId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
      `,
    ),
    check(
      'transcript_final_segments_provider_identifiers_valid',
      sql`
        ${table.provider} !~ U&'^[\\0009-\\000D\\0020\\00A0\\1680\\2000-\\200A\\2028\\2029\\202F\\205F\\3000\\FEFF]'
        and ${table.provider} !~ U&'[\\0009-\\000D\\0020\\00A0\\1680\\2000-\\200A\\2028\\2029\\202F\\205F\\3000\\FEFF]$'
        and char_length(${table.provider}) between 1 and 100
        and ${table.providerEventId} !~ U&'^[\\0009-\\000D\\0020\\00A0\\1680\\2000-\\200A\\2028\\2029\\202F\\205F\\3000\\FEFF]'
        and ${table.providerEventId} !~ U&'[\\0009-\\000D\\0020\\00A0\\1680\\2000-\\200A\\2028\\2029\\202F\\205F\\3000\\FEFF]$'
        and char_length(${table.providerEventId}) between 1 and 300
      `,
    ),
    check(
      'transcript_final_segments_text_valid',
      sql`${table.text} !~ U&'^[\\0009-\\000D\\0020\\00A0\\1680\\2000-\\200A\\2028\\2029\\202F\\205F\\3000\\FEFF]*$' and char_length(${table.text}) <= 20000`,
    ),
    check('transcript_final_segments_time_order', sql`${table.finalizedAt} >= ${table.observedAt}`),
  ],
);

export const transcriptGaps = appSchema.table(
  'transcript_gaps',
  {
    interviewId: text('interview_id').notNull(),
    gapId: text('gap_id').notNull(),
    entryKind: text('entry_kind').$type<'technical_gap'>().notNull().default('technical_gap'),
    source: text('source').$type<'speech_to_text' | 'audio_output' | 'transport'>().notNull(),
    provider: text('provider'),
    description: text('description').notNull(),
    relatedSegmentId: text('related_segment_id'),
    relatedUtteranceId: text('related_utterance_id'),
    sourceEventId: text('source_event_id').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.interviewId, table.gapId], name: 'transcript_gaps_pk' }),
    uniqueIndex('transcript_gaps_stt_source_event_unique')
      .on(table.interviewId, table.provider, table.sourceEventId)
      .where(sql`${table.source} = 'speech_to_text'`),
    uniqueIndex('transcript_gaps_non_stt_source_event_unique')
      .on(table.interviewId, table.sourceEventId)
      .where(sql`${table.source} <> 'speech_to_text'`),
    uniqueIndex('transcript_gaps_stt_utterance_unique')
      .on(table.interviewId, table.provider, table.relatedUtteranceId)
      .where(sql`${table.source} = 'speech_to_text'`),
    foreignKey({
      columns: [table.interviewId, table.gapId, table.entryKind],
      foreignColumns: [
        transcriptEntries.interviewId,
        transcriptEntries.entryId,
        transcriptEntries.kind,
      ],
      name: 'transcript_gaps_entry_fk',
    }).onDelete('cascade'),
    check('transcript_gaps_entry_kind_gap', sql`${table.entryKind} = 'technical_gap'`),
    check(
      'transcript_gaps_source_valid',
      sql`${table.source} in ('speech_to_text', 'audio_output', 'transport')`,
    ),
    check(
      'transcript_gaps_provider_shape',
      sql`(${table.source} = 'speech_to_text' and ${table.provider} is not null and btrim(${table.provider}) <> '' and ${table.relatedUtteranceId} is not null and btrim(${table.relatedUtteranceId}) <> '') or (${table.source} <> 'speech_to_text' and ${table.provider} is null and ${table.relatedUtteranceId} is null)`,
    ),
    check(
      'transcript_gaps_internal_ids_valid',
      sql`
        ${table.gapId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
        and (${table.relatedSegmentId} is null or ${table.relatedSegmentId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$')
        and (${table.relatedUtteranceId} is null or ${table.relatedUtteranceId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$')
        and ${table.sourceEventId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
      `,
    ),
    check(
      'transcript_gaps_provider_identifiers_valid',
      sql`
        ${table.provider} is null or (${table.provider} !~ U&'^[\\0009-\\000D\\0020\\00A0\\1680\\2000-\\200A\\2028\\2029\\202F\\205F\\3000\\FEFF]' and ${table.provider} !~ U&'[\\0009-\\000D\\0020\\00A0\\1680\\2000-\\200A\\2028\\2029\\202F\\205F\\3000\\FEFF]$' and char_length(${table.provider}) between 1 and 100)
      `,
    ),
    check(
      'transcript_gaps_description_valid',
      sql`${table.description} !~ U&'^[\\0009-\\000D\\0020\\00A0\\1680\\2000-\\200A\\2028\\2029\\202F\\205F\\3000\\FEFF]*$' and char_length(${table.description}) <= 1000`,
    ),
  ],
);

export const questionCoverage = appSchema.table(
  'question_coverage',
  {
    interviewId: text('interview_id').notNull(),
    guideId: text('guide_id').notNull(),
    questionId: text('question_id').notNull(),
    status: text('status')
      .$type<
        'not_addressed' | 'current' | 'partially_answered' | 'answered' | 'skipped_already_answered'
      >()
      .notNull(),
    updatedAt: timestamp('updated_at', timestampOptions),
  },
  (table) => [
    primaryKey({ columns: [table.interviewId, table.questionId], name: 'question_coverage_pk' }),
    foreignKey({
      columns: [table.interviewId, table.guideId],
      foreignColumns: [interviews.id, interviews.guideId],
      name: 'question_coverage_interview_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.guideId, table.questionId],
      foreignColumns: [guideQuestions.guideId, guideQuestions.id],
      name: 'question_coverage_question_fk',
    }).onDelete('restrict'),
    uniqueIndex('question_coverage_one_current_per_interview')
      .on(table.interviewId)
      .where(sql`${table.status} = 'current'`),
    index('question_coverage_status_idx').on(table.interviewId, table.status),
    check(
      'question_coverage_status_valid',
      sql`${table.status} in ('not_addressed', 'current', 'partially_answered', 'answered', 'skipped_already_answered')`,
    ),
  ],
);

export const coverageTurnReferences = appSchema.table(
  'coverage_turn_references',
  {
    interviewId: text('interview_id').notNull(),
    questionId: text('question_id').notNull(),
    turnId: text('turn_id').notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.interviewId, table.questionId, table.turnId],
      name: 'coverage_turn_references_pk',
    }),
    foreignKey({
      columns: [table.interviewId, table.questionId],
      foreignColumns: [questionCoverage.interviewId, questionCoverage.questionId],
      name: 'coverage_turn_references_coverage_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.interviewId, table.turnId],
      foreignColumns: [transcriptTurns.interviewId, transcriptTurns.turnId],
      name: 'coverage_turn_references_turn_fk',
    }).onDelete('restrict'),
    index('coverage_turn_references_turn_idx').on(table.interviewId, table.turnId),
  ],
);

export const contradictions = appSchema.table(
  'contradictions',
  {
    interviewId: text('interview_id').notNull(),
    id: text('id').notNull(),
    workflowRunId: text('workflow_run_id').notNull(),
    agentRunId: text('agent_run_id').notNull(),
    description: text('description').notNull(),
    suggestedClarificationQuestion: text('suggested_clarification_question').notNull(),
    shouldClarify: boolean('should_clarify').notNull(),
    rationale: text('rationale').notNull(),
    status: text('status').$type<'detected' | 'asked' | 'dismissed' | 'resolved'>().notNull(),
    askedTurnId: text('asked_turn_id'),
    createdAt: timestamp('created_at', timestampOptions).notNull(),
    updatedAt: timestamp('updated_at', timestampOptions).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.interviewId, table.id], name: 'contradictions_pk' }),
    foreignKey({
      columns: [table.interviewId, table.workflowRunId],
      foreignColumns: [workflowRuns.interviewId, workflowRuns.id],
      name: 'contradictions_workflow_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.interviewId, table.workflowRunId, table.agentRunId],
      foreignColumns: [agentRuns.interviewId, agentRuns.workflowRunId, agentRuns.id],
      name: 'contradictions_workflow_agent_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.interviewId, table.askedTurnId],
      foreignColumns: [transcriptTurns.interviewId, transcriptTurns.turnId],
      name: 'contradictions_asked_turn_fk',
    }).onDelete('restrict'),
    index('contradictions_status_idx').on(table.interviewId, table.status, table.createdAt),
    check(
      'contradictions_status_valid',
      sql`${table.status} in ('detected', 'asked', 'dismissed', 'resolved')`,
    ),
    check('contradictions_description_not_blank', sql`btrim(${table.description}) <> ''`),
    check(
      'contradictions_clarification_single_question',
      sql`right(btrim(${table.suggestedClarificationQuestion}), 1) = '?' and length(${table.suggestedClarificationQuestion}) - length(replace(${table.suggestedClarificationQuestion}, '?', '')) = 1`,
    ),
    check(
      'contradictions_asked_turn_shape',
      sql`(${table.status} = 'asked' and ${table.askedTurnId} is not null) or (${table.status} <> 'asked')`,
    ),
    check('contradictions_time_order', sql`${table.updatedAt} >= ${table.createdAt}`),
  ],
);

export const contradictionTurnReferences = appSchema.table(
  'contradiction_turn_references',
  {
    interviewId: text('interview_id').notNull(),
    contradictionId: text('contradiction_id').notNull(),
    turnId: text('turn_id').notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.interviewId, table.contradictionId, table.turnId],
      name: 'contradiction_turn_references_pk',
    }),
    foreignKey({
      columns: [table.interviewId, table.contradictionId],
      foreignColumns: [contradictions.interviewId, contradictions.id],
      name: 'contradiction_turn_references_contradiction_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.interviewId, table.turnId],
      foreignColumns: [transcriptTurns.interviewId, transcriptTurns.turnId],
      name: 'contradiction_turn_references_turn_fk',
    }).onDelete('restrict'),
    index('contradiction_turn_references_turn_idx').on(table.interviewId, table.turnId),
  ],
);

export const transcriptFinalizations = appSchema.table(
  'transcript_finalizations',
  {
    interviewId: text('interview_id').primaryKey(),
    finalizationId: text('finalization_id').notNull(),
    stateVersion: integer('state_version').notNull(),
    agentRunId: text('agent_run_id').notNull(),
    validationStatus: text('validation_status').$type<'valid' | 'valid_with_gaps'>().notNull(),
    entryCount: integer('entry_count').notNull(),
    technicalGapCount: integer('technical_gap_count').notNull(),
    deterministicIssues: jsonb('deterministic_issues')
      .$type<readonly Record<string, unknown>[]>()
      .notNull(),
    agentReport: jsonb('agent_report').$type<Record<string, unknown>>().notNull(),
    canonicalDigest: text('canonical_digest').notNull(),
    finalizedAt: timestamp('finalized_at', timestampOptions).notNull(),
  },
  (table) => [
    unique('transcript_finalizations_id_unique').on(table.finalizationId),
    foreignKey({
      columns: [table.interviewId],
      foreignColumns: [interviews.id],
      name: 'transcript_finalizations_interview_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.interviewId, table.agentRunId],
      foreignColumns: [agentRuns.interviewId, agentRuns.id],
      name: 'transcript_finalizations_agent_fk',
    }).onDelete('restrict'),
    check('transcript_finalizations_state_version_nonnegative', sql`${table.stateVersion} >= 0`),
    check(
      'transcript_finalizations_counts_nonnegative',
      sql`${table.entryCount} >= 0 and ${table.technicalGapCount} >= 0 and ${table.technicalGapCount} <= ${table.entryCount}`,
    ),
    check(
      'transcript_finalizations_validation_status_valid',
      sql`${table.validationStatus} in ('valid', 'valid_with_gaps')`,
    ),
    check(
      'transcript_finalizations_json_shape',
      sql`jsonb_typeof(${table.deterministicIssues}) = 'array' and jsonb_typeof(${table.agentReport}) = 'object'`,
    ),
    check(
      'transcript_finalizations_digest_sha256',
      sql`${table.canonicalDigest} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);

export const evaluationProfiles = appSchema.table(
  'evaluation_profiles',
  {
    profileId: text('profile_id').primaryKey(),
    name: text('name').notNull(),
    isDefault: boolean('is_default').notNull().default(false),
    profile: jsonb('profile').$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp('created_at', timestampOptions).notNull(),
    updatedAt: timestamp('updated_at', timestampOptions).notNull(),
  },
  (table) => [
    uniqueIndex('evaluation_profiles_name_unique').on(sql`lower(${table.name})`),
    uniqueIndex('evaluation_profiles_one_default')
      .on(table.isDefault)
      .where(sql`${table.isDefault} = true`),
    check(
      'evaluation_profiles_identity_valid',
      sql`${table.profileId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'`,
    ),
    check('evaluation_profiles_name_not_blank', sql`btrim(${table.name}) <> ''`),
    check('evaluation_profiles_time_order', sql`${table.updatedAt} >= ${table.createdAt}`),
    check(
      'evaluation_profiles_json_scope',
      sql`jsonb_typeof(${table.profile}) = 'object' and ${table.profile} @> jsonb_build_object('profileId', ${table.profileId}, 'name', ${table.name}, 'isDefault', ${table.isDefault}, 'createdAt', to_char(${table.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'updatedAt', to_char(${table.updatedAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))`,
    ),
  ],
);

export const evaluationRuns = appSchema.table(
  'evaluation_runs',
  {
    evaluationId: text('evaluation_id').primaryKey(),
    interviewId: text('interview_id').notNull(),
    profileId: text('profile_id').notNull(),
    profileFingerprint: text('profile_fingerprint').notNull(),
    transcriptFingerprint: text('transcript_fingerprint').notNull(),
    language: text('language').$type<'de' | 'en'>().notNull().default('de'),
    status: text('status').$type<'running' | 'completed' | 'failed'>().notNull(),
    promptVersion: text('prompt_version').notNull(),
    model: jsonb('model').$type<Record<string, unknown>>().notNull(),
    report: jsonb('report').$type<Record<string, unknown>>(),
    failure: jsonb('failure').$type<Record<string, unknown>>(),
    startedAt: timestamp('started_at', timestampOptions).notNull(),
    endedAt: timestamp('ended_at', timestampOptions),
    durationMs: integer('duration_ms'),
  },
  (table) => [
    unique('evaluation_runs_interview_profile_unique').on(table.interviewId, table.profileId),
    foreignKey({
      columns: [table.interviewId],
      foreignColumns: [interviews.id],
      name: 'evaluation_runs_interview_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.profileId],
      foreignColumns: [evaluationProfiles.profileId],
      name: 'evaluation_runs_profile_fk',
    }).onDelete('cascade'),
    index('evaluation_runs_interview_started_idx').on(table.interviewId, table.startedAt.desc()),
    check(
      'evaluation_runs_identity_valid',
      sql`${table.evaluationId} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' and ${table.promptVersion} ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'`,
    ),
    check(
      'evaluation_runs_fingerprints_sha256',
      sql`${table.profileFingerprint} ~ '^[0-9a-f]{64}$' and ${table.transcriptFingerprint} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'evaluation_runs_status_valid',
      sql`${table.status} in ('running', 'completed', 'failed')`,
    ),
    check('evaluation_runs_language_valid', sql`${table.language} in ('de', 'en')`),
    check('evaluation_runs_model_object', sql`jsonb_typeof(${table.model}) = 'object'`),
    check(
      'evaluation_runs_terminal_shape',
      sql`
        (${table.status} = 'running' and ${table.endedAt} is null and ${table.durationMs} is null and ${table.report} is null and ${table.failure} is null)
        or (${table.status} = 'completed' and ${table.endedAt} is not null and ${table.durationMs} is not null and ${table.report} is not null and jsonb_typeof(${table.report}) = 'object' and ${table.failure} is null)
        or (${table.status} = 'failed' and ${table.endedAt} is not null and ${table.durationMs} is not null and ${table.report} is null and ${table.failure} is not null and jsonb_typeof(${table.failure}) = 'object')
      `,
    ),
    check(
      'evaluation_runs_timing_valid',
      sql`${table.status} = 'running' or (${table.endedAt} >= ${table.startedAt} and ${table.durationMs} >= 0 and ${table.durationMs} = round(extract(epoch from (${table.endedAt} - ${table.startedAt})) * 1000)::integer)`,
    ),
    check(
      'evaluation_runs_completed_report_scope',
      sql`${table.status} <> 'completed' or ${table.report} @> jsonb_build_object('evaluationId', ${table.evaluationId}, 'interviewId', ${table.interviewId}, 'profileId', ${table.profileId}, 'profileFingerprint', ${table.profileFingerprint}, 'transcriptFingerprint', ${table.transcriptFingerprint}, 'language', ${table.language}, 'promptVersion', ${table.promptVersion}, 'model', ${table.model})`,
    ),
  ],
);

export const eventOutbox = appSchema.table(
  'event_outbox',
  {
    eventId: text('event_id').primaryKey(),
    interviewId: text('interview_id').notNull(),
    language: text('language').$type<'de' | 'en'>().notNull().default('de'),
    runId: text('run_id').notNull(),
    sequenceNumber: integer('sequence_number').notNull(),
    category: text('category').notNull(),
    type: text('type').notNull(),
    occurredAt: timestamp('occurred_at', timestampOptions).notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp('created_at', timestampOptions).notNull().defaultNow(),
  },
  (table) => [
    unique('event_outbox_interview_sequence_unique').on(table.interviewId, table.sequenceNumber),
    foreignKey({
      columns: [table.interviewId],
      foreignColumns: [interviews.id],
      name: 'event_outbox_interview_fk',
    }).onDelete('cascade'),
    index('event_outbox_replay_idx').on(table.interviewId, table.sequenceNumber),
    index('event_outbox_category_idx').on(table.interviewId, table.category, table.occurredAt),
    index('event_outbox_run_idx').on(table.interviewId, table.runId, table.occurredAt),
    check('event_outbox_sequence_positive', sql`${table.sequenceNumber} > 0`),
    check('event_outbox_language_valid', sql`${table.language} in ('de', 'en')`),
    check('event_outbox_run_not_blank', sql`btrim(${table.runId}) <> ''`),
    check(
      'event_outbox_category_valid',
      sql`${table.category} in ('interview', 'workflow', 'agent', 'transcript', 'voice', 'error', 'retry', 'state_update')`,
    ),
    check('event_outbox_type_not_blank', sql`btrim(${table.type}) <> ''`),
    check('event_outbox_payload_object', sql`jsonb_typeof(${table.payload}) = 'object'`),
  ],
);
