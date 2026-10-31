/**
 * U3 batch: the users, spend, data-key, first-run, ChatOps, billing and edit
 * controls, against a mocked gateway that answers with the live route shapes.
 *
 * What these pin, per control: the request it sends (only what was edited or
 * chosen), the refusal it shows in the gateway's words, and axe (light and
 * dark) on the new surface.
 */
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;
const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const U = (n: number) => `${String(n).padStart(8, "0")}-0000-4000-8000-0000000000d3`;
const T = "2026-10-11T12:00:00.000Z";
const ME = U(99);
const BOB = U(2);

type Handler = (body: Json, url: URL) => { status?: number; body: unknown } | unknown;
interface Mock {
  calls: Array<{ method: string; path: string; body: Json }>;
  on: (key: string, h: Handler | unknown) => void;
}

function authMe(over: Record<string, unknown> = {}) {
  return {
    userId: ME,
    isAdmin: true,
    via: "session",
    user: { id: ME, email: "ada@example.test", username: null, displayName: "Ada Admin" },
    mustChangePassword: false,
    totpEnabled: true,
    passwordSet: true,
    mfaSetupRequired: false,
    usernameSelfService: true,
    ...over,
  };
}

async function mockApi(page: Page, routes: Record<string, Handler | unknown> = {}): Promise<Mock> {
  const table = new Map<string, Handler | unknown>(Object.entries(routes));
  const m: Mock = { calls: [], on: (k, h) => void table.set(k, h) };
  if (!table.has("GET /auth/me")) table.set("GET /auth/me", authMe());
  await page.route("**/*", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname;
    if (req.resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    let body: Json;
    try {
      body = req.postDataJSON();
    } catch {
      body = undefined;
    }
    m.calls.push({ method: req.method(), path: p + url.search, body });
    const key = `${req.method()} ${p}`;
    const h = table.get(key) ?? (p === "/v1/me" ? table.get("GET /auth/me") : undefined);
    if (h === undefined) return json(route, {});
    const out = typeof h === "function" ? (h as Handler)(body, url) : h;
    if (out && typeof out === "object" && "status" in (out as object) && "body" in (out as object)) {
      const o = out as { status: number; body: unknown };
      return json(route, o.body, o.status);
    }
    return json(route, out);
  });
  return m;
}

const sent = (m: Mock, method: string, path: string) => m.calls.filter((c) => c.method === method && c.path.split("?")[0] === path).map((c) => c.body);

const THEMES = ["light", "dark"] as const;
async function expectAxeClean(page: Page, label: string, include?: string) {
  for (const theme of THEMES) {
    await page.evaluate(async (next) => {
      document.documentElement.dataset.theme = next;
      localStorage.setItem("regulait.theme", next);
      const finite = document.getAnimations().filter((a) => a.effect?.getTiming().iterations !== Infinity);
      await Promise.race([Promise.all(finite.map((a) => a.finished.catch(() => undefined))), new Promise((r) => setTimeout(r, 1_000))]);
    }, theme);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    let builder = new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]);
    if (include) builder = builder.include(include);
    const results = await builder.analyze();
    const summary = results.violations.map((v) => `${v.id} (${v.impact}) — ${v.help}\n    ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join("\n    ")}`);
    expect(summary, `axe on "${label}" (${theme})`).toEqual([]);
  }
}

const USERS = {
  users: [
    { id: ME, email: "ada@example.test", username: null, displayName: "Ada Admin", isAdmin: true, disabledAt: null, createdAt: T, totpEnabled: true, hasPassword: true, mustChangePassword: false },
    { id: BOB, email: "bob@example.test", username: "bob", displayName: "Bob Builder", isAdmin: false, disabledAt: null, createdAt: T, totpEnabled: false, hasPassword: true, mustChangePassword: false },
  ],
};

// ---------------------------------------------------------------------------
// item 3: usernames and role provenance
// ---------------------------------------------------------------------------

