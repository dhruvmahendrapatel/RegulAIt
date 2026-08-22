/**
 * ADR-0096 — ENTITY-AWARE COPILOT PLANNING, PROVED AGAINST A REAL DATABASE.
 *
 * ADR-0056's L6d amendment could only make the copilot SAY it had not filtered
 * on the subject a question named. This file proves the four outcomes that
 * replace that stopgap, and it is written against M-024's lesson: every guard
 * below is fired in the case where PLAUSIBLE, REAL, WELL-FORMED DATA IS
 * AVAILABLE and the broad query would have returned it. A refusal over an empty
 * ledger proves nothing — the original defect happened with eight real rows in
 * hand.
 *
 *  1. RESOLVED AND FILTERABLE. The plan gains a real entity filter and the SQL
 *     genuinely narrows — asserted as a ROW-SET DIFFERENCE against the same
 *     question without the subject, not merely as a reported filter. A filter
 *     that is announced and changes nothing is the exact class of lie this
 *     feature exists to end, so the assertion is on the counts.
 *  2. UNRESOLVED. Refused by its OWN name, distinguishable from the
 *     empty-retrieval refusal, with real approvals sitting in the ledger that
 *     the pre-0096 build would have returned and mislabelled.
 *  3. SCOPE HONESTY. The same real project name: resolved for the member,
 *     refused for the non-member — and the non-member's refusal is proved
 *     BYTE-IDENTICAL to the one a name that exists nowhere produces. Existence
 *     must not leak across the entitlement boundary (ADR-0050's idiom).
 *  4. TOOL/KIND MISMATCH. A resolved, visible agent named in an approvals
 *     question, and a resolved, visible AI vendor named anywhere: both refused
 *     by name with the tools that CAN narrow by that kind, never run broadly.
 *  5. AMBIGUITY. One name held by two governed objects: both listed, neither
 *     picked.
 *  6. THE CONTROL. A question naming no subject is untouched — same 201, same
 *     shape, none of the new machinery in the text.
 *
 * SHARED-DATABASE DISCIPLINE. This suite creates only prefixed rows and removes
 * exactly its own in `afterAll`; the audit cleanup is keyed to THIS suite's
 * user ids rather than to the copilot rule ids, so it cannot delete another
 * copilot file's evidence whichever order vitest's size sequencer picks
 * (M-020: file naming orders Playwright, not vitest). Every count assertion is
 * a delta or an exactly-scoped equality, never a global total (M-008).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  agentGrants,
  agents,
  aiVendors,
  and,
  approvals,
  auditLog,
  copilotQueries,
  createDb,
  eq,
  inArray,
  projectMembers,
  projects,
  runMigrations,
  sql,
  teamMembers,
  teams,
  users,
  type Db,
} from "@regulait/db";
import {
  COPILOT_GROUNDED_REFUSAL,
  copilotEntityUnresolvedRefusal,
  extractEntityCandidates,
} from "@regulait/shared";
import { COPILOT_RULE_IDS } from "./copilot.js";

const { buildApp } = await import("./app.js");

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "copilot-entity-bootstrap-token";
const ADMIN = { authorization: `Bearer ${BOOT}` };
const PREFIX = "copilot-entity";

/**
 * The seeded names. Every one is a two-token capitalised run so the
 * conservative extractor sees it, and none contains a phrase the keyword
 * planner consumes — the questions below must be planned by their VERB, with
 * the name contributing only the subject.
 */
const P_MEMBER = "Zephyrine Aurora";
const P_OTHER = "Zephyrine Basalt";
const TWIN = "Zephyrine Twin";
const AGENT = "Zephyrine Narrator";
const VENDOR = "Zephyrine Vendorco";
const NOWHERE = "Zephyrine Nowhere";
/** the live reproduction from ADR-0056's L6d amendment, verbatim */
const ZORBLATT = "Summarise the Zorblatt Quantum Compliance Widget approvals from last week";

