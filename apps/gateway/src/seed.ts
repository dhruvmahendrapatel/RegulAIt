/**
 * Demo-dataset seeder. Idempotent: safe to re-run — existing objects are
 * found by name/email and reused; only API keys are always minted fresh
 * (and printed exactly once, like every key in the product).
 *
 * Deliberately drives the REAL HTTP API via app.inject rather than raw
 * inserts, so seeding exercises exactly the validation and governance the
 * product enforces. Mock-provider agents make the playground fully usable
 * with ZERO external API keys; the real-provider agents become dispatchable
 * the moment a credential is added in the admin portal.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb, runMigrations } from "@regulait/db";
import { buildApp } from "./app.js";

const connectionString =
  process.env.DATABASE_URL ?? "postgres://regulait:regulait@localhost:5432/regulait";
const BOOT = process.env.REGULAIT_BOOTSTRAP_TOKEN ?? "seed-bootstrap";
const AUTH = { authorization: `Bearer ${BOOT}` };

const db = createDb(connectionString);
await runMigrations(
  db,
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations"),
);
const app = buildApp(db, {
  bootstrapToken: BOOT,
  dataKey: process.env.REGULAIT_DATA_KEY,
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

const keys: Record<string, string> = {};
for (const [name, id] of [
  ["admin", adminId],
  ["dana", danaId],
  ["avery", averyId],
] as const) {
  keys[name] = (await call("POST", `/v1/users/${id}/keys`, { name: "seed" })).token;
}
const danaAuth = { authorization: `Bearer ${keys.dana}` };

// --- agent catalog -------------------------------------------------------
const AGENTS = [
  { name: "fast-mock", provider: "mock", tier: 0, costPerMTokIn: 1, costPerMTokOut: 5, model: "mock-fast" },
  { name: "balanced-mock", provider: "mock", tier: 1, costPerMTokIn: 3, costPerMTokOut: 15, model: "mock-balanced" },
  { name: "premium-mock", provider: "mock", tier: 2, costPerMTokIn: 15, costPerMTokOut: 75, model: "mock-premium" },
  { name: "claude-opus", provider: "anthropic", tier: 2, costPerMTokIn: 5, costPerMTokOut: 25, model: "claude-opus-5" },
  { name: "gpt-5", provider: "openai", tier: 2, costPerMTokIn: 2, costPerMTokOut: 8, model: "gpt-5" },
  { name: "gemini-pro", provider: "google", tier: 1, costPerMTokIn: 1.25, costPerMTokOut: 10, model: "gemini-2.5-pro" },
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
const rules = (await call("GET", "/v1/workflows/assignment-rules")).rules ?? [];
if (!rules.some((r: Json) => r.templateId === standardTpl)) {
  await call("POST", "/v1/workflows/assignment-rules", { templateId: standardTpl, changeType: "feature" });
}
await call("POST", "/v1/compliance/profiles", {
  tag: "hipaa",
  requiredTemplateIds: [sensitiveTpl],
  piiMode: "block",
  auditRetentionDays: 2555,
  mcpDefaultMode: "read_only",
});

// --- projects ------------------------------------------------------------
const projectList = (await call("GET", "/v1/projects")).projects ?? [];
async function ensureProject(payload: Json): Promise<string> {
  const existing = projectList.find((p: Json) => p.name === payload.name);
  if (existing) return existing.id;
  return (await call("POST", "/v1/projects", payload)).id;
}
const demoProjectId = await ensureProject({
  name: "demo-project",
  costCenter: "CC-0001",
  budgetUsd: 25,
  budgetApproverUserId: averyId,
  arbiterUserId: averyId,
});
const hipaaProjectId = await ensureProject({
  name: "hipaa-project",
  costCenter: "CC-0002",
  arbiterUserId: averyId,
  classifications: ["hipaa"],
});
for (const projectId of [demoProjectId, hipaaProjectId]) {
  for (const [userId, role] of [
    [danaId, "contributor"],
    [averyId, "contributor"],
    [adminId, "owner"],
  ] as const) {
    await call("POST", `/v1/projects/${projectId}/members`, { userId, role }); // 409 dup = fine
  }
}
const ctx = (await call("GET", `/v1/projects/${demoProjectId}/context`)).context ?? [];
if (!ctx.some((c: Json) => c.key === "coding-standards")) {
  await call("POST", `/v1/projects/${demoProjectId}/context`, {
    key: "coding-standards",
    content:
      "TypeScript strict mode everywhere. No default exports. Errors are values at boundaries; " +
      "every external call is wrapped and surfaced, never swallowed.",
  });
}

// --- demo run + workflow instance for Dana -------------------------------
const danaRuns = (await call("GET", "/v1/runs", undefined, danaAuth)).runs ?? [];
if (danaRuns.length === 0) {
  await call(
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
}
const danaInstances = (await call("GET", "/v1/workflows/instances", undefined, danaAuth)).instances ?? [];
if (danaInstances.length === 0) {
  const inst = await call(
    "POST",
    "/v1/workflows/instances",
    {
      projectId: demoProjectId,
      change: {
        description: "Add saved-payment-methods to checkout",
        paths: ["src/checkout/payments.ts"],
        changeType: "feature",
        environment: "staging",
      },
    },
    danaAuth,
  );
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

await app.close();

console.log(`
RegulAIt demo data ready.

  Sign in at /app (or /admin with the admin key). Keys are shown ONCE:

    admin  admin@regulait.local   ${keys.admin}
    dana   dana@regulait.local    ${keys.dana}    (requester — start in the Playground)
    avery  avery@regulait.local   ${keys.avery}   (approver — check the Inbox)

  Seeded: 7 agents (3 mock = usable with no external keys; anthropic/openai/
  google/xai become live once you add a model credential in /admin),
  2 workflow templates + hipaa compliance profile, demo-project ($25 budget)
  and hipaa-project (classification-forced sign-off), one planned run and one
  workflow instance awaiting Avery's approval.
`);
