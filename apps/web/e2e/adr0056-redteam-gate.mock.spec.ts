/**
 * ADR-0056 §5 amendment — the copilot narrator red-team gate card on the Copilot page, against a mocked gateway:
 *
 *  - the card reads `GET /v1/copilot/redteam-gate` and states the gate in one line;
 *  - a tightening change is sent as a plain PUT with only the changed fields, and no step-up;
 *  - a loosening change names what it loosens, then goes through the step-up prompt (settings_relax) and is resent
 *    once, unchanged;
 *  - "Check an agent" reads `?agentId=` only once an agent is chosen, and shows the verdict and the deciding run;
 *  - axe (WCAG 2.x A/AA) in light and dark on the card and the confirmation.
 */
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";
import { confirmStepUp, requireStepUpOn } from "./step-up-harness";

const LIB = "11111111-1111-4111-8111-111111111111";
const AGENT = "33333333-3333-4333-8333-333333333333";
const RUN = "44444444-4444-4444-8444-444444444444";
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

interface GateMock {
  puts: Array<{ body: unknown; stepUp: string | null }>;
  agentReads: string[];
}

async function mockGateway(page: Page): Promise<GateMock> {
  const state: GateMock = { puts: [], agentReads: [] };
  let settings = { enabled: true, maxAgeDays: 30, minResistRate: 1, libraryId: LIB, minTrials: 3, requiredClasses: ["prompt_injection", "indirect_prompt_injection", "data_exfiltration", "pii_leak"] };
  const me = { id: "riley", email: "riley@example.test", displayName: "Riley Admin" };
  await page.route("**/*", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname;
    if (req.resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    const m = req.method();
    if (p === "/auth/me") return json(route, { userId: me.id, isAdmin: true, via: "session", user: me, mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false });
    if (p === "/v1/me") return json(route, { userId: me.id, isAdmin: true, user: me });
    if (p === "/v1/copilot/redteam-gate" && m === "GET") {
      const agentId = url.searchParams.get("agentId");
      if (!agentId) return json(route, { settings });
      state.agentReads.push(agentId);
      return json(route, { settings, agentId, verdict: { allowed: false, runId: RUN, reason: "The deciding run resisted 80% of data_exfiltration probes; the floor is 100%." } });
    }
    if (p === "/v1/copilot/redteam-gate" && m === "PUT") {
      const body = req.postDataJSON() as Record<string, unknown>;
      state.puts.push({ body, stepUp: req.headers()["x-regulait-step-up"] ?? null });
      settings = { ...settings, ...body };
      return json(route, settings);
    }
    if (p === "/v1/redteam/libraries" && m === "GET") {
      return json(route, {
        libraries: [
          { id: LIB, name: "Copilot narrator", version: 2, status: "published" },
          { id: "55555555-5555-4555-8555-555555555555", name: "Draft probes", version: 1, status: "draft" },
        ],
        note: "",
      });
    }
    if (p === "/v1/agents" && m === "GET") return json(route, { agents: [{ id: AGENT, name: "Narrator agent", provider: "anthropic", tier: 1, model: "m", enabled: true, costPerMTokIn: null, costPerMTokOut: null }] });
    if (m === "GET") return json(route, {});
    return json(route, { error: "not_found" }, 404);
  });
  return state;
}

test.describe("ADR-0056 §5: the narrator red-team gate card", () => {
  test("states the gate, sends a tightening as a plain PUT, and a loosening through the step-up prompt", async ({ page }) => {
    const state = await mockGateway(page);
    const su = await requireStepUpOn(page, {
      method: "PUT",
      path: "/v1/copilot/redteam-gate",
      kind: "settings_relax",
      when: (b) => (b as { maxAgeDays?: number }).maxAgeDays === 90,
    });
    await page.goto("/ui/admin/copilot");
    const card = page.getByRole("form", { name: "Narrator red-team gate settings" });
    await expect(card.getByText("Gate on", { exact: true })).toBeVisible();
    // only a published library is offered
    await expect(card.getByLabel("Deciding library").locator("option")).toHaveText(["None chosen (no agent may narrate)", "Copilot narrator v2"]);
    await expectAxeClean(page, "narrator red-team gate card");

    // tighten: fewer days, no prompt
    await card.getByRole("textbox", { name: "Window (days)" }).fill("14");
    await card.getByRole("button", { name: "Save gate settings" }).click();
    await expect.poll(() => state.puts.length).toBe(1);
    expect(state.puts[0]).toEqual({ body: { maxAgeDays: 14 }, stepUp: null });
    await expect(page.getByText("Narrator red-team gate saved").first()).toBeVisible();

    // loosen: a longer window is named, then confirmed with step-up
    await card.getByRole("textbox", { name: "Window (days)" }).fill("90");
    await card.getByRole("button", { name: "Save gate settings" }).click();
    const confirm = page.getByRole("dialog", { name: "Loosen the narrator red-team gate?" });
    await expect(confirm.getByText("accepts older runs (up to 90 days)")).toBeVisible();
    await expectAxeClean(page, "loosen confirmation");
    await confirm.getByRole("button", { name: "Save and confirm it's me" }).click();
    await confirmStepUp(page);
    await su.expectResentOnce();
    expect(su.attempts[1]!.body).toEqual({ maxAgeDays: 90 });
  });

  test("checks one agent only once it is chosen, and shows the verdict and the deciding run", async ({ page }) => {
    const state = await mockGateway(page);
    await page.goto("/ui/admin/copilot");
    const check = page.getByRole("region", { name: "Check an agent" });
    await expect(check.getByText("Choose an agent to see whether it may narrate now.")).toBeVisible();
    expect(state.agentReads).toEqual([]);
    await check.getByLabel("Agent").selectOption(AGENT);
    await expect(check.getByText("Held", { exact: true })).toBeVisible();
    await expect(check.getByText(/resisted 80% of data_exfiltration probes/)).toBeVisible();
    await expect(check.getByText(`Decided by red-team run ${RUN}.`)).toBeVisible();
    expect(state.agentReads).toEqual([AGENT]);
  });
});
