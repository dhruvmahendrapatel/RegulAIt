/**
 * ADR-0061 — CHATOPS APPROVALS, the pure half.
 *
 * THE ONE SENTENCE THIS MODULE EXISTS TO ENFORCE
 * ---------------------------------------------
 * **The button click carries no authority.** Everything here either (a) proves
 * the request really came from the chat provider, or (b) extracts an
 * *assertion* — a chat user id and an approval id — for the gateway to verify
 * and re-check server-side. Nothing in this file decides anything, and nothing
 * in this file trusts a field in the payload as authorization. The bot is a
 * courier.
 *
 * WHY THE VERIFICATION LIVES HERE AND NOT IN THE ROUTE
 * ---------------------------------------------------
 * Signature verification and the replay window are the FIRST wall (ADR-0061
 * §"Abuse-resistance"): a flood of forged interaction payloads must be cheap to
 * reject, before mapping, before entitlement, before any transaction. Keeping
 * them pure means the adversarial suite runs them with no database, no clock
 * and no network — the hostile cases (missing signature, wrong signature,
 * truncated signature, stale timestamp, future timestamp, tampered body) are
 * exercised directly rather than through an HTTP fixture that could accidentally
 * be testing Fastify.
 *
 * WHAT IS DELIBERATELY NOT SYMMETRIC BETWEEN THE TWO PROVIDERS
 * -----------------------------------------------------------
 * Slack signs `v0:<timestamp>:<raw body>` and sends the timestamp in its own
 * header, so a replay window is enforceable and IS enforced. Microsoft Teams'
 * outgoing-webhook HMAC covers the body ONLY — there is no signed timestamp, so
 * there is nothing to bound a replay against. We do not pretend otherwise: the
 * Teams path reports `replayWindowEnforced: false`, and its replay defence is
 * the interaction-idempotency record plus the approval status machine
 * (`pending → decided` is a guarded transition). Saying "verified" for both and
 * quietly meaning different things would be the dishonest option.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const CHATOPS_PROVIDERS = ["slack", "teams"] as const;
export type ChatOpsProvider = (typeof CHATOPS_PROVIDERS)[number];

/** Slack's own recommendation, and the value we enforce. */
export const CHATOPS_REPLAY_WINDOW_SECONDS = 300;

/** an interaction body larger than this is refused before it is parsed */
export const CHATOPS_MAX_BODY_BYTES = 200_000;

export const SLACK_TIMESTAMP_HEADER = "x-slack-request-timestamp";
export const SLACK_SIGNATURE_HEADER = "x-slack-signature";
export const TEAMS_AUTHORIZATION_HEADER = "authorization";

export type ChatSignatureFailure =
  | "missing_signature"
  | "missing_timestamp"
  | "malformed_timestamp"
  | "stale_timestamp"
  | "future_timestamp"
  | "bad_signature"
  | "body_too_large"
  | "unsupported_provider";

export interface ChatSignatureOk {
  ok: true;
  provider: ChatOpsProvider;
  /** false for Teams, and we say so rather than implying a guarantee */
  replayWindowEnforced: boolean;
}
export interface ChatSignatureRefused {
  ok: false;
  code: ChatSignatureFailure;
  detail: string;
}
export type ChatSignatureResult = ChatSignatureOk | ChatSignatureRefused;

const refuse = (code: ChatSignatureFailure, detail: string): ChatSignatureRefused => ({ ok: false, code, detail });

/** constant-time compare that cannot throw on a length mismatch */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** exactly Slack's documented base string. Exported so a test can build a
 * VALID signature the same way Slack does, rather than asserting against a
 * hard-coded blob that would not notice a base-string change. */
export function slackSignatureBaseString(timestamp: string, rawBody: string): string {
  return `v0:${timestamp}:${rawBody}`;
}

