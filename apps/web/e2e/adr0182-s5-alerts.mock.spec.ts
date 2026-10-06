/**
 * ADR-0182 (ADR-0175 batch D4) S5 — the governance alerts page shows each
 * episode's OWNER, its SLA chip and its WORK ITEM (PF-14), a KRI's SUGGESTED
 * halt with a "Propose halt" action that files nothing until clicked (PF-03),
 * and the admin settings for `alert_sla_hours` and `alert_ticket_mode`; the
 * Monitoring page's KRI editor offers "suggest a halt" for an agent KRI only.
 * Mocked API; axe (WCAG 2.x A/AA) in light and dark on the alerts page.
 */
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";

const AGENT = "55555555-5555-4555-8555-555555555555";
const KRI = "66666666-6666-4666-8666-666666666666";
const OWNER = "77777777-7777-4777-8777-777777777777";
const now = Date.now();
const iso = (h: number) => new Date(now + h * 3_600_000).toISOString();

const base = { acknowledgedAt: null, acknowledgedBy: null, ackNote: null, resolvedAt: null, status: "open" };
const alerts = {
  alerts: [
    {
      ...base,
      id: "halt",
      ruleId: "kri_threshold_breached",
      ruleLabel: "Key risk indicator past its threshold",
      severity: "high",
      subject: { key: `kri:${KRI}`, type: "kri", id: KRI, label: "Claims errors", context: null },
      title: "Claims errors: error rate for agent Claims assistant is 40.0% over 1 day, above the threshold of 5.0%",
      detail: { scope: "agent", scopeId: AGENT, suggestedAction: { kind: "halt_agent", agentId: AGENT } },
      firstDetectedAt: iso(-20),
      lastDetectedAt: iso(-1),
      owner: { id: OWNER, name: "Sam Steward", source: "derived" },
      dueAt: iso(4),
      slaBreachedAt: null,
      sla: "due_soon",
      ticket: null,
    },
    {
      ...base,
      id: "late",
      ruleId: "use_case_vendor_unapproved",
      ruleLabel: "Use case depends on an unapproved vendor",
      severity: "medium",
      subject: { key: "vendor:v", type: "vendor", id: "v", label: "Acme Models", context: null },
      title: "Checkout assistant depends on Acme Models, which is not approved",
      detail: {},
      firstDetectedAt: iso(-100),
      lastDetectedAt: iso(-2),
      owner: null,
      dueAt: iso(-28),
      slaBreachedAt: iso(-27),
      sla: "breached",
      ticket: { connectionId: "c1", connectionName: "Delivery board", externalId: "GOV-12", externalUrl: "https://pm.example.test/GOV-12" },
    },
  ],
  counts: { open: 2, acknowledged: 0, resolved: 0 },
  lastEvaluatedAt: iso(-1),
  rules: [],
};
const remediation = (id: string) =>
  id === "halt"
    ? {
        alert: { id, ruleId: "kri_threshold_breached", status: "open", title: alerts.alerts[0]!.title },
        candidates: [
          {
            kind: "halt_agent",
            executable: true,
            title: "Propose halting Claims assistant",
            rationale: "This KRI is set to suggest a halt of its agent when it breaches.",
            params: { agentId: AGENT },
            steps: [],
          },
        ],
        proposals: [],
        note: "Executable candidates run only after a different human approves them.",
      }
    : { alert: { id, ruleId: "use_case_vendor_unapproved", status: "open", title: "x" }, candidates: [], proposals: [], note: "n" };

interface Captured {
  ownerPuts: unknown[];
  ticketPosts: unknown[];
  remediationPosts: unknown[];
  settingsPuts: unknown[];
  kriPosts: unknown[];
}

async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

