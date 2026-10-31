/**
 * The mocked gateway for the P3 long-page split on the operations and cost pages (cross-vendor consolidation, Engines,
 * MCP servers, the cost dashboard, Infrastructure): the list contract for every list that moved to its own page, and
 * enough of every other read for each overview to render as it would with a few weeks of data. Shared by
 * long-pages-ops.mock.spec.ts; not a spec itself. Synthetic names only.
 */
import type { Page, Route } from "@playwright/test";
import { enginesList } from "./engines-fixtures";

type Json = Record<string, unknown>;
export const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

const T0 = Date.parse("2026-10-01T00:00:00Z");
const at = (i: number) => new Date(T0 - i * 3_600_000).toISOString();
const ahead = (days: number) => new Date(T0 + days * 86_400_000).toISOString();
const uuid = (p: string, i: number) => `${p}-0000-4000-8000-${String(i).padStart(12, "0")}`;

export const ME_ID = uuid("11111111", 1);
const ME = { userId: ME_ID, isAdmin: true, user: { id: ME_ID, email: "ada@example.test", displayName: "Ada Admin" } };
const PEOPLE = [
  { id: ME_ID, email: "ada@example.test", displayName: "Ada Admin", isAdmin: true, disabledAt: null, createdAt: at(900), totpEnabled: true, hasPassword: true, mustChangePassword: false },
  { id: uuid("11111111", 2), email: "avery@example.test", displayName: "Avery Approver", isAdmin: false, disabledAt: null, createdAt: at(800), totpEnabled: true, hasPassword: true, mustChangePassword: false },
  { id: uuid("11111111", 3), email: "morgan@example.test", displayName: "Morgan Reyes", isAdmin: true, disabledAt: null, createdAt: at(700), totpEnabled: true, hasPassword: true, mustChangePassword: false },
  { id: uuid("11111111", 4), email: "dana@example.test", displayName: "Dana Developer", isAdmin: false, disabledAt: null, createdAt: at(600), totpEnabled: false, hasPassword: true, mustChangePassword: false },
];

