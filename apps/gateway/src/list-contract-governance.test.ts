/**
 * ADR-0226 — the shared list contract on the governance and Shadow AI lists (P2 batch A).
 *
 * For every converted route:
 *  - paging returns every row exactly once (keyset on the default sort, offset on another), and `count=exact`
 *    equals the rows walked;
 *  - the sort allow-list: an unknown column (or an injection attempt) is a 400;
 *  - the Excel export has exactly the requested columns, in order, with the screen's labels, holds every matching
 *    row, and writes one audit row;
 *  - authorisation: an admin-only list (and its export) refuses a non-admin; a scoped list (and its export) holds
 *    only the caller's own rows;
 *  - callers that send none of the contract params get the response they always got;
 *  - no secret leaves in an export (enrolment tokens: no secret, hash or prefix column exists).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { strFromU8, unzipSync } from "fflate";
import {
  aiUseCases,
  aiVendors,
  approvalDelegations,
  auditLog,
  copilotQueries,
  createDb,
  decisionRegressionRuns,
  desc,
  eq,
  governanceAlerts,
  grantCertificationCampaigns,
  grantCertificationItems,
  inArray,
  remediationProposals,
  runMigrations,
  shadowAiFindings,
  shadowAiImports,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";
import { ENROLMENT_TOKENS_LIST } from "./endpoint-agent-routes.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { relaxStepUpForTest } from "./testing/step-up-posture.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");
const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `lcg-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const N = 23;

let db: Db;
let app: ReturnType<typeof buildApp>;
let restoreMfa: () => Promise<void>;
let restoreStepUp: () => Promise<void>;
const who = {} as Record<"a" | "b", { id: string; auth: { authorization: string } }>;
const seeded: Record<string, string[]> = {};

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const get = (url: string, headers: Record<string, string> = AUTH) => app.inject({ method: "GET", url, headers });
const sep = (url: string) => (url.includes("?") ? "&" : "?");

function readXlsx(buf: Buffer): Array<Array<string | number | null>> {
  const files = unzipSync(new Uint8Array(buf));
  const shared = files["xl/sharedStrings.xml"]
    ? [...strFromU8(files["xl/sharedStrings.xml"]).matchAll(/<si>(.*?)<\/si>/gs)].map((m) => [...m[1]!.matchAll(/<t(?:\s[^>]*)?>(.*?)<\/t>/gs)].map((t) => t[1]!).join(""))
    : [];
  const sheet = strFromU8(files["xl/worksheets/sheet1.xml"]!);
  return [...sheet.matchAll(/<row[^>]*>(.*?)<\/row>/gs)].map((row) => {
    const out: Array<string | number | null> = [];
    for (const c of row[1]!.matchAll(/<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>(.*?)<\/c>)/gs)) {
      const col = c[1]!.split("").reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
      const v = /<v>(.*?)<\/v>/s.exec(c[3] ?? "")?.[1];
      while (out.length < col) out.push(null);
      out[col] = v === undefined ? null : /t="s"/.test(c[2]!) ? shared[Number(v)]! : Number(v);
    }
    return out;
  });
}

async function walk(url: string, headers: Record<string, string>, mode: "cursor" | "offset"): Promise<Json[]> {
  const out: Json[] = [];
  let next = "";
  for (let guard = 0; guard < 300; guard++) {
    const res = await get(`${url}${next}`, headers);
    expect(res.statusCode, `${url}${next}: ${res.body}`).toBe(200);
    const body = res.json() as Json;
    out.push(...body.items);
    if (mode === "cursor") {
      expect(body.nextOffset).toBeNull();
      if (!body.nextCursor) return out;
      next = `&cursor=${encodeURIComponent(body.nextCursor)}`;
    } else {
      expect(body.nextCursor).toBeNull();
      if (body.nextOffset === null) return out;
      next = `&offset=${body.nextOffset}`;
    }
  }
  throw new Error("paging did not end");
}

interface ListCase {
  name: string;
  /** the list route (may carry filters) */
  url: string;
  exportUrl: string;
  /** a sort that pages by offset */
  offsetSort: string;
  /** the default sort pages by a keyset cursor */
  keyset: boolean;
  /** two export column ids and their screen labels */
  columns: [string, string];
  labels: [string, string];
  legacyKey: string;
  legacyUrl?: string;
  /** admin-only (a non-admin is refused), or scoped (a non-admin sees only their own) */
  access: "admin" | "scoped";
  seededKey?: string;
}

