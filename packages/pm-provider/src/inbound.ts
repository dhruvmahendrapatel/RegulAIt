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
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { pmWebhookSchema } from "@regulait/shared";
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
}

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

/** Constant-time string equality. Comparing sha256 digests (fixed length)
 * keeps timingSafeEqual applicable to inputs of differing lengths without
 * leaking the length mismatch through an early return. */
export function constantTimeEqual(a: string, b: string): boolean {
  const da = createHash("sha256").update(a).digest();
  const db = createHash("sha256").update(b).digest();
  return timingSafeEqual(da, db);
}

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
// HMAC-SHA256 of the raw body under the webhook signing secret. Payloads:
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
        fields: z.record(z.unknown()).optional(),
        revision: z
          .object({
            id: z.union([z.string(), z.number()]).optional(),
            fields: z.record(z.unknown()).optional(),
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
// generic_webhook + mock — symmetric with our OUTBOUND generic contract:
// verification is `x-regulait-signature: sha256=<hex HMAC-SHA256 of the raw
// body>` under the connection's webhook secret. The pre-existing legacy
// header (`x-regulait-webhook-secret: <secret>`) stays accepted for bridges
// built against ADR-0010's first cut, but a presented signature always takes
// precedence — a request carrying a BAD signature is rejected even if the
// legacy header is also present and valid. The body IS the normalized
// ADR-0010 shape (this adapter speaks RegulAIt's own vocabulary); the mock
// shares the parser as the tests' e2e vehicle.
// ---------------------------------------------------------------------------

export function parseGenericInboundWebhook(input: InboundWebhookInput): InboundWebhookResult {
  const signature = input.headers["x-regulait-signature"];
  if (typeof signature === "string") {
    if (!constantTimeEqual(signature, `sha256=${hmacHex(input.secret, input.rawBody)}`)) {
      throw new PmProviderError("generic webhook x-regulait-signature verification failed", 401);
    }
  } else {
    const legacy = input.headers["x-regulait-webhook-secret"];
    if (typeof legacy !== "string" || !constantTimeEqual(legacy, input.secret)) {
      throw new PmProviderError(
        "generic webhook requires x-regulait-signature or the legacy x-regulait-webhook-secret header",
        401,
      );
    }
  }
  // the body is the normalized contract itself; a malformed one is the
  // caller's validation error (ZodError → gateway 400), same as before
  return { kind: "events", events: [pmWebhookSchema.parse(parseJsonBody(input, "generic"))] };
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
