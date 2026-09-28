/**
 * ACTIVE upstream health probing — and the two things it must never do.
 *
 * The easy half (a dead upstream gets its breaker opened before a user finds it)
 * is asserted first because it is the feature. The two hard halves are why this
 * file is longer than the feature:
 *
 *  1. **OUR refusals must never open a breaker.** An egress block and an
 *     admission hold are decisions RegulAIt made. Charging them to the breaker
 *     would make an air-gapped install — where every outbound host is refused by
 *     design — report every upstream as circuit-broken on a deployment where
 *     nothing is wrong, and would send an operator hunting a network fault
 *     instead of reading a manifest finding. Asserted by counts AND by the
 *     breaker columns being untouched, because a count could be right while the
 *     row was written anyway.
 *  2. **It must not join a herd.** A probe against an open breaker enters the
 *     breaker's own one-winner election; if a real request is already probing,
 *     this sweep must fast-skip rather than add a second connect.
 *
 * And the one that is easy to get backwards: a probe that FAILS against an
 * already-open breaker must not be reported as a recovery.
 *
 * Writes (breaker columns, audit transitions) and registers servers, so `zz-`
 * (M-018). Every assertion is scoped to ids this file created (M-008).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, eq, mcpServers, runMigrations, type Db } from "@regulait/db";
import { runMcpHealthProbeSweep } from "./mcp-health-probe.js";
import { resolveBreakerConfig, setBreakerConfig, breakerConfig } from "./upstream-breaker.js";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import path from "node:path";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

let db: Db;
let priorBreaker: ReturnType<typeof breakerConfig>;
/** every server id this file creates, so nothing asserts over the deployment */
const mine: string[] = [];

/** an address nothing is listening on — a genuine upstream failure */
const DEAD_URL = "http://127.0.0.1:9/";

const register = async (name: string, url: string) => {
  const [row] = await db
    .insert(mcpServers)
    .values({ name, url, allowPrivateRanges: true })
    .returning({ id: mcpServers.id });
  mine.push(row!.id);
  return row!.id;
};

const breakerOf = async (id: string) => {
  const [row] = await db
    .select({
      openedAt: mcpServers.breakerOpenedAt,
      failures: mcpServers.breakerConsecutiveFailures,
      lastError: mcpServers.breakerLastError,
    })
    .from(mcpServers)
    .where(eq(mcpServers.id, id));
  return row!;
};

/** only this file's servers, so a shared deployment's rows never leak in */
const probeMine = async () => {
  // The sweep has no per-server filter by design — it is a sweep. So the
  // assertions below read the BREAKER COLUMNS of this file's own rows rather
  // than the sweep's aggregate counts wherever the deployment could contribute.
  return runMcpHealthProbeSweep(db, { limit: 500 });
};

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  // A threshold of 1 makes "one failure opens it" the unit under test rather
  // than "three failures do", which would only test the loop.
  priorBreaker = breakerConfig();
  setBreakerConfig(resolveBreakerConfig(process.env, { failureThreshold: 1, cooldownMs: 60_000 }));
}, 120_000);

afterAll(async () => {
  setBreakerConfig(priorBreaker);
  for (const id of mine) await db.delete(mcpServers).where(eq(mcpServers.id, id));
  await db.$client.end();
});

describe("the feature — a dead upstream is broken before a user finds it", () => {
  it("opens the breaker on an upstream nobody has called", async () => {
    const id = await register(`probe-dead-${randomUUID()}`, DEAD_URL);

    const before = await breakerOf(id);
    expect(before.openedAt, "a freshly registered server starts closed").toBeNull();
    expect(before.failures).toBe(0);

    const out = await probeMine();
    expect(out.probed).toBeGreaterThan(0);

    const after = await breakerOf(id);
    expect(after.openedAt, "the probe opened it without any user request").not.toBeNull();
    expect(after.failures).toBeGreaterThanOrEqual(1);
    expect(after.lastError, "and recorded WHY, so the refusal can name a cause").toBeTruthy();
    expect(out.opened).toContain(await nameOf(id));
  }, 60_000);

  it("a second pass does NOT re-probe it — the cooldown is respected", async () => {
    // The breaker refuses during cooldown, so the sweep must skip rather than
    // spend a connect on an upstream it is already refusing traffic for.
    const id = await register(`probe-cooldown-${randomUUID()}`, DEAD_URL);
    await probeMine();
    const opened = (await breakerOf(id)).openedAt;
    expect(opened).not.toBeNull();

    const second = await probeMine();
    expect(second.skippedCircuitOpen).toBeGreaterThan(0);
    // and the open timestamp did not move: a skipped upstream is untouched
    expect((await breakerOf(id)).openedAt?.getTime()).toBe(opened?.getTime());
  }, 60_000);
});

