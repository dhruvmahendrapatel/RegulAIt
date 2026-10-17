/**
 * ADR-0190 slice I9: the isolation UI on the real Engines, MCP servers and
 * agent builder pages, against HTTP mocks shaped like the gateway today:
 *  - `/v1/org/settings` and `/v1/executors` are built (I1, I3);
 *  - `/v1/execution-profiles`, `/v1/execution-placements` and
 *    `/v1/execution-profile-assignments/:kind/:id` are built (I2).
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
  /** a body other than the fixture list for a 200 (a malformed envelope) */
  executorsBody?: unknown;
  /** held until resolved: the executor list stays loading */
  executorsGate?: Promise<void>;
  registered: unknown[];
  /** I2: a status other than 200 for the profile and placement reads */
  profilesStatus: number;
  placementsBody?: unknown;
  /** I2: profile assignment by `kind/id`, and the PUT bodies received */
  assignments: Record<string, string | null>;
  assignWrites: Array<{ path: string; body: unknown }>;
  profileCreates: unknown[];
  profileVersions: Array<{ name: string; body: unknown }>;
  retired: string[];
  builder?: Awaited<ReturnType<typeof installBuilderMock>>;
}

const AT = "2026-10-12T10:00:00.000Z";
const prof = (over: Record<string, unknown>) => ({ version: 1, digest: "9".repeat(64), shipped: true, retiredAt: null, createdAt: AT, relaxations: [], ...over });
const PROFILES = [
  prof({ id: "p-restricted", name: "restricted", minClass: "user_space_kernel" }),
  prof({ id: "p-microvm", name: "restricted-microvm", minClass: "microvm", digest: "8".repeat(64) }),
  prof({ id: "p-engine", name: "engine-worker", minClass: "user_space_kernel", digest: "7".repeat(64), relaxations: ["filesystem.workDir", "resources", "secrets"] }),
  prof({ id: "p-loose", name: "team-loose", minClass: "hardened_container", shipped: false, digest: "6".repeat(64), relaxations: ["minClass"] }),
  prof({ id: "p-old", name: "team-old", minClass: "microvm", shipped: false, digest: "5".repeat(64), retiredAt: AT }),
];
const PLACEMENTS = {
  placements: [
    { id: "pl-1", workloadKind: "mcp_stdio", requiredClass: "microvm", requiredBy: "data_sensitivity", outcome: "refused", refusalCode: "class_below_required", appliedClass: null, executorName: null, profileName: "restricted", profileVersion: 1, createdAt: AT },
    { id: "pl-2", workloadKind: "mcp_stdio", requiredClass: "user_space_kernel", requiredBy: "workload_kind", outcome: "placed", refusalCode: null, appliedClass: "user_space_kernel", executorName: "gvisor-a", profileName: "restricted", profileVersion: 1, createdAt: AT },
  ],
  refusalsWithoutPlacement: [{ auditId: "a-1", at: AT, code: "policy_unresolved", unresolvedFact: "sensitivity", workloadKind: "mcp_stdio" }],
  attestationStrength: "software_attested",
};

