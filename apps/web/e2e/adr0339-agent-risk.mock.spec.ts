/**
 * ADR-0339 — the agent risk and agent identity screens, against a mocked gateway:
 *
 *  - the ranked list shows each agent's band and score, counts the agents not yet scored, and "Recompute now" runs the
 *    sweep and says what it did;
 *  - the ownership findings are read through the shared list control with the chosen filter;
 *  - one agent's page shows the score, the ranked fixes, a held combination's legs and its ranked ways to break it
 *    (read-only: no control changes anything there), every factor and the history;
 *  - identity: author, owner and runner; staging a link is checked in the browser first, then sent as a plain POST; a
 *    decision is confirmed, then goes through the step-up prompt (identity_manage) and is resent once, unchanged;
 *  - axe (WCAG 2.x A/AA) in light and dark on both pages.
 */
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";
import { confirmStepUp, requireStepUpOn } from "./step-up-harness";

const AG = "44444444-4444-4444-8444-444444444444";
const AG2 = "55555555-5555-4555-8555-555555555555";
const LINK = "66666666-6666-4666-8666-666666666666";
const TOOL = "77777777-7777-4777-8777-777777777777";
const THEMES = ["light", "dark"] as const;
const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

async function expectAxeClean(page: Page, label: string) {
  for (const theme of THEMES) {
    await page.evaluate(async (next) => {
      document.documentElement.dataset.theme = next;
      await Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined)));
    }, theme);
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
    const summary = results.violations.map((v) => `${v.id} (${v.impact}) — ${v.help}\n    ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join("\n    ")}`);
    expect(summary, `axe on "${label}" (${theme})`).toEqual([]);
  }
}

const fix = { title: "Remove the destructive tool", link: { to: "/admin/agents", label: "Open the agent" } };
const assessment = {
  estimate: true,
  methodVersion: "adr0339-v3",
  subject: { kind: "agent", id: AG, name: "refund-bot" },
  score: 82,
  band: "critical",
  scale: { min: 0, max: 100 },
  exposure: 63,
  reach: { people: 14, dependents: 2, multiplier: 1.3, label: "reaches 11 to 50 people or dependents", detail: "14 people may run it; 2 agents depend on it." },
  factors: [
    { id: "autonomy", title: "Acts without a person in the loop", owasp: ["LLM06"], present: true, points: 12, max: 12, evidence: "Autonomy is autonomous.", fix },
    { id: "guardrails", title: "Prompt-injection guardrail off", owasp: ["LLM01"], present: false, points: 0, max: 10, evidence: "Both guardrails block.", fix },
  ],
  toxicCombinations: [
    {
      id: "lethal_trifecta",
      title: "Private data, untrusted content and a way out",
      owasp: ["LLM01", "LLM02"],
      present: true,
      points: 20,
      evidence: "It reads customer records, reads web pages and can send email.",
      fix,
      legs: [
        { id: "private_data", label: "Private data", members: [{ kind: "connector", id: "c1", name: "CRM", why: "reads records" }] },
        { id: "untrusted_content", label: "Untrusted content", members: [{ kind: "mcp_tool", id: TOOL, name: "fetch_page", why: "an untrusted source" }] },
        { id: "external_communication", label: "External communication", members: [{ kind: "mcp_tool", id: "t2", name: "send_email", why: "reaches the open world" }] },
      ],
      fixOptions: [
        { rank: 1, action: "remove", leg: "private_data", targets: [{ kind: "connector", id: "c1", name: "CRM" }], cost: 1, sharedWith: 0, title: "Remove the private data leg: CRM" },
        { rank: 2, action: "remove", leg: "external_communication", targets: [{ kind: "mcp_tool", id: "t2", name: "send_email" }], cost: 1, sharedWith: 3, title: "Remove the external communication leg: send_email" },
      ],
    },
    { id: "sod_rule_held_by_agent", title: "Holds both sides of a separation-of-duties rule", owasp: ["LLM06"], present: false, points: 0, evidence: "No rule is held on both sides.", fix },
  ],
  fixes: [{ rank: 1, source: "lethal_trifecta", title: "Break the lethal trifecta", points: 20, owasp: ["LLM01"], link: { to: "/admin/agents", label: "Open the agent" } }],
  owaspExposure: ["LLM01", "LLM02", "LLM06"],
  method: "Points per factor, plus combinations, times reach.",
  disclaimer: "An estimate for ranking, not a certification.",
  latestAssessment: { id: "a1", score: 80, band: "critical", computedAt: "2026-11-20T00:00:00Z", triggers: ["access_changed"], methodVersion: "adr0339-v3" },
  recomputePending: false,
};

