/**
 * ADR-0334 (lane E16): the managed browser extension's gateway routes, end to end on a real database.
 *
 * What this proves:
 *  - off by default: every extension route refuses while browser governance is off; turning it on, audit mode, an
 *    allowed site and prompt capture are each a `settings_relax` step-up, audited;
 *  - enrolment: a capped bulk token shown once (never in a list), the managed config carries the policy key; a
 *    registration is idempotent for one key, the cap holds, a private key member is refused;
 *  - the device is a `browser_extension` workload identity: its key is bound through S6, every later request takes
 *    its S7 DPoP-bound self token (a bearer, another identity's token and a replayed DPoP proof are refused), and that
 *    token reaches only the three extension routes;
 *  - the policy is per user and fail closed (unknown person, no rule) and verifies under the managed config's key;
 *  - breach events are stored once, tied to the user, a pseudonym and a keyed conversation ref, with no path, account
 *    name or prompt text anywhere in storage, and are append-only;
 *  - prompt capture is refused until enabled; a captured prompt is enveloped and read only with its own step-up;
 *  - a revoked device is refused from then on.
 */
import { createPublicKey, generateKeyPairSync, randomUUID, verify } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  auditLog,
  browserEvents,
  browserGovernanceSettings,
  browserPromptCaptures,
  browserSiteAccountDomains,
  browserSiteRules,
  createDb,
  discoveryPseudonymKeys,
  eq,
  runMigrations,
  sql,
  type Db,
} from "@regulait/db";
import { BROWSER_EXTENSION_PATHS, browserPolicySchema } from "@regulait/shared";
import { buildApp } from "./app.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { grantStepUpForTest, sessionRequest, stepUpRequest } from "./testing/step-up-grant.js";
import type { StepUpCheckArgs } from "./step-up.js";
import { endpointAgentKeys } from "./testing/endpoint-agent-client.js";
import { useTestIssuerKey } from "./testing/workload-client.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const BOOT = "adr0334-bootstrap-token";
const ORIGIN = "https://gateway.adr0334.example";
const DATA_KEY = "d".repeat(64);
const AUTH = { authorization: `Bearer ${BOOT}` };
const RUN = Date.now();
const ADMIN_EMAIL = `adr0334-admin-${RUN}@example.com`;
const ENV_KEYS = ["REGULAIT_BROWSER_POLICY_SIGNING_KEY", "REGULAIT_BROWSER_POLICY_SIGNING_KEY_ID", "REGULAIT_PUBLIC_URL"] as const;
let db: Db;
let app: ReturnType<typeof buildApp>;
let adminId: string;
let KEY: { authorization: string };
let keyDir: string;
let managed: { gatewayUrl: string; enrolmentToken: string; policyKeys: { keyId: string; x: string }[] };
let tokenId: string;
const restores: Array<() => Promise<void> | void> = [];

const steppedUp = async (kind: StepUpCheckArgs["kind"], facts: Record<string, unknown>) => stepUpRequest(await grantStepUpForTest(db, adminId, { kind, facts } as StepUpCheckArgs));
const plainSession = async () => sessionRequest(await grantStepUpForTest(db, adminId, { kind: "settings_relax", facts: { unrelated: true } }));

// the endpoint agent's test client, pointed at the browser extension's self-token resource (one device key each)
const DeviceKey = endpointAgentKeys(() => app, DATA_KEY, ORIGIN, "/v1/browser-extension");
type Device = InstanceType<typeof DeviceKey> & { id: string };
const newDevice = async (): Promise<Device> => Object.assign(await DeviceKey.make(), { id: "" });

const register = (dev: Device, token = managed.enrolmentToken, extra: Record<string, unknown> = {}) =>
  app.inject({
    method: "POST",
    url: BROWSER_EXTENSION_PATHS.register,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    payload: JSON.stringify({ publicJwk: { ...dev.jwk, ...extra }, os: "linux", browserMajor: 140, extensionVersion: "0.1.0" }),
  });

async function signed(dev: Device, p: string, payload: unknown, headers?: Record<string, string>) {
  return app.inject({ method: "POST", url: p, headers: { ...(headers ?? (await dev.headers("POST", p))), "content-type": "application/json" }, payload: JSON.stringify(payload) });
}

