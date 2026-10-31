/**
 * ADR-0221 — the supplier portal, from the browser's side against a mocked gateway (the *.mock.spec.ts harness):
 *
 *  - the SUPPLIER page (/ui/supplier#<token>): the token leaves the address at once and is spent on the supplier API
 *    with the CSRF header; the page never asks the platform who is signed in and has no app chrome; an answer with a
 *    file is sent as base64 after the browser-side checks; a refused link shows the server's own sentence;
 *  - the ADMIN side: a vendor's "Supplier access" panel invites a supplier through the step-up prompt and shows the
 *    link once; the "Supplier questionnaires" page turns the portal on through the step-up prompt;
 *  - files: with files not accepted the supplier sees no file input and is told where documents go; a file nobody
 *    scanned downloads only after the reviewer confirms, with `?acknowledgeUnscanned=1`;
 *  - deciding an answer goes out with the plain client (no step-up), and accepting an answer to an unlinked question
 *    says nothing is added to the vendor's checklist;
 *  - axe (WCAG 2.x A/AA) in light and dark on the supplier page and the panel.
 */
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";
import { confirmStepUp, requireStepUpOn } from "./step-up-harness";

const TOKEN = `rglsi_${"A".repeat(40)}x_9`;
const VENDOR = "11111111-1111-4111-8111-111111111111";
const ACCESS = "22222222-2222-4222-8222-222222222222";
const SUB = "33333333-3333-4333-8333-333333333333";
const THEMES = ["light", "dark"] as const;

const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

async function expectAxeClean(page: Page, label: string) {
  for (const theme of THEMES) {
    await page.evaluate(async (next) => {
      document.documentElement.dataset.theme = next;
      try {
        localStorage.setItem("regulait.theme", next);
      } catch {
        // storage may be blocked; the attribute is what axe reads
      }
      await Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined)));
    }, theme);
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
    const summary = results.violations.map((v) => `${v.id} (${v.impact}) — ${v.help}\n    ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join("\n    ")}`);
    expect(summary, `axe on "${label}" (${theme})`).toEqual([]);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// the supplier's side
// ---------------------------------------------------------------------------------------------------------------

interface SupplierState {
  sessionStatus: number;
  sessionPosts: Array<{ body: unknown; csrf: string | null }>;
  submissions: Array<{ body: unknown; csrf: string | null }>;
  ended: number;
  platformCalls: string[];
  mine: unknown[];
  filesAccepted: boolean;
  /** when set, the next submission is refused with this answer */
  refuseSubmission: { status: number; body: unknown } | null;
}

const assessment = (mine: unknown[], filesAccepted = true) => ({
  vendorName: "Acme Transcribe",
  framework: "eu-ai-act",
  open: true,
  accessExpiresAt: "2026-11-13T09:00:00Z",
  sessionExpiresAt: "2026-10-30T17:00:00Z",
  controls: [
    { controlRef: "ART-10", title: "Data governance", description: "Training data is relevant and representative." },
    { controlRef: "ART-12", title: "Record-keeping", description: null },
  ],
  questionnaire: {
    name: "Security basics",
    version: 2,
    description: "",
    questions: [{ id: "q1", prompt: "Do you encrypt data at rest?", help: "", required: true, allowFile: false, controlRef: null }],
  },
  submissions: mine,
  limits: {
    fileMaxBytes: 2 * 1024 * 1024,
    statementMax: 4000,
    fileTypes: ["application/pdf", "image/png", "image/jpeg", "text/plain", "text/csv"],
    filesAccepted,
    fileBytesBudget: 50 * 1024 * 1024,
  },
});

