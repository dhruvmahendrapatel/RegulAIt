import { beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb, runMigrations, type Db } from "@regulait/db";
import { buildApp } from "./app.js";

/**
 * ADR-0018 §4 (C1) — the two newly-wired assignment dims at the gateway edge:
 * target-system and initiator-role. The KEY governance property: initiator-role
 * is resolved SERVER-SIDE from the authenticated initiator's role assignments,
 * never from the request body — so a role-scoped rule fires only for a genuine
 * role holder, and a client cannot smuggle a role in to route itself onto a
 * stricter template. Shares one DB (fileParallelism off); prefixed ard-.
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);
const BOOT = "ard-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };

let db: Db;
let app: ReturnType<typeof buildApp>;
let approverId: string;
let holderAuth: { authorization: string };
let plainAuth: { authorization: string };

async function makeUser(email: string) {
  const u = await app.inject({ method: "POST", headers: AUTH, url: "/v1/users", payload: { email, displayName: email.split("@")[0] } });
  const k = await app.inject({ method: "POST", headers: AUTH, url: `/v1/users/${u.json().id}/keys`, payload: { name: "t" } });
  return { id: u.json().id as string, auth: { authorization: `Bearer ${k.json().token}` } };
}
async function stageIds(auth: { authorization: string }, id: string): Promise<string[]> {
  const r = await app.inject({ method: "GET", headers: auth, url: `/v1/workflows/instances/${id}` });
  expect(r.statusCode).toBe(200);
  return (r.json().instance.definition.stages ?? []).map((s: { id: string }) => s.id);
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "a".repeat(64) });
  const approver = await makeUser("ard-approver@example.com");
  approverId = approver.id;
  const holder = await makeUser("ard-holder@example.com");
  const plain = await makeUser("ard-plain@example.com");
  holderAuth = holder.auth;
  plainAuth = plain.auth;

  // a role, granted ONLY to the holder
  const role = await app.inject({ method: "POST", headers: AUTH, url: "/v1/roles", payload: { name: "ard-release-manager", description: "release manager" } });
  await app.inject({ method: "POST", headers: AUTH, url: `/v1/users/${holder.id}/roles`, payload: { roleId: role.json().id } });

  const base = await app.inject({ method: "POST", headers: AUTH, url: "/v1/workflows/templates",
    payload: { name: "ard-base", definition: { workflow: "ard-base", stages: [
      { id: "intake", type: "trigger" },
      { id: "ard_base_gate", type: "human_approval", approvers: [approverId] },
    ] } } });
  const release = await app.inject({ method: "POST", headers: AUTH, url: "/v1/workflows/templates",
    payload: { name: "ard-release", definition: { workflow: "ard-release", stages: [
      { id: "intake", type: "trigger" },
      { id: "ard_release_gate", type: "human_approval", approvers: [approverId] },
    ] } } });

  // baseline rule (everyone) + a role-scoped rule (holders only), same changeType
  await app.inject({ method: "POST", headers: AUTH, url: "/v1/workflows/assignment-rules", payload: { templateId: base.json().id, changeType: "ard-change" } });
  await app.inject({ method: "POST", headers: AUTH, url: "/v1/workflows/assignment-rules", payload: { templateId: release.json().id, changeType: "ard-change", initiatorRole: "ard-release-manager" } });
});

describe("initiator-role dim is server-resolved (C1)", () => {
  it("a role holder's change routes onto the role-scoped template", async () => {
    const s = await app.inject({ method: "POST", headers: holderAuth, url: "/v1/workflows/instances",
      payload: { change: { description: "holder change", paths: ["src/x.ts"], changeType: "ard-change", environment: "ard-env" } } });
    expect(s.statusCode).toBe(201);
    const ids = await stageIds(holderAuth, s.json().id);
    expect(ids).toContain("ard_base_gate");
    expect(ids).toContain("ard_release_gate"); // the role-scoped stage merged in
  });

  it("a non-holder gets only the baseline — and cannot smuggle the role via the body", async () => {
    const s = await app.inject({ method: "POST", headers: plainAuth, url: "/v1/workflows/instances",
      payload: {
        change: {
          description: "plain change",
          paths: ["src/x.ts"],
          changeType: "ard-change",
          environment: "ard-env",
          // a client attempt to self-route onto the stricter template — ignored:
          // initiatorRole is derived server-side and this key is not accepted.
          initiatorRole: "ard-release-manager",
          initiatorRoles: ["ard-release-manager"],
        },
      } });
    expect(s.statusCode).toBe(201);
    const ids = await stageIds(plainAuth, s.json().id);
    expect(ids).toContain("ard_base_gate");
    expect(ids).not.toContain("ard_release_gate"); // NOT a holder → not routed
  });
});

describe("target-system dim routes at the gateway (C1)", () => {
  it("a targetSystem-scoped rule fires only for the matching change", async () => {
    const tpl = await app.inject({ method: "POST", headers: AUTH, url: "/v1/workflows/templates",
      payload: { name: "ard-ts", definition: { workflow: "ard-ts", stages: [
        { id: "intake", type: "trigger" },
        { id: "ard_ts_gate", type: "human_approval", approvers: [approverId] },
      ] } } });
    await app.inject({ method: "POST", headers: AUTH, url: "/v1/workflows/assignment-rules",
      payload: { templateId: tpl.json().id, changeType: "ard-ts-change", targetSystem: "ard-checkout" } });

    const match = await app.inject({ method: "POST", headers: plainAuth, url: "/v1/workflows/instances",
      payload: { change: { description: "ts match", paths: ["src/x.ts"], changeType: "ard-ts-change", environment: "ard-env", targetSystem: "ard-checkout" } } });
    expect(match.statusCode).toBe(201);
    expect(await stageIds(plainAuth, match.json().id)).toContain("ard_ts_gate");

    const miss = await app.inject({ method: "POST", headers: plainAuth, url: "/v1/workflows/instances",
      payload: { change: { description: "ts miss", paths: ["src/x.ts"], changeType: "ard-ts-change", environment: "ard-env", targetSystem: "ard-billing" } } });
    // no rule matches a non-checkout target → 422 no_workflow_matches_change
    expect(miss.statusCode).toBe(422);
  });
});
