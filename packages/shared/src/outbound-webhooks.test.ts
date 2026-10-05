/**
 * ADR-0173 batch 2c (F) — the webhook event registry's 2c entries.
 *
 * Rules:
 *  - every batch-2c event is registered under its family and declares its
 *    payload fields;
 *  - no declared field is a content field (inputs, outputs, previews,
 *    messages, comments, templates, secrets), and `webhookPayloadFor` drops
 *    anything undeclared — including a comment smuggled inside `scores`.
 */
import { describe, expect, it } from "vitest";
import {
  WEBHOOK_EVENTS,
  WEBHOOK_EVENT_FAMILIES,
  isWebhookEventSelector,
  webhookPayloadFor,
  webhookSelectorMatches,
  type WebhookEventName,
} from "./outbound-webhooks.js";

const BATCH_2C: WebhookEventName[] = [
  "trace.added_to_dataset",
  "trace.queued",
  "trace.retention_extended",
  "annotation.submitted",
  "annotation.item.completed",
  "annotation.sla.breached",
  "automation.matched",
  "automation.action.failed",
  "automation.rule.paused",
];

/** a field name that would carry content rather than ids, names, scores or times */
const CONTENT_FIELD =
  /(content|preview|prompt|input|output|message|comment|text|body|template|secret|completion|response|query|transcript|payload|error)/i;

describe("batch 2c webhook events", () => {
  it.each(BATCH_2C)("%s is registered under its family and declares its fields", (event) => {
    const spec = WEBHOOK_EVENTS[event];
    expect(spec, event).toBeDefined();
    expect(spec.family).toBe(event.split(".")[0]);
    expect((WEBHOOK_EVENT_FAMILIES as readonly string[]).includes(spec.family)).toBe(true);
    expect(spec.description.length).toBeGreaterThan(0);
    expect(spec.fields.length).toBeGreaterThan(0);
    expect(new Set(spec.fields).size).toBe(spec.fields.length);
    // every 2c event names the object it is about by id
    expect(spec.fields.some((f) => /Id$/.test(f))).toBe(true);
  });

  it.each(BATCH_2C)("%s declares no content field", (event) => {
    for (const f of WEBHOOK_EVENTS[event].fields) expect(f, `${event}.${f}`).not.toMatch(CONTENT_FIELD);
  });

  it("a family selector picks up every new event", () => {
    for (const fam of ["trace", "annotation", "automation"]) expect(isWebhookEventSelector(`${fam}.*`)).toBe(true);
    for (const event of BATCH_2C) expect(webhookSelectorMatches([`${event.split(".")[0]}.*`], event)).toBe(true);
    expect(webhookSelectorMatches(["prompt.*"], "trace.queued")).toBe(false);
  });

  it("an emitter that passes content cannot widen the payload", () => {
    const out = webhookPayloadFor("annotation.submitted", {
      queueId: "q1",
      itemId: "i1",
      traceId: "t1",
      reviewerUserId: "u1",
      comment: "the model leaked the customer's card number",
      inputPreview: "secret prompt",
      scores: [
        { name: "helpfulness", value: 4, comment: "verbose", reviewerNote: "x" },
        { name: "verdict", label: "pass", outputPreview: "y" },
      ],
    });
    expect(out).toEqual({
      queueId: "q1",
      itemId: "i1",
      traceId: "t1",
      reviewerUserId: "u1",
      scores: [
        { name: "helpfulness", value: 4 },
        { name: "verdict", label: "pass" },
      ],
    });
    expect(JSON.stringify(out)).not.toMatch(/card number|secret prompt|verbose|reviewerNote|outputPreview/);
  });
});
