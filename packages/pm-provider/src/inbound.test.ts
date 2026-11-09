import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  PmProviderError,
  constantTimeEqual,
  parseAsanaInboundWebhook,
  parseAzureDevOpsInboundWebhook,
  parseGenericInboundWebhook,
  parseInboundWebhook,
  parseJiraInboundWebhook,
  parseLinearInboundWebhook,
  parseMondayInboundWebhook,
  inboundDeliveryKey,
  signGenericInboundWebhook,
  PM_WEBHOOK_REPLAY_WINDOW_SECONDS,
  PM_UNSIGNED_DELIVERY_MAX_AGE_DAYS,
  type InboundWebhookInput,
} from "./index.js";

const SECRET = "rglwh_test_secret_0123456789abcdef";
/** the tests own the clock (ms) */
const NOW = 1_785_000_000_000;
const NOW_S = NOW / 1000;
const NOW_ISO = new Date(NOW).toISOString();

const sig = (secret: string, body: string) =>
  createHmac("sha256", secret).update(body).digest("hex");

const input = (over: Partial<InboundWebhookInput> & { rawBody?: string }): InboundWebhookInput => ({
  headers: {},
  query: {},
  rawBody: "{}",
  secret: SECRET,
  connectionProject: "PROJ",
  nowMs: NOW,
  ...over,
});

describe("constant-time comparison helper", () => {
  it("matches equal strings, rejects different or different-length ones", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("abc", "abcd")).toBe(false); // never throws on length mismatch
    expect(constantTimeEqual("", "")).toBe(true);
  });
});

describe("jira inbound (URL-token verification — Jira Cloud manual webhooks cannot sign)", () => {
  const issueBody = JSON.stringify({
    timestamp: NOW, webhookEvent: "jira:issue_updated",
    issue: {
      id: 10042,
      key: "REG-7",
      fields: { summary: "Build API", description: "the plan", status: { name: "Done" } },
    },
  });

  it("a valid ?token= translates issue events to the normalized shape (id, state, fields)", () => {
    const res = parseJiraInboundWebhook(input({ query: { token: SECRET }, rawBody: issueBody }));
    expect(res).toEqual({
      kind: "events",
      events: [
        {
          externalId: "10042",
          event: "updated",
          state: "Done",
          fields: { summary: "Build API", description: "the plan" },
        },
      ],
    });
    const deleted = parseJiraInboundWebhook(
      input({
        query: { token: SECRET },
        rawBody: JSON.stringify({ timestamp: NOW, webhookEvent: "jira:issue_deleted", issue: { id: "10042" } }),
      }),
    );
    expect(deleted).toEqual({ kind: "events", events: [{ externalId: "10042", event: "deleted" }] });
  });

  it("missing or wrong token throws PmProviderError — fail-closed", () => {
    expect(() => parseJiraInboundWebhook(input({ rawBody: issueBody }))).toThrow(PmProviderError);
    expect(() =>
      parseJiraInboundWebhook(input({ query: { token: "wrong" }, rawBody: issueBody })),
    ).toThrow(PmProviderError);
  });

  it("comment_created becomes a commented event on the issue; unconsumed events are ignored, never errors", () => {
    const commented = parseJiraInboundWebhook(
      input({
        query: { token: SECRET },
        rawBody: JSON.stringify({
          timestamp: NOW, webhookEvent: "comment_created",
          issue: { id: "10042" },
          comment: { body: "looks good" },
        }),
      }),
    );
    expect(commented).toEqual({
      kind: "events",
      events: [{ externalId: "10042", event: "commented", fields: { comment: "looks good" } }],
    });
    const ignored = parseJiraInboundWebhook(
      input({ query: { token: SECRET }, rawBody: JSON.stringify({ timestamp: NOW, webhookEvent: "sprint_started" }) }),
    );
    expect(ignored).toEqual({ kind: "ignored", reason: "jira event 'sprint_started' is not consumed" });
  });
});

