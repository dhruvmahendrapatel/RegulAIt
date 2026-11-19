/**
 * ADR-0322 slice 2 — opt-in vendor usage/cost pull (Anthropic cost report, OpenAI costs) against fake vendor servers.
 *
 *  - off by default; turning it on is a step-up; refused under air_gapped;
 *  - a credential is stored only with the write-capable acknowledgement and a step-up, encrypted, never returned and
 *    never in an audit row; revoking it disables the connector;
 *  - nothing leaves until the vendor host is in the egress allow-list (the guarded fetch refuses, and the fake vendor
 *    sees no request);
 *  - pulled lines are basis 'imported', origin 'pull'; a re-pull upserts rather than adding a second copy;
 *  - lines billed to the gateway's own workspace/key/project are marked overlaps_metered, excluded from the
 *    consolidated imported side and disclosed;
 *  - a vendor error stores a fixed code and RegulAIt's own sentence, never the vendor's body (which echoes the key).
 *
 * No live vendor is called: the guarded fetch's transport is an in-process fake and its DNS answer is pinned. The
 * file removes every row it created, so the shared database's cost suites see nothing of it.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  and,
  auditLog,
  costImportBatches,
  createDb,
  eq,
  importedCostLines,
  inArray,
  runMigrations,
  sql,
  vendorUsageConnectors,
  vendorUsageCredentials,
  vendorUsagePullPolicy,
  vendorUsagePullRuns,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";
import { COST_IMPORT_RULE_IDS } from "./cost-import.js";
import { DEPLOY_MODE_ENV } from "./deploy-posture.js";
import { trackEgressAllowHosts } from "./testing/egress-allow-cleanup.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { relaxStepUpAround } from "./testing/step-up-posture.js";
import { pullWindow, runVendorUsagePull, runVendorUsagePullSweep, VENDOR_USAGE_RULE_IDS } from "./vendor-usage-pull.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const BOOT = "adr0322-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = "e".repeat(64);
const RUN = Date.now();
const ANTHROPIC_KEY = `sk-ant-admin01-FAKE-${RUN}-secret`;
const OPENAI_KEY = `sk-admin-FAKE-${RUN}-secret`;
const GITHUB_TOKEN = `github_pat_FAKE_${RUN}_secret`;
const CURSOR_KEY = `key_FAKE_${RUN}_secret`;
const resolve = async () => [{ address: "93.184.216.34", family: 4 }];

interface Seen {
  url: URL;
  headers: Headers;
}
let seen: Seen[] = [];
/** what the fake vendors answer next; set per test */
let answer: (url: URL) => Response = () => new Response("{}", { status: 500 });
const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
  seen.push({ url, headers });
  return answer(url);
}) as typeof fetch;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let db: Db;
let app: ReturnType<typeof buildApp>;
const allowed = trackEgressAllowHosts();
let savedMode: string | undefined;
let savedPolicy = false;
const connectorIds: string[] = [];
const restores: Array<() => Promise<void>> = [];
/** an admin API key: an API key can never satisfy a step-up, whatever the shared database holds */
let KEY: { authorization: string };
let ADMIN_ID = "";

const today = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()));
const dayIso = (offset: number) => new Date(today.getTime() + offset * 86_400_000).toISOString();

function anthropicPages(amountCents: string) {
  return (url: URL) => {
    if (url.pathname !== "/v1/organizations/cost_report") return json({ error: "unexpected path" }, 404);
    if (!url.searchParams.get("page")) {
      return json({
        data: [
          {
            starting_at: dayIso(-2),
            ending_at: dayIso(-1),
            results: [
              { amount: amountCents, currency: "USD", workspace_id: "wrkspc_people", description: "Input Tokens", cost_type: "tokens", model: "claude-x" },
              { amount: "500", currency: "USD", workspace_id: "wrkspc_gateway", description: "Input Tokens", cost_type: "tokens", model: "claude-x" },
            ],
          },
        ],
        has_more: true,
        next_page: "page_2",
      });
    }
    return json({
      data: [{ starting_at: dayIso(-1), ending_at: dayIso(0), results: [{ amount: "250", currency: "USD", workspace_id: null, description: "Web search", cost_type: "web_search" }] }],
      has_more: false,
      next_page: null,
    });
  };
}

const put = (url: string, payload: unknown) => app.inject({ method: "PUT", url, headers: AUTH, payload: payload as object });
const steppedPut = (url: string, payload: unknown) => relaxStepUpAround(db, () => put(url, payload));

async function createConnector(vendor: "anthropic" | "openai" | "github_copilot" | "cursor", config: Record<string, unknown>) {
  const res = await app.inject({
    method: "POST",
    url: "/v1/vendor-usage/connectors",
    headers: AUTH,
    payload: { vendor, name: `adr0322-${vendor}-${RUN}-${connectorIds.length}`, config, reason: "adr0322 suite" },
  });
  expect(res.statusCode, res.body).toBe(201);
  const c = res.json().connector;
  connectorIds.push(c.id);
  return c as { id: string; enabled: boolean; credential: unknown };
}

