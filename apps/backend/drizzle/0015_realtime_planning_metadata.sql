ALTER TABLE app.ai_turn_deliveries ADD COLUMN planning_metadata jsonb;
--> statement-breakpoint
ALTER TABLE app.ai_turn_deliveries ADD CONSTRAINT ai_turn_deliveries_planning_metadata_object
  CHECK (planning_metadata IS NULL OR jsonb_typeof(planning_metadata) = 'object');
