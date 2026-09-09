/**
 * ADR-0109 / migration 0108 — PROOF THAT EACH NEW UNIQUE CONSTRAINT BITES.
 *
 * ADR-0107 deferred eleven unordered single-row reads because an `ORDER BY`
 * there would encode the wrong claim: it accommodates a duplicate where the
 * truth is that a second row is a bug the database should have refused.
 * Migration 0108 turns nine of those beliefs into constraints.
 *
 * **A constraint nobody proved is a comment.** So for every one of the nine,
 * this file writes the row the constraint forbids and asserts the database
 * refuses it.
 *
 * HOW THE ASSERTION IS MADE DISCRIMINATING (M-033)
 * ------------------------------------------------
 * The S9 trap is asserting a NEGATIVE that would pass on wrong data. "The
 * insert threw" is exactly that: a NOT-NULL violation, a CHECK violation, a
 * missing FK, or a typo'd column name all throw, and every one of them would
 * make a bogus fixture look like a working constraint. So `expectRefusedBy`
 * asserts BOTH:
 *
 *   * SQLSTATE **23505** — a unique violation specifically, not "something
 *     went wrong"; and
 *   * `error.constraint` equal to **the exact index name** — so a row refused
 *     by some OTHER unique index that happened to cover the same fixture
 *     (`users_email_unique`, `model_card_approvals_one_pending_uq`) fails the
 *     test rather than passing it.
 *
 * Each duplicate row is also deliberately DIFFERENT from its twin in every
 * column except the constrained key, so nothing but the key can be doing the
 * refusing.
 *
 * SHARED-DATABASE RULES
 * ---------------------
 * Every test file here shares one database. Fixtures are therefore suffixed
 * with a per-run token, nothing asserts an absolute row count or an empty
 * table, and the one index this file DROPS (for the non-vacuity probe below) is
 * restored in a `finally` and its restoration is asserted.
 */
import { beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  aiUseCases,
  aiVendors,
  agents,
  approvals,
  certInventory,
  createDb,
  grantCertificationCampaigns,
  grantCertificationItems,
  infraResources,
  modelCardApprovals,
  modelCards,
  runMigrations,
  sodOverrideRequests,
  sodRules,
  sql,
  traceSpans,
  traces,
  trainingDatasets,
  trainingJobs,
  users,
  workflowInstances,
  type Db,
} from "@regulait/db";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

