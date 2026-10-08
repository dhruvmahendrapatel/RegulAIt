/**
 * Demo-dataset seeder. Idempotent: safe to re-run — existing objects are
 * found by name/email and reused; only API keys (and the PM webhook secret)
 * are always minted fresh and printed exactly once, like every secret in the
 * product.
 *
 * Deliberately drives the REAL HTTP API via app.inject rather than raw
 * inserts, so seeding exercises exactly the validation and governance the
 * product enforces. Mock-provider agents and the mock PM provider make the
 * playground fully usable with ZERO external credentials; the real-provider
 * agents become dispatchable the moment a credential is added in the admin
 * portal.
 *
 * The dataset is sized so every admin panel and every /app page has something
 * true to show on first open, and so the demo still has work left to DO:
 * Avery has a sign-off waiting, Dana has a node awaiting review and a
 * context conflict to arbitrate, and both have a run they can drive further.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb, runMigrations, backupRuns, eq } from "@regulait/db";
import { auditLog, mcpServers } from "@regulait/db"; // ADR-0181 (SC): seedStrictAdmission
import { buildApp } from "./app.js";
import { ensureEphemeralLicense } from "./ephemeral-license.js";
import { dataKeyFormatError } from "./secrets.js";
import { demoKeyExpiresAt, revokeScriptKeys, SEED_PERSONA_KEY_TTL_DAYS, seedStrictIdentity } from "./demo-identity.js";
import { enrolAdminTotp, type AdminTotpEnrolment } from "./demo-identity.js"; // ADR-0181 (FX2): seedAdminMfa
import { ensureDemoModelCards } from "./demo-strict-governance.js";
import { openAssuranceGuardrailWindow, seedStrictData } from "./seed-strict-data.js";
import { assuranceAgentNames } from "./demo-intake-seed-lib.js"; // B4S-06: --open-assurance-window
import * as sharedForFixtures from "@regulait/shared";
import type { DemoIntakeFixtures } from "@regulait/shared";
import { demoSeedRefusal, demoSeedSignal, realAdminEmails } from "./seed-demo-guard.js"; // ADR-0181 FX3

const connectionString =
  process.env.DATABASE_URL ?? "postgres://regulait:regulait@localhost:5432/regulait";
const BOOT = process.env.REGULAIT_BOOTSTRAP_TOKEN ?? "seed-bootstrap";
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = process.env.REGULAIT_DATA_KEY;

// The seeder builds an app directly rather than going through `startGateway`,
// so ADR-0063's boot gate never runs here — deliberately, because constructing
// an app is not putting a deployment into service (see boot.ts). The cost of
// that, found by making the mistake: a malformed REGULAIT_DATA_KEY sailed
// through migrations and most of the seed and then surfaced as
// `POST /v1/git/connections -> 500 {"error":"internal"}`, an opaque failure
// several minutes after the actual error. The seeder is usually the FIRST
// thing an operator runs on a new deployment, which makes it the first place
// the key can be wrong and the best place to say so.
//
// This checks the value's SHAPE only. It is not the custody gate and must not
// become one: continuity is a question about a database in service, and the
// seeder's whole job is to populate one that is not yet.
if (DATA_KEY !== undefined && DATA_KEY.trim() !== "") {
  const problem = dataKeyFormatError(DATA_KEY);
  if (problem !== null) {
    console.error(
      `\nREGULAIT_DATA_KEY is set, but ${problem}\n\n` +
        `  Nothing has been seeded. Mint one with \`openssl rand -hex 32\` and use the SAME value ` +
        `in every terminal — the gateway, the seeder and demo:setup all encrypt under it, and a ` +
        `different key in one of them writes ciphertext the others cannot read.\n`,
    );
    process.exit(1);
  }
}

// AER-047: the seeded demo drives check stages nobody reports (there is no CI
// in the demo), and those templates opt in to the labelled offline auto-pass.
// The opt-in FAILS CLOSED — a process must declare offline mode for it to be
// honoured — so the seeder declares it for ITS OWN in-process app. It changes
// nothing else: a box that shows a sign of being deployed still refuses the
// opt-in (the seeded instances then wait at their check stage), an explicit
// REGULAIT_OFFLINE_CHECKS=0 is respected, and the gateway the presenter starts
// afterwards must declare it itself (DEMO_SCRIPT §0 exports it).
process.env.REGULAIT_OFFLINE_CHECKS ??= "1";

// ===== ADR-0181 FX3: the demo seed needs an explicit demo signal ============
// Checked before a pool exists; the real-admin check below runs before
// migrations, so a refusal writes nothing. See seed-demo-guard.ts.
const demoSignal = demoSeedSignal(process.argv.slice(2), process.env);
{
  const refusal = demoSeedRefusal(demoSignal, []);
  if (refusal) {
    console.error(`\n${refusal}\n`);
    process.exit(2);
  }
}
// ===== end ADR-0181 FX3 =====================================================

const db = createDb(connectionString);
// An idle pooled connection killed out from under us (e.g. a scratch database
// dropped WITH (FORCE) right after seeding finishes) must not crash the
// process via an unhandled 'error' event — all real query failures still
// surface through their own awaited promises.
(db.$client as { on: (ev: string, fn: (err: Error) => void) => void }).on("error", () => {});
// ===== ADR-0181 FX3: never seed a database a real admin uses ================
{
  const refusal = demoSeedRefusal(demoSignal, await realAdminEmails(db));
  if (refusal) {
    console.error(`\n${refusal}\n`);
    await db.$client.end();
    process.exit(2);
  }
  console.log(`demo seed: explicit demo signal ${demoSignal}; no admin outside the demo personas`);
}
// ===== end ADR-0181 FX3 =====================================================
await runMigrations(
  db,
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations"),
);
const app = buildApp(db, {
  bootstrapToken: BOOT,
  dataKey: DATA_KEY,
});

type Json = Record<string, any>;
async function call(method: string, url: string, payload?: unknown, headers = AUTH): Promise<Json> {
  const res = await app.inject({ method: method as "GET", url, headers, ...(payload ? { payload } : {}) });
  if (res.statusCode >= 400 && res.statusCode !== 409) {
    throw new Error(`${method} ${url} -> ${res.statusCode}: ${res.body}`);
  }
  try {
    return res.json();
  } catch {
    return {};
  }
}

// ADR-0181 (SB1): the guardrails / data / runtime strict-default configuration the demo needs
for (const line of (await seedStrictData(app, { bootstrapToken: BOOT })).lines) console.log(line);

// --- users ---------------------------------------------------------------
async function ensureUser(email: string, displayName: string, isAdmin = false): Promise<string> {
  const existing = (await call("GET", "/v1/users")).users?.find((u: Json) => u.email === email);
  if (existing) return existing.id;
  const created = await call("POST", "/v1/users", { email, displayName, isAdmin });
  return created.id;
}
const adminId = await ensureUser("admin@regulait.local", "Ada Admin", true);
const danaId = await ensureUser("dana@regulait.local", "Dana Developer");
const averyId = await ensureUser("avery@regulait.local", "Avery Approver");

// --- ADR-0030: usernames for the personas (sign in as `admin`, not an email)
// Set through the REAL audited admin route, so seeding exercises the same
// validation, uniqueness check and audit row a human admin would produce. It
// is idempotent by nature: re-setting the same username on the same user is a
// no-op write (the uniqueness check excludes the target itself).
for (const [username, id] of [
  ["admin", adminId],
  ["dana", danaId],
  ["avery", averyId],
] as const) {
  await call("PUT", `/v1/users/${id}/username`, { username });
}

// --- ADR-0025: ONE-TIME passwords for the personas (browser sign-in) -------
// Issued only while the account is still passwordless, so a re-seed never
// overwrites a password a human set for real (the endpoint 409s without
// force, and call() tolerates 409). Printed exactly once, like the keys;
// must_change_password forces a real password at first sign-in.
// B4S-06: issuing another person's password needs a settings_relax step-up,
// which the bootstrap credential passes only during FIRST-ADMIN SETUP — before
// any admin can step up. So Dana's and Avery's are issued here, before Ada
// enrols her authenticator; Ada's comes from her own enrolment below.
const passwords: Record<string, string> = {};
{
  const userRows = (await call("GET", "/v1/users")).users ?? [];
  for (const [name, id] of [
    ["dana", danaId],
    ["avery", averyId],
  ] as const) {
    const row = userRows.find((u: Json) => u.id === id);
    if (row?.hasPassword) {
      passwords[name] = "(already set — unchanged)";
      continue;
    }
    const res = await call("POST", `/v1/users/${id}/set-initial-password`);
    passwords[name] = res.password ?? "(already set — unchanged)";
  }
}

// --- agent catalog -------------------------------------------------------
// Model-id freshness (B1.5, LIVE_VERIFICATION_2026-08): pinned provider model
// ids AGE OUT — Google retired `gemini-2.5-pro` for new accounts and the
// out-of-box "google goes live via env fallback" demo 502'd until the id was
// refreshed to `gemini-3.6-flash` (proven working in the live run). Re-seed
// semantics are unchanged and deliberate: an EXISTING agent row is matched by
// name and never mutated (below), so refreshing an already-seeded database is
// an admin act — `PATCH /v1/agents/:agentId` (the versioned agent_config edit
// path), never a silent seed-side rewrite of rows an operator may have tuned.
const AGENTS = [
  { name: "fast-mock", provider: "mock", tier: 0, costPerMTokIn: 1, costPerMTokOut: 5, model: "mock-fast" },
  { name: "balanced-mock", provider: "mock", tier: 1, costPerMTokIn: 3, costPerMTokOut: 15, model: "mock-balanced" },
  { name: "premium-mock", provider: "mock", tier: 2, costPerMTokIn: 15, costPerMTokOut: 75, model: "mock-premium" },
  { name: "claude-opus", provider: "anthropic", tier: 2, costPerMTokIn: 5, costPerMTokOut: 25, model: "claude-opus-5" },
  { name: "gpt-5", provider: "openai", tier: 2, costPerMTokIn: 2, costPerMTokOut: 8, model: "gpt-5" },
  { name: "gemini-pro", provider: "google", tier: 1, costPerMTokIn: 1.25, costPerMTokOut: 10, model: "gemini-3.6-flash" },
  { name: "grok", provider: "xai", tier: 1, costPerMTokIn: 3, costPerMTokOut: 15, model: "grok-4" },
];
const catalog = (await call("GET", "/v1/agents")).agents ?? [];
const agentIds: Record<string, string> = {};
for (const spec of AGENTS) {
  const existing = catalog.find((a: Json) => a.name === spec.name);
  agentIds[spec.name] = existing ? existing.id : (await call("POST", "/v1/agents", spec)).id;
}
for (const userId of [adminId, danaId, averyId]) {
  for (const agentId of Object.values(agentIds)) {
    await call("POST", "/v1/grants/agents", { userId, agentId }); // 409 dup = fine
  }
}

/** the agents whose stewardship review Ada records today, once her key exists */
const reviewToday: string[] = [];
// --- ADR-0168 item 6: agent stewardship ----------------------------------
// B4S-06: naming a steward is an owner change (an owner_change step-up), which
// the bootstrap credential passes only during first-admin setup — so this runs
// BEFORE Ada enrols her authenticator. The reviews she records today run after
// her key exists (below).
// Every seeded agent gets a named steward, a successor and a staggered next
// review, through the REAL audited routes — except `grok`, deliberately left
// with NO steward (only a successor) so the inventory shows one "Orphaned"
// flag and the demo's unowned-agent alert (an approved use case runs on grok)
// keeps its executable "assign an owner" remediation. Converges on re-seed:
// an agent that already carries any stewardship record is left alone, so a
// human's later decisions are never overwritten.
{
  const DAY = 86_400_000;
  const STEWARDSHIP: Record<string, { steward: string | null; successor: string; reviewInDays: number | "record" }> = {
    "fast-mock": { steward: adminId, successor: danaId, reviewInDays: 74 },
    "balanced-mock": { steward: adminId, successor: danaId, reviewInDays: "record" },
    "premium-mock": { steward: adminId, successor: averyId, reviewInDays: 131 },
    "claude-opus": { steward: danaId, successor: adminId, reviewInDays: "record" },
    "gpt-5": { steward: danaId, successor: adminId, reviewInDays: 46 },
    "gemini-pro": { steward: averyId, successor: adminId, reviewInDays: 158 },
    grok: { steward: null, successor: danaId, reviewInDays: 102 },
  };
  const rows: Json[] = (await call("GET", "/v1/agents")).agents ?? [];
  for (const [name, plan] of Object.entries(STEWARDSHIP)) {
    const row = rows.find((a) => a.name === name);
    if (!row || row.ownerUserId || row.successorUserId || row.nextReviewAt || row.lastReviewedAt) continue;
    await call("PATCH", `/v1/agents/${row.id}/stewardship`, {
      ...(plan.steward ? { stewardUserId: plan.steward } : {}),
      successorUserId: plan.successor,
      ...(typeof plan.reviewInDays === "number"
        ? { nextReviewAt: new Date(Date.now() + plan.reviewInDays * DAY).toISOString() }
        : {}),
    });
    if (plan.reviewInDays === "record") reviewToday.push(row.id);
  }
}

