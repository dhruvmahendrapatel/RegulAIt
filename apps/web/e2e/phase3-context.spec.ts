/**
 * Pillar-4 journey — the shared context store, driven end to end in the SPA
 * against a REAL seeded gateway as the seeded CONTRIBUTOR persona (Avery, not
 * an admin, so the §9.2 role gate is genuinely exercised).
 *
 * The load-bearing assertions are the optimistic-concurrency ones. Both
 * conflict entry points are forced for real, and both resolutions are driven:
 *
 *  · a literal `409 base_revision_required` from the gateway — provoked by
 *    stubbing exactly ONE pre-read so the client believes a key it is about
 *    to create does not exist, which is precisely the race the status code
 *    exists for. The 409 is asserted on the wire, not inferred from the UI.
 *    Resolution: REBASE onto the revision that landed first.
 *  · the read-before-write catch — a real out-of-band revision lands while an
 *    edit is open, so the re-read at submit time sees a moved head and the
 *    write is never sent. Resolution: ESCALATE, i.e. submit against the stale
 *    base so the gateway retains it and routes it to the named arbiter.
 *
 * Plus: read + provenance + history, artifact promotion (asserting the OUTCOME
 * OBJECT is reported for what it is, not treated as truthy), and the version
 * graph. Every page asserts ZERO console errors; screenshots into
 * E2E_SHOTS_DIR.
 */
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const state = JSON.parse(readFileSync(path.join(here, ".e2e-state.json"), "utf8")) as {
  passwords: { admin: string; dana: string; avery: string };
  baseUrl: string;
};
const SHOTS = process.env.E2E_SHOTS_DIR ?? path.join(here, "screenshots");
mkdirSync(SHOTS, { recursive: true });

const AVERY_PASSWORD = "E2e-Avery-Context!";
const CSRF = { "x-regulait-csrf": "1" };
/** a context write is a real transaction (revision + approval + audit row) and
 * then a refetch; on a loaded CI box that round trip can outrun the default
 * 10s expect budget, and waiting longer never weakens what is asserted */
const WRITE = { timeout: 25_000 };
/** unique per run so a re-run against a warm database never collides */
const KEY = `e2e-conflict-${Date.now().toString(36)}`;

interface ConsoleTracker {
  errors: string[];
  assertClean: (label: string) => void;
}
function trackConsole(page: Page): ConsoleTracker {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    // the browser's own network log for the pre-login 401 probe and for the
    // DELIBERATE 409 conflict this spec forces — neither is emitted by our
    // code and neither is suppressible from JS. Everything else is fatal.
    if (/Failed to load resource.*(401|403|409|422)/.test(text)) return;
    errors.push(`console.error: ${text}`);
  });
  return {
    errors,
    assertClean(label: string) {
      expect(errors, `console must be clean after: ${label}`).toEqual([]);
    },
  };
}

async function shot(page: Page, name: string) {
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
}

test.describe.configure({ mode: "serial" });

let page: Page;
let track: ConsoleTracker;
let projectId = "";
/** every context POST the browser made, with the status the gateway answered */
const writes: Array<{ status: number; url: string }> = [];

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  track = trackConsole(page);
  page.on("response", (res) => {
    const u = new URL(res.url());
    if (res.request().method() === "POST" && u.pathname.endsWith("/context")) {
      writes.push({ status: res.status(), url: u.pathname });
    }
  });
});
test.afterAll(async () => {
  await page.close();
});

/** an out-of-band write by "somebody else" — the same real endpoint, outside
 * the SPA's own read-before-write dance, which is what makes the races real */
async function writeOutOfBand(body: Record<string, unknown>): Promise<{ revision: number }> {
  const res = await page.request.post(`/v1/projects/${projectId}/context`, {
    headers: CSRF,
    data: body,
  });
  expect(res.status(), `out-of-band write: ${await res.text()}`).toBe(201);
  return (await res.json()) as { revision: number };
}

