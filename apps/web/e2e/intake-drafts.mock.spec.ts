/**
 * ADR-0171 (AER-050..054) — the registration wizard keeps a first-time
 * proposer's work and tells them the truth about it:
 *
 *   050 the work is a server-side draft: it survives a reload and is offered
 *       back; Cancel and the navigation ask first; Cancel and Back wait while a
 *       submission is in flight; a create whose response is lost is retried
 *       (even after a reload) with the same Idempotency-Key, so exactly one use
 *       case with one risk set exists; nothing goes to browser storage;
 *   051 returning to Classify unchanged keeps every edit and decision; changed
 *       answers name the affected sections and regenerate only on consent;
 *   052 an edited framework explanation is sent as `frameworkRationales`;
 *   053 every yes/no question explains itself, "Not sure" counts as yes and is
 *       recorded, and an incomplete step names what is missing and takes focus
 *       to the first gap;
 *   054 Review shows the proposal itself and "Edit this section" comes back.
 *
 * The gateway is an in-test mock that keeps the draft, the use cases, the
 * questionnaire versions and the risks, so each test asserts the state the
 * page's requests left behind, not only the requests.
 */
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";
import { generateTotpSecret, verifyTotp } from "../../gateway/dist/totp.js";
import { passTotp, recordTotpSecret } from "./totp-sign-in";

/** ADR-0181: the mocked gateway's admins have TOTP enrolled under this
 * synthetic secret; codes are checked with the gateway's own TOTP code */
const MOCK_TOTP_SECRET = generateTotpSecret();
let mockTotpLastStep: number | null = null;

const AGENT = "22222222-2222-4222-8222-222222222222";
const VENDOR = "99999999-1111-4111-8111-999999999999";
const USE_CASE = "11111111-1111-4111-8111-111111111111";
const BIAS = "Disparate credit recommendation outcomes";
const INJECTION = "Prompt injection through customer-supplied text";
const EMOTION = "Emotion inference used against customers";
const HEADINGS = ["Purpose and business context", "Affected people", "Data", "Human oversight", "Operations", "Monitoring", "Security", "Accountability"];

type Json = Record<string, any>;

/** the assistant's answer: rules-based, so it follows the answers — emotion recognition adds a risk, drops a framework and redrafts section 2 */
function assistFor(body: Json) {
  const emotion = Boolean(body.euAiAct?.emotionRecognition);
  return {
    tier: { value: "high", reasons: [{ ruleId: "annex-iii", tier: "high", ref: "Annex III", reason: "Essential service" }], rulesetVersion: 1, source: "rules", disclaimer: "Screening, not legal advice." },
    frameworks: [
      { framework: "eu-ai-act", title: "EU AI Act", why: "EU nexus and high-risk purpose", source: "rules" },
      ...(emotion ? [] : [{ framework: "nist-ai-rmf", title: "NIST AI RMF", why: "agentic financial workflow", source: "rules" }]),
    ],
    risks: [
      { scenarioKey: "credit-bias", title: BIAS, description: "Profiling data may produce materially different recommendations across protected groups.", category: "bias_fairness", dimension: "bias", likelihood: "medium", impact: "high", suggestedControls: ["eu-ai-act:art-14-human-oversight"], why: "profiles natural persons", source: "rules" },
      { scenarioKey: "prompt-injection", title: INJECTION, description: "Free-text input may steer the assistant away from its instructions.", category: "prompt_injection", dimension: "security", likelihood: "medium", impact: "medium", suggestedControls: [], why: "the system interacts directly with people", source: "mock" },
      ...(emotion ? [{ scenarioKey: "emotion-misuse", title: EMOTION, description: "Inferred emotions may be used to pressure customers.", category: "manipulation", dimension: "safety", likelihood: "low", impact: "high", suggestedControls: [], why: "it infers emotions", source: "rules" }] : []),
    ],
    euAiActBlock: "```eu-ai-act-answers\n" + JSON.stringify(body.euAiAct, null, 2) + "\n```",
    questionnaire: HEADINGS.map((heading, i) => ({
      id: `q${i + 1}`,
      heading: `${i + 1}. ${heading}`,
      text: i === 1 && emotion ? "Revised draft 2: customers whose emotions are inferred." : `Draft answer ${i + 1}`,
      source: "rules",
    })),
    blocking: null,
    narrative: { status: "drafted", source: "mock" },
    disclaimer: "Suggestions only.",
  };
}

interface Gateway {
  drafts: Map<string, { scope: string; state: unknown; updatedAt: string }>;
  draftUnavailable: boolean;
  /** answer every draft save with this status instead (e.g. 413 draft_too_large) */
  draftPutStatus: number | null;
  draftPuts: number;
  assistCalls: Json[];
  creates: Array<{ key: string | undefined; body: Json; replay: boolean }>;
  useCases: Array<{ id: string; key: string | undefined; body: Json }>;
  artifacts: string[];
  risks: Array<Json & { id: string; controls: string[] }>;
  /** drop the next create's response AFTER the use case is stored (a lost response) */
  dropNextCreateResponse: boolean;
  /** hold the create until released */
  holdCreate: Promise<void> | null;
  // ---- ADR-0179 -----------------------------------------------------------
  /** who the session belongs to; null = the session has ended (every call answers 401) */
  user: "ada" | "bob" | null;
  /** who the next sign-in is */
  signInAs: "ada" | "bob";
  /** Bob's drafts (Ada's are `drafts`) */
  bobDrafts: Map<string, { scope: string; state: unknown; updatedAt: string }>;
  /** refuse (500) a draft save whose state matches */
  draftPutFails: ((state: Json) => boolean) | null;
  /** the attempt key Ada's saved draft held when each create arrived */
  draftKeyAtCreate: Array<string | undefined>;
  /** every risk POST: its key, and whether it was answered as a replay */
  riskPosts: Array<{ key: string | undefined; replay: boolean }>;
  /** every questionnaire POST: its key, and whether it was answered as a replay */
  artifactPosts: Array<{ key: string | undefined; replay: boolean }>;
  /** drop the next risk / questionnaire response AFTER it is stored (a lost response) */
  dropNextRiskResponse: boolean;
  dropNextArtifactResponse: boolean;
  // ---- ADR-0179 security review, item 6 -----------------------------------
  /** hold a draft save whose state matches until released (a slow save still in flight) */
  holdDraftPut: { when: (state: Json) => boolean; until: Promise<void> } | null;
  /** draft writes refused because they named someone other than the signed-in person */
  draftOwnerRefusals: number;
}

const json = (route: Route, body: unknown, status = 200, headers: Record<string, string> = {}) =>
  route.fulfill({ status, contentType: "application/json", headers, body: JSON.stringify(body) });

