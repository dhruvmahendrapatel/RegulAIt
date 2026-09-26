/**
 * B6c (ADR-0096 amendment) — MCP SERVERS AND TOOLS BECOME RESOLVABLE ENTITIES.
 *
 * ADR-0096 resolved six kinds and excluded MCP, naming its two blockers
 * precisely: *"the per-(user, server) tool-level visibility predicate plus the
 * non-global uniqueness of `mcp_tools.name`."* This file proves both are
 * solved rather than approximated, in the same shapes ADR-0096's own suite
 * uses, and against M-024's lesson: every refusal below fires while PLAUSIBLE,
 * REAL, WELL-FORMED rows sit in the ledger that a broad query would have
 * returned.
 *
 *  1. A SERVER-QUALIFIED NAME RESOLVES AND NARROWS — asserted as a ROW-COUNT
 *     DIFFERENCE against the same question with no subject, never as a
 *     reported filter (ADR-0096's precedent: a filter that is announced and
 *     changes nothing is the exact lie the feature exists to end). Proved on
 *     `audit_log` AND on `approvals`, the ledger ADR-0096 could not narrow for
 *     agents at all.
 *  2. NON-GLOBAL UNIQUENESS IS AMBIGUITY, NEVER A TIEBREAK. A bare tool name
 *     living on two servers lists BOTH, qualified by server, and runs nothing.
 *  3. VISIBILITY IS THE KERNEL'S OWN TOOL-LEVEL PREDICATE. A user granted ONE
 *     tool on a server resolves that tool and NOT its neighbour — the proof
 *     that this is per-(user, server, tool) and not a server-level shortcut —
 *     and, for that user, the otherwise-ambiguous bare name resolves uniquely,
 *     because ambiguity is a property of what the CALLER can see.
 *  4. SCOPE HONESTY. A tool the caller may not see refuses BYTE-IDENTICALLY to
 *     one that exists nowhere (ADR-0050's idiom), with the member resolving
 *     the very same tool as the control.
 *  5. THE SIX EXISTING KINDS ARE UNCHANGED — an agent named in an approvals
 *     question still ends in `copilot_tool_cannot_filter_entity`, so the
 *     matrix was extended rather than loosened.
 *
 * SHARED-DATABASE DISCIPLINE. Only `Zorbit`-prefixed rows, removed in
 * `afterAll`; audit cleanup keyed to THIS suite's user ids and its own rule id
 * (M-020: vitest orders by file SIZE, so no file may assume it ran first);
 * every count assertion is scoped to this suite's own project (M-008).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  agentGrants,
  agents,
  and,
  approvals,
  auditLog,
  copilotQueries,
  createDb,
  eq,
  inArray,
  mcpServers,
  mcpTools,
  projectMembers,
  projects,
  runMigrations,
  serverGrants,
  sql,
  toolGrants,
  users,
  type Db,
} from "@regulait/db";
import { copilotEntityUnresolvedRefusal } from "@regulait/shared";
import { COPILOT_RULE_IDS } from "./copilot.js";

const { buildApp } = await import("./app.js");

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "copilot-mcp-bootstrap-token";
const ADMIN = { authorization: `Bearer ${BOOT}` };
const PREFIX = "copilot-mcp";

const DOCS = "Zorbit Docs";
const WIKI = "Zorbit Wiki";
/** the tool name that lives on BOTH servers — the non-global-uniqueness case */
const SHARED_TOOL = "lookup";
/** the tool that lives on ONE server only, used for the tool-level grant proof */
const SOLO_TOOL = "digest";
const REALM = "Zorbit Realm";
const AGENT = "Zorbit Narrator";
/** a server-qualified name of the same SHAPE that exists nowhere */
const NOWHERE_QUALIFIED = "Zorbit Nomore/lookup";

/** deliberately DIFFERENT per (server, tool) so a filter that does nothing
 * produces the wrong number rather than a coincidentally right one */
const DOCS_LOOKUP_DENIALS = 3;
const DOCS_DIGEST_DENIALS = 2;
const WIKI_LOOKUP_DENIALS = 7;
const ALL_DENIALS = DOCS_LOOKUP_DENIALS + DOCS_DIGEST_DENIALS + WIKI_LOOKUP_DENIALS;
const DOCS_LOOKUP_APPROVALS = 2;
const WIKI_LOOKUP_APPROVALS = 4;
const ALL_APPROVALS = DOCS_LOOKUP_APPROVALS + WIKI_LOOKUP_APPROVALS;

