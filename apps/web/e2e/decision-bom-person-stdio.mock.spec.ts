/**
 * ADR-0190 owner decision C, slice A1: a person's own stdio call from the browser, through the MCP proxy, to an L2
 * placement, and the relaxation it relied on in the Decision BOM (mocked gateway).
 *
 * The browser makes the call with its session cookie only (no API key, no agent identity), as a person in an
 * interactive session would. The mocked `POST /mcp/:serverId` stands in for the gateway: it records the decision the
 * real resolution makes for each credential (owner decision C: L2 for the interactive session where the project is
 * relaxed; L3, refused on an L2-only host, for an API key), so this spec pins what the CONSOLE shows and sends, not
 * the placement. The placement itself is pinned by the vectors (`person-stdio-*`), `adr0190-owner-cd.test.ts` and
 * the database test `zz-adr0190-owner-cd.test.ts`. A real run (gateway, proxy, executor, gVisor) is pending: it
 * needs Docker and an L2 executor, which this environment does not have.
 *
 * What these pin:
 *  - the call leaves the browser with the session and no `authorization` header;
 *  - the decision's Decision BOM shows the relaxation from the signed facts, and its record beside them: the id, who
 *    set it, its scope, when, and a link that opens exactly the audit row that set it;
 *  - the API-key decision's BOM shows L3 required and no relaxation (negative control).
 * Axe on the BOM with the relaxation shown.
 */
import { createHash } from "node:crypto";
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";
import { installBuilderMock, ME } from "./builder-fixtures";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;
const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const U = (n: number) => `${String(n).padStart(8, "0")}-0000-4000-8000-0000000000a1`;
const H = (c: string) => c.repeat(64);
const T = "2026-10-17T09:00:00.000Z";
const SET_AT = "2026-10-16T14:30:00.000Z";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

const SERVER = U(1);
const PROJECT = U(2);
const RELAXATION = U(3);
const SET_AUDIT = U(4);
const RELAXED_DECISION = U(5);
const REFUSED_DECISION = U(6);
// the admin who set the relaxation: installBuilderMock's signed-in "Avery Admin"
const SETTER = ME;

const caps = { access: "admin", exportRoles: "admins_only", auditorGrant: null, canExport: true, exportUnavailableReason: null, canVerify: true, canViewDrift: true, exportRequiresStepUp: false, rateLimitPerMinute: 30 };
const SECTIONS = ["decision", "receipt", "principal", "actors", "action", "policy", "model", "approval", "outcome", "cost", "trace", "proof", "execution"];
const profile = { id: U(10), name: "restricted", version: 1, digest: H("a") };
const relaxationFacts = { kind: "person_stdio_l2", subjectKind: "interactive_person", relaxationId: RELAXATION, scopeKind: "project", scopeId: PROJECT };

/** the L2 placement the session call got, naming the relaxation its requirement relied on */
const PLACED_L2 = {
  workloadKind: "mcp_stdio", placement: "placed", placementId: U(11), requiredClass: "user_space_kernel", requiredBy: "unknown_agent",
  appliedClass: "user_space_kernel", refusalCode: null, profile,
  executor: { id: U(12), backend: "gvisor", runtimeVersion: "test-only-1.0", identityId: U(13), identity: null },
  offerId: null, imageDigest: null, runtimeFlagsSha256: null, relaxation: relaxationFacts,
  attestation: { placementReportSha256: H("b"), executorAttestationId: U(14), executorReportSha256: H("c") },
};
/** the API-key call: the unknown agent at L3, refused on an L2-only host; no relaxation */
const REFUSED_L3 = {
  workloadKind: "mcp_stdio", placement: "refused", placementId: U(15), requiredClass: "microvm", requiredBy: "unknown_agent",
  appliedClass: null, refusalCode: "class_below_required", profile: { ...profile, name: "restricted-microvm", id: U(16), digest: H("d") },
  executor: null, offerId: null, imageDigest: null, runtimeFlagsSha256: null, attestation: null,
};