describe("linear inbound (linear-signature = hex HMAC-SHA256 of the raw body)", () => {
  const issueBody = JSON.stringify({
    action: "update",
    type: "Issue",
    webhookTimestamp: NOW,
    data: {
      id: "lin-uuid-1",
      identifier: "REG-9",
      title: "Ship feature",
      description: "details",
      state: { name: "In Progress" },
    },
    updatedFrom: { stateId: "old" },
  });

  it("a correctly signed Issue update translates with state and fields; remove → deleted", () => {
    const res = parseLinearInboundWebhook(
      input({ headers: { "linear-signature": sig(SECRET, issueBody) }, rawBody: issueBody }),
    );
    expect(res).toEqual({
      kind: "events",
      events: [
        {
          externalId: "lin-uuid-1",
          event: "updated",
          state: "In Progress",
          fields: { title: "Ship feature", description: "details" },
        },
      ],
    });
    const removeBody = JSON.stringify({ action: "remove", type: "Issue", webhookTimestamp: NOW, data: { id: "lin-uuid-1" } });
    const removed = parseLinearInboundWebhook(
      input({ headers: { "linear-signature": sig(SECRET, removeBody) }, rawBody: removeBody }),
    );
    expect(removed).toEqual({ kind: "events", events: [{ externalId: "lin-uuid-1", event: "deleted" }] });
  });

  it("a missing or invalid signature throws — including a signature over DIFFERENT bytes", () => {
    expect(() => parseLinearInboundWebhook(input({ rawBody: issueBody }))).toThrow(PmProviderError);
    expect(() =>
      parseLinearInboundWebhook(
        input({ headers: { "linear-signature": sig("other-key", issueBody) }, rawBody: issueBody }),
      ),
    ).toThrow(/linear webhook invalid/);
    expect(() =>
      parseLinearInboundWebhook(
        input({ headers: { "linear-signature": sig(SECRET, issueBody + " ") }, rawBody: issueBody }),
      ),
    ).toThrow(PmProviderError);
  });

  it("Comment create maps to commented on the parent issue; non-Issue/Comment types are ignored", () => {
    const commentBody = JSON.stringify({
      action: "create",
      type: "Comment",
      webhookTimestamp: NOW,
      data: { id: "cmt-1", body: "nice", issueId: "lin-uuid-1" },
    });
    const commented = parseLinearInboundWebhook(
      input({ headers: { "linear-signature": sig(SECRET, commentBody) }, rawBody: commentBody }),
    );
    expect(commented).toEqual({
      kind: "events",
      events: [{ externalId: "lin-uuid-1", event: "commented", fields: { comment: "nice" } }],
    });
    const projBody = JSON.stringify({ action: "update", type: "Project", webhookTimestamp: NOW, data: { id: "p1" } });
    expect(
      parseLinearInboundWebhook(
        input({ headers: { "linear-signature": sig(SECRET, projBody) }, rawBody: projBody }),
      ),
    ).toEqual({ kind: "ignored", reason: "linear Project events are not consumed" });
  });

  it("S-03: the signed webhookTimestamp must be inside the replay window, either side; a body without one is refused", () => {
    const signed = (body: string) => input({ headers: { "linear-signature": sig(SECRET, body) }, rawBody: body });
    const at = (ts: number | undefined) =>
      JSON.stringify({ action: "update", type: "Issue", ...(ts === undefined ? {} : { webhookTimestamp: ts }), data: { id: "x" } });
    const W = PM_WEBHOOK_REPLAY_WINDOW_SECONDS * 1000;
    // boundary: exactly the window is accepted (non-vacuity of the refusals below)
    expect(parseLinearInboundWebhook(signed(at(NOW - W))).kind).toBe("events");
    expect(parseLinearInboundWebhook(signed(at(NOW + W))).kind).toBe("events");
    expect(() => parseLinearInboundWebhook(signed(at(NOW - W - 1)))).toThrow(/replay window/);
    expect(() => parseLinearInboundWebhook(signed(at(NOW + W + 1)))).toThrow(/replay window/);
    expect(() => parseLinearInboundWebhook(signed(at(undefined)))).toThrow(/no signed webhookTimestamp/);
    // a stale replay is a verification failure (401), not a malformed payload
    try {
      parseLinearInboundWebhook(signed(at(NOW - W - 1)));
    } catch (err) {
      expect((err as PmProviderError).status).toBe(401);
    }
  });
});