async function mockApi(page: Page): Promise<Captured> {
  const cap: Captured = { ownerPuts: [], ticketPosts: [], remediationPosts: [], settingsPuts: [], kriPosts: [] };
  const me = { userId: "u", isAdmin: true, user: { id: "u", email: "admin@example.test", displayName: "Avery Admin" } };
  const settings = { alertSlaHours: { high: 24, medium: 72, low: 168 }, alertTicketMode: "manual" as string };
  await page.route("**/*", async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    if (req.resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    const method = req.method();
    if (p === "/auth/me") return json(route, { ...me, via: "session", mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false });
    if (p === "/v1/me") return json(route, me);
    if (p === "/v1/users") {
      return json(route, {
        users: [
          { id: "u", email: "admin@example.test", displayName: "Avery Admin" },
          { id: "u2", email: "second@example.test", displayName: "Blake Approver" },
          { id: OWNER, email: "steward@example.test", displayName: "Sam Steward" },
        ],
      });
    }
    if (p === "/v1/governance/alerts") return json(route, alerts);
    if (p === "/v1/governance/alerts/halt/remediation" && method === "POST") {
      cap.remediationPosts.push(req.postDataJSON());
      return json(route, { id: "p1", kind: "halt_agent", status: "pending_approval" }, 201);
    }
    if (p === "/v1/governance/alerts/halt/remediation") return json(route, remediation("halt"));
    if (p === "/v1/governance/alerts/late/remediation") return json(route, remediation("late"));
    if (p === "/v1/governance/alerts/halt/owner" && method === "PUT") {
      cap.ownerPuts.push(req.postDataJSON());
      return json(route, { id: "halt", owner: { id: "u2", name: "Blake Approver", source: "assigned" }, dueAt: iso(4), slaBreachedAt: null, sla: "due_soon", ticket: null });
    }
    if (p === "/v1/governance/alerts/halt/ticket" && method === "POST") {
      cap.ticketPosts.push(req.postDataJSON());
      return json(route, { alertId: "halt", created: true, idempotent: false, ticket: { connectionId: "c1", connectionName: "Delivery board", externalId: "GOV-13", externalUrl: "https://pm.example.test/GOV-13" } }, 201);
    }
    if (p === "/v1/pm/connections") return json(route, { connections: [{ id: "c1", name: "Delivery board", provider: "jira" }] });
    if (p === "/v1/org/settings" && method === "PUT") {
      const body = req.postDataJSON() as Record<string, unknown>;
      cap.settingsPuts.push(body);
      Object.assign(settings, body);
      return json(route, { settings });
    }
    if (p === "/v1/org/settings") return json(route, { settings });
    // the Monitoring page
    if (p === "/v1/kris" && method === "POST") {
      cap.kriPosts.push(req.postDataJSON());
      return json(route, { id: KRI }, 201);
    }
    if (p === "/v1/kris") return json(route, { kris: [], metrics: [], measuredAt: iso(0), note: "n" });
    if (p === "/v1/monitoring/series") {
      return json(route, { metric: "trace_volume", unit: "traces", bucket: "day", bucketMs: 86_400_000, groupBy: "none", groups: [], points: [], folded: 0, otherIsApproximate: false });
    }
    if (p === "/v1/monitoring/dashboards") return json(route, { dashboards: [] });
    if (p === "/v1/agents") return json(route, { agents: [{ id: AGENT, name: "Claims assistant", provider: "mock", tier: 1 }] });
    if (p === "/v1/projects") return json(route, { projects: [{ id: "p", name: "Claims" }] });
    return json(route, {});
  });
  return cap;
}

const THEMES = ["light", "dark"] as const;
async function expectAxeClean(page: Page, label: string) {
  for (const theme of THEMES) {
    await page.evaluate(async (next) => {
      document.documentElement.dataset.theme = next;
      localStorage.setItem("regulait.theme", next);
      await Promise.race([
        Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined))),
        new Promise((r) => setTimeout(r, 1000)),
      ]);
    }, theme);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
    const summary = results.violations.map((v) => `${v.id} (${v.impact}) — ${v.help}\n    ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join("\n    ")}`);
    expect(summary, `axe on "${label}" (${theme})`).toEqual([]);
  }
}

