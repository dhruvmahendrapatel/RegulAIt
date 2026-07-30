import { beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb, runMigrations, infraResources, eq, type Db } from "@regulait/db";
import { resolveInfraProvider } from "@regulait/infra-provider";
import { buildApp } from "./app.js";

/**
 * ADR-0017 — the infra-ops AUTOMATION ledgers (pillar 3 §8.2 depth on top of the
 * 0027 detection spine). Driven as the admin portal drives it (pure API client).
 * Proves:
 *   · scan materializes the durable ledgers (cert_inventory / patch_records /
 *     backup_runs) and back-links each finding via ref_table/ref_id;
 *   · each operator verb (cert_rotate / patch_apply / backup_restore) funnels
 *     into the ONE Approvals Queue (objectType infra_operation) via the shared
 *     /decide path — propose -> approve writes the ledger OUTCOME + reaches the
 *     provider; deny -> accepted_risk with the durable ledger untouched;
 *   · every new route is admin-only (a non-admin gets 403);
 *   · an air_gapped-targeted resource retains METADATA ONLY on remediation;
 *   · a re-scan is idempotent (no duplicate patch_records).
 *
 * Shares one database with the other gateway suites (fileParallelism off), so
 * every object here is name-prefixed infops-.
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "infops-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = "f".repeat(64);

let db: Db;
let app: ReturnType<typeof buildApp>;
let adminAuth: { authorization: string };
let approverId: string;
let approverAuth: { authorization: string };

let cpId: string;
let certId: string;
let backupTargetId: string;
let airCertResId: string;
let denyCertResId: string;

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
  const k = await app.inject({ method: "POST", url: `/v1/users/${id}/keys`, headers: AUTH, payload: { name: "infops" } });
  return { id, auth: { authorization: `Bearer ${k.json().token}` } };
}
async function decide(approvalId: string, decision: "approved" | "denied", headers = approverAuth) {
  return app.inject({ method: "POST", url: `/v1/approvals/${approvalId}/decide`, headers, payload: { decision } });
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });

  const admin = await makeUser("infops-admin@example.com", "Infops Admin", true);
  adminAuth = admin.auth;
  const approver = await makeUser("infops-approver@example.com", "Infops Approver", false);
  approverId = approver.id;
  approverAuth = approver.auth;

  cpId = (await (await post("/v1/infra/resources", { name: "infops-control-plane", kind: "control_plane" })).json()).id;
  certId = (await (await post("/v1/infra/resources", { name: "infops-api-cert", kind: "cert", config: { daysUntilExpiry: 5 } })).json()).id;
  backupTargetId = (await (await post("/v1/infra/resources", { name: "infops-backup", kind: "backup_target", config: { hoursSinceLastBackup: 100 } })).json()).id;
  denyCertResId = (await (await post("/v1/infra/resources", { name: "infops-deny-cert", kind: "cert", config: { daysUntilExpiry: 6 } })).json()).id;

  // an air_gapped BYOC target + a cert resource pinned to it (deploy_target_id
  // is set directly — there is no create-time surface for it, by design).
  const target = await post("/v1/deploy/targets", {
    name: "infops-air", provider: "aws", roleArn: "arn:aws:iam::123456789012:role/infops", region: "us-west-2", mode: "air_gapped",
  });
  const targetId = target.json().id;
  airCertResId = (await (await post("/v1/infra/resources", { name: "infops-air-cert", kind: "cert", config: { daysUntilExpiry: 8 } })).json()).id;
  await db.update(infraResources).set({ deployTargetId: targetId }).where(eq(infraResources.id, airCertResId));

  await post("/v1/infra/scan", {});
});

async function certRowFor(resourceName: string) {
  const certs = (await getJson("/v1/infra/certs")).certs;
  return certs.find((c: any) => c.resourceName === resourceName);
}
async function patchRowFor(resourceName: string) {
  const patches = (await getJson("/v1/infra/patches")).patches;
  return patches.find((p: any) => p.resourceName === resourceName);
}
async function backupRowFor(resourceName: string, status: string) {
  const backups = (await getJson("/v1/infra/backups")).backups;
  return backups.find((b: any) => b.resourceName === resourceName && b.status === status);
}

describe("scan materializes the durable ledgers + back-links", () => {
  it("cert_inventory / patch_records / backup_runs are populated with ref-linked findings", async () => {
    const cert = await certRowFor("infops-api-cert");
    expect(cert).toBeTruthy();
    expect(cert.status).toBe("active");
    expect(new Date(cert.notAfter).getTime()).toBeGreaterThan(Date.now());

    const patch = await patchRowFor("infops-control-plane");
    expect(patch).toBeTruthy();
    expect(patch.cve).toBe("CVE-2026-0001");
    expect(patch.status).toBe("open");

    const missed = await backupRowFor("infops-backup", "missed");
    expect(missed).toBeTruthy();

    // findings carry the ref back-link
    const findings = (await getJson("/v1/infra/findings")).findings;
    const cveFinding = findings.find((f: any) => f.resourceName === "infops-control-plane" && f.kind === "cve");
    expect(cveFinding.refTable).toBe("patch_records");
    expect(cveFinding.refId).toBe(patch.id);
  });
});

describe("cert_rotate — propose -> approve -> rotated", () => {
  it("advances not_after, writes a cert_rotations row, and reaches the provider", async () => {
    const before = await certRowFor("infops-api-cert");
    const proposed = await post(`/v1/infra/certs/${before.id}/rotate`, { approverUserId: approverId });
    expect(proposed.statusCode).toBe(202);
    const approvalId = proposed.json().approvalId;

    // it is an infra_operation in the one queue
    const mine = (await getJson("/v1/approvals", approverAuth)).approvals.find((a: any) => a.id === approvalId);
    expect(mine.objectType).toBe("infra_operation");

    const d = await decide(approvalId, "approved");
    expect(d.statusCode).toBe(200);

    const after = await certRowFor("infops-api-cert");
    expect(after.status).toBe("rotated");
    expect(new Date(after.notAfter).getTime()).toBeGreaterThan(new Date(before.notAfter).getTime());
    expect(after.lastRotatedAt).toBeTruthy();

    const rotations = (await getJson(`/v1/infra/certs/${before.id}/rotations`)).rotations;
    expect(rotations).toHaveLength(1);
    expect(rotations[0].status).toBe("rotated");

    // the governed automation actually reached the mock provider
    const mock = resolveInfraProvider({ kind: "mock" }) as any;
    expect(mock.remediations.some((r: any) => r.signature === "cert_expiring:infops-api-cert")).toBe(true);
  });
});

describe("patch_apply — propose -> approve -> patched", () => {
  it("marks the CVE patched", async () => {
    const patch = await patchRowFor("infops-control-plane");
    const proposed = await post(`/v1/infra/patches/${patch.id}/apply`, { approverUserId: approverId });
    expect(proposed.statusCode).toBe(202);
    const d = await decide(proposed.json().approvalId, "approved");
    expect(d.statusCode).toBe(200);
    const after = await patchRowFor("infops-control-plane");
    expect(after.status).toBe("patched");
    expect(after.patchedAt).toBeTruthy();
  });
});

describe("backup_restore — propose -> approve -> restored", () => {
  it("appends a kind=restore status=restored run", async () => {
    const missed = await backupRowFor("infops-backup", "missed");
    const proposed = await post(`/v1/infra/backups/${missed.id}/restore`, { approverUserId: approverId });
    expect(proposed.statusCode).toBe(202);
    const d = await decide(proposed.json().approvalId, "approved");
    expect(d.statusCode).toBe(200);
    const restored = await backupRowFor("infops-backup", "restored");
    expect(restored).toBeTruthy();
    expect(restored.kind).toBe("restore");
  });
});

describe("deny -> accepted_risk, ledger untouched", () => {
  it("a denied cert rotation leaves not_after unchanged and writes no rotation row", async () => {
    const before = await certRowFor("infops-deny-cert");
    const proposed = await post(`/v1/infra/certs/${before.id}/rotate`, { approverUserId: approverId });
    const approvalId = proposed.json().approvalId;
    const d = await decide(approvalId, "denied");
    expect(d.statusCode).toBe(200);

    const after = await certRowFor("infops-deny-cert");
    // reverted to active; not_after byte-identical (durable ledger untouched)
    expect(after.status).toBe("active");
    expect(after.notAfter).toBe(before.notAfter);
    const rotations = (await getJson(`/v1/infra/certs/${before.id}/rotations`)).rotations;
    expect(rotations).toHaveLength(0);

    // the linked finding is the accepted-risk surface
    const findings = (await getJson("/v1/infra/findings")).findings;
    const f = findings.find((x: any) => x.resourceName === "infops-deny-cert" && x.kind === "cert_expiring");
    expect(f.status).toBe("accepted_risk");
  });
});

describe("air_gapped boundary — metadata only", () => {
  it("an air_gapped-targeted resource retains no provider detail on remediation", async () => {
    const cert = await certRowFor("infops-air-cert");
    const proposed = await post(`/v1/infra/certs/${cert.id}/rotate`, { approverUserId: approverId });
    await decide(proposed.json().approvalId, "approved");

    const audit = (await getJson(`/v1/audit?userId=${approverId}`)).entries;
    const applied = audit.filter((e: any) => e.ruleId === "infra-action-applied" && e.detail?.action === "cert_rotate");
    // the most recent cert_rotate apply is the air-gapped one
    const air = applied.find((e: any) => e.detail?.boundary === "air_gapped");
    expect(air).toBeTruthy();
    expect(air.detail.metadataOnly).toBe(true);
    expect(air.detail.providerDetail).toBeUndefined();
  });
});

describe("all new routes are admin-only", () => {
  const routes: Array<["GET" | "POST", string]> = [
    ["GET", "/v1/infra/certs"],
    ["GET", "/v1/infra/patches"],
    ["GET", "/v1/infra/backups"],
  ];
  it("a non-admin gets 403 on the read routes", async () => {
    for (const [method, url] of routes) {
      const res = await app.inject({ method, url, headers: approverAuth });
      expect(res.statusCode).toBe(403);
    }
  });
  it("a non-admin gets 403 on the verb routes and the rotations read", async () => {
    const cert = await certRowFor("infops-api-cert");
    const r1 = await app.inject({ method: "GET", url: `/v1/infra/certs/${cert.id}/rotations`, headers: approverAuth });
    expect(r1.statusCode).toBe(403);
    const r2 = await app.inject({ method: "POST", url: `/v1/infra/certs/${cert.id}/rotate`, headers: approverAuth, payload: { approverUserId: approverId } });
    expect(r2.statusCode).toBe(403);
  });
});

describe("re-scan is idempotent for the ledgers", () => {
  it("scanning again does not duplicate patch_records", async () => {
    const before = (await getJson("/v1/infra/patches")).patches.filter((p: any) => p.resourceName === "infops-control-plane").length;
    await post("/v1/infra/scan", {});
    const after = (await getJson("/v1/infra/patches")).patches.filter((p: any) => p.resourceName === "infops-control-plane").length;
    expect(after).toBe(before);
    expect(before).toBe(1);
  });
});
