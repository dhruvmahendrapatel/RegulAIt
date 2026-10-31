/**
 * ADR-0226 — the shared list contract on the workflows, engines, cost and operations lists (P2 batch C).
 *
 * The same checks the pilot routes have (list-contract.test.ts), run over every list this batch converts:
 *
 *  - paging by the default sort and by another sort returns every row exactly once, and `count=exact` is the
 *    true total;
 *  - the sort allow-list: an unknown column, `__proto__` or an injection attempt is a 400;
 *  - the Excel export holds exactly the requested columns, in order, with the screen's labels, one row per list
 *    row, and writes its audit row;
 *  - the list's own authorisation, for the page and the export: an admin-only list refuses a member, and a
 *    list a member may read holds only what that member could see before;
 *  - a caller that sends none of the contract's params gets the route's old response key.
 *
 * Fixtures are inserted with SQL, 12 or more per list so a 10-row page always has a next page.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { strFromU8, unzipSync } from "fflate";
import { DATA_KEY_ATTESTATION_METHODS, auditLog, createDb, desc, eq, runMigrations, sql, type Db } from "@regulait/db";
import { buildApp } from "./app.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { relaxStepUpForTest } from "./testing/step-up-posture.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");
const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `lc2c-boot-${RUN}`;
const BOOT_AUTH = { authorization: `Bearer ${BOOT}` };
const N = 12;

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
let db: Db;
let app: ReturnType<typeof buildApp>;
let restoreMfa: () => Promise<void>;
let restoreStepUp: () => Promise<void>;
const ids = {} as Record<string, string>;
let adminAuth: Record<string, string>;
let memberAuth: Record<string, string>;

const get = (url: string, headers: Record<string, string>) => app.inject({ method: "GET", url, headers });
const q = async (text: string): Promise<Json[]> => ((await db.execute(sql.raw(text))) as unknown as { rows: Json[] }).rows;
const one = async (text: string): Promise<string> => String((await q(text))[0]!.id);
const gs = `generate_series(1, ${N}) g`;
const ago = (unit = "minutes") => `now() - (g || ' ${unit}')::interval`;

function readXlsx(buf: Buffer): Array<Array<string | number | null>> {
  const files = unzipSync(new Uint8Array(buf));
  const shared = files["xl/sharedStrings.xml"]
    ? [...strFromU8(files["xl/sharedStrings.xml"]).matchAll(/<si>(.*?)<\/si>/gs)].map((m) => [...m[1]!.matchAll(/<t(?:\s[^>]*)?>(.*?)<\/t>/gs)].map((t) => t[1]!).join(""))
    : [];
  const sheet = strFromU8(files["xl/worksheets/sheet1.xml"]!);
  return [...sheet.matchAll(/<row[^>]*>(.*?)<\/row>/gs)].map((row) => {
    const out: Array<string | number | null> = [];
    for (const c of row[1]!.matchAll(/<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>(.*?)<\/c>)/gs)) {
      const col = c[1]!.split("").reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
      const v = /<v>(.*?)<\/v>/s.exec(c[3] ?? "")?.[1];
      while (out.length < col) out.push(null);
      out[col] = v === undefined ? null : /t="s"/.test(c[2]!) ? shared[Number(v)]! : Number(v);
    }
    return out;
  });
}

async function walk(url: string, headers: Record<string, string>): Promise<{ items: Json[]; total: number }> {
  const sep = url.includes("?") ? "&" : "?";
  const items: Json[] = [];
  let next = "";
  let total = -1;
  for (let guard = 0; guard < 500; guard++) {
    const res = await get(`${url}${sep}limit=10&count=exact${next}`, headers);
    expect(res.statusCode, `${url}: ${res.body}`).toBe(200);
    const body = res.json() as Json;
    if (total < 0) total = body.total;
    expect(body.items.length).toBeLessThanOrEqual(10);
    items.push(...body.items);
    if (body.nextCursor) next = `&cursor=${encodeURIComponent(body.nextCursor)}`;
    else if (body.nextOffset !== null) next = `&offset=${body.nextOffset}`;
    else return { items, total };
  }
  throw new Error(`paging did not end: ${url}`);
}

interface Case {
  name: string;
  /** the list route; `extra` query params (filters) may follow a `?` */
  url: () => string;
  exportUrl: () => string;
  legacyKey: string;
  /** every id the admin's list holds */
  adminIds: () => Promise<string[]>;
  /** another sort, read by offset */
  altSort: string;
  /** two export columns and their screen labels */
  columns: [string, string];
  labels: [string, string];
  /** the member's view: refused, or exactly these ids */
  member: "admin-only" | (() => Promise<string[]>);
  /** how a row names its id (default `id`) */
  idOf?: (r: Json) => string;
}

