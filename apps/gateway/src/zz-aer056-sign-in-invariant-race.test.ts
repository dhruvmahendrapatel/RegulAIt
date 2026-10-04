/**
 * AER-056 — concurrent administrative writes cannot remove the last recovery
 * path (ADR-0174 break-glass, amendment "concurrency").
 *
 * The sequential guards (adr0174-enterprise-sign-in.test.ts, finding 5) prove
 * each writer refuses the LAST admin / provider. They cannot see two writers
 * that each count "one would remain" before either writes. Here every race is
 * driven by TWO apps on TWO separate connection pools (two gateway replicas)
 * and a barrier inside the writers (`signInInvariantTestHooks.checked`, which
 * fires after a writer's check and before its first write):
 *
 *   - the first writer to pass its check parks at the barrier;
 *   - it is released when the second writer ALSO reaches the barrier (no
 *     serialization: both checks ran before either write — the race), or when
 *     Postgres shows the second writer WAITING on the sign-in invariant
 *     advisory lock (serialization: it will re-read after the first commits).
 *
 * Each test asserts the invariant (a usable break-glass admin and an enabled
 * SSO provider remain), that the loser got the NAMED refusal, that audit rows
 * and state agree, and that the barrier saw the second writer blocked on the
 * lock. With the lock removed from `withSignInInvariant` each race test fails
 * (both writers arrive, both commit); with the transaction removed the
 * injected-failure tests fail too (a mutation without its audit row).
 *
 * Shared-database hygiene (M-040/M-042): users and providers are run-unique;
 * provider counts are global, so the provider tests disable every OTHER
 * enabled provider for their duration and re-enable exactly those in
 * `finally`; the sign-in fields of the org_settings singleton are snapshotted
 * and restored; the SCIM licence is installed and removed like scim.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  and,
  auditLog,
  createDb,
  eq,
  gte,
  inArray,
  oidcProviders,
  ORG_SETTINGS_ID,
  orgSettings,
  samlProviders,
  sql,
  users,
  type Db,
  type OrgSettingsRow,
} from "@regulait/db";
import { buildApp } from "./app.js";
import {
  SIGN_IN_INVARIANT_LOCK_KEY,
  signInInvariantTestHooks,
  usableBreakGlassAdmins,
  type SignInInvariantSite,
} from "./break-glass.js";
import { countEnabledSsoProviders } from "./sso-providers.js";
import { installLicenseFixture, removeLicenseFixture } from "./testing/license-fixture.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const BOOT = "aer056-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const SCIM_JSON = { "content-type": "application/scim+json" };
const tag = randomBytes(4).toString("hex");

/** replica A, replica B, and a third pool that only watches pg_locks */
let dbA: Db;
let dbB: Db;
let watch: Db;
let appA: ReturnType<typeof buildApp>;
let appB: ReturnType<typeof buildApp>;
let orgSnapshot: Pick<OrgSettingsRow, "localSignIn" | "breakGlassUserIds" | "ssoOnly"> | null = null;
const createdOidc: string[] = [];
const createdSaml: string[] = [];

// ---------------------------------------------------------------------------
// the barrier
// ---------------------------------------------------------------------------

type Outcome = "both-arrived" | "second-blocked-on-lock" | "timed-out";

/** sessions in THIS database waiting (not granted) on the invariant lock */
async function waitersOnInvariantLock(): Promise<number> {
  const hi = Math.floor(SIGN_IN_INVARIANT_LOCK_KEY / 2 ** 32);
  const lo = SIGN_IN_INVARIANT_LOCK_KEY % 2 ** 32;
  const res = await watch.execute(sql`
    select count(*)::int as n from pg_locks
     where locktype = 'advisory' and not granted
       and classid = ${hi} and objid = ${lo} and objsubid = 1
       and database = (select oid from pg_database where datname = current_database())`);
  return (res.rows[0] as { n: number }).n;
}

