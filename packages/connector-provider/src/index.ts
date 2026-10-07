/**
 * @regulait/connector-provider — the real execution layer behind pillar 1's
 * connector catalog (GOVERNANCE §2) and pillar 5's actual-spend ledger
 * (GOVERNANCE §10.3).
 *
 * Follows the git-provider/pm-provider/model-provider playbook: a neutral
 * interface, real adapters for the kinds we implement now (a generic
 * HTTP/REST connector and a signed webhook receiver, both with injectable
 * fetch), an in-memory mock for tests and air-gapped development, and a
 * registry whose switch stays exhaustive over the kind union — a future new
 * kind forces a compile error instead of a silent promise.
 *
 * Placement rule (GOVERNANCE §7): execution always runs strictly AFTER the
 * governance decision, inside the `allow` branch. This package never decides
 * whether a call is permitted — it is handed an already-authorized operation
 * and performs exactly that. A FAILED call surfaces as a ConnectorProviderError
 * and bills nothing (the gateway mirrors the model path).
 *
 * "No silent promises" rule (same as model-provider): a kind that is
 * interface-ready but not implemented throws an explicit "not implemented yet"
 * from the registry rather than pretending. (Every declared kind is now
 * implemented — snowflake's ROADMAP Batch B deferral was closed by ADR-0023's
 * structured-JSON credential convention; the rule stands for future kinds.)
 *
 * Data-scope semantics (shared by every adapter here): the invocation's
 * `object` string is the SAME string pillar 1's `allowedObjects` grant field is
 * compared against (policy-kernel `connector-object-scope` rule) — enforcement
 * happens in the gateway BEFORE this package is ever invoked, exactly as it
 * does for the http/generic adapters (whose `object` is the URL path). Each
 * adapter therefore only has to define what its `object` MEANS, and must route
 * every upstream call through that object so the upstream reach never exceeds
 * the authorized object:
 *   - slack     → a channel ID (e.g. "C0123456789")
 *   - teams     → a Bot Framework CONVERSATION ID (e.g. "19:…@thread.tacv2")
 *   - outlook   → ONE recipient mailbox address (e.g. "ana@acme.com"). A
 *                 mailbox, never a distribution list the adapter resolves:
 *                 the authorized object has to be the thing that receives.
 *   - github    → an "owner/repo" slug (e.g. "acme/billing")
 *   - jira      → a project key (e.g. "PLAT")
 *   - snowflake → a "DATABASE.SCHEMA" pair (e.g. "ANALYTICS.PUBLIC")
 * Read/write classification is likewise the interface's own: `operation:
 * "read"` may only ever produce non-mutating upstream calls (GET / query),
 * `operation: "write"` only mutating ones — that is what makes pillar 1's
 * read-only grant mode meaningful, so adapters hard-fail on any op that
 * disagrees with its operation rather than quietly reclassifying.
 */

import { createHash, createPrivateKey, createPublicKey, createSign } from "node:crypto";
import { constantTimeEqual, scrubSecrets, secretRepresentations } from "@regulait/shared";
import { z } from "zod";

export const CONNECTOR_PROVIDER_KINDS = [
  "http",
  "webhook",
  "slack",
  "teams",
  "outlook",
  "github",
  "jira",
  "snowflake",
  "generic",
  "mock",
] as const;
export type ConnectorProviderKind = (typeof CONNECTOR_PROVIDER_KINDS)[number];

export function isConnectorProviderKind(value: string): value is ConnectorProviderKind {
  return (CONNECTOR_PROVIDER_KINDS as readonly string[]).includes(value);
}

export class ConnectorProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

/**
 * The abstraction's typed rate-limit error — distinct from a generic upstream
 * failure so the gateway (and pillar 1's rate-limit machinery) can tell "the
 * upstream throttled us, retry after N seconds" apart from "the call is
 * broken". `status` is always the canonical 429 even when the upstream spells
 * throttling differently (GitHub's 403-with-rate-limit-headers, Slack's
 * HTTP-200 `ok:false error:ratelimited`); the upstream's own status is kept in
 * `upstreamStatus` for the audit trail.
 */
export class ConnectorRateLimitError extends ConnectorProviderError {
  constructor(
    message: string,
    /** seconds the upstream asked us to wait (Retry-After / reset headers), when it said */
    readonly retryAfterSeconds?: number,
    readonly upstreamStatus?: number,
  ) {
    super(message, 429);
  }
}

/** A single governed connector call: read fetches the named object, write
 * pushes the payload to it. `object` and `payload` are optional — a bare
 * read/write against the connection root is valid. */
export interface ConnectorInvocation {
  operation: "read" | "write";
  object?: string | null;
  payload?: Record<string, unknown> | null;
}

/** The neutral result every adapter returns: the upstream status and its
 * decoded body. The gateway ledgers cost against the connector's list price,
 * never against anything in here. */
export interface ConnectorInvokeResult {
  status: number;
  body: unknown;
}

export interface ConnectorProvider {
  readonly kind: ConnectorProviderKind;
  invoke(invocation: ConnectorInvocation): Promise<ConnectorInvokeResult>;
}