const col = async (text: string) => (await q(text)).map((r) => String(r.id));

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restoreMfa = await relaxIdentityForTest(db, { mfaRequired: "off" });
  restoreStepUp = await relaxStepUpForTest(db);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "c".repeat(64) });
  for (const k of ["admin", "member"] as const) {
    const u = await app.inject({ method: "POST", url: "/v1/users", headers: BOOT_AUTH, payload: { email: `lc2c-${k}-${RUN}@example.com`, displayName: k === "admin" ? "Ada Admin" : "Dana Developer" } });
    expect(u.statusCode, u.body).toBe(201);
    ids[k] = u.json().id as string;
    if (k === "admin") await q(`update users set is_admin = true where id = '${ids[k]}'`);
    const key = await app.inject({ method: "POST", url: `/v1/users/${ids[k]}/keys`, headers: BOOT_AUTH, payload: { name: "lc2c" } });
    expect(key.statusCode, key.body).toBe(201);
    if (k === "admin") adminAuth = { authorization: `Bearer ${key.json().token}` };
    else memberAuth = { authorization: `Bearer ${key.json().token}` };
  }
  const A = ids.admin!;
  const M = ids.member!;
  const owner = (i = "g") => `case when ${i} % 4 = 0 then '${M}'::uuid else '${A}'::uuid end`;

  await q(`insert into workflow_instances (template_ids, definition, initiator_user_id, change, state, status, created_at)
    select '[]', '{}', ${owner()}, jsonb_build_object('description', 'Change ' || g, 'changeType', 'feature'), '{}', 'running', ${ago()} from ${gs}`);
  ids.agent = await one(`insert into builder_agents (name, owner_user_id, connection_format) values ('Credit-limit-increase assistant ${RUN}', '${A}', 'shared') returning id`);
  await q(`insert into builder_threads (agent_id, user_id, title, updated_at) select '${ids.agent}', ${owner()}, 'Thread ' || g, ${ago()} from generate_series(1, 16) g`);
  await q(`insert into eval_datasets (name, version) select 'lc2c-${RUN}-' || g, 1 from ${gs}`);
  ids.dataset = await one(`select id from eval_datasets where name = 'lc2c-${RUN}-1'`);
  await q(`insert into eval_runs (dataset_id, dataset_version, agent_name, trigger, mean_score, started_at) select '${ids.dataset}', 1, 'Credit-limit-increase assistant', 'manual', g / 20.0, ${ago()} from ${gs}`);
  await q(`insert into engine_runs (engine_id, engine_version, status, trigger, target_kind, config, config_hash, budget_usd, timeout_seconds, queue_expires_at, finished_at, run_as_user_id, cost_usd, created_at)
    select 'promptfoo', '1', 'completed', 'manual', 'agent', '{"sets":["a"]}', 'h', 1, 60, now(), now(), ${owner()}, g, ${ago()} from ${gs}`);
  await q(`insert into engine_schedules (engine_id, request, config_hash, interval_hours, next_run_at, run_as_user_id, created_at)
    select 'promptfoo', '{}', 'h', g, now(), ${owner()}, ${ago()} from ${gs}`);
  ids.webhook = await one(`insert into webhook_subscriptions (name, url, secret_ciphertext) values ('lc2c ${RUN}', 'https://receiver.example.test/hook', 'x') returning id`);
  await q(`insert into webhook_deliveries (subscription_id, event, message_id, payload, max_attempts, attempts, created_at) select '${ids.webhook}', 'run.completed', 'msg-${RUN}-' || g, '{}', 5, g % 5, ${ago()} from ${gs}`);
  const wi = await one(`insert into workload_identities (kind, identifier, sponsor_user_ids) values ('worker_runtime', 'spiffe://test.local/worker/lc2c-${RUN}', array['${A}'::uuid]) returning id`);
  ids.executor = await one(`insert into executors (workload_identity_id, name, backend, runtime_version, classes_declared) values ('${wi}', 'lc2c-${RUN}', 'runc', '1.0', '["hardened_container"]') returning id`);
  const digest = String((await q(`select digest from execution_profiles where name = 'restricted'`))[0]!.digest);
  await q(`insert into executor_attestations (executor_id, profile_digest, class, report_sha256, report, verdict, observed_at, expires_at)
    select '${ids.executor}', '${digest}', 'hardened_container', repeat('a', 64), '{}', 'pass', ${ago()}, ${ago()} + interval '1 hour' from ${gs}`);
  ids.registry = await one(`insert into mcp_registries (name, url) values ('lc2c ${RUN}', 'https://registry.example.test') returning id`);
  await q(`insert into mcp_registry_entries (registry_id, upstream_name, upstream_version, kind) select '${ids.registry}', 'io.example/server-' || g, '1.' || g, 'catalogue_only' from ${gs}`);
  await q(`insert into cost_events (user_id, technique, estimation_basis, rule_id, estimated_tokens_saved, at) select ${owner()}, 'model_routing', 'x', 'r', g, ${ago()} from ${gs}`);
  await q(`insert into cost_import_batches (adapter, vendor, format, mode, status, payload_sha256, refusals, summary, rule_id, reason, created_at)
    select 'csv', 'lc2c ${RUN}', 'csv', 'apply', 'applied', 'lc2c-${RUN}-' || g, '[]', '{}', 'r', 'ok', ${ago()} from ${gs}`);
  ids.batch = await one(`select id from cost_import_batches where vendor = 'lc2c ${RUN}' limit 1`);
  await q(`insert into imported_cost_lines (batch_id, vendor, adapter, source_row, account_ref, account_key, resolution_method, resolution_detail, period_start, period_end, amount, billing_kind)
    select '${ids.batch}', 'lc2c', 'csv', g, 'acct-' || g, 'k' || g, 'unresolved', 'none', now() - interval '30 days', now(), g * 1.5, 'usage' from ${gs}`);
  ids.period = await one(`insert into billing_periods (scope_kind, scope_key, period_start, period_end) values ('org', 'org-lc2c-${RUN}', now() - interval '30 days', now()) returning id`);
  // every third statement is project-scoped over no project: a member could have cut it, so the member sees it
  await q(`insert into billing_statements (period_id, version, rate_card_name, rate_card_version, pricing_snapshot, entitlement_scope, effective_project_ids, derived_through_at, source_usage_event_count, measured_input_tokens, measured_output_tokens, unpriced_event_count, ledger_estimated_cost_usd, seat_count, usage_subtotal_usd, seat_subtotal_usd, total_usd, payload, generated_at)
    select '${ids.period}', g, 'Standard', 1, '{}', case when g % 3 = 0 then 'project' else 'org' end, case when g % 3 = 0 then '[]'::jsonb end, now(), 0, 0, 0, 0, 0, 0, 0, 0, g, '{}', ${ago()} from ${gs}`);
  ids.definition = await one(`insert into report_definitions (name, kind) values ('lc2c ${RUN}', 'exec_summary') returning id`);
  await q(`insert into report_runs (definition_id, period, period_start, period_end, entitlement_scope, effective_project_ids, payload, row_count, generated_at)
    select '${ids.definition}', 'last_month', now() - interval '30 days', now(), case when g % 3 = 0 then 'project' else 'org' end, case when g % 3 = 0 then '[]'::jsonb end, '{}', g, ${ago()} from ${gs}`);
  ids.project = await one(`insert into projects (name) values ('lc2c ${RUN}') returning id`);
  await q(`insert into spend_anomalies (project_id, signal, method, observed, baseline_samples, absolute_floor, window_start, window_end, explanation, action, detected_at)
    select '${ids.project}', 'spend_spike', 'mad_z', g, 7, 1, now() - interval '1 day' - (g || ' hours')::interval, now() - (g || ' hours')::interval, 'signal ' || g, 'alert', ${ago()} from ${gs}`);
  await q(`insert into spend_scheduled_changes (project_id, delta_usd, effective_at, reason) select '${ids.project}', g, now() + (g || ' days')::interval, 'Change ' || g from ${gs}`);
  ids.pack = await one(`insert into compliance_packs (framework, version, title) values ('lc2c-${RUN}', 1, 'Pack') returning id`);
  await q(`insert into compliance_pack_reports (pack_id, framework, pack_version, scope_kind, entitlement_scope, effective_project_ids, period_start, period_end, payload, generated_at)
    select '${ids.pack}', 'lc2c', 1, 'org', case when g % 3 = 0 then 'project' else 'org' end, case when g % 3 = 0 then '[]'::jsonb end, now() - interval '30 days', now(), '{}', ${ago()} from ${gs}`);
  await q(`insert into infra_resources (kind, name, created_at) select 'control_plane', 'lc2c-${RUN}-' || g, ${ago()} from ${gs}`);
  ids.resource = await one(`select id from infra_resources where name = 'lc2c-${RUN}-1'`);
  await q(`insert into infra_findings (resource_id, kind, severity, detail, detected_at) select '${ids.resource}', 'drift', (array['low','medium','high','critical'])[1 + g % 4], jsonb_build_object('summary', 'Finding ' || g), ${ago()} from ${gs}`);
  await q(`insert into cert_inventory (resource_id, common_name, not_after) select '${ids.resource}', 'host' || g || '.example.test', now() + (g || ' days')::interval from ${gs}`);
  await q(`insert into patch_records (resource_id, cve, severity) select '${ids.resource}', 'CVE-2026-' || (1000 + g), 'high' from ${gs}`);
  await q(`insert into backup_runs (resource_id, status, created_at) select '${ids.resource}', 'success', ${ago()} from ${gs}`);
  ids.job = `lc2c-job-${RUN}`;
  await q(`insert into scheduler_jobs (name, interval_seconds) values ('${ids.job}', 60)`);
  await q(`insert into scheduler_runs (job_name, instance_id, items_processed, started_at) select '${ids.job}', 'node-1', g, ${ago()} from ${gs}`);
  const fp = (await get("/v1/security/data-key", adminAuth)).json().fingerprint as string;
  expect(fp).toBeTruthy();
  ids.fingerprint = fp;
  await q(`insert into data_key_attestations (fingerprint, attested_by_label, method, attested_at) select '${fp}', 'Ada Admin lc2c-${RUN}', '${DATA_KEY_ATTESTATION_METHODS[0]}', ${ago()} from ${gs}`);
  await q(`insert into onboarding_imports (kind, mode, status, payload_sha256, plan, rule_id, reason, row_count, created_at) select 'users', 'dry_run', 'planned', 'lc2c-${RUN}', '{}', 'r', 'Import ' || g, g, ${ago()} from ${gs}`);
  ids.trainingDataset = await one(`insert into training_datasets (name) values ('lc2c ${RUN}') returning id`);
  await q(`insert into training_jobs (name, dataset_id, dataset_version, backend, method, created_at) select 'Job ' || g, '${ids.trainingDataset}', 1, 'mock', 'retrieval_index', ${ago()} from ${gs}`);
  await q(`insert into model_artifacts (sha256, size_bytes, format, filename, storage_key, uploaded_by_user_id, created_at)
    select encode(sha256(convert_to('lc2c-${RUN}-' || g, 'UTF8')), 'hex'), g, 'safetensors', 'model-' || g || '.safetensors', 'sha256/' || encode(sha256(convert_to('lc2c-${RUN}-' || g, 'UTF8')), 'hex'), ${owner()}, ${ago()} from ${gs}`);
  await q(`insert into builder_skills (name, owner_user_id, admission_state, requested_visibility) select 'skill-${RUN}-' || g, '${A}', 'held', case when g % 2 = 0 then 'workspace' end from generate_series(1, 24) g`);
  await q(`insert into mcp_servers (name, url, admission_state) select 'lc2c-${RUN}-' || g, 'https://mcp' || g || '.example.test/mcp', 'held' from ${gs}`);
}, 180_000);

