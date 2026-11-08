/**
 * ADR-0246 addendum — offensive MCP tool servers as high-risk, on a real database through the real app, against the
 * `offensive-tooling` fixture of `@regulait/mcp-vuln-fixtures` (our own, simulated; no real offensive tool):
 *
 *  - admission classifies the server high-risk (our rule set), audited; a benign fixture stays standard;
 *  - default deny: every call is refused until the policy template is applied, then a call must name a target and
 *    every target must be on the authorised list (adding one is a step-up, audited);
 *  - a call that passes reaches the kernel, which queues it for the template's quorum approval; the upstream never
 *    receives a tools/call; every call's audit row carries its arguments with secrets redacted;
 *  - relaxing `mcpHighRiskMode` to 'off' needs the step-up.
 *
 * Global state (M-068): every org setting this file moves is put back in afterAll.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  and,
  approvals,
  auditLog,
  createDb,
  desc,
  eq,
  mcpServers,
  orgSettings,
  ORG_SETTINGS_ID,
  roleAssignments,
  roles,
  runMigrations,
  users,
  type Db,
} from "@regulait/db";
import { BATCH4_STRICT_DEFAULTS } from "@regulait/shared";
import { fixtureState, serveFixtureOverHttp, vulnFixture, type McpAttackClass, type ServedFixture } from "@regulait/mcp-vuln-fixtures";
import { buildApp } from "./app.js";
import { executeGovernedToolCall } from "./mcp-proxy.js";
import { MCP_HIGH_RISK_RULE_IDS } from "./mcp-high-risk.js";
import { relaxStrictAdmissionForTest } from "./testing/strict-admission.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";
import { grantStepUpForTest, stepUpRequest } from "./testing/step-up-grant.js";
import { relaxApprovalSigningForTest } from "./testing/approval-signing-posture.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL must name a disposable test database");
const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `hr-boot-${RUN}`;
const boot = { authorization: `Bearer ${BOOT}` };
// targets unique to this run: the suite shares one database, and the authorised list is global
const LAB = `lab-${RUN}.example.test`;
const IN_SCOPE = `scan.${LAB}`;
const OUT_OF_SCOPE = `scan.other-${RUN}.example.test`;

let db: Db;
let app: ReturnType<typeof buildApp>;
let adminId: string;
let adminKey: { authorization: string };
const ids: Record<"caller" | "a" | "b", string> = { caller: "", a: "", b: "" };
let roleId: string;
const restores: Array<() => Promise<void>> = [];
const served: ServedFixture[] = [];

async function mkUser(label: string): Promise<string> {
  const r = await app.inject({ method: "POST", url: "/v1/users", headers: boot, payload: { email: `hr-${label}-${RUN}@example.test`, displayName: `HR ${label}` } });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().id as string;
}

beforeAll(async () => {
  db = createDb(databaseUrl);
  await runMigrations(db, path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations"));
  restores.push(await relaxStrictAdmissionForTest(db));
  restores.push(await relaxIdentityForTest(db, { mfaRequired: "off" }));
  // passkey signing of approvals is not what this file is about (zz-b4ab proves it); quorum and pool still apply
  restores.push(await relaxApprovalSigningForTest(db));
  const [before] = await db
    .select({ mode: orgSettings.stepUpMode, actions: orgSettings.stepUpActions, hr: orgSettings.mcpHighRiskMode, pin: orgSettings.mcpDefinitionPinMode })
    .from(orgSettings)
    .where(eq(orgSettings.id, ORG_SETTINGS_ID));
  await db
    .update(orgSettings)
    .set({ stepUpMode: "required", stepUpActions: [...BATCH4_STRICT_DEFAULTS.stepUpActions], mcpHighRiskMode: "enforce", mcpDefinitionPinMode: "block" })
    .where(eq(orgSettings.id, ORG_SETTINGS_ID));
  restores.push(async () => {
    await db
      .update(orgSettings)
      .set({ stepUpMode: before!.mode, stepUpActions: before!.actions, mcpHighRiskMode: before!.hr, mcpDefinitionPinMode: before!.pin })
      .where(eq(orgSettings.id, ORG_SETTINGS_ID));
  });
  app = buildApp(db, { bootstrapToken: BOOT, retry: { maxAttempts: 1 }, timeouts: { mcpConnectMs: 2000, mcpListToolsMs: 2000, mcpCallToolMs: 2000 } });
  restores.push(await relaxGovernanceGatesForTest(db, { requireMcpAttribution: false }));
  await app.ready();
  adminId = await mkUser("admin");
  await db.update(users).set({ isAdmin: true }).where(eq(users.id, adminId));
  const key = await app.inject({ method: "POST", url: `/v1/users/${adminId}/keys`, headers: boot, payload: { name: "hr" } });
  adminKey = { authorization: `Bearer ${key.json().token}` };
  ids.caller = await mkUser("caller");
  ids.a = await mkUser("approver-a");
  ids.b = await mkUser("approver-b");
  const [role] = await db.insert(roles).values({ name: `hr approvers ${RUN}` }).returning({ id: roles.id });
  roleId = role!.id;
  // the caller is in the approver role on purpose: the pool must still exclude them
  for (const u of [ids.b, ids.caller]) await db.insert(roleAssignments).values({ userId: u, roleId });
}, 120_000);

afterAll(async () => {
  for (const s of served) await s.close();
  for (const restore of restores.reverse()) await restore();
  await app.close();
});

async function register(id: McpAttackClass) {
  const state = fixtureState(vulnFixture(id));
  const s = await serveFixtureOverHttp(state);
  served.push(s);
  const r = await app.inject({ method: "POST", url: "/v1/servers", headers: boot, payload: { name: `hr-${id}-${crypto.randomUUID()}`, url: s.url } });
  expect(r.statusCode, r.body).toBe(201);
  const serverId = r.json().id as string;
  const g = await grantStepUpForTest(db, adminId, { kind: "settings_relax", facts: { serverId, values: { mcpToolSync: serverId } } });
  const synced = await app.inject({ method: "POST", url: `/v1/servers/${serverId}/tools/sync`, ...stepUpRequest(g) });
  expect(synced.statusCode, synced.body).toBe(200);
  return { serverId, state };
}

const lastAudit = async (ruleId: string, serverId?: string) =>
  (await db.select().from(auditLog).where(serverId ? and(eq(auditLog.ruleId, ruleId), eq(auditLog.serverId, serverId)) : eq(auditLog.ruleId, ruleId)).orderBy(desc(auditLog.seq)).limit(1))[0];

describe("ADR-0246 addendum: an offensive-tooling server", () => {
  let off: Awaited<ReturnType<typeof register>>;
  const call = (toolName: string, args: Record<string, unknown>) =>
    executeGovernedToolCall(db, undefined, { userId: ids.caller, serverId: off.serverId, toolName, arguments: args });
  const deniedWith = async (toolName: string, args: Record<string, unknown>, ruleId: string) => {
    const out = await call(toolName, args);
    expect(out.kind, JSON.stringify(out)).toBe("denied");
    if (out.kind === "denied") expect(out.decision.ruleId).toBe(ruleId);
  };

  it("is classified high-risk at admission, audited; a benign server is not", async () => {
    off = await register("offensive-tooling");
    const r = await app.inject({ method: "GET", url: `/v1/servers/${off.serverId}/high-risk-policy`, headers: boot });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ riskClass: "high", mode: "enforce", policyApplied: false });
    expect(r.json().riskFindings.categories).toEqual(["network_reconnaissance", "vulnerability_exploitation", "credential_attack"]);
    expect((await lastAudit(MCP_HIGH_RISK_RULE_IDS.classified, off.serverId))?.effect).toBe("allow");
    const benign = await register("rug-pull");
    const [row] = await db.select({ riskClass: mcpServers.riskClass }).from(mcpServers).where(eq(mcpServers.id, benign.serverId));
    expect(row?.riskClass).toBe("standard");
    for (const toolName of ["port_scan", "run_exploit"]) {
      const g = await app.inject({ method: "POST", url: "/v1/grants/tools", headers: boot, payload: { userId: ids.caller, serverId: off.serverId, toolName } });
      expect(g.statusCode, g.body).toBe(201);
    }
  });

  it("refuses every call (default deny) until the policy template is applied", async () => {
    await deniedWith("port_scan", { target: IN_SCOPE }, MCP_HIGH_RISK_RULE_IDS.noPolicy);
    const applied = await app.inject({
      method: "POST",
      url: `/v1/servers/${off.serverId}/high-risk-policy`,
      headers: boot,
      payload: { approverUserId: ids.a, approverRoleId: roleId, quorum: 2, maxCalls: 5, windowSeconds: 3600 },
    });
    expect(applied.statusCode, applied.body).toBe(201);
    expect(applied.json().approvalRule).toMatchObject({ scope: "fleet", serverScope: "server", quorum: 2, toolName: null });
    expect(applied.json().rateLimit).toMatchObject({ maxCalls: 5, windowSeconds: 3600 });
    expect((await lastAudit(MCP_HIGH_RISK_RULE_IDS.policyApplied, off.serverId))?.effect).toBe("allow");
    const policy = await app.inject({ method: "GET", url: `/v1/servers/${off.serverId}/high-risk-policy`, headers: boot });
    expect(policy.json().policyApplied).toBe(true);
  });

  it("then needs a named target, and refuses one that is not on the authorised list", async () => {
    await deniedWith("port_scan", { ports: "1-1024" }, MCP_HIGH_RISK_RULE_IDS.targetRequired);
    await deniedWith("port_scan", { target: IN_SCOPE }, MCP_HIGH_RISK_RULE_IDS.targetRefused);
    const row = await lastAudit(MCP_HIGH_RISK_RULE_IDS.targetRefused, off.serverId);
    expect((row?.detail as { refusedTargets: string[] }).refusedTargets).toEqual([IN_SCOPE]);
    await deniedWith("port_scan", { target: OUT_OF_SCOPE }, MCP_HIGH_RISK_RULE_IDS.targetRefused);
  });

  it("adding an authorised target is a step-up, audited", async () => {
    const payload = { kind: "domain", value: LAB, note: "lab range, pentest engagement 42" };
    const asked = await app.inject({ method: "POST", url: "/v1/mcp/authorised-targets", headers: adminKey, payload });
    expect(asked.statusCode, asked.body).toBe(403);
    expect(asked.json()).toMatchObject({ error: "step_up_required", actionKind: "settings_relax" });
    const g = await grantStepUpForTest(db, adminId, { kind: "settings_relax", facts: { values: { mcpAuthorisedTarget: ["domain", LAB] } } });
    const added = await app.inject({ method: "POST", url: "/v1/mcp/authorised-targets", ...stepUpRequest(g), payload });
    expect(added.statusCode, added.body).toBe(201);
    expect((await lastAudit(MCP_HIGH_RISK_RULE_IDS.targetAdded))?.effect).toBe("allow");
    const bad = await app.inject({ method: "POST", url: "/v1/mcp/authorised-targets", headers: boot, payload: { kind: "cidr", value: "10.0.0.1", note: "x" } });
    expect(bad.statusCode).toBe(400);
  });

  it("an authorised call goes to the kernel and is queued for the quorum approval; arguments are audited, redacted", async () => {
    // not credential-shaped (that is the credential-audience guard's refusal); redacted by its argument name
    const secret = "plain-value-" + RUN + "-do-not-log";
    const out = await call("run_exploit", { target: IN_SCOPE, module: "simulated", api_key: secret });
    expect(out.kind, JSON.stringify(out)).toBe("approval_required");
    const [queued] = await db.select({ quorum: approvals.quorum }).from(approvals).where(eq(approvals.id, (out as { approvalId: string }).approvalId));
    expect(queued?.quorum).toBe(2);
    const row = await lastAudit(MCP_HIGH_RISK_RULE_IDS.call, off.serverId);
    const detail = row?.detail as { arguments: Record<string, unknown>; targets: string[] };
    expect(detail.arguments).toMatchObject({ target: IN_SCOPE, module: "simulated" });
    // ours ("[REDACTED]") and the ADR-0099 audit writer's own field scrub both apply; either marker is a redaction
    expect(String(detail.arguments.api_key)).toMatch(/^\[redacted/i);
    expect(JSON.stringify(row)).not.toContain(secret);
    await deniedWith("run_exploit", { target: IN_SCOPE, rhosts: [OUT_OF_SCOPE], module: "m" }, MCP_HIGH_RISK_RULE_IDS.targetRefused);
    // a credential-shaped value is still refused by the ADR-0186 V audience guard after this gate lets it through
    const keyed = await call("run_exploit", { target: IN_SCOPE, module: "m", api_key: "sk-test-" + "0123456789abcdef0123456789abcdef" });
    expect(keyed.kind).toBe("denied");
    expect(off.state.calls).toEqual([]);
  });

  it("finding 2: a target hidden in an unrecognised or nested key is checked, not just the recognised one", async () => {
    // the recognised 'target' holds an authorised value; an out-of-scope host rides in an unrecognised key
    await deniedWith("run_exploit", { target: IN_SCOPE, module: "m", lhost: OUT_OF_SCOPE }, MCP_HIGH_RISK_RULE_IDS.targetRefused);
    await deniedWith("run_exploit", { target: IN_SCOPE, module: "m", opts: { callback: OUT_OF_SCOPE } }, MCP_HIGH_RISK_RULE_IDS.targetRefused);
    const row = await lastAudit(MCP_HIGH_RISK_RULE_IDS.targetRefused, off.serverId);
    expect((row?.detail as { refusedTargets: string[] }).refusedTargets).toContain(OUT_OF_SCOPE);
  });

  it("finding 1: a call with more arguments than the scan budget is refused, not let through", async () => {
    const huge: Record<string, unknown> = { target: IN_SCOPE, module: "m", items: Array.from({ length: 30_000 }, (_, i) => `n${i}`) };
    await deniedWith("run_exploit", huge, MCP_HIGH_RISK_RULE_IDS.targetRefused);
    expect(off.state.calls).toEqual([]);
  });

  it("relaxing the high-risk mode to 'off' needs the step-up", async () => {
    const asked = await app.inject({ method: "PUT", url: "/v1/org/settings", headers: adminKey, payload: { mcpHighRiskMode: "off" } });
    expect(asked.statusCode, asked.body).toBe(403);
    expect(asked.json()).toMatchObject({ error: "step_up_required", actionKind: "settings_relax" });
  });

  it("finding 3: an admin marks a neutrally-named server high-risk by hand, audited, and it is then gated", async () => {
    // the rug-pull fixture names its tools neutrally, so the automatic classifier leaves it 'standard'
    const benign = await register("rug-pull");
    const [before] = await db.select({ riskClass: mcpServers.riskClass }).from(mcpServers).where(eq(mcpServers.id, benign.serverId));
    expect(before?.riskClass).toBe("standard");

    const marked = await app.inject({ method: "POST", url: `/v1/servers/${benign.serverId}/risk-class`, headers: boot, payload: { reason: "manual pen-test scope: it drives nmap under the hood" } });
    expect(marked.statusCode, marked.body).toBe(200);
    expect(marked.json()).toMatchObject({ riskClass: "high" });
    expect((await lastAudit(MCP_HIGH_RISK_RULE_IDS.markedManually, benign.serverId))?.effect).toBe("allow");

    // now gated: a call is refused for want of the policy template, and the upstream sees no tools/call
    const out = await executeGovernedToolCall(db, undefined, { userId: ids.caller, serverId: benign.serverId, toolName: "get_weather", arguments: { city: "Oslo" } });
    expect(out.kind, JSON.stringify(out)).toBe("denied");
    if (out.kind === "denied") expect(out.decision.ruleId).toBe(MCP_HIGH_RISK_RULE_IDS.noPolicy);
    expect(benign.state.calls).toEqual([]);

    // idempotent-ish: marking an already-high server is a 409, nothing changes
    const again = await app.inject({ method: "POST", url: `/v1/servers/${benign.serverId}/risk-class`, headers: boot, payload: { reason: "again" } });
    expect(again.statusCode).toBe(409);
  });
});
