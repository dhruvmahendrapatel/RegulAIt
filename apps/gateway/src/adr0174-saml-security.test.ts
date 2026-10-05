/**
 * ADR-0174 security review — the SAML half.
 *
 *  - finding 1: a SAML login is never a session without MFA when the org
 *    requires it. The VERIFIED assertion's AuthnContextClassRef must name a
 *    context configured as multi-factor for the IdP (`mfaAuthnContexts`), or
 *    an account with TOTP steps up to it before any session exists; an account
 *    without TOTP gets its session and the MFA gate sends it to enrolment, as
 *    before. A context smuggled outside the signed assertion counts for
 *    nothing.
 *  - finding 6: links are keyed on (entity id, NameID Format, NameID); a
 *    transient NameID is never an anchor (the verified email anchors instead).
 *
 * Every assertion is signed by a real in-test IdP key (the saml.test.ts
 * pattern): minted per run, never committed. Shared-database hygiene: every
 * provider created here is deleted and the org_settings singleton restored.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { SignedXml } from "xml-crypto";
import {
  auditLog,
  authSessions,
  createDb,
  desc,
  eq,
  federatedIdentities,
  inArray,
  ORG_SETTINGS_ID,
  orgSettings,
  samlLoginStates,
  samlProviders,
  type Db,
  type OrgSettingsRow,
} from "@regulait/db";
import { buildApp } from "./app.js";
import { hashToken, totpCode, totpStep } from "./auth.js";
import { installLicenseFixture, removeLicenseFixture } from "./testing/license-fixture.js";
import { spEntityId } from "./saml.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const BOOT = "adr0174-saml-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const CSRF = { "x-regulait-csrf": "1" };
const DATA_KEY = "d".repeat(64);
const FORM = { "content-type": "application/x-www-form-urlencoded" };
const IDP_ENTITY = "https://idp.adr0174-saml.example/metadata";
const BASE = "http://localhost:80";
const SP_ENTITY = spEntityId(BASE, {} as NodeJS.ProcessEnv);
const PPT = "urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport";
const MFA_CTX = "https://refeds.org/profile/mfa";
const EMAIL_FMT = "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress";
const TRANSIENT = "urn:oasis:names:tc:SAML:2.0:nameid-format:transient";
const PERSISTENT = "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent";
const UNSPECIFIED = "urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified";

let db: Db;
let app: ReturnType<typeof buildApp>;
let key: { privateKey: string; certPem: string };
const tag = randomBytes(3).toString("hex");
const createdProviderIds = new Set<string>();
let orgSnapshot: OrgSettingsRow | null = null;

function makeSigningKey(cn: string) {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const keyPem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  const dir = mkdtempSync(path.join(tmpdir(), "regulait-saml-test-only-"));
  try {
    const keyFile = path.join(dir, "test-only-idp-key.pem");
    const certFile = path.join(dir, "test-only-idp-cert.pem");
    writeFileSync(keyFile, keyPem, { mode: 0o600 });
    execFileSync("openssl", ["req", "-x509", "-new", "-sha256", "-days", "1", "-key", keyFile, "-out", certFile, "-subj", `/CN=${cn}`]);
    return { privateKey: keyPem, certPem: readFileSync(certFile, "utf8").trim() };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const acsFor = (providerId: string) => `${BASE}/auth/saml/${providerId}/acs`;

interface Shape {
  providerId: string;
  inResponseTo: string;
  email: string;
  nameId?: string;
  nameIdFormat?: string;
  authnContext?: string;
  /** XML appended to the Response OUTSIDE the signed Assertion */
  outside?: string;
}
function buildResponse(o: Shape): string {
  const assertionId = "_a" + randomBytes(12).toString("hex");
  const acs = acsFor(o.providerId);
  const inResp = ` InResponseTo="${esc(o.inResponseTo)}"`;
  const format = o.nameIdFormat ?? EMAIL_FMT;
  const nameId = o.nameId ?? o.email;
  return (
    `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ` +
    `ID="_r${randomBytes(12).toString("hex")}" Version="2.0" IssueInstant="${iso(0)}" Destination="${esc(acs)}"${inResp}>` +
    `<saml:Issuer>${esc(IDP_ENTITY)}</saml:Issuer>` +
    `<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>` +
    `<saml:Assertion ID="${assertionId}" Version="2.0" IssueInstant="${iso(0)}">` +
    `<saml:Issuer>${esc(IDP_ENTITY)}</saml:Issuer>` +
    `<saml:Subject><saml:NameID Format="${esc(format)}">${esc(nameId)}</saml:NameID>` +
    `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">` +
    `<saml:SubjectConfirmationData NotOnOrAfter="${iso(300_000)}" Recipient="${esc(acs)}"${inResp}/>` +
    `</saml:SubjectConfirmation></saml:Subject>` +
    `<saml:Conditions NotBefore="${iso(-60_000)}" NotOnOrAfter="${iso(300_000)}">` +
    `<saml:AudienceRestriction><saml:Audience>${esc(SP_ENTITY)}</saml:Audience></saml:AudienceRestriction></saml:Conditions>` +
    `<saml:AuthnStatement AuthnInstant="${iso(0)}" SessionIndex="_s${randomBytes(6).toString("hex")}">` +
    `<saml:AuthnContext><saml:AuthnContextClassRef>${esc(o.authnContext ?? PPT)}</saml:AuthnContextClassRef></saml:AuthnContext>` +
    `</saml:AuthnStatement>` +
    `<saml:AttributeStatement><saml:Attribute Name="email"><saml:AttributeValue>${esc(o.email)}</saml:AttributeValue></saml:Attribute></saml:AttributeStatement>` +
    `</saml:Assertion>${o.outside ?? ""}</samlp:Response>`
  );
}
function signAssertion(xml: string): string {
  const sig = new SignedXml({
    privateKey: key.privateKey,
    publicCert: key.certPem,
    signatureAlgorithm: "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
    canonicalizationAlgorithm: "http://www.w3.org/2001/10/xml-exc-c14n#",
  });
  sig.addReference({
    xpath: "//*[local-name(.)='Assertion']",
    transforms: ["http://www.w3.org/2000/09/xmldsig#enveloped-signature", "http://www.w3.org/2001/10/xml-exc-c14n#"],
    digestAlgorithm: "http://www.w3.org/2001/04/xmlenc#sha256",
  });
  sig.computeSignature(xml, { location: { reference: "//*[local-name(.)='Assertion']/*[local-name(.)='Issuer']", action: "after" } });
  return sig.getSignedXml();
}