// The same injectable-fetch shape the pm-provider adapters use, so unit tests
// never touch the network. `headers` is optional (additive — pre-existing fake
// fetches without it still typecheck) because the GitHub/Slack adapters need
// response headers to recognize throttling (Retry-After, x-ratelimit-*);
// the real global fetch always provides it.
type FetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<{
  status: number;
  headers?: { get(name: string): string | null };
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

/** shared: decode a 2xx body the way every adapter here does — empty → null,
 * JSON when it parses, raw text otherwise (a non-JSON 2xx is data, not a throw) */
function decodeBody(status: number, text: string): ConnectorInvokeResult {
  if (!text) return { status, body: null };
  try {
    return { status, body: JSON.parse(text) };
  } catch {
    return { status, body: text };
  }
}

/** shared: parse an integer Retry-After header (seconds form) when present */
function retryAfterSeconds(headers?: { get(name: string): string | null }): number | undefined {
  const raw = headers?.get("retry-after");
  if (!raw) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** shared: build a ?query string from defined params only */
function query(params: Record<string, string | number | undefined>): string {
  const pairs = Object.entries(params).filter(([, v]) => v !== undefined) as Array<
    [string, string | number]
  >;
  if (pairs.length === 0) return "";
  const qs = new URLSearchParams(pairs.map(([k, v]) => [k, String(v)]));
  return `?${qs.toString()}`;
}

// ---------------------------------------------------------------------------
// Generic HTTP/REST adapter — serves both the "generic" and "http" kinds.
// A read is GET {baseUrl}/{object}; a write is POST {baseUrl}/{object} with the
// payload as a JSON body. An optional bearer token authenticates. Any non-2xx
// surfaces as a ConnectorProviderError carrying the status (a failed call bills
// nothing upstream in the gateway).
// ---------------------------------------------------------------------------

export interface GenericHttpAdapterOptions {
  /** the connection root, e.g. https://api.example.com/v1 */
  baseUrl: string;
  /** optional bearer credential; absent = an unauthenticated endpoint */
  token?: string | null;
  fetchImpl?: FetchLike;
}

export class GenericHttpConnectorProvider implements ConnectorProvider {
  readonly kind: ConnectorProviderKind;
  private readonly base: string;
  private readonly token: string | null;
  private readonly fetchImpl: FetchLike;

  constructor(kind: "generic" | "http", opts: GenericHttpAdapterOptions) {
    this.kind = kind;
    this.base = opts.baseUrl.replace(/\/$/, "");
    this.token = opts.token ?? null;
    this.fetchImpl = opts.fetchImpl ?? (fetch as unknown as FetchLike);
  }

  private url(object?: string | null): string {
    const path = object ? `/${String(object).replace(/^\//, "")}` : "";
    return `${this.base}${path}`;
  }

  private headers(withBody: boolean): Record<string, string> {
    const h: Record<string, string> = { accept: "application/json" };
    if (withBody) h["content-type"] = "application/json";
    if (this.token) h.authorization = `Bearer ${this.token}`;
    return h;
  }

  async invoke(invocation: ConnectorInvocation): Promise<ConnectorInvokeResult> {
    const url = this.url(invocation.object);
    const res =
      invocation.operation === "write"
        ? await this.fetchImpl(url, {
            method: "POST",
            headers: this.headers(true),
            body: JSON.stringify(invocation.payload ?? {}),
          })
        : await this.fetchImpl(url, { method: "GET", headers: this.headers(false) });
    if (res.status < 200 || res.status >= 300) {
      // X19-S01: the upstream's text, scrubbed of the bearer credential it was sent
      throw new ConnectorProviderError(
        `${this.kind} ${invocation.operation} ${url} failed: ${scrubSecrets(await res.text(), this.token ? [this.token] : [])}`,
        res.status,
      );
    }
    // a non-JSON 2xx body carries no structured data — surface null, not a throw
    const text = await res.text();
    if (!text) return { status: res.status, body: null };
    try {
      return { status: res.status, body: JSON.parse(text) };
    } catch {
      return { status: res.status, body: text };
    }
  }
}

// ---------------------------------------------------------------------------
// Webhook adapter — POSTs one normalized envelope { operation, object,
// timestamp, payload } to the connection's baseUrl (the outbound mirror of the
// pm-provider's generic webhook). The token, when present, is sent as a bearer
// credential. Any non-2xx surfaces as a ConnectorProviderError.
// ---------------------------------------------------------------------------

export interface WebhookAdapterOptions {
  baseUrl: string;
  token?: string | null;
  fetchImpl?: FetchLike;
}

export class WebhookConnectorProvider implements ConnectorProvider {
  readonly kind = "webhook" as const;
  private readonly url: string;
  private readonly token: string | null;
  private readonly fetchImpl: FetchLike;

  constructor(opts: WebhookAdapterOptions) {
    // the baseUrl IS the receiver endpoint — nothing is appended
    this.url = opts.baseUrl;
    this.token = opts.token ?? null;
    this.fetchImpl = opts.fetchImpl ?? (fetch as unknown as FetchLike);
  }

  async invoke(invocation: ConnectorInvocation): Promise<ConnectorInvokeResult> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    const body = JSON.stringify({
      operation: invocation.operation,
      object: invocation.object ?? null,
      timestamp: new Date().toISOString(),
      payload: invocation.payload ?? {},
    });
    const res = await this.fetchImpl(this.url, { method: "POST", headers, body });
    if (res.status < 200 || res.status >= 300) {
      // X19-S01: the receiver's text, scrubbed of the bearer credential it was sent
      throw new ConnectorProviderError(
        `webhook ${invocation.operation} failed: ${scrubSecrets(await res.text(), this.token ? [this.token] : [])}`,
        res.status,
      );
    }
    const text = await res.text();
    if (!text) return { status: res.status, body: null };
    try {
      return { status: res.status, body: JSON.parse(text) };
    } catch {
      return { status: res.status, body: text };
    }
  }
}

// ---------------------------------------------------------------------------
// Slack adapter — Slack Web API with a Bearer bot token (xoxb-…).
//
// Object semantics: `object` is a CHANNEL ID (e.g. "C0123456789") — the natural
// unit an admin scopes a Slack grant to via `allowedObjects`. Every
// channel-touching call takes its channel from `object`, never from the
// payload, so the upstream reach can never exceed the authorized object.
//
// Operation surface (representative, per ROADMAP Batch B):
//   read,  object=null                → conversations.list   (enumerate channels;
//                                       the "connection root" read, mirroring the
//                                       generic adapter's bare read)
//   read,  object=<channel>           → conversations.history for that channel
//                                       (payload may carry limit/oldest/latest/cursor)
//   read,  payload.op=
//          "users.lookupByEmail"      → users.lookupByEmail (payload.email).
//                                       NOT channel-scoped — so under a
//                                       channel-scoped grant it is invoked with
//                                       object=null and the kernel's
//                                       object-scope rule fails it closed, which
//                                       is exactly the fail-closed semantic the
//                                       http/generic adapters already live with.
//   write, object=<channel> (required),
//          payload={text,…}           → chat.postMessage to that channel
//
// Error taxonomy: Slack answers HTTP 200 with an `{ok:false, error:"…"}`
// envelope for most failures, so HTTP status alone is meaningless — the
// envelope's error code is mapped to a typed ConnectorProviderError with a
// conventional HTTP status (auth codes→401, permission codes→403, not-found
// codes→404, anything unrecognized→502 upstream-failure). `ratelimited` (and a
// real HTTP 429 + Retry-After) map to ConnectorRateLimitError, never a generic
// failure.
// ---------------------------------------------------------------------------

export const SLACK_DEFAULT_BASE_URL = "https://slack.com/api";

export interface SlackAdapterOptions {
  /** Slack bot token (xoxb-…), sent as `Authorization: Bearer` */
  token: string;
  /** override for tests/proxies; defaults to https://slack.com/api */
  baseUrl?: string | null;
  fetchImpl?: FetchLike;
}

// ---------------------------------------------------------------------------
// ADR-0173 batch 2b review — OUR CONTROLS ARE OURS ALONE
//
// The interaction routes act on a click by its action id (Slack) or its
// submit data (Teams): `regulait_approve` + an approval id decides that
// approval; `regulait_step_*` + a prompt id answers that "Ask first" step. A
// governed connector write (a user with a chat write grant, or a builder
// agent the model steers) must therefore never be able to post a message
// carrying those controls — a look-alike card whose button answers SOMEONE
// ELSE's pending item, worded to mislead the person who clicks — nor rewrite
// one of the product's own messages.
//
// REFUSED, NOT STRIPPED: stripping would post something other than what the
// caller sent (and what an approval, if one was needed, was bound to by its
// argument digest), silently. A legitimate caller never needs our reserved
// ids, so a payload carrying one is either a mistake or an attempt; either
// way the answer is a clear, audited refusal and nothing is posted.
// ---------------------------------------------------------------------------

/** the prefix every interactive control id the product posts begins with */
export const RESERVED_CHAT_CONTROL_PREFIX = "regulait_";

export type ReservedChatControl =
  | { code: "chat_update_internal_only"; detail: string }
  | { code: "reserved_chat_control"; detail: string };

const SLACK_CONTROL_KEYS = new Set(["action_id", "block_id", "callback_id"]);

/**
 * Why a connector write must not be sent, or null when it may. Pure. Looks
 * through the whole payload (blocks and attachments may also arrive as a JSON
 * string, which is parsed and searched too), bounded in depth and size.
 */
export function reservedChatControl(
  providerKind: string,
  operation: "read" | "write",
  payload: unknown,
): ReservedChatControl | null {
  if (operation !== "write" || (providerKind !== "slack" && providerKind !== "teams")) return null;
  if (providerKind === "slack" && payload && typeof payload === "object" && (payload as Record<string, unknown>).op === "chat.update") {
    return {
      code: "chat_update_internal_only",
      detail: "rewriting a message is internal-only: the product retires its own approval and confirmation messages, nothing else may",
    };
  }
  let budget = 20_000;
  let found: string | null = null;
  let overflow = false;
  const visit = (node: unknown, depth: number): void => {
    if (found || overflow) return;
    // past the bounds nothing is assumed safe: the write is refused
    if (budget-- <= 0 || depth > 32) {
      overflow = true;
      return;
    }
    if (typeof node === "string") {
      const t = node.trimStart();
      if ((t.startsWith("[") || t.startsWith("{")) && node.length <= 1_000_000) {
        try {
          visit(JSON.parse(node), depth + 1);
        } catch {
          /* plain text */
        }
      }
      return;
    }
    if (Array.isArray(node)) {
      for (const v of node) visit(v, depth + 1);
      return;
    }
    if (!node || typeof node !== "object") return;
    for (const [key, v] of Object.entries(node as Record<string, unknown>)) {
      const k = key.toLowerCase();
      if (providerKind === "slack" && SLACK_CONTROL_KEYS.has(k) && typeof v === "string" && v.trim().toLowerCase().startsWith(RESERVED_CHAT_CONTROL_PREFIX)) {
        found = `${key} '${v.slice(0, 80)}'`;
        return;
      }
      // a Teams Action.Submit's data comes back as the activity's `value`;
      // `approvalId` there is what the interaction route decides on
      if (providerKind === "teams" && k === "approvalid") {
        found = "a submit action carrying 'approvalId'";
        return;
      }
      visit(v, depth + 1);
    }
  };
  visit(payload, 0);
  if (overflow && !found) {
    return { code: "reserved_chat_control", detail: "the message is too deeply structured to check for reserved controls" };
  }
  return found
    ? {
        code: "reserved_chat_control",
        detail: `the message carries ${found}, a control reserved for RegulAIt's own approval and confirmation messages`,
      }
    : null;
}

/** Slack `ok:false` error code → conventional HTTP status for the typed error */
const SLACK_ERROR_STATUS: Record<string, number> = {
  invalid_auth: 401,
  not_authed: 401,
  account_inactive: 401,
  token_revoked: 401,
  token_expired: 401,
  missing_scope: 403,
  access_denied: 403,
  not_allowed_token_type: 403,
  restricted_action: 403,
  ekm_access_denied: 403,
  channel_not_found: 404,
  user_not_found: 404,
  users_not_found: 404,
  thread_not_found: 404,
  is_archived: 404,
};

export class SlackConnectorProvider implements ConnectorProvider {
  readonly kind = "slack" as const;
  private readonly base: string;
  private readonly token: string;
  private readonly fetchImpl: FetchLike;

  constructor(opts: SlackAdapterOptions) {
    this.base = (opts.baseUrl ?? SLACK_DEFAULT_BASE_URL).replace(/\/$/, "");
    this.token = opts.token;
    this.fetchImpl = opts.fetchImpl ?? (fetch as unknown as FetchLike);
  }

  private headers(withBody: boolean): Record<string, string> {
    const h: Record<string, string> = {
      accept: "application/json",
      authorization: `Bearer ${this.token}`,
    };
    if (withBody) h["content-type"] = "application/json; charset=utf-8";
    return h;
  }

  async invoke(invocation: ConnectorInvocation): Promise<ConnectorInvokeResult> {
    const payload = invocation.payload ?? {};
    const op = typeof payload.op === "string" ? payload.op : null;
    const channel = invocation.object ?? null;

    let method: string;
    let apiCall: string;
    let body: string | undefined;
    let qs = "";

    if (invocation.operation === "write") {
      // the ONLY mutating op on this surface — a read-mode grant can never
      // reach it because the kernel's mode rule runs before we do, and we never
      // mutate on operation:"read"
      //
      // `chat.update` is NOT an invoke() op (ADR-0173 batch 2b review).
      // Rewriting a message is how the product retires its own approval and
      // "Ask first" messages, so any caller that reached it here — a user with
      // a Slack write grant, or a prompt-injected agent — could rewrite those
      // to mislead the person answering, or hide them. It is
      // `updateOwnMessage`, which only the ChatOps courier calls; invoke()
      // refuses it by name.
      if (op === "chat.update") {
        throw new ConnectorProviderError(
          "slack 'chat.update' is internal-only: it is not available through a connector call",
          400,
        );
      }
      if (op !== null && op !== "chat.postMessage") {
        throw new ConnectorProviderError(
          `slack write supports only 'chat.postMessage' (got op '${op}')`,
          400,
        );
      }
      if (!channel) {
        throw new ConnectorProviderError(
          "slack write requires an object (the target channel ID) — chat.postMessage without a channel is meaningless",
          400,
        );
      }
      const { op: _op, ...rest } = payload;
      method = "POST";
      apiCall = "chat.postMessage";
      // channel comes from the governed object, never the payload
      body = JSON.stringify({ ...rest, channel });
    } else if (op === "users.lookupByEmail") {
      if (typeof payload.email !== "string" || !payload.email) {
        throw new ConnectorProviderError(
          "slack users.lookupByEmail requires payload.email",
          400,
        );
      }
      method = "GET";
      apiCall = "users.lookupByEmail";
      qs = query({ email: payload.email });
    } else if (op !== null && op !== "conversations.list" && op !== "conversations.history") {
      throw new ConnectorProviderError(
        `slack read supports 'conversations.list', 'conversations.history', 'users.lookupByEmail' (got op '${op}')`,
        400,
      );
    } else if (channel) {
      method = "GET";
      apiCall = "conversations.history";
      qs = query({
        channel,
        limit: typeof payload.limit === "number" ? payload.limit : undefined,
        oldest: typeof payload.oldest === "string" ? payload.oldest : undefined,
        latest: typeof payload.latest === "string" ? payload.latest : undefined,
        cursor: typeof payload.cursor === "string" ? payload.cursor : undefined,
      });
    } else {
      method = "GET";
      apiCall = "conversations.list";
      qs = query({
        limit: typeof payload.limit === "number" ? payload.limit : undefined,
        cursor: typeof payload.cursor === "string" ? payload.cursor : undefined,
        types: typeof payload.types === "string" ? payload.types : undefined,
      });
    }
    return this.send(method, apiCall, qs, body);
  }

  /**
   * INTERNAL-ONLY (ADR-0173 batch 2b): rewrite one message this bot posted —
   * how the ChatOps courier retires an answered "Ask first" message. Not an
   * `invoke()` op, so no governed connector call (a user's or an agent's) can
   * reach it. The channel and ts are the courier's own record of what it
   * posted, never caller input.
   */
  async updateOwnMessage(input: {
    channel: string;
    ts: string;
    text: string;
    blocks?: Array<Record<string, unknown>>;
  }): Promise<ConnectorInvokeResult> {
    if (!input.channel || !input.ts) {
      throw new ConnectorProviderError("slack chat.update requires the channel and ts of the message to update", 400);
    }
    const body = JSON.stringify({
      channel: input.channel,
      ts: input.ts,
      text: input.text,
      ...(input.blocks ? { blocks: input.blocks } : {}),
    });
    return this.send("POST", "chat.update", "", body);
  }

  private async send(method: string, apiCall: string, qs: string, body: string | undefined): Promise<ConnectorInvokeResult> {
    const url = `${this.base}/${apiCall}${qs}`;
    const res = await this.fetchImpl(url, {
      method,
      headers: this.headers(body !== undefined),
      ...(body !== undefined ? { body } : {}),
    });

    // transport-level throttle: HTTP 429 + Retry-After
    if (res.status === 429) {
      throw new ConnectorRateLimitError(
        `slack ${apiCall} rate-limited (HTTP 429)`,
        retryAfterSeconds(res.headers),
        429,
      );
    }
    const text = await res.text();
    if (res.status < 200 || res.status >= 300) {
      // X19-S01: the upstream's text, scrubbed of the bot token it was sent
      throw new ConnectorProviderError(`slack ${apiCall} failed: ${scrubSecrets(text, [this.token])}`, res.status);
    }
    // envelope-level failure: HTTP 200 with ok:false
    const decoded = decodeBody(res.status, text);
    const envelope = decoded.body as { ok?: boolean; error?: string } | null;
    if (envelope && typeof envelope === "object" && envelope.ok === false) {
      const code = envelope.error ?? "unknown_error";
      if (code === "ratelimited" || code === "rate_limited") {
        throw new ConnectorRateLimitError(
          `slack ${apiCall} rate-limited (ok:false '${code}')`,
          retryAfterSeconds(res.headers),
          res.status,
        );
      }
      throw new ConnectorProviderError(
        `slack ${apiCall} failed: ${scrubSecrets(code, [this.token])}`,
        SLACK_ERROR_STATUS[code] ?? 502,
      );
    }
    return decoded;
  }
}

// ---------------------------------------------------------------------------
// Microsoft Teams adapter — the BOT FRAMEWORK CONNECTOR REST API.
//
// WHY THIS API AND NOT MICROSOFT GRAPH. Graph has
// `POST /teams/{team}/channels/{channel}/messages`, and it looks like the
// obvious counterpart to Slack's `chat.postMessage`. It is the wrong one for a
// daemon. Graph documents that endpoint's APPLICATION permission as
// `Teamwork.Migrate.All` and states plainly that "application permissions are
// only supported for migration" — an app-only credential, which is the only
// kind this connector model holds, cannot send an ordinary channel message
// through Graph at all. Everything else on that path needs a SIGNED-IN USER's
// delegated `ChannelMessage.Send`, which `connector_credentials` does not model
// and ChatOps has no user to obtain. So Graph is not a near-miss here; it is a
// credential shape we do not have.
//
// The Bot Connector API is the documented, supported, app-only path, and it is
// also the EXACT counterpart of the inbound half we already ship:
// `packages/shared/src/chatops.ts` parses a Bot Framework **Activity**
// (`from.aadObjectId`, `conversation.id`, `replyToId`, `value.*`). Outbound is
// the same Activity travelling the other way.
//
// Verified against Microsoft Learn (fetched 2026-09-19):
//   - "API reference for the Bot Framework Connector service" — Base URI, and
//     the conversation operations table:
//       POST /v3/conversations/{conversationId}/activities              (Send to conversation)
//       POST /v3/conversations/{conversationId}/activities/{activityId} (Reply to activity)
//       GET  /v3/conversations/{conversationId}/members                 (Get conversation members)
//     both POSTs take an Activity and return a **ResourceResponse** `{id}`.
//     The same table says "only Direct Line and Web Chat support the *get
//     conversations* endpoint", which is why `GET /v3/conversations` is NOT the
//     connection-root read here — see the refusal in `invoke`.
//   - "Authentication with the Bot Connector API" — the app-only token:
//       POST {login}/{tenant}/oauth2/v2.0/token
//       grant_type=client_credentials&client_id=…&client_secret=…
//       &scope=https%3A%2F%2Fapi.botframework.com%2F.default
//     with `{tenant}` = `botframework.com` for a multi-tenant bot and the
//     directory (tenant) id for a single-tenant one. The response is
//     `{token_type, expires_in, access_token}`.
//
// CREDENTIAL SHAPE — ADR-0023's structured-JSON convention, as snowflake uses.
// A Bot Connector bearer token lives about an hour, so storing one in
// `connector_credentials.token` would work in a test and silently rot in
// production. The stored credential is therefore the app registration itself,
// `{appId, appPassword, tenantId?, loginBaseUrl?}`, and this adapter mints a
// token per invoke — the same "nothing cached, nothing to revoke" posture the
// snowflake adapter takes with its short-lived key-pair JWT.
//
// TWO HOSTS, BOTH GUARDED. This is the one place Teams is structurally
// different from Slack: a post touches the login host AND the service host.
// Both go through the SAME injected `fetchImpl`, and on the ChatOps path that
// is the guarded fetch, which re-adjudicates EVERY request URL against the
// egress allow-list. Neither host is exempt; an air-gapped install has neither
// entry and the courier is simply absent. An operator enabling Teams ChatOps
// must allow-list BOTH (`login.microsoftonline.com` and the service host).
//
// Object semantics: `object` is a **conversation ID** — the Teams analogue of
// Slack's channel id and the governed unit an admin scopes via
// `allowedObjects`. Every call derives its `/v3/conversations/{id}/` prefix
// from `object`, and the Activity's own `conversation.id` is overwritten from
// it, so a payload cannot redirect the message to another conversation.
//
// Operation surface:
//   read,  object=null                → REFUSED (see above: no Teams-supported
//                                       connection-root listing exists)
//   read,  object=<conversationId>    → GET  /v3/conversations/{id}/members
//   write, object=<conversationId>
//          (required)                 → POST /v3/conversations/{id}/activities
//   write, + payload.replyToId        → POST /v3/conversations/{id}/activities/{replyToId}
//
// Error taxonomy: unlike Slack, the Bot Connector answers with REAL HTTP status
// codes and an `ErrorResponse` body `{error:{code,message}}`, so there is no
// ok:false envelope to unwrap — the status is load-bearing and is kept. 429
// (and the login service's own 429) becomes ConnectorRateLimitError; every
// other non-2xx becomes a ConnectorProviderError carrying the upstream status
// and the `error.code` when the body had one.
// ---------------------------------------------------------------------------

/** the global Teams service URL, documented as the one to use when no
 * `serviceUrl` has been observed yet. Sovereign/regional clouds (GCC High, DoD,
 * 21Vianet) and regional endpoints differ — those set an explicit baseUrl. */
export const TEAMS_DEFAULT_BASE_URL = "https://smba.trafficmanager.net/teams";
/** the Microsoft Entra ID login host. `login.microsoftonline.us` etc. override
 * it through the credential's `loginBaseUrl`. */
export const TEAMS_DEFAULT_LOGIN_BASE_URL = "https://login.microsoftonline.com";
/** the multi-tenant bot's tenant segment, per the Bot Connector auth doc */
export const TEAMS_MULTITENANT_SEGMENT = "botframework.com";
/** the app-only scope the Bot Connector accepts */
export const TEAMS_BOT_SCOPE = "https://api.botframework.com/.default";

/**
 * ADR-0167 (SEC-01): a login-host override is a plain absolute http(s) URL —
 * a host, optionally a path, and nothing else. The adapters append
 * `/<tenant>/oauth2/v2.0/token`, so a value carrying credentials, a query or a
 * fragment would let the typed field choose the whole request rather than
 * the host. WHICH hosts are reachable is the egress guard's decision at call
 * time, not this schema's: a loopback fake in a test is admitted by an allow
 * entry, never by the shape.
 */
export const loginBaseUrlSchema = z
  .string()
  .url()
  .max(2048)
  .refine(
    (v) => {
      try {
        const u = new URL(v);
        return (
          (u.protocol === "https:" || u.protocol === "http:") &&
          u.hostname !== "" &&
          u.username === "" &&
          u.password === "" &&
          u.search === "" &&
          u.hash === ""
        );
      } catch {
        return false;
      }
    },
    { message: "must be a plain http(s) URL with a host and at most a path — no credentials, query or fragment" },
  );

// X19-S01: upstream error material is scrubbed by the ONE shared helper
// (`@regulait/shared` scrub-secrets.ts); re-exported so existing imports work.
export { scrubSecrets, secretRepresentations };

/** ADR-0167 (SEC-01): what a failed token exchange tells the caller. The
 * login service's own `error` / `error_description` are what an operator
 * needs; the raw body is NEVER echoed — once a typed login host is reachable,
 * the body is whatever that host chose to say, and reflecting it to the
 * (non-admin) invoker would make the connector a read oracle for it.
 * X19-S01: and what IS relayed is scrubbed of the credentials the request
 * carried (`secrets`) before it is capped, so a login host or proxy that
 * reflects the submitted client secret cannot hand it to the caller. */
export function tokenErrorDetail(text: string, status: number, secrets: readonly string[]): string {
  try {
    const parsed = JSON.parse(text) as { error?: unknown; error_description?: unknown };
    const parts = [parsed.error, parsed.error_description]
      .filter((p): p is string => typeof p === "string" && p.length > 0)
      .map((p) => scrubSecrets(p.replace(/[\r\n\t]+/g, " "), secrets).slice(0, 300));
    if (parts.length > 0) return `HTTP ${status}: ${parts.join(" — ")}`;
  } catch {
    /* not JSON: say so, do not echo */
  }
  return `HTTP ${status} (${text.length}-byte non-JSON response body withheld)`;
}

export const teamsCredentialSchema = z
  .object({
    appId: z.string().min(1),
    appPassword: z.string().min(1),
    /** omitted ⇒ multi-tenant bot (`botframework.com`) */
    tenantId: z.string().min(1).optional(),
    /** sovereign-cloud override for the Entra login host */
    loginBaseUrl: loginBaseUrlSchema.optional(),
  })
  .strict();
export type TeamsCredential = z.infer<typeof teamsCredentialSchema>;

/** Same contract as `parseSnowflakeCredential`: a malformed credential fails
 * EXPLICITLY with an actionable message rather than opaquely at first post. */
export function parseTeamsCredential(token: string): TeamsCredential {
  let raw: unknown;
  try {
    raw = JSON.parse(token);
  } catch {
    throw new ConnectorProviderError(
      "teams credential must be a JSON document {appId, appPassword, tenantId?, loginBaseUrl?} " +
        "(the bot's Microsoft app registration, serialized then stored as the connection's single token) — " +
        "got a non-JSON token. A raw Bot Connector bearer token is NOT accepted: it expires in about an hour, " +
        "so storing one would work once and then fail silently.",
      400,
    );
  }
  const parsed = teamsCredentialSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new ConnectorProviderError(
      `teams credential JSON is invalid — expected {appId, appPassword, tenantId?, loginBaseUrl?}: ${issues}`,
      400,
    );
  }
  return parsed.data;
}