function raceBarrier() {
  const arrivals: SignInInvariantSite[] = [];
  let outcome: Outcome | null = null;
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  const finish = (o: Outcome) => {
    if (outcome === null) {
      outcome = o;
      open();
    }
  };
  const checked = async (site: SignInInvariantSite): Promise<void> => {
    arrivals.push(site);
    if (arrivals.length >= 2) {
      finish("both-arrived");
      return gate;
    }
    const deadline = Date.now() + 8_000;
    while (outcome === null) {
      if ((await waitersOnInvariantLock()) > 0) finish("second-blocked-on-lock");
      else if (Date.now() > deadline) finish("timed-out");
      else await new Promise((r) => setTimeout(r, 10));
    }
    return gate;
  };
  return { checked, arrivals, outcome: () => outcome };
}

type Res = Awaited<ReturnType<typeof appA.inject>>;

/** fire both writers at once, held at the barrier described above */
async function race(first: () => Promise<Res>, second: () => Promise<Res>) {
  const barrier = raceBarrier();
  signInInvariantTestHooks.checked = barrier.checked;
  try {
    const results = await Promise.all([first(), second()]);
    return { results, outcome: barrier.outcome(), arrivals: barrier.arrivals };
  } finally {
    delete signInInvariantTestHooks.checked;
  }
}

/** exactly one writer succeeded; returns [winnerIndex, loser] */
function oneWinner(results: Res[], okStatus = 200): { winner: 0 | 1; loser: Res } {
  const ok = results.map((r) => r.statusCode === okStatus || r.statusCode === 204);
  expect(ok.filter(Boolean), results.map((r) => `${r.statusCode} ${r.body}`).join(" | ")).toHaveLength(1);
  const winner = ok[0] ? 0 : 1;
  return { winner, loser: results[1 - winner]! };
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

let seq = 0;
/** a run-unique admin; with a (one-time) password it is a USABLE break-glass candidate */
async function mkAdmin(label: string, withPassword: boolean): Promise<string> {
  const email = `aer056-${label}-${tag}-${++seq}@example.test`;
  const r = await appA.inject({ method: "POST", url: "/v1/users", headers: AUTH, payload: { email, displayName: `AER-056 ${label}`, isAdmin: true } });
  expect(r.statusCode, r.body).toBe(201);
  const id = r.json().id as string;
  if (withPassword) {
    const p = await appA.inject({ method: "POST", url: `/v1/users/${id}/set-initial-password`, headers: AUTH, payload: {} });
    expect(p.statusCode, p.body).toBe(200);
  }
  return id;
}

async function mkOidc(): Promise<{ id: string; name: string }> {
  const name = `aer056-oidc-${tag}-${++seq}`;
  const [row] = await dbA
    .insert(oidcProviders)
    .values({ name, issuerUrl: "https://idp.aer056.example", clientId: "aer056", clientSecretCiphertext: "not-a-real-secret", enabled: true })
    .returning({ id: oidcProviders.id });
  createdOidc.push(row!.id);
  return { id: row!.id, name };
}

async function mkSaml(): Promise<{ id: string; name: string }> {
  const name = `aer056-saml-${tag}-${++seq}`;
  const [row] = await dbA
    .insert(samlProviders)
    .values({ name, entityId: `https://idp.aer056.example/${name}`, idpSsoUrl: "https://idp.aer056.example/sso", idpSigningCerts: [], enabled: true })
    .returning({ id: samlProviders.id });
  createdSaml.push(row!.id);
  return { id: row!.id, name };
}

/** disable every enabled provider that is NOT one of `keep`; returns the undo */
async function isolateProviders(keep: string[]): Promise<() => Promise<void>> {
  const otherOidc = (await dbA.select({ id: oidcProviders.id }).from(oidcProviders).where(eq(oidcProviders.enabled, true)))
    .map((r) => r.id)
    .filter((id) => !keep.includes(id));
  const otherSaml = (await dbA.select({ id: samlProviders.id }).from(samlProviders).where(eq(samlProviders.enabled, true)))
    .map((r) => r.id)
    .filter((id) => !keep.includes(id));
  if (otherOidc.length) await dbA.update(oidcProviders).set({ enabled: false }).where(inArray(oidcProviders.id, otherOidc));
  if (otherSaml.length) await dbA.update(samlProviders).set({ enabled: false }).where(inArray(samlProviders.id, otherSaml));
  return async () => {
    if (otherOidc.length) await dbA.update(oidcProviders).set({ enabled: true }).where(inArray(oidcProviders.id, otherOidc));
    if (otherSaml.length) await dbA.update(samlProviders).set({ enabled: true }).where(inArray(samlProviders.id, otherSaml));
  };
}

const readOrg = async (): Promise<OrgSettingsRow> => {
  const [row] = await dbA.select().from(orgSettings).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  return row!;
};
const restoreOrg = async () => {
  if (orgSnapshot) await dbA.update(orgSettings).set(orgSnapshot).where(eq(orgSettings.id, ORG_SETTINGS_ID));
};
/** engage break-glass through the real writer (it needs an enabled SSO provider) */
async function engage(ids: string[]): Promise<void> {
  const r = await appA.inject({ method: "PUT", url: "/v1/org/settings", headers: AUTH, payload: { localSignIn: "break_glass_only", breakGlassUserIds: ids } });
  expect(r.statusCode, r.body).toBe(200);
}

const userRow = async (id: string) => (await dbA.select().from(users).where(eq(users.id, id)))[0]!;
/** audit rows of `ruleId` written since `since`, optionally about one object */
const auditSince = (since: Date, ruleId: string, objectId?: string) =>
  dbA
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.ruleId, ruleId), gte(auditLog.at, since), ...(objectId ? [eq(auditLog.objectId, objectId)] : [])));
const auditNamed = async (since: Date, ruleId: string, name: string) =>
  (await auditSince(since, ruleId)).filter((r) => (r.detail as { name?: string } | null)?.name === name);