/** rows seeded per project — deliberately DIFFERENT so a filter that does
 * nothing produces the wrong number rather than a coincidentally right one */
const AURORA_DENIALS = 3;
const BASALT_DENIALS = 5;

let db: Db;
let app: ReturnType<typeof buildApp>;
let memberId: string;
let memberAuth: { authorization: string };
let outsiderId: string;
let outsiderAuth: { authorization: string };
let adminId: string;
let approverId: string;
let auroraId: string;
let basaltId: string;
let twinProjectId: string;
let twinTeamId: string;
let agentId: string;
let vendorId: string;

const post = (url: string, payload: unknown, headers = ADMIN) =>
  app.inject({ method: "POST", url, headers, payload: payload as object });

const ask = (question: string, headers: { authorization: string }) =>
  post("/v1/copilot/ask", { question }, headers);

async function seedDenials(userId: string, projectId: string, n: number) {
  for (let i = 0; i < n; i++) {
    await db.insert(auditLog).values({
      userId,
      objectType: "agent",
      objectId: null,
      detail: { projectId },
      effect: "deny",
      ruleId: `${PREFIX}-rule`,
      ruleChain: [],
      reason: `${PREFIX} seeded refusal`,
    });
  }
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT });
  await app.ready();

  const [aurora] = await db.insert(projects).values({ name: P_MEMBER }).returning();
  const [basalt] = await db.insert(projects).values({ name: P_OTHER }).returning();
  const [twinP] = await db.insert(projects).values({ name: TWIN }).returning();
  auroraId = aurora!.id;
  basaltId = basalt!.id;
  twinProjectId = twinP!.id;
  const [twinT] = await db.insert(teams).values({ name: TWIN }).returning();
  twinTeamId = twinT!.id;

  const mk = async (local: string, isAdmin = false) => {
    const res = await post("/v1/users", {
      email: `${local}@${PREFIX}.example`,
      displayName: local,
      isAdmin,
    });
    expect(res.statusCode).toBe(201);
    const id = res.json().id as string;
    const key = await post(`/v1/users/${id}/keys`, { name: "copilot-entity" });
    return { id, auth: { authorization: `Bearer ${key.json().token}` } };
  };
  const member = await mk(`${PREFIX}-member`);
  const outsider = await mk(`${PREFIX}-outsider`);
  const admin = await mk(`${PREFIX}-admin`, true);
  const approver = await mk(`${PREFIX}-approver`);
  memberId = member.id;
  memberAuth = member.auth;
  outsiderId = outsider.id;
  outsiderAuth = outsider.auth;
  adminId = admin.id;
  approverId = approver.id;

  // THE MEMBER sees both Aurora and Basalt (so the entity filter has something
  // to narrow AWAY FROM inside their own scope) and the twin project. THE
  // OUTSIDER is a member of nothing this suite creates, and is deliberately
  // given a project of their own so their scope is non-empty — an outsider with
  // no projects at all would make "refused" indistinguishable from "no scope".
  const [outsiderProject] = await db
    .insert(projects)
    .values({ name: `${PREFIX}-outsider-project` })
    .returning();
  await db.insert(projectMembers).values([
    { projectId: auroraId, userId: memberId, role: "owner" },
    { projectId: basaltId, userId: memberId, role: "owner" },
    { projectId: twinProjectId, userId: memberId, role: "owner" },
    { projectId: outsiderProject!.id, userId: outsiderId, role: "owner" },
  ]);
  await db.insert(teamMembers).values([{ teamId: twinTeamId, userId: memberId }]);

  const agentRes = await post("/v1/agents", {
    name: AGENT,
    provider: "mock",
    tier: 1,
    costPerMTokIn: 3,
    costPerMTokOut: 15,
    model: "mock-balanced",
  });
  expect(agentRes.statusCode).toBe(201);
  agentId = agentRes.json().id as string;
  // the member may INVOKE it, which is what makes it visible to entity
  // resolution — the kernel's own `evaluateAgent`, not a hand-rolled join
  await post("/v1/grants/agents", { userId: memberId, agentId });

  const [vendor] = await db
    .insert(aiVendors)
    .values({
      name: VENDOR,
      description: `${PREFIX} seeded vendor`,
      category: "model_provider",
      ownerUserId: memberId,
    })
    .returning();
  vendorId = vendor!.id;

  // THE PLAUSIBLE DATA (M-024). Every refusal below fires with these rows
  // sitting in the ledger, so none of them is the easy empty-retrieval case.
  await seedDenials(memberId, auroraId, AURORA_DENIALS);
  await seedDenials(memberId, basaltId, BASALT_DENIALS);
  await db.insert(approvals).values([
    { userId: memberId, approverUserId: approverId, objectType: "mcp_tool", toolName: `${PREFIX}-t1` },
    { userId: memberId, approverUserId: approverId, objectType: "mcp_tool", toolName: `${PREFIX}-t2` },
    { userId: memberId, approverUserId: approverId, objectType: "mcp_tool", toolName: `${PREFIX}-t3` },
  ]);
});