export interface TeamsAdapterOptions {
  /** the bot's app registration — NOT a bearer token (see parseTeamsCredential) */
  credential: TeamsCredential;
  /** the Bot Connector service URL; defaults to the global Teams endpoint */
  baseUrl?: string | null;
  fetchImpl?: FetchLike;
}

export class TeamsConnectorProvider implements ConnectorProvider {
  readonly kind = "teams" as const;
  private readonly base: string;
  private readonly login: string;
  private readonly cred: TeamsCredential;
  private readonly fetchImpl: FetchLike;

  constructor(opts: TeamsAdapterOptions) {
    this.base = (opts.baseUrl ?? TEAMS_DEFAULT_BASE_URL).replace(/\/$/, "");
    this.cred = opts.credential;
    this.login = (opts.credential.loginBaseUrl ?? TEAMS_DEFAULT_LOGIN_BASE_URL).replace(/\/$/, "");
    this.fetchImpl = opts.fetchImpl ?? (fetch as unknown as FetchLike);
  }

  /**
   * Step 1 of the documented flow. One token per invoke, deliberately: a cached
   * one would have to be invalidated on credential rotation, and this adapter
   * has no lifecycle hook to do that. It goes through the SAME `fetchImpl` as
   * the post, so on the ChatOps path the login host is egress-adjudicated too.
   */
  private async accessToken(): Promise<string> {
    const tenant = this.cred.tenantId ?? TEAMS_MULTITENANT_SEGMENT;
    const url = `${this.login}/${encodeURIComponent(tenant)}/oauth2/v2.0/token`;
    const form = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.cred.appId,
      client_secret: this.cred.appPassword,
      scope: TEAMS_BOT_SCOPE,
    }).toString();
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: form,
    });
    if (res.status === 429) {
      throw new ConnectorRateLimitError(
        "teams token request rate-limited by the Microsoft Entra login service (HTTP 429)",
        retryAfterSeconds(res.headers),
        429,
      );
    }
    const text = await res.text();
    if (res.status < 200 || res.status >= 300) {
      // the app password itself is never echoed; the login service's own
      // `error`/`error_description` is what an operator needs — and ONLY
      // those (ADR-0167): the raw body is withheld
      throw new ConnectorProviderError(
        `teams token request failed: ${tokenErrorDetail(text, res.status, [this.cred.appPassword])}`,
        res.status === 400 || res.status === 401 ? 401 : res.status,
      );
    }
    const decoded = decodeBody(res.status, text).body as { access_token?: unknown } | null;
    const token = decoded && typeof decoded === "object" ? decoded.access_token : null;
    if (typeof token !== "string" || !token) {
      throw new ConnectorProviderError(
        "teams token response carried no access_token — refusing to post with no credential",
        502,
      );
    }
    return token;
  }

  async invoke(invocation: ConnectorInvocation): Promise<ConnectorInvokeResult> {
    const payload = invocation.payload ?? {};
    const op = typeof payload.op === "string" ? payload.op : null;
    const conversationId = invocation.object ?? null;

    let method: string;
    let apiPath: string;
    let body: string | undefined;
    let label: string;

    if (invocation.operation === "write") {
      if (op !== null && op !== "conversations.sendToConversation" && op !== "conversations.replyToActivity") {
        throw new ConnectorProviderError(
          `teams write supports 'conversations.sendToConversation' and 'conversations.replyToActivity' (got op '${op}')`,
          400,
        );
      }
      if (!conversationId) {
        throw new ConnectorProviderError(
          "teams write requires an object (the target conversation ID) — an Activity with no conversation is meaningless",
          400,
        );
      }
      const { op: _op, replyToId: rawReplyTo, conversation: _conv, ...rest } = payload;
      const replyToId = typeof rawReplyTo === "string" && rawReplyTo ? rawReplyTo : null;
      if (op === "conversations.replyToActivity" && !replyToId) {
        throw new ConnectorProviderError(
          "teams 'conversations.replyToActivity' requires payload.replyToId (the activity being replied to)",
          400,
        );
      }
      method = "POST";
      apiPath = replyToId
        ? `/v3/conversations/${encodeURIComponent(conversationId)}/activities/${encodeURIComponent(replyToId)}`
        : `/v3/conversations/${encodeURIComponent(conversationId)}/activities`;
      label = replyToId ? "replyToActivity" : "sendToConversation";
      // `conversation` comes from the GOVERNED OBJECT, never the payload — the
      // destructure above drops any caller-supplied one before this spread.
      body = JSON.stringify({ type: "message", ...rest, conversation: { id: conversationId } });
    } else {
      if (op !== null && op !== "conversations.members") {
        throw new ConnectorProviderError(
          `teams read supports 'conversations.members' (got op '${op}')`,
          400,
        );
      }
      if (!conversationId) {
        // NOT a silent promise, and not a guess: Microsoft's own conversation
        // operations table says `GET /v3/conversations` is supported only by
        // Direct Line and Web Chat, so there is no Teams-channel listing to
        // make the bare read mean anything. Refusing beats inventing.
        throw new ConnectorProviderError(
          "teams read requires an object (the conversation ID): the Bot Connector's 'get conversations' " +
            "endpoint is supported only on the Direct Line and Web Chat channels, so the Teams channel has no " +
            "connection-root listing to enumerate",
          400,
        );
      }
      method = "GET";
      apiPath = `/v3/conversations/${encodeURIComponent(conversationId)}/members`;
      label = "conversations.members";
    }

    // Step 1 (token) happens BEFORE the service call, so a credential failure
    // never opens a socket to the service host.
    const accessToken = await this.accessToken();

    const headers: Record<string, string> = {
      accept: "application/json",
      authorization: `Bearer ${accessToken}`,
    };
    if (body !== undefined) headers["content-type"] = "application/json; charset=utf-8";

    const res = await this.fetchImpl(`${this.base}${apiPath}`, {
      method,
      headers,
      ...(body !== undefined ? { body } : {}),
    });

    if (res.status === 429) {
      throw new ConnectorRateLimitError(
        `teams ${label} rate-limited (HTTP 429)`,
        retryAfterSeconds(res.headers),
        429,
      );
    }
    const text = await res.text();
    if (res.status < 200 || res.status >= 300) {
      // the Bot Connector's ErrorResponse: {"error":{"code":"…","message":"…"}}
      let code: string | null = null;
      try {
        const parsed = JSON.parse(text) as { error?: { code?: unknown } };
        if (parsed && typeof parsed === "object" && parsed.error && typeof parsed.error.code === "string") {
          code = parsed.error.code;
        }
      } catch {
        /* a non-JSON body is reported verbatim below */
      }
      throw new ConnectorProviderError(
        `teams ${label} failed: ${scrubSecrets(code ?? text, [this.cred.appPassword, accessToken])}`,
        res.status,
      );
    }
    return decodeBody(res.status, text);
  }
}

