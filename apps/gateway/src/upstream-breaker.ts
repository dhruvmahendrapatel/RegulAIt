/**
 * ADR-0126 / ROADMAP G2 — the circuit breaker for MCP upstreams.
 *
 * ── WHAT IT IS FOR, WHICH IS NOT WHAT THE DEADLINE IS FOR ──────────────────
 * The deadlines added alongside this (timeouts.ts) bound ONE call. They do
 * nothing about the tenth caller in a row paying that same bound against an
 * upstream everybody already knows is dead. With a 10s connect deadline and a
 * dead server, a hundred queued requests is a hundred held sockets and sixteen
 * minutes of aggregate waiting to learn something the first request learned.
 * The breaker turns the second failure onwards into an immediate, named answer.
 *
 * ── THE STATE MACHINE, AND THE ONE RACE THAT MATTERS ───────────────────────
 *   closed     — normal. Failures accumulate; any success resets the count.
 *   open       — `breaker_opened_at` set and the cooldown has not elapsed.
 *                Refuse immediately, touch nothing, contact nobody.
 *   half-open  — the cooldown HAS elapsed. Exactly one request is elected to
 *                probe; it succeeds and the breaker closes, or it fails and
 *                the cooldown restarts.
 *
 * "Exactly one" is the part worth reading. The naive half-open lets every
 * waiting request through at the moment the cooldown expires, which against a
 * still-dead upstream reproduces precisely the thundering herd the breaker was
 * added to prevent — at its worst moment, when a backlog has built up. The
 * election is a conditional UPDATE that moves `breaker_opened_at` forward only
 * if it still holds the value this request read. One statement, atomic, no
 * lock, no transaction: the winner probes, everyone else sees a moved timestamp
 * and keeps fast-failing.
 *
 * ── WHY THE FAST-FAILS ARE NOT EACH AUDITED ────────────────────────────────
 * Every other refusal in this product files a row. This one deliberately files
 * the TRANSITIONS — opened, probing, recovered — and not the individual
 * refusals, because an open breaker's whole job is to refuse a lot, quickly. A
 * row per refused request would turn one upstream outage into thousands of
 * identical audit entries, burying the transitions that actually answer the
 * question an auditor asks: when did this upstream go away, and when did it
 * come back. The refusal is still NAMED to the caller; it is the ledger that
 * gets the summary rather than the stream.
 *
 * ── STATE IS SHARED, AND COSTS NOTHING TO READ ─────────────────────────────
 * It lives on the `mcp_servers` row the proxy already fetches, so every process
 * sees the same breaker with no extra query. That matters after ADR-0125: a
 * per-process breaker would make each replica rediscover a dead upstream
 * independently, and — worse for this product — would make the state invisible,
 * which is the criticism levelled at in-process scheduler health.
 */
import { and, auditLog, eq, isNotNull, mcpServers, sql, type Db } from "@regulait/db";

/** the same sentinel every other module in this directory uses for a platform
 * act with no human behind it */
const NIL_USER = "00000000-0000-0000-0000-000000000000";

/** There is no shared `audit()` helper in this codebase — the convention is a
 * direct insert, as `mcp-egress.ts` does. Kept local and tiny so the three
 * transitions below read as one shape. */
async function fileTransition(
  db: Db,
  args: {
    serverId: string;
    effect: "allow" | "deny";
    ruleId: string;
    reason: string;
    detail: Record<string, unknown>;
  },
): Promise<void> {
  await db.insert(auditLog).values({
    userId: NIL_USER,
    serverId: args.serverId,
    objectType: "mcp_server",
    objectId: args.serverId,
    effect: args.effect,
    ruleId: args.ruleId,
    ruleChain: [],
    reason: args.reason,
    detail: args.detail,
  });
}

export interface BreakerConfig {
  /** consecutive failures before the circuit opens */
  failureThreshold: number;
  /** how long an open circuit refuses before electing a prober */
  cooldownMs: number;
}

