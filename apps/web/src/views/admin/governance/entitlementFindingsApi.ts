/**
 * The four ADR-0337 §5 calls behind SaaS entitlement findings. All are admin-only; raising and withdrawing are
 * audited by the gateway. No step-up: the second administrator is the control. Every query is strict, so each sends
 * only what its route accepts.
 */
import { api } from "../../../api/client";
import { normaliseReport, normaliseReviews, reviewOf, type Report, type Review } from "./entitlementFindingsModel";

export const FINDINGS_KEY = ["admin", "discovery", "entitlement-findings"] as const;
export const REVIEWS_KEY = ["admin", "discovery", "entitlement-finding-reviews"] as const;

export async function fetchReport(windowDays: number): Promise<Report> {
  return normaliseReport(await api.get<unknown>(`/v1/discovery/entitlements/findings?windowDays=${encodeURIComponent(String(windowDays))}`));
}

export async function fetchReviews(after: string | null): Promise<{ reviews: Review[]; next: string | null }> {
  const qs = new URLSearchParams();
  if (after) qs.set("after", after);
  qs.set("limit", "50");
  return normaliseReviews(await api.get<unknown>(`/v1/discovery/entitlements/findings/reviews?${qs.toString()}`));
}

/** raises a finding the report flags now for a second administrator's decision; nothing executes */
export async function raiseReview(body: { key: string; approverUserId: string; reason: string; windowDays: number }): Promise<Review> {
  const out = await api.post<{ review: unknown }>("/v1/discovery/entitlements/findings/reviews", { key: body.key, approverUserId: body.approverUserId, reason: body.reason.trim(), windowDays: String(body.windowDays) });
  return reviewOf(out.review);
}

export async function withdrawReview(reviewId: string): Promise<void> {
  await api.post(`/v1/discovery/entitlements/findings/reviews/${encodeURIComponent(reviewId)}/withdraw`);
}
