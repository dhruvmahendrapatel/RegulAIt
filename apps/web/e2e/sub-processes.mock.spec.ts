/**
 * ADR-0341 follow-up (Camunda gap row 10): the sub-process catalogue from the browser's side, every /v1 and /auth call
 * answered by an in-test mock:
 *
 *  - the catalogue lists each sub-process with what templates can call and its latest version's state;
 *  - proposing one is held until it has a name, valid stages and a reviewer who is not the proposer, then posts
 *    exactly what was entered; a refusal's issues are shown;
 *  - a sub-process with a version waiting for review cannot take another proposal;
 *  - axe (WCAG 2.2 AA tags) over the list and both dialogs.
 */
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";

const ME = "a0000000-0000-4000-8000-000000000001";
const REVIEWER = "a0000000-0000-4000-8000-000000000002";
const FRAG = "f0000000-0000-4000-8000-000000000001";
const PENDING = "f0000000-0000-4000-8000-000000000002";
const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

const items = [
  { id: FRAG, name: "Security review", description: "plan, threat model, sign-off", version: 2, contentHash: "a".repeat(64), stageCount: 3, latest: { version: 2, state: "approved" } },
  { id: PENDING, name: "Release checks", description: null, version: null, contentHash: null, stageCount: null, latest: { version: 1, state: "pending_approval" } },
];
const version = (v: number, state: string) => ({
  id: `v${v}`,
  version: v,
  contentHash: String(v).repeat(64),
  stageCount: 3,
  state,
  proposedBy: ME,
  createdAt: "2026-11-17T09:00:00.000Z",
  decidedAt: null,
});

async function mockApi(page: Page) {
  const posts: Array<{ url: string; body: unknown }> = [];
  let refuseNext = false;
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname;
    if (route.request().resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    const method = route.request().method();
    const me = { userId: ME, isAdmin: true, user: { id: ME, email: "ada@example.test", displayName: "Ada Admin" } };
    if (p === "/auth/me") return json(route, { ...me, via: "session", mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false });
    if (p === "/v1/me") return json(route, me);
    if (p === "/v1/users")
      return json(route, {
        users: [
          { id: ME, email: "ada@example.test", displayName: "Ada Admin", isAdmin: true, disabledAt: null },
          { id: REVIEWER, email: "grace@example.test", displayName: "Grace Reviewer", isAdmin: true, disabledAt: null },
          { id: "a0000000-0000-4000-8000-000000000003", email: "lin@example.test", displayName: "Lin Member", isAdmin: false, disabledAt: null },
        ],
      });
    if (p === "/v1/workflows/fragments" && method === "GET") return json(route, { items, nextOffset: null });
    if (p === "/v1/workflows/fragments" && method === "POST") {
      posts.push({ url: p, body: route.request().postDataJSON() });
      if (refuseNext) {
        refuseNext = false;
        return json(route, { error: "fragment_invalid", issues: [{ code: "fragment_trigger", message: "a fragment cannot contain a trigger: the calling template has one", stageId: "t" }] }, 422);
      }
      return json(route, { fragment: { id: "new", name: "x" }, version: { version: 1 } }, 201);
    }
    if (p === `/v1/workflows/fragments/${FRAG}`) return json(route, { fragment: { id: FRAG, name: "Security review", description: "plan, threat model, sign-off", createdAt: "2026-11-01T00:00:00.000Z" }, versions: [version(2, "approved"), version(1, "approved")] });
    if (p === `/v1/workflows/fragments/${PENDING}`) return json(route, { fragment: { id: PENDING, name: "Release checks", description: null, createdAt: "2026-11-01T00:00:00.000Z" }, versions: [version(1, "pending_approval")] });
    if (p === `/v1/workflows/fragments/${FRAG}/versions/2`) return json(route, { fragment: { id: FRAG, name: "Security review" }, version: { version: 2, stages: [{ id: "plan", type: "planning" }], state: "approved" } });
    if (p === `/v1/workflows/fragments/${PENDING}/versions/1`) return json(route, { fragment: { id: PENDING, name: "Release checks" }, version: { version: 1, stages: [{ id: "c", type: "automated_check", checks: ["unit"] }], state: "pending_approval" } });
    if (p === `/v1/workflows/fragments/${FRAG}/versions` && method === "POST") {
      posts.push({ url: p, body: route.request().postDataJSON() });
      return json(route, { version: { version: 3 } }, 201);
    }
    return json(route, {});
  });
  return { posts, refuse: () => (refuseNext = true) };
}

async function expectAxeClean(page: Page, label: string) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(serious.map((v) => `${v.id}: ${v.help}`), `axe on ${label}`).toEqual([]);
}