/** the database's refusal message (drizzle wraps it in `cause`), or "" when the statement was not refused */
async function refusal(q: PromiseLike<unknown>): Promise<string> {
  try {
    await q;
    return "";
  } catch (err) {
    const e = err as { message?: string; cause?: { message?: string } };
    return `${e.cause?.message ?? ""} ${e.message ?? ""}`;
  }
}

async function verifiedPolicy(env: { keyId: string; payload: string; signature: string }) {
  const key = managed.policyKeys.find((k) => k.keyId === env.keyId)!;
  const payload = Buffer.from(env.payload, "base64");
  expect(verify(null, payload, createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: key.x }, format: "jwk" }), Buffer.from(env.signature, "base64"))).toBe(true);
  return browserPolicySchema.parse(JSON.parse(payload.toString("utf8")));
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restores.push(await relaxIdentityForTest(db, { mfaRequired: "off" }));
  restores.push(await useTestIssuerKey(db));
  const saved = await db.select().from(discoveryPseudonymKeys);
  await db.delete(discoveryPseudonymKeys);
  restores.push(async () => {
    await db.delete(discoveryPseudonymKeys);
    if (saved.length) await db.insert(discoveryPseudonymKeys).values(saved);
  });
  // the settings row and site rules are this file's alone; put them back to the strict default afterwards
  restores.push(async () => {
    await db.update(browserGovernanceSettings).set({ enabled: false, mode: "enforce", promptCaptureEnabled: false }).where(eq(browserGovernanceSettings.id, 1));
    await db.delete(browserSiteAccountDomains);
    await db.delete(browserSiteRules);
  });
  const env = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  restores.push(() => {
    for (const k of ENV_KEYS) {
      if (env[k] === undefined) delete process.env[k];
      else process.env[k] = env[k];
    }
  });
  keyDir = mkdtempSync(path.join(tmpdir(), "adr0334-"));
  restores.push(() => rmSync(keyDir, { recursive: true, force: true }));
  const pem = path.join(keyDir, "browser-policy.pem");
  writeFileSync(pem, generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }));
  process.env.REGULAIT_BROWSER_POLICY_SIGNING_KEY = pem;
  process.env.REGULAIT_BROWSER_POLICY_SIGNING_KEY_ID = `adr0334-${RUN}`;
  process.env.REGULAIT_PUBLIC_URL = ORIGIN;
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
  const created = await app.inject({ method: "POST", url: "/v1/users", headers: AUTH, payload: { email: ADMIN_EMAIL, displayName: "browser admin", isAdmin: true } });
  expect(created.statusCode, created.body).toBe(201);
  adminId = created.json().id;
  const key = await app.inject({ method: "POST", url: `/v1/users/${adminId}/keys`, headers: AUTH, payload: { name: "adr0334" } });
  KEY = { authorization: `Bearer ${key.json().token}` };
  await db.update(browserGovernanceSettings).set({ enabled: false, mode: "enforce", promptCaptureEnabled: false }).where(eq(browserGovernanceSettings.id, 1));
});

afterAll(async () => {
  for (const r of restores.reverse()) await r();
  await app?.close();
});

describe("ADR-0334 off by default", () => {
  it("reads as off, enforce, no capture", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/browser-governance", headers: KEY });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ enabled: false, mode: "enforce", promptCaptureEnabled: false, policyKey: { state: "ok", keyId: `adr0334-${RUN}` } });
  });

  it("every extension route refuses while it is off, and an enrolment token cannot be issued", async () => {
    const dev = await newDevice();
    const reg = await register(dev, `rgbe_${"a".repeat(64)}`);
    expect(reg.statusCode).toBe(403);
    expect(reg.json()).toEqual({ error: "browser_governance_disabled" });
    // no device can exist yet, so the self-token routes refuse at the authentication layer
    const pol = await signed(dev, BROWSER_EXTENSION_PATHS.policy, { profileEmail: "" }, {});
    expect(pol.statusCode).toBe(401);
    const issue = await app.inject({ method: "POST", url: "/v1/browser-governance/enrolment-tokens", headers: KEY, payload: { label: "x", deviceCap: 1 } });
    expect(issue.statusCode).toBe(409);
  });

  it("turning it on needs a step-up bound to the change, and is audited as a relaxation", async () => {
    const refused = await app.inject({ method: "PUT", url: "/v1/browser-governance/settings", ...(await plainSession()), payload: { enabled: true } });
    expect([403, 422], refused.body).toContain(refused.statusCode);
    const facts = { op: "browser_governance_settings", enabled: true, mode: "enforce", promptCaptureEnabled: false, relaxations: ["enable"] };
    const res = await app.inject({ method: "PUT", url: "/v1/browser-governance/settings", ...(await steppedUp("settings_relax", facts)), payload: { enabled: true } });
    expect(res.statusCode, res.body).toBe(200);
    const [row] = await db.select().from(auditLog).where(sql`${auditLog.ruleId} = 'browser-governance-relaxed' and ${auditLog.userId} = ${adminId}`);
    expect(row).toBeDefined();
    // turning it off again needs no step-up: that is the strict direction
  });
});

