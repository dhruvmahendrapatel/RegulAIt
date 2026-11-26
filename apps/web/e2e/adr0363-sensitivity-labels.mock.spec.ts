/**
 * ADR-0363 slice 1 — the sensitivity labels page, against a mocked gateway:
 *
 *  - the labels read as a tree (a child under its parent), each with what happens today; an unmapped label shows the
 *    fallback it follows;
 *  - a new mapping opens on "block" and "restricted" (never a permissive default);
 *  - loosening a mapping or a fallback is confirmed, then goes through the step-up prompt and is resent once;
 *    tightening is a plain PUT;
 *  - removing a mapping is confirmed and sends a DELETE;
 *  - with nothing synced, the page says every labelled file is blocked and links to the scan set-up;
 *  - axe (WCAG 2.x A/AA) in light and dark.
 */
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";
import { confirmStepUp, requireStepUpOn } from "./step-up-harness";

const CONF = "11111111-1111-4111-8111-111111111111";
const FIN = "22222222-2222-4222-8222-222222222222";
const PUB = "33333333-3333-4333-8333-333333333333";
const PROFILE = "44444444-4444-4444-8444-444444444444";
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

const base = { provider: "microsoft_purview", tenantId: "tenant-1", rank: 1, active: true, syncedAt: "2026-11-20T03:00:00Z" };

interface State {
  puts: Array<{ path: string; body: unknown; stepUp: string | null }>;
  deletes: string[];
}

async function mock(page: Page, opts: { empty?: boolean } = {}): Promise<State> {
  const state: State = { puts: [], deletes: [] };
  const labels: Record<string, unknown>[] = opts.empty
    ? []
    : [
        { ...base, id: FIN, labelId: "L-FIN", name: "Finance", parentLabelId: "L-CONF", rule: null },
        { ...base, id: CONF, labelId: "L-CONF", name: "Confidential", parentLabelId: null, rank: 3, rule: { action: "redact", sensitivity: "confidential", complianceProfileId: PROFILE } },
        { ...base, id: PUB, labelId: "L-PUB", name: "Public", parentLabelId: null, rank: 0, rule: { action: "allow", sensitivity: "public", complianceProfileId: null } },
      ];
  const settings = { unmappedAction: "block", protectedAction: "block", unreadableAction: "block", strictDefault: true };
  const me = { id: "riley", email: "riley@example.test", displayName: "Riley Admin" };
  await page.route("**/*", async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    if (req.resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    const m = req.method();
    if (p === "/auth/me") return json(route, { userId: me.id, isAdmin: true, via: "session", user: me, mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false });
    if (p === "/v1/me") return json(route, { userId: me.id, isAdmin: true, user: me });
    if (p === "/v1/compliance/profiles") return json(route, { profiles: [{ id: PROFILE, tag: "pci", status: "active" }] });
    if (p === "/v1/sensitivity-labels" && m === "GET") return json(route, { settings, trustedTenantIds: ["tenant-1"], labels });
    if (p === "/v1/sensitivity-labels/settings" && m === "PUT") {
      const body = req.postDataJSON() as Record<string, string>;
      state.puts.push({ path: p, body, stepUp: req.headers()["x-regulait-step-up"] ?? null });
      Object.assign(settings, body);
      return json(route, settings);
    }
    const rule = /^\/v1\/sensitivity-labels\/([^/]+)\/rule$/.exec(p);
    if (rule && m === "PUT") {
      const body = req.postDataJSON();
      state.puts.push({ path: p, body, stepUp: req.headers()["x-regulait-step-up"] ?? null });
      labels.find((l) => l.id === rule[1])!.rule = body;
      return json(route, { definitionId: rule[1], rule: body });
    }
    if (rule && m === "DELETE") {
      state.deletes.push(rule[1]!);
      labels.find((l) => l.id === rule[1])!.rule = null;
      return route.fulfill({ status: 204 });
    }
    if (m === "GET") return json(route, {});
    return json(route, { error: "not_found" }, 404);
  });
  return state;
}

