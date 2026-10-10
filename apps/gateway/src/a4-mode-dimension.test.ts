import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { relaxStrictAdmissionForTest } from "./testing/strict-admission.js";
// ADR-0181: this file registers a LOCAL MCP double (127.0.0.1 / localhost, registered seconds ago) to pin
// unrelated behaviour, not the strict admission defaults — relaxed explicitly here, restored in afterAll.
let restoreStrictAdmission: (() => Promise<void>) | undefined;
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, auditLog, createDb, eq, runMigrations, type Db } from "@regulait/db";
import { evaluate } from "@regulait/policy-kernel";
import { buildApp } from "./app.js";
import { deriveDeployContext, governedEvaluate } from "./governed-evaluate.js";
import { effectiveModeOverrides, runAuditPruneOnce, retentionFloor } from "./org-settings.js";
import { isCsvNoticeRow } from "./csv-export.js";

/** ADR-0124 — the shipped posture; these suites are about entitlement, not
 * about the kill switch, so the dial adds nothing to their decisions. */
const EXEC = { mode: "normal" } as const;

/**
 * A4 (ADR-0027, migration 0044 — decomposing ADR-0019's deferred A4):
 * (a) the deploy_mode dimension on audit rows written by deploy-mode-scoped
 *     actions (null = unknown / pre-existing / not deploy-scoped — honest,
 *     un-backfillable absence);
 * (b) MAX-only per-mode audit-retention overrides (can extend, never shorten);
 * (c) deploy-mode-scoped pillar-1 restriction rules with a server-derived
 *     context (never client-asserted). Default everywhere = no mode scoping =
 *     pre-A4 behaviour. Shares one DB (fileParallelism off); prefix a4-.
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);
const BOOT = "a4-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };

let db: Db;
let app: ReturnType<typeof buildApp>;
let anaId: string;
let anaAuth: { authorization: string };
let piaId: string;
let piaAuth: { authorization: string };
let serverId: string;
let projectId: string;

async function makeUser(email: string) {
  const u = await app.inject({ method: "POST", headers: AUTH, url: "/v1/users", payload: { email, displayName: email.split("@")[0] } });
  const k = await app.inject({ method: "POST", headers: AUTH, url: `/v1/users/${u.json().id}/keys`, payload: { name: "t" } });
  return { id: u.json().id as string, auth: { authorization: `Bearer ${k.json().token}` } };
}

async function makeWorkflowTowards(target: string, changeType: string, name: string): Promise<string> {
  const tpl = await app.inject({
    method: "POST", headers: AUTH, url: "/v1/workflows/templates",
    payload: { name, definition: { workflow: name, stages: [
      { id: "intake", type: "trigger" },
      { id: "gate", type: "human_approval", approvers: [anaId] },
      { id: "deploy", type: "deployment", connection: target, environment: "staging" },
      { id: "done", type: "human_approval", approvers: [anaId] },
    ] } },
  });
  expect(tpl.statusCode).toBe(201);
  await app.inject({
    method: "POST", headers: AUTH, url: "/v1/workflows/assignment-rules",
    payload: { templateId: tpl.json().id, changeType },
  });
  const started = await app.inject({
    method: "POST", headers: piaAuth, url: "/v1/workflows/instances",
    payload: { projectId, change: { description: "a4", paths: ["x"], changeType, environment: "staging" } },
  });
  expect(started.statusCode).toBe(201);
  return started.json().id as string;
}

async function decideGate(instanceId: string, stageId: string, decision: "approved" | "denied") {
  const view = await app.inject({ method: "GET", headers: anaAuth, url: `/v1/workflows/instances/${instanceId}` });
  const gate = (view.json().pendingApprovals ?? []).find((a: { stageId: string }) => a.stageId === stageId);
  expect(gate).toBeTruthy();
  await app.inject({ method: "POST", headers: anaAuth, url: `/v1/approvals/${gate.id}/decide`, payload: { decision } });
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restoreStrictAdmission = await relaxStrictAdmissionForTest(db);
  app = buildApp(db, { bootstrapToken: BOOT });
  const ana = await makeUser("a4-ana@example.com");
  anaId = ana.id;
  anaAuth = ana.auth;
  const pia = await makeUser("a4-pia@example.com");
  piaId = pia.id;
  piaAuth = pia.auth;
  // ADR-0043: never-fetched registry fixture — a resolvable public hostname would
  // make CI depend on DNS and a .example one fails closed under the MCP egress
  // guard's write-time check, so it points at the loopback dead port (discard),
  // which the private-ranges-open default posture permits with zero ceremony.
  const s = await app.inject({ method: "POST", headers: AUTH, url: "/v1/servers", payload: { name: "a4-server", url: "http://127.0.0.1:9" } });
  serverId = s.json().id;
  for (const tool of [{ name: "a4_read", kind: "read" }, { name: "a4_write", kind: "write" }]) {
    await app.inject({ method: "POST", headers: AUTH, url: `/v1/servers/${serverId}/tools`, payload: tool });
  }
  await app.inject({ method: "POST", headers: AUTH, url: "/v1/grants/tools", payload: { userId: piaId, serverId, toolName: "a4_write" } });
  const p = await app.inject({ method: "POST", headers: AUTH, url: "/v1/projects", payload: { name: "a4-project" } });
  projectId = p.json().id;
  // the byoc deploy target the project's in-flight work lands on (mock
  // provider — mode is a column independent of the provider kind)
  const t = await app.inject({
    method: "POST", headers: AUTH, url: "/v1/deploy/targets",
    payload: { name: "a4-byoc", provider: "mock", mode: "byoc", environment: "staging" },
  });
  expect(t.statusCode).toBe(201);
});

describe("(c) kernel: deploy-mode-scoped restriction rules", () => {
  const base = {
    userId: "u1",
    actor: null,
    serverId: "s1",
    tool: { serverId: "s1", name: "t", kind: "write" as const },
    toolGrants: [{ id: "g1", userId: "u1", serverId: "s1", toolName: "t" }],
    serverGrants: [],
  };
  const modeRule = {
    id: "ar1", userId: null, serverId: null, roleId: null, teamId: null,
    scope: "fleet" as const, serverScope: "all" as const,
    deployMode: "air_gapped" as const, toolName: null, writeOnly: false, approverUserId: "appr",
  };

  it("no derivable context (null/empty) = a mode-scoped rule does NOT match — default is today's allow", () => {
    expect(evaluate({
    execution: EXEC, ...base, approvalRules: [modeRule] }).effect).toBe("allow");
    expect(evaluate({
    execution: EXEC, ...base, approvalRules: [modeRule], deployContext: [] }).effect).toBe("allow");
    expect(evaluate({
    execution: EXEC, ...base, approvalRules: [modeRule], deployContext: ["byoc"] }).effect).toBe("allow");
  });

  it("a matching context pauses the call, and the reason names the deploy-mode scope", () => {
    const d = evaluate({
    execution: EXEC, ...base, approvalRules: [modeRule], deployContext: ["air_gapped", "hosted"] });
    expect(d.effect).toBe("require_approval");
    expect(d.reason).toContain("deploy-mode air_gapped");
  });

  it("mode-unscoped rules are byte-identical regardless of context (deployMode null/absent)", () => {
    const plain = { ...modeRule, deployMode: null };
    expect(evaluate({
    execution: EXEC, ...base, approvalRules: [plain] }).effect).toBe("require_approval");
    expect(evaluate({
    execution: EXEC, ...base, approvalRules: [plain], deployContext: ["byoc"] }).effect).toBe("require_approval");
  });

  it("mode scoping is additive-only: it narrows restrictions, it can never rescue an ungranted call", () => {
    const ungranted = { ...base, toolGrants: [] };
    const d = evaluate({
    execution: EXEC, ...ungranted, approvalRules: [modeRule], deployContext: ["air_gapped"] });
    expect(d.effect).toBe("deny");
    expect(d.ruleId).toBe("default-deny");
  });

  it("a mode-scoped rate limit binds only in its context", () => {
    const limit = {
      id: "rl1", userId: null, serverId: null, roleId: null, teamId: null,
      scope: "fleet" as const, serverScope: "all" as const, deployMode: "byoc" as const,
      toolName: null, maxCalls: 1, windowSeconds: 60, currentCount: 5,
    };
    expect(evaluate({
    execution: EXEC, ...base, rateLimits: [limit] }).effect).toBe("allow");
    expect(evaluate({
    execution: EXEC, ...base, rateLimits: [limit], deployContext: ["byoc"] }).effect).toBe("deny");
  });
});

describe("(c) server-derived context + the rule deploy-mode endpoint", () => {
  let approvalRuleId: string;

  it("PATCH /v1/rules/:kind/:id/deploy-mode sets and audits the scope; unknown rule 404s", async () => {
    const created = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/rules/approvals",
      payload: { scope: "user", serverScope: "server", userId: piaId, serverId, toolName: "a4_write", approverUserId: anaId },
    });
    expect(created.statusCode).toBe(201);
    approvalRuleId = created.json().id;
    expect(created.json().deployMode ?? null).toBeNull(); // default = mode-unscoped

    const patched = await app.inject({
      method: "PATCH", headers: AUTH, url: `/v1/rules/approvals/${approvalRuleId}/deploy-mode`,
      payload: { deployMode: "byoc" },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().deployMode).toBe("byoc");
    const [audit] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.ruleId, "rule-deploy-mode-set"), eq(auditLog.objectId, approvalRuleId)));
    expect(audit).toBeTruthy();
    expect(audit!.detail).toMatchObject({ ruleKind: "approvals", before: null, after: "byoc" });

    const missing = await app.inject({
      method: "PATCH", headers: AUTH, url: `/v1/rules/rate-limits/${approvalRuleId}/deploy-mode`,
      payload: { deployMode: "byoc" },
    });
    expect(missing.statusCode).toBe(404);
  });

  it("deriveDeployContext: in-flight instances bind the project to their targets' modes; terminal ones do not", async () => {
    expect(await deriveDeployContext(db, projectId)).toEqual([]);
    const instanceId = await makeWorkflowTowards("a4-byoc", "a4-ctx-change", "a4-ctx");
    expect(await deriveDeployContext(db, projectId)).toEqual(["byoc"]);
    // finish the run: approve the gate (mock deploy runs) then approve 'done'
    await decideGate(instanceId, "gate", "approved");
    await decideGate(instanceId, "done", "approved");
    const done = await app.inject({ method: "GET", headers: piaAuth, url: `/v1/workflows/instances/${instanceId}` });
    expect(done.json().instance.status).toBe("completed");
    expect(await deriveDeployContext(db, projectId)).toEqual([]);
  });

  it("governedEvaluate honours the mode scope end-to-end: attributed in-context call pauses, out-of-context allows", async () => {
    const tool = { serverId, name: "a4_write", kind: "write" as const };
    // no in-flight deploy-bound work → context [] → the byoc-scoped rule does not match
    const before = await governedEvaluate(db, piaId, serverId, tool, undefined, null, projectId, undefined, undefined, undefined, undefined, { actor: null });
    expect(before.decision.effect).toBe("allow");
    // an in-flight instance towards the byoc target flips the context
    const instanceId = await makeWorkflowTowards("a4-byoc", "a4-live-change", "a4-live");
    const inCtx = await governedEvaluate(db, piaId, serverId, tool, undefined, null, projectId, undefined, undefined, undefined, undefined, { actor: null });
    expect(inCtx.decision.effect).toBe("require_approval");
    expect(inCtx.decision.reason).toContain("deploy-mode byoc");
    // an UNATTRIBUTED call never derives a context — the scoped rule stays dormant
    const unattributed = await governedEvaluate(db, piaId, serverId, tool, undefined, null, null, undefined, undefined, undefined, undefined, { actor: null });
    expect(unattributed.decision.effect).toBe("allow");
    // clean up: abort so later tests see no lingering context
    const aborted = await app.inject({ method: "POST", headers: piaAuth, url: `/v1/workflows/instances/${instanceId}/abort`, payload: {} });
    expect(aborted.statusCode).toBe(200);
    expect(await deriveDeployContext(db, projectId)).toEqual([]);
    // and clear the rule's scope back to unscoped → rule now applies everywhere
    await app.inject({
      method: "PATCH", headers: AUTH, url: `/v1/rules/approvals/${approvalRuleId}/deploy-mode`,
      payload: { deployMode: null },
    });
    const cleared = await governedEvaluate(db, piaId, serverId, tool, undefined, null, null, undefined, undefined, undefined, undefined, { actor: null });
    expect(cleared.decision.effect).toBe("require_approval");
    // restore for the rest of the suite: re-scope to byoc so the plain path stays allow
    await app.inject({
      method: "PATCH", headers: AUTH, url: `/v1/rules/approvals/${approvalRuleId}/deploy-mode`,
      payload: { deployMode: "byoc" },
    });
  });
});

describe("(a) the audit deploy_mode dimension", () => {
  it("workflow deploy events carry their target's mode; non-deploy events stay null (unknown)", async () => {
    const instanceId = await makeWorkflowTowards("a4-byoc", "a4-audit-change", "a4-audit");
    await decideGate(instanceId, "gate", "approved");
    const rows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.objectType, "workflow"), eq(auditLog.objectId, instanceId)));
    const byKind = new Map(rows.map((r) => [(r.detail as { event?: { kind?: string } })?.event?.kind, r]));
    // the deploy execution event is stamped with the target's mode
    const deployRow = rows.find(
      (r) =>
        (r.detail as { event?: { kind?: string; stageId?: string } })?.event?.kind === "execution_succeeded" &&
        (r.detail as { event?: { stageId?: string } })?.event?.stageId === "deploy",
    );
    expect(deployRow).toBeTruthy();
    expect(deployRow!.deployMode).toBe("byoc");
    // the start event is NOT deploy-scoped — honest null
    expect(byKind.get("start")?.deployMode ?? null).toBeNull();
  });

  it("GET /v1/audit?deployMode= filters the trail, with `unknown` as a first-class null bucket", async () => {
    // fixtures across all four buckets, freshly stamped so they sit at the top
    // of the 100-row window whatever else the shared DB holds.
    const mk = (ruleId: string, deployMode: "hosted" | "byoc" | "air_gapped" | null) =>
      db.insert(auditLog).values({
        userId: piaId, effect: "allow", ruleId, ruleChain: [],
        reason: "a4 audit-filter fixture", deployMode,
      });
    await mk("a4-filter-hosted", "hosted");
    await mk("a4-filter-byoc", "byoc");
    await mk("a4-filter-airgapped", "air_gapped");
    await mk("a4-filter-unknown", null);

    const read = async (qs: string) => {
      const res = await app.inject({ method: "GET", headers: AUTH, url: `/v1/audit${qs}` });
      expect(res.statusCode).toBe(200);
      return res.json().entries as Array<{ ruleId: string; deployMode: string | null }>;
    };

    // each named mode returns ONLY its own rows
    for (const mode of ["hosted", "byoc", "air_gapped"] as const) {
      const rows = await read(`?deployMode=${mode}`);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.deployMode === mode)).toBe(true);
      expect(rows.some((r) => r.ruleId === `a4-filter-${mode.replace("_", "")}`)).toBe(true);
    }

    // `unknown` is null-only — it must NEVER leak a row that has a real mode,
    // which is the whole honesty point: those rows are un-backfillable, not
    // silently "hosted".
    const unknown = await read("?deployMode=unknown");
    expect(unknown.length).toBeGreaterThan(0);
    expect(unknown.every((r) => r.deployMode === null)).toBe(true);
    expect(unknown.some((r) => r.ruleId === "a4-filter-unknown")).toBe(true);
    expect(unknown.some((r) => r.ruleId.startsWith("a4-filter-") && r.ruleId !== "a4-filter-unknown")).toBe(false);

    // no param = every row, mode or not
    const all = await read("");
    expect(all.some((r) => r.deployMode === null)).toBe(true);
    expect(all.some((r) => r.deployMode !== null)).toBe(true);

    // the filter composes with userId (AND, not OR)
    const combined = await read(`?userId=${piaId}&deployMode=byoc`);
    expect(combined.every((r) => r.deployMode === "byoc")).toBe(true);
    const otherUser = await read(`?userId=${anaId}&deployMode=byoc`);
    expect(otherUser.some((r) => r.ruleId === "a4-filter-byoc")).toBe(false);

    // an unknown mode value is refused rather than silently ignored
    const bad = await app.inject({ method: "GET", headers: AUTH, url: "/v1/audit?deployMode=on_prem" });
    expect(bad.statusCode).toBe(400);
  });

  it("the CSV export carries deployMode, honours the filter, and writes null as the literal `unknown`", async () => {
    const csv = await app.inject({ method: "GET", headers: AUTH, url: "/v1/audit.csv?deployMode=unknown" });
    expect(csv.statusCode).toBe(200);
    const [header, ...body] = csv.body.trim().split("\n");
    const cols = header!.split(",");
    const modeIdx = cols.indexOf("deployMode");
    expect(modeIdx).toBeGreaterThan(-1);
    // ADR-0031: the export streams under a defaulted date window and a row
    // ceiling, and appends a single-field disclosure row when either actually
    // clipped the file. Whether it appears here depends on what earlier suites
    // left in audit_log, so the DATA rows are what this test is about — but the
    // notice, when present, must be a real ADR-0031 notice and nothing else.
    const notices = body.filter(isCsvNoticeRow);
    for (const n of notices) expect(n).toContain("REGULAIT EXPORT");
    const rows = body.filter((l) => !isCsvNoticeRow(l));
    expect(rows.length).toBeGreaterThan(0);
    // every exported row in the unknown bucket says so in words — an auditor
    // can never read an empty cell as "hosted" or as a lost value
    for (const line of rows) {
      expect(line.split(",")[modeIdx]).toBe("unknown");
    }
    expect(csv.headers["content-disposition"]).toContain("audit-log-unknown.csv");

    const scoped = await app.inject({ method: "GET", headers: AUTH, url: "/v1/audit.csv?deployMode=byoc" });
    expect(scoped.statusCode).toBe(200);
    for (const line of scoped.body.trim().split("\n").slice(1)) {
      if (isCsvNoticeRow(line)) continue;
      expect(line.split(",")[modeIdx]).toBe("byoc");
    }
  });
});

describe("(b) MAX-only per-mode audit retention", () => {
  it("effectiveModeOverrides drops inert overrides (<= the global floor) — MAX composition can never shorten", () => {
    const out = effectiveModeOverrides({ hosted: 10, byoc: 90 }, 30);
    expect(out.map((o) => o.mode)).toEqual(["byoc"]);
    expect(effectiveModeOverrides({}, 30)).toEqual([]);
    expect(effectiveModeOverrides({ air_gapped: 30 }, 30)).toEqual([]); // equal = inert
  });

  it("prune retains overridden-mode rows for the longer window; null-mode rows follow the global floor", async () => {
    // ROBUST TO SUITE ORDER: other suites may have created compliance
    // profiles whose floors win upward (profile floor > org default). Work
    // RELATIVE to the effective floor, whatever it is.
    const ambient = await retentionFloor(db);
    const put = await app.inject({
      method: "PUT", headers: AUTH, url: "/v1/org/settings",
      payload: { defaultAuditRetentionDays: 30, modeAuditRetention: {} },
    });
    expect(put.statusCode).toBe(200);
    const base = await retentionFloor(db);
    const effective = base.retainedDays!; // >= 30 (profile floors win upward)
    expect(effective).toBeGreaterThanOrEqual(30);
    const byocDays = effective + 335;
    const put2 = await app.inject({
      method: "PUT", headers: AUTH, url: "/v1/org/settings",
      payload: { modeAuditRetention: { byoc: byocDays, hosted: 5 } },
    });
    expect(put2.statusCode).toBe(200);
    try {
      const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 3600 * 1000);
      const mk = (ruleId: string, at: Date, deployMode: "hosted" | "byoc" | "air_gapped" | null) =>
        db.insert(auditLog).values({
          userId: piaId, at, effect: "allow", ruleId, ruleChain: [],
          reason: "a4 retention fixture", deployMode,
        });
      await mk("a4-ret-null-old", daysAgo(effective + 30), null); // past floor → prunable
      await mk("a4-ret-byoc-kept", daysAgo(effective + 30), "byoc"); // inside the byoc override → KEPT
      await mk("a4-ret-byoc-old", daysAgo(byocDays + 30), "byoc"); // past the override too → prunable
      await mk("a4-ret-hosted-old", daysAgo(effective + 30), "hosted"); // 5d override is INERT (< floor) → prunable
      await mk("a4-ret-fresh", daysAgo(1), null); // inside the floor → kept

      const floor = await retentionFloor(db);
      expect(floor.retainedDays).toBe(effective);
      expect(floor.modeOverrides).toEqual([
        { mode: "byoc", retainedDays: byocDays, cutoff: expect.any(Date) },
      ]);
      expect(floor.prunable).toBeGreaterThanOrEqual(3);

      const result = await runAuditPruneOnce(db, null, false);
      expect(result.deleted).toBeGreaterThanOrEqual(3);
      const survivors = await db
        .select({ ruleId: auditLog.ruleId })
        .from(auditLog)
        .where(eq(auditLog.reason, "a4 retention fixture"));
      const ids = survivors.map((s) => s.ruleId).sort();
      expect(ids).toEqual(["a4-ret-byoc-kept", "a4-ret-fresh"]);
    } finally {
      // clean the fixtures + restore the ambient settings (keep-all default)
      await db.delete(auditLog).where(eq(auditLog.reason, "a4 retention fixture"));
      const restore = await app.inject({
        method: "PUT", headers: AUTH, url: "/v1/org/settings",
        payload: { defaultAuditRetentionDays: null, modeAuditRetention: {} },
      });
      expect(restore.statusCode).toBe(200);
      // the ambient floor (whatever profile floors other suites created) holds
      const back = await retentionFloor(db);
      expect(back.retainedDays).toBe(ambient.retainedDays);
      expect(back.modeOverrides).toEqual([]);
    }
  });
});

afterAll(async () => {
  await restoreStrictAdmission?.();
});
