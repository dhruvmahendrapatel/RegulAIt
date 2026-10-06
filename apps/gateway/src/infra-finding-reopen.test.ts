import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  and,
  auditLog,
  createDb,
  eq,
  infraFindings,
  runMigrations,
  sql,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";

/**
 * ADR-0114 — a re-scan that observes the SAME signature on a finding whose
 * status CLAIMS the problem is resolved RE-OPENS it, and audits the
 * contradiction.
 *
 * ADR-0110 made the backup LEDGER row re-open on the next scan; the FINDING
 * did not follow, so a restore that reported success over a live gap left the
 * finding reading `remediated`. The precedent that makes that an
 * inconsistency rather than a trade-off is already in `infra.ts`: a cert
 * rotation that FAILS at the provider re-opens its finding, "never silently
 * closed".
 *
 * The four claims under test, each with its own per-run fixture:
 *   1. `remediated` + same signature      -> RE-OPENS, contradiction audited
 *      with the prior status recorded.
 *   2. `accepted_risk` + same signature   -> does NOT re-open, and writes NO
 *      contradiction row. Both halves asserted.
 *   3. signature NO LONGER observed       -> untouched: no re-open, no row.
 *   4. a DIFFERENT signature on the same resource+kind -> still creates a NEW
 *      finding rather than re-opening the old one (existing behaviour).
 *
 * Shares one database with the other gateway suites (fileParallelism off), so
 * every object here is name-prefixed `reop-` and carries a per-run token; every
 * count is a DELTA over a scoped query, never an absolute table count.
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "reop-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
/** per-run token: signatures are derived from the resource NAME by the mock
 * provider, so a unique name is a unique signature on a shared database. */
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

let db: Db;
let app: ReturnType<typeof buildApp>;
let adminAuth: { authorization: string };
let approverId: string;
let approverAuth: { authorization: string };

async function makeUser(email: string, displayName: string, isAdmin: boolean) {
  const u = await app.inject({
    method: "POST",
    url: "/v1/users",
    headers: AUTH,
    payload: { email, displayName, isAdmin },
  });
  const id = u.json().id as string;
  const k = await app.inject({
    method: "POST",
    url: `/v1/users/${id}/keys`,
    headers: AUTH,
    payload: { name: "reop" },
  });
  return { id, auth: { authorization: `Bearer ${k.json().token}` } };
}

/** a cert resource: the mock emits exactly ONE report, signature
 * `cert_expiring:<name>`, stable across scans. */
async function makeCertResource(name: string, daysUntilExpiry: number) {
  const r = await app.inject({
    method: "POST",
    url: "/v1/infra/resources",
    headers: adminAuth,
    payload: { name, kind: "cert", config: { daysUntilExpiry } },
  });
  expect(r.statusCode).toBe(201);
  return r.json().id as string;
}

/** scan ONE resource — never the fleet; other suites share this database. */
async function scanOne(resourceId: string) {
  const r = await app.inject({
    method: "POST",
    url: "/v1/infra/scan",
    headers: adminAuth,
    payload: { resourceId },
  });
  expect(r.statusCode).toBe(200);
  return r.json() as {
    scanned: number;
    created: number;
    autoRemediated: number;
    refreshed: number;
    reopened: number;
  };
}

async function findingFor(resourceId: string) {
  const rows = await db.select().from(infraFindings).where(eq(infraFindings.resourceId, resourceId));
  expect(rows).toHaveLength(1); // positive: the fixture really produced one
  return rows[0]!;
}

/** every `infra-finding-reopened` audit row for ONE finding — scoped, so the
 * assertions are deltas on this fixture and not a table-wide count. */
async function reopenRowsFor(findingId: string) {
  return db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.ruleId, "infra-finding-reopened"), eq(auditLog.objectId, findingId)));
}

