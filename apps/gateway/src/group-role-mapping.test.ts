/**
 * ADR-0038 e2e — IdP group → RegulAIt role mapping, proof-by-attack.
 *
 * The feature is small; the ways it could quietly become a privilege-escalation
 * or a mass-deprovision are not. Every test below is an attempt to break one of
 * the invariants the ADR calls non-negotiable:
 *
 *  1. **DEFAULT-DENY.** An UNMAPPED group grants nothing — across all three
 *     sources, however many members it has and however it is named. There is no
 *     "default role for unmapped groups" to find.
 *  2. **ADDITIVE-ONLY.** A mapping enters at the `role_assignments` layer, so it
 *     confers exactly the mapped role's grants and nothing more. Asserted
 *     through the kernel (visible tools / `POST /v1/evaluate`), not by reading
 *     the row back — a row is not access.
 *  3. **AN ADMIN'S DIRECT ASSIGNMENT IS NEVER REMOVED BY A SYNC.** The
 *     load-bearing test in this file. Assign directly, then sync a state where
 *     the group no longer implies the role: the direct assignment survives and
 *     the user keeps the access.
 *  4. **THE MISSING-CLAIM FAIL-SAFE.** An assertion that OMITS the groups claim
 *     is "no group signal, don't reconcile" and existing group-derived roles
 *     survive; an assertion carrying an EMPTY groups array is an authoritative
 *     "member of nothing" and reconciles to zero. The difference between an IdP
 *     hiccup and an organisation-wide access strip, asserted explicitly.
 *  5. **ADR-0019 REVOCATIONS STILL WIN.** A per-user revocation beats a role a
 *     group mapping keeps re-adding — the coarse directory baseline never
 *     overrides the precise per-user carve-out.
 *  6. **NO GROUP CONFERS `isAdmin`.** Asserted behaviourally (the flag stays
 *     false through a sync) and structurally (the reconciliation module
 *     contains no reference to it at all — there is no code path, not merely an
 *     unexercised one).
 *
 * All three sources are driven for real: a SCIM group sync over the token trust
 * path, an OIDC callback against an in-test IdP that signs genuine id_tokens,
 * and a SAML ACS against an in-test IdP that mints genuine XML-DSig assertions
 * with a keypair generated at suite start.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash, createSign, generateKeyPairSync, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { SignedXml } from "xml-crypto";
import {
  and,
  assertedGroups,
  auditLog,
  createDb,
  desc,
  eq,
  groupRoleMappings,
  roleAssignments,
  sql,
  users,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";
import { installLicenseFixture, removeLicenseFixture } from "./testing/license-fixture.js";
import { spEntityId } from "./saml.js";
import { normalizeAssertedGroups } from "./group-roles.js";
import { relaxStrictAdmissionForTest } from "./testing/strict-admission.js";

// ADR-0181: this file pins behaviour against a LOCAL MCP double (127.0.0.1, registered
// seconds ago), not the strict admission defaults — relaxed explicitly, restored after.
let restoreStrictAdmission: (() => Promise<void>) | undefined;

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "grm-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = "e".repeat(64);
const FORM = { "content-type": "application/x-www-form-urlencoded" };
const SCIM_JSON = { "content-type": "application/scim+json" };

let db: Db;
let app: ReturnType<typeof buildApp>;
let SCIM_TOKEN: string;
let serverId: string;

const uniq = (label: string) => `${label}.${randomBytes(4).toString("hex")}@corp.example`;
const grp = (label: string) => `${label}-${randomBytes(4).toString("hex")}`;

// ---------------------------------------------------------------------------
// an in-test OIDC IdP that signs real id_tokens (the auth-suite rig, trimmed to
// what this file needs plus a configurable `groups` claim)
// ---------------------------------------------------------------------------

const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
interface CodeRecord {
  nonce: string;
  challenge: string | null;
  email: string;
  /** undefined = OMIT the claim entirely (the fail-safe case) */
  groups?: unknown;
  claimName: string;
}
const idp = {
  server: null as Server | null,
  issuer: "",
  clientId: "grm-test-client",
  clientSecret: "grm-test-secret",
  codes: new Map<string, CodeRecord>(),
};
const signJwt = (payload: Record<string, unknown>): string => {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const data = `${b64({ alg: "RS256", kid: "k1" })}.${b64(payload)}`;
  const sig = createSign("RSA-SHA256").update(data).sign(rsa.privateKey).toString("base64url");
  return `${data}.${sig}`;
};

async function startIdp(): Promise<void> {
  idp.server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", idp.issuer || "http://127.0.0.1");
    const json = (body: unknown, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/.well-known/openid-configuration") {
      return json({
        issuer: idp.issuer,
        authorization_endpoint: `${idp.issuer}/authorize`,
        token_endpoint: `${idp.issuer}/token`,
        jwks_uri: `${idp.issuer}/jwks`,
        response_types_supported: ["code"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
      });
    }
    if (url.pathname === "/jwks") {
      const jwk = rsa.publicKey.export({ format: "jwk" }) as Record<string, unknown>;
      return json({ keys: [{ ...jwk, kid: "k1", alg: "RS256", use: "sig" }] });
    }
    if (url.pathname === "/token" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const params = new URLSearchParams(body);
        const rec = idp.codes.get(params.get("code") ?? "");
        if (!rec) return json({ error: "invalid_grant" }, 400);
        idp.codes.delete(params.get("code") ?? "");
        const verifier = params.get("code_verifier");
        if (
          rec.challenge &&
          (verifier === null ||
            createHash("sha256").update(verifier).digest("base64url") !== rec.challenge)
        ) {
          return json({ error: "invalid_grant" }, 400);
        }
        const now = Math.floor(Date.now() / 1000);
        return json({
          access_token: "at-" + randomBytes(6).toString("hex"),
          token_type: "bearer",
          expires_in: 3600,
          id_token: signJwt({
            iss: idp.issuer,
            sub: "sub-" + rec.email,
            aud: idp.clientId,
            iat: now,
            exp: now + 300,
            nonce: rec.nonce,
            email: rec.email,
            email_verified: true,
            // the WHOLE point of the fail-safe test: `undefined` means the key
            // is absent from the id_token, not present-and-empty.
            ...(rec.groups === undefined ? {} : { [rec.claimName]: rec.groups }),
          }),
        });
      });
      return;
    }
    json({ error: "not_found" }, 404);
  });
  await new Promise<void>((resolve) => idp.server!.listen(0, "127.0.0.1", resolve));
  const addr = idp.server!.address();
  if (addr === null || typeof addr === "string") throw new Error("no idp port");
  idp.issuer = `http://127.0.0.1:${addr.port}`;
}