beforeAll(async () => {
  const { runMigrations } = await import("@regulait/db");
  dbA = createDb(DATABASE_URL);
  dbB = createDb(DATABASE_URL);
  watch = createDb(DATABASE_URL);
  await runMigrations(dbA, migrationsFolder);
  appA = buildApp(dbA, { bootstrapToken: BOOT });
  appB = buildApp(dbB, { bootstrapToken: BOOT });
  const org = await readOrg();
  orgSnapshot = { localSignIn: org.localSignIn, breakGlassUserIds: org.breakGlassUserIds, ssoOnly: org.ssoOnly };
  // one enabled SSO door of our own for the user races (engage needs one)
  await mkOidc();
  // a password-less admin: keeps ADR-0022's "last active admin" guard out of
  // the way, so the refusal under test is the break-glass one
  await mkAdmin("spare", false);
}, 120_000);

afterAll(async () => {
  try {
    delete signInInvariantTestHooks.checked;
    delete signInInvariantTestHooks.written;
    await restoreOrg();
    if (createdOidc.length) await dbA.delete(oidcProviders).where(inArray(oidcProviders.id, createdOidc));
    if (createdSaml.length) await dbA.delete(samlProviders).where(inArray(samlProviders.id, createdSaml));
  } finally {
    await appA.close();
    await appB.close();
    await dbA.$client.end();
    await dbB.$client.end();
    await watch.$client.end();
  }
});

