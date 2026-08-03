/**
 * ADR-0058 — REGULATORY COMPLIANCE PACKS, PROVED BY ATTACK.
 *
 * WHAT THIS FILE TRIES TO MAKE IMPOSSIBLE TO FAKE
 * ----------------------------------------------
 *  1. A CONTROL THAT IS ALWAYS GREEN. The headline. A control is evaluated over
 *     an empty period and asserted UNSATISFIED; the evidence row is then
 *     inserted INTO that period and the same control, same pack, same request,
 *     is asserted SATISFIED; the row is deleted and it is asserted UNSATISFIED
 *     again. A scorecard whose numbers came from anywhere but the ledger cannot
 *     pass all three.
 *  2. A TICK-BOX. An attestation-required control is asserted to report as
 *     `attestation_required` and NEVER as `satisfied` — including on a run
 *     where the ledgers are full of evidence. Then an attestation is recorded
 *     and it becomes `attested`, which is asserted to be a DIFFERENT status
 *     from `satisfied` and not counted in `totals.satisfied`. And the reverse
 *     attack: attesting to an AUTO-EVIDENCED control is asserted REFUSED with
 *     a 409 and an audited deny — a human statement must not be able to stand
 *     in for ledger evidence.
 *  3. A CATALOGUE THAT IS SECRETLY CODE. A framework nobody shipped
 *     ('acme-internal-ai-standard') is POSTed as DATA, activated and evaluated,
 *     and its controls resolve against the real ledgers. No code in this repo
 *     mentions that framework.
 *  4. A SCORECARD THAT LEAKS. Two teams, two projects, evidence seeded in each.
 *     A team lead evaluates their own team's scope and the OTHER team's audit
 *     rows are asserted absent from the count — the count equals exactly the
 *     rows in their own project, not the sum. The same lead asking for an
 *     org-scoped evaluation is asserted 403 with an audited deny.
 *  5. AN ARTIFACT THAT OVERCLAIMS. Every scorecard is asserted to carry the
 *     disclaimer and to contain the string "not a compliance certification",
 *     and asserted NOT to contain a "compliant" verdict field.
 *
 * SHARED-STATE DISCIPLINE. `compliance_packs`, its controls/attestations/
 * reports, and the users/teams/projects this suite creates are org-wide.
 * `afterAll` deletes every row this suite created plus its audit rows, so the
 * deployment ends the run exactly as it started.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  and,
  auditLog,
  compliancePackAttestations,
  compliancePackControls,
  compliancePackReports,
  compliancePacks,
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
import { COMPLIANCE_PACK_DISCLAIMER, DEFAULT_COMPLIANCE_PACKS } from "@regulait/shared";
import { COMPLIANCE_PACK_RULE_IDS } from "./compliance-packs.js";

const { buildApp } = await import("./app.js");

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "compliance-packs-bootstrap-token";
const ADMIN = { authorization: `Bearer ${BOOT}` };
const PREFIX = "cpack-test";
const CUSTOM_FRAMEWORK = "acme-internal-ai-standard";

let db: Db;
let app: ReturnType<typeof buildApp>;

/** the two teams and their projects — the leak test's whole apparatus */
let teamA: string;
let teamB: string;
let projectA: string;
let projectB: string;
let leadA: string;
let leadAKey: string;

let packId: string;

const post = (url: string, payload: unknown, headers = ADMIN) =>
  app.inject({ method: "POST", url, headers, payload: payload as object });
const get = (url: string, headers = ADMIN) => app.inject({ method: "GET", url, headers });

/** A period the evaluator will look at: the current quarter. Every seeded
 * evidence row is stamped `now`, so it lands inside it. */
const PERIOD = "current_quarter" as const;

/** the pack this suite authors — deliberately NOT one of the six seeds, so the
 * assertions cannot accidentally pass because a shipped pack changed */