test.describe("ADR-0363: sensitivity labels", () => {
  test("shows the tree and what each label does; a new mapping opens strict; tightening needs no step-up", async ({ page }) => {
    const state = await mock(page);
    await page.goto("/ui/admin/sensitivity-labels");
    await expect(page.getByRole("heading", { name: "Sensitivity labels" })).toBeVisible();
    await expect(page.getByText("under Confidential", { exact: false })).toBeVisible();
    await expect(page.getByText("Not mapped: follows the fallback")).toBeVisible();
    await expect(page.getByText("Confidential · profile pci")).toBeVisible();
    await expect(page.getByText("All three block, which is the strict default.")).toBeVisible();
    await expectAxeClean(page, "Sensitivity labels");

    await page.getByRole("button", { name: "Map Finance" }).click();
    const dialog = page.getByRole("dialog", { name: "Map Finance" });
    await expect(dialog.getByRole("combobox", { name: "What happens" })).toHaveValue("block");
    await expect(dialog.getByRole("combobox", { name: "Data sensitivity" })).toHaveValue("restricted");
    await expect(dialog.getByRole("combobox", { name: "Compliance profile" })).toHaveValue("");
    await dialog.getByRole("combobox", { name: "Compliance profile" }).selectOption(PROFILE);
    await dialog.getByRole("button", { name: "Save mapping" }).click();
    await expect.poll(() => state.puts).toEqual([
      { path: `/v1/sensitivity-labels/${FIN}/rule`, body: { action: "block", sensitivity: "restricted", complianceProfileId: PROFILE }, stepUp: null },
    ]);
  });

  test("loosening a mapping is confirmed, then step-up'd and resent once", async ({ page }) => {
    await mock(page);
    const su = await requireStepUpOn(page, { method: "PUT", path: `/v1/sensitivity-labels/${CONF}/rule`, kind: "settings_relax" });
    await page.goto("/ui/admin/sensitivity-labels");
    await page.getByRole("button", { name: "Edit Confidential" }).click();
    const dialog = page.getByRole("dialog", { name: "Map Confidential" });
    await dialog.getByRole("combobox", { name: "What happens" }).selectOption("allow");
    await dialog.getByRole("button", { name: "Save mapping" }).click();
    await page.getByRole("dialog", { name: "Loosen the mapping of Confidential?" }).getByRole("button", { name: "Loosen and save" }).click();
    await confirmStepUp(page);
    await su.expectResentOnce();
    expect(su.attempts[1]!.body).toEqual({ action: "allow", sensitivity: "confidential", complianceProfileId: PROFILE });
  });

  test("loosening a fallback is confirmed and step-up'd; removing a mapping sends a DELETE", async ({ page }) => {
    const state = await mock(page);
    const su = await requireStepUpOn(page, { method: "PUT", path: "/v1/sensitivity-labels/settings", kind: "settings_relax" });
    await page.goto("/ui/admin/sensitivity-labels");
    await page.getByRole("combobox", { name: "An encrypted file" }).selectOption("redact");
    await page.getByRole("button", { name: "Save fallbacks" }).click();
    await page.getByRole("dialog", { name: "Loosen the fallbacks?" }).getByRole("button", { name: "Loosen and save" }).click();
    await confirmStepUp(page);
    await su.expectResentOnce();
    expect(su.attempts[1]!.body).toEqual({ protectedAction: "redact" });

    await expect(page.getByRole("button", { name: "Remove the mapping of Finance" })).toBeDisabled();
    await page.getByRole("button", { name: "Remove the mapping of Public" }).click();
    await page.getByRole("dialog", { name: "Remove the mapping of Public?" }).getByRole("button", { name: "Remove mapping" }).click();
    await expect.poll(() => state.deletes).toEqual([PUB]);
  });

  test("with no labels synced, says everything labelled is blocked and links to the scan set-up", async ({ page }) => {
    await mock(page, { empty: true });
    await page.goto("/ui/admin/sensitivity-labels");
    await expect(page.getByText("No labels synced yet")).toBeVisible();
    await expect(page.getByRole("link", { name: "Set up the identity-provider scan" })).toHaveAttribute("href", /\/admin\/shadow-ai\/discovery-sources$/);
    await expectAxeClean(page, "Sensitivity labels (empty)");
  });
});