async function storeKey(connectorId: string, secret: string) {
  return steppedPut(`/v1/vendor-usage/connectors/${connectorId}/credential`, {
    secret,
    replacesCredentialId: null,
    acknowledgeWriteCapable: true,
    reason: "adr0322 suite key",
  });
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  savedMode = process.env[DEPLOY_MODE_ENV];
  delete process.env[DEPLOY_MODE_ENV];
  savedPolicy = (await db.select().from(vendorUsagePullPolicy))[0]?.enabled ?? false;
  await db.update(vendorUsagePullPolicy).set({ enabled: false });
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY, vendorUsageFetch: fetchImpl, vendorUsageResolve: resolve });
  restores.push(await relaxIdentityForTest(db, { mfaRequired: "off" }));
  const created = await app.inject({ method: "POST", url: "/v1/users", headers: AUTH, payload: { email: `adr0322-admin-${RUN}@example.com`, displayName: "vendor usage admin", isAdmin: true } });
  expect(created.statusCode, created.body).toBe(201);
  ADMIN_ID = created.json().id;
  const key = await app.inject({ method: "POST", url: `/v1/users/${created.json().id}/keys`, headers: AUTH, payload: { name: "adr0322" } });
  KEY = { authorization: `Bearer ${key.json().token}` };
});

afterAll(async () => {
  const entries = await allowed.removeAll(app, AUTH);
  try {
    if (connectorIds.length) {
      const batchIds = (
        await db.select({ id: vendorUsagePullRuns.batchId }).from(vendorUsagePullRuns).where(inArray(vendorUsagePullRuns.connectorId, connectorIds))
      )
        .map((r) => r.id)
        .filter((x): x is string => Boolean(x));
      await db.delete(importedCostLines).where(inArray(importedCostLines.pullConnectorId, connectorIds));
      await db.delete(vendorUsagePullRuns).where(inArray(vendorUsagePullRuns.connectorId, connectorIds));
      if (batchIds.length) await db.delete(costImportBatches).where(inArray(costImportBatches.id, batchIds));
      await db.delete(vendorUsageConnectors).where(inArray(vendorUsageConnectors.id, connectorIds));
    }
    await db.update(vendorUsagePullPolicy).set({ enabled: savedPolicy });
    for (const r of restores.reverse()) await r();
    if (savedMode === undefined) delete process.env[DEPLOY_MODE_ENV];
    else process.env[DEPLOY_MODE_ENV] = savedMode;
    await app?.close();
  } finally {
    entries.assertRemoved();
  }
});

