/**
 * ADR-0173 batch 2b — outbound webhooks, end to end against a REAL local
 * receiver behind the REAL egress guard (custom-providers / external-scorers
 * pattern): 127.0.0.1 is unreachable until an admin allow-lists it with
 * private ranges + plaintext, and the receiver verifies every request with the
 * Standard Webhooks reference verifier under the secret the create call showed
 * once.
 *
 * Rules, each with its control:
 *  - admin-only CRUD; the secret is returned once and never listed;
 *  - default-deny egress refuses a subscription before an allow entry exists;
 *  - every POST is Standard-Webhooks signed: the receiver's verifier accepts
 *    it, and rejects it under a different secret;
 *  - a failed delivery retries with exponential backoff on the sweep, keeps its
 *    `webhook-id` across retries, and is `failed` + audited after maxAttempts;
 *  - a deactivated subscription receives nothing;
 *  - the test notification is sent at once and logged;
 *  - a prompt commit reaches a `prompt.*` subscriber with ids/names/hashes only.
 *
 * Shared state: the 127.0.0.1 allow entry this file adds is removed in
 * afterAll (M-068), and the subscriptions it creates are deleted there too.
 */
import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Webhook } from "standardwebhooks";
import { and, auditLog, eq, egressAllowHosts, webhookDeliveries, webhookSubscriptions } from "@regulait/db";
import { WEBHOOK_LIMITS } from "@regulait/shared";
import { builderKit, type BuilderKit, type Person } from "./testing/builder-fixture.js";
import { drainBackgroundWork } from "./background-work.js";
import { runWebhookDeliverySweep } from "./outbound-webhooks.js";

let k: BuilderKit;
let admin: Person;
let person: Person;
let srv: http.Server;
let port = 0;
let allowId: string | null = null;
const createdSubs: string[] = [];

/** what the receiver saw */
const hits: Array<{ path: string; headers: Record<string, string>; body: string }> = [];
/** per-path status the receiver answers with */
const statusFor = new Map<string, number>();

const url = (path: string) => `http://127.0.0.1:${port}${path}`;
const DATA_KEY = "a".repeat(64);

beforeAll(async () => {
  k = await builderKit("owh");
  admin = await k.person("admin", { admin: true });
  person = await k.person("person");
  srv = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const headers: Record<string, string> = {};
      for (const [h, v] of Object.entries(req.headers)) if (typeof v === "string") headers[h] = v;
      hits.push({ path: req.url ?? "", headers, body: raw });
      res.writeHead(statusFor.get(req.url ?? "") ?? 204);
      res.end();
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  port = (srv.address() as { port: number }).port;
});

afterAll(async () => {
  await drainBackgroundWork(k.db);
  if (createdSubs.length) {
    for (const id of createdSubs) await k.db.delete(webhookSubscriptions).where(eq(webhookSubscriptions.id, id));
  }
  if (allowId) await k.db.delete(egressAllowHosts).where(eq(egressAllowHosts.id, allowId));
  srv.closeAllConnections();
  await new Promise<void>((r) => srv.close(() => r()));
  await k.close();
});

let reusedAllow = false;
async function allowLoopback() {
  if (allowId || reusedAllow) return;
  const [existing] = await k.db.select().from(egressAllowHosts).where(eq(egressAllowHosts.host, "127.0.0.1"));
  if (existing) {
    // another file's entry: use it as it is, and never delete what is not ours
    if (!existing.allowPrivateRanges || !existing.allowPlaintextHttp) {
      throw new Error("127.0.0.1 is allow-listed by someone else without private ranges + plaintext");
    }
    reusedAllow = true;
    return;
  }
  const [row] = await k.db
    .insert(egressAllowHosts)
    .values({ host: "127.0.0.1", allowPrivateRanges: true, allowPlaintextHttp: true, note: "owh test receiver" })
    .returning();
  allowId = row!.id;
}

async function createSub(path: string, events: string[], extra: Record<string, unknown> = {}) {
  const r = await k.req("POST", "/v1/webhooks", admin.auth, {
    name: `owh-${path.replace(/\W/g, "")}-${k.RUN}`,
    url: url(path),
    events,
    allowPlaintextHttp: true,
    ...extra,
  });
  expect(r.statusCode, r.body).toBe(201);
  createdSubs.push(r.json().id);
  return r.json() as { id: string; secret: string };
}