// ---------------------------------------------------------------- cross-vendor consolidation
export const IMPORT_ID = uuid("21212121", 0);
/** 37 import batches: 3 refused, 2 revoked */
export const IMPORTS = Array.from({ length: 37 }, (_, i) => {
  const status = i === 2 || i === 11 || i === 20 ? "refused" : i === 5 || i === 15 ? "revoked" : i % 4 === 3 ? "planned" : "applied";
  return {
    id: uuid("21212121", i),
    adapter: i % 2 ? "generic_mapped" : "seat_invoice",
    vendor: ["acme-ai", "example-code-assist", "demo-cloud"][i % 3],
    format: "csv",
    mode: status === "planned" ? "dry_run" : "apply",
    status,
    source: `export-${String(i).padStart(2, "0")}.csv`,
    rowsParsed: 40 + i,
    rowsAccepted: status === "refused" ? 0 : 38 + i,
    rowsRefused: status === "refused" ? 40 + i : 2,
    totalUsd: status === "refused" ? null : 1000 + i * 17,
    reason: status === "refused" ? "the amount column did not parse on line 4" : status === "revoked" ? "revoked: wrong month" : "applied",
    createdAt: at(i * 7),
  };
});
/** 42 lines in the newest batch: 4 unattributed */
export const IMPORT_LINES = Array.from({ length: 42 }, (_, i) => ({
  id: uuid("23232323", i),
  sourceRow: i + 2,
  accountRef: i % 10 === 3 ? `contractor${i}@vendor.example` : PEOPLE[i % PEOPLE.length]!.email,
  resolvedUserId: i % 10 === 3 ? null : PEOPLE[i % PEOPLE.length]!.id,
  resolutionMethod: i % 10 === 3 ? "unresolved" : "exact_email",
  resolutionDetail: i % 10 === 3 ? "no regulAIt user matches this account" : "exact email",
  costCenter: i % 10 === 3 ? null : "CC-17",
  periodStart: at(800),
  periodEnd: at(80),
  amount: 19 + i,
  currency: "USD",
  billingKind: i % 3 ? "seat" : "usage",
  service: i % 3 ? "coding assistant seats" : "api usage",
  description: null,
  quantity: 1,
}));
const ADAPTERS = {
  adapters: [
    { id: "generic_mapped", displayName: "Generic mapped CSV or JSON", vendor: "any", formats: ["csv", "json"], capabilities: { accountIdentifier: true, accountIsEmail: false, perLinePeriod: true, quantity: true, service: true, currency: true, amountFromFile: true }, limits: "You map the columns; nothing is inferred." },
    { id: "seat_invoice", displayName: "Seat invoice export", vendor: "example-code-assist", formats: ["csv"], capabilities: { accountIdentifier: true, accountIsEmail: true, perLinePeriod: false, quantity: true, service: false, currency: false, amountFromFile: false }, limits: "Built against a declared header set that has not been checked against a live console." },
  ],
  basisStatement: "Imported, not metered.",
  piiPosture: "Account columns are kept; nothing else identifying is stored.",
  posture: "RegulAIt holds no vendor billing credential; every figure here came from a file somebody exported.",
};
const MAPPINGS = {
  aliases: Array.from({ length: 6 }, (_, i) => ({ id: uuid("24242424", i), vendor: "*", accountKey: `alias${i}@contractor.example`, userId: PEOPLE[i % 4]!.id, reason: "contractor account", createdAt: at(i * 30) })),
  domainRules: Array.from({ length: 3 }, (_, i) => ({ id: uuid("25252525", i), vendor: "*", fromDomain: `old${i}.example`, toDomain: "example.test", enabled: i !== 2, reason: "domain moved", createdAt: at(i * 40) })),
  posture: "Aliases beat domain rules; an account mapped to two people is refused.",
};
const subject = (i: number, attributed: boolean) => ({
  subjectKind: "user",
  subjectId: attributed ? PEOPLE[i % 4]!.id : null,
  label: attributed ? PEOPLE[i % 4]!.displayName : "Unattributed — vendor accounts that resolved to nobody",
  attributed,
  metered: { basis: "metered", usd: 120 + i * 9, events: 300 + i, unpricedEvents: 0 },
  imported: { basis: "imported", usd: 80 + i * 4, lines: 4 + i, byCurrency: [{ currency: "USD", amount: 80 + i * 4, lines: 4 + i }], byVendor: [{ vendor: "acme-ai", currency: "USD", amount: 80 + i * 4, lines: 4 + i }], byBillingKind: [{ billingKind: "seat", currency: "USD", amount: 80 + i * 4, lines: 4 + i }], usdNote: null },
  coverage: "Metered and imported figures are shown side by side and never added.",
});
const CONSOLIDATED = {
  window: { from: at(720), to: at(0) },
  groupedBy: "user",
  subjects: [subject(0, true), subject(1, true), subject(2, true), subject(3, true), subject(4, false)],
  basisStatement: "Two bases, never added.",
  reconciliation: { supersededLinesExcluded: 3, lastReconciledAt: at(5), note: "" },
  staleness: { vendors: [{ vendor: "acme-ai", lastImportedAt: at(30), appliedBatches: 12, daysSinceLastImport: 1 }, { vendor: "example-code-assist", lastImportedAt: at(24 * 50), appliedBatches: 9, daysSinceLastImport: 50 }], note: "The imported side is as fresh as the last file uploaded." },
  note: "Imported figures are reporting-only.",
};
const RECONCILIATION = {
  liveLines: 1204,
  supersededLines: 3,
  lastRun: { id: "rr1", trigger: "schedule", startedAt: at(5), finishedAt: at(5), outcome: "ok", scannedLines: 1207, duplicateGroups: 1, supersededLines: 3, ambiguousGroups: 1, overlapWarnings: 1, warnings: [{ kind: "overlap", detail: "Two acme-ai files cover 1–15 September; neither was touched." }], error: null },
  recentRuns: [],
  supersededSample: Array.from({ length: 3 }, (_, i) => ({ id: uuid("26262626", i), vendor: "acme-ai", accountKey: `ada@example.test`, amount: 19, currency: "USD", supersededAt: at(5), supersededReason: "the same line in a later file" })),
  scheduler: { note: "A pass runs every night." },
  posture: "Duplicates are marked, never deleted.",
};

