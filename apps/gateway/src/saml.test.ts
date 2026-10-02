/**
 * ADR-0036 e2e — SAML 2.0 SSO beside OIDC, proof-by-attack.
 *
 * The happy path is one test; the rest of this file is the attack surface,
 * because that is where SAML lives. Every assertion below is minted by a REAL
 * in-test IdP: a keypair generated with node:crypto at suite start (never a
 * committed fixture), wrapped in a short-lived self-signed X.509 certificate,
 * and used to produce a genuine XML-DSig enveloped signature over the
 * assertion. Nothing is stubbed at the crypto layer — a test that faked the
 * signature would prove nothing about the one thing this ADR is about.
 *
 * Covered: SP-initiated start → ACS → session minted with the NEW `saml`
 * origin (migration 0051's widened CHECK); signature by the WRONG key refused;
 * a tampered assertion body refused; Audience, Recipient, NotBefore and
 * NotOnOrAfter each refused on their own; assertion-ID REPLAY refused;
 * IdP-initiated refused by default and accepted (with full validation) when
 * the admin opts in; JIT default-deny vs provision-never-admin-with-default-
 * role; the allowed-domain backstop; certificate ROLLOVER (two pinned certs,
 * either one signs); the sso_only lockout guard now counting OIDC + SAML
 * together; and the ADR-0039 / ADR-0028 interplay for the new origin.
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
  and,
  auditLog,
  authSessions,
  createDb,
  desc,
  eq,
  inArray,
  oidcProviders,
  ORG_SETTINGS_ID,
  orgSettings,
  roleAssignments,
  samlAssertionIds,
  samlLoginStates,
  samlProviders,
  users,
  type Db,
  type OrgSettingsRow,
} from "@regulait/db";
import { buildApp } from "./app.js";
import { installLicenseFixture, removeLicenseFixture } from "./testing/license-fixture.js";
import { governingIpPolicy, HUMAN_SESSION_ORIGINS, hashToken } from "./auth.js";
import {
  assertionIdentity,
  assertionRecipients,
  resolveSamlEmail,
  samlClockSkewMinutes,
  SAML_MAX_CLOCK_SKEW_MINUTES,
  spEntityId,
} from "./saml.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "saml-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = "d".repeat(64);
const FORM = { "content-type": "application/x-www-form-urlencoded" };

let db: Db;
let app: ReturnType<typeof buildApp>;

// ---------------------------------------------------------------------------
// a real signing IdP — keys generated here, never committed
// ---------------------------------------------------------------------------

interface SigningKey {
  /** PKCS#8 private key PEM. TEST-ONLY: minted per run, never persisted. */
  privateKey: string;
  /** the matching self-signed X.509 certificate, PEM — what gets PINNED */
  certPem: string;
}

/**
 * node:crypto generates the keypair; openssl only wraps that key in a
 * certificate (node has no certificate-issuing API). Everything lands in a
 * temp dir that is removed immediately, so no private key ever exists in the
 * repo — the ADR's cert pinning is meaningless if the pinned identity is a
 * committed secret everyone shares.
 */