afterAll(async () => {
  const mine = [memberId, outsiderId, adminId, approverId].filter(Boolean);
  await db.delete(copilotQueries).where(inArray(copilotQueries.userId, mine));
  await db.delete(approvals).where(inArray(approvals.userId, mine));
  // keyed to THIS suite's users, never to the shared copilot rule ids — another
  // copilot file's audit evidence must survive whatever order vitest picks
  await db.delete(auditLog).where(inArray(auditLog.userId, mine));
  await db.delete(auditLog).where(eq(auditLog.ruleId, `${PREFIX}-rule`));
  await db.delete(agentGrants).where(inArray(agentGrants.userId, mine));
  await db.delete(aiVendors).where(eq(aiVendors.name, VENDOR));
  await db.delete(agents).where(eq(agents.name, AGENT));
  await db.delete(teamMembers).where(eq(teamMembers.teamId, twinTeamId));
  await db.delete(teams).where(eq(teams.id, twinTeamId));
  await db.delete(projectMembers).where(inArray(projectMembers.userId, mine));
  await db.delete(projects).where(sql`${projects.name} LIKE ${"Zephyrine %"}`);
  await db.delete(projects).where(sql`${projects.name} LIKE ${PREFIX + "%"}`);
  await db.delete(users).where(sql`${users.email} LIKE ${"%@" + PREFIX + ".example"}`);
  await app.close();
});

// ---------------------------------------------------------------------------