/** a frozen v2 Decision BOM read for one decision; `document` is the parse of `body`, the digest is over `body` */
function decisionRead(auditId: string, execution: Json, executionRelaxation: Json): Json {
  const completeness = Object.fromEntries(SECTIONS.map((s) => (s === "trace" ? [s, { status: "not_applicable" }] : [s, { status: "recorded" }])));
  const doc = { v: "regulait.decision-bom.v2", id: U(20), auditId, version: 1, supersedes: null, finality: "chain_signed", completeness, basis: { auditSeq: 42, anchorId: null, receiptSeq: 5, aiBomSnapshotId: null }, execution };
  const body = JSON.stringify(doc);
  const summary = { id: U(20), version: 1, supersedes: null, finality: "chain_signed", bodySha256: sha(body), keyId: "receipt-2026", createdAt: T };
  return {
    auditId,
    bom: { ...summary, body, signature: "A".repeat(86), aiBomSnapshotId: null, reportedFinality: "chain_signed" },
    document: doc,
    versions: [summary],
    renderings: [],
    bundle: { schema: "regulait.export-bundle/3", subject: "decision-bom", href: `/v1/decisions/${auditId}/bom/bundle?version=1` },
    capabilities: caps,
    placementReports: [],
    executionRelaxation,
  };
}

interface Proxy {
  calls: Array<{ via: "session" | "api_key"; authorization: string | null; cookie: string | null }>;
  decisions: Map<string, Json>;
  auditQueries: string[];
}

async function setup(page: Page): Promise<Proxy> {
  await installBuilderMock(page, { isAdmin: true });
  await page.context().addCookies([{ name: "regulait_session", value: "test-only-session", domain: "127.0.0.1", path: "/" }]);
  const px: Proxy = { calls: [], decisions: new Map(), auditQueries: [] };
  const relaxed = {
    id: SET_AUDIT, at: SET_AT, userId: SETTER, objectType: "project", toolName: null, effect: "allow", ruleId: "execution-person-stdio-relaxed",
    deployMode: null, reason: "a person's own stdio call may now run at L2 instead of L3",
  };
  const decisionRow = (id: string, effect: string) => ({ id, at: T, userId: SETTER, objectType: "mcp_tool", toolName: "read_file", effect, ruleId: "grant-allow", deployMode: null, reason: null });
  // registered after the builder mock, so these win for their paths
  await page.route(/\/mcp\/[^/?]+$/, async (route) => {
    const req = route.request();
    const authorization = req.headers()["authorization"] ?? null;
    const cookie = req.headers()["cookie"] ?? null;
    // the gateway's rule for a call with no agent (owner decision C): only an interactive session is relaxed
    const via = authorization === null && cookie?.includes("regulait_session=") ? "session" : "api_key";
    px.calls.push({ via, authorization, cookie });
    if (via === "session") {
      px.decisions.set(RELAXED_DECISION, decisionRead(RELAXED_DECISION, PLACED_L2, { id: RELAXATION, scopeKind: "project", scopeId: PROJECT, setBy: SETTER, setAt: SET_AT, clearedBy: null, clearedAt: null, setAuditId: SET_AUDIT }));
      return json(route, { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "ok" }] } });
    }
    px.decisions.set(REFUSED_DECISION, decisionRead(REFUSED_DECISION, REFUSED_L3, null));
    return json(route, { error: "execution_profile_unavailable", ruleId: "execution-profile", reason: "class_below_required" }, 409);
  });
  await page.route(/\/v1\/audit(\?|$)/, async (route) => {
    const q = new URL(route.request().url()).searchParams;
    px.auditQueries.push(q.toString());
    const all = [
      ...(px.decisions.has(RELAXED_DECISION) ? [decisionRow(RELAXED_DECISION, "allow")] : []),
      ...(px.decisions.has(REFUSED_DECISION) ? [decisionRow(REFUSED_DECISION, "deny")] : []),
      relaxed,
    ];
    const id = q.get("id");
    const entries = id ? all.filter((e) => e.id === id) : all;
    return json(route, { entries, pageSize: entries.length, maxPageSize: 500, hasMore: false, nextCursor: null });
  });
  await page.route(/\/v1\/users(\?|$)/, (route) =>
    json(route, { users: [{ id: SETTER, email: "avery@example.test", displayName: "Avery Admin", isAdmin: true, disabledAt: null, createdAt: T }] }),
  );
  await page.route(/\/v1\/audit\/retention$/, (route) => json(route, { retainedDays: null, floorSource: [], prunable: 0 }));
  await page.route(/\/v1\/decisions\/[^/]+\/bom(\?|$)/, async (route) => {
    const id = /\/v1\/decisions\/([^/]+)\/bom/.exec(new URL(route.request().url()).pathname)![1]!;
    const read = px.decisions.get(id);
    return read ? json(route, read) : json(route, { error: "bom_decision_not_found" }, 404);
  });
  return px;
}

