/**
 * ADR-0186 A2+B — dual control and passkey-signed approvals, against a mocked
 * gateway (the *.mock.spec.ts harness):
 *
 *  - the Inbox shows a tool-call approval's quorum progress ("1 of 2
 *    approvals") and who has decided, and Approve SIGNS the exact call: the
 *    signing options are fetched for that decision, the browser's passkey
 *    prompt receives the gateway's challenge untouched, and the decide carries
 *    `passkey: {challengeId, response}`;
 *  - a refused signature is shown as a sentence, not a code;
 *  - the admin Approvals queue signs the same way, with no override for a
 *    tool call, and shows "waiting for another approver" once you decided;
 *  - a step_up-mode approval is decided through the step-up dialog;
 *  - the approval-rule editor posts quorum and approver role, and shows the
 *    gateway's `quorum_unsatisfiable` refusal verbatim;
 *  - axe (WCAG 2.x A/AA) in light and dark on the quorum view.
 *
 * WebAuthn is faked in the page (`navigator.credentials.get`): the browser
 * library only carries the ceremony; the gateway verifies it (proved against
 * real signatures in zz-b4ab-dual-control-signed-approvals.test.ts).
 */
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const iso = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();
/** base64url of sha256 of a payload — the gateway's challenge (any 32 bytes do for the browser) */
const CHALLENGE = "q83vEjRWeJCrze8SNFZ4kKvN7xI0VniQq83vEjRWeJA";

async function fakeWebAuthn(page: Page) {
  await page.addInitScript(() => {
    const buf = (s: string) => new TextEncoder().encode(s).buffer;
    const b64u = (b: ArrayBuffer) =>
      btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const w = window as unknown as { __webauthn: { get: number; challenges: string[] } };
    w.__webauthn = { get: 0, challenges: [] };
    Object.defineProperty(navigator, "credentials", {
      configurable: true,
      value: {
        create: async () => null,
        get: async (opts: { publicKey: { challenge: ArrayBuffer } }) => {
          w.__webauthn.get += 1;
          w.__webauthn.challenges.push(b64u(opts.publicKey.challenge));
          return {
            id: "Y3JlZC0x",
            rawId: buf("cred-1"),
            type: "public-key",
            authenticatorAttachment: "platform",
            response: { clientDataJSON: buf("{}"), authenticatorData: buf("ad"), signature: buf("sig"), userHandle: null },
            getClientExtensionResults: () => ({}),
          };
        },
      },
    });
  });
}

type Row = Record<string, unknown>;
interface Captured {
  signingOptions: Array<{ id: string; body: unknown }>;
  decides: Array<{ id: string; body: Row; grant: string | null }>;
  rules: Row[];
  rulePatches: Row[];
  stepUpOptions: unknown[];
}

const AVERY = { id: "u-avery", email: "avery@example.test", displayName: "Avery Approver" };
const BEN = { id: "u-ben", email: "ben@example.test", displayName: "Ben Builder" };

function toolApproval(over: Row = {}): Row {
  return {
    id: "a-tool-1",
    status: "pending",
    objectType: "mcp_tool",
    stageId: null,
    requestedAt: iso(-0.01),
    userId: "u-dana",
    approverUserId: AVERY.id,
    toolName: "write_file",
    serverId: "s-repo",
    serverName: "repo",
    requestedByName: "Dana Developer",
    approverName: AVERY.displayName,
    argumentsDigest: "a".repeat(64),
    argumentsPreview: { path: "README.md", content: "hello" },
    argumentsPreviewKind: "arguments_v1",
    approvalScope: "action",
    contextDigest: "b".repeat(64),
    expiresAt: iso(3),
    boundTarget: { host: "repo.example.test", allowPrivateRanges: false, admissionManifestDigest: null },
    quorum: 2,
    signatureMode: "passkey",
    approvalsCount: 1,
    myDecision: null,
    decisions: [
      { principalUserId: AVERY.id, principalName: AVERY.displayName, deciderUserId: AVERY.id, decision: "approved", method: "passkey", at: iso(-0.005) },
    ],
    ...over,
  };
}