test.describe("U3: usernames", () => {
  test("self-service: set my username; a taken one is refused in the gateway's words", async ({ page }) => {
    let attempt = 0;
    const m = await mockApi(page, {
      "POST /auth/username": () =>
        ++attempt === 1 ? { status: 409, body: { error: "username_taken", detail: "username 'ada' is already taken", username: "ada" } } : { id: ME, username: "ada.l", previousUsername: null },
    });
    await page.goto("/ui/account");
    const form = page.getByTestId("account-username");
    await form.getByLabel("Username").fill("Ada");
    await form.getByRole("button", { name: "Set username" }).click();
    await expect(form.getByRole("alert")).toHaveText("username 'ada' is already taken");
    await form.getByLabel("Username").fill("Ada.L");
    await form.getByRole("button", { name: "Set username" }).click();
    await expect(form.getByRole("status")).toHaveText("Username set to ada.l.");
    expect(sent(m, "POST", "/auth/username")).toEqual([{ username: "ada" }, { username: "ada.l" }]);
    await expectAxeClean(page, "account username", '[data-testid="account-username"]');
  });

  test("self-service off: no control, and who manages it is said", async ({ page }) => {
    await mockApi(page, { "GET /auth/me": authMe({ usernameSelfService: false, user: { id: ME, email: "ada@example.test", username: "ada", displayName: "Ada Admin" } }) });
    await page.goto("/ui/account");
    const form = page.getByTestId("account-username");
    await expect(form).toContainText("ada");
    await expect(form).toContainText("managed by an administrator");
    await expect(form.getByRole("textbox")).toHaveCount(0);
  });

  test("admin: set another user's username; clear it; roles tab shows why they hold each role", async ({ page }) => {
    const m = await mockApi(page, {
      "GET /v1/users": USERS,
      "GET /v1/keys": { keys: [] },
      [`PUT /v1/users/${BOB}/username`]: (b: Json) => ({ id: BOB, username: b.username, previousUsername: "bob" }),
      [`GET /v1/users/${BOB}/role-provenance`]: {
        userId: BOB,
        email: "bob@example.test",
        isAdmin: false,
        isAdminGroupDerivable: false,
        roles: [
          { roleId: U(10), roleName: "Developer", origins: ["direct"], provenance: "direct", assignedAt: T },
          {
            roleId: U(11),
            roleName: "Reviewer",
            origins: ["direct", "group"],
            provenance: "both",
            assignedAt: T,
            viaMappings: [{ mappingId: U(12), source: "scim", externalGroup: "eng-reviewers", currentlyAssertedViaScim: true }],
          },
        ],
      },
    });
    await page.goto("/ui/admin/users");
    await page.getByText("bob@example.test").first().click();
    const form = page.getByTestId("admin-username");
    await expect(form.getByLabel("Username")).toHaveValue("bob");
    await form.getByLabel("Username").fill("robert");
    await form.getByRole("button", { name: "Change username" }).click();
    await expect(form.getByRole("status")).toHaveText("Username set to robert.");
    await form.getByRole("button", { name: "Clear username" }).click();
    expect(sent(m, "PUT", `/v1/users/${BOB}/username`)).toEqual([{ username: "robert" }, { username: null }]);
    await page.getByRole("tab", { name: "Roles" }).click();
    const prov = page.getByTestId("role-provenance");
    await expect(prov.getByText("assigned by an admin")).toBeVisible();
    await expect(prov.getByText("assigned and from a group")).toBeVisible();
    await expect(prov.getByText("SCIM group “eng-reviewers” (SCIM asserts this membership now)")).toBeVisible();
    await expectAxeClean(page, "role provenance", '[data-testid="role-provenance"]');
  });
});

// ---------------------------------------------------------------------------
// items 4-5: my consolidated spend, data-key re-encryption
// ---------------------------------------------------------------------------