describe("ADR-0322: off by default, three switches before anything leaves", () => {
  it("starts off, and lists every vendor with its scope posture and honest limits", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/vendor-usage", headers: AUTH });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.policy.enabled).toBe(false);
    expect(body.catalogue.map((c: { vendor: string; scopePosture: string }) => [c.vendor, c.scopePosture])).toEqual([
      ["anthropic", "write_capable"],
      ["openai", "write_capable"],
      ["github_copilot", "unverified"],
      ["cursor", "write_capable"],
    ]);
    expect(body.statement).toMatch(/IMPORTED/);
  });

  it("refuses a credential while the policy is off, and turning the policy on takes a step-up", async () => {
    const c = await createConnector("anthropic", {});
    expect(c.enabled).toBe(false);
    expect((await storeKey(c.id, ANTHROPIC_KEY)).statusCode).toBe(409);

    const noStepUp = await app.inject({ method: "PUT", url: "/v1/vendor-usage/policy", headers: KEY, payload: { enabled: true, reason: "adr0322 suite" } });
    expect(noStepUp.statusCode, noStepUp.body).toBe(403);
    expect((await db.select().from(vendorUsagePullPolicy))[0]?.enabled).toBe(false);

    const on = await steppedPut("/v1/vendor-usage/policy", { enabled: true, reason: "adr0322 suite" });
    expect(on.statusCode, on.body).toBe(200);
    const [row] = await db.select().from(auditLog).where(eq(auditLog.ruleId, VENDOR_USAGE_RULE_IDS.policyChanged)).orderBy(sql`${auditLog.at} desc`).limit(1);
    expect(row?.reason).toMatch(/off -> on: adr0322 suite/);
  });

  it("refuses the policy, a credential, an enable and a pull under air_gapped", async () => {
    process.env[DEPLOY_MODE_ENV] = "air_gapped";
    try {
      expect((await steppedPut("/v1/vendor-usage/policy", { enabled: true, reason: "adr0322 suite" })).statusCode).toBe(409);
      const c = connectorIds[0]!;
      expect((await storeKey(c, ANTHROPIC_KEY)).statusCode).toBe(409);
      const { run } = await runVendorUsagePull(db, c, { trigger: "manual", dataKey: DATA_KEY, deps: { fetchImpl, resolve } });
      expect([run.status, run.errorCode]).toEqual(["refused", "air_gapped"]);
      expect(await runVendorUsagePullSweep(db, { dataKey: DATA_KEY, deps: { fetchImpl, resolve } })).toEqual({ connectors: 0, linesUpserted: 0, failed: 0 });
    } finally {
      delete process.env[DEPLOY_MODE_ENV];
    }
  });

  it("validates connector configuration strictly (no base URL override exists)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/vendor-usage/connectors",
      headers: AUTH,
      payload: { vendor: "anthropic", name: `adr0322-bad-${RUN}`, config: { baseUrl: "https://attacker.example" }, reason: "adr0322 suite" },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("ADR-0322: the credential", () => {
  it("needs the write-capable acknowledgement, is encrypted, and appears in no response or audit row", async () => {
    const c = connectorIds[0]!;
    const noAck = await steppedPut(`/v1/vendor-usage/connectors/${c}/credential`, {
      secret: ANTHROPIC_KEY,
      replacesCredentialId: null,
      reason: "adr0322 suite key",
    });
    expect(noAck.statusCode).toBe(409);
    expect(noAck.json().error).toBe("write_capable_acknowledgement_required");

    const stored = await storeKey(c, ANTHROPIC_KEY);
    expect(stored.statusCode, stored.body).toBe(201);
    expect(stored.body).not.toContain(ANTHROPIC_KEY);
    const [cred] = await db.select().from(vendorUsageCredentials).where(eq(vendorUsageCredentials.connectorId, c));
    expect(cred?.scopePosture).toBe("write_capable");
    expect(cred?.writeCapableAcknowledgedAt).not.toBeNull();
    expect(cred?.secretCiphertext).not.toContain(ANTHROPIC_KEY);

    const view = await app.inject({ method: "GET", url: "/v1/vendor-usage", headers: AUTH });
    expect(view.body).not.toContain(ANTHROPIC_KEY);
    const audits = await db.select({ detail: auditLog.detail, reason: auditLog.reason }).from(auditLog).where(sql`${auditLog.ruleId} like 'vendor-usage-%'`);
    expect(JSON.stringify(audits)).not.toContain(ANTHROPIC_KEY);
  });

  it("enabling needs a step-up", async () => {
    const c = connectorIds[0]!;
    const noStepUp = await app.inject({ method: "PUT", url: `/v1/vendor-usage/connectors/${c}/enabled`, headers: KEY, payload: { enabled: true, reason: "adr0322 suite" } });
    expect(noStepUp.statusCode, noStepUp.body).toBe(403);
    const on = await steppedPut(`/v1/vendor-usage/connectors/${c}/enabled`, { enabled: true, reason: "adr0322 suite" });
    expect(on.statusCode, on.body).toBe(200);
    expect(on.json().connector.enabled).toBe(true);
  });
});

describe("ADR-0322: the Anthropic pull", () => {
  it("sends nothing until the vendor host is allow-listed", async () => {
    seen = [];
    answer = anthropicPages("1000");
    const res = await app.inject({ method: "POST", url: `/v1/vendor-usage/connectors/${connectorIds[0]}/pull`, headers: AUTH });
    expect(res.statusCode).toBe(502);
    expect(res.json().run.errorCode).toBe("egress_refused");
    expect(seen).toHaveLength(0);
    expect((await db.select().from(importedCostLines).where(eq(importedCostLines.pullConnectorId, connectorIds[0]!)))).toHaveLength(0);
  });

  it("pulls every page into imported lines, marks the gateway workspace as already metered, and upserts on re-pull", async () => {
    // egress-allow-cleanup: afterAll (tracked host, removed by allowed.removeAll)
    const allow = await relaxStepUpAround(db, () =>
      app.inject({ method: "POST", url: "/v1/egress-allow-hosts", headers: AUTH, payload: { host: allowed.trackHost("api.anthropic.com"), allowPrivateRanges: false, allowPlaintextHttp: false, note: `adr0322 ${RUN}` } }),
    );
    expect([200, 201]).toContain(allow.statusCode);
    const cfg = await put(`/v1/vendor-usage/connectors/${connectorIds[0]}/config`, { config: { gatewayWorkspaceIds: ["wrkspc_gateway"] }, reason: "adr0322 suite" });
    expect(cfg.statusCode, cfg.body).toBe(200);

    seen = [];
    answer = anthropicPages("1000");
    const res = await app.inject({ method: "POST", url: `/v1/vendor-usage/connectors/${connectorIds[0]}/pull`, headers: AUTH });
    expect(res.statusCode, res.body).toBe(200);
    const run = res.json().run;
    expect(run).toMatchObject({ status: "succeeded", pages: 2, linesUpserted: 3, overlapLines: 1 });
    expect(seen).toHaveLength(2);
    expect(seen[0]!.url.host).toBe("api.anthropic.com");
    expect(seen[0]!.headers.get("x-api-key")).toBe(ANTHROPIC_KEY);
    expect(seen[0]!.url.searchParams.getAll("group_by[]")).toEqual(["workspace_id", "description"]);
    expect(seen[1]!.url.searchParams.get("page")).toBe("page_2");

    const lines = await db.select().from(importedCostLines).where(eq(importedCostLines.pullConnectorId, connectorIds[0]!));
    expect(lines).toHaveLength(3);
    expect(new Set(lines.map((l) => l.basis))).toEqual(new Set(["imported"]));
    const people = lines.find((l) => l.accountRef === "anthropic workspace wrkspc_people")!;
    expect([people.amount, people.overlapsMetered, people.resolutionMethod]).toEqual([10, false, "unresolved"]);
    expect(lines.find((l) => l.accountRef === "anthropic workspace wrkspc_gateway")!.overlapsMetered).toBe(true);
    const [batch] = await db.select().from(costImportBatches).where(eq(costImportBatches.id, run.batchId));
    expect([batch?.origin, batch?.status, batch?.vendor]).toEqual(["pull", "applied", "anthropic"]);

    // the vendor restates the same day with a higher amount: one row, the new amount
    answer = anthropicPages("2000");
    const again = await app.inject({ method: "POST", url: `/v1/vendor-usage/connectors/${connectorIds[0]}/pull`, headers: AUTH });
    expect(again.statusCode, again.body).toBe(200);
    const after = await db.select().from(importedCostLines).where(eq(importedCostLines.pullConnectorId, connectorIds[0]!));
    expect(after).toHaveLength(3);
    expect(after.find((l) => l.accountRef === "anthropic workspace wrkspc_people")!.amount).toBe(20);
  });

  it("excludes the metered overlap from the consolidated imported side and discloses it", async () => {
    const from = dayIso(-5);
    const to = dayIso(2);
    const res = await app.inject({ method: "GET", url: `/v1/cost-consolidated?from=${from}&to=${to}`, headers: AUTH });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.meteredOverlap.linesExcluded).toBeGreaterThanOrEqual(1);
    expect(body.meteredOverlap.byCurrency.find((r: { currency: string }) => r.currency === "USD").amount).toBeGreaterThanOrEqual(5);
    // the gateway workspace's $5 is not on the imported side of the unattributed subject
    const unattributed = body.subjects.filter((s: { attributed: boolean }) => !s.attributed);
    const importedUsd = unattributed.reduce((n: number, s: { imported: { usd: number } }) => n + (s.imported?.usd ?? 0), 0);
    expect(importedUsd).toBeGreaterThanOrEqual(22.5);
    expect(body.staleness.note).toMatch(/vendor pull connector/);
  });

  it("re-marks stored lines when the gateway declaration changes", async () => {
    const res = await put(`/v1/vendor-usage/connectors/${connectorIds[0]}/config`, { config: { gatewayWorkspaceIds: [] }, reason: "adr0322 suite" });
    expect(res.json().linesRemarked).toBe(1);
    const lines = await db.select().from(importedCostLines).where(eq(importedCostLines.pullConnectorId, connectorIds[0]!));
    expect(lines.every((l) => !l.overlapsMetered)).toBe(true);
  });

  it("a re-pulled line keeps its first batch, and revoking a later pull batch withdraws only what it introduced (#861 review)", async () => {
    const c = connectorIds[0]!;
    const base = anthropicPages("2000");
    answer = (url) => {
      if (url.searchParams.get("page")) return base(url);
      return json({
        data: [
          {
            starting_at: dayIso(-2),
            ending_at: dayIso(-1),
            results: [
              { amount: "2000", currency: "USD", workspace_id: "wrkspc_people", description: "Input Tokens", cost_type: "tokens", model: "claude-x" },
              { amount: "500", currency: "USD", workspace_id: "wrkspc_gateway", description: "Input Tokens", cost_type: "tokens", model: "claude-x" },
              { amount: "700", currency: "USD", workspace_id: "wrkspc_people", description: "Output Tokens", cost_type: "tokens", model: "claude-x" },
            ],
          },
        ],
        has_more: true,
        next_page: "page_2",
      });
    };
    const before = await db.select().from(importedCostLines).where(eq(importedCostLines.pullConnectorId, c));
    expect(before).toHaveLength(3);
    const firstBatches = new Set(before.map((l) => l.batchId));
    const res = await app.inject({ method: "POST", url: `/v1/vendor-usage/connectors/${c}/pull`, headers: AUTH });
    expect(res.statusCode, res.body).toBe(200);
    const latest = res.json().run.batchId as string;
    const [batch] = await db.select().from(costImportBatches).where(eq(costImportBatches.id, latest));
    expect(batch?.summary).toMatchObject({ newLines: 1, restatedLines: 3 });
    const after = await db.select().from(importedCostLines).where(eq(importedCostLines.pullConnectorId, c));
    expect(after).toHaveLength(4);
    // the three restated lines did not move to the newest batch
    expect(after.filter((l) => l.batchId === latest).map((l) => l.description)).toEqual(["Output Tokens"]);
    expect(after.filter((l) => l.batchId !== latest).every((l) => firstBatches.has(l.batchId))).toBe(true);
    // the success audit row was written with the batch
    const [done] = await db.select().from(auditLog).where(eq(auditLog.objectId, res.json().run.id));
    expect([done?.ruleId, (done?.detail as { batchId?: string }).batchId]).toEqual([VENDOR_USAGE_RULE_IDS.pullCompleted, latest]);

    const [conn] = await db.select().from(vendorUsageConnectors).where(eq(vendorUsageConnectors.id, c));
    const revoked = await app.inject({ method: "DELETE", url: `/v1/cost-imports/${latest}`, headers: AUTH, payload: { reason: "adr0322 suite withdraw" } });
    expect(revoked.statusCode, revoked.body).toBe(200);
    expect(revoked.json().linesRemoved).toBe(1);
    const kept = await db.select().from(importedCostLines).where(eq(importedCostLines.pullConnectorId, c));
    expect(kept.map((l) => l.description).sort()).toEqual(["Input Tokens", "Input Tokens", "Web search"]);
    // the connector is rewound to the withdrawn batch's first day, so the next pull fetches those days again
    const [rewound] = await db.select().from(vendorUsageConnectors).where(eq(vendorUsageConnectors.id, c));
    expect(rewound!.pulledThrough!.getTime()).toBeLessThanOrEqual(batch!.periodStart!.getTime());
    expect(rewound!.pulledThrough!.getTime()).toBeLessThan(conn!.pulledThrough!.getTime());
  });

  it("revoking a pulled batch while a pull of its connector is running is refused, and changes nothing (#861 review 2)", async () => {
    const c = connectorIds[0]!;
    const [applied] = await db
      .select()
      .from(costImportBatches)
      .where(and(eq(costImportBatches.origin, "pull"), eq(costImportBatches.status, "applied"), sql`${costImportBatches.summary}->>'connectorId' = ${c}`))
      .limit(1);
    expect(applied, "an applied pull batch from the earlier pulls").toBeTruthy();
    const linesBefore = await db.select({ id: importedCostLines.id }).from(importedCostLines).where(eq(importedCostLines.batchId, applied!.id));
    const [connBefore] = await db.select().from(vendorUsageConnectors).where(eq(vendorUsageConnectors.id, c));
    const [running] = await db.insert(vendorUsagePullRuns).values({ connectorId: c, trigger: "schedule" }).returning();
    try {
      const res = await app.inject({ method: "DELETE", url: `/v1/cost-imports/${applied!.id}`, headers: AUTH, payload: { reason: "adr0322 revoke during pull" } });
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json().error).toBe("pull_in_progress");
      const [batchAfter] = await db.select().from(costImportBatches).where(eq(costImportBatches.id, applied!.id));
      expect(batchAfter!.status).toBe("applied");
      const linesAfter = await db.select({ id: importedCostLines.id }).from(importedCostLines).where(eq(importedCostLines.batchId, applied!.id));
      expect(linesAfter).toHaveLength(linesBefore.length);
      const [connAfter] = await db.select().from(vendorUsageConnectors).where(eq(vendorUsageConnectors.id, c));
      expect(connAfter!.pulledThrough?.getTime()).toBe(connBefore!.pulledThrough?.getTime());
      const revokeAudits = await db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.ruleId, COST_IMPORT_RULE_IDS.importRevoked), eq(auditLog.objectId, applied!.id)));
      expect(revokeAudits).toHaveLength(0);
    } finally {
      await db.delete(vendorUsagePullRuns).where(eq(vendorUsagePullRuns.id, running!.id));
    }
  });

  it("refuses a second pull while one is running, without calling the vendor (#861 review)", async () => {
    const c = connectorIds[0]!;
    const [running] = await db.insert(vendorUsagePullRuns).values({ connectorId: c, trigger: "schedule" }).returning();
    try {
      seen = [];
      answer = anthropicPages("2000");
      const res = await app.inject({ method: "POST", url: `/v1/vendor-usage/connectors/${c}/pull`, headers: AUTH });
      expect(res.statusCode).toBe(409);
      expect(res.json().run).toMatchObject({ status: "refused", errorCode: "in_progress" });
      expect(seen).toHaveLength(0);
    } finally {
      await db.delete(vendorUsagePullRuns).where(eq(vendorUsagePullRuns.id, running!.id));
    }
  });

  it("refuses a vendor that repeats a page cursor (#861 review)", async () => {
    answer = () =>
      json({ data: [{ starting_at: dayIso(-1), ending_at: dayIso(0), results: [] }], has_more: true, next_page: "same_cursor" });
    const res = await app.inject({ method: "POST", url: `/v1/vendor-usage/connectors/${connectorIds[0]}/pull`, headers: AUTH });
    expect(res.json().run.errorCode).toBe("bad_response");
    expect(res.json().run.pages).toBe(0);
  });

  it("stores a fixed code and RegulAIt's own sentence when the vendor refuses, never the vendor's body", async () => {
    answer = () => json({ error: { message: `invalid x-api-key ${ANTHROPIC_KEY}` } }, 401);
    const res = await app.inject({ method: "POST", url: `/v1/vendor-usage/connectors/${connectorIds[0]}/pull`, headers: AUTH });
    expect(res.statusCode).toBe(502);
    expect(res.json().run.errorCode).toBe("unauthorized");
    expect(res.body).not.toContain(ANTHROPIC_KEY);
    const runs = await db.select().from(vendorUsagePullRuns).where(eq(vendorUsagePullRuns.connectorId, connectorIds[0]!));
    expect(JSON.stringify(runs)).not.toContain(ANTHROPIC_KEY);
  });

  it("refuses a malformed page and writes nothing", async () => {
    const before = (await db.select().from(importedCostLines).where(eq(importedCostLines.pullConnectorId, connectorIds[0]!))).length;
    answer = () => json({ data: [{ starting_at: dayIso(-1), ending_at: dayIso(0), results: [{ amount: 12 }] }], has_more: false });
    const res = await app.inject({ method: "POST", url: `/v1/vendor-usage/connectors/${connectorIds[0]}/pull`, headers: AUTH });
    expect(res.json().run.errorCode).toBe("bad_response");
    expect((await db.select().from(importedCostLines).where(eq(importedCostLines.pullConnectorId, connectorIds[0]!))).length).toBe(before);
  });
});

