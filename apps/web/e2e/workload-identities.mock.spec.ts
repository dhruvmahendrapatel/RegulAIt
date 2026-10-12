/**
 * ADR-0188 S6 — the workload identities page against a mocked gateway (no
 * database). The page is a preview: routed, not in the navigation. These
 * check that it reads the live S4/S5 routes, that every write is confirmed and
 * resent once through the identity_manage step-up with the same body, that a
 * stale grant revision is refused rather than reported as saved, and that the
 * controls behind routes the gateway still answers 501 are disabled and
 * explained — and never send a request.
 */
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";
import { confirmStepUp, requireStepUpOn } from "./step-up-harness";
import { IDENTITY_ROUTES_NOT_BUILT } from "../src/views/admin/identity/workloadIdentityModel";

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ISO = "2026-10-11T10:00:00.000Z";
const LATER = new Date(Date.now() + 15 * 60_000).toISOString();

const STEWARD = { id: U(1), email: "avery@example.test", displayName: "Avery Admin", isAdmin: true, disabledAt: null, createdAt: ISO, totpEnabled: true, hasPassword: true, mustChangePassword: false };
const CO_STEWARD = { ...STEWARD, id: U(2), email: "blake@example.test", displayName: "Blake Builder", isAdmin: false };
const SERVER = { id: U(10), name: "Records server", url: "https://records.example.test/mcp" };
const ROLE = { id: U(11), name: "Reader", description: null };
const AGENT = { id: U(12), name: "Claims bot", provider: "mock", tier: 1, model: null, enabled: true };
const IDENTITY = {
  id: U(20), kind: "agent", agentId: U(12), builderAgentId: null, engineRunnerId: null,
  identifier: "spiffe://example.test/regulait/agent/claims-bot", sponsorUserIds: [STEWARD.id], environments: ["dev"],
  status: "active", grantsRevision: 4, createdBy: STEWARD.id, createdAt: ISO, updatedAt: ISO,
};
const GRANTS = {
  identityId: IDENTITY.id, revision: 4,
  tools: [{ serverId: SERVER.id, toolName: "read_record" }], servers: [], agents: [], connectors: [], roleIds: [ROLE.id],
};
const RUN = U(30);
const TREE = {
  items: [
    { id: U(41), rootGrantId: U(40), parentGrantId: U(40), path: [U(40)], depth: 1, sponsorUserId: STEWARD.id, actorIdentityId: U(21), runId: RUN, projectId: null,
      capMicros: 60_000_000, settledMicros: 10_000_000, reservedMicros: 0, environment: "dev", audience: null, expiresAt: LATER, revokedAt: null, revokedReason: null, createdAt: ISO },
    { id: U(40), rootGrantId: U(40), parentGrantId: null, path: [], depth: 0, sponsorUserId: STEWARD.id, actorIdentityId: IDENTITY.id, runId: RUN, projectId: null,
      capMicros: 100_000_000, settledMicros: 10_000_000, reservedMicros: 50_000_000, environment: "dev", audience: null, expiresAt: LATER, revokedAt: null, revokedReason: null, createdAt: ISO },
    // a grandchild whose edge is not in `edges`: the list route returns only edges with both ends on one page
    { id: U(42), rootGrantId: U(40), parentGrantId: U(41), path: [U(40), U(41)], depth: 2, sponsorUserId: STEWARD.id, actorIdentityId: U(22), runId: RUN, projectId: null,
      capMicros: 5_000_000, settledMicros: 0, reservedMicros: 0, environment: "dev", audience: null, expiresAt: LATER, revokedAt: null, revokedReason: null, createdAt: ISO },
  ],
  edges: [{ id: U(50), parentGrantId: U(40), childGrantId: U(41), amountMicros: 60_000_000, drawnMicros: 10_000_000, releasedMicros: 0, status: "open", createdAt: ISO, closedAt: null }],
  nextCursor: null,
};

/** the identity routes the gateway answers 501 today (the model's list, itself pinned to the gateway): never called */
const NOT_BUILT = IDENTITY_ROUTES_NOT_BUILT.map(
  (r) => [r.method, new RegExp(`^${r.path.replace(/:[A-Za-z]+/g, "[^/]+")}$`)] as const,
);

let current: Mock | null = null;

interface Mock {
  calls: Array<{ method: string; path: string; search: string }>;
  /** /v1 calls no mock answered: each fails the test (afterEach) */
  unmatched: string[];
  grantsRevision: number;
  listFails: boolean;
}

