CREATE FUNCTION "app"."notify_event_outbox_insert"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM pg_notify('orgscience_event_outbox', NEW."interview_id");
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "event_outbox_notify_after_insert"
AFTER INSERT ON "app"."event_outbox"
FOR EACH ROW
EXECUTE FUNCTION "app"."notify_event_outbox_insert"();--> statement-breakpoint
INSERT INTO "app"."schema_metadata" ("component", "version", "applied_at")
VALUES ('application', 7, now())
ON CONFLICT ("component") DO UPDATE
SET "version" = EXCLUDED."version", "applied_at" = EXCLUDED."applied_at";