describe("ADR-0322: the OpenAI pull (official SDK, guarded fetch injected)", () => {
  it("pulls costs per API key and project and marks the gateway's project as already metered", async () => {
    const c = await createConnector("openai", { gatewayProjectIds: ["proj_gateway"] });
    expect((await storeKey(c.id, OPENAI_KEY)).statusCode).toBe(201);
    expect((await steppedPut(`/v1/vendor-usage/connectors/${c.id}/enabled`, { enabled: true, reason: "adr0322 suite" })).statusCode).toBe(200);
    // egress-allow-cleanup: afterAll (tracked host, removed by allowed.removeAll)
    const allow = await relaxStepUpAround(db, () =>
      app.inject({ method: "POST", url: "/v1/egress-allow-hosts", headers: AUTH, payload: { host: allowed.trackHost("api.openai.com"), allowPrivateRanges: false, allowPlaintextHttp: false, note: `adr0322 ${RUN}` } }),
    );
    expect([200, 201]).toContain(allow.statusCode);

    seen = [];
    const start = Math.floor(Date.parse(dayIso(-1)) / 1000);
    answer = (url) =>
      url.pathname === "/v1/organization/costs"
        ? json({
            object: "page",
            data: [
              {
                object: "bucket",
                start_time: start,
                end_time: start + 86_400,
                results: [
                  { object: "organization.costs.result", amount: { value: 3.25, currency: "usd" }, line_item: "model x, input", project_id: "proj_team", api_key_id: "key_team" },
                  { object: "organization.costs.result", amount: { value: 7, currency: "usd" }, line_item: "model x, input", project_id: "proj_gateway", api_key_id: "key_gw" },
                ],
              },
            ],
            has_more: false,
            next_page: null,
          })
        : json({ error: "unexpected path" }, 404);
    const res = await app.inject({ method: "POST", url: `/v1/vendor-usage/connectors/${c.id}/pull`, headers: AUTH });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().run).toMatchObject({ status: "succeeded", linesUpserted: 2, overlapLines: 1 });
    expect(seen[0]!.url.host).toBe("api.openai.com");
    expect(seen[0]!.headers.get("authorization")).toBe(`Bearer ${OPENAI_KEY}`);
    expect(seen[0]!.url.searchParams.getAll("group_by[]").sort()).toEqual(["api_key_id", "line_item", "project_id"]);
    const lines = await db.select().from(importedCostLines).where(eq(importedCostLines.pullConnectorId, c.id));
    expect(lines.map((l) => [l.accountRef, l.amount, l.overlapsMetered]).sort()).toEqual([
      ["openai api key key_gw", 7, true],
      ["openai api key key_team", 3.25, false],
    ]);
  });

  it("revoking the key disables the connector and the next pull is refused", async () => {
    const c = connectorIds[connectorIds.length - 1]!;
    const res = await app.inject({ method: "DELETE", url: `/v1/vendor-usage/connectors/${c}/credential`, headers: AUTH, payload: { reason: "adr0322 suite revoke" } });
    expect(res.statusCode, res.body).toBe(200);
    const [cred] = await db.select().from(vendorUsageCredentials).where(eq(vendorUsageCredentials.connectorId, c));
    expect(cred?.secretCiphertext).toBeNull();
    const [conn] = await db.select().from(vendorUsageConnectors).where(eq(vendorUsageConnectors.id, c));
    expect(conn?.enabled).toBe(false);
    const { run } = await runVendorUsagePull(db, c, { trigger: "manual", dataKey: DATA_KEY, deps: { fetchImpl, resolve } });
    expect([run.status, run.errorCode]).toEqual(["refused", "disabled"]);
  });
});