// ---------------------------------------------------------------------------
// GitHub adapter — the CONNECTOR data plane over the GitHub REST API (distinct
// from packages/git-provider, which is pillar 2's git_operation plane).
// Bearer token (fine-grained PAT / classic PAT / app installation token).
//
// Object semantics: `object` is an "owner/repo" slug — the natural unit an
// admin scopes a GitHub grant to via `allowedObjects`. Every repo-touching
// call derives its /repos/{owner}/{repo}/ prefix from `object`; issue/PR
// numbers inside the payload are repo-scoped by GitHub itself, so they cannot
// escape the authorized repo.
//
// Operation surface (representative):
//   read,  object=null                    → GET /user/repos (repos the token
//                                           can see — the connection-root read)
//   read,  object=o/r  (no op|"repo.get") → GET /repos/{o}/{r}
//   read,  op="issues.list"               → GET /repos/{o}/{r}/issues
//   read,  op="issues.get"  + number      → GET /repos/{o}/{r}/issues/{n}
//   read,  op="pulls.list"                → GET /repos/{o}/{r}/pulls
//   read,  op="pulls.get"   + number      → GET /repos/{o}/{r}/pulls/{n}
//   write, op="issues.create" (default)   → POST /repos/{o}/{r}/issues
//   write, op="issues.comment" + number   → POST /repos/{o}/{r}/issues/{n}/comments
//
// baseUrl override: defaults to https://api.github.com; a GitHub Enterprise
// Server host passes its API root (https://ghe.example.com/api/v3) as the
// connection baseUrl and every path is appended under it.
//
// Rate limiting: GitHub signals primary-limit exhaustion as **403 (or 429)
// with x-ratelimit-remaining: 0** — that shape maps to
// ConnectorRateLimitError (canonical 429), never a generic 403 failure.
// retry-after wins when present; otherwise x-ratelimit-reset (epoch seconds)
// minus now.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// ADR-0121 — OUTLOOK: the approval COURIER, and deliberately nothing more.
//
// Microsoft Graph `sendMail`, app-only. Two things about the shape are worth
// stating because they are decisions rather than defaults.
//
// THE TENANT IS REQUIRED, unlike Teams. The Bot Connector accepts a
// multi-tenant bot against `botframework.com`; Graph app-only has no such
// thing — a client-credentials token is minted for ONE tenant, and a
// credential without it could only ever be guessed at.
//
// READ IS REFUSED OUTRIGHT. `operation: "read"` on a mailbox means `GET
// /messages`, which is the whole mailbox. Nothing in an approval flow needs to
// read mail, and a connector that CAN read every message an approver has ever
// received is a vastly larger capability than one that can send one. A
// read-only grant on this provider therefore authorizes nothing, and the
// adapter says so rather than quietly offering a listing.
// ---------------------------------------------------------------------------

export const OUTLOOK_DEFAULT_GRAPH_BASE_URL = "https://graph.microsoft.com";
/** the Entra login host; sovereign clouds override it on the credential */
export const OUTLOOK_DEFAULT_LOGIN_BASE_URL = "https://login.microsoftonline.com";
/** the app-only scope Graph accepts for client credentials */
export const OUTLOOK_GRAPH_SCOPE = "https://graph.microsoft.com/.default";

export const outlookCredentialSchema = z
  .object({
    appId: z.string().min(1),
    appPassword: z.string().min(1),
    /** REQUIRED — see the header: Graph app-only is single-tenant by nature */
    tenantId: z.string().min(1),
    /** the mailbox the approval is SENT FROM (`/users/{senderUpn}/sendMail`) */
    senderUpn: z.string().min(1),
    loginBaseUrl: loginBaseUrlSchema.optional(),
  })
  .strict();
export type OutlookCredential = z.infer<typeof outlookCredentialSchema>;

export function parseOutlookCredential(token: string): OutlookCredential {
  let raw: unknown;
  try {
    raw = JSON.parse(token);
  } catch {
    throw new ConnectorProviderError(
      "outlook credential must be a JSON document {appId, appPassword, tenantId, senderUpn, loginBaseUrl?} " +
        "(the app registration plus the mailbox approvals are sent FROM, serialized then stored as the " +
        "connection's single token) — got a non-JSON token. A raw Graph bearer token is NOT accepted: it " +
        "expires in about an hour, so storing one would work once and then fail silently.",
      400,
    );
  }
  const parsed = outlookCredentialSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new ConnectorProviderError(
      `outlook credential JSON is invalid — expected {appId, appPassword, tenantId, senderUpn, loginBaseUrl?}: ${issues}`,
      400,
    );
  }
  return parsed.data;
}

export interface OutlookAdapterOptions {
  credential: OutlookCredential;
  /** the Graph base; defaults to the global endpoint */
  baseUrl?: string | null;
  fetchImpl?: FetchLike;
  /** the clock the token cache reads (tests); defaults to Date.now */
  now?: () => number;
}

// ---------------------------------------------------------------------------
// ADR-0121 amendment (ADR-0183 batch 2.6) — THE APP-ONLY TOKEN IS CACHED.
//
// The adapter used to mint a token per invoke ("nothing cached, nothing to
// revoke"). Once outlook became a real courier, every approval card and alert
// paid a second round trip to the Entra login host for a token that lives about
// an hour. The token is now cached in this process, and the revocation concern
// is answered rather than dropped:
//  - the KEY is a sha256 over the login host, tenant, client id AND client
//    secret, so rotating or replacing the credential in RegulAIt misses the
//    cache at once (and the secret itself is never a key, a log line or a value);
//  - an entry is used only while it has more than OUTLOOK_TOKEN_REFRESH_MARGIN_MS
//    left; inside the margin the next send mints a fresh one (refresh);
//  - Graph answering 401 (the token was revoked, or the app's consent withdrawn,
//    before its expiry) EVICTS the entry and the send is retried ONCE with a
//    freshly minted token — a 401 means nothing was sent, so the retry cannot
//    send twice;
//  - a token response with no usable `expires_in` is not cached at all;
//  - at most OUTLOOK_TOKEN_CACHE_MAX credentials are held (oldest evicted).
// A cached token is no stronger than a freshly minted one: Graph honours an
// app-only token until its own expiry whichever way it was obtained, so the
// cache adds no lifetime the token did not already have.
// Open-source check (ADR-0176): @azure/identity's ClientSecretCredential caches
// and refreshes, but makes its own HTTP calls through the Azure SDK pipeline
// (and an instance-discovery request), outside the injected egress-guarded
// fetch every request here must use; adapting it would need a custom pipeline
// HttpClient in a package that has no Azure dependency. The hard requirement it
// cannot meet is "every request URL adjudicated by the egress guard".
// ---------------------------------------------------------------------------

export const OUTLOOK_TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;
export const OUTLOOK_TOKEN_CACHE_MAX = 64;
// Keyed by the non-secret identifiers only. Nothing is derived from the client
// secret (no hash of it is ever computed); instead the entry remembers the
// secret it was minted with and a lookup only hits when the presented secret is
// equal (constant-time), so a rotated secret never reuses the old token.
const outlookTokenCache = new Map<string, { accessToken: string; expiresAtMs: number; appPassword: string }>();


/** forget every cached outlook token (tests; an operator-initiated reset) */
export function clearOutlookTokenCache(): void {
  outlookTokenCache.clear();
}


