/**
 * ADR-0022 enterprise-UX e2e:
 *  - approver visibility: a NAMED approver (pending or already decided) can
 *    READ the workflow instance they are party to; an unrelated user still
 *    403s (with access-flavoured copy); the widening never reaches the
 *    driving routes;
 *  - approver delegation: inside the window the delegate sees the
 *    delegator's pending approvals (marked) and may decide on-behalf-of
 *    (real decider recorded + on-behalf-of audit row); outside the window
 *    nothing applies; the org master switch turns it all off;
 *  - template retire: blocks NEW instances loudly, leaves in-flight ones
 *    driveable to completion;
 *  - #79b: an unimplemented git-connection kind 400s at creation;
 *  - #79c: dryRun is persisted in the stage context (including air-gapped
 *    metadata) and a dry-run deploy NEVER satisfies a production gate —
 *    parked at blocked_on_deploy with the reason named, overridable.
 */
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, auditLog, createDb, eq, runMigrations, type Db } from "@regulait/db";
import { IMPLEMENTED_GIT_PROVIDERS } from "@regulait/git-provider";
import { buildApp } from "./app.js";
import { installLicenseFixture, removeLicenseFixture } from "./testing/license-fixture.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "test-bootstrap-token-ux";
const AUTH = { authorization: `Bearer ${BOOT}` };
const ROLE = "arn:aws:iam::123456789012:role/regulait-deploy";

let db: Db;
let app: ReturnType<typeof buildApp>;
let piaId: string; // initiator
let piaAuth: { authorization: string };
let anaId: string; // named approver
let anaAuth: { authorization: string };
let deeId: string; // delegate
let deeAuth: { authorization: string };
let zedAuth: { authorization: string }; // unrelated

const mkUser = async (email: string, name: string): Promise<{ id: string; auth: { authorization: string } }> => {
  const u = await app.inject({ method: "POST", headers: AUTH, url: "/v1/users", payload: { email, displayName: name } });
  expect(u.statusCode).toBe(201);
  const k = await app.inject({
    method: "POST", headers: AUTH, url: `/v1/users/${u.json().id}/keys`, payload: { name: "ux-key" },
  });
  return { id: u.json().id, auth: { authorization: `Bearer ${k.json().token}` } };
};

/** template: trigger → human_approval [ana] (+ optional extra stages), plus a
 * rule routing changeType to it; returns templateId */
async function mkTemplate(name: string, changeType: string, extraStages: unknown[] = []): Promise<string> {
  const tpl = await app.inject({
    method: "POST", headers: AUTH, url: "/v1/workflows/templates",
    payload: { name, definition: { workflow: name, stages: [
      { id: "intake", type: "trigger" },
      { id: "gate", type: "human_approval", approvers: [anaId] },
      ...extraStages,
    ] } },
  });
  expect(tpl.statusCode).toBe(201);
  const rule = await app.inject({
    method: "POST", headers: AUTH, url: "/v1/workflows/assignment-rules",
    payload: { templateId: tpl.json().id, changeType },
  });
  expect(rule.statusCode).toBe(201);
  return tpl.json().id as string;
}

async function startInstance(changeType: string, environment = "ux-env"): Promise<string> {
  const r = await app.inject({
    method: "POST", headers: piaAuth, url: "/v1/workflows/instances",
    payload: { change: { description: `ux ${changeType}`, paths: ["src/"], changeType, environment } },
  });
  expect(r.statusCode).toBe(201);
  return r.json().id as string;
}

async function pendingGateApproval(instanceId: string, auth: { authorization: string }) {
  const r = await app.inject({ method: "GET", headers: auth, url: "/v1/approvals?status=pending" });
  return r.json().approvals.find((a: { instanceId: string | null }) => a.instanceId === instanceId);
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "d".repeat(64) });
  // ADR-0052 §4: creating an air_gapped deploy target is now tier-gated on
  // `airgapped_mode` — run under a real signed license granting it (removed
  // in afterAll; the deployment ends UNLICENSED as it started).
  await installLicenseFixture(app, { features: ["airgapped_mode"], auth: AUTH });
  ({ id: piaId, auth: piaAuth } = await mkUser("ux-pia@example.com", "UX Pia"));
  ({ id: anaId, auth: anaAuth } = await mkUser("ux-ana@example.com", "UX Ana"));
  ({ id: deeId, auth: deeAuth } = await mkUser("ux-dee@example.com", "UX Dee"));
  ({ auth: zedAuth } = await mkUser("ux-zed@example.com", "UX Zed"));
});

