/**
 * AER-035 — ONE CONSENT IS SPENT ONCE, EVEN BY TWENTY SIMULTANEOUS REQUESTS.
 *
 * The apply route's three claimed properties — applied once, through the public
 * door, attributed to the human — were each true of a single request and none of
 * them was true of two. The proposal was read, `applied_at` was checked, the
 * mutation ran, the marker was written and the audit row was appended as five
 * independent statements, so two concurrent callers could both see
 * `applied_at = NULL` and both spend one human's approval.
 *
 * `rule_to_approval` is the case this file leads with, because it is the one
 * where the damage is a NEW GOVERNANCE OBJECT rather than a repeated no-op:
 * `createApprovalRuleRow` is an unconditional insert with a fresh id, so one
 * approval could create TWO live approval rules while the proposal row recorded
 * only whichever update committed last.
 *
 * WHY THE ASSERTIONS ARE COUNTS OF ARTIFACTS, NOT COUNTS OF 200s.
 *
 * A route could return exactly one success and still have applied the change
 * twice — and a route could return several successes while a unique constraint
 * quietly saved it. So every test here counts the THING THE WORLD NOW HOLDS: how
 * many approval rules exist for this tool name, how many config versions were
 * minted, whether the grant is gone, what the budget is. The HTTP tally is
 * asserted too, second, because an operator needs the losers to say
 * `proposal_already_applied` rather than failing opaquely.
 *
 * THE FOURTH TEST is the one a lock alone would not give: a refusal that happens
 * AFTER the lock is taken must leave no applied marker AND must still be audited
 * — the deny row is written after the rollback for exactly that reason, and a
 * fix that audited inside the transaction would lose the one record an operator
 * hunting a refused apply goes looking for.
 *
 * Writes heavily and shares the deployment, so it is `zz-` prefixed (M-018) and
 * every assertion is scoped to ids this file created (M-008).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  and,
  approvalRules,
  approvals,
  auditLog,
  configVersions,
  copilotProposals,
  copilotQueries,
  createDb,
  eq,
  mcpServers,
  mcpTools,
  projects,
  rateLimits,
  runMigrations,
  sql,
  toolGrants,
  users,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";
import { COPILOT_RULE_IDS } from "./copilot.js";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import path from "node:path";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "aer035-bootstrap";
const BOOT_AUTH = { authorization: `Bearer ${BOOT}` };
/**
 * A REAL ADMIN'S key, not the bootstrap token. `POST /v1/copilot/proposals`
 * refuses an identity-less caller (`copilot_requires_identity`) — there would be
 * no entitlement set for the evidence to be scoped to — and the applier attributes
 * the act to the caller, which is the property this file is about.
 */
let AUTH: { authorization: string };
/** how many requests race for one consent */
const RACERS = 20;

let db: Db;
let app: ReturnType<typeof buildApp>;
let adminId: string;
let serverId: string;
let queryId: string;

const post = (url: string, payload: unknown) =>
  app.inject({ method: "POST", url, headers: AUTH, payload: payload as object });

/**
 * Record a proposal through the real endpoint and approve it, so every test
 * starts from a genuinely consented proposal rather than a hand-inserted row.
 */
async function approvedProposal(kind: string, diff: Record<string, unknown>): Promise<string> {
  const p = await post("/v1/copilot/proposals", {
    queryId,
    kind,
    title: `aer035 ${kind} ${randomUUID()}`,
    rationale: "aer035 concurrency coverage",
    diff,
    approverUserId: adminId,
  });
  expect(p.statusCode, p.body).toBe(201);
  const proposalId = p.json().proposal.id as string;
  // approve it directly: this file is about the applier, and routing a decision
  // through the decide path would drag its separation-of-duties rules in here
  await db
    .update(approvals)
    // `decidedBy`, not `decidedByUserId` — the column is `decided_by`
    .set({ status: "approved", decidedBy: adminId, decidedAt: new Date() })
    .where(eq(approvals.id, p.json().approvalId as string));
  return proposalId;
}