async function allowHost(host: string) {
  // egress-allow-cleanup: afterAll (tracked host, removed by allowed.removeAll)
  const allow = await relaxStepUpAround(db, () =>
    app.inject({ method: "POST", url: "/v1/egress-allow-hosts", headers: AUTH, payload: { host: allowed.trackHost(host), allowPrivateRanges: false, allowPlaintextHttp: false, note: `adr0322 ${RUN}` } }),
  );
  expect([200, 201]).toContain(allow.statusCode);
}

async function enabledConnector(vendor: "github_copilot" | "cursor", config: Record<string, unknown>, secret: string) {
  const c = await createConnector(vendor, config);
  expect((await storeKey(c.id, secret)).statusCode).toBe(201);
  expect((await steppedPut(`/v1/vendor-usage/connectors/${c.id}/enabled`, { enabled: true, reason: "adr0322 suite" })).statusCode).toBe(200);
  return c;
}

describe("ADR-0322 slice 3: the GitHub Copilot pull (billing usage report, Copilot lines only)", () => {
  it("refuses a slug that is not a GitHub login, so the path segment cannot be steered", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/vendor-usage/connectors",
      headers: AUTH,
      payload: { vendor: "github_copilot", name: `adr0322-bad-gh-${RUN}`, config: { account: "organization", slug: "../../user" }, reason: "adr0322 suite" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("reads one report per day of the window, keeps the Copilot lines, stores the token as unverified, and upserts on re-pull", async () => {
    const c = await enabledConnector("github_copilot", { account: "organization", slug: "acme-eng", backfillDays: 3 }, GITHUB_TOKEN);
    const [cred] = await db.select().from(vendorUsageCredentials).where(eq(vendorUsageCredentials.connectorId, c.id));
    expect([cred?.scopePosture, cred?.writeCapableAcknowledgedAt]).toEqual(["unverified", null]);
    await allowHost("api.github.com");

    const yesterday = new Date(dayIso(-1));
    const items = (url: URL) => {
      const asked = Date.UTC(Number(url.searchParams.get("year")), Number(url.searchParams.get("month")) - 1, Number(url.searchParams.get("day")));
      if (asked !== yesterday.getTime()) return [];
      const date = yesterday.toISOString();
      return [
        { date, product: "Copilot", sku: "Copilot Business", quantity: 4, unitType: "user-months", netAmount: 76, organizationName: "acme-eng" },
        { date, product: "Copilot", sku: "Premium request", quantity: 25, unitType: "requests", netAmount: 1, organizationName: "acme-eng", repositoryName: "acme-eng/api" },
        { date, product: "Actions", sku: "Linux", quantity: 100, unitType: "minutes", netAmount: 0.8, organizationName: "acme-eng" },
      ];
    };
    answer = (url) =>
      url.pathname === "/organizations/acme-eng/settings/billing/usage" ? json({ usageItems: items(url) }) : json({ message: "Not Found" }, 404);

    seen = [];
    const first = await runVendorUsagePull(db, c.id, { trigger: "manual", dataKey: DATA_KEY, deps: { fetchImpl, resolve } });
    expect(first.run).toMatchObject({ status: "succeeded", linesUpserted: 2, overlapLines: 0 });
    // backfillDays 3 = three past days and today
    expect(seen).toHaveLength(4);
    expect(seen.every((s) => s.url.host === "api.github.com")).toBe(true);
    expect(seen[0]!.headers.get("authorization")).toBe(`Bearer ${GITHUB_TOKEN}`);
    expect(seen[0]!.headers.get("x-github-api-version")).toBe("2026-03-10");

    const lines = await db.select().from(importedCostLines).where(eq(importedCostLines.pullConnectorId, c.id));
    expect(lines.map((l) => [l.accountRef, l.amount, l.overlapsMetered, l.basis]).sort()).toEqual([
      ["github organization acme-eng", 1, false, "imported"],
      ["github organization acme-eng", 76, false, "imported"],
    ]);

    await runVendorUsagePull(db, c.id, { trigger: "manual", dataKey: DATA_KEY, deps: { fetchImpl, resolve } });
    expect(await db.select().from(importedCostLines).where(eq(importedCostLines.pullConnectorId, c.id))).toHaveLength(2);
    const view = await app.inject({ method: "GET", url: "/v1/vendor-usage", headers: AUTH });
    expect(view.body).not.toContain(GITHUB_TOKEN);
    const mine = view.json().connectors.find((x: { id: string }) => x.id === c.id);
    expect(mine.meteredOverlap).toMatch(/does not meter this vendor/);
  });

  it("stores a fixed code when GitHub refuses the token, never GitHub's body", async () => {
    const c = connectorIds[connectorIds.length - 1]!;
    answer = () => json({ message: `Bad credentials ${GITHUB_TOKEN}` }, 401);
    const { run } = await runVendorUsagePull(db, c, { trigger: "manual", dataKey: DATA_KEY, deps: { fetchImpl, resolve } });
    expect([run.status, run.errorCode]).toEqual(["failed", "unauthorized"]);
    expect(run.errorDetail).not.toContain(GITHUB_TOKEN);
  });
});

describe("ADR-0322 slice 3: the Cursor pull (filtered usage events, Basic auth)", () => {
  it("pages through the events, sums them per day and person, and resolves a person by email", async () => {
    const c = await enabledConnector("cursor", { backfillDays: 2 }, CURSOR_KEY);
    await allowHost("api.cursor.com");
    const at = Date.parse(dayIso(-1)) + 3_600_000;
    const bodies: Array<Record<string, unknown>> = [];
    const requestBodies: Promise<void>[] = [];
    const cursorFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const req = new Request(input, init);
      requestBodies.push(req.clone().text().then((t) => void bodies.push(JSON.parse(t))));
      return fetchImpl(input, init);
    }) as typeof fetch;
    let pageNo = 0;
    answer = (url) => {
      if (url.pathname !== "/teams/filtered-usage-events") return json({ error: "unexpected path" }, 404);
      pageNo += 1;
      return pageNo === 1
        ? json({
            usageEvents: [
              { timestamp: String(at), userEmail: `adr0322-admin-${RUN}@example.com`, model: "model-a", kind: "Usage-based", product: "agent", requestsCosts: 1, chargedCents: 12.5 },
              { timestamp: String(at + 60_000), serviceAccountId: "sa_ci", model: "model-a", kind: "Usage-based", product: "agent", chargedCents: 40 },
            ],
            pagination: { currentPage: 1, hasNextPage: true },
          })
        : json({
            usageEvents: [{ timestamp: String(at + 120_000), userEmail: `ADR0322-admin-${RUN}@example.com`, model: "model-a", kind: "Usage-based", product: "agent", requestsCosts: 2, chargedCents: 7.25 }],
            pagination: { currentPage: 2, hasNextPage: false },
          });
    };
    seen = [];
    const { run } = await runVendorUsagePull(db, c.id, { trigger: "manual", dataKey: DATA_KEY, deps: { fetchImpl: cursorFetch, resolve } });
    await Promise.all(requestBodies);
    expect(run).toMatchObject({ status: "succeeded", linesUpserted: 2, overlapLines: 0 });
    expect(seen.map((s) => s.url.host)).toEqual(["api.cursor.com", "api.cursor.com"]);
    expect(seen[0]!.headers.get("authorization")).toBe(`Basic ${Buffer.from(`${CURSOR_KEY}:`).toString("base64")}`);
    expect(bodies.map((b) => [b.page, b.pageSize])).toEqual([
      [1, 1000],
      [2, 1000],
    ]);
    expect(Number(bodies[0]!.endDate)).toBeGreaterThan(Number(bodies[0]!.startDate));

    const lines = await db.select().from(importedCostLines).where(eq(importedCostLines.pullConnectorId, c.id));
    const byRef = new Map(lines.map((l) => [l.accountRef, l]));
    expect(byRef.get(`adr0322-admin-${RUN}@example.com`)).toMatchObject({ amount: 0.1975, resolutionMethod: "exact_email" });
    expect(byRef.get("cursor service account sa_ci")).toMatchObject({ amount: 0.4 });
  });

  it("refuses a vendor that answers a different page than the one asked for, and writes nothing", async () => {
    const c = connectorIds[connectorIds.length - 1]!;
    const before = await db.select().from(importedCostLines).where(eq(importedCostLines.pullConnectorId, c));
    answer = () => json({ usageEvents: [], pagination: { currentPage: 1, hasNextPage: true } });
    let calls = 0;
    const counting = (async (input: string | URL | Request, init?: RequestInit) => {
      calls += 1;
      if (calls > 1) return json({ usageEvents: [], pagination: { currentPage: 1, hasNextPage: true } });
      return fetchImpl(input, init);
    }) as typeof fetch;
    const { run } = await runVendorUsagePull(db, c, { trigger: "manual", dataKey: DATA_KEY, deps: { fetchImpl: counting, resolve } });
    expect([run.status, run.errorCode, calls]).toEqual(["failed", "bad_response", 2]);
    expect(await db.select().from(importedCostLines).where(eq(importedCostLines.pullConnectorId, c))).toHaveLength(before.length);
  });
});