/** full OIDC round trip. `groups: undefined` OMITS the claim. */
const oidcLogin = async (
  providerId: string,
  email: string,
  claimName: string,
  groups: unknown,
) => {
  const start = await app.inject({ method: "GET", url: `/auth/oidc/${providerId}/start?returnTo=/app` });
  expect(start.statusCode).toBe(302);
  const authUrl = new URL(start.headers.location as string);
  const code = "code-" + randomBytes(8).toString("hex");
  idp.codes.set(code, {
    nonce: authUrl.searchParams.get("nonce")!,
    challenge: authUrl.searchParams.get("code_challenge"),
    email,
    groups,
    claimName,
  });
  // ADR-0167 (AUTHZ-04): the callback completes only in the browser that
  // started the login, so carry /start's binding cookie like a browser would
  const setCookie = start.headers["set-cookie"];
  const binding = (Array.isArray(setCookie) ? setCookie : [setCookie ?? ""]).map((c) => String(c).split(";")[0]).join("; ");
  return app.inject({
    method: "GET",
    url: `/auth/oidc/callback?code=${code}&state=${encodeURIComponent(authUrl.searchParams.get("state")!)}`,
    headers: { cookie: binding },
  });
};

// ---------------------------------------------------------------------------
// an in-test SAML IdP — a real keypair and a real XML-DSig, never a fixture
// ---------------------------------------------------------------------------