/** fire RACERS applies at once and tally what each one answered */
async function stampede(proposalId: string) {
  const results = await Promise.all(
    Array.from({ length: RACERS }, () =>
      app.inject({ method: "POST", url: `/v1/copilot/proposals/${proposalId}/apply`, headers: AUTH, payload: {} }),
    ),
  );
  const tally = new Map<string, number>();
  for (const r of results) {
    const key = r.statusCode === 200 ? "ok" : `${r.statusCode}:${(JSON.parse(r.body) as { error?: string }).error ?? "?"}`;
    tally.set(key, (tally.get(key) ?? 0) + 1);
  }
  return { results, tally };
}

const sourceRateLimit = async (toolName: string) => {
  const [row] = await db
    .insert(rateLimits)
    .values({ scope: "fleet", serverScope: "server", serverId, toolName, maxCalls: 1, windowSeconds: 60 })
    .returning({ id: rateLimits.id });
  return row!.id;
};

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT });

  const [u] = await db
    .insert(users)
    .values({ email: `aer035-${randomUUID()}@atomic.example`, displayName: "AER035", isAdmin: true })
    .returning({ id: users.id });
  adminId = u!.id;
  const key = await app.inject({
    method: "POST",
    url: `/v1/users/${adminId}/keys`,
    headers: BOOT_AUTH,
    payload: { name: "aer035" },
  });
  expect(key.statusCode, key.body).toBe(201);
  AUTH = { authorization: `Bearer ${key.json().token as string}` };

  const [s] = await db
    .insert(mcpServers)
    .values({ name: `aer035-${randomUUID()}`, url: "http://127.0.0.1:9/" })
    .returning({ id: mcpServers.id });
  serverId = s!.id;

  // one recorded query for every proposal to rest on — a proposal must cite the
  // proposer's own evidence, and the bootstrap caller is an admin so the
  // ownership check passes
  const [q] = await db
    .insert(copilotQueries)
    // `copilot_queries` has no `tool`/`timeframe` columns of its own — the
    // planned tool and window live inside `plan`, which is where the real route
    // puts them. (The first draft named them as columns; it ran fine, because
    // drizzle drops unknown keys, and only the BUILD caught it — vitest
    // transpiles without typechecking.)
    .values({
      userId: adminId,
      question: "aer035 fixture",
      plan: { tool: "listAudit", timeframe: "last_7d" },
      evidence: {},
      answer: "fixture",
      generation: "grounded",
    })
    .returning({ id: copilotQueries.id });
  queryId = q!.id;
}, 120_000);

afterAll(async () => {
  await app.close();
  await db.$client.end();
});

describe("AER-035 — rule_to_approval: one approval cannot create two rules", () => {
  it(`${RACERS} simultaneous applies create EXACTLY ONE approval rule`, async () => {
    const toolName = `aer035_rta_${randomUUID().slice(0, 8)}`;
    const sourceId = await sourceRateLimit(toolName);
    const proposalId = await approvedProposal("rule_to_approval", {
      sourceRuleKind: "rate-limits",
      sourceRuleId: sourceId,
      create: { scope: "fleet", serverScope: "server", serverId, toolName, approverUserId: adminId },
    });

    const { tally } = await stampede(proposalId);

    // WHAT THE WORLD HOLDS — the assertion that a lock actually worked. Before
    // this fix, an unconditional insert ran once per winner of the read race.
    const rules = await db.select().from(approvalRules).where(eq(approvalRules.toolName, toolName));
    expect(rules.length, `one consent, one rule; tally=${JSON.stringify([...tally])}`).toBe(1);

    // and every loser was told WHY, in the words an operator can act on
    expect(tally.get("ok")).toBe(1);
    expect(tally.get("409:proposal_already_applied")).toBe(RACERS - 1);

    // one applied marker, one result, one apply audit row
    const [row] = await db.select().from(copilotProposals).where(eq(copilotProposals.id, proposalId));
    expect(row!.appliedAt).not.toBeNull();
    expect((row!.appliedResult as { approvalRuleId?: string }).approvalRuleId).toBe(rules[0]!.id);
    const applied = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.ruleId, COPILOT_RULE_IDS.proposalApplied), eq(auditLog.objectId, proposalId)));
    expect(applied.length).toBe(1);
  }, 60_000);
});