test.describe("U3: spend and data key", () => {
  test("my consolidated spend shows metered and imported apart, with the no-FX note", async ({ page }) => {
    const m = await mockApi(page, {
      "GET /v1/usage-events": { events: [], totals: { events: 0, costUsd: 0 } },
      "GET /v1/cost-events": { events: [], totals: [] },
      [`GET /v1/users/${ME}/cost-consolidated`]: {
        window: { from: "2026-09-12T00:00:00.000Z", to: "2026-10-12T00:00:00.000Z" },
        groupedBy: "user",
        subjects: [
          {
            subjectKind: "user",
            subjectId: ME,
            label: "ada@example.test",
            attributed: true,
            metered: { basis: "metered", usd: 12.5, events: 40, unpricedEvents: 2 },
            imported: {
              basis: "imported",
              usd: null,
              lines: 3,
              byCurrency: [],
              byVendor: [
                { vendor: "copilot", currency: "USD", amount: 19, lines: 1 },
                { vendor: "chatgpt", currency: "EUR", amount: 22, lines: 2 },
              ],
              byBillingKind: [],
              usdNote: "no single-currency figure is given because this subject carries lines in more than one currency",
            },
            coverage: "metered_and_imported",
          },
        ],
        basisStatement: "metered = observed by RegulAIt; imported = restated from vendor exports",
        reconciliation: { supersededLinesExcluded: 0, lastReconciledAt: null, note: "" },
        staleness: { vendors: [{ vendor: "copilot", lastImportedAt: T, appliedBatches: 1, daysSinceLastImport: 3 }], note: "There is no scheduled re-import." },
        note: "There is deliberately no combined figure.",
      },
    });
    await page.goto("/ui/spend");
    const card = page.getByTestId("my-cost-consolidated");
    await expect(card.getByText("$12.5", { exact: true })).toBeVisible();
    await expect(card.getByText("2 unpriced, not counted as zero", { exact: false })).toBeVisible();
    await expect(card.getByText("No USD total")).toBeVisible();
    await expect(card.getByText("22.00 EUR")).toBeVisible();
    // the caveat stays visible as a short qualifier; its full sentence is in the metered (i)
    await expect(card.getByText("no combined figure", { exact: false })).toBeVisible();
    await expect(card.getByText("Imported · customer-supplied", { exact: false })).toBeVisible();
    await card.getByRole("button", { name: "What is metered spend?" }).click();
    await expect(page.getByRole("note")).toContainText("There is deliberately no combined figure.");
    await page.keyboard.press("Escape");
    expect(m.calls.some((c) => c.path.startsWith(`/v1/users/${ME}/cost-consolidated`))).toBe(true);
    await expectAxeClean(page, "consolidated spend", '[data-testid="my-cost-consolidated"]');
  });

  test("an incomplete re-encryption walk is an alarm with the resume command and the failed rows", async ({ page }) => {
    await mockApi(page, {
      "GET /v1/security/data-key": { fingerprint: "fp-new", recordedFingerprint: "fp-new", recordedAt: T, lastVerifiedAt: T, rotatedFrom: "fp-old", rotatedAt: T, matches: true, attested: false, attestationCount: 0, latestAttestation: null },
      "GET /v1/security/data-key/attestations": { attestations: [] },
      "GET /v1/security/data-key/reencryption": {
        run: {
          id: U(50),
          fromFingerprint: "fp-old",
          toFingerprint: "fp-new",
          status: "running",
          startedAt: T,
          finishedAt: null,
          perColumn: [{ table: "model_credentials", column: "key_ciphertext", watermark: U(51), done: false, reencrypted: 4, alreadyCurrent: 1, failed: 1 }],
          failures: [{ table: "model_credentials", column: "key_ciphertext", rowId: U(52), detail: "decrypts under neither key", recordedAt: T }],
        },
        resumeCommand: "pnpm --filter @regulait/gateway reencrypt",
        note: "This walk is INCOMPLETE — ciphertext currently exists under two keys.",
      },
    });
    await page.goto("/ui/admin/data-key");
    const card = page.getByTestId("data-key-reencryption");
    await expect(card.getByText("incomplete: data is under two keys")).toBeVisible();
    await expect(card.getByRole("alert")).toContainText("Resume it from the gateway host");
    await expect(card.getByText("pnpm --filter @regulait/gateway reencrypt")).toBeVisible();
    await expect(card.getByText("1 row(s) decrypted under neither key", { exact: false })).toBeVisible();
    await expectAxeClean(page, "re-encryption", '[data-testid="data-key-reencryption"]');
  });
});

// ---------------------------------------------------------------------------
// item 6: onboarding imports
// ---------------------------------------------------------------------------

