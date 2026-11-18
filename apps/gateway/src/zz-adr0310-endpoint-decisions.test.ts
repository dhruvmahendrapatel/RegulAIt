/**
 * ADR-0310 addendum (lane E1): endpoint decision audit and tamper reporting.
 *
 * The agent's signed decision batch: verified like a report (DPoP token, Content-Digest, a device-key JWS of its own
 * typ binding the batch id), one use per signature, one copy per batch id. Each decision is a hash-chained audit row;
 * sessions record each permission mode, so a permission-bypass session is a finding, and an agent that reports no
 * mode says so. Managed-file observations show a change on the device and a missing or weakened hook.
 *
 * The contract fixture is shared with the Go agent (agents/endpoint/internal/contract/testdata/decisions-batch.json).
 * Everything this suite creates is removed in afterAll.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { readFileSync } from "node:fs";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  and,
  auditLog,
  createDb,
  discoveryPseudonymKeys,
  discoverySources,
  endpointCodingSessionModes,
  endpointCodingSessions,
  endpointDecisionBatches,
  endpointManagedFileObservations,
  eq,
  inArray,
  runMigrations,
  sql,
  users,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";
import { decisionBatchSchema, ENDPOINT_DECISIONS_MAX_EVENTS } from "./endpoint-decisions.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { useTestIssuerKey } from "./testing/workload-client.js";
import { endpointAgentKeys } from "./testing/endpoint-agent-client.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(here, "../../../packages/db/migrations");
const FIXTURE = path.resolve(here, "../../../agents/endpoint/internal/contract/testdata/decisions-batch.json");

const RUN = randomBytes(3).toString("hex");
const BOOT = `e1dec-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const ORIGIN = "http://localhost";
// synthetic, derived at runtime: never a secret-shaped literal
const DATA_KEY = createHash("sha256").update(`e1dec-data-key-${RUN}`).digest("hex");
const prevPublicUrl = process.env.REGULAIT_PUBLIC_URL;
process.env.REGULAIT_PUBLIC_URL = ORIGIN;

let db: Db;
let app: ReturnType<typeof buildApp>;
let adminId: string;
let memberKey: { authorization: string };
const restores: Array<() => Promise<void>> = [];
const sourceIds: string[] = [];

const inject = (method: "GET" | "POST", url: string, headers: Record<string, string>, payload?: unknown) =>
  app.inject({ method, url, headers, ...(payload === undefined ? {} : { payload: payload as object }) });
const AgentKey = endpointAgentKeys(() => app, DATA_KEY, ORIGIN);
type AgentKey = InstanceType<typeof AgentKey>;

const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
const hex = (c: string) => c.repeat(64);

type Ev = Record<string, unknown>;
const batch = (o: { batchId?: string; events?: Ev[]; integrity?: unknown[]; droppedEvents?: number }) => {
  const batchId = o.batchId ?? randomUUID();
  return {
    batchId,
    body: JSON.stringify({ schema: "regulait.endpoint-decisions/1", batchId, sentAt: iso(new Date()), agentVersion: "0.9.0", droppedEvents: o.droppedEvents ?? 0, events: o.events ?? [], integrity: o.integrity ?? [] }),
  };
};
const decision = (o: Partial<{ agent: string; sessionRef: string | null; permissionMode: string | null; verdict: string; wouldDeny: boolean; wouldAsk: boolean; mode: string; action: string; emitter: string; ruleId: string | null; occurredAt: string }> = {}): Ev => ({
  eventId: randomUUID(),
  occurredAt: o.occurredAt ?? iso(new Date()),
  kind: "decision",
  agent: o.agent ?? "claude-code",
  sessionRef: o.sessionRef === undefined ? hex("a") : o.sessionRef,
  permissionMode: o.permissionMode === undefined ? "default" : o.permissionMode,
  decision: { emitter: o.emitter ?? "mcp-rules", action: o.action ?? "mcp", verdict: o.verdict ?? "deny", wouldDeny: o.wouldDeny ?? false, wouldAsk: o.wouldAsk ?? false, mode: o.mode ?? "enforce", ruleId: o.ruleId === undefined ? "rule.one" : o.ruleId },
});

let seq = 0;
async function enrolled() {
  const r = await inject("POST", "/v1/discovery/sources", AUTH, { name: `e1dec-agent-${RUN}-${++seq}`, kind: "endpoint_agent", target: { fleet: `fleet-${RUN}` }, scope: { orgLevel: true, include: [] } });
  expect(r.statusCode, r.body).toBe(201);
  const sourceId = r.json().id as string;
  sourceIds.push(sourceId);
  await db.update(discoverySources).set({ enabled: true, enabledAt: new Date(), enabledBy: adminId }).where(eq(discoverySources.id, sourceId));
  const tok = await inject("POST", `/v1/discovery/sources/${sourceId}/enrolment-tokens`, AUTH, { label: `e1dec-${RUN}`, deviceCap: 5 });
  expect(tok.statusCode, tok.body).toBe(201);
  const t = await inject("POST", "/v1/endpoint-agent/enrolment-tickets", { authorization: `Bearer ${tok.json().enrolFile.token}` }, { hostname: `e1dec-host-${RUN}-${seq}`, os: "linux", arch: "amd64", agentVersion: "0.1.0" });
  expect(t.statusCode, t.body).toBe(201);
  const key = await AgentKey.make();
  const reg = await inject("POST", "/v1/endpoint-agent/register", { authorization: `Bearer ${t.json().ticket}` }, {
    publicJwk: key.jwk,
    keyProtection: "hardware",
    keyProvider: "tpm",
    agentVersion: "0.1.0",
    os: "linux",
    arch: "amd64",
    deviceUser: `e1decuser${RUN}${seq}`,
  });
  expect(reg.statusCode, reg.body).toBe(201);
  return { sourceId, deviceId: t.json().ticketId as string, identityId: reg.json().identityId as string, key };
}

const decisionAudits = (deviceId: string) =>
  db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.objectType, "endpoint_device"), eq(auditLog.objectId, deviceId)))
    .orderBy(auditLog.seq);

beforeAll(async () => {
  process.env.REGULAIT_PUBLIC_URL = ORIGIN;
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restores.push(await relaxIdentityForTest(db, { mfaRequired: "off" }));
  restores.push(await useTestIssuerKey(db));
  // the per-tenant pseudonym key is wrapped under the first data key that asks for it (as the SD4b suite does)
  const prior = await db.select().from(discoveryPseudonymKeys);
  await db.delete(discoveryPseudonymKeys);
  restores.push(async () => {
    await db.delete(discoveryPseudonymKeys);
    if (prior.length) await db.insert(discoveryPseudonymKeys).values(prior);
  });
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
  await app.ready();
  const a = await inject("POST", "/v1/users", AUTH, { email: `e1dec-admin-${RUN}@example.com`, displayName: "e1dec admin" });
  expect(a.statusCode, a.body).toBe(201);
  adminId = a.json().id as string;
  await db.update(users).set({ isAdmin: true }).where(eq(users.id, adminId));
  const u = await inject("POST", "/v1/users", AUTH, { email: `e1dec-member-${RUN}@example.com`, displayName: "e1dec member" });
  const k = await inject("POST", `/v1/users/${u.json().id}/keys`, AUTH, { name: "k" });
  memberKey = { authorization: `Bearer ${k.json().token}` };
}, 120_000);

afterAll(async () => {
  if (sourceIds.length) {
    await db.update(discoverySources).set({ enabled: false }).where(inArray(discoverySources.id, sourceIds));
    await db.delete(discoverySources).where(inArray(discoverySources.id, sourceIds));
  }
  for (const r of restores.reverse()) await r();
  await app?.close();
  if (prevPublicUrl === undefined) delete process.env.REGULAIT_PUBLIC_URL;
  else process.env.REGULAIT_PUBLIC_URL = prevPublicUrl;
});

describe("ADR-0310 addendum: the decision batch contract", () => {
  it("parses the fixture the Go agent pins, and refuses what the contract forbids", () => {
    const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as Record<string, unknown>;
    expect(decisionBatchSchema.safeParse(fixture).success).toBe(true);
    const events = (fixture.events as Ev[]).map((e) => ({ ...e }));
    const bad = (mut: (b: Record<string, unknown>) => void) => {
      const b = structuredClone(fixture);
      mut(b);
      return decisionBatchSchema.safeParse(b).success;
    };
    // a mode from an agent that reports none; a plain no-decision as an event; both would-flags; an argument field
    expect(bad((b) => ((b.events as Ev[])[3]!.permissionMode = "default"))).toBe(false);
    expect(bad((b) => (((b.events as Ev[])[2]!.decision as Ev).wouldDeny = false))).toBe(false);
    expect(bad((b) => (((b.events as Ev[])[2]!.decision as Ev).wouldAsk = true))).toBe(false);
    expect(bad((b) => (((b.events as Ev[])[1]!.decision as Ev).command = "git push"))).toBe(false);
    expect(bad((b) => ((b.events as Ev[])[0]!.decision = (events[1] as Ev).decision))).toBe(false);
    expect(bad((b) => ((b.integrity as Ev[])[1]!.sha256 = hex("d")))).toBe(false);
    expect(bad((b) => (b.events = Array.from({ length: ENDPOINT_DECISIONS_MAX_EVENTS + 1 }, () => decision())))).toBe(false);
  });
});

describe("ADR-0310 addendum: signed decision batches", () => {
  it("audits every decision on the chain, records sessions and their modes, and treats a resent batch as a duplicate", async () => {
    const a = await enrolled();
    const sRef = hex("1");
    const { batchId, body } = batch({
      events: [
        { eventId: randomUUID(), occurredAt: iso(new Date()), kind: "session", agent: "claude-code", sessionRef: sRef, permissionMode: "bypassPermissions" },
        decision({ sessionRef: sRef, permissionMode: "bypassPermissions", verdict: "deny" }),
        decision({ sessionRef: sRef, permissionMode: "bypassPermissions", verdict: "ask", emitter: "command-rules", action: "command", ruleId: null }),
        decision({ agent: "codex", sessionRef: hex("2"), verdict: "none", wouldDeny: true, mode: "audit", emitter: "command-rules", action: "package" }),
        decision({ agent: "copilot-cli", sessionRef: null, permissionMode: null, verdict: "allow" }),
      ],
    });
    const r = await a.key.decisions(body, batchId);
    expect(r.statusCode, r.body).toBe(202);
    expect(r.json()).toEqual({ accepted: true, duplicate: false, audited: 4, refused: 0 });

    const rows = await decisionAudits(a.deviceId);
    const byRule = (id: string) => rows.filter((x) => x.ruleId === id);
    expect(byRule("endpoint-hook-deny")).toHaveLength(1);
    expect(byRule("endpoint-hook-deny")[0]!.effect).toBe("deny");
    expect(byRule("endpoint-hook-ask")[0]!.effect).toBe("require_approval");
    expect(byRule("endpoint-hook-would-deny")[0]!.effect).toBe("allow");
    expect(byRule("endpoint-hook-allow")).toHaveLength(1);
    expect(byRule("endpoint-permission-bypass-session")).toHaveLength(1);
    expect(byRule("endpoint-decision-batch-accepted")).toHaveLength(1);
    // every row is on the hash chain, and no argument ever reached it
    expect(rows.every((x) => x.seq !== null && x.rowHash !== null)).toBe(true);
    expect(JSON.stringify(rows.map((x) => x.detail))).not.toMatch(/tool_input|"command":|"cwd":|transcript/);

    const sessions = await db.select().from(endpointCodingSessions).where(eq(endpointCodingSessions.identityId, a.identityId));
    expect(sessions).toHaveLength(3);
    const claude = sessions.find((s) => s.agent === "claude-code")!;
    expect({ d: claude.decisions, deny: claude.denies, ask: claude.asks }).toEqual({ d: 2, deny: 1, ask: 1 });
    const modes = await db.select().from(endpointCodingSessionModes).where(eq(endpointCodingSessionModes.sessionId, claude.id));
    expect(modes.map((m) => m.permissionMode)).toEqual(["bypassPermissions"]);

    // a resend of the same batch (fresh signature) is a duplicate: nothing is counted or audited twice
    const again = await a.key.decisions(body, batchId);
    expect(again.statusCode).toBe(202);
    expect(again.json()).toEqual({ accepted: true, duplicate: true });
    expect((await decisionAudits(a.deviceId)).length).toBe(rows.length);
    const [claudeAfter] = await db.select().from(endpointCodingSessions).where(eq(endpointCodingSessions.id, claude.id));
    expect(claudeAfter!.decisions).toBe(2);

    // a later batch for the same session adds to it; the bypass finding is raised once per session, not per batch
    const next = batch({ events: [decision({ sessionRef: sRef, permissionMode: "bypassPermissions", verdict: "deny" })] });
    expect((await a.key.decisions(next.body, next.batchId)).statusCode).toBe(202);
    const [c2] = await db.select().from(endpointCodingSessions).where(eq(endpointCodingSessions.id, claude.id));
    expect(c2!.decisions).toBe(3);
    expect((await decisionAudits(a.deviceId)).filter((x) => x.ruleId === "endpoint-permission-bypass-session")).toHaveLength(1);
  });

  it("refuses unsigned, wrong-typ, replayed, mismatched and malformed batches with fixed codes, audited", async () => {
    const a = await enrolled();
    const ok = batch({ events: [decision()] });
    const code = async (p: Promise<{ statusCode: number; json: () => { error?: string } }>) => {
      const r = await p;
      return `${r.statusCode} ${r.json().error}`;
    };
    expect(await code(a.key.decisions(ok.body, ok.batchId, { signature: null }))).toBe("400 invalid_decisions_signature");
    // a report signature is not a decisions signature
    const reportSig = await a.key.reportSignature(ok.body, { snapshotId: ok.batchId });
    expect(await code(a.key.decisions(ok.body, ok.batchId, { signature: reportSig }))).toBe("400 invalid_decisions_signature");
    // a signature over another batch id
    const otherId = await a.key.decisionsSignature(ok.body, { batchId: randomUUID() });
    expect(await code(a.key.decisions(ok.body, ok.batchId, { signature: otherId }))).toBe("400 invalid_decisions_signature");
    // a stale one
    const stale = await a.key.decisionsSignature(ok.body, { batchId: ok.batchId, iat: Math.floor(Date.now() / 1000) - 3600 });
    expect(await code(a.key.decisions(ok.body, ok.batchId, { signature: stale }))).toBe("400 decisions_signature_stale");
    // one use per signature
    const once = await a.key.decisionsSignature(ok.body, { batchId: ok.batchId });
    expect((await a.key.decisions(ok.body, ok.batchId, { signature: once })).statusCode).toBe(202);
    expect(await code(a.key.decisions(ok.body, ok.batchId, { signature: once }))).toBe("400 decisions_replayed");
    // a body the schema refuses (an argument field)
    const leaky = batch({ events: [{ ...decision(), tool_input: { command: "cat secrets" } }] });
    expect(await code(a.key.decisions(leaky.body, leaky.batchId))).toBe("400 invalid_body");
    const refusals = (await decisionAudits(a.deviceId)).filter((x) => x.ruleId === "endpoint-decision-batch-refused");
    expect(refusals.map((x) => (x.detail as { code: string }).code).sort()).toEqual(
      ["decisions_replayed", "decisions_signature_stale", "invalid_body", "invalid_decisions_signature", "invalid_decisions_signature", "invalid_decisions_signature"].sort(),
    );
    // a person's key reaches no agent route
    expect((await inject("POST", "/v1/endpoint-agent/decisions", AUTH, {})).statusCode).toBe(401);
  });

  it("counts stale and future events as refused without auditing them, and reports device-side drops", async () => {
    const a = await enrolled();
    const old = new Date(Date.now() - 8 * 24 * 3600 * 1000);
    const ahead = new Date(Date.now() + 3600 * 1000);
    const b = batch({ droppedEvents: 7, events: [decision({ occurredAt: iso(old) }), decision({ occurredAt: iso(ahead) }), decision()] });
    const r = await a.key.decisions(b.body, b.batchId);
    expect(r.json()).toEqual({ accepted: true, duplicate: false, audited: 1, refused: 2 });
    const [row] = await db.select().from(endpointDecisionBatches).where(eq(endpointDecisionBatches.batchId, b.batchId));
    expect({ refused: row!.eventsRefused, dropped: row!.droppedEvents }).toEqual({ refused: 2, dropped: 7 });
  });
});

describe("ADR-0310 addendum: the permission-bypass session view", () => {
  it("is admin-only, flags bypass sessions, and says unknown for agents that report no mode", async () => {
    const a = await enrolled();
    const b = batch({
      events: [
        decision({ sessionRef: hex("5"), permissionMode: "bypassPermissions" }),
        decision({ agent: "codex", sessionRef: hex("6"), permissionMode: "default" }),
        decision({ agent: "cursor", sessionRef: hex("7"), permissionMode: null }),
      ],
    });
    expect((await a.key.decisions(b.body, b.batchId)).statusCode).toBe(202);
    expect((await inject("GET", "/v1/endpoint-decisions/sessions", memberKey)).statusCode).toBe(403);
    const all = await inject("GET", `/v1/endpoint-decisions/sessions?deviceId=${a.deviceId}`, AUTH);
    expect(all.statusCode, all.body).toBe(200);
    const s = all.json() as { sessions: Array<{ agent: string; permissionBypass: boolean | null; finding: string | null; permissionModeReported: boolean; device: { pseudonym: string } }>; coverage: Array<{ agent: string; permissionModeReported: boolean }> };
    const of = (agent: string) => s.sessions.find((x) => x.agent === agent)!;
    expect(of("claude-code")).toMatchObject({ permissionBypass: true, finding: "permission_bypass", permissionModeReported: true });
    expect(of("codex")).toMatchObject({ permissionBypass: false, finding: null });
    expect(of("cursor")).toMatchObject({ permissionBypass: null, finding: null, permissionModeReported: false });
    expect(of("claude-code").device.pseudonym).toMatch(/^psn:[0-9a-f]{24}$/);
    expect(s.coverage.filter((c) => !c.permissionModeReported).map((c) => c.agent).sort()).toEqual(["copilot-cli", "cursor"]);
    const onlyBypass = await inject("GET", `/v1/endpoint-decisions/sessions?deviceId=${a.deviceId}&bypass=true`, AUTH);
    expect((onlyBypass.json() as { sessions: unknown[] }).sessions).toHaveLength(1);
    // keyset pages: one at a time, no repeats, then the end
    const p1 = (await inject("GET", `/v1/endpoint-decisions/sessions?deviceId=${a.deviceId}&limit=2`, AUTH)).json() as { sessions: Array<{ id: string }>; next: string | null };
    expect(p1.sessions).toHaveLength(2);
    const p2 = (await inject("GET", `/v1/endpoint-decisions/sessions?deviceId=${a.deviceId}&limit=2&before=${p1.next}`, AUTH)).json() as { sessions: Array<{ id: string }>; next: string | null };
    expect(p2.sessions).toHaveLength(1);
    expect(p2.next).toBeNull();
    expect(new Set([...p1.sessions, ...p2.sessions].map((x) => x.id)).size).toBe(3);
    expect((await inject("GET", "/v1/endpoint-decisions/sessions?limit=999", AUTH)).statusCode).toBe(400);
  });
});

describe("ADR-0310 addendum: managed-file tamper reporting", () => {
  it("shows a changed file, a lost hook and a removed file, audits each change once, and stays quiet for an unchanged one", async () => {
    const a = await enrolled();
    const send = async (integrity: unknown[]) => {
      const b = batch({ integrity });
      const r = await a.key.decisions(b.body, b.batchId);
      expect(r.statusCode, r.body).toBe(202);
    };
    await send([
      { file: "claude-code/managed-settings.json", state: "present", sha256: hex("a"), hookStatus: "registered" },
      { file: "openai-codex/requirements.toml", state: "present", sha256: hex("b"), hookStatus: "registered" },
      { file: "cursor/hooks.json", state: "present", sha256: hex("c"), hookStatus: "registered" },
      { file: "copilot-cli/policy.json", state: "missing", sha256: null, hookStatus: null },
    ]);
    // the same state again is not a change
    await send([{ file: "claude-code/managed-settings.json", state: "present", sha256: hex("a"), hookStatus: "registered" }]);
    expect((await decisionAudits(a.deviceId)).filter((x) => x.ruleId === "endpoint-managed-file-changed")).toHaveLength(0);
    await send([
      { file: "claude-code/managed-settings.json", state: "present", sha256: hex("d"), hookStatus: "registered" },
      { file: "openai-codex/requirements.toml", state: "present", sha256: hex("e"), hookStatus: "weakened" },
      { file: "cursor/hooks.json", state: "missing", sha256: null, hookStatus: null },
      { file: "copilot-cli/policy.json", state: "missing", sha256: null, hookStatus: null },
    ]);
    expect((await decisionAudits(a.deviceId)).filter((x) => x.ruleId === "endpoint-managed-file-changed")).toHaveLength(3);
    expect((await inject("GET", "/v1/endpoint-decisions/tamper", memberKey)).statusCode).toBe(403);
    const r = await inject("GET", `/v1/endpoint-decisions/tamper?deviceId=${a.deviceId}`, AUTH);
    expect(r.statusCode, r.body).toBe(200);
    const t = r.json() as { devices: Array<{ files: Array<{ file: string; status: string; finding: boolean; bundleMatch: unknown; statesSeen?: number }> }>; findings: number };
    expect(t.devices).toHaveLength(1);
    const f = (name: string) => t.devices[0]!.files.find((x) => x.file === name)!;
    expect(f("claude-code/managed-settings.json")).toMatchObject({ status: "changed", finding: true, bundleMatch: "none", statesSeen: 2 });
    expect(f("openai-codex/requirements.toml")).toMatchObject({ status: "hook_weakened", finding: true });
    expect(f("cursor/hooks.json")).toMatchObject({ status: "file_missing", finding: true, bundleMatch: null });
    // never present on this device: the vendor is not deployed there, which is not tamper
    expect(f("copilot-cli/policy.json")).toMatchObject({ status: "file_missing", finding: false });
    expect(t.findings).toBe(3);
    const obs = await db.select({ n: sql<number>`count(*)::int` }).from(endpointManagedFileObservations).where(eq(endpointManagedFileObservations.identityId, a.identityId));
    expect(obs[0]!.n).toBe(7);
  });
});