// ---------------------------------------------------------------- engines and isolation
export const EXECUTOR_ID = uuid("31313131", 1);
const nowIso = (ms: number) => new Date(Date.now() + ms).toISOString();
function executors() {
  const base = { classesDeclared: ["hardened_container", "user_space_kernel"], quarantineCode: null, runtimeVersion: "runsc release-20260901.0", declaredClass: null, lastSeenAt: nowIso(-60_000), openOffers: 0, attestationStrength: "software_attested" };
  const fresh = (cls: string) => [{ profileDigest: "a".repeat(64), fresh: true, class: cls, expiresAt: nowIso(3_600_000), reportSha256: "b".repeat(64) }];
  return [
    { ...base, executorId: EXECUTOR_ID, name: "gvisor-a", backend: "gvisor", status: "active", attestations: fresh("user_space_kernel") },
    { ...base, executorId: uuid("31313131", 2), name: "gvisor-quarantined", backend: "gvisor", status: "quarantined", quarantineCode: "execution_profile_mismatch", attestations: [] },
    { ...base, executorId: uuid("31313131", 3), name: "kata-b", backend: "kata", status: "active", attestations: fresh("microvm") },
  ];
}
/** 26 self-test reports for gvisor-a: 3 failed */
export const ATTESTATIONS = Array.from({ length: 26 }, (_, i) => ({
  id: uuid("32323232", i),
  executorId: EXECUTOR_ID,
  isolationClass: "user_space_kernel",
  profileDigest: "a".repeat(64),
  verdict: i % 9 === 4 ? "fail" : "pass",
  failures: i % 9 === 4 ? ["egress_probe_succeeded"] : [],
  observedAt: nowIso(-(i + 1) * 3_600_000),
  expiresAt: nowIso(-(i + 1) * 3_600_000 + 2 * 3_600_000),
  reportSha256: String(i % 10).repeat(64),
}));
const PROFILES = ["restricted", "restricted-microvm", "engine-worker"].map((name, i) => ({ id: `p-${name}`, name, version: 1, digest: String(9 - i).repeat(64), shipped: true, retiredAt: null, createdAt: at(800), relaxations: [], minClass: i === 1 ? "microvm" : "user_space_kernel" }));
/** a first page of 50 decisions (more follow): 4 refused, 1 mismatch; 2 refusals before any placement */
export const PLACEMENTS = Array.from({ length: 50 }, (_, i) => {
  const outcome = i % 12 === 1 ? "refused" : i === 7 ? "mismatch" : "placed";
  return {
    id: uuid("33333333", i),
    workloadKind: i % 2 ? "mcp_stdio" : "engine_worker",
    requiredClass: "user_space_kernel",
    requiredBy: "workload_kind",
    outcome,
    refusalCode: outcome === "refused" ? "class_below_required" : outcome === "mismatch" ? "execution_profile_mismatch" : null,
    appliedClass: outcome === "placed" ? "user_space_kernel" : null,
    executorName: outcome === "placed" ? "gvisor-a" : null,
    profileName: "restricted",
    profileVersion: 1,
    createdAt: at(i),
  };
});
const UNRECORDED = [
  { auditId: "a-1", at: at(3), code: "policy_unresolved", unresolvedFact: "sensitivity", workloadKind: "mcp_stdio" },
  { auditId: "a-2", at: at(9), code: "profile_unknown", unresolvedFact: null, workloadKind: "engine_worker" },
];
const SENSITIVITIES = { projects: Array.from({ length: 4 }, (_, i) => ({ projectId: uuid("34343434", i), name: `team-17 project ${i + 1}`, useCaseCount: i, useCaseSensitivity: i ? "internal" : null, adminSensitivity: i === 3 ? "regulated" : null, effectiveSensitivity: i === 3 ? "regulated" : i ? "internal" : null, personStdioRelaxationId: null })) };

