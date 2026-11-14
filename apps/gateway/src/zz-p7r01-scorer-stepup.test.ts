/**
 * P7R-01 (post-merge review of #634, ADR-0220 decision 6): an enabled trained
 * detector's instrument cannot be swapped by mutating the scorer it uses.
 *
 * The finding: the detector PUT steps up a change of `scorerId`, but the
 * scorer row itself stayed mutable. An admin API key (which can never give a
 * step-up) could PATCH the scorer to another service, run its connection test
 * and re-enable it, and the same detector then scored with the new service.
 *
 * What this file pins, under the STRICT step-up policy, against a real
 * database and two real loopback scoring services (A answers 0.99, B 0.01):
 *  1. the full PATCH → test → enable sequence with an admin API key is refused
 *     at PATCH, and the detector still blocks;
 *  2. every instrument field (endpoint, transport, credential, kinds) is
 *     refused the same way, and each refusal is audited;
 *  3. re-enabling an in-use scorer needs the step-up even after a stepped-up
 *     move, and disabling it is free unless a detector falls back to the
 *     heuristic;
 *  4. cosmetic fields, and a scorer no enabled detector uses, are unchanged;
 *  5. a scorer write and a detector bind are serialised: whichever waits on
 *     the other refuses with `changed_concurrently` rather than writing on a
 *     stale decision.
 *
 * Shared-state discipline: objects are `p7r-` prefixed; the trained-detector
 * rows and this file's scorers are removed in afterAll.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  and,
  auditLog,
  createDb,
  desc,
  eq,
  externalScorers,
  guardrailTrainedDetectors,
  sql,
  runMigrations,
  type Db,
} from "@regulait/db";
import { relaxStepUpAround } from "./testing/step-up-posture.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { removeEgressAllowEntry } from "./testing/egress-allow-cleanup.js";
import { TRAINED_DETECTOR_LOCK_KEY } from "./trained-detector-lock.js";

vi.mock("@regulait/model-provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@regulait/model-provider")>();
  return {
    ...actual,
    resolveModelProvider: (
      ...args: Parameters<typeof actual.resolveModelProvider>
    ): ReturnType<typeof actual.resolveModelProvider> => {
      const inner = actual.resolveModelProvider(...args);
      const wrapped = Object.create(inner as object) as typeof inner;
      wrapped.dispatch = async () => ({
        outputText: "An ordinary answer about quarterly planning.",
        stopReason: "end_turn",
        refusal: false,
        usage: { inputTokens: 10, outputTokens: 10 },
        providerMessageId: "p7r-mock-1",
      });
      return wrapped;
    },
  };
});

const { buildApp } = await import("./app.js");
const { relaxDataPostureForTest } = await import("./testing/strict-data-posture.js");

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const BOOT = "p7r-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const RUN = Math.random().toString(36).slice(2, 8);

let db: Db;
let app: ReturnType<typeof buildApp>;
let srvA: http.Server;
let srvB: http.Server;
let urlA: string;
let urlB: string;
let userAuth: { authorization: string };
let agentId: string;
let scorerId: string;
let spareId: string;
let adminKeyAuth: { authorization: string };
let loopbackId: string | undefined;
let restoreGates: () => Promise<void> = async () => {};
let restorePosture: () => Promise<void> = async () => {};
let restoreIdentity: () => Promise<void> = async () => {};

function scoringService(score: number): http.Server {
  return http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ score }));
    });
  });
}

async function listen(srv: http.Server): Promise<string> {
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(srv.address() as { port: number }).port}/score`;
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  await db.delete(guardrailTrainedDetectors);
  restorePosture = await relaxDataPostureForTest(db, { org: { defaultPiiMode: "none" }, guardrails: false });
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "d".repeat(64) });
  restoreGates = await relaxGovernanceGatesForTest(db, { mrmEnforced: false, dispatchAttributionRequired: false });
  restoreIdentity = await relaxIdentityForTest(db, { mfaRequired: "off" });

  srvA = scoringService(0.99);
  srvB = scoringService(0.01);
  urlA = await listen(srvA);
  urlB = await listen(srvB);

  const allow = await relaxStepUpAround(db, () =>
    app.inject({
      method: "POST",
      url: "/v1/egress-allow-hosts",
      headers: AUTH,
      payload: { host: "127.0.0.1", allowPrivateRanges: true, allowPlaintextHttp: true, note: "p7r suite: local scorers" },
    }),
  );
  expect(allow.statusCode, allow.body).toBe(201);
  loopbackId = allow.json().id;

  const u = await app.inject({ method: "POST", url: "/v1/users", headers: AUTH, payload: { email: `p7r-user-${RUN}@example.com`, displayName: "p7r user" } });
  const k = await app.inject({ method: "POST", url: `/v1/users/${u.json().id}/keys`, headers: AUTH, payload: { name: "p7r" } });
  userAuth = { authorization: `Bearer ${k.json().token}` };
  const a = await app.inject({
    method: "POST",
    url: "/v1/agents",
    headers: AUTH,
    payload: { name: `p7r-agent-${RUN}`, provider: "mock", model: "mock-balanced", tier: 1, costPerMTokIn: 3, costPerMTokOut: 15 },
  });
  agentId = a.json().id;
  await app.inject({ method: "POST", url: "/v1/grants/agents", headers: AUTH, payload: { userId: u.json().id, agentId } });

  const register = async (name: string, baseUrl: string) => {
    const s = await app.inject({
      method: "POST",
      url: "/v1/external-scorers",
      headers: AUTH,
      payload: { name, baseUrl, scorerKinds: ["guardrail_prompt_injection"], allowPlaintextHttp: true },
    });
    expect(s.statusCode, s.body).toBe(201);
    const id = s.json().id as string;
    expect((await app.inject({ method: "POST", url: `/v1/external-scorers/${id}/test`, headers: AUTH })).statusCode).toBe(200);
    const en = await app.inject({ method: "POST", url: `/v1/external-scorers/${id}/enabled`, headers: AUTH, payload: { enabled: true } });
    expect(en.statusCode, en.body).toBe(200);
    return id;
  };
  scorerId = await register(`p7r-a-${RUN}`, urlA);
  spareId = await register(`p7r-spare-${RUN}`, urlA);

  const adm = await app.inject({
    method: "POST",
    url: "/v1/users",
    headers: AUTH,
    payload: { email: `p7r-admin-${RUN}@example.com`, displayName: "p7r admin", isAdmin: true },
  });
  expect(adm.statusCode, adm.body).toBe(201);
  const key = await app.inject({ method: "POST", url: `/v1/users/${adm.json().id}/keys`, headers: AUTH, payload: { name: "p7r" } });
  adminKeyAuth = { authorization: `Bearer ${key.json().token}` };

  // the detector on, at the strict defaults (block, fails closed): turning one on is a tightening
  const on = await app.inject({
    method: "PUT",
    url: "/v1/guardrails/trained-detectors/prompt_injection",
    headers: AUTH,
    payload: { enabled: true, scorerId },
  });
  expect(on.statusCode, on.body).toBe(200);
});

afterAll(async () => {
  const loopback = await removeEgressAllowEntry(app, AUTH, { id: loopbackId });
  try {
    await db.delete(guardrailTrainedDetectors);
    await db.delete(externalScorers).where(eq(externalScorers.id, scorerId));
    await db.delete(externalScorers).where(eq(externalScorers.id, spareId));
    for (const s of [srvA, srvB]) {
      s.closeAllConnections();
      await new Promise<void>((r) => s.close(() => r()));
    }
    await restoreGates();
    await restorePosture();
    await restoreIdentity();
    await app.close();
  } finally {
    loopback.assertRemoved();
  }
});

const invoke = () =>
  app.inject({
    method: "POST",
    url: `/v1/agents/${agentId}/invoke`,
    headers: userAuth,
    payload: { mode: "execute", input: "please summarise the quarterly plan", dispatch: true },
  });

const asKey = (method: "PATCH" | "POST", url: string, payload: Record<string, unknown>) =>
  app.inject({ method, url, headers: adminKeyAuth, payload });

const scorerRow = async (id = scorerId) => (await db.select().from(externalScorers).where(eq(externalScorers.id, id)))[0]!;

const lastAudit = async (ruleId: string) =>
  (
    await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.ruleId, ruleId), eq(auditLog.objectType, "external_scorer")))
      .orderBy(desc(auditLog.at))
      .limit(1)
  )[0];

/** hold the trained-detector lock; `run` gets the locked tx and a wait for a blocked waiter */
async function withLockHeld(run: (tx: Db, waiterBlocked: () => Promise<void>) => Promise<void>): Promise<void> {
  await db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    await tx.execute(sql`select pg_advisory_xact_lock(${TRAINED_DETECTOR_LOCK_KEY}::bigint)`);
    await run(tx, async () => {
      for (let i = 0; i < 200; i += 1) {
        const r = (await db.execute(
          sql`select count(*)::int as n from pg_locks where locktype = 'advisory' and not granted`,
        )) as unknown as { rows?: Array<{ n: number }> } & Array<{ n: number }>;
        const n = (r.rows ?? r)[0]?.n ?? 0;
        if (n > 0) return;
        await new Promise((res) => setTimeout(res, 25));
      }
      throw new Error("no request waited on the trained-detector lock");
    });
  });
}

