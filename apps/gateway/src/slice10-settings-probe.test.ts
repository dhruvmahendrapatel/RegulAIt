import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  authSessions,
  createDb,
  desc,
  eq,
  ORG_SETTINGS_ID,
  orgSettings,
  runMigrations,
  type Db,
  type OrgSettingsRow,
} from "@regulait/db";
import { buildApp } from "./app.js";

/**
 * SLICE-10 ADVERSARIAL PROBE — org settings / licensing / scheduler, at the
 * one seam the existing suites do not pin.
 *
 * What is deliberately NOT re-tested here (already pinned, by attack, elsewhere):
 *  - the CEILING MODEL itself (org ≥ user, narrowing only): routing off beats
 *    a per-user 'automatic' and lands no ledger row; semantic-cache 'off'
 *    beats a caller's opt-in; unknown keys and out-of-wall values 400; size
 *    ceilings narrow below the zod walls; worker caps clamp the run-node loop
 *    -> org-settings.test.ts ("optimizer governance — the ceiling model",
 *    "size ceilings", "worker caps");
 *  - a ceiling change REACHING an already-issued API key on next use is
 *    implicitly pinned twice: org-settings.test.ts's size-ceiling test
 *    narrows max_attachments AFTER the caller's key was minted in beforeAll
 *    (the very next dispatch on that key 422s), and session-ip-policy.test.ts
 *    ("api_key_ip_policy is a SEPARATE knob") flips the IP policy after key
 *    issuance and the next header-key request is refused;
 *  - licensing (ADR-0052), all four demanded seams: forged/tampered fails
 *    CLOSED and never displaces the installed license ("forgery fails CLOSED
 *    — refuses a TAMPERED document and leaves the installed license in
 *    force"); ABSENT fails OPEN ("absence is not an error"); EXPIRED keeps
 *    reads and governance open while expansion fails closed ("an EXPIRED
 *    license degrades to read-only, it does not brick"); deactivating a user
 *    frees a seat AND the freed seat is provable by provisioning into it
 *    ("does not count a DEACTIVATED user, and deactivating frees a seat")
 *    -> licensing.test.ts;
 *  - the scheduler (ADR-0064): a throwing job records failure in all three
 *    places (ledger row, job row lastOutcome/consecutiveFailures, deny audit
 *    scheduler-job-failed), releases its lease, and job B on the SAME tick
 *    still runs while the gateway keeps serving -> scheduler.test.ts ("a
 *    crashing job is isolated"); the ADR-0031 prune/backup schedulers'
 *    failures land on the admin health surface without folding into /health
 *    -> scheduler-health.test.ts.
 *
 * The residual seam probed here — WHICH already-issued credentials does an
 * org ceiling change reach? API keys: yes (cited above — the policy/ceiling
 * is read on every use). SESSIONS: no. `sessionLifetimeHours` is stamped
 * into `auth_sessions.expiresAt` at ISSUANCE and resolve compares only the
 * stored walls, so NARROWING the lifetime does not shorten sessions that
 * already exist. This file pins BOTH halves of that split empirically:
 *  1. a session issued under the 24h default, older than a later-narrowed
 *     1h ceiling, is still admitted (the narrowing is issuance-scoped);
 *  2. CONTROL (non-vacuity for the knob): a session issued AFTER the
 *     narrowing carries the 1h wall, not the 24h one.
 * FINDING, reported not "fixed" (semantics, ADR-0021 territory): an org that
 * needs a lifetime narrowing to bite NOW must also revoke standing sessions
 * (the ADR-0039 levers: admin revocation / revoke-others / enforce_continuous
 * IP policy, all pinned in session-ip-policy.test.ts). If the intended
 * semantics is ceiling-at-use, expiry should be re-derived from org settings
 * at resolve time — that is a product decision, not a test fix.
 *
 * Shares one DB (fileParallelism off); everything is prefixed s10-. The org
 * singleton is snapshotted in beforeAll and restored byte-identically in
 * afterAll (M-012; auth.test.ts precedent).
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);
const BOOT = "s10-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const CSRF = { "x-regulait-csrf": "1" };

let db: Db;
let app: ReturnType<typeof buildApp>;
let userId: string;
let apiKey: string;
let orgSettingsSnapshot: OrgSettingsRow | null = null;

const cookieOf = (res: { cookies: Array<{ name: string; value: string }> }): string => {
  const c = res.cookies.find((x) => x.name === "regulait_session");
  expect(c, "expected a session cookie").toBeTruthy();
  return c!.value;
};
const me = (cookie: string) =>
  app.inject({ method: "GET", url: "/auth/me", cookies: { regulait_session: cookie } });
const loginWithKey = async () => {
  const r = await app.inject({
    method: "POST", url: "/auth/login-with-key", headers: CSRF, payload: { apiKey },
  });
  expect(r.statusCode).toBe(200);
  return cookieOf(r);
};
/** the user's newest session row (only this file logs this user in) */
const latestSession = async () => {
  const [row] = await db
    .select()
    .from(authSessions)
    .where(eq(authSessions.userId, userId))
    .orderBy(desc(authSessions.createdAt))
    .limit(1);
  expect(row).toBeTruthy();
  return row!;
};
const putOrg = async (patch: Record<string, unknown>) => {
  const r = await app.inject({ method: "PUT", headers: AUTH, url: "/v1/org/settings", payload: patch });
  expect(r.statusCode).toBe(200);
};

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "c1".repeat(32) });

  const u = await app.inject({
    method: "POST", headers: AUTH, url: "/v1/users",
    payload: { email: "s10-user@example.com", displayName: "S10 User" },
  });
  expect(u.statusCode).toBe(201);
  userId = u.json().id;
  const k = await app.inject({
    method: "POST", headers: AUTH, url: `/v1/users/${userId}/keys`, payload: { name: "s10" },
  });
  apiKey = k.json().token;

  // snapshot the shared singleton so whatever this file flips is handed back
  // exactly as found (auth.test.ts SUITE-ORDER ISOLATION precedent)
  const [settings] = await db.select().from(orgSettings).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  orgSettingsSnapshot = settings ?? null;
});