// ---------------------------------------------------------------- MCP registries
export const REGISTRY_ID = uuid("41414141", 1);
const REGISTRIES = {
  deployMode: "connected",
  federationRefused: false,
  federationRefusedReason: null,
  maxPagesPerSync: 20,
  maxRegistriesPerSweep: 5,
  registries: [
    { id: REGISTRY_ID, name: "Public MCP registry", url: "https://registry.example.test", enabled: true, allowPrivateRanges: false, lastSyncAt: at(2), lastSyncOutcome: "ok", lastSyncDetail: null, createdAt: at(400) },
    { id: uuid("41414141", 2), name: "team-17 internal catalogue", url: "https://mcp.team-17.example.test", enabled: false, allowPrivateRanges: true, lastSyncAt: null, lastSyncOutcome: null, lastSyncDetail: null, createdAt: at(300) },
  ],
};
/** 64 catalogue entries: 3 conflicts, 2 no longer listed, 4 imported */
export const ENTRIES = Array.from({ length: 64 }, (_, i) => ({
  id: uuid("42424242", i),
  registryId: REGISTRY_ID,
  upstreamName: `io.example/server-${String(i).padStart(2, "0")}`,
  upstreamVersion: "1.0.0",
  title: i % 3 ? `Example server ${i}` : null,
  description: null,
  repositoryUrl: null,
  websiteUrl: null,
  kind: i % 5 === 4 ? "catalogue_only" : "remote",
  remoteUrl: i % 5 === 4 ? null : `https://mcp${i}.example.test/mcp`,
  remoteTransport: i % 5 === 4 ? null : "streamable-http",
  catalogueReason: i % 5 === 4 ? "no_distribution" : null,
  upstreamStatus: "active",
  serverId: i % 16 === 0 ? uuid("43434343", i) : null,
  importedAt: i % 16 === 0 ? at(i) : null,
  conflictReason: i === 1 || i === 2 || i === 3 ? "name_taken" : null,
  conflictServerId: null,
  remoteUrlDrift: null,
  lastSeenAt: at(2),
  missingSince: i === 6 || i === 7 ? at(30) : null,
}));
const SERVERS = {
  servers: Array.from({ length: 4 }, (_, i) => ({ id: uuid("44444444", i), name: `server-${i}`, url: `https://mcp${i}.example.test/mcp`, transport: "streamable-http", enabled: true, admissionState: i === 3 ? "held" : "admitted", createdAt: at(i * 10), tools: [] })),
};

// ---------------------------------------------------------------- cost dashboard
const PROJECTS = {
  projects: Array.from({ length: 6 }, (_, i) => ({ id: uuid("51515151", i), name: `team-17 project ${i + 1}`, costCenter: `CC-${17 + i}`, initiativeId: i < 3 ? uuid("52525252", 0) : null, budgetUsd: i === 5 ? null : 1000 * (i + 1), spentUsd: i === 1 ? 2300 : 400 * (i + 1), budgetPeriod: "monthly", alertThresholdPct: 80, classifications: i % 2 ? ["eu-ai-act"] : [] })),
};
const INITIATIVES = { initiatives: [{ id: uuid("52525252", 0), name: "Credit-limit-increase assistant", costCenter: "CC-17", projectCount: 3, spentUsd: 4200 }, { id: uuid("52525252", 1), name: "Support drafting", costCenter: null, projectCount: 0, spentUsd: 0 }] };
const UNATTRIBUTED = { measured: { events: 41, costUsd: 12.5, inputTokens: 40000, outputTokens: 9000 }, byUser: [{ userId: ME_ID, costUsd: 9 }, { userId: PEOPLE[3]!.id, costUsd: 3.5 }], byMcpTool: [] };

