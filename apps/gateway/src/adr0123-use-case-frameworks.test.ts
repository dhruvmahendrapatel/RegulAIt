import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  auditLog,
  compliancePackControls,
  compliancePacks,
  createDb,
  eq,
  runMigrations,
  type Db,
} from "@regulait/db";
import { DEFAULT_COMPLIANCE_PACKS } from "@regulait/shared";
import { buildApp } from "./app.js";

/**
 * ADR-0123 — A USE CASE MAPPED TO ANY SHIPPED FRAMEWORK, WITH REAL EVIDENCE.
 *
 * Two defects this closes, and the second is the one that matters.
 *
 * 1. THE FRAMEWORK WAS A CONSTANT. `euAiActScreeningFor` filtered packs to the
 *    literal `"eu-ai-act"`, so every other framework we ship was unreachable
 *    from a use case — NIST AI RMF included, which has no tier concept and so
 *    could never have appeared through a screening gate anyway.
 *
 * 2. A PROJECT-ATTRIBUTED REFUSAL WAS NOT COUNTABLE. A pack's
 *    `audit_decisions` collector scopes by `detail->>'projectId'`, and the
 *    governed tool/connector DECISION rows did not carry it — while the
 *    PII-block rows on the same paths did. So a project-scoped evaluation of
 *    `nist-ai-rmf:MANAGE-2.2`, whose entire claim is "refusals actually
 *    occur", counted ZERO while the refusals sat in the ledger, correct and
 *    invisible. That is worse than a missing feature: the evidence existed and
 *    the report said it did not.
 *
 * PASS CRITERIA, WRITTEN BEFORE THE RUN (M-023):
 *
 *  a. The endpoint returns the NIST pack's controls for a use case — proving
 *     the framework is no longer hard-wired. PAIRED (M-033) with the EU pack
 *     being reachable from the same route, so this is not a swapped constant.
 *  b. A use case with NO project reports `evidenceScope.kind: "no_project"`
 *     and every control's `status` NULL. A mapping without evidence must say
 *     so rather than borrow numbers from elsewhere.
 *  c. With a project, a DENY audited against that project raises the
 *     `MANAGE-2.2` evidence count. Asserted as a DELTA around the write, and
 *     paired with (d) so it cannot pass by counting everything.
 *  d. A deny attributed to a DIFFERENT project does NOT raise it. This is the
 *     assertion that makes (c) mean something — a collector that ignored
 *     scope would satisfy (c) and fail here.
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `adr0123-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };

let db: Db;
let app: ReturnType<typeof buildApp>;
let ownerId = "";
let ownerAuth: { authorization: string } = { authorization: "" };
let projectId = "";
let otherProjectId = "";
let nistPackId = "";
/** stands in for the NIST pack; run-unique so this file owns its own rows */
const PRIMARY_FRAMEWORK = `adr0123-primary-${RUN}`;
/** a SECOND framework, so "the framework is a parameter" is provable */
const SECOND_FRAMEWORK = `adr0123-second-${RUN}`;

const post = (url: string, payload?: unknown, headers = AUTH) =>
  app.inject({ method: "POST", url, headers, ...(payload ? { payload: payload as object } : {}) });

/** the MANAGE-2.2 evidence count for a given use case, as the route reports it */
async function manage22(useCaseId: string, headers = AUTH): Promise<number | null> {
  const res = await app.inject({
    method: "GET",
    url: `/v1/use-cases/${useCaseId}/frameworks?framework=${PRIMARY_FRAMEWORK}`,
    headers,
  });
  expect(res.statusCode, res.body).toBe(200);
  const pack = res.json().frameworks[0];
  return pack.controls.find(
    (c: { controlRef: string }) => c.controlRef === `${PRIMARY_FRAMEWORK}:MANAGE-2.2`,
  )?.evidenceCount;
}

/**
 * A governed DENY recorded against a project, in the shape the MCP tool path
 * now writes. Written directly because this test is about whether a project
 * -scoped collector can SEE such a row, not about re-testing the proxy.
 */
