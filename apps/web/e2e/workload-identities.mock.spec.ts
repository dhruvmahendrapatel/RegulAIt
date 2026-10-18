/**
 * ADR-0188 S6 — the workload identities page against a mocked gateway (no
 * database). The page is in the Identity & Access navigation. These check
 * that it reads the live S4/S5/S6 routes, that every write is confirmed
 * and resent once through the identity_manage step-up with the same body, that
 * a stale grant revision is refused rather than reported as saved, that a
 * private key is refused in the browser before anything is sent, and that no
 * route the gateway answers 501 is ever called (S6 built the last of them).
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
const CREDENTIAL = {
  id: U(60), identityId: IDENTITY.id, kind: "jwk", publicJwk: { kty: "OKP", crv: "Ed25519", x: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo" },
  jwkThumbprint: "kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k", x5tS256: null, sanUri: null, subjectDn: null, spiffeId: null, selfSigned: false,
  notBefore: new Date(Date.now() - 3_600_000).toISOString(), notAfter: LATER, revokedAt: null, createdAt: ISO,
};
const UNHELD_AGENT = U(13);
const PROPOSALS = {
  identityId: IDENTITY.id, windowDays: 30, since: ISO, revision: 4, unproposable: 1, truncated: false,
  proposals: [
    // allowed before, refused since: pre-selected
    { grant: { kind: "agent", agentId: AGENT.id, allowedModes: ["execute"] }, observedCalls: 3, refusedCalls: 2, lastObservedAt: ISO, heldByStewards: true, refusalOnly: false },
    // never ran: offered, but only by ticking it (security review Medium 3)
    { grant: { kind: "agent", agentId: AGENT.id, allowedModes: ["review"] }, observedCalls: 2, refusedCalls: 2, lastObservedAt: ISO, heldByStewards: true, refusalOnly: true },
    { grant: { kind: "agent", agentId: UNHELD_AGENT, allowedModes: ["execute"] }, observedCalls: 1, refusedCalls: 1, lastObservedAt: ISO, heldByStewards: false, refusalOnly: true },
  ],
  currentSet: { tools: [{ serverId: SERVER.id, toolName: "read_record" }], servers: [], connectors: [], roleIds: [ROLE.id], agents: [], revision: 4 },
  proposedSet: {
    tools: [{ serverId: SERVER.id, toolName: "read_record" }], servers: [], connectors: [], roleIds: [ROLE.id],
    agents: [{ agentId: AGENT.id, allowedModes: ["execute"] }], revision: 4,
  },
};
const PICKERS = {
  sponsors: [{ id: STEWARD.id, label: STEWARD.displayName, email: STEWARD.email }, { id: CO_STEWARD.id, label: CO_STEWARD.displayName, email: CO_STEWARD.email }],
  subjects: { agent: [{ id: U(14), label: "Unbound bot" }], builder_agent: [], engine_runner: [] },
  environments: ["dev", "hosted"],
  servers: [], agents: [], connectors: [], roles: [], workerIdentities: [], truncated: false,
};
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

/** ADR-0188 S9: one active SPIFFE trust bundle and one it replaced */
const BUNDLE = {
  id: U(70), trustDomain: "byoc.example.test", status: "active", format: "spiffe_jwks", digest: "a".repeat(64),
  authorities: [{ thumbprint: "t1", subject: "C=US, O=SPIFFE", notBefore: ISO, notAfter: LATER }],
  jwtAuthorities: [{ kid: "jwt-k1", kty: "EC", crv: "P-256", thumbprint: "j1" }], jwtAuthoritiesIgnored: 0, source: "fetch", sequence: 4,
  createdBy: STEWARD.id, createdAt: ISO, supersededAt: null, supersededByBundleId: null, revokedAt: null, revokedBy: null,
};
const OLD_BUNDLE = { ...BUNDLE, id: U(71), status: "superseded", digest: "b".repeat(64), supersededAt: ISO, supersededByBundleId: BUNDLE.id, jwtAuthorities: [], jwtAuthoritiesIgnored: 1, source: "upload", sequence: null };
/** ADR-0188 S9 follow-up: the bundle endpoint that fetched BUNDLE */
const ENDPOINT = {
  trustDomain: BUNDLE.trustDomain, url: "https://bundle.byoc.example.test/byoc", profile: "https_spiffe", endpointSpiffeId: "spiffe://byoc.example.test/spire/server",
  enabled: true, nextRefreshAt: LATER, lastAttemptAt: ISO, lastSuccessAt: ISO, lastErrorCode: null, consecutiveFailures: 0, trustUntil: LATER, updatedBy: STEWARD.id, updatedAt: ISO,
};
/** a PEM block the browser forwards as typed (its body need not parse: the gateway judges it) */
const CA_PEM = "-----BEGIN CERTIFICATE-----\nMIIBsynthetic\n-----END CERTIFICATE-----\n";

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
  /** S9: the deployment still sets the retired bundle variable */
  legacyEnv: boolean;
}

