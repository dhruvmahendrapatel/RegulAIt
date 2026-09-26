/**
 * ADR-0070 — TRACE / SPAN OBSERVABILITY: the pure half.
 *
 * Everything in this file is a pure function of data handed to it. No database,
 * no clock, no network — the same discipline `decideCompiledDefault`,
 * `consolidate` and the guardrail evaluators follow, and the reason the
 * adversarial tests can hammer the tree builder and the OTLP encoder without a
 * Postgres or a collector anywhere near them.
 *
 * Three things live here:
 *
 *  1. **The tree.** `buildSpanTree` turns the flat span rows into the nested
 *     structure the UI renders. It is deliberately the ONLY place that decides
 *     parentage, it is cycle-safe, and it orders siblings by the stored `seq`
 *     rather than by timestamp — millisecond timestamps collide on an
 *     in-process path, and a tree whose children reorder between two reads is
 *     not a trace. An orphan (a span whose parent is not in the supplied set,
 *     which is what a paginated or truncated read produces) is REATTACHED AT
 *     THE ROOT AND FLAGGED, never silently dropped: a missing branch is the one
 *     failure mode a trace viewer must not have.
 *
 *  2. **The OTel GenAI mapping.** `otelAttributesForSpan` emits the published
 *     `gen_ai.*` semantic-convention keys, so a span that leaves for a
 *     customer's Langfuse/Grafana/Honeycomb is intelligible without a RegulAIt
 *     plugin. Everything with no standard key is namespaced `regulait.*` rather
 *     than invented inside `gen_ai.*` — squatting on somebody else's namespace
 *     is how a convention stops being one.
 *
 *  3. **The OTLP/HTTP JSON encoder.** Hand-rolled, ~120 lines, no dependency.
 *     See the ADR for why the OTel SDK was rejected: we are not instrumenting a
 *     live process, we are serialising rows that are already in a database, and
 *     the SDK's value (context propagation, samplers, batch processors,
 *     auto-instrumentation) is entirely in the part we do not need — while its
 *     cost (a transitive dependency tree, a background exporter that wants to
 *     open a socket) lands squarely on an air-gapped-primary product.
 */

// ---------------------------------------------------------------------------
// Shapes. Deliberately structural, not imports from @regulait/db: this package
// must stay usable without the schema, and the gateway maps rows onto these.
// ---------------------------------------------------------------------------

export interface SpanRecord {
  id: string;
  traceId: string;
  parentSpanId: string | null;
  seq: number;
  kind: string;
  name: string;
  status: string;
  statusReason: string | null;
  startedAt: string | Date;
  endedAt: string | Date | null;
  durationMs: number | null;
  usageEventId?: string | null;
  auditLogId?: string | null;
  runId?: string | null;
  nodeId?: string | null;
  agentId?: string | null;
  mcpServerId?: string | null;
  connectorId?: string | null;
  provider?: string | null;
  model?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  costUsd?: number | null;
  inputPreview?: string | null;
  outputPreview?: string | null;
  contentWithheld?: boolean;
  attributes?: Record<string, unknown> | null;
}

export interface TraceRecord {
  id: string;
  sessionId: string | null;
  kind: string;
  rootRefId: string | null;
  name: string;
  userId: string;
  projectId: string | null;
  status: string;
  startedAt: string | Date;
  endedAt: string | Date | null;
  durationMs: number | null;
  spanCount: number;
  deniedSpanCount: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
}

export interface SpanNode extends SpanRecord {
  depth: number;
  children: SpanNode[];
  /** true when this span's recorded parent was NOT in the supplied set, so it
   * has been reattached at the root rather than dropped. Surfaced in the API
   * and rendered in the UI — a silently-relocated span is a lie about causality. */
  orphaned?: boolean;
}

// ---------------------------------------------------------------------------
// 1. THE TREE
// ---------------------------------------------------------------------------

/**
 * Assemble the nested tree. Total, cycle-safe and order-deterministic:
 *
 *  - siblings sort by `seq`, then by `id` (a total order even if two rows ever
 *    shared a seq, so two reads of the same trace can never disagree);
 *  - a span whose parent is absent from `spans` becomes a flagged root;
 *  - a parent cycle (which the DB's self-parent CHECK makes a two-row minimum,
 *    and which nothing in the recorder can produce) is broken by promoting the
 *    first span of the cycle to a flagged root, so the function terminates on
 *    corrupt data instead of recursing forever.
 */