describe("admin-only", () => {
  it("every webhook route refuses a non-admin", async () => {
    for (const [m, u] of [
      ["GET", "/v1/webhooks"],
      ["GET", "/v1/webhooks/events"],
      ["POST", "/v1/webhooks"],
      ["POST", "/v1/webhooks/sweep"],
    ] as const) {
      const r = await k.req(m, u, person.auth, m === "POST" ? {} : undefined);
      expect(r.statusCode, `${m} ${u}`).toBe(403);
    }
  });

  it("the event registry names every event and the signing scheme", async () => {
    const r = await k.req("GET", "/v1/webhooks/events", admin.auth);
    expect(r.statusCode).toBe(200);
    expect(r.json().events.map((e: { name: string }) => e.name)).toEqual(
      expect.arrayContaining(["prompt.commit", "prompt.tag.moved", "prompt.promotion.requested", "prompt.promotion.decided"]),
    );
    expect(r.json().signing.headers).toEqual(["webhook-id", "webhook-timestamp", "webhook-signature"]);
  });

  it("refuses an unregistered event selector", async () => {
    const r = await k.req("POST", "/v1/webhooks", admin.auth, { name: `owh-bad-${k.RUN}`, url: "https://example.com/x", events: ["nope.*"] });
    expect(r.statusCode).toBe(400);
  });
});

describe("egress and signing", () => {
  it("a loopback receiver is refused until an admin allow-lists it", async () => {
    const r = await k.req("POST", "/v1/webhooks", admin.auth, {
      name: `owh-denied-${k.RUN}`, url: url("/denied"), events: ["prompt.*"], allowPlaintextHttp: true,
    });
    expect(r.statusCode, r.body).toBe(400);
    expect(r.json().error).toBe("egress_blocked");
    const audits = await k.db.select().from(auditLog).where(and(eq(auditLog.objectType, "webhook_subscription"), eq(auditLog.ruleId, "egress-blocked")));
    expect(audits.length).toBeGreaterThan(0);
  });

  it("the test notification is Standard-Webhooks signed with the secret shown once", async () => {
    await allowLoopback();
    const sub = await createSub("/signed", ["prompt.*"]);
    expect(sub.secret).toMatch(/^whsec_/);
    // never listed again
    const list = await k.req("GET", "/v1/webhooks", admin.auth);
    expect(list.body).not.toContain(sub.secret);
    expect(list.body).not.toContain("ciphertext");

    const t = await k.req("POST", `/v1/webhooks/${sub.id}/test`, admin.auth);
    expect(t.statusCode, t.body).toBe(200);
    expect(t.json()).toMatchObject({ ok: true, responseCode: 204 });
    const hit = hits.filter((h) => h.path === "/signed").at(-1)!;
    expect(hit.headers["webhook-id"]).toBe(t.json().delivery.messageId);
    const verified = new Webhook(sub.secret).verify(hit.body, hit.headers) as { type: string; data: Record<string, unknown> };
    expect(verified.type).toBe("webhook.test");
    expect(verified.data.subscriptionId).toBe(sub.id);
    // a different secret does not verify
    expect(() => new Webhook(`whsec_${Buffer.from("x".repeat(32)).toString("base64")}`).verify(hit.body, hit.headers)).toThrow();
    // the test is in the delivery log
    const log = await k.req("GET", `/v1/webhooks/${sub.id}/deliveries`, admin.auth);
    expect(log.json().deliveries[0]).toMatchObject({ event: "webhook.test", status: "delivered", responseCode: 204 });
  });

  it("a prompt commit reaches a prompt.* subscriber, signed, with ids and hashes only", async () => {
    await allowLoopback();
    const sub = await createSub("/prompts", ["prompt.commit"]);
    const p = await k.req("POST", "/v1/prompts", person.auth, { name: `owh-prompt-${k.RUN}` });
    const c = await k.req("POST", `/v1/prompts/${p.json().prompt.id}/commits`, person.auth, {
      template: "Hello {{name}} TEMPLATE-BODY-MARKER", parentHash: null, message: "first",
    });
    expect(c.statusCode, c.body).toBe(201);
    await drainBackgroundWork(k.db);
    const hit = hits.filter((h) => h.path === "/prompts").at(-1);
    expect(hit, "the commit event was delivered").toBeDefined();
    const verified = new Webhook(sub.secret).verify(hit!.body, hit!.headers) as { type: string; data: Record<string, unknown> };
    expect(verified.type).toBe("prompt.commit");
    expect(verified.data).toMatchObject({ promptId: p.json().prompt.id, commitHash: c.json().hash, authorUserId: person.id });
    expect(hit!.body).not.toContain("TEMPLATE-BODY-MARKER");
    const [row] = await k.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.subscriptionId, sub.id));
    expect(row).toMatchObject({ status: "delivered", attempts: 1, responseCode: 204 });
  });
});

