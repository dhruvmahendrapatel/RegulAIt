/**
 * Process analytics (ADR-0342): the response shapes of the four reads, their normalisers, and the screen's one
 * declared state machine (owner rule 12), `analyticsReducer`.
 *
 * Truthful state is the point of this file. The gateway answers "no data" as `null` (a percentile with nothing ended,
 * a rework rate with no visits) or as a missing cell (the heatmap and throughput are sparse). Those stay `null` here and
 * the screen says "Not measured" or "No visits"; nothing is ever coerced to 0. A response that does not have the shape
 * below is a failed read (the normaliser throws), never an empty one.
 */

export type Bucket = "day" | "week" | "month";
export const BUCKETS: Bucket[] = ["day", "week", "month"];
export const WINDOWS = [7, 30, 90] as const;
export type WindowDays = (typeof WINDOWS)[number];
/** the gateway's default and maximum for the two tables is 50 and 200; one page of 50 matches its default */
export const PAGE_SIZE = 50;
/** the heatmap's top N stages by wait (the gateway allows 1..50, default 20) */
export const HEATMAP_STAGES = 20;

export interface Envelope {
  window: { from: string; to: string };
  excluded: { diverged: number; tooLong: number };
  lastProjectedAt: string | null;
  basis: string;
}

export interface TemplateRow {
  templateId: string;
  name: string;
  started: number;
  ended: { total: number; completed: number; aborted: number; denied: number; rolledBack: number };
  open: number;
  cycleTimeMs: { p50: number | null; p90: number | null; mean: number | null };
  reworkRate: number | null;
}

export interface StageRow {
  rank: number;
  stageId: string;
  stageType: string;
  visits: number;
  durationMs: { p50: number | null; p90: number | null };
  waitMs: { total: number; mean: number | null };
  workMs: { total: number; mean: number | null };
  waitShare: number | null;
  reworked: number;
  reworkRate: number | null;
  open: number;
  oldestOpenSince: string | null;
}

export interface HeatCell {
  period: string;
  visits: number;
  medianDurationMs: number | null;
  waitMs: number;
}

export interface ThroughputPeriod {
  period: string;
  started: number;
  completed: number;
  aborted: number;
  denied: number;
  rolledBack: number;
}

export type Page<K extends string, T> = Envelope & { total: number; limit: number; offset: number } & Record<K, T[]>;
export type TemplatesPage = Page<"templates", TemplateRow>;
export type StagesPage = Page<"stages", StageRow>;
export type Heatmap = Envelope & { bucket: Bucket; periods: string[]; stages: Array<{ stageId: string; cells: HeatCell[] }> };
export type Throughput = Envelope & { bucket: Bucket; periods: ThroughputPeriod[] };
export interface RefreshResult {
  projected: number;
  diverged: number;
  tooLong: number;
  remaining: boolean;
}

// ---- normalisers: the shape or a thrown error, never a silent default ------

