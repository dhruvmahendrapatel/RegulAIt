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
import { createDb, eq, inArray, mcpServers, notInArray, runMigrations, sql, type Db } from "@regulait/db";
import {
  claimHealthProbeBatch,
  healthProbeEligibility,
  HEALTH_PROBE_CLAIM_LOCK_KEY,
  runMcpHealthProbeSweep,
  type McpHealthProbeResult,
} from "./mcp-health-probe.js";
import { resolveBreakerConfig, setBreakerConfig, breakerConfig } from "./upstream-breaker.js";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { relaxStrictAdmissionForTest } from "./testing/strict-admission.js";

// ADR-0181: this file pins behaviour against a LOCAL MCP double (127.0.0.1, registered
// seconds ago), not the strict admission defaults — relaxed explicitly, restored after.
let restoreStrictAdmission: (() => Promise<void>) | undefined;

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

/**
 * A host the egress guard REFUSES, chosen so the refusal does not depend on
 * shared state (M-040, and M-042 for making the same mistake twice).
 *
 * The first version of the two tests below used loopback with
 * `allowPrivateRanges: false`, which passed alone and FAILED IN THE FULL RUN:
 * `mcp-proxy.test.ts` inserts an `egress_allow_hosts` row for `127.0.0.1` with
 * the private-range and plaintext opt-ins, so by the time this file ran the
 * "blocked" host was allow-listed and the refusal never happened — both tests
 * then asserted `> 0` against 0. Exactly the failure g2's own egress test carries
 * a paragraph about.
 *
 * A literal TEST-NET-3 address (RFC 5737), randomised per run, needs no shared
 * state at all: it is PUBLIC, so the private-range posture is irrelevant whatever
 * the org default says, default-deny refuses it as `host_not_allowlisted`, and no
 * other suite allow-lists it.
 */
const blockedUrl = () => `http://203.0.113.${1 + Math.floor(Math.random() * 250)}:9/`;

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
  restoreStrictAdmission = await relaxStrictAdmissionForTest(db);
  // A threshold of 1 makes "one failure opens it" the unit under test rather
  // than "three failures do", which would only test the loop.
  priorBreaker = breakerConfig();
  setBreakerConfig(resolveBreakerConfig(process.env, { failureThreshold: 1, cooldownMs: 60_000 }));
}, 120_000);

afterAll(async () => {
  await restoreStrictAdmission?.();
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
    // The breaker refuses during cooldown, so the sweep must not spend a connect
    // on an upstream it is already refusing traffic for.
    //
    // AER-037 changed WHERE that happens, not whether it happens. It used to be
    // selected and then refused by `breakerAdmits` (`skippedCircuitOpen`); it is
    // now excluded from selection in SQL (`inCooldown`), because selecting a row
    // that can only be skipped spends a bounded pass's budget on a certain skip.
    // The claim this test makes is unchanged and the assertion names the
    // mechanism that now implements it.
    const id = await register(`probe-cooldown-${randomUUID()}`, DEAD_URL);
    await probeMine();
    const opened = (await breakerOf(id)).openedAt;
    expect(opened).not.toBeNull();

    const second = await probeMine();
    expect(second.inCooldown).toBeGreaterThan(0);
    // and the open timestamp did not move: an unprobed upstream is untouched
    expect((await breakerOf(id)).openedAt?.getTime()).toBe(opened?.getTime());
  }, 60_000);
});