test.describe("ADR-0182 S5: governance alerts — owner, SLA, ticket and the suggested halt", () => {
  test("the list shows the SLA chips and owners; a KRI's suggestion files nothing until a person proposes it", async ({ page }) => {
    const cap = await mockApi(page);
    await page.goto("/ui/admin/governance/alerts");
    const halt = page.getByRole("button", { name: /Claims errors: error rate/ });
    await expect(halt).toContainText("SLA due soon");
    await expect(halt).toContainText("owner Sam Steward");
    const late = page.getByRole("button", { name: /depends on Acme Models/ });
    await expect(late).toContainText("SLA breached");
    await expect(late).toContainText("unowned");

    await halt.click();
    const detail = page.getByTestId("alert-detail");
    await expect(detail.getByTestId("suggested-halt")).toContainText("Nothing has been filed");
    await expect(detail.getByTestId("alert-ownership")).toContainText("Sam Steward");
    await expect(detail.getByTestId("alert-ownership")).toContainText("derived from the subject");
    // nothing was filed by opening the alert
    expect(cap.remediationPosts).toEqual([]);

    const propose = detail.getByRole("button", { name: "Propose halt" });
    await expect(propose).toBeDisabled(); // an independent approver must be named first
    await detail.getByLabel("Independent approver").selectOption("u2");
    await propose.click();
    await expect.poll(() => cap.remediationPosts).toEqual([{ kind: "halt_agent", params: { agentId: AGENT }, approverUserId: "u2" }]);
    await expectAxeClean(page, "alerts with a suggested halt");
  });

  test("an admin reassigns the owner and files one work item", async ({ page }) => {
    const cap = await mockApi(page);
    await page.goto("/ui/admin/governance/alerts");
    await page.getByRole("button", { name: /Claims errors: error rate/ }).click();
    const own = page.getByTestId("alert-ownership");
    await own.getByLabel("Assign to").selectOption("u2");
    await own.getByRole("button", { name: "Assign" }).click();
    await expect.poll(() => cap.ownerPuts).toEqual([{ userId: "u2" }]);
    await own.getByLabel("PM connection").selectOption("c1");
    await own.getByRole("button", { name: "File work item" }).click();
    await expect.poll(() => cap.ticketPosts).toEqual([{ connectionId: "c1" }]);

    // an episode already filed shows its item and offers no second one
    await page.getByRole("button", { name: /depends on Acme Models/ }).click();
    const filed = page.getByTestId("alert-ticket");
    await expect(filed.getByRole("link", { name: "GOV-12" })).toHaveAttribute("href", "https://pm.example.test/GOV-12");
    await expect(page.getByRole("button", { name: "File work item" })).toHaveCount(0);
  });

  test("the settings show the strict defaults and write through the audited org settings", async ({ page }) => {
    const cap = await mockApi(page);
    await page.goto("/ui/admin/governance/alerts");
    const card = page.getByTestId("alert-settings");
    await expect(card).toContainText("24 hours for high, 72 for medium, 168 for low");
    await expect(card.getByText("strict default", { exact: true })).toHaveCount(2);
    await card.getByLabel("High (hours)").fill("48");
    await card.getByRole("button", { name: "Save SLA" }).click();
    await expect.poll(() => cap.settingsPuts).toEqual([{ alertSlaHours: { high: 48, medium: 72, low: 168 } }]);
    await expect(card.getByText("relaxed", { exact: true })).toHaveCount(1);
    await card.getByLabel("Filing").selectOption("auto_high");
    await expect.poll(() => cap.settingsPuts.length).toBe(2);
    expect(cap.settingsPuts[1]).toEqual({ alertTicketMode: "auto_high" });
    await expect(card).toContainText("for every new high episode");
    await expectAxeClean(page, "alerts settings, relaxed");
  });
});

test.describe("ADR-0182 S5: the KRI editor's breach action", () => {
  test("only an agent KRI can suggest a halt, and the suggestion is sent", async ({ page }) => {
    const cap = await mockApi(page);
    await page.goto("/ui/admin/monitoring");
    await page.getByRole("button", { name: /New KRI/ }).click();
    const breach = page.getByLabel("When it breaches");
    await expect(breach).toBeDisabled(); // fleet scope by default
    await expect(page.getByTestId("kri-on-breach-note")).toContainText("Only a KRI on one agent can suggest a halt");
    await page.getByLabel("KRI name").fill("Claims errors");
    await page.getByLabel("Scope").selectOption("agent");
    await page.getByLabel("Agent").selectOption(AGENT);
    await page.getByLabel("Threshold").fill("5");
    await breach.selectOption("propose_halt");
    await expect(page.getByTestId("kri-on-breach-note")).toContainText("Nothing is filed and nothing stops on its own");
    await page.getByRole("button", { name: "Create KRI" }).click();
    await expect.poll(() => cap.kriPosts.length).toBe(1);
    expect(cap.kriPosts[0]).toMatchObject({ scope: "agent", scopeId: AGENT, onBreach: "propose_halt" });
  });
});