async function mockApi(
  page: Page,
  opts: {
    me: typeof BEN;
    admin: boolean;
    approvals: Row[];
    decideRefusal?: { status: number; body: Row };
    ruleRefusal?: Row;
    approvalRules?: Row[];
  },
): Promise<Captured> {
  const cap: Captured = { signingOptions: [], decides: [], rules: [], rulePatches: [], stepUpOptions: [] };
  const me = { userId: opts.me.id, isAdmin: opts.admin, user: opts.me };
  await page.route("**/*", async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    if (req.resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    const method = req.method();
    if (p === "/auth/me") return json(route, { ...me, via: "session", mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false });
    if (p === "/v1/me") return json(route, me);
    if (p === "/v1/me/ai-literacy") return json(route, { required: false, current: true, documents: [], gateMode: "enforce", exempt: null, noticeDays: 14 });
    if (p === "/v1/approvals" && method === "GET") return json(route, { approvals: opts.approvals });
    const signing = /^\/v1\/approvals\/([^/]+)\/signing-options$/.exec(p);
    if (signing) {
      cap.signingOptions.push({ id: signing[1]!, body: req.postDataJSON() });
      return json(route, {
        challengeId: "33333333-3333-4333-8333-333333333333",
        options: { challenge: CHALLENGE, rpId: "127.0.0.1", allowCredentials: [{ id: "Y3JlZC0x", type: "public-key" }], userVerification: "required", timeout: 120000 },
        signedPayload: { v: "regulait.approval-sign.v1", approvalId: signing[1], decision: (req.postDataJSON() as Row).decision },
        expiresAt: iso(0.003),
      });
    }
    const decide = /^\/v1\/approvals\/([^/]+)\/decide$/.exec(p);
    if (decide) {
      const grant = req.headers()["x-regulait-step-up"] ?? null;
      const body = req.postDataJSON() as Row;
      cap.decides.push({ id: decide[1]!, body, grant });
      const row = opts.approvals.find((a) => a.id === decide[1]) ?? {};
      if (row.signatureMode === "step_up" && !grant) {
        return json(
          route,
          { error: "step_up_required", actionKind: "approval_decide", methods: ["passkey"], action: { kind: "approval_decide", body: { approvalId: decide[1], decision: body.decision } } },
          403,
        );
      }
      if (opts.decideRefusal) return json(route, opts.decideRefusal.body, opts.decideRefusal.status);
      return json(route, { ...row, status: "approved", approvals: 2, quorum: 2, decisions: [] });
    }
    if (p === "/v1/auth/step-up/options") {
      cap.stepUpOptions.push(req.postDataJSON());
      return json(route, {
        stepUpId: "22222222-2222-4222-8222-222222222222",
        actionKind: "approval_decide",
        methods: ["passkey"],
        expiresAt: iso(0.003),
        passkey: { options: { challenge: CHALLENGE, rpId: "127.0.0.1", allowCredentials: [{ id: "Y3JlZC0x", type: "public-key" }], userVerification: "required", timeout: 120000 } },
      });
    }
    if (p === "/v1/auth/step-up/verify") return json(route, { stepUpToken: "rgsu_decide", expiresAt: iso(0.001), method: "passkey", actionKind: "approval_decide" });
    if (p === "/v1/rules/approvals" && method === "POST") {
      cap.rules.push(req.postDataJSON() as Row);
      if (opts.ruleRefusal) return json(route, opts.ruleRefusal, 422);
      return json(route, { id: "r-new", ...(req.postDataJSON() as Row) }, 201);
    }
    const rulePatch = /^\/v1\/rules\/approvals\/([^/]+)$/.exec(p);
    if (rulePatch && method === "PATCH") {
      const body = req.postDataJSON() as Row;
      cap.rulePatches.push(body);
      if ((body.quorum as number) > 3) {
        return json(route, { error: "quorum_unsatisfiable", quorum: body.quorum, eligiblePrincipals: 3, detail: "this rule needs 4 different approvers but its pool has only 3" }, 422);
      }
      return json(route, { ...(opts.approvalRules?.[0] ?? {}), ...body, versionMinted: null });
    }
    if (p === "/v1/rules/approvals") return json(route, { rules: opts.approvalRules ?? [] });
    if (p === "/v1/rules/data-scopes" || p === "/v1/rules/rate-limits") return json(route, { rules: [] });
    if (p === "/v1/users" && method === "GET") {
      return json(route, { users: [AVERY, BEN, { id: "u-dana", email: "dana@example.test", displayName: "Dana Developer" }].map((u) => ({ ...u, isAdmin: false, disabledAt: null, createdAt: iso(-90) })) });
    }
    if (p === "/v1/roles") return json(route, { roles: [{ id: "role-approvers", name: "Release approvers", description: null }] });
    if (p === "/v1/teams") return json(route, { teams: [] });
    if (p === "/v1/servers") return json(route, { servers: [{ id: "s-repo", name: "repo", url: "https://repo.example.test/mcp" }] });
    if (p === "/v1/delegations") return json(route, { delegations: [] });
    if (p === "/v1/approvals/views") return json(route, { views: [] });
    if (p === "/v1/config-versions/canaries" || p.startsWith("/v1/config-versions")) return json(route, { canaries: [], versions: [] });
    return json(route, {});
  });
  return cap;
}

