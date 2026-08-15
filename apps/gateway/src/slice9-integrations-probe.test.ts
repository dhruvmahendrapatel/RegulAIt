import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { auditLog, createDb, desc, eq, runMigrations, type Db } from "@regulait/db";
import { resolvePmProvider, type MockPmProvider } from "@regulait/pm-provider";
import { resolveConnectorProvider } from "@regulait/connector-provider";
import type { MockConnectorProvider } from "@regulait/connector-provider";
import { buildApp } from "./app.js";

/**
 * SLICE-9 ADVERSARIAL PROBE — integrations breadth (git providers, PM
 * adapters, connectors), at the seams the existing suites do not pin.
 *
 * What is deliberately NOT re-tested here (already pinned, by attack, elsewhere):
 *  - each real git adapter's full contract (createBranch/openPR/getPR/checks/
 *    merge, auth header conventions, error mapping) against a fake upstream
 *    -> packages/git-provider/src/{index,gitlab,bitbucket,azure-devops}.test.ts,
 *    with resolveProvider covering every kind ("resolves every real provider
 *    kind to an adapter of that kind");
 *  - the MOCK kind driven through the whole 10-stage workflow executor
 *    (branch → PR → merge gate → merge) -> workflow-pipeline.test.ts;
 *  - ADR-0022 #79b: an UNIMPLEMENTED git kind is a 400 at connection CREATION,
 *    never mid-workflow, and IMPLEMENTED_GIT_PROVIDERS matches every schema
 *    kind -> enterprise-ux.test.ts ("#79b git-connection kind honesty");
 *  - the egress guard over git/PM/connector outbound, write-time AND
 *    call-time, including pre-existing rows inserted straight into Postgres,
 *    DNS re-pointing, mid-flight redirects, and allow-entry withdrawal
 *    -> connection-egress.test.ts (rules git-connection-egress-blocked /
 *    pm-connection-egress-blocked / connector-egress-blocked);
 *  - inbound-webhook forgery refusal at the GATEWAY ("bad secrets are
 *    rejected", provider-native signature/token/basic-auth verification for
 *    linear/jira/monday/ado/generic) -> mcp-proxy.test.ts webhook block, and
 *    per-provider fail-closed parsers -> packages/pm-provider/src/inbound.test.ts;
 *  - drift marks divergence instead of overwriting either side (manual
 *    default is byte-identical detect-only; a DELETED item is never
 *    auto-resolved) -> pm-drift-resolution.test.ts;
 *  - PM adapter breadth (Jira v2/v3+ADF, Linear, Asana, monday, ADO, generic
 *    webhook — field mapping, approval-action resolution, decision records)
 *    -> packages/pm-provider/src/index.test.ts; connector adapter breadth
 *    (slack/github/jira/snowflake op surfaces, scope forcing, typed errors)
 *    -> packages/connector-provider/src/index.test.ts;
 *  - a connector write under a read-only grant is a 403 with the deny audited
 *    -> mcp-proxy.test.ts ("read-only" reason; effects allow,deny,deny).
 *
 * The residual seams probed here:
 *  1. A REAL git kind (gitlab) through the WORKFLOW EXECUTOR contract:
 *     branch → PR → merge against a live loopback fake upstream, through the
 *     egress-guarded fetch path (`git_connections.baseUrl` set). The package
 *     tests prove the adapters; workflow-pipeline proves the executor over
 *     mock; nothing proved a real kind THROUGH the executor. Identical-
 *     behaviour control: a mock-kind instance on an identically-shaped
 *     template ends in the same stage-status vector with the same context
 *     contract (branch/prId/mergeSha).
 *  2. THE MIRROR-FAILURE PATH: every existing mirror test asserts ok:true.
 *     Nothing pinned that a PM outage cannot roll back governance — that a
 *     sign-off decision COMMITS locally when the mirror throws, with the
 *     failure surfaced (pmMirror.ok=false) rather than a 500 or an unwound
 *     decision. Probed by tombstoning the linked work item in the shared mock
 *     provider so transitionState/addComment throw. Control (non-vacuity): an
 *     intact sibling instance mirrors ok:true through the same path.
 *  3. A readwrite connector op under a read-only grant is refused BEFORE THE
 *     ADAPTER RUNS: mcp-proxy pins the 403; this probe pins the "before the
 *     adapter" half via the shared mock connector's recorded-writes ledger
 *     (delta 0 on refusal). Control: a readwrite grant's write lands delta +1.
 *
 * Shares one DB (fileParallelism off); everything is prefixed s9-. The one
 * org-level singleton this file touches is the egress allow-list entry for
 * 127.0.0.1, which is deleted in afterAll (M-012).
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);
const BOOT = "s9-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
/** per-run suffix so rerunning this single file against the same DB never
 * double-matches an assignment rule (org-settings.test.ts precedent) */
