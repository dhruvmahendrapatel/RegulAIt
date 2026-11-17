import { describe, expect, it } from "vitest";
import {
  PM_TRIGGER_STATES,
  PM_TRIGGER_TRANSITIONS,
  canPmTriggerTransition,
  extractTriggerSignals,
  matchTrigger,
  pmTriggerSettingsSchema,
  pmTriggerSourcesOf,
} from "./triggers.js";
import { parseInboundWebhook } from "./inbound.js";

const AGENT = "557058:regulait-agent";
const ADO_AGENT = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";
const settings = pmTriggerSettingsSchema.parse({
  enabled: true,
  agentIdentities: [AGENT, ADO_AGENT, "regulait@contoso.com"],
  agentId: "11111111-1111-4111-8111-111111111111",
  change: { environment: "dev" },
});
const j = (o: unknown) => JSON.stringify(o);

describe("ADR-0356 lifecycle table", () => {
  it("declares every state, with written_back and failed terminal", () => {
    expect(Object.keys(PM_TRIGGER_TRANSITIONS).sort()).toEqual([...PM_TRIGGER_STATES].sort());
    expect(PM_TRIGGER_TRANSITIONS.written_back).toEqual([]);
    expect(PM_TRIGGER_TRANSITIONS.failed).toEqual([]);
    for (const targets of Object.values(PM_TRIGGER_TRANSITIONS)) {
      for (const t of targets) expect(PM_TRIGGER_STATES).toContain(t);
    }
  });
  it("allows only the declared moves", () => {
    expect(canPmTriggerTransition("received", "accepted")).toBe(true);
    expect(canPmTriggerTransition("received", "running")).toBe(false);
    expect(canPmTriggerTransition("denied", "running")).toBe(false);
    expect(canPmTriggerTransition("written_back", "failed")).toBe(false);
    expect(pmTriggerSourcesOf("running")).toEqual(["accepted"]);
    expect(pmTriggerSourcesOf("written_back").sort()).toEqual(["denied", "running"]);
    expect(pmTriggerSourcesOf("received")).toEqual([]);
  });
  it("defaults to off (ADR-0180)", () => {
    const s = pmTriggerSettingsSchema.parse({ agentIdentities: [AGENT], agentId: settings.agentId, change: { environment: "dev" } });
    expect(s.enabled).toBe(false);
    expect(s.change.changeType).toBe("pm_work_item");
    expect(matchTrigger({ externalId: "1", mechanism: "rule", actorIds: ["x"], targetIds: [] }, s)).toBe(false);
  });
});

describe("ADR-0356 Jira signals", () => {
  it("an assignment to the agent is a trigger; to someone else is not", () => {
    const body = j({
      webhookEvent: "jira:issue_updated",
      timestamp: Date.now(),
      user: { accountId: "557058:alice" },
      issue: { id: "10042", key: "OPS-1", fields: {} },
      changelog: { items: [{ field: "assignee", fieldId: "assignee", from: null, to: AGENT }] },
    });
    const [s] = extractTriggerSignals("jira", body);
    expect(s).toEqual({ externalId: "10042", mechanism: "assignment", actorIds: ["557058:alice"], targetIds: [AGENT] });
    expect(matchTrigger(s!, settings)).toBe(true);
    const other = extractTriggerSignals("jira", body.replace(AGENT, "557058:bob"));
    expect(matchTrigger(other[0]!, settings)).toBe(false);
  });
  it("an unrelated update carries no signal", () => {
    const body = j({ webhookEvent: "jira:issue_updated", issue: { id: "1" }, changelog: { items: [{ fieldId: "summary", to: "x" }] } });
    expect(extractTriggerSignals("jira", body)).toEqual([]);
  });
  it("a wiki-markup and an ADF mention of the agent are triggers", () => {
    const wiki = j({
      webhookEvent: "comment_created",
      issue: { id: "7" },
      comment: { author: { accountId: "557058:alice" }, body: `please take this [~accountid:${AGENT}]` },
    });
    expect(extractTriggerSignals("jira", wiki)[0]).toMatchObject({ mechanism: "mention", actorIds: ["557058:alice"], targetIds: [AGENT] });
    const adf = j({
      webhookEvent: "comment_created",
      issue: { id: "7" },
      comment: {
        author: { accountId: "557058:alice" },
        body: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "mention", attrs: { id: AGENT } }] }] },
      },
    });
    expect(matchTrigger(extractTriggerSignals("jira", adf)[0]!, settings)).toBe(true);
  });
  it("the agent's own comment or assignment never triggers itself", () => {
    const own = j({ webhookEvent: "comment_created", issue: { id: "7" }, comment: { author: { accountId: AGENT }, body: `[~accountid:${AGENT}]` } });
    expect(matchTrigger(extractTriggerSignals("jira", own)[0]!, settings)).toBe(false);
  });
  it("an Automation rule delivery is a rule trigger, and the parser makes it a verified, timestamp-checked event", () => {
    const now = Date.now();
    const body = j({ webhookEvent: "regulait:trigger", timestamp: now, issue: { id: "99" }, user: { accountId: "557058:alice" } });
    expect(extractTriggerSignals("jira", body)[0]).toEqual({ externalId: "99", mechanism: "rule", actorIds: ["557058:alice"], targetIds: [] });
    const input = { headers: {}, query: { token: "s3cret" }, rawBody: body, secret: "s3cret", connectionProject: "OPS", nowMs: now };
    expect(parseInboundWebhook("jira", input)).toEqual({ kind: "events", events: [] });
    // wrong token: refused before anything is read
    expect(() => parseInboundWebhook("jira", { ...input, query: { token: "nope" } })).toThrow(/token/);
    // stale: refused by the in-body timestamp wall
    expect(() => parseInboundWebhook("jira", { ...input, nowMs: now + 8 * 86_400_000 })).toThrow(/older than/);
  });
  it("bounds untrusted input: oversized ids are dropped, mentions are capped", () => {
    const many = Array.from({ length: 200 }, (_, i) => `[~accountid:u${i}]`).join(" ");
    const s = extractTriggerSignals("jira", j({ webhookEvent: "comment_created", issue: { id: "1" }, comment: { author: { accountId: "a" }, body: many } }));
    expect(s[0]!.targetIds.length).toBe(50);
    expect(extractTriggerSignals("jira", j({ webhookEvent: "regulait:trigger", issue: { id: "x".repeat(300) } }))).toEqual([]);
    expect(extractTriggerSignals("jira", "not json")).toEqual([]);
  });
});