afterAll(async () => {
  // take the fixtures back out, so a later suite that reads a whole table (reconciliation, the engine lease) sees
  // only its own rows; executor attestations are append-only by design and stay
  const A = ids.admin;
  const M = ids.member;
  const users = `('${A}', '${M}')`;
  const cleanup = [
    `delete from workflow_instances where initiator_user_id in ${users}`,
    `delete from builder_threads where agent_id = '${ids.agent}'`,
    `delete from builder_agents where id = '${ids.agent}'`,
    `delete from eval_runs where dataset_id = '${ids.dataset}'`,
    `delete from eval_datasets where name like 'lc2c-${RUN}-%'`,
    `delete from engine_runs where run_as_user_id in ${users}`,
    `delete from engine_schedules where run_as_user_id in ${users}`,
    `delete from webhook_deliveries where subscription_id = '${ids.webhook}'`,
    `delete from webhook_subscriptions where id = '${ids.webhook}'`,
    `delete from mcp_registry_entries where registry_id = '${ids.registry}'`,
    `delete from mcp_registries where id = '${ids.registry}'`,
    `delete from cost_events where user_id in ${users}`,
    `delete from imported_cost_lines where batch_id in (select id from cost_import_batches where vendor = 'lc2c ${RUN}')`,
    `delete from cost_import_batches where vendor = 'lc2c ${RUN}'`,
    `delete from billing_statements where period_id = '${ids.period}'`,
    `delete from billing_periods where id = '${ids.period}'`,
    `delete from report_runs where definition_id = '${ids.definition}'`,
    `delete from report_definitions where id = '${ids.definition}'`,
    `delete from spend_anomalies where project_id = '${ids.project}'`,
    `delete from spend_scheduled_changes where project_id = '${ids.project}'`,
    `delete from projects where id = '${ids.project}'`,
    `delete from compliance_pack_reports where pack_id = '${ids.pack}'`,
    `delete from compliance_packs where id = '${ids.pack}'`,
    ...["infra_findings", "cert_inventory", "patch_records", "backup_runs"].map(
      (t) => `delete from ${t} where resource_id in (select id from infra_resources where name like 'lc2c-${RUN}-%')`,
    ),
    `delete from infra_resources where name like 'lc2c-${RUN}-%'`,
    `delete from scheduler_runs where job_name = '${ids.job}'`,
    `delete from scheduler_jobs where name = '${ids.job}'`,
    `delete from data_key_attestations where attested_by_label = 'Ada Admin lc2c-${RUN}'`,
    `delete from onboarding_imports where payload_sha256 = 'lc2c-${RUN}'`,
    `delete from training_jobs where dataset_id = '${ids.trainingDataset}'`,
    `delete from training_datasets where id = '${ids.trainingDataset}'`,
    `delete from model_artifacts where uploaded_by_user_id in ${users}`,
    `delete from builder_skills where name like 'skill-${RUN}-%'`,
    `delete from mcp_servers where name like 'lc2c-${RUN}-%'`,
  ];
  const kept: string[] = [];
  for (const stmt of cleanup) await q(stmt).catch(() => kept.push(stmt.split(" where ")[0]!));
  if (kept.length) console.warn(`lc2c fixtures kept by a guard: ${kept.join("; ")}`);
  await restoreStepUp?.();
  await restoreMfa?.();
});