describe("OUR refusals never open a breaker", () => {
  it("an EGRESS-BLOCKED host is counted separately and leaves the breaker closed", async () => {
    // A public host nobody allow-listed is the egress guard's own refusal — the
    // shape an air-gapped install produces for EVERY host. If this opened a
    // breaker, such an install would report every upstream as broken while
    // nothing was actually wrong.
    const [row] = await db
      .insert(mcpServers)
      .values({
        name: `probe-egress-${randomUUID()}`,
        url: blockedUrl(),
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
        url: blockedUrl(),
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
    // A pass that selects nothing must not claim to have probed anything:
    // `probed` counts attempts that reached the upstream question.
    //
    // The registry is made non-empty EXPLICITLY, with a server whose breaker is
    // closed. `capped` compares the cap against `eligible`, and since AER-037
    // `eligible` excludes upstreams whose cooldown has not elapsed — so on a
    // registry where every breaker happened to be open (which earlier tests in
    // this file arrange) nothing is probable, `eligible` is 0 and `capped` is
    // correctly false. Leaning on "some other test left rows around" made this
    // assertion depend on which of them ran.
    const fresh = await register(`probe-zero-limit-${randomUUID()}`, DEAD_URL);
    const out = await runMcpHealthProbeSweep(db, { limit: 0 });
    expect(out.probed).toBe(0);
    expect(out.failed).toBe(0);
    expect(out.opened).toEqual([]);
    expect(out.recovered).toEqual([]);
    expect(out.eligible, "at least the server just registered is probable").toBeGreaterThan(0);
    expect(out.capped, "a zero limit over a probable registry is capped").toBe(true);
    // and the pass really did leave it alone rather than probing it anyway
    expect((await breakerOf(fresh)).openedAt).toBeNull();
  }, 60_000);
});

async function nameOf(id: string): Promise<string> {
  const [row] = await db.select({ name: mcpServers.name }).from(mcpServers).where(eq(mcpServers.id, id));
  return row!.name;
}

// ===========================================================================
// AER-037 — the cap starved the tail of the estate forever.
// ===========================================================================
//
// The first version of this sweep ordered by `breaker_opened_at desc, name asc`
// and applied `LIMIT`. That order is CONSTANT, so past the cap every five-minute
// pass probed the same lexicographically first cohort and the tail was never
// actively probed at all — keeping exactly the "first user discovers the outage"
// behaviour this file exists to remove, while `capped: true` reported the
// truncation honestly and said nothing about progress.
//
// THE CLAIM THAT REPLACED IT is about the estate across passes, not about one
// pass, so the test has to be about several. It is also the only test here that
// needs the rest of the deployment out of the way: the sweep has no per-server
// filter by design, and a rotation over a set you do not control is not a
// rotation you can assert.

describe("AER-037 — a bounded pass rotates, so the tail is late and never starved", () => {
  const LIMIT = 3;
  const COUNT = 2 * LIMIT + 1; // deliberately not a multiple: the remainder pass
  const rotation: string[] = [];

  /**
   * Park every server this file did not create: a `now()` rotation cursor and a
   * closed breaker, so the ordering under test runs over a known set.
   *
   * SAFE, and migration 0116/0118 say why in their own headers: both columns are
   * operational observations, rewritten constantly and safe to lose — never
   * evidence. Test files here run sequentially (`fileParallelism: false`), so no
   * other suite is mid-assertion on them.
   */
  const parkTheRestOfTheEstate = async () => {
    await db
      .update(mcpServers)
      .set({ lastHealthProbeAt: new Date(), breakerOpenedAt: null, breakerLastError: null })
      .where(notInArray(mcpServers.id, rotation));
  };

  /** which of OUR rows a pass actually selected, read from the cursor it stamps */
  const cursors = async () => {
    const rows = await db
      .select({ id: mcpServers.id, at: mcpServers.lastHealthProbeAt })
      .from(mcpServers)
      .where(inArray(mcpServers.id, rotation));
    return new Map(rows.map((r) => [r.id, r.at?.getTime() ?? null]));
  };

  beforeAll(async () => {
    for (let i = 0; i < COUNT; i += 1) {
      // Named so that NAME order and REGISTRATION order disagree, because the
      // defect was name order: if the rotation were still lexicographic this
      // test would pass for the wrong reason.
      rotation.push(await register(`zz-rot-${String(COUNT - i).padStart(2, "0")}-${randomUUID()}`, DEAD_URL));
    }
    await parkTheRestOfTheEstate();
  }, 60_000);

  it("reaches EVERY upstream across bounded passes, each exactly once", async () => {
    const selected: string[][] = [];
    let before = await cursors();

    // ceil(7 / 3) = 3 passes to cover the set
    for (let pass = 0; pass < 3; pass += 1) {
      const out = await runMcpHealthProbeSweep(db, { limit: LIMIT });
      const after = await cursors();
      selected.push(rotation.filter((id) => after.get(id) !== before.get(id)));
      before = after;

      // the operator-facing numbers an AER-037 diagnosis needs: a pass that
      // truncates must say how much is left, and `neverProbed` must FALL
      if (pass === 0) {
        expect(out.capped).toBe(true);
        expect(out.backlog).toBeGreaterThan(0);
      }
    }

    // THE PROPERTY: full coverage, and no row taken twice before all were taken
    // once. The defect would have produced the same three ids three times.
    const all = selected.flat();
    expect(new Set(all).size).toBe(COUNT);
    expect(all).toHaveLength(COUNT);
    // and the first pass really was bounded, rather than the limit being ignored
    expect(selected[0]).toHaveLength(LIMIT);
  }, 60_000);

  it("does not spend a bounded pass on breakers that nobody may probe", async () => {
    // Every row above is now circuit-broken with a 60s cooldown (threshold 1),
    // so a probe against any of them is impossible until it elapses. Selecting
    // them anyway would be a SECOND way to starve the tail: the budget goes to
    // rows that can only be skipped.
    const out = await runMcpHealthProbeSweep(db, { limit: LIMIT });

    expect(out.inCooldown).toBeGreaterThanOrEqual(COUNT);
    // NON-VACUITY: the rows really are in that state, read from the column
    const openCount = (
      await db
        .select({ openedAt: mcpServers.breakerOpenedAt })
        .from(mcpServers)
        .where(inArray(mcpServers.id, rotation))
    ).filter((r) => r.openedAt !== null).length;
    expect(openCount).toBe(COUNT);
    // and none of ours was selected — their cursors did not move
    const before = await cursors();
    await runMcpHealthProbeSweep(db, { limit: LIMIT });
    const after = await cursors();
    for (const id of rotation) expect(after.get(id)).toBe(before.get(id));
  }, 60_000);
});

// ===========================================================================
// AER-037, second pass — two passes AT ONCE claim disjoint sets.
// ===========================================================================
//
// The rotation above is a property of passes in SEQUENCE. The first fix also
// claimed that "two concurrent passes select disjoint sets" — in a comment
// between a SELECT and an UPDATE that were two statements, with nothing
// enforcing it: a second pass arriving in the gap picked the same head,
// stamped it again and probed it again. The claim is now one statement (`for
// update skip locked` plus the stamp), and this is the test that can tell the
// two apart.
//
// MAKING THE OVERLAP CERTAIN rather than likely: a trigger on this test's rows
// sleeps while their cursor is being stamped, so the second pass's claim is
// guaranteed to arrive while the first pass's claim still holds its row locks.
// Column- and name-scoped, so the breaker writes the probes make, and every
// other suite's rows, never touch it; dropped in `finally` whatever happens.
//
// WHAT IS READ is the world, then the report: every one of these upstreams is
// dead and the threshold is 1, so a probe is an opened breaker with ONE
// recorded failure. Probed twice is two failures; never probed is a closed
// breaker with none. Each pass's `opened` list names what it took, and the
// two lists must partition the set.

describe("AER-037 — two concurrent passes claim DISJOINT sets", () => {
  const LIMIT = 3;
  const COUNT = 2 * LIMIT;
  const tag = `zz-pair-${randomUUID().slice(0, 8)}`;
  const pair: string[] = [];
  const names: string[] = [];

  beforeAll(async () => {
    for (let i = 0; i < COUNT; i += 1) {
      // registration order and name order disagree, as in the rotation block
      const name = `${tag}-${String(COUNT - i).padStart(2, "0")}`;
      names.push(name);
      pair.push(await register(name, DEAD_URL));
    }
    // park the rest of the estate — the rotation block says why this is safe
    await db
      .update(mcpServers)
      .set({ lastHealthProbeAt: new Date(), breakerOpenedAt: null, breakerLastError: null })
      .where(notInArray(mcpServers.id, pair));
  }, 60_000);

  it("no upstream is probed twice and none is skipped when two passes overlap", async () => {
    // the tag is this test's own and hex-only, so inlining it in DDL is safe
    expect(tag).toMatch(/^zz-pair-[0-9a-f]{8}$/);
    const fnName = `zz_aer037_hold_${tag.slice(-8)}`;
    await db.execute(
      sql.raw(`
      create or replace function ${fnName}() returns trigger as $$
      begin
        perform pg_sleep(0.25);
        return new;
      end $$ language plpgsql;
    `),
    );
    await db.execute(
      sql.raw(
        `create trigger ${fnName} before update of last_health_probe_at on mcp_servers ` +
          `for each row when (new.name like '${tag}-%') execute function ${fnName}()`,
      ),
    );
    try {
      const [a, b] = await Promise.all([
        runMcpHealthProbeSweep(db, { limit: LIMIT }),
        runMcpHealthProbeSweep(db, { limit: LIMIT }),
      ]);

      // THE PARTITION, from each pass's own report of what it opened.
      const ours = (out: McpHealthProbeResult) => out.opened.filter((n) => names.includes(n)).sort();
      const tookA = ours(a);
      const tookB = ours(b);
      expect(tookA, `pass A: ${JSON.stringify(a)}`).toHaveLength(LIMIT);
      expect(tookB, `pass B: ${JSON.stringify(b)}`).toHaveLength(LIMIT);
      expect(
        tookA.filter((n) => tookB.includes(n)),
        "no upstream was probed by both passes",
      ).toEqual([]);
      expect([...tookA, ...tookB].sort(), "no upstream was skipped").toEqual([...names].sort());

      // AND THE WORLD AGREES: exactly one recorded failure on every row. A
      // report could partition correctly while a row was probed twice
      // underneath it; the failure count cannot.
      const rows = await db
        .select({
          name: mcpServers.name,
          failures: mcpServers.breakerConsecutiveFailures,
          openedAt: mcpServers.breakerOpenedAt,
        })
        .from(mcpServers)
        .where(inArray(mcpServers.id, pair));
      expect(rows).toHaveLength(COUNT);
      for (const r of rows) {
        expect(r.failures, `${r.name} was probed exactly once`).toBe(1);
        expect(r.openedAt, `${r.name} was probed at all`).not.toBeNull();
      }
    } finally {
      await db.execute(sql.raw(`drop trigger if exists ${fnName} on mcp_servers`));
      await db.execute(sql.raw(`drop function if exists ${fnName}()`));
    }
  }, 60_000);
});

// ===========================================================================
// AER-037 — the interleaving `skip locked` alone did not cover: a claim whose
// SNAPSHOT predates the other claim's commit but whose LOCKS come after it.
// ===========================================================================
//
// The overlap test above holds A's row locks for B's whole statement, so B only
// ever meets rows that are still locked and skips them. The reviewer's case is
// the other ordering: B takes its statement snapshot while A's claim is
// uncommitted, A commits, and only THEN does B reach A's rows. Unlocked by
// then, they are locked by B, re-checked against the WHERE clause (which does
// not look at the cursor) and claimed a second time.
//
// Driven deterministically, with no sleeps:
//  1. A second connection holds a GATE advisory lock.
//  2. Claim A runs inside a transaction the test keeps open, so its stamps are
//     uncommitted (and, after the fix, so is its claim lock).
//  3. Claim B starts with `eligible` extended by a function that waits on the
//     gate. Evaluated per row during B's scan, it parks B AFTER B's snapshot and
//     BEFORE B locks anything. After the fix, B parks earlier still, on the
//     claim lock, before its claim statement has a snapshot at all.
//  4. Once B is seen waiting on an advisory lock, A commits; then the gate is
//     released; then B finishes.
// The two claimed sets must be disjoint and together cover the six rows.

describe("AER-037 — a claim whose snapshot predates another claim's commit", () => {
  const LIMIT = 3;
  const COUNT = 2 * LIMIT;
  const tag = `zz-snap-${randomUUID().slice(0, 8)}`;
  const ids: string[] = [];
  const names: string[] = [];

  beforeAll(async () => {
    for (let i = 0; i < COUNT; i += 1) {
      const name = `${tag}-${String(COUNT - i).padStart(2, "0")}`;
      names.push(name);
      ids.push(await register(name, DEAD_URL));
    }
    // park the rest of the estate — the rotation block says why this is safe;
    // this file's earlier blocks left breakers open and cursors null on their
    // own rows, which would otherwise jump this queue
    await db
      .update(mcpServers)
      .set({ lastHealthProbeAt: new Date(), breakerOpenedAt: null, breakerLastError: null })
      .where(notInArray(mcpServers.id, ids));
  }, 60_000);

  it("claim B, started before claim A commits, takes none of A's rows", async () => {
    expect(tag).toMatch(/^zz-snap-[0-9a-f]{8}$/);
    const gateFn = `zz_aer037_gate_${tag.slice(-8)}`;
    const K1 = 37_037;
    const gate = 1 + Math.floor(Math.random() * 2_000_000_000);
    // the gate is a SHARED xact lock, so B's per-row calls stack harmlessly
    // and all release with B's own statement or transaction
    await db.execute(
      sql.raw(`
      create or replace function ${gateFn}() returns boolean as $$
      begin
        perform pg_advisory_xact_lock_shared(${K1}, ${gate});
        return true;
      end $$ language plpgsql volatile;
    `),
    );
    const holder = createDb(DATABASE_URL!);
    const gateConn = await (holder.$client as unknown as {
      connect: () => Promise<{ query: (t: string) => Promise<unknown>; release: () => void }>;
    }).connect();
    let b: Promise<Array<{ name: string }>> | undefined;
    try {
      await gateConn.query(`select pg_advisory_lock(${K1}, ${gate})`);

      let tookA: string[] = [];
      await db.transaction(async (outer) => {
        // A — claimed and stamped, NOT committed until this callback returns
        tookA = (await claimHealthProbeBatch(outer, LIMIT, healthProbeEligibility())).map((r) => r.name);

        // B — on its own pooled connection; not awaited, it is about to park
        b = claimHealthProbeBatch(db, LIMIT, sql`${healthProbeEligibility()} and ${sql.raw(gateFn)}()`);

        // B is parked on an advisory lock: the gate (its snapshot taken, no
        // row locked yet) or, with the claim serialized, the claim lock
        const deadline = Date.now() + 15_000;
        for (;;) {
          const r = (await db.execute(sql`
            select count(*)::int as "n" from pg_locks
            where locktype = 'advisory' and not granted
              and ((objsubid = 2 and classid = ${K1} and objid = ${gate})
                or (objsubid = 1 and ((classid::bigint << 32) | objid::bigint) = ${HEALTH_PROBE_CLAIM_LOCK_KEY}))
          `)) as unknown as { rows: Array<{ n: number }> };
          if (r.rows[0]!.n >= 1) break;
          if (Date.now() > deadline) throw new Error("claim B never parked on an advisory lock");
          await new Promise((res) => setTimeout(res, 20));
        }
      });
      // A has COMMITTED. Only now may B reach any row.
      await gateConn.query(`select pg_advisory_unlock(${K1}, ${gate})`);
      const tookB = (await b!).map((r) => r.name);

      const oursA = tookA.filter((n) => names.includes(n)).sort();
      const oursB = tookB.filter((n) => names.includes(n)).sort();
      expect(oursA, `claim A: ${JSON.stringify(tookA)}`).toHaveLength(LIMIT);
      expect(
        oursA.filter((n) => oursB.includes(n)),
        `claim B re-claimed A's rows: A=${JSON.stringify(oursA)} B=${JSON.stringify(oursB)}`,
      ).toEqual([]);
      expect([...oursA, ...oursB].sort(), "together they cover every row once").toEqual([...names].sort());
    } finally {
      await gateConn.query(`select pg_advisory_unlock_all()`).catch(() => undefined);
      await b?.catch(() => undefined);
      gateConn.release();
      await holder.$client.end();
      await db.execute(sql.raw(`drop function if exists ${gateFn}()`));
    }
  }, 60_000);
});
