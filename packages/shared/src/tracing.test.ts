/**
 * ADR-0070 — the pure half, attacked with data a database is not supposed to
 * be able to produce.
 *
 * The tree builder is the single place parentage is decided, which makes it the
 * single place a trace viewer can silently lose a branch. Every test here is a
 * shape that would make a naive builder either drop a span or never terminate:
 * an orphan, a cycle, a duplicate `seq`, an empty set. The rule it enforces is
 * that NOTHING IS EVER DROPPED — a span whose parent is missing is reattached
 * at the root and FLAGGED, because a missing branch is the one failure mode a
 * trace viewer must not have, and a silently-relocated one is a lie about
 * causality.
 */
import { describe, expect, it } from "vitest";
import {
  TRACE_TRUNCATION_MARKER,
  buildOtlpPayload,
  buildSpanTree,
  flattenSpanTree,
  otelAttributesForSpan,
  otelStatus,
  otlpSpanId,
  otlpTraceId,
  summariseSpanTree,
  toolPayloadPreview,
  tracePreview,
  type SpanRecord,
  type TraceRecord,
} from "./tracing.js";

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function span(over: Partial<SpanRecord> & { id: string }): SpanRecord {
  return {
    traceId: U(999),
    parentSpanId: null,
    seq: 0,
    kind: "llm",
    name: "s",
    status: "ok",
    statusReason: null,
    startedAt: "2026-08-07T00:00:00.000Z",
    endedAt: "2026-08-07T00:00:01.000Z",
    durationMs: 1000,
    ...over,
  };
}

describe("buildSpanTree", () => {
  it("nests by parentSpanId and assigns real depths", () => {
    const spans = [
      span({ id: U(1), seq: 0, kind: "run" }),
      span({ id: U(2), seq: 1, kind: "run_node", parentSpanId: U(1) }),
      span({ id: U(3), seq: 2, kind: "llm", parentSpanId: U(2) }),
      span({ id: U(4), seq: 3, kind: "tool", parentSpanId: U(3) }),
    ];
    const tree = buildSpanTree(spans);
    expect(tree).toHaveLength(1);
    const flat = flattenSpanTree(tree);
    expect(flat.map((n) => n.depth)).toEqual([0, 1, 2, 3]);
    expect(flat.map((n) => n.id)).toEqual([U(1), U(2), U(3), U(4)]);
  });

  it("orders siblings by seq, NOT by timestamp — and the timestamps disagree on purpose", () => {
    const spans = [
      span({ id: U(1), seq: 0, kind: "run" }),
      // three children whose START INSTANTS are identical to the millisecond,
      // which is exactly what an in-process path produces
      span({ id: U(4), seq: 3, parentSpanId: U(1), startedAt: "2026-08-07T00:00:00.000Z" }),
      span({ id: U(2), seq: 1, parentSpanId: U(1), startedAt: "2026-08-07T00:00:00.000Z" }),
      span({ id: U(3), seq: 2, parentSpanId: U(1), startedAt: "2026-08-07T00:00:00.000Z" }),
    ];
    const kids = buildSpanTree(spans)[0]!.children;
    expect(kids.map((k) => k.seq)).toEqual([1, 2, 3]);
    // and the order is STABLE across shuffles of the input
    const reversed = buildSpanTree([...spans].reverse())[0]!.children;
    expect(reversed.map((k) => k.id)).toEqual(kids.map((k) => k.id));
  });

  it("falls back to id when two siblings somehow share a seq, so order is TOTAL", () => {
    const spans = [
      span({ id: U(1), seq: 0, kind: "run" }),
      span({ id: U(3), seq: 7, parentSpanId: U(1) }),
      span({ id: U(2), seq: 7, parentSpanId: U(1) }),
    ];
    const kids = buildSpanTree(spans)[0]!.children;
    expect(kids.map((k) => k.id)).toEqual([U(2), U(3)]);
  });

  it("REATTACHES AND FLAGS an orphan rather than dropping it", () => {
    // the parent is not in the supplied set — what a truncated or paginated
    // read produces. A builder that silently skipped it would hide a branch.
    const spans = [
      span({ id: U(1), seq: 0, kind: "run" }),
      span({ id: U(2), seq: 1, parentSpanId: U(77) }),
    ];
    const tree = buildSpanTree(spans);
    expect(tree).toHaveLength(2);
    const orphan = tree.find((n) => n.id === U(2))!;
    expect(orphan.orphaned).toBe(true);
    expect(flattenSpanTree(tree)).toHaveLength(2);
  });

  it("terminates on a parent CYCLE and loses nothing", () => {
    // The DB's self-parent CHECK makes a one-row cycle impossible and nothing
    // in the recorder can build a two-row one — which is precisely why this is
    // tested: the failure mode is a hang, not a wrong answer.
    const spans = [
      span({ id: U(1), seq: 0, parentSpanId: U(2) }),
      span({ id: U(2), seq: 1, parentSpanId: U(1) }),
      span({ id: U(3), seq: 2 }),
    ];
    const tree = buildSpanTree(spans);
    expect(flattenSpanTree(tree)).toHaveLength(3);
    expect(tree.some((n) => n.orphaned)).toBe(true);
  });

  it("handles the empty set", () => {
    expect(buildSpanTree([])).toEqual([]);
    expect(summariseSpanTree([]).costUsd).toBeNull();
  });
});