interface SigningKey {
  privateKey: string;
  certPem: string;
}
function makeSigningKey(cn: string): SigningKey {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const keyPem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  const dir = mkdtempSync(path.join(tmpdir(), "regulait-grm-test-only-"));
  try {
    const keyFile = path.join(dir, "k.pem");
    const certFile = path.join(dir, "c.pem");
    writeFileSync(keyFile, keyPem, { mode: 0o600 });
    execFileSync("openssl", [
      "req", "-x509", "-new", "-sha256", "-days", "1",
      "-key", keyFile, "-out", certFile, "-subj", `/CN=${cn}`,
    ]);
    return { privateKey: keyPem, certPem: readFileSync(certFile, "utf8").trim() };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

let samlKey: SigningKey;
const IDP_ENTITY = "https://grm-idp.test.example/metadata";
const BASE = "http://localhost:80";
const SP_ENTITY = spEntityId(BASE, {} as NodeJS.ProcessEnv);
const acsFor = (providerId: string) => `${BASE}/auth/saml/${providerId}/acs`;
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
const xmlEscape = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** a Response whose group attribute can be absent, empty, or multi-valued —
 * the three shapes the fail-safe distinguishes. */
function buildResponse(o: {
  providerId: string;
  email: string;
  inResponseTo: string;
  groupAttr?: string;
  /** undefined = the <Attribute> is ABSENT; [] = present with zero values */
  groups?: string[];
}): string {
  const assertionId = "_a" + randomBytes(12).toString("hex");
  const responseId = "_r" + randomBytes(12).toString("hex");
  const acs = acsFor(o.providerId);
  const inResp = ` InResponseTo="${xmlEscape(o.inResponseTo)}"`;
  const groupXml =
    o.groups === undefined || !o.groupAttr
      ? ""
      : `<saml:Attribute Name="${xmlEscape(o.groupAttr)}" NameFormat="urn:oasis:names:tc:SAML:2.0:attrname-format:basic">` +
        o.groups.map((g) => `<saml:AttributeValue>${xmlEscape(g)}</saml:AttributeValue>`).join("") +
        `</saml:Attribute>`;
  return (
    `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ` +
    `ID="${responseId}" Version="2.0" IssueInstant="${iso(0)}" Destination="${xmlEscape(acs)}"${inResp}>` +
    `<saml:Issuer>${xmlEscape(IDP_ENTITY)}</saml:Issuer>` +
    `<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>` +
    `<saml:Assertion ID="${assertionId}" Version="2.0" IssueInstant="${iso(0)}">` +
    `<saml:Issuer>${xmlEscape(IDP_ENTITY)}</saml:Issuer>` +
    `<saml:Subject>` +
    `<saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${xmlEscape(o.email)}</saml:NameID>` +
    `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">` +
    `<saml:SubjectConfirmationData NotOnOrAfter="${iso(5 * 60_000)}" Recipient="${xmlEscape(acs)}"${inResp}/>` +
    `</saml:SubjectConfirmation></saml:Subject>` +
    `<saml:Conditions NotBefore="${iso(-60_000)}" NotOnOrAfter="${iso(5 * 60_000)}">` +
    `<saml:AudienceRestriction><saml:Audience>${xmlEscape(SP_ENTITY)}</saml:Audience></saml:AudienceRestriction>` +
    `</saml:Conditions>` +
    `<saml:AuthnStatement AuthnInstant="${iso(0)}" SessionIndex="_s${randomBytes(6).toString("hex")}">` +
    `<saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext>` +
    `</saml:AuthnStatement>` +
    (groupXml ? `<saml:AttributeStatement>${groupXml}</saml:AttributeStatement>` : "") +
    `</saml:Assertion></samlp:Response>`
  );
}

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

const samlLogin = async (
  providerId: string,
  email: string,
  groupAttr?: string,
  groups?: string[],
) => {
  const start = await app.inject({ method: "GET", url: `/auth/saml/${providerId}/start?returnTo=/app` });
  expect(start.statusCode).toBe(302);
  const url = new URL(start.headers.location as string);
  const relayState = url.searchParams.get("RelayState")!;
  const { samlLoginStates } = await import("@regulait/db");
  const [row] = await db
    .select().from(samlLoginStates).where(eq(samlLoginStates.relayState, relayState));
  const signed = signAssertion(
    buildResponse({ providerId, email, inResponseTo: row!.requestId, groupAttr, groups }),
    samlKey,
  );
  return app.inject({
    method: "POST",
    url: `/auth/saml/${providerId}/acs`,
    headers: FORM,
    payload:
      `SAMLResponse=${encodeURIComponent(Buffer.from(signed, "utf8").toString("base64"))}` +
      `&RelayState=${encodeURIComponent(relayState)}`,
  });
};

// ---------------------------------------------------------------------------
// thin helpers
// ---------------------------------------------------------------------------

const mkUser = async (email: string): Promise<string> => {
  const r = await app.inject({
    method: "POST", headers: AUTH, url: "/v1/users",
    payload: { email, displayName: email.split("@")[0], isAdmin: false },
  });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().id;
};

/** a role that grants exactly one named tool on the suite's MCP server, so
 * "the user gained exactly that role's grants" is checkable through the kernel */
const mkRoleGrantingTool = async (name: string, toolName: string): Promise<string> => {
  const role = await app.inject({
    method: "POST", headers: AUTH, url: "/v1/roles", payload: { name },
  });
  expect(role.statusCode, role.body).toBe(201);
  const roleId = role.json().id as string;
  const grant = await app.inject({
    method: "POST", headers: AUTH, url: `/v1/roles/${roleId}/grants/tools`,
    payload: { serverId, toolName },
  });
  expect(grant.statusCode, grant.body).toBe(201);
  return roleId;
};

const mkMapping = async (source: string, externalGroup: string, roleId: string) => {
  const r = await app.inject({
    method: "POST", headers: AUTH, url: "/v1/group-role-mappings",
    payload: { source, externalGroup, roleId },
  });
  expect(r.statusCode, r.body).toBe(201);
  return r.json();
};

const assignments = (userId: string) =>
  db.select().from(roleAssignments).where(eq(roleAssignments.userId, userId));

const holdsRole = async (userId: string, roleId: string, origin?: "direct" | "group") => {
  const rows = await assignments(userId);
  return rows.filter((r) => r.roleId === roleId && (origin ? r.origin === origin : true));
};

/** the KERNEL's answer, not the row's: is this tool actually callable? */
const evaluate = async (userId: string, toolName: string) => {
  const r = await app.inject({
    method: "POST", headers: AUTH, url: "/v1/evaluate",
    payload: { userId, serverId, toolName },
  });
  expect(r.statusCode, r.body).toBe(200);
  return r.json().effect as string;
};

const visibleTools = async (userId: string): Promise<string[]> => {
  const r = await app.inject({
    method: "GET", headers: AUTH, url: `/v1/users/${userId}/servers/${serverId}/tools`,
  });
  expect(r.statusCode, r.body).toBe(200);
  return (r.json().tools as Array<{ name: string }>).map((t) => t.name).sort();
};

// ---- SCIM -----------------------------------------------------------------

const scimHeaders = () => ({ authorization: `Bearer ${SCIM_TOKEN}`, ...SCIM_JSON });
const scimPost = (url: string, payload: unknown) =>
  app.inject({ method: "POST", url, headers: scimHeaders(), payload: payload as object });
const scimPut = (url: string, payload: unknown) =>
  app.inject({ method: "PUT", url, headers: scimHeaders(), payload: payload as object });

/** create a synced group with an externalId (the mapping key) and members */
const scimGroup = async (externalId: string, members: string[]) => {
  const r = await scimPost("/scim/v2/Groups", {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
    displayName: externalId,
    externalId,
    members: members.map((id) => ({ value: id })),
  });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().id as string;
};
const scimSetMembers = async (groupId: string, displayName: string, members: string[]) => {
  const r = await scimPut(`/scim/v2/Groups/${groupId}`, {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
    displayName,
    members: members.map((id) => ({ value: id })),
  });
  expect(r.statusCode, r.body).toBe(200);
};

// ---------------------------------------------------------------------------

beforeAll(async () => {
  const { runMigrations } = await import("@regulait/db");
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restoreStrictAdmission = await relaxStrictAdmissionForTest(db);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
  // ADR-0052 §4: this suite both creates SAML providers and mints SCIM tokens,
  // and both flags are now ENFORCED at their creation routes — so it runs
  // under a real signed license granting them. Removed in afterAll.
  await installLicenseFixture(app, { features: ["sso_saml", "scim_provisioning"], auth: AUTH });
  samlKey = makeSigningKey("regulait-grm-test-idp");
  await startIdp();

  // the fake OIDC IdP is plaintext http on loopback — the same conscious
  // opt-in the auth suite makes (ADR-0043 default-deny egress).
  const egress = await app.inject({
    method: "POST", headers: AUTH, url: "/v1/egress-allow-hosts",
    payload: {
      host: "127.0.0.1", allowPrivateRanges: true, allowPlaintextHttp: true,
      note: "group-role-mapping suite: local fake OIDC IdP",
    },
  });
  expect([201, 409]).toContain(egress.statusCode);

  const server = await app.inject({
    method: "POST", headers: AUTH, url: "/v1/servers",
    payload: { name: "grm-server-" + randomBytes(3).toString("hex"), url: "http://127.0.0.1:9/mcp" },
  });
  expect(server.statusCode, server.body).toBe(201);
  serverId = server.json().id;
  for (const [name, kind] of [["read_ledger", "read"], ["post_journal", "write"]] as const) {
    const t = await app.inject({
      method: "POST", headers: AUTH, url: `/v1/servers/${serverId}/tools`,
      payload: { name, kind },
    });
    expect(t.statusCode, t.body).toBe(201);
  }

  const token = await app.inject({
    method: "POST", headers: AUTH, url: "/v1/scim/tokens",
    payload: { name: "grm-idp-" + randomBytes(3).toString("hex") },
  });
  expect(token.statusCode, token.body).toBe(201);
  SCIM_TOKEN = token.json().token;
}, 180_000);

afterAll(async () => {
  await restoreStrictAdmission?.();
  // The whole gateway suite shares ONE database (vitest.config.ts turns file
  // parallelism off for exactly that reason), so this file cleans up the global
  // state it created: enabled SSO providers would change what a LATER file's
  // sso_only lockout guard counts, and leftover mappings would change the
  // `mappedGroups` figure other files read. Per-user rows are scoped to
  // freshly-minted users and are harmless.
  await db.delete(groupRoleMappings);
  await db.delete(assertedGroups);
  await db.execute(sql`delete from oidc_providers where name like 'grm-%'`);
  await db.execute(sql`delete from saml_providers where name like 'grm-%'`);
  await removeLicenseFixture(db);
  await app?.close();
  await new Promise<void>((resolve) => idp.server?.close(() => resolve()) ?? resolve());
});

// ===========================================================================

describe("ADR-0038 — the missing-claim fail-safe, at the boundary", () => {
  it("distinguishes ABSENT (no signal) from EMPTY (authoritative none)", () => {
    // absent → null → reconciliation is SKIPPED and current state survives
    expect(normalizeAssertedGroups(undefined)).toBeNull();
    expect(normalizeAssertedGroups(null)).toBeNull();
    // present-but-empty → [] → authoritative "member of nothing"
    expect(normalizeAssertedGroups([])).toEqual([]);
    expect(normalizeAssertedGroups("")).toEqual([]);
    expect(normalizeAssertedGroups("   ")).toEqual([]);
    // present → the membership list, trimmed and de-duplicated
    expect(normalizeAssertedGroups(["Eng", " Eng ", "Fin"])).toEqual(["Eng", "Fin"]);
    expect(normalizeAssertedGroups("Eng,Fin; Ops")).toEqual(["Eng", "Fin", "Ops"]);
    expect(normalizeAssertedGroups("Solo")).toEqual(["Solo"]);
    // unparseable → null: a malformed assertion fails toward CURRENT STATE
    expect(normalizeAssertedGroups(42)).toBeNull();
    expect(normalizeAssertedGroups({ groups: ["Eng"] })).toBeNull();
  });
});

describe("ADR-0038 — SCIM group sync", () => {
  it("an UNMAPPED group grants nothing, however many members it has", async () => {
    const a = await mkUser(uniq("scim.unmapped.a"));
    const b = await mkUser(uniq("scim.unmapped.b"));
    const g = grp("Nobody-Mapped-This");
    await scimGroup(g, [a, b]);
    for (const u of [a, b]) {
      expect(await assignments(u)).toHaveLength(0);
      expect(await visibleTools(u)).toEqual([]);
    }
    // and it IS visible as an unmapped asserted group — inert, not invisible
    const report = await app.inject({
      method: "GET", headers: AUTH,
      url: "/v1/group-role-mappings/asserted-groups?source=scim&unmappedOnly=true",
    });
    expect(report.statusCode).toBe(200);
    const names = (report.json().assertedGroups as Array<{ externalGroup: string }>).map(
      (r) => r.externalGroup,
    );
    expect(names).toContain(g);
  });

  it("a MAPPED group assigns the role with origin='group' and confers exactly its grants", async () => {
    const u = await mkUser(uniq("scim.mapped"));
    const roleId = await mkRoleGrantingTool("grm-scim-reader-" + randomBytes(3).toString("hex"), "read_ledger");
    const g = grp("Finance-Readonly");
    await mkMapping("scim", g, roleId);

    expect(await visibleTools(u)).toEqual([]); // default-deny before the sync
    await scimGroup(g, [u]);

    const rows = await holdsRole(u, roleId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.origin).toBe("group");
    // through the KERNEL: exactly the role's one tool, and nothing beyond it
    expect(await visibleTools(u)).toEqual(["read_ledger"]);
    expect(await evaluate(u, "read_ledger")).toBe("allow");
    expect(await evaluate(u, "post_journal")).toBe("deny");
  });

  it("removing the user from the group in the IdP removes the derived assignment", async () => {
    const u = await mkUser(uniq("scim.removed"));
    const keep = await mkUser(uniq("scim.keeper"));
    const roleId = await mkRoleGrantingTool("grm-scim-leaver-" + randomBytes(3).toString("hex"), "read_ledger");
    const g = grp("Leavers");
    await mkMapping("scim", g, roleId);
    const groupId = await scimGroup(g, [u, keep]);
    expect(await evaluate(u, "read_ledger")).toBe("allow");

    await scimSetMembers(groupId, g, [keep]); // next full sync drops u
    expect(await holdsRole(u, roleId)).toHaveLength(0);
    expect(await evaluate(u, "read_ledger")).toBe("deny");
    // the member who stayed is untouched
    expect(await evaluate(keep, "read_ledger")).toBe("allow");
  });

  it("deleting the MAPPING removes the derived assignment on the next reconciliation", async () => {
    const u = await mkUser(uniq("scim.unmapped.later"));
    const roleId = await mkRoleGrantingTool("grm-scim-unmap-" + randomBytes(3).toString("hex"), "read_ledger");
    const g = grp("Was-Mapped");
    const mapping = await mkMapping("scim", g, roleId);
    const groupId = await scimGroup(g, [u]);
    expect(await evaluate(u, "read_ledger")).toBe("allow");

    const del = await app.inject({
      method: "DELETE", headers: AUTH, url: `/v1/group-role-mappings/${mapping.id}`,
    });
    expect(del.statusCode, del.body).toBe(200);
    // the assignment survives until the next reconciliation — ONE removal path
    expect(await holdsRole(u, roleId)).toHaveLength(1);
    await scimSetMembers(groupId, g, []); // any membership event reconciles
    expect(await holdsRole(u, roleId)).toHaveLength(0);
    expect(await evaluate(u, "read_ledger")).toBe("deny");
  });

  it("deleting the GROUP reconciles every former member back to default-deny", async () => {
    const u = await mkUser(uniq("scim.groupgone"));
    const roleId = await mkRoleGrantingTool("grm-scim-gone-" + randomBytes(3).toString("hex"), "read_ledger");
    const g = grp("Doomed");
    await mkMapping("scim", g, roleId);
    const groupId = await scimGroup(g, [u]);
    expect(await evaluate(u, "read_ledger")).toBe("allow");
    const del = await app.inject({
      method: "DELETE", url: `/scim/v2/Groups/${groupId}`, headers: scimHeaders(),
    });
    expect(del.statusCode).toBe(204);
    expect(await holdsRole(u, roleId)).toHaveLength(0);
    expect(await evaluate(u, "read_ledger")).toBe("deny");
  });

  it("a replayed full sync converges — no duplicate assignment rows", async () => {
    const u = await mkUser(uniq("scim.replay"));
    const roleId = await mkRoleGrantingTool("grm-scim-replay-" + randomBytes(3).toString("hex"), "read_ledger");
    const g = grp("Replayers");
    await mkMapping("scim", g, roleId);
    const groupId = await scimGroup(g, [u]);
    for (let i = 0; i < 3; i++) await scimSetMembers(groupId, g, [u]);
    expect(await holdsRole(u, roleId)).toHaveLength(1);
  });
});

// ===========================================================================

describe("ADR-0038 — an admin's DIRECT assignment is never removed by a sync", () => {
  it("survives the group no longer implying the role, and keeps the access", async () => {
    const u = await mkUser(uniq("both.ways"));
    const roleId = await mkRoleGrantingTool("grm-both-" + randomBytes(3).toString("hex"), "read_ledger");
    const g = grp("Also-Assigned-Directly");
    await mkMapping("scim", g, roleId);

    // held BOTH ways: an admin assignment AND a group mapping
    const direct = await app.inject({
      method: "POST", headers: AUTH, url: `/v1/users/${u}/roles`, payload: { roleId },
    });
    expect(direct.statusCode, direct.body).toBe(201);
    expect(direct.json().origin).toBe("direct");
    const groupId = await scimGroup(g, [u]);
    // two rows, one per origin — migration 0053's UNIQUE includes origin
    expect(await holdsRole(u, roleId)).toHaveLength(2);
    expect(await holdsRole(u, roleId, "direct")).toHaveLength(1);
    expect(await holdsRole(u, roleId, "group")).toHaveLength(1);

    // the IdP drops them from the group
    await scimSetMembers(groupId, g, []);
    // the group-derived row is gone; the ADMIN's is untouched...
    expect(await holdsRole(u, roleId, "group")).toHaveLength(0);
    expect(await holdsRole(u, roleId, "direct")).toHaveLength(1);
    // ...and the access it confers survives, which is the point
    expect(await evaluate(u, "read_ledger")).toBe("allow");
    expect(await visibleTools(u)).toEqual(["read_ledger"]);
  });

  it("unassign removes the admin row only, and refuses to pretend about a group-held role", async () => {
    const u = await mkUser(uniq("unassign.groupheld"));
    const roleId = await mkRoleGrantingTool("grm-unassign-" + randomBytes(3).toString("hex"), "read_ledger");
    const g = grp("Group-Held");
    await mkMapping("scim", g, roleId);
    await app.inject({ method: "POST", headers: AUTH, url: `/v1/users/${u}/roles`, payload: { roleId } });
    await scimGroup(g, [u]);

    const first = await app.inject({
      method: "DELETE", headers: AUTH, url: `/v1/users/${u}/roles/${roleId}`,
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().stillHeldViaGroup).toBe(true);
    expect(await holdsRole(u, roleId, "direct")).toHaveLength(0);

    // a second unassign is an honest 409, not a lie about having removed it
    const second = await app.inject({
      method: "DELETE", headers: AUTH, url: `/v1/users/${u}/roles/${roleId}`,
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toBe("role_group_derived");
    expect(await evaluate(u, "read_ledger")).toBe("allow"); // still group-held
  });

  it("role provenance names WHY the user holds it — direct, group, or both", async () => {
    const u = await mkUser(uniq("provenance"));
    const roleId = await mkRoleGrantingTool("grm-prov-" + randomBytes(3).toString("hex"), "read_ledger");
    const g = grp("Provenance-Group");
    const mapping = await mkMapping("scim", g, roleId);
    await app.inject({ method: "POST", headers: AUTH, url: `/v1/users/${u}/roles`, payload: { roleId } });
    await scimGroup(g, [u]);

    const r = await app.inject({
      method: "GET", headers: AUTH, url: `/v1/users/${u}/role-provenance`,
    });
    expect(r.statusCode, r.body).toBe(200);
    const body = r.json() as {
      isAdmin: boolean;
      isAdminGroupDerivable: boolean;
      roles: Array<{ roleId: string; provenance: string; origins: string[]; viaMappings?: Array<{ mappingId: string; externalGroup: string; currentlyAssertedViaScim: boolean }> }>;
    };
    const entry = body.roles.find((x) => x.roleId === roleId)!;
    expect(entry.provenance).toBe("both");
    expect(entry.origins).toEqual(["direct", "group"]);
    expect(entry.viaMappings?.[0]!.mappingId).toBe(mapping.id);
    expect(entry.viaMappings?.[0]!.externalGroup).toBe(g);
    expect(entry.viaMappings?.[0]!.currentlyAssertedViaScim).toBe(true);
    expect(body.isAdminGroupDerivable).toBe(false);
    expect(body.isAdmin).toBe(false);
  });
});

// ===========================================================================

describe("ADR-0038 — OIDC login, and the missing-claim fail-safe end to end", () => {
  const CLAIM = "groups";
  let providerId: string;

  beforeAll(async () => {
    const r = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/auth/oidc-providers",
      payload: {
        name: "grm-oidc-" + randomBytes(4).toString("hex"),
        issuerUrl: idp.issuer,
        clientId: idp.clientId,
        clientSecret: idp.clientSecret,
        groupsClaim: CLAIM,
      },
    });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().groupsClaim).toBe(CLAIM);
    providerId = r.json().id;
  });

  it("an UNMAPPED asserted group grants nothing", async () => {
    const email = uniq("oidc.unmapped");
    const u = await mkUser(email);
    const res = await oidcLogin(providerId, email, CLAIM, [grp("Random-Dept")]);
    expect(res.statusCode, res.body).toBe(302);
    expect(await assignments(u)).toHaveLength(0);
  });

  it("a MAPPED asserted group assigns the role with origin='group'", async () => {
    const email = uniq("oidc.mapped");
    const u = await mkUser(email);
    const roleId = await mkRoleGrantingTool("grm-oidc-" + randomBytes(3).toString("hex"), "read_ledger");
    const g = grp("OIDC-Engineering");
    await mkMapping("oidc", g, roleId);

    const res = await oidcLogin(providerId, email, CLAIM, [g, grp("Unmapped-Too")]);
    expect(res.statusCode, res.body).toBe(302);
    const rows = await holdsRole(u, roleId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.origin).toBe("group");
    expect(await evaluate(u, "read_ledger")).toBe("allow");
  });

  it("an id_token that OMITS the claim does NOT reconcile — the roles survive", async () => {
    const email = uniq("oidc.noclaim");
    const u = await mkUser(email);
    const roleId = await mkRoleGrantingTool("grm-oidc-keep-" + randomBytes(3).toString("hex"), "read_ledger");
    const g = grp("OIDC-Keepers");
    await mkMapping("oidc", g, roleId);
    await oidcLogin(providerId, email, CLAIM, [g]);
    expect(await holdsRole(u, roleId, "group")).toHaveLength(1);

    // the IdP has a bad day and drops the claim entirely
    const res = await oidcLogin(providerId, email, CLAIM, undefined);
    expect(res.statusCode, res.body).toBe(302);
    expect(await holdsRole(u, roleId, "group")).toHaveLength(1); // NOT stripped
    expect(await evaluate(u, "read_ledger")).toBe("allow");
  });

  it("an EMPTY groups array IS authoritative — it reconciles to zero", async () => {
    const email = uniq("oidc.emptyclaim");
    const u = await mkUser(email);
    const roleId = await mkRoleGrantingTool("grm-oidc-empty-" + randomBytes(3).toString("hex"), "read_ledger");
    const g = grp("OIDC-Emptied");
    await mkMapping("oidc", g, roleId);
    await oidcLogin(providerId, email, CLAIM, [g]);
    expect(await holdsRole(u, roleId, "group")).toHaveLength(1);

    const res = await oidcLogin(providerId, email, CLAIM, []);
    expect(res.statusCode, res.body).toBe(302);
    expect(await holdsRole(u, roleId, "group")).toHaveLength(0); // deprovisioned
    expect(await evaluate(u, "read_ledger")).toBe("deny");
  });

  it("a provider with NO groupsClaim configured never reconciles at all", async () => {
    const silent = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/auth/oidc-providers",
      payload: {
        name: "grm-oidc-silent-" + randomBytes(4).toString("hex"),
        issuerUrl: idp.issuer, clientId: idp.clientId, clientSecret: idp.clientSecret,
      },
    });
    expect(silent.statusCode, silent.body).toBe(201);
    expect(silent.json().groupsClaim).toBeNull();

    const email = uniq("oidc.silent");
    const u = await mkUser(email);
    const roleId = await mkRoleGrantingTool("grm-oidc-silent-" + randomBytes(3).toString("hex"), "read_ledger");
    const g = grp("OIDC-Silent");
    await mkMapping("oidc", g, roleId);
    // the assertion CARRIES the mapped group; the provider simply does not read it
    const res = await oidcLogin(silent.json().id, email, CLAIM, [g]);
    expect(res.statusCode, res.body).toBe(302);
    expect(await assignments(u)).toHaveLength(0);
  });
});