async function recordDeny(forProjectId: string) {
  await db.insert(auditLog).values({
    userId: ownerId,
    objectType: "mcp_tool",
    objectId: null,
    detail: { projectId: forProjectId, argumentsDigest: `d-${RUN}` },
    effect: "deny",
    ruleId: "default-deny",
    ruleChain: [],
    reason: `adr0123 fixture: a refusal attributed to ${forProjectId}`,
  });
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "e".repeat(64) });

  const user = await post("/v1/users", {
    email: `adr0123-owner-${RUN}@example.com`,
    displayName: "ADR123 Owner",
    isAdmin: true,
  });
  ownerId = user.json().id;
  const key = await post(`/v1/users/${ownerId}/keys`, { name: "adr0123" });
  ownerAuth = { authorization: `Bearer ${key.json().token}` };

  projectId = (await post("/v1/projects", { name: `adr0123-project-${RUN}` })).json().id;
  otherProjectId = (await post("/v1/projects", { name: `adr0123-other-${RUN}` })).json().id;

  /**
   * RUN-UNIQUE PACKS, NOT THE SHIPPED CATALOGUE.
   *
   * `POST /v1/compliance/packs/seed` writes the seven launch packs, and
   * `compliance_packs` is unique on `(framework, version)` — so it is
   * ORG-GLOBAL SINGLETON state. A first draft of this file seeded it, and
   * `compliance-packs.test.ts` (which asserts its own seed CREATES seven) then
   * saw zero created and failed. That is M-039's lesson a second time: a
   * fixture built on shared singleton state breaks whichever suite happens to
   * run second.
   *
   * These packs are authored with run-unique framework names instead. The
   * route's behaviour — that the framework is a PARAMETER, that evidence is
   * project-scoped, that a missing project yields nulls — is what is under
   * test, and none of it depends on the shipped content. That the real NIST
   * pack ships with the control this ADR is about is asserted separately,
   * against the shipped CONSTANT, where it needs no database at all.
   */
  const authorPack = async (framework: string, withDenyControl: boolean) => {
    const res = await post("/v1/compliance/packs", {
      framework,
      version: 1,
      title: `ADR-0123 fixture pack ${framework}`,
      provenance: { source: "adr0123 test fixture" },
      controls: withDenyControl
        ? [
            {
              controlRef: `${framework}:MANAGE-2.2`,
              title: "Refusals actually occur",
              coverage: "enforced",
              collector: "audit_decisions",
              collectorParams: { effect: "deny" },
              minEvidenceCount: 1,
              attestationRequired: false,
            },
            {
              controlRef: `${framework}:GOVERN-4.1`,
              title: "Organisational — the platform must never self-certify this",
              coverage: "unaddressed",
              collector: "none",
              collectorParams: {},
              minEvidenceCount: 1,
              attestationRequired: true,
            },
          ]
        : [
            {
              controlRef: `${framework}:ART-12`,
              title: "A control from the OTHER framework",
              coverage: "evidenced",
              collector: "audit_decisions",
              collectorParams: {},
              minEvidenceCount: 1,
              attestationRequired: false,
            },
          ],
    });
    expect(res.statusCode, res.body).toBe(201);
    const id = res.json().pack?.id ?? res.json().id;
    // activation is licence-gated (ADR-0052) and this test is about the
    // mapping, so the fixture activates by column rather than by route
    await db.update(compliancePacks).set({ status: "active" }).where(eq(compliancePacks.id, id));
    return id as string;
  };
  nistPackId = await authorPack(PRIMARY_FRAMEWORK, true);
  await authorPack(SECOND_FRAMEWORK, false);
});

afterAll(async () => {
  app.server.closeAllConnections();
  await app.close();
});

/** create a use case, optionally attributed to a project */
async function makeUseCase(attributed: boolean): Promise<string> {
  const res = await post(
    "/v1/use-cases",
    {
      name: `adr0123-${attributed ? "attributed" : "orphan"}-${RUN}`,
      description: "fixture use case for the framework mapping test",
      businessContext: "none — fixture",
      dataSensitivity: "internal",
      ...(attributed ? { projectId } : {}),
    },
    ownerAuth,
  );
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id;
}