const THEMES = ["light", "dark"] as const;
async function expectAxeClean(page: Page, label: string, include: string) {
  for (const theme of THEMES) {
    await page.evaluate(async (next) => {
      document.documentElement.dataset.theme = next;
      localStorage.setItem("regulait.theme", next);
      await Promise.race([
        Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined))),
        new Promise((r) => setTimeout(r, 1000)),
      ]);
    }, theme);
    const results = await new AxeBuilder({ page })
      .include(include)
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze();
    const summary = results.violations.map((v) => `${v.id} (${v.impact}) — ${v.help}\n    ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join("\n    ")}`);
    expect(summary, `axe on "${label}" (${theme})`).toEqual([]);
  }
}

const webauthn = (page: Page) =>
  page.evaluate(() => (window as unknown as { __webauthn: { get: number; challenges: string[] } }).__webauthn);

test.describe("ADR-0186 A2+B: dual control and passkey-signed approvals", () => {
  test("the Inbox shows quorum progress and signs the exact call on Approve", async ({ page }) => {
    await fakeWebAuthn(page);
    const cap = await mockApi(page, { me: BEN, admin: false, approvals: [toolApproval()] });
    await page.goto("/ui/inbox");
    const quorum = page.getByTestId("quorum-a-tool-1");
    await expect(quorum).toContainText("1 of 2 approvals");
    await expect(quorum).toContainText("passkey-signed");
    await expect(quorum.getByRole("list", { name: "Decisions so far" })).toContainText("Avery Approver approved · passkey");
    await expectAxeClean(page, "inbox quorum view", '[data-testid="quorum-a-tool-1"]');

    // the approver reviews the exact action, then signs it from the review
    await page.getByRole("button", { name: "Review action write_file" }).click();
    await page.getByRole("dialog", { name: "Review MCP action" }).getByRole("button", { name: "Approve" }).click();
    await expect(page.getByText("Approved").first()).toBeVisible();
    expect(cap.signingOptions).toEqual([{ id: "a-tool-1", body: { decision: "approved" } }]);
    // the browser was handed the gateway's challenge untouched (the digest of the call)
    expect(await webauthn(page)).toEqual({ get: 1, challenges: [CHALLENGE] });
    expect(cap.decides).toHaveLength(1);
    expect(cap.decides[0]!.body).toMatchObject({
      decision: "approved",
      passkey: { challengeId: "33333333-3333-4333-8333-333333333333", response: { id: "Y3JlZC0x", type: "public-key" } },
    });
  });

  test("a refused signature reads as a sentence", async ({ page }) => {
    await fakeWebAuthn(page);
    await mockApi(page, {
      me: BEN,
      admin: false,
      approvals: [toolApproval()],
      decideRefusal: { status: 403, body: { error: "duplicate_approver", detail: "already decided" } },
    });
    await page.goto("/ui/inbox");
    await page.getByRole("button", { name: "Review action write_file" }).click();
    const review = page.getByRole("dialog", { name: "Review MCP action" });
    await review.getByRole("button", { name: "Approve" }).click();
    await expect(review.getByRole("alert")).toContainText("You've already decided this approval, or someone you're linked to by delegation has.");
  });

  test("the admin queue signs a tool call with no override, and shows when you are waiting on another approver", async ({ page }) => {
    await fakeWebAuthn(page);
    const cap = await mockApi(page, {
      me: { ...BEN, id: "u-admin", displayName: "Admin" },
      admin: true,
      approvals: [toolApproval(), toolApproval({ id: "a-tool-2", myDecision: "approved", toolName: "delete_branch" })],
    });
    await page.goto("/ui/admin/approvals");
    await expect(page.getByTestId("quorum-a-tool-1")).toContainText("1 of 2 approvals");
    await expect(page.getByText("override", { exact: true })).toHaveCount(0);
    await expect(page.getByText("You approved this; waiting for another approver.")).toBeVisible();
    await page.getByRole("button", { name: "Review action write_file" }).click();
    const review = page.getByRole("dialog", { name: "Review MCP action" });
    await expect(review.getByText("signs with your passkey")).toBeVisible();
    await review.getByRole("button", { name: "approve", exact: true }).click();
    await expect.poll(() => cap.decides.length).toBe(1);
    expect(cap.signingOptions).toEqual([{ id: "a-tool-1", body: { decision: "approved" } }]);
    expect(cap.decides[0]!.body.passkey).toMatchObject({ challengeId: "33333333-3333-4333-8333-333333333333" });
  });

  test("a step_up-mode approval is decided through the step-up dialog, then resent with the grant", async ({ page }) => {
    await fakeWebAuthn(page);
    const cap = await mockApi(page, { me: BEN, admin: false, approvals: [toolApproval({ signatureMode: "step_up" })] });
    await page.goto("/ui/inbox");
    await page.getByRole("button", { name: "Review action write_file" }).click();
    const review = page.getByRole("dialog", { name: "Review MCP action" });
    await expect(review.getByText("signs with your passkey")).toHaveCount(0);
    await review.getByRole("button", { name: "Approve" }).click();
    const dialog = page.getByRole("dialog", { name: "Confirm it's you" });
    await expect(dialog).toContainText("deciding this approval");
    await dialog.getByRole("button", { name: "Use a passkey" }).click();
    await expect.poll(() => cap.decides.length).toBe(2);
    expect(cap.signingOptions).toEqual([]);
    expect(cap.decides.map((d) => d.grant)).toEqual([null, "rgsu_decide"]);
    expect(cap.stepUpOptions).toEqual([{ action: { kind: "approval_decide", body: { approvalId: "a-tool-1", decision: "approved" } } }]);
  });

  test("the approval-rule editor posts quorum and approver role, and shows quorum_unsatisfiable verbatim", async ({ page }) => {
    const detail =
      "this rule needs 3 different approvers but its pool (the named approver and the active members of its approver role, never the caller, a delegator and their delegate counting once) has only 2: add people to the approver role or lower the quorum";
    const cap = await mockApi(page, {
      me: { ...BEN, id: "u-admin", displayName: "Admin" },
      admin: true,
      approvals: [],
      ruleRefusal: { error: "quorum_unsatisfiable", quorum: 3, eligiblePrincipals: 2, detail },
    });
    await page.goto("/ui/admin/rules");
    const form = page.locator("form").filter({ has: page.getByRole("button", { name: "Add approval rule" }) });
    await form.getByLabel("User").selectOption("u-dana");
    await form.getByLabel("Server", { exact: true }).selectOption("s-repo");
    await form.getByLabel("Approver", { exact: true }).selectOption(AVERY.id);
    await form.getByLabel("Approvers needed").selectOption("3");
    await form.getByLabel("Approver role").selectOption("role-approvers");
    await form.getByRole("button", { name: "Add approval rule" }).click();
    await expect(form.getByRole("alert")).toContainText("has only 2");
    expect(cap.rules).toHaveLength(1);
    expect(cap.rules[0]).toMatchObject({ scope: "user", userId: "u-dana", approverUserId: AVERY.id, quorum: 3, approverRoleId: "role-approvers" });
  });

  test("an approval rule's quorum and approver role are edited in place through PATCH; an unsatisfiable edit is refused verbatim", async ({ page }) => {
    const ruleRow = {
      id: "r-1",
      scope: "user",
      serverScope: "server",
      userId: "u-dana",
      serverId: "s-repo",
      roleId: null,
      teamId: null,
      toolName: "write_file",
      writeOnly: false,
      approverUserId: AVERY.id,
      quorum: 1,
      approverRoleId: null,
      deployMode: null,
      createdAt: iso(-2),
    };
    const cap = await mockApi(page, { me: { ...BEN, id: "u-admin", displayName: "Admin" }, admin: true, approvals: [], approvalRules: [ruleRow] });
    await page.goto("/ui/admin/rules");
    await page.getByLabel("Approvers needed for rule r-1").selectOption("3");
    await page.getByLabel("Approver role for rule r-1").selectOption("role-approvers");
    const row = page.getByRole("row").filter({ has: page.getByLabel("Approvers needed for rule r-1") });
    await row.getByRole("button", { name: "Save" }).click();
    await expect.poll(() => cap.rulePatches.length).toBe(1);
    expect(cap.rulePatches[0]).toEqual({ quorum: 3, approverRoleId: "role-approvers" });
    await page.getByLabel("Approvers needed for rule r-1").selectOption("4");
    await row.getByRole("button", { name: "Save" }).click();
    await expect(row.getByRole("alert")).toContainText("has only 3");
    expect(cap.rulePatches[1]).toEqual({ quorum: 4, approverRoleId: "role-approvers" });
  });
});