const WIZARD = { steps: [], doneCount: 0, totalCount: 0, satisfiedCount: 0, resumeAt: null, starterRoles: [], packs: [] };

test.describe("U3: group → role import", () => {
  test("preview, then apply only what the preview showed; an unknown role refuses the whole import", async ({ page }) => {
    let apply = 0;
    const m = await mockApi(page, {
      "GET /v1/onboarding": WIZARD,
      "GET /v1/roles": { roles: [{ id: U(10), name: "Developer", description: null }] },
      "GET /v1/onboarding/imports": { imports: [{ id: U(70), kind: "group_roles", mode: "dry_run", status: "refused", payloadSha256: "a".repeat(64), rowCount: 1, reason: "group→role import refused: 1 row(s) name roles that do not exist", ruleId: "onboarding-import-rejected", createdAt: T, appliedAt: null }], includesRefusals: true },
      "POST /v1/onboarding/imports/group-roles": (b: Json) => {
        const plan = (action: string) => ({ entries: b.rows.map((r: Json) => ({ ...r, action: r.roleName === "Auditor" ? "unknown_role" : action })), counts: { create: action === "create" ? 1 : 0, unchanged: 0, unknown_role: b.rows.some((r: Json) => r.roleName === "Auditor") ? 1 : 0 }, unknownRoles: b.rows.some((r: Json) => r.roleName === "Auditor") ? ["Auditor"] : [] });
        if (b.rows.some((r: Json) => r.roleName === "Auditor")) return { status: 422, body: { error: "unknown_role", ruleId: "x", unknownRoles: ["Auditor"], plan: plan("create") } };
        if (b.mode === "dry_run") return { mode: "dry_run", importId: U(71), plan: plan("create") };
        apply += 1;
        return { mode: "apply", importId: U(72), plan: plan("create"), created: 1 };
      },
    });
    await page.goto("/ui/admin/first-run");
    const card = page.getByTestId("group-role-import");
    await card.getByLabel("Row 1 source").selectOption("scim");
    await card.getByLabel("Row 1 group").fill("eng-devs");
    await card.getByLabel("Row 1 role").fill("Developer");
    await expect(card.getByRole("button", { name: "Apply previewed mappings" })).toBeDisabled();
    await card.getByRole("button", { name: "Preview (changes nothing)" }).click();
    await expect(card.getByText("will be created")).toBeVisible();
    await card.getByRole("button", { name: "Apply previewed mappings" }).click();
    await expect(card.getByText("1 mapping(s) created.")).toBeVisible();
    expect(apply).toBe(1);
    expect(sent(m, "POST", "/v1/onboarding/imports/group-roles")).toEqual([
      { mode: "dry_run", rows: [{ source: "scim", externalGroup: "eng-devs", roleName: "Developer" }] },
      { mode: "apply", rows: [{ source: "scim", externalGroup: "eng-devs", roleName: "Developer" }] },
    ]);
    await card.getByLabel("Row 1 role").fill("Auditor");
    await card.getByRole("button", { name: "Preview (changes nothing)" }).click();
    const outcome = page.getByTestId("group-role-import-outcome");
    await expect(outcome.getByText("unknown_role")).toBeVisible();
    await expect(outcome.getByText("These roles do not exist: Auditor.")).toBeVisible();
    const history = page.getByTestId("onboarding-import-history");
    await expect(history.getByText("refused", { exact: true })).toBeVisible();
    await history.getByLabel("Status").selectOption("refused");
    await expect.poll(() => m.calls.some((c) => c.path.includes("/v1/onboarding/imports?") && c.path.includes("status=refused"))).toBe(true);
    await expectAxeClean(page, "group-role import", '[data-testid="group-role-import"]');
  });
});

// ---------------------------------------------------------------------------
// item 7: ChatOps
// ---------------------------------------------------------------------------