afterAll(async () => {
  await removeLicenseFixture(db);
  await app.close();
});

describe("approver visibility — party to the instance (top blocker)", () => {
  it("a PENDING approver reads the instance; an unrelated user gets an access-worded 403", async () => {
    await mkTemplate("ux-vis", "ux-vis-change");
    const id = await startInstance("ux-vis-change");
    const asAna = await app.inject({ method: "GET", headers: anaAuth, url: `/v1/workflows/instances/${id}` });
    expect(asAna.statusCode).toBe(200);
    expect(asAna.json().pendingApprovals.length).toBe(1);
    const asZed = await app.inject({ method: "GET", headers: zedAuth, url: `/v1/workflows/instances/${id}` });
    expect(asZed.statusCode).toBe(403);
    expect(asZed.json().error).toBe("forbidden");
    expect(asZed.json().detail).toContain("access"); // access copy, not outage copy
  });

  it("a DECIDED approver still reads it (party-to, past or pending); driving routes stay closed", async () => {
    await mkTemplate("ux-vis2", "ux-vis2-change");
    const id = await startInstance("ux-vis2-change");
    const a = await pendingGateApproval(id, anaAuth);
    const dec = await app.inject({
      method: "POST", headers: anaAuth, url: `/v1/approvals/${a.id}/decide`, payload: { decision: "approved" },
    });
    expect(dec.statusCode).toBe(200);
    // decided (no pending row remains) — the read still works
    const read = await app.inject({ method: "GET", headers: anaAuth, url: `/v1/workflows/instances/${id}` });
    expect(read.statusCode).toBe(200);
    expect(read.json().instance.status).toBe("completed");
    // the widening is READ-only: ana cannot drive the instance
    const drive = await app.inject({
      method: "POST", headers: anaAuth, url: `/v1/workflows/instances/${id}/abort`, payload: {},
    });
    expect(drive.statusCode).toBe(403);
  });
});