describe("a use case maps to ANY shipped framework", () => {
  it("a: returns the named framework's controls — the framework is no longer a constant", async () => {
    const useCaseId = await makeUseCase(true);
    const res = await app.inject({
      method: "GET",
      url: `/v1/use-cases/${useCaseId}/frameworks?framework=${PRIMARY_FRAMEWORK}`,
      headers: ownerAuth,
    });
    expect(res.statusCode, res.body).toBe(200);
    const packs = res.json().frameworks;
    expect(packs, res.body).toHaveLength(1);
    expect(packs[0].framework).toBe(PRIMARY_FRAMEWORK);
    expect(packs[0].controls.map((c: { controlRef: string }) => c.controlRef)).toContain(
      `${PRIMARY_FRAMEWORK}:MANAGE-2.2`,
    );

    // PAIRED (M-033): a SECOND framework is reachable through the SAME route,
    // so this is a parameter rather than one constant swapped for another.
    const second = await app.inject({
      method: "GET",
      url: `/v1/use-cases/${useCaseId}/frameworks?framework=${SECOND_FRAMEWORK}`,
      headers: ownerAuth,
    });
    expect(second.json().frameworks[0].framework).toBe(SECOND_FRAMEWORK);

    // and with no filter, BOTH come back
    const all = await app.inject({
      method: "GET",
      url: `/v1/use-cases/${useCaseId}/frameworks`,
      headers: ownerAuth,
    });
    const frameworks = all.json().frameworks.map((f: { framework: string }) => f.framework);
    expect(frameworks).toContain(PRIMARY_FRAMEWORK);
    expect(frameworks).toContain(SECOND_FRAMEWORK);
  });

  it("the SHIPPED NIST pack really does carry the control this ADR is about", () => {
    /**
     * Asserted against the shipped CONSTANT, not the database: it needs no
     * seeding, so it cannot collide with another suite over org-global rows,
     * and it is the claim that matters — that a customer activating
     * `nist-ai-rmf` gets a control whose evidence is refusals occurring.
     */
    const nist = DEFAULT_COMPLIANCE_PACKS.find((p) => p.framework === "nist-ai-rmf");
    expect(nist, "the NIST AI RMF pack must ship").toBeTruthy();
    const manage = nist!.controls.find((c) => c.controlRef === "nist-ai-rmf:MANAGE-2.2");
    expect(manage?.collector).toBe("audit_decisions");
    expect((manage?.collectorParams as { effect?: string })?.effect).toBe("deny");
  });

  it("b: a use case with NO project is mapped but explicitly NOT evidenced", async () => {
    const useCaseId = await makeUseCase(false);
    const res = await app.inject({
      method: "GET",
      url: `/v1/use-cases/${useCaseId}/frameworks?framework=${PRIMARY_FRAMEWORK}`,
      headers: ownerAuth,
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.evidenceScope.kind).toBe("no_project");
    // the MAPPING is still there — this is not an empty response
    expect(body.frameworks[0].controls.length).toBeGreaterThan(0);
    // but every evidence field is null rather than zero: "not measured" and
    // "measured as none" are different claims and must not be conflated
    for (const c of body.frameworks[0].controls) {
      expect(c.status).toBeNull();
      expect(c.evidenceCount).toBeNull();
    }
    expect(body.frameworks[0].totals).toBeNull();
  });
});

describe("a project-attributed refusal is countable evidence", () => {
  it("c+d: a deny on THIS project raises MANAGE-2.2; a deny on another does not", async () => {
    const useCaseId = await makeUseCase(true);

    const before = await manage22(useCaseId, ownerAuth);
    expect(typeof before).toBe("number");

    // (d) FIRST, deliberately: a deny on a DIFFERENT project must not move it.
    // Asserting this before (c) means a collector that ignored scope fails
    // here rather than being masked by the passing case that follows.
    await recordDeny(otherProjectId);
    expect(await manage22(useCaseId, ownerAuth)).toBe(before);

    // (c) the same kind of row, attributed to THIS project, is counted
    await recordDeny(projectId);
    expect(await manage22(useCaseId, ownerAuth)).toBe((before ?? 0) + 1);
  });

  it("the fixture control really is the one whose claim is about refusals", async () => {
    // Guards the FIXTURE as much as the code: if this control stopped using
    // the audit_decisions collector with effect=deny, the delta test above
    // would be measuring something else while still passing.
    const [control] = await db
      .select()
      .from(compliancePackControls)
      .where(eq(compliancePackControls.controlRef, `${PRIMARY_FRAMEWORK}:MANAGE-2.2`));
    expect(control?.collector).toBe("audit_decisions");
    expect((control?.collectorParams as { effect?: string })?.effect).toBe("deny");
  });
});

/**
 * Found while auditing against ISACA's "log decisions and approvals" item.
 * `POST /v1/agents/:agentId/enabled` is the most consequential switch on an
 * agent — the kernel refuses every caller when it is off, regardless of grant
 * — and it wrote NOTHING to the ledger, three lines above a comment promising
 * "audited acts, never silent PATCH writes".
 */
describe("disabling an agent is an audited act", () => {
  it("records both directions under distinct rule ids, and the effect follows the consequence", async () => {
    const agent = await post("/v1/agents", {
      name: `adr0123-agent-${RUN}`,
      provider: "mock",
      model: "mock-fast",
      tier: 1,
    });
    expect(agent.statusCode, agent.body).toBe(201);
    const agentId = agent.json().id;

    const rows = async (ruleId: string) =>
      (await db.select().from(auditLog).where(eq(auditLog.ruleId, ruleId))).filter(
        (r) => r.objectId === agentId,
      );

    await post(`/v1/agents/${agentId}/enabled`, { enabled: false });
    const disabled = await rows("agent-disabled");
    expect(disabled).toHaveLength(1);
    // turning it OFF starts refusing, so it is recorded as a deny
    expect(disabled[0]!.effect).toBe("deny");
    expect(disabled[0]!.detail).toMatchObject({ from: true, to: false });

    await post(`/v1/agents/${agentId}/enabled`, { enabled: true });
    const enabled = await rows("agent-enabled");
    expect(enabled).toHaveLength(1);
    expect(enabled[0]!.effect).toBe("allow");

    // PAIRED NEGATIVE: a no-op write mints no row. Without this, a route that
    // audited unconditionally would pass everything above while filling the
    // ledger with events that never happened.
    const beforeNoop = (await rows("agent-enabled")).length;
    await post(`/v1/agents/${agentId}/enabled`, { enabled: true });
    expect((await rows("agent-enabled")).length).toBe(beforeNoop);
  });
});