test.describe("U3: ChatOps", () => {
  const CONN = { id: U(80), name: "eng-slack", provider: "slack", connectorId: U(81), defaultChannel: "#approvals", allowFencedDecide: false, enabled: true, createdAt: T };
  test("post a pending approval to a chosen workspace; the answer says what the card carries", async ({ page }) => {
    let n = 0;
    const m = await mockApi(page, {
      "GET /v1/chatops/connections": { connections: [CONN], posture: "p" },
      "GET /v1/chatops/identity-links": { links: [], posture: "" },
      "GET /v1/approvals": { approvals: [{ id: U(90), status: "pending", objectType: "mcp_tool", toolName: "deploy", stageId: null, requestedAt: T, userId: BOB, approverUserId: ME }] },
      "GET /v1/chatops/builder-routes": { routes: [], posture: "routes posture" },
      [`POST /v1/chatops/approvals/${U(90)}/post`]: () =>
        ++n === 1 ? { status: 502, body: { error: "chatops_post_failed", upstreamStatus: 401, detail: "slack refused the post: invalid_auth" } } : { messageId: U(91), redacted: true, decidable: false, messageRef: "1.2" },
    });
    await page.goto("/ui/admin/chatops");
    const card = page.getByTestId("chatops-post-approval");
    await card.getByLabel("Approval").selectOption(U(90));
    await card.getByLabel("Workspace", { exact: true }).selectOption("eng-slack");
    await card.getByRole("button", { name: "Post to chat" }).click();
    await expect(page.getByTestId("chatops-post-outcome")).toContainText("chatops_post_failed");
    await expect(page.getByTestId("chatops-post-outcome")).toContainText("invalid_auth");
    await card.getByRole("button", { name: "Post to chat" }).click();
    await expect(page.getByTestId("chatops-post-outcome")).toContainText("content was withheld");
    expect(sent(m, "POST", `/v1/chatops/approvals/${U(90)}/post`)).toEqual([{ connectionName: "eng-slack" }, { connectionName: "eng-slack" }]);
    await expectAxeClean(page, "post approval", '[data-testid="chatops-post-approval"]');
  });

  test("route a builder agent to one channel; a taken channel is refused by name", async ({ page }) => {
    let n = 0;
    const m = await mockApi(page, {
      "GET /v1/chatops/connections": { connections: [CONN], posture: "p" },
      "GET /v1/chatops/identity-links": { links: [], posture: "" },
      "GET /v1/approvals": { approvals: [] },
      "GET /v1/chatops/builder-routes": {
        routes: [{ channelId: U(95), agentId: U(96), agentName: "Helpdesk", provider: "slack", connectionId: CONN.id, connectionName: "eng-slack", externalChannelId: null }],
        posture: "A message reaches the agent routed to its channel.",
      },
      [`PUT /v1/chatops/builder-routes/${U(95)}`]: (b: Json) =>
        ++n === 1
          ? { status: 409, body: { error: "channel_already_routed", detail: "another agent already answers this channel on this connection; one agent per connection and channel" } }
          : { channelId: U(95), agentId: U(96), provider: "slack", connectionId: CONN.id, externalChannelId: b.externalChannelId },
    });
    await page.goto("/ui/admin/chatops");
    const card = page.getByTestId("chatops-builder-routes");
    await expect(card.getByText("connection-wide", { exact: true })).toBeVisible();
    await card.getByLabel("Channel for Helpdesk (empty = connection-wide)").fill("C0123");
    await card.getByRole("button", { name: "Save route" }).click();
    await expect(page.getByTestId("chatops-route-outcome")).toContainText("one agent per connection and channel");
    await card.getByRole("button", { name: "Save route" }).click();
    await expect(page.getByTestId("chatops-route-outcome")).toContainText("Helpdesk now answers on C0123");
    expect(sent(m, "PUT", `/v1/chatops/builder-routes/${U(95)}`)).toEqual([{ externalChannelId: "C0123" }, { externalChannelId: "C0123" }]);
    await expectAxeClean(page, "builder routes", '[data-testid="chatops-builder-routes"]');
  });
});

// ---------------------------------------------------------------------------
// item 8: billing export
// ---------------------------------------------------------------------------