export function buildSpanTree(spans: readonly SpanRecord[]): SpanNode[] {
  const byId = new Map<string, SpanNode>();
  for (const s of spans) byId.set(s.id, { ...s, depth: 0, children: [] });

  // A span is a root if it declares no parent, if its parent is not present, or
  // if following its parent chain returns to it.
  const rootOf = (node: SpanNode): { root: boolean; orphan: boolean } => {
    if (!node.parentSpanId) return { root: true, orphan: false };
    const parent = byId.get(node.parentSpanId);
    if (!parent) return { root: true, orphan: true };
    const seen = new Set<string>([node.id]);
    let cur: SpanNode | undefined = parent;
    while (cur) {
      if (seen.has(cur.id)) return { root: true, orphan: true };
      seen.add(cur.id);
      cur = cur.parentSpanId ? byId.get(cur.parentSpanId) : undefined;
    }
    return { root: false, orphan: false };
  };

  const roots: SpanNode[] = [];
  for (const node of byId.values()) {
    const r = rootOf(node);
    if (r.root) {
      if (r.orphan) node.orphaned = true;
      roots.push(node);
    } else {
      byId.get(node.parentSpanId!)!.children.push(node);
    }
  }

  const cmp = (a: SpanNode, b: SpanNode) => (a.seq - b.seq) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const assignDepth = (nodes: SpanNode[], depth: number) => {
    nodes.sort(cmp);
    for (const n of nodes) {
      n.depth = depth;
      assignDepth(n.children, depth + 1);
    }
  };
  assignDepth(roots, 0);
  return roots;
}

/** Flatten a tree back to render order (pre-order), which is what a tree table
 * actually iterates. Kept beside the builder so the two can never disagree. */
