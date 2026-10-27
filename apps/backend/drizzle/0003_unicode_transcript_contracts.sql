ALTER TABLE "app"."ai_turn_deliveries" DROP CONSTRAINT "ai_turn_deliveries_text_valid";--> statement-breakpoint
ALTER TABLE "app"."ai_turn_deliveries" DROP CONSTRAINT "ai_turn_deliveries_provider_identifiers_valid";--> statement-breakpoint
ALTER TABLE "app"."ai_turn_deliveries" DROP CONSTRAINT "ai_turn_deliveries_confirmed_text_valid";--> statement-breakpoint
ALTER TABLE "app"."ai_turn_deliveries" ADD CONSTRAINT "ai_turn_deliveries_text_valid" CHECK ("app"."ai_turn_deliveries"."proposed_text" !~ U&'^[\0009-\000D\0020\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]*$' and char_length("app"."ai_turn_deliveries"."proposed_text") <= 20000);--> statement-breakpoint
ALTER TABLE "app"."ai_turn_deliveries" ADD CONSTRAINT "ai_turn_deliveries_provider_identifiers_valid" CHECK (
        ("app"."ai_turn_deliveries"."provider" is null or ("app"."ai_turn_deliveries"."provider" !~ U&'^[\0009-\000D\0020\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]' and "app"."ai_turn_deliveries"."provider" !~ U&'[\0009-\000D\0020\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]$' and char_length("app"."ai_turn_deliveries"."provider") between 1 and 100))
        and ("app"."ai_turn_deliveries"."provider_delivery_event_id" is null or ("app"."ai_turn_deliveries"."provider_delivery_event_id" !~ U&'^[\0009-\000D\0020\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]' and "app"."ai_turn_deliveries"."provider_delivery_event_id" !~ U&'[\0009-\000D\0020\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]$' and char_length("app"."ai_turn_deliveries"."provider_delivery_event_id") between 1 and 300))
      );--> statement-breakpoint
ALTER TABLE "app"."ai_turn_deliveries" ADD CONSTRAINT "ai_turn_deliveries_confirmed_text_valid" CHECK ("app"."ai_turn_deliveries"."confirmed_spoken_text" is null or ("app"."ai_turn_deliveries"."confirmed_spoken_text" !~ U&'^[\0009-\000D\0020\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]*$' and char_length("app"."ai_turn_deliveries"."confirmed_spoken_text") <= 20000));--> statement-breakpoint
INSERT INTO "app"."schema_metadata" ("component", "version", "applied_at")
VALUES ('application', 4, now())
ON CONFLICT ("component") DO UPDATE
SET "version" = EXCLUDED."version", "applied_at" = EXCLUDED."applied_at";
