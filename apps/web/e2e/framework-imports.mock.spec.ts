/**
 * ADR-0215 review fixes from the browser's side, every /v1 and /auth call answered by an in-test mock:
 *
 *  - the framework-import drawer shows a control's DESCRIPTION on both sides, so a change to the description alone
 *    (an admin's edit that the import would keep, or a source update) is visible before the admin decides;
 *  - the feed-update drawer lists the entries an update adds, changes and removes (title, instrument, status,
 *    effective date, link) before Accept, and Accept posts to the accept route.
 */
import { expect, test, type Page, type Route } from "@playwright/test";

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

const PROPOSAL = "11111111-1111-4111-8111-111111111111";
const FEED_IMPORT = "22222222-2222-4222-8222-222222222222";

const source = {
  sourceId: "mitre-atlas",
  framework: "mitre-atlas",
  title: "MITRE ATLAS mitigations",
  publisher: "The MITRE Corporation",
  licence: "Apache-2.0",
  licenceUrl: "https://example.org/licence",
  textPolicy: "text",
  sourceVersion: "2026.10",
  retrievedOn: "2026-10-30",
  controls: 2,
  accepted: null,
  pending: { id: PROPOSAL, createdAt: "2026-10-31T00:00:00Z" },
};

const sameTitle = "AML.M0000 — Limit Public Release of Information";
const proposal = {
  id: PROPOSAL,
  sourceId: "mitre-atlas",
  framework: "mitre-atlas",
  status: "pending",
  basePackVersion: 1,
  plan: {
    framework: "mitre-atlas",
    sourceVersion: "2026.10",
    fromVersion: 1,
    toVersion: 2,
    summary: { added: 0, text_updated: 1, unchanged: 0, kept_edited: 1, edited_replaced: 0, not_in_source: 0 },
    changes: [
      {
        controlRef: "mitre-atlas:AML.M0000",
        kind: "kept_edited",
        upstreamChanged: true,
        current: { title: sameTitle, description: "Our own guidance on what we publish." },
        incoming: { title: sameTitle, description: "Limit the public release of technical information about the AI stack." },
      },
      {
        controlRef: "mitre-atlas:AML.M0001",
        kind: "text_updated",
        current: { title: "AML.M0001 — Limit Model Artifact Release", description: "Old upstream wording." },
        incoming: { title: "AML.M0001 — Limit Model Artifact Release", description: "New upstream wording." },
      },
    ],
  },
};

const feedSource = {
  sourceId: "us-federal-register-ai",
  title: "US Federal Register — AI rules",
  publisher: "Office of the Federal Register",
  licence: "US-Gov-Public-Domain",
  licenceUrl: "https://example.org/licence",
  sourceVersion: "2026-10-30",
  retrievedOn: "2026-10-30",
  entries: 2,
  accepted: { id: "33333333-3333-4333-8333-333333333333", decidedAt: "2026-10-30T00:00:00Z", entries: 2, upToDate: false },
  pending: { id: FEED_IMPORT, createdAt: "2026-10-31T00:00:00Z", diff: { added: ["us-fr-2026-1"], changed: ["us-fr-2026-2"], removed: ["us-fr-2025-9"], unchanged: 0 } },
};

const feedEntry = (key: string, title: string, status = "in_force") => ({
  key,
  title,
  instrument: `Federal Register ${key.slice(6)} (Test Agency)`,
  effectiveDate: "2026-09-01",
  status,
  sourceUrl: `https://www.federalregister.gov/d/${key.slice(6)}`,
});

const feedReview = {
  id: FEED_IMPORT,
  sourceId: "us-federal-register-ai",
  sourceVersion: "2026-10-30",
  status: "pending",
  added: [feedEntry("us-fr-2026-1", "Use of artificial intelligence in benefit decisions")],
  changed: [{ ...feedEntry("us-fr-2026-2", "AI disclosures (final rule)"), previous: feedEntry("us-fr-2026-2", "AI disclosures (proposed rule)", "proposed") }],
  removed: [feedEntry("us-fr-2025-9", "Withdrawn AI notice")],
};

