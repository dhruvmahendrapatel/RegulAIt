/**
 * ADR-0190 slice I9: the isolation UI on the real Engines, MCP servers and
 * agent builder pages, against HTTP mocks shaped like the gateway today:
 *  - `/v1/org/settings` and `/v1/executors` are built (I1, I3);
 *  - `/v1/execution-profiles` and `/v1/execution-placements` answer 501 (I2);
 *  - no route assigns a profile to an agent or an MCP server.
 */
import { expect, test, type Page, type Route } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { installBuilderMock } from "./builder-fixtures";
import { installEnginesMock } from "./engines-fixtures";
import { confirmStepUp, requireStepUpOn } from "./step-up-harness";

const strict = {
  isolationEnforcement: "enforce",
  isolationFloorPublic: "user_space_kernel",
  isolationFloorInternal: "user_space_kernel",
  isolationFloorConfidential: "user_space_kernel",
  isolationFloorRegulated: "microvm",
  isolationFloorMcpStdio: "user_space_kernel",
  isolationFloorEngineWorker: "user_space_kernel",
  executorAttestationMaxAgeMinutes: 120,
};
const EDITABLE = 7;

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

function executors(now: number) {
  const at = (ms: number) => new Date(now + ms).toISOString();
  const base = {
    classesDeclared: ["hardened_container", "user_space_kernel"],
    quarantineCode: null,
    runtimeVersion: "runsc release-20260901.0",
    declaredClass: null,
    lastSeenAt: at(-60_000),
    openOffers: 0,
    attestationStrength: "software_attested",
  };
  const fresh = (cls: string, ms = 3_600_000) => [{ profileDigest: "a".repeat(64), fresh: true, class: cls, expiresAt: at(ms), reportSha256: "b".repeat(64) }];
  return [
    { ...base, executorId: "e1", name: "gvisor-fresh", backend: "gvisor", status: "active", attestations: fresh("user_space_kernel") },
    { ...base, executorId: "e2", name: "gvisor-no-report", backend: "gvisor", status: "active", attestations: [{ profileDigest: "a".repeat(64), fresh: false }] },
    { ...base, executorId: "e3", name: "gvisor-quarantined", backend: "gvisor", status: "quarantined", quarantineCode: "execution_profile_mismatch", attestations: [] },
    { ...base, executorId: "e4", name: "kata-revoked", backend: "kata", status: "revoked", attestations: [] },
    { ...base, executorId: "e5", name: "byoc-plane", backend: "customer", classesDeclared: ["customer_declared"], status: "active", attestations: fresh("customer_declared") },
    { ...base, executorId: "e6", name: "gvisor-expiring", backend: "gvisor", status: "active", attestations: fresh("user_space_kernel", 4_000) },
    { executorId: "e7", name: "broken" },
  ];
}

interface IsolationMock {
  writes: Array<Record<string, unknown>>;
  stored: Record<string, unknown>;
  envelope: unknown;
  failReads: boolean;
  failReadsAfterWrite: boolean;
  executorsStatus: number;
  registered: unknown[];
}

async function setup(page: Page, init: Partial<IsolationMock> = {}): Promise<IsolationMock> {
  await installBuilderMock(page, { isAdmin: true });
  await installEnginesMock(page);
  const now = Date.now();
  const m: IsolationMock = { writes: [], stored: { ...strict }, envelope: undefined, failReads: false, failReadsAfterWrite: false, executorsStatus: 200, registered: [], ...init };
  await page.route(/\/v1\/(org\/settings|executors|execution-profiles|execution-placements)(\/|\?|$)/, async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    if (p === "/v1/org/settings" && req.method() === "GET") {
      if (m.failReads) return json(route, { error: "unavailable" }, 503);
      return json(route, m.envelope !== undefined ? m.envelope : { settings: m.stored });
    }
    if (p === "/v1/org/settings" && req.method() === "PUT") {
      const body = req.postDataJSON() as Record<string, unknown>;
      m.writes.push(body);
      m.stored = { ...m.stored, ...body };
      if (m.failReadsAfterWrite) m.failReads = true;
      return json(route, { settings: m.stored });
    }
    if (p === "/v1/executors" && req.method() === "POST") {
      m.registered.push(req.postDataJSON());
      return json(route, { executorId: "e9", name: "gvisor-b" }, 201);
    }
    if (p === "/v1/executors") return m.executorsStatus === 200 ? json(route, { executors: executors(now) }) : json(route, { error: "forbidden" }, m.executorsStatus);
    return json(route, { error: "not_built" }, 501);
  });
  return m;
}

const floor = (page: Page) => page.getByLabel("Isolation floor: public projects", { exact: true });
const save = (page: Page) => page.getByRole("button", { name: "Save isolation settings", exact: true });

async function axe(page: Page) {
  await page.evaluate(async () => {
    await Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined)));
  });
  const result = await new AxeBuilder({ page }).analyze();
  expect(result.violations).toEqual([]);
}

async function openEngines(page: Page) {
  await page.goto("/ui/admin/engines");
  await expect(page.getByRole("heading", { name: "Engines", exact: true, level: 1 })).toBeVisible();
}

