/**
 * The governed connector catalogue screen's state, without React (ADR-0255): the shapes of
 * `GET /v1/connector-catalogue` and `POST /v1/connector-catalogue/:pieceKey/enablement`
 * (apps/gateway/src/connector-catalogue.ts), the one reducer that owns the screen's search, paging and the
 * enable/disable flow, the read state derived from the query, and why each action is or is not available.
 *
 * The server decides. Enabling is an admin write that the gateway refuses with `step_up_required`
 * (`settings_relax`) until the person confirms it's them; this file never fakes that, it only names the phase
 * the flow is in so the screen can say so.
 */
import { ApiError } from "../../../api/client";
import { errorText, plural } from "../../../api/format";
import { stepUpRefusalOf } from "../../../stepup/stepUp";

// ---------------------------------------------------------------------------
// shapes
// ---------------------------------------------------------------------------

export interface CatalogueAction {
  name: string;
  displayName: string;
  /** the action's classification: a read can never reach a mutating upstream call */
  operation: "read" | "write";
}

/** a curated piece: one RegulAIt has a governed adapter for, off until an admin enables it */
export interface CuratedPiece {
  key: string;
  providerKind: string;
  displayName: string;
  upstream: { npm: string; version: string; path: string };
  status: "enabled" | "not_enabled";
  enabledAt: string | null;
  enabledByUserId: string | null;
  actions: CatalogueAction[];
}

/** a community piece listed as available, not enabled: names and versions only, no adapter */
export interface CommunityPiece {
  key: string;
  npm: string;
  version: string;
  upstreamPath: string;
  status: "available_not_enabled";
}

export interface CatalogueSource {
  repository: string;
  commit: string;
  licence: string;
}

export interface Catalogue {
  deployMode: string;
  /** false on an air-gapped deployment: nothing in the catalogue can run there, enabled or not */
  runnable: boolean;
  curated: CuratedPiece[];
  available: { total: number; limit: number; offset: number; source: CatalogueSource | null; items: CommunityPiece[] };
}

/** the server's bounds (connector-catalogue.ts `listQuerySchema` and `enablementBodySchema`) */
export const PAGE_SIZE = 50;
export const Q_MAX = 80;
export const REASON_MIN = 3;
export const REASON_MAX = 500;
export const SEARCH_DEBOUNCE_MS = 300;

const arr = <T,>(x: unknown): T[] => (Array.isArray(x) ? (x as T[]) : []);
const num = (x: unknown, d: number) => (typeof x === "number" && Number.isFinite(x) ? x : d);

/** read a response defensively: a missing or odd field renders as empty, never as a crash */
export function normaliseCatalogue(body: unknown): Catalogue {
  const raw = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const av = (raw.available && typeof raw.available === "object" ? raw.available : {}) as Record<string, unknown>;
  const src = av.source && typeof av.source === "object" ? (av.source as CatalogueSource) : null;
  return {
    deployMode: typeof raw.deployMode === "string" ? raw.deployMode : "hosted",
    runnable: raw.runnable !== false,
    curated: arr<CuratedPiece>(raw.curated).map((p) => ({ ...p, actions: arr<CatalogueAction>(p.actions) })),
    available: {
      total: num(av.total, 0),
      limit: num(av.limit, PAGE_SIZE),
      offset: num(av.offset, 0),
      source: src,
      items: arr<CommunityPiece>(av.items),
    },
  };
}

// ---------------------------------------------------------------------------
// the one reducer: search, paging and the enable/disable flow
// ---------------------------------------------------------------------------

export type Intent = "enable" | "disable";
export interface FlowTarget {
  key: string;
  displayName: string;
  intent: Intent;
}

/**
 * idle -> confirming (with a reason) -> submitting -> [stepping up ->] done | failed | step-up declined.
 * A failed or declined change goes back to confirming with the reason kept, never resent on its own.
 */
export type Flow =
  | { phase: "idle" }
  | { phase: "confirming"; target: FlowTarget; reason: string; touched: boolean }
  | { phase: "submitting"; target: FlowTarget; reason: string }
  | { phase: "steppingUp"; target: FlowTarget; reason: string }
  | { phase: "done"; target: FlowTarget; message: string }
  | { phase: "failed"; target: FlowTarget; reason: string; error: string; code: string | null }
  | { phase: "stepUpDeclined"; target: FlowTarget; reason: string };

export interface CatalogueState {
  /** what is typed in the search box */
  input: string;
  /** what the list is filtered by: the input, trimmed, once typing settles */
  q: string;
  offset: number;
  flow: Flow;
}

export type CatalogueEvent =
  | { type: "typed"; input: string }
  | { type: "searchSettled" }
  | { type: "page"; offset: number }
  | { type: "open"; target: FlowTarget }
  | { type: "reasonEdited"; reason: string }
  | { type: "cancel" }
  | { type: "submit" }
  | { type: "stepUpRequested" }
  | { type: "succeeded" }
  | { type: "failed"; error: unknown }
  | { type: "dismiss" };

export const initialCatalogueState: CatalogueState = { input: "", q: "", offset: 0, flow: { phase: "idle" } };

export const cleanQuery = (input: string) => input.trim().slice(0, Q_MAX);

/** why the reason cannot be sent yet, or null */
export function reasonProblem(reason: string): string | null {
  const r = reason.trim();
  if (r.length === 0) return "Give a reason. It becomes the audited record.";
  if (r.length < REASON_MIN) return `Say a little more: at least ${REASON_MIN} characters.`;
  if (r.length > REASON_MAX) return `Keep it to ${REASON_MAX} characters.`;
  return null;
}