test.describe("ADR-0341 follow-up: the sub-process catalogue", () => {
  test("lists what templates can call and each latest version's state; axe-clean", async ({ page }) => {
    await mockApi(page);
    await page.goto("/ui/admin/workflow-templates/sub-processes");
    await expect(page.getByRole("heading", { name: "Sub-process catalogue" })).toBeVisible();
    // a row that opens its record in place carries a button in its primary cell (the kit Table, UIS-04)
    await expect(page.getByRole("row").filter({ has: page.getByRole("button", { name: "Open Security review" }) })).toContainText("v2 · 3 stages");
    await expect(page.getByRole("row").filter({ has: page.getByRole("button", { name: "Open Release checks" }) })).toContainText("Nothing approved yet");
    await expect(page.getByRole("row").filter({ has: page.getByRole("button", { name: "Open Release checks" }) })).toContainText("Waiting for review");
    await expectAxeClean(page, "the catalogue");
  });

  test("holds a proposal until it is complete, never offers the proposer as reviewer, shows a refusal, then posts what was entered", async ({ page }) => {
    const mock = await mockApi(page);
    await page.goto("/ui/admin/workflow-templates/sub-processes");
    await page.getByRole("button", { name: "Propose a sub-process" }).first().click();
    const dialog = page.getByRole("dialog", { name: "Propose a sub-process" });
    await expect(dialog).toBeVisible();
    const send = dialog.getByRole("button", { name: "Send for review" });
    await expect(send).toHaveAttribute("aria-disabled", "true");
    await expect(dialog.getByRole("status")).toHaveText("Give the sub-process a name.");
    await dialog.getByRole("textbox", { name: "Name", exact: true }).fill("Data protection review");
    await expect(dialog.getByRole("status")).toHaveText("Choose who reviews it.");
    const reviewer = dialog.getByRole("combobox", { name: "Reviewer" });
    await expect(reviewer.locator("option")).toHaveText(["Choose a reviewer", "Grace Reviewer · grace@example.test"]);
    await reviewer.selectOption(REVIEWER);
    await dialog.getByRole("textbox", { name: "Stages (JSON)" }).fill("[");
    await expect(dialog.getByRole("status")).toHaveText("This is not valid JSON.");
    // an aria-disabled button stays focusable and clickable, and the click sends nothing
    await send.click({ force: true });
    expect(mock.posts).toHaveLength(0);
    await expectAxeClean(page, "the proposal dialog");

    const stages = [{ id: "t", type: "trigger" }];
    await dialog.getByRole("textbox", { name: "Stages (JSON)" }).fill(JSON.stringify(stages));
    mock.refuse();
    await send.click();
    await expect(dialog.getByRole("alert")).toContainText("t: a fragment cannot contain a trigger");
    const good = [{ id: "dpia", type: "human_approval", approvers: ["requesting_user"] }];
    await dialog.getByRole("textbox", { name: "Stages (JSON)" }).fill(JSON.stringify(good));
    await send.click();
    await expect(dialog).toBeHidden();
    expect(mock.posts.at(-1)).toEqual({ url: "/v1/workflows/fragments", body: { name: "Data protection review", stages: good, reviewerUserId: REVIEWER } });
  });

  test("proposes the next version from the latest one, and refuses while a version waits for review; axe-clean", async ({ page }) => {
    const mock = await mockApi(page);
    await page.goto("/ui/admin/workflow-templates/sub-processes");
    await page.getByRole("button", { name: "Open Release checks" }).click();
    const waiting = page.getByRole("dialog", { name: "Release checks" });
    await expect(waiting.getByRole("button", { name: "Propose a new version" })).toHaveAttribute("aria-disabled", "true");
    await expect(waiting).toContainText("A version is waiting for review");
    await waiting.getByRole("button", { name: "Close" }).click();

    await page.getByRole("button", { name: "Open Security review" }).click();
    const detail = page.getByRole("dialog", { name: "Security review" });
    await expect(detail.getByRole("row").filter({ hasText: "v2" })).toContainText("Approved");
    await expectAxeClean(page, "the sub-process dialog");
    await detail.getByRole("button", { name: "Propose a new version" }).click();
    const propose = page.getByRole("dialog", { name: "Propose a new version of Security review" });
    await expect(propose.getByRole("textbox", { name: "Stages (JSON)" })).toHaveValue(JSON.stringify([{ id: "plan", type: "planning" }], null, 2));
    await propose.getByRole("combobox", { name: "Reviewer" }).selectOption(REVIEWER);
    await propose.getByRole("button", { name: "Send for review" }).click();
    await expect(propose).toBeHidden();
    expect(mock.posts.at(-1)).toEqual({ url: `/v1/workflows/fragments/${FRAG}/versions`, body: { stages: [{ id: "plan", type: "planning" }], reviewerUserId: REVIEWER } });
  });
});