test("Engines: profiles and placements say 501, executors show the gateway's verdicts, and every refusal reason is named", async ({ page }) => {
  await setup(page);
  await openEngines(page);
  await expect(page.getByText("Execution profiles unavailable", { exact: true })).toBeVisible();
  await expect(page.getByText("Placement decisions unavailable", { exact: true })).toBeVisible();
  await expect(page.getByText(/This gateway has not built execution profiles yet \(it answers 501/)).toBeVisible();
  for (const code of ["no_executor", "attestation_stale", "class_below_required", "executor_quarantined", "profile_retired", "policy_unresolved", "execution_profile_mismatch"])
    await expect(page.locator("dt code").filter({ hasText: new RegExp(`^${code}$`) })).toBeVisible();

  const cell = (name: string) => page.getByRole("row").filter({ hasText: name });
  await expect(cell("gvisor-fresh").getByText("Fresh report", { exact: true })).toBeVisible();
  await expect(cell("gvisor-fresh")).toContainText("Software-attested L2 · User-space kernel sandbox");
  await expect(cell("gvisor-no-report").getByText("No fresh report", { exact: true })).toBeVisible();
  await expect(cell("gvisor-quarantined").getByText("Quarantined", { exact: true })).toBeVisible();
  await expect(cell("kata-revoked").getByText("Revoked", { exact: true })).toBeVisible();
  await expect(cell("byoc-plane").getByText("Customer declared", { exact: true })).toBeVisible();
  await expect(cell("byoc-plane")).toContainText("satisfies no requirement");
  await expect(page.getByRole("row").filter({ hasText: "Unreadable record" }).getByText("Unmeasured", { exact: true })).toBeVisible();
  // the device clock only takes assurance away: the expiring report turns stale while the page stays open
  await expect(cell("gvisor-expiring").getByText("Stale", { exact: true })).toBeVisible({ timeout: 25_000 });

  await axe(page);
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "dark";
  });
  await axe(page);
});

test("Engines: a refused executor list is unavailable, never an empty fleet", async ({ page }) => {
  await setup(page, { executorsStatus: 403 });
  await openEngines(page);
  await expect(page.getByText("Executors unavailable", { exact: true })).toBeVisible();
  await expect(page.getByText("You are not allowed to read executors.", { exact: true })).toBeVisible();
  await expect(page.getByText("No executors registered", { exact: true })).toHaveCount(0);
  const register = page.getByRole("button", { name: "Register executor", exact: true });
  await expect(register).toBeDisabled();
  await expect(register).toHaveAccessibleDescription(/Registering an executor is unavailable while the executor list cannot be read\. You are not allowed to read executors\./);
});