/** per-run token — this file shares its database with 173 others */
const T = `duc${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

let db: Db;

/** ids created in `beforeAll` and reused by the nine cases */
const F = {
  userA: "",
  userB: "",
  approval1: "",
  approval2: "",
  campaign: "",
  card: "",
  agent: "",
  dataset: "",
  sodRule: "",
  instance: "",
  resource: "",
  trace: "",
  runId: "",
};

/**
 * Walk an error chain for a pg error's SQLSTATE and the constraint it names.
 * drizzle wraps the driver error, so neither is reliably on the top-level
 * object.
 */
function pgErrorOf(err: unknown): { code?: string; constraint?: string } {
  let cur: unknown = err;
  for (let i = 0; i < 6 && cur && typeof cur === "object"; i += 1) {
    const c = cur as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (typeof c.code === "string") {
      return { code: c.code, constraint: typeof c.constraint === "string" ? c.constraint : undefined };
    }
    cur = c.cause;
  }
  return {};
}

/**
 * Assert that `write` is refused by a UNIQUE VIOLATION raised by the NAMED
 * index — see the header on why both halves are load-bearing.
 */
async function expectRefusedBy(indexName: string, write: () => Promise<unknown>): Promise<void> {
  let thrown: unknown;
  try {
    await write();
  } catch (err) {
    thrown = err;
  }
  expect(thrown, `the duplicate write SUCCEEDED — ${indexName} does not bite`).toBeDefined();
  const { code, constraint } = pgErrorOf(thrown);
  // 23505 specifically: a CHECK (23514), NOT NULL (23502) or FK (23503)
  // failure would mean the fixture is wrong, not that the constraint works.
  expect(code, `expected SQLSTATE 23505 from ${indexName}, got ${code}`).toBe("23505");
  // and by THIS index, not by some other unique index over the same fixture.
  expect(constraint).toBe(indexName);
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);

  const [a] = await db
    .insert(users)
    .values({ email: `${T}-a@example.com`, displayName: `${T} A` })
    .returning({ id: users.id });
  const [b] = await db
    .insert(users)
    .values({ email: `${T}-b@example.com`, displayName: `${T} B` })
    .returning({ id: users.id });
  F.userA = a!.id;
  F.userB = b!.id;

  const [ap1] = await db
    .insert(approvals)
    .values({ userId: F.userA, approverUserId: F.userB })
    .returning({ id: approvals.id });
  const [ap2] = await db
    .insert(approvals)
    .values({ userId: F.userB, approverUserId: F.userA })
    .returning({ id: approvals.id });
  F.approval1 = ap1!.id;
  F.approval2 = ap2!.id;

  const [camp] = await db
    .insert(grantCertificationCampaigns)
    .values({
      name: `${T} campaign`,
      scopeKind: "all",
      openedByUserId: F.userA,
      dueAt: new Date(Date.now() + 86_400_000),
    })
    .returning({ id: grantCertificationCampaigns.id });
  F.campaign = camp!.id;

  const [ag] = await db
    .insert(agents)
    .values({ name: `${T}-agent`, provider: "mock", tier: 0 })
    .returning({ id: agents.id });
  F.agent = ag!.id;

  const [card] = await db
    .insert(modelCards)
    .values({ agentId: F.agent, intendedUse: `${T} intended use` })
    .returning({ id: modelCards.id });
  F.card = card!.id;

  const [ds] = await db
    .insert(trainingDatasets)
    .values({ name: `${T}-dataset` })
    .returning({ id: trainingDatasets.id });
  F.dataset = ds!.id;

  const [rule] = await db
    .insert(sodRules)
    .values({ name: `${T} rule`, reason: `${T} because` })
    .returning({ id: sodRules.id });
  F.sodRule = rule!.id;

  const [inst] = await db
    .insert(workflowInstances)
    .values({
      templateIds: [],
      definition: {},
      initiatorUserId: F.userA,
      change: {},
      state: {},
      status: "in_progress",
    })
    .returning({ id: workflowInstances.id });
  F.instance = inst!.id;

  const [res] = await db
    .insert(infraResources)
    .values({ kind: "host", name: `${T}-resource` })
    .returning({ id: infraResources.id });
  F.resource = res!.id;

  const [tr] = await db
    .insert(traces)
    .values({ kind: "run", name: `${T} trace`, userId: F.userA })
    .returning({ id: traces.id });
  F.trace = tr!.id;

  // `trace_spans.run_id` carries no FK — a plain uuid is a faithful fixture.
  F.runId = (await db.execute(sql`select gen_random_uuid() as id`) as unknown as {
    rows: Array<{ id: string }>;
  }).rows[0]!.id;
});

describe("ADR-0109 — every constraint migration 0108 adds actually refuses its duplicate", () => {
  it("grant_cert_items_approval_uq — one queue row decides ONE certification item", async () => {
    const base = {
      campaignId: F.campaign,
      grantKind: "agent" as const,
      grantId: F.agent,
      holderUserId: F.userA,
      holderLabel: `${T} holder`,
      objectLabel: `${T} object`,
      reviewerUserId: F.userB,
      approvalId: F.approval1,
    };
    await db.insert(grantCertificationItems).values(base);
    await expectRefusedBy("grant_cert_items_approval_uq", () =>
      // everything else differs: a different holder, a different label, a
      // different reviewer. Only `approval_id` repeats.
      db.insert(grantCertificationItems).values({
        ...base,
        grantKind: "connector",
        holderUserId: F.userB,
        holderLabel: `${T} other holder`,
        objectLabel: `${T} other object`,
        reviewerUserId: F.userA,
      }),
    );
    // and a DIFFERENT approval is still free — the constraint is on the key,
    // not on the table.
    await db
      .insert(grantCertificationItems)
      .values({ ...base, approvalId: F.approval2, holderLabel: `${T} second` });
    // ...as is a row with NO approval at all: the index is partial for exactly
    // this reason, and two un-queued items must stay legal.
    await db.insert(grantCertificationItems).values({ ...base, approvalId: null });
    await db.insert(grantCertificationItems).values({ ...base, approvalId: null });
  });

  it("model_card_approvals_approval_uq — one queue row decides ONE sign-off", async () => {
    const base = {
      cardId: F.card,
      approverUserId: F.userA,
      approvalId: F.approval1,
      // NOT 'pending': `model_card_approvals_one_pending_uq` is a second unique
      // index on (card_id) WHERE status='pending', and a pending fixture would
      // be refused by THAT one instead — which the constraint-name assertion
      // would catch, but the fixture should not need catching.
      status: "approved" as const,
    };
    await db.insert(modelCardApprovals).values(base);
    await expectRefusedBy("model_card_approvals_approval_uq", () =>
      db.insert(modelCardApprovals).values({ ...base, approverUserId: F.userB, status: "denied" }),
    );
  });

  it("training_jobs_approval_uq — one queue row gates ONE job", async () => {
    const base = {
      name: `${T}-job`,
      datasetId: F.dataset,
      datasetVersion: 1,
      backend: "mock" as const,
      method: "lora_sft" as const,
      approvalId: F.approval1,
    };
    await db.insert(trainingJobs).values(base);
    await expectRefusedBy("training_jobs_approval_uq", () =>
      db.insert(trainingJobs).values({
        ...base,
        name: `${T}-job-2`,
        backend: "local",
        method: "retrieval_index",
      }),
    );
    // NULL approval_id = under the cost threshold. Many of those are legal and
    // the partial index must not touch them.
    await db.insert(trainingJobs).values({ ...base, name: `${T}-free-1`, approvalId: null });
    await db.insert(trainingJobs).values({ ...base, name: `${T}-free-2`, approvalId: null });
  });

  it("sod_override_approval_uq — one queue row decides ONE override (and it MINTS)", async () => {
    const base = {
      ruleId: F.sodRule,
      mintKind: "agent" as const,
      mintPayload: { userId: F.userA, agentId: F.agent },
      conflictDetail: { rule: F.sodRule },
      label: `${T} override`,
      requestedByUserId: F.userA,
      approvalId: F.approval1,
    };
    await db.insert(sodOverrideRequests).values(base);
    await expectRefusedBy("sod_override_approval_uq", () =>
      db.insert(sodOverrideRequests).values({
        ...base,
        mintKind: "connector",
        mintPayload: { userId: F.userB, connectorId: F.agent },
        label: `${T} other override`,
        requestedByUserId: F.userB,
      }),
    );
  });

  it("ai_use_cases_instance_uq — one workflow instance governs ONE use case", async () => {
    const base = {
      name: `${T} use case`,
      description: `${T} description`,
      ownerUserId: F.userA,
      businessContext: `${T} context`,
      dataSensitivity: "internal" as const,
      workflowInstanceId: F.instance,
    };
    await db.insert(aiUseCases).values(base);
    await expectRefusedBy("ai_use_cases_instance_uq", () =>
      db.insert(aiUseCases).values({
        ...base,
        name: `${T} second use case`,
        ownerUserId: F.userB,
        dataSensitivity: "regulated",
      }),
    );
  });

  it("ai_vendors_instance_uq — one workflow instance governs ONE vendor", async () => {
    const base = {
      name: `${T} vendor`,
      description: `${T} description`,
      category: "model_provider" as const,
      ownerUserId: F.userA,
      workflowInstanceId: F.instance,
    };
    await db.insert(aiVendors).values(base);
    await expectRefusedBy("ai_vendors_instance_uq", () =>
      db.insert(aiVendors).values({
        ...base,
        name: `${T} second vendor`,
        category: "data_processor",
        ownerUserId: F.userB,
      }),
    );
  });

  it("cert_inventory_resource_cn_uq — one cert per (resource, common name), TOTAL", async () => {
    const cn = `${T}.example.com`;
    await db.insert(certInventory).values({
      resourceId: F.resource,
      commonName: cn,
      notAfter: new Date(Date.now() + 30 * 86_400_000),
      serial: "aaaa",
    });
    await expectRefusedBy("cert_inventory_resource_cn_uq", () =>
      db.insert(certInventory).values({
        resourceId: F.resource,
        commonName: cn,
        notAfter: new Date(Date.now() + 60 * 86_400_000),
        serial: "bbbb",
        status: "rotated",
      }),
    );
    // a different common name on the same resource is the normal case
    await db.insert(certInventory).values({
      resourceId: F.resource,
      commonName: `other-${cn}`,
      notAfter: new Date(Date.now() + 30 * 86_400_000),
    });
  });

  it("trace_spans_run_uq — ONE run span per (trace, run), and only for kind='run'", async () => {
    const base = {
      traceId: F.trace,
      kind: "run" as const,
      name: `${T} run span`,
      startedAt: new Date(),
      runId: F.runId,
    };
    await db.insert(traceSpans).values({ ...base, seq: 1 });
    await expectRefusedBy("trace_spans_run_uq", () =>
      db.insert(traceSpans).values({ ...base, seq: 2, name: `${T} duplicate run span` }),
    );

    // THE PARTIAL HALF, and the reconciliation with ADR-0107's fix #10. That
    // fix reads `(trace_id, kind='run')` with NO run id and orders by `seq`,
    // because a trace can carry more than one run span. This index must not
    // contradict it: a SECOND run span for a DIFFERENT run, in the same trace,
    // stays legal.
    const other = (await db.execute(sql`select gen_random_uuid() as id`) as unknown as {
      rows: Array<{ id: string }>;
    }).rows[0]!.id;
    await db.insert(traceSpans).values({ ...base, seq: 3, runId: other });

    // and non-run spans of the same run are entirely outside the index — that
    // is what a run's span tree IS.
    await db.insert(traceSpans).values({ ...base, kind: "run_node", seq: 4 });
    await db.insert(traceSpans).values({ ...base, kind: "run_node", seq: 5 });
  });

  it("users_email_lower_uq — two case-variants of one address can no longer both exist", async () => {
    const addr = `${T}-Case@Example.com`;
    await db.insert(users).values({ email: addr.toLowerCase(), displayName: `${T} lower` });
    await expectRefusedBy("users_email_lower_uq", () =>
      // NOT byte-equal, so `users_email_unique` (on `email` EXACTLY) does not
      // fire — which is the entire point of ADR-0107's finding. If this test
      // ever reports `users_email_unique` as the constraint, the fixture has
      // stopped exercising the case-variant.
      db.insert(users).values({ email: addr, displayName: `${T} upper` }),
    );
  });
});

/**
 * NON-VACUITY (M-002/M-033) — the probe every constraint claim owes.
 *
 * A green suite above proves the writes are refused. It does NOT prove the
 * refusal comes from migration 0108 rather than from something that was already
 * there. So one constraint is DROPPED IN PLACE — fixture, assertion and code
 * untouched, only the index removed — and the same duplicate is written again.
 * If it still fails, the assertion was measuring something else.
 *
 * `users_email_lower_uq` is the one chosen for the COMMITTED probe, because it
 * is the one ADR-0107 named as the real fix for a stopgap and the one with a
 * security-shaped consequence. It is restored in a `finally`, and the
 * restoration is asserted rather than assumed — this database is shared with
 * 173 other test files.
 *
 * MEASURED, AND WIDER THAN THE COMMITTED PROBE (ADR-0109). The probe was also
 * run once against ALL NINE indexes dropped on a freshly migrated database,
 * with this file otherwise untouched: **11 of 11 failed**, each on its own
 * `the duplicate write SUCCEEDED — <index> does not bite`, and the pre-flight
 * case on `grant_cert_items_approval_uq is reported by the pre-flight but does
 * not exist`. So every one of the nine is load-bearing here, not just the one
 * the committed probe re-proves on each run.
 */
describe("ADR-0109 — non-vacuity: the constraint, not the fixture, is doing the work", () => {
  it("with users_email_lower_uq dropped, the SAME duplicate insert succeeds", async () => {
    const addr = `${T}-Probe@Example.com`;
    await db.insert(users).values({ email: addr.toLowerCase(), displayName: `${T} probe lower` });

    // control: with the index in place it is refused (see the case above)
    await expectRefusedBy("users_email_lower_uq", () =>
      db.insert(users).values({ email: addr, displayName: `${T} probe upper` }),
    );

    let insertedId: string | null = null;
    try {
      await db.execute(sql`DROP INDEX users_email_lower_uq`);
      const [row] = await db
        .insert(users)
        .values({ email: addr, displayName: `${T} probe upper` })
        .returning({ id: users.id });
      insertedId = row!.id;
      // THE PROBE'S POINT: neutralised, the duplicate lands. Postgres really
      // was refusing it because of this index and nothing else.
      expect(insertedId).toBeTruthy();
      const dupes = (await db.execute(
        sql`select count(*)::int as n from users where lower(email) = ${addr.toLowerCase()}`,
      ) as unknown as { rows: Array<{ n: number }> }).rows[0]!.n;
      expect(dupes).toBe(2);
    } finally {
      // remove the row the probe created BEFORE restoring, or the restore
      // itself cannot succeed — which is also a nice demonstration of what an
      // operator upgrading a dirty deployment faces.
      if (insertedId) await db.execute(sql`delete from users where id = ${insertedId}::uuid`);
      await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_uq ON users (lower(email))`);
    }

    // restoration ASSERTED, not assumed — every later file shares this database
    const back = (await db.execute(
      sql`select count(*)::int as n from pg_indexes where indexname = 'users_email_lower_uq'`,
    ) as unknown as { rows: Array<{ n: number }> }).rows[0]!.n;
    expect(back).toBe(1);
    await expectRefusedBy("users_email_lower_uq", () =>
      db.insert(users).values({ email: addr, displayName: `${T} probe upper again` }),
    );
  });
});

