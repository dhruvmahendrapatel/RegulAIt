/**
 * ADR-0175 A6/A5 — skill admission and the release waiting period in the UI:
 * the library's status badges and findings, the share-needs-approval note, the
 * agent editor's withheld skill, and the admin Admission review page (admit
 * with a reason, approve a share, set the waiting period with the
 * recommendation shown, allow one item now). Mocked API; synthetic data.
 */
import { expect, test, type Page, type Route } from "@playwright/test";
import { expectAxeClean, installBuilderMock, SKILL_ADMISSION, type MockState } from "./builder-fixtures";

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const iso = (daysAhead: number) => new Date(Date.UTC(2026, 9, 4 + daysAhead)).toISOString();

const HELD = {
  ...SKILL_ADMISSION,
  id: "sk-held",
  name: "Partner sign-in",
  description: "Use when checking a partner portal.",
  visibility: "private",
  ownerName: "Avery Admin",
  usedBy: 0,
  updatedAt: iso(0),
  canEdit: true,
  version: 3,
  admissionState: "held",
  admissionSeverity: "medium",
  admissionFindings: [{ rule: "skill.confusable.mixed_script", severity: "medium", where: "body", count: 1 }],
  body: "---\nname: Partner sign-in\n---\nSign in first.",
};
const WAITING = { ...SKILL_ADMISSION, id: "sk-wait", name: "Vendor triage", description: "", visibility: "private", ownerName: "Avery Admin", usedBy: 0, updatedAt: iso(0), canEdit: true, version: 2, release: { quarantined: true, readyAt: iso(7), ageDays: 0 }, body: "# v2" };
const PENDING = { ...SKILL_ADMISSION, id: "sk-share", name: "Model card check", description: "", visibility: "private", requestedVisibility: "workspace", ownerName: "Avery Admin", usedBy: 0, updatedAt: iso(0), canEdit: true, body: "# x" };

test.describe("ADR-0175: the skill library", () => {
  test("status badges, a held skill's findings (counts only), and sharing needs an admin", async ({ page }) => {
    const st = await installBuilderMock(page, { isAdmin: false });
    st.skills.push(HELD, WAITING, PENDING);
    await page.goto("/ui/builder/skills");
    const list = page.getByRole("list", { name: "Skills" });
    await expect(list.getByRole("button", { name: "Open skill Partner sign-in" }).getByText("Held for review")).toBeVisible();
    await expect(list.getByRole("button", { name: "Open skill Vendor triage" }).getByText("Waiting until Oct 11")).toBeVisible();
    await expect(list.getByRole("button", { name: "Open skill Model card check" }).getByText("Sharing pending approval")).toBeVisible();
    await expect(list.getByRole("button", { name: "Open skill Partner sign-in" }).getByText("v3")).toBeVisible();
    await expectAxeClean(page, "skills with admission status");

    await list.getByRole("button", { name: "Open skill Partner sign-in" }).click();
    const drawer = page.getByRole("dialog", { name: "Edit skill" });
    const note = drawer.getByTestId("skill-admission-note");
    await expect(note).toContainText("Version 3");
    await expect(note).toContainText("Agents can't use it until an admin admits it.");
    await expect(note.getByRole("list", { name: "Admission findings" })).toContainText("skill.confusable.mixed_script in body (medium, ×1)");
    await page.keyboard.press("Escape");

    await list.getByRole("button", { name: "Open skill Model card check" }).click();
    const pending = page.getByRole("dialog", { name: "Edit skill" });
    await expect(pending.getByRole("radio", { name: /Workspace/ })).toBeChecked();
    await expect(pending.getByTestId("skill-share-note")).toContainText("Waiting for an admin to approve sharing");
    await page.keyboard.press("Escape");

    await page.getByRole("button", { name: "New skill" }).click();
    const fresh = page.getByRole("dialog", { name: "New skill" });
    await expect(fresh.getByTestId("skill-share-note")).toContainText("needs an admin's approval");
    await fresh.getByRole("radio", { name: /Only me/ }).check();
    await expect(fresh.getByTestId("skill-share-note")).toHaveCount(0);
  });

  test("a refused save shows the gateway's reason", async ({ page }) => {
    await installBuilderMock(page);
    await page.route("**/v1/builder/skills", (route) =>
      route.request().method() === "POST"
        ? json(route, { error: "skill_admission_refused", detail: "skill 'Bad' was refused by admission scanning (severity critical)", findings: [] }, 422)
        : route.fallback(),
    );
    await page.goto("/ui/builder/skills");
    await page.getByRole("button", { name: "New skill" }).click();
    const drawer = page.getByRole("dialog", { name: "New skill" });
    await drawer.getByLabel("Name").fill("Bad");
    await drawer.getByRole("button", { name: "Create skill" }).click();
    await expect(drawer.getByRole("alert")).toContainText("refused by admission scanning");
  });
});

