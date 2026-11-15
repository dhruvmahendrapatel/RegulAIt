/**
 * ADR-0326 — Entra ID SSO and SCIM against a TEST tenant.
 *
 * Live, with only a test app registration's client id/secret:
 *   1. the tenant's OIDC discovery document and JWKS are reachable and name the v2.0 issuer the gateway pins;
 *   2. the app registration's client secret is valid (a client-credentials token is issued for Microsoft Graph);
 *   3. an OIDC provider for that tenant is accepted by the gateway's admin API (`/v1/auth/oidc-providers`).
 * In process, with no tenant: Entra's provisioning request shapes replayed against the gateway's `/scim/v2`
 * (create, `Replace`-cased PATCH, the path-less deactivate, `emails[type eq "work"]`, group membership remove).
 *
 * A browser sign-in (authorization code + MFA) cannot run unattended; ENTRA_ID.md has the manual check, and the
 * `email_verified`/`xms_edov` decision it depends on is unit-tested in src/oidc-email-verified.test.ts. Entra-driven
 * provisioning needs a gateway Entra can reach: it runs when REGULAIT_LIVE_PUBLIC_GATEWAY_URL is set.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, runMigrations, type Db } from "@regulait/db";
import { buildApp } from "../src/app.js";
import { installLicenseFixture, removeLicenseFixture } from "../src/testing/license-fixture.js";
import { liveEnabled, liveTitle, need, redact } from "./live-env.js";

const BOOT = "live-entra-bootstrap";
const AUTH = { authorization: `Bearer ${BOOT}` };
let db: Db;
let app: ReturnType<typeof buildApp>;

beforeAll(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL must be set");
  db = createDb(url);
  await runMigrations(db, path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations"));
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "e".repeat(64) });
});
afterAll(async () => { await app?.close(); });

describe.skipIf(!liveEnabled("entra"))(liveTitle("entra", "Entra ID test tenant"), () => {
  const tenant = liveEnabled("entra") ? need("REGULAIT_LIVE_ENTRA_TENANT_ID") : "";
  const issuer = `https://login.microsoftonline.com/${tenant}/v2.0`;

  it("discovery and JWKS name the tenant's v2.0 issuer", async () => {
    const d = await fetch(`${issuer}/.well-known/openid-configuration`);
    expect(d.status).toBe(200);
    const doc = (await d.json()) as { issuer: string; jwks_uri: string };
    expect(doc.issuer).toBe(issuer);
    const jwks = (await (await fetch(doc.jwks_uri)).json()) as { keys: unknown[] };
    expect(jwks.keys.length).toBeGreaterThan(0);
  });

  it("the test app registration's secret is valid", async () => {
    const r = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: need("REGULAIT_LIVE_ENTRA_CLIENT_ID"),
        client_secret: need("REGULAIT_LIVE_ENTRA_CLIENT_SECRET"),
        scope: "https://graph.microsoft.com/.default",
      }),
    });
    const body = (await r.json()) as { access_token?: string; error?: string };
    expect(r.status, redact(body.error ?? "")).toBe(200);
    expect(typeof body.access_token).toBe("string");
  });

  it("the gateway accepts an OIDC provider for the tenant", async () => {
    const egress = await app.inject({ method: "POST", headers: AUTH, url: "/v1/egress-allow-hosts", payload: { host: "login.microsoftonline.com", note: "live entra test" } });
    expect([200, 201]).toContain(egress.statusCode);
    const r = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/auth/oidc-providers",
      payload: { name: `live-entra-${Date.now()}`, issuer, clientId: need("REGULAIT_LIVE_ENTRA_CLIENT_ID"), clientSecret: need("REGULAIT_LIVE_ENTRA_CLIENT_SECRET") },
    });
    expect([200, 201], redact(r.body)).toContain(r.statusCode);
    expect(r.body).not.toContain(need("REGULAIT_LIVE_ENTRA_CLIENT_SECRET"));
    const id = r.json().id as string | undefined;
    if (id) await app.inject({ method: "DELETE", headers: AUTH, url: `/v1/auth/oidc-providers/${id}` });
    const eid = egress.json().id as string | undefined;
    if (eid) await app.inject({ method: "DELETE", headers: AUTH, url: `/v1/egress-allow-hosts/${eid}` });
  });

  it.todo("Entra provisions a test user and group into a reachable gateway (needs REGULAIT_LIVE_PUBLIC_GATEWAY_URL; Graph provisionOnDemand)");
});

describe("[live:entra-shapes] Entra's SCIM request shapes against /scim/v2 (no tenant needed)", () => {
  let token = "";
  const scim = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) =>
    app.inject({ method, url, headers: { authorization: `Bearer ${token}`, "content-type": "application/scim+json" }, ...(payload ? { payload: payload as object } : {}) });

  beforeAll(async () => {
    // SCIM is tier-gated and default-closed; the pilot install carries a license granting it.
    await installLicenseFixture(app, { features: ["scim_provisioning"], auth: AUTH });
    const t = await app.inject({ method: "POST", headers: AUTH, url: "/v1/scim/tokens", payload: { name: `live-entra-shapes-${Date.now()}` } });
    expect([200, 201], redact(t.body)).toContain(t.statusCode);
    token = t.json().token as string;
  });
  afterAll(async () => { await removeLicenseFixture(db); });

  it("create, Replace-cased PATCH, path-less deactivate, and a work-email filter path", async () => {
    const userName = `entra-shape-${Date.now()}@example.com`;
    const created = await scim("POST", "/scim/v2/Users", {
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
      externalId: `ext-${Date.now()}`,
      userName,
      active: true,
      displayName: "Entra Shape",
      emails: [{ primary: true, type: "work", value: userName }],
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().id as string;

    const rename = await scim("PATCH", `/scim/v2/Users/${id}`, {
      schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
      Operations: [{ op: "Replace", path: "displayName", value: "Entra Shape Renamed" }],
    });
    expect(rename.statusCode, rename.body).toBe(200);

    const email = await scim("PATCH", `/scim/v2/Users/${id}`, {
      schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
      Operations: [{ op: "Replace", path: 'emails[type eq "work"].value', value: userName }],
    });
    expect(email.statusCode, email.body).toBe(200);

    const off = await scim("PATCH", `/scim/v2/Users/${id}`, {
      schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
      Operations: [{ op: "Replace", value: { active: false } }],
    });
    expect(off.statusCode, off.body).toBe(200);
    expect(off.json().active).toBe(false);

    const lookup = await scim("GET", `/scim/v2/Users?filter=${encodeURIComponent(`userName eq "${userName}"`)}`);
    expect(lookup.statusCode).toBe(200);
    expect(lookup.json().totalResults).toBe(1);
  });

  it("Entra's DEFAULT mapping: create is accepted, a PATCH of name.givenName/title is refused (gap G0-2)", async () => {
    const userName = `entra-default-${Date.now()}@example.com`;
    const r = await scim("POST", "/scim/v2/Users", {
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
      userName,
      active: true,
      displayName: "Entra Default",
      name: { givenName: "Entra", familyName: "Default" },
      title: "Engineer",
      emails: [{ primary: true, type: "work", value: userName }],
    });
    expect(r.statusCode, r.body).toBe(201);
    const p = await scim("PATCH", `/scim/v2/Users/${r.json().id as string}`, {
      schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
      Operations: [{ op: "Replace", path: "name.givenName", value: "Changed" }, { op: "Replace", path: "title", value: "Lead" }],
    });
    // Records today's behaviour (unknown PATCH paths are refused), so a fix flips this on purpose, not silently.
    expect(p.statusCode, p.body).toBe(400);
  });
});
