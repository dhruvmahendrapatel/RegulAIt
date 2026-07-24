CREATE TABLE "approval_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"tool_name" text,
	"write_only" boolean DEFAULT false NOT NULL,
	"approver_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rate_limits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"tool_name" text,
	"max_calls" integer NOT NULL,
	"window_seconds" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"tool_name" text NOT NULL,
	"rule_id" uuid NOT NULL,
	"approver_user_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_reason" text
);
--> statement-breakpoint
ALTER TABLE "approval_rules" ADD CONSTRAINT "approval_rules_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "approval_rules" ADD CONSTRAINT "approval_rules_server_id_mcp_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."mcp_servers"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "approval_rules" ADD CONSTRAINT "approval_rules_approver_user_id_users_id_fk" FOREIGN KEY ("approver_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "rate_limits" ADD CONSTRAINT "rate_limits_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "rate_limits" ADD CONSTRAINT "rate_limits_server_id_mcp_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."mcp_servers"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_server_id_mcp_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."mcp_servers"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "approval_rules_user_server_idx" ON "approval_rules" USING btree ("user_id","server_id");
--> statement-breakpoint
CREATE INDEX "rate_limits_user_server_idx" ON "rate_limits" USING btree ("user_id","server_id");
--> statement-breakpoint
CREATE INDEX "approvals_status_idx" ON "approvals" USING btree ("status");
--> statement-breakpoint
CREATE INDEX "approvals_user_server_tool_idx" ON "approvals" USING btree ("user_id","server_id","tool_name");
