/**
 * ADR-0173 batch 2c (Q) — annotation queues, end to end against a real
 * Postgres and the real app.
 *
 * Rules, each with its control:
 *  - queue CRUD and enqueue are admin-only (a non-admin gets 403; an admin
 *    gets through);
 *  - enqueue answers {added, skipped:[{id, reason}]}, at most 500 subjects,
 *    deduplicated per (queue, subject) within a call and across calls;
 *  - reading an item: a named reviewer or an admin; anyone else (including
 *    the trace's own person when not a reviewer) gets 403 and a deny audit
 *    row; every read is audited; a non-admin gets previews only (cut, no
 *    attributes) while an admin gets the stored content;
 *  - no self-review: neither the trace's person nor the run's initiator;
 *  - N-person review: distinct reviewers (the same one again: 409, an
 *    identical replay: the recorded review, no new row), complete only at N,
 *    disagreement recorded, a completed item immutable;
 *  - rubric bounds (range, label set, 2000-char comment, unknown criteria);
 *    editing a rubric that has reviews creates a new version, one without is
 *    replaced in place;
 *  - withheld content shows the marker; pruned content shows "no longer
 *    retained" and cannot be reviewed;
 *  - each submission writes trace_scores (source annotation) without the
 *    comment, and the webhook payloads carry no comment;
 *  - the export is admin-only, audited, CSV-injection-safe and content-free;
 *  - the SLA-breach event fires once per item.
 *
 * Shared state (M-068): the webhook subscription this file adds is removed in
 * afterAll; queues, traces and eval rows it writes are removed there too.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  and,
  annotationItems,
  annotationQueues,
  annotationSubmissions,
  auditLog,
  eq,
  evalCases,
  evalDatasets,
  evalResults,
  evalRuns,
  inArray,
  ORG_SETTINGS_ID,
  orgSettings,
  traceScores,
  traceSpans,
  traces,
  webhookDeliveries,
  webhookSubscriptions,
} from "@regulait/db";
import { loadOrgSettings } from "./org-settings.js";
import { calibrationLabelsFromAnnotations } from "./eval-judge-calibration.js";
import { ANNOTATION_LIMITS, ANNOTATION_NOT_RETAINED, ANNOTATION_WITHHELD_MARKER } from "@regulait/shared";
import { builderKit, type BuilderKit, type Person } from "./testing/builder-fixture.js";
import { drainBackgroundWork } from "./background-work.js";
import { annotationCsvCell, annotationLabelsFor, enqueueAnnotationItems, runAnnotationSlaSweep } from "./annotations.js";

let k: BuilderKit;
let admin: Person;
let rev1: Person;
let rev2: Person;
let rev3: Person;
let owner: Person;
let outsider: Person;
let subId = "";
const queueIds: string[] = [];
const traceIds: string[] = [];
let evalDatasetId = "";
let evalRunId = "";

const RUBRIC = {
  criteria: [
    { name: "helpfulness", kind: "score", min: 1, max: 5, step: 1 },
    { name: "verdict", kind: "label", labels: ["good", "bad"] },
  ],
};
const LONG = "x".repeat(ANNOTATION_LIMITS.previewChars + 500);

async function mkTrace(userId: string, opts: { withheld?: boolean } = {}) {
  const [t] = await k.db
    .insert(traces)
    .values({ kind: "dispatch", name: `q trace ${k.RUN}`, userId, status: "ok", spanCount: 1 })
    .returning({ id: traces.id });
  traceIds.push(t!.id);
  const [s] = await k.db
    .insert(traceSpans)
    .values({
      traceId: t!.id,
      seq: 1,
      kind: "llm",
      name: "call",
      status: "ok",
      startedAt: new Date(),
      model: "mock-balanced",
      inputPreview: opts.withheld ? "[withheld by guardrail]" : `secret question ${LONG}`,
      outputPreview: opts.withheld ? "[withheld by guardrail]" : "the answer",
      contentWithheld: !!opts.withheld,
      attributes: { toolArgs: { apiKey: "[REDACTED]" } },
    })
    .returning({ id: traceSpans.id });
  return { traceId: t!.id, spanId: s!.id };
}

async function mkQueue(body: Record<string, unknown>) {
  const r = await k.req("POST", "/v1/annotation-queues", admin.auth, {
    name: `q-${k.RUN}-${queueIds.length}`,
    rubric: RUBRIC,
    reviewerUserIds: [rev1.id, rev2.id, rev3.id],
    ...body,
  });
  expect(r.statusCode, r.body).toBe(201);
  queueIds.push(r.json().id);
  return r.json() as { id: string; rubricVersion: number };
}

async function enqueue(queueId: string, subjects: Array<{ kind: string; id: string }>, who = admin) {
  return k.req("POST", `/v1/annotation-queues/${queueId}/items`, who.auth, { subjects });
}

const itemOf = async (queueId: string, subjectId: string) =>
  (await k.db.select().from(annotationItems).where(and(eq(annotationItems.queueId, queueId), eq(annotationItems.subjectId, subjectId))))[0]!;

const auditRows = (ruleId: string, objectId: string) =>
  k.db.select().from(auditLog).where(and(eq(auditLog.ruleId, ruleId), eq(auditLog.objectId, objectId)));

const submit = (who: Person, itemId: string, body: Record<string, unknown>) =>
  k.req("POST", `/v1/annotations/items/${itemId}/submissions`, who.auth, body);

beforeAll(async () => {
  k = await builderKit("annq");
  admin = await k.person("admin", { admin: true });
  rev1 = await k.person("rev1");
  rev2 = await k.person("rev2");
  rev3 = await k.person("rev3");
  owner = await k.person("owner");
  outsider = await k.person("outsider");
  // one active subscription to every annotation and trace event, so the
  // payloads can be inspected (removed in afterAll — M-068). Its URL is not
  // allow-listed, so nothing leaves the box.
  const [s] = await k.db
    .insert(webhookSubscriptions)
    .values({ name: `annq-${k.RUN}`, url: "https://annq.example.invalid/hook", events: ["annotation.*", "trace.queued"], secretCiphertext: "x" })
    .returning({ id: webhookSubscriptions.id });
  subId = s!.id;
});

afterAll(async () => {
  await drainBackgroundWork(k.db);
  if (subId) await k.db.delete(webhookSubscriptions).where(eq(webhookSubscriptions.id, subId));
  if (queueIds.length) await k.db.delete(annotationQueues).where(inArray(annotationQueues.id, queueIds));
  if (traceIds.length) await k.db.delete(traces).where(inArray(traces.id, traceIds));
  if (evalRunId) await k.db.delete(evalRuns).where(eq(evalRuns.id, evalRunId));
  if (evalDatasetId) await k.db.delete(evalDatasets).where(eq(evalDatasets.id, evalDatasetId));
  await k.close();
});

describe("queue setup is admin-only", () => {
  it("refuses a non-admin on every setup route, and lets an admin through", async () => {
    const q = await mkQueue({});
    for (const [method, url, body] of [
      ["GET", "/v1/annotation-queues", undefined],
      ["POST", "/v1/annotation-queues", { name: "nope", rubric: RUBRIC, reviewerUserIds: [] }],
      ["GET", `/v1/annotation-queues/${q.id}`, undefined],
      ["PATCH", `/v1/annotation-queues/${q.id}`, { name: "renamed" }],
      ["DELETE", `/v1/annotation-queues/${q.id}`, undefined],
      ["POST", `/v1/annotation-queues/${q.id}/items`, { subjects: [] }],
      ["GET", `/v1/annotation-queues/${q.id}/items`, undefined],
      ["GET", `/v1/annotation-queues/${q.id}/export`, undefined],
      ["POST", "/v1/annotation-queues/sla-sweep", {}],
    ] as const) {
      const r = await k.req(method, url, rev1.auth, body);
      expect(r.statusCode, `${method} ${url}`).toBe(403);
    }
    expect((await k.req("GET", `/v1/annotation-queues/${q.id}`, admin.auth)).statusCode).toBe(200);
    expect((await k.req("GET", "/v1/annotation-queues", admin.auth)).json().queues.map((x: { id: string }) => x.id)).toContain(q.id);
  });

  it("needs N named reviewers for an N-person review, and real active people", async () => {
    const tooFew = await k.req("POST", "/v1/annotation-queues", admin.auth, {
      name: `q-${k.RUN}-few`,
      rubric: RUBRIC,
      reviewerUserIds: [rev1.id],
      requiredReviews: 2,
    });
    expect(tooFew.statusCode).toBe(400);
    const ghost = await k.req("POST", "/v1/annotation-queues", admin.auth, {
      name: `q-${k.RUN}-ghost`,
      rubric: RUBRIC,
      reviewerUserIds: ["00000000-0000-4000-8000-00000000dead"],
    });
    expect(ghost.statusCode).toBe(422);
    expect(ghost.json().error).toBe("unknown_reviewer");
  });
});

describe("enqueue", () => {
  it("answers {added, skipped}, deduplicates per (queue, subject), and is audited", async () => {
    const q = await mkQueue({});
    const a = await mkTrace(owner.id);
    const b = await mkTrace(owner.id);
    const missing = "00000000-0000-4000-8000-0000000000aa";
    const r = await enqueue(q.id, [
      { kind: "trace", id: a.traceId },
      { kind: "trace", id: a.traceId },
      { kind: "span", id: b.spanId },
      { kind: "trace", id: missing },
    ]);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().added).toBe(2);
    expect(r.json().skipped).toEqual([
      { id: a.traceId, reason: "duplicate" },
      { id: missing, reason: "not_found" },
    ]);
    // again: everything already queued is a duplicate, nothing is added
    const again = await enqueue(q.id, [{ kind: "trace", id: a.traceId }]);
    expect(again.json()).toMatchObject({ added: 0, skipped: [{ id: a.traceId, reason: "duplicate" }] });
    expect(await k.db.select().from(annotationItems).where(eq(annotationItems.queueId, q.id))).toHaveLength(2);
    expect(await auditRows("annotation-items-queued", q.id)).toHaveLength(2);
    // the span item carries its trace; the subject's person is captured for the self-review rule
    const spanItem = await itemOf(q.id, b.spanId);
    expect(spanItem).toMatchObject({ traceId: b.traceId, spanId: b.spanId, subjectUserIds: [owner.id] });
    // trace.queued: ids only
    const sent = await k.db
      .select()
      .from(webhookDeliveries)
      .where(and(eq(webhookDeliveries.subscriptionId, subId), eq(webhookDeliveries.event, "trace.queued")));
    const mine = sent.filter((d) => (d.payload as { queueId?: string }).queueId === q.id);
    expect(mine).toHaveLength(2);
    expect(Object.keys(mine[0]!.payload as object).sort()).toEqual(
      expect.arrayContaining(["itemId", "queueId", "queueName", "traceId", "queuedByUserId", "occurredAt"]),
    );
  });

  it("refuses more than 500 subjects in one call", async () => {
    const q = await mkQueue({});
    const subjects = Array.from({ length: ANNOTATION_LIMITS.itemsPerEnqueue + 1 }, (_, i) => ({
      kind: "trace",
      id: `00000000-0000-4000-8000-${i.toString(16).padStart(12, "0")}`,
    }));
    expect((await enqueue(q.id, subjects)).statusCode).toBe(400);
    // the exported function enforces the same bound (automation rules call it)
    await expect(
      enqueueAnnotationItems(k.db, { queueId: q.id, subjects: subjects as Array<{ kind: "trace"; id: string }>, actorUserId: admin.id }),
    ).rejects.toThrow();
    expect((await enqueue(q.id, subjects.slice(0, 500))).json()).toMatchObject({ added: 0 });
  });
});

describe("reading an item", () => {
  it("admits a named reviewer (previews only) and an admin (full), refuses anyone else with a deny audit row", async () => {
    const q = await mkQueue({});
    const t = await mkTrace(owner.id);
    await enqueue(q.id, [{ kind: "trace", id: t.traceId }]);
    const item = await itemOf(q.id, t.traceId);

    const asReviewer = await k.req("GET", `/v1/annotations/items/${item.id}`, rev1.auth);
    expect(asReviewer.statusCode, asReviewer.body).toBe(200);
    const p = asReviewer.json().preview;
    expect(p.previewOnly).toBe(true);
    expect(p.spans[0].input.length).toBeLessThan(LONG.length);
    expect(p.spans[0]).not.toHaveProperty("attributes");
    expect(asReviewer.json()).not.toHaveProperty("submissions");
    expect(asReviewer.json().you).toMatchObject({ isReviewer: true, canSubmit: true });

    const asAdmin = await k.req("GET", `/v1/annotations/items/${item.id}`, admin.auth);
    expect(asAdmin.statusCode).toBe(200);
    expect(asAdmin.json().preview.previewOnly).toBe(false);
    expect(asAdmin.json().preview.spans[0].input).toBe(`secret question ${LONG}`);
    expect(asAdmin.json().preview.spans[0].attributes).toEqual({ toolArgs: { apiKey: "[REDACTED]" } });

    // the trace's own person is not a reviewer here: the queue route refuses them
    for (const who of [outsider, owner]) {
      const r = await k.req("GET", `/v1/annotations/items/${item.id}`, who.auth);
      expect(r.statusCode).toBe(403);
      expect(JSON.stringify(r.json())).not.toContain("secret question");
    }
    const reads = await auditRows("annotation-item-read", item.id);
    expect(reads.map((r) => r.userId).sort()).toEqual([rev1.id, admin.id].sort());
    expect(reads.every((r) => r.effect === "allow")).toBe(true);
    const denied = await auditRows("annotation-item-read-denied", item.id);
    expect(denied.map((r) => r.userId).sort()).toEqual([outsider.id, owner.id].sort());
    expect(denied.every((r) => r.effect === "deny")).toBe(true);
  });

  it("shows the withheld marker instead of withheld content, and 'no longer retained' once pruned", async () => {
    const q = await mkQueue({});
    const w = await mkTrace(owner.id, { withheld: true });
    const gone = await mkTrace(owner.id);
    await enqueue(q.id, [
      { kind: "span", id: w.spanId },
      { kind: "trace", id: gone.traceId },
    ]);
    const wItem = await itemOf(q.id, w.spanId);
    const r = await k.req("GET", `/v1/annotations/items/${wItem.id}`, admin.auth);
    expect(r.json().preview.spans[0]).toMatchObject({ withheld: true, input: ANNOTATION_WITHHELD_MARKER, output: ANNOTATION_WITHHELD_MARKER });
    expect(JSON.stringify(r.json())).not.toContain("withheld by guardrail");

    const goneItem = await itemOf(q.id, gone.traceId);
    await k.db.delete(traces).where(eq(traces.id, gone.traceId)); // the §8.3 prune / an erasure
    const g = await k.req("GET", `/v1/annotations/items/${goneItem.id}`, rev1.auth);
    expect(g.statusCode).toBe(200);
    expect(g.json().preview).toMatchObject({ retained: false, note: ANNOTATION_NOT_RETAINED, spans: [] });
    expect(g.json().you).toMatchObject({ canSubmit: false, blockedReason: "not_retained" });
    const s = await submit(rev1, goneItem.id, { values: { helpfulness: 3, verdict: "good" } });
    expect(s.statusCode).toBe(409);
    expect(s.json().error).toBe("subject_not_retained");
  });
});

describe("no self-review", () => {
  it("refuses the trace's person and the run's initiator, with a deny audit row", async () => {
    // rev3 is a named reviewer AND the person whose trace this is
    const q = await mkQueue({});
    const t = await mkTrace(rev3.id);
    // an eval result whose run rev2 initiated
    const [ds] = await k.db.insert(evalDatasets).values({ name: `annq-ds-${k.RUN}` }).returning();
    evalDatasetId = ds!.id;
    const [c] = await k.db.insert(evalCases).values({ datasetId: ds!.id, datasetVersion: 1, input: "what is 2+2?" }).returning();
    const [run] = await k.db
      .insert(evalRuns)
      .values({ datasetId: ds!.id, datasetVersion: 1, agentName: "a", trigger: "manual", status: "completed", initiatedByUserId: rev2.id })
      .returning();
    evalRunId = run!.id;
    const [res] = await k.db
      .insert(evalResults)
      .values({ runId: run!.id, caseId: c!.id, scorerKind: "contains", score: 1, passed: true, outputText: "4" })
      .returning();
    await enqueue(q.id, [
      { kind: "trace", id: t.traceId },
      { kind: "eval_result", id: res!.id },
    ]);
    const tItem = await itemOf(q.id, t.traceId);
    const eItem = await itemOf(q.id, res!.id);
    expect(eItem.subjectUserIds).toEqual([rev2.id]);

    const own = await submit(rev3, tItem.id, { values: { helpfulness: 5, verdict: "good" } });
    expect(own.statusCode).toBe(403);
    expect(own.json().error).toBe("self_review");
    const initiator = await submit(rev2, eItem.id, { values: { helpfulness: 5, verdict: "good" } });
    expect(initiator.statusCode).toBe(403);
    expect(initiator.json().error).toBe("self_review");
    expect((await auditRows("annotation-submit-refused", tItem.id))[0]).toMatchObject({ effect: "deny", userId: rev3.id });
    expect((await auditRows("annotation-submit-refused", eItem.id))[0]).toMatchObject({ effect: "deny", userId: rev2.id });
    // their inbox does not offer their own work
    const inbox = (await k.req("GET", "/v1/annotations/inbox", rev3.auth)).json().items.map((i: { id: string }) => i.id);
    expect(inbox).not.toContain(tItem.id);
    expect(inbox).toContain(eItem.id);
    // the eval preview is the case input and the stored output
    const read = await k.req("GET", `/v1/annotations/items/${eItem.id}`, rev1.auth);
    expect(read.json().preview.evalResult).toMatchObject({ input: "what is 2+2?", output: "4", withheld: false });
    expect(read.json().preview.evalResult).not.toHaveProperty("judgeRationale");
    // an admin who is not a named reviewer cannot submit (reviews count toward N)
    const adminSubmit = await submit(admin, eItem.id, { values: { helpfulness: 5, verdict: "good" } });
    expect(adminSubmit.statusCode).toBe(403);
    expect(adminSubmit.json().error).toBe("not_a_reviewer");
  });
});

describe("eval-result items (fix round A)", () => {
  /** a dataset, one case (optionally built from a trace), a completed run and its result */
  async function evalResultFixture(opts: { sourceTraceId?: string; initiator: string }) {
    const [ds] = await k.db.insert(evalDatasets).values({ name: `annq-fa-${k.RUN}-${Math.random().toString(36).slice(2, 8)}` }).returning();
    const [c] = await k.db
      .insert(evalCases)
      .values({ datasetId: ds!.id, datasetVersion: 1, input: `fix-a prompt ${LONG}`, sourceTraceId: opts.sourceTraceId ?? null })
      .returning();
    const [run] = await k.db
      .insert(evalRuns)
      .values({ datasetId: ds!.id, datasetVersion: 1, agentName: "a", trigger: "manual", status: "completed", initiatedByUserId: opts.initiator })
      .returning();
    const [res] = await k.db
      .insert(evalResults)
      .values({ runId: run!.id, caseId: c!.id, scorerKind: "contains", score: 1, passed: true, outputText: "fix-a output" })
      .returning();
    return {
      resultId: res!.id,
      cleanup: async () => {
        await k.db.delete(evalRuns).where(eq(evalRuns.id, run!.id));
        await k.db.delete(evalDatasets).where(eq(evalDatasets.id, ds!.id));
      },
    };
  }

  it("a case built from a trace makes that trace's person a subject user: they cannot review their own prompt", async () => {
    const q = await mkQueue({});
    const t = await mkTrace(rev1.id);
    const f = await evalResultFixture({ sourceTraceId: t.traceId, initiator: admin.id });
    try {
      await enqueue(q.id, [{ kind: "eval_result", id: f.resultId }]);
      const item = await itemOf(q.id, f.resultId);
      expect([...item.subjectUserIds].sort()).toEqual([admin.id, rev1.id].sort());
      const own = await submit(rev1, item.id, { values: { helpfulness: 5, verdict: "good" } });
      expect(own.statusCode).toBe(403);
      expect(own.json().error).toBe("self_review");
      const inbox = (await k.req("GET", "/v1/annotations/inbox", rev1.auth)).json().items.map((i: { id: string }) => i.id);
      expect(inbox).not.toContain(item.id);
      expect((await submit(rev2, item.id, { values: { helpfulness: 5, verdict: "good" } })).statusCode).toBe(201);
    } finally {
      await f.cleanup();
    }
  });

  it("with the org's content capture off, a non-admin reviewer sees the withheld marker for the case input and output", async () => {
    const q = await mkQueue({});
    const f = await evalResultFixture({ initiator: owner.id });
    const prior = await loadOrgSettings(k.db);
    try {
      await enqueue(q.id, [{ kind: "eval_result", id: f.resultId }]);
      const item = await itemOf(q.id, f.resultId);
      // capture on: the cut preview
      const on = (await k.req("GET", `/v1/annotations/items/${item.id}`, rev1.auth)).json().preview.evalResult;
      expect(on.input.startsWith("fix-a prompt")).toBe(true);
      expect(on.withheld).toBe(false);
      await k.db.update(orgSettings).set({ tracingCaptureContent: false }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
      const off = await k.req("GET", `/v1/annotations/items/${item.id}`, rev1.auth);
      expect(off.json().preview.evalResult).toMatchObject({ input: ANNOTATION_WITHHELD_MARKER, output: ANNOTATION_WITHHELD_MARKER, withheld: true });
      expect(off.body).not.toContain("fix-a prompt");
      expect(off.body).not.toContain("fix-a output");
      // an admin keeps full access
      const adm = (await k.req("GET", `/v1/annotations/items/${item.id}`, admin.auth)).json().preview.evalResult;
      expect(adm.input.startsWith("fix-a prompt")).toBe(true);
      expect(adm.output).toBe("fix-a output");
    } finally {
      await k.db.update(orgSettings).set({ tracingCaptureContent: prior.tracingCaptureContent }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
      await f.cleanup();
    }
  });

  it("labels carry each criterion's bounds or allowed labels from the rubric version the review used", async () => {
    const q = await mkQueue({});
    const t = await mkTrace(owner.id);
    await enqueue(q.id, [{ kind: "trace", id: t.traceId }]);
    const item = await itemOf(q.id, t.traceId);
    expect((await submit(rev1, item.id, { values: { helpfulness: 1, verdict: "bad" } })).statusCode).toBe(201);
    // a later rubric version on another scale does not rewrite the earlier review's scale
    const v2 = { criteria: [{ name: "helpfulness", kind: "score", min: 0, max: 10 }, { name: "verdict", kind: "label", labels: ["good", "bad", "meh"] }] };
    expect((await k.req("PATCH", `/v1/annotation-queues/${q.id}`, admin.auth, { rubric: v2 })).statusCode).toBe(200);
    const [l] = await annotationLabelsFor(k.db, { kind: "trace", ids: [t.traceId] });
    expect(l!.criteria).toEqual([
      { name: "helpfulness", kind: "score", min: 1, max: 5 },
      { name: "verdict", kind: "label", labels: ["good", "bad"] },
    ]);
    // through the calibration adapter, a 1 on 1-5 is the bottom of the scale
    const [cal] = calibrationLabelsFromAnnotations([l!]);
    expect(cal!.criteria).toEqual([
      { name: "helpfulness", kind: "score", value: 0, min: 1, max: 5 },
      { name: "verdict", kind: "label", value: "bad", labels: ["good", "bad"] },
    ]);
  });
});