describe("asana inbound (two-phase: x-hook-secret handshake, then x-hook-signature HMAC)", () => {
  it("the establishment handshake echoes the exact x-hook-secret header and processes nothing", () => {
    const res = parseAsanaInboundWebhook(
      input({ headers: { "x-hook-secret": "asana-issued-abc123" }, rawBody: "" }),
    );
    expect(res).toEqual({
      kind: "handshake",
      response: {},
      headers: { "x-hook-secret": "asana-issued-abc123" },
      statusCode: 200,
    });
  });

  it("signed thin task events become state-less updated/deleted signals; stories become comments", () => {
    const body = JSON.stringify({
      events: [
        { action: "changed", created_at: NOW_ISO, resource: { gid: 555, resource_type: "task" } },
        { action: "deleted", created_at: NOW_ISO, resource: { gid: "556", resource_type: "task" } },
        {
          action: "added",
          created_at: NOW_ISO,
          resource: { gid: "st-1", resource_type: "story" },
          parent: { gid: "555", resource_type: "task" },
        },
        { action: "removed", created_at: NOW_ISO, resource: { gid: "557", resource_type: "task" } }, // not consumed
      ],
    });
    const res = parseAsanaInboundWebhook(
      input({ headers: { "x-hook-signature": sig(SECRET, body) }, rawBody: body }),
    );
    expect(res).toEqual({
      kind: "events",
      events: [
        { externalId: "555", event: "updated" }, // thin: no state — read-through resolves content
        { externalId: "556", event: "deleted" },
        { externalId: "555", event: "commented" },
      ],
    });
  });

  it("a missing/invalid x-hook-signature throws; a payload with no actionable events is ignored", () => {
    const body = JSON.stringify({ events: [{ action: "changed", created_at: NOW_ISO, resource: { gid: "1", resource_type: "project" } }] });
    expect(() => parseAsanaInboundWebhook(input({ rawBody: body }))).toThrow(PmProviderError);
    expect(() =>
      parseAsanaInboundWebhook(
        input({ headers: { "x-hook-signature": sig("wrong", body) }, rawBody: body }),
      ),
    ).toThrow(PmProviderError);
    const ignored = parseAsanaInboundWebhook(
      input({ headers: { "x-hook-signature": sig(SECRET, body) }, rawBody: body }),
    );
    expect(ignored).toEqual({
      kind: "ignored",
      reason: "asana events are thin; none actionable — content is resolved by read-through",
    });
  });
});