const CASES: ListCase[] = [
  { name: "delegations", url: "/v1/delegations", exportUrl: "/v1/delegations/export.xlsx", offsetSort: "from", keyset: true, columns: ["from", "status"], labels: ["From", "Status"], legacyKey: "delegations", access: "admin", seededKey: "delegations" },
  { name: "vendors", url: "/v1/vendors", exportUrl: "/v1/vendors/export.xlsx", offsetSort: "name", keyset: true, columns: ["name", "status"], labels: ["Vendor", "Status"], legacyKey: "vendors", access: "scoped", seededKey: "vendors" },
  { name: "remediations", url: "/v1/governance/remediations", exportUrl: "/v1/governance/remediations/export.xlsx", offsetSort: "title", keyset: true, columns: ["title", "status"], labels: ["Remediation", "Status"], legacyKey: "proposals", access: "admin", seededKey: "remediations" },
  { name: "alerts", url: "/v1/governance/alerts?status=all", exportUrl: "/v1/governance/alerts/export.xlsx?status=all", offsetSort: "title", keyset: false, columns: ["title", "severity"], labels: ["Alert", "Severity"], legacyKey: "alerts", access: "admin", seededKey: "alerts" },
  { name: "feedback", url: "/v1/feedback", exportUrl: "/v1/feedback/export.xlsx", offsetSort: "status", keyset: true, columns: ["kind", "status"], labels: ["Kind", "Status"], legacyKey: "items", access: "scoped" },
  { name: "model cards", url: "/v1/mrm/cards", exportUrl: "/v1/mrm/cards/export.xlsx", offsetSort: "use", keyset: true, columns: ["use", "state"], labels: ["Intended use", "State"], legacyKey: "cards", access: "admin" },
  { name: "expiring sign-offs", url: "/v1/mrm/expiring", exportUrl: "/v1/mrm/expiring/export.xlsx", offsetSort: "until", keyset: false, columns: ["use", "state"], labels: ["Intended use", "State"], legacyKey: "items", access: "admin" },
  { name: "regression runs", url: "/v1/governance/decision-regression/runs", exportUrl: "/v1/governance/decision-regression/runs/export.xlsx", offsetSort: "changed", keyset: true, columns: ["subject", "changed"], labels: ["Change to", "Changed outcomes"], legacyKey: "runs", access: "admin", seededKey: "regression" },
  { name: "registered agents", url: "/v1/inventory/agents", exportUrl: "/v1/inventory/agents/export.xlsx", offsetSort: "model", keyset: false, columns: ["agent", "card"], labels: ["Agent", "Model card"], legacyKey: "agents", access: "admin" },
  { name: "certification campaigns", url: "/v1/certification-campaigns", exportUrl: "/v1/certification-campaigns/export.xlsx", offsetSort: "name", keyset: true, columns: ["name", "status"], labels: ["Campaign", "Status"], legacyKey: "campaigns", access: "admin" },
  { name: "SoD override requests", url: "/v1/sod/overrides", exportUrl: "/v1/sod/overrides/export.xlsx", offsetSort: "label", keyset: true, columns: ["label", "status"], labels: ["Request", "Status"], legacyKey: "overrides", access: "admin" },
  { name: "Shadow AI findings", url: "/v1/shadow-ai/findings", exportUrl: "/v1/shadow-ai/findings/export.xlsx", offsetSort: "subject", keyset: false, columns: ["subject", "disposition"], labels: ["Subject", "Status"], legacyKey: "findings", access: "admin", seededKey: "findings" },
  { name: "Shadow AI import history", url: "/v1/shadow-ai/imports", exportUrl: "/v1/shadow-ai/imports/export.xlsx", offsetSort: "rows", keyset: true, columns: ["kind", "status"], labels: ["Kind", "Status"], legacyKey: "imports", access: "admin", seededKey: "imports" },
  { name: "discovery runs", url: "/v1/discovery/runs", exportUrl: "/v1/discovery/runs/export.xlsx", offsetSort: "status", keyset: true, columns: ["source", "status"], labels: ["Source", "Status"], legacyKey: "runs", access: "admin" },
  { name: "provenance records", url: "/v1/content-provenance/records", exportUrl: "/v1/content-provenance/records/export.xlsx", offsetSort: "tier", keyset: true, columns: ["source", "tier"], labels: ["Source", "Tier"], legacyKey: "records", access: "admin" },
  { name: "copilot questions", url: "/v1/copilot/queries", exportUrl: "/v1/copilot/queries/export.xlsx", offsetSort: "q", keyset: true, columns: ["q", "g"], labels: ["Question", "Generation"], legacyKey: "queries", access: "scoped", seededKey: "copilot" },
  { name: "copilot proposals", url: "/v1/copilot/proposals", exportUrl: "/v1/copilot/proposals/export.xlsx", offsetSort: "t", keyset: true, columns: ["t", "s"], labels: ["Proposal", "Consent"], legacyKey: "proposals", access: "scoped" },
  { name: "guardrail decisions", url: "/v1/guardrails/violations", exportUrl: "/v1/guardrails/violations/export.xlsx", offsetSort: "outcome", keyset: true, columns: ["at", "outcome"], labels: ["When", "Outcome"], legacyKey: "violations", access: "admin" },
  { name: "preview history", url: "/v1/policy-simulations", exportUrl: "/v1/policy-simulations/export.xlsx", offsetSort: "p", keyset: true, columns: ["p", "blocked"], labels: ["Policy", "Newly blocked"], legacyKey: "simulations", access: "scoped" },
  { name: "use cases", url: "/v1/use-cases", exportUrl: "/v1/use-cases/export.xlsx", offsetSort: "name", keyset: true, columns: ["name", "status"], labels: ["Name", "Status"], legacyKey: "useCases", access: "scoped", seededKey: "useCases" },
  { name: "audit trail", url: "/v1/audit?objectType=ai_use_case", exportUrl: "/v1/audit/export.xlsx?objectType=ai_use_case", offsetSort: "effect", keyset: true, columns: ["at", "event"], labels: ["At", "Event"], legacyKey: "entries", access: "admin" },
];