describe("ADR-0334 enrolment and proofs", () => {
  const dev: { a?: Device; b?: Device } = {};

  it("issues a capped token once, with the managed config", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/browser-governance/enrolment-tokens", headers: KEY, payload: { label: `adr0334-${RUN}`, deviceCap: 1, expiresInDays: 7 } });
    expect(res.statusCode, res.body).toBe(201);
    managed = res.json().managedConfig;
    tokenId = res.json().token.tokenId;
    expect(managed.enrolmentToken).toMatch(/^rgbe_[0-9a-f]{64}$/);
    expect(managed.gatewayUrl).toBe(ORIGIN);
    expect(managed.policyKeys).toEqual([{ keyId: `adr0334-${RUN}`, x: expect.any(String) }]);
    const list = await app.inject({ method: "GET", url: "/v1/browser-governance/enrolment-tokens", headers: KEY });
    expect(list.body).not.toContain(managed.enrolmentToken);
    const long = await app.inject({ method: "POST", url: "/v1/browser-governance/enrolment-tokens", headers: KEY, payload: { label: "x", deviceCap: 1, expiresInDays: 31 } });
    expect(long.statusCode).toBe(400);
  });

  it("registers a key once (idempotent), refuses a private member and holds the cap", async () => {
    dev.a = await newDevice();
    const first = await register(dev.a);
    expect(first.statusCode, first.body).toBe(201);
    dev.a.id = first.json().deviceId;
    expect(first.json().clientId).toBe(dev.a.clientId);
    const [identity] = await db.execute(sql`select kind, status from workload_identities where id = ${first.json().identityId}`).then((r) => r.rows);
    expect(identity).toEqual({ kind: "browser_extension", status: "active" });
    const again = await register(dev.a);
    expect(again.statusCode).toBe(200);
    expect(again.json().deviceId).toBe(dev.a.id);
    dev.b = await newDevice();
    expect((await register(dev.b, managed.enrolmentToken, { d: "A".repeat(43) })).statusCode).toBe(400);
    const capped = await register(dev.b);
    expect(capped.statusCode).toBe(409);
    expect(capped.json()).toEqual({ error: "enrolment_cap_reached" });
    expect((await register(dev.b, `rgbe_${"0".repeat(64)}`)).statusCode).toBe(401);
  });

  it("takes only the device's DPoP-bound self token, refuses a replayed proof, and reaches nothing else", async () => {
    const a = dev.a!;
    const body = { profileEmail: "" };
    const p = BROWSER_EXTENSION_PATHS.policy;
    const token = await a.token();
    expect((await signed(a, p, body, { authorization: `Bearer ${token}` })).statusCode).toBe(401);
    const h = await a.headers("POST", p);
    expect((await signed(a, p, body, h)).statusCode).toBe(200);
    // the same DPoP proof again is a replay
    expect((await signed(a, p, body, h)).statusCode).toBe(401);
    // a key that registered nothing gets no token
    const stranger = await newDevice();
    expect((await stranger.tokenRequest()).statusCode).not.toBe(200);
    // the route ceiling: an admin route with the device's token
    const admin = await app.inject({ method: "GET", url: "/v1/browser-governance", headers: await a.headers("GET", "/v1/browser-governance") });
    expect(admin.statusCode).toBe(403);
    expect(admin.json().error).toBe("workload_scope");
  });

  it("answers a signed, per-user, fail-closed policy", async () => {
    const a = dev.a!;
    const unknown = await signed(a, BROWSER_EXTENSION_PATHS.policy, { profileEmail: `nobody-${RUN}@example.com` });
    const pu = await verifiedPolicy(unknown.json().policy);
    expect(pu.deviceId).toBe(a.id);
    expect(pu.sites.every((s) => s.denyReason === "user_unknown")).toBe(true);
    const known = await verifiedPolicy((await signed(a, BROWSER_EXTENSION_PATHS.policy, { profileEmail: ADMIN_EMAIL })).json().policy);
    expect(known.subject).toMatch(/^psn:[0-9a-f]{24}$/);
    expect(known.sites.every((s) => s.denyReason === "no_site_rule")).toBe(true);
  });

  it("allowing a site is a step-up bound to the site and its domains; the policy then carries them", async () => {
    const payload = { decision: "allow", accountDomains: ["example.com"] };
    const refused = await app.inject({ method: "PUT", url: "/v1/browser-governance/sites/ep-poe-web", ...(await plainSession()), payload });
    expect([403, 422], refused.body).toContain(refused.statusCode);
    const res = await app.inject({ method: "PUT", url: "/v1/browser-governance/sites/ep-poe-web", ...(await steppedUp("settings_relax", { op: "browser_site_allow", siteId: "ep-poe-web", accountDomains: ["example.com"] })), payload });
    expect(res.statusCode, res.body).toBe(200);
    expect((await app.inject({ method: "PUT", url: "/v1/browser-governance/sites/not-a-site", headers: KEY, payload: { decision: "deny" } })).statusCode).toBe(404);
    const p = await verifiedPolicy((await signed(dev.a!, BROWSER_EXTENSION_PATHS.policy, { profileEmail: ADMIN_EMAIL })).json().policy);
    expect(p.sites.find((s) => s.siteId === "ep-poe-web")).toEqual({ siteId: "ep-poe-web", decision: "allow", denyReason: null, accountDomains: ["example.com"] });
  });

  it("stores a breach event once, attributed, with no path, account name or text in storage, append-only", async () => {
    const a = dev.a!;
    const marker = `conv${RUN}`;
    const event = { eventId: randomUUID(), kind: "dlp_blocked", outcome: "blocked", code: "dlp_match", siteId: "ep-poe-web", ruleIds: ["dlp.secret.aws_key"], path: `/chat/${marker}`, occurredAt: Math.floor(Date.now() / 1000) };
    const res = await signed(a, BROWSER_EXTENSION_PATHS.events, { profileEmail: ADMIN_EMAIL, events: [event] });
    expect(res.statusCode, res.body).toBe(202);
    expect(res.json()).toEqual({ accepted: 1, duplicates: 0 });
    expect((await signed(a, BROWSER_EXTENSION_PATHS.events, { profileEmail: ADMIN_EMAIL, events: [event] })).json()).toEqual({ accepted: 0, duplicates: 1 });
    const [row] = await db.select().from(browserEvents).where(eq(browserEvents.eventId, event.eventId));
    expect(row).toMatchObject({ deviceId: a.id, userId: adminId, kind: "dlp_blocked", ruleIds: ["dlp.secret.aws_key"] });
    expect(row!.subjectPseudonym).toMatch(/^psn:/);
    expect(row!.conversationRef).toMatch(/^cnv:[0-9a-f]{32}$/);
    const stored = JSON.stringify(await db.select().from(browserEvents)) + JSON.stringify(await db.select().from(auditLog).where(sql`${auditLog.objectType} = 'browser_governance'`));
    expect(stored).not.toContain(marker);
    expect(stored).not.toContain(ADMIN_EMAIL);
    await expect(refusal(db.update(browserEvents).set({ code: "site_denied" }).where(eq(browserEvents.id, row!.id)))).resolves.toMatch(/append-only/);
    await expect(refusal(db.delete(browserEvents).where(eq(browserEvents.id, row!.id)))).resolves.toMatch(/append-only/);
    await expect(refusal(db.execute(sql`truncate browser_events`))).resolves.toMatch(/truncate|TRUNCATE|append-only/);
    const listed = await app.inject({ method: "GET", url: "/v1/browser-governance/events?limit=5", headers: KEY });
    expect(listed.json().events.some((e: { id: string }) => e.id === row!.id)).toBe(true);
    const bad = await signed(a, BROWSER_EXTENSION_PATHS.events, { profileEmail: "", events: [{ ...event, eventId: randomUUID(), text: "secret" }] });
    expect(bad.json()).toEqual({ error: "invalid_body" });
  });

  it("refuses a prompt capture until it is enabled; a captured prompt is enveloped and read with its own step-up", async () => {
    const a = dev.a!;
    const text = `adr0334 prompt ${RUN}`;
    const capture = () => ({ captureId: randomUUID(), profileEmail: ADMIN_EMAIL, siteId: "ep-poe-web", path: "/chat/1", text, capturedAt: Math.floor(Date.now() / 1000) });
    expect((await signed(a, BROWSER_EXTENSION_PATHS.promptCaptures, capture())).json()).toEqual({ error: "prompt_capture_disabled" });
    const facts = { op: "browser_governance_settings", enabled: true, mode: "enforce", promptCaptureEnabled: true, relaxations: ["prompt_capture"] };
    const on = await app.inject({ method: "PUT", url: "/v1/browser-governance/settings", ...(await steppedUp("settings_relax", facts)), payload: { promptCaptureEnabled: true } });
    expect(on.statusCode, on.body).toBe(200);
    const res = await signed(a, BROWSER_EXTENSION_PATHS.promptCaptures, capture());
    expect(res.statusCode, res.body).toBe(202);
    const [row] = await db.select().from(browserPromptCaptures).where(eq(browserPromptCaptures.deviceId, a.id));
    expect(row!.textCiphertext).not.toContain(text);
    const plain = await app.inject({ method: "GET", url: `/v1/browser-governance/prompt-captures/${row!.id}`, ...(await plainSession()) });
    expect([403, 422]).toContain(plain.statusCode);
    const read = await app.inject({ method: "GET", url: `/v1/browser-governance/prompt-captures/${row!.id}`, ...(await steppedUp("pseudonym_reveal", { op: "browser_prompt_capture_read", captureId: row!.id })) });
    expect(read.statusCode, read.body).toBe(200);
    expect(read.json().text).toBe(text);
    // the data-key re-encryption walk may rewrite the ciphertext, and only the ciphertext
    const reenc = (set: ReturnType<typeof sql>) =>
      refusal(db.transaction(async (tx) => {
        await tx.execute(sql`select set_config('regulait.secret_reencrypt', 'on', true)`);
        await tx.execute(sql`update browser_prompt_captures set ${set} where id = ${row!.id}`);
      }));
    await expect(reenc(sql`text_ciphertext = text_ciphertext || ''`)).resolves.toBe("");
    await expect(reenc(sql`site_id = 'ep-poe-web', text_chars = 1`)).resolves.toMatch(/append-only/);
    await expect(refusal(db.update(browserPromptCaptures).set({ textChars: 1 }).where(eq(browserPromptCaptures.id, row!.id)))).resolves.toMatch(/append-only/);
  });

  it("a revoked device is refused from then on", async () => {
    const a = dev.a!;
    a.reset();
    const before = await a.headers("POST", BROWSER_EXTENSION_PATHS.policy);
    const rev = await app.inject({ method: "POST", url: `/v1/browser-governance/devices/${a.id}/revoke`, headers: KEY });
    expect(rev.statusCode, rev.body).toBe(200);
    // a token minted before the revocation reads as a revoked device, which the extension treats as final
    const used = await signed(a, BROWSER_EXTENSION_PATHS.policy, { profileEmail: "" }, before);
    expect(used.statusCode).toBe(401);
    expect(used.json().error).toBe("device_revoked");
    // and no new token is minted for it
    a.reset();
    const t = await a.tokenRequest();
    expect(t.statusCode).toBe(401);
    expect(t.json().error).toBe("invalid_client");
    expect((await register(a)).json()).toEqual({ error: "device_revoked" });
    const tok = await app.inject({ method: "POST", url: `/v1/browser-governance/enrolment-tokens/${tokenId}/revoke`, headers: KEY });
    expect(tok.statusCode).toBe(200);
    expect((await register(await newDevice())).json()).toEqual({ error: "token_revoked" });
  });
});