/** the call a person's browser makes to the MCP proxy: same origin, the session cookie, no API key */
const callFromBrowser = (page: Page, headers: Record<string, string> = {}) =>
  page.evaluate(
    async ({ server, extra }) => {
      const r = await fetch(`/mcp/${server}`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json", ...extra },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read_file", arguments: { path: "README.md" } } }),
      });
      return r.status;
    },
    { server: SERVER, extra: headers },
  );

async function openBom(page: Page, auditId: string) {
  await page.goto("/ui/admin/audit");
  await expect(page.getByRole("heading", { name: "Audit log", exact: true, level: 1 })).toBeVisible();
  await page.getByRole("button", { name: `Decision BOM for audit row ${auditId}`, exact: true }).click();
  await expect(page.getByTestId("decision-bom-execution")).toBeVisible();
}

test("a person's own call from an interactive session runs at L2; the BOM shows the relaxation and opens its audit row", async ({ page }) => {
  const px = await setup(page);
  await page.goto("/ui/admin/audit");
  expect(await callFromBrowser(page)).toBe(200);
  expect(px.calls).toHaveLength(1);
  expect(px.calls[0]).toMatchObject({ via: "session", authorization: null });

  await openBom(page, RELAXED_DECISION);
  const facts = page.getByTestId("decision-bom-execution");
  await expect(facts.getByText("L3 lowered to L2 by an admin for this project", { exact: false })).toBeVisible();
  await expect(facts.getByRole("cell", { name: "Placed on an executor", exact: false })).toBeVisible();

  const record = page.getByTestId("decision-bom-relaxation-record");
  await expect(record.getByText("not part of the signed Decision BOM", { exact: false })).toBeVisible();
  await expect(record.getByRole("row").filter({ hasText: "Relaxation" }).getByText(RELAXATION)).toBeVisible();
  await expect(record.getByRole("row").filter({ hasText: "Set by" })).toContainText("Avery Admin");
  await expect(record.getByRole("row").filter({ hasText: "Scope" })).toContainText(`Project ${PROJECT}`);
  await expect(record.getByRole("row").filter({ hasText: "Today" })).toContainText("Still in force");
  await expect(record.getByRole("row").filter({ hasText: "Set at" }).getByRole("cell").nth(1)).not.toBeEmpty();
  const results = await new AxeBuilder({ page }).include("[data-testid='decision-bom-panel']").analyze();
  expect(results.violations).toEqual([]);

  // the link opens exactly the audit row that set the relaxation
  await record.getByRole("link", { name: `Open the audit row that set relaxation ${RELAXATION}`, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/ui/admin/audit\\?id=${SET_AUDIT}$`));
  await expect(page.getByTestId("audit-only-row")).toContainText(SET_AUDIT);
  await expect(page.getByRole("row").filter({ hasText: "may now run at L2 instead of L3" })).toHaveCount(1);
  await expect(page.getByRole("button", { name: `Decision BOM for audit row ${RELAXED_DECISION}`, exact: true })).toHaveCount(0);
  expect(px.auditQueries).toContain(`id=${SET_AUDIT}`);
  // and back to every row
  await page.getByRole("button", { name: "Show every row", exact: true }).click();
  await expect(page.getByRole("button", { name: `Decision BOM for audit row ${RELAXED_DECISION}`, exact: true })).toBeVisible();
});

test("NEGATIVE CONTROL: the same call with an API key stays at L3 and its BOM names no relaxation", async ({ page }) => {
  const px = await setup(page);
  await page.goto("/ui/admin/audit");
  // synthetic, test-only bearer value (no key shape)
  expect(await callFromBrowser(page, { authorization: "Bearer test-only-api-key" })).toBe(409);
  expect(px.calls[0]).toMatchObject({ via: "api_key" });

  await openBom(page, REFUSED_DECISION);
  const facts = page.getByTestId("decision-bom-execution");
  await expect(facts).toContainText("L3");
  await expect(facts).toContainText("class_below_required");
  await expect(facts).not.toContainText("Isolation relaxation");
  await expect(page.getByTestId("decision-bom-relaxation-record")).toHaveCount(0);
});