describe("summariseSpanTree", () => {
  it("returns costUsd null when NOTHING was priced, rather than a confident zero", () => {
    const t = summariseSpanTree([
      span({ id: U(1), inputTokens: 10, outputTokens: 5, costUsd: null }),
      span({ id: U(2), inputTokens: 1, outputTokens: 1 }),
    ]);
    expect(t.inputTokens).toBe(11);
    expect(t.outputTokens).toBe(6);
    expect(t.costUsd).toBeNull();
  });

  it("sums only the priced spans and counts denials separately from errors", () => {
    const t = summariseSpanTree([
      span({ id: U(1), costUsd: 0.25, inputTokens: 4, outputTokens: 2 }),
      span({ id: U(2), costUsd: null, status: "denied", statusReason: "no grant" }),
      span({ id: U(3), status: "error" }),
    ]);
    expect(t.costUsd).toBe(0.25);
    expect(t.denied).toBe(1);
    expect(t.errors).toBe(1);
    expect(t.spans).toBe(3);
  });
});

describe("previews", () => {
  it("truncates with a marker that is distinguishable from a governance withhold", () => {
    const out = tracePreview("x".repeat(50), 10);
    expect(out!.startsWith("x".repeat(10))).toBe(true);
    expect(out).toContain(TRACE_TRUNCATION_MARKER);
    // the marker says TRUNCATED, not withheld — the two are different facts
    expect(out).not.toContain("withheld");
  });

  it("returns null for a zero limit, so a metadata-only posture stores nothing", () => {
    expect(tracePreview("something sensitive", 0)).toBeNull();
    expect(tracePreview(null, 100)).toBeNull();
  });

  it("never throws on an unserialisable tool payload", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    expect(() => toolPayloadPreview(cyclic, 100)).not.toThrow();
    expect(toolPayloadPreview(cyclic, 100)).toContain("unserialisable");
  });
});

describe("OTel mapping", () => {
  it("maps a DENY to ERROR with its reason, and keeps regulait.decision beside it", () => {
    expect(otelStatus("denied", "not entitled")).toEqual({ code: 2, message: "not entitled" });
    expect(otelStatus("ok", null)).toEqual({ code: 1 });
    expect(otelStatus("running", null)).toEqual({ code: 0 });
    const a = otelAttributesForSpan(
      span({ id: U(1), status: "denied", statusReason: "not entitled" }),
      { includeContent: false },
    );
    expect(a["regulait.decision"]).toBe("denied");
    expect(a["regulait.reason"]).toBe("not entitled");
  });

  it("emits published gen_ai.* keys and namespaces everything else under regulait.*", () => {
    const a = otelAttributesForSpan(
      span({
        id: U(1),
        provider: "anthropic",
        model: "claude-x",
        inputTokens: 12,
        outputTokens: 34,
        costUsd: 0.5,
        attributes: { stopReason: "end_turn" },
      }),
      { includeContent: false, sessionId: "sess-1", userId: U(9), projectId: U(8) },
    );
    expect(a["gen_ai.system"]).toBe("anthropic");
    expect(a["gen_ai.request.model"]).toBe("claude-x");
    expect(a["gen_ai.operation.name"]).toBe("chat");
    expect(a["gen_ai.usage.input_tokens"]).toBe(12);
    expect(a["gen_ai.usage.output_tokens"]).toBe(34);
    expect(a["gen_ai.response.finish_reasons"]).toBe("end_turn");
    expect(a["gen_ai.conversation.id"]).toBe("sess-1");
    expect(a["session.id"]).toBe("sess-1");
    // NO STANDARD GENAI COST KEY EXISTS. Inventing one would be squatting.
    expect(a["gen_ai.cost.usd"]).toBeUndefined();
    expect(a["regulait.cost.usd"]).toBe(0.5);
  });

  it("omits content entirely when the org withholds it", () => {
    const s = span({ id: U(1), inputPreview: "the prompt", outputPreview: "the answer" });
    const withheld = otelAttributesForSpan(s, { includeContent: false });
    expect(withheld["gen_ai.input.messages"]).toBeUndefined();
    expect(withheld["gen_ai.output.messages"]).toBeUndefined();
    const included = otelAttributesForSpan(s, { includeContent: true });
    expect(included["gen_ai.input.messages"]).toBe("the prompt");
  });

  it("does NOT claim a GenAI operation for a span that is not one", () => {
    const a = otelAttributesForSpan(span({ id: U(1), kind: "policy" }), { includeContent: false });
    expect(a["gen_ai.operation.name"]).toBeUndefined();
    expect(a["regulait.span.kind"]).toBe("policy");
  });
});