const RUN = Date.now().toString(36);

let db: Db;
let app: ReturnType<typeof buildApp>;
let userId: string;
let userAuth: { authorization: string };
let allowHostId: string;

async function makeUser(email: string) {
  const u = await app.inject({
    method: "POST", headers: AUTH, url: "/v1/users",
    payload: { email, displayName: email.split("@")[0]!.replace(/-/g, " ") },
  });
  expect(u.statusCode).toBe(201);
  const k = await app.inject({
    method: "POST", headers: AUTH, url: `/v1/users/${u.json().id}/keys`, payload: { name: "s9" },
  });
  return { id: u.json().id as string, auth: { authorization: `Bearer ${k.json().token}` } };
}

async function lastAudit(ruleId: string) {
  const [row] = await db
    .select()
    .from(auditLog)
    .where(eq(auditLog.ruleId, ruleId))
    .orderBy(desc(auditLog.at))
    .limit(1);
  return row;
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "b9".repeat(32) });

  const user = await makeUser("s9-user@example.com");
  userId = user.id;
  userAuth = user.auth;

  // the loopback allow entry the gitlab fake upstream needs (the same opt-ins
  // an air-gapped operator uses; connection-egress.test.ts precedent)
  const allowed = await app.inject({
    method: "POST", headers: AUTH, url: "/v1/egress-allow-hosts",
    payload: {
      host: "127.0.0.1", allowPrivateRanges: true, allowPlaintextHttp: true,
      note: "s9 probe: local fake GitLab",
    },
  });
  expect(allowed.statusCode).toBe(201);
  allowHostId = allowed.json().id;
});

afterAll(async () => {
  // M-012: hand the shared allow-list back exactly as found
  await app.inject({ method: "DELETE", headers: AUTH, url: `/v1/egress-allow-hosts/${allowHostId}` });
  app.server.closeAllConnections();
  await app.close();
});

// ===========================================================================
// (1) a REAL git kind through the workflow executor contract
// ===========================================================================

