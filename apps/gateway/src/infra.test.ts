import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb, runMigrations, type Db } from "@regulait/db";
import { buildApp } from "./app.js";

/**
 * PILLAR 3 §8.2 — the governed infrastructure-operations layer, driven exactly
 * as the admin portal drives it (pure API client). Proves THE INVARIANT:
 *   · scan detects findings idempotently (a re-scan never duplicates);
 *   · a LOW finding under a permissive policy is AUTO-remediated on scan
 *     (audited via ruleId 'infra-auto-remediate', no approval);
 *   · a CRITICAL finding is NEVER auto-remediated even under a permissive
 *     policy — it is always approval-gated;
 *   · an open finding: propose -> approvals row (objectType 'infra_operation')
 *     + finding 'remediation_proposed' -> approve -> 'remediated' + audit
 *     effect 'allow'; a deny path -> 'accepted_risk' + audit 'deny';
 *   · §8.3 cascade: a classified resource's backup-retention FLOOR reflects the
 *     compliance cascade (finally consuming auditRetentionDays).
 *
 * Shares one database with the other gateway suites (fileParallelism off), so
 * every object here is name-prefixed inf-.
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "inf-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = "e".repeat(64);

let db: Db;
let app: ReturnType<typeof buildApp>;
let adminAuth: { authorization: string };
let adminId: string;
let approverId: string;
let approverAuth: { authorization: string };

// resource ids
let cpId: string;
let runtimeId: string;
let certCritId: string;
let backupId: string;

async function post(url: string, payload: unknown, headers = adminAuth) {
  return app.inject({ method: "POST", url, headers, payload: payload as object });
}
async function getJson(url: string, headers = adminAuth) {
  const res = await app.inject({ method: "GET", url, headers });
  return res.json();
}
async function makeUser(email: string, displayName: string, isAdmin: boolean) {
  const u = await app.inject({ method: "POST", url: "/v1/users", headers: AUTH, payload: { email, displayName, isAdmin } });
  const id = u.json().id;
  const k = await app.inject({ method: "POST", url: `/v1/users/${id}/keys`, headers: AUTH, payload: { name: "inf" } });
  return { id, auth: { authorization: `Bearer ${k.json().token}` } };
}

let restoreAdminKeyMfa: (() => Promise<void>) | undefined;
beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  // ADR-0181 (FX2): an admin's API key now answers to mfaRequired. This suite
  // drives admins through keys and is not about MFA, so it relaxes the dial
  // explicitly and hands the shared database back strict in afterAll (M-068).
  restoreAdminKeyMfa = await relaxIdentityForTest(db, { mfaRequired: "off" });
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });

  const admin = await makeUser("inf-admin@example.com", "Inf Admin", true);
  adminId = admin.id;
  adminAuth = admin.auth;
  const approver = await makeUser("inf-approver@example.com", "Inf Approver", false);
  approverId = approver.id;
  approverAuth = approver.auth;

  // §8.3 profile whose cascade drives the infra backup-retention floor. The
  // audit-retention value (3000) is HIGHER than the backup-retention value
  // (2555), so a floor that reflects auditRetentionDays proves it is consumed.
  await post("/v1/compliance/profiles", {
    tag: "inf-hipaa",
    piiMode: "block",
    auditRetentionDays: 3000,
    backupRetentionDays: 2555,
    patchCadenceDays: 30,
  });

  cpId = (await (await post("/v1/infra/resources", { name: "inf-control-plane", kind: "control_plane" })).json()).id;
  runtimeId = (await (await post("/v1/infra/resources", { name: "inf-runtime", kind: "agent_runtime" })).json()).id;
  certCritId = (await (await post("/v1/infra/resources", { name: "inf-legacy-cert", kind: "cert", config: { daysUntilExpiry: -1 } })).json()).id;
  backupId = (await (await post("/v1/infra/resources", {
    name: "inf-phi-backup",
    kind: "backup_target",
    config: { hoursSinceLastBackup: 100 },
    classifications: ["inf-hipaa"],
  })).json()).id;

  // runtime: a permissive 'low' ceiling -> its low drift auto-remediates.
  await post("/v1/infra/policies", { resourceId: runtimeId, autoRemediateMaxSeverity: "low" });
  // cert: a permissive 'high' ceiling -> STILL cannot auto-remediate a critical.
  await post("/v1/infra/policies", { resourceId: certCritId, autoRemediateMaxSeverity: "high" });
});

function findingsFor(all: any[], resourceId: string) {
  return all.filter((f) => f.resourceId === resourceId);
}

describe("scan — detection, auto-remediation, and the always-gated critical", () => {
  it("materializes the expected mix and auto-remediates only the permitted low", async () => {
    const scan = await post("/v1/infra/scan", {});
    expect(scan.statusCode).toBe(200);
    const body = scan.json();
    expect(body.created).toBeGreaterThanOrEqual(5);
    expect(body.autoRemediated).toBeGreaterThanOrEqual(1);

    const all = (await getJson("/v1/infra/findings")).findings;

    // control plane: a medium drift + a high cve, both OPEN (no permitting policy)
    const cp = findingsFor(all, cpId);
    expect(cp.map((f: any) => `${f.kind}/${f.severity}/${f.status}`).sort()).toEqual([
      "cve/high/open",
      "drift/medium/open",
    ]);

    // agent runtime: a LOW drift, AUTO-remediated on scan
    const rt = findingsFor(all, runtimeId);
    expect(rt).toHaveLength(1);
    expect(rt[0].kind).toBe("drift");
    expect(rt[0].severity).toBe("low");
    expect(rt[0].status).toBe("auto_remediated");

    // legacy cert: expired => CRITICAL, OPEN despite a permissive 'high' policy
    const cert = findingsFor(all, certCritId);
    expect(cert).toHaveLength(1);
    expect(cert[0].severity).toBe("critical");
    expect(cert[0].status).toBe("open");

    // backup target: a high backup_missed, OPEN
    const bk = findingsFor(all, backupId);
    expect(bk).toHaveLength(1);
    expect(bk[0].kind).toBe("backup_missed");
    expect(bk[0].status).toBe("open");
  });

  it("audits the auto-remediation as governed automation (ruleId infra-auto-remediate, allow)", async () => {
    const audit = (await getJson(`/v1/audit?userId=${adminId}`)).entries;
    const auto = audit.filter((e: any) => e.objectType === "infra_operation" && e.ruleId === "infra-auto-remediate");
    expect(auto.length).toBeGreaterThanOrEqual(1);
    expect(auto.every((e: any) => e.effect === "allow")).toBe(true);
    // and the detections themselves were audited
    expect(audit.some((e: any) => e.ruleId === "infra-scan" && e.effect === "allow")).toBe(true);
  });

  it("is idempotent — a second scan duplicates nothing, and RE-OPENS the auto-remediated finding it can still see (ADR-0114)", async () => {
    const before = (await getJson("/v1/infra/findings")).findings.length;
    const scan = await post("/v1/infra/scan", {});
    expect(scan.json().created).toBe(0);
    const after = (await getJson("/v1/infra/findings")).findings.length;
    expect(after).toBe(before);

    // ADR-0114: the runtime drift was AUTO-remediated on the first scan, and
    // the mock provider's remediation does not change what a scan observes —
    // so the second scan sees the SAME signature over a status claiming the
    // problem is resolved. That contradiction re-opens the finding IN PLACE
    // (no new row — asserted by the count above) and is audited.
    expect(scan.json().reopened).toBeGreaterThanOrEqual(1);
    const rt = findingsFor((await getJson("/v1/infra/findings")).findings, runtimeId);
    expect(rt).toHaveLength(1);
    expect(rt[0].status).toBe("open");
    const audit = (await getJson(`/v1/audit?userId=${adminId}`)).entries;
    const reopen = audit.find(
      (e: any) => e.ruleId === "infra-finding-reopened" && e.objectId === rt[0].id,
    );
    expect(reopen).toBeTruthy();
    expect(reopen.detail.priorStatus).toBe("auto_remediated");
  });
});

describe("governed remediation — approve and deny both audited", () => {
  it("propose -> approvals row + finding 'remediation_proposed' -> approve -> 'remediated'", async () => {
    const all = (await getJson("/v1/infra/findings")).findings;
    const drift = findingsFor(all, cpId).find((f: any) => f.kind === "drift");
    expect(drift.status).toBe("open");

    const proposed = await post(`/v1/infra/findings/${drift.id}/remediate`, { approverUserId: approverId });
    expect(proposed.statusCode).toBe(202);
    const approvalId = proposed.json().approvalId;

    // finding flipped, approval is pending as an infra_operation
    const afterPropose = (await getJson("/v1/infra/findings")).findings.find((f: any) => f.id === drift.id);
    expect(afterPropose.status).toBe("remediation_proposed");
    const queue = (await getJson("/v1/approvals", approverAuth)).approvals;
    const mine = queue.find((a: any) => a.id === approvalId);
    expect(mine.objectType).toBe("infra_operation");
    expect(mine.status).toBe("pending");

    // the named non-admin approver decides -> remediated
    const decide = await app.inject({
      method: "POST",
      url: `/v1/approvals/${approvalId}/decide`,
      headers: approverAuth,
      payload: { decision: "approved" },
    });
    expect(decide.statusCode).toBe(200);
    const remediated = (await getJson("/v1/infra/findings")).findings.find((f: any) => f.id === drift.id);
    expect(remediated.status).toBe("remediated");

    const audit = (await getJson(`/v1/audit?userId=${approverId}`)).entries;
    expect(audit.some((e: any) => e.objectType === "infra_operation" && e.effect === "allow" && e.ruleId === "infra-remediated")).toBe(true);
  });

  it("deny -> finding 'accepted_risk' + audit effect 'deny'", async () => {
    const all = (await getJson("/v1/infra/findings")).findings;
    const cve = findingsFor(all, cpId).find((f: any) => f.kind === "cve");
    expect(cve.status).toBe("open");

    const proposed = await post(`/v1/infra/findings/${cve.id}/remediate`, { approverUserId: approverId });
    const approvalId = proposed.json().approvalId;
    const decide = await app.inject({
      method: "POST",
      url: `/v1/approvals/${approvalId}/decide`,
      headers: approverAuth,
      payload: { decision: "denied" },
    });
    expect(decide.statusCode).toBe(200);

    const denied = (await getJson("/v1/infra/findings")).findings.find((f: any) => f.id === cve.id);
    expect(denied.status).toBe("accepted_risk");
    const audit = (await getJson(`/v1/audit?userId=${approverId}`)).entries;
    expect(audit.some((e: any) => e.objectType === "infra_operation" && e.effect === "deny" && e.ruleId === "infra-remediation-denied")).toBe(true);
  });

  it("refuses to propose a non-open finding", async () => {
    // This used to reach for the runtime finding, which ADR-0114 now RE-OPENS
    // on the second scan (see the idempotency case above) — so the fixture is
    // the `accepted_risk` finding the deny case just produced, which ADR-0114
    // deliberately does NOT re-open. The claim under test is unchanged.
    const all = (await getJson("/v1/infra/findings")).findings;
    const closed = findingsFor(all, cpId).find((f: any) => f.kind === "cve");
    expect(closed.status).toBe("accepted_risk"); // positive: a real non-open fixture
    const res = await post(`/v1/infra/findings/${closed.id}/remediate`, { approverUserId: approverId });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("not_open");
  });
});

describe("§8.3 cascade consumption", () => {
  it("a HIPAA-classified resource's backup-retention floor reflects the cascade", async () => {
    const resources = (await getJson("/v1/infra/resources")).resources;
    const backup = resources.find((r: any) => r.id === backupId);
    // floor = max(policy retention (none), cascade backup 2555, cascade audit 3000) = 3000
    expect(backup.effectivePolicy.backupRetentionDaysFloor).toBe(3000);
    expect(backup.effectivePolicy.cascade.auditRetentionDays).toBe(3000);
    // patch ceiling comes straight from the cascade (30)
    expect(backup.effectivePolicy.patchCadenceDaysCeiling).toBe(30);
  });
});

describe("external remediation execution stop", () => {
  const setMode = (mode: "normal" | "halted") =>
    app.inject({
      method: "PUT", url: "/v1/execution/mode", headers: AUTH,
      payload: { mode, reason: `infra final-call ${mode}` },
    });

  it("keeps an approved remediation pending while halted, then permits retry", async () => {
    const all = (await getJson("/v1/infra/findings")).findings;
    const drift = findingsFor(all, runtimeId).find((f: any) => f.kind === "drift" && f.status === "open");
    expect(drift).toBeDefined();
    const proposed = await post(`/v1/infra/findings/${drift.id}/remediate`, { approverUserId: approverId });
    expect(proposed.statusCode).toBe(202);
    const approvalId = proposed.json().approvalId as string;
    expect((await setMode("halted")).statusCode).toBe(200);
    try {
      const denied = await post(`/v1/approvals/${approvalId}/decide`, { decision: "approved" }, approverAuth);
      expect(denied.statusCode).toBe(409);
      const finding = (await getJson("/v1/infra/findings")).findings.find((f: any) => f.id === drift.id);
      expect(finding.status).toBe("remediation_proposed");
      const queue = (await getJson("/v1/approvals", approverAuth)).approvals;
      expect(queue.find((a: any) => a.id === approvalId).status).toBe("pending");
    } finally {
      expect((await setMode("normal")).statusCode).toBe(200);
    }
    const retry = await post(`/v1/approvals/${approvalId}/decide`, { decision: "approved" }, approverAuth);
    expect(retry.statusCode).toBe(200);
    const finding = (await getJson("/v1/infra/findings")).findings.find((f: any) => f.id === drift.id);
    expect(finding.status).toBe("remediated");
  });

  it("leaves an auto-remediation finding open while halted", async () => {
    const resource = await post("/v1/infra/resources", { name: "inf-halt-auto", kind: "agent_runtime" });
    expect(resource.statusCode).toBe(201);
    const resourceId = resource.json().id as string;
    expect((await post("/v1/infra/policies", { resourceId, autoRemediateMaxSeverity: "low" })).statusCode).toBe(201);
    expect((await setMode("halted")).statusCode).toBe(200);
    try {
      const scan = await post("/v1/infra/scan", { resourceId });
      expect(scan.statusCode).toBe(409);
      const finding = findingsFor((await getJson("/v1/infra/findings")).findings, resourceId)[0];
      expect(finding.status).toBe("open");
    } finally {
      expect((await setMode("normal")).statusCode).toBe(200);
    }
    const resumed = await post("/v1/infra/scan", { resourceId });
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json().autoRemediated).toBe(1);
  });
});

// ADR-0181 (FX2): hand the shared database back strict (M-068)
afterAll(async () => {
  await restoreAdminKeyMfa?.();
});