test("contributor login: one-time password → forced change → Shared context in the nav", async () => {
  // The whole suite shares ONE seeded database and runs serially, so whether
  // Avery's seeded one-time password is still live depends on what ran first:
  // phase2's key-custody journey signs in as Avery and completes the forced
  // change to its own constant, which left this login failing outright. Try
  // the seeded one-time credential and fall back to the password phase2
  // settles on — the forced-change flow is still asserted whenever this spec
  // is the one that gets to consume it.
  const signIn = async (password: string) => {
    await page.goto("/ui");
    await page.getByLabel("Email").fill("avery@regulait.local");
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();
  };
  await signIn(state.passwords.avery);
  const forcedChange = page.getByText("Your password is one-time");
  const rejected = page.getByText(/password is incorrect/);
  await expect(forcedChange.or(rejected).first()).toBeVisible();

  if (await forcedChange.isVisible()) {
    await page.getByLabel("Current (one-time) password").fill(state.passwords.avery);
    await page.getByLabel("New password", { exact: true }).fill(AVERY_PASSWORD);
    await page.getByLabel("Confirm new password").fill(AVERY_PASSWORD);
    await page.getByRole("button", { name: "Set password & continue" }).click();
  } else {
    // phase2 already consumed the one-time credential (PHASE2_AVERY_PASSWORD)
    await signIn("E2e-Avery-Custody!");
  }

  await expect(page.getByRole("heading", { name: /Welcome back/ })).toBeVisible();
  await expect(page.getByRole("link", { name: "Shared context", exact: true })).toBeVisible();

  const projects = (await (await page.request.get("/v1/projects")).json()) as {
    projects: Array<{ id: string; name: string }>;
  };
  projectId = projects.projects.find((p) => p.name === "demo-project")!.id;
  expect(projectId).toBeTruthy();
  track.assertClean("contributor login");
});

test("workspace entry: the context index lists the store, its arbiter and its live conflicts", async () => {
  await page.getByRole("link", { name: "Shared context", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Shared context", exact: true })).toBeVisible();
  const card = page.locator("section").filter({ hasText: "demo-project" }).first();
  await expect(card).toContainText("key");
  await expect(card).toContainText("arbiter");
  await shot(page, "phase3-01-context-index");
  track.assertClean("context index");

  await card.getByRole("button", { name: "Open store" }).click();
  await expect(page.getByRole("tab", { name: "Shared context" })).toHaveAttribute("aria-selected", "true");
});

test("read: entries carry provenance, text and the full retained history", async () => {
  const entry = page.getByTestId("context-entry-coding-standards");
  await expect(entry).toBeVisible();
  await expect(entry).toContainText("current");
  // provenance: who + which team, never a raw uuid
  await expect(entry).toContainText("by ");
  await expect(page.locator("text=/[0-9a-f]{8}-[0-9a-f]{4}-/")).toHaveCount(0);

  await entry.getByRole("button", { name: "Show text" }).click();
  await expect(entry.locator("pre")).toBeVisible();

  const notes = page.getByTestId("context-entry-checkout-domain-notes");
  await notes.getByRole("button", { name: "History" }).click();
  // the seeded key has three retained revisions — every side of its conflict
  await expect(notes.getByText("rev 1", { exact: false }).first()).toBeVisible();
  await expect(notes.getByText("rev 3", { exact: false }).first()).toBeVisible();
  await expect(notes.getByText("first write of this key")).toBeVisible();
  await shot(page, "phase3-02-context-read-history");
  await notes.getByRole("button", { name: "Hide history" }).click();
  track.assertClean("context read + history");
});

test("edit and save: the write names its base revision and becomes current", async () => {
  const entry = page.getByTestId("context-entry-coding-standards");
  await entry.getByRole("button", { name: "Edit" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("editing from rev 1");
  const body = dialog.getByLabel("Context content");
  await body.fill((await body.inputValue()) + "\nAll public functions carry an explicit return type.");
  await shot(page, "phase3-03-context-editor");
  await dialog.getByRole("button", { name: "Save revision" }).click();

  const outcome = page.getByTestId("context-outcome");
  await expect(outcome).toContainText("Revision 2 of “coding-standards” is now the current value", WRITE);
  await expect(page.getByTestId("context-entry-coding-standards")).toContainText("rev 2 · current", WRITE);
  await shot(page, "phase3-04-context-saved");
  track.assertClean("edit and save");
});

test("conflict A — a real 409 base_revision_required, resolved by REBASE", async () => {
  // the draft: a key this session believes is brand new
  await page.getByRole("button", { name: "Add context", exact: true }).first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Key").fill(KEY);
  await dialog.getByLabel("Context content").fill("Avery's first draft of the release checklist.");

  // somebody else creates the very same key while the draft is open
  const first = await writeOutOfBand({
    key: KEY,
    content: "Dana got there first: the release checklist starts with the migration plan.",
  });
  expect(first.revision).toBe(1);

  // Stub EXACTLY ONE pre-read of this key, so the client still believes the key
  // is new when it writes — which is precisely the race `409
  // base_revision_required` exists for, made deterministic. The counter is ours
  // rather than route()'s `times`, so a miss is diagnosable instead of silent,
  // and every later read of this key (the conflict view's own re-read) passes
  // straight through to the real gateway.
  const isPreRead = (url: URL) =>
    url.pathname.endsWith("/context") &&
    url.searchParams.get("key") === KEY &&
    !url.searchParams.has("history");
  let stubHits = 0;
  await page.route(isPreRead, (route) => {
    stubHits += 1;
    return stubHits === 1
      ? route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ context: [], pending: [], arbiter: null }),
        })
      : route.continue();
  });

  const before = writes.length;
  await dialog.getByRole("button", { name: "Save revision" }).click();

  // the gateway really answered 409 — asserted on the wire, not inferred
  await expect
    .poll(() => writes.slice(before).some((w) => w.status === 409), {
      message: () =>
        `the gateway must have answered 409 base_revision_required (pre-reads intercepted: ${stubHits}, ` +
        `context writes seen: ${JSON.stringify(writes.slice(before))})`,
      timeout: 25_000,
    })
    .toBe(true);
  await page.unroute(isPreRead);

  // and the UI recovered into the both-texts conflict view, not a silent retry
  const conflict = page.getByTestId("context-conflict");
  await expect(conflict).toBeVisible(WRITE);
  await expect(conflict).toContainText("is now at revision 1");
  await expect(conflict).toContainText("it already exists");
  await expect(conflict).toContainText("Dana got there first");
  await expect(conflict).toContainText("Avery's first draft");
  // with no base of its own there is no stale-base claim to escalate
  await expect(conflict).toContainText("Escalating is not available here");
  await expect(dialog.getByRole("button", { name: /^Escalate to/ })).toHaveCount(0);
  await shot(page, "phase3-05-conflict-409-both-texts");

  await dialog.getByRole("button", { name: "Rebase on rev 1 & save" }).click();
  const outcome = page.getByTestId("context-outcome");
  await expect(outcome).toContainText(`Revision 2 of “${KEY}” is now the current value`, WRITE);
  await expect(page.getByTestId(`context-entry-${KEY}`)).toContainText("rev 2 · current", WRITE);
  await shot(page, "phase3-06-conflict-409-rebased");
  track.assertClean("409 conflict → rebase");
});