describe("gitlab through the workflow executor: branch → PR → merge, real adapter, guarded fetch", () => {
  const REPO = "s9grp/app";
  const PROJ = encodeURIComponent(REPO); // s9grp%2Fapp
  const TOKEN = "glpat-s9-secret";
  let fakeGitlab: http.Server;
  let gitlabPort: number;
  const seen: Array<{ method: string; url: string; privateToken: string | undefined; body: unknown }> = [];

  /** template shape shared by the gitlab and mock instances so the parity
   * comparison compares EXECUTOR behaviour, not template differences */
  const gitStages = (prefix: string, connection: string) => [
    { id: `${prefix}-intake`, type: "trigger" },
    { id: `${prefix}-branch`, type: "git_operation", action: "create_branch", connection, repo: REPO },
    { id: `${prefix}-pr`, type: "git_operation", action: "open_pr", connection, repo: REPO },
    { id: `${prefix}-merge`, type: "git_operation", action: "merge", connection, repo: REPO, strategy: "merge" },
  ];

  async function registerPipeline(prefix: string, connection: string): Promise<string> {
    const tpl = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/workflows/templates",
      payload: { name: `${prefix}-tpl-${RUN}`, definition: { workflow: `${prefix}-tpl-${RUN}`, stages: gitStages(prefix, connection) } },
    });
    expect(tpl.statusCode).toBe(201);
    const changeType = `${prefix}-change-${RUN}`;
    const rule = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/workflows/assignment-rules",
      payload: { templateId: tpl.json().id, changeType },
    });
    expect(rule.statusCode).toBe(201);
    return changeType;
  }

  async function startInstance(changeType: string) {
    const started = await app.inject({
      method: "POST", headers: userAuth, url: "/v1/workflows/instances",
      payload: { change: { description: "s9 gitlab parity change", paths: ["src/x.ts"], changeType, environment: "staging" } },
    });
    expect(started.statusCode).toBe(201);
    const view = await app.inject({
      method: "GET", headers: userAuth, url: `/v1/workflows/instances/${started.json().id}`,
    });
    return { id: started.json().id as string, instance: view.json().instance };
  }

  beforeAll(async () => {
    // a live GitLab-shaped fake upstream on loopback (the git-provider
    // package's own fake-upstream pattern, inlined — testkit.ts is package-internal)
    fakeGitlab = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        seen.push({
          method: req.method ?? "GET",
          url: req.url ?? "",
          privateToken: req.headers["private-token"] as string | undefined,
          body: raw ? (JSON.parse(raw) as unknown) : undefined,
        });
        const route = `${req.method} ${req.url}`;
        let out: { status: number; body: unknown } | null = null;
        if (route === `POST /api/v4/projects/${PROJ}/repository/branches`) {
          out = { status: 201, body: { name: "created" } };
        } else if (route === `POST /api/v4/projects/${PROJ}/merge_requests`) {
          out = { status: 201, body: { id: 991, iid: 7, web_url: `https://gitlab.example/${REPO}/-/merge_requests/7` } };
        } else if (route === `PUT /api/v4/projects/${PROJ}/merge_requests/7/merge`) {
          out = { status: 200, body: { state: "merged", merge_commit_sha: "s9-merge-sha", sha: "s9-head-sha" } };
        }
        res.writeHead(out ? out.status : 500, { "content-type": "application/json" });
        res.end(JSON.stringify(out ? out.body : { error: `no fake route for '${route}'` }));
      });
    });
    await new Promise<void>((r) => fakeGitlab.listen(0, "127.0.0.1", r));
    gitlabPort = (fakeGitlab.address() as { port: number }).port;
  });

  afterAll(async () => {
    fakeGitlab.closeAllConnections?.();
    await new Promise<void>((r) => fakeGitlab.close(() => r()));
  });

  it("a gitlab connection drives the pipeline to completed, and the upstream saw exactly the three provider calls", async () => {
    const conn = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/git/connections",
      payload: { name: `s9-gitlab-${RUN}`, provider: "gitlab", token: TOKEN, baseUrl: `http://127.0.0.1:${gitlabPort}` },
    });
    expect(conn.statusCode).toBe(201);

    const changeType = await registerPipeline("s9gl", `s9-gitlab-${RUN}`);
    const { id, instance } = await startInstance(changeType);

    // the executor ran every stage to completion — no lastError, no parked stage
    expect(instance.context.lastError, JSON.stringify(instance.context)).toBeUndefined();
    expect(instance.status).toBe("completed");
    expect(instance.state.stageStatuses).toEqual(Array(4).fill("completed"));

    // the executor's git contract landed in the context exactly as with mock
    const expectedBranch = `regulait/${id.slice(0, 8)}`;
    expect(instance.context.branch).toBe(expectedBranch);
    expect(instance.context.prId).toBe("7"); // the MR iid, not the global id
    expect(instance.context.prUrl).toContain("/merge_requests/7");
    expect(instance.context.mergeSha).toBe("s9-merge-sha");

    // NON-VACUITY: the REAL adapter was dialled through the guarded fetch —
    // three calls, in pipeline order, carrying the decrypted PRIVATE-TOKEN
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual([
      `POST /api/v4/projects/${PROJ}/repository/branches`,
      `POST /api/v4/projects/${PROJ}/merge_requests`,
      `PUT /api/v4/projects/${PROJ}/merge_requests/7/merge`,
    ]);
    expect(seen.every((s) => s.privateToken === TOKEN)).toBe(true);
    expect(seen[0]!.body).toEqual({ branch: expectedBranch, ref: "main" });
    expect(seen[1]!.body).toMatchObject({
      source_branch: expectedBranch,
      target_branch: "main",
      title: "s9 gitlab parity change",
    });
    expect(seen[2]!.body).toEqual({ squash: false });
  });

  it("PARITY CONTROL: a mock-kind instance on the same template shape ends byte-identical on the executor contract", async () => {
    const conn = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/git/connections",
      payload: { name: `s9-mockgit-${RUN}`, provider: "mock", token: "not-a-real-token" },
    });
    expect(conn.statusCode).toBe(201);

    const changeType = await registerPipeline("s9mk", `s9-mockgit-${RUN}`);
    const upstreamCallsBefore = seen.length;
    const { id, instance } = await startInstance(changeType);

    // identical terminal state and identical context contract
    expect(instance.status).toBe("completed");
    expect(instance.state.stageStatuses).toEqual(Array(4).fill("completed"));
    expect(instance.context.branch).toBe(`regulait/${id.slice(0, 8)}`);
    expect(typeof instance.context.prId).toBe("string");
    expect(typeof instance.context.mergeSha).toBe("string");
    // and the mock never touches the network — the fake upstream saw nothing new
    expect(seen.length).toBe(upstreamCallsBefore);
  });
});

