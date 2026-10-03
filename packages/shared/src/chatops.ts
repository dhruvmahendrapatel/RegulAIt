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

export const CHATOPS_PROVIDERS = ["slack", "teams", "outlook"] as const;
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
  | "unsupported_provider"
  /** ADR-0121: the provider exists and is registrable, but takes no inbound —
   * distinct from `unsupported_provider`, which means we do not know it at all.
   * A reader of this union should be able to tell "refused by decision" from
   * "not implemented". */
  | "inbound_unsupported_by_design";

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

  if (input.provider === "outlook") {
    // ADR-0121 — A DECISION, NOT A GAP, stated here because this is where
    // someone will look for it.
    //
    // Chat inbound is accepted because the PLATFORM signs it: Slack HMACs the
    // body, the Bot Connector authenticates the caller. Email has no such
    // thing. An inbound message asserting it is from an approver is exactly
    // that — an assertion — and SPF/DKIM/DMARC would only move the trust onto
    // a relay's header parsing. Accepting a governance decision on that basis
    // would be worse than having no email channel at all, because it would
    // LOOK like a verified one.
    //
    // Microsoft Actionable Messages is the cryptographic path (a
    // Microsoft-signed bearer token, verifiable against their JWKS) and is how
    // this would become decide-from-inbox. It needs an originator id
    // registered per tenant — a deployment fact this codebase cannot hold or
    // verify for a customer — so it is not pretended at here.
    return refuse(
      "inbound_unsupported_by_design",
      "outlook is a send-only ChatOps provider: an inbound email is an unauthenticated assertion, not a " +
        "signed callback, so a decision is never taken from one. Decide from the portal link in the message.",
    );
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

/**
 * ONE semantic decide button, provider-neutral. ADR-0113 added this so a second
 * chat provider renders its OWN buttons from the SAME decision rather than
 * re-deriving one: `actions` is empty exactly when `chatDecidable` said no, so
 * a renderer cannot accidentally offer a tap the fence forbade. The payload is
 * still only the OPAQUE approval id plus the verb — nothing replayable into
 * authority, on either provider.
 */
export interface ApprovalCardAction {
  /** the Slack `action_id`; Teams carries the verb in `data.action` instead */
  id: "regulait_approve" | "regulait_reject";
  label: string;
  approvalId: string;
  action: ChatOpsAction;
}

export interface ApprovalCard {
  text: string;
  blocks: Array<Record<string, unknown>>;
  /** true when the card deliberately omits the gated action's details */
  redacted: boolean;
  /** where the human goes to decide it properly — carried on EVERY card */
  portalUrl: string;
  /** EMPTY when the sensitivity fence (or a decided card) forbids deciding
   * from chat. A renderer that emits a button when this is empty is a bug. */
  actions: ApprovalCardAction[];
  /** the sentence shown in place of the buttons when `actions` is empty */
  inAppOnlyNote: string | null;
}

const IN_APP_ONLY_NOTE =
  "This approval is in-app only: a chat tap is not a re-authenticated session, and this approval's " +
  "sensitivity classification requires deciding it in the portal.";

/** the decide buttons this card is allowed to offer — the ONE place that turns
 * `decidable` into actions, for every provider */
function approvalCardActions(approvalId: string, decidable: boolean): ApprovalCardAction[] {
  if (!decidable) return [];
  return [
    { id: "regulait_approve", label: "Approve", approvalId, action: "approve" },
    { id: "regulait_reject", label: "Reject", approvalId, action: "reject" },
  ];
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

  const actions = approvalCardActions(input.approvalId, input.decidable);
  if (actions.length > 0) {
    // THE BUTTON CARRIES ONLY THE OPAQUE APPROVAL ID. No user id, no role, no
    // signed grant — nothing that could be replayed into authority. The value
    // is a *request* to decide.
    blocks.push({
      type: "actions",
      elements: actions.map((a) => ({
        type: "button",
        action_id: a.id,
        style: a.action === "approve" ? "primary" : "danger",
        text: { type: "plain_text", text: a.label },
        value: a.approvalId,
      })),
    });
  } else {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: `_${IN_APP_ONLY_NOTE}_` }],
    });
  }

  return {
    text,
    blocks,
    redacted: input.fenced,
    portalUrl: input.portalUrl,
    actions,
    inAppOnlyNote: actions.length > 0 ? null : IN_APP_ONLY_NOTE,
  };
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
    portalUrl: input.portalUrl,
    // a DECIDED card never offers a decide button again, on any provider
    actions: [],
    inAppOnlyNote: null,
  };
}

