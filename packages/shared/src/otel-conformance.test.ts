/**
 * ADR-0177 step 1 — THE CONFORMANCE TEST. Every attribute key and event name
 * our OTLP export emits, in both profiles, must be a key the PINNED conventions
 * define:
 *
 *  - `gen_ai.*`, `mcp.*` and every other non-`regulait.*` key: an `ATTR_*`
 *    export of `@opentelemetry/semantic-conventions/incubating` (1.43.0, pinned
 *    exactly in the lockfile). This module IS the oracle — not a copy of it.
 *  - event names: an `EVENT_*` export of the same module.
 *  - OpenInference keys (profile `openinference` only): a value exported by
 *    `@arizeai/openinference-semantic-conventions` (2.14.0), where a flattened
 *    list key (`llm.input_messages.0.message.role`) must be a known prefix,
 *    an index, and a known suffix.
 *  - `regulait.*`: ours, namespaced, and allowed.
 *
 * A key we invent inside somebody else's namespace fails here. That is what
 * keeps "conversation compacted" out of `gen_ai.*` until the convention
 * publishes it.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as semconv from "@opentelemetry/semantic-conventions/incubating";
import * as oiConventions from "@arizeai/openinference-semantic-conventions";
import {
  OTEL_SCHEMA_URL,
  OTLP_EXPORT_LIMITS,
  TRACE_STANDARDS_PINS,
  buildOtlpPayload,
  type SpanRecord,
  type TraceExportProfile,
  type TraceRecord,
} from "./tracing.js";

const exported = (prefix: string) =>
  new Set(
    Object.entries(semconv)
      .filter(([name, v]) => name.startsWith(prefix) && typeof v === "string")
      .map(([, v]) => v as string),
  );
const SEMCONV_ATTRS = exported("ATTR_");
const SEMCONV_EVENTS = exported("EVENT_");
const OI_KEYS = new Set<string>([
  ...(Object.values(oiConventions.SemanticConventions) as unknown[]).filter((v): v is string => typeof v === "string"),
  oiConventions.SEMRESATTRS_PROJECT_NAME,
]);

/** an OpenInference key, including the flattened list form `<prefix>.<n>.<rest>` */
function isOpenInferenceKey(key: string): boolean {
  if (OI_KEYS.has(key)) return true;
  const m = /^(.+?)\.(\d+)\.(.+)$/.exec(key);
  return !!m && OI_KEYS.has(m[1]!) && isOpenInferenceKey(m[3]!);
}

const U = (n: number) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;
const T = U(900);
const base = {
  traceId: T,
  parentSpanId: U(1),
  status: "ok",
  statusReason: null,
  startedAt: "2026-10-05T00:00:00.000Z",
  endedAt: "2026-10-05T00:00:01.000Z",
  durationMs: 1000,
};

/** EVERY span kind we record, each with every field the emitter reads */
const SPANS: SpanRecord[] = [
  { ...base, id: U(1), parentSpanId: null, seq: 1, kind: "run", name: "run", runId: U(30) },
  { ...base, id: U(2), seq: 2, kind: "run_node", name: "node", runId: U(30), nodeId: "n1" },
  {
    ...base,
    id: U(3),
    seq: 3,
    kind: "llm",
    name: "m",
    provider: "openai",
    model: "m1",
    servedModel: "m1-snap",
    agentId: U(40),
    agentName: "Model one",
    usageEventId: U(41),
    inputTokens: 5,
    outputTokens: 6,
    costUsd: 0.01,
    inputPreview: "p",
    outputPreview: "o",
    contentWithheld: true,
    attributes: {
      stopReason: "end_turn",
      cacheReadInputTokens: 1,
      cacheCreationInputTokens: 2,
      compaction: { active: true },
      builderAgentId: U(42),
      builderAgentName: "Helper",
    },
  },
  { ...base, id: U(4), seq: 4, kind: "fallback_hop", name: "hop", provider: "anthropic", model: "m2", attributes: { fallbackPosition: 1 } },
  { ...base, id: U(5), seq: 5, kind: "tool", name: "t", mcpServerId: U(50), inputPreview: "{}", outputPreview: "{}", costUsd: 0.001, attributes: { toolCallId: "c1" } },
  { ...base, id: U(6), seq: 6, kind: "connector", name: "c", connectorId: U(60), inputPreview: "x", outputPreview: "y" },
  { ...base, id: U(7), seq: 7, kind: "policy", name: "deny", status: "denied", statusReason: "no", auditLogId: U(70), attributes: { ruleId: "r" } },
  { ...base, id: U(8), seq: 8, kind: "workflow_stage", name: "stage", status: "error", statusReason: "boom", attributes: { error: "stage_failed" } },
  { ...base, id: U(9), seq: 9, kind: "eval_case", name: "case", provider: "google", model: "g", inputPreview: "q", outputPreview: "a" },
];
const TRACE: TraceRecord = {
  id: T,
  sessionId: "s",
  kind: "run",
  rootRefId: U(30),
  name: "t",
  userId: U(80),
  projectId: U(81),
  status: "ok",
  startedAt: base.startedAt,
  endedAt: base.endedAt,
  durationMs: 1000,
  spanCount: SPANS.length,
  deniedSpanCount: 1,
  inputTokens: 5,
  outputTokens: 6,
  costUsd: 0.011,
};