const TEST_PACK = {
  framework: CUSTOM_FRAMEWORK,
  version: 1,
  title: "ACME internal AI standard (test pack authored as DATA)",
  description: "A framework that exists nowhere in this repository's source.",
  provenance: { source: "authored by the test suite", reviewedBy: null },
  cascadeTag: null,
  controls: [
    {
      // the control whose greenness is toggled by real rows
      controlRef: "acme:1.1-decisions-are-logged",
      title: "Every governed decision is recorded",
      coverage: "enforced" as const,
      collector: "audit_decisions" as const,
      collectorParams: { ruleIdPrefix: `${PREFIX}-evidence` },
      minEvidenceCount: 1,
      attestationRequired: false,
      ownerNote: null,
    },
    {
      // the organisational control that must never go green on its own
      controlRef: "acme:9.9-staff-are-trained",
      title: "Staff operating the system are trained",
      coverage: "unaddressed" as const,
      collector: "none" as const,
      collectorParams: {},
      minEvidenceCount: 1,
      attestationRequired: true,
      ownerNote: "Training records live in the customer's LMS.",
    },
    {
      // a control with a high threshold that will NOT be met — proves the
      // threshold is compared, not ignored
      controlRef: "acme:1.2-decisions-at-volume",
      title: "Decision volume exceeds the standard's floor",
      coverage: "evidenced" as const,
      collector: "audit_decisions" as const,
      collectorParams: { ruleIdPrefix: `${PREFIX}-evidence` },
      minEvidenceCount: 10_000,
      attestationRequired: false,
      ownerNote: null,
    },
  ],
};

async function evidenceRows(userId: string, projectId: string, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await db.insert(auditLog).values({
      userId,
      objectType: "agent",
      objectId: null,
      detail: { projectId },
      effect: "allow",
      ruleId: `${PREFIX}-evidence`,
      ruleChain: [],
      reason: "seeded evidence row for the compliance-pack evaluator",
    });
  }
}

async function evaluate(
  id: string,
  body: Record<string, unknown>,
  headers: { authorization: string } = ADMIN,
) {
  return post(`/v1/compliance/packs/${id}/evaluate`, { period: PERIOD, ...body }, headers);
}

function control(scorecard: { controls: Array<{ controlRef: string }> }, ref: string) {
  return scorecard.controls.find((c) => c.controlRef === ref) as unknown as {
    controlRef: string;
    status: string;
    evidenceCount: number | null;
    attestationRequired: boolean;
    attestation: unknown;
    note: string;
  };
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT });
  await app.ready();

  // two teams, two projects, one lead on team A only
  const [tA] = await db.insert(teams).values({ name: `${PREFIX}-team-a` }).returning();
  const [tB] = await db.insert(teams).values({ name: `${PREFIX}-team-b` }).returning();
  teamA = tA!.id;
  teamB = tB!.id;
  const [pA] = await db.insert(projects).values({ name: `${PREFIX}-project-a` }).returning();
  const [pB] = await db.insert(projects).values({ name: `${PREFIX}-project-b` }).returning();
  projectA = pA!.id;
  projectB = pB!.id;

  const mk = async (local: string) => {
    const res = await post("/v1/users", {
      email: `${local}@${PREFIX}.example`,
      displayName: local,
    });
    expect(res.statusCode).toBe(201);
    const id = res.json().id as string;
    const key = await post(`/v1/users/${id}/keys`, { name: "cpack" });
    return { id, apiKey: key.json().token as string };
  };
  const a = await mk(`${PREFIX}-lead-a`);
  const b = await mk(`${PREFIX}-lead-b`);
  leadA = a.id;
  leadAKey = a.apiKey;

  await db.insert(teamMembers).values([
    { teamId: teamA, userId: leadA },
    { teamId: teamB, userId: b.id },
  ]);
  await db.insert(projectMembers).values([
    { projectId: projectA, userId: leadA, teamId: teamA, role: "owner" },
    { projectId: projectB, userId: b.id, teamId: teamB, role: "owner" },
  ]);

  // THE PACK, POSTED AS DATA. Nothing in src/ mentions 'acme-internal-ai-standard'.
  const created = await post("/v1/compliance/packs", TEST_PACK);
  expect(created.statusCode).toBe(201);
  packId = created.json().pack.id;
  const activated = await post(`/v1/compliance/packs/${packId}/activate`, {});
  expect(activated.statusCode).toBe(200);
});

