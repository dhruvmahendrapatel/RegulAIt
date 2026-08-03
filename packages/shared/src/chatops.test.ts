/**
 * ADR-0061 — the first wall, proved by attack.
 *
 * Every refusal below is a case an attacker actually gets to try: no signature
 * at all, a signature over a DIFFERENT body, a signature made with the WRONG
 * secret, a truncated signature, and a perfectly valid signature REPLAYED after
 * the window. A verifier that returned `true` unconditionally fails all of
 * them; one that only checked "a signature header exists" fails four.
 */
import { describe, expect, it } from "vitest";
import {
  CHATOPS_REPLAY_WINDOW_SECONDS,
  chatContentFenced,
  chatDecidable,
  composeApprovalCard,
  composeDecidedCard,
  parseChatInteraction,
  parseSlackInteraction,
  parseTeamsInteraction,
  slackSignature,
  teamsSignature,
  verifyChatSignature,
} from "./chatops.js";

const SECRET = "s3cr3t-signing-key";
const APPROVAL = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
const NOW = 1_785_000_000;

const slackBody = (approvalId = APPROVAL, action = "regulait_approve") =>
  new URLSearchParams({
    payload: JSON.stringify({
      type: "block_actions",
      user: { id: "U123SLACK" },
      channel: { id: "C0DEPLOYS" },
      container: { message_ts: "1785000000.000100" },
      actions: [{ action_id: action, value: approvalId }],
    }),
  }).toString();

const slackHeaders = (body: string, ts = String(NOW), secret = SECRET) => ({
  "x-slack-request-timestamp": ts,
  "x-slack-signature": slackSignature(secret, ts, body),
});