// B4S-06 — `--open-assurance-window` (passed by demo:prepare only): the
// assurance run demo:intake makes needs the prompt-injection and jailbreak
// guardrails at `warn` on the agents under test (seed-strict-data.ts), and
// relaxing a guardrail needs a settings_relax step-up. The bootstrap credential
// passes that only during FIRST-ADMIN SETUP, which ends the moment Ada enrols
// her authenticator just below — after it, only Ada could, and she cannot act
// until the presenter replaces her one-time password. So the deployment
// operator opens the time-boxed window HERE (audited, expires on the server
// after ASSURANCE_WINDOW_TTL_MINUTES), and demo:intake keeps it, runs the
// tests and closes it. A plain `seed` (the e2e harness) opens nothing.
if (process.argv.includes("--open-assurance-window")) {
  const fixtures = (sharedForFixtures as unknown as { DEMO_INTAKE_FIXTURES?: DemoIntakeFixtures }).DEMO_INTAKE_FIXTURES;
  const agentRows: Json[] = (await call("GET", "/v1/agents")).agents ?? [];
  const ids = fixtures
    ? assuranceAgentNames(fixtures, new Map(agentRows.map((a) => [a.name as string, a.provider as string])))
        .map((n) => agentRows.find((a) => a.name === n)?.id as string | undefined)
        .filter((id): id is string => Boolean(id))
    : [];
  const inject = async (method: string, url: string, payload?: unknown, headers: Record<string, string> = AUTH) => {
    const r = await app.inject({ method: method as "GET", url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });
    let body: Json = {};
    try {
      body = r.json();
    } catch {
      /* 204 */
    }
    return { status: r.statusCode, body };
  };
  const window = await openAssuranceGuardrailWindow(inject, AUTH, ids);
  for (const n of window.notes) console.log(`  ${n}`);
}

// ADR-0181 (FX2): Ada enrols TOTP before any key is minted for her — an
// un-enrolled admin's key is refused, and none is issued (seedAdminMfa below)
const adminMfa = await seedAdminMfa(adminId);

const keys: Record<string, string> = {};
const keyIds: Record<string, string> = {};
for (const [name, id] of [
  ["admin", adminId],
  ["dana", danaId],
  ["avery", averyId],
] as const) {
  // ADR-0181 (FX2): an admin who has not enrolled TOTP is issued no key
  if (name === "admin" && adminMfa.status === "refused") continue;
  const minted = await call("POST", `/v1/users/${id}/keys`, { name: "seed", expiresAt: demoKeyExpiresAt(SEED_PERSONA_KEY_TTL_DAYS) });
  keys[name] = minted.token;
  keyIds[name] = minted.id;
}
const danaAuth = { authorization: `Bearer ${keys.dana}` };
const averyAuth = { authorization: `Bearer ${keys.avery}` };

// a review recorded today (by Ada) schedules the next one by the cadence
if (keys.admin) {
  const adaAuth = { authorization: `Bearer ${keys.admin}` };
  for (const id of reviewToday) await call("POST", `/v1/agents/${id}/stewardship/review`, {}, adaAuth);
}
// ADR-0181 (FX2): Ada's one-time password was issued by her TOTP enrolment
if (adminMfa.status === "enrolled") passwords.admin = adminMfa.password;
else {
  const ada = ((await call("GET", "/v1/users")).users ?? []).find((u: Json) => u.id === adminId);
  passwords.admin = ada?.hasPassword ? "(already set — unchanged)" : "(not issued — see the admin TOTP line)";
}

// ADR-0181: that was the last use of Ada's seed key. An admin-owned API key
// carries administrator power on every admin route, so the stale-credential
// monitor flags it as over-scoped (a true finding). It is revoked here rather
// than handed to the presenter; Dana's and Avery's keys (not admins) are kept.
for (const n of await revokeScriptKeys(app, BOOT, [keyIds.admin])) console.log(`  ${n}`);

// --- per-user agent policy (§4 default + ceiling, §5.2 run budget) -------
// Upsert, so re-running converges rather than duplicating. The ceilings are
// real: Avery is capped at tier 1, so the premium/frontier agents are denied
// for him even though he holds a grant for every one of them.
await call("POST", `/v1/users/${danaId}/agent-policy`, {
  defaultAgentId: agentIds["balanced-mock"],
  ceilingAgentId: agentIds["premium-mock"],
  routingMode: "automatic",
  runBudgetUsd: 0.25,
  runBudgetBreachAction: "approve",
});
await call("POST", `/v1/users/${averyId}/agent-policy`, {
  defaultAgentId: agentIds["fast-mock"],
  ceilingAgentId: agentIds["balanced-mock"],
  routingMode: "automatic",
  runBudgetUsd: 0.1,
  runBudgetBreachAction: "replan",
});

// --- MCP servers + tool inventory ----------------------------------------
// Hostnames are deliberately unreachable (RFC 2606 `.invalid`): registering a
// server and its tool inventory is a governance act and needs no live
// upstream — nothing here proxies anywhere.
await seedStrictAdmission(); // ADR-0181 (SC): demo admission + egress posture, block at the end of this file
const serverList = (await call("GET", "/v1/servers")).servers ?? [];
async function ensureServer(name: string, url: string): Promise<string> {
  const existing = serverList.find((s: Json) => s.name === name);
  if (existing) return existing.id;
  return (await call("POST", "/v1/servers", { name, url })).id;
}
// ADR-0043: demo registry rows are never connected to, but /v1/servers now
// runs the egress guard at write time and RESOLVES every destination — a
// `.invalid` hostname fails closed. The loopback dead port (discard) is
// permitted by the demo allow-list entry seedStrictAdmission adds (ADR-0181).
const repoServerId = await ensureServer("repo-tools", "http://127.0.0.1:9/repo-mcp");
const warehouseServerId = await ensureServer("data-warehouse", "http://127.0.0.1:9/warehouse-mcp");

async function ensureTools(
  serverId: string,
  tools: Array<{ name: string; kind: "read" | "write"; description: string }>,
): Promise<void> {
  const have = new Set(
    ((await call("GET", `/v1/servers/${serverId}/tools`)).tools ?? []).map((t: Json) => t.name),
  );
  for (const tool of tools) {
    if (!have.has(tool.name)) await call("POST", `/v1/servers/${serverId}/tools`, tool);
  }
}
await ensureTools(repoServerId, [
  { name: "read_file", kind: "read", description: "read one file at a ref" },
  { name: "search_code", kind: "read", description: "regex search across the repository" },
  { name: "list_branches", kind: "read", description: "list branches and their heads" },
  { name: "write_file", kind: "write", description: "commit a file change to a branch" },
  { name: "delete_branch", kind: "write", description: "delete a branch (destructive)" },
]);
await ensureTools(warehouseServerId, [
  { name: "list_schemas", kind: "read", description: "list schemas visible to the connection" },
  { name: "query", kind: "read", description: "run a read-only SQL query against a schema" },
  { name: "export_table", kind: "write", description: "materialize a table to object storage" },
]);

// --- roles, per-user tool grants, per-user revocations (§5) ---------------
// The precedence story, visible in one table: a role hands out a read-only
// baseline, a direct per-user grant adds one write tool on top, and a
// revocation subtracts a role-derived tool for one person only. Direct grants
// survive a revocation by design — a direct grant IS an explicit override.
const roleList = (await call("GET", "/v1/roles")).roles ?? [];
async function ensureRole(name: string, description: string): Promise<string> {
  const existing = roleList.find((r: Json) => r.name === name);
  if (existing) return existing.id;
  return (await call("POST", "/v1/roles", { name, description })).id;
}
const analystRoleId = await ensureRole(
  "repo-analyst",
  "read-only across repo-tools, plus warehouse query",
);
await call("POST", `/v1/roles/${analystRoleId}/grants/servers`, {
  serverId: repoServerId,
  readOnlyAll: true,
}); // 409 dup = fine
await call("POST", `/v1/roles/${analystRoleId}/grants/tools`, {
  serverId: warehouseServerId,
  toolName: "query",
});
for (const userId of [danaId, averyId]) {
  await call("POST", `/v1/users/${userId}/roles`, { roleId: analystRoleId });
}