export const OUTLOOK_ERROR_DETAIL_MAX = 300;
/** Graph's `{error:{code,message}}` as one capped, scrubbed line (the scrub is
 * the shared `scrubSecrets`, applied before the cap) */
export function graphErrorDetail(text: string, status: number, secrets: readonly string[] = []): string {
  let line = `HTTP ${status}`;
  try {
    const e = (JSON.parse(text) as { error?: { code?: unknown; message?: unknown } }).error;
    if (e && typeof e === "object") {
      line = `HTTP ${status} ${typeof e.code === "string" ? e.code : ""}: ${typeof e.message === "string" ? e.message : ""}`;
    }
  } catch {
    line = `HTTP ${status}: ${text}`;
  }
  const clean = scrubSecrets(line.replace(/[\r\n\t]+/g, " "), secrets);
  return clean.length > OUTLOOK_ERROR_DETAIL_MAX ? `${clean.slice(0, OUTLOOK_ERROR_DETAIL_MAX)}…` : clean;
}

export class OutlookConnectorProvider implements ConnectorProvider {
  readonly kind = "outlook" as const;
  private readonly base: string;
  private readonly login: string;
  private readonly cred: OutlookCredential;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly cacheKey: string;

  constructor(opts: OutlookAdapterOptions) {
    this.base = (opts.baseUrl ?? OUTLOOK_DEFAULT_GRAPH_BASE_URL).replace(/\/$/, "");
    this.cred = opts.credential;
    this.login = (opts.credential.loginBaseUrl ?? OUTLOOK_DEFAULT_LOGIN_BASE_URL).replace(/\/$/, "");
    this.fetchImpl = opts.fetchImpl ?? (fetch as unknown as FetchLike);
    this.now = opts.now ?? Date.now;
    this.cacheKey = JSON.stringify([this.login, this.cred.tenantId, this.cred.appId]);
  }

  /** A cached token while it has more than the refresh margin left, else a
   * freshly minted one (see the cache header above). */
  private async accessToken(): Promise<{ token: string; fromCache: boolean }> {
    const cached = outlookTokenCache.get(this.cacheKey);
    if (
      cached &&
      constantTimeEqual(cached.appPassword, this.cred.appPassword) &&
      cached.expiresAtMs - OUTLOOK_TOKEN_REFRESH_MARGIN_MS > this.now()
    ) {
      return { token: cached.accessToken, fromCache: true };
    }
    outlookTokenCache.delete(this.cacheKey);
    return { token: await this.mintAccessToken(), fromCache: false };
  }

  /** The client-credentials exchange. It goes through the SAME `fetchImpl` as
   * the send, so the login host is egress-adjudicated too. */
  private async mintAccessToken(): Promise<string> {
    const url = `${this.login}/${encodeURIComponent(this.cred.tenantId)}/oauth2/v2.0/token`;
    const form = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.cred.appId,
      client_secret: this.cred.appPassword,
      scope: OUTLOOK_GRAPH_SCOPE,
    });
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: form.toString(),
    });
    const text = await res.text();
    if (res.status === 429) {
      throw new ConnectorProviderError(
        "outlook token request rate-limited by the Microsoft Entra login service (HTTP 429)",
        429,
      );
    }
    if (res.status >= 400) {
      throw new ConnectorProviderError(
        `outlook token request failed: ${tokenErrorDetail(text, res.status, [this.cred.appPassword])}`,
        res.status,
      );
    }
    const decoded = decodeBody(res.status, text).body as { access_token?: unknown; expires_in?: unknown } | null;
    const token = decoded && typeof decoded === "object" ? decoded.access_token : null;
    if (typeof token !== "string" || !token) {
      throw new ConnectorProviderError(
        "outlook token response carried no access_token — refusing to send with no credential",
        502,
      );
    }
    const expiresIn = decoded && typeof decoded === "object" ? Number(decoded.expires_in) : NaN;
    if (Number.isFinite(expiresIn) && expiresIn > 0) {
      if (outlookTokenCache.size >= OUTLOOK_TOKEN_CACHE_MAX) {
        const oldest = outlookTokenCache.keys().next().value;
        if (oldest !== undefined) outlookTokenCache.delete(oldest);
      }
      outlookTokenCache.set(this.cacheKey, {
        accessToken: token,
        expiresAtMs: this.now() + expiresIn * 1000,
        appPassword: this.cred.appPassword,
      });
    }
    return token;
  }

  async invoke(invocation: ConnectorInvocation): Promise<ConnectorInvokeResult> {
    const payload = invocation.payload ?? {};
    const op = typeof payload.op === "string" ? payload.op : null;
    const recipient = invocation.object ?? null;

    if (invocation.operation !== "write") {
      throw new ConnectorProviderError(
        "outlook is send-only: `operation: 'read'` on a mailbox means reading the mailbox, which is a far " +
          "larger capability than delivering one approval and is not needed to deliver one. A read-only " +
          "grant on this connector authorizes nothing.",
        400,
      );
    }
    if (op !== null && op !== "sendMail") {
      throw new ConnectorProviderError(
        `outlook write supports 'sendMail' (got op '${op}')`,
        400,
      );
    }
    if (!recipient) {
      throw new ConnectorProviderError(
        "outlook write requires an object (the recipient mailbox address) — a message with no recipient is meaningless",
        400,
      );
    }

    // THE RECIPIENT COMES FROM THE GOVERNED OBJECT, NEVER THE PAYLOAD. The
    // destructure drops any caller-supplied recipients before the spread, so a
    // crafted payload cannot redirect an approval to another mailbox — the same
    // defence the Teams adapter applies to `conversation.id`.
    const { op: _op, toRecipients: _to, ccRecipients: _cc, bccRecipients: _bcc, ...message } = payload;
    const body = JSON.stringify({
      message: {
        ...message,
        toRecipients: [{ emailAddress: { address: recipient } }],
      },
      // An approval that was sent is a fact the operator's own mailbox should
      // carry too, so it is not silently absent from Sent Items.
      saveToSentItems: true,
    });

    // Token first, so a credential failure never opens a socket to Graph.
    const url = `${this.base}/v1.0/users/${encodeURIComponent(this.cred.senderUpn)}/sendMail`;
    const send = async (accessToken: string) =>
      this.fetchImpl(url, {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json",
        },
        body,
      });
    const first = await this.accessToken();
    // X19-S01: every credential this send put on the wire, for the scrub below
    const sentTokens = [first.token];
    let res = await send(first.token);
    if (res.status === 401) {
      // the token was refused: it is never reused. A CACHED one refused before
      // its expiry (revoked, consent withdrawn) is retried ONCE with a freshly
      // minted token — a 401 sent nothing, so the retry cannot send twice. A
      // fresh token refused is the answer, and is reported below.
      outlookTokenCache.delete(this.cacheKey);
      if (first.fromCache) {
        await res.text();
        const fresh = await this.mintAccessToken();
        sentTokens.push(fresh);
        res = await send(fresh);
        if (res.status === 401) outlookTokenCache.delete(this.cacheKey);
      }
    }
    const text = await res.text();
    const decoded = decodeBody(res.status, text);
    if (res.status === 429) {
      throw new ConnectorProviderError("outlook sendMail rate-limited by Microsoft Graph (HTTP 429)", 429);
    }
    if (res.status >= 400) {
      // ADR-0183 batch 2 review (L2): the caller sees Graph's error CODE and a
      // capped, scrubbed message; the whole body goes to the server log only.
      // X19-S01: both sinks use the ONE scrub with the same credentials, so a
      // JSON-escaped reflection is no more visible in the log than in the detail
      const secrets = [this.cred.appPassword, ...sentTokens];
      console.error(`[outlook] sendMail HTTP ${res.status}: ${scrubSecrets(text, secrets)}`);
      throw new ConnectorProviderError(`outlook sendMail failed: ${graphErrorDetail(text, res.status, secrets)}`, res.status);
    }
    // Graph answers 202 with an EMPTY body on success. Reporting that honestly
    // matters: "accepted for delivery" is not "delivered", and the adapter does
    // not have, and must not imply, delivery confirmation.
    return {
      status: res.status,
      body: decoded.body ?? { accepted: true, op: "sendMail", recipient },
    };
  }
}

export const GITHUB_DEFAULT_BASE_URL = "https://api.github.com";

export interface GitHubAdapterOptions {
  /** PAT or installation token, sent as `Authorization: Bearer` */
  token: string;
  /** defaults to https://api.github.com; set your GHE API root (…/api/v3) to override */
  baseUrl?: string | null;
  fetchImpl?: FetchLike;
}

export class GitHubConnectorProvider implements ConnectorProvider {
  readonly kind = "github" as const;
  private readonly base: string;
  private readonly token: string;
  private readonly fetchImpl: FetchLike;

  constructor(opts: GitHubAdapterOptions) {
    this.base = (opts.baseUrl ?? GITHUB_DEFAULT_BASE_URL).replace(/\/$/, "");
    this.token = opts.token;
    this.fetchImpl = opts.fetchImpl ?? (fetch as unknown as FetchLike);
  }

  private headers(withBody: boolean): Record<string, string> {
    const h: Record<string, string> = {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      authorization: `Bearer ${this.token}`,
    };
    if (withBody) h["content-type"] = "application/json";
    return h;
  }

  /** "owner/repo" → validated slug; anything else is a caller error, not an upstream one */
  private repoPath(object: string | null): string {
    if (!object || !/^[^/\s]+\/[^/\s]+$/.test(object)) {
      throw new ConnectorProviderError(
        `github object must be an "owner/repo" slug (got ${object === null ? "none" : `'${object}'`})`,
        400,
      );
    }
    return `/repos/${object}`;
  }

  private issueNumber(payload: Record<string, unknown>, op: string): number {
    const n = payload.number;
    if (typeof n !== "number" || !Number.isInteger(n) || n <= 0) {
      throw new ConnectorProviderError(`github ${op} requires payload.number (a positive integer)`, 400);
    }
    return n;
  }