async function mockApi(page: Page) {
  const posts: string[] = [];
  await page.route("**/*", async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    if (req.resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    if (p === "/auth/me") return json(route, { userId: "ada", isAdmin: true, via: "session", user: { id: "ada", email: "ada@example.test", displayName: "Ada Admin" }, mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false });
    if (p === "/v1/me") return json(route, { userId: "ada", isAdmin: true, user: { id: "ada", email: "ada@example.test", displayName: "Ada Admin" } });
    if (req.method() === "POST") {
      posts.push(p);
      return json(route, { ok: true });
    }
    if (p === "/v1/compliance/framework-imports") return json(route, { enabled: true, sources: [source] });
    if (p === `/v1/compliance/framework-imports/proposals/${PROPOSAL}`) return json(route, { proposal });
    if (p === "/v1/regulatory/feed-imports") return json(route, { enabled: true, sources: [feedSource] });
    if (p === `/v1/regulatory/feed-imports/${FEED_IMPORT}`) return json(route, { feedImport: feedReview });
    return json(route, {});
  });
  return posts;
}

test.describe("ADR-0215: import decisions show what is being approved", () => {
  test("a description-only change is visible on both sides in the framework-import drawer", async ({ page }) => {
    await mockApi(page);
    await page.goto("/ui/admin/compliance-packs/imports");
    await page.getByRole("button", { name: "Review import" }).click();
    const drawer = page.getByRole("dialog");
    await expect(drawer.getByRole("heading", { name: /version 2$/ })).toBeVisible();

    // the edited control: the titles are identical, so only the description tells the admin what ticking the box replaces
    const edited = drawer.getByRole("listitem").filter({ has: page.getByText("mitre-atlas:AML.M0000", { exact: true }) });
    await expect(edited.getByText("Changes: description")).toBeVisible();
    await expect(edited.getByText("Our own guidance on what we publish.")).toBeVisible();
    await expect(edited.getByText("Limit the public release of technical information about the AI stack.")).toBeVisible();
    await expect(edited.getByRole("checkbox")).not.toBeChecked();

    // a source update that changes only the description
    const updated = drawer.getByRole("listitem").filter({ has: page.getByText("mitre-atlas:AML.M0001", { exact: true }) });
    await expect(updated.getByText("Changes: description")).toBeVisible();
    await expect(updated.getByText("Old upstream wording.")).toBeVisible();
    await expect(updated.getByText("New upstream wording.")).toBeVisible();
  });

  test("the feed-update drawer lists added, changed and removed entries before Accept", async ({ page }) => {
    const posts = await mockApi(page);
    await page.goto("/ui/admin/governance/regulatory/sources");
    await page.getByRole("button", { name: "Review update" }).click();
    const drawer = page.getByRole("dialog");

    await expect(drawer.getByRole("link", { name: "Use of artificial intelligence in benefit decisions" })).toHaveAttribute(
      "href",
      "https://www.federalregister.gov/d/2026-1",
    );
    await expect(drawer.getByText(/Federal Register 2026-1 \(Test Agency\) · In force · effective 1 Sept? 2026/)).toBeVisible();
    // a changed entry shows what is in the feed now and what it becomes
    await expect(drawer.getByRole("link", { name: "AI disclosures (proposed rule)" })).toBeVisible();
    await expect(drawer.getByRole("link", { name: "AI disclosures (final rule)" })).toBeVisible();
    await expect(drawer.getByRole("link", { name: "Withdrawn AI notice" })).toBeVisible();

    expect(posts).toEqual([]);
    await page.getByRole("button", { name: "Accept entries" }).click();
    await expect.poll(() => posts).toEqual([`/v1/regulatory/feed-imports/${FEED_IMPORT}/accept`]);
  });
});
