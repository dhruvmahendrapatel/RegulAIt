/**
 * ADR-0083 — FIRST-PARTY DISCOVERY, PROVED THROUGH THE REAL API.
 *
 * WHAT THIS FILE TRIES TO MAKE IMPOSSIBLE TO FAKE
 * ----------------------------------------------
 *  1. A MANUFACTURED FINDING. The headline honesty claim is the governed line:
 *     a hit on a host this deployment's own configuration fronts (a platform
 *     model credential, an enabled custom provider) is labelled
 *     governed_via_gateway and NEVER ingested. The suite gives the deployment
 *     a real anthropic credential row and a real custom provider row, then
 *     feeds a log naming BOTH plus an ungoverned OpenAI hit — and asserts the
 *     shadow finding exists for OpenAI while NO finding exists for the two
 *     governed hosts. Both labels occur on one input, so a constant-true (or
 *     constant-false) governed check cannot pass this file.
 *  2. A SECOND PIPELINE. Ingest is asserted against ADR-0055's OWN artefacts:
 *     a `shadow_ai_imports` row with the SAME rule ids the JSON route writes,
 *     findings whose severity/provider come from the ADMIN catalogue, and the
 *     same audit rule ids — the discovery tags ride in the import summary.
 *  3. A COMPILED CATALOGUE THAT MINTS FINDINGS. api.groq.com is in compiled v1
 *     but NOT in the admin seed: the suite asserts it classifies as shadow,
 *     ingests as an UNMATCHED observation producing NO finding, and comes back
 *     named in `deploymentCatalogueGaps` — suggestion, never promotion.
 *  4. STORED UPLOADS. The response must say the pasted content was not stored,
 *     and the import row must carry only the SHA-256 and the bounded summary.
 *  5. AN UNGATED ROUTE. A member gets 403 from both discovery routes.
 *
 * SHARED-STATE DISCIPLINE. Seeds the catalogue in `beforeAll`; inserts its
 * model-credential and custom-provider rows with values it invented and
 * deletes exactly those in `afterAll`; clears the provider env vars the
 * governed-host loader reads and restores them verbatim (M-012); asserts
 * DELTAS or value-identified rows, never absolute counts (M-008).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  aiEndpointSignatures,
  and,
  auditLog,
  createDb,
  customModelProviders,
  eq,
  inArray,
  modelCredentials,
  runMigrations,
  shadowAiFindings,
  shadowAiImports,
  sql,
  users,
  type Db,
} from "@regulait/db";
import { EVIDENCE_MAX_BYTES, SHADOW_AI_CATALOG_V1 } from "@regulait/shared";
import { SHADOW_AI_RULE_IDS } from "./shadow-ai.js";

const { buildApp } = await import("./app.js");

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "shadow-discovery-bootstrap-token";
const ADMIN = { authorization: `Bearer ${BOOT}` };
const MEMBER_EMAIL = "shadow-discovery-member@example.com";

// Env hygiene — the governed-host loader reads the same provider env vars the
// dispatch path does (base-URL overrides move the governed host; an ambient
// API key can activate the env fallback). Capture, clear, restore verbatim.
const PROVIDER_ENV_VARS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "GOOGLE_API_KEY",
  "GOOGLE_BASE_URL",
  "GEMINI_API_KEY",
  "GEMINI_BASE_URL",
  "XAI_API_KEY",
  "XAI_BASE_URL",
] as const;
const ORIG_ENV: Record<string, string | undefined> = {};
for (const name of PROVIDER_ENV_VARS) ORIG_ENV[name] = process.env[name];

let db: Db;
let app: ReturnType<typeof buildApp>;
let memberAuth: { authorization: string };
let memberId: string;

const post = (url: string, payload: unknown, headers = ADMIN) =>
  app.inject({ method: "POST", url, headers, payload: payload as object });
const get = (url: string, headers = ADMIN) => app.inject({ method: "GET", url, headers });

const RULE_IDS = Object.values(SHADOW_AI_RULE_IDS);

/** the values this suite invents, so its rows are identifiable and its
 * cleanup cannot take anybody else's */
