/**
 * ADR-0069 — CROSS-VENDOR COST CONSOLIDATION, PROVED THROUGH THE REAL API.
 *
 * WHAT THIS FILE TRIES TO MAKE IMPOSSIBLE TO FAKE
 * ----------------------------------------------
 *  1. A BLENDED TOTAL. The consolidated response — the WHOLE body, walked to
 *     any depth, numbers inside strings included — must not contain
 *     metered+imported anywhere. The fixture numbers are chosen so a collision
 *     is impossible. A future convenience `total` field fails here.
 *  2. A SILENTLY SMALLER TOTAL. A file with one corrupted amount must produce a
 *     refusal NAMING THE ROW, and `rowsParsed = accepted + refused` (a DB CHECK,
 *     not merely a response field).
 *  3. A VANISHING ACCOUNT. An account matching nobody must appear in the
 *     consolidated view as unattributed money, not disappear and not be spread.
 *  4. A DOUBLE COUNT. Re-applying identical bytes must be a real 409.
 *  5. AN UNGATED IMPORT. A non-admin must not be able to import, must not be
 *     able to read anyone else's consolidated spend, and must be able to read
 *     their own.
 *  6. AN UNTRACEABLE CHARGEBACK. Every attributed line must carry HOW it was
 *     matched, and an admin correcting a mapping must be audited AND must
 *     restate the already-stored lines.
 *
 * SHARED-STATE DISCIPLINE. `cost_import_batches`, `imported_cost_lines`,
 * `vendor_account_aliases` and `vendor_domain_rules` are org-wide; so are the
 * `usage_events` rows this suite inserts for the metered side. `afterAll`
 * deletes every row this suite created plus its audit rows and its users, so
 * the deployment ends the run exactly as it started. The ORG_SETTINGS singleton
 * is never touched.
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
  usageEvents,
  users,
  vendorAccountAliases,
  vendorDomainRules,
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

const BOOT = "cost-import-bootstrap-token";
const ADMIN = { authorization: `Bearer ${BOOT}` };

const JANE = "cost-import-jane@example.com";
const BOB = "cost-import-bob@example.com";
const GHOST = "cost-import-nobody@example.com";

let db: Db;
let app: ReturnType<typeof buildApp>;
let janeId: string;
let bobId: string;
let janeAuth: { authorization: string };
let bobAuth: { authorization: string };
const createdUserIds: string[] = [];

const post = (url: string, payload: unknown, headers = ADMIN) =>
  app.inject({ method: "POST", url, headers, payload: payload as object });
const put = (url: string, payload: unknown, headers = ADMIN) =>
  app.inject({ method: "PUT", url, headers, payload: payload as object });
const get = (url: string, headers = ADMIN) => app.inject({ method: "GET", url, headers });
const del = (url: string, payload: unknown = {}, headers = ADMIN) =>
  app.inject({ method: "DELETE", url, headers, payload: payload as object });

const RULE_IDS = Object.values(COST_IMPORT_RULE_IDS);

/** every finite number reachable in a value, INCLUDING numbers spelled inside
 * strings — a total rendered into a sentence is still a total. */
function everyNumber(value: unknown, out: number[] = []): number[] {
  if (typeof value === "number" && Number.isFinite(value)) out.push(value);
  else if (typeof value === "string") {
    let cur = "";
    for (const ch of value + " ") {
      if ((ch >= "0" && ch <= "9") || ch === ".") cur += ch;
      else {
        if (cur.length > 0) {
          const n = Number(cur);
          if (Number.isFinite(n)) out.push(n);
        }
        cur = "";
      }
    }
  } else if (Array.isArray(value)) for (const v of value) everyNumber(v, out);
  else if (value && typeof value === "object") for (const v of Object.values(value)) everyNumber(v, out);
  return out;
}