  async invoke(invocation: ConnectorInvocation): Promise<ConnectorInvokeResult> {
    const payload = invocation.payload ?? {};
    const op = typeof payload.op === "string" ? payload.op : null;
    const object = invocation.object ?? null;

    let method: string;
    let path: string;
    let body: string | undefined;

    if (invocation.operation === "write") {
      const repo = this.repoPath(object);
      if (op === null || op === "issues.create") {
        if (typeof payload.title !== "string" || !payload.title) {
          throw new ConnectorProviderError("github issues.create requires payload.title", 400);
        }
        method = "POST";
        path = `${repo}/issues`;
        body = JSON.stringify({
          title: payload.title,
          ...(payload.body !== undefined ? { body: payload.body } : {}),
          ...(payload.labels !== undefined ? { labels: payload.labels } : {}),
          ...(payload.assignees !== undefined ? { assignees: payload.assignees } : {}),
        });
      } else if (op === "issues.comment") {
        const n = this.issueNumber(payload, op);
        if (typeof payload.body !== "string" || !payload.body) {
          throw new ConnectorProviderError("github issues.comment requires payload.body", 400);
        }
        method = "POST";
        path = `${repo}/issues/${n}/comments`;
        body = JSON.stringify({ body: payload.body });
      } else {
        throw new ConnectorProviderError(
          `github write supports 'issues.create', 'issues.comment' (got op '${op}')`,
          400,
        );
      }
    } else if (object === null) {
      if (op !== null) {
        throw new ConnectorProviderError(
          `github read op '${op}' requires an object (an "owner/repo" slug)`,
          400,
        );
      }
      method = "GET";
      path = "/user/repos";
    } else {
      const repo = this.repoPath(object);
      method = "GET";
      switch (op) {
        case null:
        case "repo.get":
          path = repo;
          break;
        case "issues.list":
          path = `${repo}/issues${query({
            state: typeof payload.state === "string" ? payload.state : undefined,
            per_page: typeof payload.per_page === "number" ? payload.per_page : undefined,
            page: typeof payload.page === "number" ? payload.page : undefined,
          })}`;
          break;
        case "issues.get":
          path = `${repo}/issues/${this.issueNumber(payload, op)}`;
          break;
        case "pulls.list":
          path = `${repo}/pulls${query({
            state: typeof payload.state === "string" ? payload.state : undefined,
            per_page: typeof payload.per_page === "number" ? payload.per_page : undefined,
            page: typeof payload.page === "number" ? payload.page : undefined,
          })}`;
          break;
        case "pulls.get":
          path = `${repo}/pulls/${this.issueNumber(payload, op)}`;
          break;
        default:
          throw new ConnectorProviderError(
            `github read supports 'repo.get', 'issues.list', 'issues.get', 'pulls.list', 'pulls.get' (got op '${op}')`,
            400,
          );
      }
    }

    const url = `${this.base}${path}`;
    const res = await this.fetchImpl(url, {
      method,
      headers: this.headers(body !== undefined),
      ...(body !== undefined ? { body } : {}),
    });

    // GitHub's rate-limit shape: 429, or 403 with x-ratelimit-remaining: 0
    const remaining = res.headers?.get("x-ratelimit-remaining");
    if (res.status === 429 || (res.status === 403 && remaining === "0")) {
      let wait = retryAfterSeconds(res.headers);
      if (wait === undefined) {
        const reset = res.headers?.get("x-ratelimit-reset");
        if (reset) {
          const resetEpoch = Number.parseInt(reset, 10);
          if (Number.isFinite(resetEpoch)) {
            wait = Math.max(0, resetEpoch - Math.floor(Date.now() / 1000));
          }
        }
      }
      throw new ConnectorRateLimitError(
        `github ${method} ${path} rate-limited (HTTP ${res.status}, x-ratelimit-remaining=${remaining ?? "?"})`,
        wait,
        res.status,
      );
    }
    const text = await res.text();
    if (res.status < 200 || res.status >= 300) {
      // GitHub error bodies carry a `message` — surface it, not the raw JSON.
      // Note: a token that cannot see a repo gets a 404 (GitHub hides
      // existence), so "scope-denied at the upstream" surfaces here as 404/403
      // with GitHub's own message.
      let detail = text;
      try {
        const parsed = JSON.parse(text) as { message?: string };
        if (parsed && typeof parsed.message === "string") detail = parsed.message;
      } catch {
        /* keep raw text */
      }
      // X19-S01: scrubbed of the token the request carried
      throw new ConnectorProviderError(`github ${method} ${path} failed: ${scrubSecrets(detail, [this.token])}`, res.status);
    }
    return decodeBody(res.status, text);
  }
}

// ---------------------------------------------------------------------------
// Jira adapter — Jira REST API v2 (plain-string fields) on the connection's
// baseUrl (https://<site>.atlassian.net or a self-hosted Jira base).
//
// Credential format: the connection's single `token` is the Jira Cloud Basic
// convention **"email:api_token"** (e.g. "jane@corp.com:ATATT3xFf…") — the
// adapter base64s the whole string into `Authorization: Basic …`, exactly as
// the pm-provider Jira adapter does. A token with no ":" is rejected at
// construction with an actionable message rather than producing opaque 401s.
//
// Object semantics: `object` is a PROJECT KEY (e.g. "PLAT") — the natural unit
// an admin scopes a Jira grant to via `allowedObjects`. Search is forced to
// `project = "<key>"` (caller JQL is ANDed inside it, never replacing it), and
// issue-keyed ops (get/comment) require the issue key to carry the authorized
// project's prefix — an issue from another project is refused locally, before
// any network call, so an authorized object can never be used to reach past
// itself.
//
// Operation surface (representative):
//   read,  object=null                    → GET /rest/api/2/project (the
//                                           connection-root read: list projects)
//   read,  object=KEY (no op|"issues.search")
//                                         → GET /rest/api/2/search?jql=project = "KEY"
//                                           (payload.jql ANDed, payload.maxResults honored)
//   read,  op="issue.get"    + key        → GET /rest/api/2/issue/{key}
//   write, op="issue.create" (default)    → POST /rest/api/2/issue
//                                           (fields.project.key forced to `object`)
//   write, op="issue.comment" + key+body  → POST /rest/api/2/issue/{key}/comment
//
// Error taxonomy: Jira failures carry the error-collection body
// `{errorMessages: string[], errors: {field: string}}` — both halves are
// flattened into one actionable message ("summary: You must specify a
// summary") instead of surfacing raw JSON. 429 + Retry-After maps to
// ConnectorRateLimitError.
// ---------------------------------------------------------------------------

export interface JiraAdapterOptions {
  /** the Jira site root, e.g. https://yourco.atlassian.net */
  baseUrl: string;
  /** "email:api_token" (Jira Cloud Basic-auth convention) */
  token: string;
  fetchImpl?: FetchLike;
}

export class JiraConnectorProvider implements ConnectorProvider {
  readonly kind = "jira" as const;
  private readonly base: string;
  private readonly auth: string;
  private readonly secrets: string[];
  private readonly fetchImpl: FetchLike;

  constructor(opts: JiraAdapterOptions) {
    if (!opts.token.includes(":")) {
      throw new ConnectorProviderError(
        "jira token must be 'email:api_token' (Jira Cloud Basic-auth convention) — got a token with no ':'",
        400,
      );
    }
    this.base = opts.baseUrl.replace(/\/$/, "");
    const encoded = Buffer.from(opts.token).toString("base64");
    this.auth = `Basic ${encoded}`;
    // the whole "email:api_token", the API token alone, and the header value
    // (X19-S01) — the email alone is not a secret and is not scrubbed
    this.secrets = [opts.token, opts.token.slice(opts.token.indexOf(":") + 1), encoded];
    this.fetchImpl = opts.fetchImpl ?? (fetch as unknown as FetchLike);
  }

  private headers(withBody: boolean): Record<string, string> {
    const h: Record<string, string> = { accept: "application/json", authorization: this.auth };
    if (withBody) h["content-type"] = "application/json";
    return h;
  }

  /** issue-keyed ops must stay inside the authorized project — checked locally,
   * before any network call, mirroring how the object bounds search/create */
  private issueKey(payload: Record<string, unknown>, project: string | null, op: string): string {
    const key = payload.key;
    if (typeof key !== "string" || !/^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(key)) {
      throw new ConnectorProviderError(
        `jira ${op} requires payload.key (an issue key like "PLAT-42")`,
        400,
      );
    }
    if (project !== null && !key.toUpperCase().startsWith(`${project.toUpperCase()}-`)) {
      throw new ConnectorProviderError(
        `jira ${op} on '${key}' is outside the authorized project '${project}' — refused before any upstream call`,
        403,
      );
    }
    return key;
  }

  async invoke(invocation: ConnectorInvocation): Promise<ConnectorInvokeResult> {
    const payload = invocation.payload ?? {};
    const op = typeof payload.op === "string" ? payload.op : null;
    const project = invocation.object ?? null;

    let method: string;
    let path: string;
    let body: string | undefined;

    if (invocation.operation === "write") {
      if (!project) {
        throw new ConnectorProviderError(
          "jira write requires an object (the target project key)",
          400,
        );
      }
      if (op === null || op === "issue.create") {
        if (typeof payload.summary !== "string" || !payload.summary) {
          throw new ConnectorProviderError("jira issue.create requires payload.summary", 400);
        }
        method = "POST";
        path = "/rest/api/2/issue";
        body = JSON.stringify({
          fields: {
            // the governed object is authoritative — a payload-supplied project
            // could not widen scope anyway, so we simply never read one
            project: { key: project },
            summary: payload.summary,
            issuetype: { name: typeof payload.issuetype === "string" ? payload.issuetype : "Task" },
            ...(typeof payload.description === "string" ? { description: payload.description } : {}),
          },
        });
      } else if (op === "issue.comment") {
        const key = this.issueKey(payload, project, op);
        if (typeof payload.body !== "string" || !payload.body) {
          throw new ConnectorProviderError("jira issue.comment requires payload.body", 400);
        }
        method = "POST";
        path = `/rest/api/2/issue/${key}/comment`;
        body = JSON.stringify({ body: payload.body });
      } else {
        throw new ConnectorProviderError(
          `jira write supports 'issue.create', 'issue.comment' (got op '${op}')`,
          400,
        );
      }
    } else if (op === "issue.get") {
      const key = this.issueKey(payload, project, op);
      method = "GET";
      path = `/rest/api/2/issue/${key}`;
    } else if (op !== null && op !== "issues.search") {
      throw new ConnectorProviderError(
        `jira read supports 'issues.search', 'issue.get' (got op '${op}')`,
        400,
      );
    } else if (project === null) {
      method = "GET";
      path = "/rest/api/2/project";
    } else {
      // scoped JQL search: the project clause comes from the governed object;
      // caller-supplied JQL narrows WITHIN it (parenthesized AND), never widens
      const scoped = `project = "${project.replace(/"/g, "")}"`;
      const extra = typeof payload.jql === "string" && payload.jql ? ` AND (${payload.jql})` : "";
      method = "GET";
      path = `/rest/api/2/search${query({
        jql: `${scoped}${extra}`,
        maxResults: typeof payload.maxResults === "number" ? payload.maxResults : undefined,
        startAt: typeof payload.startAt === "number" ? payload.startAt : undefined,
      })}`;
    }

    const url = `${this.base}${path}`;
    const res = await this.fetchImpl(url, {
      method,
      headers: this.headers(body !== undefined),
      ...(body !== undefined ? { body } : {}),
    });

    if (res.status === 429) {
      throw new ConnectorRateLimitError(
        `jira ${method} ${path} rate-limited (HTTP 429)`,
        retryAfterSeconds(res.headers),
        429,
      );
    }
    const text = await res.text();
    if (res.status < 200 || res.status >= 300) {
      // flatten Jira's error-collection body into one actionable line
      let detail = text;
      try {
        const parsed = JSON.parse(text) as {
          errorMessages?: unknown;
          errors?: Record<string, unknown>;
        };
        const parts: string[] = [];
        if (Array.isArray(parsed.errorMessages)) {
          parts.push(...parsed.errorMessages.filter((m): m is string => typeof m === "string"));
        }
        if (parsed.errors && typeof parsed.errors === "object") {
          for (const [field, msg] of Object.entries(parsed.errors)) {
            parts.push(`${field}: ${String(msg)}`);
          }
        }
        if (parts.length > 0) detail = parts.join("; ");
      } catch {
        /* keep raw text */
      }
      // X19-S01: scrubbed of the Basic credential in each form it took
      throw new ConnectorProviderError(`jira ${method} ${path} failed: ${scrubSecrets(detail, this.secrets)}`, res.status);
    }
    return decodeBody(res.status, text);
  }
}