test.describe("ADR-0175: the agent editor", () => {
  test("a withheld skill says why it is skipped", async ({ page }) => {
    const st = await installBuilderMock(page);
    const agent = st.agents.find((a) => a.name === "Intake reviewer")!;
    agent.skills = [{ id: "sk-0001", name: "Assess an AI use case", description: "", updateAvailable: false, unavailable: true, withheld: "held", pinnedVersion: 1 }];
    await page.goto(`/ui/builder/agents/${agent.id}`);
    const skills = page.getByRole("complementary", { name: "Configure agent" }).getByRole("list", { name: "Attached skills" });
    const row = skills.getByRole("listitem").filter({ hasText: "Assess an AI use case" });
    await expect(row.getByText("Held for review")).toBeVisible();
    await expect(row).toContainText("The agent skips it until an admin admits it.");
    await expect(row.getByText("No longer shared")).toHaveCount(0);
  });

  test("a private skill on a shared agent says the others run without it", async ({ page }) => {
    const st = await installBuilderMock(page);
    const agent = st.agents.find((a) => a.name === "Intake reviewer")!;
    agent.sharing = "workspace";
    agent.skills = [
      { id: "sk-0003", name: "Map to EU AI Act", pinnedName: "Map to EU AI Act", description: "", updateAvailable: false, unavailable: false, withheldFromOthers: true, visibilityRequested: false },
    ];
    await page.goto(`/ui/builder/agents/${agent.id}`);
    const skills = page.getByRole("complementary", { name: "Configure agent" }).getByRole("list", { name: "Attached skills" });
    const row = skills.getByRole("listitem").filter({ hasText: "Map to EU AI Act" });
    await expect(row.getByText("Only its owner")).toBeVisible();
    await expect(row).toContainText("People this agent is shared with run it without the skill.");
    await expectAxeClean(page, "agent editor with a private skill on a shared agent");
  });
});