// ---------------------------------------------------------------- infrastructure
const SEV = ["critical", "high", "medium", "low"] as const;
/** 14 resources */
export const RESOURCES = Array.from({ length: 14 }, (_, i) => ({ id: uuid("61616161", i), name: `resource-${String(i).padStart(2, "0")}`, kind: ["control_plane", "agent_runtime", "cert", "backup_target"][i % 4], provider: "mock", classifications: i % 3 ? ["eu-ai-act"] : [], effectivePolicy: { autoRemediateMaxSeverity: i % 2 ? "medium" : null, backupRetentionDaysFloor: 30, patchCadenceDaysCeiling: 14 }, createdAt: at(i * 3) }));
/** 23 findings: 6 open (2 critical) */
export const FINDINGS = Array.from({ length: 23 }, (_, i) => ({ id: uuid("62626262", i), resourceName: RESOURCES[i % 14]!.name, kind: ["cert_expiry", "cve", "backup_missed", "drift"][i % 4], severity: SEV[i % 4]!, status: i < 6 ? "open" : i % 2 ? "remediated" : "auto_remediated", detail: { summary: `finding ${i}` }, detectedAt: at(i) }));
/** 9 certificates */
export const CERTS = Array.from({ length: 9 }, (_, i) => ({ id: uuid("63636363", i), resourceName: RESOURCES[(i * 4 + 2) % 14]!.name, commonName: `svc-${i}.example.test`, notAfter: ahead(i * 20 - 10), status: i === 0 ? "rotation_failed" : "active", serial: `0x${(i + 10).toString(16)}`, createdAt: at(i) }));
/** 17 CVE patches: 5 open */
export const PATCHES = Array.from({ length: 17 }, (_, i) => ({ id: uuid("64646464", i), resourceName: RESOURCES[i % 14]!.name, cve: `CVE-2026-${1000 + i}`, severity: SEV[i % 4]!, package: `libexample${i}`, fixedVersion: `1.${i}.0`, status: i < 5 ? "open" : "patched", createdAt: at(i) }));
/** 21 backup runs: 2 missed */
export const BACKUPS = Array.from({ length: 21 }, (_, i) => ({ id: uuid("65656565", i), resourceName: RESOURCES[(i * 4 + 3) % 14]!.name, kind: "scheduled", status: i === 1 || i === 8 ? "missed" : "completed", retentionUntil: ahead(30 - i), createdAt: at(i) }));
const POSTURE = { resources: 14, findings: 23, open: 6, byKind: { cert_expiry: 6, cve: 6, backup_missed: 6, drift: 5 }, bySeverity: { critical: 6, high: 6, medium: 6, low: 5 }, byStatus: { open: 6, remediated: 9, auto_remediated: 8 }, backup: { missed: 2, targets: 3 } };
const POLICIES = { policies: [{ id: "pol-1", resourceId: null, patchCadenceDays: 14, certRotationDaysBeforeExpiry: 30, backupSchedule: "daily-0200", backupRetentionDays: 35, autoRemediateMaxSeverity: "medium" }] };

// ---------------------------------------------------------------- the list contract
type ListDef = { rows: Json[]; key: string; keyset: string; field: Record<string, string>; filters?: (r: Json, q: URLSearchParams) => boolean };
const RANK: Record<string, number> = { low: 1, medium: 2, high: 3, critical: 4 };
const pick = (r: Json, path: string) => {
  const v = path.split(".").reduce<unknown>((x, k) => (x as Json | null)?.[k], r) as string | number | null;
  // the gateway sorts severity by rank, not by spelling
  return path === "severity" && typeof v === "string" ? (RANK[v] ?? 0) : v;
};
const statusFilter = (r: Json, q: URLSearchParams) => !q.get("status") || r.status === q.get("status");
export const LISTS: Record<string, ListDef> = {
  "/v1/cost-imports": { rows: IMPORTS, key: "imports", keyset: "when", field: { when: "createdAt", adapter: "adapter", vendor: "vendor", mode: "mode", status: "status", rows: "rowsParsed", usd: "totalUsd", reason: "reason" }, filters: (r, q) => statusFilter(r, q) && (!q.get("vendor") || r.vendor === q.get("vendor")) },
  [`/v1/cost-imports/${IMPORT_ID}`]: { rows: IMPORT_LINES, key: "lines", keyset: "row", field: { row: "sourceRow", acct: "accountRef", who: "resolvedUserId", svc: "service", kind: "billingKind", amt: "amount", cc: "costCenter" } },
  [`/v1/executors/${EXECUTOR_ID}/attestations`]: { rows: ATTESTATIONS, key: "attestations", keyset: "at", field: { at: "observedAt", class: "isolationClass", verdict: "verdict", expires: "expiresAt", report: "reportSha256", profile: "profileDigest" } },
  [`/v1/mcp-registries/${REGISTRY_ID}/entries`]: {
    rows: ENTRIES,
    key: "entries",
    keyset: "name",
    field: { name: "upstreamName", kind: "kind", endpoint: "remoteUrl", state: "conflictReason", lastSeen: "lastSeenAt" },
    filters: (r, q) => (!q.get("kind") || r.kind === q.get("kind")) && (!q.get("q") || String(r.upstreamName).includes(q.get("q")!)),
  },
  "/v1/infra/resources": { rows: RESOURCES, key: "resources", keyset: "created", field: { created: "createdAt", name: "name", kind: "kind", provider: "provider", classifications: "kind" } },
  "/v1/infra/findings": { rows: FINDINGS, key: "findings", keyset: "detected", field: { detected: "detectedAt", severity: "severity", status: "status", resource: "resourceName", kind: "kind", summary: "detail.summary" } },
  "/v1/infra/certs": { rows: CERTS, key: "certs", keyset: "created", field: { created: "createdAt", notAfter: "notAfter", status: "status", resource: "resourceName", cn: "commonName", serial: "serial" } },
  "/v1/infra/patches": { rows: PATCHES, key: "patches", keyset: "created", field: { created: "createdAt", severity: "severity", status: "status", resource: "resourceName", cve: "cve", package: "package", fixed: "fixedVersion" } },
  "/v1/infra/backups": { rows: BACKUPS, key: "backups", keyset: "created", field: { created: "createdAt", status: "status", resource: "resourceName", kind: "kind", retention: "retentionUntil" } },
};