for (const [userId, serverId, toolName] of [
  [danaId, repoServerId, "write_file"],
  [danaId, warehouseServerId, "export_table"],
  [averyId, repoServerId, "read_file"],
] as const) {
  await call("POST", "/v1/grants/tools", { userId, serverId, toolName });
}
// Dana loses one tool out of the role's read-only-all; Avery loses the role's
// warehouse tool grant. Both deviations stay flagged, never silent.
await call("POST", "/v1/revocations", { userId: danaId, serverId: repoServerId, toolName: "search_code" });
await call("POST", "/v1/revocations", { userId: averyId, serverId: warehouseServerId, toolName: "query" });

// --- policy rules: approvals, data scopes, rate limits (§3) --------------
// None of the three rule tables has a natural unique key, so each rule is
// matched on its scope before it is written.
const scopeMatches = (r: Json, userId: string, serverId: string, toolName: string | null) =>
  r.userId === userId && r.serverId === serverId && (r.toolName ?? null) === toolName;

const existingApprovalRules = (await call("GET", "/v1/rules/approvals")).rules ?? [];
if (!existingApprovalRules.some((r: Json) => scopeMatches(r, danaId, repoServerId, "write_file"))) {
  // a governed write_file call by Dana pauses for Avery's sign-off
  await call("POST", "/v1/rules/approvals", {
    userId: danaId,
    serverId: repoServerId,
    toolName: "write_file",
    approverUserId: averyId,
  });
}
if (!existingApprovalRules.some((r: Json) => scopeMatches(r, averyId, warehouseServerId, null))) {
  await call("POST", "/v1/rules/approvals", {
    userId: averyId,
    serverId: warehouseServerId,
    writeOnly: true,
    approverUserId: adminId,
  });
}

const existingScopeRules = (await call("GET", "/v1/rules/data-scopes")).rules ?? [];
if (!existingScopeRules.some((r: Json) => scopeMatches(r, danaId, warehouseServerId, "query"))) {
  await call("POST", "/v1/rules/data-scopes", {
    userId: danaId,
    serverId: warehouseServerId,
    toolName: "query",
    argPath: "schema",
    allowedValues: ["analytics", "reporting"],
  });
}

const existingRateLimits = (await call("GET", "/v1/rules/rate-limits")).rules ?? [];
if (!existingRateLimits.some((r: Json) => scopeMatches(r, danaId, repoServerId, null))) {
  await call("POST", "/v1/rules/rate-limits", {
    userId: danaId,
    serverId: repoServerId,
    maxCalls: 120,
    windowSeconds: 3600,
  });
}
if (!existingRateLimits.some((r: Json) => scopeMatches(r, averyId, warehouseServerId, "query"))) {
  await call("POST", "/v1/rules/rate-limits", {
    userId: averyId,
    serverId: warehouseServerId,
    toolName: "query",
    maxCalls: 30,
    windowSeconds: 3600,
  });
}

// --- PILLAR 1 rule scoping: rules beyond one user × one server -------------
// A FLEET approval rule and a ROLE-scoped rate limit sit alongside the
// user-specific rules above, so the Policy & Rules tab shows a mix of scopes
// and a governed WRITE by anyone — even a user with no user-specific rule —
// pauses org-wide. These are pure RESTRICTIONS: they only ever ADD a
// require_approval / cap, never rescue an ungranted call.
if (!existingApprovalRules.some((r: Json) => r.scope === "fleet")) {
  // any write tool, on any server, by any user requires the admin's sign-off
  await call("POST", "/v1/rules/approvals", {
    scope: "fleet",
    serverScope: "all",
    writeOnly: true,
    approverUserId: adminId,
  });
}
if (!existingRateLimits.some((r: Json) => r.scope === "role" && r.roleId === analystRoleId)) {
  // the repo-analyst role is capped org-wide (all servers) — a generous cap so
  // it demonstrates a role-scoped, all-servers limit without denying the demo
  await call("POST", "/v1/rules/rate-limits", {
    scope: "role",
    roleId: analystRoleId,
    serverScope: "all",
    maxCalls: 500,
    windowSeconds: 3600,
  });
}

// --- connectors (§2) -----------------------------------------------------
const connectorList = (await call("GET", "/v1/connectors")).connectors ?? [];
async function ensureConnector(name: string, kind: string, extras: Json = {}): Promise<string> {
  const existing = connectorList.find((c: Json) => c.name === name);
  if (existing) return existing.id;
  return (await call("POST", "/v1/connectors", { name, kind, ...extras })).id;
}
// jira-cloud stays GOVERNANCE-ONLY (no providerKind) — decision + audit, no
// execution, no cost. snowflake-analytics gets the keyless 'mock' adapter and a
// flat price, so it EXECUTES and METERS with zero external keys: one demoable
// connector in each mode side by side.
const jiraConnectorId = await ensureConnector("jira-cloud", "issue-tracker");
const warehouseConnectorId = await ensureConnector("snowflake-analytics", "data-warehouse", {
  providerKind: "mock",
  pricePerCallUsd: 0.002,
});
for (const grant of [
  { userId: danaId, connectorId: jiraConnectorId, mode: "readwrite", allowedObjects: ["issue", "comment"] },
  { userId: danaId, connectorId: warehouseConnectorId, mode: "read" },
  { userId: averyId, connectorId: jiraConnectorId, mode: "read" },
]) {
  await call("POST", "/v1/grants/connectors", grant); // 409 dup = fine
}

// --- workflow templates + assignment + compliance ------------------------
const templates = (await call("GET", "/v1/workflows/templates")).templates ?? [];
async function ensureTemplate(name: string, definition: unknown): Promise<string> {
  const existing = templates.find((t: Json) => t.name === name);
  if (existing) return existing.id;
  return (await call("POST", "/v1/workflows/templates", { name, definition })).id;
}
const standardTpl = await ensureTemplate("standard-change", {
  workflow: "standard-change",
  stages: [
    { id: "intake", type: "trigger" },
    { id: "plan", type: "planning" },
    { id: "requirements", type: "artifact_generation", output: "requirements_file" },
    { id: "signoff", type: "human_approval", approvers: [averyId] },
  ],
});
const sensitiveTpl = await ensureTemplate("sensitive-data", {
  workflow: "sensitive-data",
  stages: [
    { id: "sd-intake", type: "trigger" },
    { id: "compliance-signoff", type: "human_approval", approvers: [averyId] },
  ],
});

// The complete-pipeline template (§2 end-to-end): intake → plan → requirements
// artifact → Avery's sign-off → automated build as a NESTED RUN on the mock
// agents → automated checks (no CI in the demo: the stage opts in to the
// labelled offline auto-pass, AER-047 — honoured only by a gateway started with
// REGULAIT_OFFLINE_CHECKS=1) →
// branch → PR → merge gate (Avery) → squash merge. Git stages run against the
// MOCK git provider — the whole chain is drivable with zero external
// credentials. The connection token below is an obvious dummy, encrypted at
// rest like any other.
if (DATA_KEY) {
  const gitConns = (await call("GET", "/v1/git/connections")).connections ?? [];
  if (!gitConns.some((c: Json) => c.name === "demo-git")) {
    await call("POST", "/v1/git/connections", {
      name: "demo-git",
      provider: "mock",
      token: "mock-token-not-a-real-credential",
    });
  }
}
const pipelineTpl = await ensureTemplate("complete-pipeline", {
  workflow: "complete-pipeline",
  stages: [
    { id: "intake", type: "trigger" },
    { id: "plan", type: "planning" },
    { id: "requirements", type: "artifact_generation", output: "requirements_file" },
    { id: "signoff", type: "human_approval", approvers: [averyId] },
    {
      id: "build",
      type: "automated_build",
      scope: "requirements_file",
      run: {
        run: "pipeline-build",
        escalationApproverUserId: averyId,
        nodes: [
          { id: "implement", title: "Implement the signed-off requirements", ownerAgentId: agentIds["balanced-mock"], mode: "execute", estimate: { in: 600, out: 1200 } },
          { id: "self-review", title: "Review the implementation against the requirements", ownerAgentId: agentIds["fast-mock"], mode: "execute", dependsOn: ["implement"], estimate: { in: 300, out: 600 } },
        ],
      },
    },
    // AER-047: the demo has no CI posting results, so this stage opts in to
    // the labelled offline auto-pass explicitly — every result reads
    // "auto-passed — no report (offline mode)" on the rail and in the merge
    // gate. Without the opt-in an unreported check is pending and waits.
    { id: "checks", type: "automated_check", checks: ["unit_tests", "lint", "security_scan"], offlineAutoPass: true },
    { id: "branch", type: "git_operation", action: "create_branch", connection: "demo-git", repo: "acme/checkout" },
    { id: "open_pr", type: "git_operation", action: "open_pr", connection: "demo-git", repo: "acme/checkout" },
    { id: "merge_gate", type: "human_approval", approvers: [averyId] },
    { id: "merge", type: "git_operation", action: "merge", connection: "demo-git", repo: "acme/checkout", strategy: "squash" },
  ],
});
const rules = (await call("GET", "/v1/workflows/assignment-rules")).rules ?? [];
if (!rules.some((r: Json) => r.templateId === standardTpl)) {
  await call("POST", "/v1/workflows/assignment-rules", { templateId: standardTpl, changeType: "feature" });
}
if (!rules.some((r: Json) => r.templateId === pipelineTpl)) {
  await call("POST", "/v1/workflows/assignment-rules", { templateId: pipelineTpl, changeType: "pipeline-demo" });
}
await call("POST", "/v1/compliance/profiles", {
  tag: "hipaa",
  requiredTemplateIds: [sensitiveTpl],
  piiMode: "block",
  auditRetentionDays: 2555,
  mcpDefaultMode: "read_only",
  // §8.3 -> §8.2 (pillar 3): the infra floors this framework forces onto any
  // resource carrying the 'hipaa' tag. 2555d backup retention, 30d patch cadence.
  backupRetentionDays: 2555,
  patchCadenceDays: 30,
});

// --- teams (§9 provenance) -----------------------------------------------
const teamList = (await call("GET", "/v1/teams")).teams ?? [];
async function ensureTeam(name: string, defaultClassifications?: string[]): Promise<string> {
  const existing = teamList.find((t: Json) => t.name === name);
  if (existing) return existing.id;
  return (await call("POST", "/v1/teams", {
    name,
    ...(defaultClassifications ? { defaultClassifications } : {}),
  })).id;
}
const platformTeamId = await ensureTeam("platform-eng");
const clinicalTeamId = await ensureTeam("clinical-data", ["hipaa"]);
for (const [teamId, userId] of [
  [platformTeamId, danaId],
  [platformTeamId, adminId],
  [clinicalTeamId, averyId],
  [clinicalTeamId, adminId],
] as const) {
  await call("POST", `/v1/teams/${teamId}/members`, { userId }); // 409 dup = fine
}

