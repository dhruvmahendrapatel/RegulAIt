/**
 * ADR-0173 batch 2c (Q) — annotation queues against a mocked gateway that
 * mirrors apps/gateway/src/annotations.ts (shapes, status codes, error codes):
 *
 *  1. the admin setup page: create a queue (reviewers, N, deadline, a score
 *     and a label criterion), the items with their deadline and disagreement
 *     badges, edit, the deadline check, export and remove;
 *  2. the reviewer: the Inbox "Annotations" card, the review page (previews
 *     only, the withheld marker), a submit and the blocked state after it;
 *     a pruned item ("no longer retained"); a 403 for a non-reviewer.
 *
 * axe in light and dark on the setup page and on the reviewer view.
 */
import { expect, test, type Page, type Route } from "@playwright/test";
import { CORA, DREW, ME, installBuilderMock } from "./builder-fixtures";
import { expectAxeClean, sentTo } from "./prompts-fixtures";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;
const Q1 = "aaaa1111-0000-4000-8000-000000000001";
const ITEM_OPEN = "bbbb1111-0000-4000-8000-000000000001";
const ITEM_GONE = "bbbb1111-0000-4000-8000-000000000002";
const ITEM_DENIED = "bbbb1111-0000-4000-8000-000000000003";
const TRACE = "cccc1111-0000-4000-8000-000000000001";
const WITHHELD = "[content withheld by policy]";
const iso = (minsAgo: number) => new Date(Date.now() - minsAgo * 60_000).toISOString();
const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

const RUBRIC = {
  criteria: [
    { name: "helpfulness", kind: "score", min: 1, max: 5, step: 1 },
    { name: "verdict", kind: "label", labels: ["good", "bad"] },
  ],
  commentRequired: false,
};

function itemRow(id: string, over: Json = {}) {
  return {
    id,
    queueId: Q1,
    queueName: "support-answers",
    subjectKind: "trace",
    subjectId: TRACE,
    traceId: TRACE,
    spanId: null,
    status: "open",
    requiredReviews: 2,
    submissionCount: 0,
    dueAt: iso(-120),
    slaBreached: false,
    disagreement: null,
    completedAt: null,
    ruleId: null,
    createdAt: iso(30),
    ...over,
  };
}

function itemResponse(id: string, opts: { admin: boolean; retained?: boolean; submitted?: Json | null }) {
  const retained = opts.retained !== false;
  return {
    item: itemRow(id, { submissionCount: opts.submitted ? 1 : 0 }),
    queue: { id: Q1, name: "support-answers", description: "", requiredReviews: 2, slaHours: 24 },
    rubric: { version: 1, ...RUBRIC },
    preview: retained
      ? {
          retained: true,
          note: null,
          previewOnly: !opts.admin,
          trace: { id: TRACE, name: "support chat", kind: "conversation", status: "ok", startedAt: iso(60) },
          spans: [
            { id: "s1", kind: "llm", name: "answer", status: "ok", model: "mock-balanced", startedAt: iso(60), durationMs: 900, input: "How do I reset my password?", output: "Use the reset link on the sign-in page.", withheld: false },
            { id: "s2", kind: "llm", name: "follow-up", status: "ok", model: "mock-balanced", startedAt: iso(59), durationMs: 700, input: WITHHELD, output: WITHHELD, withheld: true },
          ],
          spansTruncated: false,
          evalResult: null,
        }
      : { retained: false, note: "no longer retained", previewOnly: !opts.admin, trace: null, spans: [], spansTruncated: false, evalResult: null },
    you: {
      isReviewer: true,
      isAdmin: opts.admin,
      selfReview: false,
      canSubmit: retained && !opts.submitted,
      blockedReason: !retained ? "not_retained" : opts.submitted ? "already_submitted" : null,
      submission: opts.submitted ?? null,
    },
  };
}