/** drive the finding to `remediated` through the REAL governed path: propose a
 * remediation, then approve it. The mock provider "remediates" without
 * changing what a scan observes — which is precisely the scenario: a
 * remediation that reported success over a gap that is still live. */
async function remediateViaApproval(findingId: string) {
  const prop = await app.inject({
    method: "POST",
    url: `/v1/infra/findings/${findingId}/remediate`,
    headers: adminAuth,
    payload: { approverUserId: approverId },
  });
  expect(prop.statusCode).toBe(202);
  const approvalId = prop.json().approvalId as string;
  const dec = await app.inject({
    method: "POST",
    url: `/v1/approvals/${approvalId}/decide`,
    headers: approverAuth,
    payload: { decision: "approved" },
  });
  expect(dec.statusCode).toBe(200);
}

async function denyViaApproval(findingId: string) {
  const prop = await app.inject({
    method: "POST",
    url: `/v1/infra/findings/${findingId}/remediate`,
    headers: adminAuth,
    payload: { approverUserId: approverId },
  });
  expect(prop.statusCode).toBe(202);
  const approvalId = prop.json().approvalId as string;
  const dec = await app.inject({
    method: "POST",
    url: `/v1/approvals/${approvalId}/decide`,
    headers: approverAuth,
    payload: { decision: "denied" },
  });
  expect(dec.statusCode).toBe(200);
}

let restoreAdminKeyMfa: (() => Promise<void>) | undefined;
beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  // ADR-0181 (FX2): an admin's API key now answers to mfaRequired. This suite
  // drives admins through keys and is not about MFA, so it relaxes the dial
  // explicitly and hands the shared database back strict in afterAll (M-068).
  restoreAdminKeyMfa = await relaxIdentityForTest(db, { mfaRequired: "off" });
  app = buildApp(db, { bootstrapToken: BOOT });
  const admin = await makeUser(`reop-admin-${RUN}@example.com`, "Reop Admin", true);
  adminAuth = admin.auth;
  const approver = await makeUser(`reop-approver-${RUN}@example.com`, "Reop Approver", false);
  approverId = approver.id;
  approverAuth = approver.auth;
});