afterAll(async () => {
  const packIds = (
    await db
      .select({ id: compliancePacks.id })
      .from(compliancePacks)
      .where(inArray(compliancePacks.framework, [CUSTOM_FRAMEWORK, ...DEFAULT_COMPLIANCE_PACKS.map((p) => p.framework)]))
  ).map((r) => r.id);
  if (packIds.length) {
    await db.delete(compliancePackReports).where(inArray(compliancePackReports.packId, packIds));
    await db.delete(compliancePackAttestations).where(inArray(compliancePackAttestations.packId, packIds));
    await db.delete(compliancePackControls).where(inArray(compliancePackControls.packId, packIds));
    await db.delete(compliancePacks).where(inArray(compliancePacks.id, packIds));
  }
  await db.delete(auditLog).where(sql`${auditLog.ruleId} LIKE ${PREFIX + "%"}`);
  await db
    .delete(auditLog)
    .where(inArray(auditLog.ruleId, Object.values(COMPLIANCE_PACK_RULE_IDS) as string[]));
  await db.delete(projectMembers).where(inArray(projectMembers.projectId, [projectA, projectB]));
  await db.delete(projects).where(inArray(projects.id, [projectA, projectB]));
  await db.delete(teamMembers).where(inArray(teamMembers.teamId, [teamA, teamB]));
  await db.delete(teams).where(inArray(teams.id, [teamA, teamB]));
  await db.delete(users).where(sql`${users.email} LIKE ${"%@" + PREFIX + ".example"}`);
  await app.close();
});

// ---------------------------------------------------------------------------

describe("ADR-0058 — a control's satisfaction is computed from real ledger rows", () => {
  it("is UNSATISFIED with no evidence, SATISFIED once rows exist, and UNSATISFIED again when they are removed", async () => {
    // (1) EMPTY — the control must be red. A pack that reported green here
    // would be reading something other than the ledger.
    const before = await evaluate(packId, { scopeKind: "org", entitlementScope: "org" });
    expect(before.statusCode).toBe(201);
    const c0 = control(before.json().scorecard, "acme:1.1-decisions-are-logged");
    expect(c0.status).toBe("unsatisfied");
    expect(c0.evidenceCount).toBe(0);

    // (2) SEED THE EVIDENCE — real rows, in the real ledger, in the period
    await evidenceRows(leadA, projectA, 3);
    const during = await evaluate(packId, { scopeKind: "org", entitlementScope: "org" });
    const c1 = control(during.json().scorecard, "acme:1.1-decisions-are-logged");
    expect(c1.status).toBe("satisfied");
    expect(c1.evidenceCount).toBe(3);

    // the threshold is COMPARED, not ignored: the same 3 rows leave a
    // 10000-row control unsatisfied
    const c1hi = control(during.json().scorecard, "acme:1.2-decisions-at-volume");
    expect(c1hi.status).toBe("unsatisfied");
    expect(c1hi.evidenceCount).toBe(3);

    // (3) REMOVE IT — and the control goes red again with no other change
    await db.delete(auditLog).where(eq(auditLog.ruleId, `${PREFIX}-evidence`));
    const after = await evaluate(packId, { scopeKind: "org", entitlementScope: "org" });
    const c2 = control(after.json().scorecard, "acme:1.1-decisions-are-logged");
    expect(c2.status).toBe("unsatisfied");
    expect(c2.evidenceCount).toBe(0);
  });

  it("stores the artifact with the pack VERSION that produced it", async () => {
    const res = await evaluate(packId, { scopeKind: "org", entitlementScope: "org" });
    const reportId = res.json().report.id;
    const [row] = await db
      .select()
      .from(compliancePackReports)
      .where(eq(compliancePackReports.id, reportId));
    expect(row!.packVersion).toBe(1);
    expect(row!.framework).toBe(CUSTOM_FRAMEWORK);
  });
});