describe("ADR-0096 — a resolved subject becomes a real SQL filter", () => {
  it("narrows the ROW SET, not merely the reported filters", async () => {
    // the SAME question without the subject: both projects, both counts
    const broad = await ask("which denied decisions happened this quarter?", memberAuth);
    expect(broad.statusCode).toBe(201);
    const broadCount = broad
      .json()
      .evidence.counts.find((c: { key: string }) => c.key === "decisions").value;
    expect(broadCount).toBe(AURORA_DENIALS + BASALT_DENIALS);

    const narrow = await ask(
      `which denied decisions for ${P_MEMBER} happened this quarter?`,
      memberAuth,
    );
    expect(narrow.statusCode).toBe(201);
    const body = narrow.json();

    // THE PLAN CARRIES A REAL OBJECT, resolved from the caller's own words
    expect(body.plan.entityCandidates).toContain(P_MEMBER);
    expect(body.plan.entity).toMatchObject({
      kind: "project",
      id: auroraId,
      name: P_MEMBER,
      matchedOn: P_MEMBER,
    });

    // THE ASSERTION THAT MATTERS: the SQL did something. A reported filter that
    // leaves the row set alone is the lie this whole feature exists to end, so
    // the narrowed count must DIFFER from the broad one and must equal exactly
    // the rows seeded against this project.
    const narrowCount = body.evidence.counts.find((c: { key: string }) => c.key === "decisions").value;
    expect(narrowCount).toBe(AURORA_DENIALS);
    expect(narrowCount).not.toBe(broadCount);
    expect(body.evidence.rowsExamined).toBe(AURORA_DENIALS);

    // and the answer NAMES what it narrowed to, by kind and id
    expect(body.answer.subjectFiltered).toBe(true);
    expect(body.answer.unfilteredSubjectCaveat).toBeNull();
    expect(body.answer.text).toContain(`project '${P_MEMBER}' (${auroraId})`);
    expect(body.answer.text).toContain(`Narrowed to the project '${P_MEMBER}' (${auroraId})`);
    expect(body.note).toMatch(/SUBJECT RESOLVED AND FILTERED/);
    expect(body.note).toContain(auroraId);

    // the ledger records the subject by primary key, so "was that answer about
    // the thing I asked?" survives the prose
    const [asked] = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.ruleId, COPILOT_RULE_IDS.asked),
          eq(auditLog.objectId, body.query.id as string),
        ),
      );
    expect(asked!.detail).toMatchObject({
      subjectFiltered: true,
      entity: { kind: "project", id: auroraId, matchedOn: P_MEMBER },
    });
    expect((asked!.detail as { filters: string[] }).filters).toContain(
      `project='${P_MEMBER}'(${auroraId})`,
    );
  });

  it("resolves a subject named by its UUID, and narrows the same way", async () => {
    const res = await ask(`which denied decisions for ${auroraId} happened this quarter?`, memberAuth);
    expect(res.statusCode).toBe(201);
    expect(res.json().plan.entity).toMatchObject({ kind: "project", id: auroraId });
    expect(res.json().evidence.rowsExamined).toBe(AURORA_DENIALS);
  });

  it("narrows the OTHER project to the OTHER count — so the filter tracks the subject", async () => {
    const res = await ask(`which denied decisions for ${P_OTHER} happened this quarter?`, memberAuth);
    expect(res.statusCode).toBe(201);
    expect(res.json().plan.entity).toMatchObject({ kind: "project", id: basaltId });
    expect(res.json().evidence.rowsExamined).toBe(BASALT_DENIALS);
  });
});

describe("ADR-0096 — an unresolved subject is REFUSED BY NAME, never answered broadly", () => {
  it("refuses the live L6d reproduction, with real approvals sitting in the ledger", async () => {
    // M-024: prove the broad query WOULD have returned plausible rows. The
    // original defect was not an empty retrieval — it was eight real approvals
    // relabelled, and a guard proved only against absence proves nothing.
    const control = await ask("summarise the approvals from last week", memberAuth);
    expect(control.statusCode).toBe(201);
    expect(control.json().evidence.rowsExamined).toBeGreaterThan(0);

    const res = await ask(ZORBLATT, memberAuth);
    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.error).toBe("copilot_entity_unresolved");
    expect(body.candidates).toEqual(["Zorblatt Quantum Compliance Widget"]);
    expect(body.detail).toMatch(/^UNRESOLVED SUBJECT — REFUSING TO ANSWER/);
    expect(body.detail).toContain("Zorblatt Quantum Compliance Widget");

    // A DISTINCT REASON from the empty-retrieval refusal. A caller must be able
    // to tell "you named something I cannot find" from "your query legitimately
    // matched nothing", so neither refusal may contain the other's words.
    expect(body.detail).not.toContain("NOTHING RETRIEVED");
    expect(body.detail).not.toBe(COPILOT_GROUNDED_REFUSAL);
    expect(COPILOT_GROUNDED_REFUSAL).not.toContain("UNRESOLVED SUBJECT");

    // nothing was retrieved, nothing was recorded as an answer
    expect(body.answer).toBeUndefined();
    expect(body.evidence).toBeUndefined();

    const denies = await db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.ruleId, COPILOT_RULE_IDS.entityUnresolved), eq(auditLog.userId, memberId)),
      );
    expect(denies.length).toBeGreaterThan(0);
    expect(denies[0]!.effect).toBe("deny");
  });
});