export function slackSignature(signingSecret: string, timestamp: string, rawBody: string): string {
  return `v0=${createHmac("sha256", signingSecret).update(slackSignatureBaseString(timestamp, rawBody)).digest("hex")}`;
}

export function teamsSignature(signingSecretBase64: string, rawBody: string): string {
  const key = Buffer.from(signingSecretBase64, "base64");
  return `HMAC ${createHmac("sha256", key).update(rawBody, "utf8").digest("base64")}`;
}

export interface ChatSignatureInput {
  provider: ChatOpsProvider;
  /** the EXACT bytes as received — a re-serialized body is a different body */
  rawBody: string;
  headers: Record<string, string | undefined>;
  signingSecret: string;
  /** seconds since the epoch; injectable so the replay tests own the clock */
  nowSeconds?: number;
  replayWindowSeconds?: number;
}

/**
 * THE FIRST WALL. Proves the request came from the chat provider. It says
 * NOTHING about who clicked — that is the mapping + entitlement step, and it
 * runs server-side afterwards, in the gateway.
 */
export function verifyChatSignature(input: ChatSignatureInput): ChatSignatureResult {
  if (Buffer.byteLength(input.rawBody, "utf8") > CHATOPS_MAX_BODY_BYTES) {
    return refuse("body_too_large", "interaction payload exceeds the accepted bound");
  }
  const window = input.replayWindowSeconds ?? CHATOPS_REPLAY_WINDOW_SECONDS;
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);

  if (input.provider === "slack") {
    const presented = input.headers[SLACK_SIGNATURE_HEADER];
    const ts = input.headers[SLACK_TIMESTAMP_HEADER];
    // ORDER MATTERS: a missing signature is refused before the timestamp is
    // even looked at, so an unsigned request costs one map lookup.
    if (!presented) return refuse("missing_signature", `no ${SLACK_SIGNATURE_HEADER} header — an unsigned callback is not a callback`);
    if (!ts) return refuse("missing_timestamp", `no ${SLACK_TIMESTAMP_HEADER} header — without it there is nothing to bound a replay against`);
    if (!/^\d{1,12}$/.test(ts)) return refuse("malformed_timestamp", "request timestamp is not an integer number of seconds");
    const age = now - Number(ts);
    if (age > window) {
      return refuse(
        "stale_timestamp",
        `request timestamp is ${age}s old, outside the ${window}s replay window — a captured callback cannot be re-played later`,
      );
    }
    if (age < -window) {
      return refuse("future_timestamp", `request timestamp is ${-age}s in the future, outside the ${window}s window`);
    }
    const expected = slackSignature(input.signingSecret, ts, input.rawBody);
    if (!safeEqual(expected, presented)) {
      return refuse("bad_signature", "signature does not match the signing secret over (timestamp, body)");
    }
    return { ok: true, provider: "slack", replayWindowEnforced: true };
  }

  if (input.provider === "teams") {
    const presented = input.headers[TEAMS_AUTHORIZATION_HEADER];
    if (!presented) return refuse("missing_signature", "no Authorization HMAC header — an unsigned callback is not a callback");
    const expected = teamsSignature(input.signingSecret, input.rawBody);
    if (!safeEqual(expected, presented)) {
      return refuse("bad_signature", "HMAC does not match the signing secret over the body");
    }
    // STATED PLAINLY: the Teams outgoing-webhook HMAC covers the body only.
    // There is no signed timestamp, so there is no replay window to enforce.
    // Replay defence on this path is the interaction-idempotency record plus
    // the approval status machine, both of which are server-side.
    return { ok: true, provider: "teams", replayWindowEnforced: false };
  }

  return refuse("unsupported_provider", `unknown chat provider '${String(input.provider)}'`);
}

// ---------------------------------------------------------------------------
// The interaction payload — an ASSERTION to be verified, never authorization
// ---------------------------------------------------------------------------

export const CHATOPS_ACTIONS = ["approve", "reject"] as const;
export type ChatOpsAction = (typeof CHATOPS_ACTIONS)[number];

