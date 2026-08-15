/**
 * ADR-0076 — THE ROSTER INGEST, proved by attack.
 *
 * WHAT THIS FILE TRIES TO MAKE IMPOSSIBLE TO FAKE:
 *
 *  1. A PARALLEL WRITE PATH. The roster's whole effect must be observable
 *     through ADR-0069's OWN machinery: the alias appears in
 *     GET /v1/cost-imports/mappings, the per-alias audit rows carry the same
 *     ruleIds the single-row routes write, and — the join proof — a stored
 *     imported line that resolved to NOBODY before the roster resolves to the
 *     right human after it, by `admin_alias`, through the same re-resolution
 *     every alias write triggers. The non-vacuity control asserts the line was
 *     UNRESOLVED first.
 *  2. A GUESSED IDENTITY. One vendor account mapped to two people is refused
 *     LOUDLY — every involved row named, both emails, no alias written. Same
 *     for one person given two cost centres. An email naming no RegulAIt user
 *     is refused per-row; a roster never invents a person.
 *  3. A SILENT DRY RUN. `dry_run` writes nothing — asserted against the
 *     tables, not the response.
 *  4. A PII HOLE, IN EITHER DIRECTION. The identity columns (account, email)
 *     are join keys and exempt BY CONSTRUCTION — a roster full of emails scans
 *     `clean`. The one retained non-identity field (cost centre) goes through
 *     the same ADR-0042 gate as every other ingest, and blocks at mode
 *     `block`, counts only.
 *  5. AN UNGATED SURFACE. Non-admins get 403.
 *
 * SHARED-STATE DISCIPLINE: same as cost-import.test.ts — own users, own rule
 * ids, own vendor strings, deltas not absolutes, everything removed in
 * afterAll, ORG_SETTINGS never touched.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  auditLog,
  costImportBatches,
  createDb,
  eq,
  importedCostLines,
  inArray,
  runMigrations,
  users,
  vendorAccountAliases,
  type Db,
} from "@regulait/db";
import { COST_IMPORT_RULE_IDS } from "./cost-import.js";

const { buildApp } = await import("./app.js");

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "roster-ingest-bootstrap-token";
const ADMIN = { authorization: `Bearer ${BOOT}` };

const AMY = "roster-amy@example.com";
const BEN = "roster-ben@example.com";
const AMY_SEAT = "amy.contractor@vendorbill.example";
const VENDOR = "copilot-roster";
const SEAT_USD = 77.77;
const ENT = "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User";

let db: Db;
let app: ReturnType<typeof buildApp>;
let amyId: string;
let benId: string;
let amyAuth: { authorization: string };
let seatBatchId: string;
const createdUserIds: string[] = [];

const post = (url: string, payload: unknown, headers = ADMIN) =>
  app.inject({ method: "POST", url, headers, payload: payload as object });
const get = (url: string, headers = ADMIN) => app.inject({ method: "GET", url, headers });

async function makeUser(email: string): Promise<{ id: string; auth: { authorization: string } }> {
  const res = await post("/v1/users", { email, displayName: email });
  expect(res.statusCode).toBe(201);
  const id = res.json().id as string;
  createdUserIds.push(id);
  const key = await post(`/v1/users/${id}/keys`, { name: "roster-ingest" });
  expect(key.statusCode).toBe(201);
  return { id, auth: { authorization: `Bearer ${key.json().token}` } };
}

const SCIM_ROSTER = () =>
  JSON.stringify({
    totalResults: 2,
    Resources: [
      {
        userName: AMY_SEAT,
        displayName: "Amy A.",
        emails: [{ value: AMY, primary: true }],
        [ENT]: { costCenter: "CC-R&D" },
      },
      { userName: BEN, emails: [{ value: BEN }] },
    ],
  });

const rosterBody = (over: Record<string, unknown> = {}) => ({
  format: "json",
  mode: "dry_run",
  content: SCIM_ROSTER(),
  source: "okta-export-2026-08.json",
  vendor: VENDOR,
  reason: "quarterly seat-roster sync, confirmed with IT",
  ...over,
});

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT });

  const amy = await makeUser(AMY);
  amyId = amy.id;
  amyAuth = amy.auth;
  const ben = await makeUser(BEN);
  benId = ben.id;

  // the imported spend the roster exists to attribute: a seat billed to Amy's
  // CONTRACTOR address, which matches no RegulAIt user
  const res = await post("/v1/cost-imports", {
    adapter: "seat_roster",
    format: "csv",
    mode: "apply",
    content: `email,plan\n${AMY_SEAT},business\n`,
    source: "copilot-seats-2026-07.csv",
    config: { seatPriceUsd: SEAT_USD, vendor: VENDOR, periodStart: "2026-07-01", periodEnd: "2026-08-01" },
  });
  expect(res.statusCode).toBe(201);
  seatBatchId = res.json().importId;
});

afterAll(async () => {
  await db.delete(importedCostLines);
  await db.delete(costImportBatches);
  await db.delete(vendorAccountAliases);
  await db.delete(auditLog).where(inArray(auditLog.ruleId, Object.values(COST_IMPORT_RULE_IDS)));
  if (createdUserIds.length) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  await app.close();
});

// ===========================================================================
// 1. The gap, proved first — the join the roster exists to close
// ===========================================================================

describe("before the roster", () => {
  it("the seat line resolved to NOBODY — the non-vacuity control for the join proof below", async () => {
    const [line] = await db.select().from(importedCostLines).where(eq(importedCostLines.batchId, seatBatchId));
    expect(line!.resolvedUserId).toBeNull();
    expect(line!.resolutionMethod).toBe("unresolved");
    expect(line!.amount).toBe(SEAT_USD);
  });
});

// ===========================================================================
// 2. Dry run: the full plan, and not one write
// ===========================================================================

describe("POST /v1/cost-imports/roster (dry_run)", () => {
  it("plans one alias create, one unnecessary alias, one cost centre — and writes NOTHING", async () => {
    const res = await post("/v1/cost-imports/roster", rosterBody());
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.applied).toBe(false);
    expect(body.dialect).toBe("scim");
    expect(body.rowsParsed).toBe(2);
    expect(body.rowsRefused).toBe(0);
    expect(body.rowsAccepted + body.rowsRefused).toBe(body.rowsParsed);
    expect(body.counts).toMatchObject({
      aliasesToCreate: 1,
      aliasesToUpdate: 0,
      aliasesUnnecessary: 1, // Ben's seat IS his directory address
      costCentersToSet: 1,
    });
    const amyAction = body.actions.find((a: { accountRef: string }) => a.accountRef === AMY_SEAT);
    expect(amyAction).toMatchObject({ aliasAction: "create", userEmail: AMY, costCenter: "CC-R&D", costCenterAction: "set" });
    const benAction = body.actions.find((a: { accountRef: string }) => a.accountRef === BEN);
    expect(benAction).toMatchObject({ aliasAction: "unnecessary", costCenterAction: "none" });
    // a roster full of emails scans CLEAN: identity columns are join keys,
    // exempt by the disclosed construction, and the posture says so
    expect(body.ingestScan.verdict).toBe("clean");
    expect(body.piiPosture).toMatch(/JOIN KEYS/);
    expect(body.posture).toMatch(/refused LOUDLY/);

    // NOTHING was written
    expect(await db.select().from(vendorAccountAliases)).toHaveLength(0);
    const [amy] = await db.select({ costCenter: users.costCenter }).from(users).where(eq(users.id, amyId));
    expect(amy!.costCenter).toBeNull();
    const [line] = await db.select().from(importedCostLines).where(eq(importedCostLines.batchId, seatBatchId));
    expect(line!.resolvedUserId).toBeNull();

    const planned = await db.select().from(auditLog).where(eq(auditLog.ruleId, COST_IMPORT_RULE_IDS.rosterPlanned));
    expect(planned.length).toBe(1);
    expect(planned[0]!.reason).toMatch(/Nothing was written/);
  });
});

// ===========================================================================
// 3. Apply: through the EXISTING write paths, and the join proof
// ===========================================================================

describe("POST /v1/cost-imports/roster (apply)", () => {
  it("creates the alias through the existing path, sets the cost centre, and RE-ATTRIBUTES the stored line", async () => {
    const res = await post("/v1/cost-imports/roster", rosterBody({ mode: "apply" }));
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.applied).toBe(true);
    expect(body.aliasesCreated).toBe(1);
    expect(body.aliasesUpdated).toBe(0);
    expect(body.costCentersSet).toBe(1);
    // THE JOIN PROOF, half 1: the roster pass re-resolved stored lines
    expect(body.reresolved.changed).toBe(1);

    // half 2: the SAME line that was unresolved above is now Amy's, by
    // admin_alias — i.e. through ADR-0069's own resolution machinery
    const [line] = await db.select().from(importedCostLines).where(eq(importedCostLines.batchId, seatBatchId));
    expect(line!.resolvedUserId).toBe(amyId);
    expect(line!.resolutionMethod).toBe("admin_alias");

    // the alias is visible on the EXISTING mappings surface
    const mappings = await get("/v1/cost-imports/mappings");
    const alias = mappings.json().aliases.find((a: { accountKey: string }) => a.accountKey === AMY_SEAT);
    expect(alias).toBeDefined();
    expect(alias.userId).toBe(amyId);
    expect(alias.vendor).toBe(VENDOR);
    expect(alias.reason).toMatch(/quarterly seat-roster sync/);

    // the cost centre landed on the person
    const [amy] = await db.select({ costCenter: users.costCenter }).from(users).where(eq(users.id, amyId));
    expect(amy!.costCenter).toBe("CC-R&D");

    // audited with the SAME ruleIds the single-row routes use, marked roster
    const aliasAudits = await db.select().from(auditLog).where(eq(auditLog.ruleId, COST_IMPORT_RULE_IDS.aliasCreated));
    const rosterAliasAudits = aliasAudits.filter((a) => (a.detail as { origin?: string }).origin === "roster");
    expect(rosterAliasAudits.length).toBe(1);
    expect(rosterAliasAudits[0]!.reason).toMatch(/via roster/);
    const ccAudits = await db.select().from(auditLog).where(eq(auditLog.ruleId, COST_IMPORT_RULE_IDS.costCenterSet));
    expect(ccAudits.filter((a) => (a.detail as { origin?: string }).origin === "roster").length).toBe(1);
    const summary = await db.select().from(auditLog).where(eq(auditLog.ruleId, COST_IMPORT_RULE_IDS.rosterApplied));
    expect(summary.length).toBe(1);
    expect(summary[0]!.reason).toMatch(/1 alias\(es\) created/);
  });

  it("re-applying the same roster is a no-op reported as one — unchanged, not re-created", async () => {
    const aliasAuditsBefore = (
      await db.select().from(auditLog).where(eq(auditLog.ruleId, COST_IMPORT_RULE_IDS.aliasCreated))
    ).length;
    const res = await post("/v1/cost-imports/roster", rosterBody({ mode: "apply" }));
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.aliasesCreated).toBe(0);
    expect(body.aliasesUpdated).toBe(0);
    expect(body.counts.aliasesUnchanged).toBe(1);
    expect(body.counts.costCentersUnchanged).toBe(1);
    expect(body.costCentersSet).toBe(0);
    // no-op rows write no per-alias audit rows
    const aliasAuditsAfter = (
      await db.select().from(auditLog).where(eq(auditLog.ruleId, COST_IMPORT_RULE_IDS.aliasCreated))
    ).length;
    expect(aliasAuditsAfter).toBe(aliasAuditsBefore);
  });
});

// ===========================================================================
// 4. Ambiguity is refused loudly — never resolved by guessing
// ===========================================================================

describe("the refusals", () => {
  it("one vendor account mapped to TWO people refuses every involved row, names both, writes nothing", async () => {
    const csv =
      "seat,directory\n" +
      `shared.seat@vendorbill.example,${AMY}\n` +
      `shared.seat@vendorbill.example,${BEN}\n`;
    const res = await post("/v1/cost-imports/roster", {
      ...rosterBody({ mode: "apply", format: "csv", content: csv }),
      mapping: { account: "seat", user: "directory" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.rowsRefused).toBe(2);
    expect(body.rowsAccepted).toBe(0);
    expect(body.aliasesCreated).toBe(0);
    for (const refusal of body.refusals) {
      expect(refusal.reason).toMatch(/AMBIGUOUS/);
      expect(refusal.reason).toContain(AMY);
      expect(refusal.reason).toContain(BEN);
      expect(refusal.reason).toMatch(/never resolved by guessing/);
    }
    expect(body.refusals.map((r: { row: number }) => r.row).sort()).toEqual([2, 3]);
    const aliases = await db.select().from(vendorAccountAliases);
    expect(aliases.some((a) => a.accountKey === "shared.seat@vendorbill.example")).toBe(false);
  });

  it("an email naming no RegulAIt user is refused BY ROW — a roster never invents a person", async () => {
    const csv = `seat\nroster-nobody@example.com\n${BEN}\n`;
    const res = await post("/v1/cost-imports/roster", {
      ...rosterBody({ mode: "dry_run", format: "csv", content: csv }),
      mapping: { account: "seat" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.rowsParsed).toBe(2);
    expect(body.rowsRefused).toBe(1);
    expect(body.refusals[0]!.row).toBe(2);
    expect(body.refusals[0]!.reason).toMatch(/names no RegulAIt user/);
    expect(body.refusals[0]!.reason).toMatch(/never invents a person/);
    // the user table did not grow
    const ghosts = await db.select().from(users).where(eq(users.email, "roster-nobody@example.com"));
    expect(ghosts).toHaveLength(0);
  });

  it("one person given TWO different cost centres refuses those rows and leaves the person untouched", async () => {
    const csv = "seat,cc\n" + `${AMY},CC-ONE\n` + `${AMY},CC-TWO\n`;
    const res = await post("/v1/cost-imports/roster", {
      ...rosterBody({ mode: "apply", format: "csv", content: csv }),
      mapping: { account: "seat", costCenter: "cc" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.rowsRefused).toBe(2);
    expect(body.costCentersSet).toBe(0);
    expect(body.refusals[0]!.reason).toMatch(/AMBIGUOUS/);
    expect(body.refusals[0]!.reason).toContain("CC-ONE");
    expect(body.refusals[0]!.reason).toContain("CC-TWO");
    // Amy keeps the cost centre the earlier apply set
    const [amy] = await db.select({ costCenter: users.costCenter }).from(users).where(eq(users.id, amyId));
    expect(amy!.costCenter).toBe("CC-R&D");
  });
});

// ===========================================================================
// 5. The PII gate — exempt join keys, scanned cost centre
// ===========================================================================

describe("the ADR-0042 gate on the one retained non-identity column", () => {
  it("BLOCKS PII in the cost-centre column at mode block, counts only, nothing written", async () => {
    const csv = "seat,cc\n" + `${BEN},"owner someone@else.example"\n`;
    const res = await post("/v1/cost-imports/roster", {
      ...rosterBody({ mode: "apply", format: "csv", content: csv, piiMode: "block" }),
      mapping: { account: "seat", costCenter: "cc" },
    });
    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.error).toBe("ingest_blocked");
    expect(body.findings.pii.length).toBeGreaterThan(0);
    // COUNTS ONLY — the matched text must not come back
    expect(JSON.stringify(body.findings)).not.toContain("someone@else.example");
    expect(body.piiPosture).toMatch(/JOIN KEYS/);
    // nothing was written
    const [ben] = await db.select({ costCenter: users.costCenter }).from(users).where(eq(users.id, benId));
    expect(ben!.costCenter).toBeNull();
    const refused = await db.select().from(auditLog).where(eq(auditLog.ruleId, COST_IMPORT_RULE_IDS.rosterRefused));
    expect(refused.length).toBeGreaterThan(0);
    expect(refused.at(-1)!.effect).toBe("deny");
  });

  it("the SAME roster passes when the PII is only in the identity columns — the exemption is real", async () => {
    // Ben's seat is an email — pure identity — and there is no cost centre
    const csv = `seat\n${BEN}\n`;
    const res = await post("/v1/cost-imports/roster", {
      ...rosterBody({ mode: "dry_run", format: "csv", content: csv, piiMode: "block" }),
      mapping: { account: "seat" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ingestScan.verdict).toBe("clean");
    expect(res.json().rowsAccepted).toBe(1);
  });
});

// ===========================================================================
// 6. Default-deny
// ===========================================================================

describe("who may bulk-assert identity", () => {
  it("a non-admin cannot post a roster", async () => {
    const res = await post("/v1/cost-imports/roster", rosterBody(), amyAuth);
    expect(res.statusCode).toBe(403);
  });
});
