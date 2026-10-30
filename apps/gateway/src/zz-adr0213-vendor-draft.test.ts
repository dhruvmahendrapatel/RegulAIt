/**
 * ADR-0213 — drafted vendor questionnaire answers
 * (`POST /v1/vendors/:vendorId/questionnaire/draft`).
 *
 * Pinned:
 *  - OFF BY DEFAULT: a fresh database refuses `vendor_draft_disabled`, and
 *    turning it on through the settings writer is audited as a relaxation;
 *  - drafts never auto-submit: no questionnaire artifact, no attestation and
 *    no status change; one audit row, without the supplier's text;
 *  - every drafted section carries its source label and citations; a section
 *    nothing grounds is `none`;
 *  - the model half is refused INLINE (200, `model.status: "refused"`) when no
 *    model connection is available or the named one is not the caller's, with
 *    nothing dispatched; an entitled mock agent dispatches (metered) and its
 *    canned prose is never passed off as a draft;
 *  - object-level authorisation: a non-owner and an identity-less caller are refused.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  aiVendors,
  and,
  auditLog,
  createDb,
  desc,
  eq,
  orgSettings,
  ORG_SETTINGS_ID,
  runMigrations,
  usageEvents,
  workflowArtifacts,
  type Db,
} from "@regulait/db";
import { VENDOR_QUESTIONNAIRE_SECTIONS, splitQuestionnaire } from "@regulait/shared";
import { buildApp } from "./app.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";
import { VENDOR_QUESTIONNAIRE_TEMPLATE } from "./vendors.js";

let restoreGates: () => Promise<void> = async () => {};

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `adr0213-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const SUPPLIER_SECRET = `Subprocessor list v7 — codename QUILL-${RUN}`;

let db: Db;
let app: ReturnType<typeof buildApp>;
const owner = { id: "", auth: { authorization: "" } };
const other = { id: "", auth: { authorization: "" } };
let vendorId = "";
let grantedAgent = "";
let ungrantedAgent = "";

const post = (url: string, headers: Record<string, string>, payload: unknown) =>
  app.inject({ method: "POST", url, headers, payload: payload as object });
const draftUrl = () => `/v1/vendors/${vendorId}/questionnaire/draft`;

async function makeUser(tag: string) {
  const u = await post("/v1/users", AUTH, { email: `adr0213-${tag}-${RUN}@example.com`, displayName: tag });
  const id = u.json().id as string;
  const token = (await post(`/v1/users/${id}/keys`, AUTH, { name: "k" })).json().token as string;
  return { id, auth: { authorization: `Bearer ${token}` } };
}

async function makeAgent(name: string) {
  const r = await post("/v1/agents", AUTH, { name: `${name}-${RUN}`, provider: "mock", tier: 1, modes: ["chat"], model: "mock-balanced" });
  expect(r.statusCode).toBe(201);
  return r.json().id as string;
}

const vendorState = async () => {
  const [v] = await db.select().from(aiVendors).where(eq(aiVendors.id, vendorId));
  const artifacts = v!.workflowInstanceId
    ? await db.select().from(workflowArtifacts).where(eq(workflowArtifacts.instanceId, v!.workflowInstanceId))
    : [];
  return { status: v!.status, attestations: v!.packAttestations.length, artifacts: artifacts.length };
};
const usage = async () => (await db.select().from(usageEvents).where(eq(usageEvents.userId, owner.id))).length;
const draftAudits = async () =>
  db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.objectId, vendorId), eq(auditLog.ruleId, "vendor-questionnaire-drafted")));

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "d".repeat(64) });
  restoreGates = await relaxGovernanceGatesForTest(db, { mrmEnforced: false, dispatchAttributionRequired: false, useCaseGateMode: "off" });
  Object.assign(owner, await makeUser("owner"));
  Object.assign(other, await makeUser("other"));
  const v = await post("/v1/vendors", owner.auth, {
    name: `Acme Notes ${RUN}`,
    description: "Meeting transcription with model-written summaries over our call recordings.",
    category: "ai_feature_vendor",
    linkedAgentProviders: ["mock"],
  });
  expect(v.statusCode, v.body).toBe(201);
  vendorId = (v.json().vendor ?? v.json()).id as string;
  grantedAgent = await makeAgent("adr0213-granted");
  ungrantedAgent = await makeAgent("adr0213-ungranted");
  expect((await post("/v1/grants/agents", AUTH, { userId: owner.id, agentId: grantedAgent })).statusCode).toBeLessThan(300);
}, 120_000);

afterAll(async () => {
  app.server.closeAllConnections();
  await db.update(orgSettings).set({ vendorDraftAssistEnabled: false }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  await restoreGates();
  await app.close();
});

describe("off by default", () => {
  it("a fresh organisation refuses the drafter and writes nothing", async () => {
    const [s] = await db.select().from(orgSettings).where(eq(orgSettings.id, ORG_SETTINGS_ID));
    expect(s!.vendorDraftAssistEnabled).toBe(false);
    const r = await post(draftUrl(), owner.auth, {});
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe("vendor_draft_disabled");
    expect(await draftAudits()).toHaveLength(0);
  });

  it("turning it on is an audited relaxation of the strict default", async () => {
    const r = await app.inject({ method: "PUT", url: "/v1/org/settings", headers: AUTH, payload: { vendorDraftAssistEnabled: true } });
    expect(r.statusCode, r.body).toBe(200);
    const [row] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.ruleId, "org-settings-updated"))
      .orderBy(desc(auditLog.seq))
      .limit(1);
    expect((row!.detail as { relaxed?: string[] }).relaxed).toContain("vendorDraftAssistEnabled");
  });
});

describe("drafts, once on", () => {
  it("the gateway's blank form has exactly the six sections the drafter knows", () => {
    expect(Object.keys(splitQuestionnaire(VENDOR_QUESTIONNAIRE_TEMPLATE)).sort()).toEqual(
      VENDOR_QUESTIONNAIRE_SECTIONS.map((s) => s.id).sort(),
    );
  });

  it("labels every section with its source, and never submits or records anything", async () => {
    const before = await vendorState();
    const r = await post(draftUrl(), owner.auth, {});
    expect(r.statusCode, r.body).toBe(200);
    const b = r.json();
    expect(b.submitted).toBe(false);
    expect(b.model).toEqual({ status: "not_requested" });
    expect(b.sections).toHaveLength(6);
    for (const s of b.sections as Array<{ source: string; cites: unknown[]; text: string }>) {
      expect(["rules", "none"]).toContain(s.source);
      if (s.source === "none") expect(s.text).toBe("");
      else expect(s.cites.length).toBeGreaterThan(0);
    }
    const ai = b.sections.find((s: { id: string }) => s.id === "ai_systems");
    expect(ai.cites.map((c: { kind: string }) => c.kind)).toEqual(["vendor_record", "org_evidence"]);
    expect(b.draft).toContain("> Drafted from records — from: Vendor record; Our registry.");
    // nothing auto-submits: no artifact, no attestation, no status change
    expect(await vendorState()).toEqual(before);
    expect(await draftAudits()).toHaveLength(1);
  });

  it("refuses the model half inline when no model connection is available, dispatching nothing", async () => {
    const u0 = await usage();
    const r = await post(draftUrl(), owner.auth, { useModel: true, supplierDocuments: [{ name: "Trust page", text: SUPPLIER_SECRET }] });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().model.status).toBe("refused");
    expect(r.json().sections.every((s: { source: string }) => s.source === "rules" || s.source === "none")).toBe(true);
    expect(await usage()).toBe(u0);
  });

  it("refuses an agent the caller may not use, inline and audited", async () => {
    const u0 = await usage();
    const r = await post(draftUrl(), owner.auth, { useModel: true, agentId: ungrantedAgent });
    expect(r.statusCode).toBe(200);
    expect(r.json().model.status).toBe("refused");
    expect(await usage()).toBe(u0);
    const denials = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.objectId, ungrantedAgent), eq(auditLog.effect, "deny")));
    expect(denials.some((d) => (d.detail as { surface?: string }).surface === "vendor_draft")).toBe(true);
  });

  it("an entitled agent dispatches through the governed path, and canned prose is never a draft", async () => {
    const before = await vendorState();
    const u0 = await usage();
    const r = await post(draftUrl(), owner.auth, {
      useModel: true,
      agentId: grantedAgent,
      supplierDocuments: [{ name: "Trust page", text: SUPPLIER_SECRET }],
    });
    expect(r.statusCode, r.body).toBe(200);
    // POSITIVE CONTROL: the dispatch really happened, and it was metered
    expect(await usage()).toBe(u0 + 1);
    const m = r.json().model;
    if (m.status === "drafted") {
      expect(m.source).toBe("mock");
    } else {
      expect(m.status).toBe("unparseable");
      expect(r.json().sections.every((s: { source: string }) => s.source === "rules" || s.source === "none")).toBe(true);
    }
    expect(await vendorState()).toEqual(before);
    // the supplier's text stays out of the ledger
    expect(JSON.stringify(await draftAudits())).not.toContain(`QUILL-${RUN}`);
  });
});

describe("object-level authorisation", () => {
  it("refuses a person who neither owns the vendor nor is an admin", async () => {
    const r = await post(draftUrl(), other.auth, {});
    expect(r.statusCode).toBe(403);
  });

  it("refuses a token with no user identity", async () => {
    const r = await post(draftUrl(), AUTH, {});
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toBe("vendor_draft_requires_identity");
  });

  it("refuses an unknown body key rather than ignoring it", async () => {
    const r = await post(draftUrl(), owner.auth, { submit: true });
    expect(r.statusCode).toBe(400);
  });
});