let db: Db;
let app: ReturnType<typeof buildApp>;
let memberId: string;
let memberAuth: { authorization: string };
let partialId: string;
let partialAuth: { authorization: string };
let outsiderId: string;
let outsiderAuth: { authorization: string };
let approverId: string;
let realmId: string;
let docsId: string;
let wikiId: string;
let docsLookupId: string;
let docsDigestId: string;
let wikiLookupId: string;
let agentId: string;

const post = (url: string, payload: unknown, headers = ADMIN) =>
  app.inject({ method: "POST", url, headers, payload: payload as object });

const ask = (question: string, headers: { authorization: string }) =>
  post("/v1/copilot/ask", { question }, headers);

const decisions = (body: { evidence: { counts: Array<{ key: string; value: number }> } }) =>
  body.evidence.counts.find((c) => c.key === "decisions")!.value;
const approvalCount = (body: { evidence: { counts: Array<{ key: string; value: number }> } }) =>
  body.evidence.counts.find((c) => c.key === "approvals")!.value;

/** a governed MCP tool-call denial, in the shape the proxy really writes it:
 * the dedicated `server_id` + `tool_name` columns, `object_type` LEFT NULL,
 * and the project on the detail (an ATTRIBUTED call — which is also what makes
 * the row visible inside a non-admin's project-scoped audit read) */
async function seedToolDenials(serverId: string, toolName: string, n: number) {
  for (let i = 0; i < n; i++) {
    await db.insert(auditLog).values({
      userId: memberId,
      serverId,
      toolName,
      detail: { projectId: realmId, phase: "compliance" },
      effect: "deny",
      ruleId: `${PREFIX}-rule`,
      ruleChain: [],
      reason: `${PREFIX} seeded tool refusal`,
    });
  }
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT });
  await app.ready();

  const [realm] = await db.insert(projects).values({ name: REALM }).returning();
  realmId = realm!.id;

  const mk = async (local: string) => {
    const res = await post("/v1/users", {
      email: `${local}@${PREFIX}.example`,
      displayName: local,
    });
    expect(res.statusCode).toBe(201);
    const id = res.json().id as string;
    const key = await post(`/v1/users/${id}/keys`, { name: PREFIX });
    return { id, auth: { authorization: `Bearer ${key.json().token}` } };
  };
  const member = await mk(`${PREFIX}-member`);
  const partial = await mk(`${PREFIX}-partial`);
  const outsider = await mk(`${PREFIX}-outsider`);
  const approver = await mk(`${PREFIX}-approver`);
  memberId = member.id;
  memberAuth = member.auth;
  partialId = partial.id;
  partialAuth = partial.auth;
  outsiderId = outsider.id;
  outsiderAuth = outsider.auth;
  approverId = approver.id;

  // the outsider gets a project of their own so their scope is NON-EMPTY — an
  // outsider with no projects would make "refused" indistinguishable from
  // "you can see nothing at all" (ADR-0096's own precaution)
  const [outsiderProject] = await db
    .insert(projects)
    .values({ name: `${PREFIX}-outsider-project` })
    .returning();
  await db.insert(projectMembers).values([
    { projectId: realmId, userId: memberId, role: "owner" },
    { projectId: realmId, userId: partialId, role: "contributor" },
    { projectId: outsiderProject!.id, userId: outsiderId, role: "owner" },
  ]);

  // TWO servers carrying a tool of the SAME NAME — `mcp_tools.name` is unique
  // only per server (`mcp_tools_server_name_uq`), which is blocker #2 made real
  const [docs] = await db
    .insert(mcpServers)
    .values({ name: DOCS, url: "https://docs.zorbit.example/mcp" })
    .returning();
  const [wiki] = await db
    .insert(mcpServers)
    .values({ name: WIKI, url: "https://wiki.zorbit.example/mcp" })
    .returning();
  docsId = docs!.id;
  wikiId = wiki!.id;
  const [dl] = await db
    .insert(mcpTools)
    .values({ serverId: docsId, name: SHARED_TOOL, kind: "read" })
    .returning();
  const [dd] = await db
    .insert(mcpTools)
    .values({ serverId: docsId, name: SOLO_TOOL, kind: "read" })
    .returning();
  const [wl] = await db
    .insert(mcpTools)
    .values({ serverId: wikiId, name: SHARED_TOOL, kind: "read" })
    .returning();
  docsLookupId = dl!.id;
  docsDigestId = dd!.id;
  wikiLookupId = wl!.id;

  // THE ENTITLEMENTS, through the same tables `loadEntitlements` reads:
  //  - member  : read-all on BOTH servers → every tool visible
  //  - partial : ONE tool grant on Docs   → `lookup` visible, `digest` not
  //  - outsider: nothing at all
  await db.insert(serverGrants).values([
    { userId: memberId, serverId: docsId, readOnlyAll: true },
    { userId: memberId, serverId: wikiId, readOnlyAll: true },
  ]);
  await db
    .insert(toolGrants)
    .values([{ userId: partialId, serverId: docsId, toolName: SHARED_TOOL }]);

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
  await post("/v1/grants/agents", { userId: memberId, agentId });

  // THE PLAUSIBLE DATA (M-024) — every refusal below fires with these in place
  await seedToolDenials(docsId, SHARED_TOOL, DOCS_LOOKUP_DENIALS);
  await seedToolDenials(docsId, SOLO_TOOL, DOCS_DIGEST_DENIALS);
  await seedToolDenials(wikiId, SHARED_TOOL, WIKI_LOOKUP_DENIALS);
  for (let i = 0; i < DOCS_LOOKUP_APPROVALS; i++) {
    await db.insert(approvals).values({
      userId: memberId,
      approverUserId: approverId,
      objectType: "mcp_tool",
      serverId: docsId,
      toolName: SHARED_TOOL,
    });
  }
  for (let i = 0; i < WIKI_LOOKUP_APPROVALS; i++) {
    await db.insert(approvals).values({
      userId: memberId,
      approverUserId: approverId,
      objectType: "mcp_tool",
      serverId: wikiId,
      toolName: SHARED_TOOL,
    });
  }
});