describe("AER-035 — the other three kinds", () => {
  it("policy_tightening records exactly ONE rule edit", async () => {
    const toolName = `aer035_pt_${randomUUID().slice(0, 8)}`;
    const ruleId = await sourceRateLimit(toolName);
    const proposalId = await approvedProposal("policy_tightening", {
      ruleKind: "rate-limits",
      ruleId,
      patch: { maxCalls: 5 },
    });

    const { tally } = await stampede(proposalId);

    // WHAT THE WORLD HOLDS, for a kind whose write is IDEMPOTENT.
    //
    // `maxCalls: 5` applied twice leaves the same 5, so the value cannot tell
    // one application from two — this is the kind where a count of successes
    // would have been the only evidence, and that is exactly the evidence AER-035
    // says is not enough. `applyRuleEdit` writes one audit row per edit through
    // ADR-0074's choke point, so THAT is the countable artifact here.
    //
    // (A version count is not the measurement: a rate limit that nobody has
    // started versioning takes the unversioned path — `applyRuleEdit` invariant
    // 4, a plain row write and no version — so this rule legitimately has zero.
    // The first draft of this test asserted one version and failed for that
    // reason, which is a fact about the rule's versioning state, not about
    // atomicity.)
    const edits = await db.select().from(auditLog).where(eq(auditLog.ruleId, "copilot-proposal-rule-edit"));
    const mine = edits.filter(
      (r) => (r.detail as { copilotProposalId?: string }).copilotProposalId === proposalId,
    );
    expect(mine.length, `one consent, one edit; tally=${JSON.stringify([...tally])}`).toBe(1);
    expect(tally.get("ok")).toBe(1);
    expect(tally.get("409:proposal_already_applied")).toBe(RACERS - 1);

    const [after] = await db.select().from(rateLimits).where(eq(rateLimits.id, ruleId));
    expect(after!.maxCalls).toBe(5);
    // and no version was minted, which is the unversioned path being taken —
    // asserted rather than assumed, so a future change to versioning shows up
    // here as a failure to think about rather than a silent drift
    const versions = await db
      .select()
      .from(configVersions)
      .where(and(eq(configVersions.artifactType, "rate_limit"), eq(configVersions.artifactId, ruleId)));
    expect(versions.length).toBe(0);
  }, 60_000);

  it("grant_revocation removes one grant and the losers do not re-run it", async () => {
    const toolName = `aer035_gr_${randomUUID().slice(0, 8)}`;
    await db.insert(mcpTools).values({ serverId, name: toolName, kind: "read" });
    const [grant] = await db
      .insert(toolGrants)
      .values({ userId: adminId, serverId, toolName })
      .returning({ id: toolGrants.id });
    const proposalId = await approvedProposal("grant_revocation", { grantKind: "tool", grantId: grant!.id });

    const { tally } = await stampede(proposalId);

    const left = await db.select().from(toolGrants).where(eq(toolGrants.id, grant!.id));
    expect(left.length).toBe(0);
    expect(tally.get("ok")).toBe(1);
    // the losers must NOT be `proposal_target_gone`: that would mean they ran
    // the removal, found it already gone, and reported a vanished target — a
    // second execution wearing a different refusal's name
    expect(tally.get("409:proposal_already_applied")).toBe(RACERS - 1);
  }, 60_000);

  it("budget_adjustment writes the budget once", async () => {
    const [project] = await db
      .insert(projects)
      .values({ name: `aer035-${randomUUID()}`, budgetApproverUserId: adminId })
      .returning({ id: projects.id });
    const proposalId = await approvedProposal("budget_adjustment", {
      projectId: project!.id,
      patch: { budgetUsd: 250 },
    });

    const { tally } = await stampede(proposalId);

    const [after] = await db.select().from(projects).where(eq(projects.id, project!.id));
    expect(Number(after!.budgetUsd)).toBe(250);
    expect(tally.get("ok")).toBe(1);
    // exactly one `project-updated` row carrying this proposal id — a second
    // apply would have written a second one even though the value matched
    const rows = await db.select().from(auditLog).where(eq(auditLog.ruleId, "project-updated"));
    const mine = rows.filter((r) => (r.detail as { copilotProposalId?: string }).copilotProposalId === proposalId);
    expect(mine.length).toBe(1);
  }, 60_000);
});