export const isBusy = (f: Flow) => f.phase === "submitting" || f.phase === "steppingUp";

const pastTense = (i: Intent) => (i === "enable" ? "enabled" : "disabled");

/** what one refusal means here: the server's sentence, and its code when it has one */
function failureOf(error: unknown): { error: string; code: string | null } {
  if (error instanceof ApiError) {
    const code = typeof error.payload.error === "string" ? error.payload.error : null;
    if (code === "piece_air_gapped") return { code, error: "This deployment is air-gapped, so a catalogue piece cannot be enabled. Nothing changed." };
    if (code === "piece_has_no_adapter") return { code, error: "RegulAIt has no governed adapter for this piece yet, so it cannot be enabled. Nothing changed." };
    if (code === "unknown_piece") return { code, error: "The catalogue no longer lists this piece. Nothing changed." };
    return { code, error: errorText(error) };
  }
  return { code: null, error: errorText(error) };
}

export function catalogueReducer(s: CatalogueState, e: CatalogueEvent): CatalogueState {
  const f = s.flow;
  switch (e.type) {
    case "typed":
      return { ...s, input: e.input };
    case "searchSettled": {
      const q = cleanQuery(s.input);
      // a new search starts at the first page; the same search keeps its place
      return q === s.q ? s : { ...s, q, offset: 0 };
    }
    case "page":
      return { ...s, offset: Math.max(0, e.offset) };
    case "open":
      // one change at a time: a change in flight is never replaced
      if (isBusy(f)) return s;
      return { ...s, flow: { phase: "confirming", target: e.target, reason: "", touched: false } };
    case "reasonEdited":
      return f.phase === "confirming" ? { ...s, flow: { ...f, reason: e.reason } } : s;
    case "cancel":
      return isBusy(f) ? s : { ...s, flow: { phase: "idle" } };
    case "submit":
      if (f.phase === "failed" || f.phase === "stepUpDeclined") {
        // try again: back to the confirmation with the reason kept
        return { ...s, flow: { phase: "confirming", target: f.target, reason: f.reason, touched: true } };
      }
      if (f.phase !== "confirming") return s;
      if (reasonProblem(f.reason)) return { ...s, flow: { ...f, touched: true } };
      return { ...s, flow: { phase: "submitting", target: f.target, reason: f.reason.trim() } };
    case "stepUpRequested":
      return f.phase === "submitting" ? { ...s, flow: { phase: "steppingUp", target: f.target, reason: f.reason } } : s;
    case "succeeded":
      return isBusy(f) ? { ...s, flow: { phase: "done", target: f.target, message: `${f.target.displayName} ${pastTense(f.target.intent)}` } } : s;
    case "failed": {
      if (!isBusy(f)) return s;
      // a step-up the person did not give: the server refused, and said why; nothing changed
      if (stepUpRefusalOf(e.error)) return { ...s, flow: { phase: "stepUpDeclined", target: f.target, reason: f.reason } };
      return { ...s, flow: { phase: "failed", target: f.target, reason: f.reason, ...failureOf(e.error) } };
    }
    case "dismiss":
      return isBusy(f) ? s : { ...s, flow: { phase: "idle" } };
  }
}

// ---------------------------------------------------------------------------
// the read's state and why an action is unavailable
// ---------------------------------------------------------------------------

export type ReadState =
  | { kind: "loading" }
  | { kind: "error"; error: unknown }
  | { kind: "ready"; data: Catalogue; communityEmpty: "none" | "no_match" | null };

/** the list's state, from the query: loading, a failed read (never shown as empty), or the rows */
export function readStateOf(q: { data?: Catalogue; error: unknown; isLoading: boolean }, search: string): ReadState {
  if (q.data) {
    const empty = q.data.available.items.length === 0 ? (search ? "no_match" : "none") : null;
    return { kind: "ready", data: q.data, communityEmpty: empty };
  }
  if (q.error) return { kind: "error", error: q.error };
  return { kind: "loading" };
}

export interface ActionContext {
  isAdmin: boolean;
  runnable: boolean;
  flow: Flow;
}

/** the one action a curated piece offers, and why it cannot be taken now (null = it can) */
export function curatedAction(p: CuratedPiece, ctx: ActionContext): { intent: Intent; label: string; blocked: string | null } {
  const intent: Intent = p.status === "enabled" ? "disable" : "enable";
  const label = intent === "enable" ? "Enable" : "Disable";
  let blocked: string | null = null;
  if (!ctx.isAdmin) blocked = "Only an administrator can change the catalogue.";
  else if (intent === "enable" && !ctx.runnable) blocked = "This deployment is air-gapped: catalogue pieces call public SaaS APIs.";
  else if (isBusy(ctx.flow)) blocked = "Another change is being saved.";
  return { intent, label, blocked };
}

/** a community piece has no governed adapter, so it can never be enabled from here */
export const COMMUNITY_BLOCKED = "No governed adapter yet, so it cannot be enabled.";

export const statusLabel = (s: CuratedPiece["status"] | CommunityPiece["status"]) =>
  s === "enabled" ? "Enabled" : s === "not_enabled" ? "Not enabled" : "Available, not enabled";

/** "2 actions: 1 read, 1 write" */
export function actionsSummary(actions: readonly CatalogueAction[]): string {
  const reads = actions.filter((a) => a.operation === "read").length;
  const writes = actions.length - reads;
  return `${plural(actions.length, "action")}: ${reads} read, ${writes} write`;
}
