/**
 * ADR-0234 batch 7a (PENDING S7): every path that used to run with no RLS scope now runs under a named reason.
 *
 * Batch 2 scoped authenticated requests as their principal. The paths with no principal (auth-exempt routes, the
 * bootstrap token, non-user credentials, scheduler jobs, boot tasks, timers, background work) still ran unscoped:
 * every row on a superuser login, zero rows on the non-superuser runtime login batch 7b introduces. These tests run
 * against a scratch database migrated to the head (including the pending batch 7a migration) and prove:
 *   - the closed registry: the new reasons are registered in SQL and TypeScript alike;
 *   - what each new reason may and may not reach, with no application filter (`public_ingest` is the narrowest);
 *   - the chain writer's RETURNING works under a reason that may append but not read the ledger;
 *   - the route classes: every auth-exempt route maps to a reason, and the narrow ones go where they should;
 *   - the gateway, scheduler and background-work wiring each run under the reason they declare.
 * #809 review: a non-user credential runs under `credential_request` (users read, ledger append, nothing else), never
 * `system_task`; `bootstrap_admin` is not a caller reason; every timer is wrapped or on a reasoned allow-list.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  approvals,
  auditLog,
  authMfaPending,
  createDb,
  currentRlsScope,
  eq,
  runAsBootstrapAdmin,
  runAsPrincipalStepIfScoped,
  runMigrations,
  runWithRlsPrincipal,
  runWithRlsPrincipalStep,
  runWithRlsSystem,
  RLS_NON_CALLER_REASONS,
  RLS_SYSTEM_REASONS,
  withinSystemReason,
  withSystemContext,
  sql,
  users,
  type Db,
} from "@regulait/db";
import { AUTH_EXEMPT_ROUTES, exemptRouteRlsReason, requestRlsScope } from "./route-classes.js";
import { SCIM_ROUTES } from "./scim.js";
import { runSchedulerJob, syncSchedulerJobs, toRegistry, type SchedulerJobDefinition } from "./scheduler.js";
import { drainBackgroundWork, scheduleBackgroundWork } from "./background-work.js";
import { dropScratchDatabase } from "./testing/scratch-db.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");
const SCRATCH_DB = `rls0234b7a_${process.pid}_${Date.now()}`;
const urlFor = (name: string) => {
  const u = new URL(DATABASE_URL);
  u.pathname = "/" + name;
  return u.toString();
};

let admin: Db;
let db: Db;
const ids = { alice: randomUUID(), bob: randomUUID(), aliceApproval: randomUUID(), bobApproval: randomUUID() };

async function pgError(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    const err = e as { message?: string; cause?: { message?: string } };
    return err.cause?.message ?? err.message ?? String(e);
  }
  return "(no error)";
}
const approvalIds = async () => (await db.select({ id: approvals.id }).from(approvals)).map((r) => r.id).sort();
const auditRow = (userId: string, ruleId: string) => ({
  userId,
  objectType: "project" as const,
  objectId: null,
  detail: { test: "rls0234b7a" },
  effect: "allow" as const,
  ruleId,
  ruleChain: [],
  reason: "ADR-0234 batch 7a test row",
});

beforeAll(async () => {
  admin = createDb(DATABASE_URL);
  await admin.execute(sql.raw(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`));
  await admin.execute(sql.raw(`CREATE DATABASE ${SCRATCH_DB}`));
  db = createDb(urlFor(SCRATCH_DB));
  await runMigrations(db, migrationsFolder);
  await db.insert(users).values([
    { id: ids.alice, email: `alice-${ids.alice}@rls.test`, displayName: "Alice" },
    { id: ids.bob, email: `bob-${ids.bob}@rls.test`, displayName: "Bob" },
  ]);
  await db.insert(approvals).values([
    { id: ids.aliceApproval, userId: ids.alice, approverUserId: ids.bob },
    { id: ids.bobApproval, userId: ids.bob, approverUserId: ids.bob },
  ]);
  await db.insert(auditLog).values(auditRow(ids.alice, "rls0234b7a-seed"));
}, 180_000);

afterAll(async () => {
  await db?.$client.end().catch(() => undefined);
  if (admin) {
    await dropScratchDatabase(admin, SCRATCH_DB);
    await admin.$client.end().catch(() => undefined);
  }
});

describe("the closed registry", () => {
  it("the batch 7a reasons are registered, and the SQL registry is exactly the TypeScript one", async () => {
    for (const r of ["system_task", "public_ingest", "bootstrap_admin", "credential_request"] as const) expect(RLS_SYSTEM_REASONS).toContain(r);
    const def = await db.execute<{ d: string }>(sql`select pg_catalog.pg_get_functiondef('public.regulait_rls_system_reason()'::regprocedure) as d`);
    const list = /ARRAY\[([^\]]*)\]/.exec(def.rows[0]!.d)![1]!;
    const sqlReasons = [...list.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
    expect(sqlReasons).toEqual([...RLS_SYSTEM_REASONS].sort());
  });

  it("bootstrap_admin is not a caller reason: every step helper refuses it before any SQL runs", async () => {
    expect(RLS_NON_CALLER_REASONS.has("bootstrap_admin")).toBe(true);
    const b = "bootstrap_admin" as never;
    expect(() => runWithRlsSystem(b, "test.lift", () => 1)).toThrow(/not a registered system reason/);
    expect(() => runWithRlsPrincipalStep({ userId: ids.alice }, b, "test.lift", () => 1)).toThrow(/not a registered system reason/);
    expect(() => runWithRlsPrincipal({ userId: ids.alice }, () => runAsPrincipalStepIfScoped(b, "test.lift", () => 1))).toThrow(
      /not a registered system reason/,
    );
    await expect(withSystemContext(db, b, "test.lift", async () => 1)).rejects.toThrow(/not a registered system reason/);
    await expect(db.transaction(async (tx) => withinSystemReason(tx, b, "test.lift", async () => 1))).rejects.toThrow(/not a registered system reason/);
  });
});

describe("what each new reason reaches, with no application filter", () => {
  it("public_ingest: reads users and appends audit (with RETURNING), and nothing in approvals or the ledger", async () => {
    await runWithRlsSystem("public_ingest", "test.public", async () => {
      expect((await db.select({ id: users.id }).from(users)).length).toBeGreaterThanOrEqual(2);
      expect(await approvalIds()).toEqual([]);
      expect(await db.select({ id: auditLog.id }).from(auditLog)).toEqual([]);
      const [row] = await db.insert(auditLog).values(auditRow(ids.alice, "rls0234b7a-public")).returning({ id: auditLog.id });
      expect(row?.id).toBeTruthy();
      expect(await db.update(users).set({ displayName: "x" }).where(eq(users.id, ids.alice)).returning({ id: users.id })).toEqual([]);
      expect(await pgError(db.insert(authMfaPending).values({ tokenHash: randomUUID(), userId: ids.alice, origin: "password", expiresAt: new Date(Date.now() + 60_000) }))).toMatch(/row-level security/);
    });
  });

  it("system_task: reads users, acts on every approval, reads and appends the ledger; never writes users or MFA", async () => {
    await runWithRlsSystem("system_task", "test.job", async () => {
      expect(await approvalIds()).toEqual([ids.aliceApproval, ids.bobApproval].sort());
      expect((await db.select({ id: auditLog.id }).from(auditLog)).length).toBeGreaterThan(0);
      const [row] = await db.insert(auditLog).values(auditRow(ids.bob, "rls0234b7a-job")).returning({ id: auditLog.id });
      expect(row?.id).toBeTruthy();
      const upd = await db.update(users).set({ displayName: "job" }).where(eq(users.id, ids.alice)).returning({ id: users.id });
      expect(upd).toEqual([]);
      expect(await pgError(db.insert(authMfaPending).values({ tokenHash: randomUUID(), userId: ids.alice, origin: "password", expiresAt: new Date(Date.now() + 60_000) }))).toMatch(/row-level security/);
      // the ledger stays append-only for the app role
      expect(await pgError(db.delete(auditLog).where(eq(auditLog.ruleId, "rls0234b7a-job")))).toMatch(/permission denied/);
    });
  });

  it("bootstrap_admin: admitted where an active admin is (every approval, the ledger), and the ledger stays append-only", async () => {
    await runAsBootstrapAdmin("test.bootstrap", async () => {
      expect(currentRlsScope()).toEqual({ kind: "system", reason: "bootstrap_admin", path: "test.bootstrap" });
      expect(await approvalIds()).toEqual([ids.aliceApproval, ids.bobApproval].sort());
      expect((await db.select({ id: auditLog.id }).from(auditLog)).length).toBeGreaterThan(0);
      expect(await pgError(db.delete(auditLog).where(eq(auditLog.ruleId, "rls0234b7a-seed")))).toMatch(/permission denied/);
      expect(await pgError(db.update(auditLog).set({ reason: "rewritten" }).where(eq(auditLog.ruleId, "rls0234b7a-seed")))).toMatch(/permission denied/);
      // an audit_verify step (the policy simulator's replay) keeps the admin-equivalent scope, users read included
      await db.transaction(async (tx) =>
        withinSystemReason(tx, "audit_verify", "test.replay", async () => {
          const r = await tx.execute<{ r: string }>(sql`select current_setting('regulait.system_context', true) as r`);
          expect(r.rows[0]?.r).toBe("bootstrap_admin");
          expect((await (tx as unknown as Db).select({ id: users.id }).from(users)).length).toBeGreaterThanOrEqual(2);
        }),
      );
    });
  });

  it("credential_request: reads users and appends audit (with RETURNING); no approval, no ledger read, no other subject", async () => {
    await runWithRlsSystem("credential_request", "test.credential", async () => {
      expect((await db.select({ id: users.id }).from(users)).length).toBeGreaterThanOrEqual(2);
      const [row] = await db.insert(auditLog).values(auditRow(ids.bob, "rls0234b7a-credential")).returning({ id: auditLog.id });
      expect(row?.id).toBeTruthy();
      // no subject's ledger rows, not even the row it just appended
      expect(await db.select({ id: auditLog.id }).from(auditLog)).toEqual([]);
      expect(await db.select({ id: auditLog.id }).from(auditLog).where(eq(auditLog.userId, ids.alice))).toEqual([]);
      // no approval: none visible, and none it can rewrite, delete or create
      expect(await approvalIds()).toEqual([]);
      expect(await db.update(approvals).set({ status: "approved" }).where(eq(approvals.id, ids.aliceApproval)).returning({ id: approvals.id })).toEqual([]);
      expect(await db.delete(approvals).where(eq(approvals.id, ids.bobApproval)).returning({ id: approvals.id })).toEqual([]);
      expect(await pgError(db.insert(approvals).values({ userId: ids.alice, approverUserId: ids.alice }))).toMatch(/row-level security/);
      expect(await db.update(users).set({ displayName: "x" }).where(eq(users.id, ids.alice)).returning({ id: users.id })).toEqual([]);
      // the one runner step that supersedes an approval enters approval_maintenance for that statement only
      await db.transaction(async (tx) => {
        const seen = await withinSystemReason(tx, "approval_maintenance", "test.supersede", async () =>
          (await (tx as unknown as Db).select({ id: approvals.id }).from(approvals)).length,
        );
        expect(seen).toBe(2);
        expect(await (tx as unknown as Db).select({ id: approvals.id }).from(approvals)).toEqual([]);
      });
    });
    expect(await approvalIds()).toEqual([ids.aliceApproval, ids.bobApproval].sort());
  });

  it("approval_maintenance (the signed PM and chat webhooks): approvals and users, and the ledger only by append", async () => {
    await runWithRlsSystem("approval_maintenance", "test.webhook", async () => {
      expect(await approvalIds()).toEqual([ids.aliceApproval, ids.bobApproval].sort());
      const [row] = await db.insert(auditLog).values(auditRow(ids.alice, "rls0234b7a-webhook")).returning({ id: auditLog.id });
      expect(row?.id).toBeTruthy();
      expect(await db.select({ id: auditLog.id }).from(auditLog)).toEqual([]);
    });
  });

  it("audit_verify no longer reads users (a principal already does; bootstrap keeps its own scope)", async () => {
    await runWithRlsSystem("audit_verify", "test.verify", async () => {
      expect((await db.select({ id: auditLog.id }).from(auditLog)).length).toBeGreaterThan(0);
      expect(await db.select({ id: users.id }).from(users)).toEqual([]);
    });
  });

  it("an append-only reason (authenticate) can RETURNING its own audit row; the reason is restored after the INSERT", async () => {
    await runWithRlsSystem("authenticate", "test.sign-in", async () => {
      await db.transaction(async (tx) => {
        const [row] = await (tx as unknown as Db).insert(auditLog).values(auditRow(ids.alice, "rls0234b7a-auth")).returning({ id: auditLog.id });
        expect(row?.id).toBeTruthy();
        const r = await tx.execute<{ r: string }>(sql`select current_setting('regulait.system_context', true) as r`);
        expect(r.rows[0]?.r).toBe("authenticate");
        // and still no ledger read under authenticate
        expect(await (tx as unknown as Db).select({ id: auditLog.id }).from(auditLog)).toEqual([]);
      });
    });
  });
});

describe("the route classes", () => {
  it("every auth-exempt route maps to a reason a no-principal request may hold", () => {
    const allowed = new Set(["authenticate", "identity_provisioning", "approval_maintenance", "public_ingest"]);
    for (const url of AUTH_EXEMPT_ROUTES) expect(allowed.has(exemptRouteRlsReason(url))).toBe(true);
  });

  it("sign-in, provisioning and approval callbacks get their reason; everything else gets the narrowest", () => {
    expect(exemptRouteRlsReason("/auth/login")).toBe("authenticate");
    expect(exemptRouteRlsReason("/auth/mfa/verify")).toBe("authenticate");
    expect(exemptRouteRlsReason("/auth/oidc/callback")).toBe("identity_provisioning");
    expect(exemptRouteRlsReason("/auth/saml/:providerId/acs")).toBe("identity_provisioning");
    for (const url of SCIM_ROUTES) expect(exemptRouteRlsReason(url)).toBe("identity_provisioning");
    expect(exemptRouteRlsReason("/v1/pm/webhooks/:connectionName")).toBe("approval_maintenance");
    expect(exemptRouteRlsReason("/v1/chatops/:connectionName/interactions")).toBe("approval_maintenance");
    expect(exemptRouteRlsReason("/v1/chatops/:connectionName/events")).toBe("public_ingest");
    expect(exemptRouteRlsReason("/health")).toBe("public_ingest");
  });
});

describe("the request scope (the gateway's preHandler mapping)", () => {
  const VIAS_WITHOUT_USER = ["engine-runner", "engine-enrollment", "pdp", "endpoint-agent"] as const;
  it("each non-user credential gets credential_request, never system_task or bootstrap_admin", () => {
    for (const via of VIAS_WITHOUT_USER) {
      expect(requestRlsScope({ userId: null, isAdmin: false, via }, "/v1/engine-runner/lease")).toEqual({ kind: "credential", via });
    }
    expect(requestRlsScope({ userId: null, isAdmin: true, via: "bootstrap" }, "/v1/users")).toEqual({ kind: "bootstrap" });
    expect(requestRlsScope(undefined, "/v1/users")).toEqual({ kind: "none" });
  });

  it("a user principal never lands in a system scope, whatever the route or the admin flag", () => {
    const vias = ["api-key", "session", "virtual-key", "workload", "bootstrap", ...VIAS_WITHOUT_USER];
    for (const via of vias) {
      for (const isAdmin of [false, true]) {
        for (const url of ["/v1/users", "/health", "/auth/login", "/v1/pm/webhooks/:connectionName"]) {
          expect(requestRlsScope({ userId: ids.alice, isAdmin, via }, url)).toEqual({ kind: "principal", userId: ids.alice });
        }
      }
    }
  });

  it("an auth-exempt route resolves before the credential branches", () => {
    expect(requestRlsScope({ userId: null, isAdmin: true, via: "bootstrap" }, "/health")).toEqual({ kind: "exempt", reason: "public_ingest" });
    expect(requestRlsScope({ userId: null, isAdmin: false, via: "endpoint-agent" }, "/health")).toEqual({ kind: "exempt", reason: "public_ingest" });
  });
});

describe("the census: what may still run with no scope, or outside a request's", () => {
  const src = path.dirname(fileURLToPath(import.meta.url));
  const sources = readdirSync(src)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.endsWith(".d.ts"))
    .map((f) => ({ f, text: readFileSync(path.join(src, f), "utf8") }));

  it("every setInterval is wrapped in a scope or on this allow-list, with its reason", () => {
    // file -> the intervals in it that run with no scope of their own, and why that is safe
    const ALLOWED: Record<string, { count: number; why: string }> = {
      "scheduler.ts": { count: 1, why: "the tick runs each job through runSchedulerJob, which enters system_task" },
      "boot.ts": { count: 2, why: "rate-limit counter and PM delivery prunes touch no RLS table" },
      "org-settings.ts": { count: 1, why: "the audit prune runs on the owner connection (runAuditPruneOnce)" },
    };
    const found: Record<string, number> = {};
    for (const { f, text } of sources) {
      const lines = text.split("\n");
      lines.forEach((line, i) => {
        if (!/\bsetInterval\(/.test(line)) return;
        const window = lines.slice(i, i + 8).join("\n");
        if (/runWithRls(System|Principal)\(/.test(window)) return;
        found[f] = (found[f] ?? 0) + 1;
      });
    }
    expect(found).toEqual(Object.fromEntries(Object.entries(ALLOWED).map(([f, v]) => [f, v.count])));
  });

  it("runWithoutRlsScope is called only by the scope hook and the audit prune", () => {
    const callers = sources.filter(({ text }) => /\brunWithoutRlsScope\(/.test(text)).map(({ f }) => f).sort();
    expect(callers).toEqual(["app.ts", "org-settings.ts"]);
    for (const f of callers) {
      const n = (sources.find((x) => x.f === f)!.text.match(/\brunWithoutRlsScope\(/g) ?? []).length;
      expect(n).toBe(1);
    }
  });

  it("scheduleBackgroundWork and boot tasks enter system_task themselves", () => {
    expect(sources.find((x) => x.f === "background-work.ts")!.text).toMatch(/runWithRlsSystem\("system_task"/);
    expect(sources.find((x) => x.f === "boot.ts")!.text).toMatch(/asBootTask/);
  });

  it("only the gateway's scope hook enters bootstrap_admin", () => {
    const callers = sources.filter(({ text }) => /\brunAsBootstrapAdmin\(/.test(text)).map(({ f }) => f);
    expect(callers).toEqual(["app.ts"]);
  });
});

describe("the scheduler and background work run under system_task", () => {
  it("a scheduler job (tick or run-now) runs as system_task and sees what a job must", async () => {
    const seen: Array<{ scope: unknown; approvals: string[] }> = [];
    const def: SchedulerJobDefinition = {
      name: "rls0234b7a-probe",
      description: "ADR-0234 batch 7a probe",
      adr: "ADR-0234",
      defaultIntervalSeconds: 3600,
      run: async ({ db: d }) => {
        seen.push({ scope: currentRlsScope() ?? null, approvals: (await d.select({ id: approvals.id }).from(approvals)).map((r) => r.id).sort() });
        return { itemsProcessed: 1 };
      },
    };
    await syncSchedulerJobs(db, toRegistry([def]));
    const out = await runSchedulerJob(db, def, { instanceId: "rls0234b7a", trigger: "manual", ignoreDue: true, ignoreEnabled: true });
    expect(out).toMatchObject({ outcome: "ok" });
    expect(seen).toEqual([
      { scope: { kind: "system", reason: "system_task", path: "scheduler.rls0234b7a-probe" }, approvals: [ids.aliceApproval, ids.bobApproval].sort() },
    ]);
  });

  it("background work leaves the request's principal and runs as system_task", async () => {
    let scope: unknown = "unset";
    await runWithRlsSystem("authenticate", "test.request", async () => {
      scheduleBackgroundWork(db, async () => {
        scope = currentRlsScope() ?? null;
      });
    });
    await drainBackgroundWork(db);
    expect(scope).toEqual({ kind: "system", reason: "system_task", path: "background-work" });
  });
});
