/**
 * ADR-0071 — THE EVIDENCE FORMAT ADAPTERS, PROVED THROUGH THE REAL API.
 *
 * WHAT THIS FILE TRIES TO MAKE IMPOSSIBLE TO FAKE
 * ----------------------------------------------
 *  1. A PARALLEL PIPELINE. The headline claim of this slice is that the raw
 *     route is a LAYER over ADR-0055's importer, not a second importer. So a
 *     raw CEF file is applied and the assertions are made against ADR-0055's
 *     OWN artefacts: a `shadow_ai_imports` row with the SAME rule id the JSON
 *     route writes, a `shadow_ai_findings` row with the severity and provider
 *     ADR-0055's analyzer computes from the ADMIN catalogue, and the same audit
 *     rule id. Then the SAME evidence is sent through the JSON route and the
 *     analysis is asserted IDENTICAL.
 *  2. A PARSER THAT LOOKS RIGHT ON THE EASY CASE. The fixture's CEF header and
 *     extension both carry escaped separators (`\|`, `\=`) — the case a naive
 *     split gets wrong — and the resulting finding's subject is asserted to be
 *     the UNESCAPED identity, end to end through the API.
 *  3. A SILENTLY SMALLER INVENTORY. A file with one bad line is asserted to
 *     produce a real 422 that NAMES THE LINE NUMBER, with `rows_accepted` zero
 *     and NO finding written — not a quietly shorter success. The opt-in
 *     continue-mode is then asserted to still report every refusal.
 *  4. AN IMPORT THAT MINTS GOVERNANCE. A file whose text is full of privilege
 *     words is asserted to import as ordinary evidence with no user, role or
 *     grant created — because an adapter's output vocabulary is fixed by
 *     ADR-0055's row schemas, which is a stronger property than screening text.
 *  5. AN UNGATED IMPORT. A non-admin must not be able to list adapters or import.
 *  6. A CAPABILITY LIST THAT ONLY SAYS YES. The registry response must carry
 *     each adapter's `limits`, its `verification` claim, and the coverage
 *     posture sentence.
 *
 * SHARED-STATE DISCIPLINE. `ai_endpoint_signatures`, `shadow_ai_imports` and
 * `shadow_ai_findings` are org-wide, and `shadow-ai.test.ts` truncates them in
 * its own `afterAll`; `fileParallelism` is off, so the two never overlap. This
 * suite seeds the catalogue it needs in `beforeAll`, deletes every row it
 * created plus its audit rows and its user in `afterAll`, and never touches the
 * ORG_SETTINGS singleton.
 *
 * NO POSITIONAL ROW ASSERTIONS. Every row this suite asserts on is identified
 * by a value it chose (a subject host, an import id it was handed), never by
 * `[0]` out of an unordered query.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  aiEndpointSignatures,
  auditLog,
  createDb,
  eq,
  inArray,
  roles,
  runMigrations,
  shadowAiFindings,
  shadowAiImports,
  sql,
  users,
  type Db,
} from "@regulait/db";
import { EVIDENCE_ADAPTER_IDS } from "@regulait/shared";
import { SHADOW_AI_RULE_IDS } from "./shadow-ai.js";

const { buildApp } = await import("./app.js");

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "shadow-ai-adapters-bootstrap-token";
const ADMIN = { authorization: `Bearer ${BOOT}` };
const MEMBER_EMAIL = "shadow-ai-adapters-member@example.com";

let db: Db;
let app: ReturnType<typeof buildApp>;
let memberAuth: { authorization: string };
let memberId: string;

const post = (url: string, payload: unknown, headers = ADMIN) =>
  app.inject({ method: "POST", url, headers, payload: payload as object });
const get = (url: string, headers = ADMIN) => app.inject({ method: "GET", url, headers });

const RULE_IDS = Object.values(SHADOW_AI_RULE_IDS);

/** the hosts this suite invents, so its rows are identifiable by VALUE and its
 * cleanup cannot take anybody else's */
