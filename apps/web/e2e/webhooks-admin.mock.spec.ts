/**
 * ADR-0173 batch 2b — the admin Webhooks page against a mocked gateway: add
 * (secret shown once), the egress refusal in the guard's own words, test,
 * the delivery log with retry, pause, edit, rotate and remove.
 */
import { expect, test, type Page, type Route } from "@playwright/test";
import { installBuilderMock } from "./builder-fixtures";
import { expectAxeClean, sentTo } from "./prompts-fixtures";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;
const SUB = "aaaa0000-0000-4000-8000-000000000001";
const DELIVERY_FAILED = "bbbb0000-0000-4000-8000-000000000001";
const SECRET_1 = `whsec_${"A".repeat(43)}=`;
const SECRET_2 = `whsec_${"B".repeat(43)}=`;
const iso = (minsAgo: number) => new Date(Date.now() - minsAgo * 60_000).toISOString();

const EVENTS = {
  families: ["prompt"],
  events: [
    { name: "prompt.commit", family: "prompt", description: "A new commit was written to a prompt in the registry.", fields: [] },
    { name: "prompt.tag.moved", family: "prompt", description: "A prompt tag now points at a different commit.", fields: [] },
    { name: "prompt.promotion.requested", family: "prompt", description: "Moving a prompt's prod tag was sent to the approvals queue.", fields: [] },
    { name: "prompt.promotion.decided", family: "prompt", description: "A prompt promotion was approved, denied or found stale when decided.", fields: [] },
  ],
  signing: { scheme: "Standard Webhooks", headers: ["webhook-id", "webhook-timestamp", "webhook-signature"], note: "" },
};

const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

async function installWebhooksMock(page: Page) {
  await installBuilderMock(page, { isAdmin: true });
  const st = {
    calls: [] as Array<{ method: string; path: string; body: Json }>,
    subs: [] as Json[],
    deliveries: [
      {
        id: DELIVERY_FAILED,
        subscriptionId: SUB,
        event: "prompt.commit",
        messageId: "msg_1",
        payload: { promptId: "p", commitHash: "h" },
        status: "failed",
        attempts: 8,
        maxAttempts: 8,
        nextRetryAt: null,
        lastAttemptAt: iso(5),
        responseCode: 500,
        lastError: "the receiver answered HTTP 500",
        deliveredAt: null,
        createdAt: iso(60),
      },
    ] as Json[],
  };
  await page.route(/\/v1\/(webhooks|egress-allow-hosts)/, async (route) => {
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
    if (p === "/v1/egress-allow-hosts") return json(route, { hosts: [{ id: "h1", host: "hooks.example.test", allowPrivate: false, allowPlaintextHttp: false }] });
    if (p === "/v1/webhooks/events") return json(route, EVENTS);
    if (p === "/v1/webhooks" && method === "GET")
      return json(route, {
        subscriptions: st.subs.map((s) => ({
          ...s,
          lastDelivery: s.id === SUB ? { status: "failed", at: iso(5) } : null,
          pendingDeliveries: 0,
          failedDeliveries: st.deliveries.filter((d) => d.subscriptionId === s.id && d.status === "failed").length,
        })),
      });
    if (p === "/v1/webhooks" && method === "POST") {
      if (!String(body.url).startsWith("https://hooks.example.test"))
        return json(route, { error: "egress_blocked", code: "host_not_allowed", detail: `host ${new URL(body.url).host} is not on the egress allow-list` }, 400);
      const sub = {
        id: SUB,
        name: body.name,
        url: body.url,
        events: body.events,
        active: true,
        allowPlaintextHttp: !!body.allowPlaintextHttp,
        createdByUserId: null,
        secretRotatedAt: iso(0),
        createdAt: iso(0),
        updatedAt: iso(0),
      };
      st.subs.push(sub);
      return json(route, { ...sub, secret: SECRET_1 }, 201);
    }
    if (p === "/v1/webhooks/sweep") return json(route, { due: 1, delivered: 1, retrying: 0, failed: 0, skipped: 0 });
    if ((m = /^\/v1\/webhooks\/deliveries\/([^/]+)\/retry$/.exec(p))) {
      const d = st.deliveries.find((x) => x.id === m![1]);
      if (!d || d.status !== "failed") return json(route, { error: "not_retryable" }, 409);
      Object.assign(d, { status: "pending", attempts: 0, nextRetryAt: iso(0) });
      return json(route, d);
    }
    if ((m = /^\/v1\/webhooks\/([^/]+)(?:\/(test|deliveries|rotate-secret))?$/.exec(p))) {
      const sub = st.subs.find((s) => s.id === m![1]);
      if (!sub) return json(route, { error: "unknown_webhook" }, 404);
      const what = m[2];
      if (what === "test") return json(route, { ok: true, responseCode: 204, error: null, delivery: {} });
      if (what === "deliveries") return json(route, { deliveries: st.deliveries.filter((d) => d.subscriptionId === sub.id) });
      if (what === "rotate-secret") return json(route, { ...sub, secret: SECRET_2 });
      if (method === "PATCH") {
        Object.assign(sub, body);
        return json(route, sub);
      }
      if (method === "DELETE") {
        st.subs = st.subs.filter((s) => s.id !== sub.id);
        return json(route, { deleted: true, id: sub.id });
      }
    }
    return route.fallback();
  });
  return st;
}

