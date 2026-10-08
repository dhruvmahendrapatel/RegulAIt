import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { relaxStrictAdmissionForTest } from "./testing/strict-admission.js";
// ADR-0181: this file registers a LOCAL MCP double (127.0.0.1 / localhost, registered seconds ago) to pin
// unrelated behaviour, not the strict admission defaults — relaxed explicitly here, restored in afterAll.
let restoreStrictAdmission: (() => Promise<void>) | undefined;
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  agents,
  and,
  approvalRules,
  auditLog,
  configActivationEvents,
  configCanaryObservations,
  configVersions,
  createDb,
  eq,
  inArray,
  runMigrations,
  users,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";

/**
 * Batch B7c — the AFTER DELETE trigger ADR-0074 §5 / the B1 amendment scoped
 * as "its own slice" (migration 0102).
 *
 * Before this, only the explicit `DELETE /v1/rules/:kind/:ruleId` route
 * demoted a deleted artifact's version pointers; a subject row that vanished
 * through an FK cascade (deleting its user/server/role/team/approver) or any
 * raw SQL delete left its `active`/`canary` pointers stranded, disclosed via
 * `artifactDeleted: true`. The trigger closes the cascade path with the
 * route's EXACT semantics, at the SQL level:
 *
 *   - pointers -> status 'retired' (NOT 'superseded', NOT 'rolled_back'),
 *     canaryPct nulled;
 *   - one 'artifact_deleted' activation-ledger entry per demoted pointer;
 *   - every version row KEPT — immutable history, always.
 *
 * And the route path stays byte-identical: the route demotes before deleting
 * in one transaction, so the trigger finds nothing to do — proved here by
 * exact ledger-entry counts (a double demotion would double them).
 *
 * The trigger deliberately writes the ACTIVATION LEDGER and not audit_log:
 * ADR-0060's hash chain is application-layer (`createDb`), so a
 * trigger-inserted audit row would surface as un-chained. That boundary is
 * stated in the migration and the ADR amendment.
 *
 * SHARED-STATE DISCIPLINE: everything `orph-` prefixed; assertions are on
 * this suite's artifact ids only; afterAll removes what survives.
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "orph-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };

let db: Db;
let app: ReturnType<typeof buildApp>;
let anaId: string;
/** ADR-0186 A: the approver of the rule whose SUBJECT is ana — a rule may not
 * name its own subject as approver (the caller can never approve their own call) */
let otherApproverId: string;
let piaId: string;
let serverId: string;
/** deleted via RAW SQL USER CASCADE — the path the trigger exists for */
let cascadeRuleId: string;
/** deleted via the EXPLICIT route — the no-double-demotion control */
let routeRuleId: string;
/** deleted via raw SQL directly — covers BOTH agent artifact types at once */
let agentId: string;

async function makeUser(email: string) {
  const res = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/users",
    payload: { email, displayName: email.split("@")[0] },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

async function makeApprovalRule(subjectId: string, approverUserId = anaId) {
  const r = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/rules/approvals",
    payload: {
      scope: "user",
      userId: subjectId,
      serverScope: "server",
      serverId,
      toolName: "orph_write",
      approverUserId,
    },
  });
  expect(r.statusCode).toBe(201);
  return r.json().id as string;
}

/** version the artifact to the state the trigger must handle: an ACTIVE
 * version and a CANARY version, both pointers live */
async function versionWithCanary(artifactType: string, artifactId: string, activeBody: object, canaryBody: object) {
  const activated = await app.inject({
    method: "POST",
    headers: AUTH,
    url: `/v1/config-versions/${artifactType}/${artifactId}`,
    payload: { body: activeBody, label: "orph active", activate: true },
  });
  expect(activated.statusCode).toBe(201);
  const draft = await app.inject({
    method: "POST",
    headers: AUTH,
    url: `/v1/config-versions/${artifactType}/${artifactId}`,
    payload: { body: canaryBody, label: "orph candidate" },
  });
  expect(draft.statusCode).toBe(201);
  const canary = await app.inject({
    method: "POST",
    headers: AUTH,
    url: `/v1/config-versions/${artifactType}/${artifactId}/canary`,
    payload: { version: draft.json().version.version as number, pct: 10 },
  });
  expect(canary.statusCode).toBe(200);
}

async function versionsOf(artifactType: string, artifactId: string) {
  return db
    .select()
    .from(configVersions)
    .where(and(eq(configVersions.artifactType, artifactType as never), eq(configVersions.artifactId, artifactId)));
}

async function deletionEvents(artifactId: string) {
  return db
    .select()
    .from(configActivationEvents)
    .where(
      and(
        eq(configActivationEvents.artifactId, artifactId),
        eq(configActivationEvents.action, "artifact_deleted"),
      ),
    );
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restoreStrictAdmission = await relaxStrictAdmissionForTest(db);
  app = buildApp(db, { bootstrapToken: BOOT });

  anaId = await makeUser("orph-ana@example.com");
  piaId = await makeUser("orph-pia@example.com");
  otherApproverId = await makeUser("orph-approver@example.com");

  const s = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/servers",
    payload: { name: "orph-server", url: "http://127.0.0.1:9" },
  });
  expect(s.statusCode).toBe(201);
  serverId = s.json().id;
  await app.inject({
    method: "POST",
    headers: AUTH,
    url: `/v1/servers/${serverId}/tools`,
    payload: { name: "orph_write", kind: "write" },
  });

  cascadeRuleId = await makeApprovalRule(piaId);
  routeRuleId = await makeApprovalRule(anaId, otherApproverId);

  const a = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/agents",
    payload: { name: "orph-agent", provider: "mock", tier: 1, model: "mock-balanced", costPerMTokIn: 3, costPerMTokOut: 15 },
  });
  expect(a.statusCode).toBe(201);
  agentId = a.json().id;
});

