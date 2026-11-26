/**
 * SaaS entitlement findings (ADR-0337 §5): the report's shape, the finding reviews' shape, their normalisers, and the
 * screen's one declared state machine (owner rule 12), `findingsReducer`.
 *
 * Findings are recommendations computed at read time: an unused grant, an excessive scope, oversharing, a publicly
 * exposed agent. Nothing executes, and RegulAIt never revokes a vendor-side grant: a second administrator decides a
 * raised review in Approvals (remove or narrow it in the vendor's console, or accept the risk). A source that cannot
 * observe use is listed as not assessable for that rule, never as a finding, and an accepted risk stays listed. A
 * response without this shape is a failed read, never an empty report.
 */

export const WINDOWS = [30, 90, 180] as const;
export type WindowDays = (typeof WINDOWS)[number];
export const REASON_MAX = 1000;
export const REVIEW_STATUSES = ["pending", "remediate", "accepted", "withdrawn"] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export interface Finding {
  key: string;
  ruleId: string;
  rationale: string;
  source: { id: string; name: string };
  app: { externalId: string; displayName: string | null } | null;
  grant: { scope: string; resource: string | null; access: string | null } | null;
  agentRecord: { registry: string; displayName: string | null; externalId: string } | null;
  evidence: Array<[string, string]>;
  actionNote: string;
  review: { id: string; status: ReviewStatus; decidedAt: string | null } | null;
}

export interface Rule {
  id: string;
  title: string;
  limits: string;
  count: number;
  truncated: boolean;
  findings: Finding[];
  notAssessable: Array<{ source: string; reason: string }>;
}

export interface Report {
  windowDays: number;
  computedAt: string;
  rulesVersion: string;
  scanTruncated: boolean;
  rules: Rule[];
}

export interface Review {
  id: string;
  findingKey: string;
  ruleId: string;
  rationale: string;
  status: ReviewStatus;
  reason: string;
  subjectGone: boolean;
  createdAt: string;
  decidedAt: string | null;
  canWithdraw: { ok: true } | { ok: false; why: string };
}

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
function str(x: unknown, what: string): string {
  if (typeof x !== "string") throw new Malformed(what);
  return x;
}
function strOrNull(x: unknown, what: string): string | null {
  return x === null || x === undefined ? null : str(x, what);
}
function list(x: unknown, what: string): unknown[] {
  if (!Array.isArray(x)) throw new Malformed(what);
  return x;
}
function num(x: unknown, what: string): number {
  if (typeof x !== "number" || !Number.isFinite(x)) throw new Malformed(what);
  return x;
}
function status(x: unknown): ReviewStatus {
  if (!REVIEW_STATUSES.includes(x as ReviewStatus)) throw new Malformed("review status");
  return x as ReviewStatus;
}

/** evidence is a flat map of plain values; a missing value says "none recorded", never 0 or "never" */
function evidenceOf(x: unknown): Array<[string, string]> {
  const e = obj(x, "evidence");
  return Object.entries(e).map(([k, val]) => {
    if (val !== null && typeof val !== "string" && typeof val !== "number" && typeof val !== "boolean") throw new Malformed(`evidence.${k}`);
    return [k, val === null ? "none recorded" : String(val)];
  });
}

function findingOf(x: unknown): Finding {
  const f = obj(x, "finding");
  const src = obj(f.source, "source");
  const app = f.app == null ? null : obj(f.app, "app");
  const grant = f.grant == null ? null : obj(f.grant, "grant");
  const rec = f.agentRecord == null ? null : obj(f.agentRecord, "agentRecord");
  const action = obj(f.action, "action");
  const review = f.review == null ? null : obj(f.review, "review");
  return {
    key: str(f.key, "key"),
    ruleId: str(f.ruleId, "ruleId"),
    rationale: str(f.rationale, "rationale"),
    source: { id: str(src.id, "source.id"), name: str(src.name, "source.name") },
    app: app && { externalId: str(app.externalId, "app.externalId"), displayName: strOrNull(app.displayName, "app.displayName") },
    grant: grant && { scope: str(grant.scope, "grant.scope"), resource: strOrNull(grant.resource, "grant.resource"), access: strOrNull(grant.access, "grant.access") },
    agentRecord: rec && { registry: str(rec.registry, "agentRecord.registry"), displayName: strOrNull(rec.displayName, "agentRecord.displayName"), externalId: str(rec.externalId, "agentRecord.externalId") },
    evidence: evidenceOf(f.evidence),
    actionNote: str(action.note, "action.note"),
    review: review && { id: str(review.id, "review.id"), status: status(review.status), decidedAt: strOrNull(review.decidedAt, "review.decidedAt") },
  };
}

export function normaliseReport(raw: unknown): Report {
  const r = obj(raw, "report");
  if (typeof r.scanTruncated !== "boolean") throw new Malformed("scanTruncated");
  return {
    windowDays: num(r.windowDays, "windowDays"),
    computedAt: str(r.computedAt, "computedAt"),
    rulesVersion: str(r.rulesVersion, "rulesVersion"),
    scanTruncated: r.scanTruncated,
    rules: list(r.rules, "rules").map((r0) => {
      const ru = obj(r0, "rule");
      if (typeof ru.truncated !== "boolean") throw new Malformed("rule.truncated");
      return {
        id: str(ru.id, "rule.id"),
        title: str(ru.title, "rule.title"),
        limits: str(ru.limits, "rule.limits"),
        count: num(ru.count, "rule.count"),
        truncated: ru.truncated,
        findings: list(ru.findings, "rule.findings").map(findingOf),
        notAssessable: list(ru.notAssessable, "rule.notAssessable").map((n0) => {
          const n = obj(n0, "notAssessable");
          const s = obj(n.source, "notAssessable.source");
          return { source: str(s.name, "notAssessable.source.name"), reason: str(n.reason, "notAssessable.reason") };
        }),
      };
    }),
  };
}

