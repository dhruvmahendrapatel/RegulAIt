/**
 * ADR-0175 A7 — the non-human credential inventory, end to end.
 *
 * Pinned:
 *  - one stored credential of EVERY type appears, with its owner/creator,
 *    scope, dates, signals and flags;
 *  - the response carries no secret material: no plaintext, ciphertext, hash
 *    or fragment of one, no secret-named field, and nothing secret-shaped;
 *  - each flag fires on the credential that earns it and not elsewhere;
 *  - migration 0142's trigger stamps a rewritten secret, and leaves the stamp
 *    alone for a data-key re-encryption;
 *  - `stale_credentials` raises one medium episode per flagged credential
 *    only while the org turned alerting on, and resolves them when it is off;
 *  - the route is admin-only.
 *
 * Shared database (M-008, M-068): every row this file inserts is deleted in
 * afterAll, the org settings it touches are restored, and a last monitor pass
 * resolves anything it raised.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  and,
  apiKeys,
  chatopsConnections,
  connectorCredentials,
  connectors,
  createDb,
  customModelProviders,
  deployTargets,
  eq,
  externalScorers,
  gitConnections,
  governanceAlerts,
  inArray,
  modelCredentials,
  oidcProviders,
  orgSettings,
  pmConnections,
  runMigrations,
  samlProviders,
  scimTokens,
  sql,
  trainingBackendConfigs,
  userModelCredentials,
  users,
  virtualKeys,
  type Db,
} from "@regulait/db";
import { CREDENTIAL_TYPE_IDS } from "@regulait/shared";
import { buildApp } from "./app.js";
import { encryptSecret } from "./secrets.js";
import { hashToken } from "./token-hash.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `g175c-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const KEY = "a".repeat(64);
const DAY = 86_400_000;

let db: Db;
let app: ReturnType<typeof buildApp>;
const people = { admin: "", own: "", gone: "", adminAuth: { authorization: "" }, ownAuth: { authorization: "" } };
/** every secret-derived string this file stored: plaintexts, ciphertexts, hashes */
const secretsSeen: string[] = [];
const ids: Record<string, string> = {};
let trainingInserted = false;
let orgBefore: { ciphertext: string | null; setAt: Date | null; alerts: boolean; unusedDays: number } | null = null;

const call = (method: "GET" | "POST" | "PUT", url: string, headers: Record<string, string>, payload?: unknown) =>
  app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });
