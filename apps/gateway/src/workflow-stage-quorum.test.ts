import { beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, approvals, createDb, eq, runMigrations, type Db } from "@regulait/db";
import { buildApp } from "./app.js";

/**
 * Per-template STAGE quorum (ADR-0027 — the deferral recorded in ADR-0021):
 * a human_approval stage may carry quorum 'all'|'any', overriding the org
 * default in BOTH directions; absent = org default = today; unknown values
 * and quorum on a non-approval stage are refused loudly at template
 * validation. Shares one DB (fileParallelism off); prefix wq-.
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);
const BOOT = "wq-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };

let db: Db;
let app: ReturnType<typeof buildApp>;
let anaId: string;
let anaAuth: { authorization: string };
let bobId: string;
let bobAuth: { authorization: string };
let piaAuth: { authorization: string };

async function makeUser(email: string) {
  const u = await app.inject({ method: "POST", headers: AUTH, url: "/v1/users", payload: { email, displayName: email.split("@")[0] } });
  const k = await app.inject({ method: "POST", headers: AUTH, url: `/v1/users/${u.json().id}/keys`, payload: { name: "wq" } });
  return { id: u.json().id as string, auth: { authorization: `Bearer ${k.json().token}` } };
}

async function makeTemplate(name: string, changeType: string, gate: Record<string, unknown>) {
  const tpl = await app.inject({
    method: "POST", headers: AUTH, url: "/v1/workflows/templates",
    payload: { name, definition: { workflow: name, stages: [
      { id: "intake", type: "trigger" },
      { id: "gate", type: "human_approval", approvers: [anaId, bobId], ...gate },
    ] } },
  });
  if (tpl.statusCode === 201) {
    await app.inject({
      method: "POST", headers: AUTH, url: "/v1/workflows/assignment-rules",
      payload: { templateId: tpl.json().id, changeType },
    });
  }
  return tpl;
}

async function start(changeType: string): Promise<string> {
  const r = await app.inject({
    method: "POST", headers: piaAuth, url: "/v1/workflows/instances",
    payload: { change: { description: "wq", paths: ["x"], changeType, environment: "dev" } },
  });
  expect(r.statusCode).toBe(201);
  return r.json().id as string;
}

/**
 * Decide the gate approval THAT BELONGS TO `whoId`.
 *
 * The `approverUserId` match is load-bearing, not defensive. Under a quorum of
 * `all` this instance has one pending gate approval PER approver, and only the
 * named approver may decide their own (`not_the_named_approver`, 403). This
 * helper used to take the first gate approval in the list, which is only ever
 * correct by luck: the route's query carries no ORDER BY, so the order is
 * whatever Postgres hands back. It passed locally for months and failed in CI
 * the first time the physical row order came back the other way round — ana
 * trying to decide bob's approval, and the platform correctly refusing.
 */
async function decideAs(
  instanceId: string,
  whoId: string,
  who: { authorization: string },
  decision = "approved" as const,
) {
  const view = await app.inject({ method: "GET", headers: who, url: `/v1/workflows/instances/${instanceId}` });
  const gate = (view.json().pendingApprovals ?? []).find(
    (a: { stageId: string; approverUserId: string }) => a.stageId === "gate" && a.approverUserId === whoId,
  );
  expect(gate).toBeTruthy();
  const d = await app.inject({ method: "POST", headers: who, url: `/v1/approvals/${gate.id}/decide`, payload: { decision } });
  expect(d.statusCode).toBe(200);
}

async function status(instanceId: string): Promise<string> {
  const r = await app.inject({ method: "GET", headers: piaAuth, url: `/v1/workflows/instances/${instanceId}` });
  return r.json().instance.status;
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT });
  const ana = await makeUser("wq-ana@example.com");
  anaId = ana.id;
  anaAuth = ana.auth;
  const bob = await makeUser("wq-bob@example.com");
  bobId = bob.id;
  bobAuth = bob.auth;
  piaAuth = (await makeUser("wq-pia@example.com")).auth;
});

describe("template validation — loud refusals", () => {
  it("an unknown quorum value is a 400, never silently stripped", async () => {
    const r = await makeTemplate("wq-bad-value", "wq-bad-value-change", { quorum: "banana" });
    expect(r.statusCode).toBe(400);
  });

  it("quorum on a non-approval stage is a 400 naming the stage", async () => {
    const tpl = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/workflows/templates",
      payload: { name: "wq-bad-stage", definition: { workflow: "wq-bad-stage", stages: [
        { id: "intake", type: "trigger", quorum: "any" },
        { id: "gate", type: "human_approval", approvers: [anaId] },
      ] } },
    });
    expect(tpl.statusCode).toBe(400);
    expect(JSON.stringify(tpl.json())).toContain("cannot carry a quorum");
  });
});

describe("stage quorum overrides the org default in BOTH directions", () => {
  it("stage quorum 'any' in an 'all' org: the FIRST approval advances and supersedes the other pending row", async () => {
    // org default is 'all' (untouched)
    const tpl = await makeTemplate("wq-any", "wq-any-change", { quorum: "any" });
    expect(tpl.statusCode).toBe(201);
    const id = await start("wq-any-change");
    expect(await status(id)).toBe("blocked_on_approval");
    await decideAs(id, anaId, anaAuth);
    expect(await status(id)).toBe("completed");
    // bob's pending row was superseded, not left decidable
    const rows = await db
      .select()
      .from(approvals)
      .where(and(eq(approvals.instanceId, id), eq(approvals.stageId, "gate")));
    expect(rows.map((r) => r.status).sort()).toEqual(["approved", "superseded"]);
  });

  it("stage quorum 'all' in an 'any' org: every named approver must still approve", async () => {
    const put = await app.inject({
      method: "PUT", headers: AUTH, url: "/v1/org/settings", payload: { approvalQuorum: "any" },
    });
    expect(put.statusCode).toBe(200);
    try {
      const tpl = await makeTemplate("wq-all", "wq-all-change", { quorum: "all" });
      expect(tpl.statusCode).toBe(201);
      const id = await start("wq-all-change");
      await decideAs(id, anaId, anaAuth);
      expect(await status(id)).toBe("blocked_on_approval"); // the stage override held
      await decideAs(id, bobId, bobAuth);
      expect(await status(id)).toBe("completed");
    } finally {
      await app.inject({
        method: "PUT", headers: AUTH, url: "/v1/org/settings", payload: { approvalQuorum: "all" },
      });
    }
  });

  it("no stage quorum = the org default (today's behaviour, byte-identical)", async () => {
    const tpl = await makeTemplate("wq-default", "wq-default-change", {});
    expect(tpl.statusCode).toBe(201);
    const id = await start("wq-default-change");
    await decideAs(id, anaId, anaAuth);
    expect(await status(id)).toBe("blocked_on_approval"); // org 'all' governs
    await decideAs(id, bobId, bobAuth);
    expect(await status(id)).toBe("completed");
  });
});