describe("ADR-0058 — an organisational control is never auto-satisfied", () => {
  it("reports attestation-required, not satisfied, even with the ledgers full", async () => {
    await evidenceRows(leadA, projectA, 5);
    const res = await evaluate(packId, { scopeKind: "org", entitlementScope: "org" });
    const sc = res.json().scorecard;
    const c = control(sc, "acme:9.9-staff-are-trained");
    expect(c.status).toBe("attestation_required");
    expect(c.status).not.toBe("satisfied");
    expect(c.evidenceCount).toBeNull();
    expect(c.note).toMatch(/ATTESTATION REQUIRED/);
    // and it is NOT counted among the satisfied
    expect(sc.totals.attestationRequired).toBe(1);
    expect(sc.totals.satisfied).toBe(1); // only the audit_decisions control
    await db.delete(auditLog).where(eq(auditLog.ruleId, `${PREFIX}-evidence`));
  });

  it("becomes 'attested' — a status distinct from 'satisfied' — once a named human attests", async () => {
    const att = await post(`/v1/compliance/packs/${packId}/attestations`, {
      controlRef: "acme:9.9-staff-are-trained",
      statement: "All operators completed the 2026 AI-use training; records in the LMS.",
    });
    expect(att.statusCode).toBe(201);

    const res = await evaluate(packId, { scopeKind: "org", entitlementScope: "org" });
    const sc = res.json().scorecard;
    const c = control(sc, "acme:9.9-staff-are-trained");
    expect(c.status).toBe("attested");
    expect(c.status).not.toBe("satisfied");
    expect(sc.totals.attested).toBe(1);
    // the crux: an attestation does NOT move the satisfied count
    expect(sc.totals.satisfied).toBe(0);
    expect((c.attestation as { statement: string }).statement).toMatch(/2026 AI-use training/);

    await db
      .delete(compliancePackAttestations)
      .where(eq(compliancePackAttestations.packId, packId));
  });

  it("REFUSES an attestation on an auto-evidenced control, and audits the refusal", async () => {
    const res = await post(`/v1/compliance/packs/${packId}/attestations`, {
      controlRef: "acme:1.1-decisions-are-logged",
      statement: "trust me, everything is logged",
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("control_is_auto_evidenced");

    const denies = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.ruleId, COMPLIANCE_PACK_RULE_IDS.attestationRecorded),
          eq(auditLog.effect, "deny"),
        ),
      );
    expect(denies.length).toBeGreaterThan(0);

    // and nothing was written
    const rows = await db
      .select()
      .from(compliancePackAttestations)
      .where(eq(compliancePackAttestations.controlRef, "acme:1.1-decisions-are-logged"));
    expect(rows).toHaveLength(0);
  });
});