describe("approver delegation (ADR-0022)", () => {
  it("inside the window: delegate sees the delegator's pending rows (marked), reads the instance, decides on-behalf-of — both audited", async () => {
    await mkTemplate("ux-del", "ux-del-change");
    const id = await startInstance("ux-del-change");
    const now = Date.now();
    const dg = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/delegations",
      payload: {
        fromUserId: anaId, toUserId: deeId,
        startsAt: new Date(now - 3600_000).toISOString(),
        endsAt: new Date(now + 3600_000).toISOString(),
        reason: "ana on leave",
      },
    });
    expect(dg.statusCode).toBe(201);
    // dee's inbox now carries ana's pending approval, marked delegatedFrom
    const row = await pendingGateApproval(id, deeAuth);
    expect(row).toBeTruthy();
    expect(row.delegatedFrom).toBe("UX Ana");
    // dee can READ the instance (they can decide it, so they must see it)
    const read = await app.inject({ method: "GET", headers: deeAuth, url: `/v1/workflows/instances/${id}` });
    expect(read.statusCode).toBe(200);
    // dee decides — recorded as the REAL decider, on-behalf-of ana
    const dec = await app.inject({
      method: "POST", headers: deeAuth, url: `/v1/approvals/${row.id}/decide`, payload: { decision: "approved" },
    });
    expect(dec.statusCode).toBe(200);
    expect(dec.json().decidedBy).toBe(deeId);
    expect(dec.json().onBehalfOf).toBe(anaId);
    const audit = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.ruleId, "approval-delegated-decision"), eq(auditLog.userId, deeId)));
    expect(audit.length).toBe(1);
    expect((audit[0]!.detail as { onBehalfOfUserId: string }).onBehalfOfUserId).toBe(anaId);
    // clean up the window so later tests are unaffected
    await app.inject({ method: "DELETE", headers: AUTH, url: `/v1/delegations/${dg.json().id}` });
  });

  it("outside the window nothing applies: no inbox row, decide 403s", async () => {
    await mkTemplate("ux-del2", "ux-del2-change");
    const id = await startInstance("ux-del2-change");
    const now = Date.now();
    const dg = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/delegations",
      payload: {
        fromUserId: anaId, toUserId: deeId,
        startsAt: new Date(now + 24 * 3600_000).toISOString(), // starts tomorrow
        endsAt: new Date(now + 48 * 3600_000).toISOString(),
      },
    });
    expect(dg.statusCode).toBe(201);
    const row = await pendingGateApproval(id, deeAuth);
    expect(row).toBeUndefined();
    const anaRow = await pendingGateApproval(id, anaAuth);
    const dec = await app.inject({
      method: "POST", headers: deeAuth, url: `/v1/approvals/${anaRow.id}/decide`, payload: { decision: "approved" },
    });
    expect(dec.statusCode).toBe(403);
    expect(dec.json().error).toBe("not_the_named_approver");
    await app.inject({ method: "DELETE", headers: AUTH, url: `/v1/delegations/${dg.json().id}` });
    // an inverted window is refused at creation
    const bad = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/delegations",
      payload: { fromUserId: anaId, toUserId: deeId, startsAt: new Date(now + 2000).toISOString(), endsAt: new Date(now + 1000).toISOString() },
    });
    expect(bad.statusCode).toBe(400);
    // ana approves so no pending row lingers
    await app.inject({ method: "POST", headers: anaAuth, url: `/v1/approvals/${anaRow.id}/decide`, payload: { decision: "approved" } });
  });

  it("the org master switch turns delegation off entirely (and back on)", async () => {
    await mkTemplate("ux-del3", "ux-del3-change");
    const id = await startInstance("ux-del3-change");
    const now = Date.now();
    const dg = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/delegations",
      payload: { fromUserId: anaId, toUserId: deeId, startsAt: new Date(now - 1000).toISOString(), endsAt: new Date(now + 3600_000).toISOString() },
    });
    expect(dg.statusCode).toBe(201);
    try {
      await app.inject({ method: "PUT", headers: AUTH, url: "/v1/org/settings", payload: { approvalDelegationEnabled: false } });
      // the ACTIVE window stops applying immediately
      const row = await pendingGateApproval(id, deeAuth);
      expect(row).toBeUndefined();
      const anaRow = await pendingGateApproval(id, anaAuth);
      const dec = await app.inject({
        method: "POST", headers: deeAuth, url: `/v1/approvals/${anaRow.id}/decide`, payload: { decision: "approved" },
      });
      expect(dec.statusCode).toBe(403);
      // and creating new windows is refused
      const refused = await app.inject({
        method: "POST", headers: AUTH, url: "/v1/delegations",
        payload: { fromUserId: anaId, toUserId: deeId, startsAt: new Date(now).toISOString(), endsAt: new Date(now + 1000_000).toISOString() },
      });
      expect(refused.statusCode).toBe(409);
      expect(refused.json().error).toBe("delegation_disabled");
    } finally {
      await app.inject({ method: "PUT", headers: AUTH, url: "/v1/org/settings", payload: { approvalDelegationEnabled: true } });
      await app.inject({ method: "DELETE", headers: AUTH, url: `/v1/delegations/${dg.json().id}` });
      const anaRow = await pendingGateApproval(id, anaAuth);
      if (anaRow) {
        await app.inject({ method: "POST", headers: anaAuth, url: `/v1/approvals/${anaRow.id}/decide`, payload: { decision: "approved" } });
      }
    }
  });
});