const HOST_OPENAI = "api.openai.com";
const CLIENT_ALICE = "alice=admin";

/**
 * THE FIXTURE THE SLICE TURNS ON. `Acme\|Corp` and `Egress to AI\|Model` carry
 * escaped pipes in the CEF header; `suser=alice\=admin` carries an escaped
 * equals inside an extension value. A naive `split()` mis-reads all three.
 */
const CEF_ESCAPED = String.raw`<134>Aug  7 12:00:00 gw CEF:0|Acme\|Corp|Proxy\\Gateway|4.2|100|Egress to AI\|Model|5|rt=1785000000000 dhost=api.openai.com suser=alice\=admin cnt=3 msg=allowed by policy A`;

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT });

  const seed = await post("/v1/shadow-ai/catalogue/seed", {});
  expect(seed.statusCode).toBe(200);

  const user = await post("/v1/users", { email: MEMBER_EMAIL, displayName: "adapters member" });
  expect(user.statusCode).toBe(201);
  memberId = user.json().id;
  const key = await post(`/v1/users/${memberId}/keys`, { name: "adapters" });
  expect(key.statusCode).toBe(201);
  memberAuth = { authorization: `Bearer ${key.json().token}` };
});

afterAll(async () => {
  await db.delete(shadowAiFindings);
  await db.delete(shadowAiImports);
  await db.delete(aiEndpointSignatures);
  await db.delete(auditLog).where(inArray(auditLog.ruleId, RULE_IDS));
  if (memberId) await db.delete(users).where(eq(users.id, memberId));
  await app.close();
});

// ===========================================================================
// 1. The registry
// ===========================================================================