test.describe("ADR-0173 2b: outbound webhooks (admin)", () => {
  test("add → secret once → test → deliveries and retry → pause → edit → rotate → remove", async ({ page }) => {
    const st = await installWebhooksMock(page);
    await page.goto("/ui/admin/webhooks");
    await expect(page.getByRole("heading", { level: 1, name: "Webhooks" })).toBeVisible();
    await expect(page.getByText("No webhooks", { exact: true })).toBeVisible();
    await expect(page.getByText("Standard Webhooks")).toBeVisible();
    await expectAxeClean(page, "webhooks, empty");

    // the egress guard's refusal is shown verbatim
    await page.getByLabel("Name").fill("release-notifier");
    await page.getByLabel("Endpoint URL").fill("https://elsewhere.example.test/hook");
    await page.getByLabel("Every prompt event, including ones added later").check();
    await expect(page.getByLabel(/prompt\.commit/)).toBeDisabled();
    await page.getByRole("button", { name: "Add webhook" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "not on the egress allow-list" })).toBeVisible();

    await page.getByLabel("Endpoint URL").fill("https://hooks.example.test/regulait");
    await page.getByRole("button", { name: "Add webhook" }).click();
    await expect(page.getByTestId("webhook-secret")).toHaveText(SECRET_1);
    expect(sentTo(st, "POST", "/v1/webhooks")[1]).toEqual({ name: "release-notifier", url: "https://hooks.example.test/regulait", events: ["prompt.*"] });
    const row = page.getByRole("row").filter({ hasText: "release-notifier" });
    await expect(row).toContainText("prompt.* (4 now)");
    await expect(row).toContainText("1 failed");
    await expectAxeClean(page, "webhooks, one subscription and the secret");
    await page.getByRole("button", { name: "Dismiss" }).click();
    await expect(page.getByTestId("webhook-secret")).toHaveCount(0);

    await row.getByRole("button", { name: "Send a test to release-notifier" }).click();
    await expect(page.getByText("Test delivered to release-notifier (HTTP 204)")).toBeVisible();
    expect(sentTo(st, "POST", `/v1/webhooks/${SUB}/test`)).toHaveLength(1);

    await row.getByRole("button", { name: "Deliveries of release-notifier" }).click();
    const log = page.getByRole("dialog", { name: "Deliveries — release-notifier" });
    await expect(log.getByRole("row").filter({ hasText: "prompt.commit" })).toContainText("the receiver answered HTTP 500");
    await expectAxeClean(page, "delivery log");
    await log.getByRole("button", { name: "Retry delivery of prompt.commit" }).click();
    await expect(page.getByText("Delivery of prompt.commit requeued")).toBeVisible();
    expect(sentTo(st, "POST", `/v1/webhooks/deliveries/${DELIVERY_FAILED}/retry`)).toHaveLength(1);
    await log.getByRole("button", { name: "Close" }).click();

    await row.getByRole("button", { name: "Pause release-notifier" }).click();
    await expect(row.getByRole("button", { name: "Resume release-notifier" })).toBeVisible();
    expect(sentTo(st, "PATCH", `/v1/webhooks/${SUB}`)).toEqual([{ active: false }]);

    await row.getByRole("button", { name: "Edit release-notifier" }).click();
    const edit = page.getByRole("dialog", { name: "Edit release-notifier" });
    await edit.getByLabel("Every prompt event, including ones added later").uncheck();
    await edit.getByLabel(/prompt\.promotion\.decided/).check();
    await edit.getByRole("button", { name: "Save" }).click();
    await expect(edit).toHaveCount(0);
    expect(sentTo(st, "PATCH", `/v1/webhooks/${SUB}`)[1]).toEqual({ events: ["prompt.promotion.decided"] });

    await row.getByRole("button", { name: "Rotate the secret of release-notifier" }).click();
    await expect(page.getByTestId("webhook-secret")).toHaveText(SECRET_2);

    await page.getByRole("button", { name: "Run the retry pass now" }).click();
    await expect(page.getByText("Retry pass: 1 due, 1 delivered, 0 will retry, 0 gave up")).toBeVisible();

    await row.getByRole("button", { name: "Remove webhook release-notifier" }).click();
    await page.getByRole("dialog", { name: "Remove webhook release-notifier?" }).getByRole("button", { name: "Remove" }).click();
    await expect(page.getByText("No webhooks", { exact: true })).toBeVisible();
    expect(sentTo(st, "DELETE", `/v1/webhooks/${SUB}`)).toHaveLength(1);
  });
});
