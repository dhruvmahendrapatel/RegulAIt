/**
 * ADR-0226 P2 batch D — the shared list contract on four more lists:
 *
 *  - `GET /v1/approvals` (paging, sort and totals) and its export, the Inbox's "Recently decided" download;
 *  - `GET /v1/usage-events` (Spend's invocations, Optimization's usage events) and its export;
 *  - `GET /v1/governance/decision-regression/cases` (the golden cases, built in memory) and its export;
 *  - `GET /v1/recommendations/access` with `rule` (one rule's findings, built in memory) and its export.
 *
 * Each: paging returns every row once in the requested order; the sort allow-list; the export holds exactly the
 * requested columns and is audited; the caller's scope holds (another person's rows never appear and never export,
 * and the admin-only lists refuse a non-admin with nothing audited); callers sending none of the new params get
 * the response they always got.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { strFromU8, unzipSync } from "fflate";
import { agentGrants, and, approvals, auditLog, createDb, desc, eq, gte, inArray, orgSettings, runMigrations, usageEvents, type Db } from "@regulait/db";
import { buildApp } from "./app.js";
import type { RecommendationJudge } from "@regulait/shared";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { relaxStepUpForTest } from "./testing/step-up-posture.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");
const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `p2d-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const DECIDED = "approved,denied,returned,consumed,superseded";

let db: Db;
let app: ReturnType<typeof buildApp>;
let restoreMfa: () => Promise<void>;
let restoreStepUp: () => Promise<void>;
let startedAt: Date;
const who = {} as Record<"a" | "b", { id: string; auth: { authorization: string } }>;
const approvalIds: string[] = [];
const usageIds: string[] = [];
const A_DECIDED = 23;
const A_USAGE = 27;

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const get = (url: string, headers: Record<string, string> = AUTH) => app.inject({ method: "GET", url, headers });

function readXlsx(buf: Buffer): Array<Array<string | number | null>> {
  const files = unzipSync(new Uint8Array(buf));
  const shared = files["xl/sharedStrings.xml"]
    ? [...strFromU8(files["xl/sharedStrings.xml"]).matchAll(/<si>(.*?)<\/si>/gs)].map((m) => [...m[1]!.matchAll(/<t(?:\s[^>]*)?>(.*?)<\/t>/gs)].map((t) => t[1]!).join(""))
    : [];
  const sheet = strFromU8(files["xl/worksheets/sheet1.xml"]!);
  return [...sheet.matchAll(/<row[^>]*>(.*?)<\/row>/gs)].map((row) =>
    [...row[1]!.matchAll(/<c r="[A-Z]+\d+"([^>]*?)(?:\/>|>(.*?)<\/c>)/gs)].map((c) => {
      const v = /<v>(.*?)<\/v>/s.exec(c[2] ?? "")?.[1];
      return v === undefined ? null : /t="s"/.test(c[1]!) ? shared[Number(v)]! : Number(v);
    }),
  );
}

async function walk(url: string, headers: Record<string, string>): Promise<Json[]> {
  const out: Json[] = [];
  let next = "";
  for (let guard = 0; guard < 200; guard++) {
    const res = await get(`${url}${next}`, headers);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as Json;
    out.push(...body.items);
    if (body.nextCursor) next = `&cursor=${encodeURIComponent(body.nextCursor)}`;
    else if (body.nextOffset !== null) next = `&offset=${body.nextOffset}`;
    else return out;
  }
  throw new Error("paging did not end");
}

const exportAudits = async (listId: string) =>
  (await db.select().from(auditLog).where(and(eq(auditLog.ruleId, "list-export-xlsx"), gte(auditLog.at, startedAt))).orderBy(desc(auditLog.at))).filter(
    (r) => (r.detail as Json).listId === listId,
  );

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restoreMfa = await relaxIdentityForTest(db, { mfaRequired: "off" });
  restoreStepUp = await relaxStepUpForTest(db);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "e".repeat(64) });
  startedAt = new Date(Date.now() - 1000);
  const names = { a: "Avery Approver", b: "Morgan Reyes" };
  for (const k of ["a", "b"] as const) {
    const u = await app.inject({ method: "POST", url: "/v1/users", headers: AUTH, payload: { email: `p2d-${k}-${RUN}@example.com`, displayName: `${names[k]} ${RUN}` } });
    expect(u.statusCode, u.body).toBe(201);
    const id = u.json().id as string;
    const key = await app.inject({ method: "POST", url: `/v1/users/${id}/keys`, headers: AUTH, payload: { name: "p2d" } });
    expect(key.statusCode, key.body).toBe(201);
    who[k] = { id, auth: { authorization: `Bearer ${key.json().token}` } };
  }
  const base = Date.parse("2026-02-01T00:00:00Z");
  const statuses = ["approved", "denied", "returned", "consumed", "superseded"] as const;
  const decided = (k: "a" | "b", n: number) =>
    Array.from({ length: n }, (_, i) => ({
      userId: who[k === "a" ? "b" : "a"].id,
      objectType: "run" as const,
      approverUserId: who[k].id,
      status: statuses[i % statuses.length]!,
      // three rows share one instant, so the id tie-breaker carries the order
      requestedAt: new Date(base + (i < 3 ? 0 : i) * 60_000),
      decidedBy: who[k].id,
      decidedAt: new Date(base + i * 60_000 + 30_000),
      decisionReason: `p2d ${k} ${i}`,
    }));
  const pending = { userId: who.b.id, objectType: "run" as const, approverUserId: who.a.id, status: "pending" as const, requestedAt: new Date(base) };
  const ins = await db.insert(approvals).values([...decided("a", A_DECIDED), ...decided("b", 4), pending]).returning({ id: approvals.id });
  approvalIds.push(...ins.map((r) => r.id));
  const usage = (k: "a" | "b", n: number) =>
    Array.from({ length: n }, (_, i) => ({
      userId: who[k].id,
      objectType: i % 4 === 0 ? "connector" : "agent",
      model: `p2d-model-${i % 3}`,
      inputTokens: i * 10,
      outputTokens: i,
      costUsd: i % 5 === 0 ? null : i * 0.01,
      at: new Date(base + (i < 3 ? 0 : i) * 60_000),
    }));
  const u = await db.insert(usageEvents).values([...usage("a", A_USAGE), ...usage("b", 6)]).returning({ id: usageEvents.id });
  usageIds.push(...u.map((r) => r.id));
}, 120_000);

afterAll(async () => {
  if (approvalIds.length) await db.delete(approvals).where(inArray(approvals.id, approvalIds));
  if (usageIds.length) await db.delete(usageEvents).where(inArray(usageEvents.id, usageIds));
  await restoreStepUp?.();
  await restoreMfa?.();
});

// ---- approvals ----------------------------------------------------------------

describe("P2d: the approvals queue", () => {
  it("pages every decided row the caller may see exactly once, newest first by the keyset", async () => {
    const rows = await walk(`/v1/approvals?status=${DECIDED}&limit=10&sort=requested&dir=desc`, who.a.auth);
    expect(rows).toHaveLength(A_DECIDED);
    expect(new Set(rows.map((r) => r.id)).size).toBe(A_DECIDED);
    const keys = rows.map((r) => `${r.requestedAt}|${r.id}`);
    expect(keys).toEqual([...keys].sort().reverse());
    // the enrichment the Inbox reads is on every row
    expect(rows[0]).toMatchObject({ approverName: `Avery Approver ${RUN}`, requestedByName: `Morgan Reyes ${RUN}`, decidedByName: `Avery Approver ${RUN}` });
    expect(rows.every((r) => r.status !== "pending")).toBe(true);
  });

  it("another person's rows never appear: a non-admin sees only their own, and approverUserId cannot widen it", async () => {
    const mine = await walk(`/v1/approvals?status=${DECIDED}&limit=50&sort=decided&dir=desc&count=exact`, who.a.auth);
    expect(mine.every((r) => r.approverUserId === who.a.id)).toBe(true);
    const widened = await get(`/v1/approvals?status=${DECIDED}&approverUserId=${who.b.id}&limit=10&count=exact&sort=decided`, who.a.auth);
    expect(widened.statusCode).toBe(200);
    expect(widened.json()).toMatchObject({ items: [], total: 0 });
    const asAdmin = await walk(`/v1/approvals?status=${DECIDED}&approverUserId=${who.b.id}&limit=10&sort=decided`, AUTH);
    expect(asAdmin).toHaveLength(4);
  });

  it("sorts by a person's name on the server (the subquery binds to the row, not the inner table)", async () => {
    const res = await get(`/v1/approvals?approverUserId=${who.a.id}&limit=50&sort=requester&dir=asc&count=exact`, AUTH);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as Json;
    expect(body.total).toBe(A_DECIDED + 1);
    expect(new Set(body.items.map((r: Json) => r.requestedByName))).toEqual(new Set([`Morgan Reyes ${RUN}`]));
    const byDecider = await get(`/v1/approvals?status=${DECIDED}&limit=50&sort=decider&dir=desc`, who.b.auth);
    expect(byDecider.json().items.map((r: Json) => r.decidedByName)).toEqual(Array(4).fill(`Morgan Reyes ${RUN}`));
  });

  it("refuses an unknown sort, the legacy `order` and a cursor on a non-date sort", async () => {
    expect((await get(`/v1/approvals?sort=approverUserId&limit=10`, who.a.auth)).json().error).toBe("unknown_sort_column");
    expect((await get(`/v1/approvals?sort=requested&order=asc`, who.a.auth)).statusCode).toBe(400);
    expect((await get(`/v1/approvals?sort=status&cursor=abc`, who.a.auth)).json().error).toBe("cursor_not_supported");
  });

  it("exports only the decided rows the caller may see, with the chosen columns in order, audited", async () => {
    const res = await get(`/v1/approvals/export.xlsx?status=${DECIDED}&sort=requested&dir=desc&columns=reason,approver,status`, who.a.auth);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers["content-type"]).toContain("spreadsheetml");
    const sheet = readXlsx(res.rawPayload);
    expect(sheet[0]).toEqual(["Reason", "Approver", "Status"]);
    expect(sheet).toHaveLength(1 + A_DECIDED);
    // every row is the caller's own: b's four decided rows and the pending row never export
    expect(sheet.slice(1).every((r) => r[1] === `Avery Approver ${RUN}` && String(r[0]).startsWith("p2d a "))).toBe(true);
    expect(sheet.slice(1).some((r) => r[2] === "pending")).toBe(false);
    // the same sort as the list: newest requested first
    const listed = await walk(`/v1/approvals?status=${DECIDED}&limit=50&sort=requested&dir=desc`, who.a.auth);
    expect(sheet.slice(1).map((r) => r[0])).toEqual(listed.map((r) => r.decisionReason));
    const [audit] = await exportAudits("approvals");
    expect(audit).toMatchObject({ userId: who.a.id, ruleId: "list-export-xlsx" });
    expect(audit!.detail).toMatchObject({ listId: "approvals", rows: A_DECIDED, columns: ["reason", "approver", "status"] });
  });

  it("the export cannot be widened: approverUserId names another person's rows and gets an empty, audited file", async () => {
    const before = (await exportAudits("approvals")).length;
    const res = await get(`/v1/approvals/export.xlsx?status=${DECIDED}&approverUserId=${who.b.id}&columns=reason`, who.a.auth);
    expect(res.statusCode, res.body).toBe(200);
    expect(readXlsx(res.rawPayload)).toEqual([["Reason"]]);
    const audits = await exportAudits("approvals");
    expect(audits).toHaveLength(before + 1);
    expect(audits[0]!.detail).toMatchObject({ rows: 0, filters: { approverUserId: who.b.id } });
    // an admin sees b's rows through the same filter
    const admin = await get(`/v1/approvals/export.xlsx?status=${DECIDED}&approverUserId=${who.b.id}&columns=reason,decider`);
    expect(admin.statusCode, admin.body).toBe(200);
    const sheet = readXlsx(admin.rawPayload);
    expect(sheet).toHaveLength(1 + 4);
    expect(sheet.slice(1).every((r) => r[1] === `Morgan Reyes ${RUN}`)).toBe(true);
  });

  it("refuses an unknown or repeated column, an unknown sort and the legacy `order`, and audits nothing", async () => {
    const before = (await exportAudits("approvals")).length;
    for (const [url, error] of [
      ["/v1/approvals/export.xlsx?columns=status,approverUserId", "unknown_column"],
      ["/v1/approvals/export.xlsx?columns=status,status", "duplicate_column"],
      ["/v1/approvals/export.xlsx?columns=status&sort=approverUserId", "unknown_sort_column"],
    ] as const) {
      const res = await get(url, who.a.auth);
      expect(res.statusCode, url).toBe(400);
      expect(res.json().error, url).toBe(error);
    }
    expect((await get(`/v1/approvals/export.xlsx?columns=status&order=asc`, who.a.auth)).statusCode).toBe(400);
    expect((await get(`/v1/approvals/export.xlsx`, who.a.auth)).statusCode).toBe(400);
    expect(await exportAudits("approvals")).toHaveLength(before);
  });

  it("an unauthenticated caller is refused and nothing is audited", async () => {
    const before = (await exportAudits("approvals")).length;
    const res = await get(`/v1/approvals/export.xlsx?columns=status`, {});
    expect(res.statusCode).toBe(401);
    expect(await exportAudits("approvals")).toHaveLength(before);
  });

  it("a caller who sends none of the new params gets the capped page it always got", async () => {
    const res = await get(`/v1/approvals?status=${DECIDED}`, who.a.auth);
    const body = res.json() as Json;
    expect(Object.keys(body).sort()).toEqual(["approvals", "hasMore", "limit", "total"]);
    expect(body).toMatchObject({ total: A_DECIDED, hasMore: false, limit: 100 });
    expect(body.approvals[0].decisionReason).toBe(`p2d a ${A_DECIDED - 1}`);
    const asc = (await get(`/v1/approvals?status=pending&order=asc`, who.a.auth)).json() as Json;
    expect(asc.approvals.some((r: Json) => approvalIds.includes(r.id))).toBe(true);
  });
});

// ---- usage events -------------------------------------------------------------

describe("P2d: the usage ledger", () => {
  it("pages every event of the caller exactly once; a non-admin's userId is forced to themselves", async () => {
    const rows = await walk(`/v1/usage-events?userId=${who.b.id}&limit=10&sort=at&dir=desc`, who.a.auth);
    expect(rows).toHaveLength(A_USAGE);
    expect(rows.every((r) => r.userId === who.a.id)).toBe(true);
    expect(rows[0]).toMatchObject({ userName: `Avery Approver ${RUN}` });
    const keys = rows.map((r) => `${new Date(r.at).toISOString()}|${r.id}`);
    expect(keys).toEqual([...keys].sort().reverse());
  });

  it("filters out connector rows on the server, sorts by cost with nulls last, and counts", async () => {
    const res = await get(`/v1/usage-events?excludeObjectType=connector&limit=50&sort=cost&dir=desc&count=exact`, who.a.auth);
    const body = res.json() as Json;
    const agents = Array.from({ length: A_USAGE }, (_, i) => i).filter((i) => i % 4 !== 0);
    expect(body.total).toBe(agents.length);
    expect(body.items.every((r: Json) => r.objectType === "agent")).toBe(true);
    const costs = body.items.map((r: Json) => r.costUsd);
    const firstNull = costs.indexOf(null);
    expect(costs.slice(firstNull).every((c: unknown) => c === null)).toBe(true);
    expect(costs.slice(0, firstNull)).toEqual([...costs.slice(0, firstNull)].sort((x: number, y: number) => y - x));
  });

  it("exports only the caller's events with the chosen columns, audited; a bootstrap caller with no user is refused as before", async () => {
    const res = await get(`/v1/usage-events/export.xlsx?userId=${who.b.id}&sort=at&dir=asc&columns=model,user,tokens`, who.a.auth);
    expect(res.statusCode, res.body).toBe(200);
    const sheet = readXlsx(res.rawPayload);
    expect(sheet[0]).toEqual(["Model served", "User", "Tokens in → out"]);
    expect(sheet).toHaveLength(1 + A_USAGE);
    expect(sheet.slice(1).every((r) => r[1] === `Avery Approver ${RUN}`)).toBe(true);
    const [audit] = await exportAudits("usage-events");
    expect(audit).toMatchObject({ userId: who.a.id });
    expect(audit!.detail).toMatchObject({ rows: A_USAGE, columns: ["model", "user", "tokens"] });
    expect((await get(`/v1/usage-events?sort=bogus`, who.a.auth)).statusCode).toBe(400);
    expect((await get(`/v1/usage-events?limit=10&sort=at&format=csv`, who.a.auth)).statusCode).toBe(400);
  });

  it("a caller who sends none of the new params gets the events and totals it always got", async () => {
    const body = (await get(`/v1/usage-events?limit=5`, who.a.auth)).json() as Json;
    expect(Object.keys(body).sort()).toEqual(["events", "totals"]);
    expect(body.events).toHaveLength(5);
    expect(body.totals.events).toBe(A_USAGE);
  });
});

// ---- golden cases (in memory) ------------------------------------------------

describe("P2d: the golden cases", () => {
  it("pages every live case once, in the requested order, with the same total as the legacy list", async () => {
    const legacy = (await get(`/v1/governance/decision-regression/cases`)).json() as Json;
    expect(Object.keys(legacy).sort()).toEqual(["cases", "outcomeFields", "versions"]);
    const rows = await walk(`/v1/governance/decision-regression/cases?limit=10&sort=label&dir=asc`, AUTH);
    expect(rows.map((r) => r.id).sort()).toEqual(legacy.cases.map((c: Json) => c.id).sort());
    const labels = rows.map((r) => r.label.toLowerCase());
    expect(labels).toEqual([...labels].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0)));
    const first = (await get(`/v1/governance/decision-regression/cases?limit=10&count=exact&source=shipped`)).json() as Json;
    expect(first.total).toBe(legacy.cases.filter((c: Json) => c.source === "shipped").length);
    expect(first).toMatchObject({ nextCursor: null, versions: legacy.versions, outcomeFields: legacy.outcomeFields });
  });

  it("refuses an unknown sort or filter and a cursor", async () => {
    expect((await get(`/v1/governance/decision-regression/cases?sort=answers`)).json().error).toBe("unknown_sort_column");
    expect((await get(`/v1/governance/decision-regression/cases?sort=label&cursor=x`)).json().error).toBe("cursor_not_supported");
    expect((await get(`/v1/governance/decision-regression/cases?sort=label&source=mine`)).statusCode).toBe(400);
  });

  it("exports the chosen columns, audited; a non-admin is refused on the list and the export and nothing is audited", async () => {
    const legacy = (await get(`/v1/governance/decision-regression/cases`)).json() as Json;
    const res = await get(`/v1/governance/decision-regression/cases/export.xlsx?sort=label&dir=desc&columns=label,expect,source`);
    expect(res.statusCode, res.body).toBe(200);
    const sheet = readXlsx(res.rawPayload);
    expect(sheet[0]).toEqual(["Case", "Expectation", "Source"]);
    expect(sheet).toHaveLength(1 + legacy.cases.length);
    const audits = await exportAudits("decision-regression-cases");
    expect(audits[0]!.detail).toMatchObject({ rows: legacy.cases.length, columns: ["label", "expect", "source"] });
    const before = audits.length;
    for (const url of ["/v1/governance/decision-regression/cases?limit=10&sort=label", "/v1/governance/decision-regression/cases/export.xlsx?columns=label"]) {
      expect((await get(url, who.a.auth)).statusCode).toBe(403);
    }
    expect(await exportAudits("decision-regression-cases")).toHaveLength(before);
  });
});

// ---- findings per rule (in memory) -------------------------------------------

describe("P2d: access recommendations, findings per rule", () => {
  beforeAll(async () => {
    // three unused, backdated agent grants so the unused-grant rule has more than one finding
    for (let i = 0; i < 3; i++) {
      const ag = await app.inject({ method: "POST", url: "/v1/agents", headers: AUTH, payload: { name: `p2d-agent-${RUN}-${i}`, provider: "mock", tier: 1, model: "mock-balanced", costPerMTokIn: 1, costPerMTokOut: 2 } });
      expect(ag.statusCode, ag.body).toBe(201);
      const g = await app.inject({ method: "POST", url: "/v1/grants/agents", headers: AUTH, payload: { userId: who[i % 2 ? "b" : "a"].id, agentId: ag.json().id } });
      expect(g.statusCode, g.body).toBe(201);
      await db.update(agentGrants).set({ createdAt: new Date(Date.now() - 120 * 86_400_000) }).where(eq(agentGrants.id, g.json().id));
    }
  });

  it("pages one rule's findings, the same set as the report, in the requested order", async () => {
    const report = (await get(`/v1/recommendations/access`)).json() as Json;
    expect(report.rules).toBeDefined();
    const unused = report.rules.find((r: Json) => r.id === "unused-grant");
    expect(unused.findings.length).toBeGreaterThanOrEqual(3);
    const rows = await walk(`/v1/recommendations/access?rule=unused-grant&limit=10&sort=holder&dir=asc`, AUTH);
    expect(rows.map((r) => r.key).sort()).toEqual(unused.findings.map((f: Json) => f.key).sort());
    const holders = rows.map((r) => r.holder.label.toLowerCase());
    expect(holders).toEqual([...holders].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0)));
    const page = (await get(`/v1/recommendations/access?rule=unused-grant&limit=10&count=exact`)).json() as Json;
    expect(page).toMatchObject({ rule: "unused-grant", total: unused.findings.length, judgedFrom: "report" });
  });

  it("list reads never dispatch the judge: only the report read (and an export) does, so the page bills one dispatch", async () => {
    let calls = 0;
    const judge: RecommendationJudge = {
      id: "test:counting-judge",
      judge: async (reqs) => {
        calls += 1;
        return reqs.map((r) => ({ key: r.key, verdict: "agree" as const, note: "counted" }));
      },
    };
    const seam = buildApp(db, { bootstrapToken: BOOT, dataKey: "e".repeat(64), recommendationJudge: judge });
    const [prior] = await db.select({ on: orgSettings.recommendationJudgeEnabled }).from(orgSettings);
    await db.update(orgSettings).set({ recommendationJudgeEnabled: true });
    try {
      const at = (url: string) => seam.inject({ method: "GET", url, headers: AUTH });
      const report = (await at("/v1/recommendations/access")).json() as Json;
      expect(report.judged).toMatchObject({ enabled: true, status: "judged", judge: "test:counting-judge" });
      expect(calls).toBe(1);
      // sorting, paging and a second rule's list: no dispatch, and no verdict of their own to disagree with the report
      for (const url of [
        "/v1/recommendations/access?rule=unused-grant&limit=10&sort=holder&dir=asc",
        "/v1/recommendations/access?rule=unused-grant&limit=10&sort=holder&dir=desc&count=exact",
        "/v1/recommendations/access?rule=unused-grant&limit=10&offset=10",
      ]) {
        const res = await at(url);
        expect(res.statusCode, res.body).toBe(200);
        for (const f of (res.json() as Json).items) expect(f.judged).toBeUndefined();
      }
      expect(calls).toBe(1);
      expect((await at("/v1/recommendations/access?rule=unused-grant&sort=judged")).json().error).toBe("unknown_sort_column");
      // the export is a download the admin asks for, and still carries the judged layer
      const res = await at("/v1/recommendations/access/export.xlsx?rule=unused-grant&sort=holder&columns=holder,judged");
      expect(res.statusCode, res.body).toBe(200);
      expect(calls).toBe(2);
      expect(readXlsx(res.rawPayload)[1]![1]).toMatch(/^model-judged: agree/);
    } finally {
      await db.update(orgSettings).set({ recommendationJudgeEnabled: prior?.on ?? false });
      await seam.close();
    }
  });

  it("needs a known rule, and refuses an unknown sort", async () => {
    expect((await get(`/v1/recommendations/access?limit=10&sort=holder`)).statusCode).toBe(400);
    expect((await get(`/v1/recommendations/access?rule=nope&sort=holder`)).statusCode).toBe(400);
    expect((await get(`/v1/recommendations/access?rule=unused-grant&sort=evidence`)).json().error).toBe("unknown_sort_column");
  });

  it("exports the rule's findings with the chosen columns, audited; a non-admin is refused and nothing is audited", async () => {
    const report = (await get(`/v1/recommendations/access`)).json() as Json;
    const unused = report.rules.find((r: Json) => r.id === "unused-grant");
    const res = await get(`/v1/recommendations/access/export.xlsx?rule=unused-grant&sort=holder&columns=holder,object,why`);
    expect(res.statusCode, res.body).toBe(200);
    const sheet = readXlsx(res.rawPayload);
    expect(sheet[0]).toEqual(["Holder", "Grant", "Why"]);
    expect(sheet).toHaveLength(1 + unused.findings.length);
    const audits = await exportAudits("access-recommendation-findings");
    expect(audits[0]!.detail).toMatchObject({ rows: unused.findings.length, filters: { rule: "unused-grant" } });
    const before = audits.length;
    for (const url of ["/v1/recommendations/access?rule=unused-grant&limit=10&sort=holder", "/v1/recommendations/access/export.xlsx?rule=unused-grant&columns=holder"]) {
      expect((await get(url, who.a.auth)).statusCode).toBe(403);
    }
    expect(await exportAudits("access-recommendation-findings")).toHaveLength(before);
  });

  it("a caller who sends none of the new params gets the report it always got", async () => {
    const report = (await get(`/v1/recommendations/access?windowDays=90`)).json() as Json;
    expect(report).toHaveProperty("rules");
    expect(report).toHaveProperty("judged");
    expect(report).not.toHaveProperty("items");
  });
});