test("settings: enforcement is fixed and never sent; only the edited floor is sent; a relaxation is confirmed and resent once with step-up", async ({ page }) => {
  const m = await setup(page);
  const su = await requireStepUpOn(page, { method: "PUT", path: "/v1/org/settings", kind: "settings_relax" });
  await openEngines(page);
  await expect(page.getByText("Always on", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Enforce isolation", { exact: true })).toHaveCount(0);
  await expect(floor(page)).toHaveValue("user_space_kernel");

  await floor(page).selectOption("hardened_container");
  await save(page).click();
  const relax = page.getByRole("dialog", { name: "Relax isolation controls?" });
  await expect(relax).toContainText("Isolation floor: public projects: L1 · Hardened container");
  await relax.getByRole("button", { name: "Cancel" }).click();
  expect(su.attempts).toEqual([]);

  await save(page).click();
  await page.getByRole("dialog", { name: "Relax isolation controls?" }).getByRole("button", { name: "Save audited relaxation" }).click();
  await confirmStepUp(page);
  await su.expectResentOnce();
  expect(su.attempts[0]!.body).toEqual({ isolationFloorPublic: "hardened_container" });
  expect(m.writes).toEqual([{ isolationFloorPublic: "hardened_container" }]);
  await expect(page.getByText("Isolation settings saved", { exact: true })).toBeVisible();
  await expect(floor(page)).toHaveValue("hardened_container");
});

test("settings: a stored change during confirmation is reviewed again; a failed current read writes nothing", async ({ page }) => {
  const m = await setup(page);
  await openEngines(page);
  await floor(page).selectOption("hardened_container");
  await save(page).click();
  m.stored = { ...strict, isolationFloorPublic: "microvm" };
  await page.getByRole("dialog", { name: "Relax isolation controls?" }).getByRole("button", { name: "Save audited relaxation" }).click();
  await expect(page.getByText("The stored settings changed while this was open. Review the relaxation again.")).toBeVisible();
  expect(m.writes).toEqual([]);
  await page.getByRole("dialog", { name: "Relax isolation controls?" }).getByRole("button", { name: "Cancel" }).click();

  m.failReads = true;
  await save(page).click();
  await expect(page.getByRole("alert").filter({ hasText: "The current isolation settings could not be read. Nothing was saved." })).toBeVisible();
  expect(m.writes).toEqual([]);
});

test("settings: a failed read after a write locks the form", async ({ page }) => {
  const m = await setup(page);
  await openEngines(page);
  // tightening: no confirmation, no step-up
  await page.getByLabel("Executor attestation lifetime (minutes)", { exact: true }).fill("60");
  m.failReadsAfterWrite = true;
  await save(page).click();
  await expect(page.getByText(/Saved, but the current values could not be reloaded/)).toBeVisible();
  await expect(save(page)).toBeDisabled();
  expect(m.writes).toEqual([{ executorAttestationMaxAgeMinutes: 60 }]);
});

test("settings: malformed envelopes and a retired warn keep Engines usable and every isolation control unmeasured", async ({ page }) => {
  const m = await setup(page);
  for (const envelope of [{}, null, false, 0, "", [], { settings: null }, { settings: [] }, { settings: { ...strict, isolationEnforcement: "warn" } }]) {
    m.envelope = envelope;
    await openEngines(page);
    await expect(page.getByTestId("engine-promptfoo").getByText("On — self-test passed")).toBeVisible();
    await expect(page.getByText(/Isolation settings are unmeasured: the gateway has not reported all eight values/)).toBeVisible();
    await expect(save(page)).toBeDisabled();
    const controls = save(page).locator("xpath=ancestor::form").locator("input, select");
    await expect(controls).toHaveCount(EDITABLE);
    for (const control of await controls.all()) {
      await expect(control).toBeDisabled();
      await expect(control).toHaveAccessibleDescription(/Isolation settings are unmeasured/);
    }
    await expect(save(page)).toHaveAccessibleDescription(/Isolation settings are unmeasured/);
    await expect(floor(page)).toHaveValue("");
    await expect(page.getByText("At least as strict as the default", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Always on", { exact: true })).toHaveCount(0);
  }
  expect(m.writes).toEqual([]);
  await axe(page);
});

test("builder and MCP: profile assignment is disabled with its reason; a remote server is external", async ({ page }) => {
  const st = await installBuilderMock(page, { isAdmin: true });
  const agent = st.agents.find((a) => a.name === "Intake reviewer")!;
  await page.goto(`/ui/builder/agents/${agent.id}`);
  await expect(page.getByRole("heading", { level: 1, name: "Intake reviewer" })).toBeVisible();
  const configure = page.getByRole("button", { name: "Configure", exact: true });
  if (await configure.isVisible()) await configure.click();
  await page.locator("#configure-panel").getByRole("button", { name: /^Autonomy/ }).click();
  const agentSelect = page.getByLabel("Execution profile · agent", { exact: true });
  await expect(agentSelect).toBeDisabled();
  await expect(agentSelect).toHaveAccessibleDescription(/no route to assign one/);

  await page.route("**/v1/servers", (route) =>
    json(route, {
      servers: [
        { id: "x40-stdio", name: "Synthetic stdio", url: "", transport: "stdio", stdio: { command: "synthetic", args: [] }, allowPrivateRanges: null },
        { id: "x40-remote", name: "Synthetic remote", url: "https://example.test/mcp", transport: "streamable_http", allowPrivateRanges: null },
      ],
    }),
  );
  await page.route("**/v1/users", (route) => json(route, { users: [] }));
  await page.goto("/ui/admin/mcp-servers");
  await expect(page.getByRole("heading", { level: 1, name: "MCP servers", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Show tools on Synthetic stdio" }).click();
  await expect(page.getByLabel("Execution profile · Synthetic stdio", { exact: true })).toBeDisabled();
  await page.getByRole("link", { name: "Show tools on Synthetic remote" }).click();
  await expect(page.getByText(/This is a remote MCP server: it runs on its own host, which RegulAIt does not isolate/)).toBeVisible();
  await axe(page);
});

test("Engines: registering an executor sends the strict body and grants no class by itself", async ({ page }) => {
  const m = await setup(page);
  await openEngines(page);
  await page.getByRole("button", { name: "Register executor", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Register an executor" });
  await expect(dialog).toContainText("Registering grants no isolation class");
  await dialog.getByLabel("Worker identity id", { exact: true }).fill("11111111-1111-4111-8111-111111111111");
  await dialog.getByLabel("Executor name", { exact: true }).fill("gvisor-b");
  await dialog.getByLabel("Backend", { exact: true }).selectOption("gvisor");
  await dialog.getByLabel("Runtime version", { exact: true }).fill("release-20260901.0");
  // gVisor attests L1 or L2, never L3
  await expect(dialog.getByRole("checkbox")).toHaveCount(2);
  await dialog.getByRole("button", { name: "Register", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveText("Choose at least one class the executor is expected to attest.");
  expect(m.registered).toEqual([]);
  await dialog.getByRole("checkbox", { name: "L2 · User-space kernel sandbox" }).check();
  await axe(page);
  await dialog.getByRole("button", { name: "Register", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(m.registered).toEqual([
    { workloadIdentityId: "11111111-1111-4111-8111-111111111111", name: "gvisor-b", backend: "gvisor", runtimeVersion: "release-20260901.0", classesDeclared: ["user_space_kernel"] },
  ]);
});
