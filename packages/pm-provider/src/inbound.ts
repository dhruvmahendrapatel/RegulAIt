/**
 * Inbound webhook translation layer — the pillar-8 depth item deferred by
 * ADR-0010. Each PM tool POSTs its own native payload with its own native
 * verification mechanism; none of them can be configured to send RegulAIt's
 * invented header or normalized shape. Every parser here does exactly two
 * jobs, in order:
 *
 *   1. VERIFY the request with the mechanism the tool actually supports
 *      (HMAC signature, URL token, basic auth) against the connection's
 *      per-connection webhook secret — fail-closed with PmProviderError
 *      (gateway → 401), constant-time comparisons throughout, and never a
 *      secret in an error message.
 *   2. TRANSLATE the native payload into ADR-0010's EXISTING normalized
 *      inbound shape (@regulait/shared's pmWebhookSchema) — the downstream
 *      drift/orphan processing is unchanged; this layer sits strictly in
 *      front of it.
 *
 * Two extra result kinds cover provider realities that are not events:
 * verification HANDSHAKES (asana's x-hook-secret echo, monday's challenge
 * echo) that must be answered without processing anything, and IGNORED
 * payloads (valid but irrelevant — event types we do not consume) that must
 * be 200-and-dropped, never errored: a webhook endpoint that errors on valid
 * traffic gets auto-disabled by the sender.
 *
 * REPLAY (ADR-0010 amendment, S-03 of the 2026-11-07 review). Two walls:
 *   - a SIGNED timestamp within PM_WEBHOOK_REPLAY_WINDOW_SECONDS wherever one
 *     is signed: Linear's `webhookTimestamp` (inside the HMAC'd body) and the
 *     generic contract's `x-regulait-timestamp` (inside its HMAC). The window
 *     is the Slack ChatOps one (CHATOPS_REPLAY_WINDOW_SECONDS, 300 s).
 *   - a delivery key (inboundDeliveryKey) the gateway records once per
 *     connection in `pm_webhook_deliveries`: the sha256 of the exact body,
 *     plus the provider's own delivery id where it sends one. A second
 *     delivery with either value is acknowledged and not processed.
 * Jira, monday, Azure DevOps and Asana sign no timestamp, so for them the
 * delivery record is the only replay wall; that is stated, not hidden.
 */

import { createHash, createHmac } from "node:crypto";
import { z } from "zod";
import { CHATOPS_REPLAY_WINDOW_SECONDS, constantTimeEqual, pmWebhookSchema } from "@regulait/shared";
import { PmProviderError, type PmProviderKind } from "./index.js";

/** ADR-0010's normalized inbound event — reused, never re-invented. */
export type NormalizedInboundEvent = z.infer<typeof pmWebhookSchema>;

export interface InboundWebhookInput {
  /** lower-cased header names → first value */
  headers: Record<string, string | undefined>;
  /** query-string params — URL-token verification for tools that cannot sign */
  query?: Record<string, string | undefined>;
  /** the EXACT request body bytes as received — HMAC verification needs them */
  rawBody: string;
  /** the connection's plaintext webhook secret */
  secret: string;
  /** the connection's configured project/board/team — context for parsers */
  connectionProject: string;
  /** milliseconds since the epoch; injectable so the replay tests own the clock */
  nowMs?: number;
}

/** The signed-timestamp window, the same 300 s as Slack ChatOps (ADR-0061). */
export const PM_WEBHOOK_REPLAY_WINDOW_SECONDS = CHATOPS_REPLAY_WINDOW_SECONDS;

/** generic contract headers: unix seconds, and `sha256=<hex HMAC of "<ts>.<raw body>">` */
export const GENERIC_TIMESTAMP_HEADER = "x-regulait-timestamp";
export const GENERIC_SIGNATURE_HEADER = "x-regulait-signature";

export type InboundWebhookResult =
  /** a provider verification challenge — answer it, process nothing */
  | {
      kind: "handshake";
      response: unknown;
      headers?: Record<string, string>;
      statusCode?: number;
    }
  /** native payload translated to the ADR-0010 normalized shape */
  | { kind: "events"; events: NormalizedInboundEvent[] }
  /** valid but irrelevant — 200-and-drop, never an error */
  | { kind: "ignored"; reason: string };

// ---------------------------------------------------------------------------
// Verification helpers
// ---------------------------------------------------------------------------

