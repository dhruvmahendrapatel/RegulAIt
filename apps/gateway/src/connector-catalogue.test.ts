/**
 * ADR-0255 (P31) — the governed connector catalogue at the gateway.
 *
 *  - every curated piece starts NOT enabled (ADR-0180); enabling is admin-only (and step-up gated), and is audited with
 *    its reason; the rest of the community catalogue is listed "available, not enabled" and cannot be enabled;
 *  - a piece connector can be neither created nor invoked while its piece is disabled, on an air-gapped deployment,
 *    or with a baseUrl override, and each invoke refusal writes a deny row;
 *  - a person needs their own connector grant (default-deny), and the grant's allowedObjects names the actions;
 *  - an enabled piece's request goes to the egress guard: under the shipped strict compiled-default posture the vendor
 *    host is refused when it is not allow-listed, and NOTHING reaches the network (a global fetch spy sees no call).
 *
 * Shares one database with the other gateway suites (fileParallelism is off). The enablement table is
 * deployment-wide state, so it is emptied before and after this file.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { and, auditLog, connectorPieceEnablements, createDb, desc, eq, orgSettings, runMigrations, type Db } from "@regulait/db";
import { buildApp } from "./app.js";
import { CONNECTOR_CATALOGUE_RULE_ID, CONNECTOR_PIECE_GATE_RULE_ID } from "./connector-catalogue.js";
import { DEPLOY_MODE_ENV } from "./deploy-posture.js";
import { relaxStepUpAround } from "./testing/step-up-posture.js";
import { relaxDataPostureForTest } from "./testing/strict-data-posture.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const BOOT = "connector-catalogue-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = "7".repeat(64);
const uniq = () => randomUUID().slice(0, 8);

let db: Db;
let app: ReturnType<typeof buildApp>;
let userId: string;
let userAuth: { authorization: string };
let savedMode: string | undefined;
let savedPolicy: "inherit" | "strict" | undefined;
let realFetch: typeof fetch;
let hits: string[] = [];
let restorePosture: (() => Promise<void>) | undefined;
let restoreGates: (() => Promise<void>) | undefined;

const setEnabled = (pieceKey: string, enabled: boolean, reason = "P31 suite") =>
  relaxStepUpAround(db, () =>
    app.inject({ method: "POST", headers: AUTH, url: `/v1/connector-catalogue/${pieceKey}/enablement`, payload: { enabled, reason } }),
  );

const createSlackPieceConnector = () =>
  app.inject({ method: "POST", headers: AUTH, url: "/v1/connectors", payload: { name: `p31-slack-${uniq()}`, kind: "chat", providerKind: "piece_slack" } });

const invoke = (connectorId: string, object = "send_channel_message") =>
  app.inject({
    method: "POST",
    headers: userAuth,
    url: `/v1/connectors/${connectorId}/invoke`,
    payload: { operation: "write", object, payload: { channel: "C123", text: "hello" } },
  });

const lastRow = async (ruleId: string) =>
  (await db.select().from(auditLog).where(eq(auditLog.ruleId, ruleId)).orderBy(desc(auditLog.at)).limit(1))[0];

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  await db.delete(connectorPieceEnablements);
  restorePosture = await relaxDataPostureForTest(db, { org: { defaultPiiMode: "none" }, interception: false, guardrails: false });
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
  restoreGates = await relaxGovernanceGatesForTest(db, { mrmEnforced: false, dispatchAttributionRequired: false, keyCustodyEnforced: false });
  savedMode = process.env[DEPLOY_MODE_ENV];
  delete process.env[DEPLOY_MODE_ENV];
  const [org] = await db.select({ p: orgSettings.egressCompiledDefaultPolicy }).from(orgSettings);
  savedPolicy = org?.p as "inherit" | "strict" | undefined;
  // the shipped default (ADR-0181): compiled vendor hosts are adjudicated against the allow-list
  await db.update(orgSettings).set({ egressCompiledDefaultPolicy: "strict" });
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    hits.push(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  const u = await app.inject({ method: "POST", headers: AUTH, url: "/v1/users", payload: { email: `p31-${uniq()}@example.com`, displayName: "P31 Member" } });
  userId = u.json().id;
  const key = await app.inject({ method: "POST", headers: AUTH, url: `/v1/users/${userId}/keys`, payload: { name: "cli" } });
  userAuth = { authorization: `Bearer ${key.json().token}` };
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  if (savedMode === undefined) delete process.env[DEPLOY_MODE_ENV];
  else process.env[DEPLOY_MODE_ENV] = savedMode;
  if (savedPolicy) await db.update(orgSettings).set({ egressCompiledDefaultPolicy: savedPolicy });
  await db.delete(connectorPieceEnablements);
  await restoreGates?.();
  await restorePosture?.();
  await app.close();
  await (db.$client as { end: () => Promise<void> }).end();
});

describe("the connector catalogue (ADR-0255)", () => {
  it("lists every curated piece NOT enabled, and the community catalogue as available, not enabled (paginated)", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/connector-catalogue?limit=5", headers: AUTH });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.curated.map((p: { key: string }) => p.key)).toEqual(["slack", "jira-cloud", "github", "google-sheets", "gmail"]);
    expect(body.curated.every((p: { status: string }) => p.status === "not_enabled")).toBe(true);
    expect(body.available.items).toHaveLength(5);
    expect(body.available.total).toBeGreaterThan(100);
    expect(body.available.items.every((i: { status: string }) => i.status === "available_not_enabled")).toBe(true);
    const q = await app.inject({ method: "GET", url: "/v1/connector-catalogue?q=notion", headers: AUTH });
    expect(q.json().available.items.every((i: { key: string }) => i.key.includes("notion"))).toBe(true);
    expect((await app.inject({ method: "GET", url: "/v1/connector-catalogue?limit=1000", headers: AUTH })).statusCode).toBe(400);
  });

  it("is admin-only", async () => {
    expect((await app.inject({ method: "GET", url: "/v1/connector-catalogue", headers: userAuth })).statusCode).toBe(403);
    const res = await app.inject({ method: "POST", url: "/v1/connector-catalogue/slack/enablement", headers: userAuth, payload: { enabled: true, reason: "nope" } });
    expect(res.statusCode).toBe(403);
    expect(await db.select().from(connectorPieceEnablements)).toHaveLength(0);
  });

  // the step-up itself (kind settings_relax) is proved in zz-b4a-step-up.test.ts; on a shared database whether the
  // bootstrap credential passes it depends on first-admin setup, so this file drives enablement with it relaxed
  it("an unknown piece is a 404, a listed piece with no adapter a 409, and a reason is required", async () => {
    expect((await setEnabled("no-such-piece", true)).statusCode).toBe(404);
    const listed = await setEnabled("notion", true);
    expect(listed.statusCode).toBe(409);
    expect(listed.json().error).toBe("piece_has_no_adapter");
    expect((await setEnabled("slack", true, "")).statusCode).toBe(400);
  });

  it("a piece connector cannot be created before its piece is enabled", async () => {
    const res = await createSlackPieceConnector();
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("piece_not_enabled");
  });

  it("enable and disable are audited with the transition and the reason", async () => {
    const on = await setEnabled("slack", true, "approved for the support team");
    expect(on.statusCode).toBe(200);
    expect(on.json().piece.status).toBe("enabled");
    const row = await lastRow(CONNECTOR_CATALOGUE_RULE_ID);
    expect(row!.objectType).toBe("connector_piece");
    expect(row!.detail).toMatchObject({ pieceKey: "slack", transition: { from: "not_enabled", to: "enabled" }, reason: "approved for the support team" });
    // disabling tightens: no step-up needed
    const off = await app.inject({ method: "POST", url: "/v1/connector-catalogue/slack/enablement", headers: AUTH, payload: { enabled: false, reason: "pause" } });
    expect(off.statusCode).toBe(200);
    expect(off.json().piece.status).toBe("not_enabled");
    expect((await lastRow(CONNECTOR_CATALOGUE_RULE_ID))!.detail).toMatchObject({ transition: { from: "enabled", to: "not_enabled" } });
  });

  it("a baseUrl override is refused for a piece connector", async () => {
    await setEnabled("slack", true);
    const res = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/connectors",
      payload: { name: `p31-slack-url-${uniq()}`, kind: "chat", providerKind: "piece_slack", baseUrl: "https://evil.example" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("piece_base_url_refused");
  });

  describe("invoking a piece connector", () => {
    let connectorId: string;
    beforeAll(async () => {
      await setEnabled("slack", true);
      const created = await createSlackPieceConnector();
      expect(created.statusCode).toBe(201);
      connectorId = created.json().id;
      const cred = await app.inject({ method: "POST", headers: AUTH, url: `/v1/connectors/${connectorId}/credential`, payload: { token: "xoxb-p31-mock" } });
      expect(cred.statusCode).toBeLessThan(300);
    });

    it("is default-deny: no grant, no call", async () => {
      hits = [];
      const res = await invoke(connectorId);
      expect(res.statusCode).toBe(403);
      expect(hits).toHaveLength(0);
    });

    it("the grant's allowedObjects names the actions a person may run", async () => {
      const g = await app.inject({
        method: "POST",
        headers: AUTH,
        url: "/v1/grants/connectors",
        payload: { userId, connectorId, mode: "readwrite", allowedObjects: ["send_channel_message"] },
      });
      expect(g.statusCode).toBeLessThan(300);
      hits = [];
      const other = await invoke(connectorId, "send_direct_message");
      expect(other.statusCode).toBe(403);
      expect(hits).toHaveLength(0);
    });

    it("an enabled piece goes to the egress guard: a non-allow-listed vendor host is refused, nothing is dialled", async () => {
      hits = [];
      const res = await invoke(connectorId);
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("egress_blocked");
      expect(res.json().detail).toContain("slack.com");
      expect(hits).toHaveLength(0);
    });

    it("a disabled piece is refused on invoke, with a deny row", async () => {
      await setEnabled("slack", false);
      hits = [];
      const res = await invoke(connectorId);
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("piece_not_enabled");
      expect(hits).toHaveLength(0);
      const row = await lastRow(CONNECTOR_PIECE_GATE_RULE_ID);
      expect(row!.effect).toBe("deny");
      expect(row!.objectId).toBe(connectorId);
      expect(row!.detail).toMatchObject({ phase: "piece_gate", error: "piece_not_enabled", connectorKind: "piece_slack" });
    });

    it("air-gapped: a piece cannot be enabled, and an enabled piece is refused on invoke", async () => {
      await setEnabled("slack", true);
      process.env[DEPLOY_MODE_ENV] = "air_gapped";
      try {
        const en = await setEnabled("github", true);
        expect(en.statusCode).toBe(409);
        expect(en.json().error).toBe("piece_air_gapped");
        const list = await app.inject({ method: "GET", url: "/v1/connector-catalogue", headers: AUTH });
        expect(list.json().runnable).toBe(false);
        hits = [];
        const res = await invoke(connectorId);
        expect(res.statusCode).toBe(403);
        expect(res.json().error).toBe("piece_air_gapped");
        expect(hits).toHaveLength(0);
      } finally {
        delete process.env[DEPLOY_MODE_ENV];
      }
      expect(
        await db.select().from(connectorPieceEnablements).where(and(eq(connectorPieceEnablements.pieceKey, "github"))),
      ).toHaveLength(0);
    });
  });

  it("the DB refuses an enablement for a piece with no adapter, around the API", async () => {
    await expect(db.insert(connectorPieceEnablements).values({ pieceKey: "notion" })).rejects.toThrow();
  });
});