test.describe("U3: billing statement export", () => {
  test("CSV downloads; a scope refusal is named", async ({ page }) => {
    const ST = { id: U(60), periodId: U(61), version: 1, status: "issued", ratingMode: "list_price", totalUsd: 120, seatCount: 3, unpricedEventCount: 0, generatedAt: T, issuedAt: T };
    let n = 0;
    await mockApi(page, {
      "GET /v1/billing/overview": {
        rateCards: [], periods: [], statements: [ST], exports: [], activeSeats: 3,
        backend: { name: "noop", capabilities: {} }, ledger: { totalEvents: 0, totalListPriceUsd: 0 },
        schedulerPresent: false, paymentProcessorIntegrated: false, reconciledRatingAvailable: false, disclaimer: "", note: "",
      },
    });
    await page.route(`**/v1/billing/statements/${U(60)}/export*`, (route) => {
      n += 1;
      if (n === 1) return route.abort("connectionreset");
      if (n === 2) return json(route, { error: "billing_scope_not_entitled" }, 403);
      return route.fulfill({ status: 200, contentType: "text/csv", body: "dimension,billedUsd\nmodel,120\n" });
    });
    await page.goto("/ui/admin/billing");
    await page.getByRole("button", { name: "Export statement v1 as CSV" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "could not reach the gateway" })).toBeVisible();
    await page.getByRole("button", { name: "Export statement v1 as CSV" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "not entitled" })).toBeVisible();
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export statement v1 as CSV" }).click();
    expect((await download).suggestedFilename()).toBe(`statement-${U(60)}.csv`);
  });
});

// ---------------------------------------------------------------------------
// item 9: edit forms for PATCH routes
// ---------------------------------------------------------------------------