describe("monday inbound (challenge handshake; URL-token verification — monday sends no signature)", () => {
  it("echoes the challenge verbatim — but only with a valid ?token= (fail-closed even for handshakes)", () => {
    const body = JSON.stringify({ challenge: "c9a0e5b2-uuid" });
    const res = parseMondayInboundWebhook(input({ query: { token: SECRET }, rawBody: body }));
    expect(res).toEqual({ kind: "handshake", response: { challenge: "c9a0e5b2-uuid" }, statusCode: 200 });
    expect(() => parseMondayInboundWebhook(input({ rawBody: body }))).toThrow(PmProviderError);
    expect(() => parseMondayInboundWebhook(input({ query: { token: "no" }, rawBody: body }))).toThrow(
      PmProviderError,
    );
  });

  it("update_column_value on a status column reports the new label text as state", () => {
    const body = JSON.stringify({
      event: {
        triggerTime: NOW_ISO,
        type: "update_column_value",
        pulseId: 4321,
        boardId: 777,
        columnId: "status",
        value: { label: { text: "Done" } },
      },
    });
    const res = parseMondayInboundWebhook(input({ query: { token: SECRET }, rawBody: body }));
    expect(res).toEqual({
      kind: "events",
      events: [{ externalId: "4321", event: "updated", state: "Done" }],
    });
  });

  it("create_pulse reports an update (normalized has no 'created'), deletions delete, updates comment", () => {
    const created = parseMondayInboundWebhook(
      input({
        query: { token: SECRET },
        rawBody: JSON.stringify({ event: { triggerTime: NOW_ISO, type: "create_pulse", pulseId: 9, pulseName: "New item" } }),
      }),
    );
    expect(created).toEqual({
      kind: "events",
      events: [{ externalId: "9", event: "updated", fields: { name: "New item" } }],
    });
    const deleted = parseMondayInboundWebhook(
      input({
        query: { token: SECRET },
        rawBody: JSON.stringify({ event: { triggerTime: NOW_ISO, type: "item_deleted", itemId: 9 } }),
      }),
    );
    expect(deleted).toEqual({ kind: "events", events: [{ externalId: "9", event: "deleted" }] });
    const commented = parseMondayInboundWebhook(
      input({
        query: { token: SECRET },
        rawBody: JSON.stringify({ event: { triggerTime: NOW_ISO, type: "create_update", pulseId: 9, textBody: "hello" } }),
      }),
    );
    expect(commented).toEqual({
      kind: "events",
      events: [{ externalId: "9", event: "commented", fields: { comment: "hello" } }],
    });
    const ignored = parseMondayInboundWebhook(
      input({
        query: { token: SECRET },
        rawBody: JSON.stringify({ event: { triggerTime: NOW_ISO, type: "create_column", boardId: 777, pulseId: 1 } }),
      }),
    );
    expect(ignored).toEqual({ kind: "ignored", reason: "monday event 'create_column' is not consumed" });
  });
});