describe("ADR-0096 — existence does not leak across the entitlement boundary", () => {
  it("resolves for the member and refuses for the non-member, in words that cannot be told apart", async () => {
    // the member: the project is real, visible, and filtered on
    const seen = await ask(`which denied decisions for ${P_MEMBER} happened this quarter?`, memberAuth);
    expect(seen.statusCode).toBe(201);
    expect(seen.json().plan.entity.id).toBe(auroraId);

    // the non-member: the SAME real project, invisible to them
    const invisible = await ask(
      `which denied decisions for ${P_MEMBER} happened this quarter?`,
      outsiderAuth,
    );
    expect(invisible.statusCode).toBe(422);
    expect(invisible.json().error).toBe("copilot_entity_unresolved");

    // a name no governed object anywhere bears
    const nonexistent = await ask(
      `which denied decisions for ${NOWHERE} happened this quarter?`,
      outsiderAuth,
    );
    expect(nonexistent.statusCode).toBe(422);
    expect(nonexistent.json().error).toBe("copilot_entity_unresolved");

    // BYTE-IDENTICAL once the caller's own words are substituted. This is the
    // whole assertion: nothing in the invisible case's wording, status, error
    // code or shape distinguishes it from the nonexistent case, so the copilot
    // cannot be used as an existence oracle for another team's objects.
    const invisibleDetail = invisible.json().detail as string;
    const nonexistentDetail = nonexistent.json().detail as string;
    expect(invisibleDetail.split(P_MEMBER).join(NOWHERE)).toBe(nonexistentDetail);
    expect(invisibleDetail).toBe(copilotEntityUnresolvedRefusal([P_MEMBER]));
    expect(nonexistentDetail).toBe(copilotEntityUnresolvedRefusal([NOWHERE]));
    expect(JSON.stringify(invisible.json()).split(P_MEMBER).join(NOWHERE)).toBe(
      JSON.stringify(nonexistent.json()).split(NOWHERE).join(NOWHERE),
    );

    // and nothing about the hidden object escaped: no id, no permission
    // language (which would itself confirm the object is real), and the
    // identical-wording contract stated in the refusal's own text
    expect(invisibleDetail).not.toContain(auroraId);
    expect(invisibleDetail).not.toMatch(/not permitted|forbidden|no access|denied/i);
    expect(invisibleDetail).toMatch(/never about the organization/);
    expect(invisibleDetail).toMatch(
      /worded identically whether the object does not exist or exists somewhere you may not read/,
    );
  });

  it("an agent the caller may not invoke is unresolved, not 'you may not see it'", async () => {
    // the agent exists and the outsider has no grant for it: the kernel's own
    // evaluateAgent says deny, so resolution reports NOT FOUND — the same
    // wording a nonexistent agent produces.
    const res = await ask(`which denied decisions for ${AGENT} happened this quarter?`, outsiderAuth);
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe("copilot_entity_unresolved");
    expect(res.json().detail).toBe(copilotEntityUnresolvedRefusal([AGENT]));
    expect(res.json().detail).not.toContain(agentId);

    // THE CONTROL: the granted member resolves the very same agent
    const granted = await ask(
      `which denied decisions for ${AGENT} happened this quarter?`,
      memberAuth,
    );
    expect(granted.statusCode).toBe(201);
    expect(granted.json().plan.entity).toMatchObject({ kind: "agent", id: agentId });
  });
});