test.describe("U3: edit forms send only what was edited", () => {
  test("initiative: rename; clearing the cost center sends null", async ({ page }) => {
    const m = await mockApi(page, {
      "GET /v1/initiatives": { initiatives: [{ id: U(20), name: "Platform", costCenter: "CC-1", projectCount: 0, spentUsd: 0 }] },
      "GET /v1/projects": { projects: [] },
      "GET /v1/energy/factors": { factors: [], region: null, notes: { shipped: "none shipped", unknown: "unknown" } },
      [`PATCH /v1/initiatives/${U(20)}`]: (b: Json) => ({ id: U(20), name: b.name ?? "Platform", costCenter: b.costCenter === undefined ? "CC-1" : b.costCenter }),
    });
    // P3: initiatives are on the cost dashboard's set-up tab
    await page.goto("/ui/admin/cost?tab=setup");
    await page.getByRole("button", { name: "Edit initiative Platform" }).click();
    const dialog = page.getByRole("dialog", { name: "Edit initiative Platform" });
    await expect(dialog.getByRole("button", { name: "Save changes" })).toBeDisabled();
    await dialog.getByLabel("Cost center (empty = none)").fill("");
    await expectAxeClean(page, "edit initiative");
    await dialog.getByRole("button", { name: "Save changes" }).click();
    await expect(dialog).toBeHidden();
    expect(sent(m, "PATCH", `/v1/initiatives/${U(20)}`)).toEqual([{ costCenter: null }]);
  });

  test("passkey: rename sends the label; a refusal keeps the dialog open", async ({ page }) => {
    let n = 0;
    const m = await mockApi(page, {
      "GET /v1/auth/passkeys": { passkeys: [{ id: U(30), label: "Laptop", createdAt: T, lastUsedAt: null, backedUp: false }], rpConfigured: true },
      [`PATCH /v1/auth/passkeys/${U(30)}`]: (b: Json) => (++n === 1 ? { status: 404, body: { error: "unknown_passkey" } } : { id: U(30), label: b.label, createdAt: T, lastUsedAt: null, backedUp: false }),
    });
    await page.goto("/ui/account");
    await page.getByRole("button", { name: "Rename the passkey Laptop" }).click();
    const dialog = page.getByRole("dialog", { name: 'Rename the passkey "Laptop"' });
    await dialog.getByLabel("Name").fill("Work laptop");
    await dialog.getByRole("button", { name: "Save changes" }).click();
    await expect(dialog.getByRole("alert")).toBeVisible();
    await dialog.getByRole("button", { name: "Save changes" }).click();
    await expect(dialog).toBeHidden();
    expect(sent(m, "PATCH", `/v1/auth/passkeys/${U(30)}`)).toEqual([{ label: "Work laptop" }, { label: "Work laptop" }]);
  });

  test("external scorer: a moved endpoint refused by the egress guard says so; the key is never prefilled", async ({ page }) => {
    const SC = { id: U(40), name: "fid", baseUrl: "https://score.example/v1", scorerKinds: ["groundedness_judge"], allowPlaintextHttp: false, enabled: true, lastTestedAt: T, lastTestError: null, hasApiKey: true, createdBy: ME, createdAt: T };
    const m = await mockApi(page, {
      "GET /v1/external-scorers": { scorers: [SC] },
      "GET /v1/egress-allow-hosts": { hosts: [] },
      [`PATCH /v1/external-scorers/${U(40)}`]: { status: 400, body: { error: "egress_blocked", code: "host_not_allowed", detail: "host 'other.example' is not in the egress allow-list" } },
    });
    await page.goto("/ui/admin/external-scorers");
    await page.getByRole("button", { name: "Edit external scorer fid" }).click();
    const dialog = page.getByRole("dialog", { name: "Edit external scorer fid" });
    await expect(dialog.getByLabel("API key")).toHaveValue("");
    await dialog.getByLabel("Endpoint URL").fill("https://other.example/v1");
    await dialog.getByRole("button", { name: "Save changes" }).click();
    await expect(dialog.getByRole("alert")).toContainText("not in the egress allow-list");
    expect(sent(m, "PATCH", `/v1/external-scorers/${U(40)}`)).toEqual([{ baseUrl: "https://other.example/v1" }]);
  });

  test("report schedule: change the cadence and pick a recipient", async ({ page }) => {
    const m = await mockApi(page, {
      "GET /v1/users": USERS,
      "GET /v1/reports/overview": {
        definitions: [{ id: U(55), name: "Exec summary", kind: "exec_summary", scopeKind: "org", scopeId: null, period: "current_month", format: "json", entitlementScope: "org", description: null, lastGeneratedAt: null, runCount: 0, schedules: [{ id: U(56), definitionId: U(55), cadence: "monthly", enabled: true, recipientUserIds: null, lastGeneratedAt: null, lastRunId: null }] }],
        schedulerPresent: false,
        note: "",
      },
      [`PATCH /v1/reports/schedules/${U(56)}`]: (b: Json) => ({ schedule: { id: U(56), ...b } }),
    });
    await page.goto("/ui/admin/reports");
    await page.getByRole("button", { name: "Edit schedule for Exec summary" }).click();
    const dialog = page.getByRole("dialog", { name: "Edit the monthly schedule for Exec summary" });
    await dialog.getByLabel("Cadence").selectOption("weekly");
    await dialog.getByLabel("bob@example.test").check();
    await dialog.getByRole("button", { name: "Save changes" }).click();
    await expect(dialog).toBeHidden();
    expect(sent(m, "PATCH", `/v1/reports/schedules/${U(56)}`)).toEqual([{ cadence: "weekly", recipientUserIds: [BOB] }]);
  });

  test("report schedule: a stored recipient the list does not show has its own box, and unticking it removes it", async ({ page }) => {
    const gone = U(77);
    const m = await mockApi(page, {
      "GET /v1/users": USERS,
      "GET /v1/reports/overview": {
        definitions: [{ id: U(55), name: "Exec summary", kind: "exec_summary", scopeKind: "org", scopeId: null, period: "current_month", format: "json", entitlementScope: "org", description: null, lastGeneratedAt: null, runCount: 0, schedules: [{ id: U(56), definitionId: U(55), cadence: "monthly", enabled: true, recipientUserIds: [BOB, gone], lastGeneratedAt: null, lastRunId: null }] }],
        schedulerPresent: false,
        note: "",
      },
      [`PATCH /v1/reports/schedules/${U(56)}`]: (b: Json) => ({ schedule: { id: U(56), ...b } }),
    });
    await page.goto("/ui/admin/reports");
    await page.getByRole("button", { name: "Edit schedule for Exec summary" }).click();
    const dialog = page.getByRole("dialog", { name: "Edit the monthly schedule for Exec summary" });
    const unlisted = dialog.getByLabel(`${gone} (not in this list)`);
    await expect(unlisted).toBeChecked();
    await expect(dialog.getByText(/A stored entry is not in the list above and shown by id/)).toBeVisible();
    await unlisted.uncheck();
    // still on screen, so it can be ticked again
    await expect(unlisted).not.toBeChecked();
    await dialog.getByRole("button", { name: "Save changes" }).click();
    await expect(dialog).toBeHidden();
    expect(sent(m, "PATCH", `/v1/reports/schedules/${U(56)}`)).toEqual([{ recipientUserIds: [BOB] }]);
  });

  test("scope rule: set a surface back to inherit sends null", async ({ page }) => {
    const m = await mockApi(page, {
      "GET /v1/interception/settings": { settings: { anthropicCompatEnabled: false, openaiCompatEnabled: false, resolutionMode: "require_agent" } },
      "GET /v1/interception/scope-rules": { rules: [{ id: U(65), scopeKind: "user", scopeId: BOB, scopeName: "bob@example.test", anthropicCompatEnabled: true, openaiCompatEnabled: null, resolutionMode: null, note: "pilot", createdAt: T }] },
      "GET /v1/users": USERS,
      [`PATCH /v1/interception/scope-rules/${U(65)}`]: (b: Json) => ({ id: U(65), ...b }),
    });
    await page.goto("/ui/admin/client-access");
    await page.getByRole("button", { name: "Edit scope rule for user bob@example.test" }).click();
    const dialog = page.getByRole("dialog", { name: "Edit the override for user bob@example.test" });
    await dialog.getByLabel("/v1/messages").selectOption("");
    await dialog.getByRole("button", { name: "Save changes" }).click();
    await expect(dialog).toBeHidden();
    expect(sent(m, "PATCH", `/v1/interception/scope-rules/${U(65)}`)).toEqual([{ anthropicCompatEnabled: null }]);
  });

  test("vendor: editable while in flight; a decided vendor's edit is disabled with the reason", async ({ page }) => {
    const VENDOR = (status: string) => ({ id: U(75), name: "Acme AI", description: "Summaries", category: "ai_feature_vendor", ownerUserId: ME, linkedCustomProviderIds: [], linkedAgentProviders: [], packAttestations: [], status, workflowInstanceId: null, decidedAt: null, retiredReason: null, createdAt: T });
    let status = "under_assessment";
    const m = await mockApi(page, {
      "GET /v1/vendors": () => ({ vendors: [VENDOR(status)], disclaimer: "" }),
      [`GET /v1/vendors/${U(75)}`]: () => ({ vendor: VENDOR(status), instance: null, questionnaire: null, questionnaireTemplate: null, attestations: [], packChecklist: null, disclaimer: "" }),
      "GET /v1/custom-model-providers": { providers: [] },
      "GET /v1/compliance/packs": { packs: [] },
      [`PATCH /v1/vendors/${U(75)}`]: (b: Json) => ({ ...VENDOR(status), ...b }),
    });
    await page.goto(`/ui/admin/vendors?vendor=${U(75)}`);
    if (!(await page.getByRole("button", { name: "Edit vendor Acme AI" }).isVisible())) await page.getByText("Acme AI").first().click();
    await page.getByRole("button", { name: "Edit vendor Acme AI" }).click();
    const dialog = page.getByRole("dialog", { name: "Edit vendor Acme AI" });
    await dialog.getByLabel("Linked agent providers").fill("openai, anthropic");
    await dialog.getByRole("button", { name: "Save changes" }).click();
    await expect(dialog).toBeHidden();
    expect(sent(m, "PATCH", `/v1/vendors/${U(75)}`)).toEqual([{ linkedAgentProviders: ["openai", "anthropic"] }]);
    status = "approved";
    await page.reload();
    if (!(await page.getByRole("button", { name: "Edit vendor Acme AI" }).isVisible())) await page.getByText("Acme AI").first().click();
    await expect(page.getByRole("button", { name: "Edit vendor Acme AI" })).toBeDisabled();
    await expect(page.getByText("This vendor is approved: a decided record", { exact: false })).toBeVisible();
  });
});
