/**
 * ADR-0173 §2 — the pure half of inbound conversations: the Slack Events and
 * Teams outgoing-webhook parsers and the Teams replay guard. Every "ignored"
 * and every null below is a message that must NOT start a turn; each has a
 * readable control beside it so a parser that ignored everything would fail.
 */
import { describe, expect, it } from "vitest";
import {
  CHANNEL_MESSAGE_MAX_CHARS,
  parseSlackEvent,
  parseTeamsMessage,
  stripSlackMentions,
  teamsActivityFreshness,
  teamsPlainText,
} from "./chatops.js";

const NOW = 1_785_000_000;

const slackEvent = (event: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: "event_callback", team_id: "T1", event_id: "Ev01", event: event, ...extra });

describe("parseSlackEvent", () => {
  it("answers the URL-verification handshake with its challenge", () => {
    expect(parseSlackEvent(JSON.stringify({ type: "url_verification", challenge: "abc123", token: "x" }))).toEqual({
      kind: "url_verification",
      challenge: "abc123",
    });
    expect(parseSlackEvent(JSON.stringify({ type: "url_verification" }))).toBeNull();
  });

  it("reads an app mention: mention stripped, threaded under the message, addressed", () => {
    const r = parseSlackEvent(slackEvent({ type: "app_mention", user: "U1", channel: "C1", ts: "1.5", text: "<@UBOT> summarise the policy" }));
    expect(r).toEqual({
      kind: "message",
      message: {
        provider: "slack",
        eventId: "Ev01",
        messageKey: "C1:1.5",
        chatUserId: "U1",
        channelId: "C1",
        threadId: "1.5",
        replyThreadRef: "1.5",
        replyTarget: "C1",
        text: "summarise the policy",
        addressed: true,
      },
    });
  });

  it("a plain channel message is not addressed; a reply in a thread stays in that thread", () => {
    const r = parseSlackEvent(slackEvent({ type: "message", user: "U1", channel: "C1", ts: "2.0", thread_ts: "1.5", text: "and?" }));
    expect(r?.kind).toBe("message");
    if (r?.kind !== "message") return;
    expect(r.message).toMatchObject({ threadId: "1.5", replyThreadRef: "1.5", addressed: false, messageKey: "C1:2.0" });
  });

  it("a direct message is addressed and is one continuing conversation, replied to unthreaded", () => {
    const r = parseSlackEvent(slackEvent({ type: "message", channel_type: "im", user: "U1", channel: "D1", ts: "3.0", text: "hi" }));
    if (r?.kind !== "message") throw new Error("expected a message");
    expect(r.message).toMatchObject({ addressed: true, threadId: "im", replyThreadRef: null });
  });

  it("ignores bot messages (our own replies would loop), edits and every other subtype", () => {
    const base = { type: "message", user: "U1", channel: "C1", ts: "4.0", text: "x" };
    expect(parseSlackEvent(slackEvent({ ...base, bot_id: "B1" }))).toEqual({ kind: "ignored", eventId: "Ev01", reason: "bot_message" });
    expect(parseSlackEvent(slackEvent({ ...base, subtype: "bot_message" }))).toMatchObject({ kind: "ignored", reason: "bot_message" });
    expect(parseSlackEvent(slackEvent({ ...base, subtype: "message_changed" }))).toMatchObject({ kind: "ignored", reason: "edit" });
    expect(parseSlackEvent(slackEvent({ ...base, edited: { user: "U1", ts: "4.1" } }))).toMatchObject({ kind: "ignored", reason: "edit" });
    expect(parseSlackEvent(slackEvent({ ...base, subtype: "channel_join" }))).toMatchObject({ kind: "ignored", reason: "subtype_channel_join" });
    expect(parseSlackEvent(slackEvent({ type: "reaction_added", user: "U1" }))).toMatchObject({ kind: "ignored", reason: "unsupported_event" });
    expect(parseSlackEvent(slackEvent({ ...base, text: "<@UBOT>" }))).toMatchObject({ kind: "ignored", reason: "empty_message" });
    // control: the same base with none of those is a message
    expect(parseSlackEvent(slackEvent(base))?.kind).toBe("message");
  });

  it("refuses what it cannot read", () => {
    expect(parseSlackEvent("not json")).toBeNull();
    expect(parseSlackEvent(JSON.stringify({ type: "event_callback", event: { type: "message" } }))).toBeNull(); // no event_id
    expect(parseSlackEvent(slackEvent({ type: "message", channel: "C1", ts: "1", text: "no user" }))).toBeNull();
    expect(parseSlackEvent(JSON.stringify({ type: "block_actions" }))).toBeNull();
  });

  it("caps the text a message can carry into a turn", () => {
    const r = parseSlackEvent(slackEvent({ type: "app_mention", user: "U1", channel: "C1", ts: "1", text: "y".repeat(20_000) }));
    if (r?.kind !== "message") throw new Error("expected a message");
    expect(r.message.text).toHaveLength(CHANNEL_MESSAGE_MAX_CHARS);
  });

  it("stripSlackMentions drops user mentions with or without a label", () => {
    expect(stripSlackMentions("<@U1|bot>  hello <@U2> there")).toBe("hello there");
  });
});

