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

const post = (url: string, payload?: unknown, headers = AUTH) =>
  app.inject({ method: "POST", url, headers, ...(payload ? { payload: payload as object } : {}) });

/** the MANAGE-2.2 evidence count for a given use case, as the route reports it */
async function manage22(useCaseId: string, headers = AUTH): Promise<number | null> {
  const res = await app.inject({
    method: "GET",
    url: `/v1/use-cases/${useCaseId}/frameworks?framework=nist-ai-rmf`,
    headers,
  });
  expect(res.statusCode, res.body).toBe(200);
  const pack = res.json().frameworks[0];
  return pack.controls.find((c: { controlRef: string }) => c.controlRef === "nist-ai-rmf:MANAGE-2.2")
    ?.evidenceCount;
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

  // Packs seed as DRAFT and evaluate nothing until activated; activation is
  // licence-gated, so the fixture activates by column rather than by route —
  // this test is about the mapping, not about ADR-0052.
  await post("/v1/compliance/packs/seed", {});
  const [nist] = await db
    .select()
    .from(compliancePacks)
    .where(eq(compliancePacks.framework, "nist-ai-rmf"));
  nistPackId = nist!.id;
  await db.update(compliancePacks).set({ status: "active" }).where(eq(compliancePacks.id, nistPackId));
  const [eu] = await db
    .select()
    .from(compliancePacks)
    .where(eq(compliancePacks.framework, "eu-ai-act"));
  await db.update(compliancePacks).set({ status: "active" }).where(eq(compliancePacks.id, eu!.id));
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
  it("a: returns the NIST pack's controls — the framework is no longer a constant", async () => {
    const useCaseId = await makeUseCase(true);
    const res = await app.inject({
      method: "GET",
      url: `/v1/use-cases/${useCaseId}/frameworks?framework=nist-ai-rmf`,
      headers: ownerAuth,
    });
    expect(res.statusCode, res.body).toBe(200);
    const packs = res.json().frameworks;
    expect(packs).toHaveLength(1);
    expect(packs[0].framework).toBe("nist-ai-rmf");
    expect(packs[0].controls.map((c: { controlRef: string }) => c.controlRef)).toContain(
      "nist-ai-rmf:MANAGE-2.2",
    );

    // PAIRED (M-033): the EU pack is reachable through the SAME route, so this
    // is a parameter rather than one constant swapped for another.
    const eu = await app.inject({
      method: "GET",
      url: `/v1/use-cases/${useCaseId}/frameworks?framework=eu-ai-act`,
      headers: ownerAuth,
    });
    expect(eu.json().frameworks[0].framework).toBe("eu-ai-act");

    // and with no filter, BOTH come back
    const all = await app.inject({
      method: "GET",
      url: `/v1/use-cases/${useCaseId}/frameworks`,
      headers: ownerAuth,
    });
    const frameworks = all.json().frameworks.map((f: { framework: string }) => f.framework);
    expect(frameworks).toContain("nist-ai-rmf");
    expect(frameworks).toContain("eu-ai-act");
  });

  it("b: a use case with NO project is mapped but explicitly NOT evidenced", async () => {
    const useCaseId = await makeUseCase(false);
    const res = await app.inject({
      method: "GET",
      url: `/v1/use-cases/${useCaseId}/frameworks?framework=nist-ai-rmf`,
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

  it("the control that reports it is the one whose claim is about refusals", async () => {
    // Guards the fixture as much as the code: if MANAGE-2.2 ever stops using
    // the audit_decisions collector with effect=deny, the test above would be
    // measuring something else while still passing.
    const [control] = await db
      .select()
      .from(compliancePackControls)
      .where(eq(compliancePackControls.controlRef, "nist-ai-rmf:MANAGE-2.2"));
    expect(control?.collector).toBe("audit_decisions");
    expect((control?.collectorParams as { effect?: string })?.effect).toBe("deny");
  });
});