describe("OTLP encoding", () => {
  const trace: TraceRecord = {
    id: U(100),
    sessionId: "sess",
    kind: "run",
    rootRefId: U(101),
    name: "t",
    userId: U(9),
    projectId: null,
    status: "ok",
    startedAt: "2026-08-07T00:00:00.000Z",
    endedAt: "2026-08-07T00:00:02.000Z",
    durationMs: 2000,
    spanCount: 2,
    deniedSpanCount: 0,
    inputTokens: 1,
    outputTokens: 1,
    costUsd: 0.1,
  };

  it("maps our 16-byte trace uuid to the OTLP trace id with no information lost", () => {
    expect(otlpTraceId(U(100))).toBe(U(100).replace(/-/g, ""));
    expect(otlpTraceId(U(100))).toHaveLength(32);
  });

  it("truncates the span id to 8 bytes as OTLP requires — and that is DISCLOSED", () => {
    const full = U(1);
    expect(otlpSpanId(full)).toHaveLength(16);
    expect(otlpSpanId(full)).toBe(full.replace(/-/g, "").slice(0, 16));
    // the full uuid rides along, so the lossy mapping never loses the row
    const { body } = buildOtlpPayload({
      serviceName: "svc",
      includeContent: false,
      traces: [{ trace, spans: [span({ id: full })] }],
    });
    const emitted = (
      ((body["resourceSpans"] as Array<Record<string, unknown>>)[0]!["scopeSpans"] as Array<
        Record<string, unknown>
      >)[0]!["spans"] as Array<Record<string, unknown>>
    )[0]!;
    const attrs = Object.fromEntries(
      (emitted["attributes"] as Array<{ key: string; value: Record<string, unknown> }>).map((a) => [
        a.key,
        Object.values(a.value)[0],
      ]),
    );
    expect(attrs["regulait.span.id"]).toBe(full);
  });

  it("refuses a non-uuid rather than emitting a malformed id", () => {
    expect(() => otlpTraceId("not-a-uuid")).toThrow();
    expect(() => otlpSpanId("")).toThrow();
  });

  it("encodes nanosecond timestamps as decimal STRINGS (a Number loses precision)", () => {
    const { body } = buildOtlpPayload({
      serviceName: "svc",
      includeContent: false,
      traces: [{ trace, spans: [span({ id: U(1) })] }],
    });
    const emitted = (
      ((body["resourceSpans"] as Array<Record<string, unknown>>)[0]!["scopeSpans"] as Array<
        Record<string, unknown>
      >)[0]!["spans"] as Array<Record<string, unknown>>
    )[0]!;
    expect(typeof emitted["startTimeUnixNano"]).toBe("string");
    expect(emitted["startTimeUnixNano"]).toBe(
      String(BigInt(Date.parse("2026-08-07T00:00:00.000Z")) * 1_000_000n),
    );
    // and it is beyond what a JS number holds exactly
    expect(Number(emitted["startTimeUnixNano"])).toBeGreaterThan(Number.MAX_SAFE_INTEGER);
  });

  it("carries the parent link so the tree survives the wire", () => {
    const { body, spanCount } = buildOtlpPayload({
      serviceName: "svc",
      includeContent: false,
      traces: [
        {
          trace,
          spans: [span({ id: U(1), kind: "run" }), span({ id: U(2), parentSpanId: U(1) })],
        },
      ],
    });
    expect(spanCount).toBe(2);
    const emitted = ((
      (body["resourceSpans"] as Array<Record<string, unknown>>)[0]!["scopeSpans"] as Array<
        Record<string, unknown>
      >
    )[0]!["spans"]) as Array<Record<string, unknown>>;
    expect(emitted[0]!["parentSpanId"]).toBeUndefined();
    expect(emitted[1]!["parentSpanId"]).toBe(otlpSpanId(U(1)));
  });
});