async function mockSupplier(page: Page, patch: Partial<SupplierState> = {}): Promise<SupplierState> {
  const state: SupplierState = {
    sessionStatus: 200,
    sessionPosts: [],
    submissions: [],
    ended: 0,
    platformCalls: [],
    mine: [],
    filesAccepted: true,
    refuseSubmission: null,
    ...patch,
  };
  let signedIn = false;
  await page.route("**/*", async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    if (p.startsWith("/v1") || p.startsWith("/auth")) {
      state.platformCalls.push(`${req.method()} ${p}`);
      return json(route, { error: "unauthenticated" }, 401);
    }
    if (req.resourceType() === "document" || !p.startsWith("/supplier/")) return route.continue();
    const csrf = req.headers()["x-regulait-csrf"] ?? null;
    if (p === "/supplier/v1/session" && req.method() === "POST") {
      state.sessionPosts.push({ body: req.postDataJSON(), csrf });
      if (state.sessionStatus !== 200) {
        return json(route, { error: "link_not_valid", detail: "This link cannot be used. It may have expired or already been used. Ask your contact for a new link." }, state.sessionStatus);
      }
      signedIn = true;
      return json(route, { vendorName: "Acme Transcribe", framework: "eu-ai-act", sessionExpiresAt: "2026-10-30T17:00:00Z" });
    }
    if (p === "/supplier/v1/assessment" && req.method() === "GET") {
      if (!signedIn) return json(route, { error: "session_not_valid", detail: "Your session has ended. Open the most recent link you were sent, or ask your contact for a new one." }, 401);
      return json(route, assessment(state.mine, state.filesAccepted));
    }
    if (p === "/supplier/v1/submissions" && req.method() === "POST") {
      const body = req.postDataJSON() as { target: { controlRef?: string }; statement: string; file?: { name: string } };
      state.submissions.push({ body, csrf });
      if (state.refuseSubmission) return json(route, state.refuseSubmission.body, state.refuseSubmission.status);
      const row = {
        id: SUB,
        kind: "control",
        controlRef: body.target.controlRef ?? null,
        questionId: null,
        statement: body.statement,
        file: body.file ? { name: body.file.name, contentType: "text/plain", size: 5, scanStatus: "not_scanned" } : null,
        status: "submitted",
        decisionReason: null,
        decidedAt: null,
        createdAt: "2026-10-30T10:00:00Z",
      };
      state.mine = [row];
      return json(route, row, 201);
    }
    if (p === "/supplier/v1/session/end" && req.method() === "POST") {
      state.ended += 1;
      signedIn = false;
      return json(route, { ended: true });
    }
    return json(route, { error: "not_found" }, 404);
  });
  return state;
}

