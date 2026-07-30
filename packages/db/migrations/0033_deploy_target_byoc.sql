ALTER TABLE "deploy_targets" ADD COLUMN "mode" text DEFAULT 'hosted' NOT NULL;
--> statement-breakpoint
ALTER TABLE "deploy_targets" ADD COLUMN "role_arn" text;
--> statement-breakpoint
ALTER TABLE "deploy_targets" ADD COLUMN "region" text;