describe("ADR-0058 — a pack added as DATA is evaluated with no code change", () => {
  it("evaluates a framework that appears nowhere in this repository's source", async () => {
    const res = await get(`/v1/compliance/packs/${packId}`);
    expect(res.statusCode).toBe(200);
    expect(res.json().pack.framework).toBe(CUSTOM_FRAMEWORK);
    expect(res.json().controls).toHaveLength(3);

    const ev = await evaluate(packId, { scopeKind: "org", entitlementScope: "org" });
    expect(ev.json().scorecard.framework).toBe(CUSTOM_FRAMEWORK);
    expect(ev.json().scorecard.totals.controls).toBe(3);
  });

  it("activating a NEW VERSION retires the previous one — a framework revision needs no release", async () => {
    const v2 = await post("/v1/compliance/packs", {
      ...TEST_PACK,
      version: 2,
      title: "ACME internal AI standard v2 (revised catalogue)",
      controls: [
        {
          controlRef: "acme:1.1-decisions-are-logged",
          title: "Every governed decision is recorded (revised wording)",
          coverage: "enforced",
          collector: "audit_decisions",
          collectorParams: { ruleIdPrefix: `${PREFIX}-evidence` },
          minEvidenceCount: 1,
          attestationRequired: false,
          ownerNote: null,
        },
      ],
    });
    expect(v2.statusCode).toBe(201);
    const v2Id = v2.json().pack.id as string;
    const act = await post(`/v1/compliance/packs/${v2Id}/activate`, {});
    expect(act.statusCode).toBe(200);
    expect(act.json().retired.version).toBe(1);

    const list = await get(`/v1/compliance/packs?framework=${CUSTOM_FRAMEWORK}`);
    const packsByVersion = new Map(
      (list.json().packs as Array<{ version: number; status: string }>).map((p) => [p.version, p.status]),
    );
    expect(packsByVersion.get(1)).toBe("retired");
    expect(packsByVersion.get(2)).toBe("active");

    // AND the artifact generated under v1 still says v1 — a revision does not
    // rewrite a report an auditor was already handed
    const old = await db
      .select()
      .from(compliancePackReports)
      .where(eq(compliancePackReports.packId, packId));
    expect(old.length).toBeGreaterThan(0);
    for (const r of old) expect(r.packVersion).toBe(1);

    // put the fixture back so later tests still see v1 active
    await db.delete(compliancePackControls).where(eq(compliancePackControls.packId, v2Id));
    await db.delete(compliancePacks).where(eq(compliancePacks.id, v2Id));
    await db
      .update(compliancePacks)
      .set({ status: "active", retiredAt: null })
      .where(eq(compliancePacks.id, packId));
  });

  it("seeds the six launch packs as ROWS, idempotently", async () => {
    const first = await post("/v1/compliance/packs/seed", {});
    expect(first.statusCode).toBe(201);
    expect(first.json().created.length).toBe(DEFAULT_COMPLIANCE_PACKS.length);
    const second = await post("/v1/compliance/packs/seed", {});
    expect(second.json().created).toHaveLength(0);
    expect(second.json().skipped.length).toBe(DEFAULT_COMPLIANCE_PACKS.length);

    // every seeded pack carries at least one attestation-required control —
    // the honest "this is where the platform stops" marker
    const rows = await db
      .select()
      .from(compliancePacks)
      .where(inArray(compliancePacks.framework, DEFAULT_COMPLIANCE_PACKS.map((p) => p.framework)));
    expect(rows.length).toBe(DEFAULT_COMPLIANCE_PACKS.length);
    for (const p of rows) {
      const controls = await db
        .select()
        .from(compliancePackControls)
        .where(eq(compliancePackControls.packId, p.id));
      expect(controls.some((c) => c.attestationRequired)).toBe(true);
    }
  });
});

describe("ADR-0058 — entitlement scoping: a pack report never leaks another team's evidence", () => {
  it("counts only the caller's own project's rows, not the org-wide sum", async () => {
    await evidenceRows(leadA, projectA, 2);
    await evidenceRows(leadA, projectB, 7); // seeded in the OTHER team's project

    const LEAD = { authorization: `Bearer ${leadAKey}` };
    const res = await evaluate(
      packId,
      { scopeKind: "team", scopeId: teamA, entitlementScope: "team" },
      LEAD,
    );
    expect(res.statusCode).toBe(201);
    const sc = res.json().scorecard;
    const c = control(sc, "acme:1.1-decisions-are-logged");
    // EXACTLY the two rows in project A. Not 9. Not 7.
    expect(c.evidenceCount).toBe(2);
    expect(res.json().scope.effectiveProjectIds).toEqual([projectA]);

    // the admin, org-scoped, sees all nine — which is what makes the 2 above a
    // narrowing rather than an accident of an empty ledger
    const asAdmin = await evaluate(packId, { scopeKind: "org", entitlementScope: "org" });
    expect(control(asAdmin.json().scorecard, "acme:1.1-decisions-are-logged").evidenceCount).toBe(9);

    await db.delete(auditLog).where(eq(auditLog.ruleId, `${PREFIX}-evidence`));
  });

  it("refuses an org-scoped evaluation from a non-admin, and audits the refusal", async () => {
    const LEAD = { authorization: `Bearer ${leadAKey}` };
    const res = await evaluate(packId, { scopeKind: "org", entitlementScope: "org" }, LEAD);
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("pack_scope_not_entitled");

    const denies = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.ruleId, COMPLIANCE_PACK_RULE_IDS.evaluationDenied));
    expect(denies.length).toBeGreaterThan(0);
    expect(denies.some((d) => d.userId === leadA)).toBe(true);
  });

  it("refuses to hand a non-admin an artifact generated at a wider scope", async () => {
    const admin = await evaluate(packId, { scopeKind: "org", entitlementScope: "org" });
    const reportId = admin.json().report.id;
    const LEAD = { authorization: `Bearer ${leadAKey}` };
    const res = await get(`/v1/compliance/pack-reports/${reportId}`, LEAD);
    expect(res.statusCode).toBe(403);
  });
});