const synthetic = (label: string) => {
  const s = `synthetic-${label}-${randomBytes(18).toString("hex")}`;
  secretsSeen.push(s);
  return s;
};
const cipher = (label: string) => {
  const c = encryptSecret(KEY, synthetic(label));
  secretsSeen.push(c);
  return c;
};
const hash = (label: string) => {
  const h = hashToken(synthetic(label));
  secretsSeen.push(h);
  return h;
};
const inventory = async (query = "") => {
  const r = await call("GET", `/v1/admin/credentials${query}`, people.adminAuth);
  expect(r.statusCode, r.body).toBe(200);
  return r;
};
const mine = (body: { credentials: Array<{ id: string }> }) => {
  const own = new Set(Object.values(ids));
  return body.credentials.filter((c) => own.has(c.id.slice(c.id.indexOf(":") + 1)));
};
const row = (body: { credentials: Array<{ id: string }> }, id: string) => body.credentials.find((c) => c.id === id) as any;

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: KEY });
  const mkUser = async (tag: string, isAdmin: boolean) => {
    const r = await call("POST", "/v1/users", AUTH, { email: `g175c-${tag}-${RUN}@example.com`, displayName: `Cred ${tag} ${RUN}`, isAdmin });
    expect(r.statusCode, r.body).toBe(201);
    return r.json().id as string;
  };
  people.admin = await mkUser("admin", true);
  people.own = await mkUser("own", false);
  people.gone = await mkUser("gone", false);
  const key = async (userId: string, name: string) => {
    const r = await call("POST", `/v1/users/${userId}/keys`, AUTH, { name });
    expect(r.statusCode, r.body).toBe(201);
    secretsSeen.push(r.json().token);
    return { id: r.json().id as string, token: r.json().token as string };
  };
  const adminKey = await key(people.admin, `g175c-admin-${RUN}`);
  people.adminAuth = { authorization: `Bearer ${adminKey.token}` };
  ids.adminKey = adminKey.id;
  const ownKey = await key(people.own, `g175c-own-${RUN}`);
  people.ownAuth = { authorization: `Bearer ${ownKey.token}` };
  ids.ownKey = ownKey.id;
  ids.goneKey = (await key(people.gone, `g175c-gone-${RUN}`)).id;
  ids.expiredKey = (await key(people.own, `g175c-expired-${RUN}`)).id;
  ids.oldKey = (await key(people.own, `g175c-old-${RUN}`)).id;
  // the stored token hashes are secret material too
  for (const k of await db.select({ h: apiKeys.tokenHash }).from(apiKeys).where(inArray(apiKeys.id, [ids.adminKey, ids.ownKey, ids.goneKey, ids.expiredKey, ids.oldKey]))) {
    secretsSeen.push(k.h);
  }
  await db.update(apiKeys).set({ expiresAt: new Date(Date.now() + 30 * DAY) }).where(inArray(apiKeys.id, [ids.adminKey, ids.ownKey, ids.goneKey]));
  await db.update(apiKeys).set({ expiresAt: new Date(Date.now() - 2 * DAY) }).where(eq(apiKeys.id, ids.expiredKey));
  await db.update(apiKeys).set({ createdAt: new Date(Date.now() - 200 * DAY), expiresAt: new Date(Date.now() + 30 * DAY) }).where(eq(apiKeys.id, ids.oldKey));
  await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, people.gone));

  const [vk] = await db
    .insert(virtualKeys)
    .values({ name: `g175c-vk-${RUN}`, userId: people.own, tokenHash: hash("vk"), createdBy: people.admin })
    .returning({ id: virtualKeys.id });
  ids.vk = vk!.id;
  const [scim] = await db.insert(scimTokens).values({ name: `g175c-scim-${RUN}`, tokenHash: hash("scim") }).returning({ id: scimTokens.id });
  ids.scim = scim!.id;
  const [mc] = await db.insert(modelCredentials).values({ provider: `g175c-prov-${RUN}`, keyCiphertext: cipher("model") }).returning({ id: modelCredentials.id });
  ids.modelCred = mc!.id;
  const [umc] = await db
    .insert(userModelCredentials)
    .values({ userId: people.own, provider: `g175c-prov-${RUN}`, keyCiphertext: cipher("user-model") })
    .returning({ id: userModelCredentials.id });
  ids.userModelCred = umc!.id;
  const [cp] = await db
    .insert(customModelProviders)
    .values({ name: `g175c-custom-${RUN}`, wireProtocol: "openai_chat", baseUrl: "https://g175c.example.invalid/v1", keyCiphertext: cipher("custom"), createdBy: people.gone })
    .returning({ id: customModelProviders.id });
  ids.custom = cp!.id;
  const [sc] = await db
    .insert(externalScorers)
    .values({ name: `g175c-scorer-${RUN}`, baseUrl: "https://g175c.example.invalid/score", keyCiphertext: cipher("scorer"), createdBy: people.admin })
    .returning({ id: externalScorers.id });
  ids.scorer = sc!.id;
  const [conn] = await db.insert(connectors).values({ name: `g175c-connector-${RUN}`, kind: "mock" }).returning({ id: connectors.id });
  ids.connector = conn!.id;
  const [cc] = await db.insert(connectorCredentials).values({ connectorId: conn!.id, tokenCiphertext: cipher("connector") }).returning({ id: connectorCredentials.id });
  ids.connectorCred = cc!.id;
  const [git] = await db.insert(gitConnections).values({ name: `g175c-git-${RUN}`, provider: "mock", tokenCiphertext: cipher("git") }).returning({ id: gitConnections.id });
  ids.git = git!.id;
  const [pm] = await db
    .insert(pmConnections)
    .values({ name: `g175c-pm-${RUN}`, provider: "mock", project: "G175C", tokenCiphertext: cipher("pm"), webhookSecretHash: hash("pm-webhook"), webhookSecretCiphertext: cipher("pm-webhook") })
    .returning({ id: pmConnections.id });
  ids.pm = pm!.id;
  const [dt] = await db
    .insert(deployTargets)
    .values({ name: `g175c-deploy-${RUN}`, provider: "mock", environment: "staging", credentialCiphertext: cipher("deploy"), roleArn: "arn:aws:iam::000000000000:role/g175c" })
    .returning({ id: deployTargets.id });
  ids.deploy = dt!.id;
  const [chat] = await db
    .insert(chatopsConnections)
    .values({ name: `g175c-chat-${RUN}`, provider: "slack", connectorId: conn!.id, signingSecretCiphertext: cipher("chat"), defaultChannel: "#g175c", createdByUserId: people.admin })
    .returning({ id: chatopsConnections.id });
  ids.chat = chat!.id;
  const [oidc] = await db
    .insert(oidcProviders)
    .values({ name: `g175c-oidc-${RUN}`, issuerUrl: "https://g175c.example.invalid", clientId: "g175c-client", clientSecretCiphertext: cipher("oidc"), enabled: false })
    .returning({ id: oidcProviders.id });
  ids.oidc = oidc!.id;
  const [saml] = await db
    .insert(samlProviders)
    .values({ name: `g175c-saml-${RUN}`, entityId: `https://g175c.example.invalid/${RUN}`, idpSsoUrl: "https://g175c.example.invalid/sso", idpSigningCerts: [], spPrivateKeyCiphertext: cipher("saml"), enabled: false })
    .returning({ id: samlProviders.id });
  ids.saml = saml!.id;
  const [existingTraining] = await db.select({ id: trainingBackendConfigs.id }).from(trainingBackendConfigs).where(eq(trainingBackendConfigs.backend, "vertex"));
  if (!existingTraining) {
    const [t] = await db
      .insert(trainingBackendConfigs)
      .values({ backend: "vertex", keyCiphertext: cipher("training"), createdByUserId: people.admin })
      .returning({ id: trainingBackendConfigs.id });
    ids.training = t!.id;
    trainingInserted = true;
  }
  const [org] = await db
    .select({
      id: orgSettings.id,
      ciphertext: orgSettings.tracingOtlpHeadersCiphertext,
      setAt: orgSettings.tracingOtlpHeadersSetAt,
      alerts: orgSettings.staleCredentialAlerts,
      unusedDays: orgSettings.credentialUnusedDays,
    })
    .from(orgSettings);
  orgBefore = { ciphertext: org!.ciphertext, setAt: org!.setAt, alerts: org!.alerts, unusedDays: org!.unusedDays };
  if (org!.ciphertext) secretsSeen.push(org!.ciphertext);
  await db.update(orgSettings).set({ tracingOtlpHeadersCiphertext: cipher("otlp") });
  ids.org = org!.id;
}, 120_000);