/** Constant-time string equality: the ONE shared helper (ADR-0176), which
 * hashes both sides first so inputs of different lengths compare without a
 * throw or a length leak. Re-exported so this package's API is unchanged. */
export { constantTimeEqual };

const hmacHex = (secret: string, rawBody: string): string =>
  createHmac("sha256", secret).update(rawBody).digest("hex");

/** URL-token verification (?token=<secret>) for tools whose outbound webhooks
 * can neither sign payloads nor carry custom headers. */
function requireUrlToken(input: InboundWebhookInput, provider: string): void {
  const token = input.query?.token;
  if (typeof token !== "string" || !constantTimeEqual(token, input.secret)) {
    throw new PmProviderError(
      `${provider} webhook requires a valid ?token= URL parameter`,
      401,
    );
  }
}

/** Hex HMAC-SHA256-of-raw-body verification under the named header. */
function requireHmacHeader(input: InboundWebhookInput, provider: string, header: string): void {
  const presented = input.headers[header];
  if (typeof presented !== "string" || !constantTimeEqual(presented, hmacHex(input.secret, input.rawBody))) {
    throw new PmProviderError(
      `${provider} webhook ${typeof presented === "string" ? "invalid" : "missing"} ${header} signature`,
      401,
    );
  }
}

/** Refuse a signed timestamp outside the window, either side of now (401). */
function requireFreshTimestamp(input: InboundWebhookInput, provider: string, signedAtMs: number): void {
  const now = input.nowMs ?? Date.now();
  const skew = Math.abs(now - signedAtMs);
  if (!Number.isFinite(signedAtMs) || skew > PM_WEBHOOK_REPLAY_WINDOW_SECONDS * 1000) {
    throw new PmProviderError(
      `${provider} webhook timestamp is outside the ${PM_WEBHOOK_REPLAY_WINDOW_SECONDS} s replay window`,
      401,
    );
  }
}

function parseJsonBody(input: InboundWebhookInput, provider: string): unknown {
  const raw = input.rawBody.trim();
  if (raw === "") return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new PmProviderError(`${provider} webhook body is not valid JSON`, 400);
  }
}

/** Build a normalized event, dropping empty optionals, and validate it
 * against the ONE shared schema so every parser provably emits the ADR-0010
 * contract. */
function normalized(e: {
  externalId: string;
  event: "updated" | "deleted" | "commented";
  state?: string | null | undefined;
  fields?: Record<string, unknown> | undefined;
}): NormalizedInboundEvent {
  const fields =
    e.fields === undefined
      ? undefined
      : Object.fromEntries(Object.entries(e.fields).filter(([, v]) => v !== undefined));
  return pmWebhookSchema.parse({
    externalId: e.externalId,
    event: e.event,
    ...(e.state ? { state: e.state } : {}),
    ...(fields && Object.keys(fields).length > 0 ? { fields } : {}),
  });
}

// ---------------------------------------------------------------------------
// jira — Jira Cloud MANUAL webhooks can neither send custom headers nor sign
// payloads; the only verification a receiver can enforce is a secret token
// embedded in the webhook URL, so this parser requires ?token=<secret>
// (constant-time compared). Payloads carry the full issue snapshot:
// { webhookEvent: "jira:issue_created"|"jira:issue_updated"|"jira:issue_deleted"
//   |"comment_created"|..., issue: { id, key, fields: { summary, description,
//   status: { name } } }, comment?: { body } }.
// issue.id (Jira's internal id — what JiraProvider.createWorkItem records as
// the link's externalId) keys the event; status.name is the reported state.
// ---------------------------------------------------------------------------

const jiraPayloadSchema = z
  .object({
    webhookEvent: z.string(),
    issue: z
      .object({
        id: z.union([z.string(), z.number()]).transform(String),
        key: z.string().optional(),
        fields: z
          .object({
            summary: z.string().nullish(),
            description: z.string().nullish(),
            status: z.object({ name: z.string().nullish() }).passthrough().nullish(),
          })
          .passthrough()
          .nullish(),
      })
      .passthrough()
      .optional(),
    comment: z.object({ body: z.unknown() }).passthrough().optional(),
  })
  .passthrough();