async function installAnnotationMock(page: Page, opts: { isAdmin: boolean }) {
  await installBuilderMock(page, { isAdmin: opts.isAdmin });
  const st = {
    calls: [] as Array<{ method: string; path: string; body: Json }>,
    queues: [] as Json[],
    items: [
      itemRow(ITEM_OPEN, { slaBreached: true }),
      itemRow("bbbb1111-0000-4000-8000-000000000009", { subjectKind: "span", status: "completed", submissionCount: 2, disagreement: true }),
    ] as Json[],
    submitted: null as Json,
  };
  await page.route(/\/v1\/(annotation-queues|annotations|users)(\/|\?|$)/, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname;
    const method = req.method();
    let body: Json;
    try {
      body = req.postDataJSON();
    } catch {
      body = undefined;
    }
    st.calls.push({ method, path: p + url.search, body });
    let m: RegExpExecArray | null;
    if (p === "/v1/users" && method === "GET") {
      return json(route, {
        users: [
          { id: ME, email: "avery@example.test", displayName: "Avery Admin", isAdmin: true, disabledAt: null },
          { id: DREW, email: "drew@example.test", displayName: "Drew Reviewer", isAdmin: false, disabledAt: null },
          { id: CORA, email: "cora@example.test", displayName: "Cora Analyst", isAdmin: false, disabledAt: null },
        ],
      });
    }
    if (!p.startsWith("/v1/annotation") ) return route.fallback();
    if (p === "/v1/annotation-queues" && method === "GET") return json(route, { queues: st.queues });
    if (p === "/v1/annotation-queues" && method === "POST") {
      if (body.requiredReviews > body.reviewerUserIds.length) return json(route, { error: "validation", issues: [{ message: "an N-person review needs at least N named reviewers" }] }, 400);
      const q = {
        id: Q1,
        name: body.name,
        description: body.description,
        rubricVersion: 1,
        requiredReviews: body.requiredReviews,
        slaHours: body.slaHours,
        reviewerCount: body.reviewerUserIds.length,
        openItems: 1,
        completedItems: 1,
        breachedItems: 1,
        disagreements: 1,
        updatedAt: iso(0),
        _reviewers: body.reviewerUserIds,
        _rubric: body.rubric,
      };
      st.queues.push(q);
      return json(route, q, 201);
    }
    if (p === "/v1/annotation-queues/sla-sweep") return json(route, { breached: 1, itemIds: [ITEM_OPEN] });
    if ((m = /^\/v1\/annotation-queues\/([^/]+)\/items\/([^/]+)$/.exec(p)) && method === "DELETE") {
      st.items = st.items.filter((i) => i.id !== m![2]);
      return json(route, { deleted: true, id: m[2] });
    }
    if ((m = /^\/v1\/annotation-queues\/([^/]+)\/items$/.exec(p))) return json(route, { items: st.items });
    if ((m = /^\/v1\/annotation-queues\/([^/]+)\/export$/.exec(p))) {
      return route.fulfill({ status: 200, contentType: "text/csv", body: "item_id,criterion\r\n" });
    }
    if ((m = /^\/v1\/annotation-queues\/([^/]+)$/.exec(p))) {
      const q = st.queues.find((x) => x.id === m![1]);
      if (!q) return json(route, { error: "unknown_queue" }, 404);
      const detail = () => ({
        ...q,
        rubric: q._rubric,
        rubricVersions: [{ version: q.rubricVersion, rubric: q._rubric, createdAt: iso(0) }],
        reviewers: q._reviewers.map((id: string) => ({ id, name: id === DREW ? "Drew Reviewer" : "Cora Analyst" })),
      });
      if (method === "GET") return json(route, detail());
      if (method === "PATCH") {
        if (body.rubric) {
          q.rubricVersion += 1;
          q._rubric = body.rubric;
        }
        if (body.name) q.name = body.name;
        return json(route, detail());
      }
      if (method === "DELETE") {
        st.queues = st.queues.filter((x) => x.id !== q.id);
        return json(route, { deleted: true, id: q.id });
      }
    }
    // ---- reviewer
    if (p === "/v1/annotations/inbox") return json(route, { items: st.submitted ? [] : [itemRow(ITEM_OPEN), itemRow(ITEM_GONE, { subjectKind: "span" })] });
    if ((m = /^\/v1\/annotations\/items\/([^/]+)$/.exec(p))) {
      if (m[1] === ITEM_DENIED) return json(route, { error: "forbidden", detail: "only the queue's named reviewers and admins may read its items" }, 403);
      if (m[1] === ITEM_GONE) return json(route, itemResponse(ITEM_GONE, { admin: opts.isAdmin, retained: false }));
      return json(route, itemResponse(m[1]!, { admin: opts.isAdmin, submitted: st.submitted }));
    }
    if ((m = /^\/v1\/annotations\/items\/([^/]+)\/submissions$/.exec(p))) {
      if (body.values.helpfulness > 5) return json(route, { error: "rubric_violation", detail: '"helpfulness" must be from 1 to 5' }, 422);
      st.submitted = { id: "sub-1", reviewerUserId: ME, rubricVersion: 1, values: body.values, comment: body.comment ?? null, createdAt: iso(0) };
      return json(route, { replayed: false, submission: st.submitted, item: { id: m[1], status: "open", disagreement: null, completedAt: null } }, 201);
    }
    return route.fallback();
  });
  return st;
}