// ===========================================================================

describe("ADR-0038 — SAML login", () => {
  const ATTR = "memberOf";
  let providerId: string;

  beforeAll(async () => {
    const r = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/auth/saml-providers",
      payload: {
        name: "grm-saml-" + randomBytes(4).toString("hex"),
        entityId: IDP_ENTITY,
        idpSsoUrl: "https://grm-idp.test.example/sso",
        idpSigningCerts: [samlKey.certPem],
        groupsAttribute: ATTR,
      },
    });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().groupsAttribute).toBe(ATTR);
    providerId = r.json().id;
  });

  it("an UNMAPPED asserted group grants nothing", async () => {
    const email = uniq("saml.unmapped");
    const u = await mkUser(email);
    const res = await samlLogin(providerId, email, ATTR, [grp("SAML-Random")]);
    expect(res.statusCode, res.body).toBe(302);
    expect(await assignments(u)).toHaveLength(0);
  });

  it("a MAPPED asserted group assigns the role with origin='group' and confers its grants", async () => {
    const email = uniq("saml.mapped");
    const u = await mkUser(email);
    const roleId = await mkRoleGrantingTool("grm-saml-" + randomBytes(3).toString("hex"), "read_ledger");
    const g = grp("SAML-Analysts");
    await mkMapping("saml", g, roleId);

    const res = await samlLogin(providerId, email, ATTR, [g]);
    expect(res.statusCode, res.body).toBe(302);
    const rows = await holdsRole(u, roleId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.origin).toBe("group");
    expect(await evaluate(u, "read_ledger")).toBe("allow");
    expect(await evaluate(u, "post_journal")).toBe("deny");
  });

  it("an assertion that OMITS the attribute does NOT reconcile — the roles survive", async () => {
    const email = uniq("saml.noattr");
    const u = await mkUser(email);
    const roleId = await mkRoleGrantingTool("grm-saml-keep-" + randomBytes(3).toString("hex"), "read_ledger");
    const g = grp("SAML-Keepers");
    await mkMapping("saml", g, roleId);
    await samlLogin(providerId, email, ATTR, [g]);
    expect(await holdsRole(u, roleId, "group")).toHaveLength(1);

    const res = await samlLogin(providerId, email, ATTR, undefined); // attribute absent
    expect(res.statusCode, res.body).toBe(302);
    expect(await holdsRole(u, roleId, "group")).toHaveLength(1);
    expect(await evaluate(u, "read_ledger")).toBe("allow");
  });

  /**
   * The SAML analogue of "an empty groups array". Documented honestly, because
   * XML is not JSON: an `<Attribute>` element carrying literally ZERO
   * `<AttributeValue>` children does not survive XML→object parsing as an empty
   * value — it is indistinguishable from an absent attribute, and therefore
   * falls to the fail-safe (no signal, don't reconcile), which is the safe
   * direction. The shape a real IdP emits for "member of nothing" is an
   * attribute with a single EMPTY value, and that IS authoritative here.
   */
  it("an attribute PRESENT with an empty value is authoritative — it reconciles to zero", async () => {
    const email = uniq("saml.emptyattr");
    const u = await mkUser(email);
    const roleId = await mkRoleGrantingTool("grm-saml-empty-" + randomBytes(3).toString("hex"), "read_ledger");
    const g = grp("SAML-Emptied");
    await mkMapping("saml", g, roleId);
    await samlLogin(providerId, email, ATTR, [g]);
    expect(await holdsRole(u, roleId, "group")).toHaveLength(1);

    const res = await samlLogin(providerId, email, ATTR, [""]);
    expect(res.statusCode, res.body).toBe(302);
    expect(await holdsRole(u, roleId, "group")).toHaveLength(0);
    expect(await evaluate(u, "read_ledger")).toBe("deny");
  });

  it("a ZERO-CHILD attribute element falls to the fail-safe, not to deprovisioning", async () => {
    const email = uniq("saml.zerochild");
    const u = await mkUser(email);
    const roleId = await mkRoleGrantingTool("grm-saml-zero-" + randomBytes(3).toString("hex"), "read_ledger");
    const g = grp("SAML-ZeroChild");
    await mkMapping("saml", g, roleId);
    await samlLogin(providerId, email, ATTR, [g]);
    expect(await holdsRole(u, roleId, "group")).toHaveLength(1);

    // <Attribute Name="memberOf"/> — no AttributeValue children at all
    const res = await samlLogin(providerId, email, ATTR, []);
    expect(res.statusCode, res.body).toBe(302);
    // it does NOT read as "member of nothing": access survives, and the way to
    // deprovision is an assertion that actually says so (empty value above).
    expect(await holdsRole(u, roleId, "group")).toHaveLength(1);
    expect(await evaluate(u, "read_ledger")).toBe("allow");
  });

  it("the same mapping keyed to a DIFFERENT source does not fire (source is part of the key)", async () => {
    const email = uniq("saml.wrongsource");
    const u = await mkUser(email);
    const roleId = await mkRoleGrantingTool("grm-saml-src-" + randomBytes(3).toString("hex"), "read_ledger");
    const g = grp("Only-Mapped-For-Scim");
    await mkMapping("scim", g, roleId); // scim, not saml
    const res = await samlLogin(providerId, email, ATTR, [g]);
    expect(res.statusCode, res.body).toBe(302);
    expect(await assignments(u)).toHaveLength(0);
  });
});