const mkProvider = async (payload: Record<string, unknown> = {}) => {
  const r = await app.inject({
    method: "POST", headers: AUTH, url: "/v1/auth/saml-providers",
    payload: { name: `a174-saml-${randomBytes(4).toString("hex")}`, entityId: IDP_ENTITY, idpSsoUrl: "https://idp.adr0174-saml.example/sso", idpSigningCerts: [key.certPem], ...payload },
  });
  expect(r.statusCode, r.body).toBe(201);
  createdProviderIds.add(r.json().id);
  return r.json() as { id: string; mfaAuthnContexts: string[] | null };
};
const mkUser = async (address: string): Promise<string> => {
  const r = await app.inject({ method: "POST", headers: AUTH, url: "/v1/users", payload: { email: address, displayName: address.split("@")[0], isAdmin: false } });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().id;
};
const cookieOf = (res: { cookies: Array<{ name: string; value: string }> }, name = "regulait_session") =>
  res.cookies.find((c) => c.name === name)?.value ?? null;
const putSettings = (payload: Record<string, unknown>) => app.inject({ method: "PUT", url: "/v1/org/settings", headers: AUTH, payload });
const latestAudit = async (ruleId: string) => {
  const [row] = await db.select().from(auditLog).where(eq(auditLog.ruleId, ruleId)).orderBy(desc(auditLog.at)).limit(1);
  return row ?? null;
};