const A = () => ids.admin!;
const M = () => ids.member!;
const CASES: Case[] = [
  {
    name: "workflows",
    url: () => "/v1/workflows/instances",
    exportUrl: () => "/v1/workflows/instances/export.xlsx",
    legacyKey: "instances",
    adminIds: () => col(`select id from workflow_instances`),
    altSort: "change",
    columns: ["change", "status"],
    labels: ["Change", "Status"],
    member: () => col(`select id from workflow_instances where initiator_user_id = '${M()}'`),
  },
  {
    name: "builder threads",
    url: () => "/v1/builder/threads",
    exportUrl: () => "/v1/builder/threads/export.xlsx",
    legacyKey: "threads",
    adminIds: () => col(`select id from builder_threads where user_id = '${A()}'`),
    altSort: "title",
    columns: ["title", "agent"],
    labels: ["Thread", "Agent"],
    member: () => col(`select id from builder_threads where user_id = '${M()}'`),
  },
  {
    name: "eval datasets",
    url: () => "/v1/evals/datasets",
    exportUrl: () => "/v1/evals/datasets/export.xlsx",
    legacyKey: "datasets",
    adminIds: () => col(`select id from eval_datasets`),
    altSort: "cases",
    columns: ["name", "version"],
    labels: ["Dataset", "Version"],
    member: "admin-only",
  },
  {
    name: "eval runs",
    url: () => "/v1/evals/runs",
    exportUrl: () => "/v1/evals/runs/export.xlsx",
    legacyKey: "runs",
    adminIds: () => col(`select id from eval_runs`),
    altSort: "score",
    columns: ["dataset", "agent"],
    labels: ["Dataset", "Agent"],
    member: "admin-only",
  },
  {
    name: "engine runs",
    url: () => "/v1/engine-runs",
    exportUrl: () => "/v1/engine-runs/export.xlsx",
    legacyKey: "runs",
    adminIds: () => col(`select id from engine_runs`),
    altSort: "cost",
    columns: ["engine", "status"],
    labels: ["Engine", "Status"],
    member: () => col(`select id from engine_runs where run_as_user_id = '${M()}'`),
  },
  {
    name: "engine schedules",
    url: () => "/v1/engine-schedules",
    exportUrl: () => "/v1/engine-schedules/export.xlsx",
    legacyKey: "schedules",
    adminIds: () => col(`select id from engine_schedules`),
    altSort: "every",
    columns: ["engine", "every"],
    labels: ["Engine", "Every (hours)"],
    member: () => col(`select id from engine_schedules where run_as_user_id = '${M()}'`),
  },
  {
    name: "webhook deliveries",
    url: () => `/v1/webhooks/${ids.webhook}/deliveries`,
    exportUrl: () => `/v1/webhooks/${ids.webhook}/deliveries/export.xlsx`,
    legacyKey: "deliveries",
    adminIds: () => col(`select id from webhook_deliveries where subscription_id = '${ids.webhook}'`),
    altSort: "attempts",
    columns: ["event", "attempts"],
    labels: ["Event", "Attempts"],
    member: "admin-only",
  },
  {
    name: "executor attestations",
    url: () => `/v1/executors/${ids.executor}/attestations`,
    exportUrl: () => `/v1/executors/${ids.executor}/attestations/export.xlsx`,
    legacyKey: "attestations",
    adminIds: () => col(`select id from executor_attestations where executor_id = '${ids.executor}'`),
    altSort: "verdict",
    columns: ["at", "report"],
    labels: ["Observed", "Report SHA-256"],
    member: "admin-only",
  },
  {
    name: "registry entries",
    url: () => `/v1/mcp-registries/${ids.registry}/entries`,
    exportUrl: () => `/v1/mcp-registries/${ids.registry}/entries/export.xlsx`,
    legacyKey: "entries",
    adminIds: () => col(`select id from mcp_registry_entries where registry_id = '${ids.registry}'`),
    altSort: "version",
    columns: ["name", "state"],
    labels: ["Entry", "State"],
    member: "admin-only",
  },
  {
    name: "cost events",
    url: () => "/v1/cost-events",
    exportUrl: () => "/v1/cost-events/export.xlsx",
    legacyKey: "events",
    adminIds: () => col(`select id from cost_events`),
    altSort: "tokens",
    columns: ["at", "technique"],
    labels: ["At", "Technique"],
    member: () => col(`select id from cost_events where user_id = '${M()}'`),
  },
  {
    name: "cost imports",
    url: () => "/v1/cost-imports",
    exportUrl: () => "/v1/cost-imports/export.xlsx",
    legacyKey: "imports",
    adminIds: () => col(`select id from cost_import_batches`),
    altSort: "vendor",
    columns: ["vendor", "status"],
    labels: ["Vendor", "Status"],
    member: "admin-only",
  },
  {
    name: "cost import lines",
    url: () => `/v1/cost-imports/${ids.batch}`,
    exportUrl: () => `/v1/cost-imports/${ids.batch}/export.xlsx`,
    legacyKey: "lines",
    adminIds: () => col(`select id from imported_cost_lines where batch_id = '${ids.batch}'`),
    altSort: "amt",
    columns: ["row", "acct"],
    labels: ["File line", "Vendor account"],
    member: "admin-only",
  },
  {
    name: "billing statements",
    url: () => "/v1/billing/statements",
    exportUrl: () => "/v1/billing/statements/export.xlsx",
    legacyKey: "statements",
    adminIds: () => col(`select id from billing_statements`),
    altSort: "t",
    columns: ["v", "st"],
    labels: ["Version", "Status"],
    // the member is in no project, so only statements over no project are theirs to see (ADR-0047's rule)
    member: () => col(`select id from billing_statements where entitlement_scope <> 'org' and effective_project_ids is not null and effective_project_ids <@ '[]'::jsonb`),
  },
  {
    name: "report runs",
    url: () => "/v1/reports/runs",
    exportUrl: () => "/v1/reports/runs/export.xlsx",
    legacyKey: "runs",
    adminIds: () => col(`select id from report_runs`),
    altSort: "n",
    columns: ["d", "n"],
    labels: ["Definition", "Rows"],
    member: () => col(`select id from report_runs where entitlement_scope <> 'org' and effective_project_ids is not null and effective_project_ids <@ '[]'::jsonb`),
  },
  {
    name: "spend anomalies",
    url: () => "/v1/spend/anomalies",
    exportUrl: () => "/v1/spend/anomalies/export.xlsx",
    legacyKey: "anomalies",
    adminIds: () => col(`select id from spend_anomalies`),
    altSort: "o",
    columns: ["p", "s"],
    labels: ["Project", "Signal"],
    member: () => col(`select a.id from spend_anomalies a join project_members m on m.project_id = a.project_id where m.user_id = '${M()}'`),
  },
  {
    name: "spend scheduled changes",
    url: () => "/v1/spend/scheduled-changes",
    exportUrl: () => "/v1/spend/scheduled-changes/export.xlsx",
    legacyKey: "scheduledChanges",
    adminIds: () => col(`select id from spend_scheduled_changes`),
    altSort: "d",
    columns: ["p", "d"],
    labels: ["Project", "Delta"],
    member: "admin-only",
  },
  {
    name: "pack reports",
    url: () => "/v1/compliance/pack-reports",
    exportUrl: () => "/v1/compliance/pack-reports/export.xlsx",
    legacyKey: "reports",
    adminIds: () => col(`select id from compliance_pack_reports`),
    altSort: "by",
    columns: ["pack", "scope"],
    labels: ["Pack", "Covers"],
    member: () => col(`select id from compliance_pack_reports where entitlement_scope <> 'org' and effective_project_ids is not null and effective_project_ids <@ '[]'::jsonb`),
  },
  ...(
    [
      ["resources", "infra_resources", "name", ["name", "kind"], ["Name", "Kind"]],
      ["findings", "infra_findings", "detected", ["resource", "severity"], ["Governs", "Severity"]],
      ["certs", "cert_inventory", "cn", ["cn", "notAfter"], ["Common name", "Not after"]],
      ["patches", "patch_records", "cve", ["cve", "severity"], ["CVE", "Severity"]],
      ["backups", "backup_runs", "status", ["resource", "status"], ["Governs", "Status"]],
    ] as const
  ).map(([p, table, alt, columns, labels]) => ({
    name: `infra ${p}`,
    url: () => `/v1/infra/${p}`,
    exportUrl: () => `/v1/infra/${p}/export.xlsx`,
    legacyKey: p,
    adminIds: () => col(`select id from ${table}`),
    altSort: alt,
    columns: [...columns] as [string, string],
    labels: [...labels] as [string, string],
    member: "admin-only" as const,
  })),
  {
    name: "scheduler job runs",
    url: () => `/v1/scheduler/jobs/${ids.job}/runs`,
    exportUrl: () => `/v1/scheduler/jobs/${ids.job}/runs/export.xlsx`,
    legacyKey: "runs",
    adminIds: () => col(`select id from scheduler_runs where job_name = '${ids.job}'`),
    altSort: "items",
    columns: ["started", "items"],
    labels: ["Started", "Items"],
    member: "admin-only",
  },
  {
    name: "data-key attestations",
    url: () => "/v1/security/data-key/attestations",
    exportUrl: () => "/v1/security/data-key/attestations/export.xlsx",
    legacyKey: "attestations",
    adminIds: () => col(`select id from data_key_attestations where fingerprint = '${ids.fingerprint}'`),
    altSort: "who",
    columns: ["at", "who"],
    labels: ["When", "Who"],
    member: "admin-only",
  },
  {
    name: "onboarding imports",
    url: () => "/v1/onboarding/imports",
    exportUrl: () => "/v1/onboarding/imports/export.xlsx",
    legacyKey: "imports",
    adminIds: () => col(`select id from onboarding_imports`),
    altSort: "rows",
    columns: ["kind", "why"],
    labels: ["Kind", "What happened"],
    member: "admin-only",
  },
  {
    name: "training jobs",
    url: () => "/v1/llm/jobs",
    exportUrl: () => "/v1/llm/jobs/export.xlsx",
    legacyKey: "jobs",
    adminIds: () => col(`select id from training_jobs`),
    altSort: "name",
    columns: ["name", "dataset"],
    labels: ["Job", "Trained on"],
    member: "admin-only",
  },
  {
    name: "model artifacts",
    url: () => "/v1/model-artifacts",
    exportUrl: () => "/v1/model-artifacts/export.xlsx",
    legacyKey: "artifacts",
    adminIds: () => col(`select id from model_artifacts`),
    altSort: "size",
    columns: ["name", "scan"],
    labels: ["File name", "Scan"],
    member: () => col(`select id from model_artifacts where uploaded_by_user_id = '${M()}'`),
  },
  {
    name: "held skills",
    url: () => "/v1/admission/skills?view=held",
    exportUrl: () => "/v1/admission/skills/export.xlsx?view=held",
    legacyKey: "skills",
    adminIds: () => col(`select id from builder_skills where archived_at is null and admission_state in ('held', 'refused', 'admitted')`),
    altSort: "owner",
    columns: ["name", "state"],
    labels: ["Skill", "State"],
    member: "admin-only",
  },
  {
    name: "share requests",
    url: () => "/v1/admission/skills?view=shares",
    exportUrl: () => "/v1/admission/skills/export.xlsx?view=shares",
    legacyKey: "skills",
    adminIds: () => col(`select id from builder_skills where archived_at is null and requested_visibility = 'workspace'`),
    altSort: "state",
    columns: ["name", "owner"],
    labels: ["Skill", "Owner"],
    member: "admin-only",
  },
  {
    name: "held MCP servers",
    url: () => "/v1/mcp/admission?state=held",
    exportUrl: () => "/v1/mcp/admission/export.xlsx?state=held",
    legacyKey: "servers",
    adminIds: () => col(`select id from mcp_servers where admission_state = 'held'`),
    altSort: "name",
    columns: ["name", "sev"],
    labels: ["Server", "Severity"],
    member: "admin-only",
  },
];