export function parseJiraInboundWebhook(input: InboundWebhookInput): InboundWebhookResult {
  requireUrlToken(input, "jira");
  const parsed = jiraPayloadSchema.safeParse(parseJsonBody(input, "jira"));
  if (!parsed.success) {
    throw new PmProviderError("unrecognized jira webhook payload (no webhookEvent)", 400);
  }
  const { webhookEvent, issue, comment } = parsed.data;
  const issueEvents: Record<string, "updated" | "deleted"> = {
    "jira:issue_created": "updated",
    "jira:issue_updated": "updated",
    "jira:issue_deleted": "deleted",
  };
  const mappedIssueEvent = issueEvents[webhookEvent];
  if (mappedIssueEvent) {
    if (!issue) throw new PmProviderError(`jira ${webhookEvent} payload carries no issue`, 400);
    return {
      kind: "events",
      events: [
        normalized({
          externalId: issue.id,
          event: mappedIssueEvent,
          state: issue.fields?.status?.name,
          fields:
            mappedIssueEvent === "updated"
              ? { summary: issue.fields?.summary ?? undefined, description: issue.fields?.description ?? undefined }
              : undefined,
        }),
      ],
    };
  }
  if (webhookEvent === "comment_created" || webhookEvent === "comment_updated") {
    if (!issue) throw new PmProviderError(`jira ${webhookEvent} payload carries no issue`, 400);
    return {
      kind: "events",
      events: [
        normalized({
          externalId: issue.id,
          event: "commented",
          fields: { comment: comment?.body },
        }),
      ],
    };
  }
  return { kind: "ignored", reason: `jira event '${webhookEvent}' is not consumed` };
}

// ---------------------------------------------------------------------------
// linear — Linear signs every delivery: header `linear-signature` is the hex
// HMAC-SHA256 of the raw body under the webhook signing secret, and the body
// carries `webhookTimestamp` (ms), which is therefore signed: it must be
// within PM_WEBHOOK_REPLAY_WINDOW_SECONDS, and a body without it is refused.
// Payloads:
// { action: "create"|"update"|"remove", type: "Issue"|"Comment"|...,
//   data: { id, identifier, title, description?, state?: { name },
//           issueId?/issue? on Comment }, updatedFrom? }.
// data.id is the issue UUID — exactly what LinearProvider.createWorkItem
// records as the link's externalId. Non-Issue/Comment types are ignored.
// ---------------------------------------------------------------------------

