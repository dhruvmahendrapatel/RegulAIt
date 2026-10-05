/**
 * ADR-0173 batch 2b — the run graph's vocabulary on the web side.
 *
 * The shapes mirror `apps/gateway/src/run-graph.ts` (GET /v1/run-graph/...).
 * Everything here is pure so the wording a screen reader hears (the text
 * alternative) is unit-tested without a browser.
 */
import type { Tone } from "../kit";

export type RunPathKind = "builder_turn" | "orchestration" | "use_case";
export type RunPathStatus =
  | "done"
  | "active"
  | "waiting"
  | "denied"
  | "error"
  | "not_started"
  | "stopped"
  | "expired"
  | "skipped";

export interface RunPathActor {
  kind: "person" | "agent" | "model" | "system";
  id: string | null;
  name: string | null;
}

export interface RunPathNode {
  id: string;
  type: string;
  label: string;
  status: RunPathStatus;
  rawStatus: string | null;
  statusDetail: string | null;
  actor: RunPathActor | null;
  at: string | null;
  endedAt: string | null;
  costUsd: number | null;
  links: { auditLogId: string | null; traceId: string | null; spanId: string | null; approvalId: string | null };
  facts: Array<{ label: string; value: string }>;
}

export interface RunPathEdge {
  from: string;
  to: string;
  kind: string;
}

export interface RunPathGraph {
  kind: RunPathKind;
  subject: { id: string; label: string };
  generatedAt: string;
  /** in decision-path order: the order the text alternative lists them in */
  nodes: RunPathNode[];
  edges: RunPathEdge[];
  summary: { nodes: number; costUsd: number | null; denied: number; waiting: number; errors: number };
  notes: string[];
}

/** which graph to read */
export type RunGraphSource =
  | { kind: "builder_turn"; threadId: string; turn: number }
  | { kind: "orchestration"; runId: string }
  | { kind: "use_case"; useCaseId: string };

export function runGraphPath(source: RunGraphSource): string {
  switch (source.kind) {
    case "builder_turn":
      return `/v1/run-graph/builder-turn/${encodeURIComponent(source.threadId)}/${source.turn}`;
    case "orchestration":
      return `/v1/run-graph/orchestration/${encodeURIComponent(source.runId)}`;
    case "use_case":
      return `/v1/run-graph/use-case/${encodeURIComponent(source.useCaseId)}`;
  }
}

export function runGraphKey(source: RunGraphSource): readonly unknown[] {
  switch (source.kind) {
    case "builder_turn":
      return ["run-graph", source.kind, source.threadId, source.turn];
    case "orchestration":
      return ["run-graph", source.kind, source.runId];
    case "use_case":
      return ["run-graph", source.kind, source.useCaseId];
  }
}

export const STATUS_LABEL: Record<RunPathStatus, string> = {
  done: "Done",
  active: "In progress",
  waiting: "Waiting",
  denied: "Denied",
  error: "Error",
  not_started: "Not started",
  stopped: "Stopped",
  expired: "Expired",
  skipped: "Skipped",
};

export const STATUS_TONE: Record<RunPathStatus, Tone> = {
  done: "ok",
  active: "info",
  waiting: "warn",
  denied: "danger",
  error: "danger",
  not_started: "neutral",
  stopped: "neutral",
  expired: "warn",
  skipped: "neutral",
};

export const statusLabel = (s: string): string => STATUS_LABEL[s as RunPathStatus] ?? s;
export const statusTone = (s: string): Tone => STATUS_TONE[s as RunPathStatus] ?? "neutral";

const ACTOR_KIND: Record<RunPathActor["kind"], string> = {
  person: "Person",
  agent: "Agent",
  model: "Model",
  system: "System",
};

/** who acted, in words; null when the step records nobody */
export function actorText(actor: RunPathActor | null): string | null {
  if (!actor) return null;
  if (actor.kind === "system") return "System";
  return actor.name ?? `${ACTOR_KIND[actor.kind]} (name not recorded)`;
}

/** a measured cost; null stays "not priced", never $0 */
export function fmtCost(usd: number | null | undefined): string | null {
  if (usd == null || !Number.isFinite(usd)) return null;
  if (usd === 0) return "$0";
  if (usd < 0.0001) return "under $0.0001";
  return "$" + usd.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
}

/** an ISO time as `2026-10-02 15:25` (local) */
export function fmtWhen(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * One step as a sentence: what a graph node is called by assistive technology
 * and what the ordered list says. "Step 2 of 6: Model step 1. Done. Model:
 * claude-default. 2026-10-02 15:25. Cost $0.0012."
 */
export function stepSentence(node: RunPathNode, index: number, total: number): string {
  const parts = [`Step ${index + 1} of ${total}: ${node.label}`, statusLabel(node.status)];
  const who = actorText(node.actor);
  if (who) parts.push(`${ACTOR_KIND[node.actor!.kind]}: ${who}`);
  const when = fmtWhen(node.at);
  if (when) parts.push(when);
  const cost = fmtCost(node.costUsd);
  if (cost) parts.push(`Cost ${cost}`);
  return parts.join(". ") + ".";
}

/** the graph in one line: how many steps, what it cost, what stopped it */
export function summaryText(graph: Pick<RunPathGraph, "summary">): string {
  const s = graph.summary;
  const parts = [`${s.nodes} step${s.nodes === 1 ? "" : "s"}`];
  const cost = fmtCost(s.costUsd);
  parts.push(cost ? `measured cost ${cost}` : "no measured cost");
  if (s.denied) parts.push(`${s.denied} denied`);
  if (s.waiting) parts.push(`${s.waiting} waiting`);
  if (s.errors) parts.push(`${s.errors} with errors`);
  return parts.join(" · ");
}

const EDGE_KIND: Record<string, string> = {
  next: "then",
  then: "then",
  tool_call: "calls a tool",
  fallback: "falls back to",
  starts: "starts",
  depends_on: "feeds",
  leads: "delegates to",
  escalated: "escalated to",
};

/** an edge in words, e.g. "Model step 1 calls a tool: Read" */
export function edgeSentence(edge: RunPathEdge, labelOf: (id: string) => string): string {
  return `${labelOf(edge.from)} ${EDGE_KIND[edge.kind] ?? "leads to"}: ${labelOf(edge.to)}`;
}

/** a lead delegating, or a fallback hop: drawn dashed (the API's notes say so) */
export const DASHED_EDGE_KINDS = new Set(["leads", "fallback"]);

/** for each node id, the ids of the steps that lead into it (for "comes after" in details) */
export function predecessors(graph: Pick<RunPathGraph, "edges">): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const e of graph.edges) {
    const list = out.get(e.to) ?? [];
    if (!list.includes(e.from)) list.push(e.from);
    out.set(e.to, list);
  }
  return out;
}
