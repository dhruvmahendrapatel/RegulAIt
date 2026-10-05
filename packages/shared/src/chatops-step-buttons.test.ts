/**
 * ADR-0173 batch 2b — the pure half of the Slack "Ask first" buttons and the
 * Teams Bot Framework endpoint: what a click and an activity parse to, and
 * that the composed Block Kit is inert and carries only the opaque prompt id.
 */
import { describe, expect, it } from "vitest";
import {
  SLACK_STEP_ACTION_IDS,
  composeStepAnsweredBlocks,
  composeStepConfirmBlocks,
  parseSlackInteraction,
  parseSlackStepInteraction,
  parseTeamsBotActivity,
} from "./chatops.js";

const PROMPT = "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b";
const click = (over: Record<string, unknown> = {}, action: Record<string, unknown> = {}) =>
  new URLSearchParams({
    payload: JSON.stringify({
      type: "block_actions",
      user: { id: "U-ME" },
      container: { message_ts: "1785.1" },
      channel: { id: "C-1" },
      message: { blocks: [{ type: "section", text: { type: "mrkdwn", text: "Let me check &lt;x&gt;" } }, { type: "actions", elements: [] }] },
      actions: [{ action_id: SLACK_STEP_ACTION_IDS.approve, value: PROMPT, ...action }],
      ...over,
    }),
  }).toString();

describe("parseSlackStepInteraction", () => {
  it("reads a step click: who, which prompt, which answer, where — and NOTHING of the message's own content", () => {
    // the clicked message's blocks are never read: the answered message is
    // rebuilt from stored data (ADR-0173 batch 2b review)
    expect(parseSlackStepInteraction(click())).toEqual({
      chatUserId: "U-ME",
      promptId: PROMPT,
      answer: "approve",
      messageRef: "1785.1",
      channel: "C-1",
    });
    expect(parseSlackStepInteraction(click({}, { action_id: SLACK_STEP_ACTION_IDS.deny }))?.answer).toBe("deny");
  });

  it("refuses anything it cannot read as exactly one step click", () => {
    expect(parseSlackStepInteraction(click({}, { action_id: "regulait_approve" }))).toBeNull(); // an approval card
    expect(parseSlackStepInteraction(click({}, { value: "not-a-uuid" }))).toBeNull();
    expect(parseSlackStepInteraction(click({ type: "view_submission" }))).toBeNull();
    expect(parseSlackStepInteraction(click({ user: {} }))).toBeNull();
    expect(
      parseSlackStepInteraction(click({ actions: [{ action_id: SLACK_STEP_ACTION_IDS.approve, value: PROMPT }, { action_id: SLACK_STEP_ACTION_IDS.deny, value: PROMPT }] })),
    ).toBeNull();
    expect(parseSlackStepInteraction("payload=%7Bnot-json")).toBeNull();
    expect(parseSlackStepInteraction("")).toBeNull();
  });

  it("the approval parser never mistakes a step click for an approval decision", () => {
    expect(parseSlackInteraction(click())).toBeNull();
  });
});

describe("composeStepConfirmBlocks / composeStepAnsweredBlocks", () => {
  it("the reply and the tool label are inert; the buttons carry only the prompt id", () => {
    const blocks = composeStepConfirmBlocks({ text: "<!channel> see <https://evil|safe>", toolLabel: "send\n<@U999>", promptId: PROMPT });
    // mrkdwn (the parsed format) carries the reply escaped …
    const sections = JSON.stringify(blocks.filter((b) => b.type === "section"));
    expect(sections).not.toMatch(/<!channel>|<https:/);
    expect(sections).toContain("&lt;!channel&gt;");
    // … and the tool label goes in plain_text, which Slack never parses for links or mentions
    const context = blocks.find((b) => b.type === "context") as { elements: Array<{ type: string; text: string }> };
    expect(context.elements[0]).toMatchObject({ type: "plain_text" });
    expect(blocks.filter((b) => b.type !== "context").some((b) => JSON.stringify(b).includes("<@U999>"))).toBe(false);
    expect(context.elements[0]!.text).not.toContain("\n");
    const actions = blocks.find((b) => b.type === "actions") as { elements: Array<Record<string, unknown>> };
    expect(actions.elements.map((e) => [e.action_id, e.value])).toEqual([
      [SLACK_STEP_ACTION_IDS.approve, PROMPT],
      [SLACK_STEP_ACTION_IDS.deny, PROMPT],
    ]);
  });

  it("splits a long reply under Slack's per-section cap", () => {
    const blocks = composeStepConfirmBlocks({ text: "x".repeat(6_000), toolLabel: "t", promptId: PROMPT });
    const sections = blocks.filter((b) => b.type === "section") as Array<{ text: { text: string } }>;
    expect(sections.length).toBe(3);
    for (const s of sections) expect(s.text.text.length).toBeLessThanOrEqual(3_000);
  });

  it("an answered message is rebuilt from the stored reply, made inert once, with no buttons", () => {
    const blocks = composeStepAnsweredBlocks({ text: "Let me check <x> <!channel>", outcome: "Approved by Ann." });
    expect(blocks.some((b) => b.type === "actions")).toBe(false);
    expect(JSON.stringify(blocks)).toContain("Let me check &lt;x&gt; &lt;!channel&gt;");
    expect(JSON.stringify(blocks)).not.toContain("<!channel>");
    expect(JSON.stringify(blocks)).not.toContain("&amp;lt;");
  });
});

describe("parseTeamsBotActivity", () => {
  const activity = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      type: "message",
      id: "act-1",
      timestamp: "2026-10-05T00:00:00Z",
      channelId: "msteams",
      serviceUrl: "https://service.example/teams/",
      text: "<at>Bot</at> hello",
      from: { id: "29:x", aadObjectId: "aad-1" },
      conversation: { id: "a:1", tenantId: "conv-tenant" },
      channelData: { tenant: { id: "tenant-1" } },
      ...over,
    });

  it("a message: the inbound message plus what the token is bound to", () => {
    const p = parseTeamsBotActivity(activity());
    expect(p).toMatchObject({ kind: "message", serviceUrl: "https://service.example/teams/", tenantId: "tenant-1", channelId: "msteams" });
    if (p?.kind !== "message") throw new Error("expected a message");
    expect(p.message).toMatchObject({ provider: "teams", chatUserId: "aad-1", text: "hello", eventId: "act-1" });
    expect(parseTeamsBotActivity(activity({ channelData: {} }))?.tenantId).toBe("conv-tenant");
  });

  it("other activity types are acknowledged and ignored; garbage is unreadable", () => {
    expect(parseTeamsBotActivity(activity({ type: "conversationUpdate" }))).toMatchObject({ kind: "ignored", reason: "activity_conversationUpdate" });
    expect(parseTeamsBotActivity(activity({ text: "<at>Bot</at>" }))).toMatchObject({ kind: "ignored", reason: "unreadable_message" });
    expect(parseTeamsBotActivity("[]")).toBeNull();
    expect(parseTeamsBotActivity("{")).toBeNull();
    expect(parseTeamsBotActivity(JSON.stringify({ id: "x" }))).toBeNull();
  });
});