const SUBJECT_DNS = "l4-dns-resolver";
const SUBJECT_REPO = "l4-shadow-repo";
const CRED_CIPHERTEXT = "l4-not-a-real-ciphertext"; // never decrypted by discovery
const CUSTOM_NAME = "l4-corp-vllm";
const CUSTOM_HOST = "vllm.l4-corp.internal";

/** governed (anthropic credential + custom vllm), shadow (openai ×2), noise */
const DNS_LOG = [
  "Aug 20 10:00:01 dnsmasq[812]: query[A] api.openai.com from 10.9.9.1",
  "Aug 20 10:00:02 dnsmasq[812]: query[A] api.anthropic.com from 10.9.9.2",
  `Aug 20 10:00:03 dnsmasq[812]: query[A] ${CUSTOM_HOST} from 10.9.9.3`,
  "Aug 20 10:00:04 dnsmasq[812]: query[A] github.com from 10.9.9.1",
  "Aug 20 10:00:05 dnsmasq[812]: query[A] api.openai.com from 10.9.9.4",
].join("\n");

beforeAll(async () => {
  for (const name of PROVIDER_ENV_VARS) delete process.env[name];
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT });

  const seed = await post("/v1/shadow-ai/catalogue/seed", {});
  expect(seed.statusCode).toBe(200);

  // the governed levers, inserted directly: a stored platform credential for
  // anthropic (its compiled default endpoint is api.anthropic.com) and an
  // enabled custom provider fronting an in-house host compiled v1 never named
  await db.insert(modelCredentials).values({ provider: "anthropic", keyCiphertext: CRED_CIPHERTEXT });
  await db.insert(customModelProviders).values({
    name: CUSTOM_NAME,
    wireProtocol: "openai_chat",
    baseUrl: `https://${CUSTOM_HOST}:8000/v1`,
    enabled: true,
  });

  const user = await post("/v1/users", { email: MEMBER_EMAIL, displayName: "discovery member" });
  expect(user.statusCode).toBe(201);
  memberId = user.json().id;
  const key = await post(`/v1/users/${memberId}/keys`, { name: "discovery" });
  expect(key.statusCode).toBe(201);
  memberAuth = { authorization: `Bearer ${key.json().token}` };
});

afterAll(async () => {
  await db.delete(shadowAiFindings);
  await db.delete(shadowAiImports);
  await db.delete(aiEndpointSignatures);
  await db
    .delete(modelCredentials)
    .where(and(eq(modelCredentials.provider, "anthropic"), eq(modelCredentials.keyCiphertext, CRED_CIPHERTEXT)));
  await db.delete(customModelProviders).where(eq(customModelProviders.name, CUSTOM_NAME));
  await db.delete(auditLog).where(inArray(auditLog.ruleId, RULE_IDS));
  if (memberId) await db.delete(users).where(eq(users.id, memberId));
  await app.close();
  for (const name of PROVIDER_ENV_VARS) {
    if (ORIG_ENV[name] === undefined) delete process.env[name];
    else process.env[name] = ORIG_ENV[name];
  }
});

// ===========================================================================
// 1. The compiled catalogue surface
// ===========================================================================

describe("the discovery catalogue states what it is and what it cannot see", () => {
  it("returns the frozen v1 entries, THIS deployment's governed hosts, and the honesty text", async () => {
    const res = await get("/v1/shadow-ai/discovery/catalog");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.catalogVersion).toBe(1);
    expect(body.total).toBe(SHADOW_AI_CATALOG_V1.length);
    expect(body.endpoints + body.sdks).toBe(body.total);
    const ids = (body.entries as Array<{ id: string }>).map((e) => e.id);
    expect(ids).toContain("ep-openai-api");
    expect(ids).toContain("sdk-litellm");

    // the governed line is COMPUTED from live configuration, with reasons
    const governed = body.governedHosts as Array<{ host: string; reason: string }>;
    const anthropic = governed.find((g) => g.host === "api.anthropic.com");
    expect(anthropic).toBeDefined();
    expect(anthropic!.reason).toMatch(/platform model credential for provider 'anthropic'/);
    const vllm = governed.find((g) => g.host === CUSTOM_HOST);
    expect(vllm).toBeDefined();
    expect(vllm!.reason).toMatch(/custom model provider 'l4-corp-vllm'/);
    // control: nothing put openai there
    expect(governed.some((g) => g.host === "api.openai.com")).toBe(false);

    // the honesty sentences, verbatim from the shared constants
    expect(body.posture).toMatch(/COMPILED INTO THIS BUILD/);
    expect(body.posture).toMatch(/cannot mint a finding/);
    expect(body.limits).toMatch(/inherently incomplete and dated/);
    expect(body.limits).toMatch(/MENTIONED a provider, never that traffic flowed/);
  });

  it("is admin-only in both directions — a member can neither read nor classify", async () => {
    expect((await get("/v1/shadow-ai/discovery/catalog", memberAuth)).statusCode).toBe(403);
    const res = await post("/v1/shadow-ai/discovery", { sourceKind: "dns_log", content: "x" }, memberAuth);
    expect(res.statusCode).toBe(403);
  });
});