// --- projects ------------------------------------------------------------
// Budgets are scaled to the seeded demo spend below, so budget-vs-actual is a
// real reading rather than a rounding error against a placeholder cap.
const projectList = (await call("GET", "/v1/projects")).projects ?? [];
async function ensureProject(payload: Json): Promise<string> {
  const existing = projectList.find((p: Json) => p.name === payload.name);
  if (existing) return existing.id;
  return (await call("POST", "/v1/projects", payload)).id;
}
const demoProjectId = await ensureProject({
  name: "demo-project",
  costCenter: "CC-0001",
  budgetUsd: 0.2,
  budgetApproverUserId: averyId,
  // pillar-5 polish: a calendar-month budget window with a modest 80% warn
  // threshold, so the "this month" gauge and the non-blocking alert are both
  // demoable against the seeded spend (which lands in the current month).
  budgetPeriod: "monthly",
  alertThresholdPct: 80,
  // §9 arbiter: Dana owns the domain, so shared-context conflicts land on her
  arbiterUserId: danaId,
});
// idempotent on re-seed: ensureProject returns an existing row unchanged, so
// carry the period/threshold onto a demo-project created before this slice.
await call("PATCH", `/v1/projects/${demoProjectId}`, {
  budgetPeriod: "monthly",
  alertThresholdPct: 80,
});
const hipaaProjectId = await ensureProject({
  name: "hipaa-project",
  costCenter: "CC-0002",
  budgetUsd: 0.1,
  budgetApproverUserId: averyId,
  arbiterUserId: averyId,
  classifications: ["hipaa"],
});
// Membership carries the contributing team, so every context write inherits
// provenance without anyone having to state it.
for (const [projectId, userId, role, teamId] of [
  // demo-project intentionally carries TWO owners (Dana + admin) so the
  // membership-lifecycle demo can demote/remove one owner and still leave the
  // project with an owner — the last-owner block is demoable on hipaa-project,
  // where admin is the sole owner.
  [demoProjectId, danaId, "owner", platformTeamId],
  [demoProjectId, averyId, "contributor", null],
  [demoProjectId, adminId, "owner", platformTeamId],
  [hipaaProjectId, danaId, "contributor", platformTeamId],
  [hipaaProjectId, averyId, "contributor", clinicalTeamId],
  [hipaaProjectId, adminId, "owner", clinicalTeamId],
] as const) {
  await call("POST", `/v1/projects/${projectId}/members`, { userId, role, teamId }); // 409 dup = fine
}

// --- initiatives (pillar-5 cross-team rollup) ----------------------------
// A flat, reporting-only grouping of projects for chargeback/showback above
// the single-project level. Grouping is idempotent and changes no governance.
const initiativeList = (await call("GET", "/v1/initiatives")).initiatives ?? [];
async function ensureInitiative(name: string, costCenter?: string): Promise<string> {
  const existing = initiativeList.find((i: Json) => i.name === name);
  if (existing) return existing.id;
  return (await call("POST", "/v1/initiatives", { name, ...(costCenter ? { costCenter } : {}) })).id;
}
const platformInitiativeId = await ensureInitiative("Platform Modernization", "CC-PLAT");
// Group the demo project under it — only when it isn't already there, so a
// re-seed neither re-PATCHes nor overwrites a later manual regrouping.
const demoRow = ((await call("GET", "/v1/projects")).projects ?? []).find(
  (p: Json) => p.id === demoProjectId,
);
if (!demoRow?.initiativeId) {
  await call("PATCH", `/v1/projects/${demoProjectId}`, { initiativeId: platformInitiativeId });
}

// --- shared context (§9.2): accepted revisions + one live conflict --------
const demoCtx = (await call("GET", `/v1/projects/${demoProjectId}/context`)).context ?? [];
if (!demoCtx.some((c: Json) => c.key === "coding-standards")) {
  await call(
    "POST",
    `/v1/projects/${demoProjectId}/context`,
    {
      key: "coding-standards",
      teamId: platformTeamId,
      content:
        "TypeScript strict mode everywhere. No default exports. Errors are values at boundaries; " +
        "every external call is wrapped and surfaced, never swallowed.",
    },
    danaAuth,
  );
}
if (!demoCtx.some((c: Json) => c.key === "checkout-domain-notes")) {
  // rev 1 and rev 2 stack cleanly; rev 3 is written against the stale rev 1,
  // so it is RETAINED but not current and routed to the project's arbiter.
  await call(
    "POST",
    `/v1/projects/${demoProjectId}/context`,
    {
      key: "checkout-domain-notes",
      content:
        "Checkout owns the order total; the payment vault owns card data. " +
        "Nothing downstream of checkout may see a PAN.",
    },
    averyAuth,
  );
  await call(
    "POST",
    `/v1/projects/${demoProjectId}/context`,
    {
      key: "checkout-domain-notes",
      baseRevision: 1,
      teamId: platformTeamId,
      content:
        "Checkout owns the order total; the payment vault owns card data. " +
        "Nothing downstream of checkout may see a PAN. Stored methods are vault tokens only, " +
        "scoped per customer and soft-deleted with the customer record.",
    },
    danaAuth,
  );
  await call(
    "POST",
    `/v1/projects/${demoProjectId}/context`,
    {
      key: "checkout-domain-notes",
      baseRevision: 1,
      content:
        "Checkout owns the order total; the payment vault owns card data. " +
        "Nothing downstream of checkout may see a PAN. Compliance additionally requires that " +
        "stored-method identifiers never appear in application logs.",
    },
    averyAuth,
  );
}
const hipaaCtx = (await call("GET", `/v1/projects/${hipaaProjectId}/context`)).context ?? [];
if (!hipaaCtx.some((c: Json) => c.key === "phi-handling")) {
  await call(
    "POST",
    `/v1/projects/${hipaaProjectId}/context`,
    {
      key: "phi-handling",
      teamId: clinicalTeamId,
      content:
        "PHI never leaves the clinical boundary. Exports carry identifiers, timestamps, " +
        "purpose-of-use codes and the requesting principal — never clinical content. " +
        "Every export is itself an audited event with a named requester.",
    },
    averyAuth,
  );
}

// --- infra operations (pillar 3 §8.2) ------------------------------------
// A keyless, mock-provider fleet: a control plane (drift + CVE), an agent
// runtime under a permissive policy (its LOW drift auto-remediates on scan,
// audited — no approval), two certs (one expiring HIGH, one already-EXPIRED
// CRITICAL that is ALWAYS approval-gated), and a HIPAA-classified backup target
// whose §8.3 cascade derives a 2555d retention FLOOR that overrides its own 30d
// policy. One scan through the real API materializes the mixed posture; the
// signature-uniqueness index makes a re-run idempotent.
const infraResList = (await call("GET", "/v1/infra/resources")).resources ?? [];
async function ensureInfraResource(name: string, kind: string, extras: Json = {}): Promise<string> {
  const existing = infraResList.find((r: Json) => r.name === name);
  if (existing) return existing.id;
  return (await call("POST", "/v1/infra/resources", { name, kind, provider: "mock", ...extras })).id;
}
await ensureInfraResource("control-plane-gateway", "control_plane");
const runtimeResId = await ensureInfraResource("agent-runtime-pool", "agent_runtime");
await ensureInfraResource("api-tls-cert", "cert", { config: { daysUntilExpiry: 5 } });
await ensureInfraResource("legacy-tls-cert", "cert", { config: { daysUntilExpiry: -2 } });
const backupResId = await ensureInfraResource("phi-backup-primary", "backup_target", {
  config: { hoursSinceLastBackup: 100 },
  classifications: ["hipaa"],
});
const infraPolList = (await call("GET", "/v1/infra/policies")).policies ?? [];
async function ensureInfraPolicy(resourceId: string, body: Json): Promise<void> {
  if (infraPolList.some((p: Json) => p.resourceId === resourceId)) return;
  await call("POST", "/v1/infra/policies", { resourceId, ...body });
}
// agent-runtime: a permissive ceiling of 'low' — its low drift auto-remediates.
await ensureInfraPolicy(runtimeResId, { autoRemediateMaxSeverity: "low", patchCadenceDays: 90 });
// backup target: a 30d retention policy the HIPAA cascade floor (2555d) overrides.
await ensureInfraPolicy(backupResId, { backupRetentionDays: 30, backupSchedule: "daily-0200" });
// One scan: detects the mix and auto-remediates only what the policy permits.
// Idempotent — a re-run refreshes detected_at, never duplicates a finding.
// ADR-0017: the scan also materializes the automation ledgers — cert_inventory
// (from the two certs), a patch_records CVE (from the control plane), and a
// 'missed' backup_runs row (from the phi backup target).
await call("POST", "/v1/infra/scan", {});

// ADR-0017: seed one SUCCESSFUL backup run so the run/restore ledger shows real
// history alongside the scan-detected 'missed' row. Direct insert (there is no
// success-run API surface); idempotent by the deterministic size marker.
{
  const existing = (await db.select().from(backupRuns).where(eq(backupRuns.resourceId, backupResId)))
    .filter((r) => r.status === "success");
  if (existing.length === 0) {
    const now = Date.now();
    await db.insert(backupRuns).values({
      resourceId: backupResId,
      kind: "backup",
      status: "success",
      startedAt: new Date(now - 26 * 3600_000),
      finishedAt: new Date(now - 26 * 3600_000 + 240_000),
      sizeBytes: 4_294_967_296,
      retentionUntil: new Date(now + 2555 * 86_400_000),
    });
  }
}

// --- PM connection (mock provider) ---------------------------------------
// EPIC-06 against the in-memory MOCK provider: no external service, no real
// credential. The token below is an obvious dummy and is encrypted at rest
// like any other; the webhook secret is returned exactly once, here.
let pmWebhookSecret: string | null = null;
if (DATA_KEY) {
  const pmList = (await call("GET", "/v1/pm/connections")).connections ?? [];
  if (!pmList.some((c: Json) => c.name === "demo-pm")) {
    const created = await call("POST", "/v1/pm/connections", {
      name: "demo-pm",
      provider: "mock",
      project: "REGULAIT-DEMO",
      token: "mock-token-not-a-real-credential",
    });
    pmWebhookSecret = created.webhookSecret ?? null;
  }
}