test("conflict B — the head moves under an open edit, resolved by ESCALATION to the arbiter", async () => {
  const entry = page.getByTestId(`context-entry-${KEY}`);
  await entry.getByRole("button", { name: "Edit" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("editing from rev 2");

  // a real third revision lands while the edit is open
  const third = await writeOutOfBand({
    key: KEY,
    baseRevision: 2,
    content: "Dana again: the checklist now ends with the rollback rehearsal.",
  });
  expect(third.revision).toBe(3);

  await dialog
    .getByLabel("Context content")
    .fill("Avery's rewrite: the checklist is owned by the release manager, not the author.");
  await dialog.getByRole("button", { name: "Save revision" }).click();

  // read-before-write caught it: nothing was sent, both texts are on screen
  const conflict = page.getByTestId("context-conflict");
  await expect(conflict).toBeVisible(WRITE);
  await expect(conflict).toContainText("is now at revision 3");
  await expect(conflict).toContainText("your edit was based on revision 2");
  await expect(conflict).toContainText("rollback rehearsal"); // theirs
  await expect(conflict).toContainText("owned by the release manager"); // yours
  await expect(conflict.getByText("theirs · rev 3")).toBeVisible();
  await expect(conflict.getByText("unsent draft")).toBeVisible();
  await shot(page, "phase3-07-conflict-stale-base-both-texts");

  // escalate: submit against the STALE base on purpose
  await dialog.getByRole("button", { name: /^Escalate to Dana/ }).click();

  const outcome = page.getByTestId("context-outcome");
  await expect(outcome).toContainText(`Revision 4 of “${KEY}” was retained, but it is NOT the current value`, WRITE);
  await expect(outcome).toContainText("sent yours to Dana Developer to decide");
  // the store did NOT move: rev 3 is still what everyone reads
  await expect(page.getByTestId(`context-entry-${KEY}`)).toContainText("rev 3 · current", WRITE);
  await expect(page.getByTestId(`context-entry-${KEY}`)).toContainText("1 awaiting arbiter");
  await expect(page.getByText("Conflicting revisions awaiting a decision")).toBeVisible();
  await shot(page, "phase3-08-conflict-escalated");
  track.assertClean("stale-base conflict → arbiter");
});

test("promote: a signed-off artifact lands in the shared store, reported by its real outcome", async () => {
  // drive a workflow of THIS project to completion so it has a signed-off
  // artifact: standard-change is intake → plan → requirements → sign-off,
  // and Avery is both its initiator and its named approver.
  const inst = (await (
    await page.request.post("/v1/workflows/instances", {
      headers: CSRF,
      data: {
        projectId,
        change: {
          description: "E2E: promote a signed-off artifact into shared context",
          paths: ["src/checkout/release-checklist.md"],
          changeType: "feature",
          environment: "staging",
        },
      },
    })
  ).json()) as { id: string };
  // ADR-0079: a `planning` stage now RESTS instead of auto-completing, so a
  // freshly started standard-change instance parks at `blocked_on_plan` and
  // the requirements artifact below would 409. Leave plan-only the same way
  // the seeder and the UI do — an explicit advance of the current stage.
  const parked = (await (
    await page.request.get(`/v1/workflows/instances/${inst.id}`)
  ).json()) as {
    instance?: { status?: string; state?: { currentStageIndex?: number }; definition?: { stages?: Array<{ id: string }> } };
  };
  if (parked.instance?.status === "blocked_on_plan") {
    const stage = parked.instance.definition?.stages?.[parked.instance.state?.currentStageIndex ?? -1];
    expect(stage, "a blocked_on_plan instance must have a current stage").toBeTruthy();
    const advanced = await page.request.post(`/v1/workflows/instances/${inst.id}/advance`, {
      headers: CSRF,
      data: { stageId: stage!.id },
    });
    expect(advanced.status()).toBeLessThan(300);
  }

  const artifactRes = await page.request.post(`/v1/workflows/instances/${inst.id}/artifacts`, {
    headers: CSRF,
    data: {
      stageId: "requirements",
      content:
        "# Release checklist\n\n1. Migration plan reviewed.\n2. Rollback rehearsed.\n3. Release manager owns the checklist.",
    },
  });
  expect(artifactRes.status()).toBeLessThan(300);
  const view = (await (await page.request.get(`/v1/workflows/instances/${inst.id}`)).json()) as {
    instance?: { status?: string };
    pendingApprovals?: Array<{ id: string }>;
  };
  const approvalId = view.pendingApprovals?.[0]?.id;
  expect(approvalId, `the sign-off gate must be waiting: ${JSON.stringify(view.instance)}`).toBeTruthy();
  const decided = await page.request.post(`/v1/approvals/${approvalId}/decide`, {
    headers: CSRF,
    // Avery initiated it and is also its named approver — the gateway insists
    // a self-review carries a recorded reason, so it does
    data: { decision: "approved", reason: "e2e: signing off my own release-checklist requirements" },
  });
  expect(decided.status(), await decided.text()).toBeLessThan(300);

  await page.reload();
  const row = page.getByTestId("promotable-requirements_file");
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Promote" }).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("provenance link back to the artifact");
  await shot(page, "phase3-09-promote-confirm");
  await dialog.getByRole("button", { name: "Promote", exact: true }).click();

  // the write answers with an OUTCOME OBJECT — the UI must say which one
  // the write answers with an outcome object; this asserts the reported words
  // match what actually happened, rather than "it did not throw"
  const outcome = page.getByTestId("context-outcome");
  await expect(outcome).toContainText("Revision 1 of “requirements_file” is now the current value", WRITE);
  await expect(outcome).toContainText("Promoted from the signed-off artifact “requirements_file” v1");
  const entry = page.getByTestId("context-entry-requirements_file");
  await expect(entry).toContainText("from artifact");
  await shot(page, "phase3-10-promoted");
  track.assertClean("artifact promotion");
});

test("version graph: lineage, the conflict fork and the superseded revisions, all legible", async () => {
  await page.getByRole("tab", { name: "Version graph" }).click();
  await expect(page.getByRole("img", { name: /Version graph:/ })).toBeVisible();
  // the four states are named, not colour-coded only
  await expect(page.getByText("accepted · current head").first()).toBeVisible();
  await expect(page.getByText("accepted · superseded by a later revision").first()).toBeVisible();
  await expect(page.getByText("conflict · retained, awaiting the arbiter").first()).toBeVisible();
  await shot(page, "phase3-11-version-graph");

  // the escalated revision 4 is on the canvas as a fork, and selecting it
  // explains itself honestly
  const conflictNode = page
    .getByRole("button", { name: new RegExp(`${KEY} revision 4, conflict · retained, awaiting the arbiter`) })
    .first();
  await expect(conflictNode).toBeVisible();
  await conflictNode.click();
  const detail = page.getByTestId("graph-detail");
  await expect(detail).toContainText("rev 4");
  await expect(detail).toContainText("based on rev 2");
  await expect(detail).toContainText("awaiting the arbiter");
  await shot(page, "phase3-12-version-graph-detail");
  track.assertClean("version graph");
});

test("dark theme: the context store and its graph stay legible", async () => {
  await page.getByRole("button", { name: /Switch to (light|dark) theme/ }).click();
  await shot(page, "phase3-13-version-graph-dark");
  await page.getByRole("tab", { name: "Shared context" }).click();
  await expect(page.getByTestId(`context-entry-${KEY}`)).toBeVisible();
  await shot(page, "phase3-14-context-dark");
  track.assertClean("dark theme");
});
