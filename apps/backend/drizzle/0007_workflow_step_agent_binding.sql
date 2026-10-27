ALTER TABLE "app"."workflow_step_runs" ADD COLUMN "agent_run_id" text;--> statement-breakpoint
WITH "candidate_agent_runs" AS (
  SELECT
    "step"."id" AS "step_run_id",
    min("agent"."id") AS "agent_run_id",
    count(*) AS "candidate_count"
  FROM "app"."workflow_step_runs" AS "step"
  JOIN "app"."agent_runs" AS "agent"
    ON "agent"."interview_id" = "step"."interview_id"
   AND "agent"."workflow_run_id" = "step"."workflow_run_id"
   AND "agent"."status" = 'succeeded'
   AND "agent"."output" = "step"."output"
   AND "agent"."agent_name" = CASE "step"."step"
     WHEN 'coverage_analysis' THEN 'coverage_analysis'
     WHEN 'consistency_analysis' THEN 'consistency_analysis'
     WHEN 'interview_decision' THEN 'interview_decision'
     WHEN 'conductor_question_generation' THEN 'interview_conductor'
   END
  WHERE "step"."status" = 'succeeded'
    AND "step"."step" IN (
      'coverage_analysis',
      'consistency_analysis',
      'interview_decision',
      'conductor_question_generation'
    )
    AND "step"."output" IS NOT NULL
  GROUP BY "step"."id"
)
UPDATE "app"."workflow_step_runs" AS "step"
SET "agent_run_id" = "candidate"."agent_run_id"
FROM "candidate_agent_runs" AS "candidate"
WHERE "step"."id" = "candidate"."step_run_id"
  AND "candidate"."candidate_count" = 1;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "app"."workflow_step_runs" AS "step"
    WHERE (
      "step"."step" IN (
        'coverage_analysis',
        'consistency_analysis',
        'interview_decision',
        'conductor_question_generation'
      )
      AND (
        ("step"."status" = 'succeeded' AND (
          "step"."agent_run_id" IS NULL OR "step"."output" IS NULL
        ))
        OR ("step"."status" <> 'succeeded' AND (
          "step"."agent_run_id" IS NOT NULL OR "step"."output" IS NOT NULL
        ))
      )
    ) OR (
      "step"."step" NOT IN (
        'coverage_analysis',
        'consistency_analysis',
        'interview_decision',
        'conductor_question_generation'
      )
      AND "step"."output" IS NOT NULL
    )
  ) THEN
    RAISE EXCEPTION 'Cannot determine one exact agent run for every persisted workflow step'
      USING ERRCODE = '23514';
  END IF;
END;
$$;--> statement-breakpoint
ALTER TABLE "app"."workflow_step_runs" ADD CONSTRAINT "workflow_step_runs_agent_fk" FOREIGN KEY ("interview_id","workflow_run_id","agent_run_id") REFERENCES "app"."agent_runs"("interview_id","workflow_run_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."workflow_step_runs" ADD CONSTRAINT "workflow_step_runs_agent_shape" CHECK (
        ("app"."workflow_step_runs"."step" in ('coverage_analysis', 'consistency_analysis', 'interview_decision', 'conductor_question_generation')
          and (("app"."workflow_step_runs"."status" = 'succeeded' and "app"."workflow_step_runs"."agent_run_id" is not null and "app"."workflow_step_runs"."output" is not null)
            or ("app"."workflow_step_runs"."status" <> 'succeeded' and "app"."workflow_step_runs"."agent_run_id" is null and "app"."workflow_step_runs"."output" is null)))
        or ("app"."workflow_step_runs"."step" not in ('coverage_analysis', 'consistency_analysis', 'interview_decision', 'conductor_question_generation')
          and "app"."workflow_step_runs"."agent_run_id" is null and "app"."workflow_step_runs"."output" is null)
      );--> statement-breakpoint
INSERT INTO "app"."schema_metadata" ("component", "version", "applied_at")
VALUES ('application', 8, now())
ON CONFLICT ("component") DO UPDATE
SET "version" = EXCLUDED."version", "applied_at" = EXCLUDED."applied_at";