const latestExportAudit = async () => (await db.select().from(auditLog).where(eq(auditLog.ruleId, "list-export-xlsx")).orderBy(desc(auditLog.at)).limit(1))[0]!;
const sep = (u: string) => (u.includes("?") ? "&" : "?");

describe.each(CASES)("ADR-0226 batch C: $name", (c) => {
  const idOf = (r: Json) => (c.idOf ? c.idOf(r) : String(r.id));

  it("pages every row exactly once, by the default sort and by another, with the true total", async () => {
    const expected = await c.adminIds();
    expect(expected.length).toBeGreaterThanOrEqual(N);
    for (const url of [c.url(), `${c.url()}${sep(c.url())}sort=${c.altSort}&dir=desc`]) {
      const { items, total } = await walk(url, adminAuth);
      const got = items.map(idOf);
      expect(new Set(got).size, `${url}: a row came twice`).toBe(got.length);
      expect(new Set(got)).toEqual(new Set(expected));
      expect(total).toBe(expected.length);
    }
  });

  it("refuses a column off the allow-list, and never interpolates it", async () => {
    for (const bad of ["nope", "__proto__", "id;drop table users", "constructor"]) {
      const res = await get(`${c.url()}${sep(c.url())}sort=${encodeURIComponent(bad)}&limit=10`, adminAuth);
      expect(res.statusCode, `${bad}: ${res.body}`).toBe(400);
      expect(res.json().error).toBe("unknown_sort_column");
    }
    const ex = await get(`${c.exportUrl()}${sep(c.exportUrl())}columns=${c.columns[0]},nope`, adminAuth);
    expect(ex.statusCode).toBe(400);
  });

  it("exports exactly the requested columns, in order, with the screen's labels, for every row, and audits it", async () => {
    const expected = await c.adminIds();
    const res = await get(`${c.exportUrl()}${sep(c.exportUrl())}columns=${c.columns[1]},${c.columns[0]}`, adminAuth);
    expect(res.statusCode, res.body.slice(0, 300)).toBe(200);
    expect(res.headers["content-type"]).toContain("spreadsheetml");
    const rows = readXlsx(res.rawPayload);
    expect(rows[0]).toEqual([c.labels[1], c.labels[0]]);
    expect(rows.length - 1).toBe(expected.length);
    const audit = await latestExportAudit();
    expect(audit.objectType).toBe("audit_export");
    expect(audit.detail).toMatchObject({ columns: [c.columns[1], c.columns[0]], rows: expected.length });
  });

  it("keeps the list's own authorisation for the page and the export", async () => {
    if (c.member === "admin-only") {
      expect((await get(`${c.url()}${sep(c.url())}limit=10&count=exact`, memberAuth)).statusCode).toBe(403);
      expect((await get(`${c.exportUrl()}${sep(c.exportUrl())}columns=${c.columns[0]}`, memberAuth)).statusCode).toBe(403);
      return;
    }
    const mine = await c.member();
    const { items, total } = await walk(c.url(), memberAuth);
    expect(new Set(items.map(idOf))).toEqual(new Set(mine));
    expect(total).toBe(mine.length);
    const res = await get(`${c.exportUrl()}${sep(c.exportUrl())}columns=${c.columns[0]}`, memberAuth);
    expect(res.statusCode, res.body.slice(0, 300)).toBe(200);
    expect(readXlsx(res.rawPayload).length - 1).toBe(mine.length);
  });

  it("answers its old shape to a caller that sends none of the contract's params", async () => {
    const res = await get(c.url(), adminAuth);
    expect(res.statusCode, res.body.slice(0, 300)).toBe(200);
    const body = res.json() as Json;
    expect(Array.isArray(body[c.legacyKey])).toBe(true);
    expect(body.items).toBeUndefined();
  });
});