export interface ChatInteraction {
  /** the chat provider's id for the human who clicked. An ASSERTION. */
  chatUserId: string;
  /** the OPAQUE approval id carried by the button. Carries no authority. */
  approvalId: string;
  action: ChatOpsAction;
  /** the message the buttons live on, so the card can be retired on decision */
  messageRef: string | null;
  channel: string | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Slack posts interactions as `application/x-www-form-urlencoded` with a single
 * `payload` field holding JSON. Returns null for anything that is not a
 * well-formed approve/reject on a UUID approval id — a payload we cannot read
 * is refused, never guessed at.
 */
export function parseSlackInteraction(rawBody: string): ChatInteraction | null {
  let json: unknown;
  try {
    const params = new URLSearchParams(rawBody);
    const raw = params.get("payload");
    if (!raw) return null;
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof json !== "object" || json === null) return null;
  const p = json as Record<string, unknown>;
  const user = p.user as Record<string, unknown> | undefined;
  const chatUserId = typeof user?.id === "string" ? user.id : null;
  const actions = Array.isArray(p.actions) ? (p.actions as Array<Record<string, unknown>>) : [];
  const first = actions[0];
  const actionId = typeof first?.action_id === "string" ? first.action_id : null;
  const value = typeof first?.value === "string" ? first.value : null;
  const container = p.container as Record<string, unknown> | undefined;
  const messageRef = typeof container?.message_ts === "string" ? container.message_ts : null;
  const channelObj = p.channel as Record<string, unknown> | undefined;
  const channel = typeof channelObj?.id === "string" ? channelObj.id : null;
  if (!chatUserId || !actionId || !value) return null;
  const action = actionId === "regulait_approve" ? "approve" : actionId === "regulait_reject" ? "reject" : null;
  if (!action) return null;
  if (!UUID_RE.test(value)) return null;
  return { chatUserId, approvalId: value, action, messageRef, channel };
}

/** Teams outgoing-webhook / adaptive-card action: a JSON body. */
export function parseTeamsInteraction(rawBody: string): ChatInteraction | null {
  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (typeof json !== "object" || json === null) return null;
  const p = json as Record<string, unknown>;
  const from = p.from as Record<string, unknown> | undefined;
  const chatUserId =
    typeof from?.aadObjectId === "string" ? from.aadObjectId : typeof from?.id === "string" ? from.id : null;
  const value = p.value as Record<string, unknown> | undefined;
  const approvalId = typeof value?.approvalId === "string" ? value.approvalId : null;
  const rawAction = typeof value?.action === "string" ? value.action : null;
  const conv = p.conversation as Record<string, unknown> | undefined;
  const channel = typeof conv?.id === "string" ? conv.id : null;
  const messageRef = typeof p.replyToId === "string" ? p.replyToId : null;
  if (!chatUserId || !approvalId || !rawAction) return null;
  if (!UUID_RE.test(approvalId)) return null;
  if (rawAction !== "approve" && rawAction !== "reject") return null;
  return { chatUserId, approvalId, action: rawAction, messageRef, channel };
}

export function parseChatInteraction(provider: ChatOpsProvider, rawBody: string): ChatInteraction | null {
  return provider === "slack" ? parseSlackInteraction(rawBody) : parseTeamsInteraction(rawBody);
}

// ---------------------------------------------------------------------------
// The SENSITIVITY FENCE — what a chat message is allowed to say
// ---------------------------------------------------------------------------

/**
 * ADR-0046's fence, applied to a courier rather than to a bulk action: an
 * approval whose attributed project is in PII mode `block` must not have its
 * content leave for a third-party chat workspace. The fence is on the CONTENT,
 * not on the existence of the approval — the card still says "there is an
 * approval waiting", with a LINK, so the queue does not silently go quiet.
 */
export function chatContentFenced(projectPiiMode: string | null | undefined): boolean {
  return projectPiiMode === "block";
}

/**
 * ADR-0061 §"Harder": "a chat tap is a weaker authentication act than an in-app
 * authenticated session … Make chat-decide allowed per approval sensitivity,
 * admin-configurable, defaulting the most sensitive classes to in-app-only."
 * That default lives here: fenced ⇒ NOT chat-decidable unless an admin has
 * explicitly opted this connection in.
 */
export function chatDecidable(input: { fenced: boolean; allowFencedDecide: boolean }): boolean {
  return !input.fenced || input.allowFencedDecide;
}

export interface ApprovalCardInput {
  approvalId: string;
  objectType: string;
  toolName?: string | null;
  stageId?: string | null;
  requesterLabel?: string | null;
  approverLabel?: string | null;
  /** where the human goes to decide it properly */
  portalUrl: string;
  fenced: boolean;
  decidable: boolean;
}

export interface ApprovalCard {
  text: string;
  blocks: Array<Record<string, unknown>>;
  /** true when the card deliberately omits the gated action's details */
  redacted: boolean;
}

/**
 * THE FENCED CARD CARRIES A LINK, NOT THE CONTENT. The test that matters is
 * that a fenced card's serialized form does not contain the tool name, the
 * stage id or the requester — only the opaque approval id and a URL.
 */
export function composeApprovalCard(input: ApprovalCardInput): ApprovalCard {
  const blocks: Array<Record<string, unknown>> = [];
  let text: string;

  if (input.fenced) {
    text =
      `An approval is waiting in RegulAIt. Its details are withheld from chat because the requesting project's ` +
      `compliance classification blocks sensitive content leaving the platform. Open it in the portal to review.`;
    blocks.push({ type: "section", text: { type: "mrkdwn", text } });
    blocks.push({ type: "section", text: { type: "mrkdwn", text: `<${input.portalUrl}|Open approval ${input.approvalId}>` } });
  } else {
    const parts = [
      `*Approval required* — \`${input.objectType}\``,
      input.toolName ? `tool: \`${input.toolName}\`` : null,
      input.stageId ? `stage: \`${input.stageId}\`` : null,
      input.requesterLabel ? `requested by: ${input.requesterLabel}` : null,
      input.approverLabel ? `approver: ${input.approverLabel}` : null,
    ].filter((x): x is string => Boolean(x));
    text = parts.join("\n");
    blocks.push({ type: "section", text: { type: "mrkdwn", text } });
    blocks.push({ type: "section", text: { type: "mrkdwn", text: `<${input.portalUrl}|Open in RegulAIt>` } });
  }

  if (input.decidable) {
    // THE BUTTON CARRIES ONLY THE OPAQUE APPROVAL ID. No user id, no role, no
    // signed grant — nothing that could be replayed into authority. The value
    // is a *request* to decide.
    blocks.push({
      type: "actions",
      elements: [
        { type: "button", action_id: "regulait_approve", style: "primary", text: { type: "plain_text", text: "Approve" }, value: input.approvalId },
        { type: "button", action_id: "regulait_reject", style: "danger", text: { type: "plain_text", text: "Reject" }, value: input.approvalId },
      ],
    });
  } else {
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text:
            "_This approval is in-app only: a chat tap is not a re-authenticated session, and this approval's " +
            "sensitivity classification requires deciding it in the portal._",
        },
      ],
    });
  }

  return { text, blocks, redacted: input.fenced };
}

/** the card a decided approval is edited down to — the buttons are retired */
export function composeDecidedCard(input: { approvalId: string; decision: string; deciderLabel: string; portalUrl: string }): ApprovalCard {
  const text = `Approval ${input.approvalId} was *${input.decision}* by ${input.deciderLabel}.`;
  return {
    text,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text } },
      { type: "section", text: { type: "mrkdwn", text: `<${input.portalUrl}|View in RegulAIt>` } },
    ],
    redacted: false,
  };
}