test.describe("ADR-0221: the supplier page", () => {
  test("spends the link, drops it from the address, answers with a file and signs out, with no platform call", async ({ page }) => {
    const state = await mockSupplier(page);
    await page.goto(`/ui/supplier#${TOKEN}`);
    await expect(page.getByRole("heading", { name: "Supplier assessment" })).toBeVisible();
    await expect(page.getByText("Acme Transcribe").first()).toBeVisible();
    // the token is gone from the address bar
    expect(new URL(page.url()).hash).toBe("");
    expect(await page.evaluate(() => window.location.href)).not.toContain(TOKEN);
    expect(state.sessionPosts).toEqual([{ body: { token: TOKEN }, csrf: "1" }]);
    // no app chrome, and the platform was never asked who is signed in
    await expect(page.getByRole("navigation")).toHaveCount(0);
    expect(state.platformCalls).toEqual([]);
    // a question that takes no file has no file input
    const q1 = page.getByRole("region", { name: /Do you encrypt data at rest/ });
    await expect(q1.getByLabel("Supporting file (optional)")).toHaveCount(0);
    await expectAxeClean(page, "supplier assessment");

    const art10 = page.getByRole("region", { name: /ART-10/ });
    // a file of another type is refused before anything is sent
    await art10.getByLabel("Supporting file (optional)").setInputFiles({ name: "evil.exe", mimeType: "application/octet-stream", buffer: Buffer.from("MZ") });
    await expect(art10.getByRole("alert")).toContainText("Choose a PDF, PNG, JPEG, plain text or CSV file");
    await art10.getByLabel("Your answer for ART-10").fill("Training data is reviewed every quarter.");
    await art10.getByRole("button", { name: "Send answer" }).click();
    expect(state.submissions).toHaveLength(0);

    await art10.getByLabel("Supporting file (optional)").setInputFiles({ name: "policy.txt", mimeType: "text/plain", buffer: Buffer.from("hello") });
    await art10.getByRole("button", { name: "Send answer" }).click();
    await expect.poll(() => state.submissions.length).toBe(1);
    expect(state.submissions[0]).toEqual({
      body: { target: { kind: "control", controlRef: "ART-10" }, statement: "Training data is reviewed every quarter.", file: { name: "policy.txt", base64: Buffer.from("hello").toString("base64") } },
      csrf: "1",
    });
    await expect(art10.getByRole("status").filter({ hasText: "Answer sent" })).toBeVisible();
    await expect(art10.getByText("Waiting for review")).toBeVisible();

    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page.getByText("You have signed out")).toBeVisible();
    expect(state.ended).toBe(1);
    expect(state.platformCalls).toEqual([]);
  });

  test("with files not accepted there is no file input, and the page says where documents go", async ({ page }) => {
    await mockSupplier(page, { filesAccepted: false });
    await page.goto(`/ui/supplier#${TOKEN}`);
    await expect(page.getByRole("heading", { name: "Supplier assessment" })).toBeVisible();
    await expect(page.getByTestId("supplier-files-not-accepted")).toHaveText(
      "Files cannot be attached here. Write your answer, and send any supporting documents to your contact.",
    );
    await expect(page.getByLabel("Supporting file (optional)")).toHaveCount(0);
    await expect(page.locator('input[type="file"]')).toHaveCount(0);
    await expectAxeClean(page, "supplier assessment, files not accepted");
  });

  test("a refused answer shows the server's own sentence beside the form", async ({ page }) => {
    const detail = "This access can hold at most 50 MB of files. Submit your answer without a file, or ask your contact for help.";
    const state = await mockSupplier(page, { refuseSubmission: { status: 413, body: { error: "file_budget_exceeded", detail } } });
    await page.goto(`/ui/supplier#${TOKEN}`);
    const art10 = page.getByRole("region", { name: /ART-10/ });
    await art10.getByLabel("Your answer for ART-10").fill("See the attached policy.");
    // the counter is described, not announced on every keystroke
    await expect(art10.locator("[aria-live]")).toHaveCount(0);
    await art10.getByRole("button", { name: "Send answer" }).click();
    await expect.poll(() => state.submissions.length).toBe(1);
    await expect(art10.getByRole("alert")).toHaveText(detail);
  });

  test("an answer a newer one replaced reads as replaced", async ({ page }) => {
    const old = {
      id: SUB, kind: "control", controlRef: "ART-10", questionId: null, statement: "First try.", file: null,
      status: "withdrawn", decisionReason: "Replaced by a newer answer from the supplier", decidedAt: "2026-10-30T10:05:00Z", createdAt: "2026-10-30T10:00:00Z",
    };
    await mockSupplier(page, { mine: [old] });
    await page.goto(`/ui/supplier#${TOKEN}`);
    await expect(page.getByRole("region", { name: /ART-10/ }).getByText("Replaced by a newer answer")).toBeVisible();
  });

  test("a refused link shows the server's sentence and is still dropped from the address", async ({ page }) => {
    const state = await mockSupplier(page, { sessionStatus: 401 });
    await page.goto(`/ui/supplier#${TOKEN}`);
    await expect(page.getByRole("alert")).toContainText("This link cannot be used. It may have expired or already been used.");
    expect(new URL(page.url()).hash).toBe("");
    expect(state.platformCalls).toEqual([]);
    await expectAxeClean(page, "supplier link refused");
  });

  test("without a link and without a session, the page says to open the link", async ({ page }) => {
    const state = await mockSupplier(page);
    await page.goto("/ui/supplier");
    await expect(page.getByRole("alert")).toContainText("Your session has ended.");
    expect(state.sessionPosts).toEqual([]);
    expect(state.platformCalls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// the admin's side
// ---------------------------------------------------------------------------------------------------------------

interface AdminState {
  enabled: boolean;
  acceptUnscannedFiles: boolean;
  scannerConfigured: boolean;
  grantPosts: unknown[];
  settingsPuts: unknown[];
  decisions: Array<{ id: string; body: unknown; stepUp: string | null }>;
  downloads: string[];
}

const QSUB = "55555555-5555-4555-8555-555555555555";
const RSUB = "66666666-6666-4666-8666-666666666666";
const WSUB = "77777777-7777-4777-8777-777777777777";
const CSUB = "88888888-8888-4888-8888-888888888888";
const sub = (patch: Record<string, unknown>) => ({
  id: SUB, kind: "control", controlRef: "ART-10", questionnaireId: null, questionId: null, statement: "Training data is reviewed every quarter.",
  file: null, status: "submitted", decisionReason: null, decidedAt: null, createdAt: "2026-10-30T10:00:00Z",
  accessId: ACCESS, accessState: "active", supplierEmail: "sam@supplier.example", framework: "eu-ai-act",
  ...patch,
});
const REVIEW_LIST = [
  sub({ file: { name: "policy.pdf", contentType: "application/pdf", size: 20480, sha256: "ab".repeat(32), scanStatus: "not_scanned" } }),
  // an answer to a question with no linked control
  sub({ id: QSUB, kind: "question", controlRef: null, questionnaireId: "44444444-4444-4444-8444-444444444444", questionId: "q1", statement: "Yes, AES-256.", supplierEmail: "pat@supplier.example" }),
  // from a grant since revoked: no Accept
  sub({ id: RSUB, statement: "Reviewed yearly.", supplierEmail: "lee@supplier.example", accessState: "revoked" }),
  // replaced by a newer answer: no actions, no file
  sub({ id: WSUB, statement: "Draft.", supplierEmail: "kim@supplier.example", status: "withdrawn", decisionReason: "Replaced by a newer answer from the supplier" }),
  // a clean file downloads directly
  sub({ id: CSUB, statement: "Scanned evidence.", supplierEmail: "ash@supplier.example", status: "accepted", file: { name: "clean.pdf", contentType: "application/pdf", size: 2048, sha256: "cd".repeat(32), scanStatus: "clean" } }),
];

async function mockAdmin(page: Page, patch: Partial<AdminState> = {}): Promise<AdminState> {
  const state: AdminState = {
    enabled: true,
    acceptUnscannedFiles: false,
    scannerConfigured: false,
    grantPosts: [],
    settingsPuts: [],
    decisions: [],
    downloads: [],
    ...patch,
  };
  const me = { id: "riley", email: "riley@example.test", displayName: "Riley Admin" };
  const vendor = {
    id: VENDOR, name: "Acme Transcribe", description: "Transcribes calls.", category: "ai_feature_vendor", ownerUserId: "riley", ownerName: "Riley Admin",
    linkedCustomProviderIds: [], linkedAgentProviders: [], packAttestations: [], status: "under_assessment", workflowInstanceId: null,
    decidedAt: null, retiredReason: null, createdAt: "2026-10-01T09:00:00Z",
  };
  await page.route("**/*", async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    if (req.resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    const m = req.method();
    if (p === "/auth/me") return json(route, { userId: me.id, isAdmin: true, via: "session", user: me, mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false });
    if (p === "/v1/me") return json(route, { userId: me.id, isAdmin: true, user: me });
    if (p === "/v1/vendors" && m === "GET") return json(route, { vendors: [vendor], disclaimer: "Vendor-attested." });
    if (p === `/v1/vendors/${VENDOR}` && m === "GET") {
      return json(route, { vendor, instance: null, questionnaire: null, questionnaireTemplate: null, attestations: [], packChecklist: null, disclaimer: "Vendor-attested, not verified." });
    }
    if (p === "/v1/compliance/packs") return json(route, { packs: [{ framework: "eu-ai-act", status: "active" }] });
    const settingsView = () => ({ enabled: state.enabled, acceptUnscannedFiles: state.acceptUnscannedFiles, scannerConfigured: state.scannerConfigured });
    if (p === "/v1/supplier-portal/settings" && m === "GET") return json(route, settingsView());
    if (p === "/v1/supplier-portal/settings" && m === "PUT") {
      const body = req.postDataJSON() as { enabled?: boolean; acceptUnscannedFiles?: boolean };
      state.settingsPuts.push(body);
      if (body.enabled !== undefined) state.enabled = body.enabled;
      if (body.acceptUnscannedFiles !== undefined) state.acceptUnscannedFiles = body.acceptUnscannedFiles;
      return json(route, { ...settingsView(), changed: true });
    }
    const decision = /^\/v1\/vendors\/[^/]+\/supplier-submissions\/([^/]+)\/decision$/.exec(p);
    if (decision && m === "POST") {
      state.decisions.push({ id: decision[1]!, body: req.postDataJSON(), stepUp: req.headers()["x-regulait-step-up"] ?? null });
      return json(route, { id: decision[1], status: "accepted", attestation: null, disclaimer: "Vendor-attested." });
    }
    const file = /^\/v1\/vendors\/[^/]+\/supplier-submissions\/([^/]+)\/file$/.exec(p);
    if (file && m === "GET") {
      const u = new URL(req.url());
      state.downloads.push(`${file[1]}${u.search}`);
      if (file[1] === SUB && u.searchParams.get("acknowledgeUnscanned") !== "1") {
        return json(route, { error: "unscanned_file_acknowledgement_required", detail: "This file has not been scanned for malware." }, 409);
      }
      return route.fulfill({ status: 200, contentType: "application/pdf", body: "%PDF-1.4" });
    }
    if (p === "/v1/supplier-questionnaires" && m === "GET") {
      return json(route, { questionnaires: [{ id: "44444444-4444-4444-8444-444444444444", name: "Security basics", version: 1, description: "", questions: [{ id: "q1", prompt: "Do you encrypt data at rest?", help: "", required: true, allowFile: false, controlRef: null }], createdAt: "2026-10-01T09:00:00Z", retiredAt: null }] });
    }
    if (p === `/v1/vendors/${VENDOR}/supplier-access` && m === "GET") {
      return json(route, {
        enabled: state.enabled,
        access: state.grantPosts.length
          ? [{ id: ACCESS, email: "sam@supplier.example", framework: "eu-ai-act", questionnaire: null, expiresAt: "2026-11-13T09:00:00Z", revokedAt: null, createdAt: "2026-10-30T09:00:00Z", state: "active", liveSessions: 0, links: [{ id: "l1", expiresAt: "2026-10-31T09:00:00Z", usedAt: null, revokedAt: null, state: "active" }] }]
          : [],
      });
    }
    if (p === `/v1/vendors/${VENDOR}/supplier-access` && m === "POST") {
      state.grantPosts.push(req.postDataJSON());
      return json(route, {
        access: { id: ACCESS, email: "sam@supplier.example", framework: "eu-ai-act", expiresAt: "2026-11-13T09:00:00Z" },
        link: { url: `https://regulait.example/ui/supplier#${TOKEN}`, expiresAt: "2026-10-31T09:00:00Z" },
        notice: "Copy this link now and send it to the supplier yourself. It is shown once, works once and is not stored.",
      }, 201);
    }
    if (p === `/v1/vendors/${VENDOR}/supplier-submissions` && m === "GET") {
      return json(route, {
        submissions: REVIEW_LIST,
        disclaimer: "An accepted answer is the vendor's claim, not verified by this platform.",
      });
    }
    if (m === "GET") return json(route, {});
    return json(route, { error: "not_found" }, 404);
  });
  return state;
}

test.describe("ADR-0221: supplier access for admins", () => {
  test("a vendor's panel invites a supplier through the step-up prompt and shows the link once", async ({ page }) => {
    const state = await mockAdmin(page);
    const su = await requireStepUpOn(page, { method: "POST", path: `/v1/vendors/${VENDOR}/supplier-access`, kind: "identity_manage" });
    await page.goto(`/ui/admin/vendors?vendorId=${VENDOR}`);
    const panel = page.locator("section", { has: page.getByText("Supplier access", { exact: true }) }).last();
    await expect(panel.getByText("No supplier has access")).toBeVisible();
    // the requirements sit beside the decision
    await expect(panel.getByTestId("supplier-invite-terms")).toContainText("works once, is shown to you once, and expires");
    await expect(panel.getByTestId("supplier-invite-terms")).toContainText("limited to this vendor's assessment");
    await expectAxeClean(page, "vendor supplier access");

    await panel.getByLabel("Supplier contact's email").fill("sam@supplier.example");
    await panel.getByLabel("Framework").selectOption("eu-ai-act");
    await panel.getByRole("button", { name: "Create access and link" }).click();
    await confirmStepUp(page);
    await su.expectResentOnce();
    expect(state.grantPosts).toEqual([{ email: "sam@supplier.example", framework: "eu-ai-act", questionnaireId: null, accessDays: 14, inviteHours: 24 }]);

    const dialog = page.getByRole("dialog", { name: "Copy the sign-in link" });
    await expect(dialog.getByLabel("Sign-in link")).toHaveValue(`https://regulait.example/ui/supplier#${TOKEN}`);
    await expect(dialog).toContainText("It is shown once, works once and is not stored.");
    await expectAxeClean(page, "supplier link shown once");
    await dialog.getByRole("button", { name: "Done" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    // the link is gone from the page and from browser storage
    expect(await page.content()).not.toContain(TOKEN);
    expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain(TOKEN);
    await expect(panel.getByRole("button", { name: "New link for sam@supplier.example" })).toBeVisible();
    await expect(panel.getByRole("button", { name: "Revoke access for sam@supplier.example" })).toBeVisible();
  });

  test("with the portal off, the panel says where to turn it on and the form is disabled", async ({ page }) => {
    await mockAdmin(page, { enabled: false });
    await page.goto(`/ui/admin/vendors?vendorId=${VENDOR}`);
    const off = page.getByTestId("supplier-portal-off");
    await expect(off).toContainText("The supplier portal is off");
    await expect(off.getByRole("link", { name: "Supplier questionnaires" })).toHaveAttribute("href", "/ui/admin/vendors/questionnaires");
    await expect(page.getByRole("button", { name: "Create access and link" })).toBeDisabled();
    // what a supplier sent is still reviewable: the file says plainly that it was not scanned
    await expect(page.getByText("Not scanned")).toBeVisible();
    await expect(page.getByText("Access revoked", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Accept answer from lee@supplier.example" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Reject answer from lee@supplier.example" })).toBeVisible();
    await expect(page.getByText("Withdrawn", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: /kim@supplier\.example/ })).toHaveCount(0);
    // a question's internal id is never shown
    await expect(page.getByText("Do you encrypt data at rest?")).toBeVisible();
    await expect(page.getByText("An accepted answer is the vendor's claim, not verified by this platform.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Accept answer from sam@supplier.example" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Reject answer from sam@supplier.example" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Download file policy.pdf" })).toBeVisible();
    await expectAxeClean(page, "vendor supplier access, portal off");
  });

  test("Supplier questionnaires turns the portal on through the step-up prompt", async ({ page }) => {
    const state = await mockAdmin(page, { enabled: false });
    const su = await requireStepUpOn(page, { method: "PUT", path: "/v1/supplier-portal/settings", kind: "settings_relax", when: (b) => (b as { enabled?: boolean }).enabled === true });
    await page.goto("/ui/admin/vendors/questionnaires");
    await expect(page.getByRole("heading", { name: "Supplier questionnaires" })).toBeVisible();
    // the portal and the unscanned-files setting both start strict
    await expect(page.getByText("Strict default")).toHaveCount(2);
    await expect(page.getByRole("heading", { name: "Security basics" })).toBeVisible();
    await expectAxeClean(page, "supplier questionnaires");
    await page.getByRole("button", { name: "Turn the portal on" }).click();
    await confirmStepUp(page);
    await su.expectResentOnce();
    expect(state.settingsPuts).toEqual([{ enabled: true }]);
    await expect(page.getByText("Relaxed", { exact: true })).toBeVisible();
  });

  test("accepting unscanned files is a second, step-up relaxation, and not offered with a scanner", async ({ page }) => {
    const state = await mockAdmin(page);
    const su = await requireStepUpOn(page, {
      method: "PUT",
      path: "/v1/supplier-portal/settings",
      kind: "settings_relax",
      when: (b) => (b as { acceptUnscannedFiles?: boolean }).acceptUnscannedFiles === true,
    });
    await page.goto("/ui/admin/vendors/questionnaires");
    const files = page.getByTestId("supplier-unscanned-setting");
    await expect(files).toContainText("Off: suppliers cannot attach files until a malware scanner is configured.");
    await files.getByRole("button", { name: "Accept unscanned files" }).click();
    await confirmStepUp(page);
    await su.expectResentOnce();
    expect(state.settingsPuts).toEqual([{ acceptUnscannedFiles: true }]);
    await expect(files).toContainText("On: suppliers can attach files that nobody has scanned. Each download asks the reviewer to confirm.");
    await expect(files.getByText("Relaxed", { exact: true })).toBeVisible();
    await expectAxeClean(page, "supplier questionnaires, unscanned files accepted");
  });

  test("with a scanner configured there is no unscanned-files switch", async ({ page }) => {
    await mockAdmin(page, { scannerConfigured: true });
    await page.goto("/ui/admin/vendors/questionnaires");
    const files = page.getByTestId("supplier-unscanned-setting");
    await expect(files).toContainText("A scanner checks every file.");
    await expect(files.getByRole("button")).toHaveCount(0);
  });

  test("an unscanned file downloads only after the reviewer confirms; a clean one downloads at once", async ({ page }) => {
    const state = await mockAdmin(page);
    await page.goto(`/ui/admin/vendors?vendorId=${VENDOR}`);
    await page.getByRole("button", { name: "Download file policy.pdf" }).click();
    const dialog = page.getByRole("dialog", { name: "Download a file that has not been scanned?" });
    await expect(dialog).toContainText("has not been scanned for malware. Open it only if you trust the supplier");
    await expect(dialog).toContainText("The download is recorded in the audit trail.");
    expect(state.downloads).toEqual([]);
    await expectAxeClean(page, "unscanned download confirmation");
    const download = page.waitForEvent("download");
    await dialog.getByRole("button", { name: "Download anyway" }).click();
    expect((await download).suggestedFilename()).toBe("policy.pdf");
    expect(state.downloads).toEqual([`${SUB}?acknowledgeUnscanned=1`]);

    const clean = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download file clean.pdf" }).click();
    await clean;
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(state.downloads).toEqual([`${SUB}?acknowledgeUnscanned=1`, CSUB]);
  });

  test("accepting an answer to an unlinked question says nothing is added, and asks for no step-up", async ({ page }) => {
    const state = await mockAdmin(page);
    await page.goto(`/ui/admin/vendors?vendorId=${VENDOR}`);
    await page.getByRole("button", { name: "Accept answer from pat@supplier.example" }).click();
    const dialog = page.getByRole("dialog", { name: "Accept this answer?" });
    await expect(dialog).toContainText("This question is not linked to a control, so nothing is added to the vendor's checklist.");
    await dialog.getByRole("button", { name: "Accept answer" }).click();
    await expect.poll(() => state.decisions.length).toBe(1);
    expect(state.decisions[0]).toEqual({ id: QSUB, body: { decision: "accept" }, stepUp: null });
    await expect(page.getByText("Accepted. This question is not linked to a control, so nothing is added to the vendor's checklist.").first()).toBeVisible();
    await expect(page.getByRole("dialog", { name: "Confirm it's you" })).toHaveCount(0);

    // a control answer keeps the claim wording
    await page.getByRole("button", { name: "Accept answer from sam@supplier.example" }).click();
    await expect(page.getByRole("dialog", { name: "Accept this answer?" })).toContainText("as a claim the vendor made, attributed to you");
  });
});