// --- ADR-0181 SB2: approved model cards (mrmEnforced is on by default) ------
for (const n of (await ensureDemoModelCards(app, { bootstrapToken: BOOT, averyAuth, averyId })).notes) console.log(`  ${n}`);

// --- demo activity: governed evaluations + real metered spend ------------
// Unlike every object above, activity is append-only by nature (audit rows
// and ledger rows are events, not entities), so it cannot be de-duplicated by
// name. It runs exactly once: on a database with no usage history yet.
const alreadyActive = ((await call("GET", "/v1/usage-events?limit=1")).events ?? []).length > 0;
if (!alreadyActive) {
  // Decision-only evaluations — no queue entries, no execution — so the audit
  // log opens on the full spread of outcomes the entitlement model produces.
  for (const [userId, serverId, toolName] of [
    [danaId, repoServerId, "read_file"], // allow — role read-only-all
    [danaId, repoServerId, "search_code"], // deny — per-user revocation beats the role
    [danaId, repoServerId, "write_file"], // require_approval — direct grant + approval rule
    [danaId, warehouseServerId, "export_table"], // require_approval — FLEET write rule (no user rule here)
    [averyId, repoServerId, "delete_branch"], // deny — nothing grants a write here
    [averyId, warehouseServerId, "query"], // deny — the role's grant is revoked for Avery
  ] as const) {
    await call("POST", "/v1/evaluate", { userId, serverId, toolName });
  }

  // Real, metered mock dispatches attributed to a project — this is what puts
  // numbers on the Cost & Projects dashboard. quality-sensitive requests are
  // never downgraded (they serve the requested agent); the rest are short
  // enough to classify as low-complexity and route down to the cheapest
  // entitled agent, which is what produces the savings ledger.
  const BRIEF_CHECKOUT = `Plan the saved-payment-methods work for checkout.

Context: the checkout service re-collects card details on every order. Returning
customers should be able to pick a stored method in one tap, with no PCI scope
moving into our own systems.

Constraints:
- Only provider-vault tokens are stored on our side; never a PAN, never a CVV.
- The stored-method list is per customer and must respect the existing
  soft-delete semantics on the customer record.
- Checkout stays usable when the vault is unreachable: fall back to the one-off
  card form and surface a non-blocking notice.

Deliverables: a stage-by-stage plan, the API surface to add to
src/checkout/payments.ts, the migration required, and the rollout order across
staging and the canary cohort.`;

  const BRIEF_REVIEW = `Review this change for release risk.

The diff adds a stored-payment-method selector to checkout, a new
POST /checkout/payment-methods endpoint, and a migration adding a vault_token
column with a partial unique index.

Call out anything that could double-charge, anything that widens the data we
retain, any migration step that is not safely re-runnable, and any code path
that fails open when the payment vault is unavailable.`;

  const BRIEF_PHI = `Plan an audit-export endpoint for PHI access logs.

Context: compliance needs a signed, time-bounded export of every read against a
patient record, grouped by requesting user and purpose-of-use.

Constraints:
- The export never contains clinical content — identifiers, timestamps, purpose
  codes and the requesting principal only.
- Retention is seven years, and any window inside it must be reproducible.
- Every export is itself an auditable event with a named requester.

Deliverables: the endpoint contract, the storage and retention plan, and the
controls a reviewer would check before sign-off.`;

  const INVOCATIONS: Array<{
    auth: typeof danaAuth;
    projectId: string;
    agent: string;
    mode: string;
    costSensitivity: "standard" | "cost-sensitive" | "quality-sensitive";
    input: string;
  }> = [
    { auth: danaAuth, projectId: demoProjectId, agent: "premium-mock", mode: "plan", costSensitivity: "quality-sensitive", input: BRIEF_CHECKOUT },
    { auth: danaAuth, projectId: demoProjectId, agent: "premium-mock", mode: "review", costSensitivity: "quality-sensitive", input: BRIEF_REVIEW },
    { auth: danaAuth, projectId: demoProjectId, agent: "balanced-mock", mode: "execute", costSensitivity: "quality-sensitive", input: BRIEF_REVIEW },
    { auth: danaAuth, projectId: demoProjectId, agent: "premium-mock", mode: "review", costSensitivity: "cost-sensitive", input: "Summarize the open TODOs in the checkout module and rank them by release risk." },
    { auth: danaAuth, projectId: demoProjectId, agent: "balanced-mock", mode: "execute", costSensitivity: "standard", input: "Write a one-paragraph release note for the saved-payment-methods change." },
    { auth: danaAuth, projectId: demoProjectId, agent: "fast-mock", mode: "execute", costSensitivity: "standard", input: "Draft the commit message for the vault_token migration." },
    { auth: averyAuth, projectId: demoProjectId, agent: "balanced-mock", mode: "review", costSensitivity: "quality-sensitive", input: BRIEF_REVIEW },
    { auth: averyAuth, projectId: demoProjectId, agent: "balanced-mock", mode: "review", costSensitivity: "standard", input: "List the checks a release reviewer should run before approving a payments change." },
    { auth: danaAuth, projectId: hipaaProjectId, agent: "premium-mock", mode: "plan", costSensitivity: "quality-sensitive", input: BRIEF_PHI },
    { auth: danaAuth, projectId: hipaaProjectId, agent: "balanced-mock", mode: "execute", costSensitivity: "standard", input: "Draft a short changelog entry for the PHI audit-export endpoint." },
    { auth: averyAuth, projectId: hipaaProjectId, agent: "balanced-mock", mode: "plan", costSensitivity: "quality-sensitive", input: BRIEF_PHI },
    { auth: averyAuth, projectId: hipaaProjectId, agent: "fast-mock", mode: "execute", costSensitivity: "standard", input: "List the fields the PHI access-log export must never include." },
  ];
  for (const inv of INVOCATIONS) {
    await call(
      "POST",
      `/v1/agents/${agentIds[inv.agent]}/invoke`,
      {
        mode: inv.mode,
        input: inv.input,
        costSensitivity: inv.costSensitivity,
        dispatch: true,
        projectId: inv.projectId,
      },
      inv.auth,
    );
  }

  // Real, metered CONNECTOR calls attributed to a project — Dana reads the
  // keyless mock-adapter warehouse connector a few times, so the "Spend by
  // connector" card is non-empty on first open. Each allowed call = one audit
  // row + one usage_events row (object_type 'connector') priced at the
  // connector's flat rate; nothing external is contacted.
  for (const object of ["accounts", "orders", "revenue_by_region"]) {
    await call(
      "POST",
      `/v1/connectors/${warehouseConnectorId}/invoke`,
      { operation: "read", object, projectId: demoProjectId },
      danaAuth,
    );
  }

  // §8.4 PII ENFORCEMENT DEMO — the hipaa project seeds piiMode 'block', so a
  // dispatch whose INPUT carries an obvious FAKE SSN is denied BEFORE the
  // provider call (no cost, no usage row) and leaves a 'pii-blocked' audit
  // deny. This makes the block real in the audit log + the Playground badge.
  // The number below is a well-known INVALID test SSN — never real PII. Guarded
  // idempotent: only fired if no pii-blocked row exists yet.
  const auditSoFar = (await call("GET", "/v1/audit")).entries ?? [];
  if (!auditSoFar.some((e: Json) => e.ruleId === "pii-blocked")) {
    // app.inject directly (not call()) — a 403 is the EXPECTED, correct outcome
    // and must not abort the seed.
    await app.inject({
      method: "POST",
      url: `/v1/agents/${agentIds["balanced-mock"]}/invoke`,
      headers: danaAuth,
      payload: {
        mode: "execute",
        dispatch: true,
        projectId: hipaaProjectId,
        input: "Please redact this record before export — patient SSN 123-45-6789 must not leak.",
      },
    });
  }
}

// --- demo conversation (multi-turn Playground memory) ---------------------
// One short thread for Dana on the mock agents, driven through the REAL
// invoke API: a summarize turn, then a terse follow-up whose reply visibly
// inherits the earlier topic — proof on first open that the stored history
// rides every dispatch. Guarded like the other append-only seeds: the
// thread's auto-title is the first ~60 chars of its opening turn, so a
// re-run matches on that prefix instead of creating a duplicate.
const CONVO_OPENER =
  "Summarize the saved-payment-methods checkout plan for the release notes.";
// Terse (< 8 words) so the mock's reply inherits the opener's topic — and
// still topic-bearing itself, so ANOTHER terse turn typed live in the demo
// ("now make it shorter") inherits a topic from THIS turn in its turn.
const CONVO_FOLLOW_UP = "Shorter — just the payment-methods bullets.";
const danaConvos = (await call("GET", "/v1/conversations", undefined, danaAuth)).conversations ?? [];
if (!danaConvos.some((c: Json) => c.title && CONVO_OPENER.startsWith(c.title))) {
  const convo = await call(
    "POST",
    "/v1/conversations",
    { agentId: agentIds["balanced-mock"], projectId: demoProjectId },
    danaAuth,
  );
  for (const input of [CONVO_OPENER, CONVO_FOLLOW_UP]) {
    await call(
      "POST",
      `/v1/agents/${agentIds["balanced-mock"]}/invoke`,
      { mode: "execute", input, dispatch: true, conversationId: convo.id },
      danaAuth,
    );
  }
}

// --- demo runs (one per persona) -----------------------------------------
const danaRuns = (await call("GET", "/v1/runs", undefined, danaAuth)).runs ?? [];
if (!danaRuns.some((r: Json) => r.name === "checkout-refactor")) {
  const run = await call(
    "POST",
    "/v1/runs",
    {
      projectId: demoProjectId,
      graph: {
        run: "checkout-refactor",
        escalationApproverUserId: averyId,
        nodes: [
          { id: "design", title: "Draft the new checkout API design", ownerAgentId: agentIds["balanced-mock"], mode: "execute", estimate: { in: 400, out: 800 } },
          { id: "implement", title: "Implement the checkout endpoints", ownerAgentId: agentIds["balanced-mock"], mode: "execute", dependsOn: ["design"], estimate: { in: 800, out: 1600 } },
          { id: "docs", title: "Update the public API docs", ownerAgentId: agentIds["fast-mock"], mode: "execute", estimate: { in: 200, out: 400 } },
        ],
      },
    },
    danaAuth,
  );
  // Drive it far enough to be real — one node taken all the way to done, the
  // next left in review — so the run has MEASURED spend against its budget
  // and still has something for a human to accept.
  await call("POST", `/v1/runs/${run.id}/auto`, { maxNodes: 1, acceptReviews: true }, danaAuth);
  await call("POST", `/v1/runs/${run.id}/auto`, { maxNodes: 1 }, danaAuth);
}

