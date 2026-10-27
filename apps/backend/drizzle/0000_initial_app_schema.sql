CREATE SCHEMA "app";
--> statement-breakpoint
CREATE TABLE "app"."agent_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"interview_id" text NOT NULL,
	"workflow_run_id" text NOT NULL,
	"agent_name" text NOT NULL,
	"invocation_number" integer DEFAULT 1 NOT NULL,
	"status" text NOT NULL,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"model_mode" text NOT NULL,
	"model_provider" text,
	"model_name" text,
	"started_at" timestamp(3) with time zone,
	"ended_at" timestamp(3) with time zone,
	"duration_ms" integer,
	"error_code" text,
	"error_message" text,
	"error_retryable" boolean,
	"input" jsonb NOT NULL,
	"output" jsonb,
	CONSTRAINT "agent_runs_interview_id_unique" UNIQUE("interview_id","id"),
	CONSTRAINT "agent_runs_workflow_scope_unique" UNIQUE("interview_id","workflow_run_id","id"),
	CONSTRAINT "agent_runs_invocation_unique" UNIQUE("workflow_run_id","agent_name","invocation_number"),
	CONSTRAINT "agent_runs_name_valid" CHECK ("app"."agent_runs"."agent_name" in ('coverage_analysis', 'consistency_analysis', 'interview_decision', 'interview_conductor', 'transcript_finalization')),
	CONSTRAINT "agent_runs_status_valid" CHECK ("app"."agent_runs"."status" in ('waiting', 'running', 'succeeded', 'failed', 'retrying', 'skipped')),
	CONSTRAINT "agent_runs_numbers_valid" CHECK ("app"."agent_runs"."invocation_number" > 0 and "app"."agent_runs"."retry_count" >= 0),
	CONSTRAINT "agent_runs_timing_valid" CHECK (
        ("app"."agent_runs"."status" = 'waiting' and "app"."agent_runs"."started_at" is null and "app"."agent_runs"."ended_at" is null and "app"."agent_runs"."duration_ms" is null)
        or ("app"."agent_runs"."status" in ('running', 'retrying') and "app"."agent_runs"."started_at" is not null and "app"."agent_runs"."ended_at" is null and "app"."agent_runs"."duration_ms" is null)
        or ("app"."agent_runs"."status" in ('succeeded', 'failed', 'skipped') and "app"."agent_runs"."started_at" is not null and "app"."agent_runs"."ended_at" is not null and "app"."agent_runs"."ended_at" >= "app"."agent_runs"."started_at" and "app"."agent_runs"."duration_ms" is not null and "app"."agent_runs"."duration_ms" >= 0)
      ),
	CONSTRAINT "agent_runs_error_shape" CHECK (("app"."agent_runs"."status" = 'failed' and "app"."agent_runs"."error_code" is not null and "app"."agent_runs"."error_message" is not null and "app"."agent_runs"."error_retryable" is not null) or ("app"."agent_runs"."status" <> 'failed' and "app"."agent_runs"."error_code" is null and "app"."agent_runs"."error_message" is null and "app"."agent_runs"."error_retryable" is null)),
	CONSTRAINT "agent_runs_output_shape" CHECK (("app"."agent_runs"."status" = 'succeeded' and "app"."agent_runs"."output" is not null) or ("app"."agent_runs"."status" <> 'succeeded')),
	CONSTRAINT "agent_runs_model_valid" CHECK (("app"."agent_runs"."model_mode" = 'demo' and "app"."agent_runs"."model_provider" is null and "app"."agent_runs"."model_name" is null) or ("app"."agent_runs"."model_mode" = 'provider' and "app"."agent_runs"."model_provider" is not null and "app"."agent_runs"."model_name" is not null)),
	CONSTRAINT "agent_runs_json_objects" CHECK (jsonb_typeof("app"."agent_runs"."input") = 'object' and ("app"."agent_runs"."output" is null or jsonb_typeof("app"."agent_runs"."output") = 'object'))
);
--> statement-breakpoint
CREATE TABLE "app"."ai_turn_deliveries" (
	"id" text NOT NULL,
	"interview_id" text NOT NULL,
	"job_id" text NOT NULL,
	"workflow_run_id" text NOT NULL,
	"turn_id" text NOT NULL,
	"utterance_id" text NOT NULL,
	"reserved_sequence_number" integer NOT NULL,
	"turn_type" text NOT NULL,
	"guide_id" text,
	"question_id" text,
	"proposed_text" text NOT NULL,
	"status" text NOT NULL,
	"provider" text,
	"provider_delivery_event_id" text,
	"confirmed_spoken_text" text,
	"created_at" timestamp(3) with time zone NOT NULL,
	"resolved_at" timestamp(3) with time zone,
	"interrupted_at" timestamp(3) with time zone,
	CONSTRAINT "ai_turn_deliveries_pk" PRIMARY KEY("interview_id","id"),
	CONSTRAINT "ai_turn_deliveries_turn_scope_unique" UNIQUE("interview_id","id","turn_id"),
	CONSTRAINT "ai_turn_deliveries_sequence_unique" UNIQUE("interview_id","reserved_sequence_number"),
	CONSTRAINT "ai_turn_deliveries_turn_unique" UNIQUE("interview_id","turn_id"),
	CONSTRAINT "ai_turn_deliveries_utterance_unique" UNIQUE("interview_id","utterance_id"),
	CONSTRAINT "ai_turn_deliveries_sequence_positive" CHECK ("app"."ai_turn_deliveries"."reserved_sequence_number" > 0),
	CONSTRAINT "ai_turn_deliveries_text_not_blank" CHECK (btrim("app"."ai_turn_deliveries"."proposed_text") <> ''),
	CONSTRAINT "ai_turn_deliveries_turn_type_valid" CHECK ("app"."ai_turn_deliveries"."turn_type" in ('greeting', 'main_question', 'follow_up_question', 'clarification_question', 'transition', 'closing')),
	CONSTRAINT "ai_turn_deliveries_guide_reference_shape" CHECK (
        ("app"."ai_turn_deliveries"."turn_type" in ('greeting', 'closing') and "app"."ai_turn_deliveries"."guide_id" is null and "app"."ai_turn_deliveries"."question_id" is null)
        or ("app"."ai_turn_deliveries"."turn_type" in ('main_question', 'follow_up_question', 'clarification_question') and "app"."ai_turn_deliveries"."guide_id" is not null and "app"."ai_turn_deliveries"."question_id" is not null)
        or ("app"."ai_turn_deliveries"."turn_type" = 'transition' and (("app"."ai_turn_deliveries"."guide_id" is null and "app"."ai_turn_deliveries"."question_id" is null) or ("app"."ai_turn_deliveries"."guide_id" is not null and "app"."ai_turn_deliveries"."question_id" is not null)))
      ),
	CONSTRAINT "ai_turn_deliveries_resolution_shape" CHECK (
        ("app"."ai_turn_deliveries"."status" = 'pending' and "app"."ai_turn_deliveries"."provider" is null and "app"."ai_turn_deliveries"."provider_delivery_event_id" is null and "app"."ai_turn_deliveries"."confirmed_spoken_text" is null and "app"."ai_turn_deliveries"."resolved_at" is null and "app"."ai_turn_deliveries"."interrupted_at" is null)
        or ("app"."ai_turn_deliveries"."status" = 'complete' and "app"."ai_turn_deliveries"."provider" is not null and btrim("app"."ai_turn_deliveries"."provider") <> '' and "app"."ai_turn_deliveries"."provider_delivery_event_id" is not null and btrim("app"."ai_turn_deliveries"."provider_delivery_event_id") <> '' and "app"."ai_turn_deliveries"."confirmed_spoken_text" is not null and btrim("app"."ai_turn_deliveries"."confirmed_spoken_text") <> '' and "app"."ai_turn_deliveries"."resolved_at" is not null and "app"."ai_turn_deliveries"."interrupted_at" is null)
        or ("app"."ai_turn_deliveries"."status" = 'interrupted' and "app"."ai_turn_deliveries"."provider" is not null and btrim("app"."ai_turn_deliveries"."provider") <> '' and "app"."ai_turn_deliveries"."provider_delivery_event_id" is not null and btrim("app"."ai_turn_deliveries"."provider_delivery_event_id") <> '' and "app"."ai_turn_deliveries"."confirmed_spoken_text" is not null and "app"."ai_turn_deliveries"."resolved_at" is not null and "app"."ai_turn_deliveries"."interrupted_at" is not null)
        or ("app"."ai_turn_deliveries"."status" in ('gapped', 'cancelled') and "app"."ai_turn_deliveries"."provider" is null and "app"."ai_turn_deliveries"."provider_delivery_event_id" is null and "app"."ai_turn_deliveries"."confirmed_spoken_text" is null and "app"."ai_turn_deliveries"."resolved_at" is not null and "app"."ai_turn_deliveries"."interrupted_at" is null)
      ),
	CONSTRAINT "ai_turn_deliveries_time_order" CHECK (("app"."ai_turn_deliveries"."resolved_at" is null or "app"."ai_turn_deliveries"."resolved_at" >= "app"."ai_turn_deliveries"."created_at") and ("app"."ai_turn_deliveries"."interrupted_at" is null or ("app"."ai_turn_deliveries"."interrupted_at" >= "app"."ai_turn_deliveries"."created_at" and "app"."ai_turn_deliveries"."resolved_at" is not null and "app"."ai_turn_deliveries"."interrupted_at" <= "app"."ai_turn_deliveries"."resolved_at"))),
	CONSTRAINT "ai_turn_deliveries_confirmed_prefix" CHECK ("app"."ai_turn_deliveries"."confirmed_spoken_text" is null or left("app"."ai_turn_deliveries"."proposed_text", char_length("app"."ai_turn_deliveries"."confirmed_spoken_text")) = "app"."ai_turn_deliveries"."confirmed_spoken_text")
);
--> statement-breakpoint
CREATE TABLE "app"."command_receipts" (
	"interview_id" text NOT NULL,
	"command_type" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_fingerprint" text NOT NULL,
	"result_resource_id" text,
	"result_state_version" integer,
	"created_at" timestamp(3) with time zone NOT NULL,
	CONSTRAINT "command_receipts_pk" PRIMARY KEY("interview_id","command_type","idempotency_key"),
	CONSTRAINT "command_receipts_type_not_blank" CHECK (btrim("app"."command_receipts"."command_type") <> ''),
	CONSTRAINT "command_receipts_key_not_blank" CHECK (btrim("app"."command_receipts"."idempotency_key") <> ''),
	CONSTRAINT "command_receipts_fingerprint_sha256" CHECK ("app"."command_receipts"."request_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "command_receipts_result_version_nonnegative" CHECK ("app"."command_receipts"."result_state_version" is null or "app"."command_receipts"."result_state_version" >= 0)
);
--> statement-breakpoint
CREATE TABLE "app"."contradiction_turn_references" (
	"interview_id" text NOT NULL,
	"contradiction_id" text NOT NULL,
	"turn_id" text NOT NULL,
	CONSTRAINT "contradiction_turn_references_pk" PRIMARY KEY("interview_id","contradiction_id","turn_id")
);
--> statement-breakpoint
CREATE TABLE "app"."contradictions" (
	"interview_id" text NOT NULL,
	"id" text NOT NULL,
	"workflow_run_id" text NOT NULL,
	"agent_run_id" text NOT NULL,
	"description" text NOT NULL,
	"suggested_clarification_question" text NOT NULL,
	"should_clarify" boolean NOT NULL,
	"rationale" text NOT NULL,
	"status" text NOT NULL,
	"asked_turn_id" text,
	"created_at" timestamp(3) with time zone NOT NULL,
	"updated_at" timestamp(3) with time zone NOT NULL,
	CONSTRAINT "contradictions_pk" PRIMARY KEY("interview_id","id"),
	CONSTRAINT "contradictions_status_valid" CHECK ("app"."contradictions"."status" in ('detected', 'asked', 'dismissed', 'resolved')),
	CONSTRAINT "contradictions_description_not_blank" CHECK (btrim("app"."contradictions"."description") <> ''),
	CONSTRAINT "contradictions_clarification_single_question" CHECK (right(btrim("app"."contradictions"."suggested_clarification_question"), 1) = '?' and length("app"."contradictions"."suggested_clarification_question") - length(replace("app"."contradictions"."suggested_clarification_question", '?', '')) = 1),
	CONSTRAINT "contradictions_asked_turn_shape" CHECK (("app"."contradictions"."status" = 'asked' and "app"."contradictions"."asked_turn_id" is not null) or ("app"."contradictions"."status" <> 'asked')),
	CONSTRAINT "contradictions_time_order" CHECK ("app"."contradictions"."updated_at" >= "app"."contradictions"."created_at")
);
--> statement-breakpoint
CREATE TABLE "app"."coverage_turn_references" (
	"interview_id" text NOT NULL,
	"question_id" text NOT NULL,
	"turn_id" text NOT NULL,
	CONSTRAINT "coverage_turn_references_pk" PRIMARY KEY("interview_id","question_id","turn_id")
);
--> statement-breakpoint
CREATE TABLE "app"."durable_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"interview_id" text NOT NULL,
	"type" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"source_turn_id" text,
	"expected_state_version" integer NOT NULL,
	"status" text NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"maximum_attempts" integer DEFAULT 3 NOT NULL,
	"available_at" timestamp(3) with time zone NOT NULL,
	"lease_owner" text,
	"lease_token" text,
	"lease_expires_at" timestamp(3) with time zone,
	"last_error_code" text,
	"last_error_message" text,
	"last_error_retryable" boolean,
	"last_error_occurred_at" timestamp(3) with time zone,
	"cancellation_reason" text,
	"result_delivery_id" text,
	"applied_state_version" integer,
	"created_at" timestamp(3) with time zone NOT NULL,
	"updated_at" timestamp(3) with time zone NOT NULL,
	"completed_at" timestamp(3) with time zone,
	CONSTRAINT "durable_jobs_interview_id_unique" UNIQUE("interview_id","id"),
	CONSTRAINT "durable_jobs_idempotency_unique" UNIQUE("interview_id","idempotency_key"),
	CONSTRAINT "durable_jobs_lease_token_unique" UNIQUE("lease_token"),
	CONSTRAINT "durable_jobs_type_valid" CHECK ("app"."durable_jobs"."type" in ('start_interview', 'participant_turn', 'finish_interview')),
	CONSTRAINT "durable_jobs_source_shape" CHECK (("app"."durable_jobs"."type" = 'participant_turn' and "app"."durable_jobs"."source_turn_id" is not null) or ("app"."durable_jobs"."type" in ('start_interview', 'finish_interview') and "app"."durable_jobs"."source_turn_id" is null)),
	CONSTRAINT "durable_jobs_status_valid" CHECK ("app"."durable_jobs"."status" in ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
	CONSTRAINT "durable_jobs_attempts_valid" CHECK ("app"."durable_jobs"."attempt_count" >= 0 and "app"."durable_jobs"."maximum_attempts" > 0 and "app"."durable_jobs"."attempt_count" <= "app"."durable_jobs"."maximum_attempts"),
	CONSTRAINT "durable_jobs_expected_version_nonnegative" CHECK ("app"."durable_jobs"."expected_state_version" >= 0),
	CONSTRAINT "durable_jobs_lease_shape" CHECK (("app"."durable_jobs"."status" = 'running' and "app"."durable_jobs"."lease_owner" is not null and "app"."durable_jobs"."lease_token" is not null and "app"."durable_jobs"."lease_expires_at" is not null) or ("app"."durable_jobs"."status" <> 'running' and "app"."durable_jobs"."lease_owner" is null and "app"."durable_jobs"."lease_expires_at" is null)),
	CONSTRAINT "durable_jobs_initial_lease_token_null" CHECK ("app"."durable_jobs"."status" <> 'queued' or "app"."durable_jobs"."attempt_count" > 0 or "app"."durable_jobs"."lease_token" is null),
	CONSTRAINT "durable_jobs_terminal_shape" CHECK (("app"."durable_jobs"."status" in ('queued', 'running') and "app"."durable_jobs"."completed_at" is null) or ("app"."durable_jobs"."status" in ('succeeded', 'failed', 'cancelled') and "app"."durable_jobs"."completed_at" is not null)),
	CONSTRAINT "durable_jobs_cancellation_shape" CHECK (("app"."durable_jobs"."status" = 'cancelled' and "app"."durable_jobs"."cancellation_reason" is not null) or ("app"."durable_jobs"."status" <> 'cancelled' and "app"."durable_jobs"."cancellation_reason" is null)),
	CONSTRAINT "durable_jobs_applied_version_shape" CHECK (("app"."durable_jobs"."status" = 'succeeded' and "app"."durable_jobs"."applied_state_version" is not null and "app"."durable_jobs"."applied_state_version" >= 0) or ("app"."durable_jobs"."status" <> 'succeeded' and "app"."durable_jobs"."applied_state_version" is null)),
	CONSTRAINT "durable_jobs_last_error_shape" CHECK (("app"."durable_jobs"."last_error_code" is null and "app"."durable_jobs"."last_error_message" is null and "app"."durable_jobs"."last_error_retryable" is null and "app"."durable_jobs"."last_error_occurred_at" is null) or ("app"."durable_jobs"."last_error_code" is not null and "app"."durable_jobs"."last_error_message" is not null and "app"."durable_jobs"."last_error_retryable" is not null and "app"."durable_jobs"."last_error_occurred_at" is not null)),
	CONSTRAINT "durable_jobs_time_order" CHECK ("app"."durable_jobs"."updated_at" >= "app"."durable_jobs"."created_at")
);
--> statement-breakpoint
CREATE TABLE "app"."event_outbox" (
	"event_id" text PRIMARY KEY NOT NULL,
	"interview_id" text NOT NULL,
	"run_id" text NOT NULL,
	"sequence_number" integer NOT NULL,
	"category" text NOT NULL,
	"type" text NOT NULL,
	"occurred_at" timestamp(3) with time zone NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_outbox_interview_sequence_unique" UNIQUE("interview_id","sequence_number"),
	CONSTRAINT "event_outbox_sequence_positive" CHECK ("app"."event_outbox"."sequence_number" > 0),
	CONSTRAINT "event_outbox_run_not_blank" CHECK (btrim("app"."event_outbox"."run_id") <> ''),
	CONSTRAINT "event_outbox_category_valid" CHECK ("app"."event_outbox"."category" in ('interview', 'workflow', 'agent', 'transcript', 'voice', 'error', 'retry', 'state_update')),
	CONSTRAINT "event_outbox_type_not_blank" CHECK (btrim("app"."event_outbox"."type") <> ''),
	CONSTRAINT "event_outbox_payload_object" CHECK (jsonb_typeof("app"."event_outbox"."payload") = 'object')
);
--> statement-breakpoint
CREATE TABLE "app"."guide_questions" (
	"guide_id" text NOT NULL,
	"id" text NOT NULL,
	"section_id" text NOT NULL,
	"kind" text NOT NULL,
	"main_question_id" text NOT NULL,
	"position" integer NOT NULL,
	"text" text NOT NULL,
	CONSTRAINT "guide_questions_pk" PRIMARY KEY("guide_id","id"),
	CONSTRAINT "guide_questions_scope_unique" UNIQUE("guide_id","id","section_id"),
	CONSTRAINT "guide_questions_kind_valid" CHECK ("app"."guide_questions"."kind" in ('main_question', 'follow_up_question')),
	CONSTRAINT "guide_questions_hierarchy_valid" CHECK (("app"."guide_questions"."kind" = 'main_question' and "app"."guide_questions"."main_question_id" = "app"."guide_questions"."id") or ("app"."guide_questions"."kind" = 'follow_up_question' and "app"."guide_questions"."main_question_id" <> "app"."guide_questions"."id")),
	CONSTRAINT "guide_questions_position_nonnegative" CHECK ("app"."guide_questions"."position" >= 0),
	CONSTRAINT "guide_questions_text_not_blank" CHECK (btrim("app"."guide_questions"."text") <> '')
);
--> statement-breakpoint
CREATE TABLE "app"."guide_sections" (
	"guide_id" text NOT NULL,
	"id" text NOT NULL,
	"position" integer NOT NULL,
	"title" text NOT NULL,
	CONSTRAINT "guide_sections_pk" PRIMARY KEY("guide_id","id"),
	CONSTRAINT "guide_sections_position_unique" UNIQUE("guide_id","position"),
	CONSTRAINT "guide_sections_id_not_blank" CHECK (btrim("app"."guide_sections"."id") <> ''),
	CONSTRAINT "guide_sections_position_nonnegative" CHECK ("app"."guide_sections"."position" >= 0),
	CONSTRAINT "guide_sections_title_not_blank" CHECK (btrim("app"."guide_sections"."title") <> '')
);
--> statement-breakpoint
CREATE TABLE "app"."guides" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"source_markdown" text NOT NULL,
	"stable_id_version" text NOT NULL,
	"created_at" timestamp(3) with time zone NOT NULL,
	CONSTRAINT "guides_id_not_blank" CHECK (btrim("app"."guides"."id") <> ''),
	CONSTRAINT "guides_title_not_blank" CHECK (btrim("app"."guides"."title") <> ''),
	CONSTRAINT "guides_source_not_blank" CHECK (btrim("app"."guides"."source_markdown") <> ''),
	CONSTRAINT "guides_stable_id_version_v1" CHECK ("app"."guides"."stable_id_version" = 'v1')
);
--> statement-breakpoint
CREATE TABLE "app"."interview_counters" (
	"interview_id" text PRIMARY KEY NOT NULL,
	"next_transcript_sequence" integer DEFAULT 1 NOT NULL,
	"next_event_sequence" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "interview_counters_sequences_positive" CHECK ("app"."interview_counters"."next_transcript_sequence" > 0 and "app"."interview_counters"."next_event_sequence" > 0)
);
--> statement-breakpoint
CREATE TABLE "app"."interview_state" (
	"interview_id" text PRIMARY KEY NOT NULL,
	"guide_id" text NOT NULL,
	"status" text NOT NULL,
	"state_version" integer DEFAULT 0 NOT NULL,
	"coverage_version" integer DEFAULT 0 NOT NULL,
	"current_main_question_id" text,
	"active_workflow_run_id" text,
	"created_at" timestamp(3) with time zone NOT NULL,
	"updated_at" timestamp(3) with time zone NOT NULL,
	"started_at" timestamp(3) with time zone,
	"active_since" timestamp(3) with time zone,
	"paused_at" timestamp(3) with time zone,
	"ending_at" timestamp(3) with time zone,
	"ending_from" text,
	"ended_at" timestamp(3) with time zone,
	"failed_at" timestamp(3) with time zone,
	"failed_from" text,
	"failure_code" text,
	"failure_message" text,
	CONSTRAINT "interview_state_status_valid" CHECK ("app"."interview_state"."status" in ('ready', 'active', 'paused', 'ending', 'completed', 'failed')),
	CONSTRAINT "interview_state_versions_nonnegative" CHECK ("app"."interview_state"."state_version" >= 0 and "app"."interview_state"."coverage_version" >= 0),
	CONSTRAINT "interview_state_time_order" CHECK ("app"."interview_state"."updated_at" >= "app"."interview_state"."created_at"),
	CONSTRAINT "interview_state_lifecycle_shape" CHECK (
        ("app"."interview_state"."status" = 'ready' and "app"."interview_state"."started_at" is null and "app"."interview_state"."active_since" is null and "app"."interview_state"."paused_at" is null and "app"."interview_state"."ending_at" is null and "app"."interview_state"."ending_from" is null and "app"."interview_state"."ended_at" is null and "app"."interview_state"."failed_at" is null and "app"."interview_state"."failed_from" is null and "app"."interview_state"."failure_code" is null and "app"."interview_state"."failure_message" is null)
        or ("app"."interview_state"."status" = 'active' and "app"."interview_state"."started_at" is not null and "app"."interview_state"."active_since" is not null and "app"."interview_state"."paused_at" is null and "app"."interview_state"."ending_at" is null and "app"."interview_state"."ending_from" is null and "app"."interview_state"."ended_at" is null and "app"."interview_state"."failed_at" is null and "app"."interview_state"."failed_from" is null and "app"."interview_state"."failure_code" is null and "app"."interview_state"."failure_message" is null)
        or ("app"."interview_state"."status" = 'paused' and "app"."interview_state"."started_at" is not null and "app"."interview_state"."active_since" is null and "app"."interview_state"."paused_at" is not null and "app"."interview_state"."ending_at" is null and "app"."interview_state"."ending_from" is null and "app"."interview_state"."ended_at" is null and "app"."interview_state"."failed_at" is null and "app"."interview_state"."failed_from" is null and "app"."interview_state"."failure_code" is null and "app"."interview_state"."failure_message" is null)
        or ("app"."interview_state"."status" = 'ending' and "app"."interview_state"."started_at" is not null and "app"."interview_state"."active_since" is null and "app"."interview_state"."paused_at" is null and "app"."interview_state"."ending_at" is not null and "app"."interview_state"."ending_from" is not null and "app"."interview_state"."ending_from" in ('active', 'paused') and "app"."interview_state"."ended_at" is null and "app"."interview_state"."failed_at" is null and "app"."interview_state"."failed_from" is null and "app"."interview_state"."failure_code" is null and "app"."interview_state"."failure_message" is null)
        or ("app"."interview_state"."status" = 'completed' and "app"."interview_state"."started_at" is not null and "app"."interview_state"."active_since" is null and "app"."interview_state"."paused_at" is null and "app"."interview_state"."ending_at" is not null and "app"."interview_state"."ending_from" is null and "app"."interview_state"."ended_at" is not null and "app"."interview_state"."failed_at" is null and "app"."interview_state"."failed_from" is null and "app"."interview_state"."failure_code" is null and "app"."interview_state"."failure_message" is null)
        or ("app"."interview_state"."status" = 'failed' and "app"."interview_state"."active_since" is null and "app"."interview_state"."paused_at" is null and "app"."interview_state"."ending_at" is null and "app"."interview_state"."ending_from" is null and "app"."interview_state"."ended_at" is null and "app"."interview_state"."failed_at" is not null and "app"."interview_state"."failed_from" is not null and "app"."interview_state"."failed_from" in ('ready', 'active', 'paused', 'ending') and "app"."interview_state"."failure_code" is not null and btrim("app"."interview_state"."failure_code") <> '' and "app"."interview_state"."failure_message" is not null and btrim("app"."interview_state"."failure_message") <> '')
      ),
	CONSTRAINT "interview_state_lifecycle_time_order" CHECK (
        ("app"."interview_state"."status" = 'ready')
        or ("app"."interview_state"."status" = 'active' and "app"."interview_state"."started_at" >= "app"."interview_state"."created_at" and "app"."interview_state"."active_since" >= "app"."interview_state"."started_at" and "app"."interview_state"."updated_at" >= "app"."interview_state"."active_since")
        or ("app"."interview_state"."status" = 'paused' and "app"."interview_state"."started_at" >= "app"."interview_state"."created_at" and "app"."interview_state"."paused_at" >= "app"."interview_state"."started_at" and "app"."interview_state"."updated_at" >= "app"."interview_state"."paused_at")
        or ("app"."interview_state"."status" = 'ending' and "app"."interview_state"."started_at" >= "app"."interview_state"."created_at" and "app"."interview_state"."ending_at" >= "app"."interview_state"."started_at" and "app"."interview_state"."updated_at" >= "app"."interview_state"."ending_at")
        or ("app"."interview_state"."status" = 'completed' and "app"."interview_state"."started_at" >= "app"."interview_state"."created_at" and "app"."interview_state"."ending_at" >= "app"."interview_state"."started_at" and "app"."interview_state"."ended_at" >= "app"."interview_state"."ending_at" and "app"."interview_state"."updated_at" >= "app"."interview_state"."ended_at")
        or ("app"."interview_state"."status" = 'failed' and "app"."interview_state"."failed_at" >= "app"."interview_state"."created_at" and "app"."interview_state"."updated_at" >= "app"."interview_state"."failed_at" and (("app"."interview_state"."failed_from" = 'ready' and "app"."interview_state"."started_at" is null) or ("app"."interview_state"."failed_from" <> 'ready' and "app"."interview_state"."started_at" is not null and "app"."interview_state"."started_at" >= "app"."interview_state"."created_at" and "app"."interview_state"."failed_at" >= "app"."interview_state"."started_at")))
      )
);
--> statement-breakpoint
CREATE TABLE "app"."interviews" (
	"id" text PRIMARY KEY NOT NULL,
	"guide_id" text NOT NULL,
	"created_at" timestamp(3) with time zone NOT NULL,
	CONSTRAINT "interviews_id_guide_unique" UNIQUE("id","guide_id"),
	CONSTRAINT "interviews_id_not_blank" CHECK (btrim("app"."interviews"."id") <> '')
);
--> statement-breakpoint
CREATE TABLE "app"."question_coverage" (
	"interview_id" text NOT NULL,
	"guide_id" text NOT NULL,
	"question_id" text NOT NULL,
	"status" text NOT NULL,
	"updated_at" timestamp(3) with time zone,
	CONSTRAINT "question_coverage_pk" PRIMARY KEY("interview_id","question_id"),
	CONSTRAINT "question_coverage_status_valid" CHECK ("app"."question_coverage"."status" in ('not_addressed', 'current', 'partially_answered', 'answered', 'skipped_already_answered'))
);
--> statement-breakpoint
CREATE TABLE "app"."schema_metadata" (
	"component" text PRIMARY KEY NOT NULL,
	"version" integer NOT NULL,
	"applied_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "schema_metadata_component_not_blank" CHECK (btrim("app"."schema_metadata"."component") <> ''),
	CONSTRAINT "schema_metadata_version_positive" CHECK ("app"."schema_metadata"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "app"."transcript_entries" (
	"interview_id" text NOT NULL,
	"sequence_number" integer NOT NULL,
	"entry_id" text NOT NULL,
	"kind" text NOT NULL,
	"occurred_at" timestamp(3) with time zone NOT NULL,
	CONSTRAINT "transcript_entries_pk" PRIMARY KEY("interview_id","sequence_number"),
	CONSTRAINT "transcript_entries_id_unique" UNIQUE("interview_id","entry_id"),
	CONSTRAINT "transcript_entries_subtype_unique" UNIQUE("interview_id","entry_id","kind"),
	CONSTRAINT "transcript_entries_sequence_positive" CHECK ("app"."transcript_entries"."sequence_number" > 0),
	CONSTRAINT "transcript_entries_kind_valid" CHECK ("app"."transcript_entries"."kind" in ('turn', 'technical_gap'))
);
--> statement-breakpoint
CREATE TABLE "app"."transcript_final_segments" (
	"interview_id" text NOT NULL,
	"provider" text NOT NULL,
	"provider_event_id" text NOT NULL,
	"segment_id" text NOT NULL,
	"utterance_id" text NOT NULL,
	"turn_id" text NOT NULL,
	"text" text NOT NULL,
	"observed_at" timestamp(3) with time zone NOT NULL,
	"finalized_at" timestamp(3) with time zone NOT NULL,
	CONSTRAINT "transcript_final_segments_pk" PRIMARY KEY("interview_id","provider","provider_event_id"),
	CONSTRAINT "transcript_final_segments_segment_unique" UNIQUE("interview_id","provider","segment_id"),
	CONSTRAINT "transcript_final_segments_turn_unique" UNIQUE("interview_id","turn_id"),
	CONSTRAINT "transcript_final_segments_utterance_unique" UNIQUE("interview_id","provider","utterance_id"),
	CONSTRAINT "transcript_final_segments_provider_not_blank" CHECK (btrim("app"."transcript_final_segments"."provider") <> ''),
	CONSTRAINT "transcript_final_segments_text_not_blank" CHECK (btrim("app"."transcript_final_segments"."text") <> ''),
	CONSTRAINT "transcript_final_segments_time_order" CHECK ("app"."transcript_final_segments"."finalized_at" >= "app"."transcript_final_segments"."observed_at")
);
--> statement-breakpoint
CREATE TABLE "app"."transcript_finalizations" (
	"interview_id" text PRIMARY KEY NOT NULL,
	"finalization_id" text NOT NULL,
	"state_version" integer NOT NULL,
	"agent_run_id" text NOT NULL,
	"validation_status" text NOT NULL,
	"entry_count" integer NOT NULL,
	"technical_gap_count" integer NOT NULL,
	"deterministic_issues" jsonb NOT NULL,
	"agent_report" jsonb NOT NULL,
	"canonical_digest" text NOT NULL,
	"finalized_at" timestamp(3) with time zone NOT NULL,
	CONSTRAINT "transcript_finalizations_id_unique" UNIQUE("finalization_id"),
	CONSTRAINT "transcript_finalizations_state_version_nonnegative" CHECK ("app"."transcript_finalizations"."state_version" >= 0),
	CONSTRAINT "transcript_finalizations_counts_nonnegative" CHECK ("app"."transcript_finalizations"."entry_count" >= 0 and "app"."transcript_finalizations"."technical_gap_count" >= 0 and "app"."transcript_finalizations"."technical_gap_count" <= "app"."transcript_finalizations"."entry_count"),
	CONSTRAINT "transcript_finalizations_validation_status_valid" CHECK ("app"."transcript_finalizations"."validation_status" in ('valid', 'valid_with_gaps')),
	CONSTRAINT "transcript_finalizations_json_shape" CHECK (jsonb_typeof("app"."transcript_finalizations"."deterministic_issues") = 'array' and jsonb_typeof("app"."transcript_finalizations"."agent_report") = 'object'),
	CONSTRAINT "transcript_finalizations_digest_sha256" CHECK ("app"."transcript_finalizations"."canonical_digest" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "app"."transcript_gaps" (
	"interview_id" text NOT NULL,
	"gap_id" text NOT NULL,
	"entry_kind" text DEFAULT 'technical_gap' NOT NULL,
	"source" text NOT NULL,
	"provider" text,
	"description" text NOT NULL,
	"related_segment_id" text,
	"related_utterance_id" text,
	"source_event_id" text NOT NULL,
	CONSTRAINT "transcript_gaps_pk" PRIMARY KEY("interview_id","gap_id"),
	CONSTRAINT "transcript_gaps_entry_kind_gap" CHECK ("app"."transcript_gaps"."entry_kind" = 'technical_gap'),
	CONSTRAINT "transcript_gaps_source_valid" CHECK ("app"."transcript_gaps"."source" in ('speech_to_text', 'audio_output', 'transport')),
	CONSTRAINT "transcript_gaps_provider_shape" CHECK (("app"."transcript_gaps"."source" = 'speech_to_text' and "app"."transcript_gaps"."provider" is not null and btrim("app"."transcript_gaps"."provider") <> '' and "app"."transcript_gaps"."related_utterance_id" is not null and btrim("app"."transcript_gaps"."related_utterance_id") <> '') or ("app"."transcript_gaps"."source" <> 'speech_to_text' and "app"."transcript_gaps"."provider" is null and "app"."transcript_gaps"."related_utterance_id" is null)),
	CONSTRAINT "transcript_gaps_description_not_blank" CHECK (btrim("app"."transcript_gaps"."description") <> '')
);
--> statement-breakpoint
CREATE TABLE "app"."transcript_partial_events" (
	"interview_id" text NOT NULL,
	"provider" text NOT NULL,
	"provider_event_id" text NOT NULL,
	"segment_id" text NOT NULL,
	"utterance_id" text NOT NULL,
	"revision" integer NOT NULL,
	"text" text NOT NULL,
	"disposition" text NOT NULL,
	"observed_at" timestamp(3) with time zone NOT NULL,
	CONSTRAINT "transcript_partial_events_pk" PRIMARY KEY("interview_id","provider","provider_event_id"),
	CONSTRAINT "transcript_partial_segment_revision_unique" UNIQUE("interview_id","provider","segment_id","revision"),
	CONSTRAINT "transcript_partial_provider_not_blank" CHECK (btrim("app"."transcript_partial_events"."provider") <> ''),
	CONSTRAINT "transcript_partial_revision_nonnegative" CHECK ("app"."transcript_partial_events"."revision" >= 0),
	CONSTRAINT "transcript_partial_disposition_valid" CHECK ("app"."transcript_partial_events"."disposition" in ('accepted', 'updated', 'ignored_stale', 'ignored_finalized'))
);
--> statement-breakpoint
CREATE TABLE "app"."transcript_turns" (
	"interview_id" text NOT NULL,
	"turn_id" text NOT NULL,
	"entry_kind" text DEFAULT 'turn' NOT NULL,
	"speaker" text NOT NULL,
	"turn_type" text NOT NULL,
	"text" text NOT NULL,
	"guide_id" text,
	"question_id" text,
	"source_provider" text,
	"provider_event_id" text,
	"source_segment_id" text,
	"delivery_id" text,
	"delivery_event_id" text,
	"delivery_status" text,
	"interrupted_at" timestamp(3) with time zone,
	CONSTRAINT "transcript_turns_pk" PRIMARY KEY("interview_id","turn_id"),
	CONSTRAINT "transcript_turns_source_scope_unique" UNIQUE("interview_id","turn_id","source_provider"),
	CONSTRAINT "transcript_turns_entry_kind_turn" CHECK ("app"."transcript_turns"."entry_kind" = 'turn'),
	CONSTRAINT "transcript_turns_text_not_blank" CHECK (btrim("app"."transcript_turns"."text") <> ''),
	CONSTRAINT "transcript_turns_turn_type_valid" CHECK ("app"."transcript_turns"."turn_type" in ('greeting', 'main_question', 'follow_up_question', 'clarification_question', 'participant_answer', 'transition', 'closing')),
	CONSTRAINT "transcript_turns_speaker_shape" CHECK (
        ("app"."transcript_turns"."speaker" = 'participant' and "app"."transcript_turns"."turn_type" = 'participant_answer' and "app"."transcript_turns"."source_provider" is not null and btrim("app"."transcript_turns"."source_provider") <> '' and "app"."transcript_turns"."provider_event_id" is not null and "app"."transcript_turns"."source_segment_id" is not null and "app"."transcript_turns"."delivery_id" is null and "app"."transcript_turns"."delivery_event_id" is null and "app"."transcript_turns"."delivery_status" is null and "app"."transcript_turns"."interrupted_at" is null)
        or ("app"."transcript_turns"."speaker" = 'ai_interviewer' and "app"."transcript_turns"."turn_type" <> 'participant_answer' and "app"."transcript_turns"."source_provider" is null and "app"."transcript_turns"."provider_event_id" is null and "app"."transcript_turns"."source_segment_id" is null and "app"."transcript_turns"."delivery_id" is not null and "app"."transcript_turns"."delivery_event_id" is not null and "app"."transcript_turns"."delivery_status" is not null and "app"."transcript_turns"."delivery_status" in ('complete', 'interrupted'))
      ),
	CONSTRAINT "transcript_turns_interruption_shape" CHECK (("app"."transcript_turns"."delivery_status" = 'interrupted' and "app"."transcript_turns"."interrupted_at" is not null) or ("app"."transcript_turns"."delivery_status" is distinct from 'interrupted' and "app"."transcript_turns"."interrupted_at" is null)),
	CONSTRAINT "transcript_turns_guide_reference_shape" CHECK (
        ("app"."transcript_turns"."turn_type" in ('greeting', 'closing') and "app"."transcript_turns"."guide_id" is null and "app"."transcript_turns"."question_id" is null)
        or ("app"."transcript_turns"."turn_type" in ('main_question', 'follow_up_question', 'clarification_question') and "app"."transcript_turns"."guide_id" is not null and "app"."transcript_turns"."question_id" is not null)
        or ("app"."transcript_turns"."turn_type" in ('participant_answer', 'transition') and (("app"."transcript_turns"."guide_id" is null and "app"."transcript_turns"."question_id" is null) or ("app"."transcript_turns"."guide_id" is not null and "app"."transcript_turns"."question_id" is not null)))
      )
);
--> statement-breakpoint
CREATE TABLE "app"."workflow_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"interview_id" text NOT NULL,
	"job_id" text NOT NULL,
	"mastra_attempt_id" text NOT NULL,
	"attempt_number" integer NOT NULL,
	"expected_state_version" integer NOT NULL,
	"status" text NOT NULL,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp(3) with time zone,
	"ended_at" timestamp(3) with time zone,
	"duration_ms" integer,
	"error_code" text,
	"error_message" text,
	"error_retryable" boolean,
	"rejection_reason" text,
	"applied_at" timestamp(3) with time zone,
	"created_at" timestamp(3) with time zone NOT NULL,
	CONSTRAINT "workflow_runs_interview_id_unique" UNIQUE("interview_id","id"),
	CONSTRAINT "workflow_runs_delivery_scope_unique" UNIQUE("interview_id","id","job_id"),
	CONSTRAINT "workflow_runs_job_attempt_unique" UNIQUE("job_id","attempt_number"),
	CONSTRAINT "workflow_runs_mastra_attempt_unique" UNIQUE("mastra_attempt_id"),
	CONSTRAINT "workflow_runs_status_valid" CHECK ("app"."workflow_runs"."status" in ('waiting', 'running', 'succeeded', 'failed', 'retrying', 'skipped')),
	CONSTRAINT "workflow_runs_numbers_valid" CHECK ("app"."workflow_runs"."attempt_number" > 0 and "app"."workflow_runs"."expected_state_version" >= 0 and "app"."workflow_runs"."retry_count" >= 0),
	CONSTRAINT "workflow_runs_timing_valid" CHECK (
        ("app"."workflow_runs"."status" = 'waiting' and "app"."workflow_runs"."started_at" is null and "app"."workflow_runs"."ended_at" is null and "app"."workflow_runs"."duration_ms" is null)
        or ("app"."workflow_runs"."status" in ('running', 'retrying') and "app"."workflow_runs"."started_at" is not null and "app"."workflow_runs"."ended_at" is null and "app"."workflow_runs"."duration_ms" is null)
        or ("app"."workflow_runs"."status" in ('succeeded', 'failed', 'skipped') and "app"."workflow_runs"."started_at" is not null and "app"."workflow_runs"."ended_at" is not null and "app"."workflow_runs"."duration_ms" is not null and "app"."workflow_runs"."duration_ms" >= 0)
      ),
	CONSTRAINT "workflow_runs_apply_shape" CHECK ("app"."workflow_runs"."applied_at" is null or ("app"."workflow_runs"."status" = 'succeeded' and "app"."workflow_runs"."rejection_reason" is null)),
	CONSTRAINT "workflow_runs_error_shape" CHECK (("app"."workflow_runs"."status" = 'failed' and "app"."workflow_runs"."error_code" is not null and "app"."workflow_runs"."error_message" is not null and "app"."workflow_runs"."error_retryable" is not null) or ("app"."workflow_runs"."status" <> 'failed' and "app"."workflow_runs"."error_code" is null and "app"."workflow_runs"."error_message" is null and "app"."workflow_runs"."error_retryable" is null)),
	CONSTRAINT "workflow_runs_time_order" CHECK ("app"."workflow_runs"."ended_at" is null or ("app"."workflow_runs"."started_at" is not null and "app"."workflow_runs"."ended_at" >= "app"."workflow_runs"."started_at"))
);
--> statement-breakpoint
CREATE TABLE "app"."workflow_step_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"interview_id" text NOT NULL,
	"workflow_run_id" text NOT NULL,
	"step" text NOT NULL,
	"attempt_number" integer DEFAULT 1 NOT NULL,
	"status" text NOT NULL,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp(3) with time zone,
	"ended_at" timestamp(3) with time zone,
	"duration_ms" integer,
	"error_code" text,
	"error_message" text,
	"error_retryable" boolean,
	"input" jsonb,
	"output" jsonb,
	CONSTRAINT "workflow_step_runs_identity_unique" UNIQUE("workflow_run_id","step","attempt_number"),
	CONSTRAINT "workflow_step_runs_attempt_positive" CHECK ("app"."workflow_step_runs"."attempt_number" > 0),
	CONSTRAINT "workflow_step_runs_retry_nonnegative" CHECK ("app"."workflow_step_runs"."retry_count" >= 0),
	CONSTRAINT "workflow_step_runs_step_valid" CHECK ("app"."workflow_step_runs"."step" in ('receive_user_turn', 'finalize_user_turn', 'load_interview_state', 'coverage_analysis', 'consistency_analysis', 'interview_decision', 'conductor_question_generation', 'validation', 'persistence', 'text_streaming', 'audio_streaming', 'state_update')),
	CONSTRAINT "workflow_step_runs_status_valid" CHECK ("app"."workflow_step_runs"."status" in ('waiting', 'running', 'succeeded', 'failed', 'retrying', 'skipped')),
	CONSTRAINT "workflow_step_runs_timing_valid" CHECK (
        ("app"."workflow_step_runs"."status" = 'waiting' and "app"."workflow_step_runs"."started_at" is null and "app"."workflow_step_runs"."ended_at" is null and "app"."workflow_step_runs"."duration_ms" is null)
        or ("app"."workflow_step_runs"."status" in ('running', 'retrying') and "app"."workflow_step_runs"."started_at" is not null and "app"."workflow_step_runs"."ended_at" is null and "app"."workflow_step_runs"."duration_ms" is null)
        or ("app"."workflow_step_runs"."status" in ('succeeded', 'failed', 'skipped') and "app"."workflow_step_runs"."started_at" is not null and "app"."workflow_step_runs"."ended_at" is not null and "app"."workflow_step_runs"."ended_at" >= "app"."workflow_step_runs"."started_at" and "app"."workflow_step_runs"."duration_ms" is not null and "app"."workflow_step_runs"."duration_ms" >= 0)
      ),
	CONSTRAINT "workflow_step_runs_error_shape" CHECK (("app"."workflow_step_runs"."status" = 'failed' and "app"."workflow_step_runs"."error_code" is not null and "app"."workflow_step_runs"."error_message" is not null and "app"."workflow_step_runs"."error_retryable" is not null) or ("app"."workflow_step_runs"."status" <> 'failed' and "app"."workflow_step_runs"."error_code" is null and "app"."workflow_step_runs"."error_message" is null and "app"."workflow_step_runs"."error_retryable" is null)),
	CONSTRAINT "workflow_step_runs_json_objects" CHECK (("app"."workflow_step_runs"."input" is null or jsonb_typeof("app"."workflow_step_runs"."input") = 'object') and ("app"."workflow_step_runs"."output" is null or jsonb_typeof("app"."workflow_step_runs"."output") = 'object'))
);
--> statement-breakpoint
ALTER TABLE "app"."agent_runs" ADD CONSTRAINT "agent_runs_workflow_fk" FOREIGN KEY ("interview_id","workflow_run_id") REFERENCES "app"."workflow_runs"("interview_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."ai_turn_deliveries" ADD CONSTRAINT "ai_turn_deliveries_job_fk" FOREIGN KEY ("interview_id","job_id") REFERENCES "app"."durable_jobs"("interview_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."ai_turn_deliveries" ADD CONSTRAINT "ai_turn_deliveries_workflow_job_fk" FOREIGN KEY ("interview_id","workflow_run_id","job_id") REFERENCES "app"."workflow_runs"("interview_id","id","job_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."ai_turn_deliveries" ADD CONSTRAINT "ai_turn_deliveries_interview_guide_fk" FOREIGN KEY ("interview_id","guide_id") REFERENCES "app"."interviews"("id","guide_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."ai_turn_deliveries" ADD CONSTRAINT "ai_turn_deliveries_question_fk" FOREIGN KEY ("guide_id","question_id") REFERENCES "app"."guide_questions"("guide_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."command_receipts" ADD CONSTRAINT "command_receipts_interview_fk" FOREIGN KEY ("interview_id") REFERENCES "app"."interviews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."contradiction_turn_references" ADD CONSTRAINT "contradiction_turn_references_contradiction_fk" FOREIGN KEY ("interview_id","contradiction_id") REFERENCES "app"."contradictions"("interview_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."contradiction_turn_references" ADD CONSTRAINT "contradiction_turn_references_turn_fk" FOREIGN KEY ("interview_id","turn_id") REFERENCES "app"."transcript_turns"("interview_id","turn_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."contradictions" ADD CONSTRAINT "contradictions_workflow_fk" FOREIGN KEY ("interview_id","workflow_run_id") REFERENCES "app"."workflow_runs"("interview_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."contradictions" ADD CONSTRAINT "contradictions_workflow_agent_fk" FOREIGN KEY ("interview_id","workflow_run_id","agent_run_id") REFERENCES "app"."agent_runs"("interview_id","workflow_run_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."contradictions" ADD CONSTRAINT "contradictions_asked_turn_fk" FOREIGN KEY ("interview_id","asked_turn_id") REFERENCES "app"."transcript_turns"("interview_id","turn_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."coverage_turn_references" ADD CONSTRAINT "coverage_turn_references_coverage_fk" FOREIGN KEY ("interview_id","question_id") REFERENCES "app"."question_coverage"("interview_id","question_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."coverage_turn_references" ADD CONSTRAINT "coverage_turn_references_turn_fk" FOREIGN KEY ("interview_id","turn_id") REFERENCES "app"."transcript_turns"("interview_id","turn_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."durable_jobs" ADD CONSTRAINT "durable_jobs_interview_fk" FOREIGN KEY ("interview_id") REFERENCES "app"."interviews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."durable_jobs" ADD CONSTRAINT "durable_jobs_source_final_segment_fk" FOREIGN KEY ("interview_id","source_turn_id") REFERENCES "app"."transcript_final_segments"("interview_id","turn_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."event_outbox" ADD CONSTRAINT "event_outbox_interview_fk" FOREIGN KEY ("interview_id") REFERENCES "app"."interviews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."guide_questions" ADD CONSTRAINT "guide_questions_section_fk" FOREIGN KEY ("guide_id","section_id") REFERENCES "app"."guide_sections"("guide_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."guide_questions" ADD CONSTRAINT "guide_questions_main_question_fk" FOREIGN KEY ("guide_id","main_question_id","section_id") REFERENCES "app"."guide_questions"("guide_id","id","section_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."guide_sections" ADD CONSTRAINT "guide_sections_guide_fk" FOREIGN KEY ("guide_id") REFERENCES "app"."guides"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."interview_counters" ADD CONSTRAINT "interview_counters_interview_fk" FOREIGN KEY ("interview_id") REFERENCES "app"."interviews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."interview_state" ADD CONSTRAINT "interview_state_interview_fk" FOREIGN KEY ("interview_id","guide_id") REFERENCES "app"."interviews"("id","guide_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."interview_state" ADD CONSTRAINT "interview_state_current_question_fk" FOREIGN KEY ("guide_id","current_main_question_id") REFERENCES "app"."guide_questions"("guide_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."interview_state" ADD CONSTRAINT "interview_state_active_workflow_fk" FOREIGN KEY ("interview_id","active_workflow_run_id") REFERENCES "app"."workflow_runs"("interview_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."interviews" ADD CONSTRAINT "interviews_guide_fk" FOREIGN KEY ("guide_id") REFERENCES "app"."guides"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."question_coverage" ADD CONSTRAINT "question_coverage_interview_fk" FOREIGN KEY ("interview_id","guide_id") REFERENCES "app"."interviews"("id","guide_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."question_coverage" ADD CONSTRAINT "question_coverage_question_fk" FOREIGN KEY ("guide_id","question_id") REFERENCES "app"."guide_questions"("guide_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."transcript_entries" ADD CONSTRAINT "transcript_entries_interview_fk" FOREIGN KEY ("interview_id") REFERENCES "app"."interviews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."transcript_final_segments" ADD CONSTRAINT "transcript_final_segments_turn_fk" FOREIGN KEY ("interview_id","turn_id","provider") REFERENCES "app"."transcript_turns"("interview_id","turn_id","source_provider") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."transcript_finalizations" ADD CONSTRAINT "transcript_finalizations_interview_fk" FOREIGN KEY ("interview_id") REFERENCES "app"."interviews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."transcript_finalizations" ADD CONSTRAINT "transcript_finalizations_agent_fk" FOREIGN KEY ("interview_id","agent_run_id") REFERENCES "app"."agent_runs"("interview_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."transcript_gaps" ADD CONSTRAINT "transcript_gaps_entry_fk" FOREIGN KEY ("interview_id","gap_id","entry_kind") REFERENCES "app"."transcript_entries"("interview_id","entry_id","kind") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."transcript_partial_events" ADD CONSTRAINT "transcript_partial_events_interview_fk" FOREIGN KEY ("interview_id") REFERENCES "app"."interviews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."transcript_turns" ADD CONSTRAINT "transcript_turns_entry_fk" FOREIGN KEY ("interview_id","turn_id","entry_kind") REFERENCES "app"."transcript_entries"("interview_id","entry_id","kind") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."transcript_turns" ADD CONSTRAINT "transcript_turns_delivery_fk" FOREIGN KEY ("interview_id","delivery_id","turn_id") REFERENCES "app"."ai_turn_deliveries"("interview_id","id","turn_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."transcript_turns" ADD CONSTRAINT "transcript_turns_interview_guide_fk" FOREIGN KEY ("interview_id","guide_id") REFERENCES "app"."interviews"("id","guide_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."transcript_turns" ADD CONSTRAINT "transcript_turns_question_fk" FOREIGN KEY ("guide_id","question_id") REFERENCES "app"."guide_questions"("guide_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."workflow_runs" ADD CONSTRAINT "workflow_runs_job_fk" FOREIGN KEY ("interview_id","job_id") REFERENCES "app"."durable_jobs"("interview_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."workflow_step_runs" ADD CONSTRAINT "workflow_step_runs_workflow_fk" FOREIGN KEY ("interview_id","workflow_run_id") REFERENCES "app"."workflow_runs"("interview_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_runs_workflow_idx" ON "app"."agent_runs" USING btree ("workflow_run_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_turn_deliveries_provider_event_unique" ON "app"."ai_turn_deliveries" USING btree ("interview_id","provider","provider_delivery_event_id") WHERE "app"."ai_turn_deliveries"."provider_delivery_event_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_turn_deliveries_one_pending_per_interview" ON "app"."ai_turn_deliveries" USING btree ("interview_id") WHERE "app"."ai_turn_deliveries"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "ai_turn_deliveries_pending_idx" ON "app"."ai_turn_deliveries" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "contradiction_turn_references_turn_idx" ON "app"."contradiction_turn_references" USING btree ("interview_id","turn_id");--> statement-breakpoint
CREATE INDEX "contradictions_status_idx" ON "app"."contradictions" USING btree ("interview_id","status","created_at");--> statement-breakpoint
CREATE INDEX "coverage_turn_references_turn_idx" ON "app"."coverage_turn_references" USING btree ("interview_id","turn_id");--> statement-breakpoint
CREATE UNIQUE INDEX "durable_jobs_one_active_per_interview" ON "app"."durable_jobs" USING btree ("interview_id") WHERE "app"."durable_jobs"."status" in ('queued', 'running');--> statement-breakpoint
CREATE INDEX "durable_jobs_claim_idx" ON "app"."durable_jobs" USING btree ("status","available_at","created_at");--> statement-breakpoint
CREATE INDEX "event_outbox_replay_idx" ON "app"."event_outbox" USING btree ("interview_id","sequence_number");--> statement-breakpoint
CREATE INDEX "event_outbox_category_idx" ON "app"."event_outbox" USING btree ("interview_id","category","occurred_at");--> statement-breakpoint
CREATE INDEX "event_outbox_run_idx" ON "app"."event_outbox" USING btree ("interview_id","run_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "guide_questions_main_position_unique" ON "app"."guide_questions" USING btree ("guide_id","section_id","position") WHERE "app"."guide_questions"."kind" = 'main_question';--> statement-breakpoint
CREATE UNIQUE INDEX "guide_questions_follow_up_position_unique" ON "app"."guide_questions" USING btree ("guide_id","main_question_id","position") WHERE "app"."guide_questions"."kind" = 'follow_up_question';--> statement-breakpoint
CREATE UNIQUE INDEX "question_coverage_one_current_per_interview" ON "app"."question_coverage" USING btree ("interview_id") WHERE "app"."question_coverage"."status" = 'current';--> statement-breakpoint
CREATE INDEX "question_coverage_status_idx" ON "app"."question_coverage" USING btree ("interview_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "transcript_gaps_stt_source_event_unique" ON "app"."transcript_gaps" USING btree ("interview_id","provider","source_event_id") WHERE "app"."transcript_gaps"."source" = 'speech_to_text';--> statement-breakpoint
CREATE UNIQUE INDEX "transcript_gaps_non_stt_source_event_unique" ON "app"."transcript_gaps" USING btree ("interview_id","source_event_id") WHERE "app"."transcript_gaps"."source" <> 'speech_to_text';--> statement-breakpoint
CREATE UNIQUE INDEX "transcript_gaps_stt_utterance_unique" ON "app"."transcript_gaps" USING btree ("interview_id","provider","related_utterance_id") WHERE "app"."transcript_gaps"."source" = 'speech_to_text';--> statement-breakpoint
CREATE INDEX "transcript_partial_segment_idx" ON "app"."transcript_partial_events" USING btree ("interview_id","provider","segment_id","revision");--> statement-breakpoint
CREATE UNIQUE INDEX "transcript_turns_participant_provider_event_unique" ON "app"."transcript_turns" USING btree ("interview_id","source_provider","provider_event_id") WHERE "app"."transcript_turns"."provider_event_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "transcript_turns_source_segment_unique" ON "app"."transcript_turns" USING btree ("interview_id","source_provider","source_segment_id") WHERE "app"."transcript_turns"."source_segment_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "transcript_turns_delivery_event_unique" ON "app"."transcript_turns" USING btree ("interview_id","delivery_event_id") WHERE "app"."transcript_turns"."delivery_event_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_runs_one_applied_per_job" ON "app"."workflow_runs" USING btree ("job_id") WHERE "app"."workflow_runs"."applied_at" is not null;--> statement-breakpoint
CREATE INDEX "workflow_runs_interview_created_idx" ON "app"."workflow_runs" USING btree ("interview_id","created_at");--> statement-breakpoint
CREATE INDEX "workflow_step_runs_workflow_idx" ON "app"."workflow_step_runs" USING btree ("workflow_run_id","started_at");
--> statement-breakpoint
INSERT INTO "app"."schema_metadata" ("component", "version", "applied_at")
VALUES ('application', 1, now())
ON CONFLICT ("component") DO UPDATE
SET "version" = EXCLUDED."version", "applied_at" = EXCLUDED."applied_at";