afterAll(async () => {
  // M-012: restore the singleton byte-identically (or remove it if this file
  // was what lazily created it — the loader recreates defaults on next read)
  if (orgSettingsSnapshot) {
    await db.update(orgSettings).set(orgSettingsSnapshot).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  } else {
    await db.delete(orgSettings);
  }
  app.server.closeAllConnections();
  await app.close();
});

describe("which already-issued credentials does a session-lifetime narrowing reach?", () => {
  const HOUR = 3600_000;

  it("a session issued under the wide ceiling outlives a later narrowing — the wall was stamped at issuance", async () => {
    // issued under the 24h default; prove the issuance stamp first
    const cookie = await loginWithKey();
    const issued = await latestSession();
    const issuedLifetimeMs = issued.expiresAt.getTime() - issued.createdAt.getTime();
    expect(issuedLifetimeMs).toBeGreaterThan(23 * HOUR); // the 24h default, minus clock skew
    expect((await me(cookie)).statusCode).toBe(200);

    // the org narrows the ceiling to 1h, and the standing session is made
    // OLDER than that new ceiling (createdAt backdated 2h; the stored walls
    // untouched — exactly the state a real narrowing leaves behind)
    await putOrg({ sessionLifetimeHours: 1 });
    await db
      .update(authSessions)
      .set({ createdAt: new Date(Date.now() - 2 * HOUR) })
      .where(eq(authSessions.id, issued.id));

    // EMPIRICAL SEAM ANSWER: the session is STILL ADMITTED. Resolve trusts
    // the issuance-stamped expires_at; the narrowed ceiling does not reach
    // already-issued sessions. (Contrast: an already-issued API KEY is
    // re-adjudicated on every use — cited in the header.) If this ever flips
    // to ceiling-at-use, this assertion fails and the finding graduates into
    // pinned-by-test semantics — update the header comment when it does.
    const stillAlive = await me(cookie);
    expect(stillAlive.statusCode).toBe(200);
    expect(stillAlive.json().userId).toBe(userId);
  });

  it("CONTROL (non-vacuity): a session issued AFTER the narrowing carries the 1h wall, not the 24h one", async () => {
    // the ceiling is still narrowed from the previous test (same describe)
    const cookie = await loginWithKey();
    const fresh = await latestSession();
    const freshLifetimeMs = fresh.expiresAt.getTime() - fresh.createdAt.getTime();
    // ~1h (± a minute of clock skew), nowhere near the 24h default — the knob
    // is live and binds every NEW session, so the previous test measured the
    // stored-wall semantics, not a dead setting
    expect(freshLifetimeMs).toBeGreaterThan(0.9 * HOUR);
    expect(freshLifetimeMs).toBeLessThan(1.1 * HOUR);
    expect((await me(cookie)).statusCode).toBe(200);

    // and the stamped wall is enforced: past it, the session is dead
    await db
      .update(authSessions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(authSessions.id, fresh.id));
    expect((await me(cookie)).statusCode).toBe(401);

    // restore the ceiling for any later suite sharing this DB run (the
    // afterAll snapshot also covers this; belt and braces per M-012)
    await putOrg({ sessionLifetimeHours: 24 });
  });
});