const latestExportAudit = async () =>
  (await db.select().from(auditLog).where(eq(auditLog.ruleId, "list-export-xlsx")).orderBy(desc(auditLog.at)).limit(1))[0]!;

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restoreMfa = await relaxIdentityForTest(db, { mfaRequired: "off" });
  restoreStepUp = await relaxStepUpForTest(db);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "c".repeat(64) });
  for (const k of ["a", "b"] as const) {
    const u = await app.inject({ method: "POST", url: "/v1/users", headers: AUTH, payload: { email: `lcg-${k}-${RUN}@example.com`, displayName: `Morgan Reyes ${k} ${RUN}` } });
    expect(u.statusCode, u.body).toBe(201);
    const id = u.json().id as string;
    const key = await app.inject({ method: "POST", url: `/v1/users/${id}/keys`, headers: AUTH, payload: { name: "lcg" } });
    expect(key.statusCode, key.body).toBe(201);
    who[k] = { id, auth: { authorization: `Bearer ${key.json().token}` } };
  }
  const base = Date.parse("2026-02-01T00:00:00Z");
  const at = (i: number) => new Date(base + (i < 3 ? 0 : i) * 60_000);
  const ids = <T extends { id: string }>(rows: T[]) => rows.map((r) => r.id);
  const range = Array.from({ length: N }, (_, i) => i);
  seeded.delegations = ids(
    await db
      .insert(approvalDelegations)
      .values(range.map((i) => ({ fromUserId: who.a.id, toUserId: who.b.id, startsAt: at(i), endsAt: new Date(at(i).getTime() + (i % 2 ? 1 : -1) * 86_400_000 * 400), reason: `lcg ${RUN} ${i}`, createdAt: at(i) })))
      .returning({ id: approvalDelegations.id }),
  );
  seeded.vendors = ids(
    await db
      .insert(aiVendors)
      .values(range.map((i) => ({ name: `lcg vendor ${RUN} ${String((i * 7) % 23).padStart(2, "0")}`, description: "Credit-limit-increase assistant vendor", category: "model_provider" as const, ownerUserId: i < 15 ? who.a.id : who.b.id, createdAt: at(i) })))
      .returning({ id: aiVendors.id }),
  );
  seeded.remediations = ids(
    await db
      .insert(remediationProposals)
      .values(range.map((i) => ({ kind: "link_control" as const, params: { n: `${RUN}-${i}` }, title: `lcg remediation ${RUN} ${(i * 5) % 23}`, rationale: "test", proposedByUserId: who.a.id, createdAt: at(i) })))
      .returning({ id: remediationProposals.id }),
  );
  seeded.alerts = ids(
    await db
      .insert(governanceAlerts)
      .values(range.map((i) => ({ ruleId: "lcg-test-rule", subjectKey: `lcg:${RUN}:${i}`, severity: (["low", "medium", "high"] as const)[i % 3]!, title: `lcg alert ${RUN} ${i}`, lastDetectedAt: at(i), firstDetectedAt: at(i) })))
      .returning({ id: governanceAlerts.id }),
  );
  seeded.regression = ids(
    await db
      .insert(decisionRegressionRuns)
      .values(range.map((i) => ({ trigger: "preview" as const, subject: "review_policy" as const, candidateDigest: `lcg${i}`, cases: 10, changed: i % 4, createdAt: at(i) })))
      .returning({ id: decisionRegressionRuns.id }),
  );
  seeded.findings = ids(
    await db
      .insert(shadowAiFindings)
      .values(range.map((i) => ({ subjectKind: "repo" as const, subject: `lcg-repo-${RUN}-${i}`, provider: "openai", signalSources: ["code_scan"], signatureKinds: ["sdk"], firstSeenAt: at(i), lastSeenAt: at(i), severity: (["low", "medium", "high", "critical"] as const)[i % 4]!, confidence: "low" as const, evidence: [], disposition: i % 3 ? ("open" as const) : ("confirmed" as const), dispositionAt: i % 3 ? null : at(i), dispositionReason: i % 3 ? null : "lcg" })))
      .returning({ id: shadowAiFindings.id }),
  );
  seeded.imports = ids(
    await db
      .insert(shadowAiImports)
      .values(range.map((i) => ({ kind: "egress_log" as const, payloadSha256: "0".repeat(64), mode: "dry_run" as const, status: "planned" as const, rowCount: i, summary: {}, ruleId: "lcg", reason: `lcg ${RUN} ${i}`, createdAt: at(i) })))
      .returning({ id: shadowAiImports.id }),
  );
  seeded.copilot = ids(
    await db
      .insert(copilotQueries)
      .values(range.map((i) => ({ userId: i < 15 ? who.a.id : who.b.id, question: `lcg ${RUN} question ${(i * 3) % 23}`, plan: {}, evidence: {}, answer: "x", createdAt: at(i) })))
      .returning({ id: copilotQueries.id }),
  );
  seeded.useCases = ids(
    await db
      .insert(aiUseCases)
      .values(range.map((i) => ({ name: `lcg use case ${RUN} ${(i * 11) % 23}`, description: "Credit-limit-increase assistant", businessContext: "x", ownerUserId: i < 15 ? who.a.id : who.b.id, dataSensitivity: "internal" as const, status: (["proposed", "under_review", "approved"] as const)[i % 3]!, euAiActTier: i % 2 ? ("high" as const) : null, euAiActRulesetVersion: i % 2 ? 1 : null, euAiActReasons: i % 2 ? [] : null, createdAt: at(i) })))
      .returning({ id: aiUseCases.id }),
  );
}, 120_000);

