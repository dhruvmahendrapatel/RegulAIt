/**
 * ADR-0358 (lane E39) — AI adoption analytics: the shared contract (pure, no I/O).
 *
 * Two sources, never blended (ADR-0069): `metered` figures come from the gateway's own usage ledger, `imported`
 * figures from applied, unsuperseded imported vendor lines. Nothing here adds one to the other.
 *
 * Privacy defaults (ADR-0180): per-person ranking OFF and counts of people below `minCohortSize` suppressed.
 */
import { z } from "zod";

export const ADOPTION_POLICY_DEFAULTS = Object.freeze({ perPersonRanking: false, minCohortSize: 5 });
export const ADOPTION_MIN_COHORT_RANGE = Object.freeze({ min: 1, max: 50 });

export const ADOPTION_BUCKETS = ["day", "week", "month"] as const;
export type AdoptionBucket = (typeof ADOPTION_BUCKETS)[number];

/** the metered tool kinds: model dispatch to an agent, a governed connector, an MCP server, an A2A agent */
export const ADOPTION_TOOL_KINDS = ["agent", "connector", "mcp_server", "a2a_agent"] as const;
export type AdoptionToolKind = (typeof ADOPTION_TOOL_KINDS)[number];

export const ADOPTION_GROUP_BY = ["none", "team", "project"] as const;
export const ADOPTION_SEAT_GROUP_BY = ["none", "team"] as const;

/** the page sizes, as the ADR-0226 list contract offers them */
export const ADOPTION_PAGE_SIZES = [10, 50, 100, 500] as const;
export const ADOPTION_MAX_OFFSET = 100_000;
export const ADOPTION_MAX_WINDOW_DAYS = 366;
export const ADOPTION_MAX_DAY_BUCKET_WINDOW_DAYS = 92;
export const ADOPTION_DEFAULT_WINDOW_DAYS = 30;
export const ADOPTION_REASON_MAX = 500;

const DAY_MS = 86_400_000;

const pageSchema = {
  limit: z.coerce
    .number()
    .int()
    .refine((n) => (ADOPTION_PAGE_SIZES as readonly number[]).includes(n), { message: "limit must be 10, 50, 100 or 500" })
    .default(100),
  offset: z.coerce.number().int().min(0).max(ADOPTION_MAX_OFFSET).default(0),
};
const windowSchema = {
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
};
const uuid = z.string().uuid();

export const adoptionActiveUsersQuerySchema = z
  .object({
    ...windowSchema,
    ...pageSchema,
    bucket: z.enum(ADOPTION_BUCKETS).default("week"),
    groupBy: z.enum(ADOPTION_GROUP_BY).default("none"),
    toolKind: z.enum(ADOPTION_TOOL_KINDS).optional(),
    toolId: uuid.optional(),
    teamId: uuid.optional(),
    projectId: uuid.optional(),
  })
  .strict();
export type AdoptionActiveUsersQuery = z.infer<typeof adoptionActiveUsersQuerySchema>;

export const adoptionTopToolsQuerySchema = z
  .object({ ...windowSchema, ...pageSchema, toolKind: z.enum(ADOPTION_TOOL_KINDS).optional() })
  .strict();
export type AdoptionTopToolsQuery = z.infer<typeof adoptionTopToolsQuerySchema>;

export const adoptionSeatsQuerySchema = z
  .object({
    ...windowSchema,
    ...pageSchema,
    groupBy: z.enum(ADOPTION_SEAT_GROUP_BY).default("none"),
    vendor: z.string().trim().min(1).max(100).optional(),
  })
  .strict();
export type AdoptionSeatsQuery = z.infer<typeof adoptionSeatsQuerySchema>;

export const adoptionPeopleQuerySchema = z
  .object({ ...windowSchema, ...pageSchema, toolKind: z.enum(ADOPTION_TOOL_KINDS).optional(), toolId: uuid.optional() })
  .strict();
export type AdoptionPeopleQuery = z.infer<typeof adoptionPeopleQuerySchema>;

export const setAdoptionPolicySchema = z
  .object({
    perPersonRanking: z.boolean().optional(),
    minCohortSize: z.number().int().min(ADOPTION_MIN_COHORT_RANGE.min).max(ADOPTION_MIN_COHORT_RANGE.max).optional(),
    reason: z.string().trim().min(1).max(ADOPTION_REASON_MAX),
  })
  .strict()
  .refine((b) => b.perPersonRanking !== undefined || b.minCohortSize !== undefined, {
    message: "send perPersonRanking, minCohortSize or both",
  });
export type SetAdoptionPolicy = z.infer<typeof setAdoptionPolicySchema>;

export interface AdoptionPolicy {
  perPersonRanking: boolean;
  minCohortSize: number;
}

/** the fields of `next` that are looser than the strict default AND than what is stored now */
export function adoptionPolicyRelaxations(next: Partial<AdoptionPolicy>, current: AdoptionPolicy): Partial<AdoptionPolicy> {
  const out: Partial<AdoptionPolicy> = {};
  if (next.perPersonRanking === true && !current.perPersonRanking) out.perPersonRanking = true;
  if (
    next.minCohortSize !== undefined &&
    next.minCohortSize < ADOPTION_POLICY_DEFAULTS.minCohortSize &&
    next.minCohortSize < current.minCohortSize
  ) {
    out.minCohortSize = next.minCohortSize;
  }
  return out;
}

/** a count of people, or null with `suppressed` when it is small enough to single someone out (0 is never suppressed) */
export function suppressCount(n: number, minCohortSize: number): { value: number | null; suppressed: boolean } {
  if (n > 0 && n < minCohortSize) return { value: null, suppressed: true };
  return { value: n, suppressed: false };
}

export class AdoptionWindowError extends Error {
  constructor(message: string) {
    super(message);
  }
}

/**
 * Resolve the `[from, to)` window: default the last 30 days, at most 366 days, from strictly before to, and a day bucket
 * at most 92 days (a bounded number of rows per tool). `now` is passed in so tests and callers decide the clock.
 */
export function resolveAdoptionWindow(
  q: { from?: string; to?: string },
  now: Date,
  bucket?: AdoptionBucket,
): { from: Date; to: Date } {
  const to = q.to ? new Date(q.to) : now;
  const from = q.from ? new Date(q.from) : new Date(to.getTime() - ADOPTION_DEFAULT_WINDOW_DAYS * DAY_MS);
  if (!(from.getTime() < to.getTime())) throw new AdoptionWindowError("`from` must be strictly before `to`");
  const days = (to.getTime() - from.getTime()) / DAY_MS;
  if (days > ADOPTION_MAX_WINDOW_DAYS) throw new AdoptionWindowError(`the window is at most ${ADOPTION_MAX_WINDOW_DAYS} days`);
  if (bucket === "day" && days > ADOPTION_MAX_DAY_BUCKET_WINDOW_DAYS) {
    throw new AdoptionWindowError(`a day bucket covers at most ${ADOPTION_MAX_DAY_BUCKET_WINDOW_DAYS} days; use week or month`);
  }
  return { from, to };
}

/** seat utilisation for one vendor (and team), from imported lines only */
export interface SeatCounts {
  licensed: number;
  activeLicensed: number;
  activeWithoutSeat: number;
  /** false when the vendor's imported lines in the window carry no usage at all: no evidence is not "unused" */
  activityKnown: boolean;
}

export function seatUtilisation(c: SeatCounts): number | null {
  if (!c.activityKnown || c.licensed === 0) return null;
  return Math.round((c.activeLicensed / c.licensed) * 10_000) / 10_000;
}
