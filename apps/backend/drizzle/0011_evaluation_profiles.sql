CREATE TABLE "app"."evaluation_profiles" (
	"profile_id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"profile" jsonb NOT NULL,
	"created_at" timestamp(3) with time zone NOT NULL,
	"updated_at" timestamp(3) with time zone NOT NULL,
	CONSTRAINT "evaluation_profiles_identity_valid" CHECK ("app"."evaluation_profiles"."profile_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
	CONSTRAINT "evaluation_profiles_name_not_blank" CHECK (btrim("app"."evaluation_profiles"."name") <> ''),
	CONSTRAINT "evaluation_profiles_time_order" CHECK ("app"."evaluation_profiles"."updated_at" >= "app"."evaluation_profiles"."created_at"),
	CONSTRAINT "evaluation_profiles_json_scope" CHECK (jsonb_typeof("app"."evaluation_profiles"."profile") = 'object' and "app"."evaluation_profiles"."profile" @> jsonb_build_object('profileId', "app"."evaluation_profiles"."profile_id", 'name', "app"."evaluation_profiles"."name", 'isDefault', "app"."evaluation_profiles"."is_default", 'createdAt', to_char("app"."evaluation_profiles"."created_at" at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'updatedAt', to_char("app"."evaluation_profiles"."updated_at" at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "evaluation_profiles_name_unique" ON "app"."evaluation_profiles" USING btree (lower("name"));
--> statement-breakpoint
CREATE UNIQUE INDEX "evaluation_profiles_one_default" ON "app"."evaluation_profiles" USING btree ("is_default") WHERE "app"."evaluation_profiles"."is_default" = true;
--> statement-breakpoint
INSERT INTO "app"."schema_metadata" ("component", "version", "applied_at")
VALUES ('application', 12, now())
ON CONFLICT ("component") DO UPDATE
SET "version" = EXCLUDED."version", "applied_at" = EXCLUDED."applied_at";