async function mockGateway(page: Page, patch: Partial<Gateway> = {}): Promise<Gateway> {
  const gw: Gateway = {
    drafts: new Map(), draftUnavailable: false, draftPutStatus: null, draftPuts: 0, assistCalls: [], creates: [], useCases: [], artifacts: [], risks: [], dropNextCreateResponse: false, holdCreate: null,
    user: "ada", signInAs: "ada", bobDrafts: new Map(), draftPutFails: null, draftKeyAtCreate: [], riskPosts: [], artifactPosts: [], dropNextRiskResponse: false, dropNextArtifactResponse: false,
    holdDraftPut: null, draftOwnerRefusals: 0,
    ...patch,
  };
  // the stored risks and questionnaire versions by Idempotency-Key: the gateway's replay contract
  const riskByKey = new Map<string, Json>();
  const versionByKey = new Map<string, number>();
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const p = url.pathname;
    if (request.resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    const method = request.method();
    const body = (method === "GET" || method === "DELETE" ? {} : request.postDataJSON() ?? {}) as Json;

    const person = gw.user === "bob"
      ? { id: "b", email: "bob@example.test", displayName: "Bob Other" }
      : { id: "u", email: "ada@example.test", displayName: "Ada Owner" };
    // ADR-0181: an admin with TOTP enrolled gives a code after the password
    if (p === "/auth/login") return json(route, { mfaRequired: true, pendingToken: "synthetic-pending-token" });
    if (p === "/auth/mfa/verify") {
      const step = verifyTotp(MOCK_TOTP_SECRET, String(body.code ?? ""), mockTotpLastStep);
      if (step === null) return json(route, { error: "invalid_code" }, 401);
      mockTotpLastStep = step;
      gw.user = gw.signInAs;
      return json(route, {});
    }
    if (p === "/auth/logout") {
      gw.user = null;
      return json(route, { ok: true });
    }
    if (p === "/auth/sign-in-options") return json(route, {});
    // an ended session: the gateway's preHandler refuses everything else
    if (gw.user === null) return json(route, { error: "unauthenticated" }, 401);
    if (p === "/auth/me") return json(route, { userId: person.id, isAdmin: true, via: "session", user: person, mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false });
    if (p === "/v1/me") return json(route, { userId: person.id, isAdmin: true, user: person });
    if (p === "/v1/use-cases/draft") {
      if (gw.draftUnavailable) return json(route, { error: "internal" }, 500);
      // drafts are per signed-in person
      const drafts = gw.user === "bob" ? gw.bobDrafts : gw.drafts;
      const scope = url.searchParams.get("scope") ?? "";
      // the gateway's rule: a write naming someone other than the caller stores nothing
      const named = request.headers()["x-regulait-draft-owner"];
      if ((method === "PUT" || method === "DELETE") && named !== undefined && named !== person.id) {
        gw.draftOwnerRefusals += 1;
        return json(route, { error: "draft_owner_changed" }, 409);
      }
      // a slow save: the caller (and its cookie) was resolved when it arrived
      if (method === "PUT" && gw.holdDraftPut?.when(body.state as Json)) await gw.holdDraftPut.until;
      if (method === "PUT") gw.draftPuts += 1;
      if (method === "PUT" && gw.draftPutStatus) return json(route, { error: gw.draftPutStatus === 413 ? "draft_too_large" : "internal" }, gw.draftPutStatus);
      if (method === "PUT" && gw.draftPutFails?.(body.state as Json)) return json(route, { error: "internal" }, 500);
      if (method === "PUT") drafts.set(scope, { scope, state: body.state, updatedAt: new Date().toISOString() });
      if (method === "DELETE") {
        drafts.delete(scope);
        return route.fulfill({ status: 204 });
      }
      return json(route, { draft: drafts.get(scope) ?? null });
    }
    if (p === "/v1/agents") return json(route, { agents: [{ id: AGENT, name: "Credit assistant", provider: "mock", model: "mock-balanced", enabled: true, modes: ["chat"] }] });
    if (p === "/v1/vendors") return json(route, { vendors: [{ id: VENDOR, name: "Acme Model Services", category: "model_provider", status: "approved" }] });
    if (p === "/v1/governance/review-policy") {
      return json(route, { roles: [{ id: "privacy", name: "Privacy", memberUserIds: ["p"] }, { id: "security", name: "Security", memberUserIds: ["s"] }], tiers: { high: { roleIds: ["privacy", "security"], validityMonths: 6 } }, riskAcceptorUserIds: [], updatedAt: null, updatedByName: null });
    }
    if (p === "/v1/use-cases/intake/assist") {
      gw.assistCalls.push(body);
      return json(route, assistFor(body));
    }
    if (p === "/v1/use-cases" && method === "POST") {
      const key = request.headers()["idempotency-key"];
      if (gw.holdCreate) await gw.holdCreate;
      // the gateway's contract: the same caller and key returns the ORIGINAL use case
      const earlier = key ? gw.useCases.find((u) => u.key === key) : undefined;
      gw.creates.push({ key, body, replay: Boolean(earlier) });
      gw.draftKeyAtCreate.push((gw.drafts.get("new")?.state as Json | undefined)?.attempt?.key);
      if (earlier) return json(route, { id: earlier.id, instance: { id: `instance-${earlier.id}` } }, 200, { "Idempotent-Replay": "true" });
      const id = gw.useCases.length === 0 ? USE_CASE : `${gw.useCases.length}1111111-1111-4111-8111-111111111111`;
      gw.useCases.push({ id, key, body });
      if (gw.dropNextCreateResponse) {
        gw.dropNextCreateResponse = false;
        return route.abort("connectionreset");
      }
      return json(route, { id, instance: { id: `instance-${id}` } }, 201);
    }
    if (/^\/v1\/workflows\/instances\/[^/]+\/advance$/.test(p)) return json(route, { status: "running" });
    if (/^\/v1\/workflows\/instances\/[^/]+\/artifacts$/.test(p)) {
      const key = request.headers()["idempotency-key"];
      const earlier = key ? versionByKey.get(key) : undefined;
      gw.artifactPosts.push({ key, replay: earlier !== undefined });
      if (earlier !== undefined) return json(route, { version: earlier, status: "awaiting_approval" }, 200, { "Idempotent-Replay": "true" });
      gw.artifacts.push(String(body.content));
      if (key) versionByKey.set(key, gw.artifacts.length);
      if (gw.dropNextArtifactResponse) {
        gw.dropNextArtifactResponse = false;
        return route.abort("connectionreset");
      }
      return json(route, { version: gw.artifacts.length }, 201);
    }
    if (p === "/v1/risks" && method === "POST") {
      const key = request.headers()["idempotency-key"];
      const earlier = key ? riskByKey.get(key) : undefined;
      gw.riskPosts.push({ key, replay: Boolean(earlier) });
      if (earlier) return json(route, earlier, 200, { "Idempotent-Replay": "true" });
      const row = { ...body, id: `risk-${gw.risks.length + 1}`, controls: [] as string[] };
      gw.risks.push(row);
      if (key) riskByKey.set(key, row);
      if (gw.dropNextRiskResponse) {
        gw.dropNextRiskResponse = false;
        return route.abort("connectionreset");
      }
      return json(route, row, 201);
    }
    const controls = p.match(/^\/v1\/risks\/([^/]+)\/controls$/);
    if (controls && method === "POST") {
      gw.risks.find((r) => r.id === controls[1])?.controls.push(String(body.controlRef));
      return json(route, { linked: true }, 201);
    }
    return json(route, {});
  });
  return gw;
}

