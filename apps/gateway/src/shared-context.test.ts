import { beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb, runMigrations, type Db } from "@regulait/db";
import { buildApp } from "./app.js";

/**
 * Slice 5 — the pillar-4 write surface in /app, driven exactly as the UI
 * drives it (ADR-0012: the portal is a pure API client):
 *   · the context editor's read-before-write journey: first write with no
 *     base, clean edit against the fetched base, the blind-write 409 the
 *     editor's pre-check leans on, and the deliberate stale-base submit that
 *     is retained and routed to the arbiter;
 *   · the display enrichments the screens need: provenance names on the
 *     context list, pending-awaiting-arbiter markers (card badge + history
 *     drawer), member names, the arbiter's name, and BOTH candidate texts on
 *     the arbiter's inbox row;
 *   · arbitration outcomes reflected in the list: approve → the retained
 *     revision becomes current; deny → historical forever;
 *   · the names-only /v1/users/directory behind the owner's add-member form
 *     (readable by non-admins, leaking no emails);
 *   · promote-to-shared-context from the workflow detail surface, with the
 *     not-the-artifact-owner rejection the UI renders gracefully.
 *
 * Shares one database with the other gateway suites (fileParallelism off),
 * so every object here is name-prefixed s5-.
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "s5-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = "e".repeat(64);

let db: Db;
let app: ReturnType<typeof buildApp>;

type Auth = { authorization: string };
let oliveId: string; // project owner
let oliveAuth: Auth;
let coraId: string; // contributor, team s5-team-a
let coraAuth: Auth;
let caseyId: string; // contributor, team s5-team-b
let caseyAuth: Auth;
let vinnieAuth: Auth; // viewer
let abbyId: string; // named arbiter — deliberately NOT a project member
let abbyAuth: Auth;
let drewId: string; // in the directory, not yet a member
let teamAId: string;
let projectId: string;

const KEY = "s5-notes";
const V1 = "s5 v1 — errors are values at boundaries";
const V2 = "s5 v2 — errors are values; every external call is wrapped";
const V3_CORA = "s5 cora's competing v3 — wrap AND log every external call";

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });

  const mkUser = async (email: string, name: string) => {
    const r = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/users",
      payload: { email, displayName: name },
    });
    expect(r.statusCode).toBe(201);
    return r.json().id as string;
  };
  const authFor = async (userId: string): Promise<Auth> => {
    const r = await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/users/${userId}/keys`,
      payload: { name: "s5" },
    });
    return { authorization: `Bearer ${r.json().token}` };
  };

  oliveId = await mkUser("s5-olive@example.com", "S5 Olive");
  coraId = await mkUser("s5-cora@example.com", "S5 Cora");
  caseyId = await mkUser("s5-casey@example.com", "S5 Casey");
  const vinnieId = await mkUser("s5-vinnie@example.com", "S5 Vinnie");
  abbyId = await mkUser("s5-abby@example.com", "S5 Abby");
  drewId = await mkUser("s5-drew@example.com", "S5 Drew");
  oliveAuth = await authFor(oliveId);
  coraAuth = await authFor(coraId);
  caseyAuth = await authFor(caseyId);
  vinnieAuth = await authFor(vinnieId);
  abbyAuth = await authFor(abbyId);

  const teamA = await app.inject({
    method: "POST", headers: AUTH, url: "/v1/teams", payload: { name: "s5-team-a" },
  });
  teamAId = teamA.json().id;
  const teamB = await app.inject({
    method: "POST", headers: AUTH, url: "/v1/teams", payload: { name: "s5-team-b" },
  });
  const teamBId = teamB.json().id;
  await app.inject({
    method: "POST", headers: AUTH, url: `/v1/teams/${teamAId}/members`, payload: { userId: coraId },
  });
  await app.inject({
    method: "POST", headers: AUTH, url: `/v1/teams/${teamBId}/members`, payload: { userId: caseyId },
  });

  const project = await app.inject({
    method: "POST", headers: AUTH, url: "/v1/projects",
    payload: { name: "s5-shared", arbiterUserId: abbyId },
  });
  expect(project.statusCode).toBe(201);
  projectId = project.json().id;
  for (const [userId, role, teamId] of [
    [oliveId, "owner", null],
    [coraId, "contributor", teamAId],
    [caseyId, "contributor", teamBId],
    [vinnieId, "viewer", null],
  ] as const) {
    const r = await app.inject({
      method: "POST", headers: AUTH, url: `/v1/projects/${projectId}/members`,
      payload: { userId, role, teamId },
    });
    expect(r.statusCode).toBe(201);
  }
});

describe("slice 5: the context editor's read-before-write journey", () => {
  it("first write of a key needs no base and lands accepted with named provenance", async () => {
    const write = await app.inject({
      method: "POST", headers: coraAuth, url: `/v1/projects/${projectId}/context`,
      payload: { key: KEY, content: V1 }, // the exact new-key payload the editor POSTs
    });
    expect(write.statusCode).toBe(201);
    expect(write.json()).toMatchObject({ revision: 1, accepted: true });

    const view = await app.inject({
      method: "GET", headers: vinnieAuth, url: `/v1/projects/${projectId}/context`,
    });
    const item = view.json().context.find((c: { key: string }) => c.key === KEY);
    expect(item.provenance).toMatchObject({
      userId: coraId,
      userName: "S5 Cora",
      teamId: teamAId,
      teamName: "s5-team-a", // membership's team rode in as provenance default
    });
    // the editor's "sent to <arbiter>" copy and the card's pending marker
    expect(view.json().arbiter).toMatchObject({ userId: abbyId, name: "S5 Abby" });
    expect(view.json().pending).toEqual([]);
  });

  it("a clean edit submits with the fetched base revision and becomes current", async () => {
    // (a) the editor fetches the current revision first…
    const cur = await app.inject({
      method: "GET", headers: caseyAuth,
      url: `/v1/projects/${projectId}/context?key=${KEY}`,
    });
    const base = cur.json().context[0].revision;
    expect(base).toBe(1);
    // …and (b) submits naming it
    const write = await app.inject({
      method: "POST", headers: caseyAuth, url: `/v1/projects/${projectId}/context`,
      payload: { key: KEY, content: V2, baseRevision: base },
    });
    expect(write.json()).toMatchObject({ revision: 2, accepted: true });
    const view = await app.inject({
      method: "GET", headers: vinnieAuth, url: `/v1/projects/${projectId}/context?key=${KEY}`,
    });
    expect(view.json().context[0]).toMatchObject({ revision: 2, content: V2 });
  });

  it("a blind write 409s with the latest accepted base — the contract the editor's pre-check leans on", async () => {
    const blind = await app.inject({
      method: "POST", headers: coraAuth, url: `/v1/projects/${projectId}/context`,
      payload: { key: KEY, content: "no base named" },
    });
    expect(blind.statusCode).toBe(409);
    expect(blind.json()).toMatchObject({ error: "base_revision_required", latestAccepted: 2 });
  });

  it("a stale-base submit is retained — pending on the list, awaiting-arbiter in the history drawer", async () => {
    const stale = await app.inject({
      method: "POST", headers: coraAuth, url: `/v1/projects/${projectId}/context`,
      payload: { key: KEY, content: V3_CORA, baseRevision: 1 }, // the editor's "submit against my stale base"
    });
    expect(stale.statusCode).toBe(201);
    expect(stale.json()).toMatchObject({ revision: 3, accepted: false, conflict: true });
    const approvalId = stale.json().approvalId as string;

    // nothing overwritten; the card shows "1 revision awaiting arbiter"
    const view = await app.inject({
      method: "GET", headers: vinnieAuth, url: `/v1/projects/${projectId}/context`,
    });
    expect(view.json().context.find((c: { key: string }) => c.key === KEY).revision).toBe(2);
    expect(view.json().pending).toHaveLength(1);
    expect(view.json().pending[0]).toMatchObject({
      key: KEY,
      revision: 3,
      baseRevision: 1,
      content: V3_CORA,
      byName: "S5 Cora",
      approvalId,
    });

    // the history drawer can label every row: accepted / awaiting arbiter
    const history = await app.inject({
      method: "GET", headers: vinnieAuth,
      url: `/v1/projects/${projectId}/context?key=${KEY}&history=true`,
    });
    const rows = history.json().history;
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ revision: 1, accepted: true, byName: "S5 Cora", pendingApprovalId: null });
    expect(rows[1]).toMatchObject({ revision: 2, accepted: true, byName: "S5 Casey", teamName: "s5-team-b" });
    expect(rows[2]).toMatchObject({ revision: 3, accepted: false, pendingApprovalId: approvalId });
  });

  it("the arbiter's inbox row carries BOTH candidate texts — even for a non-member arbiter", async () => {
    const inbox = await app.inject({ method: "GET", headers: abbyAuth, url: "/v1/approvals?status=pending" });
    const row = inbox.json().approvals.find((a: { projectId: string | null }) => a.projectId === projectId);
    expect(row).toBeTruthy();
    expect(row.objectLabel).toBe("s5-shared");
    expect(row.contextConflict).toMatchObject({
      key: KEY,
      conflicting: { revision: 3, baseRevision: 1, content: V3_CORA, byName: "S5 Cora" },
      current: { revision: 2, content: V2, byName: "S5 Casey" },
    });
  });

  it("arbiter approval makes the retained revision current; the pending markers clear", async () => {
    const inbox = await app.inject({ method: "GET", headers: abbyAuth, url: "/v1/approvals?status=pending" });
    const row = inbox.json().approvals.find((a: { projectId: string | null }) => a.projectId === projectId);
    const decided = await app.inject({
      method: "POST", headers: abbyAuth, url: `/v1/approvals/${row.id}/decide`,
      payload: { decision: "approved", reason: "cora's wording covers logging too" },
    });
    expect(decided.statusCode).toBe(200);

    const view = await app.inject({
      method: "GET", headers: vinnieAuth, url: `/v1/projects/${projectId}/context?key=${KEY}`,
    });
    expect(view.json().context[0]).toMatchObject({ revision: 3, content: V3_CORA });
    expect(view.json().pending).toEqual([]);
    const history = await app.inject({
      method: "GET", headers: vinnieAuth,
      url: `/v1/projects/${projectId}/context?key=${KEY}&history=true`,
    });
    expect(history.json().history[2]).toMatchObject({ revision: 3, accepted: true, pendingApprovalId: null });
  });

  it("a denied conflict stays historical — 'rejected' in the drawer, never current, never pending", async () => {
    const stale = await app.inject({
      method: "POST", headers: caseyAuth, url: `/v1/projects/${projectId}/context`,
      payload: { key: KEY, content: "s5 casey's counter-proposal", baseRevision: 2 },
    });
    expect(stale.json()).toMatchObject({ revision: 4, conflict: true });
    await app.inject({
      method: "POST", headers: abbyAuth, url: `/v1/approvals/${stale.json().approvalId}/decide`,
      payload: { decision: "denied", reason: "rev 3 already covers it" },
    });

    const view = await app.inject({
      method: "GET", headers: vinnieAuth, url: `/v1/projects/${projectId}/context?key=${KEY}`,
    });
    expect(view.json().context[0].revision).toBe(3); // unchanged
    expect(view.json().pending).toEqual([]); // decided → no longer awaiting anyone
    const history = await app.inject({
      method: "GET", headers: vinnieAuth,
      url: `/v1/projects/${projectId}/context?key=${KEY}&history=true`,
    });
    // accepted=false with NO pending approval = the drawer's "rejected" state
    expect(history.json().history[3]).toMatchObject({ revision: 4, accepted: false, pendingApprovalId: null });
  });
});

describe("slice 5: members surface + the names-only directory", () => {
  it("the members list names people and teams for any member", async () => {
    const res = await app.inject({
      method: "GET", headers: vinnieAuth, url: `/v1/projects/${projectId}/members`,
    });
    expect(res.statusCode).toBe(200);
    const cora = res.json().members.find((m: { userId: string }) => m.userId === coraId);
    expect(cora).toMatchObject({ userName: "S5 Cora", teamName: "s5-team-a", role: "contributor" });
    const olive = res.json().members.find((m: { userId: string }) => m.userId === oliveId);
    expect(olive).toMatchObject({ userName: "S5 Olive", teamName: null, role: "owner" });
  });

  it("the directory is readable by a non-admin, names-only — no emails, no admin flags", async () => {
    const res = await app.inject({ method: "GET", headers: coraAuth, url: "/v1/users/directory" });
    expect(res.statusCode).toBe(200);
    const drew = res.json().users.find((u: { id: string }) => u.id === drewId);
    expect(drew).toMatchObject({ name: "S5 Drew", teams: [] });
    const cora = res.json().users.find((u: { id: string }) => u.id === coraId);
    expect(cora.teams).toEqual([{ id: teamAId, name: "s5-team-a" }]);
    // names only: nothing else about anyone leaves through this endpoint
    expect(res.body).not.toContain("@example.com");
    expect(Object.keys(drew).sort()).toEqual(["id", "name", "teams"]);
  });

  it("an owner adds a member from the directory; a contributor cannot", async () => {
    const denied = await app.inject({
      method: "POST", headers: coraAuth, url: `/v1/projects/${projectId}/members`,
      payload: { userId: drewId, role: "viewer" },
    });
    expect(denied.statusCode).toBe(403);

    const added = await app.inject({
      method: "POST", headers: oliveAuth, url: `/v1/projects/${projectId}/members`,
      payload: { userId: drewId, role: "viewer" }, // the add-member form's payload
    });
    expect(added.statusCode).toBe(201);
    const res = await app.inject({
      method: "GET", headers: vinnieAuth, url: `/v1/projects/${projectId}/members`,
    });
    expect(res.json().members.find((m: { userId: string }) => m.userId === drewId)).toMatchObject({
      userName: "S5 Drew", role: "viewer",
    });
  });
});

describe("slice 5: promote-to-shared-context from the workflow detail surface", () => {
  let artifactId: string;

  it("the initiator promotes a workflow artifact into shared context with provenance", async () => {
    const tpl = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/workflows/templates",
      payload: {
        name: "s5-promote",
        definition: {
          workflow: "s5-promote",
          stages: [
            { id: "intake", type: "trigger" },
            { id: "draft", type: "artifact_generation", output: "s5-plan" },
          ],
        },
      },
    });
    await app.inject({
      method: "POST", headers: AUTH, url: "/v1/workflows/assignment-rules",
      payload: { templateId: tpl.json().id, changeType: "s5-promote" },
    });
    const started = await app.inject({
      method: "POST", headers: coraAuth, url: "/v1/workflows/instances",
      payload: {
        projectId,
        change: { description: "s5 promote journey", paths: ["a.ts"], changeType: "s5-promote", environment: "staging" },
      },
    });
    expect(started.statusCode).toBe(201);
    const instanceId = started.json().id;
    await app.inject({
      method: "POST", headers: coraAuth, url: `/v1/workflows/instances/${instanceId}/artifacts`,
      payload: { stageId: "draft", content: "S5 PROMOTED PLAN CONTENT" },
    });
    const view = await app.inject({
      method: "GET", headers: coraAuth, url: `/v1/workflows/instances/${instanceId}`,
    });
    artifactId = view.json().artifacts[0].id;

    const promoted = await app.inject({
      method: "POST", headers: coraAuth, url: `/v1/projects/${projectId}/context/promote`,
      payload: { artifactId }, // exactly what the detail page's button POSTs
    });
    expect(promoted.statusCode).toBe(201);
    expect(promoted.json()).toMatchObject({ key: "s5-plan", revision: 1, accepted: true });

    const ctx = await app.inject({
      method: "GET", headers: vinnieAuth, url: `/v1/projects/${projectId}/context?key=s5-plan`,
    });
    expect(ctx.json().context[0].content).toBe("S5 PROMOTED PLAN CONTENT");
    expect(ctx.json().context[0].provenance).toMatchObject({
      userName: "S5 Cora",
      sourceArtifactId: artifactId,
    });
  });

  it("anyone else gets the not-the-artifact-owner rejection the UI renders gracefully", async () => {
    const stolen = await app.inject({
      method: "POST", headers: caseyAuth, url: `/v1/projects/${projectId}/context/promote`,
      payload: { artifactId },
    });
    expect(stolen.statusCode).toBe(403);
    expect(stolen.json().error).toBe("not_the_artifact_owner");
  });
});

describe("pillar-4 polish: falsifiable provenance + the concurrent-write race", () => {
  const PKEY = "s5-provenance";

  it("a bootstrap-token contribution is refused — never mis-attributed to a governance-role holder", async () => {
    // the bootstrap/admin token has NO user identity; authorship must not fall
    // back to the project's budget approver or arbiter (the old bug)
    const res = await app.inject({
      method: "POST", headers: AUTH,
      url: `/v1/projects/${projectId}/context`,
      payload: { key: PKEY, content: "written by no real user" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("bootstrap_cannot_contribute");
    // and nothing landed under anyone's name for that key
    const view = await app.inject({
      method: "GET", headers: vinnieAuth, url: `/v1/projects/${projectId}/context?key=${PKEY}`,
    });
    expect(view.json().context).toEqual([]);
  });

  it("an authenticated contribution attributes to the REAL writer", async () => {
    const write = await app.inject({
      method: "POST", headers: coraAuth,
      url: `/v1/projects/${projectId}/context`,
      payload: { key: PKEY, content: "written by cora" },
    });
    expect(write.statusCode).toBe(201);
    const view = await app.inject({
      method: "GET", headers: vinnieAuth, url: `/v1/projects/${projectId}/context?key=${PKEY}`,
    });
    expect(view.json().context[0].provenance).toMatchObject({ userId: coraId, userName: "S5 Cora" });
  });

  it("two concurrent same-key writes never duplicate a revision (the unique index holds)", async () => {
    const RKEY = "s5-race";
    const seed = await app.inject({
      method: "POST", headers: coraAuth, url: `/v1/projects/${projectId}/context`,
      payload: { key: RKEY, content: "race base v1" },
    });
    expect(seed.statusCode).toBe(201);

    // fire two writes concurrently, both naming the SAME base revision — they
    // compute the same next revision and race for it
    const [a, b] = await Promise.all([
      app.inject({
        method: "POST", headers: coraAuth, url: `/v1/projects/${projectId}/context`,
        payload: { key: RKEY, baseRevision: 1, content: "racer A" },
      }),
      app.inject({
        method: "POST", headers: caseyAuth, url: `/v1/projects/${projectId}/context`,
        payload: { key: RKEY, baseRevision: 1, content: "racer B" },
      }),
    ]);
    // neither 500s; one becomes the current revision, the loser is retried and
    // lands as a distinct higher (conflicting) revision — never a duplicate
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);

    const history = await app.inject({
      method: "GET", headers: vinnieAuth,
      url: `/v1/projects/${projectId}/context?key=${RKEY}&history=true`,
    });
    const revs = history.json().history.map((r: { revision: number }) => r.revision);
    expect(revs.length).toBe(3); // rev1 + the two racers
    expect(new Set(revs).size).toBe(revs.length); // NO duplicate revision number
    // exactly one racer won the accepted head (rev2); the other is a retained
    // conflict (rev3), never a second row at the same revision
    const accepted = history
      .json()
      .history.filter((r: { accepted: boolean }) => r.accepted)
      .map((r: { revision: number }) => r.revision)
      .sort((x: number, y: number) => x - y);
    expect(accepted).toEqual([1, 2]);
  });
});