describe("slack signature verification is the first wall", () => {
  it("accepts a correctly signed, in-window callback", () => {
    const body = slackBody();
    const r = verifyChatSignature({ provider: "slack", rawBody: body, headers: slackHeaders(body), signingSecret: SECRET, nowSeconds: NOW });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.replayWindowEnforced).toBe(true);
  });

  it("REFUSES an unsigned callback", () => {
    const body = slackBody();
    const r = verifyChatSignature({
      provider: "slack",
      rawBody: body,
      headers: { "x-slack-request-timestamp": String(NOW) },
      signingSecret: SECRET,
      nowSeconds: NOW,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("missing_signature");
  });

  it("REFUSES a callback with no timestamp — there would be nothing to bound a replay against", () => {
    const body = slackBody();
    const r = verifyChatSignature({
      provider: "slack",
      rawBody: body,
      headers: { "x-slack-signature": slackSignature(SECRET, String(NOW), body) },
      signingSecret: SECRET,
      nowSeconds: NOW,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("missing_timestamp");
  });

  it("REFUSES a signature made with the wrong secret", () => {
    const body = slackBody();
    const r = verifyChatSignature({
      provider: "slack",
      rawBody: body,
      headers: slackHeaders(body, String(NOW), "not-the-signing-secret"),
      signingSecret: SECRET,
      nowSeconds: NOW,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("bad_signature");
  });

  it("REFUSES a signature over a DIFFERENT body — the payload cannot be swapped after signing", () => {
    const signed = slackBody();
    const tampered = slackBody("00000000-0000-0000-0000-000000000001");
    const r = verifyChatSignature({
      provider: "slack",
      rawBody: tampered,
      headers: slackHeaders(signed),
      signingSecret: SECRET,
      nowSeconds: NOW,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("bad_signature");
  });

  it("REFUSES a truncated signature without throwing on the length mismatch", () => {
    const body = slackBody();
    const good = slackSignature(SECRET, String(NOW), body);
    const r = verifyChatSignature({
      provider: "slack",
      rawBody: body,
      headers: { "x-slack-request-timestamp": String(NOW), "x-slack-signature": good.slice(0, 20) },
      signingSecret: SECRET,
      nowSeconds: NOW,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("bad_signature");
  });

  it("REFUSES a REPLAY: a perfectly valid callback captured and re-sent later", () => {
    const body = slackBody();
    const headers = slackHeaders(body);
    // valid now …
    expect(verifyChatSignature({ provider: "slack", rawBody: body, headers, signingSecret: SECRET, nowSeconds: NOW }).ok).toBe(true);
    // … and refused one second past the window
    const r = verifyChatSignature({
      provider: "slack",
      rawBody: body,
      headers,
      signingSecret: SECRET,
      nowSeconds: NOW + CHATOPS_REPLAY_WINDOW_SECONDS + 1,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("stale_timestamp");
  });

  it("REFUSES a timestamp from the future", () => {
    const body = slackBody();
    const ts = String(NOW + CHATOPS_REPLAY_WINDOW_SECONDS + 60);
    const r = verifyChatSignature({
      provider: "slack",
      rawBody: body,
      headers: slackHeaders(body, ts),
      signingSecret: SECRET,
      nowSeconds: NOW,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("future_timestamp");
  });

  it("REFUSES a non-numeric timestamp", () => {
    const body = slackBody();
    const r = verifyChatSignature({
      provider: "slack",
      rawBody: body,
      headers: { "x-slack-request-timestamp": "not-a-time", "x-slack-signature": "v0=deadbeef" },
      signingSecret: SECRET,
      nowSeconds: NOW,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("malformed_timestamp");
  });
});

describe("teams verification is honest about what it cannot enforce", () => {
  const b64 = Buffer.from("teams-shared-secret").toString("base64");
  const body = JSON.stringify({ from: { aadObjectId: "AAD-1" }, value: { approvalId: APPROVAL, action: "approve" } });

  it("accepts a correct HMAC but reports that NO replay window is enforced", () => {
    const r = verifyChatSignature({
      provider: "teams",
      rawBody: body,
      headers: { authorization: teamsSignature(b64, body) },
      signingSecret: b64,
      nowSeconds: NOW,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.replayWindowEnforced).toBe(false);
  });

  it("refuses an unsigned and a wrongly-signed Teams callback", () => {
    expect(verifyChatSignature({ provider: "teams", rawBody: body, headers: {}, signingSecret: b64 }).ok).toBe(false);
    const wrong = teamsSignature(Buffer.from("other").toString("base64"), body);
    const r = verifyChatSignature({ provider: "teams", rawBody: body, headers: { authorization: wrong }, signingSecret: b64 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("bad_signature");
  });
});

describe("the interaction payload is an assertion, parsed strictly", () => {
  it("reads the slack user id, the opaque approval id and the action", () => {
    const parsed = parseSlackInteraction(slackBody());
    expect(parsed).toEqual({
      chatUserId: "U123SLACK",
      approvalId: APPROVAL,
      action: "approve",
      messageRef: "1785000000.000100",
      channel: "C0DEPLOYS",
    });
  });

  it("returns null — never a guess — for anything malformed", () => {
    expect(parseSlackInteraction("")).toBeNull();
    expect(parseSlackInteraction("payload=not-json")).toBeNull();
    expect(parseSlackInteraction(slackBody("not-a-uuid"))).toBeNull();
    expect(parseSlackInteraction(slackBody(APPROVAL, "some_other_button"))).toBeNull();
    expect(parseTeamsInteraction("{}")).toBeNull();
    expect(parseTeamsInteraction(JSON.stringify({ from: { id: "x" }, value: { approvalId: APPROVAL, action: "delete" } }))).toBeNull();
  });

  it("dispatches on provider", () => {
    expect(parseChatInteraction("slack", slackBody())?.action).toBe("approve");
    expect(
      parseChatInteraction("teams", JSON.stringify({ from: { id: "T1" }, value: { approvalId: APPROVAL, action: "reject" } }))?.action,
    ).toBe("reject");
  });
});

describe("the sensitivity fence keeps content out of chat", () => {
  const sensitive = {
    approvalId: APPROVAL,
    objectType: "mcp_tool",
    toolName: "patients.read",
    stageId: "prod-signoff",
    requesterLabel: "dana@example.com",
    approverLabel: "sam@example.com",
    portalUrl: "https://regulait.example/admin/approvals",
  };

  it("a fenced card carries a LINK and NOT the payload", () => {
    const card = composeApprovalCard({ ...sensitive, fenced: true, decidable: false });
    const serialized = JSON.stringify(card);
    expect(card.redacted).toBe(true);
    expect(serialized).not.toContain("patients.read");
    expect(serialized).not.toContain("prod-signoff");
    expect(serialized).not.toContain("dana@example.com");
    expect(serialized).toContain(sensitive.portalUrl);
    expect(serialized).toContain(APPROVAL);
  });

  it("an unfenced card may name the gated action, and carries buttons whose value is ONLY the approval id", () => {
    const card = composeApprovalCard({ ...sensitive, fenced: false, decidable: true });
    const serialized = JSON.stringify(card);
    expect(card.redacted).toBe(false);
    expect(serialized).toContain("patients.read");
    const actions = card.blocks.find((b) => b.type === "actions") as { elements: Array<Record<string, unknown>> };
    expect(actions.elements.every((e) => e.value === APPROVAL)).toBe(true);
    // nothing in a button may resemble authority
    expect(JSON.stringify(actions)).not.toContain("sam@example.com");
  });

  it("a non-decidable card retires the buttons and says why", () => {
    const card = composeApprovalCard({ ...sensitive, fenced: true, decidable: false });
    expect(card.blocks.some((b) => b.type === "actions")).toBe(false);
    expect(JSON.stringify(card)).toMatch(/not a re-authenticated session/);
  });

  it("fenced approvals default to in-app-only and are opt-in per connection", () => {
    expect(chatContentFenced("block")).toBe(true);
    expect(chatContentFenced("redact")).toBe(false);
    expect(chatContentFenced(null)).toBe(false);
    expect(chatDecidable({ fenced: true, allowFencedDecide: false })).toBe(false);
    expect(chatDecidable({ fenced: true, allowFencedDecide: true })).toBe(true);
    expect(chatDecidable({ fenced: false, allowFencedDecide: false })).toBe(true);
  });

  it("the decided card names the human, not the bot", () => {
    const card = composeDecidedCard({ approvalId: APPROVAL, decision: "approved", deciderLabel: "Dana", portalUrl: "https://x/y" });
    expect(card.text).toMatch(/approved\* by Dana/);
    expect(card.blocks.some((b) => b.type === "actions")).toBe(false);
  });
});