interface State {
  sweeps: unknown[];
  stages: unknown[];
  findingsQueries: string[];
}

async function mock(page: Page): Promise<State> {
  const state: State = { sweeps: [], stages: [], findingsQueries: [] };
  const links: Record<string, unknown>[] = [
    { id: LINK, kind: "cloud_service_account", provider: "aws", externalId: "arn:aws:iam::123456789012:role/refund-runner", status: "staged", source: "admin", note: null, stagedByUserId: "sam", stagedAt: "2026-11-20T00:00:00Z", decidedByUserId: null, decidedAt: null, decisionNote: null },
  ];
  const me = { id: "riley", email: "riley@example.test", displayName: "Riley Admin" };
  await page.route("**/*", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname;
    if (req.resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    const m = req.method();
    if (p === "/auth/me") return json(route, { userId: me.id, isAdmin: true, via: "session", user: me, mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false });
    if (p === "/v1/me") return json(route, { userId: me.id, isAdmin: true, user: me });
    if (p === "/v1/users") return json(route, { users: [{ id: "sam", email: "sam@example.test", displayName: "Sam Owner" }] });
    if (p === "/v1/agent-risk" && m === "GET") {
      const items = url.searchParams.get("kind") === "agent" ? [{ id: AG, name: "refund-bot", score: 82, band: "critical", computedAt: "2026-11-20T00:00:00Z", assessmentId: "a1" }, { id: AG2, name: "faq-bot", score: 12, band: "low", computedAt: "2026-11-20T00:00:00Z", assessmentId: "a2" }] : [];
      return json(route, { kind: url.searchParams.get("kind"), items, unscored: 3, nextCursor: null, limit: 50, methodVersion: "adr0339-v3" });
    }
    if (p === "/v1/agent-risk/recompute" && m === "POST") {
      state.sweeps.push(req.postDataJSON());
      return json(route, { scored: 3, dropped: 0, failed: 0, changed: 1 });
    }
    if (p === "/v1/agent-identity/ownership-findings") {
      state.findingsQueries.push(url.search);
      return json(route, { items: [{ kind: "agent", id: AG2, name: "faq-bot", ownerUserId: "sam", flag: "inactive", ownerLastActiveAt: "2026-06-01T00:00:00Z" }], total: 1, nextCursor: null, limit: 10 });
    }
    if (p === `/v1/agent-risk/agent/${AG}`) return json(route, assessment);
    if (p === `/v1/agent-risk/agent/${AG}/history`) {
      return json(route, { items: [{ id: "a1", score: 80, band: "critical", triggers: ["access_changed"], methodVersion: "adr0339-v3", assessment: { score: 80 }, computedAt: "2026-11-20T00:00:00Z" }], nextCursor: null, limit: 20 });
    }
    if (p === `/v1/agent-identity/agent/${AG}`) {
      return json(route, {
        subject: { kind: "agent", id: AG, name: "refund-bot" },
        author: { source: "principal", userId: "sam", displayName: "Sam Owner", vendorCreatorPseudonym: null, recordedAt: "2026-11-01T00:00:00Z" },
        ownership: { flag: "owned", ownerUserId: "sam", ownerLastActiveAt: "2026-11-19T00:00:00Z", inactiveAfterDays: 90 },
        runner: { workloadIdentity: { id: "w1", identifier: "agent:refund-bot", status: "active" }, invokers: [{ userId: "sam", displayName: "Sam Owner", calls: 42 }], moreInvokers: false, windowDays: 30 },
        nonHumanIdentities: links,
      });
    }
    if (p === `/v1/agent-identity/agent/${AG}/links` && m === "POST") {
      state.stages.push(req.postDataJSON());
      return json(route, { id: "88888888-8888-4888-8888-888888888888" }, 201);
    }
    if (p === `/v1/agent-identity/links/${LINK}/decision` && m === "POST") {
      Object.assign(links[0]!, { status: "confirmed", decidedAt: "2026-11-21T00:00:00Z", decidedByUserId: "riley" });
      return json(route, links[0]);
    }
    if (m === "GET") return json(route, {});
    return json(route, { error: "not_found" }, 404);
  });
  return state;
}