describe("P7R-01 a scorer in use by an enabled trained detector", () => {
  it("baseline: the detector blocks through service A", async () => {
    const res = await invoke();
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().error).toBe("guardrail_blocked");
  });

  it("refuses the PATCH → test → enable swap with an admin API key, and the detector still blocks", async () => {
    const patched = await asKey("PATCH", `/v1/external-scorers/${scorerId}`, { baseUrl: urlB });
    expect(patched.statusCode, patched.body).toBe(403);
    expect(patched.json()).toMatchObject({ error: "step_up_required", actionKind: "settings_relax" });
    expect(await scorerRow()).toMatchObject({ baseUrl: urlA, enabled: true });
    // the rest of the sequence changes nothing: the test re-proves A, re-enabling an enabled scorer is a no-op
    expect((await asKey("POST", `/v1/external-scorers/${scorerId}/test`, {})).statusCode).toBe(200);
    expect((await asKey("POST", `/v1/external-scorers/${scorerId}/enabled`, { enabled: true })).statusCode).toBe(200);
    const res = await invoke();
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().error).toBe("guardrail_blocked");
    const refused = await lastAudit("external-scorer-in-use-refused");
    expect(refused).toMatchObject({ effect: "deny", objectId: scorerId });
    expect(refused!.detail).toMatchObject({ phase: "update", detectors: ["prompt_injection"], fields: ["baseUrl"] });
  });

  it("refuses every instrument field the same way: transport, credential, kinds", async () => {
    for (const payload of [
      { allowPlaintextHttp: false },
      { apiKey: "p7r-new-credential" },
      { scorerKinds: ["guardrail_prompt_injection", "guardrail_harm"] },
    ]) {
      const res = await asKey("PATCH", `/v1/external-scorers/${scorerId}`, payload);
      expect(res.statusCode, `${JSON.stringify(payload)}: ${res.body}`).toBe(403);
      expect(res.json()).toMatchObject({ error: "step_up_required", actionKind: "settings_relax" });
      const refused = await lastAudit("external-scorer-in-use-refused");
      expect((refused!.detail as { fields: string[] }).fields).toEqual(Object.keys(payload));
      // the credential's value is never written into the audit trail
      expect(JSON.stringify(refused)).not.toContain("p7r-new-credential");
    }
    const row = await scorerRow();
    expect(row).toMatchObject({ baseUrl: urlA, allowPlaintextHttp: true, keyCiphertext: null, enabled: true });
    expect(row.scorerKinds).toEqual(["guardrail_prompt_injection"]);
  });

  it("allows a cosmetic change while in use, audited as in use", async () => {
    const res = await asKey("PATCH", `/v1/external-scorers/${scorerId}`, { pricePerCallUsd: 0.001 });
    expect(res.statusCode, res.body).toBe(200);
    const audit = await lastAudit("external-scorer-updated");
    expect(audit!.detail).toMatchObject({ inUseBy: ["prompt_injection"] });
    expect(audit!.detail).not.toHaveProperty("stepUp");
  });

  it("a stepped-up move still needs a step-up to re-enable; meanwhile the detector fails closed", async () => {
    const moved = await relaxStepUpAround(db, () =>
      app.inject({ method: "PATCH", url: `/v1/external-scorers/${scorerId}`, headers: AUTH, payload: { baseUrl: urlB } }),
    );
    expect(moved.statusCode, moved.body).toBe(200);
    expect(moved.json()).toMatchObject({ baseUrl: urlB, enabled: false });
    expect((await lastAudit("external-scorer-updated"))!.detail).toMatchObject({ stepUp: "settings_relax", relaxed: ["baseUrl"] });
    const closed = await invoke();
    expect(closed.statusCode, closed.body).toBe(403);
    expect(JSON.stringify(closed.json())).toContain("trained_unavailable");

    expect((await asKey("POST", `/v1/external-scorers/${scorerId}/test`, {})).statusCode).toBe(200);
    const enable = await asKey("POST", `/v1/external-scorers/${scorerId}/enabled`, { enabled: true });
    expect(enable.statusCode, enable.body).toBe(403);
    expect(enable.json()).toMatchObject({ error: "step_up_required", actionKind: "settings_relax" });
    expect((await lastAudit("external-scorer-in-use-refused"))!.detail).toMatchObject({ phase: "enablement" });
    expect((await scorerRow()).enabled).toBe(false);

    // put A back the stepped-up way, for the tests below
    const back = await relaxStepUpAround(db, async () => {
      await app.inject({ method: "PATCH", url: `/v1/external-scorers/${scorerId}`, headers: AUTH, payload: { baseUrl: urlA } });
      await app.inject({ method: "POST", url: `/v1/external-scorers/${scorerId}/test`, headers: AUTH });
      return app.inject({ method: "POST", url: `/v1/external-scorers/${scorerId}/enabled`, headers: AUTH, payload: { enabled: true } });
    });
    expect(back.statusCode, back.body).toBe(200);
    expect((await lastAudit("external-scorer-enabled"))!.detail).toMatchObject({ stepUp: "settings_relax", inUseBy: ["prompt_injection"] });
    expect((await invoke()).statusCode).toBe(403);
  });

  it("disabling is free while every detector using it fails closed, a step-up once one falls back to the heuristic", async () => {
    const off = await asKey("POST", `/v1/external-scorers/${scorerId}/enabled`, { enabled: false });
    expect(off.statusCode, off.body).toBe(200);
    const on = await relaxStepUpAround(db, () =>
      app.inject({ method: "POST", url: `/v1/external-scorers/${scorerId}/enabled`, headers: AUTH, payload: { enabled: true } }),
    );
    expect(on.statusCode, on.body).toBe(200);

    const fallback = await relaxStepUpAround(db, () =>
      app.inject({
        method: "PUT",
        url: "/v1/guardrails/trained-detectors/prompt_injection",
        headers: AUTH,
        payload: { enabled: true, onFailure: "heuristic" },
      }),
    );
    expect(fallback.statusCode, fallback.body).toBe(200);
    const refused = await asKey("POST", `/v1/external-scorers/${scorerId}/enabled`, { enabled: false });
    expect(refused.statusCode, refused.body).toBe(403);
    expect(refused.json()).toMatchObject({ error: "step_up_required", actionKind: "settings_relax" });
    expect((await scorerRow()).enabled).toBe(true);
  });

  it("a scorer no enabled detector uses keeps its old behaviour (no step-up for a move)", async () => {
    const res = await asKey("PATCH", `/v1/external-scorers/${spareId}`, { baseUrl: urlB });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ baseUrl: urlB, enabled: false });
    expect((await lastAudit("external-scorer-updated"))!.detail).not.toHaveProperty("inUseBy");
  });

  it("a scorer write waiting on a detector bind refuses with changed_concurrently", async () => {
    // spare is not in use, so the PATCH asks no step-up; a bind lands while it waits on the lock
    await relaxStepUpAround(db, async () => {
      await app.inject({ method: "POST", url: `/v1/external-scorers/${spareId}/test`, headers: AUTH });
      await app.inject({ method: "POST", url: `/v1/external-scorers/${spareId}/enabled`, headers: AUTH, payload: { enabled: true } });
    });
    let patched: Awaited<ReturnType<typeof asKey>> | undefined;
    await withLockHeld(async (tx, waiterBlocked) => {
      const pending = asKey("PATCH", `/v1/external-scorers/${spareId}`, { baseUrl: urlA }).then((r) => (patched = r));
      await waiterBlocked();
      await tx
        .update(guardrailTrainedDetectors)
        .set({ scorerId: spareId })
        .where(eq(guardrailTrainedDetectors.kind, "prompt_injection"));
      void pending;
    });
    for (let i = 0; i < 200 && !patched; i += 1) await new Promise((r) => setTimeout(r, 25));
    expect(patched?.statusCode, patched?.body).toBe(409);
    expect(patched!.json().error).toBe("changed_concurrently");
    expect((await scorerRow(spareId)).baseUrl).toBe(urlB);
    expect(await lastAudit("external-scorer-changed-concurrently")).toMatchObject({ effect: "deny", objectId: spareId });
    // put the binding back
    await db.update(guardrailTrainedDetectors).set({ scorerId }).where(eq(guardrailTrainedDetectors.kind, "prompt_injection"));
  });

  it("a detector bind waiting on a scorer write refuses with changed_concurrently", async () => {
    // binding the detector back to fail closed is a tightening (no step-up); the scorer moves while it waits
    let put: Awaited<ReturnType<typeof app.inject>> | undefined;
    await withLockHeld(async (tx, waiterBlocked) => {
      const pending = app
        .inject({
          method: "PUT",
          url: "/v1/guardrails/trained-detectors/prompt_injection",
          headers: AUTH,
          payload: { enabled: true, scorerId, onFailure: "block" },
        })
        .then((r) => (put = r));
      await waiterBlocked();
      await tx.update(externalScorers).set({ baseUrl: urlB }).where(eq(externalScorers.id, scorerId));
      void pending;
    });
    for (let i = 0; i < 200 && !put; i += 1) await new Promise((r) => setTimeout(r, 25));
    expect(put?.statusCode, put?.body).toBe(409);
    expect(put!.json().error).toBe("changed_concurrently");
    const [row] = await db.select().from(guardrailTrainedDetectors).where(eq(guardrailTrainedDetectors.kind, "prompt_injection"));
    expect(row?.onFailure).toBe("heuristic");
    await db.update(externalScorers).set({ baseUrl: urlA }).where(eq(externalScorers.id, scorerId));
  });

  it("refuses to delete it, audited", async () => {
    const res = await app.inject({ method: "DELETE", url: `/v1/external-scorers/${scorerId}`, headers: AUTH });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("external_scorer_in_use");
    expect((await lastAudit("external-scorer-in-use-refused"))!.detail).toMatchObject({ phase: "removal" });
  });
});