async function makeUser(email: string): Promise<{ id: string; auth: { authorization: string } }> {
  const res = await post("/v1/users", { email, displayName: email });
  expect(res.statusCode).toBe(201);
  const id = res.json().id as string;
  createdUserIds.push(id);
  const key = await post(`/v1/users/${id}/keys`, { name: "cost-import" });
  expect(key.statusCode).toBe(201);
  return { id, auth: { authorization: `Bearer ${key.json().token}` } };
}

// THE FIXTURE NUMBERS ARE THE EXPERIMENT. Jane has 61.11 metered and 146.30
// imported; if 207.41 shows up anywhere in a response, somebody added the two
// bases. Three seats at 146.30 plus 61.11 is 500.01, the fleet-wide version of
// the same lie. Neither value arises any other way in this fixture, so a hit is
// a blend and not a coincidence.
const METERED_USD = 61.11;
const SEAT_PRICE = 146.3;
/** what Jane's row would be if the two bases were added: 61.11 + 146.30 */
const SUBJECT_BLENDED = 207.41;
/** what the whole view would be if they were: 61.11 + 3 x 146.30 */
const FLEET_BLENDED = 500.01;

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT });

  const jane = await makeUser(JANE);
  janeId = jane.id;
  janeAuth = jane.auth;
  const bob = await makeUser(BOB);
  bobId = bob.id;
  bobAuth = bob.auth;

  // the METERED side: a real usage_events row for Jane, plus an UNPRICED one
  // (ADR-0051's rule — an unpriced event is unpriced, not zero)
  await db.insert(usageEvents).values([
    { userId: janeId, objectType: "agent", provider: "mock", model: "m", costUsd: METERED_USD },
    { userId: janeId, objectType: "agent", provider: "mock", model: "m", costUsd: null },
  ]);
});