describe("ADR-0058 — the artifact never claims compliance", () => {
  it("carries the disclaimer, says it is not a certification, and has no verdict field", async () => {
    const res = await evaluate(packId, { scopeKind: "org", entitlementScope: "org" });
    const sc = res.json().scorecard;
    expect(sc.disclaimer).toBe(COMPLIANCE_PACK_DISCLAIMER);
    expect(sc.disclaimer).toMatch(/not a compliance certification/i);
    expect(sc.statement).toMatch(/NOT a compliance verdict/);
    expect(sc.updatePolicy).toMatch(/A pack is rows, not a build artifact/);
    // there is no verdict to emit into
    expect(sc).not.toHaveProperty("compliant");
    expect(sc).not.toHaveProperty("verdict");
    expect(JSON.stringify(sc)).not.toMatch(/"status":"compliant"/);
  });

  it("audits the evaluation with the effective scope it was permitted to query", async () => {
    const rows = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.ruleId, COMPLIANCE_PACK_RULE_IDS.evaluated));
    expect(rows.length).toBeGreaterThan(0);
    const latest = rows[rows.length - 1]!;
    expect(latest.reason).toMatch(/CONTROL-MAPPING/);
    expect(latest.detail).toHaveProperty("effectiveProjectIds");
  });
});

describe("ADR-0058 — ADR-0047's placeholder catalogue is retired", () => {
  it("a report definition naming a pack gets the pack's real, ledger-evidenced controls", async () => {
    await evidenceRows(leadA, projectA, 4);
    const def = await post("/v1/reports/definitions", {
      name: `${PREFIX}-pack-backed-report`,
      kind: "compliance",
      scopeKind: "org",
      entitlementScope: "org",
      sections: ["controls"],
      packId,
    });
    expect(def.statusCode).toBe(201);
    const defId = def.json().definition.id as string;
    const gen = await post(`/v1/reports/definitions/${defId}/generate`, { period: PERIOD });
    expect(gen.statusCode).toBe(201);
    const controls = gen.json().report.controls;
    expect(controls.catalogueSource).toBe("pack");
    expect(controls.packVersion).toBe(1);
    expect(controls.framework).toBe(CUSTOM_FRAMEWORK);
    expect(controls.note).toMatch(/not a compliance certification/i);
    // the pack's own numbers, from the ledger
    expect(controls.met).toBe(1);
    expect(controls.attestationRequired).toBe(1);

    await db.delete(auditLog).where(eq(auditLog.ruleId, `${PREFIX}-evidence`));
    await app.inject({ method: "DELETE", url: `/v1/reports/definitions/${defId}`, headers: ADMIN });
  });

  it("a definition naming NO pack gets the built-in FALLBACK, and it says so", async () => {
    const def = await post("/v1/reports/definitions", {
      name: `${PREFIX}-fallback-report`,
      kind: "compliance",
      scopeKind: "org",
      entitlementScope: "org",
      sections: ["controls"],
    });
    const defId = def.json().definition.id as string;
    const gen = await post(`/v1/reports/definitions/${defId}/generate`, { period: PERIOD });
    const controls = gen.json().report.controls;
    expect(controls.catalogueSource).toBe("built-in");
    expect(controls.note).toMatch(/FALLBACK CATALOGUE/);
    expect(controls.note).toMatch(/ADR-0058/);
    await app.inject({ method: "DELETE", url: `/v1/reports/definitions/${defId}`, headers: ADMIN });
  });
});
