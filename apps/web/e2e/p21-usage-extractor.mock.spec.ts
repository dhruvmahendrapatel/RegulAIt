/**
 * ADR-0241 (P21) — the "Usage counts — custom mapping" card on the Agents page (owner-approved on #453,
 * 2026-11-07), from the browser's side. Every /v1 and /auth call is answered by an in-test mock that follows
 * apps/gateway/src/usage-extractors.ts: the shapes, the 422 `invalid_usage_mapping` with `errors[]`, the exact-count
 * test, the 409 `sample_test_required` (sent before the step-up), the 413 `sample_too_large`, and the
 * `settings_relax` step-up on turning the switch on and on activating.
 *
 * Covered: the list, create (with a 422), test fail and pass, Activate disabled until a pass, activate with the
 * step-up, deactivate, the switch with its step-up (and none to turn it off), the fallback count ("not measured",
 * never 0), the error with Retry, the empty state, the refusals inline, and axe in light and dark.
 * Synthetic names only.
 */
import { expect, test, type Page, type Route } from "@playwright/test";
import { expectAxeClean } from "./builder-fixtures";
import { confirmStepUp, requireStepUpOn } from "./step-up-harness";

const TRIAGE = "c1111111-1111-4111-8111-111111111111";
const SUMMARY = "c2222222-2222-4222-8222-222222222222";
const V1 = "d1111111-1111-4111-8111-111111111111";
const V2 = "d2222222-2222-4222-8222-222222222222";
const NOW = "2026-11-06T10:00:00.000Z";

const users = [{ id: "ada", email: "ada@example.test", displayName: "Ada Admin", isAdmin: true, disabledAt: null }];
const base = { provider: "custom", tier: 1, model: "synthetic-model", enabled: true, costPerMTokIn: 1, costPerMTokOut: 2, systemPrompt: null, lifecycleReason: null, lastReviewedAt: null, lastReviewedByName: null, stewardDeactivated: false, successorDeactivated: false, highestUseCaseTier: null, reviewCadenceMonths: 12, ownerUserId: "ada", stewardUserId: "ada", stewardName: "Ada Admin", successorUserId: null, successorName: null, lifecycleStatus: "active", nextReviewAt: "2027-04-03T12:00:00.000Z", orphaned: false, reviewOverdue: false };
const agents = [
  { ...base, id: TRIAGE, name: "Claims triage" },
  { ...base, id: SUMMARY, name: "Intake summariser" },
];

type Fields = Record<string, { pointer: string }>;
interface Version {
  id: string;
  agentId: string;
  version: number;
  mapping: { format: string; fields: Fields };
  mappingSha256: string;
  createdBy: string;
  createdAt: string;
  latestTest: { id: string; versionId: string; passed: boolean; failure: string | null; testedAt: string } | null;
}
const FIELDS = ["inputTokens", "outputTokens", "cacheReadInputTokens", "cacheCreationInputTokens", "imageInputTokens", "imageOutputTokens", "audioInputTokens", "audioOutputTokens"];

const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

function pointerGet(doc: unknown, pointer: string): unknown {
  let at: unknown = doc;
  for (const seg of pointer.split("/").slice(1)) at = at && typeof at === "object" ? (at as Record<string, unknown>)[seg] : undefined;
  return at;
}

interface Opts {
  /** answer the versions read with a 500 this many times first */
  failVersions?: number;
  /** answer every activate with the 409 (the latest test changed under the admin) */
  activate409?: boolean;
  /** answer every test with the 413 */
  sample413?: boolean;
}