describe("N-person review", () => {
  it("needs distinct reviewers, completes only at N, records disagreement, and then is immutable", async () => {
    const q = await mkQueue({ requiredReviews: 2 });
    const t = await mkTrace(owner.id);
    await enqueue(q.id, [{ kind: "trace", id: t.traceId }]);
    const item = await itemOf(q.id, t.traceId);
    const first = { values: { helpfulness: 1, verdict: "bad" }, comment: "=HYPERLINK(\"http://evil\")" };

    const s1 = await submit(rev1, item.id, first);
    expect(s1.statusCode, s1.body).toBe(201);
    expect(s1.json().item.status).toBe("open");
    // idempotent: the same review again is the recorded one, no new row
    const replay = await submit(rev1, item.id, first);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ replayed: true, submission: { id: s1.json().submission.id } });
    // the same reviewer with a different review: 409, never a second count toward N
    const twice = await submit(rev1, item.id, { values: { helpfulness: 5, verdict: "good" } });
    expect(twice.statusCode).toBe(409);
    expect(twice.json().error).toBe("already_submitted");
    expect(await k.db.select().from(annotationSubmissions).where(eq(annotationSubmissions.itemId, item.id))).toHaveLength(1);
    expect((await itemOf(q.id, t.traceId)).status).toBe("open");

    const s2 = await submit(rev2, item.id, { values: { helpfulness: 5, verdict: "good" } });
    expect(s2.statusCode).toBe(201);
    expect(s2.json().item).toMatchObject({ status: "completed", disagreement: true });
    const done = await itemOf(q.id, t.traceId);
    expect(done.disagreementDetail?.map((d) => d.criterion).sort()).toEqual(["helpfulness", "verdict"]);

    // completed = immutable
    const late = await submit(rev3, item.id, { values: { helpfulness: 3, verdict: "good" } });
    expect(late.statusCode).toBe(409);
    expect(late.json().error).toBe("item_completed");

    // trace scores: one per criterion per review, source annotation, never the comment
    const scores = await k.db.select().from(traceScores).where(eq(traceScores.traceId, t.traceId));
    expect(scores).toHaveLength(4);
    expect(scores.every((s) => s.source === "annotation")).toBe(true);
    expect(JSON.stringify(scores)).not.toContain("HYPERLINK");
    // webhooks: submitted x2 + completed, ids and scores only
    const events = (await k.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.subscriptionId, subId))).filter(
      (d) => (d.payload as { itemId?: string }).itemId === item.id && d.event.startsWith("annotation."),
    );
    expect(events.map((e) => e.event).sort()).toEqual(["annotation.item.completed", "annotation.submitted", "annotation.submitted"]);
    expect(JSON.stringify(events.map((e) => e.payload))).not.toContain("HYPERLINK");
    const completed = events.find((e) => e.event === "annotation.item.completed")!.payload as Record<string, unknown>;
    expect(completed).toMatchObject({ reviewerCount: 2, disagreement: true, scores: [{ name: "helpfulness", value: 3 }, { name: "verdict", label: "good" }] });
    expect(await auditRows("annotation-item-completed", item.id)).toHaveLength(1);

    // the labels E and K read: values, never comments
    const labels = await annotationLabelsFor(k.db, { kind: "trace", ids: [t.traceId] });
    expect(labels.map((l) => l.reviewerUserId)).toEqual([rev1.id, rev2.id]);
    expect(JSON.stringify(labels)).not.toContain("HYPERLINK");
  });
});