describe("ADR-0226 batch C: details", () => {
  it("an unknown parent is the route's own 404, for the page and the export", async () => {
    const nil = "00000000-0000-4000-8000-000000000000";
    for (const [url, code] of [
      [`/v1/webhooks/${nil}/deliveries?limit=10&count=exact`, "unknown_webhook"],
      [`/v1/executors/${nil}/attestations?limit=10&count=exact`, "executor_not_found"],
      [`/v1/mcp-registries/${nil}/entries?limit=10&count=exact`, "unknown_registry"],
      [`/v1/cost-imports/${nil}?limit=10&count=exact`, "unknown_import"],
      [`/v1/scheduler/jobs/nope-${RUN}/runs?limit=10&count=exact`, "unknown_scheduler_job"],
    ] as const) {
      const res = await get(url, adminAuth);
      expect(res.statusCode, url).toBe(404);
      expect(res.json().error).toBe(code);
    }
  });

  it("the inbox search runs on the server and matches % and _ literally", async () => {
    const hit = await get(`/v1/builder/threads?limit=10&count=exact&q=${encodeURIComponent("Thread 1")}`, adminAuth);
    expect(hit.statusCode).toBe(200);
    const titles = (hit.json().items as Json[]).map((t) => t.title as string);
    expect(titles.length).toBeGreaterThan(0);
    expect(titles.every((t) => t.includes("Thread 1"))).toBe(true);
    const literal = await get(`/v1/builder/threads?limit=10&count=exact&q=${encodeURIComponent("%")}`, adminAuth);
    expect(literal.json().total).toBe(0);
  });

  it("a bootstrap credential with no identity is refused the inbox, as before", async () => {
    expect((await get("/v1/builder/threads?limit=10&count=exact", BOOT_AUTH)).statusCode).toBe(403);
  });

  it("the change-requests page carries the intake form's routable types", async () => {
    const body = (await get("/v1/workflows/instances?limit=10&count=exact", adminAuth)).json() as Json;
    expect(Array.isArray(body.changeTypes)).toBe(true);
    expect(Array.isArray(body.routes)).toBe(true);
  });

  it("the deliveries export never carries the payload, and the MCP export never the server URL", async () => {
    const d = await get(`/v1/webhooks/${ids.webhook}/deliveries/export.xlsx?columns=payload`, adminAuth);
    expect(d.statusCode).toBe(400);
    const m = await get(`/v1/mcp/admission/export.xlsx?columns=url`, adminAuth);
    expect(m.statusCode).toBe(400);
  });

  it("findings sort worst first by default", async () => {
    const body = (await get("/v1/infra/findings?limit=50&count=exact", adminAuth)).json() as Json;
    const rank = { critical: 4, high: 3, medium: 2, low: 1 } as Record<string, number>;
    const ranks = (body.items as Json[]).map((f) => rank[f.severity as string]!);
    expect(ranks).toEqual([...ranks].sort((a, b) => b - a));
  });
});