const roundTrip = async (providerId: string, o: Omit<Shape, "providerId" | "inResponseTo">) => {
  const s = await app.inject({ method: "GET", url: `/auth/saml/${providerId}/start?returnTo=/app` });
  expect(s.statusCode).toBe(302);
  const relayState = new URL(s.headers.location as string).searchParams.get("RelayState")!;
  const [row] = await db.select().from(samlLoginStates).where(eq(samlLoginStates.relayState, relayState));
  let signed = signAssertion(buildResponse({ providerId, inResponseTo: row!.requestId, ...o, outside: undefined }));
  if (o.outside) signed = signed.replace("</samlp:Response>", `${o.outside}</samlp:Response>`);
  return app.inject({
    method: "POST", url: `/auth/saml/${providerId}/acs`, headers: FORM,
    payload: `SAMLResponse=${encodeURIComponent(Buffer.from(signed, "utf8").toString("base64"))}&RelayState=${encodeURIComponent(relayState)}`,
  });
};

/** a user with a real password and an ACTIVE TOTP, plus a link to the provider
 * (as if an admin had approved it), so the SAML login resolves straight to it */
const userWithTotp = async (address: string, providerId: string) => {
  const uid = await mkUser(address);
  const init = await app.inject({ method: "POST", headers: AUTH, url: `/v1/users/${uid}/set-initial-password`, payload: {} });
  const first = await app.inject({ method: "POST", url: "/auth/login", headers: CSRF, payload: { email: address, password: init.json().password } });
  const cookie = cookieOf(first)!;
  const real = `Syn-${randomBytes(12).toString("base64url")}-9a`;
  expect((await app.inject({ method: "POST", url: "/auth/change-password", headers: CSRF, cookies: { regulait_session: cookie }, payload: { currentPassword: init.json().password, newPassword: real } })).statusCode).toBe(200);
  const login2 = await app.inject({ method: "POST", url: "/auth/login", headers: CSRF, payload: { email: address, password: real } });
  const c2 = cookieOf(login2)!;
  const enroll = await app.inject({ method: "POST", url: "/auth/totp/enroll", headers: CSRF, cookies: { regulait_session: c2 } });
  const secret = enroll.json().secret as string;
  expect((await app.inject({ method: "POST", url: "/auth/totp/activate", headers: CSRF, cookies: { regulait_session: c2 }, payload: { code: totpCode(secret, totpStep() - 1) } })).statusCode).toBe(200);
  await db.insert(federatedIdentities).values({ userId: uid, samlProviderId: providerId, issuer: IDP_ENTITY, subjectFormat: EMAIL_FMT, subject: address, linkedVia: "admin" });
  return { uid, secret };
};

beforeAll(async () => {
  const { runMigrations } = await import("@regulait/db");
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
  await installLicenseFixture(app, { features: ["sso_saml"], auth: AUTH });
  key = makeSigningKey("regulait-adr0174-test-idp");
  const [settings] = await db.select().from(orgSettings).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  orgSnapshot = settings ?? null;
}, 120_000);

afterAll(async () => {
  try {
    if (createdProviderIds.size > 0) await db.delete(samlProviders).where(inArray(samlProviders.id, [...createdProviderIds]));
    if (orgSnapshot) await db.update(orgSettings).set(orgSnapshot).where(eq(orgSettings.id, ORG_SETTINGS_ID));
    await removeLicenseFixture(db);
  } finally {
    await app?.close();
  }
});

