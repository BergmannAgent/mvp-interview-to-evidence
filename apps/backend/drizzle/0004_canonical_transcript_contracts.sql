ALTER TABLE "app"."transcript_final_segments" DROP CONSTRAINT "transcript_final_segments_provider_not_blank";--> statement-breakpoint
ALTER TABLE "app"."transcript_final_segments" DROP CONSTRAINT "transcript_final_segments_text_not_blank";--> statement-breakpoint
ALTER TABLE "app"."transcript_gaps" DROP CONSTRAINT "transcript_gaps_description_not_blank";--> statement-breakpoint
ALTER TABLE "app"."transcript_partial_events" DROP CONSTRAINT "transcript_partial_provider_not_blank";--> statement-breakpoint
ALTER TABLE "app"."transcript_turns" DROP CONSTRAINT "transcript_turns_text_not_blank";--> statement-breakpoint
ALTER TABLE "app"."transcript_final_segments" ADD CONSTRAINT "transcript_final_segments_internal_ids_valid" CHECK (
        "app"."transcript_final_segments"."segment_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
        and "app"."transcript_final_segments"."utterance_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
        and "app"."transcript_final_segments"."turn_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
      );--> statement-breakpoint
ALTER TABLE "app"."transcript_final_segments" ADD CONSTRAINT "transcript_final_segments_provider_identifiers_valid" CHECK (
        "app"."transcript_final_segments"."provider" !~ U&'^[\0009-\000D\0020\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]'
        and "app"."transcript_final_segments"."provider" !~ U&'[\0009-\000D\0020\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]$'
        and char_length("app"."transcript_final_segments"."provider") between 1 and 100
        and "app"."transcript_final_segments"."provider_event_id" !~ U&'^[\0009-\000D\0020\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]'
        and "app"."transcript_final_segments"."provider_event_id" !~ U&'[\0009-\000D\0020\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]$'
        and char_length("app"."transcript_final_segments"."provider_event_id") between 1 and 300
      );--> statement-breakpoint
ALTER TABLE "app"."transcript_final_segments" ADD CONSTRAINT "transcript_final_segments_text_valid" CHECK ("app"."transcript_final_segments"."text" !~ U&'^[\0009-\000D\0020\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]*$' and char_length("app"."transcript_final_segments"."text") <= 20000);--> statement-breakpoint
ALTER TABLE "app"."transcript_gaps" ADD CONSTRAINT "transcript_gaps_internal_ids_valid" CHECK (
        "app"."transcript_gaps"."gap_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
        and ("app"."transcript_gaps"."related_segment_id" is null or "app"."transcript_gaps"."related_segment_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$')
        and ("app"."transcript_gaps"."related_utterance_id" is null or "app"."transcript_gaps"."related_utterance_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$')
        and "app"."transcript_gaps"."source_event_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
      );--> statement-breakpoint
ALTER TABLE "app"."transcript_gaps" ADD CONSTRAINT "transcript_gaps_provider_identifiers_valid" CHECK (
        "app"."transcript_gaps"."provider" is null or ("app"."transcript_gaps"."provider" !~ U&'^[\0009-\000D\0020\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]' and "app"."transcript_gaps"."provider" !~ U&'[\0009-\000D\0020\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]$' and char_length("app"."transcript_gaps"."provider") between 1 and 100)
      );--> statement-breakpoint
ALTER TABLE "app"."transcript_gaps" ADD CONSTRAINT "transcript_gaps_description_valid" CHECK ("app"."transcript_gaps"."description" !~ U&'^[\0009-\000D\0020\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]*$' and char_length("app"."transcript_gaps"."description") <= 1000);--> statement-breakpoint
ALTER TABLE "app"."transcript_partial_events" ADD CONSTRAINT "transcript_partial_internal_ids_valid" CHECK (
        "app"."transcript_partial_events"."segment_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
        and "app"."transcript_partial_events"."utterance_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
      );--> statement-breakpoint
ALTER TABLE "app"."transcript_partial_events" ADD CONSTRAINT "transcript_partial_provider_identifiers_valid" CHECK (
        "app"."transcript_partial_events"."provider" !~ U&'^[\0009-\000D\0020\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]'
        and "app"."transcript_partial_events"."provider" !~ U&'[\0009-\000D\0020\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]$'
        and char_length("app"."transcript_partial_events"."provider") between 1 and 100
        and "app"."transcript_partial_events"."provider_event_id" !~ U&'^[\0009-\000D\0020\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]'
        and "app"."transcript_partial_events"."provider_event_id" !~ U&'[\0009-\000D\0020\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]$'
        and char_length("app"."transcript_partial_events"."provider_event_id") between 1 and 300
      );--> statement-breakpoint
ALTER TABLE "app"."transcript_partial_events" ADD CONSTRAINT "transcript_partial_text_valid" CHECK (char_length("app"."transcript_partial_events"."text") <= 20000);--> statement-breakpoint
ALTER TABLE "app"."transcript_turns" ADD CONSTRAINT "transcript_turns_internal_ids_valid" CHECK (
        "app"."transcript_turns"."turn_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
        and ("app"."transcript_turns"."source_segment_id" is null or "app"."transcript_turns"."source_segment_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$')
        and ("app"."transcript_turns"."delivery_id" is null or "app"."transcript_turns"."delivery_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$')
      );--> statement-breakpoint
ALTER TABLE "app"."transcript_turns" ADD CONSTRAINT "transcript_turns_provider_identifiers_valid" CHECK (
        ("app"."transcript_turns"."source_provider" is null or ("app"."transcript_turns"."source_provider" !~ U&'^[\0009-\000D\0020\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]' and "app"."transcript_turns"."source_provider" !~ U&'[\0009-\000D\0020\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]$' and char_length("app"."transcript_turns"."source_provider") between 1 and 100))
        and ("app"."transcript_turns"."provider_event_id" is null or ("app"."transcript_turns"."provider_event_id" !~ U&'^[\0009-\000D\0020\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]' and "app"."transcript_turns"."provider_event_id" !~ U&'[\0009-\000D\0020\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]$' and char_length("app"."transcript_turns"."provider_event_id") between 1 and 300))
        and ("app"."transcript_turns"."delivery_event_id" is null or ("app"."transcript_turns"."delivery_event_id" !~ U&'^[\0009-\000D\0020\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]' and "app"."transcript_turns"."delivery_event_id" !~ U&'[\0009-\000D\0020\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]$' and char_length("app"."transcript_turns"."delivery_event_id") between 1 and 300))
      );--> statement-breakpoint
ALTER TABLE "app"."transcript_turns" ADD CONSTRAINT "transcript_turns_text_valid" CHECK ("app"."transcript_turns"."text" !~ U&'^[\0009-\000D\0020\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]*$' and char_length("app"."transcript_turns"."text") <= 20000);--> statement-breakpoint
INSERT INTO "app"."schema_metadata" ("component", "version", "applied_at")
VALUES ('application', 5, now())
ON CONFLICT ("component") DO UPDATE
SET "version" = EXCLUDED."version", "applied_at" = EXCLUDED."applied_at";