async function mockApi(page: Page, opts: Partial<Mock> = {}): Promise<Mock> {
  const m: Mock = { calls: [], unmatched: [], grantsRevision: 4, listFails: false, ...opts };
  current = m;
  const me = { userId: STEWARD.id, isAdmin: true, user: { id: STEWARD.id, email: STEWARD.email, displayName: STEWARD.displayName } };
  await page.route("**/*", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname;
    if (req.resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    const method = req.method();
    m.calls.push({ method, path: p, search: url.search });
    if (NOT_BUILT.some(([verb, re]) => verb === method && re.test(p))) return json(route, { error: "not_built" }, 501);
    if (p === "/auth/me") return json(route, { ...me, via: "session", mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false });
    if (p === "/v1/me") return json(route, me);
    // the shell's own reads on every page: the acknowledgement gate and the approvals badge
    if (p === "/v1/me/ai-literacy") return json(route, { required: false, current: true, documents: [], gateMode: "enforce", exempt: null, noticeDays: 14 });
    if (p === "/v1/approvals" && method === "GET") return json(route, { approvals: [] });
    if (p === "/v1/users") return json(route, { users: [STEWARD, CO_STEWARD] });
    if (p === "/v1/servers") return json(route, { servers: [SERVER] });
    if (p === `/v1/servers/${SERVER.id}/tools`) return json(route, { tools: [{ serverId: SERVER.id, name: "read_record", kind: "read" }, { serverId: SERVER.id, name: "write_record", kind: "write" }] });
    if (p === "/v1/agents") return json(route, { agents: [AGENT] });
    if (p === "/v1/connectors") return json(route, { connectors: [] });
    if (p === "/v1/identity/signing-keys") return json(route, { items: [] });
    if (p === "/v1/roles") return json(route, { roles: [ROLE] });
    if (p === "/v1/workload-identities" && method === "GET") {
      if (m.listFails) return json(route, { error: "internal", detail: "SYNTHETIC_UNTRUSTED_SERVER_DETAIL" }, 500);
      return json(route, { items: [IDENTITY], nextCursor: null });
    }
    if (p === `/v1/workload-identities/${IDENTITY.id}` && method === "GET") {
      return json(route, { ...IDENTITY, activeCredentialCount: 1, liveDelegationGrantCount: 2 });
    }
    if (p === `/v1/workload-identities/${IDENTITY.id}` && method === "PATCH") return json(route, { ...IDENTITY, ...(req.postDataJSON() as object) });
    if (p === `/v1/workload-identities/${IDENTITY.id}/grants` && method === "GET") return json(route, { ...GRANTS, revision: m.grantsRevision });
    if (p === `/v1/workload-identities/${IDENTITY.id}/grants` && method === "PUT") {
      const body = req.postDataJSON() as { revision: number };
      if (body.revision !== m.grantsRevision) {
        return json(route, { error: "grants_revision_conflict", detail: "the grant set changed since it was read", currentRevision: m.grantsRevision }, 409);
      }
      m.grantsRevision += 1;
      return json(route, { ...body, identityId: IDENTITY.id, revision: m.grantsRevision });
    }
    if (p === "/v1/delegation-grants" && method === "GET") return json(route, TREE);
    if (p === `/v1/delegation-grants/${U(40)}/revoke` && method === "POST") return json(route, { grantId: U(40), revoked: 2 });
    m.unmatched.push(`${method} ${p}`);
    return json(route, { error: "unmatched_mock", detail: `${method} ${p} has no mock in this spec` }, 500);
  });
  return m;
}