// ---------------------------------------------------------------------------
// Snowflake adapter — the Snowflake SQL API v2 (POST /api/v2/statements) with
// key-pair JWT auth (ADR-0023).
//
// Credential format (ADR-0023's structured-JSON-inside-the-single-ciphertext
// convention): the connection's single `token` is a JSON document
//   {"account":"myorg-acct","user":"SVC_REGULAIT","privateKey":"-----BEGIN…",
//    "passphrase":"…"?}
// serialized then encrypted exactly like every other connector token — ZERO
// migration for the credential, and any future multi-field connector gets the
// same convention for free. `parseSnowflakeCredential` validates the shape
// with an actionable message; the gateway calls it at connection-create time
// for kind=snowflake so a malformed credential 400s at write, not at first
// invoke.
//
// Auth: RS256 key-pair JWT against the SQL API. Claims follow Snowflake's
// fingerprint convention: with Q = UPPER(account).UPPER(user) and fp =
// "SHA256:" + base64(sha256(DER-SPKI public key derived from the private
// key)), the token carries iss = "Q.fp", sub = "Q", iat = now, exp = now+300s
// (one short-lived token per invoke — nothing cached, nothing to revoke). Sent
// as `Authorization: Bearer` + `X-Snowflake-Authorization-Token-Type:
// KEYPAIR_JWT`.
//
// Object semantics: `object` is a **"DATABASE.SCHEMA" pair** (e.g.
// "ANALYTICS.PUBLIC") — the governed unit an admin scopes a Snowflake grant to
// via `allowedObjects`. Chosen over a warehouse because a warehouse is COMPUTE
// (which cluster burns credits), not DATA REACH — pillar 1's object scope
// exists to bound what data a user can touch, and database.schema is
// Snowflake's own containment unit for that (the analogue of owner/repo and
// the Jira project key). The warehouse rides `payload.warehouse` as a plain
// execution parameter. Every statement is submitted with the SQL API's
// `database`/`schema` fields taken from `object` — never from the payload — so
// unqualified names in caller SQL resolve inside the authorized scope.
//
// Operation surface:
//   read,  object=null                → SHOW DATABASES (the connection-root
//                                       read, mirroring the other adapters'
//                                       bare read; adapter-generated SQL)
//   read,  object=DB.SCHEMA
//          + payload.statement        → the statement, submitted with
//                                       database/schema from the object
//                                       (payload.warehouse / payload.timeout
//                                       forwarded when present)
//   write, object=DB.SCHEMA (required)
//          + payload.statement        → same submission; mutating statements
//
// STATEMENT-LEVEL GUARD — defense-in-depth, NOT a SQL parser: the adapter
// (a) rejects multi-statement submissions (any ';' beyond an optional trailing
// one) and never sends MULTI_STATEMENT_COUNT, so the SQL API's own
// single-statement default is the real backstop; and (b) requires the
// statement's first keyword to match the op class — read: SELECT / WITH /
// SHOW / DESCRIBE (non-mutating), write: INSERT / UPDATE (the mutating surface
// this slice supports; DELETE/DDL are deliberately not offered). A ';' inside
// a string literal is a false-positive rejection and a mutating statement
// smuggled past the keyword check (e.g. via a CTE) is ultimately bounded by
// the stored credential's own Snowflake role — which is why the ADR records
// this guard as defense-in-depth on top of pillar-1 scoping + least-privilege
// upstream roles, not as a parser. Fully-qualified names in caller SQL can
// name other databases; the same upstream role bound applies (see ADR-0023).
//
// Rate limiting: the SQL API answers HTTP 429 — mapped to
// ConnectorRateLimitError with Retry-After when present, never a generic
// failure. Other non-2xx bodies carry {message, code} — flattened into one
// actionable line.
// ---------------------------------------------------------------------------

/** ADR-0023 structured-JSON credential for kind=snowflake (the whole document
 * is what gets encrypted into connector_credentials.token_ciphertext). */
export const snowflakeCredentialSchema = z
  .object({
    /** account identifier, e.g. "myorg-acct123" (no .snowflakecomputing.com).
     * ADR-0167 (SEC-01): it becomes a HOSTNAME LABEL, so it is one — a `/`,
     * `?`, `@` or `:` here would let the field choose a different host or
     * path than `<account>.snowflakecomputing.com`. */
    account: z
      .string()
      .min(1)
      .max(255)
      .regex(/^[A-Za-z0-9_.-]+$/, "account must be a hostname label: letters, digits, '_', '.' and '-' only"),
    /** the Snowflake user the key pair is registered to */
    user: z.string().min(1),
    /** PEM-encoded RSA private key (PKCS#8 "BEGIN PRIVATE KEY" or encrypted
     * "BEGIN ENCRYPTED PRIVATE KEY") */
    privateKey: z.string().min(1),
    /** passphrase for an encrypted private key; omit for an unencrypted one */
    passphrase: z.string().min(1).optional(),
  })
  .strict();

export type SnowflakeCredential = z.infer<typeof snowflakeCredentialSchema>;

/** Parse + validate the JSON credential convention with ACTIONABLE failures
 * (400): not-JSON, wrong shape, and unknown extra fields each get a message
 * that says what to send instead. The gateway calls this at connection-create
 * time for kind=snowflake; the registry calls it again at invoke time (the
 * stored credential predating validation must still fail explicit). */
export function parseSnowflakeCredential(token: string): SnowflakeCredential {
  let raw: unknown;
  try {
    raw = JSON.parse(token);
  } catch {
    throw new ConnectorProviderError(
      "snowflake credential must be a JSON document {account, user, privateKey, passphrase?} " +
        "(serialized then stored as the connection's single token) — got a non-JSON token",
      400,
    );
  }
  const parsed = snowflakeCredentialSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new ConnectorProviderError(
      `snowflake credential JSON is invalid — expected {account, user, privateKey, passphrase?}: ${issues}`,
      400,
    );
  }
  return parsed.data;
}

/** exported for tests: the RS256 key-pair JWT (Snowflake fingerprint claim
 * convention). `nowMs` is injectable so tests can pin iat/exp. */
export function buildSnowflakeJwt(cred: SnowflakeCredential, nowMs = Date.now()): string {
  let privateKey;
  try {
    privateKey = createPrivateKey(
      cred.passphrase ? { key: cred.privateKey, passphrase: cred.passphrase } : cred.privateKey,
    );
  } catch (err) {
    throw new ConnectorProviderError(
      "snowflake privateKey could not be parsed — provide a PEM RSA private key " +
        "(PKCS#8), and the matching passphrase when it is encrypted: " +
        (err instanceof Error ? err.message : String(err)),
      400,
    );
  }
  // Snowflake's public-key fingerprint: SHA256 over the DER-encoded SPKI
  // public key derived from the private key, base64, "SHA256:"-prefixed.
  // (Round-trips through an unencrypted in-memory PEM because the installed
  // @types/node signature for createPublicKey doesn't accept a KeyObject.)
  const spki = createPublicKey(privateKey.export({ type: "pkcs8", format: "pem" }) as string).export(
    { type: "spki", format: "der" },
  );
  const fingerprint = `SHA256:${createHash("sha256").update(spki).digest("base64")}`;
  const qualified = `${cred.account.toUpperCase()}.${cred.user.toUpperCase()}`;
  const now = Math.floor(nowMs / 1000);
  const b64url = (obj: unknown) =>
    Buffer.from(JSON.stringify(obj)).toString("base64url");
  const signingInput = `${b64url({ alg: "RS256", typ: "JWT" })}.${b64url({
    iss: `${qualified}.${fingerprint}`,
    sub: qualified,
    iat: now,
    exp: now + 300, // one short-lived token per invoke
  })}`;
  const signature = createSign("RSA-SHA256")
    .update(signingInput)
    .sign(privateKey)
    .toString("base64url");
  return `${signingInput}.${signature}`;
}

/** first keyword per op class — see the STATEMENT-LEVEL GUARD comment above */
const SNOWFLAKE_READ_VERBS = ["SELECT", "WITH", "SHOW", "DESCRIBE"] as const;
const SNOWFLAKE_WRITE_VERBS = ["INSERT", "UPDATE"] as const;

export interface SnowflakeAdapterOptions {
  credential: SnowflakeCredential;
  /** defaults to https://<account>.snowflakecomputing.com; override for tests/proxies */
  baseUrl?: string | null;
  fetchImpl?: FetchLike;
}

export class SnowflakeConnectorProvider implements ConnectorProvider {
  readonly kind = "snowflake" as const;
  private readonly base: string;
  private readonly credential: SnowflakeCredential;
  private readonly fetchImpl: FetchLike;

  constructor(opts: SnowflakeAdapterOptions) {
    this.credential = opts.credential;
    this.base = (
      opts.baseUrl ?? `https://${opts.credential.account.toLowerCase()}.snowflakecomputing.com`
    ).replace(/\/$/, "");
    this.fetchImpl = opts.fetchImpl ?? (fetch as unknown as FetchLike);
  }

  /** "DATABASE.SCHEMA" → validated pair; anything else is a caller error */
  private objectScope(object: string | null): { database: string; schema: string } {
    const m = object === null ? null : /^([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)$/.exec(object);
    if (!m) {
      throw new ConnectorProviderError(
        `snowflake object must be a "DATABASE.SCHEMA" pair (got ${object === null ? "none" : `'${object}'`})`,
        400,
      );
    }
    return { database: m[1]!, schema: m[2]! };
  }

  /** the statement-level guard: single statement, op-class first keyword */
  private guardStatement(operation: "read" | "write", statement: string): string {
    const trimmed = statement.trim().replace(/;$/, "").trim();
    if (!trimmed) {
      throw new ConnectorProviderError("snowflake payload.statement is empty", 400);
    }
    if (trimmed.includes(";")) {
      throw new ConnectorProviderError(
        "snowflake rejects multi-statement submissions — one statement per governed call " +
          "(defense-in-depth; the SQL API's single-statement default is the backstop)",
        400,
      );
    }
    const verbs = operation === "read" ? SNOWFLAKE_READ_VERBS : SNOWFLAKE_WRITE_VERBS;
    const first = (trimmed.match(/^[A-Za-z]+/) ?? [""])[0].toUpperCase();
    if (!(verbs as readonly string[]).includes(first)) {
      throw new ConnectorProviderError(
        `snowflake ${operation} allows statements starting with ${verbs.join("/")} ` +
          `(got '${first || trimmed.slice(0, 20)}') — a ${operation === "read" ? "mutating" : "non-mutating"} ` +
          `statement must not ride operation:"${operation}"`,
        400,
      );
    }
    return trimmed;
  }

  async invoke(invocation: ConnectorInvocation): Promise<ConnectorInvokeResult> {
    const payload = invocation.payload ?? {};

    let body: Record<string, unknown>;
    if (invocation.operation === "read" && invocation.object == null) {
      // the connection-root read — adapter-generated, non-mutating by
      // construction; caller-supplied SQL without an object is refused (the
      // object is where the governed scope lives)
      if (typeof payload.statement === "string") {
        throw new ConnectorProviderError(
          'snowflake read with a statement requires an object (the governed "DATABASE.SCHEMA" scope)',
          400,
        );
      }
      body = { statement: "SHOW DATABASES" };
    } else {
      const scope = this.objectScope(invocation.object ?? null);
      if (typeof payload.statement !== "string") {
        throw new ConnectorProviderError(
          `snowflake ${invocation.operation} requires payload.statement (the SQL to run)`,
          400,
        );
      }
      const statement = this.guardStatement(invocation.operation, payload.statement);
      body = {
        statement,
        // the governed object is authoritative for the session scope — the
        // payload never carries database/schema, so it cannot widen them
        database: scope.database,
        schema: scope.schema,
        ...(typeof payload.warehouse === "string" && payload.warehouse
          ? { warehouse: payload.warehouse }
          : {}),
        ...(typeof payload.timeout === "number" ? { timeout: payload.timeout } : {}),
      };
    }

    const url = `${this.base}/api/v2/statements`;
    const jwt = buildSnowflakeJwt(this.credential);
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        authorization: `Bearer ${jwt}`,
        "x-snowflake-authorization-token-type": "KEYPAIR_JWT",
      },
      body: JSON.stringify(body),
    });

    if (res.status === 429) {
      throw new ConnectorRateLimitError(
        "snowflake POST /api/v2/statements rate-limited (HTTP 429)",
        retryAfterSeconds(res.headers),
        429,
      );
    }
    const text = await res.text();
    if (res.status < 200 || res.status >= 300) {
      // SQL API error bodies carry {message, code} — surface both, not raw
      // JSON; and a NON-JSON body is withheld rather than echoed (ADR-0167):
      // the account host is admin-typed, so its response is not ours to relay
      let detail = `HTTP ${res.status} (${text.length}-byte non-JSON response body withheld)`;
      try {
        const parsed = JSON.parse(text) as { message?: string; code?: string };
        if (parsed && typeof parsed.message === "string") {
          const message = parsed.message.slice(0, 500);
          detail = parsed.code ? `${message} (code ${parsed.code})` : message;
        }
      } catch {
        /* not JSON: the coarse line above stands */
      }
      // X19-S01: scrubbed of the key-pair JWT the request carried
      throw new ConnectorProviderError(
        `snowflake POST /api/v2/statements failed: ${scrubSecrets(detail, [jwt])}`,
        res.status,
      );
    }
    return decodeBody(res.status, text);
  }
}