afterAll(async () => {
  await restoreStepUp?.();
  await restoreMfa?.();
});

describe.each(CASES)("ADR-0226: $name", (c) => {
  const ownRows = async (headers: Record<string, string>) => walk(`${c.url}${sep(c.url)}limit=10&count=exact`, headers, c.keyset ? "cursor" : "offset");

  it("pages every row exactly once, and count=exact is the true total", async () => {
    const first = await get(`${c.url}${sep(c.url)}limit=10&count=exact`);
    expect(first.statusCode, first.body).toBe(200);
    const total = first.json().total as number;
    const items = await ownRows(AUTH);
    expect(items).toHaveLength(total);
    expect(new Set(items.map((r) => r.id ?? r.receiptSeq)).size).toBe(total);
    const byOffset = await walk(`${c.url}${sep(c.url)}limit=10&sort=${c.offsetSort}&dir=asc`, AUTH, "offset");
    expect(new Set(byOffset.map((r) => r.id)).size).toBe(total);
    expect(new Set(byOffset.map((r) => r.id))).toEqual(new Set(items.map((r) => r.id)));
    if (c.seededKey) for (const id of seeded[c.seededKey]!) expect(items.some((r) => r.id === id), id).toBe(true);
  });

  it("refuses a sort column off the allow-list", async () => {
    for (const bad of ["nope", encodeURIComponent("name; drop table users; --"), "__proto__"]) {
      const res = await get(`${c.url}${sep(c.url)}limit=10&sort=${bad}`);
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("unknown_sort_column");
    }
    expect((await get(`${c.exportUrl}${sep(c.exportUrl)}columns=${c.columns[0]},nope`)).statusCode).toBe(400);
  });

  it("exports exactly the requested columns, every matching row, and audits it", async () => {
    const total = (await get(`${c.url}${sep(c.url)}limit=10&count=exact`)).json().total as number;
    const res = await get(`${c.exportUrl}${sep(c.exportUrl)}columns=${c.columns.join(",")}`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers["content-type"]).toContain("spreadsheetml");
    const rows = readXlsx(res.rawPayload);
    expect(rows[0]).toEqual(c.labels);
    expect(rows.length - 1).toBe(total);
    const a = await latestExportAudit();
    expect(a.objectType).toBe("audit_export");
    expect(a.detail).toMatchObject({ columns: c.columns, rows: total, truncated: false });
  });

  it("keeps the list's authorisation, export included", async () => {
    if (c.access === "admin") {
      expect((await get(`${c.url}${sep(c.url)}limit=10&count=exact`, who.a.auth)).statusCode).toBe(403);
      expect((await get(`${c.exportUrl}${sep(c.exportUrl)}columns=${c.columns[0]}`, who.a.auth)).statusCode).toBe(403);
      return;
    }
    const mine = await ownRows(who.b.auth);
    const all = await ownRows(AUTH);
    expect(mine.length).toBeLessThanOrEqual(all.length);
    if (c.seededKey) {
      const ofB = seeded[c.seededKey]!.slice(15);
      expect(new Set(mine.map((r) => r.id))).toEqual(new Set(ofB));
      const file = await get(`${c.exportUrl}${sep(c.exportUrl)}columns=${c.columns[0]}`, who.b.auth);
      expect(readXlsx(file.rawPayload).length - 1).toBe(ofB.length);
    }
  });

  it("answers its old response to a caller that sends no contract param", async () => {
    const res = await get(c.legacyUrl ?? c.url);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as Json;
    expect(Array.isArray(body[c.legacyKey])).toBe(true);
    expect(body).not.toHaveProperty("nextOffset");
  });
});

