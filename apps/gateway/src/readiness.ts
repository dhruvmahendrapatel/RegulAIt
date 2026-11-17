/**
 * ADR-0343 — readiness for N replicas behind a load balancer.
 *
 * `GET /health` stays the liveness probe: it answers whether this process and its database pool work. `GET /ready` is
 * the readiness probe: the same database check, and 503 `draining` from the moment a shutdown starts, so the load
 * balancer (a Kubernetes Service, an ALB target group, a compose healthcheck) stops sending new requests to a replica
 * BEFORE it stops accepting them. A restarting replica therefore drops no request it was handed.
 *
 * The draining flag is per app instance (a WeakSet), not per process, so the hundred test files that build apps never
 * see each other's state.
 */
const draining = new WeakSet<object>();

/** mark this app as draining: `/ready` answers 503 from now on */
export function markDraining(app: object): void {
  draining.add(app);
}

export function isDraining(app: object): boolean {
  return draining.has(app);
}

/** the default wait between "not ready" and "stop accepting" (0: a single host has no load balancer to tell) */
export const DEFAULT_DRAIN_DELAY_MS = 0;
/** the longest drain delay accepted, so a typo cannot hold a replica past any orchestrator's grace period */
export const MAX_DRAIN_DELAY_MS = 60_000;

/** REGULAIT_DRAIN_DELAY_MS: how long a draining replica keeps serving while the load balancer notices `/ready` */
export function resolveDrainDelayMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.REGULAIT_DRAIN_DELAY_MS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_DRAIN_DELAY_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_DRAIN_DELAY_MS;
  return Math.min(Math.trunc(n), MAX_DRAIN_DELAY_MS);
}
