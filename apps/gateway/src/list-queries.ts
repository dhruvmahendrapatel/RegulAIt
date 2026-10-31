/**
 * Query-string schemas shared by a route handler and its OpenAPI doc, so the
 * published parameters are the ones the handler actually parses.
 */
import { APPROVAL_OBJECT_TYPES } from "@regulait/shared";
import { z } from "zod";

export const APPROVAL_STATUSES = ["pending", "approved", "denied", "returned", "consumed", "superseded"] as const;

/** the approvals queue answers at most this many rows; `total` says how many matched */
export const APPROVALS_PAGE_LIMIT = 100;

/**
 * `GET /v1/approvals`. `status` is one status or a comma-separated list of
 * them (`approved,denied,returned`); `order` defaults to `desc` (newest first),
 * the behaviour every existing caller relies on.
 */
export const approvalsListQuery = z.object({
  status: z
    .string()
    .transform((s) => s.split(",").map((x) => x.trim()))
    .pipe(z.array(z.enum(APPROVAL_STATUSES)).min(1).max(APPROVAL_STATUSES.length))
    .optional(),
  objectType: z.enum(APPROVAL_OBJECT_TYPES).optional(),
  approverUserId: z.string().uuid().optional(),
  order: z.enum(["asc", "desc"]).default("desc"),
});

/** the default look-back of `GET /v1/usage-events/summary` when `from` is absent */
export const USAGE_SUMMARY_DEFAULT_DAYS = 30;

/**
 * `GET /v1/usage-events/summary`. Same `userId` rule as `/v1/usage-events`
 * (forced to self for a non-admin). The window is half-open, `[from, to)`.
 * `day` is a daily series keyed by UTC date (days with no event are absent).
 */
export const usageSummaryQuery = z
  .object({
    groupBy: z.enum(["agent", "connector", "mcp_tool", "project", "day"]),
    userId: z.string().uuid().optional(),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
  })
  .refine((q) => !q.from || !q.to || q.from < q.to, { message: "`from` must be before `to`", path: ["from"] });