afterAll(async () => {
  const mine = [memberId, partialId, outsiderId, approverId].filter(Boolean);
  await db.delete(copilotQueries).where(inArray(copilotQueries.userId, mine));
  await db.delete(approvals).where(inArray(approvals.userId, mine));
  await db.delete(auditLog).where(inArray(auditLog.userId, mine));
  await db.delete(auditLog).where(eq(auditLog.ruleId, `${PREFIX}-rule`));
  await db.delete(agentGrants).where(inArray(agentGrants.userId, mine));
  await db.delete(agents).where(eq(agents.name, AGENT));
  await db.delete(toolGrants).where(inArray(toolGrants.userId, mine));
  await db.delete(serverGrants).where(inArray(serverGrants.userId, mine));
  // mcp_tools cascades from mcp_servers
  await db.delete(mcpServers).where(inArray(mcpServers.id, [docsId, wikiId].filter(Boolean)));
  await db.delete(projectMembers).where(inArray(projectMembers.userId, mine));
  await db.delete(projects).where(sql`${projects.name} LIKE ${"Zorbit %"}`);
  await db.delete(projects).where(sql`${projects.name} LIKE ${PREFIX + "%"}`);
  await db.delete(users).where(sql`${users.email} LIKE ${"%@" + PREFIX + ".example"}`);
  await app.close();
});

// ---------------------------------------------------------------------------