// ===========================================================================
// (2) the PM mirror-failure path: an outage never rolls back governance
// ===========================================================================

describe("approval mirroring survives a failing PM adapter", () => {
  const PM_PROJECT = "s9-signoff-proj";
  const CONN = `s9-pm-signoff-${RUN}`;
  let changeType: string;

  /** intake → artifact → signoff, pm-synced; returns ids ready to decide */
  async function instanceReadyToDecide() {
    const started = await app.inject({
      method: "POST", headers: userAuth, url: "/v1/workflows/instances",
      payload: { change: { description: "s9 mirrored change", paths: ["svc/a.ts"], changeType, environment: "staging" } },
    });
    expect(started.statusCode).toBe(201);
    const instanceId = started.json().id as string;
    const sync = await app.inject({
      method: "POST", headers: userAuth, url: `/v1/workflows/instances/${instanceId}/pm-sync`,
      payload: { connectionName: CONN },
    });
    expect(sync.statusCode).toBe(201);
    const externalId = sync.json().externalId as string;
    const art = await app.inject({
      method: "POST", headers: userAuth, url: `/v1/workflows/instances/${instanceId}/artifacts`,
      payload: { stageId: "s9-spec", content: "the spec" },
    });
    expect(art.statusCode).toBe(201);
    const inbox = await app.inject({ method: "GET", headers: userAuth, url: "/v1/approvals?status=pending" });
    const entry = inbox.json().approvals.find(
      (a: { instanceId: string | null }) => a.instanceId === instanceId,
    );
    expect(entry).toBeTruthy();
    return { instanceId, externalId, approvalId: entry.id as string };
  }

  beforeAll(async () => {
    const conn = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/pm/connections",
      payload: {
        name: CONN, provider: "mock", project: PM_PROJECT, token: "mock-token",
        mapping: {
          task: { workItemType: "Task", fields: { title: "title", status: "state" } },
          approval: { target: "status_transition", stageMap: { "s9-signoff": "Signed Off" } },
        },
      },
    });
    expect(conn.statusCode).toBe(201);

    const tpl = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/workflows/templates",
      payload: {
        name: `s9-mirror-tpl-${RUN}`,
        definition: {
          workflow: `s9-mirror-tpl-${RUN}`,
          stages: [
            { id: "s9-intake", type: "trigger" },
            { id: "s9-spec", type: "artifact_generation", output: "spec_doc" },
            { id: "s9-signoff", type: "human_approval", approvers: ["requesting_user"] },
          ],
        },
      },
    });
    expect(tpl.statusCode).toBe(201);
    changeType = `s9-mirror-change-${RUN}`;
    const rule = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/workflows/assignment-rules",
      payload: { templateId: tpl.json().id, changeType },
    });
    expect(rule.statusCode).toBe(201);
  });

  it("THE ATTACK: the linked item dies upstream, the decision still commits, the failure is surfaced — never a rollback", async () => {
    const { instanceId, externalId, approvalId } = await instanceReadyToDecide();

    // the PM tool loses the work item BETWEEN sync and decision (an outage,
    // a deletion, a permissions change — anything that makes the mirror throw)
    const mock = resolvePmProvider({ provider: "mock", token: "" }) as MockPmProvider;
    await mock.deleteWorkItem(PM_PROJECT, externalId);

    const mirroredAuditsBefore = (await lastAudit("pm-approval-mirrored"))?.at ?? null;

    const decided = await app.inject({
      method: "POST", headers: userAuth, url: `/v1/approvals/${approvalId}/decide`,
      payload: { decision: "approved", reason: "s9 decide through the outage" },
    });
    // the decision is durable: 200, approved — the PM failure did NOT unwind it
    expect(decided.statusCode).toBe(200);
    expect(decided.json().status).toBe("approved");
    // and the failure is SURFACED, not swallowed and not pretended successful
    expect(decided.json().pmMirror.ok).toBe(false);
    expect(decided.json().pmMirror.error).toContain("deleted");

    // the workflow advanced on the LOCAL decision — governance never waited on the PM tool
    const view = await app.inject({
      method: "GET", headers: userAuth, url: `/v1/workflows/instances/${instanceId}`,
    });
    expect(view.json().instance.status).toBe("completed");

    // no success audit was minted for a mirror that failed
    const after = (await lastAudit("pm-approval-mirrored"))?.at ?? null;
    expect(after?.toString() ?? null).toBe(mirroredAuditsBefore?.toString() ?? null);
  });

  it("CONTROL (non-vacuity): an intact sibling instance mirrors ok:true through the same path", async () => {
    const { instanceId, externalId, approvalId } = await instanceReadyToDecide();
    const decided = await app.inject({
      method: "POST", headers: userAuth, url: `/v1/approvals/${approvalId}/decide`,
      payload: { decision: "approved", reason: "s9 healthy mirror" },
    });
    expect(decided.statusCode).toBe(200);
    expect(decided.json().status).toBe("approved");
    expect(decided.json().pmMirror).toEqual({ ok: true, action: "transition" });

    const mock = resolvePmProvider({ provider: "mock", token: "" });
    const item = await mock.getWorkItem(PM_PROJECT, externalId);
    expect(item.state).toBe("Signed Off");
    expect(item.comments.some((c) => c.includes("s9-signoff") && c.includes("approved"))).toBe(true);

    const view = await app.inject({
      method: "GET", headers: userAuth, url: `/v1/workflows/instances/${instanceId}`,
    });
    expect(view.json().instance.status).toBe("completed");
  });
});

