/**
 * ADR-0363 slice 3 — the curated AI app risk rows (data only). Every known value cites the vendor page it was read
 * from and the day it was checked; anything not verified is `unknown`. Frozen and pinned by `ai-app-risk.test.ts`.
 */
import type { AiAppRiskRow } from "./ai-app-risk.js";

export const AI_APP_RISK_ROWS: AiAppRiskRow[] = [];