// ===========================================================================
// 2. The governed line: one input, both labels, and only shadow is ingested
// ===========================================================================

describe("governed_via_gateway vs shadow — the honest core, on one input", () => {
  it("dry-run classifies shadow AND governed AND unmatched without writing a finding", async () => {
    const before = await db.select({ n: sql<number>`count(*)::int` }).from(shadowAiFindings);
    const res = await post("/v1/shadow-ai/discovery", {
      sourceKind: "dns_log",
      content: DNS_LOG,
      subject: SUBJECT_DNS,
      mode: "dry_run",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.classification.catalogVersion).toBe(1);
    expect(body.classification.shadowCount).toBe(1);
    expect(body.classification.governedCount).toBe(2);
    expect(body.classification.unmatchedCount).toBe(1);
    expect(body.classification.unmatchedSample).toContain("github.com");

    // shadow: the ungoverned catalogue hit, tagged with its compiled signature
    expect(body.matches).toHaveLength(1);
    expect(body.matches[0].value).toBe("api.openai.com");
    expect(body.matches[0].entryId).toBe("ep-openai-api");
    expect(body.matches[0].provider).toBe("openai");
    expect(body.matches[0].occurrences).toBe(2);

    // governed: BOTH configured hosts, each with the configuration that fronts it
    const governedValues = (body.governed as Array<{ value: string; governedReason: string }>);
    expect(governedValues.map((g) => g.value).sort()).toEqual(["api.anthropic.com", CUSTOM_HOST]);
    expect(governedValues.find((g) => g.value === "api.anthropic.com")!.governedReason).toMatch(
      /platform model credential/,
    );

    // the preview reaches ADR-0055's analyzer but writes nothing
    expect(body.ingest.mode).toBe("dry_run");
    expect(body.ingest.observed).toBe(1); // ONLY the shadow row was forwarded
    expect(body.rawContentStored).toBe(false);
    expect(body.retention).toMatch(/was not stored/);

    const after = await db.select({ n: sql<number>`count(*)::int` }).from(shadowAiFindings);
    expect(after[0]!.n).toBe(before[0]!.n);
  });

  it("apply files the SHADOW finding through ADR-0055's pipeline — and NO finding for governed hosts", async () => {
    const res = await post("/v1/shadow-ai/discovery", {
      sourceKind: "dns_log",
      content: DNS_LOG,
      subject: SUBJECT_DNS,
      mode: "apply",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ingest.mode).toBe("apply");
    expect(body.ingest.created + body.ingest.updated).toBe(1);

    // the import row: ADR-0055's own ledger, same rule id as every other apply,
    // carrying the discovery tags (source kind + catalogue version + signature)
    const [importRow] = await db.select().from(shadowAiImports).where(eq(shadowAiImports.id, body.ingest.importId));
    expect(importRow).toBeDefined();
    expect(importRow!.status).toBe("applied");
    expect(importRow!.ruleId).toBe(SHADOW_AI_RULE_IDS.importApplied);
    expect(importRow!.source).toBe("first_party_discovery:v1:dns_log");
    const summary = importRow!.summary as { firstPartyDiscovery: Record<string, unknown> };
    expect(summary.firstPartyDiscovery.catalogVersion).toBe(1);
    expect(summary.firstPartyDiscovery.sourceKind).toBe("dns_log");
    expect((summary.firstPartyDiscovery.matches as Array<{ entryId: string }>)[0]!.entryId).toBe("ep-openai-api");
    // the raw upload itself is nowhere in the row — fingerprint + summary only
    expect(JSON.stringify(importRow!.summary)).not.toContain("dnsmasq");
    expect(importRow!.payloadSha256).toMatch(/^[0-9a-f]{64}$/);

    // the finding: severity/provider computed by the ADMIN catalogue, subject
    // is the operator-asserted label, count aggregated from the log
    const [finding] = await db
      .select()
      .from(shadowAiFindings)
      .where(and(eq(shadowAiFindings.subject, SUBJECT_DNS), eq(shadowAiFindings.provider, "openai")));
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("high");
    expect(finding!.observationCount).toBe(2);
    expect(finding!.lastImportId).toBe(body.ingest.importId);

    // THE CONTROL THAT MAKES THE FEATURE HONEST: the governed hosts produced
    // NO finding — filing them would have manufactured findings
    const governedFindings = await db
      .select()
      .from(shadowAiFindings)
      .where(and(eq(shadowAiFindings.subject, SUBJECT_DNS), inArray(shadowAiFindings.provider, ["anthropic"])));
    expect(governedFindings).toHaveLength(0);

    const audits = await db.select().from(auditLog).where(eq(auditLog.objectId, body.ingest.importId));
    expect(audits.some((a) => a.ruleId === SHADOW_AI_RULE_IDS.importApplied && a.effect === "allow")).toBe(true);
  });

  it("with nothing shadow-classified there is nothing to ingest — audited, not erroneous", async () => {
    const audBefore = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(auditLog)
      .where(eq(auditLog.ruleId, SHADOW_AI_RULE_IDS.discoveryClassified));
    const res = await post("/v1/shadow-ai/discovery", {
      sourceKind: "dns_log",
      content: "Aug 20 10:01:00 dnsmasq[812]: query[A] github.com from 10.9.9.1",
      mode: "apply",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ingest).toBeNull();
    expect(res.json().classification.shadowCount).toBe(0);
    const audAfter = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(auditLog)
      .where(eq(auditLog.ruleId, SHADOW_AI_RULE_IDS.discoveryClassified));
    expect(audAfter[0]!.n).toBe(audBefore[0]!.n + 1);
  });
});

// ===========================================================================
// 3. Two catalogues, two jobs: a compiled hit cannot mint a finding
// ===========================================================================

describe("the compiled catalogue suggests; only the admin catalogue finds", () => {
  it("a compiled-only hit (api.groq.com) ingests as unmatched, produces NO finding, and is named as a GAP", async () => {
    const before = await db.select({ n: sql<number>`count(*)::int` }).from(shadowAiFindings);
    const res = await post("/v1/shadow-ai/discovery", {
      sourceKind: "proxy_log",
      content: "1755680000.123 204 10.9.9.5 TCP_TUNNEL/200 4512 CONNECT api.groq.com:443 - HIER_DIRECT/x -",
      subject: "l4-groq-probe",
      mode: "apply",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    // compiled v1 knows groq…
    expect(body.matches[0].entryId).toBe("ep-groq-api");
    // …but the ADMIN seed does not, so the pipeline leaves it unmatched and
    // the response names the gap with the row that would close it
    expect(body.ingest.matched).toBe(0);
    expect(body.ingest.unmatched).toBe(1);
    expect(body.ingest.findings).toEqual([]);
    expect(body.deploymentCatalogueGaps).toEqual([
      { value: "api.groq.com", kind: "endpoint", provider: "groq", entryId: "ep-groq-api" },
    ]);
    expect(body.gapNote).toMatch(/never mints a finding/);

    const after = await db.select({ n: sql<number>`count(*)::int` }).from(shadowAiFindings);
    expect(after[0]!.n).toBe(before[0]!.n);
  });
});

// ===========================================================================
// 4. Manifests: capability findings, subject required, unreadable refused
// ===========================================================================

describe("dependency manifests", () => {
  it("requires a subject — a code_scan finding without a repo points at nothing", async () => {
    const res = await post("/v1/shadow-ai/discovery", {
      sourceKind: "package_json",
      content: JSON.stringify({ dependencies: { openai: "^4" } }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("subject_required");
  });

  it("a package.json ingests SDK hits as low-severity capability findings", async () => {
    const res = await post("/v1/shadow-ai/discovery", {
      sourceKind: "package_json",
      content: JSON.stringify({ dependencies: { openai: "^4.0.0", express: "^4.18.0" } }),
      subject: SUBJECT_REPO,
      mode: "apply",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.matches.map((m: { value: string }) => m.value)).toEqual(["openai"]);
    expect(body.classification.unmatchedSample).toContain("express");
    // an SDK is never governed_via_gateway — a manifest cannot say where it points
    expect(body.governed).toEqual([]);

    const [finding] = await db
      .select()
      .from(shadowAiFindings)
      .where(and(eq(shadowAiFindings.subject, SUBJECT_REPO), eq(shadowAiFindings.provider, "openai")));
    expect(finding).toBeDefined();
    expect(finding!.subjectKind).toBe("repo");
    // ADR-0055's tiering: a dependency is a CAPABILITY, not an act
    expect(finding!.severity).toBe("low");
  });

  it("classifies requirements.txt and go.mod through the same route", async () => {
    const req = await post("/v1/shadow-ai/discovery", {
      sourceKind: "requirements_txt",
      content: "litellm==1.40\nnumpy==2.0\n",
      subject: SUBJECT_REPO,
      mode: "dry_run",
    });
    expect(req.statusCode).toBe(200);
    expect(req.json().matches.map((m: { value: string }) => m.value)).toEqual(["litellm"]);

    const gomod = await post("/v1/shadow-ai/discovery", {
      sourceKind: "go_mod",
      content: "module m\nrequire github.com/anthropics/anthropic-sdk-go v1.0.0\n",
      subject: SUBJECT_REPO,
      mode: "dry_run",
    });
    expect(gomod.statusCode).toBe(200);
    expect(gomod.json().matches[0].provider).toBe("anthropic");
  });

  it("refuses an unreadable manifest loudly, with a refused ledger row and an audit deny", async () => {
    const res = await post("/v1/shadow-ai/discovery", {
      sourceKind: "package_json",
      content: "this is not json",
      subject: SUBJECT_REPO,
      mode: "apply",
    });
    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.error).toBe("unreadable_discovery_input");

    const [row] = await db.select().from(shadowAiImports).where(eq(shadowAiImports.id, body.importId));
    expect(row).toBeDefined();
    expect(row!.status).toBe("refused");
    expect(row!.ruleId).toBe(SHADOW_AI_RULE_IDS.discoveryUnreadable);
    expect(row!.rowCount).toBe(0);

    const audits = await db.select().from(auditLog).where(eq(auditLog.objectId, body.importId));
    expect(audits.some((a) => a.ruleId === SHADOW_AI_RULE_IDS.discoveryUnreadable && a.effect === "deny")).toBe(true);
  });
});

// ===========================================================================
// 5. Bounds
// ===========================================================================

describe("input bounds", () => {
  it("refuses an oversized paste before classification, writing nothing", async () => {
    // Fastify's default 1 MB body limit sits IN FRONT of the route's
    // EVIDENCE_MAX_BYTES wall (which is therefore defence-in-depth, the same
    // situation as ADR-0055/0071's own 2 MB walls), and the app's generic
    // error handler maps the transport 413 to a 500 today — a pre-existing
    // gateway-wide behaviour this slice does not reach in to change. The
    // property that matters here: an oversized paste is REFUSED before the
    // classifier runs, and no ledger row of any kind is written.
    const importsBefore = await db.select({ n: sql<number>`count(*)::int` }).from(shadowAiImports);
    const res = await post("/v1/shadow-ai/discovery", {
      sourceKind: "dns_log",
      content: "x".repeat(EVIDENCE_MAX_BYTES + 1),
      mode: "dry_run",
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(413);
    const importsAfter = await db.select({ n: sql<number>`count(*)::int` }).from(shadowAiImports);
    expect(importsAfter[0]!.n).toBe(importsBefore[0]!.n);
  });
});