describe("AER-035 — a refusal after the lock rolls everything back, and is still audited", () => {
  it("a vanished target leaves NO applied marker, and the deny row survives the rollback", async () => {
    // The refusal happens INSIDE the transaction, after the proposal row is
    // locked and after the consent check. Two things must both hold: nothing is
    // marked applied, and the deny row exists anyway — which is only true
    // because the audit is written after the rollback rather than inside it.
    const toolName = `aer035_gone_${randomUUID().slice(0, 8)}`;
    await db.insert(mcpTools).values({ serverId, name: toolName, kind: "read" });
    const [grant] = await db
      .insert(toolGrants)
      .values({ userId: adminId, serverId, toolName })
      .returning({ id: toolGrants.id });
    const proposalId = await approvedProposal("grant_revocation", { grantKind: "tool", grantId: grant!.id });
    // the target disappears between approval and apply — a real sequence, since
    // an admin can remove a grant by hand while a proposal sits approved
    await db.delete(toolGrants).where(eq(toolGrants.id, grant!.id));

    const res = await app.inject({
      method: "POST",
      url: `/v1/copilot/proposals/${proposalId}/apply`,
      headers: AUTH,
      payload: {},
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("proposal_target_gone");

    const [row] = await db.select().from(copilotProposals).where(eq(copilotProposals.id, proposalId));
    expect(row!.appliedAt, "a refused apply must not be marked applied").toBeNull();
    expect(row!.appliedResult).toBeNull();

    const denied = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.ruleId, COPILOT_RULE_IDS.proposalApplyRefused), eq(auditLog.objectId, proposalId)));
    expect(denied.length, "the refusal is on the record despite the rollback").toBe(1);
    expect(denied[0]!.effect).toBe("deny");

    // and it is still applicable afterwards: the rollback left a clean proposal,
    // so re-proposing is not required to recover from a transient refusal
    const again = await app.inject({
      method: "POST",
      url: `/v1/copilot/proposals/${proposalId}/apply`,
      headers: AUTH,
      payload: {},
    });
    expect(again.statusCode).toBe(404);
    expect(again.json().error).toBe("proposal_target_gone");
  }, 60_000);
});

// ===========================================================================
// AER-035 acceptance item 3 — a fault AFTER the mutation and the marker.
// ===========================================================================
//
// WHAT WAS STILL UNPROVEN, and why the existing coverage did not cover it. The
// refusal test above fires BEFORE any target mutation, so it proves the
// transaction can abort — not that the abort undoes the mutation and the applied
// marker. Those are written seconds apart inside the same transaction, and
// "they are in one transaction" was, until this test, a claim about the source
// rather than an observed property.
//
// THE FAULT IS INJECTED IN POSTGRES, not in the application. A `before insert`
// trigger on `audit_log`, scoped by rule id AND object id to this one proposal,
// raises exactly when the applier writes its SUCCESS audit row — which is the
// last write of the transaction and therefore strictly after the target mutation
// and after `applied_at`. Nothing in the shipped code changes, there is no
// failpoint to leave behind, and the timing is deterministic rather than raced.
//
// ABOUT ACCEPTANCE ITEM 4 (process crash / recovery), stated rather than faked:
// an uncommitted transaction discarded when a backend dies is a Postgres
// guarantee, not a path in this repository's code. What this repository has to
// prove is that all three writes are INSIDE one transaction — because if they
// are, a crash cannot leave two of them behind, and if they are not, no amount of
// crash testing makes them safe. That is exactly what this test observes. A
// harness that killed the process would be testing Postgres's durability, and
// would pass whether or not our boundary was drawn correctly.