describe("rubric bounds and versions", () => {
  it("refuses a score out of range or off its step, a label outside the set, an unknown criterion and a long comment", async () => {
    const q = await mkQueue({});
    const t = await mkTrace(owner.id);
    await enqueue(q.id, [{ kind: "trace", id: t.traceId }]);
    const item = await itemOf(q.id, t.traceId);
    for (const body of [
      { values: { helpfulness: 6, verdict: "good" } },
      { values: { helpfulness: 2.5, verdict: "good" } },
      { values: { helpfulness: 3, verdict: "maybe" } },
      { values: { helpfulness: 3 } },
      { values: { helpfulness: 3, verdict: "good", extra: 1 } },
      { values: { helpfulness: 3, verdict: "good" }, comment: "c".repeat(ANNOTATION_LIMITS.commentChars + 1) },
    ]) {
      const r = await submit(rev1, item.id, body);
      expect(r.statusCode, JSON.stringify(body).slice(0, 80)).toBe(422);
      expect(r.json().error).toBe("rubric_violation");
    }
    const ok = await submit(rev1, item.id, { values: { helpfulness: 3, verdict: "good" }, comment: "c".repeat(ANNOTATION_LIMITS.commentChars) });
    expect(ok.statusCode).toBe(201);
  });

  it("replaces an unused rubric in place, and versions one that has reviews", async () => {
    const q = await mkQueue({});
    const edited = { criteria: [...RUBRIC.criteria, { name: "safety", kind: "label", labels: ["safe", "unsafe"] }] };
    const p1 = await k.req("PATCH", `/v1/annotation-queues/${q.id}`, admin.auth, { rubric: edited });
    expect(p1.statusCode, p1.body).toBe(200);
    expect(p1.json().rubricVersion).toBe(1);
    expect(p1.json().rubricVersions).toHaveLength(1);

    const t = await mkTrace(owner.id);
    await enqueue(q.id, [{ kind: "trace", id: t.traceId }]);
    const item = await itemOf(q.id, t.traceId);
    expect((await submit(rev1, item.id, { values: { helpfulness: 4, verdict: "good", safety: "safe" } })).statusCode).toBe(201);

    const p2 = await k.req("PATCH", `/v1/annotation-queues/${q.id}`, admin.auth, { rubric: RUBRIC });
    expect(p2.json().rubricVersion).toBe(2);
    expect(p2.json().rubricVersions.map((v: { version: number }) => v.version)).toEqual([2, 1]);
    // the earlier review keeps the version it was made against
    const [sub] = await k.db.select().from(annotationSubmissions).where(eq(annotationSubmissions.itemId, item.id));
    expect(sub!.rubricVersion).toBe(1);
    expect((await auditRows("annotation-queue-updated", q.id)).map((r) => (r.detail as { rubricChange: string }).rubricChange).sort()).toEqual([
      "new_version",
      "replaced",
    ]);
  });
});