async function setup(page: Page, init: Partial<IsolationMock> = {}): Promise<IsolationMock> {
  const builder = await installBuilderMock(page, { isAdmin: true });
  await installEnginesMock(page);
  const now = Date.now();
  const m: IsolationMock = {
    writes: [],
    stored: { ...strict },
    envelope: undefined,
    failReads: false,
    failReadsAfterWrite: false,
    executorsStatus: 200,
    registered: [],
    profilesStatus: 200,
    assignments: {},
    assignWrites: [],
    profileCreates: [],
    profileVersions: [],
    retired: [],
    builder,
    ...init,
  };
  await page.route(/\/v1\/(org\/settings|executors|execution-profiles|execution-placements|execution-profile-assignments)(\/|\?|$)/, async (route) => {
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
    if (p === "/v1/executors") {
      if (m.executorsGate) await m.executorsGate;
      if (m.executorsStatus !== 200) return json(route, { error: "forbidden" }, m.executorsStatus);
      return json(route, m.executorsBody !== undefined ? m.executorsBody : { executors: executors(now) });
    }
    if (p === "/v1/execution-profiles" && req.method() === "POST") {
      m.profileCreates.push(req.postDataJSON());
      return json(route, { ...prof({ id: "p-new", name: "team-new", minClass: "microvm", shipped: false }) }, 201);
    }
    const named = /^\/v1\/execution-profiles\/([a-z0-9-]+)(\/versions|\/retire)?$/.exec(p);
    if (named && named[2] === "/versions" && req.method() === "POST") {
      m.profileVersions.push({ name: named[1]!, body: req.postDataJSON() });
      return json(route, { ...prof({ id: "p-v2", name: named[1], version: 2, minClass: "microvm", shipped: false }) }, 201);
    }
    if (named && named[2] === "/retire" && req.method() === "POST") {
      m.retired.push(named[1]!);
      return json(route, { name: named[1], versions: [], assignmentsNowRefused: 0 });
    }
    if (named && !named[2]) {
      const pv = PROFILES.find((x) => x.name === named[1]);
      if (!pv) return json(route, { error: "execution_profile_not_found" }, 404);
      return json(route, { name: pv.name, versions: [{ ...pv, body: { schema: "regulait.execution-profile.v1", name: pv.name, minClass: pv.minClass, secrets: "none" } }] });
    }
    if (p === "/v1/execution-placements/pl-1") {
      return json(route, { ...PLACEMENTS.placements[0], auditId: "a-pl-1", reportSha256: null, attestationStrength: "software_attested", audit: { id: "a-pl-1", at: AT, ruleId: "execution-refused", effect: "deny", reason: "placement refused (class_below_required)", detail: {} } });
    }
    if (p === "/v1/execution-profiles") {
      if (m.profilesStatus !== 200) return json(route, { error: "forbidden" }, m.profilesStatus);
      return json(route, { profiles: PROFILES, reference: "restricted" });
    }
    if (p === "/v1/execution-placements") {
      if (m.profilesStatus !== 200) return json(route, { error: "forbidden" }, m.profilesStatus);
      return json(route, m.placementsBody !== undefined ? m.placementsBody : PLACEMENTS);
    }
    return json(route, { error: "not_found" }, 404);
  });
  await page.route("**/v1/identity/picker-sources", (route) =>
    json(route, {
      sponsors: [],
      subjects: { agent: [], builder_agent: [], engine_runner: [] },
      environments: [],
      servers: [],
      agents: [],
      connectors: [],
      roles: [],
      workerIdentities: [
        { id: "11111111-1111-4111-8111-111111111111", label: "spiffe://example.org/regulait/worker_runtime/gvisor-b" },
        { id: "22222222-2222-4222-8222-222222222222", label: "spiffe://example.org/regulait/worker_runtime/kata-a" },
      ],
      truncated: false,
    }),
  );
  await page.route(/\/v1\/execution-profile-assignments\//, async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    const assign = /^\/v1\/execution-profile-assignments\/([a-z_]+)\/([^/]+)$/.exec(p);
    if (assign) {
      const key = `${assign[1]}/${decodeURIComponent(assign[2]!)}`;
      if (req.method() === "PUT") {
        const body = req.postDataJSON() as { profileId: string | null };
        m.assignWrites.push({ path: p, body });
        m.assignments[key] = body.profileId;
      }
      const id = m.assignments[key] ?? null;
      const assigned = id ? PROFILES.find((x) => x.id === id)! : null;
      return json(route, { target: { kind: assign[1], id: assign[2] }, assigned, effective: assigned ?? PROFILES[0], source: assigned ? "assigned" : "shipped_default" });
    }
    return json(route, { error: "not_found" }, 404);
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

test("Engines: profiles and placements are live, executors show the gateway's verdicts, and every refusal reason is named", async ({ page }) => {
  await setup(page);
  await openEngines(page);
  const profileRow = (name: string) => page.getByRole("row").filter({ hasText: new RegExp(`^${name} v1`) });
  await expect(profileRow("restricted").getByText("Live", { exact: true })).toBeVisible();
  await expect(profileRow("restricted")).toContainText("None");
  await expect(profileRow("team-loose")).toContainText("L1 · Hardened container");
  await expect(profileRow("team-loose")).toContainText("minClass");
  await expect(profileRow("team-old").getByText("Retired", { exact: true })).toBeVisible();
  const placement = (text: string) => page.getByRole("row").filter({ hasText: text });
  await expect(placement("set by the project's data sensitivity").getByText("Refused", { exact: true })).toBeVisible();
  await expect(placement("set by the project's data sensitivity")).toContainText("class_below_required");
  await expect(placement("on gvisor-a").getByText("Placed", { exact: true })).toBeVisible();
  await expect(page.getByText("Refused before any placement", { exact: true })).toBeVisible();
  await expect(page.getByText("· the fact sensitivity did not resolve")).toBeVisible();
  await expect(page.getByText(/answers 501/)).toHaveCount(0);
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

test("Engines: registering is disabled while the executor list loads, and enabled once it has", async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await setup(page, { executorsGate: gate });
  await openEngines(page);
  const register = page.getByRole("button", { name: "Register executor", exact: true });
  await expect(register).toBeDisabled();
  await expect(register).toHaveAccessibleDescription("Registering an executor is available once the executor list has loaded.");
  await expect(page.getByText("No executors registered", { exact: true })).toHaveCount(0);
  release();
  await expect(page.getByRole("row").filter({ hasText: "gvisor-fresh" })).toBeVisible();
  await expect(register).toBeEnabled();
});

test("Engines: a malformed executor list is unreadable, never an empty fleet, and registering stays disabled", async ({ page }) => {
  await setup(page, { executorsBody: { executors: "none" } });
  await openEngines(page);
  await expect(page.getByText("Executors unavailable", { exact: true })).toBeVisible();
  await expect(page.getByText("The gateway's executor list could not be read. No placement assurance is shown.", { exact: true })).toBeVisible();
  await expect(page.getByText("No executors registered", { exact: true })).toHaveCount(0);
  const register = page.getByRole("button", { name: "Register executor", exact: true });
  await expect(register).toBeDisabled();
  await expect(register).toHaveAccessibleDescription(
    "Registering an executor is unavailable while the executor list cannot be read. The gateway's executor list could not be read. No placement assurance is shown.",
  );
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

test("Engines: an unreadable placement list and a refused profile read are unavailable, never empty", async ({ page }) => {
  const m = await setup(page, { placementsBody: { placements: "none" } });
  await openEngines(page);
  await expect(page.getByText("Placement decisions unavailable", { exact: true })).toBeVisible();
  await expect(page.getByText("No placement decisions yet", { exact: true })).toHaveCount(0);
  m.profilesStatus = 403;
  await openEngines(page);
  await expect(page.getByText("You are not allowed to read execution profiles.", { exact: true })).toBeVisible();
  await expect(page.getByText("No execution profiles", { exact: true })).toHaveCount(0);
});

test("builder and MCP: a stricter profile is assigned without step-up, a looser one is resent once with it; a remote server is external", async ({ page }) => {
  const m = await setup(page);
  const agent = m.builder!.agents.find((a) => a.name === "Intake reviewer")!;
  await page.goto(`/ui/builder/agents/${agent.id}`);
  await expect(page.getByRole("heading", { level: 1, name: "Intake reviewer" })).toBeVisible();
  const configure = page.getByRole("button", { name: "Configure", exact: true });
  if (await configure.isVisible()) await configure.click();
  await page.locator("#configure-panel").getByRole("button", { name: /^Autonomy/ }).click();
  const agentSelect = page.getByLabel("Execution profile · agent", { exact: true });
  await expect(agentSelect).toBeEnabled();
  await expect(agentSelect).toHaveValue("");
  await expect(page.getByText(/In force: restricted v1 · L2 · User-space kernel sandbox \(the shipped default\)/)).toBeVisible();
  // a retired profile is never offered
  await expect(agentSelect.locator("option", { hasText: "team-old" })).toHaveCount(0);
  await agentSelect.selectOption("p-microvm");
  await page.getByRole("button", { name: "Save execution profile", exact: true }).click();
  await expect.poll(() => m.assignWrites.length).toBe(1);
  expect(m.assignWrites[0]).toEqual({ path: `/v1/execution-profile-assignments/builder_agent/${agent.id}`, body: { profileId: "p-microvm" } });
  await expect(page.getByText(/In force: restricted-microvm v1 · L3 · MicroVM sandbox \(assigned\)/)).toBeVisible();

  const su = await requireStepUpOn(page, { method: "PUT", path: `/v1/execution-profile-assignments/builder_agent/${agent.id}`, kind: "settings_relax" });
  await agentSelect.selectOption("p-loose");
  await page.getByRole("button", { name: "Save execution profile", exact: true }).click();
  await confirmStepUp(page);
  await su.expectResentOnce();
  expect(su.attempts[0]!.body).toEqual({ profileId: "p-loose" });
  await expect(page.getByText(/In force: team-loose v1 · L1 · Hardened container \(assigned\)/)).toBeVisible();

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
  const serverSelect = page.getByLabel("Execution profile · Synthetic stdio", { exact: true });
  await expect(serverSelect).toBeEnabled();
  await expect(serverSelect).toHaveValue("");
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
  // ADR-0188 S6: chosen from the gateway's worker identities, never typed
  await expect(dialog.getByLabel("Worker identity", { exact: true }).locator("option")).toHaveCount(3);
  await dialog.getByLabel("Worker identity", { exact: true }).selectOption("11111111-1111-4111-8111-111111111111");
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

test("Engines: a new profile starts from a live version, renamed, at the chosen class; a stricter one needs no step-up", async ({ page }) => {
  const m = await setup(page);
  await openEngines(page);
  await page.getByRole("button", { name: "New profile", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New execution profile" });
  // a retired version is never a starting point
  await expect(dialog.getByLabel("Start from", { exact: true }).locator("option", { hasText: "team-old" })).toHaveCount(0);
  await dialog.getByLabel("Profile name", { exact: true }).fill("Team-New");
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("Name: 2 to 63 characters");
  await dialog.getByLabel("Profile name", { exact: true }).fill("team-new");
  await dialog.getByLabel("Minimum isolation class", { exact: true }).selectOption("microvm");
  await axe(page);
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(m.profileCreates).toEqual([{ body: { schema: "regulait.execution-profile.v1", name: "team-new", minClass: "microvm", secrets: "none" } }]);
});

test("Engines: a custom profile gets a new version or is retired; shipped ones offer neither; a placement shows its evidence", async ({ page }) => {
  const m = await setup(page);
  await openEngines(page);
  await expect(page.getByRole("button", { name: "New version of restricted", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Retire team-old", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "New version of team-loose", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New version of team-loose" });
  // no class is preselected, and the current class is refused here rather than sent for a 409 "unchanged"
  const minClass = dialog.getByLabel("Minimum isolation class", { exact: true });
  await expect(minClass).toHaveValue("");
  const current = PROFILES.find((p) => p.name === "team-loose")!.minClass;
  await minClass.selectOption(current);
  await dialog.getByRole("button", { name: "Create version", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("Choose a different class");
  expect(m.profileVersions).toEqual([]);
  await minClass.selectOption("microvm");
  await dialog.getByRole("button", { name: "Create version", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(m.profileVersions).toEqual([{ name: "team-loose", body: { body: { schema: "regulait.execution-profile.v1", name: "team-loose", minClass: "microvm", secrets: "none" } } }]);

  await page.getByRole("button", { name: "Retire team-loose", exact: true }).click();
  const retire = page.getByRole("dialog", { name: "Retire team-loose?" });
  await expect(retire).toContainText("nothing falls back to weaker isolation");
  await retire.getByRole("button", { name: "Retire profile", exact: true }).click();
  await expect(retire).toHaveCount(0);
  expect(m.retired).toEqual(["team-loose"]);

  await page.getByRole("button", { name: "Evidence for placement pl-1", exact: true }).click();
  const evidence = page.getByTestId("placement-evidence");
  await expect(evidence).toContainText("a-pl-1");
  await expect(evidence).toContainText("placement refused (class_below_required)");
  await expect(evidence).toContainText("None (nothing was started)");
  await expect(evidence).toContainText("software-attested");
  await axe(page);
});