// ===========================================================================

describe("ADR-0038 — composition with the rest of pillar 1", () => {
  it("an ADR-0019 per-user revocation BEATS a role a mapping keeps re-adding", async () => {
    const u = await mkUser(uniq("revoked.but.mapped"));
    const roleId = await mkRoleGrantingTool("grm-revoked-" + randomBytes(3).toString("hex"), "read_ledger");
    const g = grp("Revoked-Carveout");
    await mkMapping("scim", g, roleId);
    const groupId = await scimGroup(g, [u]);
    expect(await evaluate(u, "read_ledger")).toBe("allow");

    // the precise per-user carve-out
    const rev = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/revocations",
      payload: { userId: u, serverId, toolName: "read_ledger" },
    });
    expect(rev.statusCode, rev.body).toBe(201);
    expect(await evaluate(u, "read_ledger")).toBe("deny");

    // the mapping keeps re-adding the role on every sync — and never wins
    for (let i = 0; i < 3; i++) {
      await scimSetMembers(groupId, g, []);
      await scimSetMembers(groupId, g, [u]);
      expect(await holdsRole(u, roleId, "group")).toHaveLength(1);
      expect(await evaluate(u, "read_ledger")).toBe("deny");
    }
    expect(await visibleTools(u)).toEqual([]);
  });

  it("mapping is ADDITIVE — it cannot mint an entitlement the role does not carry", async () => {
    const u = await mkUser(uniq("additive"));
    // a role with NO grants at all
    const empty = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/roles",
      payload: { name: "grm-empty-" + randomBytes(3).toString("hex") },
    });
    expect(empty.statusCode).toBe(201);
    const roleId = empty.json().id as string;
    const g = grp("Maps-To-An-Empty-Role");
    await mkMapping("scim", g, roleId);
    await scimGroup(g, [u]);

    expect(await holdsRole(u, roleId, "group")).toHaveLength(1); // the role IS held
    expect(await visibleTools(u)).toEqual([]); // and it carries nothing
    expect(await evaluate(u, "read_ledger")).toBe("deny");
    expect(await evaluate(u, "post_journal")).toBe("deny");
  });

  it("NO group can confer isAdmin — behaviourally, and structurally", async () => {
    const u = await mkUser(uniq("never.admin"));
    const roleId = await mkRoleGrantingTool("grm-broad-" + randomBytes(3).toString("hex"), "post_journal");
    // a group named exactly like the escalation an attacker would try
    const g = "SOC-Admins-" + randomBytes(4).toString("hex");
    await mkMapping("scim", g, roleId);
    await scimGroup(g, [u]);

    expect(await holdsRole(u, roleId, "group")).toHaveLength(1);
    expect(await evaluate(u, "post_journal")).toBe("allow"); // the ROLE's grants, yes
    const [row] = await db.select().from(users).where(eq(users.id, u));
    expect(row!.isAdmin).toBe(false); // the platform admin bit, never
    const status = await app.inject({ method: "GET", headers: AUTH, url: "/v1/scim/status" });
    expect(status.json().isAdminGroupDerivable).toBe(false);
    expect(status.json().unmappedGroupsGrantEntitlement).toBe(false);

    // STRUCTURAL: there is no code path from a group to the admin bit. The
    // reconciler — the module every identity event actually runs — never names
    // the flag and never writes a `users` row, with comments stripped so the
    // assertion is about CODE and not about prose. An unexercised path is still
    // a path; this asserts there isn't one to exercise.
    const raw = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "group-roles.ts"),
      "utf8",
    );
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/isAdmin|is_admin/);
    expect(code).not.toMatch(/\.update\(users\)|\.insert\(users\)/);
    // it writes exactly one table, and reads the mapping table whose only
    // foreign key is to `roles`
    expect(code).not.toMatch(/\.insert\((?!roleAssignments|auditLog|assertedGroupsTable)/);
  });

  it("mapping to an unknown role is refused, and a duplicate mapping is a 409", async () => {
    const bogus = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/group-role-mappings",
      payload: { source: "scim", externalGroup: grp("X"), roleId: "00000000-0000-0000-0000-000000000000" },
    });
    expect(bogus.statusCode).toBe(422);
    expect(bogus.json().error).toBe("unknown_role");

    const roleId = await mkRoleGrantingTool("grm-dupe-" + randomBytes(3).toString("hex"), "read_ledger");
    const g = grp("Dupe");
    await mkMapping("scim", g, roleId);
    const again = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/group-role-mappings",
      payload: { source: "scim", externalGroup: g, roleId },
    });
    expect(again.statusCode).toBe(409);
    expect(await db.select().from(groupRoleMappings)
      .where(and(eq(groupRoleMappings.source, "scim"), eq(groupRoleMappings.externalGroup, g))))
      .toHaveLength(1);
  });

  it("one group may map to SEVERAL roles — the union of their baselines", async () => {
    const u = await mkUser(uniq("union"));
    const readRole = await mkRoleGrantingTool("grm-union-r-" + randomBytes(3).toString("hex"), "read_ledger");
    const writeRole = await mkRoleGrantingTool("grm-union-w-" + randomBytes(3).toString("hex"), "post_journal");
    const g = grp("Union-Group");
    await mkMapping("scim", g, readRole);
    await mkMapping("scim", g, writeRole);
    await scimGroup(g, [u]);
    expect(await holdsRole(u, readRole, "group")).toHaveLength(1);
    expect(await holdsRole(u, writeRole, "group")).toHaveLength(1);
    expect(await visibleTools(u)).toEqual(["post_journal", "read_ledger"]);
  });
});