describe("the adapter registry states what it cannot do", () => {
  it("lists every adapter with its limits, its verification claim and the coverage posture", async () => {
    const res = await get("/v1/shadow-ai/adapters");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.adapters.map((a: { id: string }) => a.id).sort()).toEqual([...EVIDENCE_ADAPTER_IDS].sort());
    for (const a of body.adapters as Array<{ limits: string; verification: string; formatBasis: string }>) {
      expect(a.limits.length).toBeGreaterThan(120);
      expect(a.verification.length).toBeGreaterThan(80);
      expect(["published-spec", "declared-format", "operator-mapped"]).toContain(a.formatBasis);
    }
    // the coverage claim ADR-0055 makes must survive this slice intact
    expect(body.posture).toMatch(/ships no collector/);
    expect(body.posture).toMatch(/Coverage remains exactly what you exported/);
    expect(body.pipeline).toMatch(/layer, not a second importer/);
  });

  it("refuses an unknown adapter by name, listing the ones that exist", async () => {
    const res = await post("/v1/shadow-ai/imports/raw", { adapter: "zscaler_nss", content: "x" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("unknown_adapter");
    expect(res.json().available).toContain("generic_mapped");
  });

  it("refuses a format the adapter does not read", async () => {
    const res = await post("/v1/shadow-ai/imports/raw", { adapter: "cef", format: "csv", content: "a,b" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("unsupported_format");
  });

  it("is admin-only in both directions — a member can neither list nor import", async () => {
    expect((await get("/v1/shadow-ai/adapters", memberAuth)).statusCode).toBe(403);
    const res = await post("/v1/shadow-ai/imports/raw", { adapter: "cef", content: CEF_ESCAPED }, memberAuth);
    expect(res.statusCode).toBe(403);
  });
});

// ===========================================================================
// 2. A raw CEF file flows through the EXISTING pipeline to a finding
// ===========================================================================

describe("a raw CEF file reaches a finding through ADR-0055's own pipeline", () => {
  let dryRunBody: Record<string, unknown>;

  it("previews without writing anything to the inventory", async () => {
    const before = await db.select({ n: sql<number>`count(*)::int` }).from(shadowAiFindings);
    const res = await post("/v1/shadow-ai/imports/raw", {
      adapter: "cef",
      content: CEF_ESCAPED,
      source: "adapters-suite.cef",
      mode: "dry_run",
    });
    expect(res.statusCode).toBe(200);
    dryRunBody = res.json();

    expect(dryRunBody.mode).toBe("dry_run");
    expect(dryRunBody.adapter).toBe("cef");
    expect(dryRunBody.kind).toBe("egress_log");
    expect(dryRunBody.rowsParsed).toBe(1);
    expect(dryRunBody.rowsAccepted).toBe(1);
    expect(dryRunBody.rowsRefused).toBe(0);
    expect(dryRunBody.limits).toMatch(/discarded/);
    expect(dryRunBody.verification).toMatch(/has NOT been run against a real export/);

    // THE ESCAPES SURVIVED END TO END: the subject is the unescaped identity a
    // naive split would have mangled, and the destination is the unescaped host.
    const findings = dryRunBody.findings as Array<{ subject: string; provider: string; severity: string; evidence: unknown[] }>;
    expect(findings).toHaveLength(1);
    expect(findings[0]!.subject).toBe(CLIENT_ALICE);
    expect(findings[0]!.provider).toBe("openai");
    // severity is ADR-0055's, computed from the ADMIN catalogue — not the CEF
    // record's own `severity=5`, which this adapter deliberately discards
    expect(findings[0]!.severity).toBe("high");

    const after = await db.select({ n: sql<number>`count(*)::int` }).from(shadowAiFindings);
    expect(after[0]!.n).toBe(before[0]!.n);
  });

  it("applies into shadow_ai_findings via the SAME rule ids the row-shaped import uses", async () => {
    const res = await post("/v1/shadow-ai/imports/raw", {
      adapter: "cef",
      content: CEF_ESCAPED,
      source: "adapters-suite.cef",
      mode: "apply",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.created + body.updated).toBe(1);

    // identified by the id the API HANDED us, never by position in a query
    const [importRow] = await db.select().from(shadowAiImports).where(eq(shadowAiImports.id, body.importId));
    expect(importRow).toBeDefined();
    expect(importRow!.status).toBe("applied");
    expect(importRow!.ruleId).toBe(SHADOW_AI_RULE_IDS.importApplied);
    expect(importRow!.rowCount).toBe(1);
    const summary = importRow!.summary as Record<string, unknown>;
    expect(summary.adapter).toBe("cef");
    expect(summary.rowsParsed).toBe(1);
    expect(summary.rowsAccepted).toBe(1);
    expect(summary.rowsRefused).toBe(0);
    expect(summary.formatBasis).toBe("published-spec");

    // the finding is identified by the SUBJECT this suite invented
    const [finding] = await db.select().from(shadowAiFindings).where(eq(shadowAiFindings.subject, CLIENT_ALICE));
    expect(finding).toBeDefined();
    expect(finding!.provider).toBe("openai");
    expect(finding!.severity).toBe("high");
    expect(finding!.observationCount).toBe(3); // the CEF `cnt`, honoured
    expect(finding!.lastImportId).toBe(body.importId);

    const audits = await db.select().from(auditLog).where(eq(auditLog.objectId, body.importId));
    expect(audits.some((a) => a.ruleId === SHADOW_AI_RULE_IDS.importApplied && a.effect === "allow")).toBe(true);
  });

  it("computes EXACTLY what the row-shaped import computes from the same evidence", async () => {
    // the same observation, hand-normalised the way a customer had to do it
    // BEFORE this slice existed. If the raw route were a second pipeline, these
    // two analyses could drift; they must not.
    const viaRows = await post("/v1/shadow-ai/imports", {
      kind: "egress_log",
      mode: "dry_run",
      rows: [
        {
          destinationHost: HOST_OPENAI,
          sourceIdentity: CLIENT_ALICE,
          observedAt: new Date(1785000000000).toISOString(),
          requestCount: 3,
        },
      ],
    });
    expect(viaRows.statusCode).toBe(200);
    const rowsBody = viaRows.json();

    expect(rowsBody.observed).toBe(dryRunBody.observed);
    expect(rowsBody.matched).toBe(dryRunBody.matched);
    expect(rowsBody.unmatched).toBe(dryRunBody.unmatched);
    expect(rowsBody.dropped).toBe(dryRunBody.dropped);
    expect(rowsBody.findings).toEqual(dryRunBody.findings);
  });
});

// ===========================================================================
// 3. A malformed line refuses, naming the line — it never returns less
// ===========================================================================

describe("a bad line is a refusal with a locus, never a quietly smaller result", () => {
  const RAGGED = [
    "CEF:0|Acme|Proxy|4.2|100|allowed|5|dhost=api.anthropic.com suser=ragged-bob",
    "Jul 30 09:00:00 gw this line is not a CEF record at all",
    "CEF:0|Acme|Proxy|4.2|100|allowed|5|dhost=api.mistral.ai suser=ragged-carol",
  ].join("\n");

  it("refuses the WHOLE file by default, naming the line, and writes no finding", async () => {
    const before = await db.select({ n: sql<number>`count(*)::int` }).from(shadowAiFindings);
    const res = await post("/v1/shadow-ai/imports/raw", { adapter: "cef", content: RAGGED, mode: "apply" });
    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.error).toBe("malformed_rows");
    expect(body.detail).toMatch(/starting at line 2/);
    expect(body.detail).toMatch(/SMALLER inventory that looks complete/);
    expect(body.rowsParsed).toBe(3);
    expect(body.rowsAccepted).toBe(0);
    expect(body.rowsRefused).toBe(1);
    expect(body.refusals[0].row).toBe(2);

    const [refusalRow] = await db.select().from(shadowAiImports).where(eq(shadowAiImports.id, body.importId));
    expect(refusalRow!.status).toBe("refused");
    expect(refusalRow!.ruleId).toBe(SHADOW_AI_RULE_IDS.rawMalformedRows);
    expect(refusalRow!.rowCount).toBe(0);

    const after = await db.select({ n: sql<number>`count(*)::int` }).from(shadowAiFindings);
    expect(after[0]!.n).toBe(before[0]!.n);

    const audits = await db.select().from(auditLog).where(eq(auditLog.objectId, body.importId));
    expect(audits.some((a) => a.ruleId === SHADOW_AI_RULE_IDS.rawMalformedRows && a.effect === "deny")).toBe(true);
  });

  it("the opt-in continue mode still reports every refusal with its line number", async () => {
    const res = await post("/v1/shadow-ai/imports/raw", {
      adapter: "cef",
      content: RAGGED,
      mode: "apply",
      onMalformedRow: "report_and_continue",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.rowsParsed).toBe(3);
    expect(body.rowsAccepted).toBe(2);
    expect(body.rowsRefused).toBe(1);
    expect(body.refusals[0].row).toBe(2);
    // the identity that is the whole claim that nothing was dropped
    expect(body.rowsAccepted + body.rowsRefused).toBe(body.rowsParsed);

    const [importRow] = await db.select().from(shadowAiImports).where(eq(shadowAiImports.id, body.importId));
    const summary = importRow!.summary as Record<string, unknown>;
    expect(summary.rowsRefused).toBe(1);
    expect((summary.refusals as Array<{ row: number }>)[0]!.row).toBe(2);

    const [bobFinding] = await db.select().from(shadowAiFindings).where(eq(shadowAiFindings.subject, "ragged-bob"));
    expect(bobFinding).toBeDefined();
    expect(bobFinding!.provider).toBe("anthropic");
  });

  it("refuses a file it cannot read at all as a WHOLE-FILE error, not 5,000 row errors", async () => {
    const res = await post("/v1/shadow-ai/imports/raw", {
      adapter: "w3c_extended",
      content: "2026-08-07 12:00:00 10.0.0.5 api.openai.com",
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe("unreadable_evidence_file");
    expect(res.json().detail).toMatch(/#Fields:/);
    const [row] = await db.select().from(shadowAiImports).where(eq(shadowAiImports.id, res.json().importId));
    expect(row!.status).toBe("refused");
    expect(row!.ruleId).toBe(SHADOW_AI_RULE_IDS.rawUnreadable);
  });

  it("refuses an adapter configuration it cannot honour", async () => {
    const res = await post("/v1/shadow-ai/imports/raw", {
      adapter: "proxy_common",
      content: "10.0.0.5 - - [07/Aug/2026:12:00:00 +0000] \"GET https://api.openai.com/x HTTP/1.1\" 200 5",
      config: { layout: "sniff-it-for-me" },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe("invalid_adapter_config");
  });
});

// ===========================================================================
// 4. The other adapters, end to end
// ===========================================================================

describe("the other grammars reach the same pipeline", () => {
  it("W3C extended: a #Fields:-driven proxy export lands as findings", async () => {
    const content = [
      "#Software: Acme Secure Web Gateway",
      "#Fields: date time c-ip cs-username cs-host sc-status",
      "2026-08-07 12:00:00 10.0.0.9 w3c-dave api.openai.com 200",
      "2026-08-07 12:00:01 10.0.0.9 w3c-dave github.com 200",
    ].join("\n");
    const res = await post("/v1/shadow-ai/imports/raw", { adapter: "w3c_extended", content, mode: "apply" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.rowsAccepted).toBe(2);
    // THE NEGATIVE TWIN: github.com is in the SAME file and must not be flagged
    expect(body.observed).toBe(2);
    expect(body.matched).toBe(1);
    expect(body.unmatched).toBe(1);

    const [finding] = await db.select().from(shadowAiFindings).where(eq(shadowAiFindings.subject, "w3c-dave"));
    expect(finding).toBeDefined();
    expect(finding!.provider).toBe("openai");
  });

  it("LEEF 2.0: a delimiter-bearing record lands, escaped delimiter and all", async () => {
    const content = String.raw`LEEF:2.0|Acme|Web|4.2|100|^|dstHostName=api.anthropic.com^usrName=leef\^erin^cnt=4`;
    const res = await post("/v1/shadow-ai/imports/raw", { adapter: "leef", content, mode: "apply" });
    expect(res.statusCode).toBe(200);
    const [finding] = await db.select().from(shadowAiFindings).where(eq(shadowAiFindings.subject, "leef^erin"));
    expect(finding).toBeDefined();
    expect(finding!.provider).toBe("anthropic");
    expect(finding!.observationCount).toBe(4);
  });

  it("proxy_common: a Squid line lands with the ident column as the actor", async () => {
    const content =
      "1785000000.000    412 10.0.0.11 TCP_MISS/200 5321 POST http://api.openai.com/v1/chat squid-frank DIRECT/1.2.3.4 application/json";
    const res = await post("/v1/shadow-ai/imports/raw", {
      adapter: "proxy_common",
      content,
      config: { layout: "squid" },
      mode: "apply",
    });
    expect(res.statusCode).toBe(200);
    const [finding] = await db.select().from(shadowAiFindings).where(eq(shadowAiFindings.subject, "squid-frank"));
    expect(finding).toBeDefined();
    expect(finding!.provider).toBe("openai");
  });

  it("generic_mapped: a CASB-shaped app-access CSV lands as saas_export evidence", async () => {
    const content = [
      "application,app_host,granted_by,assignments",
      "ChatGPT,chat.openai.com,sso-grace@example.com,12",
      "Confluence,atlassian.net,sso-grace@example.com,40",
    ].join("\n");
    const res = await post("/v1/shadow-ai/imports/raw", {
      adapter: "generic_mapped",
      format: "csv",
      content,
      config: { kind: "saas_export" },
      mode: "apply",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.kind).toBe("saas_export");
    expect(body.rowsAccepted).toBe(2);
    expect(body.matched).toBe(1); // ChatGPT only — Confluence is not AI
    const [finding] = await db.select().from(shadowAiFindings).where(eq(shadowAiFindings.subject, "ChatGPT"));
    expect(finding).toBeDefined();
    expect(finding!.provider).toBe("openai");
    expect(finding!.severity).toBe("medium"); // a consumer web app, per ADR-0055 §6
  });

  it("generic_mapped: an ambiguous header set is refused rather than guessed", async () => {
    const content = ["user,host,url", "ambiguous-hank,api.openai.com,https://api.openai.com/v1"].join("\n");
    const res = await post("/v1/shadow-ai/imports/raw", {
      adapter: "generic_mapped",
      format: "csv",
      content,
      config: { kind: "egress_log" },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().detail).toMatch(/ambiguous/);
  });
});

// ===========================================================================
// 5. An adapter cannot widen what an import can say
// ===========================================================================

describe("an adapter cannot mint governance, and the catalogue still decides everything", () => {
  it("a file stuffed with privilege words imports as ordinary evidence and creates nothing", async () => {
    const rolesBefore = await db.select({ n: sql<number>`count(*)::int` }).from(roles);
    const usersBefore = await db.select({ n: sql<number>`count(*)::int` }).from(users);

    // every one of these words is a SHADOW_AI_FORBIDDEN_KEYS entry, and the file
    // puts them where a naive importer might have retained them as fields
    const content = [
      "#Fields: date time cs-username cs-host",
      "2026-08-07 12:00:00 isAdmin api.openai.com",
      "2026-08-07 12:00:01 grants=all api.openai.com",
    ].join("\n");
    const res = await post("/v1/shadow-ai/imports/raw", { adapter: "w3c_extended", content, mode: "apply" });
    expect(res.statusCode).toBe(200);

    // they landed as an OPAQUE source identity — a string, not a field
    const [finding] = await db.select().from(shadowAiFindings).where(eq(shadowAiFindings.subject, "isAdmin"));
    expect(finding).toBeDefined();
    expect(finding!.provider).toBe("openai");

    const rolesAfter = await db.select({ n: sql<number>`count(*)::int` }).from(roles);
    const usersAfter = await db.select({ n: sql<number>`count(*)::int` }).from(users);
    expect(rolesAfter[0]!.n).toBe(rolesBefore[0]!.n);
    expect(usersAfter[0]!.n).toBe(usersBefore[0]!.n);
  });

  it("emptying the catalogue makes every adapter match nothing — detection is still DATA", async () => {
    const signatures = await db.select().from(aiEndpointSignatures);
    await db.delete(aiEndpointSignatures);
    try {
      const res = await post("/v1/shadow-ai/imports/raw", { adapter: "cef", content: CEF_ESCAPED, mode: "dry_run" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.rowsAccepted).toBe(1);
      expect(body.observed).toBe(1);
      expect(body.matched).toBe(0);
      expect(body.findings).toEqual([]);
    } finally {
      // restore the catalogue exactly as it was
      for (const s of signatures) {
        await db.insert(aiEndpointSignatures).values({
          id: s.id,
          provider: s.provider,
          kind: s.kind,
          value: s.value,
          matchType: s.matchType,
          minLength: s.minLength,
          replacementAgentId: s.replacementAgentId,
          replacementNote: s.replacementNote,
          provenance: s.provenance,
          enabled: s.enabled,
          lastUpdatedAt: s.lastUpdatedAt,
          updatedByUserId: s.updatedByUserId,
          createdAt: s.createdAt,
        });
      }
    }
  });

  it("the coverage statement survives: findings still say no collector ships", async () => {
    const res = await get("/v1/shadow-ai/findings");
    expect(res.statusCode).toBe(200);
    expect(res.json().coverage.statement).toMatch(/RegulAIt ships no collector/);
  });
});
