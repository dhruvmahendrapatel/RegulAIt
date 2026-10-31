/**
 * ADR-0225 (P13 d) — OUTWARD TRUST PAGES, on a real database through the real app.
 *
 * Pinned:
 *  - shipped OFF: the public trust centre and the auditor portal answer 404, and publishing or granting is refused
 *    (409 trust_pages_disabled); drafting still works, so an admin can prepare before turning it on;
 *  - an AI system card is drafted from the use-case register and its systems' model cards; the draft states facts
 *    and uses no claim wording;
 *  - publishing refuses claim wording ("certified", "compliant", ...) and empty fields (422, audited as a denial);
 *    a published item is not edited in place; a stale version is 409;
 *  - publish and unpublish need the `settings_relax` step-up (an API key can never give one);
 *  - the public trust centre shows only published, public items, as snapshots with no internal id, no source and
 *    no person, and is cacheable; drafts and auditors-only items never appear; unpublishing removes an item;
 *  - auditor access: only published items can be granted; the sign-in link is shown once, stored only as its
 *    SHA-256, single use, needs the CSRF header, and opens an HttpOnly SameSite=Strict cookie scoped to
 *    /v1/auditor; the portal lists and serves only the grant's items (default-deny, a refusal is audited), every
 *    view is audited; unpublishing an item hides it from the auditor; revoking the grant ends the session; an
 *    expired link is refused; turning the setting off closes everything, sign-out included (L1);
 *  - review of #631: turning the setting off revokes every session and unused link for good, so on again revives none
 *    (M1); unpublishing removes the item from every grant, so an edit and republish never reaches an old grant (M2);
 *  - the route classes: the five portal routes are public, everything under /v1/trust is admin-only.
 *
 * Global state (M-068): the trust setting is put back to off and step-up to strict in afterAll; every row this file
 * created is removed.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  agents,
  aiUseCases,
  and,
  auditLog,
  auditorGrants,
  auditorLinks,
  createDb,
  desc,
  eq,
  inArray,
  modelCards,
  runMigrations,
  sql,
  trustCenterProfile,
  trustPublications,
  type Db,
} from "@regulait/db";
import { claimWordingProblems } from "@regulait/shared";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { relaxStepUpForTest } from "./testing/step-up-posture.js";
import { buildApp } from "./app.js";
import { routeAuthClass } from "./route-classes.js";
import { hashToken } from "./token-hash.js";
import { TRUST_RULE_IDS } from "./trust-pages.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `p13d-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const CSRF = { "x-regulait-csrf": "1" };
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
let db: Db;
let app: ReturnType<typeof buildApp>;
const users = {} as Record<"admin" | "member", { id: string; auth: { authorization: string } }>;
const created = { useCases: [] as string[], agents: [] as string[], publications: [] as string[], grants: [] as string[] };

type Method = "GET" | "PUT" | "POST" | "PATCH" | "DELETE";
const inject = (method: Method, url: string, headers: Record<string, string>, payload?: unknown) =>
  app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });
const admin = (method: Method, url: string, payload?: unknown) => inject(method, url, users.admin.auth, payload);

async function setTrustPages(on: boolean) {
  const r = await admin("PUT", "/v1/org/settings", { trustPagesEnabled: on });
  expect(r.statusCode, r.body).toBe(200);
}

async function lastAudit(ruleId: string, objectId?: string) {
  const [row] = await db
    .select()
    .from(auditLog)
    .where(objectId ? and(eq(auditLog.ruleId, ruleId), eq(auditLog.objectId, objectId)) : eq(auditLog.ruleId, ruleId))
    .orderBy(desc(auditLog.seq))
    .limit(1);
  return row;
}

async function mkUseCase(label: string): Promise<{ useCaseId: string; agentId: string }> {
  const [agent] = await db
    .insert(agents)
    .values({ name: `p13d agent ${label} ${RUN}`, provider: "mock", tier: 1 })
    .returning({ id: agents.id });
  created.agents.push(agent!.id);
  await db.insert(modelCards).values({
    agentId: agent!.id,
    intendedUse: "summarising support tickets",
    limitations: "May miss sarcasm in short messages.",
    dataClaims: { training_data: "provider states no customer data is used for training" },
    biasFairness: [{ dimension: "dialect", method: "counterfactual prompt set", status: "assessed" }],
    standardRefs: ["nist-ai-rmf:MEASURE-2.11"],
  });
  const now = new Date();
  const [uc] = await db
    .insert(aiUseCases)
    .values({
      name: `Ticket summariser ${label} ${RUN}`,
      description: "Summarises inbound support tickets for the support team.",
      businessContext: "Customer support",
      dataSensitivity: "internal",
      ownerUserId: users.admin.id,
      intendedAgentIds: [agent!.id],
      status: "approved",
      approvedAt: now,
      approvedUntil: new Date(now.getTime() + 180 * 86_400_000),
    } as typeof aiUseCases.$inferInsert)
    .returning({ id: aiUseCases.id });
  created.useCases.push(uc!.id);
  return { useCaseId: uc!.id, agentId: agent!.id };
}

async function draftCard(label: string) {
  const { useCaseId } = await mkUseCase(label);
  const r = await admin("POST", "/v1/trust/publications/from-use-case", { useCaseId });
  expect(r.statusCode, r.body).toBe(201);
  created.publications.push(r.json().id);
  return r.json() as { id: string; version: number; slug: string; title: string; content: Record<string, string>; sourceRef: string };
}

async function publish(id: string, version: number, audience: "public" | "auditors" = "public") {
  return admin("POST", `/v1/trust/publications/${id}/publish`, { expectedVersion: version, audience });
}

let restoreIdentity: (() => Promise<void>) | undefined;
let restoreStepUp: (() => Promise<void>) | undefined;
beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restoreIdentity = await relaxIdentityForTest(db, { mfaRequired: "off" });
  restoreStepUp = await relaxStepUpForTest(db);
  app = buildApp(db, { bootstrapToken: BOOT });
  for (const [k, isAdmin] of [["admin", true], ["member", false]] as const) {
    const u = await inject("POST", "/v1/users", AUTH, { email: `p13d-${k}-${RUN}@example.com`, displayName: `p13d ${k} ${RUN}`, isAdmin });
    expect(u.statusCode, u.body).toBe(201);
    const id = u.json().id as string;
    const token = (await inject("POST", `/v1/users/${id}/keys`, AUTH, { name: "p13d" })).json().token as string;
    users[k] = { id, auth: { authorization: `Bearer ${token}` } };
  }
  await db.execute(sql`UPDATE org_settings SET trust_pages_enabled = false`);
}, 120_000);

afterAll(async () => {
  await db.execute(sql`UPDATE org_settings SET trust_pages_enabled = false`);
  await restoreStepUp?.();
  await restoreIdentity?.();
  if (created.grants.length) await db.delete(auditorGrants).where(inArray(auditorGrants.id, created.grants));
  if (created.publications.length) await db.delete(trustPublications).where(inArray(trustPublications.id, created.publications));
  if (created.useCases.length) await db.delete(aiUseCases).where(inArray(aiUseCases.id, created.useCases));
  if (created.agents.length) await db.delete(agents).where(inArray(agents.id, created.agents));
  await db.delete(trustCenterProfile);
  app.server.closeAllConnections();
  await app.close();
});

// ---------------------------------------------------------------------------

describe("the wording guard (unit)", () => {
  it("finds claim words, whole-word and case-insensitive, and passes factual text", () => {
    expect(claimWordingProblems("We are ISO 42001 Certified.")).toEqual(["certified"]);
    expect(claimWordingProblems("This system is fully compliant and complies with the Act.")).toEqual(["compliant", "complies with"]);
    expect(claimWordingProblems("We guarantee uptime.")).toEqual(["guarantee"]);
    expect(claimWordingProblems("Access certification campaigns ran quarterly; 14 evidence records on file.")).toEqual([]);
    expect(claimWordingProblems("Uncertified")).toEqual([]);
  });
});

describe("route classes", () => {
  it("the portal routes are public; every /v1/trust route is admin-only", () => {
    for (const [m, u] of [
      ["GET", "/v1/trust-center"],
      ["POST", "/v1/auditor/session"],
      ["GET", "/v1/auditor/session"],
      ["DELETE", "/v1/auditor/session"],
      ["GET", "/v1/auditor/items/:slug"],
    ] as const) {
      expect(routeAuthClass(m, u), `${m} ${u}`).toBe("public");
    }
    for (const [m, u] of [
      ["GET", "/v1/trust/publications"],
      ["POST", "/v1/trust/publications/:publicationId/publish"],
      ["POST", "/v1/trust/auditor-grants"],
      ["PUT", "/v1/trust/profile"],
    ] as const) {
      expect(routeAuthClass(m, u), `${m} ${u}`).toBe("admin");
    }
  });

  it("a signed-in member who is not an admin is refused", async () => {
    const r = await inject("GET", "/v1/trust/publications", users.member.auth);
    expect(r.statusCode).toBe(403);
  });
});

describe("shipped off", () => {
  it("the public pages answer 404; publishing and granting are refused; drafting works", async () => {
    expect((await inject("GET", "/v1/trust-center", {})).statusCode).toBe(404);
    expect((await inject("POST", "/v1/auditor/session", CSRF, { token: "x" })).statusCode).toBe(404);
    expect((await inject("GET", "/v1/auditor/session", {})).statusCode).toBe(404);

    const d = await draftCard("off");
    expect(d.content.purpose).toContain("Summarises inbound support tickets");
    const pub = await publish(d.id, d.version);
    expect(pub.statusCode, pub.body).toBe(409);
    expect(pub.json().error).toBe("trust_pages_disabled");
    const g = await admin("POST", "/v1/trust/auditor-grants", {
      auditorName: "A",
      auditorEmail: "a@example.com",
      days: 5,
      publicationIds: [d.id],
    });
    expect(g.statusCode).toBe(409);
    const [row] = await db.select().from(trustPublications).where(eq(trustPublications.id, d.id));
    expect(row!.status).toBe("draft");
  });
});

describe("drafting an AI system card from the register", () => {
  it("fills every field from the use case and its model cards, factually, and records where it came from", async () => {
    const d = await draftCard("fields");
    expect(d.title).toContain("Ticket summariser");
    expect(d.sourceRef).toMatch(/^use_case:/);
    expect(d.content.limits).toContain("May miss sarcasm");
    expect(d.content.oversight).toContain("Approved through the organisation's AI review");
    expect(d.content.dataUse).toContain("Data sensitivity recorded for this use case: internal");
    expect(d.content.dataUse).toContain("as its provider states it");
    expect(d.content.evaluationSummary).toContain("dialect (counterfactual prompt set): assessed");
    expect(d.content.evaluationSummary).toContain("nist-ai-rmf:MEASURE-2.11");
    expect(claimWordingProblems(Object.values(d.content).join("\n"))).toEqual([]);
    expect(UUID_RE.test(Object.values(d.content).join("\n"))).toBe(false);
    const a = await lastAudit(TRUST_RULE_IDS.drafted, d.id);
    expect(a?.effect).toBe("allow");
  });

  it("an unknown or retired use case is 404", async () => {
    const r = await admin("POST", "/v1/trust/publications/from-use-case", { useCaseId: "00000000-0000-4000-8000-000000000001" });
    expect(r.statusCode).toBe(404);
  });
});

describe("publishing, with the pages on", () => {
  beforeAll(async () => {
    await setTrustPages(true);
    const r = await admin("PUT", "/v1/trust/profile", { displayName: `Example org ${RUN}`, intro: "How we use AI.", contactEmail: "trust@example.com" });
    expect(r.statusCode, r.body).toBe(200);
  });

  it("refuses claim wording and empty fields, audited as a denial; a stale version is 409", async () => {
    const d = await draftCard("claims");
    const e = await admin("PATCH", `/v1/trust/publications/${d.id}`, {
      expectedVersion: d.version,
      content: { ...d.content, oversight: "Our process is certified and fully compliant." },
    });
    expect(e.statusCode, e.body).toBe(200);
    const edited = e.json();
    expect(edited.version).toBe(d.version + 1);

    const stale = await publish(d.id, d.version);
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toBe("version_conflict");

    const refused = await publish(d.id, edited.version);
    expect(refused.statusCode, refused.body).toBe(422);
    expect(refused.json()).toMatchObject({ error: "claim_wording", words: ["certified", "compliant"] });
    const a = await lastAudit(TRUST_RULE_IDS.publishRefused, d.id);
    expect(a?.effect).toBe("deny");

    const blank = await admin("PATCH", `/v1/trust/publications/${d.id}`, {
      expectedVersion: edited.version,
      content: { ...d.content, limits: "  " },
    });
    const empty = await publish(d.id, blank.json().version);
    expect(empty.statusCode).toBe(422);
    expect(empty.json()).toMatchObject({ error: "incomplete_content", fields: ["limits"] });

    const wrongShape = await admin("PATCH", `/v1/trust/publications/${d.id}`, {
      expectedVersion: blank.json().version,
      content: { statement: "x", evidenceSummary: "y" },
    });
    expect(wrongShape.statusCode).toBe(400);
  });

  it("publishes a snapshot; the public page shows it with no id, source or person, cacheable; drafts and auditors-only items never appear", async () => {
    const pub = await draftCard("public");
    const draft = await draftCard("still-draft");
    const aud = await draftCard("auditors-only");
    const p = await publish(pub.id, pub.version);
    expect(p.statusCode, p.body).toBe(200);
    expect(p.json()).toMatchObject({ status: "published", audience: "public" });
    expect((await publish(aud.id, aud.version, "auditors")).statusCode).toBe(200);
    const a = await lastAudit(TRUST_RULE_IDS.published, pub.id);
    expect(a?.userId).toBe(users.admin.id);

    const tc = await inject("GET", "/v1/trust-center", {});
    expect(tc.statusCode).toBe(200);
    expect(tc.headers["cache-control"]).toBe("public, max-age=300");
    expect(tc.headers["set-cookie"]).toBeUndefined();
    const body = tc.json();
    expect(body.displayName).toBe(`Example org ${RUN}`);
    expect(body.disclaimer).toMatch(/not a certification/);
    const slugs = body.items.map((i: { slug: string }) => i.slug);
    expect(slugs).toContain(pub.slug);
    expect(slugs).not.toContain(draft.slug);
    expect(slugs).not.toContain(aud.slug);
    // nothing internal: no uuid anywhere, no source reference, no publisher
    expect(UUID_RE.test(tc.body)).toBe(false);
    expect(tc.body).not.toContain("use_case:");
    expect(tc.body).not.toContain("publishedBy");
    const item = body.items.find((i: { slug: string }) => i.slug === pub.slug);
    expect(Object.keys(item).sort()).toEqual(["content", "kind", "publishedAt", "slug", "title"]);
    expect(Object.keys(item.content).sort()).toEqual(["dataUse", "evaluationSummary", "limits", "oversight", "purpose"]);

    // a published item is never edited in place
    const inPlace = await admin("PATCH", `/v1/trust/publications/${pub.id}`, { expectedVersion: pub.version, title: "x" });
    expect(inPlace.statusCode).toBe(409);
    expect(inPlace.json().error).toBe("unpublish_first");
    expect((await admin("DELETE", `/v1/trust/publications/${pub.id}`)).statusCode).toBe(409);

    // unpublish: gone from the page, audited, and a new draft version
    const un = await admin("POST", `/v1/trust/publications/${pub.id}/unpublish`, { expectedVersion: pub.version });
    expect(un.statusCode, un.body).toBe(200);
    expect(un.json()).toMatchObject({ status: "draft", publishedAt: null, version: pub.version + 1 });
    expect((await lastAudit(TRUST_RULE_IDS.unpublished, pub.id))?.effect).toBe("allow");
    const after = (await inject("GET", "/v1/trust-center", {})).json();
    expect(after.items.map((i: { slug: string }) => i.slug)).not.toContain(pub.slug);

    // a draft can be deleted, audited
    const del = await admin("DELETE", `/v1/trust/publications/${draft.id}`);
    expect(del.statusCode).toBe(204);
    expect((await lastAudit(TRUST_RULE_IDS.deleted, draft.id))?.effect).toBe("allow");
  });

  it("the heading refuses claim wording", async () => {
    const r = await admin("PUT", "/v1/trust/profile", { displayName: "Accredited Example", intro: "" });
    expect(r.statusCode).toBe(422);
  });
});

describe("step-up (strict defaults)", () => {
  it("publish and unpublish need the settings_relax step-up, which an API key cannot give; nothing changes", async () => {
    const d = await draftCard("stepup");
    await restoreStepUp!();
    try {
      const r = await publish(d.id, d.version);
      expect(r.statusCode, r.body).toBe(403);
      expect(String(r.json().error)).toMatch(/step_up/);
      const [row] = await db.select().from(trustPublications).where(eq(trustPublications.id, d.id));
      expect(row!.status).toBe("draft");
    } finally {
      restoreStepUp = await relaxStepUpForTest(db);
    }
  });
});

describe("auditor access", () => {
  let inScope: { id: string; slug: string; version: number };
  let auditorsOnly: { id: string; slug: string; version: number };
  let outOfScope: { id: string; slug: string; version: number };

  beforeAll(async () => {
    await setTrustPages(true);
    const mk = async (label: string, audience: "public" | "auditors") => {
      const d = await draftCard(label);
      const p = await publish(d.id, d.version, audience);
      expect(p.statusCode, p.body).toBe(200);
      return { id: d.id, slug: d.slug, version: p.json().version as number };
    };
    inScope = await mk("scope", "public");
    auditorsOnly = await mk("aud", "auditors");
    outOfScope = await mk("outside", "public");
  });

  async function grant(publicationIds: string[], extra: Record<string, unknown> = {}) {
    const r = await admin("POST", "/v1/trust/auditor-grants", {
      auditorName: `Auditor ${RUN}`,
      auditorEmail: `auditor-${RUN}@example.com`,
      auditorOrganisation: "Example Audit LLP",
      days: 14,
      publicationIds,
      ...extra,
    });
    if (r.statusCode === 201) created.grants.push(r.json().grant.id);
    return r;
  }

  const tokenOf = (path: string) => path.split("#")[1]!;
  async function redeem(token: string, headers: Record<string, string> = CSRF) {
    return inject("POST", "/v1/auditor/session", headers, { token });
  }
  const cookieOf = (r: { headers: Record<string, unknown> }) => String(r.headers["set-cookie"]).split(";")[0]!;

  it("only published items can be granted", async () => {
    const d = await draftCard("unpublished-grant");
    const r = await grant([inScope.id, d.id]);
    expect(r.statusCode).toBe(422);
    expect(r.json()).toMatchObject({ error: "items_not_published", publicationIds: [d.id] });
  });

  it("link: shown once, stored as a hash, single use, CSRF header; the session reads only the grant's items, every view audited", async () => {
    const g = await grant([inScope.id, auditorsOnly.id]);
    expect(g.statusCode, g.body).toBe(201);
    const { grant: gr, link } = g.json();
    expect(link.shownOnce).toBe(true);
    expect(link.path).toMatch(/^\/ui\/audit#rgal_[0-9a-f]{64}$/);
    const token = tokenOf(link.path);
    const [stored] = await db.select().from(auditorLinks).where(eq(auditorLinks.grantId, gr.id));
    expect(stored!.tokenHash).toBe(hashToken(token));
    expect(JSON.stringify(stored)).not.toContain(token);
    expect((await lastAudit(TRUST_RULE_IDS.grantCreated, gr.id))?.effect).toBe("allow");

    // the list never returns a token
    const list = await admin("GET", "/v1/trust/auditor-grants");
    expect(list.body).not.toContain(token);

    expect((await redeem(token, {})).statusCode).toBe(403);
    const ok = await redeem(token);
    expect(ok.statusCode, ok.body).toBe(201);
    const setCookie = String(ok.headers["set-cookie"]);
    expect(setCookie).toMatch(/^regulait_auditor=rgas_[0-9a-f]{64}; Path=\/v1\/auditor; HttpOnly; SameSite=Strict; Max-Age=\d+/);
    expect(ok.headers["cache-control"]).toBe("no-store");
    const cookie = cookieOf(ok);

    const again = await redeem(token);
    expect(again.statusCode).toBe(401);
    expect((await lastAudit(TRUST_RULE_IDS.linkRefused, gr.id))?.effect).toBe("deny");

    const s = await inject("GET", "/v1/auditor/session", { cookie });
    expect(s.statusCode, s.body).toBe(200);
    expect(s.json().items.map((i: { slug: string }) => i.slug).sort()).toEqual([inScope.slug, auditorsOnly.slug].sort());
    expect(UUID_RE.test(s.body)).toBe(false);
    expect((await lastAudit(TRUST_RULE_IDS.portalOpened, gr.id))?.effect).toBe("allow");

    const view = await inject("GET", `/v1/auditor/items/${auditorsOnly.slug}`, { cookie });
    expect(view.statusCode, view.body).toBe(200);
    expect(view.headers["cache-control"]).toBe("no-store");
    expect(Object.keys(view.json()).sort()).toEqual(["content", "kind", "publishedAt", "slug", "title"]);
    const viewed = await lastAudit(TRUST_RULE_IDS.itemViewed, gr.id);
    expect((viewed!.detail as { publicationId: string }).publicationId).toBe(auditorsOnly.id);

    // default-deny: a published item outside the grant is 404, and the attempt is recorded
    const outside = await inject("GET", `/v1/auditor/items/${outOfScope.slug}`, { cookie });
    expect(outside.statusCode).toBe(404);
    expect((await lastAudit(TRUST_RULE_IDS.viewRefused, gr.id))?.effect).toBe("deny");

    // no cookie, or a forged one
    expect((await inject("GET", "/v1/auditor/session", {})).statusCode).toBe(401);
    expect((await inject("GET", "/v1/auditor/session", { cookie: `regulait_auditor=rgas_${"0".repeat(64)}` })).statusCode).toBe(401);

    // unpublishing an item hides it from the auditor
    const un = await admin("POST", `/v1/trust/publications/${inScope.id}/unpublish`, { expectedVersion: inScope.version });
    expect(un.statusCode, un.body).toBe(200);
    expect((await inject("GET", `/v1/auditor/items/${inScope.slug}`, { cookie })).statusCode).toBe(404);
    const relisted = (await inject("GET", "/v1/auditor/session", { cookie })).json();
    expect(relisted.items.map((i: { slug: string }) => i.slug)).toEqual([auditorsOnly.slug]);

    // the admin sees the views
    const detail = await admin("GET", `/v1/trust/auditor-grants/${gr.id}`);
    expect(detail.statusCode).toBe(200);
    expect(detail.json().grant.views).toBeGreaterThanOrEqual(1);
    expect(detail.json().activity.some((a: { ruleId: string }) => a.ruleId === TRUST_RULE_IDS.itemViewed)).toBe(true);

    // revoking ends the session now
    const rv = await admin("POST", `/v1/trust/auditor-grants/${gr.id}/revoke`);
    expect(rv.statusCode).toBe(200);
    expect(rv.json().changed).toBe(true);
    expect((await inject("GET", "/v1/auditor/session", { cookie })).statusCode).toBe(401);
    expect((await admin("POST", `/v1/trust/auditor-grants/${gr.id}/links`, {})).statusCode).toBe(409);
  });

  it("an expired link is refused; a new link revokes the earlier unused one; signing out ends the session", async () => {
    const g = await grant([auditorsOnly.id]);
    expect(g.statusCode, g.body).toBe(201);
    const gr = g.json().grant;
    const first = tokenOf(g.json().link.path);
    const again = await admin("POST", `/v1/trust/auditor-grants/${gr.id}/links`, { linkTtlHours: 2 });
    expect(again.statusCode, again.body).toBe(201);
    const second = tokenOf(again.json().link.path);
    expect((await redeem(first)).statusCode).toBe(401);

    // age the second link past its expiry (both timestamps move, so the TTL CHECK still holds)
    await db
      .update(auditorLinks)
      .set({ createdAt: new Date(Date.now() - 10 * 3_600_000), expiresAt: new Date(Date.now() - 3_600_000) })
      .where(eq(auditorLinks.tokenHash, hashToken(second)));
    expect((await redeem(second)).statusCode).toBe(401);

    const third = tokenOf((await admin("POST", `/v1/trust/auditor-grants/${gr.id}/links`, {})).json().link.path);
    const ok = await redeem(third);
    expect(ok.statusCode).toBe(201);
    const cookie = cookieOf(ok);
    expect((await inject("DELETE", "/v1/auditor/session", { cookie })).statusCode).toBe(403);
    const out = await inject("DELETE", "/v1/auditor/session", { cookie, ...CSRF });
    expect(out.statusCode).toBe(200);
    expect(String(out.headers["set-cookie"])).toContain("Max-Age=0");
    expect((await inject("GET", "/v1/auditor/session", { cookie })).statusCode).toBe(401);
  });

  it("M2 (review of #631): unpublish -> edit -> republish never reaches an existing grant; a new grant is needed", async () => {
    const d = await draftCard("m2");
    const p1 = await publish(d.id, d.version, "auditors");
    expect(p1.statusCode, p1.body).toBe(200);
    const g = await grant([d.id, auditorsOnly.id]);
    expect(g.statusCode, g.body).toBe(201);
    const gr = g.json().grant;
    const ok = await redeem(tokenOf(g.json().link.path));
    const cookie = cookieOf(ok);
    expect((await inject("GET", `/v1/auditor/items/${d.slug}`, { cookie })).statusCode).toBe(200);

    // unpublish, edit, republish (to a different audience): the old grant must not see the new content
    const un = await admin("POST", `/v1/trust/publications/${d.id}/unpublish`, { expectedVersion: p1.json().version });
    expect(un.statusCode, un.body).toBe(200);
    expect(un.json()).toMatchObject({ status: "draft" });
    const removed = await lastAudit(TRUST_RULE_IDS.grantItemRemoved, gr.id);
    expect((removed!.detail as { publicationId: string }).publicationId).toBe(d.id);
    const ed = await admin("PATCH", `/v1/trust/publications/${d.id}`, {
      expectedVersion: un.json().version,
      content: { ...d.content, purpose: "New wording nobody selected for this auditor." },
    });
    expect(ed.statusCode, ed.body).toBe(200);
    const re = await publish(d.id, ed.json().version, "public");
    expect(re.statusCode, re.body).toBe(200);

    const view = await inject("GET", `/v1/auditor/items/${d.slug}`, { cookie });
    expect(view.statusCode).toBe(404);
    expect(view.body).not.toContain("New wording");
    const listed = (await inject("GET", "/v1/auditor/session", { cookie })).json();
    expect(listed.items.map((i: { slug: string }) => i.slug)).toEqual([auditorsOnly.slug]);
    const detail = (await admin("GET", `/v1/trust/auditor-grants/${gr.id}`)).json();
    expect(detail.items.map((i: { id: string }) => i.id)).toEqual([auditorsOnly.id]);

    // a new grant for the republished item is the way back, and it shows the new content
    const g2 = await grant([d.id]);
    expect(g2.statusCode, g2.body).toBe(201);
    const c2 = cookieOf(await redeem(tokenOf(g2.json().link.path)));
    const v2 = await inject("GET", `/v1/auditor/items/${d.slug}`, { cookie: c2 });
    expect(v2.statusCode).toBe(200);
    expect(v2.json().content.purpose).toBe("New wording nobody selected for this auditor.");
  });

  it("turning the setting off closes the public page and the portal at once; sign-out answers 404 too (L1)", async () => {
    const g = await grant([auditorsOnly.id]);
    const ok = await redeem(tokenOf(g.json().link.path));
    const cookie = cookieOf(ok);
    await setTrustPages(false);
    expect((await inject("GET", "/v1/trust-center", {})).statusCode).toBe(404);
    expect((await inject("GET", "/v1/auditor/session", { cookie })).statusCode).toBe(404);
    expect((await inject("GET", `/v1/auditor/items/${auditorsOnly.slug}`, { cookie })).statusCode).toBe(404);
    const out = await inject("DELETE", "/v1/auditor/session", { cookie, ...CSRF });
    expect(out.statusCode).toBe(404);
    expect(out.json()).toEqual({ error: "not_found" });
  });

  it("M1 (review of #631): off ends every session and unused link for good; on again revives none", async () => {
    await setTrustPages(true);
    const g = await grant([auditorsOnly.id]);
    const cookie = cookieOf(await redeem(tokenOf(g.json().link.path)));
    // a second grant whose link is still unused
    const g2 = await grant([auditorsOnly.id]);
    const unused = tokenOf(g2.json().link.path);
    expect((await inject("GET", "/v1/auditor/session", { cookie })).statusCode).toBe(200);

    await setTrustPages(false);
    const off = await lastAudit("auditor-access-revoked-pages-off");
    expect((off!.detail as { sessionsRevoked: number }).sessionsRevoked).toBeGreaterThanOrEqual(1);
    expect((off!.detail as { linksRevoked: number }).linksRevoked).toBeGreaterThanOrEqual(1);
    const [link] = await db.select().from(auditorLinks).where(eq(auditorLinks.tokenHash, hashToken(unused)));
    expect(link!.revokedAt).not.toBeNull();

    await setTrustPages(true);
    expect((await inject("GET", "/v1/auditor/session", { cookie })).statusCode).toBe(401);
    expect((await redeem(unused)).statusCode).toBe(401);
    // the way back is a new link, with a step-up
    const fresh = await admin("POST", `/v1/trust/auditor-grants/${g.json().grant.id}/links`, {});
    expect(fresh.statusCode, fresh.body).toBe(201);
    expect((await redeem(tokenOf(fresh.json().link.path))).statusCode).toBe(201);
    await setTrustPages(false);
  });
});