describe("retries", () => {
  it("backs off exponentially on the sweep, keeps the webhook-id, and gives up after maxAttempts", async () => {
    await allowLoopback();
    statusFor.set("/flaky", 500);
    const sub = await createSub("/flaky", ["prompt.*"]);
    const p = await k.req("POST", "/v1/prompts", person.auth, { name: `owh-flaky-${k.RUN}` });
    await k.req("POST", `/v1/prompts/${p.json().prompt.id}/commits`, person.auth, { template: "x", parentHash: null, message: "m" });
    await drainBackgroundWork(k.db);
    let [row] = await k.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.subscriptionId, sub.id));
    expect(row).toMatchObject({ status: "pending", attempts: 1, responseCode: 500 });
    const firstGap = row!.nextRetryAt!.getTime() - row!.lastAttemptAt!.getTime();
    expect(firstGap).toBe(WEBHOOK_LIMITS.baseBackoffSeconds * 1000);

    // not due yet: a sweep now does not touch it
    await runWebhookDeliverySweep(k.db, DATA_KEY, { now: new Date(row!.lastAttemptAt!.getTime() + 1000) });
    [row] = await k.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, row!.id));
    expect(row!.attempts).toBe(1);

    // due: each sweep at the due time is one more attempt, with a doubled gap
    for (let attempt = 2; attempt <= WEBHOOK_LIMITS.maxAttempts; attempt += 1) {
      await runWebhookDeliverySweep(k.db, DATA_KEY, { now: row!.nextRetryAt! });
      const [next] = await k.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, row!.id));
      expect(next!.attempts).toBe(attempt);
      if (attempt < WEBHOOK_LIMITS.maxAttempts) {
        expect(next!.status).toBe("pending");
        expect(next!.nextRetryAt!.getTime() - next!.lastAttemptAt!.getTime()).toBe(
          Math.min(WEBHOOK_LIMITS.maxBackoffSeconds, WEBHOOK_LIMITS.baseBackoffSeconds * 2 ** (attempt - 1)) * 1000,
        );
      } else {
        expect(next!.status).toBe("failed");
        expect(next!.nextRetryAt).toBeNull();
      }
      row = next;
    }
    const sent = hits.filter((h) => h.path === "/flaky");
    expect(sent).toHaveLength(WEBHOOK_LIMITS.maxAttempts);
    expect(new Set(sent.map((h) => h.headers["webhook-id"])).size).toBe(1);
    const gaveUp = await k.db.select().from(auditLog).where(and(eq(auditLog.objectId, sub.id), eq(auditLog.ruleId, "webhook-delivery-failed")));
    expect(gaveUp).toHaveLength(1);

    // an admin requeue sends it again (now answered)
    statusFor.set("/flaky", 200);
    const again = await k.req("POST", `/v1/webhooks/deliveries/${row!.id}/retry`, admin.auth);
    expect(again.statusCode, again.body).toBe(200);
    await drainBackgroundWork(k.db);
    const [done] = await k.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, row!.id));
    expect(done!.status).toBe("delivered");
  });

  it("a deactivated subscription receives nothing", async () => {
    await allowLoopback();
    const sub = await createSub("/off", ["prompt.*"]);
    const off = await k.req("PATCH", `/v1/webhooks/${sub.id}`, admin.auth, { active: false });
    expect(off.statusCode, off.body).toBe(200);
    const p = await k.req("POST", "/v1/prompts", person.auth, { name: `owh-off-${k.RUN}` });
    await k.req("POST", `/v1/prompts/${p.json().prompt.id}/commits`, person.auth, { template: "y", parentHash: null, message: "m" });
    await drainBackgroundWork(k.db);
    expect(hits.filter((h) => h.path === "/off")).toHaveLength(0);
    expect(await k.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.subscriptionId, sub.id))).toHaveLength(0);
  });

  it("rotating the secret signs with the new one; deleting removes the subscription", async () => {
    await allowLoopback();
    const sub = await createSub("/rotate", ["prompt.*"]);
    const rot = await k.req("POST", `/v1/webhooks/${sub.id}/rotate-secret`, admin.auth);
    expect(rot.statusCode).toBe(200);
    const fresh = rot.json().secret as string;
    expect(fresh).not.toBe(sub.secret);
    await k.req("POST", `/v1/webhooks/${sub.id}/test`, admin.auth);
    const hit = hits.filter((h) => h.path === "/rotate").at(-1)!;
    expect(() => new Webhook(fresh).verify(hit.body, hit.headers)).not.toThrow();
    expect(() => new Webhook(sub.secret).verify(hit.body, hit.headers)).toThrow();
    const del = await k.req("DELETE", `/v1/webhooks/${sub.id}`, admin.auth);
    expect(del.statusCode).toBe(200);
    expect(await k.db.select().from(webhookSubscriptions).where(eq(webhookSubscriptions.id, sub.id))).toHaveLength(0);
  });
});
