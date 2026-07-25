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
  type InboundWebhookInput,
} from "./index.js";

const SECRET = "rglwh_test_secret_0123456789abcdef";

const sig = (secret: string, body: string) =>
  createHmac("sha256", secret).update(body).digest("hex");

const input = (over: Partial<InboundWebhookInput> & { rawBody?: string }): InboundWebhookInput => ({
  headers: {},
  query: {},
  rawBody: "{}",
  secret: SECRET,
  connectionProject: "PROJ",
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
    webhookEvent: "jira:issue_updated",
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
        rawBody: JSON.stringify({ webhookEvent: "jira:issue_deleted", issue: { id: "10042" } }),
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
          webhookEvent: "comment_created",
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
      input({ query: { token: SECRET }, rawBody: JSON.stringify({ webhookEvent: "sprint_started" }) }),
    );
    expect(ignored).toEqual({ kind: "ignored", reason: "jira event 'sprint_started' is not consumed" });
  });
});

describe("linear inbound (linear-signature = hex HMAC-SHA256 of the raw body)", () => {
  const issueBody = JSON.stringify({
    action: "update",
    type: "Issue",
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
    const removeBody = JSON.stringify({ action: "remove", type: "Issue", data: { id: "lin-uuid-1" } });
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
      data: { id: "cmt-1", body: "nice", issueId: "lin-uuid-1" },
    });
    const commented = parseLinearInboundWebhook(
      input({ headers: { "linear-signature": sig(SECRET, commentBody) }, rawBody: commentBody }),
    );
    expect(commented).toEqual({
      kind: "events",
      events: [{ externalId: "lin-uuid-1", event: "commented", fields: { comment: "nice" } }],
    });
    const projBody = JSON.stringify({ action: "update", type: "Project", data: { id: "p1" } });
    expect(
      parseLinearInboundWebhook(
        input({ headers: { "linear-signature": sig(SECRET, projBody) }, rawBody: projBody }),
      ),
    ).toEqual({ kind: "ignored", reason: "linear Project events are not consumed" });
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
        { action: "changed", resource: { gid: 555, resource_type: "task" } },
        { action: "deleted", resource: { gid: "556", resource_type: "task" } },
        {
          action: "added",
          resource: { gid: "st-1", resource_type: "story" },
          parent: { gid: "555", resource_type: "task" },
        },
        { action: "removed", resource: { gid: "557", resource_type: "task" } }, // not consumed
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
    const body = JSON.stringify({ events: [{ action: "changed", resource: { gid: "1", resource_type: "project" } }] });
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
        rawBody: JSON.stringify({ event: { type: "create_pulse", pulseId: 9, pulseName: "New item" } }),
      }),
    );
    expect(created).toEqual({
      kind: "events",
      events: [{ externalId: "9", event: "updated", fields: { name: "New item" } }],
    });
    const deleted = parseMondayInboundWebhook(
      input({
        query: { token: SECRET },
        rawBody: JSON.stringify({ event: { type: "item_deleted", itemId: 9 } }),
      }),
    );
    expect(deleted).toEqual({ kind: "events", events: [{ externalId: "9", event: "deleted" }] });
    const commented = parseMondayInboundWebhook(
      input({
        query: { token: SECRET },
        rawBody: JSON.stringify({ event: { type: "create_update", pulseId: 9, textBody: "hello" } }),
      }),
    );
    expect(commented).toEqual({
      kind: "events",
      events: [{ externalId: "9", event: "commented", fields: { comment: "hello" } }],
    });
    const ignored = parseMondayInboundWebhook(
      input({
        query: { token: SECRET },
        rawBody: JSON.stringify({ event: { type: "create_column", boardId: 777, pulseId: 1 } }),
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
      eventType: "workitem.updated",
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
          eventType: "workitem.created",
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
        rawBody: JSON.stringify({ eventType: "workitem.deleted", resource: { id: 42 } }),
      }),
    );
    expect(deleted).toEqual({ kind: "events", events: [{ externalId: "42", event: "deleted" }] });
    const ignored = parseAzureDevOpsInboundWebhook(
      input({
        headers: { authorization: basic("svc", SECRET) },
        rawBody: JSON.stringify({ eventType: "build.complete" }),
      }),
    );
    expect(ignored).toEqual({ kind: "ignored", reason: "azure_devops event 'build.complete' is not consumed" });
  });

  it("missing or wrong basic-auth password throws — fail-closed", () => {
    const body = JSON.stringify({ eventType: "workitem.deleted", resource: { id: 1 } });
    expect(() => parseAzureDevOpsInboundWebhook(input({ rawBody: body }))).toThrow(PmProviderError);
    expect(() =>
      parseAzureDevOpsInboundWebhook(
        input({ headers: { authorization: basic("svc", "wrong") }, rawBody: body }),
      ),
    ).toThrow(PmProviderError);
  });
});

describe("generic_webhook/mock inbound (signed normalized envelope; legacy header still accepted)", () => {
  const body = JSON.stringify({ externalId: "7", event: "updated", state: "in_review" });

  it("verifies x-regulait-signature (sha256=<hex HMAC>) over the raw body — outbound symmetry", () => {
    const res = parseGenericInboundWebhook(
      input({ headers: { "x-regulait-signature": `sha256=${sig(SECRET, body)}` }, rawBody: body }),
    );
    expect(res).toEqual({
      kind: "events",
      events: [{ externalId: "7", event: "updated", state: "in_review" }],
    });
  });

  it("keeps accepting the legacy x-regulait-webhook-secret header; neither mechanism → throws", () => {
    const res = parseGenericInboundWebhook(
      input({ headers: { "x-regulait-webhook-secret": SECRET }, rawBody: body }),
    );
    expect(res.kind).toBe("events");
    expect(() => parseGenericInboundWebhook(input({ rawBody: body }))).toThrow(PmProviderError);
    expect(() =>
      parseGenericInboundWebhook(
        input({ headers: { "x-regulait-webhook-secret": "wrong" }, rawBody: body }),
      ),
    ).toThrow(PmProviderError);
  });

  it("a presented signature takes precedence: a BAD signature is rejected even with a valid legacy header", () => {
    expect(() =>
      parseGenericInboundWebhook(
        input({
          headers: {
            "x-regulait-signature": `sha256=${sig("wrong-key", body)}`,
            "x-regulait-webhook-secret": SECRET,
          },
          rawBody: body,
        }),
      ),
    ).toThrow(/x-regulait-signature/);
  });
});

describe("parseInboundWebhook registry", () => {
  it("dispatches by provider kind — mock shares the generic parser (the tests' e2e vehicle)", () => {
    const body = JSON.stringify({ externalId: "1", event: "deleted" });
    const viaMock = parseInboundWebhook(
      "mock",
      input({ headers: { "x-regulait-webhook-secret": SECRET }, rawBody: body }),
    );
    expect(viaMock).toEqual({ kind: "events", events: [{ externalId: "1", event: "deleted" }] });
    const viaJira = parseInboundWebhook(
      "jira",
      input({ query: { token: SECRET }, rawBody: JSON.stringify({ webhookEvent: "worklog_updated" }) }),
    );
    expect(viaJira.kind).toBe("ignored");
  });
});
