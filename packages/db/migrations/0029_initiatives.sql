CREATE TABLE IF NOT EXISTS "initiatives" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL UNIQUE,
  "cost_center" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "initiative_id" uuid;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "projects" ADD CONSTRAINT "projects_initiative_id_initiatives_id_fk"
    FOREIGN KEY ("initiative_id") REFERENCES "initiatives"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;