const stage = (page: Page) => page.locator('[aria-current="step"]');
const card = (page: Page, title: string) => page.locator("section").filter({ has: page.getByText(title, { exact: true }) }).last();
const nav = (page: Page) => page.getByRole("complementary", { name: "Primary navigation" });

/** the worked example, through Describe and Classify, onto Suggestions */
async function toSuggestions(page: Page) {
  await page.goto("/ui/admin/governance/intake");
  await page.getByRole("button", { name: "Fill in an example" }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(stage(page)).toContainText("Classify");
  await page.getByRole("button", { name: "Draft suggestions" }).click();
  await expect(stage(page)).toContainText("Suggestions");
}

/** the proposer's own decisions and words at every stage, ending on Review */
async function walkWithEdits(page: Page) {
  await toSuggestions(page);
  await card(page, "NIST AI RMF").getByRole("button", { name: "Reject", exact: true }).click();
  await card(page, INJECTION).getByRole("button", { name: "Reject", exact: true }).click();
  await card(page, "EU AI Act").getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByLabel("Edit EU AI Act").fill("Customers in Germany use it, and it decides on access to credit.");
  await card(page, BIAS).getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByLabel(`Edit ${BIAS}`).fill("Edited bias text: outcomes are compared across groups monthly.");
  await page.getByRole("button", { name: /Accept all remaining/ }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(stage(page)).toContainText("Questionnaire");
  await page.getByLabel("1. Purpose and business context answer").fill("My own purpose answer.");
  await card(page, "3. Data").getByRole("button", { name: "Reject", exact: true }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(stage(page)).toContainText("Link stack");
  await page.getByLabel("Model / agent").selectOption(AGENT);
  await page.getByLabel("Vendor").selectOption(VENDOR);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(stage(page)).toContainText("Review");
}

const draftStep = (gw: Gateway) => (gw.drafts.get("new")?.state as Json | undefined)?.step;
/** is the browser's leave prompt armed? (a cancelable beforeunload that a listener prevents) */
const unloadArmed = (page: Page) => page.evaluate(() => {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
});

async function expectNoAxeViolations(page: Page, label: string) {
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate(async (next) => {
      document.documentElement.dataset.theme = next;
      await Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined)));
    }, theme);
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.nodes[0]?.target.join(" ")}`), `axe on "${label}" (${theme})`).toEqual([]);
  }
}

test.describe("AER-050: the work is a server-side draft, leaving asks first, and a lost response never duplicates", () => {
  test("every stage is saved as a draft (never in browser storage), survives a reload and resumes unchanged", async ({ page }) => {
    const gw = await mockGateway(page);
    await walkWithEdits(page);
    await expect.poll(() => draftStep(gw), { message: "the Review step is saved" }).toBe(5);
    await expect(page.getByText(/^Draft saved/)).toBeVisible();
    // questionnaire text can be sensitive: none of it is in the browser's storage
    const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
    expect(stored).not.toContain("My own purpose answer");
    expect(stored).not.toContain("Customers in Germany");
    // saved, so a reload needs no prompt
    expect(await unloadArmed(page)).toBe(false);

    await page.reload();
    await expect(page.getByText(/You have a saved draft of “Credit-limit-increase assistant”/)).toBeVisible();
    await expectNoAxeViolations(page, "resume offer");
    await page.getByRole("button", { name: "Resume your draft" }).click();
    await expect(stage(page)).toContainText("Review");
    const proposal = page.getByRole("group", { name: "Your proposal" });
    await expect(proposal).toContainText("Customers in Germany use it, and it decides on access to credit.");
    await expect(proposal).toContainText("Edited bias text: outcomes are compared across groups monthly.");
    await expect(proposal).toContainText("Credit assistant · mock/mock-balanced");
    await page.getByRole("button", { name: "Back" }).click();
    await page.getByRole("button", { name: "Back" }).click();
    await expect(stage(page)).toContainText("Questionnaire");
    await expect(page.getByLabel("1. Purpose and business context answer")).toHaveValue("My own purpose answer.");
    await expect(card(page, "3. Data").getByText("rejected", { exact: true })).toBeVisible();
    // the assistant was not asked again to restore any of it
    expect(gw.assistCalls).toHaveLength(1);
  });

  test("Start fresh discards the saved draft and opens a blank form", async ({ page }) => {
    const gw = await mockGateway(page);
    gw.drafts.set("new", { scope: "new", state: { kind: "registration", version: 1, step: 1, form: { title: "Old idea", description: "Old purpose" } }, updatedAt: "2026-10-02T09:00:00Z" });
    await page.goto("/ui/admin/governance/intake");
    await expect(page.getByText(/You have a saved draft of “Old idea”/)).toBeVisible();
    await page.getByRole("button", { name: "Start fresh" }).click();
    await expect.poll(() => gw.drafts.has("new")).toBe(false);
    await expect(page.getByLabel("Use-case name")).toHaveValue("");
    await expect(stage(page)).toContainText("Describe");
  });

  test("a draft the gateway refuses (too large) is said plainly and not retried in a loop; the next change tries again", async ({ page }) => {
    const gw = await mockGateway(page, { draftPutStatus: 413 });
    await page.goto("/ui/admin/governance/intake");
    await page.getByLabel("Use-case name").fill("Something new");
    await expect(page.getByText("This draft is too large to save: your answers stay on this page until you submit.")).toBeVisible();
    expect(gw.draftPuts).toBe(1);
    await page.waitForTimeout(2500);
    expect(gw.draftPuts, "no save loop while nothing changes").toBe(1);
    expect(await unloadArmed(page)).toBe(true);
    await page.getByLabel("Use-case name").fill("Something newer");
    await expect.poll(() => gw.draftPuts).toBe(2);
  });

  test("Cancel and the navigation ask before leaving; Stay keeps the answers; an unsaved form arms the browser's prompt", async ({ page }) => {
    await mockGateway(page, { draftUnavailable: true });
    await page.goto("/ui/admin/governance/intake");
    await page.getByLabel("Use-case name").fill("Something new");
    await expect(page.getByText("Your draft can't be saved right now: your answers stay on this page until you submit.")).toBeVisible();
    expect(await unloadArmed(page)).toBe(true);

    await page.getByRole("link", { name: "Cancel" }).click();
    const leave = page.getByRole("dialog", { name: "Leave this registration?" });
    await expect(leave).toContainText("not saved anywhere else");
    await expectNoAxeViolations(page, "leave dialog");
    await leave.getByRole("button", { name: "Stay on this page" }).click();
    await expect(leave).toHaveCount(0);
    await expect(page).toHaveURL(/\/ui\/admin\/governance\/intake$/);
    await expect(page.getByLabel("Use-case name")).toHaveValue("Something new");

    // the navigation rail asks too, then goes where it was asked to
    await nav(page).getByRole("link", { name: "Home", exact: true }).click();
    await expect(leave).toBeVisible();
    await leave.getByRole("button", { name: "Leave", exact: true }).click();
    await expect(page).toHaveURL(/\/ui\/?$/);
  });

  test("Cancel and Back are disabled while a submission is in flight; leaving then says how to recover", async ({ page }) => {
    let release: () => void = () => undefined;
    const gw = await mockGateway(page, { holdCreate: new Promise<void>((resolve) => { release = resolve; }) });
    await walkWithEdits(page);
    await page.getByRole("button", { name: "Submit for human review" }).click();
    await expect(page.getByRole("button", { name: "Submitting…" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Cancel" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Back" })).toBeDisabled();
    expect(await unloadArmed(page)).toBe(true);
    // the key the create carries is in the draft before the request is answered
    await expect.poll(() => (gw.drafts.get("new")?.state as Json | undefined)?.attempt?.key).toBeTruthy();
    const draftKey = (gw.drafts.get("new")!.state as Json).attempt.key as string;
    await nav(page).getByRole("link", { name: "Home", exact: true }).click();
    const leave = page.getByRole("dialog", { name: "Your submission is still being sent" });
    await expect(leave).toContainText("will not create a second use case");
    await leave.getByRole("button", { name: "Stay on this page" }).click();
    release();
    await expect(page.getByRole("status").filter({ hasText: "Submitted for human review." })).toBeVisible();
    expect(gw.creates.map((c) => c.key)).toEqual([draftKey]);
    // submitted: the draft is gone and nothing asks before leaving
    await expect.poll(() => gw.drafts.has("new")).toBe(false);
    expect(await unloadArmed(page)).toBe(false);
  });

  test("a create whose response is lost is finished after a reload with the same key: one use case, one risk set", async ({ page }) => {
    const gw = await mockGateway(page, { dropNextCreateResponse: true });
    await walkWithEdits(page);
    await page.getByRole("button", { name: "Submit for human review" }).click();
    await expect(page.getByRole("main").getByRole("alert").filter({ hasText: "retry to resume" })).toBeVisible();
    // the gateway committed it; the page never heard back
    expect(gw.useCases).toHaveLength(1);
    const key = gw.creates[0]!.key!;
    expect(key).toMatch(/^[0-9a-f-]{36}$/);
    await expect.poll(() => (gw.drafts.get("new")?.state as Json | undefined)?.attempt?.key).toBe(key);

    await page.reload();
    await page.getByRole("button", { name: "Resume your draft" }).click();
    await expect(stage(page)).toContainText("Review");
    await expect(page.getByText(/A submission from these answers has already started/)).toBeVisible();
    await page.getByRole("button", { name: "Submit for human review" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Submitted for human review." })).toBeVisible();

    expect(gw.creates.map((c) => [c.key, c.replay])).toEqual([[key, false], [key, true]]);
    expect(gw.creates[1]!.body).toEqual(gw.creates[0]!.body);
    expect(gw.useCases).toHaveLength(1);
    expect(gw.artifacts).toHaveLength(1);
    expect(gw.risks.map((r) => [r.title, r.useCaseId, r.controls])).toEqual([[BIAS, USE_CASE, ["eu-ai-act:art-14-human-oversight"]]]);
    await expect(page.getByRole("link", { name: "Open the use-case workspace" })).toHaveAttribute("href", `/ui/admin/governance/use-cases/${USE_CASE}`);
    await expect.poll(() => gw.drafts.has("new")).toBe(false);
  });

  test("a retry on the same page after a lost response reuses the key too", async ({ page }) => {
    const gw = await mockGateway(page, { dropNextCreateResponse: true });
    await walkWithEdits(page);
    await page.getByRole("button", { name: "Submit for human review" }).click();
    await expect(page.getByRole("main").getByRole("alert").filter({ hasText: "retry to resume" })).toBeVisible();
    await page.getByRole("button", { name: "Submit for human review" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Submitted for human review." })).toBeVisible();
    expect(gw.creates.map((c) => c.replay)).toEqual([false, true]);
    expect(new Set(gw.creates.map((c) => c.key)).size).toBe(1);
    expect(gw.useCases).toHaveLength(1);
    expect(gw.risks).toHaveLength(1);
  });
});

test.describe("AER-051: returning to Classify never silently replaces edits", () => {
  test("Back to Classify and on with unchanged answers keeps every edit and decision, and does not re-draft", async ({ page }) => {
    const gw = await mockGateway(page);
    await walkWithEdits(page);
    for (const s of ["Link stack", "Questionnaire", "Suggestions", "Classify"]) {
      await page.getByRole("button", { name: "Back" }).click();
      await expect(stage(page)).toContainText(s);
    }
    await page.getByRole("button", { name: "Draft suggestions" }).click();
    await expect(stage(page)).toContainText("Suggestions");
    expect(gw.assistCalls).toHaveLength(1);
    await expect(card(page, "NIST AI RMF").getByText("rejected", { exact: true })).toBeVisible();
    await expect(card(page, BIAS)).toContainText("Edited bias text");
    await expect(page.getByRole("button", { name: "Accept all remaining (0)" })).toBeDisabled();
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByLabel("1. Purpose and business context answer")).toHaveValue("My own purpose answer.");
    await expect(card(page, "3. Data").getByText("rejected", { exact: true })).toBeVisible();
  });

  test("changed answers name the affected sections; nothing changes until the proposer chooses, and Keep my edits keeps them", async ({ page }) => {
    const gw = await mockGateway(page);
    await walkWithEdits(page);
    await page.getByRole("button", { name: "Back" }).click();
    await page.getByRole("button", { name: "Back" }).click();
    await page.getByLabel("2. Affected people answer").fill("My own words about affected people.");
    for (let i = 0; i < 2; i += 1) await page.getByRole("button", { name: "Back" }).click();
    await expect(stage(page)).toContainText("Classify");
    await page.getByLabel("Emotion recognition").selectOption("yes");
    await page.getByRole("button", { name: "Draft suggestions" }).click();

    const choice = page.getByRole("region", { name: "Your answers changed since the suggestions were drafted" });
    await expect(choice).toContainText("Frameworks: no longer suggests NIST AI RMF.");
    await expect(choice).toContainText(`Risk scenarios: adds ${EMOTION}.`);
    await expect(choice).toContainText("Questionnaire: a new draft for 2. Affected people (you edited it).");
    // nothing has been replaced yet: still on Classify, the proposal untouched
    await expect(stage(page)).toContainText("Classify");
    expect(gw.assistCalls).toHaveLength(2);
    await expectNoAxeViolations(page, "re-draft choice");

    await choice.getByRole("button", { name: "Keep my edits" }).click();
    await expect(stage(page)).toContainText("Suggestions");
    await expect(card(page, "NIST AI RMF")).toContainText("No longer suggested by your answers");
    await expect(card(page, "NIST AI RMF").getByText("rejected", { exact: true })).toBeVisible();
    await expect(card(page, EMOTION).getByText("not reviewed", { exact: true })).toBeVisible();
    await expect(card(page, BIAS)).toContainText("Edited bias text");
    await card(page, EMOTION).getByRole("button", { name: "Accept", exact: true }).click();
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByLabel("2. Affected people answer")).toHaveValue("My own words about affected people.");
    await expect(page.getByLabel("1. Purpose and business context answer")).toHaveValue("My own purpose answer.");
    // the screening section always follows the answers
    await expect(page.getByLabel("9. EU AI Act risk screening")).toHaveValue(/"emotionRecognition": true/);
  });

  test("Regenerate affected sections replaces only those, with the proposer's consent, and drops stale suggestions with their edits", async ({ page }) => {
    await mockGateway(page);
    await walkWithEdits(page);
    await page.getByRole("button", { name: "Back" }).click();
    await page.getByRole("button", { name: "Back" }).click();
    await page.getByLabel("2. Affected people answer").fill("My own words about affected people.");
    for (let i = 0; i < 2; i += 1) await page.getByRole("button", { name: "Back" }).click();
    await page.getByLabel("Emotion recognition").selectOption("yes");
    await page.getByRole("button", { name: "Draft suggestions" }).click();
    await page.getByRole("button", { name: "Regenerate affected sections" }).click();
    await expect(stage(page)).toContainText("Suggestions");
    await expect(page.getByText("NIST AI RMF", { exact: true })).toHaveCount(0);
    await expect(card(page, BIAS)).toContainText("Edited bias text");
    await expect(card(page, "EU AI Act")).toContainText("Customers in Germany");
    await page.getByRole("button", { name: /Accept all remaining/ }).click();
    await page.getByRole("button", { name: "Continue" }).click();
    // the affected section takes the new draft; the unaffected one keeps the proposer's words
    await expect(page.getByLabel("2. Affected people answer")).toHaveValue("Revised draft 2: customers whose emotions are inferred.");
    await expect(page.getByLabel("1. Purpose and business context answer")).toHaveValue("My own purpose answer.");
  });
});

test.describe("AER-052/053/054: explanations saved, plain-language screening, the proposal reviewed", () => {
  test("AER-052: an edited framework explanation is sent with the use case; an unedited or rejected one is not", async ({ page }) => {
    const gw = await mockGateway(page);
    await walkWithEdits(page);
    await page.getByRole("button", { name: "Submit for human review" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Submitted for human review." })).toBeVisible();
    expect(gw.creates[0]!.body.complianceTags).toEqual(["eu-ai-act"]);
    expect(gw.creates[0]!.body.frameworkRationales).toEqual({ "eu-ai-act": "Customers in Germany use it, and it decides on access to credit." });
  });

  test("AER-053: each yes/no question explains itself; a missing answer is named with its group and the first gap takes focus", async ({ page }) => {
    await mockGateway(page);
    await page.goto("/ui/admin/governance/intake");
    await page.getByRole("button", { name: "Fill in an example" }).click();
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByLabel("Has an EU nexus")).toHaveAccessibleDescription(/offered to people in the EU.*Example:/);
    await expect(page.getByLabel("Safety component")).toHaveAccessibleDescription(/put health or safety at risk.*Example:/);
    await expect(page.getByLabel("Manipulative techniques")).toHaveAccessibleDescription(/steer people's choices.*Example:/);
    await expect(page.getByLabel("Profiles natural persons")).toHaveAccessibleDescription(/picture of individual people.*Example:/);

    // one gap in each group
    await page.getByLabel("People affected").selectOption("");
    await page.getByLabel("Sectors: Financial services", { exact: true }).uncheck();
    await page.getByLabel("Social scoring").selectOption("");
    const missing = page.getByRole("region", { name: /3 questions still need an answer/ });
    await expect(missing).toContainText("Purpose and people: People affected");
    await expect(missing).toContainText("Data and sector: Sectors");
    await expect(missing).toContainText("What it does in practice: Social scoring");
    await expect(page.getByRole("button", { name: "Draft suggestions" })).toBeDisabled();
    await expectNoAxeViolations(page, "Classify (missing answers)");
    // the keyboard reaches the summary and lands on the first gap
    await missing.getByRole("button", { name: "Go to the first unanswered question" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByLabel("People affected")).toBeFocused();
    await page.getByLabel("People affected").selectOption("customers");
    await page.getByLabel("Sectors: Financial services", { exact: true }).check();
    await page.getByLabel("Social scoring").selectOption("no");
    await expect(missing).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Draft suggestions" })).toBeEnabled();
  });

  test("AER-053: Not sure counts as yes for the tier, is recorded in the questionnaire, and is shown on Review", async ({ page }) => {
    const gw = await mockGateway(page);
    await page.goto("/ui/admin/governance/intake");
    await page.getByRole("button", { name: "Fill in an example" }).click();
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByLabel("Profiles natural persons").selectOption("unsure");
    await page.getByLabel("Has an EU nexus").selectOption("unsure");
    await page.getByLabel("Social scoring").selectOption("unsure");
    await expect(page.getByLabel("Social scoring")).toHaveAccessibleDescription(/Not sure counts as yes until a reviewer confirms it/);
    await expectNoAxeViolations(page, "Classify (not sure)");
    await page.getByRole("button", { name: "Draft suggestions" }).click();
    // uncertainty can never screen as a lower tier: each "not sure" is sent as yes
    expect(gw.assistCalls[0]!.euAiAct).toMatchObject({ profilesNaturalPersons: true, socialScoring: true });
    expect(gw.assistCalls[0]!.context).toMatchObject({ euNexus: true });
    await page.getByRole("button", { name: /Accept all remaining/ }).click();
    for (let i = 0; i < 3; i += 1) await page.getByRole("button", { name: "Continue" }).click();
    const proposal = page.getByRole("group", { name: "Your proposal" });
    await expect(proposal).toContainText("Your reviewers will see that you were not sure about: Profiles natural persons, Has an EU nexus, Social scoring.");
    await page.getByRole("button", { name: "Submit for human review" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Submitted for human review." })).toBeVisible();
    expect(gw.creates[0]!.body.screeningAnswers).toMatchObject({ profilesNaturalPersons: true, socialScoring: true, euNexus: true });
    // the questionnaire version the reviewer decides on records the EU answers that were guesses
    const block = /```eu-ai-act-answers\n([\s\S]*?)```/.exec(gw.artifacts[0]!)![1]!;
    expect(JSON.parse(block)).toMatchObject({ profilesNaturalPersons: true, socialScoring: true, unsure: ["profilesNaturalPersons", "socialScoring"] });
  });

  test("AER-054: Review shows the proposal itself, who receives it and where to follow it; Edit this section comes back keeping the rest", async ({ page }) => {
    await mockGateway(page);
    await walkWithEdits(page);
    const proposal = page.getByRole("group", { name: "Your proposal" });
    await expect(proposal).toContainText("Customers in Germany use it, and it decides on access to credit.");
    await expect(proposal).toContainText("NIST AI RMF — rejected, not included");
    await expect(proposal).toContainText("Edited bias text: outcomes are compared across groups monthly.");
    await expect(proposal).toContainText(`${INJECTION} — rejected, not included`);
    await proposal.locator("summary", { hasText: "Questionnaire" }).click();
    await expect(proposal).toContainText("My own purpose answer.");
    await expect(proposal).toContainText("3. Data — rejected, not included");
    await expect(proposal).toContainText("Credit assistant · mock/mock-balanced");
    await expect(proposal).toContainText("Acme Model Services · approved");
    await expect(proposal).toContainText("One review from each of these reviewer roles: Privacy, Security.");
    await expect(proposal.getByRole("link", { name: "Follow it in the AI registry" })).toHaveAttribute("href", "/ui/admin/use-cases");
    await expectNoAxeViolations(page, "Review (the proposal)");

    await proposal.getByRole("button", { name: "Edit this section: Risks" }).click();
    await expect(stage(page)).toContainText("Suggestions");
    await card(page, INJECTION).getByRole("button", { name: "Accept", exact: true }).click();
    await page.getByRole("button", { name: "Return to review" }).click();
    await expect(stage(page)).toContainText("Review");
    await expect(proposal).not.toContainText(`${INJECTION} — rejected`);
    await expect(proposal).toContainText("Free-text input may steer the assistant");
    await expect(proposal).toContainText("Customers in Germany use it");
    await proposal.locator("summary", { hasText: "Questionnaire" }).click();
    await expect(proposal).toContainText("My own purpose answer.");
    await expect(proposal).toContainText("Credit assistant · mock/mock-balanced");
  });
});

// ===========================================================================
// ADR-0179 — the rest of AER-050: failed saves, browser Back, session loss,
// another user, and lost risk / questionnaire responses
// ===========================================================================

const submitted = (page: Page) => page.getByRole("status").filter({ hasText: "Submitted for human review." });
const notSaved = (page: Page) => page.getByRole("main").getByRole("alert").filter({ hasText: "Your draft could not be saved" });

test("B1: a permanently oversized exit save can be discarded without removing an older draft", async ({ page }, testInfo) => {
  const gw = await mockGateway(page);
  await page.goto("/ui/admin/governance/intake");
  await page.getByLabel("Use-case name").fill("Earlier saved proposal");
  await expect.poll(() => (gw.drafts.get("new")?.state as Json)?.form?.title).toBe("Earlier saved proposal");
  gw.draftPutStatus = 413;
  await page.getByLabel("Use-case name").fill("Latest unsaved oversized proposal");
  await expect(page.getByText("This draft is too large to save: your answers stay on this page until you submit.")).toBeVisible();
  await page.getByRole("link", { name: "Cancel", exact: true }).click();
  const leave = page.getByRole("dialog", { name: "Leave this registration?" });
  await leave.getByRole("button", { name: "Leave", exact: true }).click();
  await expect(leave.getByRole("alert")).toContainText("could not be saved");
  const puts = gw.draftPuts;
  await expectNoAxeViolations(page, "discard oversized exit save");
  await page.screenshot({ path: testInfo.outputPath("x13-discard-oversized.png") });
  await leave.getByRole("button", { name: "Discard and leave", exact: true }).click();
  await expect(page).toHaveURL(/\/ui\/admin\/use-cases$/);
  expect(gw.draftPuts, "discard must suppress the automatic exit save").toBe(puts);
  expect((gw.drafts.get("new")?.state as Json)?.form?.title).toBe("Earlier saved proposal");
});

test("B1: an unresolved initial draft read does not trap an edited registration", async ({ page }) => {
  await mockGateway(page);
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/v1/use-cases/draft?scope=new", async (route) => {
    if (route.request().method() === "GET") { await held; await route.abort().catch(() => undefined); }
    else await route.fallback();
  });
  try {
    await page.goto("/ui/admin/governance/intake");
    await page.getByLabel("Use-case name").fill("Leave despite unavailable initial read");
    await page.getByRole("link", { name: "Cancel", exact: true }).click();
    const leave = page.getByRole("dialog", { name: "Leave this registration?" });
    await leave.getByRole("button", { name: "Leave", exact: true }).click();
    await expect(leave.getByRole("alert")).toContainText("could not be saved");
    await leave.getByRole("button", { name: "Discard and leave", exact: true }).click();
    await expect(page).toHaveURL(/\/ui\/admin\/use-cases$/);
  } finally { release(); }
});

test("M1: Back after direct URL entry warns and sends the latest exit snapshot", async ({ page }) => {
  const gw = await mockGateway(page, { draftPutStatus: 500 });
  // Two document navigations: the previous entry is outside this router's history.
  await page.goto("/ui/admin/use-cases");
  await page.goto("/ui/admin/governance/intake");
  await page.getByLabel("Use-case name").fill("Unsaved direct-URL proposal");
  expect(await unloadArmed(page)).toBe(true);
  let warned = false;
  page.once("dialog", async (dialog) => {
    expect(dialog.type()).toBe("beforeunload");
    warned = true;
    await dialog.dismiss();
  });
  // A dismissed native warning cancels navigation: wait only for that attempt,
  // rather than asking Playwright to wait for a document that will not load.
  await page.goBack({ timeout: 2000 }).catch((error: Error) => {
    expect(error.message).toMatch(/Timeout|ERR_ABORTED/);
  });
  expect(warned, "Back out of a directly entered document must warn before leaving").toBe(true);
  await expect(page).toHaveURL(/\/ui\/admin\/governance\/intake$/);
  await expect(page.getByLabel("Use-case name")).toHaveValue("Unsaved direct-URL proposal");

  gw.draftPutStatus = null;
  await page.getByLabel("Use-case name").fill("Latest direct-URL proposal");
  const exits: Array<{ title: string; owner: string }> = [];
  await page.exposeFunction("recordDraftExit", (body: string, owner: string) => {
    exits.push({ title: JSON.parse(body).state.form.title, owner });
  });
  // Page request interception cannot complete a keepalive that outlives its
  // document. Observe its actual invocation without replacing the fetch.
  await page.evaluate(() => {
    const original = window.fetch.bind(window);
    window.fetch = (input, init) => {
      if (String(input).startsWith("/v1/use-cases/draft") && init?.keepalive) {
        void (window as any).recordDraftExit(String(init.body), (init.headers as Record<string, string>)["x-regulait-draft-owner"]);
      }
      return original(input, init);
    };
  });
  page.once("dialog", (dialog) => void dialog.accept());
  await page.goBack();
  await expect(page).toHaveURL(/\/ui\/admin\/use-cases$/);
  await expect.poll(() => exits).toContainEqual({ title: "Latest direct-URL proposal", owner: "u" });
});

async function signIn(page: Page, email: string) {
  recordTotpSecret(email, MOCK_TOTP_SECRET);
  await page.getByLabel("Email or username").fill(email);
  await page.getByLabel("Password", { exact: true }).fill("synthetic-password-for-a-mock");
  await page.getByRole("button", { name: "Sign in" }).click();
  await passTotp(page, email, page.locator("button[aria-haspopup=menu]"));
}

test.describe("ADR-0179: a create waits for a durable draft save", () => {
  test("a refused save of the create's key sends no create; the error says so, and Retry creates once with the saved key", async ({ page }) => {
    const gw = await mockGateway(page);
    await walkWithEdits(page);
    await expect.poll(() => draftStep(gw)).toBe(5);
    // the save that carries the create's Idempotency-Key is refused
    gw.draftPutFails = (state) => Boolean(state.attempt);
    await page.getByRole("button", { name: "Submit for human review" }).click();
    await expect(notSaved(page)).toContainText("the next step of your submission was not sent");
    await expect(notSaved(page)).toContainText("This step was not sent");
    expect(gw.creates, "no create without its key on the server").toHaveLength(0);
    await expectNoAxeViolations(page, "draft not saved");

    gw.draftPutFails = null;
    await notSaved(page).getByRole("button", { name: "Retry" }).click();
    await expect(submitted(page)).toBeVisible();
    expect(gw.creates).toHaveLength(1);
    // the server held the key before the create was sent
    expect(gw.draftKeyAtCreate).toEqual([gw.creates[0]!.key]);
    expect(gw.useCases).toHaveLength(1);
    expect(gw.artifacts).toHaveLength(1);
    expect(gw.risks).toHaveLength(1);
  });

  test("a stalled checkpoint save times out without creating; retry keeps the same durable attempt", async ({ page }) => {
    const gw = await mockGateway(page);
    await walkWithEdits(page);
    await expect.poll(() => draftStep(gw)).toBe(5);
    let stall = true;
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    await page.route("**/v1/use-cases/draft?scope=new", async (route) => {
      if (stall && route.request().method() === "PUT" && route.request().postDataJSON().state.attempt) {
        await held;
        await route.abort().catch(() => undefined);
      } else {
        await route.fallback();
      }
    });
    try {
      await page.getByRole("button", { name: "Submit for human review" }).click();
      await expect(notSaved(page)).toBeVisible({ timeout: 20_000 });
      expect(gw.creates, "no create while its recovery key is not durable").toHaveLength(0);
      stall = false;
      release();
      await notSaved(page).getByRole("button", { name: "Retry" }).click();
      await expect(submitted(page)).toBeVisible();
      expect(gw.creates).toHaveLength(1);
      expect(gw.draftKeyAtCreate).toEqual([gw.creates[0]!.key]);
    } finally {
      release();
    }
  });

  test("a refused save of a risk's key sends no risk; Retry registers it once", async ({ page }) => {
    const gw = await mockGateway(page);
    await walkWithEdits(page);
    await expect.poll(() => draftStep(gw)).toBe(5);
    gw.draftPutFails = (state) => Object.keys((state.checkpoint as Json | undefined)?.riskAttempts ?? {}).length > 0;
    await page.getByRole("button", { name: "Submit for human review" }).click();
    await expect(notSaved(page)).toBeVisible();
    expect(gw.useCases).toHaveLength(1);
    expect(gw.artifacts).toHaveLength(1);
    expect(gw.riskPosts, "no risk without its key on the server").toHaveLength(0);

    gw.draftPutFails = null;
    await notSaved(page).getByRole("button", { name: "Retry" }).click();
    await expect(submitted(page)).toBeVisible();
    expect(gw.creates).toHaveLength(1);
    expect(gw.risks).toHaveLength(1);
    expect(gw.riskPosts.map((r) => r.replay)).toEqual([false]);
  });

  test("a questionnaire and then a risk whose responses are lost are finished after reloads with the same keys: one version, one risk", async ({ page }) => {
    const gw = await mockGateway(page, { dropNextArtifactResponse: true });
    await walkWithEdits(page);
    await page.getByRole("button", { name: "Submit for human review" }).click();
    await expect(page.getByRole("main").getByRole("alert").filter({ hasText: "retry to resume" })).toBeVisible();
    expect(gw.artifacts).toHaveLength(1);

    gw.dropNextRiskResponse = true;
    await page.reload();
    await page.getByRole("button", { name: "Resume your draft" }).click();
    await page.getByRole("button", { name: "Submit for human review" }).click();
    await expect(page.getByRole("main").getByRole("alert").filter({ hasText: "retry to resume" })).toBeVisible();
    expect(gw.risks).toHaveLength(1);

    await page.reload();
    await page.getByRole("button", { name: "Resume your draft" }).click();
    await page.getByRole("button", { name: "Submit for human review" }).click();
    await expect(submitted(page)).toBeVisible();

    expect(gw.useCases).toHaveLength(1);
    expect(gw.artifacts, "one questionnaire version: no second review round").toHaveLength(1);
    expect(gw.artifactPosts.map((a) => a.replay)).toEqual([false, true]);
    expect(new Set(gw.artifactPosts.map((a) => a.key)).size).toBe(1);
    expect(gw.risks.map((r) => [r.title, r.controls])).toEqual([[BIAS, ["eu-ai-act:art-14-human-oversight"]]]);
    expect(gw.riskPosts.map((r) => r.replay)).toEqual([false, true]);
    expect(new Set(gw.riskPosts.map((r) => r.key)).size).toBe(1);
    await expect.poll(() => gw.drafts.has("new")).toBe(false);
  });
});

test.describe("ADR-0179: browser Back and leaving the page keep the last edit", () => {
  test("an edit followed at once by browser Back asks first; Stay keeps it; Leave saves it; Forward recovers it exactly", async ({ page }) => {
    const gw = await mockGateway(page);
    // Enter through a real SPA link so Back/Forward are router transitions;
    // document exits are covered separately by the beforeunload checks.
    await page.goto("/ui/admin/use-cases");
    await page.getByRole("link", { name: "Register AI use case", exact: true }).click();
    const name = page.getByLabel("Use-case name");
    await name.fill("Typed just before Back");
    await page.evaluate(() => history.back());
    const leave = page.getByRole("dialog", { name: "Leave this registration?" });
    await expect(leave).toBeVisible();
    await expect(page).toHaveURL(/\/ui\/admin\/governance\/intake$/);
    await expectNoAxeViolations(page, "Back asks first");
    await leave.getByRole("button", { name: "Stay on this page" }).click();
    await expect(leave).toHaveCount(0);
    await expect(name).toHaveValue("Typed just before Back");

    // again, and this time leave at once
    await name.fill("Typed just before Back, then edited");
    await page.evaluate(() => history.back());
    await leave.getByRole("button", { name: "Leave", exact: true }).click();
    await expect(page).toHaveURL(/\/ui\/admin\/use-cases$/);
    await expect.poll(() => ((gw.drafts.get("new")?.state as Json | undefined)?.form as Json | undefined)?.title).toBe("Typed just before Back, then edited");

    // POP updates the address before React commits the destination. The
    // reproduced CI trace still shows the intake dialog at this URL: Forward
    // at that point races the outstanding Back. Wait for the actual page.
    await expect(page.getByRole("heading", { level: 1, name: "AI registry", exact: true })).toBeVisible();
    await expect(leave).toHaveCount(0);

    await page.goForward();
    await expect(page).toHaveURL(/\/ui\/admin\/governance\/intake$/);
    await expect(page.getByText(/You have a saved draft of “Typed just before Back, then edited”/)).toBeVisible();
    await page.getByRole("button", { name: "Resume your draft" }).click();
    await expect(name).toHaveValue("Typed just before Back, then edited");
  });

  test("the search palette asks before leaving an edited intake, then saves before navigating", async ({ page }) => {
    const gw = await mockGateway(page);
    await page.goto("/ui/admin/governance/intake");
    await page.getByLabel("Use-case name").fill("Kept when the page unmounts");
    expect(gw.draftPuts).toBe(0);
    await page.keyboard.press("Control+k");
    const dialog = page.getByRole("dialog", { name: "Search pages and your work" });
    await dialog.getByRole("combobox", { name: "Search pages, agents, models and projects" }).fill("models");
    await expect(dialog.getByRole("group", { name: "Pages" }).getByRole("option", { name: /^Models/ })).toBeVisible();
    await page.keyboard.press("Enter");
    const leave = page.getByRole("dialog", { name: "Leave this registration?" });
    await expect(leave).toBeVisible();
    await expect(page).toHaveURL(/\/intake$/);
    await expectNoAxeViolations(page, "programmatic navigation asks first");
    await leave.getByRole("button", { name: "Leave", exact: true }).click();
    await expect(page).toHaveURL(/\/ui\/models$/);
    await expect.poll(() => ((gw.drafts.get("new")?.state as Json | undefined)?.form as Json | undefined)?.title).toBe("Kept when the page unmounts");
  });

  test("a failed save on Leave keeps the dialog and latest edit; retry leaves only after saving", async ({ page }, testInfo) => {
    const gw = await mockGateway(page);
    await page.goto("/ui/admin/governance/intake");
    gw.draftPutFails = () => true;
    await page.getByLabel("Use-case name").fill("Keep this unsaved answer");
    await page.getByRole("link", { name: "Cancel", exact: true }).click();
    const leave = page.getByRole("dialog", { name: "Leave this registration?" });
    await expect(leave).toBeVisible();
    await leave.getByRole("button", { name: "Leave", exact: true }).click();
    await expect(leave.getByRole("alert")).toContainText("could not be saved");
    await expect(page).toHaveURL(/\/intake$/);
    await expect(page.getByLabel("Use-case name")).toHaveValue("Keep this unsaved answer");
    expect(gw.drafts.has("new")).toBe(false);
    await expectNoAxeViolations(page, "failed exit save keeps the form");
    await page.screenshot({ path: testInfo.outputPath("x13-failed-exit-save.png") });

    gw.draftPutFails = null;
    await leave.getByRole("button", { name: "Leave", exact: true }).click();
    await expect(page).toHaveURL(/\/use-cases$/);
    expect(((gw.drafts.get("new")?.state as Json)?.form as Json)?.title).toBe("Keep this unsaved answer");
  });

  test("an edit made just before the page is closed or reloaded is saved on the way out", async ({ page }) => {
    const gw = await mockGateway(page);
    await page.goto("/ui/admin/governance/intake");
    await page.getByLabel("Use-case name").fill("Kept when the page goes");
    // inside the one-second debounce: nothing saved yet
    expect(gw.draftPuts).toBe(0);
    // the browser's `pagehide` as the page goes. Dispatched here rather than by
    // a real unload: the test's request interception cannot see a keepalive
    // request that outlives its page, though the browser still sends it.
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: false })));
    await expect.poll(() => ((gw.drafts.get("new")?.state as Json | undefined)?.form as Json | undefined)?.title, { timeout: 900 }).toBe("Kept when the page goes");
    page.on("dialog", (dialog) => void dialog.accept());
    await page.reload();
    await expect(page.getByText(/You have a saved draft of “Kept when the page goes”/)).toBeVisible();
  });
});

test.describe("ADR-0179: session loss and another user", () => {
  test("an expired session mid-intake keeps the saved draft; signing in again returns to it and it submits once", async ({ page }) => {
    const gw = await mockGateway(page);
    await walkWithEdits(page);
    await expect.poll(() => draftStep(gw)).toBe(5);
    const saved = JSON.stringify(gw.drafts.get("new")!.state);

    gw.user = null; // the session ends
    await page.getByRole("button", { name: "Back" }).click();
    await expect(page.getByLabel("Email or username")).toBeVisible();
    // the save under the dead session was refused; the last durable draft is untouched
    expect(JSON.stringify(gw.drafts.get("new")!.state)).toBe(saved);

    await signIn(page, "ada@example.test");
    await expect(page).toHaveURL(/\/ui\/admin\/governance\/intake$/);
    await expect(page.getByText(/You have a saved draft of “Credit-limit-increase assistant”/)).toBeVisible();
    await page.getByRole("button", { name: "Resume your draft" }).click();
    await expect(stage(page)).toContainText("Review");
    await expect(page.getByRole("group", { name: "Your proposal" })).toContainText("Edited bias text: outcomes are compared across groups monthly.");
    await page.getByRole("button", { name: "Submit for human review" }).click();
    await expect(submitted(page)).toBeVisible();
    expect(gw.useCases).toHaveLength(1);
    expect(gw.risks).toHaveLength(1);
    await expect.poll(() => gw.drafts.has("new")).toBe(false);
  });

  test("user A signs out and user B signs in on the same browser: B never sees, resumes or removes A's draft", async ({ page }) => {
    const gw = await mockGateway(page);
    await page.goto("/ui/admin/governance/intake");
    await page.getByLabel("Use-case name").fill("Ada's confidential idea");
    await expect.poll(() => ((gw.drafts.get("new")?.state as Json | undefined)?.form as Json | undefined)?.title).toBe("Ada's confidential idea");

    await page.locator("button[aria-haspopup=menu]").click();
    await page.getByRole("menuitem", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/ui\/login/);
    gw.signInAs = "bob";
    await signIn(page, "bob@example.test");
    await expect(page).toHaveURL(/\/ui\/admin\/governance\/intake$/);
    await expect(page.getByLabel("Use-case name")).toHaveValue("");
    await expect(page.getByText(/You have a saved draft/)).toHaveCount(0);
    expect(await page.content()).not.toContain("Ada's confidential idea");
    // B's page neither read nor removed A's draft
    expect(gw.bobDrafts.size).toBe(0);
    expect(((gw.drafts.get("new")?.state as Json | undefined)?.form as Json | undefined)?.title).toBe("Ada's confidential idea");
  });

  test("A's exit save, queued behind a slow save, lands after B signs in: it names A, so it never becomes B's draft", async ({ page }) => {
    let release!: () => void;
    let held = false;
    const gw = await mockGateway(page, {
      holdDraftPut: {
        when: (state) => {
          const hit = (state.form as Json | undefined)?.title === "Ada's confidential idea";
          if (hit) held = true;
          return hit;
        },
        until: new Promise<void>((resolve) => { release = resolve; }),
      },
    });
    await page.goto("/ui/admin/governance/intake");
    await page.getByLabel("Use-case name").fill("Ada's confidential idea");
    // the debounced save is in flight and slow
    await expect.poll(() => held, { message: "the slow save has arrived" }).toBe(true);
    // a last edit the slow save does not hold; leaving queues it behind that save
    await page.getByLabel("Use-case name").fill("Ada's confidential idea, second thoughts");

    await page.locator("button[aria-haspopup=menu]").click();
    await page.getByRole("menuitem", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/ui\/login/);
    gw.signInAs = "bob";
    await signIn(page, "bob@example.test");
    await expect(page).toHaveURL(/\/ui\/admin\/governance\/intake$/);

    // the slow save finishes; the exit save queued behind it goes now, under Bob's session
    release();
    await expect.poll(() => gw.draftOwnerRefusals, { message: "the late exit save is refused" }).toBe(1);
    expect(gw.bobDrafts.size, "nothing of Ada's lands in Bob's drafts").toBe(0);
    await expect(page.getByText(/You have a saved draft/)).toHaveCount(0);
    expect(await page.content()).not.toContain("second thoughts");
  });
});