describe("workflow template retire (soft-disable)", () => {
  it("blocks NEW instances loudly; in-flight instances drive to completion; the why is recorded", async () => {
    const tplId = await mkTemplate("ux-retire", "ux-retire-change");
    const inflight = await startInstance("ux-retire-change");
    // reason is required — it IS the record
    const noReason = await app.inject({
      method: "POST", headers: AUTH, url: `/v1/workflows/templates/${tplId}/retire`, payload: {},
    });
    expect(noReason.statusCode).toBe(400);
    const ret = await app.inject({
      method: "POST", headers: AUTH, url: `/v1/workflows/templates/${tplId}/retire`,
      payload: { reason: "superseded by ux-retire-v2" },
    });
    expect(ret.statusCode).toBe(200);
    expect(ret.json().retiredAt).toBeTruthy();
    expect(ret.json().retiredReason).toContain("superseded");
    // a NEW instance is refused with the template named — never silently skipped
    const blocked = await app.inject({
      method: "POST", headers: piaAuth, url: "/v1/workflows/instances",
      payload: { change: { description: "post-retire", paths: ["x"], changeType: "ux-retire-change", environment: "ux-env" } },
    });
    expect(blocked.statusCode).toBe(422);
    expect(blocked.json().error).toBe("template_retired");
    expect(blocked.json().templates).toContain("ux-retire");
    // the IN-FLIGHT instance is untouched: its gate still decides and completes
    const a = await pendingGateApproval(inflight, anaAuth);
    const dec = await app.inject({
      method: "POST", headers: anaAuth, url: `/v1/approvals/${a.id}/decide`, payload: { decision: "approved" },
    });
    expect(dec.statusCode).toBe(200);
    const v = await app.inject({ method: "GET", headers: piaAuth, url: `/v1/workflows/instances/${inflight}` });
    expect(v.json().instance.status).toBe("completed");
    // retiring twice is a clean 409
    const again = await app.inject({
      method: "POST", headers: AUTH, url: `/v1/workflows/templates/${tplId}/retire`, payload: { reason: "again" },
    });
    expect(again.statusCode).toBe(409);
  });
});

describe("#79b git-connection kind honesty", () => {
  it("an unimplemented kind is a 400 at CREATION, and the exported set matches every schema kind", async () => {
    const r = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/git/connections",
      payload: { name: "ux-gitea", provider: "gitea", token: "t" },
    });
    expect(r.statusCode).toBe(400);
    // every kind the schema/DB enum admits today has a real adapter
    for (const kind of ["github", "gitlab", "bitbucket", "azure_devops", "mock"]) {
      expect(IMPLEMENTED_GIT_PROVIDERS.has(kind)).toBe(true);
    }
    expect(IMPLEMENTED_GIT_PROVIDERS.size).toBe(5);
  });
});

