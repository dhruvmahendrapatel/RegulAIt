/**
 * ADR-0186 T — OTLP INGEST-SHAPE FIXTURES for the two open tracing UIs ADR-0177
 * names (rows 18 and 19). Both are export DESTINATIONS only: neither is a
 * dependency, neither is bundled or hosted, and no request leaves this test.
 *
 * The fixtures (`__fixtures__/otlp-ingest/*.json`) are hand-written from each
 * tool's public ingest documentation; every rule carries the sentence it comes
 * from and the file header carries the URL, the commit and the date read. This
 * test serialises a representative governed-call trace through the exporter's
 * real body builder (`buildOtlpPayload`, the function `POST /v1/tracing/export`
 * calls) and the same `JSON.stringify` the route sends, parses the bytes back,
 * and checks them against each fixture for every profile the fixture covers.
 *
 * What "satisfies" means here: the documented REQUIRED fields (ids, both
 * timestamps as decimal strings of nanoseconds), the attributes each tool KEYS
 * ON (model, usage, provider, span kind, session and user, content keys when
 * content capture is on) with their documented value types, the documented
 * key restrictions, and the transport (content type) — which is where the
 * Phoenix fixture records that our JSON body needs a Collector in front.
 *
 * The checker is `__fixtures__/otlp-ingest/check-ingest-shape.mjs`, shared with
 * the gateway's wire test (`apps/gateway/src/b4t-otlp-export-wire.test.ts`),
 * which runs it on the bytes a real governed call's export puts on the wire.
 * Each describe block also proves the checker is not vacuous: breaking one
 * required field in the parsed body must produce a violation.
 */
import { describe, expect, it } from "vitest";
import {
  buildOtlpPayload,
  type SpanRecord,
  type TraceExportProfile,
  type TraceRecord,
} from "./tracing.js";
import { checkIngestShape, loadIngestFixture as loadFixture } from "./__fixtures__/otlp-ingest/check-ingest-shape.mjs";

/** what `POST /v1/tracing/export` sends: apps/gateway/src/tracing.ts posts
 * `JSON.stringify(payload.body)` with this content type */
const OUR_CONTENT_TYPE = "application/json";

// ---------------------------------------------------------------------------
// A representative governed call: the decision, the model call it allowed, the
// MCP tool call the model made, and a refusal of a second tool call.
// ---------------------------------------------------------------------------

const U = (n: number) => `${String(n).padStart(8, "0")}-0000-4000-8000-0000000000aa`;
const TRACE_ID = U(1000);
const at = (s: number) => new Date(Date.UTC(2026, 9, 7, 9, 0, s)).toISOString();
const span = (over: Partial<SpanRecord> & Pick<SpanRecord, "id" | "seq" | "kind" | "name">): SpanRecord => ({
  traceId: TRACE_ID,
  parentSpanId: null,
  status: "ok",
  statusReason: null,
  startedAt: at(over.seq),
  endedAt: at(over.seq + 1),
  durationMs: 1000,
  ...over,
});
const SPANS: SpanRecord[] = [
  span({ id: U(1), seq: 1, kind: "policy", name: "governance decision", attributes: { ruleId: "allow-list" } }),
  span({
    id: U(2),
    parentSpanId: U(1),
    seq: 2,
    kind: "llm",
    name: "model call",
    provider: "anthropic",
    model: "fixture-model",
    servedModel: "fixture-model-served",
    agentId: U(40),
    agentName: "Fixture agent",
    usageEventId: U(41),
    inputTokens: 120,
    outputTokens: 30,
    // a whole-dollar cost on purpose: a cost is a double on the wire even when whole
    costUsd: 1,
    inputPreview: "summarise the ticket",
    outputPreview: "the ticket asks for a refund",
    attributes: { stopReason: "end_turn", cacheReadInputTokens: 10 },
  }),
  span({
    id: U(3),
    parentSpanId: U(2),
    seq: 3,
    kind: "tool",
    name: "tickets.read",
    mcpServerId: U(50),
    inputPreview: '{"id":"T-1"}',
    outputPreview: '{"status":"open"}',
    attributes: { toolCallId: "call-1" },
  }),
  span({
    id: U(4),
    parentSpanId: U(2),
    seq: 4,
    kind: "policy",
    name: "tickets.refund",
    status: "denied",
    statusReason: "tool not on the caller's allow-list",
    auditLogId: U(70),
    attributes: { ruleId: "default-deny" },
  }),
];
const TRACE: TraceRecord = {
  id: TRACE_ID,
  sessionId: "session-fixture-1",
  kind: "dispatch",
  rootRefId: null,
  name: "governed call",
  userId: U(80),
  projectId: U(81),
  status: "ok",
  startedAt: at(1),
  endedAt: at(5),
  durationMs: 4000,
  spanCount: SPANS.length,
  deniedSpanCount: 1,
  inputTokens: 120,
  outputTokens: 30,
  costUsd: 1,
};