// ===========================================================================
describe("AER-056: the spare key — two usable break-glass admins removed at once", () => {
  const demote = (app: typeof appA, id: string) => () =>
    app.inject({ method: "POST", url: `/v1/users/${id}/admin`, headers: AUTH, payload: { isAdmin: false } });
  const deactivate = (app: typeof appA, id: string) => () =>
    app.inject({ method: "POST", url: `/v1/users/${id}/deactivate`, headers: AUTH, payload: {} });

  it.each([
    ["demote + demote", "demote", "demote"],
    ["deactivate + demote", "deactivate", "demote"],
    ["deactivate + deactivate", "deactivate", "deactivate"],
  ] as const)("%s: one wins, the other gets break_glass_last_admin, and one usable admin remains", async (_label, kindA, kindB) => {
    const a = await mkAdmin("a", true);
    const b = await mkAdmin("b", true);
    await engage([a, b]);
    try {
      const since = new Date();
      const act = (kind: "demote" | "deactivate", app: typeof appA, id: string) => (kind === "demote" ? demote(app, id) : deactivate(app, id));
      const { results, outcome } = await race(act(kindA, appA, a), act(kindB, appB, b));
      const { winner, loser } = oneWinner(results);
      expect(loser.statusCode).toBe(409);
      expect(loser.json().error).toBe("break_glass_last_admin");
      expect(outcome).toBe("second-blocked-on-lock");

      // the invariant
      const org = await readOrg();
      expect(org.localSignIn).toBe("break_glass_only");
      expect(await usableBreakGlassAdmins(dbA, org.breakGlassUserIds)).toBe(1);

      // state and audit agree, per user
      const kinds = [kindA, kindB];
      for (const [i, id] of [a, b].entries()) {
        const row = await userRow(id);
        const removed = kinds[i] === "demote" ? !row.isAdmin : row.disabledAt !== null;
        const rule = kinds[i] === "demote" ? "user-demoted-admin" : "user-deactivated";
        expect(removed, `user ${i}`).toBe(i === winner);
        expect(await auditSince(since, rule, id), `audit for user ${i}`).toHaveLength(i === winner ? 1 : 0);
        // a demoted admin leaves the list in the SAME transaction; the loser keeps its place
        if (kinds[i] === "demote" && i === winner) expect(org.breakGlassUserIds ?? []).not.toContain(id);
        else expect(org.breakGlassUserIds ?? []).toContain(id);
      }
    } finally {
      await restoreOrg();
    }
  });
});

// ===========================================================================
describe("AER-056: the front door — OIDC and SAML removed at once", () => {
  const oidcDisable = (app: typeof appA, id: string) => () =>
    app.inject({ method: "PATCH", url: `/v1/auth/oidc-providers/${id}`, headers: AUTH, payload: { enabled: false } });
  const oidcDelete = (app: typeof appA, id: string) => () =>
    app.inject({ method: "DELETE", url: `/v1/auth/oidc-providers/${id}`, headers: AUTH });
  const samlDisable = (app: typeof appA, id: string) => () =>
    app.inject({ method: "PATCH", url: `/v1/auth/saml-providers/${id}`, headers: AUTH, payload: { enabled: false } });
  const samlDelete = (app: typeof appA, id: string) => () =>
    app.inject({ method: "DELETE", url: `/v1/auth/saml-providers/${id}`, headers: AUTH });

  it.each([
    ["OIDC disable + SAML delete", "disable", "delete"],
    ["OIDC delete + SAML disable", "delete", "disable"],
  ] as const)("%s: one wins, the other gets break_glass_last_sso_provider, and one provider stays enabled", async (_label, oidcKind, samlKind) => {
    const oidc = await mkOidc();
    const saml = await mkSaml();
    const undo = await isolateProviders([oidc.id, saml.id]);
    const glass = await mkAdmin("door", true);
    try {
      await engage([glass]);
      const since = new Date();
      const { results, outcome } = await race(
        oidcKind === "disable" ? oidcDisable(appA, oidc.id) : oidcDelete(appA, oidc.id),
        samlKind === "disable" ? samlDisable(appB, saml.id) : samlDelete(appB, saml.id),
      );
      const { winner, loser } = oneWinner(results);
      expect(loser.statusCode).toBe(409);
      expect(loser.json().error).toBe("break_glass_last_sso_provider");
      expect(outcome).toBe("second-blocked-on-lock");

      // the invariant: exactly our one surviving provider is enabled
      expect((await countEnabledSsoProviders(dbA)).total).toBe(1);

      // state and audit agree, per provider
      const [o] = await dbA.select().from(oidcProviders).where(eq(oidcProviders.id, oidc.id));
      const [s] = await dbA.select().from(samlProviders).where(eq(samlProviders.id, saml.id));
      const oidcGone = oidcKind === "disable" ? o?.enabled === false : o === undefined;
      const samlGone = samlKind === "disable" ? s?.enabled === false : s === undefined;
      expect([oidcGone, samlGone]).toEqual([winner === 0, winner === 1]);
      const oidcAudit = await auditNamed(since, oidcKind === "disable" ? "oidc-provider-updated" : "oidc-provider-deleted", oidc.name);
      const samlAudit = await auditNamed(since, samlKind === "disable" ? "saml-provider-updated" : "saml-provider-deleted", saml.name);
      expect([oidcAudit.length, samlAudit.length]).toEqual([oidcGone ? 1 : 0, samlGone ? 1 : 0]);
    } finally {
      await restoreOrg();
      await undo();
    }
  });
});