export function flattenSpanTree(nodes: readonly SpanNode[]): SpanNode[] {
  const out: SpanNode[] = [];
  const walk = (ns: readonly SpanNode[]) => {
    for (const n of ns) {
      out.push(n);
      walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

export interface TreeTotals {
  spans: number;
  denied: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  /** null when NOTHING under the tree was priced — a measured token count
   * never becomes an invented dollar (the `usage_events` rule, unchanged) */
  costUsd: number | null;
  maxDepth: number;
}

/** Roll a tree up. Sums only the spans that actually carry figures, and returns
 * `costUsd: null` when none did rather than a confident 0. */
export function summariseSpanTree(spans: readonly SpanRecord[]): TreeTotals {
  let inputTokens = 0;
  let outputTokens = 0;
  let cost = 0;
  let priced = false;
  let denied = 0;
  let errors = 0;
  for (const s of spans) {
    inputTokens += s.inputTokens ?? 0;
    outputTokens += s.outputTokens ?? 0;
    if (s.costUsd != null) {
      cost += s.costUsd;
      priced = true;
    }
    if (s.status === "denied") denied++;
    if (s.status === "error") errors++;
  }
  const depths = flattenSpanTree(buildSpanTree(spans)).map((n) => n.depth);
  return {
    spans: spans.length,
    denied,
    errors,
    inputTokens,
    outputTokens,
    costUsd: priced ? Number(cost.toFixed(6)) : null,
    maxDepth: depths.length ? Math.max(...depths) : 0,
  };
}

// ---------------------------------------------------------------------------
// 2. CONTENT PREVIEWS — the EXISTING posture, not a fourth one.
// ---------------------------------------------------------------------------

/** The marker appended when a preview was cut. Distinct from the ADR-0042 /
 * §8.4 WITHHELD markers on purpose: truncation is a display limit, withholding
 * is a governance decision, and a reader must be able to tell which happened. */
export const TRACE_TRUNCATION_MARKER = "\n…[truncated by trace preview limit]";

/**
 * Truncate a preview. The text handed in is ALREADY whatever the dispatch path
 * decided a caller may see — for an output that is `result.outputText`, i.e.
 * post-substitution, exactly as `eval_results.output_text` stores it. This
 * function adds a length limit and nothing else; it makes no PII decision of
 * its own, because a second PII decision in a second place is how two postures
 * become three.
 */
export function tracePreview(text: string | null | undefined, maxChars: number): string | null {
  if (text == null) return null;
  if (maxChars <= 0) return null;
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + TRACE_TRUNCATION_MARKER;
}

/** Render tool arguments / results for a span preview. Non-string payloads are
 * JSON-encoded; an unencodable one says so rather than throwing inside the
 * recorder (a trace must never be able to fail the call it is tracing). */
export function toolPayloadPreview(value: unknown, maxChars: number): string | null {
  if (value === undefined || value === null) return null;
  let text: string;
  if (typeof value === "string") text = value;
  else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = "[unserialisable tool payload]";
    }
  }
  return tracePreview(text, maxChars);
}

// ---------------------------------------------------------------------------
// 3. OTEL GENAI SEMANTIC CONVENTIONS
// ---------------------------------------------------------------------------

/**
 * The RegulAIt span kind -> `gen_ai.operation.name`. Only the GenAI spans get
 * a GenAI operation; a run container or a policy decision is not a GenAI
 * operation and claiming otherwise would put a meaningless value in a
 * standardised field.
 */
const GEN_AI_OPERATION: Record<string, string> = {
  llm: "chat",
  fallback_hop: "chat",
  tool: "execute_tool",
  eval_case: "chat",
};

/** OTel status codes (opentelemetry.proto.trace.v1.Status.StatusCode) */
export const OTEL_STATUS_UNSET = 0;
export const OTEL_STATUS_OK = 1;
export const OTEL_STATUS_ERROR = 2;

/**
 * THE STATUS MAPPING — corrected by ADR-0070's 2026-08-15 amendment.
 *
 * ADR-0070 shipped `denied -> ERROR`, disclosing in its own words that "in
 * someone else's Grafana a governance refusal will look like a failure". That
 * is the ADR-0057/0072 inversion a third time: **defences working must never
 * be indistinguishable from defences failing.** It is now:
 *
 *   | RegulAIt status | OTel StatusCode | why                                |
 *   |---|---|---|
 *   | `ok`      | `Ok` (1)    | explicitly validated as successful       |
 *   | `denied`  | `Unset` (0) | the operation completed as designed and  |
 *   |           |             | contains NO error — the gateway refused  |
 *   | `error`   | `Error` (2) | the operation contains an error          |
 *   | `running` | `Unset` (0) | not finished; nothing to claim           |
 *
 * THE SPEC BASIS, checked 2026-08-15 rather than remembered:
 *
 *  - **OTel trace API spec** (`specification/trace/api.md`, open-telemetry/
 *    opentelemetry-specification @ main): the three codes are `Unset` — "The
 *    default status"; `Ok` — "validated by an Application developer or
 *    Operator to have completed successfully"; `Error` — "The operation
 *    contains an error". A governance DENY contains no error: it is the
 *    product doing exactly its job. The same spec: `Description` "MUST only be
 *    used with the `Error` `StatusCode` value" and "MUST be IGNORED for
 *    `StatusCode` `Ok` & `Unset`" — which is why a denied span carries NO
 *    status message and its reason rides `regulait.reason` instead. Emitting
 *    the reason in a field the spec says receivers must ignore would have been
 *    a reason that silently disappears.
 *  - **OTel HTTP semantic conventions** (`docs/http/http-spans.md`,
 *    open-telemetry/semantic-conventions @ main) supply the precedent for the
 *    exact shape of this decision: "For HTTP status codes in the 4xx range
 *    span status MUST be left unset in case of `SpanKind.SERVER` and SHOULD be
 *    set to `Error` in case of `SpanKind.CLIENT`." A deliberate 4xx issued BY
 *    the instrumented server is not that server's error. A pillar-1 refusal is
 *    that case precisely: the gateway, acting as the server, refused its
 *    caller. (The CLIENT half of that rule does not reach us — a denied span
 *    never made an upstream request, so there is no upstream status to
 *    reflect.)
 *
 * THE ADR-0070 OBJECTION, ANSWERED RATHER THAN IGNORED. The original argument
 * for ERROR was that UNSET makes a refusal invisible in an off-the-shelf error
 * filter. That is true, and it is the wrong cure: it makes a refusal *visible
 * as an outage*, which is worse than invisible — it manufactures incidents out
 * of the product working. The distinction is instead made QUERYABLE by
 * attribute, which is what a trace backend actually filters on:
 * `regulait.outcome` is emitted on EVERY span (`ok` | `denied` | `error` |
 * `running`), so `regulait.outcome = "denied"` is one filter clause, and
 * `regulait.decision`, `regulait.reason` and `regulait.rule.id` say who
 * refused and why. A genuine execution failure still lands on `Error` AND on
 * the standard `error.type` attribute, so an error dashboard built by someone
 * who has never heard of RegulAIt still shows the failures and no longer shows
 * the refusals.
 */
export function otelStatus(status: string, reason: string | null): { code: number; message?: string } {
  if (status === "ok") return { code: OTEL_STATUS_OK };
  // Only a genuine execution failure is an OTel error, and only it may carry a
  // Description (the spec forbids one on Unset/Ok).
  if (status === "error") {
    return reason ? { code: OTEL_STATUS_ERROR, message: reason } : { code: OTEL_STATUS_ERROR };
  }
  // `denied` and `running` alike: no error occurred. The refusal's reason and
  // rule travel as attributes — see `otelAttributesForSpan`.
  return { code: OTEL_STATUS_UNSET };
}

export interface OtelAttrContext {
  sessionId?: string | null;
  projectId?: string | null;
  userId?: string | null;
  /** whether prompts/outputs may leave with the span */
  includeContent: boolean;
}

/**
 * The published `gen_ai.*` keys, plus `regulait.*` for everything the
 * convention has no key for. Nothing is emitted with a null/undefined value —
 * an absent attribute is honest, an attribute set to "null" is not.
 */
export function otelAttributesForSpan(
  span: SpanRecord,
  ctx: OtelAttrContext,
): Record<string, string | number | boolean> {
  const a: Record<string, string | number | boolean> = {};
  const op = GEN_AI_OPERATION[span.kind];
  if (op) a["gen_ai.operation.name"] = op;
  // `gen_ai.system` is the provider family. Ours is the provider column, which
  // is already provider-agnostic vocabulary ("anthropic" | "openai" | ...).
  if (span.provider) a["gen_ai.system"] = span.provider;
  if (span.model) {
    a["gen_ai.request.model"] = span.model;
    a["gen_ai.response.model"] = span.model;
  }
  if (span.inputTokens != null) a["gen_ai.usage.input_tokens"] = span.inputTokens;
  if (span.outputTokens != null) a["gen_ai.usage.output_tokens"] = span.outputTokens;
  const finish = span.attributes?.["stopReason"];
  if (typeof finish === "string") a["gen_ai.response.finish_reasons"] = finish;
  if (span.kind === "tool") {
    a["gen_ai.tool.name"] = span.name;
    const callId = span.attributes?.["toolCallId"];
    if (typeof callId === "string") a["gen_ai.tool.call.id"] = callId;
  }
  if (ctx.sessionId) {
    a["gen_ai.conversation.id"] = ctx.sessionId;
    // `session.id` is the general-purpose convention; emitted alongside so a
    // backend that groups on either one works without configuration.
    a["session.id"] = ctx.sessionId;
  }
  if (ctx.userId) a["enduser.id"] = ctx.userId;

  // --- RegulAIt-specific. Namespaced, never squatting inside gen_ai.* -----
  a["regulait.span.kind"] = span.kind;
  /**
   * THE DISCRIMINATOR, on EVERY span rather than only on the refusals.
   *
   * Since a DENY now exports as OTel `Unset` (see `otelStatus`), "was this
   * refused?" must be answerable by a FILTER and not by reading prose. It is
   * emitted unconditionally and for every status so that
   * `regulait.outcome = "denied"` and `regulait.outcome = "error"` are each
   * one clause in any backend's query language — and so that a span with no
   * `regulait.outcome` at all is recognisably an OLD export rather than an
   * ambiguous one.
   */
  a["regulait.outcome"] = span.status;
  if (span.status === "denied") a["regulait.decision"] = "denied";
  if (span.statusReason) a["regulait.reason"] = span.statusReason;
  /**
   * WHICH RULE REFUSED. A deny that names no rule is a deny nobody can act on.
   * `ruleId` is the governance kernel's own rule id where the recorder had one
   * (the `policy` spans carry it); otherwise the dispatch core's error CODE is
   * the rule that fired (`pii_blocked`, `budget_exceeded`, `egress_blocked`…),
   * which is what an operator greps for.
   */
  if (span.status === "denied") {
    const ruleId = span.attributes?.["ruleId"] ?? span.attributes?.["error"];
    if (typeof ruleId === "string") a["regulait.rule.id"] = ruleId;
  }
  /**
   * `error.type` — the PUBLISHED general attribute ("Describes a class of
   * error the operation ended with"; instrumentations "SHOULD NOT set
   * `error.type`" when the operation completed successfully; open-telemetry/
   * semantic-conventions `docs/registry/attributes/error.md`, checked
   * 2026-08-15). It is set on genuine failures ONLY, never on a refusal, so a
   * standard error dashboard built by somebody who has never heard of RegulAIt
   * keeps showing outages and stops showing the governance layer working.
   */
  if (span.status === "error") {
    const code = span.attributes?.["error"];
    a["error.type"] = typeof code === "string" ? code : "execution_error";
  }
  // NO STANDARD GENAI COST KEY EXISTS. Emitting one under gen_ai.* would be
  // inventing a convention; this is ours and is labelled as ours.
  if (span.costUsd != null) a["regulait.cost.usd"] = span.costUsd;
  if (ctx.projectId) a["regulait.project.id"] = ctx.projectId;
  if (span.runId) a["regulait.run.id"] = span.runId;
  if (span.nodeId) a["regulait.run.node_id"] = span.nodeId;
  if (span.agentId) a["regulait.agent.id"] = span.agentId;
  if (span.usageEventId) a["regulait.usage_event.id"] = span.usageEventId;
  if (span.auditLogId) a["regulait.audit_log.id"] = span.auditLogId;
  if (span.contentWithheld) a["regulait.content.withheld"] = true;
  if (span.kind === "fallback_hop") {
    const pos = span.attributes?.["fallbackPosition"];
    if (typeof pos === "number") a["regulait.fallback.position"] = pos;
  }

  if (ctx.includeContent) {
    if (span.inputPreview) a["gen_ai.input.messages"] = span.inputPreview;
    if (span.outputPreview) a["gen_ai.output.messages"] = span.outputPreview;
  }
  return a;
}

// ---------------------------------------------------------------------------
// 4. THE OTLP/HTTP JSON ENCODER
// ---------------------------------------------------------------------------

const HEX32 = /^[0-9a-f]{32}$/;

/**
 * OTLP trace ids are 16 bytes. A UUID is 16 bytes, so a RegulAIt trace id maps
 * to an OTLP trace id EXACTLY — dashes stripped, no information lost, and the
 * id in a customer's Grafana is the id in our own URL bar.
 */
export function otlpTraceId(uuid: string): string {
  const hex = uuid.replace(/-/g, "").toLowerCase();
  if (!HEX32.test(hex)) throw new Error(`not a uuid: ${uuid}`);
  return hex;
}

/**
 * OTLP span ids are 8 bytes, and a UUID is 16, so this IS lossy: the first 8
 * bytes of the span uuid. Disclosed in the ADR rather than glossed. The
 * collision probability inside one exported trace is a birthday problem over
 * 2^64 with span counts in the hundreds (~10^-15), and the exported span
 * carries its full uuid as `regulait.span.id` so the exact row is always
 * recoverable regardless.
 */
export function otlpSpanId(uuid: string): string {
  const hex = uuid.replace(/-/g, "").toLowerCase();
  if (!HEX32.test(hex)) throw new Error(`not a uuid: ${uuid}`);
  return hex.slice(0, 16);
}

function unixNano(t: string | Date | null | undefined): string {
  if (t == null) return "0";
  const ms = t instanceof Date ? t.getTime() : new Date(t).getTime();
  if (!Number.isFinite(ms)) return "0";
  // OTLP requires a fixed64 as a decimal STRING in JSON — a Number would lose
  // precision above 2^53, which nanoseconds pass in 1970.
  return (BigInt(Math.trunc(ms)) * 1_000_000n).toString();
}

function otlpAttrs(a: Record<string, string | number | boolean>): unknown[] {
  return Object.entries(a).map(([key, v]) => ({
    key,
    value:
      typeof v === "string"
        ? { stringValue: v }
        : typeof v === "boolean"
          ? { boolValue: v }
          : Number.isInteger(v)
            ? { intValue: String(v) }
            : { doubleValue: v },
  }));
}

/** OTel SpanKind. Everything we emit is INTERNAL except an LLM/tool call,
 * which is a CLIENT call to something outside the process. */
function otlpSpanKind(kind: string): number {
  return kind === "llm" || kind === "fallback_hop" || kind === "tool" || kind === "connector" ? 3 : 1;
}

export interface OtlpBuildInput {
  serviceName: string;
  /** the traces being exported, each with its spans */
  traces: ReadonlyArray<{ trace: TraceRecord; spans: readonly SpanRecord[] }>;
  includeContent: boolean;
  /** stamped on the resource so a receiving backend can tell which deployment
   * mode produced the data (hosted / byoc / air_gapped) */
  deploymentMode?: string | undefined;
}

/**
 * Build an OTLP/HTTP JSON `ExportTraceServiceRequest` body. Pure — the caller
 * posts it (through the egress guard). Returns the body plus the counts, so an
 * export response can state exactly what it sent rather than what it intended.
 */
export function buildOtlpPayload(input: OtlpBuildInput): {
  body: Record<string, unknown>;
  traceCount: number;
  spanCount: number;
} {
  const resourceAttrs: Record<string, string | number | boolean> = {
    "service.name": input.serviceName,
    "telemetry.sdk.name": "regulait",
    "telemetry.sdk.language": "nodejs",
  };
  if (input.deploymentMode) resourceAttrs["deployment.environment.name"] = input.deploymentMode;

  const spans: unknown[] = [];
  let spanCount = 0;
  for (const { trace, spans: rows } of input.traces) {
    const traceIdHex = otlpTraceId(trace.id);
    for (const s of rows) {
      const attrs = otelAttributesForSpan(s, {
        sessionId: trace.sessionId,
        projectId: trace.projectId,
        userId: trace.userId,
        includeContent: input.includeContent,
      });
      attrs["regulait.span.id"] = s.id;
      attrs["regulait.trace.kind"] = trace.kind;
      const st = otelStatus(s.status, s.statusReason);
      spans.push({
        traceId: traceIdHex,
        spanId: otlpSpanId(s.id),
        ...(s.parentSpanId ? { parentSpanId: otlpSpanId(s.parentSpanId) } : {}),
        name: s.name,
        kind: otlpSpanKind(s.kind),
        startTimeUnixNano: unixNano(s.startedAt),
        endTimeUnixNano: unixNano(s.endedAt ?? s.startedAt),
        attributes: otlpAttrs(attrs),
        status: st,
      });
      spanCount++;
    }
  }

  return {
    body: {
      resourceSpans: [
        {
          resource: { attributes: otlpAttrs(resourceAttrs) },
          scopeSpans: [
            {
              scope: { name: "regulait.gateway", version: "0070" },
              spans,
            },
          ],
        },
      ],
    },
    traceCount: input.traces.length,
    spanCount,
  };
}

/**
 * What this exporter does NOT do, returned on the export API response so it is
 * read by an operator rather than only by whoever opens the ADR.
 */
export const OTLP_EXPORT_LIMITS =
  "Export is a PULL over a bounded window, not a live streaming pipeline: nothing is spooled, " +
  "nothing is retried in the background, and a failed export changes no stored row (re-run it). " +
  "Span ids are the first 8 bytes of RegulAIt's 16-byte span uuid, as OTLP requires 8; the full " +
  "uuid rides along as `regulait.span.id`. A governance DENY exports as OTel status UNSET — NOT " +
  "Error — because the OTel trace spec defines Error as 'the operation contains an error' and a " +
  "refusal is the product working; the same reasoning the HTTP conventions use when they require " +
  "a 4xx to leave a SERVER span's status unset. Only a genuine execution failure exports as " +
  "Error, and only it carries the standard `error.type`. Filter on `regulait.outcome` " +
  "(`ok`/`denied`/`error`/`running`, present on every span) to separate the two; a denied span " +
  "also carries `regulait.decision`, `regulait.reason` and `regulait.rule.id`. The reason is NOT " +
  "in the OTel status message because the spec requires receivers to ignore a description on a " +
  "non-Error status. No exporter is configured by default and none is ever contacted " +
  "unless an admin types an endpoint, which is then adjudicated by the egress guard on every export.";