// ===========================================================================
describe("finding 1: SAML sessions answer to the org MFA requirement", () => {
  it("an assertion without a multi-factor context does NOT mint a session for a TOTP account — it steps up to the code first", async () => {
    const p = await mkProvider();
    const address = `stepup-${tag}@adr0174-saml.example`;
    const { uid, secret } = await userWithTotp(address, p.id);
    expect((await putSettings({ mfaRequired: "all" })).statusCode).toBe(200);
    try {
      const acs = await roundTrip(p.id, { email: address });
      expect(acs.statusCode, acs.body).toBe(302);
      expect(acs.headers.location).toBe("/ui/login?mfa=pending");
      expect(cookieOf(acs)).toBeNull(); // NO session
      const pending = cookieOf(acs, "regulait_mfa_pending");
      expect(pending).toBeTruthy();
      expect((await latestAudit("saml-mfa-step-up"))?.objectId).toBe(uid);
      // a wrong code is refused and mints nothing
      const wrong = await app.inject({ method: "POST", url: "/auth/mfa/verify", headers: CSRF, cookies: { regulait_mfa_pending: pending! }, payload: { code: "000000" } });
      expect(wrong.statusCode).toBe(401);
      expect(cookieOf(wrong)).toBeNull();
      const ok = await app.inject({ method: "POST", url: "/auth/mfa/verify", headers: CSRF, cookies: { regulait_mfa_pending: pending! }, payload: { code: totpCode(secret, totpStep()) } });
      expect(ok.statusCode, ok.body).toBe(200);
      const session = cookieOf(ok)!;
      const [row] = await db.select().from(authSessions).where(eq(authSessions.tokenHash, hashToken(session)));
      expect(row?.origin).toBe("saml");
      expect(row?.userId).toBe(uid);
      expect((await app.inject({ method: "GET", url: "/v1/me", cookies: { regulait_session: session } })).statusCode).toBe(200);
      expect((await latestAudit("login-succeeded"))?.detail).toMatchObject({ method: "saml", mfa: "totp-step-up", providerId: p.id });
    } finally {
      await putSettings({ mfaRequired: orgSnapshot?.mfaRequired ?? "off" });
    }
  });

  it("a configured multi-factor AuthnContextClassRef satisfies the requirement — no step-up, and no TOTP enrolment needed", async () => {
    const p = await mkProvider({ mfaAuthnContexts: [MFA_CTX] });
    expect(p.mfaAuthnContexts).toEqual([MFA_CTX]);
    const address = `ctx-${tag}@adr0174-saml.example`;
    const uid = await mkUser(address); // never signed in, no TOTP
    expect((await putSettings({ mfaRequired: "all" })).statusCode).toBe(200);
    try {
      const acs = await roundTrip(p.id, { email: address, authnContext: MFA_CTX });
      expect(acs.statusCode, acs.body).toBe(302);
      expect(acs.headers.location).toBe("/app");
      const session = cookieOf(acs)!;
      const [row] = await db.select().from(authSessions).where(eq(authSessions.tokenHash, hashToken(session)));
      expect(row?.idpMfa).toBe(true);
      expect(row?.userId).toBe(uid);
      expect((await app.inject({ method: "GET", url: "/v1/me", cookies: { regulait_session: session } })).statusCode).toBe(200);
    } finally {
      await putSettings({ mfaRequired: orgSnapshot?.mfaRequired ?? "off" });
    }
  });

  it("an account with no TOTP and no multi-factor context gets its session and is sent to enrolment, as before", async () => {
    const p = await mkProvider({ mfaAuthnContexts: [MFA_CTX] });
    const address = `enrol-${tag}@adr0174-saml.example`;
    await mkUser(address);
    expect((await putSettings({ mfaRequired: "all" })).statusCode).toBe(200);
    try {
      const acs = await roundTrip(p.id, { email: address });
      expect(acs.headers.location).toBe("/app");
      const me = await app.inject({ method: "GET", url: "/v1/me", cookies: { regulait_session: cookieOf(acs)! } });
      expect(me.statusCode).toBe(403);
      expect(me.json().error).toBe("mfa_enrollment_required");
    } finally {
      await putSettings({ mfaRequired: orgSnapshot?.mfaRequired ?? "off" });
    }
  });

  it("a multi-factor context smuggled OUTSIDE the signed assertion counts for nothing", async () => {
    const p = await mkProvider({ mfaAuthnContexts: [MFA_CTX] });
    const address = `smuggle-${tag}@adr0174-saml.example`;
    await userWithTotp(address, p.id);
    expect((await putSettings({ mfaRequired: "all" })).statusCode).toBe(200);
    try {
      const forged = `<saml:AuthnStatement AuthnInstant="${iso(0)}"><saml:AuthnContext><saml:AuthnContextClassRef>${MFA_CTX}</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>`;
      const acs = await roundTrip(p.id, { email: address, outside: forged });
      expect(cookieOf(acs)).toBeNull();
      expect(acs.headers.location === "/ui/login?mfa=pending" || acs.statusCode >= 400, `${acs.statusCode} ${acs.headers.location ?? acs.body}`).toBe(true);
    } finally {
      await putSettings({ mfaRequired: orgSnapshot?.mfaRequired ?? "off" });
    }
  });

  it("with MFA off nothing changes: a TOTP account signs straight in over SAML", async () => {
    const p = await mkProvider();
    const address = `off-${tag}@adr0174-saml.example`;
    await userWithTotp(address, p.id);
    expect((await putSettings({ mfaRequired: "off" })).statusCode).toBe(200);
    try {
      const acs = await roundTrip(p.id, { email: address });
      expect(acs.headers.location).toBe("/app");
      expect(cookieOf(acs)).toBeTruthy();
    } finally {
      await putSettings({ mfaRequired: orgSnapshot?.mfaRequired ?? "off" });
    }
  });
});