describe("ADR-0226: per-route specifics", () => {
  it("the Shadow AI findings status filter runs on the server, with figures across every finding", async () => {
    const all = (await get("/v1/shadow-ai/findings?limit=10&count=exact")).json();
    const open = await walk("/v1/shadow-ai/findings?limit=10&status=open&sort=subject", AUTH, "offset");
    expect(open.every((f) => f.disposition === "open")).toBe(true);
    expect(open.length).toBe(all.summary.statusCounts.open);
    expect(all.summary.statusCounts.all).toBe(all.total);
  });

  it("the registry's filters and figures run on the server", async () => {
    const q = encodeURIComponent(`lcg use case ${RUN}`);
    const high = (await get(`/v1/use-cases?limit=100&count=exact&q=${q}&tier=high_or_prohibited`)).json();
    expect(high.total).toBe(seeded.useCases!.filter((_, i) => i % 2).length);
    expect(high.items.every((r: Json) => r.euAiActTier === "high")).toBe(true);
    const review = (await get(`/v1/use-cases?limit=100&count=exact&q=${q}&status=in_review`)).json();
    expect(review.items.every((r: Json) => ["proposed", "under_review", "needs_info"].includes(r.status))).toBe(true);
    expect(review.summary.headline.total).toBeGreaterThanOrEqual(N);
    // `%` and `_` in a search are literal
    expect((await get(`/v1/use-cases?limit=10&count=exact&q=${encodeURIComponent("%")}`)).json().total).toBe(0);
  });

  it("the audit trail keeps its cursor: a caller paging with `cursor` alone gets the old shape", async () => {
    const first = (await get("/v1/audit?limit=2")).json();
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await get(`/v1/audit?limit=2&cursor=${encodeURIComponent(first.nextCursor)}`);
    expect(Object.keys(second.json())).toContain("entries");
    // and the contract's default sort pages by the same keyset
    const page = (await get("/v1/audit?limit=10&sort=at&dir=desc")).json();
    expect(page.nextCursor).toEqual(expect.any(String));
  });

  it("campaign items page through their own route; an unknown campaign is a 404", async () => {
    const res = await get(`/v1/certification-campaigns/00000000-0000-4000-8000-000000000000/items?limit=10`);
    expect(res.statusCode).toBe(404);
    expect((await get(`/v1/certification-campaigns/00000000-0000-4000-8000-000000000000/items?limit=10`, who.a.auth)).statusCode).toBe(403);
  });

  it("an enrolment token's export can never carry its secret, hash or prefix", () => {
    for (const id of Object.keys(ENROLMENT_TOKENS_LIST.columns)) expect(id).not.toMatch(/secret|hash|prefix|token/i);
    for (const c of Object.values(ENROLMENT_TOKENS_LIST.columns)) expect(c.label).not.toMatch(/secret|hash|prefix/i);
  });

  it("receipts list under the contract and every page is audited", async () => {
    const res = await get("/v1/receipts?limit=10&sort=seq&dir=asc&count=exact");
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toHaveProperty("items");
    const [row] = await db.select().from(auditLog).where(eq(auditLog.ruleId, "decision-receipts-listed")).orderBy(desc(auditLog.at)).limit(1);
    expect(row!.detail).toMatchObject({ sort: "seq" });
    expect((await get("/v1/receipts?limit=10&sort=nope")).statusCode).toBe(400);
    const file = await get("/v1/receipts/export.xlsx?columns=seq,effect");
    expect(readXlsx(file.rawPayload)[0]).toEqual(["Sequence", "Effect"]);
  });

  it("alerts default to the triage order: the most severe first, the most recently seen first within a severity", async () => {
    const rank: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 };
    const mine = new Set(seeded.alerts);
    const rows = (await walk("/v1/governance/alerts?status=all&limit=10&count=exact", AUTH, "offset")).filter((r) => mine.has(r.id as string));
    expect(rows).toHaveLength(seeded.alerts!.length);
    for (let i = 1; i < rows.length; i++) {
      const [a, b] = [rows[i - 1]!, rows[i]!];
      const bySeverity = rank[a.severity as string]! - rank[b.severity as string]!;
      expect(bySeverity, `${a.title} before ${b.title}`).toBeGreaterThanOrEqual(0);
      if (bySeverity === 0) expect(Date.parse(a.lastDetectedAt as string)).toBeGreaterThanOrEqual(Date.parse(b.lastDetectedAt as string));
    }
    expect((await get("/v1/governance/alerts?status=all&limit=10&cursor=abc")).statusCode).toBe(400);
  });

  it("delegations filter by state on the server", async () => {
    const active = await walk("/v1/delegations?limit=10&status=expired&sort=from", AUTH, "offset");
    expect(active.every((d) => !d.active && new Date(d.endsAt).getTime() <= Date.now())).toBe(true);
  });
});