const linearPayloadSchema = z
  .object({
    action: z.string(),
    type: z.string(),
    /** ms since the epoch, inside the signed body (Linear's replay guard) */
    webhookTimestamp: z.number().optional(),
    data: z
      .object({
        id: z.union([z.string(), z.number()]).transform(String).optional(),
        identifier: z.string().optional(),
        title: z.string().optional(),
        description: z.string().nullish(),
        body: z.string().optional(),
        issueId: z.string().optional(),
        issue: z
          .object({ id: z.union([z.string(), z.number()]).transform(String) })
          .passthrough()
          .optional(),
        state: z.object({ name: z.string().nullish() }).passthrough().nullish(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export function parseLinearInboundWebhook(input: InboundWebhookInput): InboundWebhookResult {
  requireHmacHeader(input, "linear", "linear-signature");
  const parsed = linearPayloadSchema.safeParse(parseJsonBody(input, "linear"));
  if (!parsed.success) {
    throw new PmProviderError("unrecognized linear webhook payload (no action/type)", 400);
  }
  if (parsed.data.webhookTimestamp === undefined) {
    throw new PmProviderError("linear webhook carries no signed webhookTimestamp", 401);
  }
  requireFreshTimestamp(input, "linear", parsed.data.webhookTimestamp);
  const { action, type, data } = parsed.data;
  if (type === "Issue") {
    if (!data?.id) throw new PmProviderError("linear Issue payload carries no data.id", 400);
    if (action === "remove") {
      return { kind: "events", events: [normalized({ externalId: data.id, event: "deleted" })] };
    }
    return {
      kind: "events",
      events: [
        normalized({
          externalId: data.id,
          event: "updated",
          state: data.state?.name,
          fields: { title: data.title, description: data.description ?? undefined },
        }),
      ],
    };
  }
  if (type === "Comment") {
    const issueId = data?.issueId ?? data?.issue?.id;
    if (action === "remove" || !issueId) {
      return { kind: "ignored", reason: `linear Comment ${action} is not consumed` };
    }
    return {
      kind: "events",
      events: [normalized({ externalId: issueId, event: "commented", fields: { comment: data?.body } })],
    };
  }
  return { kind: "ignored", reason: `linear ${type} events are not consumed` };
}

// ---------------------------------------------------------------------------
// asana — TWO-PHASE. Establishing the webhook, Asana POSTs a handshake with
// header `x-hook-secret` that MUST be answered 200 echoing the SAME header
// (and processing nothing). Deliveries then carry header `x-hook-signature`,
// the hex HMAC-SHA256 of the raw body under the stored secret. Asana events
// are THIN by design — { events: [{ action: "added"|"changed"|"removed"|
// "deleted"|"undeleted", resource: { gid, resource_type }, parent? }] } with
// NO field data — so task changes translate to state-less "updated" signals
// (recorded in pm_sync_events; content stays resolved by ADR-0010's live
// read-through) and story-on-task events to "commented". "removed" means
// removed-from-a-project, not deleted, and is deliberately not consumed.
// ---------------------------------------------------------------------------

const asanaPayloadSchema = z
  .object({
    events: z
      .array(
        z
          .object({
            action: z.string(),
            resource: z
              .object({
                gid: z.union([z.string(), z.number()]).transform(String),
                resource_type: z.string().optional(),
              })
              .passthrough()
              .optional(),
            parent: z
              .object({
                gid: z.union([z.string(), z.number()]).transform(String),
                resource_type: z.string().optional(),
              })
              .passthrough()
              .nullish(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

export function parseAsanaInboundWebhook(input: InboundWebhookInput): InboundWebhookResult {
  const hookSecret = input.headers["x-hook-secret"];
  if (typeof hookSecret === "string") {
    // establishment handshake: echo the header, process nothing
    return {
      kind: "handshake",
      response: {},
      headers: { "x-hook-secret": hookSecret },
      statusCode: 200,
    };
  }
  requireHmacHeader(input, "asana", "x-hook-signature");
  const parsed = asanaPayloadSchema.safeParse(parseJsonBody(input, "asana"));
  if (!parsed.success || !parsed.data.events) {
    return { kind: "ignored", reason: "asana payload carries no events array" };
  }
  const events: NormalizedInboundEvent[] = [];
  for (const ev of parsed.data.events) {
    if (!ev.resource) continue;
    if (ev.resource.resource_type === "task") {
      if (ev.action === "deleted") {
        events.push(normalized({ externalId: ev.resource.gid, event: "deleted" }));
      } else if (ev.action === "added" || ev.action === "changed" || ev.action === "undeleted") {
        // thin event: no state, no fields — a fetch-to-resolve signal only
        events.push(normalized({ externalId: ev.resource.gid, event: "updated" }));
      }
      // "removed" (from a project) is deliberately not consumed
    } else if (ev.resource.resource_type === "story" && ev.parent?.resource_type === "task") {
      if (ev.action === "added") {
        events.push(normalized({ externalId: ev.parent.gid, event: "commented" }));
      }
    }
  }
  if (events.length === 0) {
    return {
      kind: "ignored",
      reason: "asana events are thin; none actionable — content is resolved by read-through",
    };
  }
  return { kind: "events", events };
}

// ---------------------------------------------------------------------------
// monday — challenge handshake: a body of { challenge: "<uuid>" } must be
// echoed back verbatim as JSON. monday webhooks carry NO payload signature
// (the JWT it optionally sends is signed with monday's app secret, which a
// manual-integration receiver does not hold), so — documented limitation —
// verification is the same ?token=<secret> URL parameter as jira, checked
// before the challenge is answered (fail-closed). Events:
// { event: { type: "update_column_value"|"create_pulse"|"item_deleted"|
//   "create_update"|..., pulseId, boardId, columnId?, value?: { label?:
//   { text } }, textBody? } } — a status-column change carries its new label
// text, which is the reported state.
// ---------------------------------------------------------------------------

const mondayPayloadSchema = z
  .object({
    challenge: z.string().optional(),
    event: z
      .object({
        type: z.string(),
        pulseId: z.union([z.string(), z.number()]).optional(),
        itemId: z.union([z.string(), z.number()]).optional(),
        columnId: z.string().optional(),
        value: z
          .object({
            label: z.object({ text: z.string().nullish() }).passthrough().nullish(),
          })
          .passthrough()
          .nullish(),
        textBody: z.string().nullish(),
        pulseName: z.string().nullish(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export function parseMondayInboundWebhook(input: InboundWebhookInput): InboundWebhookResult {
  requireUrlToken(input, "monday");
  const parsed = mondayPayloadSchema.safeParse(parseJsonBody(input, "monday"));
  if (!parsed.success) {
    throw new PmProviderError("unrecognized monday webhook payload", 400);
  }
  if (typeof parsed.data.challenge === "string") {
    // challenge handshake: echo verbatim, process nothing
    return { kind: "handshake", response: { challenge: parsed.data.challenge }, statusCode: 200 };
  }
  const ev = parsed.data.event;
  if (!ev) return { kind: "ignored", reason: "monday payload carries no event" };
  const rawId = ev.pulseId ?? ev.itemId;
  if (rawId === undefined) {
    return { kind: "ignored", reason: `monday event '${ev.type}' carries no item id` };
  }
  const externalId = String(rawId);
  switch (ev.type) {
    case "update_column_value":
      return {
        kind: "events",
        events: [
          normalized({
            externalId,
            event: "updated",
            // a status-column change carries its new label text as the state
            state: ev.value?.label?.text,
          }),
        ],
      };
    case "create_pulse":
      // normalized vocabulary has no "created": report it as an update — an
      // item RegulAIt did not create has no link and lands as matched:false
      return {
        kind: "events",
        events: [
          normalized({
            externalId,
            event: "updated",
            fields: ev.pulseName ? { name: ev.pulseName } : undefined,
          }),
        ],
      };
    case "item_deleted":
    case "delete_pulse":
      return { kind: "events", events: [normalized({ externalId, event: "deleted" })] };
    case "create_update":
      return {
        kind: "events",
        events: [
          normalized({
            externalId,
            event: "commented",
            fields: { comment: ev.textBody ?? undefined },
          }),
        ],
      };
    default:
      return { kind: "ignored", reason: `monday event '${ev.type}' is not consumed` };
  }
}

// ---------------------------------------------------------------------------
// azure_devops — service hooks POST { eventType: "workitem.created"|
// "workitem.updated"|"workitem.deleted"|"workitem.commented", resource } and
// can be configured with basic-auth credentials on the subscription; the
// basic-auth PASSWORD is verified against the stored secret (constant-time;
// the username is not significant). Payload asymmetry, faithfully handled:
// workitem.created's resource IS the work item ({ id, fields: plain values })
// while workitem.updated's resource is the UPDATE ({ id: update id,
// workItemId, fields: { "Field": { oldValue, newValue } }, revision: { id,
// fields: plain values } }).
// ---------------------------------------------------------------------------

const adoPayloadSchema = z
  .object({
    eventType: z.string(),
    resource: z
      .object({
        id: z.union([z.string(), z.number()]).optional(),
        workItemId: z.union([z.string(), z.number()]).optional(),
        fields: z.record(z.string(), z.unknown()).optional(),
        revision: z
          .object({
            id: z.union([z.string(), z.number()]).optional(),
            fields: z.record(z.string(), z.unknown()).optional(),
          })
          .passthrough()
          .nullish(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

/** an ADO field arrives plain on created ("Doing") and as {oldValue,newValue}
 * on updated — take the string either way */
function adoFieldValue(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (v !== null && typeof v === "object" && "newValue" in v) {
    const nv = (v as { newValue?: unknown }).newValue;
    if (typeof nv === "string") return nv;
  }
  return undefined;
}

export function parseAzureDevOpsInboundWebhook(input: InboundWebhookInput): InboundWebhookResult {
  const auth = input.headers.authorization;
  if (typeof auth !== "string" || !auth.startsWith("Basic ")) {
    throw new PmProviderError("azure_devops webhook requires basic-auth credentials", 401);
  }
  const decoded = Buffer.from(auth.slice("Basic ".length), "base64").toString("utf8");
  const sep = decoded.indexOf(":");
  const password = sep === -1 ? decoded : decoded.slice(sep + 1);
  if (!constantTimeEqual(password, input.secret)) {
    throw new PmProviderError("azure_devops webhook basic-auth verification failed", 401);
  }
  const parsed = adoPayloadSchema.safeParse(parseJsonBody(input, "azure_devops"));
  if (!parsed.success) {
    throw new PmProviderError("unrecognized azure_devops webhook payload (no eventType)", 400);
  }
  const { eventType, resource } = parsed.data;
  if (!eventType.startsWith("workitem.")) {
    return { kind: "ignored", reason: `azure_devops event '${eventType}' is not consumed` };
  }
  if (!resource) throw new PmProviderError(`azure_devops ${eventType} payload carries no resource`, 400);
  const workItemId = (id: unknown) => (id === undefined ? undefined : String(id));
  switch (eventType) {
    case "workitem.created": {
      const id = workItemId(resource.id);
      if (!id) throw new PmProviderError("azure_devops workitem.created carries no resource.id", 400);
      return {
        kind: "events",
        events: [
          normalized({
            externalId: id,
            event: "updated",
            state: adoFieldValue(resource.fields?.["System.State"]),
            fields: { title: adoFieldValue(resource.fields?.["System.Title"]) },
          }),
        ],
      };
    }
    case "workitem.updated": {
      // resource.id is the UPDATE id here; the work item is workItemId/revision.id
      const id = workItemId(resource.workItemId ?? resource.revision?.id ?? resource.id);
      if (!id) throw new PmProviderError("azure_devops workitem.updated carries no work item id", 400);
      return {
        kind: "events",
        events: [
          normalized({
            externalId: id,
            event: "updated",
            state:
              adoFieldValue(resource.fields?.["System.State"]) ??
              adoFieldValue(resource.revision?.fields?.["System.State"]),
            fields: {
              title:
                adoFieldValue(resource.fields?.["System.Title"]) ??
                adoFieldValue(resource.revision?.fields?.["System.Title"]),
            },
          }),
        ],
      };
    }
    case "workitem.deleted": {
      const id = workItemId(resource.id ?? resource.workItemId);
      if (!id) throw new PmProviderError("azure_devops workitem.deleted carries no resource.id", 400);
      return { kind: "events", events: [normalized({ externalId: id, event: "deleted" })] };
    }
    case "workitem.commented": {
      const id = workItemId(resource.id ?? resource.workItemId);
      if (!id) throw new PmProviderError("azure_devops workitem.commented carries no resource.id", 400);
      return {
        kind: "events",
        events: [
          normalized({
            externalId: id,
            event: "commented",
            fields: { comment: adoFieldValue(resource.fields?.["System.History"]) },
          }),
        ],
      };
    }
    default:
      return { kind: "ignored", reason: `azure_devops event '${eventType}' is not consumed` };
  }
}

// ---------------------------------------------------------------------------
// generic_webhook + mock — RegulAIt's own contract, so it is the strict one:
//   x-regulait-timestamp: <unix seconds>
//   x-regulait-signature: sha256=<hex HMAC-SHA256 of "<timestamp>.<raw body>">
// under the connection's webhook secret, with the timestamp inside the
// PM_WEBHOOK_REPLAY_WINDOW_SECONDS window. There is no other mechanism: the
// static `x-regulait-webhook-secret` header and the body-only signature of
// ADR-0010's first cut were removed (S-03; ADR-0180, no grandfathering), so a
// request carrying either is refused. The body IS the normalized ADR-0010
// shape; the mock shares the parser as the tests' e2e vehicle.
// ---------------------------------------------------------------------------

const genericSignature = (secret: string, timestamp: string, rawBody: string): string =>
  `sha256=${createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex")}`;

/** The headers a sender (a bridge, or a test) attaches to a generic inbound delivery. */
export function signGenericInboundWebhook(
  secret: string,
  rawBody: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Record<string, string> {
  const timestamp = String(nowSeconds);
  return {
    [GENERIC_TIMESTAMP_HEADER]: timestamp,
    [GENERIC_SIGNATURE_HEADER]: genericSignature(secret, timestamp, rawBody),
  };
}

export function parseGenericInboundWebhook(input: InboundWebhookInput): InboundWebhookResult {
  const timestamp = input.headers[GENERIC_TIMESTAMP_HEADER];
  const signature = input.headers[GENERIC_SIGNATURE_HEADER];
  if (typeof timestamp !== "string" || typeof signature !== "string") {
    throw new PmProviderError(
      `generic webhook requires ${GENERIC_TIMESTAMP_HEADER} and ${GENERIC_SIGNATURE_HEADER}`,
      401,
    );
  }
  if (!/^[0-9]{1,12}$/.test(timestamp)) {
    throw new PmProviderError(`generic webhook ${GENERIC_TIMESTAMP_HEADER} is not unix seconds`, 401);
  }
  if (!constantTimeEqual(signature, genericSignature(input.secret, timestamp, input.rawBody))) {
    throw new PmProviderError(`generic webhook ${GENERIC_SIGNATURE_HEADER} verification failed`, 401);
  }
  requireFreshTimestamp(input, "generic", Number(timestamp) * 1000);
  // the body is the normalized contract itself; a malformed one is the
  // caller's validation error (ZodError → gateway 400), same as before
  return { kind: "events", events: [pmWebhookSchema.parse(parseJsonBody(input, "generic"))] };
}

// ---------------------------------------------------------------------------
// Delivery key — what the gateway records once per connection so a replay is
// acknowledged and never processed twice (pm_webhook_deliveries).
//   contentSha256  the sha256 of the exact body bytes (for generic/mock, of the
//               signed "<timestamp>.<body>"): always present, and the key
//               that matters for an attacker, because it is the signed (or
//               token-guarded) part of every delivery.
//   deliveryId  the provider's own id for the delivery where it sends one, so
//               a provider RETRY that re-stamps the body is still one
//               delivery: jira `x-atlassian-webhook-identifier`, linear
//               `linear-delivery`, azure_devops body `id`, monday body
//               `event.triggerUuid`. Asana and generic send none.
// An id longer than 200 characters is stored as its sha256.
// ---------------------------------------------------------------------------

export interface InboundDeliveryKey {
  contentSha256: string;
  deliveryId: string | null;
}

export function inboundDeliveryKey(provider: PmProviderKind, input: InboundWebhookInput): InboundDeliveryKey {
  // generic signs "<timestamp>.<body>", and its body carries no timestamp of its own: keying on the signed content
  // lets two identical reports sent at different times through, while a replay (same timestamp) is a duplicate
  // inside the window and refused outside it
  const signedTimestamp = input.headers[GENERIC_TIMESTAMP_HEADER];
  const content =
    (provider === "generic_webhook" || provider === "mock") && typeof signedTimestamp === "string"
      ? `${signedTimestamp}.${input.rawBody}`
      : input.rawBody;
  const contentSha256 = createHash("sha256").update(content, "utf8").digest("hex");
  let raw: unknown;
  const bodyField = (pick: (b: Record<string, unknown>) => unknown): unknown => {
    try {
      const b = JSON.parse(input.rawBody) as unknown;
      return b !== null && typeof b === "object" ? pick(b as Record<string, unknown>) : undefined;
    } catch {
      return undefined;
    }
  };
  switch (provider) {
    case "jira":
      raw = input.headers["x-atlassian-webhook-identifier"];
      break;
    case "linear":
      raw = input.headers["linear-delivery"];
      break;
    case "azure_devops":
      raw = bodyField((b) => b.id);
      break;
    case "monday":
      raw = bodyField((b) => {
        const ev = b.event;
        return ev !== null && typeof ev === "object" ? (ev as Record<string, unknown>).triggerUuid : undefined;
      });
      break;
    case "asana":
    case "generic_webhook":
    case "mock":
      raw = undefined;
      break;
  }
  const id = typeof raw === "string" || typeof raw === "number" ? String(raw).trim() : "";
  const deliveryId =
    id === "" ? null : id.length > 200 ? `sha256:${createHash("sha256").update(id, "utf8").digest("hex")}` : id;
  return { contentSha256, deliveryId };
}

// ---------------------------------------------------------------------------
// Registry — exhaustive over the kind union, like resolvePmProvider: a new
// provider kind forces a compile error here instead of a silent 500.
// ---------------------------------------------------------------------------

export function parseInboundWebhook(
  provider: PmProviderKind,
  input: InboundWebhookInput,
): InboundWebhookResult {
  switch (provider) {
    case "jira":
      return parseJiraInboundWebhook(input);
    case "linear":
      return parseLinearInboundWebhook(input);
    case "asana":
      return parseAsanaInboundWebhook(input);
    case "monday":
      return parseMondayInboundWebhook(input);
    case "azure_devops":
      return parseAzureDevOpsInboundWebhook(input);
    case "generic_webhook":
    case "mock":
      return parseGenericInboundWebhook(input);
  }
}