// ===========================================================================
describe("finding 6: SAML anchors — entity id + NameID Format, never a transient NameID", () => {
  it("a transient NameID is never stored or matched: the verified email anchors the link instead", async () => {
    const p = await mkProvider();
    const address = `transient-${tag}@adr0174-saml.example`;
    const uid = await mkUser(address);
    const first = await roundTrip(p.id, { email: address, nameId: `_t${randomBytes(8).toString("hex")}`, nameIdFormat: TRANSIENT });
    expect(first.headers.location).toBe("/app");
    const rows = await db.select().from(federatedIdentities).where(eq(federatedIdentities.userId, uid));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ issuer: IDP_ENTITY, subjectFormat: "email-anchor", subject: address });
    // a fresh transient NameID next time still reaches the same, single link
    const second = await roundTrip(p.id, { email: address, nameId: `_t${randomBytes(8).toString("hex")}`, nameIdFormat: TRANSIENT });
    expect(second.headers.location).toBe("/app");
    expect(await db.select().from(federatedIdentities).where(eq(federatedIdentities.userId, uid))).toHaveLength(1);
  });

  it("the NameID Format is part of the anchor: the same value under another format is not the linked identity", async () => {
    const p = await mkProvider();
    const address = `persistent-${tag}@adr0174-saml.example`;
    const uid = await mkUser(address);
    const nameId = `p-${randomBytes(6).toString("hex")}`;
    expect((await roundTrip(p.id, { email: address, nameId, nameIdFormat: PERSISTENT })).headers.location).toBe("/app");
    const [row] = await db.select().from(federatedIdentities).where(eq(federatedIdentities.userId, uid));
    expect(row).toMatchObject({ issuer: IDP_ENTITY, subjectFormat: PERSISTENT, subject: nameId });
    const other = await roundTrip(p.id, { email: address, nameId, nameIdFormat: UNSPECIFIED });
    expect(other.headers.location).toBe("/ui/login?link=pending");
    expect(cookieOf(other)).toBeNull();
  });

  it("changing the provider's entity id drops its links (audited)", async () => {
    const p = await mkProvider();
    const address = `entity-${tag}@adr0174-saml.example`;
    await mkUser(address);
    expect((await roundTrip(p.id, { email: address })).headers.location).toBe("/app");
    expect(await db.select().from(federatedIdentities).where(eq(federatedIdentities.samlProviderId, p.id))).toHaveLength(1);
    const patch = await app.inject({ method: "PATCH", url: `/v1/auth/saml-providers/${p.id}`, headers: AUTH, payload: { entityId: "https://idp.elsewhere.example/metadata" } });
    expect(patch.statusCode, patch.body).toBe(200);
    expect(await db.select().from(federatedIdentities).where(eq(federatedIdentities.samlProviderId, p.id))).toHaveLength(0);
    expect((await latestAudit("federated-identities-reset"))?.objectId).toBe(p.id);
  });
});