async function mockApi(page: Page, opts: Partial<Mock> = {}): Promise<Mock> {
  const m: Mock = { calls: [], unmatched: [], grantsRevision: 4, listFails: false, legacyEnv: false, ...opts };
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
    // ADR-0188 S9: the SPIFFE trust bundles card
    if (p === "/v1/identity/spiffe-trust-bundles" && method === "GET") return json(route, { items: [BUNDLE, OLD_BUNDLE], legacyEnvironmentIgnored: m.legacyEnv });
    if (p === "/v1/identity/spiffe-trust-bundles" && method === "POST") {
      const body = req.postDataJSON() as { trustDomain: string; replacesBundleId: string | null };
      return json(route, { ...BUNDLE, id: U(72), trustDomain: body.trustDomain, digest: "c".repeat(64) }, 201);
    }
    if (p === `/v1/identity/spiffe-trust-bundles/${BUNDLE.id}/revoke` && method === "POST") {
      return json(route, { bundle: { ...BUNDLE, status: "revoked", revokedAt: ISO, revokedBy: STEWARD.id }, tokensRevoked: 2, grantsRevoked: [U(40)], cascade: "complete", grantsNotRevoked: [] });
    }
    // ADR-0188 S9 follow-up: the SPIFFE bundle endpoints card
    if (p === "/v1/identity/spiffe-bundle-endpoints" && method === "GET") return json(route, { items: [ENDPOINT] });
    if (p.startsWith("/v1/identity/spiffe-bundle-endpoints/") && method === "PUT") {
      const body = req.postDataJSON() as { enabled: boolean };
      return json(route, { endpoint: { ...ENDPOINT, ...body, trustDomain: decodeURIComponent(p.split("/").pop()!) }, refresh: body.enabled ? { trustDomain: "x", outcome: "unchanged", bundleId: BUNDLE.id } : null });
    }
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
    if (p === `/v1/workload-identities/${IDENTITY.id}/credentials` && method === "GET") return json(route, { items: [CREDENTIAL] });
    if (p === `/v1/workload-identities/${IDENTITY.id}/credentials` && method === "POST") {
      return json(route, { ...CREDENTIAL, id: U(61), publicJwk: (req.postDataJSON() as { publicJwk: object }).publicJwk }, 201);
    }
    if (p === `/v1/workload-identities/${IDENTITY.id}/credentials/${CREDENTIAL.id}` && method === "DELETE") {
      return json(route, { credential: { ...CREDENTIAL, revokedAt: ISO }, tokensRevoked: 0, grantsRevoked: [] });
    }
    if (p === `/v1/workload-identities/${IDENTITY.id}/revoke` && method === "POST") {
      return json(route, { identity: { ...IDENTITY, status: "revoked" }, credentialsRevoked: 1, tokensRevoked: 0, grantsRevoked: [] });
    }
    if (p === `/v1/workload-identities/${IDENTITY.id}/grant-proposals` && method === "GET") return json(route, PROPOSALS);
    if (p === "/v1/identity/picker-sources" && method === "GET") return json(route, PICKERS);
    if (p === "/v1/workload-identities" && method === "POST") {
      return json(route, { ...IDENTITY, id: U(25), kind: "worker_runtime", agentId: null, ...(req.postDataJSON() as object) }, 201);
    }
    // U3: the identity and delegation settings card on this page (strict defaults)
    if (p === "/v1/org/settings" && method === "GET") {
      return json(route, {
        settings: {
          agentEntitlementMode: "own_grants", delegatedTokenTtlSeconds: 300, delegationMaxDepth: 3,
          workloadClientAuthMethods: ["private_key_jwt", "tls_client_auth", "self_signed_tls_client_auth", "spiffe_svid"],
          dpopNonceRequired: true, workloadKeyMaxAgeDays: 90, delegationUncappedRootAllowed: false,
          delegationRootDefaultCapMicros: 0, delegationRootMaxLifetimeSeconds: 900,
        },
      });
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

test.describe("ADR-0188 S6: workload identities", () => {
  test.beforeEach(() => {
    current = null;
  });
  test.afterEach(() => {
    expect(current?.unmatched ?? [], "every /v1 call this page makes is mocked deliberately").toEqual([]);
  });

  test("lists identities from the live route, is in the Identity & Access navigation, and calls no stub", async ({ page }) => {
    const m = await mockApi(page);
    await page.goto("/ui/admin/workload-identities");
    await expect(page.getByRole("heading", { name: "Workload identities" })).toBeVisible();
    const row = page.getByRole("row", { name: new RegExp(IDENTITY.identifier) });
    await expect(row).toContainText("Avery Admin");
    await expect(row).toContainText("dev");
    await expect(page.getByRole("note").filter({ hasText: "cannot be undone" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Workload identities" }).first()).toHaveAttribute("href", /\/admin\/workload-identities$/);

    // S6 built the last stub: every control is live
    expect(IDENTITY_ROUTES_NOT_BUILT).toEqual([]);
    await expect(page.getByRole("button", { name: "Add identity" })).toBeEnabled();

    await page.getByRole("button", { name: `Manage ${IDENTITY.identifier}` }).click();
    await expect(page.getByRole("button", { name: "Revoke identity" })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Add public credential" })).toBeEnabled();
    await expect(page.getByText("1 credential is active")).toBeVisible();
    await expect(page.getByRole("row", { name: /kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k/ })).toContainText("live");
    const grants = page.getByRole("row", { name: /read_record/ });
    await expect(grants).toContainText("Records server");
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
  test("creating an identity offers only the picker sources and is resent once through step-up", async ({ page }) => {
    const m = await mockApi(page);
    const su = await requireStepUpOn(page, { method: "POST", path: "/v1/workload-identities", kind: "identity_manage" });
    await page.goto("/ui/admin/workload-identities");
    await page.getByRole("button", { name: "Add identity" }).click();
    const dialog = page.getByRole("dialog", { name: "Add workload identity" });
    await expect(dialog.getByRole("button", { name: "Review identity" })).toBeEnabled();
    await dialog.getByRole("button", { name: "Review identity" }).click();
    await expect(dialog.getByRole("alert")).toContainText("steward");
    await dialog.getByLabel("Add a steward", { exact: true }).selectOption(STEWARD.id);
    await dialog.getByRole("button", { name: "Add steward" }).click();
    await dialog.getByLabel("Add an environment", { exact: true }).selectOption("dev");
    await dialog.getByRole("button", { name: "Add environment" }).click();
    await expectNoAxeViolations(page, "the open Add workload identity dialog");
    await dialog.getByRole("button", { name: "Review identity" }).click();
    await page.getByRole("dialog", { name: "Create workload identity?" }).getByRole("button", { name: "Create identity" }).click();
    await confirmStepUp(page);
    await su.expectResentOnce();
    expect(su.attempts[1]!.body).toEqual({ kind: "worker_runtime", sponsorUserIds: [STEWARD.id], environments: ["dev"] });
    await expect(page.getByText("Workload identity created.")).toBeVisible();
    expect(m.calls.some((c) => c.path === "/v1/identity/picker-sources")).toBe(true);
  });

  test("a private key is refused in the browser; a public key is bound through step-up", async ({ page }) => {
    const m = await mockApi(page);
    const su = await requireStepUpOn(page, { method: "POST", path: `/v1/workload-identities/${IDENTITY.id}/credentials`, kind: "identity_manage" });
    await openIdentity(page);
    await page.getByRole("button", { name: "Add public credential" }).click();
    const dialog = page.getByRole("dialog", { name: "Add public credential" });
    const field = dialog.getByLabel("Public key (JSON Web Key)", { exact: true });
    await field.fill(JSON.stringify({ ...CREDENTIAL.publicJwk, d: "SYNTHETIC_PRIVATE_MEMBER" }));
    await dialog.getByRole("button", { name: "Review credential" }).click();
    await expect(dialog.getByRole("alert")).toContainText("private key");
    expect(m.calls.filter((c) => c.method === "POST" && c.path.endsWith("/credentials"))).toHaveLength(0);
    await field.fill(JSON.stringify({ ...CREDENTIAL.publicJwk, kid: "mine" }));
    await dialog.getByRole("button", { name: "Review credential" }).click();
    await page.getByRole("dialog", { name: "Add public credential?" }).getByRole("button", { name: "Add credential" }).click();
    await confirmStepUp(page);
    await su.expectResentOnce();
    expect(su.attempts[1]!.body).toEqual({ kind: "jwk", publicJwk: CREDENTIAL.publicJwk });
    await expect(page.getByText("Public credential added.")).toBeVisible();
  });

  test("revoking a credential is confirmed as permanent and stepped up", async ({ page }) => {
    await mockApi(page);
    const cred = await requireStepUpOn(page, { method: "DELETE", path: `/v1/workload-identities/${IDENTITY.id}/credentials/${CREDENTIAL.id}`, kind: "identity_manage" });
    await openIdentity(page);
    await page.getByRole("button", { name: /^Revoke Public key \(JWK\)/ }).click();
    const c = page.getByRole("dialog", { name: "Revoke public credential?" });
    await expect(c).toContainText("never revived");
    await c.getByRole("button", { name: "Revoke credential" }).click();
    await confirmStepUp(page);
    await cred.expectResentOnce();
    await expect(page.getByText("Credential revoked.")).toBeVisible();
  });

  test("revoking the identity is confirmed as permanent and stepped up", async ({ page }) => {
    await mockApi(page);
    const ident = await requireStepUpOn(page, { method: "POST", path: `/v1/workload-identities/${IDENTITY.id}/revoke`, kind: "identity_manage" });
    await openIdentity(page);
    await page.getByRole("button", { name: "Revoke identity" }).click();
    const r = page.getByRole("dialog", { name: "Revoke identity permanently?" });
    await expect(r).toContainText("can never be restored");
    await r.getByRole("button", { name: "Revoke identity" }).click();
    await confirmStepUp(page);
    await ident.expectResentOnce();
    expect(ident.attempts[1]!.body).toEqual({});
    await expect(page.getByText("Identity revoked.")).toBeVisible();
  });

  test("proposals from observed use are read on request and accepted as the proposed set at its revision", async ({ page }) => {
    const m = await mockApi(page);
    const su = await requireStepUpOn(page, { method: "PUT", path: `/v1/workload-identities/${IDENTITY.id}/grants`, kind: "identity_manage" });
    await openIdentity(page);
    expect(m.calls.some((c) => c.path.endsWith("/grant-proposals"))).toBe(false);
    await page.getByRole("button", { name: "Propose grants from observed use" }).click();
    await expect(page.getByRole("row", { name: /no steward holds it/ })).toBeVisible();
    await expect(page.getByText("1 observed call(s) cannot become an own grant", { exact: false })).toBeVisible();
    await expectNoAxeViolations(page, "the loaded grant proposals");
    await page.getByRole("button", { name: "Accept proposals" }).click();
    await page.getByRole("dialog", { name: "Accept proposed grants?" }).getByRole("button", { name: "Accept proposals" }).click();
    await confirmStepUp(page);
    await su.expectResentOnce();
    expect(su.attempts[1]!.body).toEqual(PROPOSALS.proposedSet);
    await expect(page.getByText("Proposed grants accepted.")).toBeVisible();
  });

  test("a proposal that never ran is not pre-selected, and is added only when ticked", async ({ page }) => {
    await mockApi(page);
    const su = await requireStepUpOn(page, { method: "PUT", path: `/v1/workload-identities/${IDENTITY.id}/grants`, kind: "identity_manage" });
    await openIdentity(page);
    await page.getByRole("button", { name: "Propose grants from observed use" }).click();
    const allowedBefore = page.getByRole("checkbox", { name: `Include Agent invocation; modes: execute on ${AGENT.name}` });
    const neverRan = page.getByRole("checkbox", { name: `Include Agent invocation; modes: review on ${AGENT.name}` });
    await expect(allowedBefore).toBeChecked();
    await expect(neverRan).not.toBeChecked();
    await expect(page.getByRole("row", { name: /modes: review/ })).toContainText("Never ran: every call was refused for lack of this grant.");
    // the proposal no steward holds cannot be selected at all
    await expect(page.getByRole("row", { name: /no steward holds it/ }).getByRole("checkbox")).toHaveCount(0);
    await neverRan.check();
    await page.getByRole("button", { name: "Accept proposals" }).click();
    const confirm = page.getByRole("dialog", { name: "Accept proposed grants?" });
    await expect(confirm).toContainText("never been allowed to use");
    await confirm.getByRole("button", { name: "Accept proposals" }).click();
    await confirmStepUp(page);
    await su.expectResentOnce();
    expect(su.attempts[1]!.body).toEqual({ ...PROPOSALS.currentSet, agents: [{ agentId: AGENT.id, allowedModes: ["execute", "review"] }] });
  });
});

test.describe("ADR-0188 S9: SPIFFE trust bundles", () => {
  test.beforeEach(() => {
    current = null;
  });
  test.afterEach(() => {
    expect(current?.unmatched ?? [], "every /v1 call this page makes is mocked deliberately").toEqual([]);
  });

  const card = (page: Page) => page.getByTestId("spiffe-trust-bundles");
  const bundlePosts = (m: Mock) => m.calls.filter((c) => c.method === "POST" && c.path === "/v1/identity/spiffe-trust-bundles");

  test("lists bundles, says the retired variable is ignored, and refuses a private key in the browser", async ({ page }) => {
    const m = await mockApi(page, { legacyEnv: true });
    await page.goto("/ui/admin/workload-identities");
    const c = card(page);
    await expect(c.getByRole("row", { name: /byoc\.example\.test.*active/ }).first()).toContainText("1 JWT-SVID key(s): jwt-k1");
    await expect(c.getByRole("row", { name: /byoc\.example\.test.*active/ }).first()).toContainText("fetched, sequence 4");
    await expect(c.getByRole("row", { name: /superseded/ })).toContainText("1 JWT-SVID key(s) not kept");
    await expect(c.getByRole("row", { name: /superseded/ })).toContainText("Replaced");
    await expect(c.getByRole("note")).toContainText("REGULAIT_SPIFFE_TRUST_BUNDLES");
    await c.getByLabel("Trust domain", { exact: true }).fill("new.example.test");
    // assembled at runtime: no key-shaped literal in the repository
    await c.getByLabel("Bundle (SPIFFE JSON or PEM CA certificates)").fill(`${CA_PEM}${["-----BEGIN", "PRIVATE KEY-----"].join(" ")}\n`);
    await c.getByRole("button", { name: "Upload bundle" }).click();
    await expect(c.getByText("This text contains a private key.")).toBeVisible();
    // a domain that already has an active bundle must be replaced from its row
    await c.getByLabel("Trust domain", { exact: true }).fill(BUNDLE.trustDomain);
    await c.getByLabel("Bundle (SPIFFE JSON or PEM CA certificates)").fill(CA_PEM);
    await c.getByRole("button", { name: "Upload bundle" }).click();
    await expect(c.getByText("already has an active bundle")).toBeVisible();
    expect(bundlePosts(m)).toHaveLength(0);
    await expectNoAxeViolations(page, "the SPIFFE trust bundles card");
  });

  test("a first upload is confirmed, then resent once through the identity_manage step-up with the same body", async ({ page }) => {
    await mockApi(page);
    const su = await requireStepUpOn(page, { method: "POST", path: "/v1/identity/spiffe-trust-bundles", kind: "identity_manage" });
    await page.goto("/ui/admin/workload-identities");
    const c = card(page);
    await c.getByLabel("Trust domain", { exact: true }).fill("new.example.test");
    await c.getByLabel("Bundle (SPIFFE JSON or PEM CA certificates)").fill(CA_PEM);
    await c.getByRole("button", { name: "Upload bundle" }).click();
    const confirm = page.getByRole("dialog", { name: "Trust new.example.test?" });
    await expect(confirm).toContainText("widens who can sign in");
    await confirm.getByRole("button", { name: "Upload bundle" }).click();
    await confirmStepUp(page);
    await su.expectResentOnce();
    expect(su.attempts[1]!.body).toEqual({ trustDomain: "new.example.test", bundle: CA_PEM, replacesBundleId: null });
    await expect(page.getByText("Bundle uploaded.")).toBeVisible();
  });

  test("replacing names the active bundle (compare-and-set) and keeps the domain fixed", async ({ page }) => {
    await mockApi(page);
    const su = await requireStepUpOn(page, { method: "POST", path: "/v1/identity/spiffe-trust-bundles", kind: "identity_manage" });
    await page.goto("/ui/admin/workload-identities");
    const c = card(page);
    await c.getByRole("button", { name: `Replace the bundle of ${BUNDLE.trustDomain}` }).click();
    await expect(c.getByLabel("Trust domain", { exact: true })).toHaveValue(BUNDLE.trustDomain);
    await expect(c.getByLabel("Trust domain", { exact: true })).toHaveAttribute("readonly", "");
    await c.getByLabel("Bundle (SPIFFE JSON or PEM CA certificates)").fill(CA_PEM);
    await c.getByRole("button", { name: "Replace bundle" }).click();
    const confirm = page.getByRole("dialog", { name: `Replace the bundle of ${BUNDLE.trustDomain}?` });
    await expect(confirm).toContainText("Keep the old CA in the bundle");
    await confirm.getByRole("button", { name: "Replace bundle" }).click();
    await confirmStepUp(page);
    await su.expectResentOnce();
    expect(su.attempts[1]!.body).toEqual({ trustDomain: BUNDLE.trustDomain, bundle: CA_PEM, replacesBundleId: BUNDLE.id });
    await expect(page.getByText("Bundle replaced.")).toBeVisible();
  });

  test("revoking is confirmed as permanent, with the cascade named, and stepped up", async ({ page }) => {
    await mockApi(page);
    const su = await requireStepUpOn(page, { method: "POST", path: `/v1/identity/spiffe-trust-bundles/${BUNDLE.id}/revoke`, kind: "identity_manage" });
    await page.goto("/ui/admin/workload-identities");
    await card(page).getByRole("button", { name: `Revoke the bundle of ${BUNDLE.trustDomain}` }).click();
    const confirm = page.getByRole("dialog", { name: `Revoke the bundle of ${BUNDLE.trustDomain}?` });
    await expect(confirm).toContainText("cannot be undone");
    await expect(confirm).toContainText("revoked with its descendants");
    await expectNoAxeViolations(page, "the revoke-bundle confirmation");
    await confirm.getByRole("button", { name: "Revoke bundle" }).click();
    await confirmStepUp(page);
    await su.expectResentOnce();
    expect(su.attempts[1]!.body).toEqual({});
    await expect(page.getByText("Bundle revoked.")).toBeVisible();
  });
});

test.describe("ADR-0188 S9 follow-up: SPIFFE bundle endpoints", () => {
  test.beforeEach(() => {
    current = null;
  });
  test.afterEach(() => {
    expect(current?.unmatched ?? [], "every /v1 call this page makes is mocked deliberately").toEqual([]);
  });

  const card = (page: Page) => page.getByTestId("spiffe-bundle-endpoints");
  const endpointPuts = (m: Mock) => m.calls.filter((c) => c.method === "PUT" && c.path.startsWith("/v1/identity/spiffe-bundle-endpoints/"));

  test("lists the endpoint with its fetch state, and refuses a non-https URL and a missing server ID in the browser", async ({ page }) => {
    const m = await mockApi(page);
    await page.goto("/ui/admin/workload-identities");
    const c = card(page);
    await expect(c.getByRole("row", { name: /byoc\.example\.test/ })).toContainText("fetching");
    await expect(c.getByRole("row", { name: /byoc\.example\.test/ })).toContainText("spiffe://byoc.example.test/spire/server");
    await c.getByLabel("Trust domain to fetch").fill("new.example.test");
    await c.getByLabel("Bundle endpoint URL").fill("http://bundle.new.example.test/new");
    await c.getByLabel("Endpoint server SPIFFE ID").fill("spiffe://new.example.test/spire/server");
    await c.getByRole("button", { name: "Save and fetch" }).click();
    await expect(c.getByText("A bundle endpoint URL is https.")).toBeVisible();
    await c.getByLabel("Bundle endpoint URL").fill("https://bundle.new.example.test/new");
    await c.getByLabel("Endpoint server SPIFFE ID").fill("");
    await c.getByRole("button", { name: "Save and fetch" }).click();
    await expect(c.getByText("Name the endpoint server's SPIFFE ID")).toBeVisible();
    expect(endpointPuts(m)).toHaveLength(0);
    await expectNoAxeViolations(page, "the SPIFFE bundle endpoints card");
  });

  test("setting an endpoint is confirmed, then resent once through the identity_manage step-up with the same body", async ({ page }) => {
    await mockApi(page);
    const su = await requireStepUpOn(page, { method: "PUT", path: "/v1/identity/spiffe-bundle-endpoints/new.example.test", kind: "identity_manage" });
    await page.goto("/ui/admin/workload-identities");
    const c = card(page);
    await c.getByLabel("Trust domain to fetch").fill("new.example.test");
    await c.getByLabel("Bundle endpoint URL").fill("https://bundle.new.example.test/new");
    await c.getByLabel("Endpoint profile").selectOption("https_web");
    await c.getByRole("button", { name: "Save and fetch" }).click();
    const confirm = page.getByRole("dialog", { name: "Fetch the bundle of new.example.test?" });
    await expect(confirm).toContainText("whoever controls this endpoint decides");
    await confirm.getByRole("button", { name: "Save and fetch" }).click();
    await confirmStepUp(page);
    await su.expectResentOnce();
    expect(su.attempts[1]!.body).toEqual({ url: "https://bundle.new.example.test/new", profile: "https_web", endpointSpiffeId: null, enabled: true });
    await expect(page.getByText("Endpoint saved.")).toBeVisible();
  });

  test("stopping a fetch keeps the endpoint and names when the last bundle stops authenticating", async ({ page }) => {
    await mockApi(page);
    const su = await requireStepUpOn(page, { method: "PUT", path: `/v1/identity/spiffe-bundle-endpoints/${ENDPOINT.trustDomain}`, kind: "identity_manage" });
    await page.goto("/ui/admin/workload-identities");
    await card(page).getByRole("button", { name: `Stop fetching the bundle of ${ENDPOINT.trustDomain}` }).click();
    const confirm = page.getByRole("dialog", { name: `Stop fetching the bundle of ${ENDPOINT.trustDomain}?` });
    await expect(confirm).toContainText("keeps authenticating until");
    await confirm.getByRole("button", { name: "Stop fetching" }).click();
    await confirmStepUp(page);
    await su.expectResentOnce();
    expect(su.attempts[1]!.body).toEqual({ url: ENDPOINT.url, profile: ENDPOINT.profile, endpointSpiffeId: ENDPOINT.endpointSpiffeId, enabled: false });
    await expect(page.getByText("Fetching stopped.")).toBeVisible();
  });
});