describe("azure_devops inbound (service-hook basic auth; created/updated payload asymmetry)", () => {
  const basic = (user: string, pass: string) =>
    `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;

  it("workitem.updated verifies the basic-auth password and reads ids/fields from the update+revision", () => {
    const body = JSON.stringify({
      createdDate: NOW_ISO, eventType: "workitem.updated",
      resource: {
        id: 999, // the UPDATE id — must NOT be used as the work item id
        workItemId: 42,
        fields: { "System.State": { oldValue: "To Do", newValue: "Doing" } },
        revision: { id: 42, fields: { "System.Title": "Build API", "System.State": "Doing" } },
      },
    });
    const res = parseAzureDevOpsInboundWebhook(
      input({ headers: { authorization: basic("svc", SECRET) }, rawBody: body }),
    );
    expect(res).toEqual({
      kind: "events",
      events: [{ externalId: "42", event: "updated", state: "Doing", fields: { title: "Build API" } }],
    });
  });

  it("workitem.created reads plain fields from the resource; deleted deletes; others are ignored", () => {
    const created = parseAzureDevOpsInboundWebhook(
      input({
        headers: { authorization: basic("", SECRET) },
        rawBody: JSON.stringify({
          createdDate: NOW_ISO, eventType: "workitem.created",
          resource: { id: 42, fields: { "System.Title": "Build API", "System.State": "To Do" } },
        }),
      }),
    );
    expect(created).toEqual({
      kind: "events",
      events: [{ externalId: "42", event: "updated", state: "To Do", fields: { title: "Build API" } }],
    });
    const deleted = parseAzureDevOpsInboundWebhook(
      input({
        headers: { authorization: basic("svc", SECRET) },
        rawBody: JSON.stringify({ createdDate: NOW_ISO, eventType: "workitem.deleted", resource: { id: 42 } }),
      }),
    );
    expect(deleted).toEqual({ kind: "events", events: [{ externalId: "42", event: "deleted" }] });
    const ignored = parseAzureDevOpsInboundWebhook(
      input({
        headers: { authorization: basic("svc", SECRET) },
        rawBody: JSON.stringify({ createdDate: NOW_ISO, eventType: "build.complete" }),
      }),
    );
    expect(ignored).toEqual({ kind: "ignored", reason: "azure_devops event 'build.complete' is not consumed" });
  });

  it("missing or wrong basic-auth password throws — fail-closed", () => {
    const body = JSON.stringify({ createdDate: NOW_ISO, eventType: "workitem.deleted", resource: { id: 1 } });
    expect(() => parseAzureDevOpsInboundWebhook(input({ rawBody: body }))).toThrow(PmProviderError);
    expect(() =>
      parseAzureDevOpsInboundWebhook(
        input({ headers: { authorization: basic("svc", "wrong") }, rawBody: body }),
      ),
    ).toThrow(PmProviderError);
  });
});

describe("generic_webhook/mock inbound (S-03: timestamped signature only; the static header is gone)", () => {
  const body = JSON.stringify({ externalId: "7", event: "updated", state: "in_review" });
  const ts = String(NOW_S);
  const genericSig = (secret: string, t: string, b: string) => `sha256=${sig(secret, `${t}.${b}`)}`;

  it("verifies x-regulait-signature over \"<x-regulait-timestamp>.<raw body>\"", () => {
    const res = parseGenericInboundWebhook(input({ headers: signGenericInboundWebhook(SECRET, body, NOW_S), rawBody: body }));
    expect(res).toEqual({
      kind: "events",
      events: [{ externalId: "7", event: "updated", state: "in_review" }],
    });
    expect(signGenericInboundWebhook(SECRET, body, NOW_S)).toEqual({
      "x-regulait-timestamp": ts,
      "x-regulait-signature": genericSig(SECRET, ts, body),
    });
  });

  it("refuses the static x-regulait-webhook-secret header, even holding the right secret", () => {
    expect(() =>
      parseGenericInboundWebhook(input({ headers: { "x-regulait-webhook-secret": SECRET }, rawBody: body })),
    ).toThrow(/requires x-regulait-timestamp and x-regulait-signature/);
    expect(() => parseGenericInboundWebhook(input({ rawBody: body }))).toThrow(PmProviderError);
  });

  it("refuses the body-only signature of the first cut, and a timestamp the signature does not cover", () => {
    // the old contract: a correct HMAC of the body alone, with a timestamp header added
    expect(() =>
      parseGenericInboundWebhook(
        input({ headers: { "x-regulait-timestamp": ts, "x-regulait-signature": `sha256=${sig(SECRET, body)}` }, rawBody: body }),
      ),
    ).toThrow(/verification failed/);
    // a valid signature for one timestamp, presented with another (moving a capture into the window)
    expect(() =>
      parseGenericInboundWebhook(
        input({ headers: { "x-regulait-timestamp": String(NOW_S + 1), "x-regulait-signature": genericSig(SECRET, ts, body) }, rawBody: body }),
      ),
    ).toThrow(/verification failed/);
    expect(() =>
      parseGenericInboundWebhook(input({ headers: { ...signGenericInboundWebhook(SECRET, body, NOW_S), "x-regulait-timestamp": "1e9" }, rawBody: body })),
    ).toThrow(/not unix seconds/);
  });

  it("refuses a correctly signed but stale (or future) delivery; the window edge is accepted", () => {
    const W = PM_WEBHOOK_REPLAY_WINDOW_SECONDS;
    const at = (s: number) => input({ headers: signGenericInboundWebhook(SECRET, body, s), rawBody: body });
    expect(parseGenericInboundWebhook(at(NOW_S - W)).kind).toBe("events");
    expect(parseGenericInboundWebhook(at(NOW_S + W)).kind).toBe("events");
    expect(() => parseGenericInboundWebhook(at(NOW_S - W - 1))).toThrow(/replay window/);
    expect(() => parseGenericInboundWebhook(at(NOW_S + W + 1))).toThrow(/replay window/);
  });
});

describe("S-03 review finding 2: providers that sign no timestamp must carry a recent in-body creation time", () => {
  const DAY = 86_400_000;
  const MAX = PM_UNSIGNED_DELIVERY_MAX_AGE_DAYS * DAY;
  const FUT = PM_WEBHOOK_REPLAY_WINDOW_SECONDS * 1000;
  const iso = (ms: number) => new Date(ms).toISOString();
  const jira = (ts: unknown) =>
    parseJiraInboundWebhook(
      input({
        query: { token: SECRET },
        rawBody: JSON.stringify({ ...(ts === undefined ? {} : { timestamp: ts }), webhookEvent: "jira:issue_deleted", issue: { id: "1" } }),
      }),
    );
  const asana = (times: Array<string | undefined>) => {
    const body = JSON.stringify({
      events: times.map((t, i) => ({ action: "changed", ...(t === undefined ? {} : { created_at: t }), resource: { gid: String(i), resource_type: "task" } })),
    });
    return parseAsanaInboundWebhook(input({ headers: { "x-hook-signature": sig(SECRET, body) }, rawBody: body }));
  };
  const monday = (t: string | undefined) =>
    parseMondayInboundWebhook(
      input({ query: { token: SECRET }, rawBody: JSON.stringify({ event: { ...(t === undefined ? {} : { triggerTime: t }), type: "item_deleted", itemId: 9 } }) }),
    );
  const ado = (t: string | undefined) =>
    parseAzureDevOpsInboundWebhook(
      input({
        headers: { authorization: `Basic ${Buffer.from(`svc:${SECRET}`).toString("base64")}` },
        rawBody: JSON.stringify({ ...(t === undefined ? {} : { createdDate: t }), eventType: "workitem.deleted", resource: { id: 1 } }),
      }),
    );

  it("the edges are accepted: exactly the max age, and the replay window into the future (non-vacuity)", () => {
    expect(jira(NOW - MAX).kind).toBe("events");
    expect(jira(NOW + FUT).kind).toBe("events");
    expect(asana([iso(NOW - MAX)]).kind).toBe("events");
    expect(monday(iso(NOW - MAX)).kind).toBe("events");
    expect(ado(iso(NOW + FUT)).kind).toBe("events");
  });

  it("a delivery older than the max age (a post-prune replay) is refused 401, on every such provider", () => {
    for (const run of [() => jira(NOW - MAX - 1), () => asana([iso(NOW - MAX - 1)]), () => monday(iso(NOW - MAX - 1)), () => ado(iso(NOW - MAX - 1))]) {
      try {
        run();
        throw new Error("accepted a stale delivery");
      } catch (err) {
        expect(err).toBeInstanceOf(PmProviderError);
        expect((err as PmProviderError).status).toBe(401);
        expect((err as Error).message).toMatch(/older than/);
      }
    }
  });

  it("a future timestamp past the window, a missing one and an unparseable one are refused (fail closed)", () => {
    expect(() => jira(NOW + FUT + 1)).toThrow(/older than|future/);
    expect(() => jira(undefined)).toThrow(/carries no creation timestamp/);
    expect(() => monday(undefined)).toThrow(/carries no creation timestamp/);
    expect(() => ado(undefined)).toThrow(/carries no creation timestamp/);
    expect(() => ado("not a date")).toThrow(/older than|future/);
    // one stale or untimed event spoils the whole Asana batch
    expect(() => asana([iso(NOW), iso(NOW - MAX - 1)])).toThrow(/older than/);
    expect(() => asana([iso(NOW), undefined])).toThrow(/carries no creation timestamp/);
  });

  it("handshakes and ignored payloads process nothing, so they need no timestamp", () => {
    const hs = parseAsanaInboundWebhook(input({ headers: { "x-hook-secret": "hs" } }));
    expect(hs.kind).toBe("handshake");
    const challenge = parseMondayInboundWebhook(input({ query: { token: SECRET }, rawBody: JSON.stringify({ challenge: "c" }) }));
    expect(challenge.kind).toBe("handshake");
    const ignored = parseJiraInboundWebhook(input({ query: { token: SECRET }, rawBody: JSON.stringify({ webhookEvent: "sprint_started" }) }));
    expect(ignored.kind).toBe("ignored");
  });

  it("verification still comes first: a stale delivery with a wrong token is a token failure, not an age failure", () => {
    expect(() =>
      parseJiraInboundWebhook(
        input({ query: { token: "wrong" }, rawBody: JSON.stringify({ timestamp: NOW - MAX - 1, webhookEvent: "jira:issue_deleted", issue: { id: "1" } }) }),
      ),
    ).toThrow(/token/);
  });
});

describe("inboundDeliveryKey (S-03 dedup key)", () => {
  it("is the body sha256 plus the provider delivery id where one is sent", () => {
    const body = JSON.stringify({ id: "ado-evt-1", createdDate: NOW_ISO, eventType: "workitem.updated" });
    const k = inboundDeliveryKey("azure_devops", input({ rawBody: body }));
    expect(k.contentSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(k.deliveryId).toBe("ado-evt-1");
    expect(inboundDeliveryKey("jira", input({ headers: { "x-atlassian-webhook-identifier": "jw-1" } })).deliveryId).toBe("jw-1");
    expect(inboundDeliveryKey("linear", input({ headers: { "linear-delivery": "ld-1" } })).deliveryId).toBe("ld-1");
    expect(
      inboundDeliveryKey("monday", input({ rawBody: JSON.stringify({ event: { triggerUuid: "tu-1" } }) })).deliveryId,
    ).toBe("tu-1");
    expect(inboundDeliveryKey("asana", input({ headers: { "x-atlassian-webhook-identifier": "x" } })).deliveryId).toBeNull();
    expect(inboundDeliveryKey("generic_webhook", input({})).deliveryId).toBeNull();
    // a non-JSON body still has a body key
    expect(inboundDeliveryKey("monday", input({ rawBody: "not json" }))).toMatchObject({ deliveryId: null });
  });

  it("a different body is a different key; an over-long id is stored as its sha256", () => {
    const a = inboundDeliveryKey("asana", input({ rawBody: "{\"a\":1}" }));
    const b = inboundDeliveryKey("asana", input({ rawBody: "{\"a\":2}" }));
    expect(a.contentSha256).not.toBe(b.contentSha256);
    const long = inboundDeliveryKey("jira", input({ headers: { "x-atlassian-webhook-identifier": "z".repeat(500) } }));
    expect(long.deliveryId).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe("parseInboundWebhook registry", () => {
  it("dispatches by provider kind — mock shares the generic parser (the tests' e2e vehicle)", () => {
    const body = JSON.stringify({ externalId: "1", event: "deleted" });
    const viaMock = parseInboundWebhook(
      "mock",
      input({ headers: signGenericInboundWebhook(SECRET, body, NOW_S), rawBody: body }),
    );
    expect(viaMock).toEqual({ kind: "events", events: [{ externalId: "1", event: "deleted" }] });
    const viaJira = parseInboundWebhook(
      "jira",
      input({ query: { token: SECRET }, rawBody: JSON.stringify({ timestamp: NOW, webhookEvent: "worklog_updated" }) }),
    );
    expect(viaJira.kind).toBe("ignored");
  });
});