/** an axe WCAG 2.2 AA scan of whatever is on screen now */
async function expectNoAxeViolations(page: Page, what: string) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.help}`), `axe violations: ${what}`).toEqual([]);
}

const notBuiltCalls = (m: Mock) => m.calls.filter((c) => NOT_BUILT.some(([verb, re]) => verb === c.method && re.test(c.path)));

async function openIdentity(page: Page) {
  await page.goto("/ui/admin/workload-identities");
  await page.getByRole("button", { name: `Manage ${IDENTITY.identifier}` }).click();
  await expect(page.getByRole("heading", { name: IDENTITY.identifier })).toBeVisible();
}

test.describe("ADR-0188 S6: workload identities (preview)", () => {
  test.beforeEach(() => {
    current = null;
  });
  test.afterEach(() => {
    expect(current?.unmatched ?? [], "every /v1 call this page makes is mocked deliberately").toEqual([]);
  });

  test("lists identities from the live route, stays out of the navigation, and explains what is not built", async ({ page }) => {
    const m = await mockApi(page);
    await page.goto("/ui/admin/workload-identities");
    await expect(page.getByRole("heading", { name: "Workload identities" })).toBeVisible();
    const row = page.getByRole("row", { name: new RegExp(IDENTITY.identifier) });
    await expect(row).toContainText("Avery Admin");
    await expect(row).toContainText("dev");
    await expect(page.getByRole("note").filter({ hasText: "not in the navigation" })).toBeVisible();
    await expect(page.locator('a[href*="workload-identities"]')).toHaveCount(0);

    const add = page.getByRole("button", { name: "Add identity — unavailable" });
    await expect(add).toHaveAttribute("aria-disabled", "true");
    // aria-disabled, not disabled: still reachable from the keyboard, and refusing to act
    await add.focus();
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: "What is the reason Add identity is unavailable?" }).click();
    await expect(page.getByRole("note").filter({ hasText: "not built on this gateway yet" })).toBeVisible();

    await page.getByRole("button", { name: `Manage ${IDENTITY.identifier}` }).click();
    await expect(page.getByRole("button", { name: "Revoke identity — unavailable" })).toHaveAttribute("aria-disabled", "true");
    await expect(page.getByRole("button", { name: "Add public credential — unavailable" })).toHaveAttribute("aria-disabled", "true");
    await expect(page.getByText("1 credential is active")).toBeVisible();
    const grants = page.getByRole("row", { name: /read_record/ });
    await expect(grants).toContainText("Records server");
    await page.getByRole("button", { name: "Revoke identity — unavailable" }).focus();
    await page.keyboard.press("Enter");
    expect(notBuiltCalls(m)).toEqual([]);

    await expectNoAxeViolations(page, "the page with an identity open");
  });

  test("a failed read says so and infers no empty list", async ({ page }) => {
    await mockApi(page, { listFails: true });
    await page.goto("/ui/admin/workload-identities");
    await expect(page.getByText("Workload identities could not be read. No empty or active state is inferred.")).toBeVisible();
    await expect(page.getByText("No workload identities")).toHaveCount(0);
    await expect(page.getByText("SYNTHETIC_UNTRUSTED_SERVER_DETAIL")).toHaveCount(0);
  });

  test("suspending is confirmed, then resent once through the identity_manage step-up", async ({ page }) => {
    await mockApi(page);
    const su = await requireStepUpOn(page, { method: "PATCH", path: `/v1/workload-identities/${IDENTITY.id}`, kind: "identity_manage" });
    await openIdentity(page);
    await page.getByRole("button", { name: "Suspend identity" }).click();
    const confirm = page.getByRole("dialog", { name: "Suspend identity?" });
    await expect(confirm).toContainText("refused at its next use");
    await confirm.getByRole("button", { name: "Suspend identity" }).click();
    await confirmStepUp(page);
    await su.expectResentOnce();
    expect(su.attempts[1]!.body).toEqual({ status: "suspended" });
    await expect(page.getByText("Identity suspended.")).toBeVisible();
  });

  test("editing stewards sends only the changed field", async ({ page }) => {
    await mockApi(page);
    const su = await requireStepUpOn(page, { method: "PATCH", path: `/v1/workload-identities/${IDENTITY.id}`, kind: "identity_manage" });
    await openIdentity(page);
    await page.getByRole("button", { name: "Edit stewards and environments" }).click();
    const editor = page.getByRole("dialog", { name: "Edit stewards and environments" });
    await editor.getByLabel("Add a steward", { exact: true }).selectOption(CO_STEWARD.id);
    await editor.getByRole("button", { name: "Add steward" }).click();
    await editor.getByLabel("Add an environment", { exact: true }).fill("Prod!");
    await editor.getByRole("button", { name: "Add environment" }).click();
    await expect(editor.getByRole("alert")).toContainText("lowercase");
    await editor.getByRole("button", { name: "Review change" }).click();
    await page.getByRole("dialog", { name: "Change stewards and environments?" }).getByRole("button", { name: "Save changes" }).click();
    await confirmStepUp(page);
    await su.expectResentOnce();
    expect(su.attempts[1]!.body).toEqual({ sponsorUserIds: [STEWARD.id, CO_STEWARD.id] });
  });

  test("removing an own grant replaces the whole set at the revision read", async ({ page }) => {
    await mockApi(page);
    const su = await requireStepUpOn(page, { method: "PUT", path: `/v1/workload-identities/${IDENTITY.id}/grants`, kind: "identity_manage" });
    const ifMatch: string[] = [];
    page.on("request", (r) => {
      if (r.method() === "PUT" && r.url().endsWith("/grants")) ifMatch.push(r.headers()["if-match"] ?? "");
    });
    await openIdentity(page);
    await page.getByRole("button", { name: "Remove grant on Records server (read_record)" }).click();
    await page.getByRole("dialog", { name: "Remove own grant?" }).getByRole("button", { name: "Remove grant" }).click();
    await confirmStepUp(page);
    await su.expectResentOnce();
    expect(su.attempts[1]!.body).toEqual({ tools: [], servers: [], agents: [], connectors: [], roleIds: [ROLE.id], revision: 4 });
    expect(ifMatch).toEqual(['"4"', '"4"']);
    await expect(page.getByText("Own grant removed.")).toBeVisible();
  });

  test("a whole-server grant starts read-only", async ({ page }) => {
    await mockApi(page);
    const su = await requireStepUpOn(page, { method: "PUT", path: `/v1/workload-identities/${IDENTITY.id}/grants`, kind: "identity_manage" });
    await openIdentity(page);
    await page.getByRole("button", { name: "Add own grant" }).click();
    const editor = page.getByRole("dialog", { name: "Add own grant" });
    await editor.getByLabel("Grant kind", { exact: true }).selectOption("server");
    await editor.getByLabel("Target", { exact: true }).selectOption(SERVER.id);
    await expect(editor.getByLabel("Only its read-only tools")).toBeChecked();
    await expectNoAxeViolations(page, "the open Add own grant dialog");
    await editor.getByRole("button", { name: "Review grant" }).click();
    await page.getByRole("dialog", { name: "Add own grant?" }).getByRole("button", { name: "Add grant" }).click();
    await confirmStepUp(page);
    await su.expectResentOnce();
    expect((su.attempts[1]!.body as { servers: unknown }).servers).toEqual([{ serverId: SERVER.id, readOnlyAll: true }]);
  });

  test("a stale grant revision is refused and reported, never shown as saved", async ({ page }) => {
    const m = await mockApi(page);
    await openIdentity(page);
    m.grantsRevision = 5; // another admin changed the set after this page read revision 4
    await page.getByRole("button", { name: "Remove grant on Records server (read_record)" }).click();
    await page.getByRole("dialog", { name: "Remove own grant?" }).getByRole("button", { name: "Remove grant" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "changed since this page loaded" }).first()).toBeVisible();
    await expect(page.getByText("Own grant removed.")).toHaveCount(0);
    await expect(page.getByText("revision 5", { exact: false }).first()).toBeVisible();
  });

  test("a run's delegation tree is drawn root first, and a cascade revoke goes through step-up", async ({ page }) => {
    const m = await mockApi(page);
    const su = await requireStepUpOn(page, { method: "POST", path: `/v1/delegation-grants/${U(40)}/revoke`, kind: "identity_manage" });
    await page.goto("/ui/admin/workload-identities");
    await page.getByLabel("Run ID", { exact: true }).fill("not-a-run");
    await page.getByRole("button", { name: "Load delegation tree" }).click();
    await expect(page.getByText("Enter a run ID")).toBeVisible();
    await page.getByLabel("Run ID", { exact: true }).fill(RUN);
    await page.getByRole("button", { name: "Load delegation tree" }).click();
    const tree = page.getByRole("table").last();
    await expect(tree.getByRole("row").nth(1)).toContainText("Root grant");
    await expect(tree.getByRole("row").nth(1)).toContainText("Remaining $40.00");
    await expect(tree.getByRole("row").nth(2)).toContainText("Allocated $60.00");
    await expect(tree.getByRole("row").nth(3)).toContainText("Edge not loaded");
    await expect(tree.getByRole("row").nth(3)).not.toContainText("Root");
    await expectNoAxeViolations(page, "the loaded delegation tree");
    expect(m.calls.some((c) => c.path === "/v1/delegation-grants" && c.search.includes(`runId=${RUN}`))).toBe(true);
    await page.getByRole("button", { name: `Revoke grant for ${IDENTITY.identifier} and its descendants` }).click();
    await page.getByRole("dialog", { name: "Revoke grant and descendants?" }).getByRole("button", { name: "Revoke grant and descendants" }).click();
    await confirmStepUp(page);
    await su.expectResentOnce();
    expect(su.attempts[1]!.body).toEqual({});
    expect(notBuiltCalls(m)).toEqual([]);
  });
});
