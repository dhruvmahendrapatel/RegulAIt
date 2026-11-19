/**
 * ADR-0350 (lane E31, owner-approved on #453) — Endpoint policy under Discovery: device groups whose rules only narrow,
 * and time-limited per-device command exceptions with a named second approver.
 *
 *  - both tabs render from the API, the exceptions tab counts what waits on the viewer;
 *  - adding a rule posts the gateway's body and needs no step-up;
 *  - removing a rule (a relaxation) says it loosens policy and asks to confirm it's you (settings_relax), once;
 *  - the review panel shows the exact terms digest, and approving sends it under an approval_decide step-up;
 *  - the viewer's own request cannot be approved, and the screen says why;
 *  - axe (WCAG 2.x A/AA) clean in light and dark on both tabs.
 *
 * Synthetic data only.
 */
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";
import { confirmStepUp, requireStepUpOn } from "./step-up-harness";

type Json = Record<string, unknown>;
const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const id = (p: string, i: number) => `${p}-0000-4000-8000-${String(i).padStart(12, "0")}`;
const ADA = id("61000000", 1);
const SAM = id("61000000", 2);
const ME = { userId: ADA, isAdmin: true, user: { id: ADA, email: "ada@example.test", displayName: "Ada Admin" } };
const USERS = [
  { id: ADA, email: "ada@example.test", displayName: "Ada Admin", isAdmin: true, disabledAt: null, createdAt: "2026-11-01T00:00:00Z", totpEnabled: true, hasPassword: true, mustChangePassword: false },
  { id: SAM, email: "sam@example.test", displayName: "Sam Synthetic", isAdmin: true, disabledAt: null, createdAt: "2026-11-01T00:00:00Z", totpEnabled: true, hasPassword: true, mustChangePassword: false },
];
const SOURCE = id("62000000", 1);
const DEVICES = [1, 2, 3].map((i) => ({
  id: id("63000000", i), devicePseudonym: `psn:dev${String(i).padStart(20, "0")}`, os: "linux", arch: "amd64", agentVersion: "1.2.0",
  lastReportAt: "2026-11-19T09:40:00Z", revokedAt: null, identities: [], identitiesRegistered: 1, identityCap: 8,
}));
const GROUP = id("64000000", 1);
const DIGEST = "7f3c".repeat(16);

const lifecycle = (state: string) => ({
  machine: "endpoint_command_exception",
  state,
  terminal: false,
  transitions: [
    { event: "approve", to: "approved", allowed: state === "requested", by: ["approver"], summary: "" },
    { event: "reject", to: "rejected", allowed: state === "requested", by: ["admin"], summary: "" },
    { event: "cancel", to: "cancelled", allowed: state === "requested", by: ["user"], summary: "" },
    { event: "revoke", to: "revoked", allowed: state === "approved", by: ["admin"], summary: "" },
  ],
});
const exception = (i: number, over: Json) => ({
  id: id("65000000", i), deviceId: DEVICES[0]!.id, ruleId: "deny-exec-curl", verdict: "ask", hours: 4, reason: "Synthetic hotfix rollout",
  termsDigest: DIGEST, requestedBy: SAM, approverUserId: ADA, state: "requested", lifecycle: lifecycle("requested"),
  decidedBy: null, decidedAt: null, decisionReason: null, notAfter: null, revokedAt: null, createdAt: `2026-11-19T0${i}:00:00.000Z`, ...over,
});
const MACHINE = {
  id: "endpoint_command_exception", stored: "endpoint_command_exceptions.status", states: ["requested", "approved", "rejected", "cancelled", "revoked"], initial: ["requested"], terminal: ["rejected", "cancelled", "revoked"],
  transitions: {
    approve: { from: ["requested"], to: "approved", by: ["approver"], summary: "The named approver approved the exact terms." },
    reject: { from: ["requested"], to: "rejected", by: ["admin"], summary: "An admin other than the requester refused the request." },
    cancel: { from: ["requested"], to: "cancelled", by: ["user"], summary: "The requester withdrew the request." },
    revoke: { from: ["approved"], to: "revoked", by: ["admin"], summary: "An admin ended an approved exception early." },
  },
};