describe("ADR-0226 batch A: certification campaigns filter by status, with per-status counts (ADR-0208 G9)", () => {
  const STATUSES = ["open", "completed", "expired-incomplete", "cancelled"] as const;
  let mine: string[] = [];

  beforeAll(async () => {
    const day = 86_400_000;
    const now = Date.now();
    // two of each effective status; the cancelled ones are past due with an undecided item, and still read cancelled
    const spec = [
      ...[0, 1].map((i) => ({ i, status: "open" as const, dueAt: new Date(now + 30 * day), undecided: true })),
      ...[2, 3].map((i) => ({ i, status: "completed" as const, dueAt: new Date(now - 30 * day), undecided: false })),
      ...[4, 5].map((i) => ({ i, status: "open" as const, dueAt: new Date(now - day), undecided: true })),
      ...[6, 7].map((i) => ({ i, status: "cancelled" as const, dueAt: new Date(now - day), undecided: true })),
    ];
    const rows = await db
      .insert(grantCertificationCampaigns)
      .values(
        spec.map((c) => ({
          name: `lcg campaign ${RUN} ${c.i}`,
          scopeKind: "all" as const,
          openedByUserId: who.a.id,
          dueAt: c.dueAt,
          status: c.status,
          completedAt: c.status === "completed" ? new Date(now - 31 * day) : null,
          cancelledAt: c.status === "cancelled" ? new Date(now - 2 * day) : null,
          cancelledReason: c.status === "cancelled" ? "Scope was wrong; reopened" : null,
          cancelledByUserId: c.status === "cancelled" ? who.a.id : null,
        })),
      )
      .returning({ id: grantCertificationCampaigns.id });
    mine = rows.map((r) => r.id);
    await db.insert(grantCertificationItems).values(
      spec.flatMap((c, k) => [
        // one decided item each, and an undecided one where the spec says so
        { campaignId: mine[k]!, grantKind: "agent" as const, grantId: crypto.randomUUID(), holderUserId: who.b.id, holderLabel: "Dana Developer", objectLabel: "Credit-limit-increase assistant", reviewerUserId: who.a.id, decision: "keep" as const, decidedByUserId: who.a.id, decidedAt: new Date(now - 2 * day) },
        ...(c.undecided ? [{ campaignId: mine[k]!, grantKind: "agent" as const, grantId: crypto.randomUUID(), holderUserId: who.b.id, holderLabel: "Jordan Owner", objectLabel: "Credit-limit-increase assistant", reviewerUserId: who.a.id }] : []),
      ]),
    );
  });

  afterAll(async () => {
    if (mine.length) await db.delete(grantCertificationCampaigns).where(inArray(grantCertificationCampaigns.id, mine));
  });

  /** what the route has always said each campaign's status is (computed in code, not SQL) */
  const legacyStatuses = async () => new Map(((await get("/v1/certification-campaigns")).json().campaigns as Json[]).map((c) => [c.id as string, c.status as string]));

  it("the status filter returns exactly the campaigns of that status, by the same rule the old response uses", async () => {
    const legacy = await legacyStatuses();
    for (const id of mine) expect(STATUSES).toContain(legacy.get(id));
    expect(mine.map((id) => legacy.get(id))).toEqual(["open", "open", "completed", "completed", "expired-incomplete", "expired-incomplete", "cancelled", "cancelled"]);
    for (const status of STATUSES) {
      const rows = await walk(`/v1/certification-campaigns?limit=10&status=${status}&sort=name`, AUTH, "offset");
      expect(new Set(rows.map((r) => r.id)), status).toEqual(new Set([...legacy].filter(([, s]) => s === status).map(([id]) => id)));
      expect(rows.every((r) => r.status === status)).toBe(true);
      // the page's row carries the cancellation the old response carries
      if (status === "cancelled") expect(rows.filter((r) => mine.includes(r.id)).every((r) => r.cancellation?.reason === "Scope was wrong; reopened")).toBe(true);
    }
  });

  it("returns the per-status counts across every campaign as `summary`, whatever the filter", async () => {
    const legacy = await legacyStatuses();
    const expected = Object.fromEntries(STATUSES.map((s) => [s, [...legacy.values()].filter((v) => v === s).length]));
    expect(expected.cancelled).toBeGreaterThanOrEqual(2);
    for (const filter of ["", "&status=open", "&status=cancelled"]) {
      const body = (await get(`/v1/certification-campaigns?limit=10&count=exact${filter}`)).json() as Json;
      expect(body.summary, filter).toEqual({ statusCounts: expected });
      if (filter) expect(body.total).toBe(expected[filter.split("=")[1]!]);
    }
    expect(Object.values(expected).reduce((a, b) => a + b, 0)).toBe(legacy.size);
  });

  it("an unknown status is a 400, never interpolated; the export takes the same filter; a non-admin is refused", async () => {
    for (const bad of ["nope", "open' or '1'='1", "Cancelled"]) {
      const res = await get(`/v1/certification-campaigns?limit=10&count=exact&status=${encodeURIComponent(bad)}`);
      expect(res.statusCode, bad).toBe(400);
    }
    const file = await get(`/v1/certification-campaigns/export.xlsx?columns=name,status&status=cancelled`);
    expect(file.statusCode, file.body.slice(0, 300)).toBe(200);
    const rows = readXlsx(file.rawPayload);
    expect(rows[0]).toEqual(["Campaign", "Status"]);
    expect(rows.slice(1).every((r) => r[1] === "cancelled")).toBe(true);
    expect(rows.slice(1).map((r) => r[0])).toEqual(expect.arrayContaining([`lcg campaign ${RUN} 6`, `lcg campaign ${RUN} 7`]));
    expect((await get(`/v1/certification-campaigns?limit=10&count=exact&status=open`, who.a.auth)).statusCode).toBe(403);
  });
});