describe("ADR-0096 — a resolved subject this tool cannot filter by is refused, not run broadly", () => {
  it("refuses an approvals question naming an agent, and names the tools that CAN narrow", async () => {
    // the precondition: the caller HAS approvals, so a broad run would have
    // returned real rows to mislabel (M-024 again)
    const control = await ask("summarise the approvals from last week", memberAuth);
    expect(control.json().evidence.rowsExamined).toBeGreaterThan(0);

    const res = await ask(`which approvals are waiting for ${AGENT}?`, memberAuth);
    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.error).toBe("copilot_tool_cannot_filter_entity");
    expect(body.tool).toBe("listApprovals");
    expect(body.entity).toMatchObject({ kind: "agent", id: agentId, name: AGENT });
    expect(body.toolsThatCanFilter).toEqual(["queryAuditDecisions", "summarizeUsage"]);
    expect(body.detail).toMatch(/^SUBJECT NOT FILTERABLE BY THIS TOOL/);
    expect(body.detail).toContain("carries no agent column");
    expect(body.detail).toContain("queryAuditDecisions, summarizeUsage");
    // it is NOT the unresolved refusal — the subject was found, and saying
    // otherwise would be a false statement about a real, visible object
    expect(body.detail).not.toMatch(/UNRESOLVED SUBJECT/);

    const denies = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.ruleId, COPILOT_RULE_IDS.entityNotFilterable),
          eq(auditLog.userId, memberId),
        ),
      );
    expect(denies.length).toBeGreaterThan(0);
  });

  it("a real AI vendor resolves — and is refused because NO tool can narrow by vendor", async () => {
    const res = await ask(`how much did ${VENDOR} spend last month?`, memberAuth);
    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.error).toBe("copilot_tool_cannot_filter_entity");
    expect(body.entity).toMatchObject({ kind: "vendor", id: vendorId, name: VENDOR });
    expect(body.toolsThatCanFilter).toEqual([]);
    expect(body.detail).toMatch(/No read tool in this build can narrow by AI vendor/);
    // THE POINT of resolving a kind nothing can filter: a REAL vendor is never
    // reported as "no such thing in your scope"
    expect(body.detail).not.toMatch(/UNRESOLVED SUBJECT/);
  });
});

describe("ADR-0096 — ambiguity is listed and asked about, never resolved by a tiebreak", () => {
  it("lists every governed object the name matched, and runs no query", async () => {
    const res = await ask(`which denied decisions for ${TWIN} happened this quarter?`, memberAuth);
    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.error).toBe("copilot_entity_ambiguous");
    expect(body.detail).toMatch(/^AMBIGUOUS SUBJECT — REFUSING TO GUESS/);

    const kinds = (body.candidates as Array<{ kind: string; id: string }>).map((c) => c.kind).sort();
    expect(kinds).toEqual(["project", "team"]);
    expect(body.detail).toContain(twinProjectId);
    expect(body.detail).toContain(twinTeamId);
    expect(body.answer).toBeUndefined();

    const denies = await db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.ruleId, COPILOT_RULE_IDS.entityAmbiguous), eq(auditLog.userId, memberId)),
      );
    expect(denies.length).toBeGreaterThan(0);
  });
});

describe("ADR-0096 — a question naming no subject is untouched", () => {
  it("THE CONTROL — the ordinary denials question answers exactly as before", async () => {
    const res = await ask("what governance denials happened recently and why?", memberAuth);
    expect(res.statusCode).toBe(201);
    const body = res.json();

    // the entity layer contributed literally nothing to this answer
    expect(extractEntityCandidates("what governance denials happened recently and why?")).toEqual([]);
    expect(body.plan.entityCandidates).toEqual([]);
    expect(body.plan.entity).toBeNull();
    expect(body.answer.text).not.toMatch(/Narrowed to the/);
    expect(body.note).not.toMatch(/SUBJECT RESOLVED AND FILTERED/);
    // and it is still a real, useful answer over real rows
    expect(body.evidence.rowsExamined).toBeGreaterThan(0);
    expect(body.answer.groundedRefusal).toBe(false);
  });

  it("the four ADR-0056 worked questions still name no subject at all", () => {
    for (const q of [
      "Who accessed PII last quarter?",
      "Which denied MCP tool calls spiked this week?",
      "How much have we spent this month on tokens?",
      "Show me approvals waiting on me",
    ]) {
      expect(extractEntityCandidates(q)).toEqual([]);
    }
  });
});