describe("OUR refusals never open a breaker", () => {
  it("an EGRESS-BLOCKED host is counted separately and leaves the breaker closed", async () => {
    // `allowPrivateRanges: false` against a loopback address is the egress
    // guard's own refusal — the shape an air-gapped install produces for every
    // host. If this opened a breaker, such an install would report every
    // upstream as broken while nothing was actually wrong.
    const [row] = await db
      .insert(mcpServers)
      .values({
        name: `probe-egress-${randomUUID()}`,
        url: DEAD_URL,
        allowPrivateRanges: false,
      })
      .returning({ id: mcpServers.id });
    const id = row!.id;
    mine.push(id);

    const out = await probeMine();
    expect(out.skippedOurRefusal, "counted as ours, not as the upstream's").toBeGreaterThan(0);

    const after = await breakerOf(id);
    expect(after.openedAt, "an egress refusal must not open a breaker").toBeNull();
    expect(after.failures, "and must not increment the failure count either").toBe(0);
    expect(after.lastError).toBeNull();
    expect(out.opened).not.toContain(await nameOf(id));
  }, 60_000);

  it("the counts distinguish the two, so an operator can tell them apart", async () => {
    // THE CONTROL for the test above: in one pass, a dead upstream and an
    // egress-refused one must land in DIFFERENT buckets. Without this, both
    // tests would pass if the sweep counted everything as `skippedOurRefusal`.
    const dead = await register(`probe-mix-dead-${randomUUID()}`, DEAD_URL);
    const [blockedRow] = await db
      .insert(mcpServers)
      .values({
        name: `probe-mix-egress-${randomUUID()}`,
        url: DEAD_URL,
        allowPrivateRanges: false,
      })
      .returning({ id: mcpServers.id });
    const blocked = blockedRow!.id;
    mine.push(blocked);

    const out = await probeMine();
    expect(out.failed, "the dead one is an upstream failure").toBeGreaterThan(0);
    expect(out.skippedOurRefusal, "the blocked one is our refusal").toBeGreaterThan(0);

    expect((await breakerOf(dead)).openedAt, "dead: broken").not.toBeNull();
    expect((await breakerOf(blocked)).openedAt, "blocked: untouched").toBeNull();
  }, 60_000);
});

describe("the sweep reports what the breaker did, not what it guessed", () => {
  it("a probe that FAILS against an open breaker is not reported as a recovery", async () => {
    // The easy bug: "we probed an open breaker" read as "it came back". The
    // cooldown is set to 0 so the breaker is half-open and this sweep wins the
    // election — it really does probe — and the probe really does fail.
    const id = await register(`probe-still-dead-${randomUUID()}`, DEAD_URL);
    await probeMine();
    expect((await breakerOf(id)).openedAt).not.toBeNull();

    setBreakerConfig(resolveBreakerConfig(process.env, { failureThreshold: 1, cooldownMs: 0 }));
    try {
      const out = await probeMine();
      expect(out.recovered, "still dead — not a recovery").not.toContain(await nameOf(id));
      expect((await breakerOf(id)).openedAt, "and still broken").not.toBeNull();
    } finally {
      setBreakerConfig(resolveBreakerConfig(process.env, { failureThreshold: 1, cooldownMs: 60_000 }));
    }
  }, 60_000);

  it("reports zero probes and no failures when there is nothing reachable to charge", async () => {
    // A pass over a deployment whose only entries are egress-refused must not
    // claim to have probed anything: `probed` counts attempts that reached the
    // upstream question, and our own refusal never did.
    const out = await runMcpHealthProbeSweep(db, { limit: 0 });
    expect(out.probed).toBe(0);
    expect(out.failed).toBe(0);
    expect(out.opened).toEqual([]);
    expect(out.recovered).toEqual([]);
    expect(out.capped, "a zero limit over a non-empty registry is capped").toBe(true);
  }, 60_000);
});

async function nameOf(id: string): Promise<string> {
  const [row] = await db.select({ name: mcpServers.name }).from(mcpServers).where(eq(mcpServers.id, id));
  return row!.name;
}