function contract(endpoint: string, q: URLSearchParams) {
  const list = LISTS[endpoint]!;
  const sort = q.get("sort") ?? list.keyset;
  const dir = q.get("dir") === "asc" ? 1 : -1;
  const f = list.field[sort] ?? list.field[list.keyset]!;
  const rows = list.rows.filter((r) => (list.filters ? list.filters(r, q) : true)).sort((a, b) => {
    const x = pick(a, f);
    const y = pick(b, f);
    if (x === y) return 0;
    if (x === null) return 1;
    if (y === null) return -1;
    return (x < y ? -1 : 1) * dir;
  });
  const limit = Number(q.get("limit") ?? 10);
  const start = q.get("cursor") ? Number(atob(q.get("cursor")!)) : Number(q.get("offset") ?? 0);
  const more = start + limit < rows.length;
  const keyset = sort === list.keyset;
  return {
    items: rows.slice(start, start + limit),
    nextCursor: more && keyset ? btoa(String(start + limit)) : null,
    nextOffset: more && !keyset ? start + limit : null,
    total: q.get("count") ? rows.length : null,
    totalIsEstimate: false,
  };
}

export interface OpsCapture {
  lists: URL[];
  exports: URL[];
  writes: Array<{ method: string; path: string; body: unknown }>;
}

