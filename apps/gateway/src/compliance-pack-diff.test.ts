/**
 * ADR-0087 — the pack-version diff + impact preview, proved by attack.
 *
 * WHAT THIS FILE TRIES TO MAKE IMPOSSIBLE TO FAKE
 * ----------------------------------------------
 *  1. A DIFF THAT READS THE WRONG THING. v1 and v2 of a framework nobody
 *     shipped differ in every kind at once — a control added, one removed,
 *     one changed on threshold/coverage/ownerNote, the pack retitled and its
 *     cascadeTag changed — and each kind is asserted present, with the
 *     cascadeTag change flagged HIGH-consequence.
 *  2. AN IMPACT PREVIEW THAT PREDICTS INSTEAD OF MEASURING. Evidence rows are
 *     seeded so the SAME ledger satisfies v1's threshold and fails v2's
 *     higher one; the preview must report satisfied→unsatisfied for that
 *     control, null→computed for the added one, computed→null for the removed
 *     one. If the second evaluation were a copy of the first, these assertions
 *     redden — proven by the M-002 sabotage run.
 *  3. A "READ-ONLY" ENDPOINT THAT WRITES STATE. Asserted by DELTAS (M-008):
 *     zero new pack-report rows, pack statuses unmoved, and exactly one
 *     append-only audit row per diff call (the row the activation audit later
 *     consults).
 *  4. AN ACTIVATION AUDIT THAT FLATTERS. Activating v2 after the 1→2 diff was
 *     computed records diffComputed: true; activating v3 with no diff ever
 *     computed records false; the very first activation (nothing to diff
 *     against) records null — never a fabricated true.
 *  5. IMPLIED CHANGE WHERE THERE IS NONE. Diffing a version against itself
 *     says identical + evaluationIdentical in so many words.
 *
 * SHARED-STATE DISCIPLINE: everything this suite creates is deleted in
 * afterAll, and audit-row cleanup is scoped to THIS suite's framework so a
 * neighbouring pack suite's rows are never touched.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  and,
  auditLog,
  compliancePackControls,
  compliancePackReports,
  compliancePacks,
  createDb,
  eq,
  inArray,
  runMigrations,
  sql,
  users,
  type Db,
} from "@regulait/db";
import { COMPLIANCE_PACK_RULE_IDS } from "./compliance-packs.js";

const { buildApp } = await import("./app.js");

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "cpackdiff-bootstrap-token";
const ADMIN = { authorization: `Bearer ${BOOT}` };
const PREFIX = "cpackdiff-test";
const FRAMEWORK = "acme-diff-standard";

let db: Db;
let app: ReturnType<typeof buildApp>;
let evidenceUser: string;
let nonAdminKey: string;
let v1Id: string;
let v2Id: string;

const post = (url: string, payload: unknown, headers = ADMIN) =>
  app.inject({ method: "POST", url, headers, payload: payload as object });
const get = (url: string, headers = ADMIN) => app.inject({ method: "GET", url, headers });

const diffUrl = (from: number, to: number) =>
  `/v1/compliance-packs/${FRAMEWORK}/diff?from=${from}&to=${to}`;

const CONTROL_KEPT = {
  // v1 threshold 1 → v2 threshold 10: the CC6.6-shaped case — same ledger,
  // satisfied under v1, unsatisfied under v2's higher bar
  controlRef: "diff:1.1-decisions-logged",
  title: "Every governed decision is recorded",
  coverage: "enforced" as const,
  collector: "audit_decisions" as const,
  collectorParams: { ruleIdPrefix: `${PREFIX}-evidence` },
  minEvidenceCount: 1,
  attestationRequired: false,
  ownerNote: null,
};
const CONTROL_REMOVED = {
  controlRef: "diff:2.2-removed-in-v2",
  title: "A control the revision drops",
  coverage: "evidenced" as const,
  collector: "audit_decisions" as const,
  collectorParams: { ruleIdPrefix: `${PREFIX}-evidence` },
  minEvidenceCount: 1,
  attestationRequired: false,
  ownerNote: null,
};
const CONTROL_ORG = {
  controlRef: "diff:9.9-staff-trained",
  title: "Staff operating the system are trained",
  coverage: "unaddressed" as const,
  collector: "none" as const,
  collectorParams: {},
  minEvidenceCount: 1,
  attestationRequired: true,
  ownerNote: "Training records live in the customer's LMS.",
};

const V1_PACK = {
  framework: FRAMEWORK,
  version: 1,
  title: "ACME diff standard",
  description: "v1 of a framework that exists nowhere in this repository's source.",
  provenance: { source: "authored by the diff test suite", reviewedBy: null },
  cascadeTag: null,
  controls: [CONTROL_KEPT, CONTROL_REMOVED, CONTROL_ORG],
};

const V2_PACK = {
  framework: FRAMEWORK,
  version: 2,
  title: "ACME diff standard (rev. 2027)",
  description: "v1 of a framework that exists nowhere in this repository's source.",
  provenance: { source: "authored by the diff test suite", reviewedBy: null },
  cascadeTag: "acme-diff-restricted",
  controls: [
    {
      ...CONTROL_KEPT,
      title: "Every governed decision is recorded and reviewed",
      coverage: "evidenced" as const,
      minEvidenceCount: 10,
      ownerNote: "Review cadence is the customer's own process.",
    },
    {
      controlRef: "diff:3.3-added-in-v2",
      title: "New obligation the revision introduces",
      coverage: "evidenced" as const,
      collector: "audit_decisions" as const,
      collectorParams: { ruleIdPrefix: `${PREFIX}-new` },
      minEvidenceCount: 1,
      attestationRequired: false,
      ownerNote: null,
    },
    CONTROL_ORG,
  ],
};

async function evidenceRows(n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await db.insert(auditLog).values({
      userId: evidenceUser,
      objectType: "agent",
      objectId: null,
      detail: { projectId: randomUUID() },
      effect: "allow",
      ruleId: `${PREFIX}-evidence`,
      ruleChain: [],
      reason: "seeded evidence row for the pack-diff impact preview",
    });
  }
}

function impactControl(
  impact: { controls: Array<{ controlRef: string }> },
  ref: string,
): {
  controlRef: string;
  definitionChange: string;
  fromStatus: string | null;
  toStatus: string | null;
  fromEvidenceCount: number | null;
  toEvidenceCount: number | null;
  moved: boolean;
  detail: string | null;
} {
  const c = impact.controls.find((x) => x.controlRef === ref);
  if (!c) throw new Error(`impact preview has no entry for ${ref}`);
  return c as ReturnType<typeof impactControl>;
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT });
  await app.ready();

  const res = await post("/v1/users", {
    email: `${PREFIX}-viewer@${PREFIX}.example`,
    displayName: `${PREFIX}-viewer`,
  });
  expect(res.statusCode).toBe(201);
  evidenceUser = res.json().id as string;
  const key = await post(`/v1/users/${evidenceUser}/keys`, { name: "cpackdiff" });
  nonAdminKey = key.json().token as string;

  const v1 = await post("/v1/compliance/packs", V1_PACK);
  expect(v1.statusCode).toBe(201);
  v1Id = v1.json().pack.id;
  const v2 = await post("/v1/compliance/packs", V2_PACK);
  expect(v2.statusCode).toBe(201);
  v2Id = v2.json().pack.id;

  // v1 is the ACTIVE version — the thing v2 would be reviewed against
  const act = await post(`/v1/compliance/packs/${v1Id}/activate`, {});
  expect(act.statusCode).toBe(200);
});

afterAll(async () => {
  const packIds = (
    await db
      .select({ id: compliancePacks.id })
      .from(compliancePacks)
      .where(eq(compliancePacks.framework, FRAMEWORK))
  ).map((r) => r.id);
  if (packIds.length) {
    await db.delete(compliancePackReports).where(inArray(compliancePackReports.packId, packIds));
    await db.delete(compliancePackControls).where(inArray(compliancePackControls.packId, packIds));
    await db.delete(compliancePacks).where(inArray(compliancePacks.id, packIds));
  }
  await db.delete(auditLog).where(sql`${auditLog.ruleId} LIKE ${PREFIX + "%"}`);
  // scoped to THIS suite's framework — never the neighbouring pack suite's rows
  await db
    .delete(auditLog)
    .where(
      and(
        inArray(auditLog.ruleId, Object.values(COMPLIANCE_PACK_RULE_IDS) as string[]),
        sql`${auditLog.detail} ->> 'framework' = ${FRAMEWORK}`,
      ),
    );
  await db.delete(users).where(sql`${users.email} LIKE ${"%@" + PREFIX + ".example"}`);
  await app.close();
});

// ---------------------------------------------------------------------------

describe("ADR-0087 — the structured diff of two pack versions", () => {
  it("reports added / removed / changed controls with per-field before/after", async () => {
    const res = await get(diffUrl(1, 2));
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.from.version).toBe(1);
    expect(body.to.version).toBe(2);
    expect(body.to.status).toBe("draft"); // NOTHING activated by looking

    const d = body.diff;
    expect(d.identical).toBe(false);
    expect(d.controlsAdded.map((c: { controlRef: string }) => c.controlRef)).toEqual([
      "diff:3.3-added-in-v2",
    ]);
    expect(d.controlsRemoved.map((c: { controlRef: string }) => c.controlRef)).toEqual([
      "diff:2.2-removed-in-v2",
    ]);
    expect(d.controlsChanged.map((c: { controlRef: string }) => c.controlRef)).toEqual([
      "diff:1.1-decisions-logged",
    ]);

    const fields = new Map(
      (d.controlsChanged[0].fields as Array<{ field: string; from: unknown; to: unknown }>).map(
        (f) => [f.field, f],
      ),
    );
    expect(fields.get("minEvidenceCount")).toEqual({ field: "minEvidenceCount", from: 1, to: 10 });
    expect(fields.get("coverage")).toEqual({ field: "coverage", from: "enforced", to: "evidenced" });
    expect(fields.get("ownerNote")!.from).toBeNull();
    expect(fields.has("collector")).toBe(false); // equal fields are not listed

    expect(d.summary).toMatchObject({
      controlsAdded: 1,
      controlsRemoved: 1,
      controlsChanged: 1,
      controlsUnchanged: 1, // the attestation-required control is untouched
      cascadeTagChanged: true,
    });
    expect(d.packChanges.map((c: { field: string }) => c.field)).toContain("title");
    expect(body.disclaimer).toMatch(/not a compliance certification/i);
  });

  it("flags the cascadeTag change as HIGH consequence — it is §8.3 reach, not prose", async () => {
    const d = (await get(diffUrl(1, 2))).json().diff;
    expect(d.cascadeTagChange).not.toBeNull();
    expect(d.cascadeTagChange.consequence).toBe("HIGH");
    expect(d.cascadeTagChange.from).toBeNull();
    expect(d.cascadeTagChange.to).toBe("acme-diff-restricted");
    expect(d.cascadeTagChange.note).toMatch(/cascade/);
  });

  it("404s with invalid_reference for a version or framework that does not exist", async () => {
    const noTo = await get(diffUrl(1, 99));
    expect(noTo.statusCode).toBe(404);
    expect(noTo.json().error).toBe("invalid_reference");
    expect(noTo.json().detail).toMatch(/version 99/);

    const noFrom = await get(diffUrl(99, 2));
    expect(noFrom.statusCode).toBe(404);
    expect(noFrom.json().error).toBe("invalid_reference");

    const noFw = await get(`/v1/compliance-packs/no-such-framework/diff?from=1&to=2`);
    expect(noFw.statusCode).toBe(404);
    expect(noFw.json().error).toBe("invalid_reference");
  });

  it("is admin-only via the default gate", async () => {
    const res = await get(diffUrl(1, 2), { authorization: `Bearer ${nonAdminKey}` });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("admin_only");
  });
});

describe("ADR-0087 — the impact preview measures, against the CURRENT ledgers", () => {
  it("reports which computed statuses would move: same ledger, both versions, real evaluator", async () => {
    // 3 rows: enough for v1's threshold of 1, not for v2's threshold of 10
    await evidenceRows(3);
    const res = await get(diffUrl(1, 2));
    expect(res.statusCode).toBe(200);
    const impact = res.json().impact;

    // the CC6.6-shaped move: satisfied under v1, unsatisfied under v2's
    // higher threshold — SAME rows, SAME period
    const kept = impactControl(impact, "diff:1.1-decisions-logged");
    expect(kept.definitionChange).toBe("changed");
    expect(kept.fromStatus).toBe("satisfied");
    expect(kept.toStatus).toBe("unsatisfied");
    expect(kept.fromEvidenceCount).toBe(3);
    expect(kept.toEvidenceCount).toBe(3);
    expect(kept.moved).toBe(true);
    expect(kept.detail).toMatch(/satisfied under v1 → unsatisfied under v2/);

    // the removed control: computed under v1, gone under v2
    const removed = impactControl(impact, "diff:2.2-removed-in-v2");
    expect(removed.definitionChange).toBe("removed");
    expect(removed.fromStatus).toBe("satisfied");
    expect(removed.toStatus).toBeNull();
    expect(removed.moved).toBe(true);

    // the added control: no v1 status, computed fresh under v2 (its own
    // rule-id prefix has no rows, so it lands unsatisfied — a NEW obligation
    // arriving red, which is exactly what the admin should see)
    const added = impactControl(impact, "diff:3.3-added-in-v2");
    expect(added.definitionChange).toBe("added");
    expect(added.fromStatus).toBeNull();
    expect(added.toStatus).toBe("unsatisfied");
    expect(added.moved).toBe(true);

    // the untouched organisational control does not move
    const org = impactControl(impact, "diff:9.9-staff-trained");
    expect(org.fromStatus).toBe("attestation_required");
    expect(org.toStatus).toBe("attestation_required");
    expect(org.moved).toBe(false);

    expect(impact.statusesMoved).toBe(3);
    expect(impact.evaluationIdentical).toBe(false);
    // honesty about what this is: current ledgers at request time, not the future
    expect(impact.note).toMatch(/request time, not the future/);

    await db.delete(auditLog).where(eq(auditLog.ruleId, `${PREFIX}-evidence`));
  });

  it("says IDENTICAL rather than implying change when nothing would move", async () => {
    const res = await get(diffUrl(1, 1));
    expect(res.statusCode).toBe(200);
    expect(res.json().diff.identical).toBe(true);
    expect(res.json().impact.statusesMoved).toBe(0);
    expect(res.json().impact.evaluationIdentical).toBe(true);
    expect(res.json().impact.note).toMatch(/evaluate IDENTICALLY/);
  });

  it("is read-only: no report row, no status change — DELTAS, one audit row per call", async () => {
    const reportsBefore = (
      await db
        .select({ id: compliancePackReports.id })
        .from(compliancePackReports)
        .where(eq(compliancePackReports.framework, FRAMEWORK))
    ).length;
    const auditBefore = (
      await db
        .select({ id: auditLog.id })
        .from(auditLog)
        .where(eq(auditLog.ruleId, COMPLIANCE_PACK_RULE_IDS.diffComputed))
    ).length;

    const res = await get(diffUrl(1, 2));
    expect(res.statusCode).toBe(200);

    const reportsAfter = (
      await db
        .select({ id: compliancePackReports.id })
        .from(compliancePackReports)
        .where(eq(compliancePackReports.framework, FRAMEWORK))
    ).length;
    expect(reportsAfter - reportsBefore).toBe(0); // a diff stores NO artifact

    const [v1Row] = await db.select().from(compliancePacks).where(eq(compliancePacks.id, v1Id));
    const [v2Row] = await db.select().from(compliancePacks).where(eq(compliancePacks.id, v2Id));
    expect(v1Row!.status).toBe("active"); // nothing activated
    expect(v2Row!.status).toBe("draft");

    // the ONE write: the append-only audit row the activation audit consults
    const auditAfter = (
      await db
        .select({ id: auditLog.id })
        .from(auditLog)
        .where(eq(auditLog.ruleId, COMPLIANCE_PACK_RULE_IDS.diffComputed))
    ).length;
    expect(auditAfter - auditBefore).toBe(1);
  });
});

describe("ADR-0087 — activation records whether a diff was computed, honestly", () => {
  const activationRows = async () =>
    (
      await db
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.ruleId, COMPLIANCE_PACK_RULE_IDS.packActivated),
            sql`${auditLog.detail} ->> 'framework' = ${FRAMEWORK}`,
          ),
        )
    ).sort((a, b) => a.at.getTime() - b.at.getTime());

  it("the first activation (nothing to diff against) recorded null, not a fabricated boolean", async () => {
    const rows = await activationRows();
    expect(rows.length).toBeGreaterThan(0);
    expect((rows[0]!.detail as { diffComputed: boolean | null }).diffComputed).toBeNull();
  });

  it("activating v2 after the 1→2 diff was computed records diffComputed: true — and was never gated on it", async () => {
    const act = await post(`/v1/compliance/packs/${v2Id}/activate`, {});
    expect(act.statusCode).toBe(200); // no "view the diff first" ceremony
    expect(act.json().retired.version).toBe(1);

    const rows = await activationRows();
    const latest = rows[rows.length - 1]!;
    expect(latest.detail).toMatchObject({
      framework: FRAMEWORK,
      version: 2,
      supersededVersion: 1,
      diffComputed: true,
    });
  });

  it("activating a version whose from→to diff was NEVER computed records false", async () => {
    const v3 = await post("/v1/compliance/packs", {
      ...V1_PACK,
      version: 3,
      title: "ACME diff standard v3 (activated blind, on purpose)",
      controls: [CONTROL_ORG],
    });
    expect(v3.statusCode).toBe(201);
    const act = await post(`/v1/compliance/packs/${v3.json().pack.id}/activate`, {});
    expect(act.statusCode).toBe(200);
    expect(act.json().retired.version).toBe(2);

    const rows = await activationRows();
    const latest = rows[rows.length - 1]!;
    expect(latest.detail).toMatchObject({ version: 3, supersededVersion: 2, diffComputed: false });
  });
});