async function mockApi(page: Page, opts: Opts = {}) {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  let enabled = false;
  let activeId: string | null = null;
  let failVersions = opts.failVersions ?? 0;
  const versions: Version[] = [
    {
      id: V2,
      agentId: TRIAGE,
      version: 2,
      mapping: { format: "regulait.usage-mapping/v1", fields: { inputTokens: { pointer: "/usage/input_tokens" }, outputTokens: { pointer: "/usage/completion" } } },
      mappingSha256: "2b".repeat(32),
      createdBy: "ada",
      createdAt: "2026-11-04T09:00:00.000Z",
      latestTest: { id: "t-2", versionId: V2, passed: false, failure: "the mapping's counts differ from the expected counts for: outputTokens", testedAt: "2026-11-04T09:05:00.000Z" },
    },
    {
      id: V1,
      agentId: TRIAGE,
      version: 1,
      mapping: { format: "regulait.usage-mapping/v1", fields: { inputTokens: { pointer: "/usage/input_tokens" }, outputTokens: { pointer: "/usage/output_tokens" } } },
      mappingSha256: "1a".repeat(32),
      createdBy: "ada",
      createdAt: "2026-11-03T09:00:00.000Z",
      latestTest: null,
    },
  ];
  await page.route("**/*", async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    if (req.resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    const method = req.method();
    let body: unknown = null;
    try {
      body = req.postDataJSON();
    } catch {
      body = null;
    }
    calls.push({ method, path: p, body });
    if (p === "/auth/me") return json(route, { userId: "ada", isAdmin: true, via: "session", user: { id: "ada", email: "ada@example.test", displayName: "Ada Admin" }, mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false });
    if (p === "/v1/me") return json(route, { userId: "ada", isAdmin: true, user: { id: "ada", email: "ada@example.test", displayName: "Ada Admin" } });
    if (p === "/v1/agents") return json(route, { agents });
    if (p === "/v1/users") return json(route, { users });
    if (p === "/v1/custom-model-providers") return json(route, { providers: [] });
    if (p === "/v1/usage-extractors") {
      const a = versions.find((v) => v.id === activeId);
      return json(route, { enabled, active: a ? [{ agentId: a.agentId, versionId: a.id, version: a.version, testId: a.latestTest!.id, activatedBy: "ada", activatedAt: NOW }] : [] });
    }
    if (p === "/v1/usage-extractors/enabled" && method === "PUT") {
      const next = (body as { enabled: boolean }).enabled;
      const changed = next !== enabled;
      enabled = next;
      return json(route, { enabled, changed });
    }
    const m = p.match(/^\/v1\/agents\/([^/]+)\/usage-extractor\/(versions|deactivate)(?:\/([^/]+)\/(test|activate))?$/);
    if (m) {
      const [, agentId, kind, versionId, action] = m;
      const mine = versions.filter((v) => v.agentId === agentId).sort((x, y) => y.version - x.version);
      if (kind === "deactivate") {
        const changed = mine.some((v) => v.id === activeId);
        if (changed) activeId = null;
        return json(route, { agentId, deactivated: changed });
      }
      if (!action && method === "GET") {
        if (failVersions > 0) {
          failVersions -= 1;
          return json(route, { error: "internal_error" }, 500);
        }
        return json(route, { enabled, activeVersionId: mine.some((v) => v.id === activeId) ? activeId : null, versions: mine });
      }
      if (!action && method === "POST") {
        const fields = ((body as { mapping?: { fields?: Fields } }).mapping?.fields ?? {}) as Fields;
        const errors = Object.entries(fields)
          .filter(([, src]) => typeof src.pointer === "string" && !src.pointer.startsWith("/"))
          .map(([f]) => `mapping.fields.${f}: not an RFC 6901 JSON pointer`);
        if (errors.length) return json(route, { error: "invalid_usage_mapping", errors }, 422);
        const row: Version = {
          id: `d3333333-3333-4333-8333-33333333333${mine.length + 1}`,
          agentId: agentId!,
          version: (mine[0]?.version ?? 0) + 1,
          mapping: (body as { mapping: Version["mapping"] }).mapping,
          mappingSha256: "3c".repeat(32),
          createdBy: "ada",
          createdAt: NOW,
          latestTest: null,
        };
        versions.push(row);
        return json(route, row, 201);
      }
      const v = versions.find((x) => x.id === versionId && x.agentId === agentId);
      if (!v) return json(route, { error: "unknown_usage_extractor_version" }, 404);
      if (action === "test") {
        if (opts.sample413) return json(route, { error: "sample_too_large", detail: "a sample is at most 1048576 bytes of JSON" }, 413);
        const { sample, expected } = body as { sample: unknown; expected: Record<string, number> };
        const extracted = Object.fromEntries(FIELDS.map((f) => [f, v.mapping.fields[f] ? Number(pointerGet(sample, v.mapping.fields[f]!.pointer) ?? 0) : 0]));
        const diff = FIELDS.filter((f) => (expected[f] ?? 0) !== extracted[f]);
        const failure = diff.length ? `the mapping's counts differ from the expected counts for: ${diff.join(", ")}` : null;
        v.latestTest = { id: `t-${v.version}-${Date.now()}`, versionId: v.id, passed: failure === null, failure, testedAt: NOW };
        return json(route, { testId: v.latestTest.id, passed: failure === null, extracted, failure });
      }
      if (action === "activate") {
        if (opts.activate409 || !v.latestTest?.passed) return json(route, { error: "sample_test_required", detail: "a version activates only when its latest sample test passed" }, 409);
        activeId = v.id;
        return json(route, { agentId, versionId: v.id, version: v.version, testId: v.latestTest.id, activated: true });
      }
    }
    return json(route, {});
  });
  return { calls, versions };
}

