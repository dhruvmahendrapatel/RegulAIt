-- ADR-0181 security review, FX3 finding 6: the guardrail window gets a
-- SERVER-SIDE limit.
--
-- The assurance run's guardrail window (demo:intake) relaxes prompt injection
-- and jailbreak to `warn` on the agents under test, through an agent-scope
-- override, and deletes that override in a `finally`. Nothing on the server
-- bounded it: a crash between open and close left a permanent relaxation that
-- looked exactly like an admin's choice.
--
--   created_by  'admin' (every override an admin writes, and the org row) or
--               'assurance-window' (a time-boxed window override). Says WHO
--               owns the row, so a re-run reclaims its own leftovers and never
--               touches an admin's override.
--   expires_at  NULL for an admin override and for the org row; REQUIRED for a
--               window override. `resolveGuardrailPolicy` ignores a row whose
--               expiry has passed (the org default applies again at once), and
--               the `guardrail-window-expiry-sweep` scheduler job deletes it
--               with an audit row.
--
-- The two checks make the bound structural: a window row cannot exist without
-- an expiry, an admin row cannot carry one, and the org default can never be a
-- window. There are no existing window rows to migrate (the window ships in
-- the same batch), so every existing row is an admin row and takes the default.
ALTER TABLE "guardrail_configs" ADD COLUMN "created_by" text DEFAULT 'admin' NOT NULL;
--> statement-breakpoint
ALTER TABLE "guardrail_configs" ADD COLUMN "expires_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "guardrail_configs" ADD CONSTRAINT "guardrail_configs_created_by_check"
  CHECK ("created_by" IN ('admin', 'assurance-window'));
--> statement-breakpoint
ALTER TABLE "guardrail_configs" ADD CONSTRAINT "guardrail_configs_window_expiry_check"
  CHECK (("created_by" = 'assurance-window') = ("expires_at" IS NOT NULL));
--> statement-breakpoint
ALTER TABLE "guardrail_configs" ADD CONSTRAINT "guardrail_configs_window_scope_check"
  CHECK ("created_by" = 'admin' OR "scope" <> 'org');
--> statement-breakpoint
CREATE INDEX "guardrail_configs_expires_at_idx" ON "guardrail_configs" USING btree ("expires_at")
  WHERE "expires_at" IS NOT NULL;