describe("AER-035 — a fault at the LAST write undoes the mutation and the marker", () => {
  it("an injected failure on the success audit leaves no rule, no marker, and no audit row", async () => {
    const toolName = `aer035_fault_${randomUUID().slice(0, 8)}`;
    await db.insert(mcpTools).values({ serverId, name: toolName, kind: "read" });
    const sourceId = await sourceRateLimit(toolName);
    const proposalId = await approvedProposal("rule_to_approval", {
      sourceRuleKind: "rate-limits",
      sourceRuleId: sourceId,
      create: { scope: "fleet", serverScope: "server", serverId, toolName, approverUserId: adminId },
    });

    // THE FAILPOINT. Scoped to this proposal, so no other test in this file or
    // any other can be affected by it, and dropped in `finally` whatever happens.
    const fnName = `zz_aer035_fault_${proposalId.replace(/-/g, "")}`;
    // The body is a dollar-quoted STRING to Postgres, so bind parameters cannot
    // reach inside it — `$1` there is the function's own positional argument, not
    // the query's. Both values are inlined instead: one is a compile-time
    // constant and the other is a uuid this test just generated, so there is
    // nothing user-supplied in the statement.
    expect(proposalId).toMatch(/^[0-9a-f-]{36}$/);
    await db.execute(
      sql.raw(`
      create or replace function ${fnName}() returns trigger as $$
      begin
        if new.rule_id = '${COPILOT_RULE_IDS.proposalApplied}' and new.object_id = '${proposalId}'::uuid then
          raise exception 'aer035 injected failure on the success audit';
        end if;
        return new;
      end $$ language plpgsql;
    `),
    );
    await db.execute(
      sql`create trigger ${sql.raw(fnName)} before insert on audit_log for each row execute function ${sql.raw(fnName)}()`,
    );

    try {
      const res = await app.inject({
        method: "POST",
        url: `/v1/copilot/proposals/${proposalId}/apply`,
        headers: AUTH,
        payload: {},
      });
      // It fails. WHICH status matters less than what the world holds — an
      // injected database fault is not a governance outcome and has no named
      // shape; what must not happen is a 200.
      expect(res.statusCode, res.body).not.toBe(200);

      // (1) THE TARGET MUTATION IS GONE. `rule_to_approval` inserts an approval
      // rule with a fresh id, so a surviving one is unmistakable — this is the
      // same mutation whose unlocked version produced ten rules from one
      // approval, which is why it is the kind chosen here.
      const rules = await db
        .select()
        .from(approvalRules)
        .where(and(eq(approvalRules.serverId, serverId), eq(approvalRules.toolName, toolName)));
      expect(rules, "the mutation rolled back with the audit row").toHaveLength(0);

      // (2) THE MARKER IS GONE — written BEFORE the audit, so a surviving
      // `applied_at` would mean consent had been spent on a change that never
      // happened, and the proposal could never be applied again.
      const [row] = await db.select().from(copilotProposals).where(eq(copilotProposals.id, proposalId));
      expect(row!.appliedAt, "no applied marker without the change").toBeNull();
      expect(row!.appliedResult).toBeNull();

      // (3) AND NO SUCCESS ROW, which is the trivial half but worth pinning: a
      // ledger claiming an apply that did not happen is the failure mode this
      // whole ADR exists to prevent.
      const applied = await db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.ruleId, COPILOT_RULE_IDS.proposalApplied), eq(auditLog.objectId, proposalId)));
      expect(applied).toHaveLength(0);
    } finally {
      await db.execute(sql`drop trigger if exists ${sql.raw(fnName)} on audit_log`);
      await db.execute(sql`drop function if exists ${sql.raw(fnName)}()`);
    }

    // RECOVERY, which is acceptance item 4's real question: after the fault, the
    // proposal is still applicable exactly once. If the marker had survived the
    // rollback this would return `proposal_already_applied` and a human's consent
    // would have been consumed by a failure.
    const again = await app.inject({
      method: "POST",
      url: `/v1/copilot/proposals/${proposalId}/apply`,
      headers: AUTH,
      payload: {},
    });
    expect(again.statusCode, again.body).toBe(200);
    const rulesNow = await db
      .select()
      .from(approvalRules)
      .where(and(eq(approvalRules.serverId, serverId), eq(approvalRules.toolName, toolName)));
    expect(rulesNow, "and it creates exactly one rule, not zero and not two").toHaveLength(1);

    // NON-VACUITY FOR THE WHOLE TEST: the failure above really was the injected
    // one rather than the proposal being inapplicable all along. The line above
    // is what proves it — same proposal, trigger gone, 200.
    const [after] = await db.select().from(copilotProposals).where(eq(copilotProposals.id, proposalId));
    expect(after!.appliedAt).not.toBeNull();
  }, 60_000);
});