const usageCard = (page: Page) => page.locator("[data-rg-card]").filter({ has: page.getByText("Usage counts — custom mapping", { exact: true }) });

async function openTriage(page: Page) {
  await page.goto("/ui/admin/agents");
  const card = usageCard(page);
  await card.getByLabel("Agent", { exact: true }).selectOption(TRIAGE);
  await expect(card.getByText("Versions for Claims triage")).toBeVisible();
  return card;
}

const SAMPLE = JSON.stringify({ id: "resp-0001", usage: { input_tokens: 1840, output_tokens: 212, cached_tokens: 600 } }, null, 2);

test.describe("ADR-0241 (P21): usage counts — custom mapping", () => {
  test("the list, the fallback count, and the switch: on asks for a step-up, off does not", async ({ page }) => {
    const { calls } = await mockApi(page);
    const card = await openTriage(page);

    // the versions, newest first, each with its latest test
    const v2 = card.getByRole("row").filter({ has: page.getByRole("button", { name: "Activate version 2" }) });
    await expect(v2).toContainText("Text in, text out");
    await expect(v2).toContainText("✕ Failed");
    const v1 = card.getByRole("row").filter({ has: page.getByRole("button", { name: "Activate version 1" }) });
    await expect(v1).toContainText("Not tested");
    await expect(v1.getByRole("button", { name: "Run a sample test: version 1" })).toBeVisible();

    // Activate is disabled until the version's latest test passed, and says why beside it
    await expect(card.getByRole("button", { name: "Activate version 2" })).toBeDisabled();
    await expect(card.getByRole("button", { name: "Activate version 2" })).toHaveAccessibleDescription("Activates only after its latest test passed");
    await expect(v2.getByText("Activates only after its latest test passed")).toBeVisible();

    // nothing is active, and the fallback count is not measured (never an invented 0), with the audit log one click away
    await expect(card.getByTestId("usage-counting-with")).toHaveText("The built-in adapter");
    await expect(card.getByTestId("usage-fallbacks")).toContainText("not measured");
    await expect(card.getByTestId("usage-fallbacks")).not.toContainText("0");
    await expect(card.getByRole("link", { name: "view in audit log" })).toHaveAttribute("href", "/ui/admin/audit");

    // off by default, and the card says what off means
    const sw = card.getByRole("switch", { name: "Use custom mappings" });
    await expect(sw).toHaveAttribute("aria-checked", "false");
    await expect(card.getByText(/^Off: every agent is counted by its adapter's built-in extraction\./)).toBeVisible();
    await expectAxeClean(page, "Usage counts: the version list, switch off");

    // on: a settings_relax step-up, then the same PUT resent with the grant
    const su = await requireStepUpOn(page, { method: "PUT", path: "/v1/usage-extractors/enabled", kind: "settings_relax", when: (b) => (b as { enabled?: boolean })?.enabled === true });
    await sw.click();
    await confirmStepUp(page);
    await su.expectResentOnce();
    expect(su.attempts[0]!.body).toEqual({ enabled: true });
    await expect(sw).toHaveAttribute("aria-checked", "true");
    await expect(card.getByText(/^On: an agent with an active version is counted by it\./)).toBeVisible();

    // off: returns to the built-in counts and asks for nothing
    await sw.click();
    await expect(sw).toHaveAttribute("aria-checked", "false");
    expect(su.attempts).toHaveLength(2);
    const puts = calls.filter((c) => c.method === "PUT" && c.path === "/v1/usage-extractors/enabled").map((c) => c.body);
    expect(puts.at(-1)).toEqual({ enabled: false });
    // no audit read was invented for the count
    expect(calls.some((c) => c.path.startsWith("/v1/audit"))).toBe(false);
  });

  test("create (a 422 shown inline), test fail then pass, activate with a step-up, deactivate", async ({ page }) => {
    const { calls } = await mockApi(page);
    const card = await openTriage(page);

    await card.getByRole("button", { name: "New version" }).click();
    const editor = card.getByRole("region", { name: /Where the counts are — version 3/ });
    await editor.getByLabel("Text in (required)").fill("/usage/input_tokens");
    await editor.getByLabel("Text out (required)").fill("usage/output_tokens");
    await editor.getByLabel("Cache read").fill("/usage/cached_tokens");
    await editor.getByRole("button", { name: "Save version 3" }).click();
    // the gateway's own errors[], inline beside the save
    await expect(editor.getByRole("alert")).toContainText("Cannot save yet:");
    await expect(editor.getByRole("alert")).toContainText("mapping.fields.outputTokens: not an RFC 6901 JSON pointer");
    await expectAxeClean(page, "Usage counts: a refused save");

    await editor.getByLabel("Text out (required)").fill("/usage/output_tokens");
    await editor.getByRole("button", { name: "Save version 3" }).click();
    const saved = calls.filter((c) => c.method === "POST" && c.path === `/v1/agents/${TRIAGE}/usage-extractor/versions`).at(-1)!.body;
    expect(saved).toEqual({
      mapping: {
        format: "regulait.usage-mapping/v1",
        fields: { inputTokens: { pointer: "/usage/input_tokens" }, outputTokens: { pointer: "/usage/output_tokens" }, cacheReadInputTokens: { pointer: "/usage/cached_tokens" } },
      },
    });

    // the test panel opens for the new version; a wrong count fails, row by row
    const panel = card.getByRole("region", { name: /Test version 3 against a sample response/ });
    await panel.getByLabel("Sample response (JSON, up to 1 MB)").fill(SAMPLE);
    await panel.getByLabel("Text in").fill("1840");
    await panel.getByLabel("Text out").fill("200");
    await panel.getByLabel("Cache read").fill("600");
    await panel.getByRole("button", { name: "Run test" }).click();
    const result = panel.getByRole("status");
    await expect(result).toContainText("✕ Failed — the mapping's counts differ from the expected counts for: outputTokens");
    await expect(result.getByRole("row").filter({ hasText: "Text out" })).toContainText("200");
    await expect(result.getByRole("row").filter({ hasText: "Text out" })).toContainText("212");
    await expect(result.getByRole("row").filter({ hasText: "Text out" })).toContainText("✕ differs");
    await expect(card.getByRole("button", { name: "Activate version 3", exact: true })).toBeDisabled();
    await expect(panel.getByRole("button", { name: /^Activate version 3…/ })).toHaveCount(0);

    // the exact counts pass, and the version can now be activated
    await panel.getByLabel("Text out").fill("212");
    await panel.getByRole("button", { name: "Run test" }).click();
    await expect(result).toContainText("✓ Passed — version 3 can be activated");
    for (const [label, n] of [["Text in", "1,840"], ["Text out", "212"], ["Cache read", "600"]] as const) {
      const row = result.getByRole("row").filter({ hasText: label });
      await expect(row).toContainText(n);
      await expect(row).toContainText("✓ match");
    }
    await expect(card.getByRole("button", { name: "Activate version 3", exact: true })).toBeEnabled();
    const sent = calls.filter((c) => c.path.endsWith("/test")).at(-1)!.body as { expected: unknown };
    expect(sent.expected).toEqual({ inputTokens: 1840, outputTokens: 212, cacheReadInputTokens: 600 });
    await expectAxeClean(page, "Usage counts: a passed test");

    // activate: a settings_relax step-up
    const su = await requireStepUpOn(page, { method: "POST", path: /\/usage-extractor\/versions\/[^/]+\/activate$/, kind: "settings_relax" });
    await panel.getByRole("button", { name: /^Activate version 3…/ }).click();
    await confirmStepUp(page);
    await su.expectResentOnce();
    const v3 = card.getByRole("row").filter({ has: page.getByRole("button", { name: "Deactivate version 3" }) });
    await expect(v3).toContainText("Active");
    await expect(card.getByTestId("usage-counting-with")).toContainText("Version 3");
    await expect(card.getByTestId("usage-counting-with")).toContainText("active since 6 Nov 2026, by Ada Admin");
    await expect(card.getByTestId("usage-counting-with")).toContainText("not used while the switch is off");

    // deactivate: back to the built-in counts, no step-up
    await card.getByRole("button", { name: "Deactivate version 3" }).click();
    await expect(card.getByTestId("usage-counting-with")).toHaveText("The built-in adapter");
    expect(su.attempts).toHaveLength(2);
    expect(calls.some((c) => c.method === "POST" && c.path === `/v1/agents/${TRIAGE}/usage-extractor/deactivate`)).toBe(true);
  });

  test("a 409 on activate says the step-up was not used; a 413 names the sample bound", async ({ page }) => {
    const { calls, versions } = await mockApi(page, { activate409: true, sample413: true });
    // the list says version 2 passed, but the gateway's own check refuses it (the latest test changed meanwhile)
    versions[0]!.latestTest = { id: "t-2b", versionId: V2, passed: true, failure: null, testedAt: NOW };
    const card = await openTriage(page);
    // no step-up harness here: like the gateway, the mock refuses with the 409 before any step-up is asked for
    await card.getByRole("button", { name: "Activate version 2" }).click();
    await expect(card.getByText("Not activated.")).toBeVisible();
    await expect(card.getByRole("alert").filter({ hasText: "Not activated." })).toContainText(
      "Version 2's latest test did not pass. Run a passing test first; your step-up was not used.",
    );
    // so no prompt was opened and no grant was asked for
    await expect(page.getByRole("dialog", { name: "Confirm it's you" })).toHaveCount(0);
    expect(calls.some((c) => c.path.startsWith("/v1/auth/step-up"))).toBe(false);
    expect(calls.filter((c) => c.path.endsWith("/activate"))).toHaveLength(1);

    await card.getByRole("button", { name: "Test again: version 2" }).click();
    const panel = card.getByRole("region", { name: /Test version 2 against a sample response/ });
    await panel.getByLabel("Sample response (JSON, up to 1 MB)").fill(SAMPLE);
    await panel.getByLabel("Text in").fill("1840");
    await panel.getByLabel("Text out").fill("212");
    await panel.getByRole("button", { name: "Run test" }).click();
    await expect(panel.getByRole("alert")).toContainText("Sample too large. A sample is at most 1 MB of JSON.");
    expect(calls.filter((c) => c.path.endsWith("/test"))).toHaveLength(1);
    await expectAxeClean(page, "Usage counts: refusals");
  });

  test("a failed read shows the error with Retry; an agent with no versions shows the empty state", async ({ page }) => {
    // two: the app retries a failed read once before it shows the error
    await mockApi(page, { failVersions: 2 });
    await page.goto("/ui/admin/agents");
    const card = usageCard(page);
    await card.getByLabel("Agent", { exact: true }).selectOption(TRIAGE);
    const err = card.getByRole("alert").filter({ hasText: "Couldn't load the versions for Claims triage" });
    await expect(err).toContainText("The fallback count is unknown, never 0, until this loads.");
    await expect(card.getByTestId("usage-counting-with")).toHaveText("unknown");
    await expectAxeClean(page, "Usage counts: a failed read");
    await err.getByRole("button", { name: "Retry" }).click();
    await expect(card.getByText("Versions for Claims triage")).toBeVisible();

    await card.getByLabel("Agent", { exact: true }).selectOption(SUMMARY);
    await expect(card.getByText("Intake summariser is counted by its built-in adapter")).toBeVisible();
    await expect(card.getByText("Add a mapping only if this agent's provider reports usage somewhere the adapter does not read.")).toBeVisible();
    await expectAxeClean(page, "Usage counts: no versions yet");
    await card.getByRole("button", { name: "New version" }).click();
    await expect(card.getByRole("region", { name: /Where the counts are — version 1/ })).toBeVisible();
  });
});
