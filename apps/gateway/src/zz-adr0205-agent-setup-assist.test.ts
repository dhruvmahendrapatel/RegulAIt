/**
 * ADR-0205 — the agent setup assistant (`/v1/agents/setup-assist`).
 *
 * Pinned:
 *  - it is OFF by default: the draft route refuses 409 until an admin turns it on, and turning it on through
 *    PUT /v1/org/settings is audited as a relaxation;
 *  - it is SUGGESTION-ONLY: the draft never creates or changes an agent, and the one audit row never carries the
 *    admin's description;
 *  - a model draft takes the governed path: an agent the admin is not granted is REFUSED (no dispatch, the rules
 *    draft still returns), an entitled one is metered, and the keyless mock's prose is never passed off as a draft;
 *  - it is admin-only, and an identity-less caller is refused.
 * The mock provider only: no key, no network.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { agents, auditLog, and, createDb, eq, orgSettings, ORG_SETTINGS_ID, runMigrations, usageEvents, type Db } from "@regulait/db";
import { buildApp } from "./app.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";
import { relaxStepUpForTest } from "./testing/step-up-posture.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";

let restoreGates: () => Promise<void> = async () => {};
let restoreStepUp: () => Promise<void> = async () => {};
// an admin acts here through an API key, which the strict admin-MFA default refuses; MFA is not under test
let restoreAdminKeyMfa: () => Promise<void> = async () => {};

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `adr0205-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const DESCRIPTION = `Answers customer questions about their loan applications — codename QUASAR-${RUN}.`;

let db: Db;
let app: ReturnType<typeof buildApp>;
let admin = { id: "", auth: { authorization: "" } };
let member = { id: "", auth: { authorization: "" } };
let grantedAgent = "";
let ungrantedAgent = "";

const post = (url: string, headers: Record<string, string>, payload: unknown) =>
  app.inject({ method: "POST", url, headers, payload: payload as object });
const agentCount = async () => (await db.select({ id: agents.id }).from(agents)).length;

async function makeAgent(name: string) {
  const r = await post("/v1/agents", AUTH, { name: `${name}-${RUN}`, provider: "mock", tier: 1, modes: ["chat"], model: "mock-balanced" });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().id as string;
}

async function makeUser(tag: string, isAdmin: boolean) {
  const u = await post("/v1/users", AUTH, { email: `adr0205-${tag}-${RUN}@example.com`, displayName: tag, isAdmin });
  expect(u.statusCode, u.body).toBeLessThan(300);
  const id = u.json().id as string;
  return { id, auth: { authorization: `Bearer ${(await post(`/v1/users/${id}/keys`, AUTH, { name: "k" })).json().token}` } };
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "d".repeat(64) });
  restoreAdminKeyMfa = await relaxIdentityForTest(db, { mfaRequired: "off" });
  restoreGates = await relaxGovernanceGatesForTest(db, { mrmEnforced: false, dispatchAttributionRequired: false, useCaseGateMode: "off" });
  admin = await makeUser("admin", true);
  member = await makeUser("member", false);
  grantedAgent = await makeAgent("adr0205-granted");
  ungrantedAgent = await makeAgent("adr0205-ungranted");
  expect((await post("/v1/grants/agents", AUTH, { userId: admin.id, agentId: grantedAgent })).statusCode).toBeLessThan(300);
}, 120_000);

afterAll(async () => {
  await db.update(orgSettings).set({ agentSetupAssistEnabled: false }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  await restoreStepUp();
  await restoreGates();
  await restoreAdminKeyMfa();
  app.server.closeAllConnections();
  await app.close();
});

describe("off by default", () => {
  it("reports disabled and refuses a draft until an admin turns it on", async () => {
    const s = await app.inject({ method: "GET", url: "/v1/agents/setup-assist", headers: admin.auth });
    expect(s.statusCode, s.body).toBe(200);
    expect(s.json().enabled).toBe(false);
    const r = await post("/v1/agents/setup-assist", admin.auth, { description: DESCRIPTION });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe("agent_setup_assist_disabled");
    // the refusal tells the admin where to go, without exposing the internal setting key
    expect(r.json().detail).toContain("organisation settings");
    expect(r.json().detail).not.toContain("agentSetupAssistEnabled");
  });

  it("turning it on is an audited relaxation", async () => {
    restoreStepUp = await relaxStepUpForTest(db);
    const r = await app.inject({ method: "PUT", url: "/v1/org/settings", headers: admin.auth, payload: { agentSetupAssistEnabled: true } });
    expect(r.statusCode, r.body).toBe(200);
    const rows = await db.select().from(auditLog).where(eq(auditLog.userId, admin.id));
    const row = rows.find((x) => JSON.stringify(x.detail).includes("agentSetupAssistEnabled"));
    expect(row, "the enable is audited").toBeTruthy();
    expect(JSON.stringify(row!.detail)).toContain("relaxed");
    const s = await app.inject({ method: "GET", url: "/v1/agents/setup-assist", headers: admin.auth });
    expect(s.json().enabled).toBe(true);
  });
});

describe("suggestion-only", () => {
  it("returns a rules draft, creates no agent and keeps the description out of the audit log", async () => {
    const before = await agentCount();
    const r = await post("/v1/agents/setup-assist", admin.auth, { description: DESCRIPTION });
    expect(r.statusCode, r.body).toBe(200);
    const b = r.json();
    expect(b.draft.riskTier).toMatchObject({ value: "high", source: "rules" });
    expect(b.draft.grants.value).toMatch(/no one/i);
    expect(b.model).toEqual({ status: "not_requested" });
    expect(await agentCount()).toBe(before);
    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.userId, admin.id), eq(auditLog.ruleId, "agent-setup-assisted")));
    expect(audits).toHaveLength(1);
    expect(JSON.stringify(audits[0])).not.toContain(`QUASAR-${RUN}`);
  });

  it("refuses an apply-style smuggled key", async () => {
    const r = await post("/v1/agents/setup-assist", admin.auth, { description: DESCRIPTION, apply: true });
    expect(r.statusCode).toBe(400);
  });
});

describe("the optional model draft", () => {
  it("refuses an agent the admin is not granted, with no dispatch and the rules draft intact", async () => {
    const usageBefore = (await db.select().from(usageEvents).where(eq(usageEvents.userId, admin.id))).length;
    const r = await post("/v1/agents/setup-assist", admin.auth, { description: DESCRIPTION, draftWithModel: true, agentId: ungrantedAgent });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().model.status).toBe("refused");
    expect(r.json().model.reason).toBeTruthy();
    expect(r.json().draft.systemPrompt.source).toBe("rules");
    expect((await db.select().from(usageEvents).where(eq(usageEvents.userId, admin.id))).length).toBe(usageBefore);
  });

  it("dispatches an entitled agent through the governed path and never passes off canned prose", async () => {
    const before = await agentCount();
    const usageBefore = (await db.select().from(usageEvents).where(eq(usageEvents.userId, admin.id))).length;
    const r = await post("/v1/agents/setup-assist", admin.auth, { description: DESCRIPTION, draftWithModel: true, agentId: grantedAgent });
    expect(r.statusCode, r.body).toBe(200);
    // POSITIVE CONTROL: the dispatch really happened, and was metered
    expect((await db.select().from(usageEvents).where(eq(usageEvents.userId, admin.id))).length).toBe(usageBefore + 1);
    const m = r.json().model;
    if (m.status === "drafted") {
      expect(m.source).toBe("mock");
    } else {
      expect(m.status).toBe("unparseable");
      expect(r.json().draft.systemPrompt.source).toBe("rules");
    }
    // a model draft never lowers the rules' risk tier, and never creates an agent
    expect(r.json().draft.riskTier.value).toBe("high");
    expect(await agentCount()).toBe(before);
  });
});

describe("refusals", () => {
  it("is admin-only and refuses an identity-less caller", async () => {
    expect((await post("/v1/agents/setup-assist", member.auth, { description: DESCRIPTION })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/v1/agents/setup-assist", headers: member.auth })).statusCode).toBe(403);
    expect((await post("/v1/agents/setup-assist", AUTH, { description: DESCRIPTION })).statusCode).toBe(403);
  });
});