afterAll(async () => {
  if (orgBefore) {
    await db.update(orgSettings).set({
      tracingOtlpHeadersCiphertext: orgBefore.ciphertext,
      staleCredentialAlerts: orgBefore.alerts,
      credentialUnusedDays: orgBefore.unusedDays,
    });
    // the restore itself is a rewrite; put the recorded date back as it was
    await db.update(orgSettings).set({ tracingOtlpHeadersSetAt: orgBefore.setAt });
  }
  if (trainingInserted) await db.delete(trainingBackendConfigs).where(eq(trainingBackendConfigs.id, ids.training!));
  await db.delete(chatopsConnections).where(eq(chatopsConnections.id, ids.chat!));
  await db.delete(connectorCredentials).where(eq(connectorCredentials.id, ids.connectorCred!));
  await db.delete(connectors).where(eq(connectors.id, ids.connector!));
  await db.delete(virtualKeys).where(eq(virtualKeys.id, ids.vk!));
  await db.delete(scimTokens).where(eq(scimTokens.id, ids.scim!));
  await db.delete(userModelCredentials).where(eq(userModelCredentials.id, ids.userModelCred!));
  await db.delete(modelCredentials).where(eq(modelCredentials.id, ids.modelCred!));
  await db.delete(customModelProviders).where(eq(customModelProviders.id, ids.custom!));
  await db.delete(externalScorers).where(eq(externalScorers.id, ids.scorer!));
  await db.delete(gitConnections).where(eq(gitConnections.id, ids.git!));
  await db.delete(pmConnections).where(eq(pmConnections.id, ids.pm!));
  await db.delete(deployTargets).where(eq(deployTargets.id, ids.deploy!));
  await db.delete(oidcProviders).where(eq(oidcProviders.id, ids.oidc!));
  await db.delete(samlProviders).where(eq(samlProviders.id, ids.saml!));
  // revoke every key this file issued, so no flag outlives it
  await db.update(apiKeys).set({ revokedAt: new Date() }).where(inArray(apiKeys.userId, [people.admin, people.own, people.gone]));
  await call("POST", "/v1/governance/monitor/evaluate", AUTH);
  app.server.closeAllConnections();
  await app.close();
});

