/**
 * ADR-0221 (PENDING P4) — THE SUPPLIER PORTAL, on a real database through the real app.
 *
 * Pinned:
 *  - off (the shipped default): every supplier route answers the same 404 as an unknown path, and no access can be
 *    granted; turning it on needs a settings_relax step-up under the strict defaults; turning it off revokes every
 *    live session and unused link;
 *  - a link is shown once, stored only as its sha256, spent on first use; every refused link gets one body;
 *  - the session cookie is HttpOnly, SameSite=Strict, scoped to the supplier API path; mutations need the CSRF
 *    header; a platform key does not open a supplier route and a supplier cookie does not open a platform route;
 *  - a supplier sees and writes only its own grant's vendor, framework and questionnaire;
 *  - files: type from the bytes and the extension together, size limit, the scan hook, stored as an envelope, and
 *    downloaded by an admin only as a no-sniff attachment;
 *  - accept writes an ADR-0084 attestation naming the supplier and the reviewer, through the same rules (a refusal
 *    rolls the decision back); reject needs a reason;
 *  - revoke and the idle window end a session; address rate limit.
 *
 * Global state (M-068): the setting and step-up are put back to strict, the test pack and the vendors are removed.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  aiVendors,
  and,
  auditLog,
  compliancePackControls,
  compliancePacks,
  createDb,
  eq,
  inArray,
  runMigrations,
  sql,
  supplierInvitations,
  supplierQuestionnaires,
  supplierSessions,
  supplierSubmissions,
  type Db,
} from "@regulait/db";
import { SUPPLIER_LINK_REFUSAL, SUPPLIER_SESSION_COOKIE, SUPPLIER_SESSION_REFUSAL } from "@regulait/shared";
import { buildApp } from "./app.js";
import { detectSupplierFileType } from "./supplier-portal.js";
import { routeAuthClass } from "./route-classes.js";
import { hashToken } from "./token-hash.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { relaxStepUpForTest } from "./testing/step-up-posture.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `sp-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = "b".repeat(64);
const FRAMEWORK = `sp-standard-${RUN}`;
const CONTROL = "sp:1.1-supplier-controls";
const CSRF = { "x-regulait-csrf": "1" };

let db: Db;
let app: ReturnType<typeof buildApp>;
let scanned: ReturnType<typeof buildApp>;
let limited: ReturnType<typeof buildApp>;
let restoreStepUp: (() => Promise<void>) | undefined;
let restoreIdentity: (() => Promise<void>) | undefined;
let admin: { id: string; auth: { authorization: string } };
const vendorIds: string[] = [];
let packId: string;

const rnd = () => Math.floor(Math.random() * 250) + 1;
const freshIp = () => `198.51.${rnd()}.${rnd()}`;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

async function propose(name: string): Promise<{ id: string; instanceId: string }> {
  const res = await app.inject({
    method: "POST",
    url: "/v1/vendors",
    headers: admin.auth,
    payload: { name: `${name} ${RUN}`, description: "synthetic supplier portal fixture", category: "ai_feature_vendor" },
  });
  expect(res.statusCode, res.body).toBe(201);
  vendorIds.push(res.json().id);
  return { id: res.json().id, instanceId: res.json().instance.id };
}

async function submitQuestionnaire(instanceId: string) {
  const left = await app.inject({ method: "POST", headers: admin.auth, url: `/v1/workflows/instances/${instanceId}/advance`, payload: { stageId: "plan" } });
  expect(left.statusCode, left.body).toBe(200);
  const art = await app.inject({
    method: "POST",
    headers: admin.auth,
    url: `/v1/workflows/instances/${instanceId}/artifacts`,
    payload: { stageId: "questionnaire", content: "# Vendor AI assessment questionnaire\n\nVendor-supplied answers." },
  });
  expect(art.statusCode, art.body).toBe(201);
}

async function grant(vendorId: string, extra: Record<string, unknown> = {}) {
  const res = await app.inject({
    method: "POST",
    url: `/v1/vendors/${vendorId}/supplier-access`,
    headers: admin.auth,
    payload: { email: `Contact-${RUN}@Supplier.example`, framework: FRAMEWORK, ...extra },
  });
  expect(res.statusCode, res.body).toBe(201);
  const url = res.json().link.url as string;
  return { accessId: res.json().access.id as string, token: url.slice(url.indexOf("#") + 1), body: res.json() };
}

async function signIn(token: string, a = app) {
  const res = await a.inject({ method: "POST", url: "/supplier/v1/session", headers: CSRF, payload: { token }, remoteAddress: freshIp() });
  const set = String(res.headers["set-cookie"] ?? "");
  const cookie = set.split(";")[0]!;
  return { res, set, cookie };
}

const supplier = (cookie: string, method: "GET" | "POST", url: string, payload?: unknown, headers: Record<string, string> = CSRF) =>
  app.inject({ method, url, headers: { cookie, ...headers }, ...(payload !== undefined ? { payload: payload as object } : {}), remoteAddress: freshIp() });

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restoreIdentity = await relaxIdentityForTest(db, { mfaRequired: "off" });
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
  scanned = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY, supplierFileScanner: async () => "rejected" });
  limited = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY, trustProxy: false, rateLimit: { enabled: true, globalMax: 100_000, apiKeyMax: 100_000 } });
  const u = await app.inject({ method: "POST", url: "/v1/users", headers: AUTH, payload: { email: `sp-admin-${RUN}@example.com`, displayName: "sp admin", isAdmin: true } });
  expect(u.statusCode, u.body).toBe(201);
  const key = await app.inject({ method: "POST", url: `/v1/users/${u.json().id}/keys`, headers: AUTH, payload: { name: "sp" } });
  admin = { id: u.json().id, auth: { authorization: `Bearer ${key.json().token}` } };
  // the framework's active pack, written as data (this suite's own framework name collides with nothing)
  const [p] = await db
    .insert(compliancePacks)
    .values({
      framework: FRAMEWORK,
      version: 1,
      title: "supplier portal test pack",
      description: "authored by the supplier portal suite",
      provenance: { source: "test suite", reviewedBy: null },
      status: "active",
    } as never)
    .returning({ id: compliancePacks.id });
  packId = p!.id;
  await db.insert(compliancePackControls).values({
    packId,
    controlRef: CONTROL,
    title: "Suppliers state their AI controls",
    coverage: "unaddressed",
    collector: "none",
    collectorParams: {},
    minEvidenceCount: 1,
    attestationRequired: true,
    ownerNote: null,
  } as never);
}, 120_000);

afterAll(async () => {
  await restoreStepUp?.();
  await db.execute(sql`UPDATE org_settings SET supplier_portal_enabled = false`);
  await restoreIdentity?.();
  if (vendorIds.length) await db.delete(aiVendors).where(inArray(aiVendors.id, vendorIds));
  await db.delete(supplierQuestionnaires).where(sql`${supplierQuestionnaires.name} like ${`sp-q-${RUN}%`}`);
  await db.delete(compliancePackControls).where(eq(compliancePackControls.packId, packId));
  await db.delete(compliancePacks).where(eq(compliancePacks.id, packId));
  await db.execute(sql`delete from rate_limit_counters where bucket like 'sp:%'`);
  for (const a of [app, scanned, limited]) {
    a.server.closeAllConnections();
    await a.close();
  }
});

describe("the portal is off until an admin turns it on with a step-up", () => {
  it("off: every supplier route is the unknown-path 404, and no access can be granted", async () => {
    // what a route that does not exist answers a credentialed caller (an anonymous one is refused before routing)
    const unknown = await app.inject({ method: "GET", url: "/supplier/v1/nothing-here", headers: admin.auth });
    expect(unknown.statusCode).toBe(404);
    for (const [method, url] of [["GET", "/supplier/v1/assessment"], ["POST", "/supplier/v1/session"], ["POST", "/supplier/v1/submissions"]] as const) {
      const res = await app.inject({ method, url, headers: CSRF, payload: method === "POST" ? {} : undefined });
      expect(res.statusCode).toBe(404);
      expect({ ...res.json(), message: "" }).toEqual({ ...unknown.json(), message: "" });
    }
    const v = await propose("sp-off");
    const res = await app.inject({ method: "POST", url: `/v1/vendors/${v.id}/supplier-access`, headers: admin.auth, payload: { email: "a@b.example", framework: FRAMEWORK } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("supplier_portal_disabled");
  });

  it("turning it on is refused without a step-up under the strict defaults, and audited as a relaxation once allowed", async () => {
    const refused = await app.inject({ method: "PUT", url: "/v1/supplier-portal/settings", headers: admin.auth, payload: { enabled: true } });
    expect(refused.statusCode).toBeGreaterThanOrEqual(400);
    expect((await app.inject({ method: "GET", url: "/v1/supplier-portal/settings", headers: admin.auth })).json().enabled).toBe(false);
    restoreStepUp = await relaxStepUpForTest(db);
    const on = await app.inject({ method: "PUT", url: "/v1/supplier-portal/settings", headers: admin.auth, payload: { enabled: true } });
    expect(on.statusCode, on.body).toBe(200);
    const [row] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.ruleId, "supplier-portal-setting"), eq(auditLog.userId, admin.id)));
    expect((row!.detail as { relaxed: string[] }).relaxed).toEqual(["supplierPortalEnabled"]);
  });

  it("the routes are classed honestly: supplier routes public to the platform hooks, admin routes admin", () => {
    expect(routeAuthClass("POST", "/supplier/v1/session")).toBe("public");
    expect(routeAuthClass("GET", "/supplier/v1/assessment")).toBe("public");
    expect(routeAuthClass("POST", "/v1/vendors/:vendorId/supplier-access")).toBe("admin");
    expect(routeAuthClass("PUT", "/v1/supplier-portal/settings")).toBe("admin");
    expect(routeAuthClass("GET", "/v1/vendors/:vendorId/supplier-submissions/:submissionId/file")).toBe("admin");
  });
});

describe("links and sessions", () => {
  it("a link is shown once, stored only as its hash, and spent on first use; refusals are uniform", async () => {
    const v = await propose("sp-links");
    const g = await grant(v.id);
    expect(g.token).toMatch(/^rglsi_[A-Za-z0-9_-]{43}$/);
    const [inv] = await db.select().from(supplierInvitations).where(eq(supplierInvitations.accessId, g.accessId));
    expect(inv!.tokenHash).toBe(hashToken(g.token));
    expect(JSON.stringify(inv)).not.toContain(g.token);
    const list = await app.inject({ method: "GET", url: `/v1/vendors/${v.id}/supplier-access`, headers: admin.auth });
    expect(list.body).not.toContain(g.token);
    expect(list.json().access[0].email).toBe(`contact-${RUN}@supplier.example`);

    const noCsrf = await app.inject({ method: "POST", url: "/supplier/v1/session", payload: { token: g.token }, remoteAddress: freshIp() });
    expect(noCsrf.statusCode).toBe(403);

    const first = await signIn(g.token);
    expect(first.res.statusCode, first.res.body).toBe(200);
    expect(first.set).toContain(`${SUPPLIER_SESSION_COOKIE}=rglss_`);
    expect(first.set).toContain("HttpOnly");
    expect(first.set).toContain("SameSite=Strict");
    expect(first.set).toContain("Path=/supplier/v1");

    const replay = await signIn(g.token);
    const bogus = await signIn(`rglsi_${"x".repeat(43)}`);
    const malformed = await signIn("not-a-token");
    for (const r of [replay, bogus, malformed]) {
      expect(r.res.statusCode).toBe(401);
      expect(r.res.json()).toEqual(SUPPLIER_LINK_REFUSAL);
    }
    const refusedAudit = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.objectId, g.accessId), eq(auditLog.ruleId, "supplier-link-refused")));
    expect(refusedAudit.length).toBe(1);
  });

  it("a platform key does not open a supplier route, and a supplier cookie does not open a platform route", async () => {
    const v = await propose("sp-boundary");
    const { cookie } = await signIn((await grant(v.id)).token);
    const withKey = await app.inject({ method: "GET", url: "/supplier/v1/assessment", headers: admin.auth, remoteAddress: freshIp() });
    expect(withKey.statusCode).toBe(401);
    expect(withKey.json()).toEqual(SUPPLIER_SESSION_REFUSAL);
    for (const url of ["/v1/vendors", `/v1/vendors/${v.id}/supplier-submissions`, "/auth/me"]) {
      const res = await app.inject({ method: "GET", url, headers: { cookie } });
      expect(res.statusCode, url).toBe(401);
    }
  });

  it("a supplier sees only its own grant: one vendor, one framework, its own answers", async () => {
    const a = await propose("sp-scope-a");
    const b = await propose("sp-scope-b");
    const sa = await signIn((await grant(a.id)).token);
    const sb = await signIn((await grant(b.id)).token);
    const posted = await supplier(sa.cookie, "POST", "/supplier/v1/submissions", { target: { kind: "control", controlRef: CONTROL }, statement: "A's answer" });
    expect(posted.statusCode, posted.body).toBe(201);
    const view = await supplier(sb.cookie, "GET", "/supplier/v1/assessment");
    expect(view.statusCode).toBe(200);
    expect(view.json().vendorName).toBe(`sp-scope-b ${RUN}`);
    expect(view.json().framework).toBe(FRAMEWORK);
    expect(view.json().controls.map((c: { controlRef: string }) => c.controlRef)).toEqual([CONTROL]);
    expect(view.json().submissions).toEqual([]);
    expect(view.body).not.toContain("A's answer");
    expect(view.headers["cache-control"]).toBe("no-store");
    const unknown = await supplier(sb.cookie, "POST", "/supplier/v1/submissions", { target: { kind: "control", controlRef: "other:9.9" }, statement: "x" });
    expect(unknown.statusCode).toBe(422);
    const noCsrf = await supplier(sb.cookie, "POST", "/supplier/v1/submissions", { target: { kind: "control", controlRef: CONTROL }, statement: "x" }, {});
    expect(noCsrf.statusCode).toBe(403);
  });

  it("revoking the grant ends the session and its unused links; the idle window ends a session", async () => {
    const v = await propose("sp-revoke");
    const g = await grant(v.id);
    const { cookie } = await signIn(g.token);
    expect((await supplier(cookie, "GET", "/supplier/v1/assessment")).statusCode).toBe(200);
    const relink = await app.inject({ method: "POST", url: `/v1/vendors/${v.id}/supplier-access/${g.accessId}/links`, headers: admin.auth, payload: {} });
    expect(relink.statusCode, relink.body).toBe(201);
    const revoked = await app.inject({ method: "POST", url: `/v1/vendors/${v.id}/supplier-access/${g.accessId}/revoke`, headers: admin.auth, payload: { reason: "contract ended" } });
    expect(revoked.statusCode, revoked.body).toBe(200);
    expect((await supplier(cookie, "GET", "/supplier/v1/assessment")).statusCode).toBe(401);
    const url = relink.json().link.url as string;
    expect((await signIn(url.slice(url.indexOf("#") + 1))).res.statusCode).toBe(401);

    const v2 = await propose("sp-idle");
    const s2 = await signIn((await grant(v2.id)).token);
    await db.execute(sql`UPDATE supplier_sessions SET last_seen_at = now() - interval '31 minutes'
      WHERE access_id IN (SELECT id FROM supplier_access WHERE vendor_id = ${v2.id})`);
    expect((await supplier(s2.cookie, "GET", "/supplier/v1/assessment")).statusCode).toBe(401);
  });

  it("the address rate limit answers 429", async () => {
    const ip = freshIp();
    let last = 0;
    for (let i = 0; i < 62; i++) {
      last = (await limited.inject({ method: "POST", url: "/supplier/v1/session", headers: CSRF, payload: { token: "x" }, remoteAddress: ip })).statusCode;
    }
    expect(last).toBe(429);
  });
});

describe("evidence files", () => {
  it("detects the type from the bytes and requires the matching extension", () => {
    expect(detectSupplierFileType(PNG, "shot.png")).toBe("image/png");
    expect(detectSupplierFileType(PNG, "shot.pdf")).toBeNull();
    expect(detectSupplierFileType(Buffer.from("%PDF-1.7\n"), "report.PDF")).toBe("application/pdf");
    expect(detectSupplierFileType(Buffer.from("a,b\n1,2\n"), "data.csv")).toBe("text/csv");
    expect(detectSupplierFileType(Buffer.from("plain\n"), "notes.txt")).toBe("text/plain");
    expect(detectSupplierFileType(Buffer.from([0x4d, 0x5a, 0x90, 0x00]), "tool.txt")).toBeNull();
    expect(detectSupplierFileType(Buffer.from("<script>"), "page.html")).toBeNull();
    expect(detectSupplierFileType(Buffer.from([0xff, 0xfe, 0x00]), "bad.txt")).toBeNull();
  });

  it("stores an allowed file as an envelope, refuses the rest, and the scan hook can refuse", async () => {
    const v = await propose("sp-files");
    const g = await grant(v.id);
    const { cookie } = await signIn(g.token);
    const post = (file: { name: string; base64: string }) =>
      supplier(cookie, "POST", "/supplier/v1/submissions", { target: { kind: "control", controlRef: CONTROL }, statement: "see file", file });
    const ok = await post({ name: "evidence.png", base64: PNG.toString("base64") });
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json().file).toMatchObject({ contentType: "image/png", size: PNG.length, scanStatus: "not_scanned" });
    const [row] = await db.select().from(supplierSubmissions).where(eq(supplierSubmissions.id, ok.json().id));
    expect(row!.fileCiphertext).not.toContain(PNG.toString("base64"));
    expect((await post({ name: "evidence.exe", base64: PNG.toString("base64") })).json().error).toBe("file_type_not_allowed");
    expect((await post({ name: "x.txt", base64: "!!!!" })).json().error).toBe("file_unreadable");
    const big = Buffer.alloc(2 * 1024 * 1024 + 1, 0x41).toString("base64");
    expect((await post({ name: "big.txt", base64: big })).json().error).toBe("file_too_large");

    const s2 = await signIn((await grant(v.id)).token, scanned);
    const refused = await scanned.inject({
      method: "POST",
      url: "/supplier/v1/submissions",
      headers: { cookie: s2.cookie, ...CSRF },
      payload: { target: { kind: "control", controlRef: CONTROL }, statement: "x", file: { name: "e.png", base64: PNG.toString("base64") } },
      remoteAddress: freshIp(),
    });
    expect(refused.json().error).toBe("file_rejected");

    const dl = await app.inject({ method: "GET", url: `/v1/vendors/${v.id}/supplier-submissions/${ok.json().id}/file`, headers: admin.auth });
    expect(dl.statusCode).toBe(200);
    expect(dl.rawPayload.equals(PNG)).toBe(true);
    expect(dl.headers["content-disposition"]).toBe('attachment; filename="evidence.png"');
    expect(dl.headers["x-content-type-options"]).toBe("nosniff");
  });
});

describe("decisions flow into the ADR-0084 attestations", () => {
  it("accept records an attestation naming the supplier and the reviewer; a refused write rolls the decision back", async () => {
    const v = await propose("sp-accept");
    const g = await grant(v.id);
    const { cookie } = await signIn(g.token);
    const sub = await supplier(cookie, "POST", "/supplier/v1/submissions", { target: { kind: "control", controlRef: CONTROL }, statement: "We review model changes." });
    expect(sub.statusCode).toBe(201);
    const decide = (payload: unknown) =>
      app.inject({ method: "POST", url: `/v1/vendors/${v.id}/supplier-submissions/${sub.json().id}/decision`, headers: admin.auth, payload: payload as object });

    const early = await decide({ decision: "accept" });
    expect(early.statusCode).toBe(409);
    expect(early.json().error).toBe("questionnaire_not_submitted");
    const [still] = await db.select().from(supplierSubmissions).where(eq(supplierSubmissions.id, sub.json().id));
    expect(still!.status).toBe("submitted");

    await submitQuestionnaire(v.instanceId);
    const accepted = await decide({ decision: "accept" });
    expect(accepted.statusCode, accepted.body).toBe(200);
    const [vendor] = await db.select().from(aiVendors).where(eq(aiVendors.id, v.id));
    expect(vendor!.packAttestations).toHaveLength(1);
    expect(vendor!.packAttestations[0]).toMatchObject({
      controlRef: CONTROL,
      statement: "We review model changes.",
      recordedByUserId: admin.id,
      submittedBySupplier: { accessId: g.accessId, email: `contact-${RUN}@supplier.example`, submissionId: sub.json().id },
    });
    expect((await decide({ decision: "accept" })).json().error).toBe("already_decided");
  });

  it("reject needs a reason, and the supplier sees it", async () => {
    const v = await propose("sp-reject");
    const { cookie } = await signIn((await grant(v.id)).token);
    const sub = await supplier(cookie, "POST", "/supplier/v1/submissions", { target: { kind: "control", controlRef: CONTROL }, statement: "trust us" });
    const url = `/v1/vendors/${v.id}/supplier-submissions/${sub.json().id}/decision`;
    expect((await app.inject({ method: "POST", url, headers: admin.auth, payload: { decision: "reject" } })).statusCode).toBe(400);
    const res = await app.inject({ method: "POST", url, headers: admin.auth, payload: { decision: "reject", reason: "Attach the audit report." } });
    expect(res.statusCode, res.body).toBe(200);
    const view = await supplier(cookie, "GET", "/supplier/v1/assessment");
    expect(view.json().submissions[0]).toMatchObject({ status: "rejected", decisionReason: "Attach the audit report." });
  });

  it("a custom questionnaire is versioned, and an accepted answer to a mapped question becomes an attestation", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/v1/supplier-questionnaires",
      headers: admin.auth,
      payload: { name: `sp-q-${RUN}`, questions: [{ id: "training", prompt: "Do you train on our data?", controlRef: CONTROL }] },
    });
    expect(created.statusCode, created.body).toBe(201);
    const v2 = await app.inject({
      method: "POST",
      url: `/v1/supplier-questionnaires/${created.json().id}/versions`,
      headers: admin.auth,
      payload: { questions: [{ id: "training", prompt: "Do you train any model on our data?", controlRef: CONTROL, allowFile: true }] },
    });
    expect(v2.json().version).toBe(2);
    const v = await propose("sp-questionnaire");
    await submitQuestionnaire(v.instanceId);
    const { cookie } = await signIn((await grant(v.id, { questionnaireId: v2.json().id })).token);
    const view = await supplier(cookie, "GET", "/supplier/v1/assessment");
    expect(view.json().questionnaire).toMatchObject({ name: `sp-q-${RUN}`, version: 2 });
    const bad = await supplier(cookie, "POST", "/supplier/v1/submissions", { target: { kind: "question", questionId: "nope" }, statement: "x" });
    expect(bad.statusCode).toBe(422);
    const sub = await supplier(cookie, "POST", "/supplier/v1/submissions", { target: { kind: "question", questionId: "training" }, statement: "No." });
    expect(sub.statusCode, sub.body).toBe(201);
    const ok = await app.inject({ method: "POST", url: `/v1/vendors/${v.id}/supplier-submissions/${sub.json().id}/decision`, headers: admin.auth, payload: { decision: "accept" } });
    expect(ok.json().attestation).toMatchObject({ controlRef: CONTROL, statement: "No." });
    const retired = await app.inject({ method: "POST", url: `/v1/supplier-questionnaires/${v2.json().id}/retire`, headers: admin.auth, payload: {} });
    expect(retired.json().changed).toBe(true);
    const refused = await app.inject({
      method: "POST",
      url: `/v1/vendors/${v.id}/supplier-access`,
      headers: admin.auth,
      payload: { email: "x@y.example", framework: FRAMEWORK, questionnaireId: v2.json().id },
    });
    expect(refused.json().error).toBe("questionnaire_not_available");
  });
});

describe("turning the portal off", () => {
  it("revokes every live session and unused link", async () => {
    const v = await propose("sp-switch-off");
    const { cookie } = await signIn((await grant(v.id)).token);
    const off = await app.inject({ method: "PUT", url: "/v1/supplier-portal/settings", headers: admin.auth, payload: { enabled: false } });
    expect(off.statusCode).toBe(200);
    const live = await db.select().from(supplierSessions).where(sql`${supplierSessions.revokedAt} IS NULL`);
    expect(live).toEqual([]);
    await app.inject({ method: "PUT", url: "/v1/supplier-portal/settings", headers: admin.auth, payload: { enabled: true } });
    expect((await supplier(cookie, "GET", "/supplier/v1/assessment")).statusCode).toBe(401);
  });
});