/** every route the five pages and their list pages read; anything else answers `{}` */
export async function mockOps(page: Page): Promise<OpsCapture> {
  const cap: OpsCapture = { lists: [], exports: [], writes: [] };
  await page.route("**/*", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname;
    const q = url.searchParams;
    if (req.resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    if (p === "/auth/me") return json(route, { ...ME, via: "session", mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false });
    if (p === "/v1/me") return json(route, ME);
    if (req.method() !== "GET") {
      cap.writes.push({ method: req.method(), path: p, body: req.postDataJSON?.() ?? null });
      return json(route, {});
    }
    if (p.endsWith("/export.xlsx")) {
      cap.exports.push(url);
      return route.fulfill({
        status: 200,
        headers: { "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "x-regulait-export-truncated": "0", "x-regulait-export-row-limit": "100000" },
        body: Buffer.from("PK\u0003\u0004"),
      });
    }
    const list = LISTS[p];
    if (list && (q.get("sort") || q.get("count"))) {
      cap.lists.push(url);
      return json(route, contract(p, q));
    }
    if (p === `/v1/cost-imports/${IMPORT_ID}`) {
      return json(route, { import: { ...IMPORTS[0], payloadSha256: "a".repeat(64), periodStart: at(800), periodEnd: at(80), appliedAt: at(0), revokedAt: null }, lines: IMPORT_LINES, linesTruncated: false, basisStatement: "IMPORTED cost is what a vendor file says." });
    }
    if (list) return json(route, { [list.key]: list.rows, ...(p === `/v1/mcp-registries/${REGISTRY_ID}/entries` ? { registry: { id: REGISTRY_ID, name: "Public MCP registry" } } : {}) });
    switch (p) {
      case "/v1/users":
        return json(route, { users: PEOPLE });
      case "/v1/users/directory":
        return json(route, { users: PEOPLE.map((x) => ({ id: x.id, name: x.displayName, teams: [{ id: "t17", name: "team-17" }] })) });
      case "/v1/me/ai-literacy":
        return json(route, { required: false, current: true, documents: [], gateMode: "enforce", exempt: null, noticeDays: 14 });
      case "/v1/projects":
        return json(route, PROJECTS);
      case "/v1/initiatives":
        return json(route, INITIATIVES);
      case "/v1/costs/unattributed":
        return json(route, UNATTRIBUTED);
      case "/v1/energy/factors":
        return json(route, { factors: [], region: null, notes: { shipped: "Shipped factors are published estimates.", unknown: "An unknown model has no factor." } });
      case "/v1/org/settings":
        return json(route, { settings: { infraApproverUserId: PEOPLE[1]!.id, backupVerifyEnabled: true, backupVerifyIntervalHours: 24, isolationEnforcement: "enforce", executorAttestationMaxAgeMinutes: 120 } });
      case "/v1/compliance/profiles":
        return json(route, { profiles: [{ tag: "eu-ai-act" }, { tag: "nist-ai-rmf" }] });
      case "/v1/cost-imports/adapters":
        return json(route, ADAPTERS);
      case "/v1/cost-imports/mappings":
        return json(route, MAPPINGS);
      case "/v1/cost-consolidated":
        return json(route, CONSOLIDATED);
      case "/v1/cost-imports/reconciliation":
        return json(route, RECONCILIATION);
      case "/v1/engines":
        return json(route, enginesList());
      case "/v1/executors":
        return json(route, { executors: executors() });
      case `/v1/executors/${EXECUTOR_ID}`:
        return json(route, { ...executors()[0], workloadIdentityId: uuid("35353535", 1), quarantinedAt: null, reenabledAt: null });
      case "/v1/execution-profiles":
        return json(route, { profiles: PROFILES, reference: "restricted" });
      case "/v1/execution-placements":
        return json(route, { placements: q.get("cursor") ? PLACEMENTS.slice(0, 10).map((x, i) => ({ ...x, id: uuid("36363636", i), createdAt: at(60 + i) })) : PLACEMENTS, refusalsWithoutPlacement: q.get("refusalsCursor") ? [] : UNRECORDED, nextCursor: q.get("cursor") ? null : "c2", refusalsNextCursor: null, attestationStrength: "software_attested" });
      case "/v1/execution-project-sensitivities":
        return json(route, SENSITIVITIES);
      case "/v1/execution-person-stdio-relaxations":
        return json(route, { relaxations: [] });
      case "/v1/detection/content":
        return json(route, { sets: [] });
      case "/v1/mcp-registries":
        return json(route, REGISTRIES);
      case "/v1/servers":
        return json(route, SERVERS);
      case "/v1/infra/posture":
        return json(route, POSTURE);
      case "/v1/infra/policies":
        return json(route, POLICIES);
      default:
        return json(route, {});
    }
  });
  return cap;
}

export const PAGES = [
  { name: "Cross-vendor consolidation", path: "/ui/admin/cost-consolidation" },
  { name: "Engines", path: "/ui/admin/engines" },
  { name: "MCP servers", path: "/ui/admin/mcp-servers" },
  { name: "MCP registries", path: "/ui/admin/mcp-servers?tab=registries", open: { button: /Browse entries of Public MCP registry/ } },
  { name: "Cost dashboard", path: "/ui/admin/cost" },
  { name: "Infrastructure", path: "/ui/admin/infrastructure" },
] as const;