describe("ADR-0175 A7 — the credential inventory", () => {
  it("lists one credential of every stored type, with its signals", async () => {
    const body = (await inventory()).json();
    const types = new Set(mine(body).map((c: any) => c.type));
    const expected = CREDENTIAL_TYPE_IDS.filter((t) => t !== "training_backend_key" || trainingInserted);
    for (const t of expected) expect(types.has(t), `missing ${t}`).toBe(true);
    // the types that record no use say so
    expect(body.types.filter((t: any) => t.lastUsed === "none").map((t: any) => t.type).sort()).toEqual(
      [
        "deploy_credential",
        "deploy_role",
        "external_scorer_key",
        "git_token",
        "model_credential",
        "oidc_client_secret",
        "otlp_headers",
        "pm_token",
        "pm_webhook_secret",
        "saml_sp_key",
        "training_backend_key",
        "user_model_credential",
      ].sort(),
    );
    expect(body.notStored.map((n: any) => n.what)).toContain("MCP server upstream auth");
    const vk = row(body, `virtual_key:${ids.vk}`);
    expect(vk).toMatchObject({ ownerUserId: people.own, ownerKind: "owner", lastUsedSignal: "recorded", manageAt: "/admin/virtual-keys", status: "active" });
    const custom = row(body, `custom_provider_key:${ids.custom}`);
    expect(custom).toMatchObject({ ownerUserId: people.gone, ownerKind: "creator", lastUsedSignal: "ledger", expirySignal: "not_tracked" });
    expect(row(body, `oidc_client_secret:${ids.oidc}`)).toMatchObject({ status: "disabled", rotationSignal: "recorded" });
    expect(row(body, `model_credential:${ids.modelCred}`).scope).toMatch(/platform key/);
  });

  it("returns no secret material: no plaintext, ciphertext, hash or fragment, no secret field, nothing secret-shaped", async () => {
    const text = (await inventory("?includeRevoked=true")).body;
    expect(secretsSeen.length).toBeGreaterThan(30);
    for (const s of secretsSeen) {
      for (const at of [0, Math.floor(s.length / 2) - 6, s.length - 12]) {
        const frag = s.slice(at, at + 12);
        expect(text.includes(frag), `fragment of stored secret material at ${at}`).toBe(false);
      }
    }
    const keys = new Set<string>();
    const walk = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) (keys.add(k), walk(x));
    };
    walk(JSON.parse(text));
    expect([...keys].filter((k) => /ciphertext|hash|^token$|^secret$|apikey|password|privatekey|prefix/i.test(k))).toEqual([]);
    // anything long, opaque and unbroken (hex digests, tokens, envelope parts),
    // outside the human-chosen labels (a credential's name is whatever its
    // creator typed, and other suites' rows share this database)
    const labels = JSON.stringify(JSON.parse(text), (k, v) => (k === "name" || k === "ownerName" ? "" : v));
    expect(labels.match(/[A-Za-z0-9+/=_]{24,}/g) ?? []).toEqual([]);
  });

  it("flags each credential that earns a flag, and only those", async () => {
    const body = (await inventory()).json();
    const flagsOf = (id: string) => row(body, id)?.flags;
    expect(flagsOf(`api_key:${ids.ownKey}`)).toEqual([]);
    expect(flagsOf(`api_key:${ids.adminKey}`)).toEqual(["over_scoped"]);
    expect(flagsOf(`api_key:${ids.goneKey}`)).toEqual(["owner_deactivated"]);
    expect(flagsOf(`api_key:${ids.expiredKey}`)).toEqual(["past_expiry"]);
    expect(flagsOf(`api_key:${ids.oldKey}`)).toEqual(["unused"]);
    expect(flagsOf(`virtual_key:${ids.vk}`)).toEqual(["never_expires", "over_scoped"]);
    expect(flagsOf(`scim_token:${ids.scim}`)).toEqual(["never_expires"]);
    expect(flagsOf(`custom_provider_key:${ids.custom}`)).toEqual(["owner_deactivated"]);
    // a held third-party secret: expiry not tracked, no use signal → no flag
    expect(flagsOf(`git_token:${ids.git}`)).toEqual([]);
    expect(row(body, `api_key:${ids.oldKey}`).flagReasons.unused).toMatch(/never used/);
    // filters
    const byFlag = (await inventory("?flag=owner_deactivated")).json();
    expect(mine(byFlag).map((c: any) => c.id).sort()).toEqual([`api_key:${ids.goneKey}`, `custom_provider_key:${ids.custom}`].sort());
    const byType = (await inventory("?type=scim_token")).json();
    expect(byType.credentials.every((c: any) => c.type === "scim_token")).toBe(true);
    // the org threshold is honoured: at 365 days the 200-day-old key is not unused
    await db.update(orgSettings).set({ credentialUnusedDays: 365 });
    expect(row((await inventory()).json(), `api_key:${ids.oldKey}`).flags).toEqual([]);
    await db.update(orgSettings).set({ credentialUnusedDays: orgBefore!.unusedDays });
  });

  it("is admin-only", async () => {
    const r = await call("GET", "/v1/admin/credentials", people.ownAuth);
    expect(r.statusCode).toBe(403);
  });
});