afterAll(async () => {
  await db.delete(importedCostLines);
  await db.delete(costImportBatches);
  await db.delete(vendorAccountAliases);
  await db.delete(vendorDomainRules);
  await db.delete(auditLog).where(inArray(auditLog.ruleId, RULE_IDS));
  if (createdUserIds.length) {
    await db.delete(usageEvents).where(inArray(usageEvents.userId, createdUserIds));
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  await app.close();
});

// ===========================================================================
// 1. The registry
// ===========================================================================

describe("the adapter registry is a registry, and every adapter states its limits", () => {
  it("lists five adapters, each with declared capabilities and an honest limits string", async () => {
    const res = await get("/v1/cost-imports/adapters");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.adapters.map((a: { id: string }) => a.id).sort()).toEqual([
      "anthropic_console",
      "aws_cur",
      "generic_mapped",
      "openai_console",
      "seat_roster",
    ]);
    for (const a of body.adapters) {
      expect(a.limits.length).toBeGreaterThan(80);
      expect(a.capabilities).toHaveProperty("accountIsEmail");
    }
    expect(body.basisStatement).toMatch(/restated/);
    expect(body.piiPosture).toMatch(/exempt/);
    // the honest statement that there is nothing to poll
    expect(body.posture).toMatch(/no scheduled re-import/i);
  });

  it("refuses an unknown adapter by name and lists the real ones", async () => {
    const res = await post("/v1/cost-imports", { adapter: "definitely_not_real", content: "a,b\n1,2\n" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("unknown_adapter");
    expect(res.json().available).toContain("generic_mapped");
  });
});

// ===========================================================================
// 2. Nothing is silently dropped
// ===========================================================================

describe("a malformed row is refused BY ROW NUMBER, never dropped", () => {
  const CSV =
    "email,cost,month\n" +
    `${JANE},100.00,2026-07\n` +
    `${BOB},1OO.00,2026-07\n` + // capital letter O
    `${GHOST},50.00,2026-07\n`;

  it("dry run reports rowsParsed = accepted + refused, names row 3, and stores nothing", async () => {
    const res = await post("/v1/cost-imports", {
      adapter: "generic_mapped",
      format: "csv",
      mode: "dry_run",
      content: CSV,
      source: "unit-test.csv",
      config: { mapping: { account: "email", amount: "cost", period: "month" }, defaults: { vendor: "openai" } },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.rowsParsed).toBe(3);
    expect(body.rowsAccepted).toBe(2);
    expect(body.rowsRefused).toBe(1);
    expect(body.rowsAccepted + body.rowsRefused).toBe(body.rowsParsed);
    expect(body.refusals[0].row).toBe(3);
    expect(body.refusals[0].field).toBe("cost");
    expect(body.refusals[0].reason).toContain("1OO.00");
    expect(body.basis).toBe("imported");

    // a dry run WRITES NO LINES
    const lines = await db.select().from(importedCostLines);
    expect(lines).toHaveLength(0);
    // but it DOES leave a planned batch row — the preview is auditable too
    const [batch] = await db.select().from(costImportBatches).where(eq(costImportBatches.id, body.importId));
    expect(batch?.status).toBe("planned");
    expect(batch?.rowsRefused).toBe(1);
  });

  it("refuses a whole file that is not this adapter's format, naming the missing columns", async () => {
    const res = await post("/v1/cost-imports", {
      adapter: "openai_console",
      format: "csv",
      mode: "dry_run",
      content: "day,member,cost\n2026-07-01,x@y.com,1.00\n",
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe("unmappable_file");
    expect(String(res.json().missing)).toContain("account");
    expect(res.json().headersFound).toContain("day");
  });

  it("refuses an ambiguous date rather than moving spend between months", async () => {
    const res = await post("/v1/cost-imports", {
      adapter: "generic_mapped",
      format: "csv",
      mode: "dry_run",
      content: `email,cost,month\n${JANE},1.00,07/08/2026\n`,
      config: { mapping: { account: "email", amount: "cost", period: "month" }, defaults: { vendor: "openai" } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().rowsAccepted).toBe(0);
    expect(res.json().refusals[0].reason).toMatch(/ambiguous/);
  });
});

// ===========================================================================
// 3. Apply, identity resolution, the unmatched account, and the double count
// ===========================================================================

describe("applying an import", () => {
  let seatBatchId: string;

  it("stores lines, records HOW each was matched, and keeps the unmatched one visible", async () => {
    const res = await post("/v1/cost-imports", {
      adapter: "seat_roster",
      format: "csv",
      mode: "apply",
      content: `email,plan\n${JANE},business\n${BOB},business\n${GHOST},business\n`,
      source: "copilot-seats-2026-07.csv",
      config: {
        seatPriceUsd: SEAT_PRICE,
        vendor: "github-copilot",
        periodStart: "2026-07-01",
        periodEnd: "2026-08-01",
        planColumn: "plan",
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    seatBatchId = body.importId;
    expect(body.rowsAccepted).toBe(3);
    expect(body.resolution.byMethod.exact_email).toBe(2);
    expect(body.resolution.byMethod.unresolved).toBe(1);
    expect(body.resolution.unattributedAmount).toBe(SEAT_PRICE);
    expect(body.resolution.note).toMatch(/never assigned to a plausible-looking match/);
    expect(body.adapterLimits).toMatch(/ASSERTED BY THE OPERATOR/);

    const lines = await db.select().from(importedCostLines).where(eq(importedCostLines.batchId, seatBatchId));
    expect(lines).toHaveLength(3);
    // THE BASIS IS A DB-LEVEL FACT
    expect(lines.every((l) => l.basis === "imported")).toBe(true);
    const ghost = lines.find((l) => l.accountKey === GHOST)!;
    expect(ghost.resolvedUserId).toBeNull();
    expect(ghost.resolutionMethod).toBe("unresolved");
    expect(ghost.amount).toBe(SEAT_PRICE);
    const jane = lines.find((l) => l.accountKey === JANE)!;
    expect(jane.resolvedUserId).toBe(janeId);
    expect(jane.resolutionMethod).toBe("exact_email");
    expect(jane.resolutionDetail).toMatch(/matches this user's RegulAIt email/);
    expect(jane.sourceRow).toBe(2);
    expect(jane.detail).toMatchObject({ derivedFrom: "operator-asserted seat price" });
  });

  it("REFUSES the same bytes a second time rather than doubling every figure", async () => {
    const payload = {
      adapter: "seat_roster",
      format: "csv" as const,
      mode: "apply" as const,
      content: `email,plan\n${JANE},business\n${BOB},business\n${GHOST},business\n`,
      config: {
        seatPriceUsd: SEAT_PRICE,
        vendor: "github-copilot",
        periodStart: "2026-07-01",
        periodEnd: "2026-08-01",
        planColumn: "plan",
      },
    };
    const res = await post("/v1/cost-imports", payload);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("duplicate_import");
    expect(res.json().duplicateOf).toBe(seatBatchId);
    expect(res.json().detail).toMatch(/double every figure/);
    // and the refusal is itself a row + an audited deny
    const denies = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.ruleId, COST_IMPORT_RULE_IDS.importDuplicate));
    expect(denies.length).toBeGreaterThan(0);
    expect(denies[0]!.effect).toBe("deny");
    // no extra lines landed
    const lines = await db.select().from(importedCostLines).where(eq(importedCostLines.batchId, seatBatchId));
    expect(lines).toHaveLength(3);
  });

  it("an admin alias attributes the unmatched account, restates the STORED line, and is audited", async () => {
    const res = await post("/v1/cost-imports/mappings", {
      vendor: "github-copilot",
      accountRef: GHOST,
      userId: bobId,
      reason: "this seat is billed to Bob's alternate address; confirmed with IT",
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().reresolved.changed).toBe(1);

    const [ghost] = await db.select().from(importedCostLines).where(eq(importedCostLines.accountKey, GHOST));
    expect(ghost!.resolvedUserId).toBe(bobId);
    expect(ghost!.resolutionMethod).toBe("admin_alias");
    expect(ghost!.resolutionDetail).toMatch(/an administrator asserted/);
    expect(ghost!.resolutionMappingId).toBe(res.json().alias.id);

    const audits = await db.select().from(auditLog).where(eq(auditLog.ruleId, COST_IMPORT_RULE_IDS.aliasCreated));
    expect(audits.length).toBe(1);
    expect(audits[0]!.reason).toContain("confirmed with IT");
    expect(audits[0]!.reason).toContain("1 stored line(s) re-attributed");
  });

  it("removing the alias puts the line back to unattributed — visible, not deleted", async () => {
    const [alias] = await db.select().from(vendorAccountAliases);
    const res = await del(`/v1/cost-imports/mappings/${alias!.id}`);
    expect(res.statusCode).toBe(200);
    expect(res.json().reresolved.changed).toBe(1);
    const [ghost] = await db.select().from(importedCostLines).where(eq(importedCostLines.accountKey, GHOST));
    expect(ghost!.resolvedUserId).toBeNull();
    expect(ghost!.resolutionMethod).toBe("unresolved");
    expect(ghost!.amount).toBe(SEAT_PRICE);
  });

  it("a domain rule resolves an alternate corporate domain, and refuses to rewrite a domain to itself", async () => {
    const bad = await post("/v1/cost-imports/domain-rules", {
      fromDomain: "example.com",
      toDomain: "example.com",
      reason: "no-op",
    });
    expect(bad.statusCode).toBe(400);

    const rule = await post("/v1/cost-imports/domain-rules", {
      fromDomain: "cost-import-alt.example",
      toDomain: "example.com",
      reason: "the vendor bills our legacy domain",
    });
    expect(rule.statusCode).toBe(201);

    const imported = await post("/v1/cost-imports", {
      adapter: "generic_mapped",
      format: "csv",
      mode: "apply",
      content: `email,cost,month\ncost-import-jane@cost-import-alt.example,4.00,2026-07\n`,
      config: { mapping: { account: "email", amount: "cost", period: "month" }, defaults: { vendor: "cursor" } },
    });
    expect(imported.statusCode).toBe(201);
    expect(imported.json().resolution.byMethod.domain_rule).toBe(1);

    const [line] = await db
      .select()
      .from(importedCostLines)
      .where(eq(importedCostLines.batchId, imported.json().importId));
    expect(line!.resolvedUserId).toBe(janeId);
    expect(line!.resolutionMethod).toBe("domain_rule");
    expect(line!.resolutionDomainRuleId).toBe(rule.json().domainRule.id);

    // clean the rule back off so later assertions are not affected
    const removed = await del(`/v1/cost-imports/domain-rules/${rule.json().domainRule.id}`);
    expect(removed.statusCode).toBe(200);
    await db.delete(importedCostLines).where(eq(importedCostLines.batchId, imported.json().importId));
    await db.delete(costImportBatches).where(eq(costImportBatches.id, imported.json().importId));
  });

  it("revoking a batch withdraws its lines but KEEPS the batch row, and unblocks a re-import", async () => {
    const extra = await post("/v1/cost-imports", {
      adapter: "seat_roster",
      format: "csv",
      mode: "apply",
      content: `email,plan\n${JANE},team\n`,
      config: { seatPriceUsd: 1, vendor: "revoke-me", periodStart: "2026-07-01", periodEnd: "2026-08-01" },
    });
    expect(extra.statusCode).toBe(201);
    const id = extra.json().importId;

    const revoked = await del(`/v1/cost-imports/${id}`, { reason: "wrong file" });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json().linesRemoved).toBe(1);
    const [batch] = await db.select().from(costImportBatches).where(eq(costImportBatches.id, id));
    expect(batch?.status).toBe("revoked");
    expect(batch?.revokedAt).not.toBeNull();
    expect(await db.select().from(importedCostLines).where(eq(importedCostLines.batchId, id))).toHaveLength(0);

    // the same bytes may now be applied again — revocation IS the correction path
    const again = await post("/v1/cost-imports", {
      adapter: "seat_roster",
      format: "csv",
      mode: "apply",
      content: `email,plan\n${JANE},team\n`,
      config: { seatPriceUsd: 1, vendor: "revoke-me", periodStart: "2026-07-01", periodEnd: "2026-08-01" },
    });
    expect(again.statusCode).toBe(201);
    await db.delete(importedCostLines).where(eq(importedCostLines.batchId, again.json().importId));
    await db.delete(costImportBatches).where(eq(costImportBatches.id, again.json().importId));
    await db.delete(costImportBatches).where(eq(costImportBatches.id, id));

    const revokedAudit = await db.select().from(auditLog).where(eq(auditLog.ruleId, COST_IMPORT_RULE_IDS.importRevoked));
    expect(revokedAudit.length).toBe(1);
    expect(revokedAudit[0]!.reason).toContain("wrong file");
  });

  it("refuses to revoke something that was never applied", async () => {
    const [planned] = await db.select().from(costImportBatches).where(eq(costImportBatches.status, "planned"));
    const res = await del(`/v1/cost-imports/${planned!.id}`, { reason: "x" });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("not_revocable");
  });
});

// ===========================================================================
// 4. The ADR-0042 ingest gate
// ===========================================================================

describe("the ingest scan", () => {
  it("BLOCKS PII in a non-identity column, records counts only, and stores no lines", async () => {
    const res = await post("/v1/cost-imports", {
      adapter: "generic_mapped",
      format: "csv",
      mode: "apply",
      piiMode: "block",
      content: `email,cost,month,note\n${JANE},1.00,2026-07,"contact 555-01-2345 or someone@else.example"\n`,
      config: {
        mapping: { account: "email", amount: "cost", period: "month", description: "note" },
        defaults: { vendor: "openai" },
      },
    });
    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.error).toBe("ingest_blocked");
    expect(body.piiMode).toBe("block");
    expect(body.findings.pii.length).toBeGreaterThan(0);
    // COUNTS ONLY — the matched text must not come back
    expect(JSON.stringify(body.findings)).not.toContain("someone@else.example");
    expect(body.piiPosture).toMatch(/exempt/);

    const [batch] = await db.select().from(costImportBatches).where(eq(costImportBatches.id, body.importId));
    expect(batch?.status).toBe("refused");
    expect(await db.select().from(importedCostLines).where(eq(importedCostLines.batchId, body.importId))).toHaveLength(0);
  });

  it("does NOT block on the ACCOUNT column — the identity join key is exempt by construction", async () => {
    const res = await post("/v1/cost-imports", {
      adapter: "generic_mapped",
      format: "csv",
      mode: "dry_run",
      piiMode: "block",
      content: `email,cost,month\n${JANE},1.00,2026-07\n`,
      config: { mapping: { account: "email", amount: "cost", period: "month" }, defaults: { vendor: "openai" } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ingestScan.verdict).toBe("clean");
    expect(res.json().rowsAccepted).toBe(1);
  });
});

// ===========================================================================
// 5. The consolidated view — and the total that does not exist
// ===========================================================================

describe("the consolidated view", () => {
  it("reports metered and imported side by side, and NO number anywhere is their sum", async () => {
    const res = await get("/v1/cost-consolidated?from=2026-06-01T00:00:00.000Z&to=2027-01-01T00:00:00.000Z");
    expect(res.statusCode).toBe(200);
    const body = res.json();

    const jane = body.subjects.find((s: { subjectId: string }) => s.subjectId === janeId);
    expect(jane.metered.basis).toBe("metered");
    expect(jane.imported.basis).toBe("imported");
    expect(jane.metered.usd).toBe(METERED_USD);
    expect(jane.metered.unpricedEvents).toBe(1);
    expect(jane.imported.usd).toBe(SEAT_PRICE);
    expect(jane.coverage).toContain("not added together");

    // THE ADVERSARIAL ASSERTION, applied to JANE'S SUBJECT rather than to the
    // whole body. This route is fleet-wide by design, so when the full suite
    // runs it also reports every other suite's `usage_events` rows — real
    // behaviour, but it means a whole-body numeric assertion here would be
    // asserting things about other people's fixtures. Jane's subject is
    // entirely this suite's, and 61.11 + 146.30 = 207.41 arises no other way,
    // so a 207.41 inside it means somebody blended the bases. The whole-body
    // version of this assertion lives on the SELF-SCOPED route below, whose
    // response contains nothing but this suite's rows.
    expect(everyNumber(jane)).not.toContain(SUBJECT_BLENDED);
    expect(everyNumber(jane)).toContain(METERED_USD);
    expect(everyNumber(jane)).toContain(SEAT_PRICE);

    // and no field name invites the mistake
    const keys = new Set<string>();
    const walk = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") for (const [k, val] of Object.entries(v)) { keys.add(k.toLowerCase()); walk(val); }
    };
    walk(body.subjects);
    for (const forbidden of ["total", "combined", "grandtotal", "allusd"]) expect([...keys]).not.toContain(forbidden);

    expect(body.basisStatement).toMatch(/never added to `metered` spend/);
    expect(body.note).toMatch(/no combined figure/);
  });

  it("shows the unmatched vendor account as unattributed spend rather than losing it", async () => {
    const res = await get("/v1/cost-consolidated?from=2026-06-01T00:00:00.000Z&to=2027-01-01T00:00:00.000Z");
    const unattributed = res.json().subjects.find((s: { subjectId: string | null }) => s.subjectId === null);
    expect(unattributed).toBeDefined();
    expect(unattributed.attributed).toBe(false);
    expect(unattributed.imported.usd).toBe(SEAT_PRICE);
    expect(unattributed.label).toMatch(/unattributed/);
  });

  it("reports its own staleness, and says why there is no scheduled re-import", async () => {
    const res = await get("/v1/cost-consolidated?from=2026-06-01T00:00:00.000Z&to=2027-01-01T00:00:00.000Z");
    const staleness = res.json().staleness;
    expect(staleness.vendors.some((v: { vendor: string }) => v.vendor === "github-copilot")).toBe(true);
    expect(staleness.note).toMatch(/nothing to\s+poll|nothing to poll/);
  });

  it("groups by cost centre through the person-level chargeback key", async () => {
    const set = await put(`/v1/users/${janeId}/cost-center`, { costCenter: "CC-ENG" });
    expect(set.statusCode).toBe(200);
    expect(set.json().costCenter).toBe("CC-ENG");
    const audits = await db.select().from(auditLog).where(eq(auditLog.ruleId, COST_IMPORT_RULE_IDS.costCenterSet));
    expect(audits.length).toBe(1);

    const res = await get("/v1/cost-consolidated?by=cost_center&from=2026-06-01T00:00:00.000Z&to=2027-01-01T00:00:00.000Z");
    expect(res.statusCode).toBe(200);
    const cc = res.json().subjects.find((s: { subjectId: string | null }) => s.subjectId === "CC-ENG");
    expect(cc.metered.usd).toBe(METERED_USD);
    expect(cc.imported.usd).toBe(SEAT_PRICE);
    expect(everyNumber(cc)).not.toContain(SUBJECT_BLENDED);

    await put(`/v1/users/${janeId}/cost-center`, { costCenter: null });
  });

  it("the CSV export carries two money columns and no combined one", async () => {
    // the SELF-SCOPED CSV, so the body is this suite's rows and nothing else
    const res = await get(
      `/v1/users/${janeId}/cost-consolidated?format=csv&from=2026-06-01T00:00:00.000Z&to=2027-01-01T00:00:00.000Z`,
    );
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    const header = res.body.split("\n")[0]!;
    expect(header).toContain("metered_usd");
    expect(header).toContain("imported_usd");
    expect(header).not.toMatch(/total|combined/i);
    expect(res.body).toContain("61.11");
    expect(res.body).toContain("146.30");
    expect(everyNumber(res.body)).not.toContain(SUBJECT_BLENDED);
    expect(everyNumber(res.body)).not.toContain(FLEET_BLENDED);
  });

  it("refuses a window that ends before it starts", async () => {
    const res = await get("/v1/cost-consolidated?from=2027-01-01T00:00:00.000Z&to=2026-01-01T00:00:00.000Z");
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_window");
  });
});

// ===========================================================================
// 6. Default-deny
// ===========================================================================

describe("who may import, and who may see whose spend", () => {
  it("a non-admin cannot import", async () => {
    const res = await post(
      "/v1/cost-imports",
      { adapter: "generic_mapped", content: `email,cost,month\n${JANE},1.00,2026-07\n` },
      janeAuth,
    );
    expect(res.statusCode).toBe(403);
  });

  it("a non-admin cannot assert an identity mapping", async () => {
    const res = await post(
      "/v1/cost-imports/mappings",
      { accountRef: "x@y.com", userId: janeId, reason: "because" },
      janeAuth,
    );
    expect(res.statusCode).toBe(403);
  });

  it("a non-admin cannot read the fleet-wide consolidated view", async () => {
    const res = await get("/v1/cost-consolidated", janeAuth);
    expect(res.statusCode).toBe(403);
  });

  it("a non-admin CAN read their own — and gets a real number", async () => {
    const res = await get(
      `/v1/users/${janeId}/cost-consolidated?from=2026-06-01T00:00:00.000Z&to=2027-01-01T00:00:00.000Z`,
      janeAuth,
    );
    expect(res.statusCode).toBe(200);
    const jane = res.json().subjects.find((s: { subjectId: string }) => s.subjectId === janeId);
    expect(jane.metered.usd).toBe(METERED_USD);
    expect(jane.imported.usd).toBe(SEAT_PRICE);
    // THE WHOLE-BODY ADVERSARIAL ASSERTION. This response is scoped to one
    // user, so it contains this suite's rows and nothing else — every number at
    // every depth, numbers spelled inside sentences included, and neither
    // blended figure may appear anywhere in it.
    expect(everyNumber(res.json())).toContain(METERED_USD);
    expect(everyNumber(res.json())).toContain(SEAT_PRICE);
    expect(everyNumber(res.json())).not.toContain(SUBJECT_BLENDED);
    expect(everyNumber(res.json())).not.toContain(FLEET_BLENDED);
  });

  it("a non-admin CANNOT read somebody else's — cross-user cost visibility is an entitlement question", async () => {
    const res = await get(`/v1/users/${janeId}/cost-consolidated`, bobAuth);
    expect(res.statusCode).toBe(403);
    expect(res.json().detail).toMatch(/only your own/);
  });

  it("the self-scoped view leaks nothing about anyone else", async () => {
    const res = await get(
      `/v1/users/${bobId}/cost-consolidated?from=2026-06-01T00:00:00.000Z&to=2027-01-01T00:00:00.000Z`,
      bobAuth,
    );
    expect(res.statusCode).toBe(200);
    const subjects = res.json().subjects as Array<{ subjectId: string | null }>;
    expect(subjects.every((s) => s.subjectId === bobId)).toBe(true);
    expect(JSON.stringify(res.json())).not.toContain(janeId);
  });
});

// ===========================================================================
// 7. The database itself refuses a metered-looking imported row
// ===========================================================================

describe("the honesty spine is a database constraint, not a convention", () => {
  it("REFUSES to store an imported line claiming to be metered", async () => {
    const [batch] = await db.select().from(costImportBatches).where(eq(costImportBatches.status, "applied")).limit(1);
    expect(batch).toBeDefined();
    await expect(
      db.insert(importedCostLines).values({
        batchId: batch!.id,
        // the lie
        basis: "metered",
        vendor: "x",
        adapter: "generic_mapped",
        sourceRow: 1,
        accountRef: "a@b.com",
        accountKey: "a@b.com",
        resolutionMethod: "unresolved",
        resolutionDetail: "n/a",
        periodStart: new Date("2026-07-01"),
        periodEnd: new Date("2026-08-01"),
        amount: 1,
        currency: "USD",
        billingKind: "usage",
      }),
    ).rejects.toThrow();
  });

  it("REFUSES a row that claims a resolution method with no user behind it", async () => {
    const [batch] = await db.select().from(costImportBatches).where(eq(costImportBatches.status, "applied")).limit(1);
    await expect(
      db.insert(importedCostLines).values({
        batchId: batch!.id,
        vendor: "x",
        adapter: "generic_mapped",
        sourceRow: 1,
        accountRef: "a@b.com",
        accountKey: "a@b.com",
        resolvedUserId: null,
        resolutionMethod: "exact_email",
        resolutionDetail: "claims a match it does not have",
        periodStart: new Date("2026-07-01"),
        periodEnd: new Date("2026-08-01"),
        amount: 1,
        currency: "USD",
        billingKind: "usage",
      }),
    ).rejects.toThrow();
  });

  it("deleting a user un-attributes their imported spend rather than deleting it", async () => {
    const doomed = await makeUser("cost-import-doomed@example.com");
    const imported = await post("/v1/cost-imports", {
      adapter: "seat_roster",
      format: "csv",
      mode: "apply",
      content: `email,plan\ncost-import-doomed@example.com,pro\n`,
      config: { seatPriceUsd: 42, vendor: "doomed-vendor", periodStart: "2026-07-01", periodEnd: "2026-08-01" },
    });
    expect(imported.statusCode).toBe(201);
    const batchId = imported.json().importId;
    const [before] = await db.select().from(importedCostLines).where(eq(importedCostLines.batchId, batchId));
    expect(before!.resolvedUserId).toBe(doomed.id);

    await db.delete(users).where(eq(users.id, doomed.id));

    const [after] = await db.select().from(importedCostLines).where(eq(importedCostLines.batchId, batchId));
    expect(after).toBeDefined();
    expect(after!.amount).toBe(42);
    expect(after!.resolvedUserId).toBeNull();
    expect(after!.resolutionMethod).toBe("unresolved");
    expect(after!.resolutionDetail).toMatch(/has been deleted/);

    await db.delete(importedCostLines).where(eq(importedCostLines.batchId, batchId));
    await db.delete(costImportBatches).where(eq(costImportBatches.id, batchId));
  });
});
