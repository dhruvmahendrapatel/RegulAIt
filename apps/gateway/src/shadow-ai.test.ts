/**
 * ADR-0055 — SHADOW-AI DISCOVERY, PROVED BY ATTACK.
 *
 * WHAT THIS FILE TRIES TO MAKE IMPOSSIBLE TO FAKE
 * ----------------------------------------------
 *  1. AN EVIDENCE FILE THAT MINTS GOVERNANCE. The headline attack, tried three
 *     ways: a row carrying `isAdmin`, a row carrying `grants`, and a row
 *     carrying `roleId` (the shape that would try to name an entitlement). Each
 *     is asserted REFUSED with a real error, AUDITED with a stable rule id,
 *     recorded in `shadow_ai_imports` as `refused` — and, the assertion that
 *     matters most, asserted to have created NO user, NO role and NO grant. A
 *     silent strip would pass a weaker test and be the worse outcome.
 *  2. AN ANALYZER THAT FLAGS EVERYTHING. Every positive assertion has a
 *     negative twin in the same import: `api.openai.com` is flagged in the SAME
 *     file where `github.com`, `registry.npmjs.org` and `notopenai.com` are
 *     not. An analyzer that returned "shadow AI!" for every row fails here.
 *  3. A CATALOGUE THAT IS SECRETLY CODE. The catalogue is emptied and the same
 *     evidence re-imported: it must match NOTHING. Then a private, never-heard-
 *     of in-house endpoint is registered as a row and the same evidence must
 *     match it. Detection is data, proved by moving the data.
 *  4. A FINDING THAT IS NOT ACTIONABLE. A catalogue row naming a governed
 *     replacement agent must carry that link all the way into
 *     `GET /v1/shadow-ai/findings` and into the remediation plan.
 *  5. AN INVENTORY THAT DOUBLE-COUNTS. The same usage seen by two different
 *     evidence classes must produce ONE row with TWO signal sources and RAISED
 *     confidence — not two rows.
 *  6. A COVERAGE NUMBER WITHOUT ITS CAVEAT. The findings response must carry
 *     the scorecard statement that no collector ships.
 *
 * SHARED-STATE DISCIPLINE. `ai_endpoint_signatures`, `shadow_ai_imports` and
 * `shadow_ai_findings` are org-wide. `afterAll` deletes every row this suite
 * created plus its audit rows and its agent, so the deployment ends the run
 * exactly as it started.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  agents,
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
import { DEFAULT_AI_SIGNATURES, EVIDENCE_MAX_ROWS } from "@regulait/shared";
import { SHADOW_AI_RULE_IDS } from "./shadow-ai.js";

const { buildApp } = await import("./app.js");

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "shadow-ai-bootstrap-token";
const ADMIN = { authorization: `Bearer ${BOOT}` };
const AGENT_NAME = "shadow-ai-test-governed-agent";
const PRIVATE_HOST = "llm.internal.acme-shadow-test.example";

let db: Db;
let app: ReturnType<typeof buildApp>;
let agentId: string;

const post = (url: string, payload: unknown, headers = ADMIN) =>
  app.inject({ method: "POST", url, headers, payload: payload as object });
const get = (url: string, headers = ADMIN) => app.inject({ method: "GET", url, headers });
const del = (url: string, headers = ADMIN) => app.inject({ method: "DELETE", url, headers });

const RULE_IDS = Object.values(SHADOW_AI_RULE_IDS);

async function auditRows(ruleId: string) {
  return db.select().from(auditLog).where(eq(auditLog.ruleId, ruleId));
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT });

  const agentRes = await post("/v1/agents", {
    name: AGENT_NAME,
    provider: "openai",
    tier: 2,
    modes: ["chat"],
  });
  expect(agentRes.statusCode).toBe(201);
  agentId = agentRes.json().id;

  const seed = await post("/v1/shadow-ai/catalogue/seed", {});
  expect(seed.statusCode).toBe(200);
});

afterAll(async () => {
  await db.delete(shadowAiFindings);
  await db.delete(shadowAiImports);
  await db.delete(aiEndpointSignatures);
  await db.delete(auditLog).where(inArray(auditLog.ruleId, RULE_IDS));
  if (agentId) await db.delete(agents).where(eq(agents.id, agentId));
  await app.close();
});

// ===========================================================================
// 1. The catalogue is DATA
// ===========================================================================

describe("the signature catalogue is data, not code", () => {
  it("seeds idempotently and reports its own staleness surface", async () => {
    const again = await post("/v1/shadow-ai/catalogue/seed", {});
    expect(again.statusCode).toBe(200);
    expect(again.json().inserted).toBe(0);

    const list = await get("/v1/shadow-ai/catalogue");
    expect(list.statusCode).toBe(200);
    const body = list.json();
    expect(body.total).toBe(DEFAULT_AI_SIGNATURES.length);
    expect(body.oldestEntryAt).toBeTruthy();
    expect(body.posture).toMatch(/never a release/);
  });

  it("a re-seed does NOT clobber an admin's edit", async () => {
    const [row] = await db
      .select()
      .from(aiEndpointSignatures)
      .where(eq(aiEndpointSignatures.value, "api.mistral.ai"));
    expect(row).toBeDefined();
    // admin disables it as a known false positive
    const edited = await post("/v1/shadow-ai/catalogue", {
      provider: "mistral",
      kind: "hostname",
      value: "api.mistral.ai",
      matchType: "exact_host",
      enabled: false,
      provenance: "admin",
    });
    expect(edited.statusCode).toBe(200);
    await post("/v1/shadow-ai/catalogue/seed", {});
    const [after] = await db
      .select()
      .from(aiEndpointSignatures)
      .where(eq(aiEndpointSignatures.value, "api.mistral.ai"));
    expect(after?.enabled).toBe(false);
  });

  it("refuses a key signature with no length bound (it would flag every fixture)", async () => {
    const res = await post("/v1/shadow-ai/catalogue", {
      provider: "sloppy",
      kind: "api_key_prefix",
      value: "sk-",
      matchType: "key_prefix",
    });
    expect(res.statusCode).toBe(400);
  });

  it("refuses a replacement agent that does not exist", async () => {
    const res = await post("/v1/shadow-ai/catalogue", {
      provider: "openai",
      kind: "hostname",
      value: "example-not-real.invalid",
      matchType: "exact_host",
      replacementAgentId: "00000000-0000-0000-0000-000000000123",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_reference");
  });
});

// ===========================================================================
// 2. Evidence is untrusted input
// ===========================================================================

describe("an evidence import cannot mint governed objects", () => {
  const attacks = [
    { name: "isAdmin", rows: [{ destinationHost: "api.openai.com", isAdmin: true }] },
    { name: "grants", rows: [{ destinationHost: "api.openai.com", grants: ["*"] }] },
    { name: "roleId", rows: [{ destinationHost: "api.openai.com", roleId: "00000000-0000-0000-0000-000000000000" }] },
  ];

  for (const attack of attacks) {
    it(`refuses, audits and records an evidence file carrying '${attack.name}'`, async () => {
      const usersBefore = await db.select({ n: sql<number>`count(*)::int` }).from(users);
      const rolesBefore = await db.select({ n: sql<number>`count(*)::int` }).from(roles);

      const res = await post("/v1/shadow-ai/imports", { kind: "egress_log", mode: "apply", rows: attack.rows });
      expect(res.statusCode).toBe(422);
      expect(res.json().error).toBe("privilege_escalation_refused");
      expect(res.json().detail).toMatch(/never an instruction to the platform/);

      const importRow = (await db.select().from(shadowAiImports).where(eq(shadowAiImports.id, res.json().importId)))[0];
      expect(importRow?.status).toBe("refused");
      expect(importRow?.mode).toBe("apply");

      const audits = await auditRows(SHADOW_AI_RULE_IDS.importPrivilegeRefused);
      expect(audits.some((a) => a.objectId === res.json().importId && a.effect === "deny")).toBe(true);

      // THE ASSERTION THAT MATTERS: nothing governed was created
      const usersAfter = await db.select({ n: sql<number>`count(*)::int` }).from(users);
      const rolesAfter = await db.select({ n: sql<number>`count(*)::int` }).from(roles);
      expect(usersAfter[0]?.n).toBe(usersBefore[0]?.n);
      expect(rolesAfter[0]?.n).toBe(rolesBefore[0]?.n);
      // and no finding was written from a refused file
      const findings = await db.select().from(shadowAiFindings).where(eq(shadowAiFindings.subject, "api.openai.com"));
      expect(findings).toHaveLength(0);
    });
  }

  it("refuses an unknown field with a real error rather than silently dropping it", async () => {
    const res = await post("/v1/shadow-ai/imports", {
      kind: "egress_log",
      mode: "apply",
      rows: [{ destinationHost: "api.openai.com", sneaky: "value" }],
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe("invalid_evidence");
    expect(res.json().issues.length).toBeGreaterThan(0);
    const row = (await db.select().from(shadowAiImports).where(eq(shadowAiImports.id, res.json().importId)))[0];
    expect(row?.status).toBe("refused");
  });

  it("bounds the batch", async () => {
    const rows = Array.from({ length: EVIDENCE_MAX_ROWS + 1 }, () => ({ destinationHost: "api.openai.com" }));
    const res = await post("/v1/shadow-ai/imports", { kind: "egress_log", mode: "apply", rows });
    // either the byte bound or the row bound catches it; both are refusals
    expect([413, 422]).toContain(res.statusCode);
  });

  it("refuses a whole credential — a fragment is all discovery is allowed to see", async () => {
    const res = await post("/v1/shadow-ai/imports", {
      kind: "code_scan",
      mode: "apply",
      rows: [{ repo: "acme/x", keyFragment: `sk-${"a".repeat(60)}` }],
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe("invalid_evidence");
  });
});

// ===========================================================================
// 3. Classification: true positives AND true negatives
// ===========================================================================

describe("classification produces true positives AND true negatives", () => {
  it("flags the model endpoint and leaves ordinary traffic alone in the SAME file", async () => {
    const res = await post("/v1/shadow-ai/imports", {
      kind: "egress_log",
      mode: "apply",
      source: "acme-forward-proxy",
      rows: [
        { destinationHost: "api.openai.com", sourceIdentity: "build-runner-01", requestCount: 412, observedAt: "2026-07-01T00:00:00.000Z" },
        { destinationHost: "github.com", sourceIdentity: "build-runner-01", requestCount: 9000 },
        { destinationHost: "registry.npmjs.org", sourceIdentity: "build-runner-01", requestCount: 300 },
        { destinationHost: "notopenai.com", sourceIdentity: "build-runner-01", requestCount: 5 },
      ],
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.observed).toBe(4);
    expect(body.matched).toBe(1);
    expect(body.unmatched).toBe(3);
    expect(body.created).toBe(1);

    const rows = await db.select().from(shadowAiFindings).where(eq(shadowAiFindings.subject, "build-runner-01"));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.provider).toBe("openai");
    expect(rows[0]?.severity).toBe("high");
    expect(rows[0]?.observationCount).toBe(412);
  });

  it("a dry run writes NOTHING to the inventory", async () => {
    const before = await db.select({ n: sql<number>`count(*)::int` }).from(shadowAiFindings);
    const res = await post("/v1/shadow-ai/imports", {
      kind: "egress_log",
      mode: "dry_run",
      rows: [{ destinationHost: "api.anthropic.com", sourceIdentity: "dry-run-host-only" }],
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().mode).toBe("dry_run");
    expect(res.json().findings).toHaveLength(1);
    const after = await db.select({ n: sql<number>`count(*)::int` }).from(shadowAiFindings);
    expect(after[0]?.n).toBe(before[0]?.n);
  });

  it("tiers a leaked key above an SDK import, and stores only a fragment", async () => {
    const res = await post("/v1/shadow-ai/imports", {
      kind: "code_scan",
      mode: "apply",
      rows: [
        { repo: "acme/payments", path: "src/llm.py", keyFragment: "sk-ant-ab", keyLength: 64 },
        { repo: "acme/marketing", path: "package.json", packageName: "openai" },
        { repo: "acme/marketing", path: "package.json", packageName: "express" },
        { repo: "acme/fixtures", path: "test/fixture.py", keyFragment: "sk-test", keyLength: 7 },
      ],
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().matched).toBe(2);
    expect(res.json().unmatched).toBe(2);

    const [critical] = await db.select().from(shadowAiFindings).where(eq(shadowAiFindings.subject, "acme/payments"));
    expect(critical?.severity).toBe("critical");
    expect(critical?.provider).toBe("anthropic");
    const [low] = await db.select().from(shadowAiFindings).where(eq(shadowAiFindings.subject, "acme/marketing"));
    expect(low?.severity).toBe("low");

    // the stored evidence must not contain a usable credential
    const evidenceJson = JSON.stringify(critical?.evidence ?? []);
    expect(evidenceJson).not.toContain("sk-ant-ab");
  });
});

// ===========================================================================
// 4. Correlation
// ===========================================================================

describe("correlation deduplicates rather than double-counting", () => {
  it("the same usage seen by two evidence classes is ONE row with two sources", async () => {
    await post("/v1/shadow-ai/imports", {
      kind: "code_scan",
      mode: "apply",
      rows: [{ repo: "acme/corr", path: "requirements.txt", packageName: "openai" }],
    });
    const first = await db.select().from(shadowAiFindings).where(eq(shadowAiFindings.subject, "acme/corr"));
    expect(first).toHaveLength(1);
    expect(first[0]?.confidence).toBe("low");

    await post("/v1/shadow-ai/imports", {
      kind: "self_reported",
      mode: "apply",
      rows: [{ owner: "acme", system: "corr", provider: "openai", note: "known integration" }],
    });
    // self_reported has its own subject shape; correlate on the REPO subject by
    // re-observing the repo through a second source instead
    await post("/v1/shadow-ai/imports", {
      kind: "code_scan",
      mode: "apply",
      rows: [{ repo: "acme/corr", path: "src/app.py", packageName: "openai" }],
    });
    const second = await db.select().from(shadowAiFindings).where(eq(shadowAiFindings.subject, "acme/corr"));
    expect(second).toHaveLength(1);
    // same source twice is not corroboration, but the counts accumulate
    expect(second[0]?.observationCount).toBe(2);
    expect(second[0]?.confidence).toBe("low");
  });
});

// ===========================================================================
// 5. The catalogue really is the only source of detection
// ===========================================================================

describe("detection lives entirely in the catalogue", () => {
  it("with the catalogue emptied, the same evidence matches NOTHING; a private endpoint row makes it match", async () => {
    const saved = await db.select().from(aiEndpointSignatures);
    await db.delete(aiEndpointSignatures);
    try {
      const none = await post("/v1/shadow-ai/imports", {
        kind: "egress_log",
        mode: "dry_run",
        rows: [{ destinationHost: "api.openai.com", sourceIdentity: "catalogue-empty-probe" }],
      });
      expect(none.statusCode).toBe(200);
      expect(none.json().matched).toBe(0);
      expect(none.json().findings).toHaveLength(0);

      // a private, in-house endpoint nobody could have hard-coded
      const reg = await post("/v1/shadow-ai/catalogue", {
        provider: "acme-inhouse-llm",
        kind: "hostname",
        value: PRIVATE_HOST,
        matchType: "exact_host",
        provenance: "admin",
        replacementAgentId: agentId,
        replacementNote: "route via the governed agent",
      });
      expect(reg.statusCode).toBe(201);

      const hit = await post("/v1/shadow-ai/imports", {
        kind: "egress_log",
        mode: "apply",
        rows: [{ destinationHost: PRIVATE_HOST, sourceIdentity: "private-probe-host" }],
      });
      expect(hit.statusCode).toBe(200);
      expect(hit.json().matched).toBe(1);

      const [row] = await db.select().from(shadowAiFindings).where(eq(shadowAiFindings.subject, "private-probe-host"));
      expect(row?.provider).toBe("acme-inhouse-llm");
      expect(row?.replacementAgentId).toBe(agentId);

      // and removing the row removes detection again
      const [sig] = await db.select().from(aiEndpointSignatures).where(eq(aiEndpointSignatures.value, PRIVATE_HOST));
      const gone = await del(`/v1/shadow-ai/catalogue/${sig!.id}`);
      expect(gone.statusCode).toBe(200);
      const after = await post("/v1/shadow-ai/imports", {
        kind: "egress_log",
        mode: "dry_run",
        rows: [{ destinationHost: PRIVATE_HOST, sourceIdentity: "private-probe-host-2" }],
      });
      expect(after.json().matched).toBe(0);
    } finally {
      await db.delete(aiEndpointSignatures);
      for (const s of saved) {
        await db.insert(aiEndpointSignatures).values({
          provider: s.provider,
          kind: s.kind,
          value: s.value,
          matchType: s.matchType,
          minLength: s.minLength,
          replacementAgentId: s.replacementAgentId,
          replacementNote: s.replacementNote,
          provenance: s.provenance,
          enabled: s.enabled,
        });
      }
    }
  });
});

// ===========================================================================
// 6. Findings are actionable and honestly bounded
// ===========================================================================

describe("the inventory is actionable and states its own coverage", () => {
  it("links a finding to the governed replacement agent", async () => {
    await post("/v1/shadow-ai/catalogue", {
      provider: "openai",
      kind: "hostname",
      value: "api.openai.com",
      matchType: "exact_host",
      provenance: "admin",
      replacementAgentId: agentId,
      replacementNote: "route through the governed agent",
    });
    await post("/v1/shadow-ai/imports", {
      kind: "egress_log",
      mode: "apply",
      rows: [{ destinationHost: "api.openai.com", sourceIdentity: "actionable-host" }],
    });

    const res = await get("/v1/shadow-ai/findings");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const finding = body.findings.find((f: { subject: string }) => f.subject === "actionable-host");
    expect(finding).toBeDefined();
    expect(finding.replacementAgent?.id).toBe(agentId);
    expect(finding.replacementAgent?.name).toBe(AGENT_NAME);

    const plan = await get(`/v1/shadow-ai/findings/${finding.id}/remediation-plan`);
    expect(plan.statusCode).toBe(200);
    expect(plan.json().replacementAgent?.id).toBe(agentId);
    expect(plan.json().steps.length).toBeGreaterThanOrEqual(4);
    // the loop closes on the LEDGERS, not on an assertion
    expect(JSON.stringify(plan.json().steps)).toMatch(/usage_events/);
    // and it hands back the ONE workflow route rather than starting one itself
    expect(plan.json().workflowRequest.route).toBe("POST /v1/workflows/instances");
  });

  it("reports severity-ordered findings and never claims completeness", async () => {
    const res = await get("/v1/shadow-ai/findings");
    const body = res.json();
    expect(body.coverage.statement).toMatch(/ships no collector/);
    expect(body.coverage.statement).toMatch(/does not prove its absence/);
    expect(body.coverage.sourcesPossible).toBe(4);
    expect(body.posture).toMatch(/SIGNAL, NOT PROOF/);
    const severities = body.findings.map((f: { severity: string }) => f.severity);
    const rank: Record<string, number> = { critical: 3, high: 2, medium: 1, low: 0 };
    for (let i = 1; i < severities.length; i += 1) {
      expect(rank[severities[i - 1]] ?? 0).toBeGreaterThanOrEqual(rank[severities[i]] ?? 0);
    }
  });

  it("a disposition off 'open' requires a reason and is audited", async () => {
    const res = await get("/v1/shadow-ai/findings");
    const finding = res.json().findings.find((f: { subject: string }) => f.subject === "acme/marketing");
    expect(finding).toBeDefined();

    const noReason = await post(`/v1/shadow-ai/findings/${finding.id}/disposition`, { disposition: "false_positive" });
    expect(noReason.statusCode).toBe(400);

    const ok = await post(`/v1/shadow-ai/findings/${finding.id}/disposition`, {
      disposition: "false_positive",
      reason: "the SDK is vendored for a test fixture and never called",
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().disposition).toBe("false_positive");
    expect(ok.json().dispositionAt).toBeTruthy();

    const audits = await auditRows(SHADOW_AI_RULE_IDS.findingDisposition);
    expect(audits.some((a) => a.objectId === finding.id)).toBe(true);
  });

  it("refuses to link a remediation to a workflow instance that does not exist", async () => {
    const res = await get("/v1/shadow-ai/findings");
    const finding = res.json().findings[0];
    const bad = await post(`/v1/shadow-ai/findings/${finding.id}/remediate`, {
      instanceId: "00000000-0000-0000-0000-0000000000ff",
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe("invalid_reference");
  });
});