// ===========================================================================
describe("AER-056: a SCIM connector and the admin API at once", () => {
  let token = "";
  beforeAll(async () => {
    await installLicenseFixture(appA, { features: ["scim_provisioning"], auth: AUTH });
    const issued = await appA.inject({ method: "POST", url: "/v1/scim/tokens", headers: AUTH, payload: { name: `aer056-${tag}` } });
    expect(issued.statusCode, issued.body).toBe(201);
    token = issued.json().token as string;
  });
  afterAll(async () => {
    await removeLicenseFixture(dbA);
  });

  it("SCIM active:false and an admin demotion of the two spare keys: one wins, the other is refused by name", async () => {
    const a = await mkAdmin("scim-a", true);
    const b = await mkAdmin("scim-b", true);
    await engage([a, b]);
    try {
      const since = new Date();
      const { results, outcome } = await race(
        () =>
          appA.inject({
            method: "PATCH",
            url: `/scim/v2/Users/${a}`,
            headers: { authorization: `Bearer ${token}`, ...SCIM_JSON },
            payload: { schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"], Operations: [{ op: "replace", path: "active", value: false }] },
          }),
        () => appB.inject({ method: "POST", url: `/v1/users/${b}/admin`, headers: AUTH, payload: { isAdmin: false } }),
      );
      const { winner, loser } = oneWinner(results);
      expect(loser.statusCode).toBe(409);
      // SCIM answers in its own error shape; the admin API with the named body
      if (winner === 1) expect(loser.json().detail).toMatch(/^break_glass_last_admin: /);
      else expect(loser.json().error).toBe("break_glass_last_admin");
      expect(outcome).toBe("second-blocked-on-lock");

      const org = await readOrg();
      expect(await usableBreakGlassAdmins(dbA, org.breakGlassUserIds)).toBe(1);
      const ra = await userRow(a);
      const rb = await userRow(b);
      expect([ra.disabledAt !== null, !rb.isAdmin]).toEqual([winner === 0, winner === 1]);
      expect((await auditSince(since, "scim-user-deactivated", a)).length).toBe(winner === 0 ? 1 : 0);
      expect((await auditSince(since, "user-demoted-admin", b)).length).toBe(winner === 1 ? 1 : 0);
    } finally {
      await restoreOrg();
    }
  });
});

// ===========================================================================
describe("AER-056: engaging break-glass while the last provider is removed", () => {
  it("never ends with the mode engaged and no enabled provider; the loser gets a named refusal", async () => {
    const oidc = await mkOidc();
    const undo = await isolateProviders([oidc.id]);
    const glass = await mkAdmin("mode", true);
    try {
      await dbA.update(orgSettings).set({ localSignIn: "enabled", breakGlassUserIds: null, ssoOnly: false }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
      const since = new Date();
      const { results, outcome } = await race(
        () => appA.inject({ method: "PUT", url: "/v1/org/settings", headers: AUTH, payload: { localSignIn: "break_glass_only", breakGlassUserIds: [glass] } }),
        () => appB.inject({ method: "PATCH", url: `/v1/auth/oidc-providers/${oidc.id}`, headers: AUTH, payload: { enabled: false } }),
      );
      const { winner, loser } = oneWinner(results);
      expect(outcome).toBe("second-blocked-on-lock");
      if (winner === 0) {
        // the mode engaged first: the provider is now the last door
        expect(loser.statusCode).toBe(409);
        expect(loser.json().error).toBe("break_glass_last_sso_provider");
      } else {
        // the provider went first: there is no door to engage behind
        expect(loser.statusCode).toBe(422);
        expect(loser.json().error).toBe("break_glass_needs_sso_provider");
      }

      const org = await readOrg();
      const enabled = (await countEnabledSsoProviders(dbA)).total;
      expect(org.localSignIn === "break_glass_only" && enabled === 0, "mode engaged with no SSO provider").toBe(false);
      // state and audit agree
      const engagedAudit = (await auditSince(since, "org-settings-updated")).filter(
        (r) => (r.detail as { changed?: Record<string, unknown> } | null)?.changed?.localSignIn === "break_glass_only",
      );
      expect(engagedAudit.length).toBe(org.localSignIn === "break_glass_only" ? 1 : 0);
      expect((await auditNamed(since, "oidc-provider-updated", oidc.name)).length).toBe(enabled === 0 ? 1 : 0);
      expect([org.localSignIn === "break_glass_only", enabled === 0]).toEqual([winner === 0, winner === 1]);
    } finally {
      await restoreOrg();
      await undo();
    }
  });
});

// ===========================================================================
describe("AER-056: a failed write leaves state, audit and the lock as they were", () => {
  it("a demotion whose audit write fails rolls back the flag AND the list clean-up, and releases the lock", async () => {
    const a = await mkAdmin("fail-a", true);
    const b = await mkAdmin("fail-b", true);
    await engage([a, b]);
    try {
      const since = new Date();
      signInInvariantTestHooks.written = async (site) => {
        if (site === "user-demote") throw new Error("AER-056 injected failure between the write and its audit row");
      };
      let failed: Res;
      try {
        failed = await appA.inject({ method: "POST", url: `/v1/users/${a}/admin`, headers: AUTH, payload: { isAdmin: false } });
      } finally {
        delete signInInvariantTestHooks.written;
      }
      expect(failed.statusCode).toBe(500);
      expect((await userRow(a)).isAdmin).toBe(true);
      expect((await readOrg()).breakGlassUserIds ?? []).toContain(a);
      expect(await auditSince(since, "user-demoted-admin", a)).toHaveLength(0);

      // the lock went with the transaction: the next writer is not stuck behind it
      const again = await appB.inject({ method: "POST", url: `/v1/users/${a}/admin`, headers: AUTH, payload: { isAdmin: false } });
      expect(again.statusCode, again.body).toBe(200);
      expect(await auditSince(since, "user-demoted-admin", a)).toHaveLength(1);
      expect((await readOrg()).breakGlassUserIds ?? []).not.toContain(a);
    } finally {
      delete signInInvariantTestHooks.written;
      await restoreOrg();
    }
  });

  it("a provider delete whose audit write fails keeps the provider and writes no audit row", async () => {
    const saml = await mkSaml();
    const since = new Date();
    signInInvariantTestHooks.written = async (site) => {
      if (site === "saml-provider-delete") throw new Error("AER-056 injected failure between the delete and its audit row");
    };
    let failed: Res;
    try {
      failed = await appA.inject({ method: "DELETE", url: `/v1/auth/saml-providers/${saml.id}`, headers: AUTH });
    } finally {
      delete signInInvariantTestHooks.written;
    }
    expect(failed.statusCode).toBe(500);
    expect(await dbA.select({ id: samlProviders.id }).from(samlProviders).where(eq(samlProviders.id, saml.id))).toHaveLength(1);
    expect(await auditNamed(since, "saml-provider-deleted", saml.name)).toHaveLength(0);
  });
});
