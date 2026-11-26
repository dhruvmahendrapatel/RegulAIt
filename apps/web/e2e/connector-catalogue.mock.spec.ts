/**
 * The governed connector catalogue (ADR-0255), from the browser's side. Every /v1 and /auth call is answered by an
 * in-test mock that follows apps/gateway/src/connector-catalogue.ts: the GET's shape (curated pieces, and the
 * community pieces as a page with total, limit and offset, filtered by `q` as a substring of the key), the strict
 * query (only limit, offset and q), the enablement POST with `{ enabled, reason }`, the `settings_relax` step-up on
 * enabling only, and the 409 `piece_has_no_adapter` for a community piece.
 *
 * Covered: the list (status, actions, upstream, paging through the community pieces, why a community piece cannot be
 * enabled), the debounced server search and its empty state, a failed read with Retry, enabling with a required
 * reason and the step-up, a declined step-up that changes nothing and keeps the reason, disabling with a reason and
 * no step-up, an air-gapped deployment where enabling is unavailable and says why, and axe in light and dark.
 * Synthetic names only.
 */
import { expect, test, type Page, type Route } from "@playwright/test";
import { expectAxeClean } from "./builder-fixtures";
import { confirmStepUp, requireStepUpOn } from "./step-up-harness";

const NOW = "2026-11-10T09:00:00.000Z";
const PATH = "/v1/connector-catalogue";
const ENABLE = (key: string) => `${PATH}/${key}/enablement`;

const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

const curated = (key: string, displayName: string, enabled: boolean) => ({
  key,
  providerKind: `piece_${key.replace(/-/g, "_")}`,
  displayName,
  upstream: { npm: `@activepieces/piece-${key}`, version: "0.1.0", path: `packages/pieces/community/${key}` },
  enabled,
  actions: [
    { name: "list_items", displayName: "List items", operation: "read" },
    { name: "send_item", displayName: "Send item", operation: "write" },
  ],
});

// 60 synthetic community pieces plus one that a search finds alone
const COMMUNITY = [...Array.from({ length: 60 }, (_, i) => `sample-piece-${String(i + 1).padStart(2, "0")}`), "weather-feed"];

interface Opts {
  failList?: number;
  airGapped?: boolean;
}

async function mockApi(page: Page, opts: Opts = {}) {
  const calls: Array<{ method: string; path: string; body: unknown; query: URLSearchParams }> = [];
  let failList = opts.failList ?? 0;
  const st = { pieces: [curated("chat-notify", "Chat notify", true), curated("sheet-sync", "Sheet sync", false)], enabledBy: { "chat-notify": "ada" } as Record<string, string | null> };
  const view = (p: ReturnType<typeof curated>) => ({
    key: p.key,
    providerKind: p.providerKind,
    displayName: p.displayName,
    upstream: p.upstream,
    status: p.enabled ? "enabled" : "not_enabled",
    enabledAt: p.enabled ? NOW : null,
    enabledByUserId: p.enabled ? st.enabledBy[p.key] ?? null : null,
    actions: p.actions,
  });
  await page.route("**/*", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname;
    if (req.resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    const method = req.method();
    let body: unknown = null;
    try {
      body = req.postDataJSON();
    } catch {
      body = null;
    }
    calls.push({ method, path: p, body, query: url.searchParams });
    if (p === "/auth/me" || p === "/v1/me") {
      return json(route, { userId: "ada", isAdmin: true, via: "session", user: { id: "ada", email: "ada@example.test", displayName: "Ada Admin" }, mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false });
    }
    if (p === "/v1/users") return json(route, { users: [{ id: "ada", email: "ada@example.test", displayName: "Ada Admin", isAdmin: true, disabledAt: null }] });
    if (p === PATH && method === "GET") {
      // the route's query schema is strict: anything but limit, offset and q is a 400
      for (const k of url.searchParams.keys()) if (!["limit", "offset", "q"].includes(k)) return json(route, { error: "invalid_query" }, 400);
      if (failList > 0) {
        failList -= 1;
        return json(route, { error: "internal_error" }, 500);
      }
      const limit = Number(url.searchParams.get("limit") ?? 50);
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const q = url.searchParams.get("q")?.toLowerCase();
      const matching = q ? COMMUNITY.filter((k) => k.includes(q)) : COMMUNITY;
      return json(route, {
        deployMode: opts.airGapped ? "air_gapped" : "hosted",
        runnable: !opts.airGapped,
        curated: st.pieces.map(view),
        available: {
          total: matching.length,
          limit,
          offset,
          source: { repository: "github.com/activepieces/activepieces", commit: "0123456789abcdef0123456789abcdef01234567", licence: "MIT" },
          items: matching.slice(offset, offset + limit).map((key) => ({ key, npm: `@activepieces/piece-${key}`, version: "0.0.1", upstreamPath: `packages/pieces/community/${key}`, status: "available_not_enabled" })),
        },
      });
    }
    const en = p.match(/^\/v1\/connector-catalogue\/([^/]+)\/enablement$/);
    if (en && method === "POST") {
      const key = decodeURIComponent(en[1]!);
      const piece = st.pieces.find((x) => x.key === key);
      if (!piece) return json(route, COMMUNITY.includes(key) ? { error: "piece_has_no_adapter", detail: "no governed adapter" } : { error: "unknown_piece" }, COMMUNITY.includes(key) ? 409 : 404);
      const b = body as { enabled: boolean; reason: string };
      if (typeof b?.enabled !== "boolean" || typeof b.reason !== "string" || b.reason.trim().length < 3) return json(route, { error: "invalid_body" }, 400);
      piece.enabled = b.enabled;
      st.enabledBy[key] = "ada";
      return json(route, { piece: view(piece) });
    }
    return json(route, {});
  });
  return { calls, st };
}