export const BREAKER_DEFAULTS: Readonly<BreakerConfig> = Object.freeze({
  // Five, not one. A single failure is ordinary — a redeploy, a dropped
  // connection, a blip — and opening on it would make the breaker itself the
  // outage. Five consecutive failures with no success in between is a pattern.
  failureThreshold: 5,
  // Long enough that probing is cheap against a genuinely dead upstream, short
  // enough that a recovered one is back in service before a human notices.
  cooldownMs: 30_000,
});

function envInt(env: NodeJS.ProcessEnv, key: string, dflt: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return dflt;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${key} must be a positive number, got: ${raw}`);
  }
  return Math.floor(n);
}

export function resolveBreakerConfig(
  env: NodeJS.ProcessEnv = process.env,
  override: Partial<BreakerConfig> = {},
): BreakerConfig {
  return {
    failureThreshold: envInt(env, "REGULAIT_BREAKER_FAILURES", BREAKER_DEFAULTS.failureThreshold),
    cooldownMs: envInt(env, "REGULAIT_BREAKER_COOLDOWN_MS", BREAKER_DEFAULTS.cooldownMs),
    ...override,
  };
}

let active: BreakerConfig = resolveBreakerConfig();
export function breakerConfig(): BreakerConfig {
  return active;
}
export function setBreakerConfig(cfg: BreakerConfig): void {
  active = cfg;
}

export const BREAKER_RULE_IDS = {
  opened: "mcp-upstream-breaker-opened",
  probing: "mcp-upstream-breaker-probing",
  closed: "mcp-upstream-breaker-closed",
} as const;

/** the subset of the server row this module needs — so callers can pass the
 * row they already have rather than re-reading it */
export interface BreakerRow {
  id: string;
  name: string;
  breakerOpenedAt: Date | null;
  breakerLastError: string | null;
  breakerConsecutiveFailures: number;
}

export type BreakerState = "closed" | "open" | "half_open";

/** PURE. Given a row and a clock, which state is this breaker in? */
export function breakerStateOf(
  row: Pick<BreakerRow, "breakerOpenedAt">,
  cfg: BreakerConfig = active,
  now: number = Date.now(),
): BreakerState {
  if (row.breakerOpenedAt === null) return "closed";
  return now - row.breakerOpenedAt.getTime() >= cfg.cooldownMs ? "half_open" : "open";
}

/**
 * Should this request be refused before anything is attempted?
 *
 * Returns the refusal detail when yes, `null` when the request may proceed —
 * either because the breaker is closed, or because THIS request won the
 * election to probe a half-open one.
 *
 * The election is the conditional UPDATE. `breaker_opened_at = <what we read>`
 * in the WHERE clause is the whole mechanism: only the first request to arrive
 * after the cooldown matches it, and moving the timestamp forward makes every
 * concurrent sibling miss. No lock, no transaction, one round trip.
 */
export async function breakerAdmits(
  db: Db,
  row: BreakerRow,
  cfg: BreakerConfig = active,
): Promise<{ refusedUntilMs: number; reason: string } | null> {
  const state = breakerStateOf(row, cfg);
  if (state === "closed") return null;

  const openedAt = row.breakerOpenedAt!;
  if (state === "open") {
    const retryInMs = Math.max(0, cfg.cooldownMs - (Date.now() - openedAt.getTime()));
    return {
      refusedUntilMs: retryInMs,
      reason:
        `upstream MCP server '${row.name}' is circuit-broken after ` +
        `${row.breakerConsecutiveFailures} consecutive failures: ${row.breakerLastError ?? "unknown"}`,
    };
  }

  // half-open: elect exactly one prober
  const elected = await db
    .update(mcpServers)
    .set({ breakerOpenedAt: new Date() })
    .where(and(eq(mcpServers.id, row.id), eq(mcpServers.breakerOpenedAt, openedAt)))
    .returning({ id: mcpServers.id });

  if (elected.length === 1) {
    await fileTransition(db, {
      serverId: row.id,
      effect: "allow",
      ruleId: BREAKER_RULE_IDS.probing,
      reason: `cooldown elapsed for '${row.name}'; this request was elected to probe the upstream`,
      detail: { consecutiveFailures: row.breakerConsecutiveFailures, cooldownMs: cfg.cooldownMs },
    });
    return null;
  }

  // somebody else got there first — keep fast-failing rather than joining a herd
  return {
    refusedUntilMs: cfg.cooldownMs,
    reason:
      `upstream MCP server '${row.name}' is circuit-broken and another request is already ` +
      `probing it`,
  };
}

/**
 * One upstream failure. Increments, and OPENS on crossing the threshold.
 *
 * The increment is done in SQL rather than read-modify-write for the same
 * reason ADR-0125 gave for the run budget: concurrent failures against one dead
 * upstream are the normal case here, not the exotic one, and two workers each
 * writing an absolute would lose counts at exactly the moment the count is
 * supposed to be rising.
 */
export async function recordUpstreamFailure(
  db: Db,
  row: BreakerRow,
  error: string,
  cfg: BreakerConfig = active,
): Promise<void> {
  const [updated] = await db
    .update(mcpServers)
    .set({
      breakerConsecutiveFailures: sql`${mcpServers.breakerConsecutiveFailures} + 1`,
      breakerLastFailureAt: new Date(),
      breakerLastError: error,
    })
    .where(eq(mcpServers.id, row.id))
    .returning({ failures: mcpServers.breakerConsecutiveFailures, openedAt: mcpServers.breakerOpenedAt });

  if (!updated) return;
  // already open (this was the elected probe failing) — restart the cooldown
  // rather than filing a second "opened" transition
  if (updated.openedAt !== null) {
    await db.update(mcpServers).set({ breakerOpenedAt: new Date() }).where(eq(mcpServers.id, row.id));
    return;
  }
  if (updated.failures < cfg.failureThreshold) return;

  await db.update(mcpServers).set({ breakerOpenedAt: new Date() }).where(eq(mcpServers.id, row.id));
  await fileTransition(db, {
    serverId: row.id,
    effect: "deny",
    ruleId: BREAKER_RULE_IDS.opened,
    reason:
      `circuit opened for upstream '${row.name}' after ${updated.failures} consecutive ` +
      `failures; calls are refused for ${cfg.cooldownMs}ms. Last error: ${error}`,
    detail: { consecutiveFailures: updated.failures, cooldownMs: cfg.cooldownMs },
  });
}

/**
 * One upstream success. Resets the count, and files a transition ONLY if the
 * breaker was actually open — otherwise every healthy call would write a row.
 */
export async function recordUpstreamSuccess(db: Db, row: BreakerRow): Promise<void> {
  if (row.breakerConsecutiveFailures === 0 && row.breakerOpenedAt === null) return;

  await db
    .update(mcpServers)
    .set({ breakerConsecutiveFailures: 0, breakerOpenedAt: null, breakerLastError: null })
    .where(eq(mcpServers.id, row.id));

  if (row.breakerOpenedAt !== null) {
    await fileTransition(db, {
      serverId: row.id,
      effect: "allow",
      ruleId: BREAKER_RULE_IDS.closed,
      reason: `upstream '${row.name}' answered a probe; circuit closed and calls resume`,
      detail: { recoveredAfterFailures: row.breakerConsecutiveFailures },
    });
  }
}

/** Every upstream currently circuit-broken — for the operator read below. */
export async function openBreakers(db: Db) {
  return db
    .select({
      id: mcpServers.id,
      name: mcpServers.name,
      openedAt: mcpServers.breakerOpenedAt,
      consecutiveFailures: mcpServers.breakerConsecutiveFailures,
      lastError: mcpServers.breakerLastError,
    })
    .from(mcpServers)
    .where(isNotNull(mcpServers.breakerOpenedAt));
}
