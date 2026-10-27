ALTER TABLE "app"."ai_turn_deliveries" DROP CONSTRAINT "ai_turn_deliveries_text_not_blank";--> statement-breakpoint
ALTER TABLE "app"."ai_turn_deliveries" ADD CONSTRAINT "ai_turn_deliveries_internal_ids_valid" CHECK (
        "app"."ai_turn_deliveries"."id" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
        and "app"."ai_turn_deliveries"."job_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
        and "app"."ai_turn_deliveries"."workflow_run_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
        and "app"."ai_turn_deliveries"."turn_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
        and "app"."ai_turn_deliveries"."utterance_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
      );--> statement-breakpoint
ALTER TABLE "app"."ai_turn_deliveries" ADD CONSTRAINT "ai_turn_deliveries_text_valid" CHECK (btrim("app"."ai_turn_deliveries"."proposed_text") <> '' and char_length("app"."ai_turn_deliveries"."proposed_text") <= 20000);--> statement-breakpoint
ALTER TABLE "app"."ai_turn_deliveries" ADD CONSTRAINT "ai_turn_deliveries_provider_identifiers_valid" CHECK (
        ("app"."ai_turn_deliveries"."provider" is null or ("app"."ai_turn_deliveries"."provider" = btrim("app"."ai_turn_deliveries"."provider") and char_length("app"."ai_turn_deliveries"."provider") between 1 and 100))
        and ("app"."ai_turn_deliveries"."provider_delivery_event_id" is null or ("app"."ai_turn_deliveries"."provider_delivery_event_id" = btrim("app"."ai_turn_deliveries"."provider_delivery_event_id") and char_length("app"."ai_turn_deliveries"."provider_delivery_event_id") between 1 and 300))
      );--> statement-breakpoint
ALTER TABLE "app"."ai_turn_deliveries" ADD CONSTRAINT "ai_turn_deliveries_confirmed_text_valid" CHECK ("app"."ai_turn_deliveries"."confirmed_spoken_text" is null or (btrim("app"."ai_turn_deliveries"."confirmed_spoken_text") <> '' and char_length("app"."ai_turn_deliveries"."confirmed_spoken_text") <= 20000));--> statement-breakpoint
INSERT INTO "app"."schema_metadata" ("component", "version", "applied_at")
VALUES ('application', 3, now())
ON CONFLICT ("component") DO UPDATE
SET "version" = EXCLUDED."version", "applied_at" = EXCLUDED."applied_at";