// ---------------------------------------------------------------------------
// ADR-0113 — RENDERING THE SAME CARD FOR TEAMS
// ---------------------------------------------------------------------------
//
// Teams cannot render Slack Block Kit, so a second renderer is unavoidable. The
// thing that must NOT be duplicated is the DECISION about what the card is
// allowed to say and offer, because a second copy of that is a second place for
// the sensitivity fence to drift. So this function takes the ALREADY-COMPOSED
// `ApprovalCard` and re-renders it: `text` is reused byte-for-byte (modulo the
// bold-marker conversion below), and the buttons come from `card.actions`,
// which `composeApprovalCard` already emptied if the fence said so. A fenced
// approval therefore produces a Teams card with a link and no Action.Submit for
// the same reason and by the same code path as on Slack.
//
// The Action.Submit `data` is exactly what `parseTeamsInteraction` reads back:
// `{approvalId, action}` arrives as the inbound Activity's `value`.
//
// FIDELITY, STATED RATHER THAN IMPLIED. Adaptive Cards support a smaller
// markdown subset than Slack mrkdwn. Bold is spelled `**x**` instead of `*x*`,
// so that one marker is converted. Slack's backtick code spans have no Adaptive
// Cards equivalent and are LEFT ALONE — they render as literal backticks in
// Teams. That is a cosmetic difference in a card whose content is otherwise
// identical, and it is recorded in ADR-0113 rather than papered over.
export const TEAMS_ADAPTIVE_CARD_CONTENT_TYPE = "application/vnd.microsoft.card.adaptive";
/** the schema version pinned for the card body — 1.4 is broadly supported by
 * shipped Teams clients; 1.5 is not uniformly rendered */
export const TEAMS_ADAPTIVE_CARD_VERSION = "1.4";

/** Slack mrkdwn `*bold*` → Adaptive Cards `**bold**`. Deliberately narrow: it
 * only touches a `*…*` run that contains no `*` and no newline. */
function toAdaptiveMarkdown(text: string): string {
  return text.replace(/(^|[\s(])\*([^*\n]+)\*(?=$|[\s.,;:!?)])/g, (_m, lead: string, inner: string) => `${lead}**${inner}**`);
}

export interface TeamsActivityPayload {
  text: string;
  attachments: Array<{ contentType: string; content: Record<string, unknown> }>;
}

/**
 * Render an already-composed `ApprovalCard` as the Bot Framework Activity
 * fields a Teams post carries. Pure: no clock, no network, no db.
 */
export interface OutlookMessagePayload {
  subject: string;
  body: { contentType: "HTML"; content: string };
}

/** Minimal HTML escaping — this content reaches a mail client, and a tool name
 * or approver label is operator-supplied text, not markup. */