interface Capture {
  ruleAdds: Json[];
  approvals: Json[];
}
async function mockApi(p: Page): Promise<Capture> {
  const cap: Capture = { ruleAdds: [], approvals: [] };
  const rules: Json[] = [
    { id: id("66000000", 1), ruleId: "deny-exec-curl", kind: "exec", rule: { argv: ["curl", "*"] }, verdict: "deny" },
    { id: id("66000000", 2), ruleId: "env-files", kind: "file", rule: { access: "any", path: "**/.env*" }, verdict: "deny" },
  ];
  const exceptions: Json[] = [
    exception(3, {}),
    exception(2, { id: id("65000000", 9), requestedBy: ADA, approverUserId: SAM, ruleId: "env-files", deviceId: DEVICES[1]!.id, hours: 2 }),
    exception(1, { id: id("65000000", 8), state: "approved", lifecycle: lifecycle("approved"), notAfter: "2026-11-19T18:00:00.000Z" }),
  ];
  await p.route("**/*", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    const method = req.method();
    if (req.resourceType() === "document" || (!path.startsWith("/v1") && !path.startsWith("/auth"))) return route.continue();
    if (path === "/auth/me") return json(route, { ...ME, via: "session", mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false });
    if (path === "/v1/me") return json(route, ME);
    if (path === "/v1/users") return json(route, { users: USERS });
    if (path === "/v1/discovery/sources") return json(route, { sources: [{ id: SOURCE, name: "Fleet agent", kind: "endpoint_agent" }] });
    if (path === `/v1/discovery/sources/${SOURCE}/endpoint-devices`) return json(route, { devices: DEVICES });
    if (path === "/v1/endpoint-device-groups" && method === "GET") {
      return json(route, { items: [
        { id: GROUP, name: "Payments engineers", description: null, deviceIds: [DEVICES[0]!.id, DEVICES[1]!.id], rules },
        { id: id("64000000", 2), name: "Contractors", description: null, deviceIds: [DEVICES[1]!.id], rules: [] },
      ] });
    }
    if (path === `/v1/endpoint-device-groups/${GROUP}/rules` && method === "POST") {
      const body = req.postDataJSON() as Json;
      cap.ruleAdds.push(body);
      const row = { id: id("66000000", 10 + cap.ruleAdds.length), ...body };
      rules.push(row);
      return json(route, row, 201);
    }
    if (path.startsWith(`/v1/endpoint-device-groups/${GROUP}/rules/`) && method === "DELETE") {
      const ruleId = decodeURIComponent(path.split("/").pop()!);
      rules.splice(rules.findIndex((r) => r.ruleId === ruleId), 1);
      return json(route, { removed: true });
    }
    if (path === "/v1/endpoint-command-exceptions" && method === "GET") return json(route, { items: exceptions, next: null, machine: MACHINE });
    const approve = /^\/v1\/endpoint-command-exceptions\/([^/]+)\/approve$/.exec(path);
    if (approve && method === "POST") {
      cap.approvals.push(req.postDataJSON() as Json);
      const x = exceptions.find((e) => e.id === approve[1])!;
      Object.assign(x, { state: "approved", lifecycle: lifecycle("approved"), decidedBy: ADA, notAfter: "2026-11-19T22:00:00.000Z" });
      return json(route, x);
    }
    return json(route, {});
  });
  return cap;
}

