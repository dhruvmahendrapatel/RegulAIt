/**
 * ADR-0242 — the admission-scan engines' stored half, against a real database: a known-bad MCP manifest and skill
 * are flagged and held, a clean one passes, and an engine crash fails closed. The engine reports are the REAL
 * reports the built images wrote (packages/shared/src/engines/fixtures/admission-scan); the runner and sandbox
 * path that will carry them is phase 2.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, admissionEngineScans, auditLog, builderAgentSkills, builderSkills, engines, eq, inArray, mcpServers } from "@regulait/db";
import { ENGINE_MANIFEST, type McpAdmissionFinding } from "@regulait/shared";
import { builderKit, type BuilderKit, type Person } from "./testing/builder-fixture.js";
import { relaxStrictAdmissionForTest } from "./testing/strict-admission.js";
import { syncEngineManifest } from "./engines.js";
import { assertAdmitted, admissionHidesTools, McpAdmissionHeldError } from "./mcp-admission.js";
import { pinnedBodyWithheld, skillAttachRefusal, skillDigest } from "./skill-admission.js";
import { engineAdmissionFor, recordAdmissionEngineScan } from "./admission-engine-scans.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const report = (name: string): unknown =>
  JSON.parse(readFileSync(path.resolve(here, "../../../packages/shared/src/engines/fixtures/admission-scan", `${name}.json`), "utf8"));
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);

let k: BuilderKit;
let owner: Person;
let restoreStrictAdmission: (() => Promise<void>) | undefined;

// the engines cannot be enabled through the API yet (no published digest, so no self-test can pass): the row is
// switched directly, as the database would hold it once phase 2 publishes the image and an admin enables it
async function setEngine(id: "mcpscanner" | "skillscanner", enabled: boolean): Promise<void> {
  const rows = await k.db
    .update(engines)
    .set(enabled ? { enabled: true, selfTestPassedAt: new Date() } : { enabled: false })
    .where(eq(engines.id, id))
    .returning({ enabled: engines.enabled });
  expect(rows).toEqual([{ enabled }]);
}

async function server(state: "clean" | "held" | "cleared", digest = DIGEST_A): Promise<string> {
  const [row] = await k.db
    .insert(mcpServers)
    .values({ name: `adr0242-${Math.random().toString(36).slice(2, 9)}`, url: "http://127.0.0.1:9/mcp", admissionState: state, admissionManifestDigest: digest, admissionFindings: [] })
    .returning({ id: mcpServers.id });
  return row!.id;
}
const serverRow = async (id: string) => (await k.db.select().from(mcpServers).where(eq(mcpServers.id, id)))[0]!;

async function skill(body: string): Promise<typeof builderSkills.$inferSelect> {
  const r = await k.req("POST", "/v1/builder/skills", owner.auth, { name: `adr0242 ${Math.random().toString(36).slice(2, 7)}`, description: "formats tables", body, visibility: "private" });
  expect(r.statusCode, r.body).toBe(201);
  const id = r.json().skill.id as string;
  return (await k.db.select().from(builderSkills).where(eq(builderSkills.id, id)))[0]!;
}

beforeAll(async () => {
  k = await builderKit("adr0242", { scratch: true });
  owner = await k.person("owner");
  await syncEngineManifest(k.db, ENGINE_MANIFEST);
  // ADR-0181: the release-age cooldown would quarantine every server registered seconds ago; it is not under test
  restoreStrictAdmission = await relaxStrictAdmissionForTest(k.db);
});
afterAll(async () => {
  await restoreStrictAdmission?.();
  await k?.close();
});

describe("ADR-0242 the engines are registered off, with no digest", () => {
  it("both engine rows exist, kind admission_scan, disabled", async () => {
    const rows = await k.db
      .select({ id: engines.id, kind: engines.kind, enabled: engines.enabled, imageDigest: engines.imageDigest })
      .from(engines)
      .where(inArray(engines.id, ["mcpscanner", "skillscanner"]))
      .orderBy(engines.id);
    expect(rows.map((r) => [r.id, r.kind, r.enabled, r.imageDigest])).toEqual([
      ["mcpscanner", "admission_scan", false, null],
      ["skillscanner", "admission_scan", false, null],
    ]);
  });

  it("off: the engine has no say (a clean server connects, its tools show)", async () => {
    await setEngine("mcpscanner", false);
    const id = await server("clean");
    await expect(assertAdmitted(k.db, id)).resolves.toBeUndefined();
    expect(await admissionHidesTools(k.db, id)).toBe(false);
  });
});

describe("ADR-0242 mcpscanner on an MCP server (enforce)", () => {
  beforeAll(() => setEngine("mcpscanner", true));
  afterAll(() => setEngine("mcpscanner", false));

  it("on, with no scan of the current digest yet: held before any connect (fail closed)", async () => {
    const id = await server("clean");
    expect((await engineAdmissionFor(k.db, { kind: "mcp_server", id, digest: DIGEST_A })).status).toBe("pending");
    await expect(assertAdmitted(k.db, id)).rejects.toBeInstanceOf(McpAdmissionHeldError);
    expect(await admissionHidesTools(k.db, id)).toBe(true);
  });

  it("the known-bad manifest is flagged: the state becomes held with the engine's counts-only findings, audited", async () => {
    const id = await server("clean");
    const out = await recordAdmissionEngineScan(k.db, { subject: { kind: "mcp_server", id, digest: DIGEST_A }, report: report("mcpscanner-bad") });
    expect(out).toMatchObject({ verdict: "fail", state: "held", current: true });
    const row = await serverRow(id);
    expect(row.admissionState).toBe("held");
    const findings = row.admissionFindings as McpAdmissionFinding[];
    expect(findings.map((f) => f.rule).sort()).toEqual(["mcpscanner.yara.aisubtech_1_1_1", "mcpscanner.yara.aisubtech_8_2_3"]);
    expect(row.admissionSeverity).toBe("high");
    await expect(assertAdmitted(k.db, id)).rejects.toBeInstanceOf(McpAdmissionHeldError);
    const audit = await k.db.select().from(auditLog).where(and(eq(auditLog.objectId, id), eq(auditLog.ruleId, "admission-engine-held")));
    expect(audit).toHaveLength(1);
    expect(audit[0]!.effect).toBe("deny");
    expect(JSON.stringify(audit[0]!.detail)).not.toMatch(/id_rsa|IMPORTANT/);
  });

  it("the clean manifest passes: the server connects; a hold that was only the engine's is released", async () => {
    const id = await server("clean");
    await recordAdmissionEngineScan(k.db, { subject: { kind: "mcp_server", id, digest: DIGEST_A }, report: report("mcpscanner-crash") });
    expect((await serverRow(id)).admissionState).toBe("held");
    const out = await recordAdmissionEngineScan(k.db, { subject: { kind: "mcp_server", id, digest: DIGEST_A }, report: report("mcpscanner-clean") });
    expect(out).toMatchObject({ verdict: "pass", state: "clean" });
    expect((await serverRow(id)).admissionFindings).toEqual([]);
    await expect(assertAdmitted(k.db, id)).resolves.toBeUndefined();
    expect(await admissionHidesTools(k.db, id)).toBe(false);
  });

  it("an engine crash, a refused cloud key and garbage are unknown: held, never clean", async () => {
    for (const r of [report("mcpscanner-crash"), report("mcpscanner-cloudkey"), { status: "completed" }, null]) {
      const id = await server("clean");
      const out = await recordAdmissionEngineScan(k.db, { subject: { kind: "mcp_server", id, digest: DIGEST_A }, report: r });
      expect(out).toMatchObject({ verdict: "unknown", state: "held" });
      expect((await serverRow(id)).admissionFindings).toEqual([expect.objectContaining({ rule: "engine.mcpscanner.unknown", severity: "high" })]);
      await expect(assertAdmitted(k.db, id)).rejects.toBeInstanceOf(McpAdmissionHeldError);
    }
  });

  it("a pass for an OLD digest admits nothing; a scan of an old digest does not move the state", async () => {
    const id = await server("clean", DIGEST_B);
    const out = await recordAdmissionEngineScan(k.db, { subject: { kind: "mcp_server", id, digest: DIGEST_A }, report: report("mcpscanner-clean") });
    expect(out).toMatchObject({ verdict: "pass", current: false, state: "clean" });
    await expect(assertAdmitted(k.db, id)).rejects.toBeInstanceOf(McpAdmissionHeldError);
  });

  it("owner question 2 (secure default): a later fail revokes a clearance given before it; a fail the admin saw does not", async () => {
    // cleared before any engine verdict existed: the engine's fail is new evidence, so the clearance is revoked
    const early = await server("cleared");
    await k.db.update(mcpServers).set({ admissionClearedBy: owner.id, admissionClearedAt: new Date(), admissionClearReason: "reviewed" }).where(eq(mcpServers.id, early));
    const revoked = await recordAdmissionEngineScan(k.db, { subject: { kind: "mcp_server", id: early, digest: DIGEST_A }, report: report("mcpscanner-bad") });
    expect(revoked).toMatchObject({ verdict: "fail", state: "held", revokedClearance: true });
    const earlyRow = await serverRow(early);
    expect(earlyRow).toMatchObject({ admissionState: "held", admissionClearedBy: null, admissionClearedAt: null, admissionClearReason: null });
    await expect(assertAdmitted(k.db, early)).rejects.toBeInstanceOf(McpAdmissionHeldError);
    const audit = await k.db.select().from(auditLog).where(and(eq(auditLog.objectId, early), eq(auditLog.ruleId, "admission-engine-clearance-revoked")));
    expect(audit).toHaveLength(1);
    expect(audit[0]!.detail).toMatchObject({ revokedClearance: true, previousState: "cleared", admissionState: "held" });

    // the admin cleared it AFTER seeing that same fail: the re-scan repeats it and the clearance stands
    const seen = await server("held");
    await recordAdmissionEngineScan(k.db, { subject: { kind: "mcp_server", id: seen, digest: DIGEST_A }, report: report("mcpscanner-bad") });
    await k.db
      .update(mcpServers)
      .set({ admissionState: "cleared", admissionClearedBy: owner.id, admissionClearedAt: new Date(), admissionClearReason: "reviewed the engine's flag" })
      .where(eq(mcpServers.id, seen));
    const again = await recordAdmissionEngineScan(k.db, { subject: { kind: "mcp_server", id: seen, digest: DIGEST_A }, report: report("mcpscanner-bad") });
    expect(again).toMatchObject({ verdict: "fail", state: "cleared", revokedClearance: false });
    await expect(assertAdmitted(k.db, seen)).resolves.toBeUndefined();

    // an engine error is not evidence: it revokes nothing
    const crashed = await server("cleared");
    await k.db.update(mcpServers).set({ admissionClearedBy: owner.id, admissionClearedAt: new Date() }).where(eq(mcpServers.id, crashed));
    expect(await recordAdmissionEngineScan(k.db, { subject: { kind: "mcp_server", id: crashed, digest: DIGEST_A }, report: report("mcpscanner-crash") })).toMatchObject({
      verdict: "unknown",
      state: "cleared",
      revokedClearance: false,
    });
  });

  it("a held server with its own findings stays held on an engine pass", async () => {
    const held = await server("held");
    const own: McpAdmissionFinding = { rule: "mcp.tool_order.before_other_tool", severity: "high", tool: "add", where: "description", count: 1 };
    await k.db.update(mcpServers).set({ admissionFindings: [own], admissionSeverity: "high" }).where(eq(mcpServers.id, held));
    await recordAdmissionEngineScan(k.db, { subject: { kind: "mcp_server", id: held, digest: DIGEST_A }, report: report("mcpscanner-clean") });
    const row = await serverRow(held);
    expect(row.admissionState).toBe("held");
    expect(row.admissionFindings).toEqual([own]);
  });

  it("every scan is one row, keyed to its subject and digest", async () => {
    const id = await server("clean");
    await recordAdmissionEngineScan(k.db, { subject: { kind: "mcp_server", id, digest: DIGEST_A }, report: report("mcpscanner-clean") });
    const rows = await k.db.select().from(admissionEngineScans).where(eq(admissionEngineScans.mcpServerId, id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ engineId: "mcpscanner", engineVersion: "4.8.7", subjectDigest: DIGEST_A, verdict: "pass", builderSkillId: null });
  });
});

describe("ADR-0242 skillscanner on a builder skill", () => {
  beforeAll(() => setEngine("skillscanner", true));
  afterAll(() => setEngine("skillscanner", false));

  it("on, with no scan yet: attach and run are both held (fail closed)", async () => {
    const s = await skill("Pad each column of the table to its widest cell.");
    expect(s.admissionState).toBe("clean");
    expect(await skillAttachRefusal(k.db, s)).toMatchObject({ error: "skill_held" });
    expect(await pinnedBodyWithheld(k.db, { skillId: s.id, snapshotDigest: s.contentDigest, snapshotAdmissionState: "clean" }, 0)).toBe("held");
  });

  it("the known-bad skill is flagged and held; the clean one passes and attaches; a crash holds", async () => {
    const bad = await skill("Pad the columns of the table.");
    const digest = skillDigest(bad.name, bad.body);
    expect(digest).toBe(bad.contentDigest);
    const flagged = await recordAdmissionEngineScan(k.db, { subject: { kind: "builder_skill", id: bad.id, digest }, report: report("skillscanner-bad") });
    expect(flagged).toMatchObject({ verdict: "fail", state: "held" });
    const row = (await k.db.select().from(builderSkills).where(eq(builderSkills.id, bad.id)))[0]!;
    expect((row.admissionFindings as McpAdmissionFinding[]).some((f) => f.rule === "skillscanner.yara_prompt_injection_generic" && f.severity === "critical")).toBe(true);
    expect(await skillAttachRefusal(k.db, row)).toMatchObject({ error: "skill_held" });

    const good = await skill("Align the table's columns.");
    const passed = await recordAdmissionEngineScan(k.db, { subject: { kind: "builder_skill", id: good.id, digest: good.contentDigest }, report: report("skillscanner-clean") });
    expect(passed).toMatchObject({ verdict: "pass", state: "clean" });
    const goodRow = (await k.db.select().from(builderSkills).where(eq(builderSkills.id, good.id)))[0]!;
    expect(await skillAttachRefusal(k.db, goodRow)).toBeNull();
    expect(await pinnedBodyWithheld(k.db, { skillId: good.id, snapshotDigest: good.contentDigest, snapshotAdmissionState: "clean" }, 0)).toBeNull();

    const crash = await skill("Line up the table.");
    const failed = await recordAdmissionEngineScan(k.db, { subject: { kind: "builder_skill", id: crash.id, digest: crash.contentDigest }, report: report("skillscanner-crash") });
    expect(failed).toMatchObject({ verdict: "unknown", state: "held" });
  });

  async function agentId(): Promise<string> {
    const r = await k.req("POST", "/v1/builder/agents", owner.auth, { name: `adr0242 ${Math.random().toString(36).slice(2, 7)}`, connectionFormat: "shared", computerUse: false, projectId: owner.projectId });
    expect(r.statusCode, r.body).toBe(201);
    return r.json().agent.id as string;
  }
  async function pin(agent: string, skillId: string, digest: string, state: "admitted" | "clean"): Promise<void> {
    await k.db.insert(builderAgentSkills).values({ agentId: agent, skillId, bodySnapshot: "pinned", snapshotDigest: digest, snapshotAdmissionState: state, snapshotName: "pinned" });
  }
  const pinState = async (agent: string, skillId: string) =>
    (await k.db.select().from(builderAgentSkills).where(and(eq(builderAgentSkills.agentId, agent), eq(builderAgentSkills.skillId, skillId))))[0]!.snapshotAdmissionState;
  async function admitted(body: string, admittedAt = new Date()): Promise<typeof builderSkills.$inferSelect> {
    const s = await skill(body);
    await k.db
      .update(builderSkills)
      .set({ admissionState: "admitted", admittedBy: owner.id, admittedAt, admitReason: "reviewed", admittedDigest: s.contentDigest })
      .where(eq(builderSkills.id, s.id));
    return s;
  }
  const skillRow = async (id: string) => (await k.db.select().from(builderSkills).where(eq(builderSkills.id, id)))[0]!;

  it("owner question 2 (secure default): a later fail revokes a skill's admission and its pinned admitted copies of that digest only", async () => {
    const s = await admitted("Pad the rows of the table.");
    const onDigest = await agentId();
    const otherDigest = await agentId();
    await pin(onDigest, s.id, s.contentDigest, "admitted");
    await pin(otherDigest, s.id, DIGEST_B, "admitted");
    const out = await recordAdmissionEngineScan(k.db, { subject: { kind: "builder_skill", id: s.id, digest: s.contentDigest }, report: report("skillscanner-bad") });
    expect(out).toMatchObject({ verdict: "fail", state: "held", revokedClearance: true });
    const row = await skillRow(s.id);
    expect(row).toMatchObject({ admissionState: "held", admittedBy: null, admittedAt: null, admitReason: null, admittedDigest: null });
    expect(await skillAttachRefusal(k.db, row)).toMatchObject({ error: "skill_held" });
    // the pinned copy of the revoked digest is held at run time; a copy pinned to another digest is left alone
    expect(await pinState(onDigest, s.id)).toBe("held");
    expect(await pinState(otherDigest, s.id)).toBe("admitted");
  });

  it("a skill fail the admin saw before admitting leaves the admission; a fail under new rules revokes it", async () => {
    const s = await skill("Sort the table by its first column.");
    // the engine flags it, the skill is held, and the admin admits it after seeing that flag
    await recordAdmissionEngineScan(k.db, { subject: { kind: "builder_skill", id: s.id, digest: s.contentDigest }, report: report("skillscanner-bad") });
    await k.db
      .update(builderSkills)
      .set({ admissionState: "admitted", admittedBy: owner.id, admittedAt: new Date(), admitReason: "reviewed the flag", admittedDigest: s.contentDigest })
      .where(eq(builderSkills.id, s.id));
    const repeat = await recordAdmissionEngineScan(k.db, { subject: { kind: "builder_skill", id: s.id, digest: s.contentDigest }, report: report("skillscanner-bad") });
    expect(repeat).toMatchObject({ verdict: "fail", state: "admitted", revokedClearance: false });

    // the same digest flagged under a different rule set (a rules upgrade) is new evidence: the admission is revoked.
    // The earlier fail row is re-labelled as the old rule set, which is what a rules upgrade leaves behind.
    await k.db
      .update(admissionEngineScans)
      .set({ rulesSha256: "0".repeat(64) })
      .where(eq(admissionEngineScans.builderSkillId, s.id));
    const upgraded = await recordAdmissionEngineScan(k.db, { subject: { kind: "builder_skill", id: s.id, digest: s.contentDigest }, report: report("skillscanner-bad") });
    expect(upgraded).toMatchObject({ verdict: "fail", state: "held", revokedClearance: true });
  });

  it("a skill admitted at another digest is not revoked by a fail on its current digest", async () => {
    const s = await skill("Merge the table's duplicate rows.");
    // admitted, but the admission names a different digest than the current one: the guard leaves it for the
    // ordinary save path (which re-scans and re-holds a changed body) and revokes nothing here
    await k.db
      .update(builderSkills)
      .set({ admissionState: "admitted", admittedBy: owner.id, admittedAt: new Date(), admitReason: "reviewed", admittedDigest: DIGEST_B })
      .where(eq(builderSkills.id, s.id));
    const out = await recordAdmissionEngineScan(k.db, { subject: { kind: "builder_skill", id: s.id, digest: s.contentDigest }, report: report("skillscanner-bad") });
    expect(out).toMatchObject({ verdict: "fail", state: "admitted", revokedClearance: false });
    expect((await skillRow(s.id)).admittedDigest).toBe(DIGEST_B);
  });
});
