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
import { and, admissionEngineScans, auditLog, builderSkills, engines, eq, inArray, mcpServers } from "@regulait/db";
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

  it("an admin's clearance of the digest stands; a held server with its own findings stays held on an engine pass", async () => {
    const cleared = await server("cleared");
    await recordAdmissionEngineScan(k.db, { subject: { kind: "mcp_server", id: cleared, digest: DIGEST_A }, report: report("mcpscanner-bad") });
    expect((await serverRow(cleared)).admissionState).toBe("cleared");
    await expect(assertAdmitted(k.db, cleared)).resolves.toBeUndefined();

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
});