describe("B6c — a server-qualified MCP tool resolves and the SQL genuinely narrows", () => {
  it("narrows the ROW SET on audit_log, not merely the reported filters", async () => {
    const broad = await ask("which denied decisions happened this quarter?", memberAuth);
    expect(broad.statusCode).toBe(201);
    expect(decisions(broad.json())).toBe(ALL_DENIALS);

    const narrow = await ask(
      `which denied decisions for "${DOCS}/${SHARED_TOOL}" happened this quarter?`,
      memberAuth,
    );
    expect(narrow.statusCode).toBe(201);
    const body = narrow.json();

    // the plan carries a REAL object, and its name is SERVER-QUALIFIED so the
    // caller can tell it from the identically-named tool on the other server
    expect(body.plan.entityCandidates).toContain(`${DOCS}/${SHARED_TOOL}`);
    expect(body.plan.entity).toMatchObject({
      kind: "mcp_tool",
      id: docsLookupId,
      name: `${DOCS}/${SHARED_TOOL}`,
      matchedOn: `${DOCS}/${SHARED_TOOL}`,
    });

    // THE NO-OP-FILTER PROBE'S TARGET: the count must MOVE
    expect(decisions(body)).toBe(DOCS_LOOKUP_DENIALS);
    expect(decisions(body)).not.toBe(ALL_DENIALS);
    expect(body.evidence.rowsExamined).toBe(DOCS_LOOKUP_DENIALS);
    expect(body.answer.subjectFiltered).toBe(true);
    expect(body.answer.unfilteredSubjectCaveat).toBeNull();
    expect(body.note).toMatch(/SUBJECT RESOLVED AND FILTERED/);

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
      entity: { kind: "mcp_tool", id: docsLookupId },
    });
  });

  it("the IDENTICALLY-NAMED tool on the other server narrows to the OTHER count", async () => {
    const res = await ask(
      `which denied decisions for "${WIKI}/${SHARED_TOOL}" happened this quarter?`,
      memberAuth,
    );
    expect(res.statusCode).toBe(201);
    expect(res.json().plan.entity).toMatchObject({ kind: "mcp_tool", id: wikiLookupId });
    // the filter TRACKS the subject: same tool name, different server, different rows
    expect(res.json().evidence.rowsExamined).toBe(WIKI_LOOKUP_DENIALS);
    expect(WIKI_LOOKUP_DENIALS).not.toBe(DOCS_LOOKUP_DENIALS);
  });

  it("an MCP SERVER narrows to every tool on it, and to nothing else", async () => {
    const res = await ask(`which denied decisions for "${DOCS}" happened this quarter?`, memberAuth);
    expect(res.statusCode).toBe(201);
    expect(res.json().plan.entity).toMatchObject({ kind: "mcp_server", id: docsId, name: DOCS });
    expect(res.json().evidence.rowsExamined).toBe(DOCS_LOOKUP_DENIALS + DOCS_DIGEST_DENIALS);
    expect(res.json().evidence.rowsExamined).not.toBe(ALL_DENIALS);
  });

  it("narrows the APPROVALS ledger too — the ledger ADR-0096 could not narrow for agents", async () => {
    const broad = await ask("summarise the approvals from this quarter", memberAuth);
    expect(broad.statusCode).toBe(201);
    expect(approvalCount(broad.json())).toBe(ALL_APPROVALS);

    const narrow = await ask(
      `summarise the approvals for "${DOCS}/${SHARED_TOOL}" from this quarter`,
      memberAuth,
    );
    expect(narrow.statusCode).toBe(201);
    expect(narrow.json().plan.tool).toBe("listApprovals");
    expect(narrow.json().plan.entity).toMatchObject({ kind: "mcp_tool", id: docsLookupId });
    expect(approvalCount(narrow.json())).toBe(DOCS_LOOKUP_APPROVALS);
    expect(approvalCount(narrow.json())).not.toBe(ALL_APPROVALS);
  });
});

describe("B6c — non-global tool-name uniqueness is AMBIGUITY, never a tiebreak", () => {
  it("a bare tool name living on two servers lists BOTH, qualified by server, and runs nothing", async () => {
    const res = await ask(
      `which denied decisions for "${SHARED_TOOL}" happened this quarter?`,
      memberAuth,
    );
    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.error).toBe("copilot_entity_ambiguous");

    // both candidates, each qualified by its server, each with its real id
    const names = (body.candidates as Array<{ kind: string; id: string; name: string }>)
      .map((m) => m.name)
      .sort();
    expect(names).toEqual([`${DOCS}/${SHARED_TOOL}`, `${WIKI}/${SHARED_TOOL}`]);
    expect(
      (body.candidates as Array<{ kind: string }>).every((m) => m.kind === "mcp_tool"),
    ).toBe(true);
    const ids = (body.candidates as Array<{ id: string }>).map((m) => m.id).sort();
    expect(ids).toEqual([docsLookupId, wikiLookupId].sort());
    expect(body.detail).toContain(`${DOCS}/${SHARED_TOOL}`);
    expect(body.detail).toContain(`${WIKI}/${SHARED_TOOL}`);
    expect(body.detail).toMatch(/^AMBIGUOUS SUBJECT — REFUSING TO GUESS/);

    // NOTHING was retrieved: the refusal precedes the query, so neither
    // candidate's rows were read and no tiebreak was even possible
    expect(body.evidence).toBeUndefined();
  });
});

