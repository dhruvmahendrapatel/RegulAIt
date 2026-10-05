/**
 * ADR-0173 batch 2b — outbound webhooks: the event registry and the
 * subscription shapes. Pure.
 *
 * THE EVENT REGISTRY is one table keyed by event name. Each entry names its
 * FAMILY (the part before the dot) and the payload fields it may carry. A
 * subscription lists exact event names or a whole family (`prompt.*`). Batch
 * 2c adds `trace.*`, `annotation.*` and `automation.*` by adding entries here
 * (and a family to WEBHOOK_EVENT_FAMILIES); nothing else in the delivery path
 * changes, and a subscription to a family picks up its new events.
 *
 * WHAT A PAYLOAD MAY CARRY: ids, names, hashes, actor ids and timestamps —
 * never template text, never secrets, never content. `webhookPayloadFor`
 * keeps only the fields the event declares, so an emitter that passes more
 * cannot widen what leaves the deployment.
 *
 * Signing follows the Standard Webhooks specification (headers `webhook-id`,
 * `webhook-timestamp`, `webhook-signature`; `whsec_` secrets), so a receiver
 * can verify with any off-the-shelf Standard Webhooks library.
 */
import { z } from "zod";

export const WEBHOOK_EVENT_FAMILIES = ["prompt"] as const;
export type WebhookEventFamily = (typeof WEBHOOK_EVENT_FAMILIES)[number];

interface WebhookEventSpec {
  family: WebhookEventFamily;
  description: string;
  /** the ONLY fields a payload of this event may carry (besides the envelope) */
  fields: readonly string[];
}

export const WEBHOOK_EVENTS = {
  "prompt.commit": {
    family: "prompt",
    description: "A new commit was written to a prompt in the registry.",
    fields: ["promptId", "promptName", "commitHash", "parentHash", "authorUserId"],
  },
  "prompt.tag.moved": {
    family: "prompt",
    description: "A prompt tag now points at a different commit.",
    fields: ["promptId", "promptName", "tag", "commitHash", "previousCommitHash", "movedByUserId", "approvalId"],
  },
  "prompt.promotion.requested": {
    family: "prompt",
    description: "Moving a prompt's prod tag was sent to the approvals queue.",
    fields: ["promptId", "promptName", "tag", "commitHash", "approvalId", "requestedByUserId", "approverUserId"],
  },
  "prompt.promotion.decided": {
    family: "prompt",
    description: "A prompt promotion was approved, denied or found stale when decided.",
    fields: ["promptId", "promptName", "tag", "commitHash", "approvalId", "decision", "outcome", "decidedByUserId"],
  },
} as const satisfies Record<string, WebhookEventSpec>;

export type WebhookEventName = keyof typeof WEBHOOK_EVENTS;
export const WEBHOOK_EVENT_NAMES = Object.keys(WEBHOOK_EVENTS) as WebhookEventName[];

/** the test notification an admin sends; never matched by a subscription's event list */
export const WEBHOOK_TEST_EVENT = "webhook.test" as const;

export function isWebhookEventName(name: string): name is WebhookEventName {
  return Object.prototype.hasOwnProperty.call(WEBHOOK_EVENTS, name);
}

/** a subscription entry: an exact event name or `<family>.*` */
export function isWebhookEventSelector(s: string): boolean {
  if (isWebhookEventName(s)) return true;
  const m = /^([a-z]+)\.\*$/.exec(s);
  return !!m && (WEBHOOK_EVENT_FAMILIES as readonly string[]).includes(m[1]!);
}

export function webhookSelectorMatches(selectors: readonly string[], event: string): boolean {
  if (!isWebhookEventName(event)) return false;
  const family = WEBHOOK_EVENTS[event].family;
  return selectors.some((s) => s === event || s === `${family}.*`);
}

/** keep only what the event declares; drop undefined */
export function webhookPayloadFor(event: WebhookEventName, data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of WEBHOOK_EVENTS[event].fields) {
    if (data[f] !== undefined) out[f] = data[f];
  }
  return out;
}

export const WEBHOOK_LIMITS = {
  nameChars: 80,
  urlChars: 2000,
  eventsPerSubscription: 50,
  /** attempts per delivery, the first one included */
  maxAttempts: 8,
  /** first retry after this; doubles each attempt */
  baseBackoffSeconds: 30,
  maxBackoffSeconds: 6 * 3600,
  /** one delivery POST's deadline */
  timeoutMs: 10_000,
} as const;

/** exponential backoff after the given number of attempts so far (1 = the first failed) */
export function webhookRetryDelaySeconds(attempts: number): number {
  const n = Math.max(1, attempts);
  return Math.min(WEBHOOK_LIMITS.maxBackoffSeconds, WEBHOOK_LIMITS.baseBackoffSeconds * 2 ** (n - 1));
}

const selectors = z
  .array(z.string().refine(isWebhookEventSelector, { message: "not a registered event or event family" }))
  .min(1)
  .max(WEBHOOK_LIMITS.eventsPerSubscription)
  .transform((v) => [...new Set(v)]);

export const webhookSubscriptionCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(WEBHOOK_LIMITS.nameChars),
    url: z.string().url().max(WEBHOOK_LIMITS.urlChars),
    events: selectors,
    active: z.boolean().default(true),
    /** the subscription's half of the plaintext-http opt-in; the egress allow entry must agree */
    allowPlaintextHttp: z.boolean().default(false),
  })
  .strict();
export type WebhookSubscriptionCreate = z.infer<typeof webhookSubscriptionCreateSchema>;

export const webhookSubscriptionUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(WEBHOOK_LIMITS.nameChars).optional(),
    url: z.string().url().max(WEBHOOK_LIMITS.urlChars).optional(),
    events: selectors.optional(),
    active: z.boolean().optional(),
    allowPlaintextHttp: z.boolean().optional(),
  })
  .strict();

export const WEBHOOK_DELIVERY_STATUSES = ["pending", "delivered", "failed"] as const;
export type WebhookDeliveryStatus = (typeof WEBHOOK_DELIVERY_STATUSES)[number];
