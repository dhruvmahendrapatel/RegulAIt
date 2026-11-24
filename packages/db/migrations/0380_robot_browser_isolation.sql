-- ADR-0364 S3 (lane E45): the `robot_browser` sandbox workload kind under ADR-0190. Hand-authored (never drizzle-kit
-- generate), additive and idempotent.
--
-- 1. `robot_browser` joins the isolable workload kinds on the two tables that CHECK them (execution_placements,
--    execution_offers), mirroring ISOLABLE_WORKLOAD_KINDS in packages/shared/src/isolation/contract.ts.
-- 2. `org_settings.isolation_floor_robot_browser`: the robot run floor, strict default L2 (`user_space_kernel`) on the
--    existing row (first load, ADR-0180: no grandfathering). Lowering it is the same audited `settings_relax` step-up
--    as every other isolation floor (`PUT /v1/org/settings`), and the CHECK holds it at or above a hardened container
--    (L1): there is no L0 value.
-- 3. `execution_offers.egress_targets`: a robot run's per-run egress (`[{host, port}]`), REQUIRED on a robot_browser
--    offer and NULL on every other kind (the CHECK; the gateway and the offer schema refuse the same). Exception comment
--    (ADR-0200 3NF, on the column in schema.ts): an "as offered" snapshot of the version's allowed sites, written once.
--    With it `execution_offers.robot_run_id`, the run the offer is for (required on robot_browser, NULL elsewhere).
-- 4. The shipped `robot-browser` execution profile, version 1, byte for byte the body in
--    packages/shared/src/isolation/profiles.ts (its digest is the SHA-256 of that canonical text; the table's own
--    digest CHECK refuses anything else). Inserted only when the name has no version yet.
--
-- No new table and no new function, so no new row-level security policy or search_path pin is needed.

ALTER TABLE "execution_placements" DROP CONSTRAINT IF EXISTS "execution_placements_workload_kind_check";
--> statement-breakpoint
ALTER TABLE "execution_placements" ADD CONSTRAINT "execution_placements_workload_kind_check" CHECK (
  "workload_kind" IN ('mcp_stdio', 'code_exec', 'engine_worker', 'byoc_worker', 'robot_browser')
);
--> statement-breakpoint
ALTER TABLE "execution_offers" DROP CONSTRAINT IF EXISTS "execution_offers_workload_kind_check";
--> statement-breakpoint
ALTER TABLE "execution_offers" ADD CONSTRAINT "execution_offers_workload_kind_check" CHECK (
  "workload_kind" IN ('mcp_stdio', 'code_exec', 'engine_worker', 'byoc_worker', 'robot_browser')
);
--> statement-breakpoint
ALTER TABLE "org_settings" ADD COLUMN IF NOT EXISTS "isolation_floor_robot_browser" text DEFAULT 'user_space_kernel' NOT NULL;
--> statement-breakpoint
ALTER TABLE "org_settings" DROP CONSTRAINT IF EXISTS "org_settings_isolation_floor_robot_browser_check";
--> statement-breakpoint
ALTER TABLE "org_settings" ADD CONSTRAINT "org_settings_isolation_floor_robot_browser_check" CHECK (
  "isolation_floor_robot_browser" IN ('hardened_container', 'user_space_kernel', 'microvm')
);
--> statement-breakpoint
ALTER TABLE "execution_offers" ADD COLUMN IF NOT EXISTS "egress_targets" jsonb;
--> statement-breakpoint
ALTER TABLE "execution_offers" DROP CONSTRAINT IF EXISTS "execution_offers_egress_targets_check";
--> statement-breakpoint
ALTER TABLE "execution_offers" ADD CONSTRAINT "execution_offers_egress_targets_check" CHECK (
  ("workload_kind" = 'robot_browser') = ("egress_targets" IS NOT NULL)
  AND ("egress_targets" IS NULL OR (jsonb_typeof("egress_targets") = 'array' AND jsonb_array_length("egress_targets") BETWEEN 1 AND 64))
);
--> statement-breakpoint
-- the robot run an offer is for: required on robot_browser, NULL elsewhere. Its foreign key to robot_runs("id") is
-- added where robot_runs is created (pending robots.sql sorts after this file).
ALTER TABLE "execution_offers" ADD COLUMN IF NOT EXISTS "robot_run_id" uuid;
--> statement-breakpoint
ALTER TABLE "execution_offers" DROP CONSTRAINT IF EXISTS "execution_offers_robot_run_check";
--> statement-breakpoint
ALTER TABLE "execution_offers" ADD CONSTRAINT "execution_offers_robot_run_check" CHECK (
  ("workload_kind" = 'robot_browser') = ("robot_run_id" IS NOT NULL)
);
--> statement-breakpoint
INSERT INTO "execution_profiles" ("name", "version", "body", "digest", "min_class", "shipped")
SELECT 'robot-browser', 1, '{"attestation":{"executorMaxAgeMinutes":120,"perPlacement":true,"probes":["runtime_identity","proc_status","seccomp_enforced","root_read_only","egress_literal_address","egress_dns","network_interfaces","no_executor_credentials","visible_limits","host_cgroup_limits","runtime_config"]},"filesystem":{"inputs":[],"rootReadOnly":true,"workDir":{"path":"/work","tmpfsMiB":1024}},"minClass":"user_space_kernel","name":"robot-browser","network":{"mode":"egress_proxy"},"persistence":"none","process":{"capabilities":[],"exec":"image_only","noNewPrivileges":true,"pids":{"hostCgroupPidsMax":1024,"workloadNproc":512},"seccomp":{"type":"RuntimeDefault"},"uid":10001},"resources":{"cpuMillis":2000,"memoryMiB":2048,"outputBytes":134217728,"wallClockSecondsPerCall":420,"wallClockSecondsPerSession":420},"runsc":{"directfs":false,"ociSeccomp":true,"platform":"systrap","sidecarReleaseEnforcementPolicy":"ALWAYS","sidecarUsagePolicy":"STRICT"},"schema":"regulait.execution-profile.v1","secrets":"task_scoped","workloadKinds":["robot_browser"]}', '16391ff57c49268eb2448f1af0454063186719b0ed4e675d5e3137f75b4535bc', 'user_space_kernel', true
WHERE NOT EXISTS (SELECT 1 FROM "execution_profiles" WHERE "name" = 'robot-browser');