test.describe("ADR-0339: agent risk and identity", () => {
  test("ranks agents, counts the unscored, recomputes, and lists ownership findings", async ({ page }) => {
    const state = await mock(page);
    await page.goto("/ui/admin/agent-risk");
    await expect(page.getByRole("heading", { name: "Agent risk" })).toBeVisible();
    await expect(page.getByRole("link", { name: "refund-bot" })).toBeVisible();
    await expect(page.getByText("Critical").first()).toBeVisible();
    await expect(page.getByText("3 agents are not scored yet")).toBeVisible();
    await expect(page.getByRole("cell", { name: "Owner inactive" })).toBeVisible();
    await expect.poll(() => state.findingsQueries.some((q) => q.includes("kind=agent"))).toBe(true);
    await expectAxeClean(page, "agent risk");
    await page.getByRole("combobox", { name: "Show" }).selectOption("orphaned");
    await expect.poll(() => state.findingsQueries.some((q) => q.includes("flag=orphaned"))).toBe(true);
    await page.getByRole("button", { name: "Recompute now" }).click();
    await expect.poll(() => state.sweeps).toEqual([{}]);
    await expect(page.getByText("Recompute finished: 3 scored, 1 changed band or score.").first()).toBeVisible();
  });

  test("shows one agent's score, a held combination read-only, its identity, and decides a link through step-up", async ({ page }) => {
    const state = await mock(page);
    const su = await requireStepUpOn(page, { method: "POST", path: `/v1/agent-identity/links/${LINK}/decision`, kind: "identity_manage" });
    await page.goto(`/ui/admin/agent-risk/agent/${AG}`);
    await expect(page.getByRole("heading", { name: "refund-bot" })).toBeVisible();
    await expect(page.getByText("Reach: reaches 11 to 50 people or dependents")).toBeVisible();
    await expect(page.getByText("fetch_page")).toBeVisible();
    await expect(page.getByText("Remove the private data leg: CRM")).toBeVisible();
    await expect(page.getByText("(3 holdings by other agents)")).toBeVisible();
    // the ways to break it are read-only: no control on the page applies one
    await expect(page.getByRole("button", { name: /^(Remove|Turn Ask-first|Apply)/ })).toHaveCount(0);
    await expect(page.getByText("Not held")).toBeVisible();
    await expect(page.getByText("Recomputed by an admin")).toHaveCount(0);
    await expect(page.getByText("Access changed").first()).toBeVisible();
    await expect(page.getByText("Sam Owner (42 calls)")).toBeVisible();
    await expectAxeClean(page, "agent risk detail");

    const form = page.getByRole("form", { name: "Link an identity" });
    await form.getByRole("textbox", { name: "Identifier" }).fill("not-an-arn");
    await form.getByRole("button", { name: "Stage link" }).click();
    await expect(form.getByText(/That is not an identifier AWS issues/)).toBeVisible();
    expect(state.stages).toEqual([]);
    await form.getByRole("textbox", { name: "Identifier" }).fill("arn:aws:iam::123456789012:role/refund-reader");
    await form.getByRole("button", { name: "Stage link" }).click();
    await expect.poll(() => state.stages).toEqual([{ kind: "cloud_service_account", provider: "aws", externalId: "arn:aws:iam::123456789012:role/refund-reader" }]);

    await page.getByRole("button", { name: "Confirm arn:aws:iam::123456789012:role/refund-runner" }).click();
    const dialog = page.getByRole("dialog", { name: "Confirm arn:aws:iam::123456789012:role/refund-runner?" });
    await expectAxeClean(page, "link decision");
    await dialog.getByRole("button", { name: "Confirm link" }).click();
    await confirmStepUp(page);
    await su.expectResentOnce();
    expect(su.attempts[0]!.body).toEqual({ decision: "confirmed" });
    await expect(page.getByText("Link confirmed.").first()).toBeVisible();
  });
});