function escapeHtml(v: string): string {
  return v
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * ADR-0121 — render an already-composed `ApprovalCard` as the mail fields a
 * Graph `sendMail` carries. Pure: no clock, no network, no db.
 *
 * THERE ARE NO DECIDE ACTIONS HERE, AND THAT IS THE POINT. `card.actions` is
 * deliberately not rendered. ADR-0061's fence reasons that a chat tap is not a
 * re-authenticated session; an email is weaker still — it forwards, it sits in
 * an unlocked mailbox, it survives in archives and backups, and anyone holding
 * a copy holds whatever the copy can do. So the message carries the SAME
 * content and the portal link, and the decision is taken where the approver is
 * authenticated. A deployment cannot opt out with `allowFencedDecide`: that
 * switch loosens the FENCE, not this channel's own limits.
 */
export function outlookMessageForCard(card: ApprovalCard): OutlookMessagePayload {
  const lines = [`<p>${escapeHtml(card.text).replace(/\n/g, "<br/>")}</p>`];
  if (/^https?:\/\//i.test(card.portalUrl)) {
    lines.push(`<p><a href="${escapeHtml(card.portalUrl)}">Open in RegulAIt to decide</a></p>`);
  } else {
    // no public base URL configured: say where to go rather than emit a dead
    // link, exactly as the Teams renderer declines a dead Action.OpenUrl
    lines.push(`<p>Decide in RegulAIt: ${escapeHtml(card.portalUrl)}</p>`);
  }
  if (card.inAppOnlyNote) {
    lines.push(`<p><em>${escapeHtml(card.inAppOnlyNote)}</em></p>`);
  }
  lines.push(
    "<p><small>Approvals are decided in RegulAIt, never by replying to this message — " +
      "a reply is not a signed instruction and will not be acted on.</small></p>",
  );
  return {
    subject: card.redacted
      ? "RegulAIt: an approval needs you (content withheld)"
      : "RegulAIt: an approval needs you",
    body: { contentType: "HTML", content: lines.join("\n") },
  };
}

export function teamsActivityForCard(card: ApprovalCard): TeamsActivityPayload {
  const body: Array<Record<string, unknown>> = [
    { type: "TextBlock", text: toAdaptiveMarkdown(card.text), wrap: true },
    // The link is carried as TEXT as well as (when absolute) an action, so a
    // fenced card always still says WHERE to go even on a client that drops
    // the action bar. This is the "a link, not the content" half of the fence.
    { type: "TextBlock", text: card.portalUrl, wrap: true, isSubtle: true },
  ];
  if (card.inAppOnlyNote) {
    body.push({ type: "TextBlock", text: `_${card.inAppOnlyNote}_`, wrap: true, isSubtle: true });
  }

  const actions: Array<Record<string, unknown>> = [];
  // Action.OpenUrl needs an ABSOLUTE url; a deployment that has not configured
  // its public base URL gets the path as text above and no dead button.
  if (/^https?:\/\//i.test(card.portalUrl)) {
    actions.push({ type: "Action.OpenUrl", title: "Open in RegulAIt", url: card.portalUrl });
  }
  for (const a of card.actions) {
    // SAME rule as the Slack button: the payload is the opaque approval id and
    // a verb, nothing that could be replayed into authority.
    actions.push({
      type: "Action.Submit",
      title: a.label,
      data: { approvalId: a.approvalId, action: a.action },
    });
  }

  return {
    text: card.text,
    attachments: [
      {
        contentType: TEAMS_ADAPTIVE_CARD_CONTENT_TYPE,
        content: {
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
          type: "AdaptiveCard",
          version: TEAMS_ADAPTIVE_CARD_VERSION,
          body,
          ...(actions.length > 0 ? { actions } : {}),
        },
      },
    ],
  };
}


// ---------------------------------------------------------------------------
// ADR-0162 — governance-monitor alert cards. INFORMATION, never a decision:
// no actions, so no renderer can emit a button. The title is the alert's own
// (names of use cases / agents / vendors — governance metadata, never prompt
// or response content); the portal link is where a human acts.
// ---------------------------------------------------------------------------

export function composeAlertCard(input: {
  alertId: string;
  severity: "low" | "medium" | "high";
  ruleLabel: string;
  title: string;
  portalUrl: string;
}): ApprovalCard {
  const icon = input.severity === "high" ? "🔴" : input.severity === "medium" ? "🟠" : "⚪";
  const text = `${icon} *Governance alert* — ${input.severity.toUpperCase()} — ${input.ruleLabel}\n${input.title}`;
  return {
    text,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text } },
      { type: "section", text: { type: "mrkdwn", text: `<${input.portalUrl}|Open in RegulAIt>` } },
    ],
    redacted: false,
    portalUrl: input.portalUrl,
    actions: [],
    inAppOnlyNote: null,
  };
}

/** does a workspace with this threshold receive an alert of this severity? */
export function alertMeetsThreshold(severity: string, threshold: "medium" | "high" | null): boolean {
  if (!threshold) return false;
  const rank: Record<string, number> = { low: 0, medium: 1, high: 2 };
  return (rank[severity] ?? -1) >= rank[threshold]!;
}