// ===========================================================================
// (3) a read-only grant refuses a write BEFORE the adapter runs
// ===========================================================================

describe("connector read-only grant: the refusal happens before the adapter, not inside it", () => {
  let connectorId: string;
  let writerAuth: { authorization: string };
  const sharedMock = resolveConnectorProvider({ kind: "mock" }) as MockConnectorProvider;

  beforeAll(async () => {
    connectorId = (await app.inject({
      method: "POST", headers: AUTH, url: "/v1/connectors",
      payload: { name: `s9-warehouse-${RUN}`, kind: "data-warehouse", providerKind: "mock" },
    })).json().id;
    // the read-only caller (userId) and a readwrite control caller
    await app.inject({
      method: "POST", headers: AUTH, url: "/v1/grants/connectors",
      payload: { userId, connectorId, mode: "read", allowedObjects: ["s9-accounts"] },
    });
    const writer = await makeUser("s9-writer@example.com");
    writerAuth = writer.auth;
    await app.inject({
      method: "POST", headers: AUTH, url: "/v1/grants/connectors",
      payload: { userId: writer.id, connectorId, mode: "readwrite", allowedObjects: ["s9-accounts"] },
    });
  });

  it("THE ATTACK: a write under mode:'read' is a 403 and the adapter's write ledger does not move", async () => {
    const writesBefore = sharedMock.writes.length;
    const refused = await app.inject({
      method: "POST", headers: userAuth, url: `/v1/connectors/${connectorId}/invoke`,
      payload: { operation: "write", object: "s9-accounts", payload: { note: "s9 must never land" } },
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().decision.reason).toContain("read-only");
    // DELTA (M-008): the adapter never ran — the gateway refused upstream of it
    expect(sharedMock.writes.length).toBe(writesBefore);
    expect(sharedMock.writes.some((w) => (w.payload as { note?: string }).note === "s9 must never land")).toBe(false);
  });

  it("CONTROL (non-vacuity): the same write under mode:'readwrite' reaches the adapter, delta +1", async () => {
    const writesBefore = sharedMock.writes.length;
    const ok = await app.inject({
      method: "POST", headers: writerAuth, url: `/v1/connectors/${connectorId}/invoke`,
      payload: { operation: "write", object: "s9-accounts", payload: { note: "s9 legitimate write" } },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().decision.effect).toBe("allow");
    expect(sharedMock.writes.length).toBe(writesBefore + 1);
    expect(sharedMock.writes[sharedMock.writes.length - 1]).toEqual({
      object: "s9-accounts",
      payload: { note: "s9 legitimate write" },
    });
  });
});