/** the admin endpoints the Admission review page reads and writes */
async function installAdmissionMock(page: Page, st: MockState) {
  const state = {
    days: 0,
    skills: [
      { ...HELD, ownerName: "Drew Reviewer", visibilityRequestedAt: null, admissionScannedAt: iso(0), admittedAt: null, admitReason: null },
      { ...PENDING, ownerName: "Cora Analyst", admissionSeverity: null, admissionFindings: [], visibilityRequestedAt: iso(0), admissionScannedAt: iso(0), admittedAt: null, admitReason: null },
    ],
  };
  await page.route("**/v1/admission/skills", (route) =>
    json(route, { scannerVersion: "skill-admission/2", holdAt: "medium", refuseAt: "high", rules: [], skills: state.skills }),
  );
  await page.route(/\/v1\/admission\/skills\/[^/]+\/(admit|visibility)$/, (route) => {
    st.calls.push({ method: "POST", path: new URL(route.request().url()).pathname, body: route.request().postDataJSON() });
    return json(route, { skill: {} });
  });
  await page.route("**/v1/release-quarantine", (route) =>
    json(route, {
      enabled: state.days > 0,
      minReleaseAgeDays: state.days,
      recommendedDays: 7,
      servers: state.days > 0 ? [{ id: "33333333-0000-4000-8000-0000000000aa", name: "weather-mcp", origin: "local", release: "registration", firstSeenAt: iso(0), ageDays: 0, readyAt: iso(7), quarantined: true, admissionState: "unscanned" }] : [],
      skills: [],
    }),
  );
  await page.route("**/v1/release-quarantine/override", (route) => {
    st.calls.push({ method: "POST", path: "/v1/release-quarantine/override", body: route.request().postDataJSON() });
    return json(route, { override: {} }, 201);
  });
  await page.route("**/v1/mcp/admission", (route) => json(route, { mode: "log", enforcing: false, servers: [] }));
  await page.route("**/v1/org/settings", (route) => {
    if (route.request().method() === "PUT") {
      const body = route.request().postDataJSON();
      st.calls.push({ method: "PUT", path: "/v1/org/settings", body });
      state.days = body.minReleaseAgeDays;
      return json(route, { settings: { minReleaseAgeDays: state.days } });
    }
    return json(route, { settings: { minReleaseAgeDays: state.days } });
  });
}
const posted = (st: MockState, path: string) => st.calls.filter((c) => c.path === path).map((c) => c.body);

test.describe("ADR-0175: Admission review (admin)", () => {
  test("admit a held skill with a reason, approve a share, set the waiting period, allow one item now", async ({ page }) => {
    const st = await installBuilderMock(page);
    await installAdmissionMock(page, st);
    await page.goto("/ui/admin/admission");
    await expect(page.getByRole("heading", { level: 1, name: "Admission review" })).toBeVisible();
    await expect(page.getByText("skill.confusable.mixed_script in body (medium, ×1)").first()).toBeVisible();
    await expectAxeClean(page, "admission review");

    await page.getByRole("button", { name: "Admit Partner sign-in" }).click();
    const modal = page.getByRole("dialog", { name: "Admit Partner sign-in?" });
    await modal.getByRole("button", { name: "Admit" }).click();
    await expect(modal.getByRole("alert")).toContainText("A reason is required");
    await modal.getByLabel("Reason").fill("brand name spelled in Cyrillic on purpose");
    await modal.getByRole("button", { name: "Admit" }).click();
    await expect(modal).toHaveCount(0);
    // the digest of the content the page showed travels with the admission
    expect(posted(st, "/v1/admission/skills/sk-held/admit")).toEqual([{ digest: "0".repeat(64), reason: "brand name spelled in Cyrillic on purpose" }]);

    await page.getByRole("button", { name: "Approve sharing Model card check" }).click();
    await expect.poll(() => posted(st, "/v1/admission/skills/sk-share/visibility")).toEqual([{ decision: "approve" }]);

    // the waiting period: off, with the recommendation one click away
    const days = page.getByLabel("Minimum release age in days");
    await expect(days).toHaveValue("0");
    await page.getByRole("button", { name: "Use recommended (7)" }).click();
    await expect(days).toHaveValue("7");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect.poll(() => posted(st, "/v1/org/settings")).toEqual([{ minReleaseAgeDays: 7 }]);
    await page.getByRole("button", { name: "Allow weather-mcp now" }).click();
    const allow = page.getByRole("dialog", { name: "Allow weather-mcp now?" });
    await allow.getByLabel("Reason").fill("internal server, reviewed");
    await allow.getByRole("button", { name: "Allow now" }).click();
    await expect.poll(() => posted(st, "/v1/release-quarantine/override")).toEqual([
      { kind: "mcp_server", id: "33333333-0000-4000-8000-0000000000aa", digest: "registration", reason: "internal server, reviewed" },
    ]);
    await expectAxeClean(page, "admission review with waiting period");
  });
});