describe("ADR-0114 — a remediation contradicted by the next scan re-opens its finding", () => {
  it("a `remediated` finding whose signature is observed AGAIN re-opens, and the contradiction is audited with the prior status", async () => {
    const name = `reop-remediated-${RUN}`;
    const resourceId = await makeCertResource(name, 5);

    const first = await scanOne(resourceId);
    expect(first.created).toBe(1);
    expect(first.reopened).toBe(0); // a brand-new finding contradicts nothing

    const finding = await findingFor(resourceId);
    expect(finding.status).toBe("open");
    expect((finding.detail as Record<string, unknown>).signature).toBe(`cert_expiring:${name}`);
    const detectedBeforeClose = finding.detectedAt;

    // the governed remediation reports success...
    await remediateViaApproval(finding.id);
    const closed = await findingFor(resourceId);
    expect(closed.status).toBe("remediated"); // positive: the close really happened
    expect(await reopenRowsFor(finding.id)).toHaveLength(0); // nothing audited yet

    // ...and the very next scan still sees the SAME signature.
    const second = await scanOne(resourceId);
    expect(second.reopened).toBe(1);
    expect(second.created).toBe(0); // re-opened IN PLACE, not duplicated
    expect(second.refreshed).toBe(1);

    const reopenedFinding = await findingFor(resourceId);
    expect(reopenedFinding.id).toBe(finding.id); // same row
    expect(reopenedFinding.status).toBe("open");

    // the contradiction is an audited fact, with what was CLAIMED, what was
    // OBSERVED, and when the finding was last seen before the close.
    const rows = await reopenRowsFor(finding.id);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.objectType).toBe("infra_operation");
    expect(row.effect).toBe("allow");
    expect(row.detail).toMatchObject({
      phase: "scan",
      resource: name,
      kind: "cert_expiring",
      signature: `cert_expiring:${name}`,
      priorStatus: "remediated",
      reopenedStatus: "open",
      priorDetectedAt: detectedBeforeClose.toISOString(),
    });
    expect(row.reason).toContain("remediated");
    expect(row.reason).toContain(`cert_expiring:${name}`);
    expect(row.reason).toContain("RE-OPENED");

    // and the re-opened finding is genuinely re-proposable — the point of
    // re-opening rather than merely logging.
    const reprop = await app.inject({
      method: "POST",
      url: `/v1/infra/findings/${finding.id}/remediate`,
      headers: adminAuth,
      payload: { approverUserId: approverId },
    });
    expect(reprop.statusCode).toBe(202);
  });

  it("an `accepted_risk` finding whose signature is observed AGAIN does NOT re-open and writes NO contradiction row", async () => {
    const name = `reop-accepted-${RUN}`;
    const resourceId = await makeCertResource(name, 7);

    expect((await scanOne(resourceId)).created).toBe(1);
    const finding = await findingFor(resourceId);
    expect(finding.status).toBe("open");

    // a human decides to live with it
    await denyViaApproval(finding.id);
    const accepted = await findingFor(resourceId);
    expect(accepted.status).toBe("accepted_risk"); // positive: the fixture is real
    const detectedAtAccept = accepted.detectedAt;

    // the scan still sees it — which is EXPECTED, not news
    const second = await scanOne(resourceId);
    expect(second.reopened).toBe(0);
    expect(second.refreshed).toBe(1); // positive: the scan DID match this finding

    const after = await findingFor(resourceId);
    expect(after.id).toBe(finding.id);
    expect(after.status).toBe("accepted_risk"); // half one: status untouched
    // ...and the refresh half of the re-scan still ran, so "untouched status"
    // is a real constraint on a row the scan really wrote, not a row it missed.
    expect(after.detectedAt.getTime()).toBeGreaterThan(detectedAtAccept.getTime());

    // half two: no contradiction row at all for this finding
    expect(await reopenRowsFor(finding.id)).toHaveLength(0);
  });

  it("a finding whose signature is NO LONGER observed is untouched — no re-open, no audit row", async () => {
    const name = `reop-gone-${RUN}`;
    const resourceId = await makeCertResource(name, 9);

    expect((await scanOne(resourceId)).created).toBe(1);
    const finding = await findingFor(resourceId);
    await remediateViaApproval(finding.id);
    expect((await findingFor(resourceId)).status).toBe("remediated");
    const detectedAtClose = (await findingFor(resourceId)).detectedAt;

    // rewrite the stored signature so the scanner's report no longer matches
    // this row: the SAME resource+kind, a signature that is no longer observed.
    await db
      .update(infraFindings)
      .set({ detail: { ...(finding.detail as Record<string, unknown>), signature: `cert_expiring:GONE-${RUN}` } })
      .where(eq(infraFindings.id, finding.id));

    const second = await scanOne(resourceId);
    expect(second.reopened).toBe(0);
    // positive on the same row: the scan DID run and DID do work — it created a
    // fresh finding for the signature it can still see. A scan that silently
    // did nothing would satisfy `reopened === 0` vacuously.
    expect(second.created).toBe(1);
    expect(second.refreshed).toBe(0);

    const [untouched] = await db.select().from(infraFindings).where(eq(infraFindings.id, finding.id));
    expect(untouched!.status).toBe("remediated"); // not re-opened
    expect(untouched!.detectedAt.getTime()).toBe(detectedAtClose.getTime()); // not even refreshed
    expect(await reopenRowsFor(finding.id)).toHaveLength(0);
  });

  it("a DIFFERENT signature on the same resource+kind still creates a NEW finding rather than re-opening the old one", async () => {
    const name = `reop-distinct-${RUN}`;
    const resourceId = await makeCertResource(name, 11);

    // a decoy: same resource, same kind, a signature the scanner never emits,
    // closed as `remediated` so it is an eligible re-open candidate in every
    // respect EXCEPT its signature.
    const decoySignature = `cert_expiring:DECOY-${RUN}`;
    const [decoy] = await db
      .insert(infraFindings)
      .values({
        resourceId,
        kind: "cert_expiring",
        severity: "high",
        detail: { signature: decoySignature, summary: "decoy — never emitted by the scanner" },
        status: "remediated",
      })
      .returning();
    const decoyDetectedAt = decoy!.detectedAt;

    const scan = await scanOne(resourceId);
    // the real signature is unknown here, so it is CREATED, not matched
    expect(scan.created).toBe(1);
    expect(scan.reopened).toBe(0);
    expect(scan.refreshed).toBe(0);

    const rows = await db
      .select()
      .from(infraFindings)
      .where(eq(infraFindings.resourceId, resourceId));
    expect(rows).toHaveLength(2); // the decoy AND a new finding — the whole claim

    const fresh = rows.find((r) => r.id !== decoy!.id)!;
    expect(fresh).toBeTruthy();
    expect((fresh.detail as Record<string, unknown>).signature).toBe(`cert_expiring:${name}`);
    expect(fresh.status).toBe("open");

    const decoyAfter = rows.find((r) => r.id === decoy!.id)!;
    expect(decoyAfter.status).toBe("remediated"); // untouched by the match
    expect(decoyAfter.detectedAt.getTime()).toBe(decoyDetectedAt.getTime());
    expect(await reopenRowsFor(decoy!.id)).toHaveLength(0);
  });

  it("the re-open fires ONCE per false close: a second re-scan of an already re-opened finding writes no further contradiction rows", async () => {
    // This is the flapping bound ADR-0114 claims, asserted rather than argued:
    // `open` does not re-open, so the contradiction is reported on the first
    // scan after the false close and not on every scan thereafter.
    const name = `reop-once-${RUN}`;
    const resourceId = await makeCertResource(name, 13);
    expect((await scanOne(resourceId)).created).toBe(1);
    const finding = await findingFor(resourceId);
    await remediateViaApproval(finding.id);

    expect((await scanOne(resourceId)).reopened).toBe(1);
    expect(await reopenRowsFor(finding.id)).toHaveLength(1);

    const third = await scanOne(resourceId);
    expect(third.reopened).toBe(0);
    expect(third.refreshed).toBe(1); // positive: the scan still matched the row
    expect(await reopenRowsFor(finding.id)).toHaveLength(1); // still exactly one
    expect((await findingFor(resourceId)).status).toBe("open");
  });
});