const card = (page: Page, title: string) => page.locator("[data-rg-card]").filter({ has: page.getByText(title, { exact: true }) });
const listCalls = (calls: Array<{ method: string; path: string; query: URLSearchParams }>) => calls.filter((c) => c.method === "GET" && c.path === PATH);
const posts = (calls: Array<{ method: string; path: string; body: unknown }>) => calls.filter((c) => c.method === "POST" && c.path.endsWith("/enablement"));

test.describe("connector catalogue", () => {
  test("lists the curated pieces and pages through the community pieces, which cannot be enabled and say why", async ({ page }) => {
    const { calls } = await mockApi(page);
    await page.goto("/ui/admin/connectors");
    await page.getByRole("link", { name: "Connector catalogue" }).click();
    await expect(page).toHaveURL(/\/ui\/admin\/connectors\/catalogue$/);
    await expect(page.getByRole("heading", { name: "Connector catalogue" })).toBeVisible();

    const curatedCard = card(page, "Curated pieces");
    const chat = curatedCard.getByRole("row").filter({ hasText: "Chat notify" });
    await expect(chat).toContainText("Enabled");
    await expect(chat).toContainText("2 actions: 1 read, 1 write");
    await expect(chat).toContainText("@activepieces/piece-chat-notify 0.1.0");
    await expect(chat).toContainText("by Ada Admin");
    await expect(chat.getByRole("button", { name: "Disable Chat notify" })).toBeVisible();
    const sheet = curatedCard.getByRole("row").filter({ hasText: "Sheet sync" });
    await expect(sheet).toContainText("Not enabled");
    await expect(sheet.getByRole("button", { name: "Enable Sheet sync" })).toBeVisible();

    const community = card(page, "Community pieces");
    await expect(community.getByText("1–50 of 61")).toBeVisible();
    const row = community.getByRole("row").filter({ hasText: "sample-piece-01" });
    await expect(row).toContainText("Available, not enabled");
    const blocked = row.getByRole("button", { name: "Enable sample-piece-01" });
    await expect(blocked).toHaveAttribute("aria-disabled", "true");
    await expect(blocked).toHaveAccessibleDescription("No governed adapter yet, so it cannot be enabled.");
    await blocked.click({ force: true });
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(community.getByRole("button", { name: "Previous" })).toHaveAttribute("aria-disabled", "true");
    await expectAxeClean(page, "connector catalogue");

    await community.getByRole("button", { name: "Next" }).click();
    await expect(community.getByText("51–61 of 61")).toBeVisible();
    await expect(community.getByRole("row").filter({ hasText: "weather-feed" })).toBeVisible();
    await expect(community.getByRole("button", { name: "Next" })).toHaveAttribute("aria-disabled", "true");
    const last = listCalls(calls).at(-1)!;
    expect(Object.fromEntries(last.query)).toEqual({ limit: "50", offset: "50" });
    expect(posts(calls)).toHaveLength(0);
  });

  test("the search runs on the server once typing settles, starts at the first page, and says when nothing matches", async ({ page }) => {
    const { calls } = await mockApi(page);
    await page.goto("/ui/admin/connectors/catalogue");
    const community = card(page, "Community pieces");
    await community.getByRole("button", { name: "Next" }).click();
    await expect(community.getByText("51–61 of 61")).toBeVisible();
    const before = listCalls(calls).length;
    await community.getByLabel("Search community pieces").pressSequentially("weather", { delay: 20 });
    await expect(community.getByText("1–1 of 1")).toBeVisible();
    // debounced: one read for the settled search, not one per keystroke
    const searched = listCalls(calls).slice(before);
    expect(searched.map((c) => Object.fromEntries(c.query))).toEqual([{ limit: "50", offset: "0", q: "weather" }]);
    await community.getByLabel("Search community pieces").fill("no-such-piece");
    await expect(community.getByText("No pieces match", { exact: true }).first()).toBeVisible();
    await expect(community.getByText("Try a different search.")).toBeVisible();
    await expectAxeClean(page, "connector catalogue: no match");
  });

  test("a failed read is an error with Retry, never an empty catalogue", async ({ page }) => {
    // the read and the client's one automatic retry both fail
    await mockApi(page, { failList: 2 });
    await page.goto("/ui/admin/connectors/catalogue");
    await expect(page.getByRole("alert").first()).toBeVisible();
    await expect(page.getByText("No curated pieces")).toHaveCount(0);
    await page.getByRole("button", { name: "Retry" }).click();
    await expect(card(page, "Curated pieces").getByRole("row").filter({ hasText: "Sheet sync" })).toBeVisible();
  });

  test("enabling needs a reason and the step-up; the piece is then enabled", async ({ page }) => {
    const { calls } = await mockApi(page);
    await page.goto("/ui/admin/connectors/catalogue");
    const sheet = card(page, "Curated pieces").getByRole("row").filter({ hasText: "Sheet sync" });
    await sheet.getByRole("button", { name: "Enable Sheet sync" }).click();
    const dialog = page.getByRole("dialog", { name: "Enable Sheet sync?" });
    await expect(dialog).toContainText("You will be asked to confirm it's you.");
    const confirm = dialog.getByRole("button", { name: "Enable Sheet sync" });
    // nothing is sent without a reason, and the button says why it is unavailable
    await expect(confirm).toHaveAttribute("aria-disabled", "true");
    await expect(confirm).toHaveAccessibleDescription(/unavailable until there is a reason/);
    await confirm.click({ force: true });
    await expect(dialog.getByText("Give a reason. It becomes the audited record.").first()).toBeVisible();
    expect(posts(calls)).toHaveLength(0);
    await expectAxeClean(page, "connector catalogue: enable dialog");

    const su = await requireStepUpOn(page, { method: "POST", path: ENABLE("sheet-sync"), kind: "settings_relax" });
    await dialog.getByLabel("Reason (required, audited)").fill("  Finance sheet sync, change ticket FIN-7  ");
    await expect(confirm).not.toHaveAttribute("aria-disabled", "true");
    await confirm.click();
    await expect(page.getByTestId("catalogue-flow")).toContainText("Confirm it's you in the dialog to continue.");
    await confirmStepUp(page);
    await su.expectResentOnce();
    expect(su.attempts[0]!.body).toEqual({ enabled: true, reason: "Finance sheet sync, change ticket FIN-7" });
    await expect(page.getByTestId("catalogue-flow")).toContainText("Sheet sync enabled. The change is in the audit log.");
    await expect(sheet).toContainText("Enabled");
    await expect(sheet.getByRole("button", { name: "Disable Sheet sync" })).toBeVisible();
  });

  test("a declined step-up changes nothing; trying again keeps the reason", async ({ page }) => {
    const { st } = await mockApi(page);
    await page.goto("/ui/admin/connectors/catalogue");
    const sheet = card(page, "Curated pieces").getByRole("row").filter({ hasText: "Sheet sync" });
    await sheet.getByRole("button", { name: "Enable Sheet sync" }).click();
    const dialog = page.getByRole("dialog", { name: "Enable Sheet sync?" });
    await dialog.getByLabel("Reason (required, audited)").fill("Pilot for the reporting team");
    const su = await requireStepUpOn(page, { method: "POST", path: ENABLE("sheet-sync"), kind: "settings_relax" });
    await dialog.getByRole("button", { name: "Enable Sheet sync" }).click();
    await page.getByRole("dialog", { name: "Confirm it's you" }).getByRole("button", { name: "Cancel" }).click();
    const flow = page.getByTestId("catalogue-flow");
    await expect(flow.getByRole("alert")).toHaveText("Sheet sync was not enabled: you did not confirm it's you. Nothing changed.");
    expect(su.attempts).toHaveLength(1);
    expect(st.pieces.find((p) => p.key === "sheet-sync")!.enabled).toBe(false);
    await expect(sheet).toContainText("Not enabled");

    await flow.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByRole("dialog", { name: "Enable Sheet sync?" }).getByLabel("Reason (required, audited)")).toHaveValue("Pilot for the reporting team");
    await page.getByRole("dialog", { name: "Enable Sheet sync?" }).getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByTestId("catalogue-flow")).toHaveCount(0);
  });

  test("disabling needs a reason and no step-up", async ({ page }) => {
    const { calls } = await mockApi(page);
    await page.goto("/ui/admin/connectors/catalogue");
    const chat = card(page, "Curated pieces").getByRole("row").filter({ hasText: "Chat notify" });
    await chat.getByRole("button", { name: "Disable Chat notify" }).click();
    const dialog = page.getByRole("dialog", { name: "Disable Chat notify?" });
    await expect(dialog).toContainText("refused from then on");
    await dialog.getByLabel("Reason (required, audited)").fill("Replaced by the in-house notifier");
    await dialog.getByRole("button", { name: "Disable Chat notify" }).click();
    await expect(page.getByTestId("catalogue-flow")).toContainText("Chat notify disabled. The change is in the audit log.");
    await expect(page.getByRole("dialog", { name: "Confirm it's you" })).toHaveCount(0);
    expect(posts(calls).map((c) => c.body)).toEqual([{ enabled: false, reason: "Replaced by the in-house notifier" }]);
    await expect(chat).toContainText("Not enabled");
    await expect(chat.getByRole("button", { name: "Enable Chat notify" })).toBeVisible();
  });

  test("on an air-gapped deployment enabling is unavailable and says why; disabling still works", async ({ page }) => {
    await mockApi(page, { airGapped: true });
    await page.goto("/ui/admin/connectors/catalogue");
    await expect(page.getByTestId("catalogue-air-gapped")).toContainText("air-gapped");
    const sheet = card(page, "Curated pieces").getByRole("row").filter({ hasText: "Sheet sync" });
    const enable = sheet.getByRole("button", { name: "Enable Sheet sync" });
    await expect(enable).toHaveAttribute("aria-disabled", "true");
    await expect(enable).toHaveAccessibleDescription("This deployment is air-gapped: catalogue pieces call public SaaS APIs.");
    await enable.click({ force: true });
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(card(page, "Curated pieces").getByRole("button", { name: "Disable Chat notify" })).not.toHaveAttribute("aria-disabled", "true");
    await expectAxeClean(page, "connector catalogue: air-gapped");
  });
});