class Malformed extends Error {
  constructor(what: string) {
    super(`The server's answer was not in the expected form (${what}).`);
    this.name = "MalformedResponse";
  }
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
function obj(x: unknown, what: string): Record<string, unknown> {
  if (!isObj(x)) throw new Malformed(what);
  return x;
}
function count(x: unknown, what: string): number {
  if (typeof x !== "number" || !Number.isFinite(x) || x < 0) throw new Malformed(what);
  return x;
}
function maybe(x: unknown, what: string): number | null {
  if (x === null) return null;
  if (typeof x !== "number" || !Number.isFinite(x)) throw new Malformed(what);
  return x;
}
function str(x: unknown, what: string): string {
  if (typeof x !== "string") throw new Malformed(what);
  return x;
}
function strOrNull(x: unknown, what: string): string | null {
  return x === null ? null : str(x, what);
}
function list(x: unknown, what: string): unknown[] {
  if (!Array.isArray(x)) throw new Malformed(what);
  return x;
}
function bucketOf(x: unknown): Bucket {
  if (!BUCKETS.includes(x as Bucket)) throw new Malformed("bucket");
  return x as Bucket;
}

function envelope(r: Record<string, unknown>): Envelope {
  const w = obj(r.window, "window");
  const ex = obj(r.excluded, "excluded");
  return {
    window: { from: str(w.from, "window.from"), to: str(w.to, "window.to") },
    excluded: { diverged: count(ex.diverged, "excluded.diverged"), tooLong: count(ex.tooLong, "excluded.tooLong") },
    lastProjectedAt: strOrNull(r.lastProjectedAt, "lastProjectedAt"),
    basis: str(r.basis, "basis"),
  };
}

function paged(r: Record<string, unknown>) {
  return { ...envelope(r), total: count(r.total, "total"), limit: count(r.limit, "limit"), offset: count(r.offset, "offset") };
}

export function normaliseTemplates(raw: unknown): TemplatesPage {
  const r = obj(raw, "templates");
  return {
    ...paged(r),
    templates: list(r.templates, "templates").map((t0) => {
      const t = obj(t0, "template");
      const e = obj(t.ended, "ended");
      const c = obj(t.cycleTimeMs, "cycleTimeMs");
      return {
        templateId: str(t.templateId, "templateId"),
        name: str(t.name, "name"),
        started: count(t.started, "started"),
        ended: {
          total: count(e.total, "ended.total"),
          completed: count(e.completed, "ended.completed"),
          aborted: count(e.aborted, "ended.aborted"),
          denied: count(e.denied, "ended.denied"),
          rolledBack: count(e.rolledBack, "ended.rolledBack"),
        },
        open: count(t.open, "open"),
        cycleTimeMs: { p50: maybe(c.p50, "p50"), p90: maybe(c.p90, "p90"), mean: maybe(c.mean, "mean") },
        reworkRate: maybe(t.reworkRate, "reworkRate"),
      };
    }),
  };
}

export function normaliseStages(raw: unknown): StagesPage {
  const r = obj(raw, "stages");
  return {
    ...paged(r),
    stages: list(r.stages, "stages").map((s0) => {
      const s = obj(s0, "stage");
      const d = obj(s.durationMs, "durationMs");
      const w = obj(s.waitMs, "waitMs");
      const k = obj(s.workMs, "workMs");
      return {
        rank: count(s.rank, "rank"),
        stageId: str(s.stageId, "stageId"),
        stageType: str(s.stageType, "stageType"),
        visits: count(s.visits, "visits"),
        durationMs: { p50: maybe(d.p50, "durationMs.p50"), p90: maybe(d.p90, "durationMs.p90") },
        waitMs: { total: count(w.total, "waitMs.total"), mean: maybe(w.mean, "waitMs.mean") },
        workMs: { total: count(k.total, "workMs.total"), mean: maybe(k.mean, "workMs.mean") },
        waitShare: maybe(s.waitShare, "waitShare"),
        reworked: count(s.reworked, "reworked"),
        reworkRate: maybe(s.reworkRate, "reworkRate"),
        open: count(s.open, "open"),
        oldestOpenSince: strOrNull(s.oldestOpenSince, "oldestOpenSince"),
      };
    }),
  };
}

export function normaliseHeatmap(raw: unknown): Heatmap {
  const r = obj(raw, "heatmap");
  return {
    ...envelope(r),
    bucket: bucketOf(r.bucket),
    periods: list(r.periods, "periods").map((p) => str(p, "period")),
    stages: list(r.stages, "stages").map((s0) => {
      const s = obj(s0, "stage");
      return {
        stageId: str(s.stageId, "stageId"),
        cells: list(s.cells, "cells").map((c0) => {
          const c = obj(c0, "cell");
          return { period: str(c.period, "cell.period"), visits: count(c.visits, "cell.visits"), medianDurationMs: maybe(c.medianDurationMs, "cell.medianDurationMs"), waitMs: count(c.waitMs, "cell.waitMs") };
        }),
      };
    }),
  };
}

export function normaliseThroughput(raw: unknown): Throughput {
  const r = obj(raw, "throughput");
  return {
    ...envelope(r),
    bucket: bucketOf(r.bucket),
    periods: list(r.periods, "periods").map((p0) => {
      const p = obj(p0, "period");
      return {
        period: str(p.period, "period"),
        started: count(p.started, "started"),
        completed: count(p.completed, "completed"),
        aborted: count(p.aborted, "aborted"),
        denied: count(p.denied, "denied"),
        rolledBack: count(p.rolledBack, "rolledBack"),
      };
    }),
  };
}

export function normaliseRefresh(raw: unknown): RefreshResult {
  const r = obj(raw, "refresh");
  if (typeof r.remaining !== "boolean") throw new Malformed("remaining");
  return { projected: count(r.projected, "projected"), diverged: count(r.diverged, "diverged"), tooLong: count(r.tooLong, "tooLong"), remaining: r.remaining };
}

// ---- display helpers: null stays "not measured" ---------------------------

export const NOT_MEASURED = "Not measured";

export function pct(rate: number | null): string {
  if (rate == null) return NOT_MEASURED;
  return `${Math.round(rate * 1000) / 10}%`;
}

/**
 * The heatmap's cells for one stage, one per period of the response. A period the gateway did not send has no visits:
 * it is `null` here, which the screen shows as "No visits", never as a 0-visit cell with a 0 duration.
 */
export function cellsByPeriod(periods: string[], cells: HeatCell[]): Array<{ period: string; cell: HeatCell | null }> {
  const at = new Map(cells.map((c) => [c.period, c]));
  return periods.map((period) => ({ period, cell: at.get(period) ?? null }));
}

/** 0..4 by the cell's wait against the heaviest cell on the map; colour is never the only carrier (the text is in the cell) */
export function waitLevel(waitMs: number, maxWaitMs: number): 0 | 1 | 2 | 3 | 4 {
  if (maxWaitMs <= 0 || waitMs <= 0) return 0;
  return Math.min(4, Math.max(1, Math.ceil((waitMs / maxWaitMs) * 4))) as 1 | 2 | 3 | 4;
}

// ---- the screen's one reducer ---------------------------------------------

export type RefreshFlow =
  | { phase: "idle" }
  | { phase: "running" }
  | { phase: "done"; result: RefreshResult }
  | { phase: "failed"; message: string };

export interface AnalyticsState {
  days: WindowDays;
  /** the window's end, fixed when the window is chosen or refreshed, so every read (and its cache key) sees one window */
  anchor: string;
  templateId: string;
  bucket: Bucket;
  templatesOffset: number;
  stagesOffset: number;
  refresh: RefreshFlow;
}

export type AnalyticsEvent =
  | { type: "window"; days: WindowDays; now: string }
  | { type: "template"; templateId: string }
  | { type: "bucket"; bucket: Bucket }
  | { type: "templatesPage"; offset: number }
  | { type: "stagesPage"; offset: number }
  | { type: "refreshStart" }
  | { type: "refreshDone"; result: RefreshResult; now: string }
  | { type: "refreshFailed"; message: string }
  | { type: "refreshDismiss" };

export function initialAnalyticsState(now: string): AnalyticsState {
  return { days: 30, anchor: now, templateId: "", bucket: "week", templatesOffset: 0, stagesOffset: 0, refresh: { phase: "idle" } };
}

const page = (offset: number) => Math.max(0, Math.floor(offset / PAGE_SIZE) * PAGE_SIZE);

export function analyticsReducer(s: AnalyticsState, e: AnalyticsEvent): AnalyticsState {
  switch (e.type) {
    case "window":
      return { ...s, days: e.days, anchor: e.now, templatesOffset: 0, stagesOffset: 0 };
    case "template":
      return { ...s, templateId: e.templateId, templatesOffset: 0, stagesOffset: 0 };
    case "bucket":
      return { ...s, bucket: e.bucket };
    case "templatesPage":
      return { ...s, templatesOffset: page(e.offset) };
    case "stagesPage":
      return { ...s, stagesOffset: page(e.offset) };
    case "refreshStart":
      // one pass at a time: a second press while one runs changes nothing
      return s.refresh.phase === "running" ? s : { ...s, refresh: { phase: "running" } };
    case "refreshDone":
      return s.refresh.phase === "running" ? { ...s, anchor: e.now, refresh: { phase: "done", result: e.result } } : s;
    case "refreshFailed":
      return s.refresh.phase === "running" ? { ...s, refresh: { phase: "failed", message: e.message } } : s;
    case "refreshDismiss":
      return s.refresh.phase === "running" ? s : { ...s, refresh: { phase: "idle" } };
  }
}

/** the window the reads ask for: `days` back from the anchor */
export function windowOf(s: Pick<AnalyticsState, "days" | "anchor">): { from: string; to: string } {
  const to = new Date(s.anchor);
  return { from: new Date(to.getTime() - s.days * 86_400_000).toISOString(), to: to.toISOString() };
}