afterAll(async () => {
  await restoreStrictAdmission?.();
  const artifacts = [cascadeRuleId, routeRuleId, agentId].filter(Boolean);
  if (artifacts.length) {
    await db.delete(configCanaryObservations).where(inArray(configCanaryObservations.artifactId, artifacts));
    await db.delete(configActivationEvents).where(inArray(configActivationEvents.artifactId, artifacts));
    await db.delete(configVersions).where(inArray(configVersions.artifactId, artifacts));
    await db.delete(approvalRules).where(inArray(approvalRules.id, artifacts));
    await db.delete(auditLog).where(inArray(auditLog.objectId, artifacts));
  }
  await db.delete(agents).where(eq(agents.name, "orph-agent"));
  await db.delete(users).where(inArray(users.email, ["orph-ana@example.com", "orph-pia@example.com", "orph-approver@example.com"]));
});

// ---------------------------------------------------------------------------

describe("B7c — an FK-cascade delete demotes orphaned pointers exactly like the route", () => {
  it("deleting the subject USER via raw SQL cascades the rule away and the trigger retires both pointers", async () => {
    await versionWithCanary("approval_rule", cascadeRuleId, { writeOnly: true }, { toolName: "orph_read" });
    const before = await versionsOf("approval_rule", cascadeRuleId);
    expect(before.filter((v) => v.status === "active").length).toBe(1);
    expect(before.filter((v) => v.status === "canary").length).toBe(1);

    // RAW SQL, NOT THE ROUTE: the user delete cascades approval_rules.user_id
    // with no application code involved — the exact orphan path the B1
    // amendment disclosed
    await db.delete(users).where(eq(users.id, piaId));
    expect((await db.select().from(approvalRules).where(eq(approvalRules.id, cascadeRuleId))).length).toBe(0);

    // pointers demoted, versions KEPT — the route's semantics, from SQL
    const after = await versionsOf("approval_rule", cascadeRuleId);
    expect(after.length).toBe(before.length);
    expect(after.filter((v) => v.status === "active" || v.status === "canary")).toEqual([]);
    const retired = after.filter((v) => v.status === "retired");
    expect(retired.length).toBe(2);
    for (const v of retired) expect(v.canaryPct).toBeNull();

    // one 'artifact_deleted' ledger entry per demoted pointer, naming the path
    const events = await deletionEvents(cascadeRuleId);
    expect(events.length).toBe(2);
    for (const e of events) {
      expect(e.reason).toMatch(/AFTER DELETE trigger on approval_rules/);
      expect(e.reason).toMatch(/kept \(status 'retired'\)/);
    }

    // and the read surface reports the tombstone with NO live pointer
    const lineage = await app.inject({
      method: "GET",
      headers: AUTH,
      url: `/v1/config-versions/approval_rule/${cascadeRuleId}`,
    });
    expect(lineage.json().artifactDeleted).toBe(true);
    expect(lineage.json().active).toBeNull();
    expect(lineage.json().canary).toBeNull();
  });

  it("raw-deleting an AGENT retires the pointers of BOTH its artifact types (agent_config AND agent_system_prompt)", async () => {
    const cfg = await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/config-versions/agent_config/${agentId}`,
      payload: { body: { model: "mock-premium" }, label: "orph cfg", activate: true },
    });
    expect(cfg.statusCode).toBe(201);
    const prompt = await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/agents/${agentId}/system-prompt`,
      payload: { systemPrompt: "orph base prompt" },
    });
    expect(prompt.statusCode).toBe(200);
    expect((await versionsOf("agent_config", agentId)).some((v) => v.status === "active")).toBe(true);
    expect((await versionsOf("agent_system_prompt", agentId)).some((v) => v.status === "active")).toBe(true);

    await db.delete(agents).where(eq(agents.id, agentId));

    for (const t of ["agent_config", "agent_system_prompt"] as const) {
      const rows = await versionsOf(t, agentId);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.filter((v) => v.status === "active" || v.status === "canary")).toEqual([]);
      expect(rows.filter((v) => v.status === "retired").length).toBe(1);
    }
    const events = await deletionEvents(agentId);
    expect(events.length).toBe(2);
    expect(events.map((e) => e.artifactType).sort()).toEqual(["agent_config", "agent_system_prompt"]);
  });

  it("the EXPLICIT route still behaves identically — no double demotion, no duplicate ledger entries", async () => {
    await versionWithCanary("approval_rule", routeRuleId, { writeOnly: true }, { toolName: "orph_read" });

    const res = await app.inject({
      method: "DELETE",
      headers: AUTH,
      url: `/v1/rules/approvals/${routeRuleId}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().versionsRetired).toBe(2);

    // EXACTLY one ledger entry per pointer: the route demoted them inside its
    // own transaction BEFORE deleting the row, so when the trigger fired on
    // that delete there was nothing left in the active/canary space
    const events = await deletionEvents(routeRuleId);
    expect(events.length).toBe(2);
    for (const e of events) expect(e.reason).not.toMatch(/AFTER DELETE trigger/);

    const rows = await versionsOf("approval_rule", routeRuleId);
    expect(rows.filter((v) => v.status === "retired").length).toBe(2);
  });
});
