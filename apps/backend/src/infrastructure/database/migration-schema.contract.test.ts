import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { getTableConfig, PgDialect, type PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import {
  agentRuns,
  aiTurnDeliveries,
  contradictions,
  durableJobs,
  evaluationRuns,
  eventOutbox,
  guides,
  interviewCounters,
  interviews,
  interviewState,
  transcriptFinalSegments,
  transcriptGaps,
  transcriptPartialEvents,
  transcriptTurns,
  workflowRuns,
  workflowStepRuns,
} from './schema.js';

const migrationDirectory = fileURLToPath(new URL('../../../drizzle/', import.meta.url));
const migrationFiles = readdirSync(migrationDirectory)
  .filter((file) => file.endsWith('.sql'))
  .sort();
const expectedMigrationFiles = [
  '0000_initial_app_schema.sql',
  '0001_transcript_mutation_fence.sql',
  '0002_ai_delivery_contracts.sql',
  '0003_unicode_transcript_contracts.sql',
  '0004_canonical_transcript_contracts.sql',
  '0005_interview_state_summary_pagination.sql',
  '0006_event_outbox_notifications.sql',
  '0007_workflow_step_agent_binding.sql',
  '0008_fast_mvp_sessions.sql',
  '0009_evaluation_persistence.sql',
  '0010_realtime_provider_transcript.sql',
  '0011_evaluation_profiles.sql',
  '0012_profile_driven_evaluations.sql',
  '0013_bilingual_interview_language.sql',
  '0014_section_context_memories.sql',
  '0015_realtime_planning_metadata.sql',
  '0016_interview_settings.sql',
  '0017_interview_display_name.sql',
] as const;

if (migrationFiles.join('\n') !== expectedMigrationFiles.join('\n')) {
  throw new Error('Expected the ordered application SQL migration set');
}

const initialMigrationSql = readFileSync(
  `${migrationDirectory}/${expectedMigrationFiles[0]}`,
  'utf8',
);
const transcriptMutationFenceSql = readFileSync(
  `${migrationDirectory}/${expectedMigrationFiles[1]}`,
  'utf8',
);
const aiDeliveryContractsSql = readFileSync(
  `${migrationDirectory}/${expectedMigrationFiles[2]}`,
  'utf8',
);
const unicodeTranscriptContractsSql = readFileSync(
  `${migrationDirectory}/${expectedMigrationFiles[3]}`,
  'utf8',
);
const canonicalTranscriptContractsSql = readFileSync(
  `${migrationDirectory}/${expectedMigrationFiles[4]}`,
  'utf8',
);
const interviewStateSummaryPaginationSql = readFileSync(
  `${migrationDirectory}/${expectedMigrationFiles[5]}`,
  'utf8',
);
const eventOutboxNotificationsSql = readFileSync(
  `${migrationDirectory}/${expectedMigrationFiles[6]}`,
  'utf8',
);
const workflowStepAgentBindingSql = readFileSync(
  `${migrationDirectory}/${expectedMigrationFiles[7]}`,
  'utf8',
);
const realtimeProviderTranscriptSql = readFileSync(
  `${migrationDirectory}/${expectedMigrationFiles[10]}`,
  'utf8',
);
const bilingualInterviewLanguageSql = readFileSync(
  `${migrationDirectory}/${expectedMigrationFiles[13]}`,
  'utf8',
);
const sectionContextMemoriesSql = readFileSync(
  `${migrationDirectory}/${expectedMigrationFiles[14]}`,
  'utf8',
);
const migrationSql = `${initialMigrationSql}\n${transcriptMutationFenceSql}\n${aiDeliveryContractsSql}\n${unicodeTranscriptContractsSql}\n${canonicalTranscriptContractsSql}\n${interviewStateSummaryPaginationSql}\n${eventOutboxNotificationsSql}\n${workflowStepAgentBindingSql}`;

const REQUIRED_TABLES = [
  'schema_metadata',
  'guides',
  'guide_sections',
  'guide_questions',
  'interviews',
  'interview_state',
  'interview_counters',
  'question_coverage',
  'coverage_turn_references',
  'transcript_partial_events',
  'transcript_final_segments',
  'transcript_entries',
  'transcript_turns',
  'transcript_gaps',
  'ai_turn_deliveries',
  'command_receipts',
  'durable_jobs',
  'workflow_runs',
  'workflow_step_runs',
  'agent_runs',
  'contradictions',
  'contradiction_turn_references',
  'transcript_finalizations',
  'event_outbox',
] as const;

describe('application schema source', () => {
  it('persists validated section context memories in interview state', () => {
    expect(requiredColumnNames(interviewState)).toContain('section_memories');
    expect(schemaCheckSql(interviewState, 'interview_state_section_memories_array')).toContain(
      'jsonb_typeof("app"."interview_state"."section_memories") = \'array\'',
    );
    expect(sectionContextMemoriesSql).toContain(
      'ADD COLUMN "section_memories" jsonb NOT NULL DEFAULT \'[]\'::jsonb',
    );
    expect(sectionContextMemoriesSql).toContain("VALUES ('application', 15, now())");
  });

  it('models guide, interview, monitoring, and evaluation locale as one persisted contract', () => {
    expect(requiredColumnNames(guides)).toContain('source_language');
    expect(requiredColumnNames(interviews)).toContain('language');
    expect(requiredColumnNames(eventOutbox)).toContain('language');
    expect(requiredColumnNames(evaluationRuns)).toContain('language');
    expect(schemaCheckSql(guides, 'guides_source_language_valid')).toContain(
      "\"source_language\" in ('de', 'en')",
    );
    expect(schemaCheckSql(interviews, 'interviews_language_valid')).toContain(
      "\"language\" in ('de', 'en')",
    );
    expect(schemaCheckSql(eventOutbox, 'event_outbox_language_valid')).toContain(
      "\"language\" in ('de', 'en')",
    );
    expect(schemaCheckSql(evaluationRuns, 'evaluation_runs_language_valid')).toContain(
      "\"language\" in ('de', 'en')",
    );
    expect(schemaCheckSql(evaluationRuns, 'evaluation_runs_completed_report_scope')).toContain(
      '\'language\', "app"."evaluation_runs"."language"',
    );
    expect(uniqueColumns(guides, 'guides_id_language_unique')).toEqual(['id', 'source_language']);
    expect(foreignKeyShape(interviews, 'interviews_guide_language_fk')).toEqual({
      columns: ['guide_id', 'language'],
      foreignTable: 'guides',
      foreignColumns: ['id', 'source_language'],
    });
  });

  it('tracks the realtime provider transcript constraint migration', () => {
    expect(realtimeProviderTranscriptSql).toContain(
      'DROP CONSTRAINT "ai_turn_deliveries_confirmed_prefix"',
    );
    expect(realtimeProviderTranscriptSql).toContain(
      '"confirmed_spoken_text" is null or "app"."ai_turn_deliveries"."status" = \'complete\'',
    );
    expect(realtimeProviderTranscriptSql).toContain(
      'left("app"."ai_turn_deliveries"."proposed_text", char_length("app"."ai_turn_deliveries"."confirmed_spoken_text")) = "app"."ai_turn_deliveries"."confirmed_spoken_text"',
    );
  });

  it('defines a nonnegative transcript mutation fence on each interview counter', () => {
    expect(requiredColumnNames(interviewCounters)).toContain('transcript_mutation_version');
    expect(
      schemaCheckSql(interviewCounters, 'interview_counters_transcript_mutation_nonnegative'),
    ).toContain('"transcript_mutation_version" >= 0');
  });

  it('persists immutable bounded initial job delay metadata', () => {
    expect(requiredColumnNames(durableJobs)).toContain('initial_delay_ms');
    expect(schemaCheckSql(durableJobs, 'durable_jobs_initial_delay_valid')).toContain(
      '"initial_delay_ms" >= 0 and "app"."durable_jobs"."initial_delay_ms" <= 900000',
    );
  });

  it('makes nullable lifecycle discriminators and terminal durations explicit', () => {
    const lifecycle = schemaCheckSql(interviewState, 'interview_state_lifecycle_shape');
    expect(lifecycle).toContain('"ending_from" is not null');
    expect(lifecycle).toContain('"failed_from" is not null');
    const lifecycleTimeOrder = schemaCheckSql(
      interviewState,
      'interview_state_lifecycle_time_order',
    );
    expect(lifecycleTimeOrder).toContain('"active_since" >= "app"."interview_state"."started_at"');
    expect(lifecycleTimeOrder).toContain('"ended_at" >= "app"."interview_state"."ending_at"');
    for (const lifecycleTimestamp of [
      'active_since',
      'paused_at',
      'ending_at',
      'ended_at',
      'failed_at',
    ]) {
      expect(lifecycleTimeOrder).toContain(
        `"updated_at" >= "app"."interview_state"."${lifecycleTimestamp}"`,
      );
    }

    for (const [table, checkName] of [
      [workflowRuns, 'workflow_runs_timing_valid'],
      [workflowStepRuns, 'workflow_step_runs_timing_valid'],
      [agentRuns, 'agent_runs_timing_valid'],
    ] as const) {
      expect(schemaCheckSql(table, checkName)).toContain('"duration_ms" is not null');
    }
  });

  it('fully constrains resolved AI delivery and transcript-turn shapes', () => {
    const internalIds = schemaCheckSql(aiTurnDeliveries, 'ai_turn_deliveries_internal_ids_valid');
    for (const column of ['id', 'job_id', 'workflow_run_id', 'turn_id', 'utterance_id']) {
      expect(internalIds).toContain(`"${column}" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'`);
    }
    const proposedText = schemaCheckSql(aiTurnDeliveries, 'ai_turn_deliveries_text_valid');
    expect(proposedText).toContain('!~ U&');
    expect(proposedText).toContain(
      'char_length("app"."ai_turn_deliveries"."proposed_text") <= 20000',
    );

    const providerIdentifiers = schemaCheckSql(
      aiTurnDeliveries,
      'ai_turn_deliveries_provider_identifiers_valid',
    );
    expect(providerIdentifiers).toContain(
      'char_length("app"."ai_turn_deliveries"."provider") between 1 and 100',
    );
    expect(providerIdentifiers).toContain(
      'char_length("app"."ai_turn_deliveries"."provider_delivery_event_id") between 1 and 300',
    );
    expect(providerIdentifiers).toContain('!~ U&');
    const confirmedText = schemaCheckSql(
      aiTurnDeliveries,
      'ai_turn_deliveries_confirmed_text_valid',
    );
    expect(confirmedText).toContain('!~ U&');
    expect(confirmedText).toContain(
      'char_length("app"."ai_turn_deliveries"."confirmed_spoken_text") <= 20000',
    );

    const resolution = schemaCheckSql(aiTurnDeliveries, 'ai_turn_deliveries_resolution_shape');
    expect(resolution).toContain('"confirmed_spoken_text" is not null');
    expect(resolution).toContain('btrim("app"."ai_turn_deliveries"."provider") <> \'\'');
    expect(resolution).toContain('"provider_delivery_event_id" is null');
    expect(resolution).toContain('"interrupted_at" is null');

    const timeOrder = schemaCheckSql(aiTurnDeliveries, 'ai_turn_deliveries_time_order');
    expect(timeOrder).toContain('"resolved_at" >= "app"."ai_turn_deliveries"."created_at"');
    expect(timeOrder).toContain('"interrupted_at" <= "app"."ai_turn_deliveries"."resolved_at"');

    const turnShape = schemaCheckSql(transcriptTurns, 'transcript_turns_speaker_shape');
    expect(turnShape).toContain('"delivery_status" is not null');
    expect(turnShape).toContain('"source_provider" is not null');
    expect(turnShape).toContain('"source_provider" is null');

    const gapProviderShape = schemaCheckSql(transcriptGaps, 'transcript_gaps_provider_shape');
    expect(gapProviderShape).toContain('"source" = \'speech_to_text\'');
    expect(gapProviderShape).toContain('"provider" is not null');
  });

  it('matches canonical transcript identifier and Unicode text contracts', () => {
    const partialIds = schemaCheckSql(
      transcriptPartialEvents,
      'transcript_partial_internal_ids_valid',
    );
    expect(partialIds).toContain('"segment_id" ~ \'^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$\'');
    expect(partialIds).toContain('"utterance_id" ~ \'^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$\'');
    const partialProviderIds = schemaCheckSql(
      transcriptPartialEvents,
      'transcript_partial_provider_identifiers_valid',
    );
    expect(partialProviderIds).toContain(
      'char_length("app"."transcript_partial_events"."provider") between 1 and 100',
    );
    expect(partialProviderIds).toContain(
      'char_length("app"."transcript_partial_events"."provider_event_id") between 1 and 300',
    );
    expect(schemaCheckSql(transcriptPartialEvents, 'transcript_partial_text_valid')).toContain(
      'char_length("app"."transcript_partial_events"."text") <= 20000',
    );

    const turnText = schemaCheckSql(transcriptTurns, 'transcript_turns_text_valid');
    expect(turnText).toContain('!~ U&');
    expect(turnText).toContain('char_length("app"."transcript_turns"."text") <= 20000');
    const turnProviderIds = schemaCheckSql(
      transcriptTurns,
      'transcript_turns_provider_identifiers_valid',
    );
    expect(turnProviderIds).toContain(
      'char_length("app"."transcript_turns"."source_provider") between 1 and 100',
    );
    expect(turnProviderIds).toContain(
      'char_length("app"."transcript_turns"."delivery_event_id") between 1 and 300',
    );

    const finalText = schemaCheckSql(
      transcriptFinalSegments,
      'transcript_final_segments_text_valid',
    );
    expect(finalText).toContain('!~ U&');
    expect(finalText).toContain('char_length("app"."transcript_final_segments"."text") <= 20000');
    const finalProviderIds = schemaCheckSql(
      transcriptFinalSegments,
      'transcript_final_segments_provider_identifiers_valid',
    );
    expect(finalProviderIds).toContain(
      'char_length("app"."transcript_final_segments"."provider") between 1 and 100',
    );
    expect(finalProviderIds).toContain(
      'char_length("app"."transcript_final_segments"."provider_event_id") between 1 and 300',
    );

    const gapDescription = schemaCheckSql(transcriptGaps, 'transcript_gaps_description_valid');
    expect(gapDescription).toContain('!~ U&');
    expect(gapDescription).toContain('char_length("app"."transcript_gaps"."description") <= 1000');
    expect(schemaCheckSql(transcriptGaps, 'transcript_gaps_internal_ids_valid')).toContain(
      '"source_event_id" ~ \'^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$\'',
    );
    const gapProviderIds = schemaCheckSql(
      transcriptGaps,
      'transcript_gaps_provider_identifiers_valid',
    );
    expect(gapProviderIds).toContain(
      'char_length("app"."transcript_gaps"."provider") between 1 and 100',
    );
  });

  it('binds contradictions to an agent workflow and participant jobs to final segments', () => {
    expect(uniqueColumns(agentRuns, 'agent_runs_workflow_scope_unique')).toEqual([
      'interview_id',
      'workflow_run_id',
      'id',
    ]);
    expect(foreignKeyShape(contradictions, 'contradictions_workflow_agent_fk')).toEqual({
      columns: ['interview_id', 'workflow_run_id', 'agent_run_id'],
      foreignTable: 'agent_runs',
      foreignColumns: ['interview_id', 'workflow_run_id', 'id'],
    });
    expect(uniqueColumns(transcriptFinalSegments, 'transcript_final_segments_turn_unique')).toEqual(
      ['interview_id', 'turn_id'],
    );
    expect(foreignKeyShape(transcriptFinalSegments, 'transcript_final_segments_turn_fk')).toEqual({
      columns: ['interview_id', 'turn_id', 'provider'],
      foreignTable: 'transcript_turns',
      foreignColumns: ['interview_id', 'turn_id', 'source_provider'],
    });
    expect(foreignKeyShape(durableJobs, 'durable_jobs_source_final_segment_fk')).toEqual({
      columns: ['interview_id', 'source_turn_id'],
      foreignTable: 'transcript_final_segments',
      foreignColumns: ['interview_id', 'turn_id'],
    });
  });

  it('binds each attributed workflow step to one exact agent run', () => {
    expect(foreignKeyShape(workflowStepRuns, 'workflow_step_runs_agent_fk')).toEqual({
      columns: ['interview_id', 'workflow_run_id', 'agent_run_id'],
      foreignTable: 'agent_runs',
      foreignColumns: ['interview_id', 'workflow_run_id', 'id'],
    });
    const attribution = schemaCheckSql(workflowStepRuns, 'workflow_step_runs_agent_shape');
    expect(attribution).toContain('"agent_run_id" is not null');
    expect(attribution).toContain('"output" is not null');
    expect(attribution).toContain('"agent_run_id" is null');
  });

  it('scopes final STT and gap identities by provider and preserves finalization timing', () => {
    expect(primaryKeyColumns(transcriptFinalSegments, 'transcript_final_segments_pk')).toEqual([
      'interview_id',
      'provider',
      'provider_event_id',
    ]);
    expect(
      uniqueColumns(transcriptFinalSegments, 'transcript_final_segments_segment_unique'),
    ).toEqual(['interview_id', 'provider', 'segment_id']);
    expect(
      uniqueColumns(transcriptFinalSegments, 'transcript_final_segments_utterance_unique'),
    ).toEqual(['interview_id', 'provider', 'utterance_id']);
    expect(indexColumns(transcriptGaps, 'transcript_gaps_stt_source_event_unique')).toEqual([
      'interview_id',
      'provider',
      'source_event_id',
    ]);
    expect(indexColumns(transcriptGaps, 'transcript_gaps_non_stt_source_event_unique')).toEqual([
      'interview_id',
      'source_event_id',
    ]);
    expect(indexColumns(transcriptGaps, 'transcript_gaps_stt_utterance_unique')).toEqual([
      'interview_id',
      'provider',
      'related_utterance_id',
    ]);
    expect(schemaCheckSql(transcriptGaps, 'transcript_gaps_provider_shape')).toContain(
      '"related_utterance_id" is not null',
    );

    expect(requiredColumnNames(transcriptFinalSegments)).toEqual(
      expect.arrayContaining(['utterance_id', 'observed_at', 'finalized_at']),
    );
    expect(
      schemaCheckSql(transcriptFinalSegments, 'transcript_final_segments_time_order'),
    ).toContain('"finalized_at" >= "app"."transcript_final_segments"."observed_at"');
  });
});

describe('app persistence migrations', () => {
  it('migrates historical rows to German and records bilingual schema version 14', () => {
    for (const column of ['"source_language"', '"language"']) {
      expect(bilingualInterviewLanguageSql).toContain(
        `ADD COLUMN ${column} text NOT NULL DEFAULT 'de'`,
      );
    }
    expect(bilingualInterviewLanguageSql).toContain(
      'ADD CONSTRAINT "interviews_guide_language_fk"',
    );
    expect(bilingualInterviewLanguageSql).toContain('FOREIGN KEY ("guide_id", "language")');
    expect(bilingualInterviewLanguageSql).toContain(
      'REFERENCES "app"."guides"("id", "source_language")',
    );
    expect(bilingualInterviewLanguageSql).toContain(
      'ADD CONSTRAINT "evaluation_runs_language_valid"',
    );
    expect(bilingualInterviewLanguageSql).toContain('\'language\', "language"');
    expect(bilingualInterviewLanguageSql).toContain(
      'DROP CONSTRAINT "evaluation_runs_completed_report_scope"',
    );
    expect(bilingualInterviewLanguageSql).toContain("VALUES ('application', 14, now())");
  });

  it('creates the complete application schema and records its version', () => {
    expect(initialMigrationSql).toContain('CREATE SCHEMA "app";');
    for (const table of REQUIRED_TABLES) {
      expect(initialMigrationSql).toContain(`CREATE TABLE "app"."${table}"`);
    }
    expect(initialMigrationSql).toContain(
      'INSERT INTO "app"."schema_metadata" ("component", "version", "applied_at")',
    );
    expect(initialMigrationSql).toContain("VALUES ('application', 1, now())");
    expect(initialMigrationSql).toContain('ON CONFLICT ("component") DO UPDATE');
    expect(transcriptMutationFenceSql).toContain(
      'INSERT INTO "app"."schema_metadata" ("component", "version", "applied_at")',
    );
    expect(transcriptMutationFenceSql).toContain("VALUES ('application', 2, now())");
    expect(transcriptMutationFenceSql).toContain('ON CONFLICT ("component") DO UPDATE');
    expect(aiDeliveryContractsSql).toContain("VALUES ('application', 3, now())");
    expect(aiDeliveryContractsSql).toContain('ON CONFLICT ("component") DO UPDATE');
    expect(unicodeTranscriptContractsSql).toContain("VALUES ('application', 4, now())");
    expect(unicodeTranscriptContractsSql).toContain('ON CONFLICT ("component") DO UPDATE');
    expect(canonicalTranscriptContractsSql).toContain("VALUES ('application', 5, now())");
    expect(canonicalTranscriptContractsSql).toContain('ON CONFLICT ("component") DO UPDATE');
    expect(interviewStateSummaryPaginationSql).toContain("VALUES ('application', 6, now())");
    expect(interviewStateSummaryPaginationSql).toContain('ON CONFLICT ("component") DO UPDATE');
    expect(interviewStateSummaryPaginationSql).toContain(
      'CREATE INDEX "interview_state_summary_pagination_idx" ON "app"."interview_state" USING btree ("created_at" DESC NULLS LAST,"interview_id" DESC NULLS LAST)',
    );
    expect(eventOutboxNotificationsSql).toContain(
      'CREATE TRIGGER "event_outbox_notify_after_insert"',
    );
    expect(eventOutboxNotificationsSql).toContain(
      'PERFORM pg_notify(\'orgscience_event_outbox\', NEW."interview_id")',
    );
    expect(eventOutboxNotificationsSql).toContain('AFTER INSERT ON "app"."event_outbox"');
    expect(eventOutboxNotificationsSql).toContain("VALUES ('application', 7, now())");
    expect(eventOutboxNotificationsSql).toContain('ON CONFLICT ("component") DO UPDATE');
    expect(workflowStepAgentBindingSql).toContain('WITH "candidate_agent_runs" AS');
    expect(workflowStepAgentBindingSql).toContain('"candidate"."candidate_count" = 1');
    expect(workflowStepAgentBindingSql).toContain("USING ERRCODE = '23514'");
    expect(workflowStepAgentBindingSql).toContain('ADD CONSTRAINT "workflow_step_runs_agent_fk"');
    expect(workflowStepAgentBindingSql).toContain("VALUES ('application', 8, now())");
    expect(canonicalTranscriptContractsSql).toContain(
      'ADD CONSTRAINT "transcript_turns_text_valid"',
    );
    expect(canonicalTranscriptContractsSql).toContain(
      'ADD CONSTRAINT "transcript_gaps_description_valid"',
    );
    expect(canonicalTranscriptContractsSql).not.toMatch(/\bcreate\s+table\b/iu);
  });

  it('uses locked per-interview counters rather than database sequences', () => {
    const counters = tableDefinition('interview_counters');

    expect(counters).toContain('"next_transcript_sequence" integer DEFAULT 1 NOT NULL');
    expect(counters).toContain('"next_event_sequence" integer DEFAULT 1 NOT NULL');
    expect(transcriptMutationFenceSql).toContain(
      'ADD COLUMN "transcript_mutation_version" integer DEFAULT 0 NOT NULL',
    );
    expect(transcriptMutationFenceSql).toContain(
      'ADD CONSTRAINT "interview_counters_transcript_mutation_nonnegative" CHECK ("app"."interview_counters"."transcript_mutation_version" >= 0)',
    );
    expect(transcriptMutationFenceSql).toContain(
      'ADD COLUMN "initial_delay_ms" integer DEFAULT 0 NOT NULL',
    );
    expect(transcriptMutationFenceSql).toContain(
      'ADD CONSTRAINT "durable_jobs_initial_delay_valid" CHECK ("app"."durable_jobs"."initial_delay_ms" >= 0 AND "app"."durable_jobs"."initial_delay_ms" <= 900000)',
    );
    expect(transcriptMutationFenceSql).not.toMatch(/\bdrop\b/iu);
    expect(transcriptMutationFenceSql).not.toMatch(/\bcreate\s+table\b/iu);
    expect(migrationSql).not.toMatch(/\bcreate\s+sequence\b/iu);
    expect(migrationSql).not.toMatch(/\bserial\b/iu);
    expect(migrationSql).not.toMatch(/generated\s+(?:always|by default)\s+as\s+identity/iu);
    expect(migrationSql).not.toContain('nextval(');
  });

  it('enforces interview and guide isolation through composite foreign keys', () => {
    expectNamedConstraints([
      'guide_questions_section_fk',
      'guide_questions_main_question_fk',
      'interview_state_interview_fk',
      'question_coverage_interview_fk',
      'question_coverage_question_fk',
      'coverage_turn_references_turn_fk',
      'transcript_turns_entry_fk',
      'transcript_turns_delivery_fk',
      'transcript_final_segments_turn_fk',
      'durable_jobs_source_final_segment_fk',
      'contradictions_workflow_agent_fk',
      'contradiction_turn_references_turn_fk',
    ]);
    expect(migrationSql).toContain(
      'FOREIGN KEY ("interview_id","guide_id") REFERENCES "app"."interviews"("id","guide_id")',
    );
    expect(migrationSql).toContain(
      'FOREIGN KEY ("guide_id","question_id") REFERENCES "app"."guide_questions"("guide_id","id")',
    );
    expect(migrationSql).toContain(
      'FOREIGN KEY ("interview_id","source_turn_id") REFERENCES "app"."transcript_final_segments"("interview_id","turn_id")',
    );
    expect(migrationSql).toContain(
      'FOREIGN KEY ("interview_id","workflow_run_id","agent_run_id") REFERENCES "app"."agent_runs"("interview_id","workflow_run_id","id")',
    );
  });

  it('guards active work, current coverage, positions, and accepted workflow results', () => {
    expectNamedIndexes([
      'guide_questions_main_position_unique',
      'guide_questions_follow_up_position_unique',
      'interview_state_summary_pagination_idx',
      'question_coverage_one_current_per_interview',
      'durable_jobs_one_active_per_interview',
      'workflow_runs_one_applied_per_job',
      'transcript_gaps_stt_source_event_unique',
      'transcript_gaps_non_stt_source_event_unique',
    ]);
    expect(migrationSql).toContain(
      'WHERE "app"."durable_jobs"."status" in (\'queued\', \'running\')',
    );
    expect(migrationSql).toContain('WHERE "app"."question_coverage"."status" = \'current\'');
  });

  it('requires fenced job leases and records the applied state version', () => {
    const jobs = tableDefinition('durable_jobs');

    expect(jobs).toContain('"lease_token" text');
    expect(jobs).toContain('"applied_state_version" integer');
    expect(jobs).toContain('"last_error_retryable" boolean');
    expect(jobs).toContain('"last_error_occurred_at" timestamp(3) with time zone');
    expect(jobs).toContain('CONSTRAINT "durable_jobs_lease_token_unique" UNIQUE("lease_token")');
    expect(jobs).toContain('CONSTRAINT "durable_jobs_lease_shape" CHECK');
    expect(jobs).toContain('CONSTRAINT "durable_jobs_initial_lease_token_null" CHECK');
    expect(jobs).toContain('CONSTRAINT "durable_jobs_applied_version_shape" CHECK');
    expect(jobs).toContain('CONSTRAINT "durable_jobs_last_error_shape" CHECK');
  });

  it('keeps canonical text relational and limits JSONB to validated flexible records', () => {
    for (const table of [
      'interview_state',
      'question_coverage',
      'transcript_entries',
      'transcript_turns',
      'transcript_gaps',
    ]) {
      expect(tableDefinition(table)).not.toContain('jsonb');
    }

    expect(tableDefinition('workflow_step_runs')).toContain('"input" jsonb');
    expect(tableDefinition('agent_runs')).toContain('"output" jsonb');
    expect(tableDefinition('event_outbox')).toContain('"payload" jsonb NOT NULL');
    expect(migrationSql).toContain('CONSTRAINT "event_outbox_payload_object" CHECK');
    expect(migrationSql).toContain('CONSTRAINT "agent_runs_json_objects" CHECK');
  });

  it('constrains immutable transcript and run identities at the database boundary', () => {
    expectNamedConstraints([
      'transcript_entries_pk',
      'transcript_entries_id_unique',
      'transcript_final_segments_pk',
      'transcript_final_segments_turn_unique',
      'ai_turn_deliveries_sequence_unique',
      'ai_turn_deliveries_turn_unique',
      'ai_turn_deliveries_time_order',
      'command_receipts_pk',
      'durable_jobs_idempotency_unique',
      'workflow_runs_job_attempt_unique',
      'agent_runs_workflow_scope_unique',
      'event_outbox_interview_sequence_unique',
      'workflow_step_runs_timing_valid',
      'workflow_step_runs_error_shape',
      'agent_runs_timing_valid',
      'agent_runs_error_shape',
    ]);
    expect(tableDefinition('workflow_runs')).toContain('"error_retryable" boolean');
    expect(tableDefinition('workflow_step_runs')).toContain('"error_retryable" boolean');
    expect(tableDefinition('agent_runs')).toContain('"error_retryable" boolean');
  });

  it('materializes provider-scoped transcript identities and timestamp ordering', () => {
    const finalSegments = tableDefinition('transcript_final_segments');
    const lifecycle = tableDefinition('interview_state');

    expect(finalSegments).toContain('"utterance_id" text NOT NULL');
    expect(finalSegments).toContain('"observed_at" timestamp(3) with time zone NOT NULL');
    expect(finalSegments).toContain('"finalized_at" timestamp(3) with time zone NOT NULL');
    expect(finalSegments).toContain(
      'CONSTRAINT "transcript_final_segments_pk" PRIMARY KEY("interview_id","provider","provider_event_id")',
    );
    expect(finalSegments).toContain(
      'CONSTRAINT "transcript_final_segments_segment_unique" UNIQUE("interview_id","provider","segment_id")',
    );
    expect(finalSegments).toContain(
      'CONSTRAINT "transcript_final_segments_utterance_unique" UNIQUE("interview_id","provider","utterance_id")',
    );
    expect(finalSegments).toContain(
      'CONSTRAINT "transcript_final_segments_time_order" CHECK ("app"."transcript_final_segments"."finalized_at" >= "app"."transcript_final_segments"."observed_at")',
    );
    expect(migrationSql).toContain(
      'CREATE UNIQUE INDEX "transcript_gaps_stt_source_event_unique" ON "app"."transcript_gaps" USING btree ("interview_id","provider","source_event_id") WHERE "app"."transcript_gaps"."source" = \'speech_to_text\'',
    );
    expect(migrationSql).toContain(
      'CREATE UNIQUE INDEX "transcript_gaps_non_stt_source_event_unique" ON "app"."transcript_gaps" USING btree ("interview_id","source_event_id") WHERE "app"."transcript_gaps"."source" <> \'speech_to_text\'',
    );
    expect(migrationSql).toContain(
      'CREATE UNIQUE INDEX "transcript_gaps_stt_utterance_unique" ON "app"."transcript_gaps" USING btree ("interview_id","provider","related_utterance_id") WHERE "app"."transcript_gaps"."source" = \'speech_to_text\'',
    );
    expect(tableDefinition('transcript_gaps')).toContain('"related_utterance_id" text');

    for (const lifecycleTimestamp of [
      'active_since',
      'paused_at',
      'ending_at',
      'ended_at',
      'failed_at',
    ]) {
      expect(lifecycle).toContain(
        `"app"."interview_state"."updated_at" >= "app"."interview_state"."${lifecycleTimestamp}"`,
      );
    }
  });
});

function tableDefinition(table: string): string {
  const match = new RegExp(`CREATE TABLE "app"\\."${table}" \\(([\\s\\S]*?)\\n\\);`, 'u').exec(
    migrationSql,
  );
  if (match?.[1] === undefined) {
    throw new Error(`Migration does not define app.${table}`);
  }
  return match[1];
}

function expectNamedConstraints(names: readonly string[]): void {
  for (const name of names) {
    expect(migrationSql).toContain(`CONSTRAINT "${name}"`);
  }
}

function expectNamedIndexes(names: readonly string[]): void {
  for (const name of names) {
    expect(migrationSql).toContain(`INDEX "${name}"`);
  }
}

function schemaCheckSql(table: PgTable, name: string): string {
  const constraint = getTableConfig(table).checks.find((candidate) => candidate.name === name);
  if (constraint === undefined) throw new Error(`Schema does not define check ${name}`);
  return new PgDialect().sqlToQuery(constraint.value).sql.replace(/\s+/gu, ' ').trim();
}

function uniqueColumns(table: PgTable, name: string): readonly string[] {
  const constraint = getTableConfig(table).uniqueConstraints.find(
    (candidate) => candidate.getName() === name,
  );
  if (constraint === undefined) throw new Error(`Schema does not define unique constraint ${name}`);
  return constraint.columns.map((column) => column.name);
}

function primaryKeyColumns(table: PgTable, name: string): readonly string[] {
  const constraint = getTableConfig(table).primaryKeys.find(
    (candidate) => candidate.getName() === name,
  );
  if (constraint === undefined) throw new Error(`Schema does not define primary key ${name}`);
  return constraint.columns.map((column) => column.name);
}

function indexColumns(table: PgTable, name: string): readonly string[] {
  const index = getTableConfig(table).indexes.find((candidate) => candidate.config.name === name);
  if (index === undefined) throw new Error(`Schema does not define index ${name}`);
  return index.config.columns.map((column) => {
    if (!('name' in column) || typeof column.name !== 'string') {
      throw new Error(`Index ${name} contains a non-column expression`);
    }
    return column.name;
  });
}

function requiredColumnNames(table: PgTable): readonly string[] {
  return getTableConfig(table)
    .columns.filter((column) => column.notNull)
    .map((column) => column.name);
}

function foreignKeyShape(
  table: PgTable,
  name: string,
): {
  readonly columns: readonly string[];
  readonly foreignTable: string;
  readonly foreignColumns: readonly string[];
} {
  const constraint = getTableConfig(table).foreignKeys.find(
    (candidate) => candidate.getName() === name,
  );
  if (constraint === undefined) throw new Error(`Schema does not define foreign key ${name}`);
  const reference = constraint.reference();
  return {
    columns: reference.columns.map((column) => column.name),
    foreignTable: getTableConfig(reference.foreignTable).name,
    foreignColumns: reference.foreignColumns.map((column) => column.name),
  };
}