/**
 * The pre-flight is the operator-facing half of ADR-0109, and it is only worth
 * shipping if it agrees with the database it is describing.
 */
describe("ADR-0109 — the pre-flight report", () => {
  it("covers exactly the nine enforced constraints plus the advisory one, and each check runs", async () => {
    const { DEFERRED_UNIQUE_CHECKS, runDeferredUniquePreflight, formatDeferredUniquePreflight } =
      await import("@regulait/db");
    const enforced = DEFERRED_UNIQUE_CHECKS.filter((c) => c.enforced);
    expect(enforced).toHaveLength(9);
    expect(DEFERRED_UNIQUE_CHECKS.filter((c) => !c.enforced).map((c) => c.table)).toEqual([
      "backup_runs",
    ]);

    // every enforced check names an index that really exists on this database —
    // this is what stops the report and the migration drifting apart.
    for (const c of enforced) {
      const n = (await db.execute(
        sql`select count(*)::int as n from pg_indexes where indexname = ${c.index!}`,
      ) as unknown as { rows: Array<{ n: number }> }).rows[0]!.n;
      expect(n, `${c.index} is reported by the pre-flight but does not exist`).toBe(1);
    }

    const report = await runDeferredUniquePreflight(db);
    // Every enforced check MUST be clean: the constraints are in place, so a
    // non-zero count here would mean the pre-flight's SQL disagrees with the
    // index it describes.
    expect(report.blocking).toEqual([]);
    expect(report.clean).toBe(true);
    expect(report.findings).toHaveLength(10);
    expect(formatDeferredUniquePreflight(report)).toContain("CLEAN");
  });
});