describe("ADR-0114 §2 — `approved` is in the enum and is written by NO path (M-035)", () => {
  it("no finding in this database has ever held `approved`, and the enum still accepts it", async () => {
    // The per-status table refuses `approved` defensively. The claim behind
    // that refusal — that nothing writes it — is measured here rather than
    // asserted in prose: every writer of infra_findings.status was enumerated
    // in infra.ts and none sets 'approved'. A row proves the enum would take
    // it, so this is not a vacuous "the value is impossible" check.
    const approvedRows = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(infraFindings)
      .where(eq(infraFindings.status, "approved"));
    expect(approvedRows[0]!.n).toBe(0);

    const name = `reop-enum-${RUN}`;
    const resourceId = await makeCertResource(name, 15);
    const [row] = await db
      .insert(infraFindings)
      .values({
        resourceId,
        kind: "drift",
        severity: "low",
        detail: { signature: `drift:ENUM-${RUN}` },
        status: "approved",
      })
      .returning();
    expect(row!.status).toBe("approved"); // the enum really does accept it
    await db.delete(infraFindings).where(eq(infraFindings.id, row!.id));
  });
});

// ADR-0181 (FX2): hand the shared database back strict (M-068)
afterAll(async () => {
  await restoreAdminKeyMfa?.();
});