type Attr = { key: string };
function collect(profile: TraceExportProfile) {
  const { body } = buildOtlpPayload({
    serviceName: "svc",
    includeContent: true,
    deploymentMode: "air_gapped",
    profile,
    traces: [{ trace: TRACE, spans: SPANS }],
    scores: [
      { traceId: T, spanId: U(3), source: "annotation", name: "helpful", value: 3, label: "ok" },
      { traceId: T, spanId: null, source: "trace_eval", name: "grounded", value: null, label: "flagged" },
    ],
  });
  const rs = (body["resourceSpans"] as Array<Record<string, unknown>>)[0]!;
  const resourceKeys = ((rs["resource"] as { attributes: Attr[] }).attributes).map((a) => a.key);
  const spans = ((rs["scopeSpans"] as Array<Record<string, unknown>>)[0]!["spans"]) as Array<{
    attributes: Attr[];
    events?: Array<{ name: string; attributes: Attr[] }>;
  }>;
  const spanKeys = new Set<string>();
  const eventNames = new Set<string>();
  for (const s of spans) {
    for (const a of s.attributes) spanKeys.add(a.key);
    for (const e of s.events ?? []) {
      eventNames.add(e.name);
      for (const a of e.attributes) spanKeys.add(a.key);
    }
  }
  return { resourceKeys, spanKeys: [...spanKeys], eventNames: [...eventNames] };
}

describe("OTLP conformance against the pinned conventions", () => {
  it("the oracle is the pinned module, and it is the version we pinned", () => {
    // the package does not export its package.json, so read it beside its entry
    const entry = createRequire(import.meta.url).resolve("@opentelemetry/semantic-conventions");
    const pkg = JSON.parse(readFileSync(join(entry.slice(0, entry.lastIndexOf("/build/")), "package.json"), "utf8"));
    expect(pkg.version).toBe(TRACE_STANDARDS_PINS.otelSemanticConventions);
    expect(SEMCONV_ATTRS.has("gen_ai.provider.name")).toBe(true);
    expect(SEMCONV_EVENTS.has("gen_ai.evaluation.result")).toBe(true);
  });

  for (const profile of ["otel_genai", "openinference"] as const) {
    it(`${profile}: every gen_ai.* / mcp.* key exists in the pinned semconv incubating exports`, () => {
      const { spanKeys } = collect(profile);
      const ours = spanKeys.filter((k) => k.startsWith("gen_ai.") || k.startsWith("mcp."));
      // the fixture really exercises the keys this test exists for
      expect(ours).toEqual(expect.arrayContaining([
        "gen_ai.provider.name",
        "gen_ai.response.model",
        "gen_ai.agent.id",
        "gen_ai.usage.cache_read.input_tokens",
        "gen_ai.evaluation.score.value",
        "mcp.method.name",
      ]));
      expect(ours.filter((k) => !SEMCONV_ATTRS.has(k))).toEqual([]);
    });

    it(`${profile}: every event name is a pinned semconv event`, () => {
      const { eventNames } = collect(profile);
      expect(eventNames).toEqual(["gen_ai.evaluation.result"]);
      expect(eventNames.filter((n) => !SEMCONV_EVENTS.has(n))).toEqual([]);
    });

    it(`${profile}: every other key is a pinned convention key or namespaced regulait.*`, () => {
      const { spanKeys, resourceKeys } = collect(profile);
      const unknown = [...spanKeys, ...resourceKeys].filter(
        (k) =>
          !k.startsWith("regulait.") &&
          !SEMCONV_ATTRS.has(k) &&
          !(profile === "openinference" && isOpenInferenceKey(k)),
      );
      expect(unknown).toEqual([]);
    });
  }

  /**
   * ADR-0186 T: `schemaUrl` on every ResourceSpans and every ScopeSpans, and it
   * names the INSTALLED semconv version (read from the package itself, not
   * from our pin), so the URL cannot drift from the keys we emit.
   */
  for (const profile of ["otel_genai", "openinference"] as const) {
    it(`${profile}: every exported ResourceSpans and ScopeSpans carries the pinned schemaUrl`, () => {
      const entry = createRequire(import.meta.url).resolve("@opentelemetry/semantic-conventions");
      const installed = JSON.parse(readFileSync(join(entry.slice(0, entry.lastIndexOf("/build/")), "package.json"), "utf8")).version;
      expect(OTEL_SCHEMA_URL).toBe(`https://opentelemetry.io/schemas/${installed}`);
      const { body } = buildOtlpPayload({
        serviceName: "svc",
        includeContent: false,
        profile,
        traces: [{ trace: TRACE, spans: SPANS }],
      });
      // through the bytes, as a receiver reads them
      const wire = JSON.parse(JSON.stringify(body)) as { resourceSpans: Array<{ schemaUrl?: unknown; scopeSpans: Array<{ schemaUrl?: unknown; spans: unknown[] }> }> };
      expect(wire.resourceSpans.length).toBeGreaterThan(0);
      for (const rs of wire.resourceSpans) {
        expect(rs.schemaUrl, "ResourceSpans.schemaUrl").toBe(OTEL_SCHEMA_URL);
        expect(rs.scopeSpans.length).toBeGreaterThan(0);
        for (const ss of rs.scopeSpans) {
          expect(ss.schemaUrl, "ScopeSpans.schemaUrl").toBe(OTEL_SCHEMA_URL);
          expect(ss.spans.length).toBe(SPANS.length);
        }
      }
    });
  }

  it("the export limits state the schema URL, the gen_ai.system end date and the JSON-only transport", () => {
    expect(OTLP_EXPORT_LIMITS).toContain(OTEL_SCHEMA_URL);
    expect(OTLP_EXPORT_LIMITS).toContain("2027-01-01");
    expect(OTLP_EXPORT_LIMITS).toContain("OpenTelemetry Collector");
  });

  it("the default profile emits no OpenInference-only key", () => {
    const { spanKeys } = collect("otel_genai");
    expect(spanKeys.filter((k) => !SEMCONV_ATTRS.has(k) && !k.startsWith("regulait."))).toEqual([]);
  });
});