export function reviewOf(x: unknown): Review {
  const r = obj(x, "review");
  const l = obj(r.lifecycle, "lifecycle");
  const w = list(l.transitions, "lifecycle.transitions").map((t) => obj(t, "transition")).find((t) => t.event === "withdraw");
  return {
    id: str(r.id, "id"),
    findingKey: str(r.findingKey, "findingKey"),
    ruleId: str(r.ruleId, "ruleId"),
    rationale: str(r.rationale, "rationale"),
    status: status(r.status),
    reason: str(r.reason, "reason"),
    subjectGone: r.subjectGone === true,
    createdAt: str(r.createdAt, "createdAt"),
    decidedAt: strOrNull(r.decidedAt, "decidedAt"),
    canWithdraw: w?.allowed === true ? { ok: true } : { ok: false, why: (w && typeof w.reason === "string" ? w.reason : null) ?? "Only a pending review can be withdrawn." },
  };
}

export function normaliseReviews(raw: unknown): { reviews: Review[]; next: string | null } {
  const r = obj(raw, "reviews");
  return { reviews: list(r.reviews, "reviews").map(reviewOf), next: strOrNull(r.next, "next") };
}

/** each review state in words: nothing here says a grant was removed, because nothing executes */
export const REVIEW_COPY: Record<ReviewStatus, { label: string; tone: "neutral" | "info" | "warn" | "ok" }> = {
  pending: { label: "Waiting for a second administrator", tone: "info" },
  remediate: { label: "To be removed or narrowed in the vendor's console", tone: "warn" },
  accepted: { label: "Risk accepted", tone: "neutral" },
  withdrawn: { label: "Withdrawn", tone: "neutral" },
};

/** the finding's subject in words: the app (or the agent, for the public-exposure rule) */
export function subjectOf(f: Finding): string {
  if (f.app) return f.app.displayName ?? f.app.externalId;
  if (f.agentRecord) return f.agentRecord.displayName ?? f.agentRecord.externalId;
  return "Unnamed subject";
}

// ---- the screen's one reducer ---------------------------------------------

export type Change =
  | { kind: "raise"; finding: Finding; approverUserId: string; reason: string }
  | { kind: "withdraw"; review: Review };

export type Flow =
  | { phase: "idle" }
  | { phase: "editing"; change: Change }
  | { phase: "submitting"; change: Change }
  | { phase: "done"; change: Change }
  | { phase: "failed"; change: Change; message: string };

export interface ScreenState {
  windowDays: WindowDays;
  flow: Flow;
  /** the `after` cursor of each reviews page loaded so far (null is the first page) */
  reviewCursors: Array<string | null>;
}

export type ScreenEvent =
  | { type: "window"; windowDays: WindowDays }
  | { type: "moreReviews"; after: string }
  | { type: "open"; change: Change }
  | { type: "edit"; change: Change }
  | { type: "cancel" }
  | { type: "submit" }
  | { type: "succeeded" }
  | { type: "failed"; message: string };

export const initialScreen: ScreenState = { windowDays: 90, flow: { phase: "idle" }, reviewCursors: [null] };

export function changeProblem(c: Change): string | null {
  if (c.kind !== "raise") return null;
  if (!c.approverUserId) return "Choose the administrator who decides.";
  const r = c.reason.trim();
  if (!r) return "Say why it should be reviewed.";
  if (r.length > REASON_MAX) return `The reason is at most ${REASON_MAX} characters.`;
  return null;
}

export function findingsReducer(s: ScreenState, e: ScreenEvent): ScreenState {
  const f = s.flow;
  const flow = (next: Flow): ScreenState => (next === f ? s : { ...s, flow: next });
  switch (e.type) {
    case "window":
      return e.windowDays === s.windowDays ? s : { ...s, windowDays: e.windowDays };
    case "moreReviews":
      return s.reviewCursors.includes(e.after) ? s : { ...s, reviewCursors: [...s.reviewCursors, e.after] };
    case "open":
      return f.phase === "submitting" ? s : flow({ phase: "editing", change: e.change });
    case "edit":
      return f.phase === "editing" || f.phase === "failed" ? flow({ phase: "editing", change: e.change }) : s;
    case "cancel":
      return f.phase === "submitting" || f.phase === "idle" ? s : flow({ phase: "idle" });
    case "submit":
      if (f.phase !== "editing" && f.phase !== "failed") return s;
      return changeProblem(f.change) ? s : flow({ phase: "submitting", change: f.change });
    case "succeeded":
      return f.phase === "submitting" ? flow({ phase: "done", change: f.change }) : s;
    case "failed":
      return f.phase === "submitting" ? flow({ phase: "failed", change: f.change, message: e.message }) : s;
  }
}