/** the bytes the exporter would send, parsed back the way a receiver would */
function wireBody(profile: TraceExportProfile, includeContent = true): Record<string, unknown> {
  const { body } = buildOtlpPayload({
    serviceName: "regulait-gateway",
    traces: [{ trace: TRACE, spans: SPANS }],
    includeContent,
    deploymentMode: "byoc",
    profile,
  });
  return JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
}

type WireAttr = { key: string; value: Record<string, unknown> };
type WireSpan = Record<string, unknown> & { attributes?: WireAttr[] };
const kindOf = (s: WireSpan) => s.attributes?.find((a) => a.key === "regulait.span.kind")?.value["stringValue"];

// ---------------------------------------------------------------------------

for (const name of ["langfuse", "phoenix"] as const) {
  const fx = loadFixture(name);
  const profiles = Object.keys(fx.profiles) as TraceExportProfile[];

  describe(`OTLP ingest shape — ${name} (documented, hand-written fixture)`, () => {
    it("the fixture is the verified one, and covers at least one export profile", () => {
      expect(fx.tool).toBe(name);
      expect(fx.verified).toBe(true);
      expect(profiles.length).toBeGreaterThan(0);
    });

    it("transport: our OTLP/HTTP JSON body is accepted directly, or the fixture says what must sit in between", () => {
      const direct = fx.transport.acceptsContentTypes.includes(OUR_CONTENT_TYPE);
      expect(direct, `${name}: the fixture's directFromRegulait disagrees with its content types`).toBe(fx.transport.directFromRegulait);
      if (!direct) expect(fx.transport.via, `${name} cannot take JSON; the fixture must name the bridge`).toMatch(/Collector/);
    });

    for (const profile of profiles) {
      for (const includeContent of [true, false]) {
        it(`${profile}, content ${includeContent ? "on" : "off"}: the exported body satisfies every documented rule`, () => {
          const v = checkIngestShape(wireBody(profile, includeContent), fx, profile, { includeContent, sessionTrace: true });
          expect(v).toEqual([]);
        });
      }

      it(`${profile}: the checker is not vacuous — breaking one required field is caught`, () => {
        const body = wireBody(profile);
        const rs = body["resourceSpans"] as Array<{ scopeSpans: Array<{ spans: WireSpan[] }> }>;
        const s = rs[0]!.scopeSpans[0]!.spans.find((x) => kindOf(x) === "llm")!;
        // a timestamp as a JSON number (the precision-losing mistake) instead of a decimal string
        s["startTimeUnixNano"] = Number(s["startTimeUnixNano"]);
        // and one attribute the tool keys on, removed
        const firstKeyed = Object.values(fx.profiles[profile]!.byKind ?? {})[0]?.allOf?.[0];
        if (firstKeyed) s.attributes = s.attributes!.filter((a) => a.key !== firstKeyed);
        const v = checkIngestShape(body, fx, profile, { includeContent: true, sessionTrace: true });
        expect(v.some((m) => m.includes("startTimeUnixNano"))).toBe(true);
        if (firstKeyed) expect(v.some((m) => m.includes(`missing ${firstKeyed}`))).toBe(true);
      });
    }
  });
}

describe("OTLP ingest shape — the two transport facts, stated once", () => {
  it("Langfuse takes our JSON body directly; Phoenix needs a Collector (protobuf only on HTTP)", () => {
    expect(loadFixture("langfuse").transport.directFromRegulait).toBe(true);
    expect(loadFixture("phoenix").transport.directFromRegulait).toBe(false);
  });
});