describe("B6c — visibility is the KERNEL'S per-(user, server) TOOL-LEVEL predicate", () => {
  it("a one-tool grant resolves that tool and NOT its neighbour on the same server", async () => {
    const granted = await ask(
      `which denied decisions for "${DOCS}/${SHARED_TOOL}" happened this quarter?`,
      partialAuth,
    );
    expect(granted.statusCode).toBe(201);
    expect(granted.json().plan.entity).toMatchObject({ kind: "mcp_tool", id: docsLookupId });

    // the SAME server, a tool this caller has no grant for: NOT FOUND, in the
    // same words a nonexistent name produces — a server-level shortcut would
    // have resolved it, which is exactly what blocker #1 was about
    const ungranted = await ask(
      `which denied decisions for "${DOCS}/${SOLO_TOOL}" happened this quarter?`,
      partialAuth,
    );
    expect(ungranted.statusCode).toBe(422);
    expect(ungranted.json().error).toBe("copilot_entity_unresolved");
    expect(ungranted.json().detail).toBe(
      copilotEntityUnresolvedRefusal([`${DOCS}/${SOLO_TOOL}`]),
    );
    expect(ungranted.json().detail).not.toContain(docsDigestId);

    // THE CONTROL: the fully-granted member resolves that very same tool
    const control = await ask(
      `which denied decisions for "${DOCS}/${SOLO_TOOL}" happened this quarter?`,
      memberAuth,
    );
    expect(control.statusCode).toBe(201);
    expect(control.json().plan.entity).toMatchObject({ kind: "mcp_tool", id: docsDigestId });
    expect(control.json().evidence.rowsExamined).toBe(DOCS_DIGEST_DENIALS);
  });

  it("ambiguity is a property of the CALLER'S scope: the same bare name resolves uniquely for a one-tool grantee", async () => {
    const res = await ask(
      `which denied decisions for "${SHARED_TOOL}" happened this quarter?`,
      partialAuth,
    );
    // this caller can see exactly ONE tool by that name, so there is nothing
    // to guess between — and the answer is genuinely narrowed to it
    expect(res.statusCode).toBe(201);
    expect(res.json().plan.entity).toMatchObject({ kind: "mcp_tool", id: docsLookupId });
    expect(res.json().evidence.rowsExamined).toBe(DOCS_LOOKUP_DENIALS);
  });
});

describe("B6c — existence does not leak across the MCP entitlement boundary", () => {
  it("a tool the caller may not see refuses BYTE-IDENTICALLY to one that exists nowhere", async () => {
    const invisible = await ask(
      `which denied decisions for "${DOCS}/${SHARED_TOOL}" happened this quarter?`,
      outsiderAuth,
    );
    expect(invisible.statusCode).toBe(422);
    expect(invisible.json().error).toBe("copilot_entity_unresolved");

    const nonexistent = await ask(
      `which denied decisions for "${NOWHERE_QUALIFIED}" happened this quarter?`,
      outsiderAuth,
    );
    expect(nonexistent.statusCode).toBe(422);
    expect(nonexistent.json().error).toBe("copilot_entity_unresolved");

    // THE WHOLE ASSERTION: after substituting only the caller's own words, the
    // two bodies are the same bytes — so the copilot cannot be used as an
    // existence oracle for another team's MCP estate
    const invisibleDetail = invisible.json().detail as string;
    const nonexistentDetail = nonexistent.json().detail as string;
    expect(invisibleDetail.split(`${DOCS}/${SHARED_TOOL}`).join(NOWHERE_QUALIFIED)).toBe(
      nonexistentDetail,
    );
    expect(JSON.stringify(invisible.json()).split(`${DOCS}/${SHARED_TOOL}`).join(NOWHERE_QUALIFIED)).toBe(
      JSON.stringify(nonexistent.json()),
    );
    expect(invisibleDetail).not.toContain(docsLookupId);
    expect(invisibleDetail).not.toContain(docsId);
    expect(invisibleDetail).not.toMatch(/not permitted|forbidden|no access|denied/i);

    // THE CONTROL: the member resolves the very same tool
    const control = await ask(
      `which denied decisions for "${DOCS}/${SHARED_TOOL}" happened this quarter?`,
      memberAuth,
    );
    expect(control.statusCode).toBe(201);
    expect(control.json().plan.entity.id).toBe(docsLookupId);
  });

  it("the SERVER is invisible too, in the same words", async () => {
    const res = await ask(`which denied decisions for "${DOCS}" happened this quarter?`, outsiderAuth);
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe("copilot_entity_unresolved");
    expect(res.json().detail).toBe(copilotEntityUnresolvedRefusal([DOCS]));
    expect(res.json().detail).not.toContain(docsId);
  });
});

describe("B6c — the six pre-existing kinds behave identically", () => {
  it("an agent named in an approvals question still ends in the tool/kind refusal", async () => {
    const res = await ask(`summarise the approvals for "${AGENT}" from this quarter`, memberAuth);
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe("copilot_tool_cannot_filter_entity");
    // the matrix was EXTENDED, not loosened: `approvals` still has no agent
    // column, and the refusal still names the tools that can narrow by one
    expect(res.json().toolsThatCanFilter).toEqual(["queryAuditDecisions", "summarizeUsage"]);
  });

  it("a question naming no subject is untouched", async () => {
    const res = await ask("which denied decisions happened this quarter?", memberAuth);
    expect(res.statusCode).toBe(201);
    expect(res.json().plan.entityCandidates).toEqual([]);
    expect(res.json().plan.entity).toBeNull();
    expect(res.json().evidence.rowsExamined).toBe(ALL_DENIALS);
  });
});