// ---------------------------------------------------------------------------
// Mock adapter — in-memory, keyless, deterministic: for tests and air-gapped
// development. `read` returns a canned object keyed by the requested object;
// `write` records the payload and echoes it back. The whole execution layer is
// demoable and testable with zero external keys and zero network.
// ---------------------------------------------------------------------------

export class MockConnectorProvider implements ConnectorProvider {
  readonly kind = "mock" as const;
  /** every write, in order — inspectable by tests */
  readonly writes: Array<{ object: string | null; payload: Record<string, unknown> }> = [];

  async invoke(invocation: ConnectorInvocation): Promise<ConnectorInvokeResult> {
    const object = invocation.object ?? null;
    if (invocation.operation === "write") {
      const payload = invocation.payload ?? {};
      this.writes.push({ object, payload });
      return { status: 200, body: { ok: true, operation: "write", object, echoed: payload } };
    }
    // deterministic canned read — a stable shape keyed by the object name so a
    // demo/test can assert an exact body with no external system
    return {
      status: 200,
      body: {
        object: object ?? "root",
        records: [
          { id: `${object ?? "root"}-1`, name: `mock ${object ?? "root"} #1` },
          { id: `${object ?? "root"}-2`, name: `mock ${object ?? "root"} #2` },
        ],
        source: "mock-connector",
      },
    };
  }

  /** test helper: forget every recorded write */
  reset(): void {
    this.writes.length = 0;
  }
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export interface ConnectorProviderConfig {
  kind: ConnectorProviderKind;
  /** connection root / receiver endpoint; required for generic/http/webhook */
  baseUrl?: string | null;
  /** bearer credential; keyless kinds (mock, unauthenticated generic) omit it */
  token?: string | null;
}

/** validates the persisted provider config before an adapter is built */
export const connectorProviderConfigSchema = z.object({
  kind: z.enum(CONNECTOR_PROVIDER_KINDS),
  baseUrl: z.string().url().nullable().optional(),
  token: z.string().min(1).nullable().optional(),
});

/** shared mock instance so recorded writes persist across resolutions in one
 * process (mirrors pm-provider's sharedMock) */
const sharedMock = new MockConnectorProvider();

export function resolveConnectorProvider(
  config: ConnectorProviderConfig,
  fetchImpl?: FetchLike,
): ConnectorProvider {
  switch (config.kind) {
    case "mock":
      return sharedMock;
    case "outlook": {
      if (!config.token) {
        throw new ConnectorProviderError(
          "outlook connector requires a credential (the app registration JSON — see parseOutlookCredential)",
        );
      }
      return new OutlookConnectorProvider({
        credential: parseOutlookCredential(config.token),
        baseUrl: config.baseUrl ?? null,
        ...(fetchImpl ? { fetchImpl } : {}),
      });
    }
    case "generic":
    case "http": {
      if (!config.baseUrl) {
        throw new ConnectorProviderError(
          `${config.kind} connector requires a baseUrl (the connection root URL)`,
        );
      }
      return new GenericHttpConnectorProvider(config.kind, {
        baseUrl: config.baseUrl,
        token: config.token ?? null,
        ...(fetchImpl ? { fetchImpl } : {}),
      });
    }
    case "webhook":
      if (!config.baseUrl) {
        throw new ConnectorProviderError(
          "webhook connector requires a baseUrl (the receiver endpoint URL)",
        );
      }
      return new WebhookConnectorProvider({
        baseUrl: config.baseUrl,
        token: config.token ?? null,
        ...(fetchImpl ? { fetchImpl } : {}),
      });
    case "slack":
      // token = bot token; baseUrl optional (defaults to https://slack.com/api,
      // override only for proxies/tests)
      if (!config.token) {
        throw new ConnectorProviderError(
          "slack connector requires a token (a bot token, xoxb-…)",
        );
      }
      return new SlackConnectorProvider({
        token: config.token,
        baseUrl: config.baseUrl ?? null,
        ...(fetchImpl ? { fetchImpl } : {}),
      });
    case "teams":
      // token = the structured-JSON credential {appId, appPassword, tenantId?,
      // loginBaseUrl?} — the bot's Microsoft app registration, NOT a bearer
      // token (a Bot Connector token lives ~1h; see parseTeamsCredential).
      // baseUrl optional (defaults to the global Teams service URL; a regional
      // or sovereign-cloud deployment sets its own serviceUrl).
      if (!config.token) {
        throw new ConnectorProviderError(
          "teams connector requires a token (the JSON credential {appId, appPassword, tenantId?, loginBaseUrl?})",
        );
      }
      return new TeamsConnectorProvider({
        credential: parseTeamsCredential(config.token),
        baseUrl: config.baseUrl ?? null,
        ...(fetchImpl ? { fetchImpl } : {}),
      });
    case "github":
      // token = PAT/installation token; baseUrl optional (defaults to
      // https://api.github.com; a GHE deployment sets its …/api/v3 root)
      if (!config.token) {
        throw new ConnectorProviderError(
          "github connector requires a token (a PAT or installation token)",
        );
      }
      return new GitHubConnectorProvider({
        token: config.token,
        baseUrl: config.baseUrl ?? null,
        ...(fetchImpl ? { fetchImpl } : {}),
      });
    case "jira":
      // baseUrl = the Jira site root (required — there is no global default);
      // token = "email:api_token" (validated in the adapter constructor)
      if (!config.baseUrl) {
        throw new ConnectorProviderError(
          "jira connector requires a baseUrl (https://<site>.atlassian.net)",
        );
      }
      if (!config.token) {
        throw new ConnectorProviderError(
          "jira connector requires a token ('email:api_token', Jira Cloud Basic-auth convention)",
        );
      }
      return new JiraConnectorProvider({
        baseUrl: config.baseUrl,
        token: config.token,
        ...(fetchImpl ? { fetchImpl } : {}),
      });
    case "snowflake":
      // ADR-0023 closed the ROADMAP Batch B deferral: token = the
      // structured-JSON credential {account, user, privateKey, passphrase?}
      // inside the one ciphertext (validated again here — a stored credential
      // predating validation must fail explicit, not opaque); baseUrl optional
      // (defaults to https://<account>.snowflakecomputing.com, override for
      // proxies/tests).
      if (!config.token) {
        throw new ConnectorProviderError(
          "snowflake connector requires a token (the JSON credential {account, user, privateKey, passphrase?})",
        );
      }
      return new SnowflakeConnectorProvider({
        credential: parseSnowflakeCredential(config.token),
        baseUrl: config.baseUrl ?? null,
        ...(fetchImpl ? { fetchImpl } : {}),
      });
  }
}

// ---------------------------------------------------------------------------
// ADR-0062 — the compiled vendor defaults, made adjudicable
// ---------------------------------------------------------------------------
//
// See the long note in `@regulait/model-provider`. Same contract, same
// tri-state, same rule: `undefined` means "this module cannot say where the
// adapter would go", and a strict posture must refuse rather than guess.
//
// `snowflake` is the honest `undefined` here. Its default is derived from the
// DECRYPTED CREDENTIAL (`https://<account>.snowflakecomputing.com`), so it is
// knowable at call time but not statically, and this registry deliberately does
// not take a credential. `connectorCredentialHosts` below is the call-time
// half: given the decrypted token it names the typed host and the compiled
// ones, and the gateway guards both (ADR-0167).

export function connectorDefaultBaseUrl(kind: string): string | null | undefined {
  switch (kind) {
    case "slack":
      return SLACK_DEFAULT_BASE_URL;
    case "teams":
      // the documented global Teams service URL. It is a real compiled
      // destination, so ADR-0062's posture gate adjudicates it exactly as it
      // does slack.com — Teams gets no exemption. NOTE: a Teams post ALSO
      // reaches the Entra login host, which this registry cannot name here
      // because it is credential-derived (`loginBaseUrl`); that host is
      // adjudicated at call time by the guarded fetch, which re-checks every
      // request URL (and, since ADR-0167, on the connector invoke path too —
      // see `connectorCredentialHosts`).
      return TEAMS_DEFAULT_BASE_URL;
    case "outlook":
      // ADR-0167: the Graph default, so a strict posture adjudicates it like
      // every other compiled vendor host instead of refusing it as unknown
      return OUTLOOK_DEFAULT_GRAPH_BASE_URL;
    case "github":
      return GITHUB_DEFAULT_BASE_URL;
    // these cannot be constructed without an explicit baseUrl (the adapter
    // throws), so a null override never reaches a compiled destination
    case "http":
    case "generic":
    case "webhook":
    case "jira":
      return null;
    case "mock":
      return null;
    default:
      // includes `snowflake` — credential-derived, see above
      return undefined;
  }
}

/**
 * ADR-0167 (SEC-01): the kinds whose adapters reach a host NAMED BY THE
 * CREDENTIAL rather than only by the connector row. The gateway must hand
 * these a guarded fetch even with no `baseUrl` override, because "no override
 * means no check" only holds for hosts nobody typed.
 */
export const CREDENTIAL_HOST_CONNECTOR_KINDS: ReadonlySet<string> = new Set([
  "teams",
  "outlook",
  "snowflake",
]);

/**
 * The hosts an adapter of `kind` reaches with NO `baseUrl` override, split
 * into the one an admin TYPED into the credential (adjudicated like any typed
 * destination) and the vendor's COMPILED ones (which follow the deployment
 * posture). Throws `ConnectorProviderError` for a credential the kind cannot
 * parse — the same error the adapter itself would raise.
 */
export function connectorCredentialHosts(
  kind: string,
  token: string | null,
): { typed: string | null; compiled: string[] } {
  switch (kind) {
    case "snowflake":
      return {
        typed: token
          ? `https://${parseSnowflakeCredential(token).account.toLowerCase()}.snowflakecomputing.com`
          : null,
        compiled: [],
      };
    case "teams": {
      const cred = token ? parseTeamsCredential(token) : null;
      return {
        typed: cred?.loginBaseUrl ?? null,
        compiled: [TEAMS_DEFAULT_BASE_URL, ...(cred?.loginBaseUrl ? [] : [TEAMS_DEFAULT_LOGIN_BASE_URL])],
      };
    }
    case "outlook": {
      const cred = token ? parseOutlookCredential(token) : null;
      return {
        typed: cred?.loginBaseUrl ?? null,
        compiled: [
          OUTLOOK_DEFAULT_GRAPH_BASE_URL,
          ...(cred?.loginBaseUrl ? [] : [OUTLOOK_DEFAULT_LOGIN_BASE_URL]),
        ],
      };
    }
    default:
      return { typed: null, compiled: [] };
  }
}