describe("ADR-0175 A7 — when a secret was last set (migration 0142)", () => {
  it("stamps a rewritten secret, and leaves the stamp alone under a data-key re-encryption", async () => {
    const stamp = async () =>
      (await db.select({ at: scimTokens.secretSetAt, created: scimTokens.createdAt }).from(scimTokens).where(eq(scimTokens.id, ids.scim!)))[0]!;
    const first = await stamp();
    expect(first.at).not.toBeNull();
    // an old set date, so a bump is visible (writing the stamp alone does not fire it)
    await db.update(scimTokens).set({ secretSetAt: new Date(Date.now() - 50 * DAY) }).where(eq(scimTokens.id, ids.scim!));
    // a re-encryption-style rewrite (the walk sets the transaction flag)
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('regulait.secret_reencrypt', 'on', true)`);
      await tx.update(scimTokens).set({ tokenHash: hash("scim-reencrypted") }).where(eq(scimTokens.id, ids.scim!));
    });
    const kept = await stamp();
    expect(Date.now() - kept.at!.getTime()).toBeGreaterThan(49 * DAY);
    // an ordinary rotation: the stamp moves to now
    await db.update(scimTokens).set({ tokenHash: hash("scim-rotated") }).where(eq(scimTokens.id, ids.scim!));
    const rotated = await stamp();
    expect(Date.now() - rotated.at!.getTime()).toBeLessThan(60_000);
    // a write that does not touch the secret does not move it
    await db.update(scimTokens).set({ lastUsedAt: new Date() }).where(eq(scimTokens.id, ids.scim!));
    expect((await stamp()).at!.getTime()).toBe(rotated.at!.getTime());
    const body = (await inventory()).json();
    expect(row(body, `scim_token:${ids.scim}`)).toMatchObject({ rotationSignal: "recorded", ageSinceRotationDays: 0 });
  });
});

describe("ADR-0175 A7 — the stale_credentials monitor rule", () => {
  const episodes = async () =>
    db
      .select()
      .from(governanceAlerts)
      .where(and(eq(governanceAlerts.ruleId, "stale_credentials"), sql`${governanceAlerts.subjectKey} LIKE ${"credential:%"}`));
  const evaluate = async () => {
    const r = await call("POST", "/v1/governance/monitor/evaluate", people.adminAuth);
    expect(r.statusCode, r.body).toBe(200);
  };
  const subject = (id: string) => `credential:${id}`;

  it("is observe-only by default: flags on the page, no episode", async () => {
    expect(orgBefore!.alerts).toBe(false);
    await evaluate();
    const open = (await episodes()).filter((a) => a.status !== "resolved" && a.subjectKey.includes(ids.vk!));
    expect(open).toEqual([]);
    expect((await inventory()).json().alerting).toBe(false);
  });

  it("with alerting on, raises one medium episode per flagged credential, and resolves them when it is turned off", async () => {
    const on = await call("PUT", "/v1/org/settings", people.adminAuth, { staleCredentialAlerts: true });
    expect(on.statusCode, on.body).toBe(200);
    await evaluate();
    await evaluate(); // a second pass refreshes, never duplicates
    const open = (await episodes()).filter((a) => a.status !== "resolved");
    const flagged = [`api_key:${ids.adminKey}`, `api_key:${ids.goneKey}`, `api_key:${ids.expiredKey}`, `api_key:${ids.oldKey}`, `virtual_key:${ids.vk}`, `custom_provider_key:${ids.custom}`];
    for (const id of flagged) {
      const mineOpen = open.filter((a) => a.subjectKey === subject(id));
      expect(mineOpen, id).toHaveLength(1);
      expect(mineOpen[0]!.severity).toBe("medium");
    }
    expect(open.filter((a) => a.subjectKey === subject(`api_key:${ids.ownKey}`))).toEqual([]);
    expect(open.filter((a) => a.subjectKey === subject(`git_token:${ids.git}`))).toEqual([]);
    const vkAlert = open.find((a) => a.subjectKey === subject(`virtual_key:${ids.vk}`))!;
    expect(vkAlert.title).toBe(`Virtual key 'g175c-vk-${RUN}': never expires, over scoped`);
    const plan = await call("GET", `/v1/governance/alerts/${vkAlert.id}/remediation`, people.adminAuth);
    expect(plan.statusCode, plan.body).toBe(200);
    expect(plan.json().candidates[0]).toMatchObject({ kind: "review_credential", executable: false, href: "/admin/virtual-keys" });

    const off = await call("PUT", "/v1/org/settings", people.adminAuth, { staleCredentialAlerts: false });
    expect(off.statusCode, off.body).toBe(200);
    await evaluate();
    const still = (await episodes()).filter((a) => a.status !== "resolved" && flagged.some((id) => a.subjectKey === subject(id)));
    expect(still).toEqual([]);
    // every flagged credential in this shared database was raised and resolved, so allow for the volume
  }, 180_000);
});