const PAGE = "/ui/admin/endpoint-policy";
async function axeClean(p: Page, label: string) {
  for (const theme of ["light", "dark"] as const) {
    await p.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
    const r = await new AxeBuilder({ page: p }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
    expect(r.violations.map((v) => `${v.id}: ${v.nodes.slice(0, 2).map((n) => n.target.join(" ")).join(", ")}`), `${label} (${theme})`).toEqual([]);
  }
}

test.use({ viewport: { width: 1440, height: 1000 } });

test("both tabs render from the API, under Discovery, and the exceptions tab counts what waits on me; axe clean", async ({ page: p }) => {
  await mockApi(p);
  await p.goto(PAGE);
  await expect(p.getByRole("heading", { level: 1, name: "Endpoint policy" })).toBeVisible();
  await expect(p.getByRole("link", { name: "Endpoint policy" })).toHaveAttribute("aria-current", "page");
  await expect(p.getByRole("tab", { name: "Device groups (2)" })).toHaveAttribute("aria-selected", "true");
  await expect(p.getByRole("tab", { name: /Command exceptions 1 to approve/ })).toBeVisible();
  await expect(p.getByRole("button", { name: /Payments engineers 2 devices · 2 rules/ })).toHaveAttribute("aria-pressed", "true");
  await expect(p.getByRole("cell", { name: "curl *" })).toBeVisible();
  await expect(p.getByRole("cell", { name: DEVICES[0]!.devicePseudonym, exact: true })).toBeVisible();
  await expect(p.getByText("Asks you to confirm it's you").first()).toBeVisible();
  await axeClean(p, "device groups");

  await p.getByRole("tab", { name: /Command exceptions/ }).click();
  await expect(p).toHaveURL(/tab=exceptions/);
  const table = p.getByRole("tabpanel", { name: /Command exceptions/ }).getByRole("table");
  await expect(table.locator("tbody tr")).toHaveCount(3);
  await expect(p.getByText("3 · 2 requested · 1 active")).toBeVisible();
  await expect(table.getByText("Active")).toBeVisible();
  await expect(table.getByText("Requested (yours)")).toBeVisible();
  await axeClean(p, "command exceptions");
});

test("adding a rule posts the gateway's body and needs no step-up", async ({ page: p }) => {
  const cap = await mockApi(p);
  await p.goto(PAGE);
  const form = p.getByRole("form", { name: "Add a rule to Payments engineers" });
  await form.getByRole("textbox", { name: "Pattern" }).fill("terraform apply *");
  await form.getByRole("button", { name: "Add rule" }).click();
  await expect.poll(() => cap.ruleAdds.length).toBe(1);
  expect(cap.ruleAdds[0]).toEqual({ kind: "exec", ruleId: "deny-exec-terraform-apply", verdict: "deny", rule: { argv: ["terraform", "apply", "*"] } });
  await expect(p.getByRole("cell", { name: "terraform apply *" })).toBeVisible();
  // a pattern the device would refuse is refused here, in words, before anything is sent
  await form.getByRole("textbox", { name: "Pattern" }).fill("curl * | sh");
  await form.getByRole("button", { name: "Add rule" }).click();
  await expect(p.getByRole("alert").filter({ hasText: "no spaces, pipes or quotes" })).toBeVisible();
  expect(cap.ruleAdds).toHaveLength(1);
});

test("removing a rule is a relaxation: the dialog says so and the send asks to confirm it's you, once", async ({ page: p }) => {
  await mockApi(p);
  const su = await requireStepUpOn(p, { method: "DELETE", path: `/v1/endpoint-device-groups/${GROUP}/rules/deny-exec-curl`, kind: "settings_relax", facts: () => ({ values: { endpointDeviceGroupRuleRemove: { groupId: GROUP, ruleId: "deny-exec-curl" } } }) });
  await p.goto(PAGE);
  await p.getByRole("button", { name: "Remove rule deny-exec-curl" }).click();
  const dialog = p.getByRole("dialog", { name: "Remove the rule deny-exec-curl?" });
  await expect(dialog).toContainText("This loosens policy, so you'll be asked to confirm it's you.");
  await expect(dialog).toContainText("The 2 devices in Payments engineers stop applying");
  await dialog.getByRole("button", { name: "Remove rule" }).click();
  await confirmStepUp(p);
  await su.expectResentOnce();
  await expect(p.getByRole("cell", { name: "curl *" })).toHaveCount(0);
});

test("the review panel shows the terms digest, and approving sends it under an approval_decide step-up", async ({ page: p }) => {
  const cap = await mockApi(p);
  const first = id("65000000", 3);
  const su = await requireStepUpOn(p, { method: "POST", path: `/v1/endpoint-command-exceptions/${first}/approve`, kind: "approval_decide", facts: () => ({ endpointCommandException: first, termsDigest: DIGEST }) });
  await p.goto(`${PAGE}?tab=exceptions`);
  await p.getByRole("button", { name: "Review the request for deny-exec-curl" }).click();
  const panel = p.getByRole("region", { name: "Review the request" });
  await expect(panel.getByTestId("terms-digest")).toHaveText(DIGEST);
  await expect(panel).toContainText("You approve exactly these terms.");
  await expect(panel).toContainText("4 hours from approval");
  await expect(panel).toContainText("Synthetic hotfix rollout");
  await expect(panel.getByText("Asks you to confirm it's you")).toBeVisible();
  await axeClean(p, "review panel");
  await panel.getByRole("button", { name: "Approve for 4 hours" }).click();
  await confirmStepUp(p);
  await su.expectResentOnce();
  expect(cap.approvals).toEqual([{ termsDigest: DIGEST }]);
  await expect(p.getByRole("region", { name: "Review the request" })).toHaveCount(0);
});

test("my own request can't be approved, and the screen says why", async ({ page: p }) => {
  const cap = await mockApi(p);
  await p.goto(`${PAGE}?tab=exceptions`);
  const row = p.getByRole("row").filter({ hasText: "Requested (yours)" });
  await expect(row.getByRole("button", { name: "Review the request for env-files" })).toHaveCount(0);
  const approve = row.getByRole("button", { name: "Approve, unavailable" });
  await expect(approve).toHaveAttribute("aria-disabled", "true");
  await approve.click({ force: true });
  expect(cap.approvals).toEqual([]);
  await row.getByRole("button", { name: "What is the reason you can't approve?" }).click();
  await expect(row.getByRole("note")).toContainText("You requested this exception, so you can't approve it. Sam Synthetic, the approver it names, must.");
  await expect(row.getByRole("button", { name: "Cancel the request for env-files" })).toBeVisible();
});