test.describe("ADR-0173 2c: annotation queues", () => {
  test("admin: create a queue → items → edit → deadline check → export → remove", async ({ page }) => {
    const st = await installAnnotationMock(page, { isAdmin: true });
    await page.goto("/ui/admin/annotation-queues");
    await expect(page.getByRole("heading", { level: 1, name: "Annotation queues" })).toBeVisible();
    await expect(page.getByText("No annotation queues", { exact: true })).toBeVisible();
    await expectAxeClean(page, "annotation queues, empty");

    await page.getByRole("button", { name: "New queue" }).click();
    const dialog = page.getByRole("dialog", { name: "New annotation queue" });
    await dialog.getByLabel("Queue name").fill("support-answers");
    await dialog.getByLabel("Reviews needed per item", { exact: true }).selectOption("2");
    await dialog.getByLabel("Deadline (hours, optional)", { exact: true }).fill("24");
    await dialog.getByLabel(/Drew Reviewer/).check();
    await dialog.getByLabel(/Cora Analyst/).check();
    await dialog.getByRole("button", { name: "Add criterion" }).click();
    await dialog.getByLabel("Criterion 2 name").fill("verdict");
    await dialog.getByLabel("Criterion 2 type").selectOption("label");
    await dialog.getByLabel("Criterion 2 labels (comma-separated)").fill("good, bad");
    await expectAxeClean(page, "new queue dialog");
    await dialog.getByRole("button", { name: "Create queue" }).click();
    await expect(dialog).toHaveCount(0);
    expect(sentTo(st, "POST", "/v1/annotation-queues")[0]).toEqual({
      name: "support-answers",
      description: "",
      reviewerUserIds: [DREW, CORA],
      requiredReviews: 2,
      slaHours: 24,
      rubric: {
        criteria: [
          { name: "helpfulness", kind: "score", min: 1, max: 5, step: 1 },
          { name: "verdict", kind: "label", labels: ["good", "bad"] },
        ],
        commentRequired: false,
      },
    });
    const row = page.getByRole("row").filter({ hasText: "support-answers" });
    await expect(row).toContainText("2 · 2 per item");
    await expect(row).toContainText("1 past deadline");
    await expect(row).toContainText("1 disagreed");
    await expectAxeClean(page, "annotation queues, one queue");

    await row.getByRole("button", { name: "Items of support-answers" }).click();
    const items = page.getByRole("dialog", { name: "Items — support-answers" });
    await expect(items.getByRole("row").filter({ hasText: "past deadline" })).toContainText("0 of 2");
    await expect(items.getByRole("row").filter({ hasText: "reviewers disagreed" })).toContainText("2 of 2");
    await expectAxeClean(page, "queue items");
    await items.getByRole("button", { name: "Close" }).click();

    await row.getByRole("button", { name: "Edit support-answers" }).click();
    const edit = page.getByRole("dialog", { name: "Edit support-answers" });
    await expect(edit.getByText("Version 1.")).toBeVisible();
    await edit.getByLabel("Criterion 1 highest").fill("10");
    await edit.getByRole("button", { name: "Save" }).click();
    await expect(edit).toHaveCount(0);
    expect(sentTo(st, "PATCH", `/v1/annotation-queues/${Q1}`)[0].rubric.criteria[0]).toEqual({ name: "helpfulness", kind: "score", min: 1, max: 10, step: 1 });
    await expect(row).toContainText("version 2");

    await page.getByRole("button", { name: "Check deadlines now" }).click();
    await expect(page.getByText("Deadline check: 1 item(s) newly past their deadline")).toBeVisible();

    const download = page.waitForEvent("download");
    await row.getByRole("button", { name: "Export the reviews of support-answers" }).click();
    expect((await download).suggestedFilename()).toBe("annotations-support-answers.csv");
    expect(sentTo(st, "GET", `/v1/annotation-queues/${Q1}/export`)).toHaveLength(1);

    await row.getByRole("button", { name: "Remove queue support-answers" }).click();
    await page.getByRole("dialog", { name: "Remove queue support-answers?" }).getByRole("button", { name: "Remove" }).click();
    await expect(page.getByText("No annotation queues", { exact: true })).toBeVisible();
  });

  test("reviewer: Inbox → previews only with the withheld marker → submit; not retained; refused", async ({ page }) => {
    const st = await installAnnotationMock(page, { isAdmin: false });
    await page.goto("/ui/inbox");
    await expect(page.getByText("Annotations · 2 to review")).toBeVisible();
    await expect(page.getByText("No sign-offs waiting on you")).toBeVisible();
    await expectAxeClean(page, "inbox with annotations");

    await page.getByRole("link", { name: "Trace in support-answers" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Review · support-answers" })).toBeVisible();
    await expect(page.getByText("previews only")).toBeVisible();
    await expect(page.getByText("How do I reset my password?")).toBeVisible();
    await expect(page.getByText(WITHHELD).first()).toBeVisible();
    await expect(page.getByText("withheld by policy").first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Submit review" })).toBeDisabled();
    await expectAxeClean(page, "reviewer view");

    await page.getByLabel("helpfulness (1 to 5)").fill("4");
    await page.getByLabel("verdict").selectOption("good");
    await page.getByLabel("Comment (optional)").fill("Clear and correct.");
    await page.getByRole("button", { name: "Submit review" }).click();
    await expect(page.getByText("Review recorded")).toBeVisible();
    expect(sentTo(st, "POST", `/v1/annotations/items/${ITEM_OPEN}/submissions`)).toEqual([{ values: { helpfulness: 4, verdict: "good" }, comment: "Clear and correct." }]);
    await expect(page.getByRole("status").filter({ hasText: "You have reviewed this item." })).toBeVisible();
    await expect(page.getByText("Clear and correct.")).toBeVisible();

    await page.goto(`/ui/inbox/annotations/${ITEM_GONE}`);
    await expect(page.getByText("No longer retained", { exact: true })).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: "content is no longer retained" })).toBeVisible();
    await expectAxeClean(page, "reviewer view, not retained");

    await page.goto(`/ui/inbox/annotations/${ITEM_DENIED}`);
    await expect(page.getByText("Only this queue's named reviewers and admins can read its items.")).toBeVisible();
    await expectAxeClean(page, "reviewer view, refused");
  });
});
