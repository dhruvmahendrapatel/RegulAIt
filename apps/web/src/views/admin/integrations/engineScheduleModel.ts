/**
 * ADR-0187 — recurring engine runs (`/v1/engine-schedules`), the browser's
 * model. Mirrors `createEngineScheduleSchema` / `updateEngineScheduleSchema`
 * in `packages/shared/src/engines/contract.ts` and the `engine_schedules` row.
 *
 * A schedule carries the SAME request as `POST /v1/engine-runs`; the gateway
 * validates it now as the creator and again at every run it starts. It runs as
 * its creator, so only the creator may switch it back on.
 *
 * ADR-0208 G9: only the creator may change its interval (the PATCH body carries `enabled` and/or `intervalHours`);
 * the creator or an admin may delete it (soft: it leaves the list and starts no further run).
 */

export const SCHEDULE_INTERVAL_LIMITS = { min: 1, max: 720 } as const;

export interface EngineSchedule {
  id: string;
  engineId: string;
  request: Record<string, unknown>;
  configHash: string;
  runAsUserId: string | null;
  intervalHours: number;
  nextRunAt: string;
  enabled: boolean;
  lastRunId: string | null;
  lastSkip: string | null;
  createdAt: string;
  updatedAt: string;
}

/** a whole number of hours from 1 to 720, read by character (no regex on input) */
export function parseIntervalHours(raw: string): number | null {
  const text = raw.trim();
  if (text === "" || text.length > 3 || ![...text].every((c) => c >= "0" && c <= "9")) return null;
  const n = Number(text);
  return n >= SCHEDULE_INTERVAL_LIMITS.min && n <= SCHEDULE_INTERVAL_LIMITS.max ? n : null;
}

export function scheduleBody(request: Record<string, unknown>, intervalRaw: string): { error: string } | { body: { request: Record<string, unknown>; intervalHours: number } } {
  const hours = parseIntervalHours(intervalRaw);
  if (hours === null) return { error: `The interval must be a whole number of hours from ${SCHEDULE_INTERVAL_LIMITS.min} to ${SCHEDULE_INTERVAL_LIMITS.max}.` };
  return { body: { request, intervalHours: hours } };
}

/**
 * Can this person switch the schedule the other way? Off is always allowed;
 * on only for the person it runs as (the gateway answers 403
 * `schedule_owner_only` otherwise).
 */
export function scheduleToggle(s: Pick<EngineSchedule, "enabled" | "runAsUserId">, me: string | null): { ok: true; next: boolean } | { ok: false; reason: string } {
  if (s.enabled) return { ok: true, next: false };
  if (s.runAsUserId === null) return { ok: false, reason: "The person this schedule ran as no longer exists, so it cannot be switched back on. Create a new schedule instead." };
  if (s.runAsUserId !== me) return { ok: false, reason: "Only the person this schedule runs as can switch it back on, because every run it starts executes as them." };
  return { ok: true, next: true };
}

/** ADR-0208 G9: may this person change how often the schedule runs? Only the person it runs as. */
export function scheduleEditable(s: Pick<EngineSchedule, "runAsUserId">, me: string | null): boolean {
  return me !== null && s.runAsUserId === me;
}

/** ADR-0208 G9: may this person delete the schedule? The person it runs as, or an admin. */
export function scheduleDeletable(s: Pick<EngineSchedule, "runAsUserId">, me: string | null, isAdmin: boolean): boolean {
  return isAdmin || scheduleEditable(s, me);
}

/** the sets and target of a stored request, read defensively */
export function scheduleRequestSummary(request: unknown): { agentId: string | null; sets: string[]; trials: number | null } {
  const r = (request && typeof request === "object" ? request : {}) as Record<string, unknown>;
  const target = (r.target && typeof r.target === "object" ? r.target : {}) as Record<string, unknown>;
  const config = (r.config && typeof r.config === "object" ? r.config : {}) as Record<string, unknown>;
  return {
    agentId: typeof target.agentId === "string" ? target.agentId : null,
    sets: Array.isArray(config.sets) ? config.sets.filter((s): s is string => typeof s === "string") : [],
    trials: typeof r.trials === "number" ? r.trials : null,
  };
}

/** the schedule routes' own refusal codes, in words (pinned to engine-runs.ts by the test) */
export const SCHEDULE_REFUSALS: Readonly<Record<string, string>> = {
  engine_schedule_not_found: "That schedule no longer exists, or you cannot see it. Refresh the list.",
  schedule_owner_only: "Only the person this schedule runs as can switch it back on or change how often it runs.",
  bootstrap_cannot_schedule_engine: "A schedule runs as the person who creates it, so it cannot be created without a signed-in user.",
};