describe("#79c dry-run deploy honesty", () => {
  const mkTarget = async (name: string, extra: Record<string, unknown> = {}) => {
    const r = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/deploy/targets",
      payload: { name, provider: "aws", roleArn: ROLE, region: "us-east-1", mode: "byoc", ...extra },
    });
    expect(r.statusCode).toBe(201);
  };
  const approveGate = async (id: string) => {
    const a = await pendingGateApproval(id, anaAuth);
    const r = await app.inject({
      method: "POST", headers: anaAuth, url: `/v1/approvals/${a.id}/decide`, payload: { decision: "approved" },
    });
    expect(r.statusCode).toBe(200);
  };
  const view = async (id: string) =>
    (await app.inject({ method: "GET", headers: piaAuth, url: `/v1/workflows/instances/${id}` })).json().instance;

  it("a NON-production dry-run deploy advances, with dryRun persisted in the stage context", async () => {
    await mkTarget("ux-aws-dev");
    await mkTemplate("ux-dry-dev", "ux-dry-dev-change", [
      { id: "deploy", type: "deployment", connection: "ux-aws-dev" },
    ]);
    const id = await startInstance("ux-dry-dev-change");
    await approveGate(id);
    const inst = await view(id);
    expect(inst.status).toBe("completed");
    expect(inst.context["deploy:deploy"].dryRun).toBe(true);
  });

  it("a dry-run NEVER satisfies a production deploy gate — parked with the reason named; override advances", async () => {
    await mkTarget("ux-aws-prod", { environment: "production" });
    await mkTemplate("ux-dry-prod", "ux-dry-prod-change", [
      { id: "deploy", type: "deployment", connection: "ux-aws-prod" },
    ]);
    const id = await startInstance("ux-dry-prod-change");
    await approveGate(id);
    const inst = await view(id);
    expect(inst.status).toBe("blocked_on_deploy");
    expect(inst.context["deploy:deploy"].dryRun).toBe(true);
    expect(inst.context.lastError).toContain("dry-run deploy cannot satisfy a production deploy gate");
    // the governed escape: an out-of-band deploy is confirmed by hand. pia
    // initiated this instance, so it is a self-attestation and the reason is
    // mandatory (see the deploy-override separation-of-duties tests below).
    const ov = await app.inject({
      method: "POST", headers: piaAuth, url: `/v1/workflows/instances/${id}/deploy-override`,
      payload: { stageId: "deploy", reason: "shipped through the standard release pipeline out-of-band" },
    });
    expect(ov.statusCode).toBe(200);
    expect((await view(id)).status).toBe("completed");
  });

  it("a change-environment=production dry-run is refused too", async () => {
    await mkTarget("ux-aws-chg");
    const tplId = await mkTemplate("ux-dry-chg", "ux-dry-chg-change", [
      { id: "deploy", type: "deployment", connection: "ux-aws-chg" },
    ]);
    // start via the admin explicit-template escape hatch so another suite's
    // environment=production assignment rule can't merge its template in
    const adminU = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/users",
      payload: { email: "ux-admin@example.com", displayName: "UX Admin", isAdmin: true },
    });
    const adminK = await app.inject({
      method: "POST", headers: AUTH, url: `/v1/users/${adminU.json().id}/keys`, payload: { name: "ux-admin-key" },
    });
    const adminAuth = { authorization: `Bearer ${adminK.json().token}` };
    const r = await app.inject({
      method: "POST", headers: adminAuth, url: "/v1/workflows/instances",
      payload: {
        templateId: tplId,
        change: { description: "prod change", paths: ["src/"], changeType: "ux-dry-chg-change", environment: "production" },
      },
    });
    expect(r.statusCode).toBe(201);
    const id = r.json().id as string;
    await approveGate(id);
    const inst = (await app.inject({ method: "GET", headers: adminAuth, url: `/v1/workflows/instances/${id}` })).json().instance;
    expect(inst.status).toBe("blocked_on_deploy");
    expect(inst.context["deploy:deploy"].dryRun).toBe(true);
  });

  it("the air-gapped branch persists dryRun as METADATA while the data boundary holds (no url/detail)", async () => {
    await mkTarget("ux-aws-air", { mode: "air_gapped" });
    await mkTemplate("ux-dry-air", "ux-dry-air-change", [
      { id: "deploy", type: "deployment", connection: "ux-aws-air" },
    ]);
    const id = await startInstance("ux-dry-air-change");
    await approveGate(id);
    const inst = await view(id);
    const dep = inst.context["deploy:deploy"];
    expect(dep.dryRun).toBe(true);
    expect(dep.mode).toBe("air_gapped");
    expect(dep.url).toBeUndefined();
    expect(dep.detail).toBeUndefined();
  });

  it("the MOCK provider's deploy is not a dry-run (the demo double's deploys ARE its contract)", async () => {
    await app.inject({
      method: "POST", headers: AUTH, url: "/v1/deploy/targets",
      payload: { name: "ux-mock", provider: "mock", environment: "production" },
    });
    await mkTemplate("ux-mock-tpl", "ux-mock-change", [
      { id: "deploy", type: "deployment", connection: "ux-mock" },
    ]);
    const id = await startInstance("ux-mock-change");
    await approveGate(id);
    const inst = await view(id);
    expect(inst.status).toBe("completed"); // production + mock still flows (demo/tests)
    expect(inst.context["deploy:deploy"].dryRun).toBe(false);
  });
});