describe("parseTeamsMessage", () => {
  const activity = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      type: "message",
      id: "1501",
      timestamp: "2026-10-04T10:00:00.000Z",
      text: "<at>RegulAIt</at>&nbsp;summarise <b>this</b> &amp; that",
      from: { id: "29:abc", aadObjectId: "aad-1", name: "Dana" },
      conversation: { id: "19:chan@thread.tacv2;messageid=1500" },
      ...over,
    });

  it("reads the message: HTML and the mention stripped, channel split from the thread, reply under the activity", () => {
    expect(parseTeamsMessage(activity())).toEqual({
      timestamp: "2026-10-04T10:00:00.000Z",
      message: {
        provider: "teams",
        eventId: "1501",
        messageKey: "19:chan@thread.tacv2;messageid=1500:1501",
        chatUserId: "aad-1",
        channelId: "19:chan@thread.tacv2",
        threadId: "19:chan@thread.tacv2;messageid=1500",
        replyThreadRef: "1501",
        replyTarget: "19:chan@thread.tacv2;messageid=1500",
        text: "summarise this & that",
        addressed: true,
      },
    });
  });

  it("falls back to from.id exactly as the interaction parser does", () => {
    expect(parseTeamsMessage(activity({ from: { id: "29:abc" } }))?.message.chatUserId).toBe("29:abc");
  });

  it("refuses a non-message, a missing id/sender/conversation, and an empty text", () => {
    expect(parseTeamsMessage(activity({ type: "invoke" }))).toBeNull();
    expect(parseTeamsMessage(activity({ id: undefined }))).toBeNull();
    expect(parseTeamsMessage(activity({ from: {} }))).toBeNull();
    expect(parseTeamsMessage(activity({ conversation: {} }))).toBeNull();
    expect(parseTeamsMessage(activity({ text: "<at>RegulAIt</at>" }))).toBeNull();
    expect(parseTeamsMessage("{")).toBeNull();
  });

  it("teamsPlainText keeps line breaks and decodes entities", () => {
    expect(teamsPlainText("a<br/>b&lt;c&gt; &quot;d&quot;")).toBe('a\nb<c> "d"');
  });
});

describe("teamsActivityFreshness — the replay guard over the SIGNED body timestamp", () => {
  const iso = (secondsAgo: number) => new Date((NOW - secondsAgo) * 1000).toISOString();
  it("accepts inside the window and refuses outside it, in both directions", () => {
    expect(teamsActivityFreshness(iso(0), NOW)).toEqual({ ok: true });
    expect(teamsActivityFreshness(iso(299), NOW)).toEqual({ ok: true });
    expect(teamsActivityFreshness(iso(301), NOW)).toMatchObject({ ok: false, code: "stale_timestamp" });
    expect(teamsActivityFreshness(iso(-301), NOW)).toMatchObject({ ok: false, code: "future_timestamp" });
  });
  it("refuses a missing or unreadable timestamp rather than waving it through", () => {
    expect(teamsActivityFreshness(null, NOW)).toMatchObject({ ok: false, code: "missing_timestamp" });
    expect(teamsActivityFreshness("yesterday-ish", NOW)).toMatchObject({ ok: false, code: "malformed_timestamp" });
  });
});