const averyRuns = (await call("GET", "/v1/runs", undefined, averyAuth)).runs ?? [];
if (!averyRuns.some((r: Json) => r.name === "phi-access-review")) {
  // Left PLANNED on purpose: Avery's Runs page opens on a run he can start.
  // Both owners are tier 1 or below, inside his ceiling.
  await call(
    "POST",
    "/v1/runs",
    {
      projectId: hipaaProjectId,
      graph: {
        run: "phi-access-review",
        escalationApproverUserId: adminId,
        nodes: [
          { id: "inventory", title: "Inventory every code path that reads a patient record", ownerAgentId: agentIds["balanced-mock"], mode: "execute", estimate: { in: 600, out: 1200 } },
          { id: "gaps", title: "List the access paths missing an audit-log write", ownerAgentId: agentIds["fast-mock"], mode: "execute", dependsOn: ["inventory"], estimate: { in: 300, out: 600 } },
        ],
      },
    },
    averyAuth,
  );
}

// --- workflow instances (one per persona) --------------------------------
// ADR-0079: a `planning` stage now RESTS (plan-only: mutating agent work
// attributed to the instance is refused there). Every seeded instance that must
// reach a later stage therefore leaves plan-only by the same explicit advance a
// user makes — nothing here bypasses the gate. No-op for a template without a
// planning stage, so the deploy-tail seeds below need no special-casing.
async function leavePlanOnly(
  instanceId: string,
  auth: { authorization: string },
): Promise<void> {
  const view = await call("GET", `/v1/workflows/instances/${instanceId}`, undefined, auth);
  if (view.instance?.status !== "blocked_on_plan") return;
  const stage = view.instance.definition?.stages?.[view.instance.state?.currentStageIndex ?? -1];
  if (!stage) return;
  await call("POST", `/v1/workflows/instances/${instanceId}/advance`, { stageId: stage.id }, auth);
}

const DANA_CHANGE = "Add saved-payment-methods to checkout";
const danaInstances = (await call("GET", "/v1/workflows/instances", undefined, danaAuth)).instances ?? [];
if (!danaInstances.some((i: Json) => i.change?.description === DANA_CHANGE)) {
  const inst = await call(
    "POST",
    "/v1/workflows/instances",
    {
      projectId: demoProjectId,
      change: {
        description: DANA_CHANGE,
        paths: ["src/checkout/payments.ts"],
        changeType: "feature",
        environment: "staging",
      },
    },
    danaAuth,
  );
  await leavePlanOnly(inst.id, danaAuth);
  // submit the requirements artifact so Avery's inbox has a real sign-off waiting
  await call(
    "POST",
    `/v1/workflows/instances/${inst.id}/artifacts`,
    {
      stageId: "requirements",
      content:
        "# Requirements: saved payment methods\n\n1. Store tokenized methods only.\n" +
        "2. PCI scope stays in the provider vault.\n3. Checkout page offers stored methods first.",
    },
    danaAuth,
  );
}

// The complete-pipeline instance, parked at the SIGN-OFF gate so the demo can
// drive the whole chain live: Avery approves in the Inbox → the nested build
// run spawns (Dana auto-advances it from Runs) → checks auto-pass (labelled, offline opt-in) →
// branch + PR open on the mock provider → the merge gate lands back in
// Avery's Inbox → approve → squash-merged. Deliberately not pre-driven past
// sign-off — everything after it happens on stage during the demo.
const PIPELINE_CHANGE = "Ship the checkout payment-vault fallback";
const danaInstances2 = (await call("GET", "/v1/workflows/instances", undefined, danaAuth)).instances ?? [];
if (!danaInstances2.some((i: Json) => i.change?.description === PIPELINE_CHANGE)) {
  const inst = await call(
    "POST",
    "/v1/workflows/instances",
    {
      change: {
        description: PIPELINE_CHANGE,
        paths: ["src/checkout/vault-fallback.ts"],
        changeType: "pipeline-demo",
        environment: "staging",
      },
    },
    danaAuth,
  );
  await leavePlanOnly(inst.id, danaAuth);
  await call(
    "POST",
    `/v1/workflows/instances/${inst.id}/artifacts`,
    {
      stageId: "requirements",
      content:
        "# Requirements: payment-vault fallback\n\n1. Checkout falls back to the one-off card form " +
        "when the vault is unreachable.\n2. The fallback surfaces a non-blocking notice, never an error page.\n" +
        "3. No PAN or CVV ever touches our own storage — vault tokens only.",
    },
    danaAuth,
  );
}

const AVERY_CHANGE = "Add an audit export for PHI access logs";
const averyInstances = (await call("GET", "/v1/workflows/instances", undefined, averyAuth)).instances ?? [];
if (!averyInstances.some((i: Json) => i.change?.description === AVERY_CHANGE)) {
  // hipaa-project's classification cascades in the sensitive-data template on
  // top of the rule-matched one, so this instance carries an extra compliance
  // sign-off nobody configured by hand. Left at the artifact stage: Avery's
  // Workflows page opens on something he can fill in.
  const inst = await call(
    "POST",
    "/v1/workflows/instances",
    {
      projectId: hipaaProjectId,
      change: {
        description: AVERY_CHANGE,
        paths: ["src/phi/audit-export.ts"],
        changeType: "feature",
        environment: "staging",
      },
    },
    averyAuth,
  );
  await leavePlanOnly(inst.id, averyAuth);
}

// --- THE CASCADE HEADLINE (§8.3, MARKET_ANALYSIS 2026-08 §3 → item 4) ------
// One compliance tag on hipaa-project does all the forcing; nobody configured
// any of it per-change. Dana proposes an ordinary 'feature' change on the
// HIPAA project: the assignment rule routes standard-change, and the project's
// classification cascades sensitive-data in ON TOP. The requirements artifact
// is submitted and the standard sign-off approved, so the instance comes to
// rest EXACTLY at 'compliance-signoff' — the stage that exists only because of
// the tag — pending in Avery's inbox on first open. The same tag already
// blocks an SSN prompt in Dana's chat (piiMode) and floors audit retention at
// 2555d. Idempotent by description, like every instance seed here.
const CASCADE_CHANGE = "Redact and export the oncology cohort (PHI)";
{
  const danaInstances3 =
    (await call("GET", "/v1/workflows/instances", undefined, danaAuth)).instances ?? [];
  if (!danaInstances3.some((i: Json) => i.change?.description === CASCADE_CHANGE)) {
    const inst = await call(
      "POST",
      "/v1/workflows/instances",
      {
        projectId: hipaaProjectId,
        change: {
          description: CASCADE_CHANGE,
          paths: ["src/phi/cohort-export.ts"],
          changeType: "feature",
          environment: "staging",
        },
      },
      danaAuth,
    );
    await leavePlanOnly(inst.id, danaAuth);
    await call(
      "POST",
      `/v1/workflows/instances/${inst.id}/artifacts`,
      {
        stageId: "requirements",
        content:
          "# Requirements: oncology cohort export\n\n1. Export carries identifiers, timestamps and " +
          "purpose-of-use codes — never clinical content.\n2. Every export is itself an audited event " +
          "with a named requester.\n3. Redaction runs before anything leaves the clinical boundary.",
      },
      danaAuth,
    );
    // Avery approves the STANDARD sign-off so the instance advances to the
    // cascade-forced compliance gate and parks there — that pending row is the
    // cascade story sitting in his inbox.
    const view = await call("GET", `/v1/workflows/instances/${inst.id}`, undefined, averyAuth);
    const gate = (view.pendingApprovals ?? []).find((a: Json) => a.stageId === "signoff");
    if (gate) await call("POST", `/v1/approvals/${gate.id}/decide`, { decision: "approved" }, averyAuth);
  }
}

// --- deploy-verify-rollback pipeline (pillar 2 tail, ADR-0015) -------------
// A governed MOCK deploy target + a deploy→verify→rollback template, driven to
// rest at the three newer workflow statuses so every state has a live example
// on first open: blocked_on_check (a pre-deploy check failed), blocked_on_deploy
// (the deploy condition was unmet → manual handoff), and rolled_back (a
// post-deploy verify failed → the deployment auto-reversed, terminal). Mock
// provider = zero external credentials; idempotent by name/description.
{
  const deployTargets = (await call("GET", "/v1/deploy/targets")).targets ?? [];
  if (!deployTargets.some((t: Json) => t.name === "demo-deploy")) {
    await call("POST", "/v1/deploy/targets", { name: "demo-deploy", provider: "mock", mode: "hosted", environment: "production" });
  }
  const deployTpl = await ensureTemplate("deploy-verify-pipeline", {
    workflow: "deploy-verify-pipeline",
    stages: [
      { id: "intake", type: "trigger" },
      { id: "gate", type: "human_approval", approvers: [averyId] },
      // a pre-deploy gate check (default onFailure: block) — a failure here rests
      // the instance at blocked_on_check
      // AER-047: instances 2 and 3 below reach the deploy without reporting
      // 'preflight', so the demo opts in to the labelled offline auto-pass
      // here (and on `verify`, which a deploy-override cascades into)
      { id: "precheck", type: "automated_check", checks: ["preflight"], offlineAutoPass: true },
      // the governed deploy, conditioned on environment==production; a staging
      // change fails the condition and rests at blocked_on_deploy
      { id: "deploy", type: "deployment", connection: "demo-deploy", environment: "production", condition: { field: "environment", equals: "production" } },
      // the post-deploy verify: onFailure rollback routes straight to `undo`
      { id: "verify", type: "automated_check", checks: ["smoke"], onFailure: "rollback", rollbackStageId: "undo", offlineAutoPass: true },
      { id: "undo", type: "rollback", connection: "demo-deploy" },
      { id: "done", type: "human_approval", approvers: [averyId] },
    ],
  });
  const deployRules = (await call("GET", "/v1/workflows/assignment-rules")).rules ?? [];
  if (!deployRules.some((r: Json) => r.templateId === deployTpl)) {
    await call("POST", "/v1/workflows/assignment-rules", { templateId: deployTpl, changeType: "deploy-demo" });
  }

  // approve the (single) gate on an instance as Avery, so the seed can drive the
  // instance past intake into the deploy tail deterministically.
  async function approveInstanceGate(instId: string): Promise<void> {
    const view = await call("GET", `/v1/workflows/instances/${instId}`, undefined, averyAuth);
    const gate = (view.pendingApprovals ?? []).find((a: Json) => a.stageId === "gate");
    if (gate) await call("POST", `/v1/approvals/${gate.id}/decide`, { decision: "approved" }, averyAuth);
  }
  async function ensureDeployInstance(
    description: string,
    environment: string,
    prep: (instId: string) => Promise<void>,
  ): Promise<void> {
    const existing = (await call("GET", "/v1/workflows/instances", undefined, danaAuth)).instances ?? [];
    if (existing.some((i: Json) => i.change?.description === description)) return;
    const inst = await call(
      "POST",
      "/v1/workflows/instances",
      { change: { description, paths: ["src/checkout/deploy.ts"], changeType: "deploy-demo", environment } },
      danaAuth,
    );
    await leavePlanOnly(inst.id, danaAuth);
    await prep(inst.id);
    await approveInstanceGate(inst.id);
  }

  // 1) blocked_on_check — the pre-deploy 'preflight' check fails
  await ensureDeployInstance(
    "Deploy checkout to production (pre-check fails)",
    "production",
    async (id) => {
      await call(
        "POST",
        `/v1/workflows/instances/${id}/checks`,
        { round: 0 /* a fresh instance is in round 0 (AER-048) */, stageId: "precheck", results: [{ check: "preflight", status: "failed", severity: "high" }] },
        danaAuth,
      );
    },
  );
  // 2) blocked_on_deploy — precheck passes, but the deploy condition
  //    (environment==production) is unmet for a staging change → manual handoff
  await ensureDeployInstance(
    "Deploy checkout to staging (condition unmet)",
    "staging",
    async () => {},
  );
  // 3) rolled_back — precheck passes, deploy runs, the post-deploy 'smoke' verify
  //    fails → auto-rollback → terminal rolled_back
  await ensureDeployInstance(
    "Deploy checkout to production (verify fails → rollback)",
    "production",
    async (id) => {
      await call(
        "POST",
        `/v1/workflows/instances/${id}/checks`,
        { round: 0 /* a fresh instance is in round 0 (AER-048) */, stageId: "verify", results: [{ check: "smoke", status: "failed", severity: "critical" }] },
        danaAuth,
      );
    },
  );
}