describe("export", () => {
  it("is CSV-injection-safe, content-free and audited", async () => {
    expect(annotationCsvCell("=1+1")).toBe("'=1+1");
    expect(annotationCsvCell("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(annotationCsvCell('-2,"x"')).toBe(`"'-2,""x"""`);
    expect(annotationCsvCell(-2)).toBe("-2");
    // fix round A (csv-stringify): the full-width forms a spreadsheet also evaluates
    expect(annotationCsvCell("＝1+1")).toBe("'＝1+1");
    expect(annotationCsvCell(true)).toBe("true");

    const q = await mkQueue({});
    const t = await mkTrace(owner.id);
    await enqueue(q.id, [{ kind: "trace", id: t.traceId }]);
    const item = await itemOf(q.id, t.traceId);
    await submit(rev1, item.id, { values: { helpfulness: 2, verdict: "bad" }, comment: "=cmd|' /C calc'!A0" });
    const r = await k.req("GET", `/v1/annotation-queues/${q.id}/export`, admin.auth);
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toMatch(/text\/csv/);
    const lines = r.body.trim().split("\r\n");
    expect(lines[0]).toBe(
      "item_id,subject_kind,subject_id,trace_id,span_id,item_status,disagreement,submission_id,reviewer_user_id,rubric_version,submitted_at,criterion,score,label,comment",
    );
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain(",helpfulness,2,,");
    expect(lines[2]).toContain(",verdict,,bad,");
    for (const l of lines.slice(1)) expect(l.endsWith(`'=cmd|' /C calc'!A0`)).toBe(true);
    expect(r.body).not.toContain("secret question");
    expect(await auditRows("annotation-queue-exported", q.id)).toHaveLength(1);
  });
});

describe("the SLA sweep", () => {
  it("marks an overdue item breached once, audits it once and sends one event", async () => {
    const q = await mkQueue({ slaHours: 1 });
    const t = await mkTrace(owner.id);
    await enqueue(q.id, [{ kind: "trace", id: t.traceId }]);
    const item = await itemOf(q.id, t.traceId);
    const later = new Date(item.dueAt!.getTime() + 60_000);
    expect((await runAnnotationSlaSweep(k.db, undefined, { now: new Date(item.dueAt!.getTime() - 60_000) })).itemIds).not.toContain(item.id);
    expect((await runAnnotationSlaSweep(k.db, undefined, { now: later })).itemIds).toContain(item.id);
    expect((await runAnnotationSlaSweep(k.db, undefined, { now: new Date(later.getTime() + 60_000) })).itemIds).not.toContain(item.id);
    const viaRoute = await k.req("POST", "/v1/annotation-queues/sla-sweep", admin.auth, {});
    expect(viaRoute.statusCode).toBe(200);
    expect(viaRoute.json().itemIds).not.toContain(item.id);

    expect((await itemOf(q.id, t.traceId)).slaBreachedAt?.toISOString()).toBe(later.toISOString());
    expect(await auditRows("annotation-sla-breached", item.id)).toHaveLength(1);
    const events = (await k.db.select().from(webhookDeliveries).where(and(eq(webhookDeliveries.subscriptionId, subId), eq(webhookDeliveries.event, "annotation.sla.breached")))).filter(
      (d) => (d.payload as { itemId?: string }).itemId === item.id,
    );
    expect(events).toHaveLength(1);
    expect((events[0]!.payload as { reviewerUserIds: string[] }).reviewerUserIds.sort()).toEqual([rev1.id, rev2.id, rev3.id].sort());
    const list = await k.req("GET", `/v1/annotation-queues/${q.id}/items`, admin.auth);
    expect(list.json().items[0]).toMatchObject({ id: item.id, slaBreached: true });
  });
});