describe("ADR-0322: row-level security on the four tables (ADR-0234, #861 review)", () => {
  const TABLES = ["vendor_usage_connectors", "vendor_usage_credentials", "vendor_usage_pull_policy", "vendor_usage_pull_runs"] as const;
  const countAs = (scope: { reason?: string; userId?: string }) =>
    db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('role', 'regulait_app', true)`);
      if (scope.reason) await tx.execute(sql`select set_config('regulait.system_context', ${scope.reason}, true)`);
      if (scope.userId) await tx.execute(sql`select set_config('regulait.user_id', ${scope.userId}, true)`);
      const r = await tx.execute(sql`select
        (select count(*)::int from vendor_usage_connectors) as vendor_usage_connectors,
        (select count(*)::int from vendor_usage_credentials) as vendor_usage_credentials,
        (select count(*)::int from vendor_usage_pull_policy) as vendor_usage_pull_policy,
        (select count(*)::int from vendor_usage_pull_runs) as vendor_usage_pull_runs`);
      return (r.rows as Array<Record<(typeof TABLES)[number], number>>)[0]!;
    });
  const none = Object.fromEntries(TABLES.map((t) => [t, 0]));

  it("all four tables have row-level security ENABLED and FORCED", async () => {
    const r = await db.execute(sql`
      select relname, relrowsecurity as on, relforcerowsecurity as forced from pg_class
       where relnamespace = 'public'::regnamespace and relkind = 'r' and relname in ('vendor_usage_connectors', 'vendor_usage_credentials', 'vendor_usage_pull_policy', 'vendor_usage_pull_runs') order by relname`);
    expect(r.rows).toEqual(TABLES.map((relname) => ({ relname, on: true, forced: true })));
  });

  it("NEGATIVE: a plain app connection, request-only reasons and a non-admin principal see nothing", async () => {
    const owner = await countAs({ reason: "migration" });
    for (const t of TABLES) expect(owner[t], t).toBeGreaterThan(0);
    expect(await countAs({})).toEqual(none);
    expect(await countAs({ reason: "public_ingest" })).toEqual(none);
    expect(await countAs({ reason: "credential_request" })).toEqual(none);
    const u = await app.inject({ method: "POST", url: "/v1/users", headers: AUTH, payload: { email: `adr0322-member-${RUN}@example.com`, displayName: "vendor usage member" } });
    expect(u.statusCode, u.body).toBe(201);
    expect(await countAs({ userId: u.json().id })).toEqual(none);
    // the admin principal and the scheduled sweep reach every row
    expect(await countAs({ userId: ADMIN_ID })).toEqual(owner);
    expect(await countAs({ reason: "system_task" })).toEqual(owner);
  });

  it("NEGATIVE: without an admin principal or the sweep's reason nothing can be written", async () => {
    const attempt = (reason: string | null) =>
      db
        .transaction(async (tx) => {
          await tx.execute(sql`select set_config('role', 'regulait_app', true)`);
          if (reason) await tx.execute(sql`select set_config('regulait.system_context', ${reason}, true)`);
          await tx.execute(sql`insert into vendor_usage_connectors (vendor, name) values ('anthropic', ${`adr0322-rls-${RUN}-${reason ?? "none"}`})`);
        })
        .then(
          () => null,
          (e: unknown) => e as { message?: string; cause?: { message?: string } },
        );
    for (const reason of [null, "public_ingest", "credential_request"]) {
      const err = await attempt(reason);
      expect(String(err?.cause?.message ?? err?.message), String(reason)).toMatch(/row-level security/);
    }
  });
});

describe("ADR-0322: the window and the sweep", () => {
  it("resumes from the last pull minus the restated days and never asks for more than 31 days", () => {
    const now = new Date("2026-11-15T10:00:00Z");
    expect(pullWindow(null, 7, now)).toEqual({ start: new Date("2026-11-08T00:00:00Z"), end: new Date("2026-11-16T00:00:00Z") });
    expect(pullWindow(new Date("2026-11-14T09:00:00Z"), 7, now)).toEqual({ start: new Date("2026-11-12T00:00:00Z"), end: new Date("2026-11-16T00:00:00Z") });
    const old = pullWindow(new Date("2026-01-01T00:00:00Z"), 7, now);
    expect(old.start).toEqual(new Date("2026-10-15T00:00:00Z"));
    expect(old.end.getTime() - old.start.getTime()).toBeLessThanOrEqual(31 * 86_400_000);
  });

  it("pulls nothing while the policy is off", async () => {
    await steppedPut("/v1/vendor-usage/policy", { enabled: false, reason: "adr0322 suite off" });
    seen = [];
    expect(await runVendorUsagePullSweep(db, { dataKey: DATA_KEY, deps: { fetchImpl, resolve } })).toEqual({ connectors: 0, linesUpserted: 0, failed: 0 });
    expect(seen).toHaveLength(0);
  });
});