// --- PM links + a decision record on the demo objects (pillar 8) ----------
// checkout-refactor's task graph maps onto mock work items in REGULAIT-DEMO
// and carries one recorded decision, and Dana's workflow instance gets its
// single linked item — so the /app PM strip and Decisions card open
// non-empty. pm-sync verifies every existing link live and repairs (or
// orphans) dead ones; the append-only decision is guarded by a lookup.
// The summary printed below reports only what was VERIFIED against the
// provider, never an assumption — the mock store is per-process, so a
// re-seed re-syncs links but cannot restore comments an earlier process made.
let pmSummaryLine = "skipped — REGULAIT_DATA_KEY unset, no PM connection seeded";
if (DATA_KEY) {
  const runsNow = (await call("GET", "/v1/runs", undefined, danaAuth)).runs ?? [];
  const checkoutRun = runsNow.find((r: Json) => r.name === "checkout-refactor");
  let syncLine = "checkout-refactor run not found, nothing synced";
  let decisionLine = "no decision recorded";
  if (checkoutRun) {
    const sync = await call("POST", `/v1/runs/${checkoutRun.id}/pm-sync`, { connectionName: "demo-pm" }, danaAuth);
    syncLine = [
      `${sync.created?.length ?? 0} item(s) created`,
      `${sync.verified?.length ?? 0} verified live`,
      ...((sync.repaired?.length ?? 0) > 0 ? [`${sync.repaired.length} repaired in place`] : []),
      ...((sync.orphaned?.length ?? 0) > 0 ? [`${sync.orphaned.length} ORPHANED`] : []),
    ].join(", ");
    const decided =
      (await call("GET", `/v1/decisions?objectType=run&objectId=${checkoutRun.id}`, undefined, danaAuth))
        .decisions ?? [];
    if (decided.length === 0) {
      const recorded = await call(
        "POST",
        "/v1/decisions",
        {
          objectType: "run",
          objectId: checkoutRun.id,
          decision: "Ship the checkout refactor behind the existing checkout feature flag",
          rationale:
            "The design node's API shape is additive; keeping the flag makes rollback a config change, not a deploy.",
        },
        danaAuth,
      );
      if (recorded.pmMirror?.ok === false) {
        throw new Error(`seeded decision failed to mirror: ${recorded.pmMirror.error}`);
      }
    }
    // Live verification, not a claim: is the decision comment actually on the
    // run's work item at the provider right now?
    const linksLive =
      (await call("GET", `/v1/pm/links?runId=${checkoutRun.id}&live=true`, undefined, danaAuth)).links ?? [];
    const runParent = linksLive.find((l: Json) => l.objectType === "run" && !l.orphanedAt);
    const mirrorVisible = Boolean(
      runParent?.live?.comments?.some((c: string) => c.startsWith("[RegulAIt] decision")),
    );
    const decidedCount = Math.max(
      1,
      ((await call("GET", `/v1/decisions?objectType=run&objectId=${checkoutRun.id}`, undefined, danaAuth))
        .decisions ?? []).length,
    );
    decisionLine = mirrorVisible
      ? `${decidedCount} decision(s) recorded, mirror VERIFIED live on the run's work item`
      : `${decidedCount} decision(s) recorded locally; the mirror comment is not visible on the provider right now (per-process mock store) — the next decision recorded against the running gateway mirrors fresh`;
  }
  const instancesNow = (await call("GET", "/v1/workflows/instances", undefined, danaAuth)).instances ?? [];
  const danaInst = instancesNow.find((i: Json) => i.change?.description === DANA_CHANGE);
  if (danaInst) {
    await call(
      "POST",
      `/v1/workflows/instances/${danaInst.id}/pm-sync`,
      { connectionName: "demo-pm" },
      danaAuth,
    );
  }
  pmSummaryLine = `${syncLine}; ${decisionLine}`;
}

// ---------------------------------------------------------------------------
// OPT-IN EPHEMERAL LICENSE (REGULAIT_EPHEMERAL_LICENSE=1)
// ---------------------------------------------------------------------------
//
// Tier-gated features default CLOSED with no license installed, which is the
// correct posture and is fatal to anything that wants to exercise them. Two
// headline capabilities sit behind that gate — `advanced_orchestration`
// (pillar-7 goal decomposition) and `custom_model_providers` — so a seeded
// environment could not demonstrate or TEST either, and two e2e specs failed
// for a reason that looked like a product defect and was a licensing posture.
//
// THE KEY IS MINTED AND THROWN AWAY (see ./ephemeral-license.ts): only the
// PUBLIC half is written, into a scratch keyring outside the source tree, and
// the private half is never written anywhere.
//
// OPT-IN, because a seeder that silently licenses itself would make the
// default-closed posture untestable — the thing being protected here is the
// ability to observe the refusal. `infra/license-keys/` and
// `infra/release-keys/` are untouched, and the license says on its face that
// it is not production.
//
// RE-RUN SAFE: a valid licence that still verifies under this keyring (and has
// more than a week left) is KEPT, not re-minted — under Docker this block runs
// on every boot (the image's start command seeds when SEED_DEMO=1), and a
// restart must not churn the licence a demo password was set under.
if (process.env.REGULAIT_EPHEMERAL_LICENSE === "1") {
  const keyringDir = process.env.REGULAIT_LICENSE_KEYRING;
  if (!keyringDir) {
    throw new Error(
      "REGULAIT_EPHEMERAL_LICENSE=1 needs REGULAIT_LICENSE_KEYRING pointing at a scratch directory. " +
        "The gateway process must read the SAME directory, or it will refuse the license this seeder installs.",
    );
  }
  const result = await ensureEphemeralLicense({
    db,
    inject: (opts) => app.inject(opts),
    headers: AUTH,
    keyringDir,
  });
  console.log(result.line);
}

await seedStrictIdentity((m, u) => call(m, u)); // ADR-0181 SA
await app.close();
// end the pool so the process exits NOW instead of lingering on idle
// connections for the pool timeout (a window in which a killed connection
// used to crash the exit)
await db.$client.end();