// ===========================================================================

describe("ADR-0038 — audit", () => {
  it("every reconciliation names the event, the asserted groups and the mapping", async () => {
    const u = await mkUser(uniq("audited"));
    const roleId = await mkRoleGrantingTool("grm-audit-" + randomBytes(3).toString("hex"), "read_ledger");
    const g = grp("Audited-Group");
    const mapping = await mkMapping("scim", g, roleId);
    const groupId = await scimGroup(g, [u]);

    const [added] = await db
      .select().from(auditLog)
      .where(and(eq(auditLog.objectType, "group_role_mapping"), eq(auditLog.objectId, u)))
      .orderBy(desc(auditLog.at)).limit(1);
    expect(added).toBeTruthy();
    expect(added!.ruleId).toBe("group-role-reconciled");
    const d = added!.detail as Record<string, unknown>;
    expect(d.event).toBe("scim-group-sync");
    expect(d.source).toBe("scim");
    expect(d.assertedGroups).toEqual([g]);
    expect((d.mappingsFired as Array<{ mappingId: string }>)[0]!.mappingId).toBe(mapping.id);
    expect((d.assignmentsAdded as Array<{ roleId: string; origin: string }>)[0]).toMatchObject({
      roleId, origin: "group",
    });
    expect(added!.reason).toContain(g);
    expect(added!.reason).toContain("admin-direct assignments untouched");

    // ...and the REMOVAL is audited with its origin too
    await scimSetMembers(groupId, g, []);
    const [removedRow] = await db
      .select().from(auditLog)
      .where(and(eq(auditLog.objectType, "group_role_mapping"), eq(auditLog.objectId, u)))
      .orderBy(desc(auditLog.at)).limit(1);
    const rd = removedRow!.detail as Record<string, unknown>;
    expect(rd.assertedGroups).toEqual([]);
    expect((rd.assignmentsRemoved as Array<{ roleId: string; origin: string }>)[0]).toMatchObject({
      roleId, origin: "group",
    });
  });

  it("admin CRUD of a mapping is audited as group_role_mapping", async () => {
    const roleId = await mkRoleGrantingTool("grm-crud-" + randomBytes(3).toString("hex"), "read_ledger");
    const g = grp("CRUD-Group");
    const mapping = await mkMapping("scim", g, roleId);
    const [created] = await db
      .select().from(auditLog)
      .where(and(eq(auditLog.objectType, "group_role_mapping"), eq(auditLog.objectId, mapping.id)))
      .orderBy(desc(auditLog.at)).limit(1);
    expect(created!.ruleId).toBe("group-role-mapping-created");
    expect(created!.reason).toContain(g);

    await app.inject({ method: "DELETE", headers: AUTH, url: `/v1/group-role-mappings/${mapping.id}` });
    const [deleted] = await db
      .select().from(auditLog)
      .where(and(eq(auditLog.objectType, "group_role_mapping"), eq(auditLog.objectId, mapping.id)))
      .orderBy(desc(auditLog.at)).limit(1);
    expect(deleted!.ruleId).toBe("group-role-mapping-deleted");
  });

  it("sightings are recorded per source, so the unmapped report is real", async () => {
    const u = await mkUser(uniq("sighted"));
    const g = grp("Sighted-Only");
    await scimGroup(g, [u]);
    const [row] = await db
      .select().from(assertedGroups)
      .where(and(eq(assertedGroups.source, "scim"), eq(assertedGroups.externalGroup, g)));
    expect(row).toBeTruthy();
    expect(row!.seenCount).toBeGreaterThanOrEqual(1);

    const list = await app.inject({
      method: "GET", headers: AUTH, url: "/v1/group-role-mappings",
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().unmappedGroupsGrantEntitlement).toBe(false);
  });
});
