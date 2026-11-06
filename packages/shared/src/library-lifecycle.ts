/**
 * ADR-0208 G9 — the libraries' lifecycle bodies: retire an eval dataset (by name, every version), retire one
 * red-team library version, cancel a certification campaign. Each carries a required reason that lands on the row and
 * in the action's audit row. (The engine schedule edit extends `updateEngineScheduleSchema` in engines/contract.ts.)
 */
import { z } from "zod";

/** a reason a person types to explain a lifecycle act: trimmed, 10 to 2000 characters */
export const lifecycleReasonSchema = z.string().trim().min(10).max(2000);

export const retireEvalDatasetSchema = z.object({ reason: lifecycleReasonSchema }).strict();
export const retireRedTeamLibrarySchema = z.object({ reason: lifecycleReasonSchema }).strict();
export const cancelCertificationCampaignSchema = z.object({ reason: lifecycleReasonSchema }).strict();