function makeSigningKey(cn: string): SigningKey {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const keyPem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  const dir = mkdtempSync(path.join(tmpdir(), "regulait-saml-test-only-"));
  try {
    const keyFile = path.join(dir, "test-only-idp-key.pem");
    const certFile = path.join(dir, "test-only-idp-cert.pem");
    writeFileSync(keyFile, keyPem, { mode: 0o600 });
    execFileSync("openssl", [
      "req", "-x509", "-new", "-sha256", "-days", "1",
      "-key", keyFile, "-out", certFile,
      "-subj", `/CN=${cn}`,
    ]);
    return { privateKey: keyPem, certPem: readFileSync(certFile, "utf8").trim() };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

let keyA: SigningKey; // the pinned IdP key
let keyB: SigningKey; // the rollover / attacker key, depending on the test

const IDP_ENTITY = "https://idp.test.example/metadata";
/** what fastify's inject() reports as the Host header — the SP entity id and
 * ACS URL are derived from the request host exactly like the OIDC
 * redirect_uri, so the test must speak the same origin the server computes. */
const BASE = "http://localhost:80";
const SP_ENTITY = spEntityId(BASE, {} as NodeJS.ProcessEnv);
const acsFor = (providerId: string) => `${BASE}/auth/saml/${providerId}/acs`;

const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
const xmlEscape = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

interface AssertionOptions {
  providerId: string;
  email: string;
  /** null = omit InResponseTo everywhere (the IdP-initiated shape) */
  inResponseTo: string | null;
  issuer?: string;
  audience?: string;
  recipient?: string;
  notBefore?: string;
  notOnOrAfter?: string;
  assertionId?: string;
  nameIdFormat?: string;
  displayName?: string;
  /** extra <Attribute> entries, e.g. a non-NameID email carrier */
  attributes?: Record<string, string>;
}

/** an unsigned SAML Response carrying one Assertion, built as literal XML so
 * every attribute an attacker would tamper with is visible in the test. */
function buildResponse(o: AssertionOptions): { xml: string; assertionId: string } {
  const assertionId = o.assertionId ?? "_a" + randomBytes(12).toString("hex");
  const responseId = "_r" + randomBytes(12).toString("hex");
  const acs = o.recipient ?? acsFor(o.providerId);
  const notBefore = o.notBefore ?? iso(-60_000);
  const notOnOrAfter = o.notOnOrAfter ?? iso(5 * 60_000);
  const issuer = o.issuer ?? IDP_ENTITY;
  const audience = o.audience ?? SP_ENTITY;
  const inResp = o.inResponseTo ? ` InResponseTo="${xmlEscape(o.inResponseTo)}"` : "";
  const nameIdFormat =
    o.nameIdFormat ?? "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress";
  const attrs = Object.entries(o.attributes ?? {})
    .map(
      ([name, value]) =>
        `<saml:Attribute Name="${xmlEscape(name)}" NameFormat="urn:oasis:names:tc:SAML:2.0:attrname-format:basic">` +
        `<saml:AttributeValue>${xmlEscape(value)}</saml:AttributeValue></saml:Attribute>`,
    )
    .join("");
  const displayName = o.displayName
    ? `<saml:Attribute Name="displayName"><saml:AttributeValue>${xmlEscape(o.displayName)}</saml:AttributeValue></saml:Attribute>`
    : "";
  const xml =
    `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ` +
    `ID="${responseId}" Version="2.0" IssueInstant="${iso(0)}" Destination="${xmlEscape(acsFor(o.providerId))}"${inResp}>` +
    `<saml:Issuer>${xmlEscape(issuer)}</saml:Issuer>` +
    `<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>` +
    `<saml:Assertion ID="${assertionId}" Version="2.0" IssueInstant="${iso(0)}">` +
    `<saml:Issuer>${xmlEscape(issuer)}</saml:Issuer>` +
    `<saml:Subject>` +
    `<saml:NameID Format="${xmlEscape(nameIdFormat)}">${xmlEscape(o.email)}</saml:NameID>` +
    `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">` +
    `<saml:SubjectConfirmationData NotOnOrAfter="${notOnOrAfter}" Recipient="${xmlEscape(acs)}"${inResp}/>` +
    `</saml:SubjectConfirmation></saml:Subject>` +
    `<saml:Conditions NotBefore="${notBefore}" NotOnOrAfter="${notOnOrAfter}">` +
    `<saml:AudienceRestriction><saml:Audience>${xmlEscape(audience)}</saml:Audience></saml:AudienceRestriction>` +
    `</saml:Conditions>` +
    `<saml:AuthnStatement AuthnInstant="${iso(0)}" SessionIndex="_s${randomBytes(6).toString("hex")}">` +
    `<saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext>` +
    `</saml:AuthnStatement>` +
    (attrs || displayName ? `<saml:AttributeStatement>${attrs}${displayName}</saml:AttributeStatement>` : "") +
    `</saml:Assertion></samlp:Response>`;
  return { xml, assertionId };
}

/** a genuine enveloped XML-DSig over the Assertion element (exclusive c14n,
 * RSA-SHA256) — the exact shape a real IdP emits and the exact shape
 * node-saml verifies. */
function signAssertion(xml: string, key: SigningKey): string {
  const sig = new SignedXml({
    privateKey: key.privateKey,
    publicCert: key.certPem,
    signatureAlgorithm: "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
    canonicalizationAlgorithm: "http://www.w3.org/2001/10/xml-exc-c14n#",
  });
  sig.addReference({
    xpath: "//*[local-name(.)='Assertion']",
    transforms: [
      "http://www.w3.org/2000/09/xmldsig#enveloped-signature",
      "http://www.w3.org/2001/10/xml-exc-c14n#",
    ],
    digestAlgorithm: "http://www.w3.org/2001/04/xmlenc#sha256",
  });
  sig.computeSignature(xml, {
    location: { reference: "//*[local-name(.)='Assertion']/*[local-name(.)='Issuer']", action: "after" },
  });
  return sig.getSignedXml();
}

const postAcs = (providerId: string, signedXml: string, relayState?: string) =>
  app.inject({
    method: "POST",
    url: `/auth/saml/${providerId}/acs`,
    headers: FORM,
    payload:
      `SAMLResponse=${encodeURIComponent(Buffer.from(signedXml, "utf8").toString("base64"))}` +
      (relayState ? `&RelayState=${encodeURIComponent(relayState)}` : ""),
  });

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * SUITE-ORDER ISOLATION (mirrors the note in auth.test.ts). The gateway suite
 * shares ONE database and vitest orders files by cached duration, so this file
 * may run before any other. Two things here are GLOBAL and must not leak:
 * enabled SSO providers (the ADR-0036 lockout guard counts OIDC + SAML
 * together, so a leftover enabled provider silently changes what a later
 * file's `sso_only` assertions observe) and the `org_settings` singleton this
 * file flips (`ssoOnly`, `sessionIpPolicy`, `sessionIpAllowlist`). Every
 * provider created here is tracked and deleted, and the singleton is
 * snapshotted and restored — the group-role-mapping.test.ts pattern.
 */
const createdSamlProviderIds = new Set<string>();
const createdOidcProviderIds = new Set<string>();
let orgSettingsSnapshot: OrgSettingsRow | null = null;

const mkProvider = async (payload: Record<string, unknown> = {}) => {
  const r = await app.inject({
    method: "POST", headers: AUTH, url: "/v1/auth/saml-providers",
    payload: {
      name: "idp-" + randomBytes(5).toString("hex"),
      entityId: IDP_ENTITY,
      idpSsoUrl: "https://idp.test.example/sso",
      idpSigningCerts: [keyA.certPem],
      ...payload,
    },
  });
  expect(r.statusCode, JSON.stringify(r.json())).toBe(201);
  const row = r.json();
  createdSamlProviderIds.add(row.id);
  return row;
};

const mkUser = async (email: string, name: string): Promise<string> => {
  const r = await app.inject({
    method: "POST", headers: AUTH, url: "/v1/users",
    payload: { email, displayName: name, isAdmin: false },
  });
  expect(r.statusCode).toBe(201);
  return r.json().id;
};

/** drive /start and hand back the correlation values the IdP would echo */
const start = async (providerId: string, returnTo = "/app") => {
  const r = await app.inject({ method: "GET", url: `/auth/saml/${providerId}/start?returnTo=${returnTo}` });
  expect(r.statusCode).toBe(302);
  const url = new URL(r.headers.location as string);
  const relayState = url.searchParams.get("RelayState")!;
  expect(relayState).toBeTruthy();
  const [row] = await db
    .select()
    .from(samlLoginStates)
    .where(eq(samlLoginStates.relayState, relayState));
  expect(row).toBeTruthy();
  return { relayState, requestId: row!.requestId, ssoUrl: url };
};

/** the whole SP-initiated flow with one knob per test */
const roundTrip = async (
  providerId: string,
  o: Omit<AssertionOptions, "providerId" | "inResponseTo"> & { inResponseTo?: string | null },
  key: SigningKey = keyA,
  tamper?: (signed: string) => string,
) => {
  const s = await start(providerId);
  const { xml, assertionId } = buildResponse({
    providerId,
    inResponseTo: o.inResponseTo === undefined ? s.requestId : o.inResponseTo,
    ...o,
  });
  let signed = signAssertion(xml, key);
  if (tamper) signed = tamper(signed);
  const res = await postAcs(providerId, signed, s.relayState);
  return { res, assertionId, ...s };
};

const cookieOf = (res: { cookies: Array<{ name: string; value: string }> }): string => {
  const c = res.cookies.find((x) => x.name === "regulait_session");
  expect(c, "expected a session cookie").toBeTruthy();
  return c!.value;
};

const latestAudit = async (ruleId: string) => {
  const [row] = await db
    .select().from(auditLog).where(eq(auditLog.ruleId, ruleId)).orderBy(desc(auditLog.at)).limit(1);
  return row ?? null;
};

beforeAll(async () => {
  const { runMigrations } = await import("@regulait/db");
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
  // ADR-0052 §4: creating a SAML provider is tier-gated on `sso_saml` and the
  // flag is now ENFORCED at the route, so this suite runs under a real signed
  // license granting it. Removed in afterAll — the deployment ends UNLICENSED
  // exactly as it started (`licenses` is an org singleton).
  await installLicenseFixture(app, { features: ["sso_saml"], auth: AUTH });
  keyA = makeSigningKey("regulait-test-idp-a");
  keyB = makeSigningKey("regulait-test-idp-b");
  const [settings] = await db.select().from(orgSettings).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  orgSettingsSnapshot = settings ?? null;
}, 120_000);

afterAll(async () => {
  // Providers go out through the DB rather than the API so the no-lockout
  // guard can never refuse this file's own cleanup; the singleton is restored
  // afterwards to exactly the row this file found.
  if (createdSamlProviderIds.size > 0) {
    await db.delete(samlProviders).where(inArray(samlProviders.id, [...createdSamlProviderIds]));
  }
  if (createdOidcProviderIds.size > 0) {
    await db.delete(oidcProviders).where(inArray(oidcProviders.id, [...createdOidcProviderIds]));
  }
  if (orgSettingsSnapshot) {
    await db
      .update(orgSettings)
      .set(orgSettingsSnapshot)
      .where(eq(orgSettings.id, ORG_SETTINGS_ID));
  }
  await removeLicenseFixture(db);
  await app?.close();
});

// ===========================================================================

describe("ADR-0036 — the happy path", () => {
  it("SP-initiated start → ACS mints a session with origin 'saml'", async () => {
    const p = await mkProvider();
    const email = `sam.spinit.${randomBytes(3).toString("hex")}@corp.example`;
    const userId = await mkUser(email, "Sam SP");
    const { res } = await roundTrip(p.id, { email });
    expect(res.statusCode, res.body).toBe(302);
    expect(res.headers.location).toBe("/app");
    const cookie = cookieOf(res);
    // migration 0051's widened CHECK is what lets this row exist at all
    const [session] = await db
      .select().from(authSessions).where(eq(authSessions.tokenHash, hashToken(cookie)));
    expect(session!.origin).toBe("saml");
    expect(session!.userId).toBe(userId);
    const me = await app.inject({ method: "GET", url: "/auth/me", cookies: { regulait_session: cookie } });
    expect(me.json().userId).toBe(userId);
    expect(me.json().sessionOrigin).toBe("saml");
    const audit = await latestAudit("login-succeeded");
    expect((audit!.detail as Record<string, unknown>).method).toBe("saml");
  });

  it("the AuthnRequest is a real redirect carrying a single-use correlation row", async () => {
    const p = await mkProvider();
    const s = await start(p.id, "/admin");
    expect(s.ssoUrl.origin + s.ssoUrl.pathname).toBe("https://idp.test.example/sso");
    expect(s.ssoUrl.searchParams.get("SAMLRequest")).toBeTruthy();
    const [row] = await db
      .select().from(samlLoginStates).where(eq(samlLoginStates.requestId, s.requestId));
    expect(row!.returnTo).toBe("/admin");
    expect(row!.acsUrl).toBe(acsFor(p.id));
  });

  it("returnTo is honoured from the server-side row, not from the IdP's POST", async () => {
    const p = await mkProvider();
    const email = `sam.return.${randomBytes(3).toString("hex")}@corp.example`;
    await mkUser(email, "Sam Return");
    const s = await start(p.id, "/admin");
    const { xml } = buildResponse({ providerId: p.id, email, inResponseTo: s.requestId });
    const res = await postAcs(p.id, signAssertion(xml, keyA), s.relayState);
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe("/admin");
  });

  it("publishes SP metadata for the IdP admin (entity id + ACS URL, no secret)", async () => {
    const p = await mkProvider();
    const res = await app.inject({ method: "GET", url: `/auth/saml/${p.id}/metadata` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("samlmetadata+xml");
    expect(res.body).toContain(SP_ENTITY);
    expect(res.body).toContain(acsFor(p.id));
  });

  it("lists enabled providers for the login screen without any credential", async () => {
    const p = await mkProvider({ name: "login-screen-" + randomBytes(3).toString("hex") });
    const res = await app.inject({ method: "GET", url: "/auth/saml/providers" });
    expect(res.statusCode).toBe(200);
    const names = (res.json().providers as Array<{ id: string }>).map((x) => x.id);
    expect(names).toContain(p.id);
    // names only — no cert, no entity id, no config
    expect(JSON.stringify(res.json())).not.toContain("BEGIN CERTIFICATE");
  });
});

describe("ADR-0036 — signature is the whole security model", () => {
  it("REFUSES an assertion signed by a different key than the pinned cert", async () => {
    const p = await mkProvider(); // pins keyA
    const email = `sam.wrongkey.${randomBytes(3).toString("hex")}@corp.example`;
    await mkUser(email, "Sam WrongKey");
    const { res } = await roundTrip(p.id, { email }, keyB); // signs with keyB
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("saml_validation_failed");
    const audit = await latestAudit("saml-login-failed");
    expect(audit!.effect).toBe("deny");
  });

  it("REFUSES a tampered assertion body (the email swapped after signing)", async () => {
    const p = await mkProvider();
    const victim = `sam.victim.${randomBytes(3).toString("hex")}@corp.example`;
    const attacker = `sam.attacker.${randomBytes(3).toString("hex")}@corp.example`;
    await mkUser(victim, "Victim");
    await mkUser(attacker, "Attacker");
    const { res } = await roundTrip(p.id, { email: attacker }, keyA, (signed) =>
      signed.replace(attacker, victim),
    );
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("saml_validation_failed");
    // and no session was minted for EITHER identity
    expect(res.cookies.find((c) => c.name === "regulait_session")).toBeUndefined();
  });

  it("REFUSES an entirely unsigned assertion", async () => {
    const p = await mkProvider();
    const email = `sam.unsigned.${randomBytes(3).toString("hex")}@corp.example`;
    await mkUser(email, "Sam Unsigned");
    const s = await start(p.id);
    const { xml } = buildResponse({ providerId: p.id, email, inResponseTo: s.requestId });
    const res = await postAcs(p.id, xml, s.relayState); // never signed
    expect(res.statusCode).toBe(401);
  });

  it("a cert ROLLOVER pins TWO certs and either one verifies", async () => {
    const p = await mkProvider({ idpSigningCerts: [keyA.certPem, keyB.certPem] });
    const oldKeyEmail = `sam.rollold.${randomBytes(3).toString("hex")}@corp.example`;
    const newKeyEmail = `sam.rollnew.${randomBytes(3).toString("hex")}@corp.example`;
    await mkUser(oldKeyEmail, "Old Key");
    await mkUser(newKeyEmail, "New Key");
    const outgoing = await roundTrip(p.id, { email: oldKeyEmail }, keyA);
    expect(outgoing.res.statusCode).toBe(302);
    const incoming = await roundTrip(p.id, { email: newKeyEmail }, keyB);
    expect(incoming.res.statusCode).toBe(302);
  });
});

describe("ADR-0036 — the mandatory assertion conditions", () => {
  it("REFUSES an Audience naming a different SP", async () => {
    const p = await mkProvider();
    const email = `sam.aud.${randomBytes(3).toString("hex")}@corp.example`;
    await mkUser(email, "Sam Audience");
    const { res } = await roundTrip(p.id, { email, audience: "https://someone-else.example/sp" });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("saml_validation_failed");
  });

  it("REFUSES a Recipient that is not our ACS URL", async () => {
    const p = await mkProvider();
    const email = `sam.recip.${randomBytes(3).toString("hex")}@corp.example`;
    await mkUser(email, "Sam Recipient");
    const { res } = await roundTrip(p.id, { email, recipient: "https://evil.example/acs" });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("saml_recipient_mismatch");
    expect((await latestAudit("saml-recipient-refused"))!.effect).toBe("deny");
  });

  it("REFUSES an expired NotOnOrAfter (well past the bounded skew)", async () => {
    const p = await mkProvider();
    const email = `sam.expired.${randomBytes(3).toString("hex")}@corp.example`;
    await mkUser(email, "Sam Expired");
    const { res } = await roundTrip(p.id, {
      email,
      notBefore: iso(-60 * 60_000),
      notOnOrAfter: iso(-30 * 60_000),
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("saml_validation_failed");
  });

  it("REFUSES a NotBefore in the future (well past the bounded skew)", async () => {
    const p = await mkProvider();
    const email = `sam.notyet.${randomBytes(3).toString("hex")}@corp.example`;
    await mkUser(email, "Sam NotYet");
    const { res } = await roundTrip(p.id, {
      email,
      notBefore: iso(30 * 60_000),
      notOnOrAfter: iso(60 * 60_000),
    });
    expect(res.statusCode).toBe(401);
  });

  it("REFUSES an Issuer that is not the provider's pinned entity id", async () => {
    const p = await mkProvider();
    const email = `sam.issuer.${randomBytes(3).toString("hex")}@corp.example`;
    await mkUser(email, "Sam Issuer");
    const { res } = await roundTrip(p.id, { email, issuer: "https://other-idp.example/metadata" });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("saml_issuer_mismatch");
  });

  it("the clock-skew tolerance is bounded and single-digit, never unbounded", () => {
    expect(samlClockSkewMinutes({} as NodeJS.ProcessEnv)).toBe(2);
    expect(samlClockSkewMinutes({ REGULAIT_SAML_CLOCK_SKEW_MINUTES: "4" } as NodeJS.ProcessEnv)).toBe(4);
    // a fat-fingered or hostile value cannot widen the window past the cap,
    // and node-saml's "-1 = skip timestamp checks" is unreachable from here
    expect(samlClockSkewMinutes({ REGULAIT_SAML_CLOCK_SKEW_MINUTES: "600" } as NodeJS.ProcessEnv))
      .toBe(SAML_MAX_CLOCK_SKEW_MINUTES);
    expect(samlClockSkewMinutes({ REGULAIT_SAML_CLOCK_SKEW_MINUTES: "-1" } as NodeJS.ProcessEnv)).toBe(2);
    expect(samlClockSkewMinutes({ REGULAIT_SAML_CLOCK_SKEW_MINUTES: "nonsense" } as NodeJS.ProcessEnv)).toBe(2);
  });
});

describe("ADR-0036 — replay and initiation mode", () => {
  it("REFUSES the same assertion ID twice (unsolicited path, replay guard)", async () => {
    const p = await mkProvider({ allowIdpInitiated: true });
    const email = `sam.replay.${randomBytes(3).toString("hex")}@corp.example`;
    await mkUser(email, "Sam Replay");
    const { xml, assertionId } = buildResponse({ providerId: p.id, email, inResponseTo: null });
    const signed = signAssertion(xml, keyA);

    const first = await postAcs(p.id, signed);
    expect(first.statusCode).toBe(302);
    const [seen] = await db
      .select().from(samlAssertionIds).where(eq(samlAssertionIds.assertionId, assertionId));
    expect(seen).toBeTruthy();

    const second = await postAcs(p.id, signed); // byte-identical replay
    expect(second.statusCode).toBe(403);
    expect(second.json().error).toBe("saml_assertion_replayed");
    expect(second.cookies.find((c) => c.name === "regulait_session")).toBeUndefined();
    expect((await latestAudit("saml-assertion-replayed"))!.effect).toBe("deny");
  });

  it("REFUSES a replayed SOLICITED assertion (the correlation row is single-use)", async () => {
    const p = await mkProvider();
    const email = `sam.replay2.${randomBytes(3).toString("hex")}@corp.example`;
    await mkUser(email, "Sam Replay2");
    const s = await start(p.id);
    const { xml } = buildResponse({ providerId: p.id, email, inResponseTo: s.requestId });
    const signed = signAssertion(xml, keyA);
    expect((await postAcs(p.id, signed, s.relayState)).statusCode).toBe(302);
    const again = await postAcs(p.id, signed, s.relayState);
    expect(again.statusCode).not.toBe(302);
    // the correlation row is gone, so the library refuses before we even reach
    // the replay seen-set — a strictly stronger refusal, not a weaker one
    expect([401, 403]).toContain(again.statusCode);
  });

  it("REFUSES an IdP-initiated assertion when allow_idp_initiated is off (the default)", async () => {
    const p = await mkProvider();
    expect(p.allowIdpInitiated).toBe(false);
    const email = `sam.unsolicited.${randomBytes(3).toString("hex")}@corp.example`;
    await mkUser(email, "Sam Unsolicited");
    const { xml } = buildResponse({ providerId: p.id, email, inResponseTo: null });
    const res = await postAcs(p.id, signAssertion(xml, keyA));
    expect(res.statusCode).toBe(401);
    expect(res.cookies.find((c) => c.name === "regulait_session")).toBeUndefined();
  });

  it("ACCEPTS an IdP-initiated assertion when opted in — with full validation still applied", async () => {
    const p = await mkProvider({ allowIdpInitiated: true });
    const email = `sam.idpinit.${randomBytes(3).toString("hex")}@corp.example`;
    const userId = await mkUser(email, "Sam IdPInit");
    const ok = buildResponse({ providerId: p.id, email, inResponseTo: null });
    const res = await postAcs(p.id, signAssertion(ok.xml, keyA));
    expect(res.statusCode).toBe(302);
    const [session] = await db
      .select().from(authSessions).where(eq(authSessions.tokenHash, hashToken(cookieOf(res))));
    expect(session!.userId).toBe(userId);
    expect(session!.origin).toBe("saml");

    // opting in does NOT relax anything else: wrong key still refused
    const bad = buildResponse({ providerId: p.id, email, inResponseTo: null });
    expect((await postAcs(p.id, signAssertion(bad.xml, keyB))).statusCode).toBe(401);
    // ...nor the audience
    const badAud = buildResponse({
      providerId: p.id, email, inResponseTo: null, audience: "https://elsewhere.example/sp",
    });
    expect((await postAcs(p.id, signAssertion(badAud.xml, keyA))).statusCode).toBe(401);
  });
});

describe("ADR-0036 — identity mapping, JIT and the domain backstop", () => {
  it("JIT OFF (the default) refuses an unknown subject with a 403 + audit row", async () => {
    const p = await mkProvider();
    expect(p.jitProvisioning).toBe(false);
    const email = `nobody.${randomBytes(4).toString("hex")}@corp.example`;
    const { res } = await roundTrip(p.id, { email });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("unknown_user");
    const audit = await latestAudit("saml-unknown-subject");
    expect(audit!.effect).toBe("deny");
    expect((audit!.detail as Record<string, unknown>).email).toBe(email);
    const [none] = await db.select().from(users).where(eq(users.email, email));
    expect(none).toBeUndefined();
  });

  it("JIT ON provisions a NON-ADMIN user and attaches the provider's default role", async () => {
    const roleRes = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/roles",
      payload: { name: "saml-jit-role-" + randomBytes(3).toString("hex"), description: "ADR-0036" },
    });
    expect(roleRes.statusCode).toBe(201);
    const roleId = roleRes.json().id;
    const p = await mkProvider({ jitProvisioning: true, defaultRoleId: roleId });
    const email = `jit.${randomBytes(4).toString("hex")}@corp.example`;
    const { res } = await roundTrip(p.id, { email, displayName: "JIT Person" });
    expect(res.statusCode).toBe(302);
    const [created] = await db.select().from(users).where(eq(users.email, email));
    expect(created).toBeTruthy();
    expect(created!.isAdmin).toBe(false); // NEVER admin
    expect(created!.passwordHash).toBeNull();
    const [assignment] = await db
      .select().from(roleAssignments)
      .where(and(eq(roleAssignments.userId, created!.id), eq(roleAssignments.roleId, roleId)));
    expect(assignment).toBeTruthy();
    const audit = await latestAudit("saml-user-provisioned");
    expect(audit!.effect).toBe("allow");
    expect((audit!.detail as Record<string, unknown>).defaultRoleId).toBe(roleId);
  });

  it("REFUSES an email outside allowed_email_domains, even with JIT on", async () => {
    const p = await mkProvider({ jitProvisioning: true, allowedEmailDomains: ["corp.example"] });
    const email = `outsider.${randomBytes(4).toString("hex")}@notcorp.example`;
    const { res } = await roundTrip(p.id, { email });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("email_domain_not_allowed");
    const [none] = await db.select().from(users).where(eq(users.email, email));
    expect(none).toBeUndefined();
    expect((await latestAudit("saml-domain-refused"))!.effect).toBe("deny");
  });

  it("maps from a configured email ATTRIBUTE when the NameID is not an emailAddress", async () => {
    const p = await mkProvider({ emailAttribute: "urn:corp:mail" });
    const email = `attr.${randomBytes(4).toString("hex")}@corp.example`;
    const userId = await mkUser(email, "Attr Person");
    const { res } = await roundTrip(p.id, {
      email: "opaque-persistent-handle",
      nameIdFormat: "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent",
      attributes: { "urn:corp:mail": email },
    });
    expect(res.statusCode).toBe(302);
    const [session] = await db
      .select().from(authSessions).where(eq(authSessions.tokenHash, hashToken(cookieOf(res))));
    expect(session!.userId).toBe(userId);
  });

  it("never promotes a non-emailAddress NameID to an identity claim", () => {
    // an 'unspecified' NameID is whatever the IdP feels like sending; treating
    // one that happens to contain '@' as an email is how SSO ends up matching
    // on an attacker-chosen string
    const persistent = {
      nameID: "attacker@corp.example",
      nameIDFormat: "urn:oasis:names:tc:SAML:2.0:nameid-format:unspecified",
    } as never;
    expect(resolveSamlEmail(persistent, null).email).toBeNull();
    const emailNameId = {
      nameID: "Real.Person@Corp.Example",
      nameIDFormat: "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
    } as never;
    expect(resolveSamlEmail(emailNameId, null)).toEqual({
      email: "real.person@corp.example",
      source: "nameid",
    });
  });

  it("REFUSES a deactivated account (ADR-0022: deactivate kills SSO too)", async () => {
    const p = await mkProvider();
    const email = `gone.${randomBytes(4).toString("hex")}@corp.example`;
    const userId = await mkUser(email, "Gone Person");
    const off = await app.inject({
      method: "POST", headers: AUTH, url: `/v1/users/${userId}/deactivate`,
      payload: { reason: "ADR-0036 test" },
    });
    expect(off.statusCode).toBe(200);
    const { res } = await roundTrip(p.id, { email });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("user_disabled");
  });
});

describe("ADR-0036 — admin CRUD, secrets and the generalized lockout guard", () => {
  it("never returns the SP private key, only whether one is set", async () => {
    const p = await mkProvider({
      spPrivateKey: "-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----",
    });
    expect(p.spPrivateKeySet).toBe(true);
    expect(JSON.stringify(p)).not.toContain("not-a-real-key");
    const list = await app.inject({ method: "GET", headers: AUTH, url: "/v1/auth/saml-providers" });
    expect(JSON.stringify(list.json())).not.toContain("not-a-real-key");
    expect(JSON.stringify(list.json())).not.toContain("spPrivateKeyCiphertext");
  });

  it("refuses a posture where an UNSIGNED assertion could be accepted", async () => {
    const bad = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/auth/saml-providers",
      payload: {
        name: "unsigned-" + randomBytes(3).toString("hex"),
        entityId: IDP_ENTITY,
        idpSsoUrl: "https://idp.test.example/sso",
        idpSigningCerts: [keyA.certPem],
        wantAssertionsSigned: false,
      },
    });
    expect(bad.statusCode).toBe(400);
    // ...and the same combination cannot be reached in two PATCH steps either
    const p = await mkProvider();
    const step = await app.inject({
      method: "PATCH", headers: AUTH, url: `/v1/auth/saml-providers/${p.id}`,
      payload: { wantAssertionsSigned: false },
    });
    expect(step.statusCode).toBe(422);
    expect(step.json().error).toBe("unsigned_assertions_refused");
  });

  it("refuses a non-PEM signing certificate", async () => {
    const bad = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/auth/saml-providers",
      payload: {
        name: "badcert-" + randomBytes(3).toString("hex"),
        entityId: IDP_ENTITY,
        idpSsoUrl: "https://idp.test.example/sso",
        idpSigningCerts: ["just some base64 looking text"],
      },
    });
    expect(bad.statusCode).toBe(400);
  });

  it("a disabled provider serves no login path at all", async () => {
    const p = await mkProvider();
    const off = await app.inject({
      method: "PATCH", headers: AUTH, url: `/v1/auth/saml-providers/${p.id}`,
      payload: { enabled: false },
    });
    expect(off.statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/auth/saml/${p.id}/start` })).statusCode).toBe(404);
    const { xml } = buildResponse({ providerId: p.id, email: "x@corp.example", inResponseTo: null });
    expect((await postAcs(p.id, signAssertion(xml, keyA))).statusCode).toBe(404);
  });

  it("sso_only counts OIDC and SAML TOGETHER — a SAML-only org may engage it", async () => {
    // Start clean: no enabled providers of EITHER family. This is a counting
    // assertion, so the precondition is established here rather than inherited
    // from whichever file vitest happened to schedule first — including OIDC
    // providers, which the guard counts together with SAML ones. Everything
    // borrowed is handed back at the end of the test.
    await app.inject({ method: "PUT", headers: AUTH, url: "/v1/org/settings", payload: { ssoOnly: false } });
    const all = await app.inject({ method: "GET", headers: AUTH, url: "/v1/auth/saml-providers" });
    for (const prov of all.json().providers as Array<{ id: string; enabled: boolean }>) {
      if (prov.enabled) {
        await app.inject({
          method: "PATCH", headers: AUTH, url: `/v1/auth/saml-providers/${prov.id}`,
          payload: { enabled: false },
        });
      }
    }
    const borrowedOidc = (
      await db.select({ id: oidcProviders.id }).from(oidcProviders).where(eq(oidcProviders.enabled, true))
    ).map((p) => p.id);
    if (borrowedOidc.length > 0) {
      await db
        .update(oidcProviders)
        .set({ enabled: false })
        .where(inArray(oidcProviders.id, borrowedOidc));
    }
    const refused = await app.inject({
      method: "PUT", headers: AUTH, url: "/v1/org/settings", payload: { ssoOnly: true },
    });
    expect(refused.statusCode).toBe(422);
    expect(refused.json().error).toBe("sso_only_needs_a_provider");

    // ONE enabled SAML provider is now enough — the old rule demanded OIDC
    const p = await mkProvider({ name: "sso-only-" + randomBytes(3).toString("hex") });
    const engaged = await app.inject({
      method: "PUT", headers: AUTH, url: "/v1/org/settings", payload: { ssoOnly: true },
    });
    expect(engaged.statusCode).toBe(200);

    // ...and it cannot then be disabled or deleted while it is the last door
    const lock = await app.inject({
      method: "PATCH", headers: AUTH, url: `/v1/auth/saml-providers/${p.id}`,
      payload: { enabled: false },
    });
    expect(lock.statusCode).toBe(409);
    expect(lock.json().error).toBe("sso_only_needs_a_provider");
    const del = await app.inject({
      method: "DELETE", headers: AUTH, url: `/v1/auth/saml-providers/${p.id}`,
    });
    expect(del.statusCode).toBe(409);

    // an OIDC provider covering for it releases the SAML one, and vice versa —
    // that is exactly what "counted together" has to mean. ADR-0043 puts the
    // OIDC issuer behind the default-deny egress guard, so the loopback issuer
    // is allow-listed here exactly as an air-gapped operator with a
    // self-hosted Keycloak would (the pattern auth.test.ts already uses).
    const allow = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/egress-allow-hosts",
      payload: {
        host: "127.0.0.1",
        allowPrivateRanges: true,
        allowPlaintextHttp: true,
        note: "ADR-0036 lockout-guard test: loopback OIDC issuer",
      },
    });
    expect([200, 201]).toContain(allow.statusCode);
    const oidc2 = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/auth/oidc-providers",
      payload: {
        name: "oidc-cover-" + randomBytes(3).toString("hex"),
        issuerUrl: "http://127.0.0.1:9",
        clientId: "cid", clientSecret: "csec",
      },
    });
    expect(oidc2.statusCode, JSON.stringify(oidc2.json())).toBe(201);
    createdOidcProviderIds.add(oidc2.json().id);
    const nowFree = await app.inject({
      method: "PATCH", headers: AUTH, url: `/v1/auth/saml-providers/${p.id}`,
      payload: { enabled: false },
    });
    expect(nowFree.statusCode).toBe(200);
    // symmetric: the last OIDC provider is now held by nothing else
    const oidcLocked = await app.inject({
      method: "PATCH", headers: AUTH, url: `/v1/auth/oidc-providers/${oidc2.json().id}`,
      payload: { enabled: false },
    });
    expect(oidcLocked.statusCode).toBe(409);
    // re-enabling the SAML provider frees the OIDC one — both directions
    await app.inject({
      method: "PATCH", headers: AUTH, url: `/v1/auth/saml-providers/${p.id}`, payload: { enabled: true },
    });
    const oidcFree = await app.inject({
      method: "PATCH", headers: AUTH, url: `/v1/auth/oidc-providers/${oidc2.json().id}`,
      payload: { enabled: false },
    });
    expect(oidcFree.statusCode).toBe(200);

    // leave the org as we found it — dial off, borrowed providers handed back
    await app.inject({ method: "PUT", headers: AUTH, url: "/v1/org/settings", payload: { ssoOnly: false } });
    if (borrowedOidc.length > 0) {
      await db
        .update(oidcProviders)
        .set({ enabled: true })
        .where(inArray(oidcProviders.id, borrowedOidc));
    }
  });
});

describe("ADR-0036 × ADR-0039 / ADR-0028 — the new origin obeys the existing rules", () => {
  it("'saml' is governed by the HUMAN IP knob, not the automation one", () => {
    expect(HUMAN_SESSION_ORIGINS.has("saml")).toBe(true);
    const org = { sessionIpPolicy: "enforce_continuous", apiKeyIpPolicy: "off" } as never;
    expect(governingIpPolicy(org, "saml")).toBe("enforce_continuous");
    const flipped = { sessionIpPolicy: "off", apiKeyIpPolicy: "enforce_continuous" } as never;
    expect(governingIpPolicy(flipped, "saml")).toBe("off");
  });

  it("an out-of-envelope SAML login is refused at the door with no cookie", async () => {
    const p = await mkProvider();
    const email = `sam.ip.${randomBytes(3).toString("hex")}@corp.example`;
    await mkUser(email, "Sam IP");
    const set = await app.inject({
      method: "PUT", headers: AUTH, url: "/v1/org/settings",
      // 203.0.113.0/24 is TEST-NET-3 — never the injected client address
      payload: { sessionIpPolicy: "enforce_at_login", sessionIpAllowlist: ["203.0.113.0/24"] },
    });
    expect(set.statusCode).toBe(200);
    try {
      const { res } = await roundTrip(p.id, { email });
      expect(res.statusCode).toBe(401);
      expect(res.json().error).toBe("ip_not_allowed");
      expect(res.cookies.find((c) => c.name === "regulait_session")).toBeUndefined();
      const audit = await latestAudit("ip-policy-login-denied");
      expect((audit!.detail as Record<string, unknown>).method).toBe("saml");
    } finally {
      await app.inject({
        method: "PUT", headers: AUTH, url: "/v1/org/settings",
        payload: { sessionIpPolicy: "off", sessionIpAllowlist: [] },
      });
    }
  });

  it("a 'saml' session NEVER receives the ADR-0028 current-password bypass", async () => {
    const p = await mkProvider();
    const email = `sam.bypass.${randomBytes(3).toString("hex")}@corp.example`;
    const userId = await mkUser(email, "Sam Bypass");
    // the account is in the very recovery state that opens the bypass for an
    // API-KEY session: no password hash at all
    const [before] = await db.select().from(users).where(eq(users.id, userId));
    expect(before!.passwordHash).toBeNull();
    const { res } = await roundTrip(p.id, { email });
    expect(res.statusCode).toBe(302);
    const cookie = cookieOf(res);
    const me = await app.inject({ method: "GET", url: "/auth/me", cookies: { regulait_session: cookie } });
    expect(me.json().sessionOrigin).toBe("saml");
    expect(me.json().passwordChangeRequiresCurrent).toBe(true);
    const change = await app.inject({
      method: "POST", url: "/auth/change-password",
      headers: { "x-regulait-csrf": "1" },
      cookies: { regulait_session: cookie },
      payload: { newPassword: "A-Brand-New-Password-9" },
    });
    // no current password, no bypass: the SSO origin fails closed exactly like
    // 'oidc' and 'unknown' do
    expect(change.statusCode).toBe(409);
    expect(change.json().error).toBe("no_password_set");
  });
});

describe("ADR-0036 — verified-assertion readers (unit)", () => {
  it("reads the ID, NotOnOrAfter and every Recipient off the parsed assertion", () => {
    const assertion = {
      $: { ID: "_abc" },
      Conditions: [{ $: { NotOnOrAfter: "2030-01-01T00:00:00Z" } }],
      Subject: [
        {
          SubjectConfirmation: [
            { SubjectConfirmationData: [{ $: { Recipient: "https://a.example/acs" } }] },
            { SubjectConfirmationData: [{ $: { Recipient: "https://b.example/acs" } }] },
          ],
        },
      ],
    };
    expect(assertionIdentity(assertion).id).toBe("_abc");
    expect(assertionIdentity(assertion).notOnOrAfter?.toISOString()).toBe("2030-01-01T00:00:00.000Z");
    expect(assertionRecipients(assertion)).toEqual([
      "https://a.example/acs",
      "https://b.example/acs",
    ]);
  });

  it("treats a missing ID / missing Recipient as absent rather than inventing one", () => {
    expect(assertionIdentity(null)).toEqual({ id: null, notOnOrAfter: null });
    expect(assertionRecipients(null)).toEqual([]);
    expect(assertionRecipients({ Subject: [{}] })).toEqual([]);
  });
});

// ===========================================================================
// ADR-0167 (AUTHZ-04) — the login is bound to the browser that started it
// ===========================================================================
//
// The ACS claimed the correlation row by RelayState alone and minted a session
// for whoever posted it, so an attacker who started a login, authenticated at
// the IdP and handed the resulting POST to a victim signed the victim in as
// THEMSELVES. The binding is a `SameSite=None; Secure` cookie set at /start —
// the ACS is a cross-site POST, which a Lax cookie never accompanies — so it
// exists only over a genuinely secure request. This suite's `app` trusts no
// proxy and speaks plain http, so a second app behind one trusted hop carries
// `x-forwarded-proto: https`, exactly what Caddy sends upstream.
describe("ADR-0167 — the SP-initiated login completes only in the browser that started it", () => {
  const PROXY = "127.0.0.1";
  const HTTPS_BASE = "https://localhost:80";
  const SP_ENTITY_HTTPS = spEntityId(HTTPS_BASE, {} as NodeJS.ProcessEnv);
  const TLS = { "x-forwarded-proto": "https" };
  let proxied: ReturnType<typeof buildApp>;

  beforeAll(async () => {
    proxied = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY, trustProxy: [PROXY] });
    await proxied.ready();
  });
  afterAll(async () => {
    await proxied.close();
  });

  /** /start over TLS: the correlation row plus the binding cookie the browser would hold */
  const startSecure = async (providerId: string) => {
    const r = await proxied.inject({ method: "GET", url: `/auth/saml/${providerId}/start?returnTo=/app`, headers: TLS });
    expect(r.statusCode).toBe(302);
    const relayState = new URL(r.headers.location as string).searchParams.get("RelayState")!;
    const [row] = await db.select().from(samlLoginStates).where(eq(samlLoginStates.relayState, relayState));
    expect(row).toBeTruthy();
    const binding = r.cookies.find((c) => c.name === "regulait_saml_login");
    const setCookie = ([] as string[]).concat(r.headers["set-cookie"] as string | string[]).join("\n");
    return { relayState, requestId: row!.requestId, binding, setCookie };
  };

  const postSecureAcs = (providerId: string, signedXml: string, relayState: string, cookie?: string) =>
    proxied.inject({
      method: "POST",
      url: `/auth/saml/${providerId}/acs`,
      headers: { ...FORM, ...TLS, ...(cookie ? { cookie } : {}) },
      payload:
        `SAMLResponse=${encodeURIComponent(Buffer.from(signedXml, "utf8").toString("base64"))}` +
        `&RelayState=${encodeURIComponent(relayState)}`,
    });

  it("over TLS, /start sets a SameSite=None; Secure binding cookie scoped to the login path; over plain http it sets none", async () => {
    const p = await mkProvider();
    const s = await startSecure(p.id);
    expect(s.binding).toBeTruthy();
    expect(s.setCookie).toContain("regulait_saml_login=");
    expect(s.setCookie).toContain("SameSite=None");
    expect(s.setCookie).toContain("Secure");
    expect(s.setCookie).toContain("HttpOnly");
    expect(s.setCookie).toContain("Path=/auth/saml");
    // plain http cannot carry a None cookie, so none is set and none is demanded
    const plain = await app.inject({ method: "GET", url: `/auth/saml/${p.id}/start?returnTo=/app` });
    expect(plain.statusCode).toBe(302);
    expect(plain.cookies.find((c) => c.name === "regulait_saml_login")).toBeUndefined();
  });

  it("the same signed assertion is REFUSED without the binding cookie (audited, before the XML is parsed) and ACCEPTED with it", async () => {
    const p = await mkProvider();
    const email = `bind-${randomBytes(4).toString("hex")}@saml-test.example`;
    await mkUser(email, "Bound User");
    const s = await startSecure(p.id);
    const { xml } = buildResponse({
      providerId: p.id,
      email,
      inResponseTo: s.requestId,
      audience: SP_ENTITY_HTTPS,
      recipient: `${HTTPS_BASE}/auth/saml/${p.id}/acs`,
    });
    const signed = signAssertion(xml, keyA);

    // the browser that started it: signed in
    const own = await postSecureAcs(p.id, signed, s.relayState, `regulait_saml_login=${s.binding!.value}`);
    expect(own.statusCode, own.body).toBe(302);
    expect(own.cookies.find((c) => c.name === "regulait_session")).toBeTruthy();

    // a second login, planted in the victim's browser: a valid, correlated,
    // signed response — and no cookie
    const s2 = await startSecure(p.id);
    const planted = signAssertion(
      buildResponse({
        providerId: p.id,
        email,
        inResponseTo: s2.requestId,
        audience: SP_ENTITY_HTTPS,
        recipient: `${HTTPS_BASE}/auth/saml/${p.id}/acs`,
      }).xml,
      keyA,
    );
    const victim = await postSecureAcs(p.id, planted, s2.relayState);
    expect(victim.statusCode).toBe(401);
    expect(victim.json().error).toBe("login_not_bound_to_this_browser");
    expect(victim.cookies.find((c) => c.name === "regulait_session")).toBeUndefined();
    const row = await latestAudit("saml-login-browser-mismatch");
    expect(row).toBeTruthy();
    expect((row!.detail as { bindingCookiePresent?: boolean }).bindingCookiePresent).toBe(false);

    // the mismatch SPENT the state (like the OIDC one): even the right browser
    // cannot complete that login any more — a planted RelayState is not retryable
    const retried = await postSecureAcs(p.id, planted, s2.relayState, `regulait_saml_login=${s2.binding!.value}`);
    expect(retried.statusCode).toBe(401);
    expect(retried.json().error).not.toBe("login_not_bound_to_this_browser");
    expect(retried.cookies.find((c) => c.name === "regulait_session")).toBeUndefined();

    // a forged value is a mismatch too
    const s3 = await startSecure(p.id);
    const forged = await postSecureAcs(p.id, planted, s3.relayState, "regulait_saml_login=not-the-hmac");
    expect(forged.statusCode).toBe(401);
    expect(forged.json().error).toBe("login_not_bound_to_this_browser");
  });
});