console.log(`
RegulAIt demo data ready.

  Browser sign-in (ADR-0025/0030) at /ui: EMAIL OR USERNAME + ONE-TIME
  password. Shown ONCE; each persona must set their own password at first
  sign-in. The username column is the ADR-0030 second identifier — sign in as
  simply 'admin' if you prefer.

    admin  admin  admin@regulait.local   ${passwords.admin}
${adminMfaLine(adminMfa)}
    dana   dana   dana@regulait.local    ${passwords.dana}    (requester — Playground, Runs, Workflows)
    avery  avery  avery@regulait.local   ${passwords.avery}   (approver — Inbox has a sign-off waiting)

  API keys (programmatic/IDE access — NOT the browser login; the login page
  keeps a "sign in with an API key" fallback that exchanges one for a
  session). Shown ONCE:

    admin  (none kept: the seed's own admin key was revoked after its last use;
            an admin-owned key is over-scoped by definition, so issue one in
            /admin → Users only when a task needs it)
    dana   ${keys.dana}
    avery  ${keys.avery}
${pmWebhookSecret ? `\n    demo-pm webhook secret (shown ONCE)  ${pmWebhookSecret}\n` : ""}
  THE HEADLINE — the §8.3 compliance cascade, live out of the box. ONE tag
  ('hipaa' on hipaa-project) forces everything below; nobody configured any of
  it per-change:
    · avery  Inbox: '${CASCADE_CHANGE}' is parked at
             'compliance-signoff' — a stage no assignment rule routed; the tag
             cascaded the sensitive-data template into an ordinary feature
             change (watch: approving it completes the governed flow).
    · dana   Chat billed to hipaa-project: paste a prompt containing an SSN
             (e.g. 123-45-6789) — DENIED before the model runs, red 'PII
             blocked' badge, zero cost (the tag's piiMode 'block'; the seed
             already left one such deny in /admin → Audit).
    · admin  /admin → Workflows: the template GALLERY annotates, per stage,
             which compliance profiles demand it — derived live from the same
             cascade rules, so editing the profile moves the gallery. Audit
             retention is floored at the tag's 2555 days; the hipaa backup
             target's 2555d retention floor overrides its own 30d policy.

  Governance: 2 MCP servers with 8 tools (read + write), a 'repo-analyst' role
  granting read-only-all, per-user tool grants layered on top, 2 revocations,
  scoped policy rules (user + a FLEET write-approval + a ROLE-scoped rate limit,
  so any governed write pauses org-wide), 1 data-scope rule, 2 connectors (snowflake-
  analytics executes via a keyless mock adapter and is metered per call at
  $0.002; jira-cloud stays governance-only), 7 agents
  (3 mock = usable with no external keys; anthropic/openai/google/xai go live
  once you add a model credential in /admin → Model Credentials (which also
  lists exactly which agents are still waiting on one). Provider env vars
  (ANTHROPIC_API_KEY, …) are NOT read at dispatch: the env-key fallback ships
  off (ADR-0181) and an admin turns it on in /admin → Organization, audited.
  The one exception is this seed: GOOGLE_API_KEY, when set, is imported once
  into the encrypted store — see the "provider key:" line at the top),
  and per-user agent policies with a per-run budget cap (/admin → Agents).

  No placeholder provider credential is seeded, deliberately — it would make
  routing believe those providers work and turn a clean 409 into a failed
  dispatch. Add a real one in Model Credentials, or stay on the mock agents.

  Onboarding anyone else (ADR-0025): create them in /admin → Users, hit
  'set one-time pw' for their browser sign-in (shown once, must-change on
  first use) and/or 'issue key' for programmatic access — each plaintext is
  shown once there and never again. Users bring their own provider keys in
  /app → Settings.

  Projects: demo-project and hipaa-project (classification-forced sign-off),
  both with members, team provenance, shared context, a budget and real
  measured spend from 12 seeded mock dispatches.

  PII enforcement (§8.4, pillar 3): hipaa-project seeds piiMode 'block', so a
  seeded dispatch whose input carried a fake SSN was DENIED before the model
  ran (no cost) — see the 'pii-blocked' deny in /admin → Audit, and try it
  live in the Playground (a prompt with an SSN billed to hipaa-project shows a
  red 'PII blocked' badge). /admin → Audit also prunes the log to the global
  retention floor (longest auditRetentionDays across profiles; hipaa = 2555d).

  Playground (multi-turn): dana opens on a seeded 2-turn conversation billed
  to demo-project — the terse follow-up's reply visibly continues the first
  turn's topic, proof the stored history rides every dispatch. The rail's
  'New conversation' starts a fresh thread; every turn stays governed,
  routed and metered exactly like a single-turn invoke.

  Spend & savings (pillars 5+6, /app): every user has a personal cost page —
  measured spend, tokens, savings by technique, spend by agent, spend by
  connector, recent invocations — plus a drill-down into any project they are a
  MEMBER of (the per-project /costs endpoint admits members, not only admins).

  PM integration (pillar 8): the mock 'demo-pm' connection is linked to
  Dana's checkout-refactor run (every node = a mock work item) and to her
  workflow instance. This seed run, verified live against the provider:
  ${pmSummaryLine}.
  See the PM strip on each detail page ('Sync now' verifies every link live,
  repairs missing items in place, and orphans unrepairable ones; drift is
  surfaced, never auto-fixed). /admin → PM Connections lists/creates
  connections; the webhook secret is shown exactly once there, like every
  secret.

  Infra ops (pillar 3, §8.2): 5 mock resources with a scanned posture —
  /admin → Infrastructure / Operations. The agent-runtime's LOW drift
  auto-remediated on scan (audited, no approval, under its 'low' ceiling);
  the control plane's drift+CVE and the API cert's HIGH expiry stay open; the
  legacy cert is EXPIRED = CRITICAL and is ALWAYS approval-gated. 'Propose
  remediation' on any open finding queues an infra_operation approval; the
  HIPAA-tagged backup target shows a 2555d retention FLOOR from the §8.3
  cascade overriding its own 30d policy.

  Workflows (pillar 2): 3 templates — standard-change (type 'feature'),
  sensitive-data (hipaa cascade), and complete-pipeline (type 'pipeline-demo':
  intake → plan → requirements → sign-off → nested build run → checks →
  branch → PR → merge gate → squash merge, all on the MOCK git provider via
  the 'demo-git' connection). /admin → Workflows shows the chains, authors
  templates from a JSON starter, manages assignment rules (with delete) and
  git connections.

  Still to do in the demo — nothing is seeded finished:
    · avery  Inbox: THREE workflow sign-offs (standard + the pipeline + the
             cascade-forced compliance gate above);
             Workflows: an instance awaiting its requirements artifact;
             Runs: a planned run to start.
    · dana   Inbox: a shared-context conflict to arbitrate; Runs: a node
             awaiting review, then auto-advance the rest; Runs → New run →
             "Describe the goal" drafts a task graph with a lead agent
             (mock, zero external keys) — review, tweak, Plan run.

  Drive the pipeline live ('Ship the checkout payment-vault fallback'):
    1. avery  Inbox → approve the sign-off (reads the artifact inline)
    2. dana   the build stage spawns a nested run — open it from the
              workflow's 'watch the run' link (or Runs) and Auto-advance
    3. (auto) checks auto-pass, labelled "no report (offline mode)" — only on a
              gateway started with REGULAIT_OFFLINE_CHECKS=1; without it they wait
              for a report — then branch + PR open on the mock provider, and the
              PR URL appears under Delivery
    4. avery  Inbox → approve the merge gate → squash-merged, chain complete.

  Simulation / Access preview — pick Dana + the repo server from the selects
  and step through the precedence chain:
    read_file    allow (role grants read-only-all)
    search_code  deny (her per-user revocation beats the role)
    write_file   require_approval (named approver: Avery)
`);

// ===========================================================================
// ADR-0181 (agent SC) — THE DEMO'S ADMISSION AND EGRESS POSTURE, configured
// truthfully under the strict defaults. Called from ONE line, just before the
// MCP section above. Nothing here relaxes a control:
//
//  - mcpPrivateRangesDefault is false, so the demo's local MCP hosts get an
//    explicit, audited egress allow-list entry with the private-range and
//    plaintext opt-ins (the demo MCP server listens on 127.0.0.1/127.0.0.2
//    over http). Every other private address stays refused.
//  - egressCompiledDefaultPolicy is strict, so the one vendor endpoint the demo
//    story dispatches to (the seeded gemini-pro agent, when a key is supplied)
//    gets its allow-list entry. The other seeded real-provider agents are not
//    allow-listed: an admin adds their hosts when they add their keys.
//  - minReleaseAgeDays is 7 and the two demo MCP servers are HISTORIC in the
//    story (registered long before the meeting), so their registration is
//    dated 60 days back. That is a dataset fact, written once, and recorded in
//    the audit trail under its own rule id so nobody mistakes it for a
//    real-time registration. A server registered during the demo still waits.
//  - mcpAdmissionMode is enforce: the demo servers are scanned at their first
//    sync and admitted on a clean manifest, like any other server.
// ===========================================================================
async function seedStrictAdmission(): Promise<void> {
  const localHosts = [
    ...new Set(
      ["127.0.0.1", "127.0.0.2", process.env.REGULAIT_DEMO_MCP_HOST_REPO, process.env.REGULAIT_DEMO_MCP_HOST_WAREHOUSE].filter(
        (h): h is string => !!h && h.trim() !== "",
      ),
    ),
  ];
  const allowed = new Set(
    (((await call("GET", "/v1/egress-allow-hosts")).hosts ?? []) as Json[]).map((h) => h.host as string),
  );
  for (const host of localHosts) {
    if (allowed.has(host)) continue;
    await call("POST", "/v1/egress-allow-hosts", {
      host,
      allowPrivateRanges: true,
      allowPlaintextHttp: true,
      note: "demo: the local demo MCP server (loopback, http). ADR-0181 keeps every other private address refused.",
    });
  }
  if (!allowed.has("generativelanguage.googleapis.com")) {
    await call("POST", "/v1/egress-allow-hosts", {
      host: "generativelanguage.googleapis.com",
      note: "demo: the seeded gemini-pro agent's compiled endpoint (strict compiled-egress posture, ADR-0181)",
    });
  }

  const historic: Array<[string, string]> = [
    ["repo-tools", "http://127.0.0.1:9/repo-mcp"],
    ["data-warehouse", "http://127.0.0.1:9/warehouse-mcp"],
  ];
  const registeredAt = new Date(Date.now() - 60 * 86_400_000);
  const have = ((await call("GET", "/v1/servers")).servers ?? []) as Json[];
  for (const [name, url] of historic) {
    const id: string = have.find((s) => s.name === name)?.id ?? (await call("POST", "/v1/servers", { name, url })).id;
    const [row] = await db
      .select({ releaseDigest: mcpServers.releaseDigest, releaseSeenAt: mcpServers.releaseSeenAt })
      .from(mcpServers)
      .where(eq(mcpServers.id, id));
    // once only: a server that has synced a manifest, or is already dated, is left alone
    if (!row || row.releaseDigest !== null || row.releaseSeenAt.getTime() <= registeredAt.getTime()) continue;
    await db
      .update(mcpServers)
      .set({ createdAt: registeredAt, releaseSeenAt: registeredAt })
      .where(eq(mcpServers.id, id));
    await db.insert(auditLog).values({
      userId: "00000000-0000-0000-0000-000000000000",
      serverId: id,
      objectType: "mcp_server",
      objectId: id,
      detail: { phase: "demo-seed", registeredAt: registeredAt.toISOString(), minReleaseAgeDays: 7 },
      effect: "allow",
      ruleId: "demo-seed-historic-server-dated",
      ruleChain: [],
      reason:
        `demo seed: MCP server '${name}' is a historic server in the demo story, so its registration is dated ` +
        `${registeredAt.toISOString().slice(0, 10)}, past the 7-day release-age cooldown. A dataset fact, not a ` +
        `cooldown override; a server registered during the demo still waits.`,
    });
  }
}

// --- ADR-0181 (FX2): seedAdminMfa -------------------------------------------
// MFA is required for admins, and since FX2 an admin's API key answers to it
// too, so the admin persona the prep tooling acts as must be enrolled before a
// key is minted for her. Enrolled through the real routes (enrolAdminTotp:
// one-time password -> sign-in -> enrol -> activate), never by relaxing
// mfaRequired. The authenticator secret is printed ONCE, beside her one-time
// password, for the presenter to add to an authenticator app.
async function seedAdminMfa(userId: string): Promise<AdminTotpEnrolment> {
  const result = await enrolAdminTotp(app, BOOT, userId);
  // a re-seed after the presenter set her password (demo:set-passwords, which
  // re-provisions her authenticator): she enrols at her own sign-in, and the
  // seed acts without her key — never by relaxing anything
  if (result.status === "refused") console.log(`  admin TOTP not enrolled by the seed: ${result.reason}`);
  return result;
}

function adminMfaLine(r: AdminTotpEnrolment): string {
  if (r.status === "enrolled") return `           admin TOTP (shown ONCE; add it to an authenticator app): ${r.otpauthUri}`;
  return r.status === "already"
    ? "           admin TOTP: already enrolled (unchanged)"
    : "           admin TOTP: not enrolled — she enrols an authenticator at her first sign-in";
}