describe("ADR-0356 Azure DevOps signals", () => {
  it("an AssignedTo change to the agent is a trigger (identity object and legacy string)", () => {
    const body = j({
      eventType: "workitem.updated",
      resource: {
        workItemId: 314,
        revisedBy: { id: "aaaaaaaa-0000-0000-0000-000000000001", uniqueName: "Alice@Contoso.com" },
        fields: { "System.AssignedTo": { oldValue: null, newValue: { id: ADO_AGENT, uniqueName: "regulait@contoso.com" } } },
      },
    });
    const [s] = extractTriggerSignals("azure_devops", body);
    expect(s).toMatchObject({ externalId: "314", mechanism: "assignment", actorIds: ["aaaaaaaa-0000-0000-0000-000000000001", "alice@contoso.com"] });
    expect(matchTrigger(s!, settings)).toBe(true);
    const legacy = j({
      eventType: "workitem.updated",
      resource: { workItemId: 314, revisedBy: { id: "x" }, fields: { "System.AssignedTo": { newValue: "RegulAIt Agent <REGULAIT@contoso.com>" } } },
    });
    expect(matchTrigger(extractTriggerSignals("azure_devops", legacy)[0]!, settings)).toBe(true);
  });
  it("an edit that does not change the assignee is not an assignment", () => {
    const body = j({ eventType: "workitem.updated", resource: { workItemId: 1, fields: { "System.AssignedTo": "RegulAIt <regulait@contoso.com>" } } });
    expect(extractTriggerSignals("azure_devops", body)).toEqual([]);
  });
  it("a data-vss-mention of the agent in a comment is a trigger", () => {
    const body = j({
      eventType: "workitem.commented",
      resource: {
        id: 77,
        fields: {
          "System.History": `<div><a href="#" data-vss-mention="version:2.0,${ADO_AGENT.toUpperCase()}">@RegulAIt</a> please</div>`,
          "System.ChangedBy": "Alice <alice@contoso.com>",
        },
      },
    });
    const [s] = extractTriggerSignals("azure_devops", body);
    expect(s).toMatchObject({ externalId: "77", mechanism: "mention", actorIds: ["alice@contoso.com"], targetIds: [ADO_AGENT] });
    expect(matchTrigger(s!, settings)).toBe(true);
  });
  it("a service-hook subscription pointed at ?trigger=rule is a rule trigger", () => {
    const body = j({ eventType: "workitem.updated", resource: { workItemId: 5, revisedBy: { id: "u1" }, fields: {} } });
    expect(extractTriggerSignals("azure_devops", body, { trigger: "rule" })[0]).toMatchObject({ mechanism: "rule", externalId: "5" });
    expect(extractTriggerSignals("azure_devops", body)).toEqual([]);
  });
  it("a disabled mechanism is not a trigger", () => {
    const off = { ...settings, mechanisms: { ...settings.mechanisms, rule: false } };
    expect(matchTrigger({ externalId: "5", mechanism: "rule", actorIds: ["u1"], targetIds: [] }, off)).toBe(false);
  });
});

describe("ADR-0356 providers without a case", () => {
  it("return no signal", () => {
    for (const p of ["linear", "asana", "monday", "generic_webhook", "mock"] as const) {
      expect(extractTriggerSignals(p, j({ webhookEvent: "regulait:trigger", issue: { id: "1" } }))).toEqual([]);
    }
  });
});
