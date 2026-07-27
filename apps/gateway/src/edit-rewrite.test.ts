import { beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { costEvents, createDb, eq, runMigrations, type Db } from "@regulait/db";
import { resolveModelProvider, type MockModelProvider } from "@regulait/model-provider";
import { buildApp } from "./app.js";

/**
 * PILLAR 6 §8 — edit vs rewrite, end to end: a dispatch carrying a large
 * baseline the user asks to EDIT (targeted-change intent) is instructed to
 * return a compact diff — the diff directive + the baseline flow to the model
 * and ONE edit_vs_rewrite estimate row lands in the per-technique ledger; a
 * rewrite-intent request, an absent baseline, and the per-user "passthrough"
 * off switch each write NO row and leave the dispatch unchanged. Edit vs
 * rewrite is a pure cost annotation — it never changes the served agent,
 * model, entitlement, or governance.
 *
 * Shares one database with the other gateway suites (fileParallelism is off);
 * everything here is prefixed edit- and ledger asserts filter by user id. The
 * shared mock is process-wide, so wire asserts locate this suite's dispatch by
 * a unique input marker.
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "edit-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = "d".repeat(64);

// ≥ 800 chars → ≥ 200 estimated tokens (chars/4), clearing the 200-token
// minimum editable baseline; a full rewrite would re-emit ≈ all of it.
const BIG_BASELINE =
  "export function total(items) {\n  return items.reduce((s, i) => s + i.price, 0)\n}\n".repeat(
    20,
  );
const BASELINE_DELIMITER = "----- BASELINE -----";
const DIFF_DIRECTIVE = "Return ONLY a minimal";

let db: Db;
let app: ReturnType<typeof buildApp>;
let mock: MockModelProvider;

async function makeUser(email: string) {
  const user = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/users",
    payload: { email, displayName: email },
  });
  expect(user.statusCode).toBe(201);
  const key = await app.inject({
    method: "POST",
    headers: AUTH,
    url: `/v1/users/${user.json().id}/keys`,
    payload: { name: "test" },
  });
  expect(key.statusCode).toBe(201);
  return { id: user.json().id as string, auth: { authorization: `Bearer ${key.json().token}` } };
}

async function makeAgent(name: string) {
  const res = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/agents",
    payload: { name, provider: "mock", tier: 1, costPerMTokIn: 3, costPerMTokOut: 15, model: "mock-balanced" },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

const grant = (userId: string, agentId: string) =>
  app.inject({ method: "POST", headers: AUTH, url: "/v1/grants/agents", payload: { userId, agentId } });

const setRoutingMode = (userId: string, routingMode: "automatic" | "passthrough") =>
  app.inject({
    method: "POST",
    headers: AUTH,
    url: `/v1/users/${userId}/agent-policy`,
    payload: { routingMode },
  });

let agentId: string;
let projectId: string;

async function invoke(
  auth: { authorization: string },
  payload: Record<string, unknown>,
) {
  const res = await app.inject({
    method: "POST",
    headers: auth,
    url: `/v1/agents/${agentId}/invoke`,
    payload: { mode: "chat", dispatch: true, projectId, ...payload },
  });
  expect(res.statusCode).toBe(200);
  return res.json();
}

const editRows = async (userId: string) =>
  (await db.select().from(costEvents).where(eq(costEvents.userId, userId))).filter(
    (r) => r.technique === "edit_vs_rewrite",
  );

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
  mock = resolveModelProvider({ provider: "mock" }) as MockModelProvider;

  agentId = await makeAgent("edit-agent");

  const project = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/projects",
    payload: { name: "edit-project" },
  });
  expect(project.statusCode).toBe(201);
  projectId = project.json().id;
});

describe("edit vs rewrite estimate row + diff-directive threading", () => {
  it("a large baseline + edit-intent request writes an edit_vs_rewrite row and sends the diff directive + baseline", async () => {
    const u = await makeUser("edit-yes@example.com");
    await grant(u.id, agentId);
    const marker = "edit-yes-marker-abc: fix the typo in the return statement";
    await invoke(u.auth, { input: marker, baseline: BIG_BASELINE });

    const rows = await editRows(u.id);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.ruleId).toBe("edit-vs-rewrite");
    expect(row.servedAgentId).toBe(agentId);
    expect(row.projectId).toBe(projectId);
    expect(row.estimatedTokensSaved).toBeGreaterThan(0);
    expect(row.estimatedTokensSaved).toBe(Math.round(Math.ceil(BIG_BASELINE.length / 4) * 0.75));
    // dollars = saved OUTPUT tokens × served OUTPUT price
    expect(row.estimatedCostSavedUsd!).toBeGreaterThan(0);
    expect(row.estimationBasis).toContain("edit-vs-rewrite");
    expect((row.detail as { baselineTokens?: number }).baselineTokens).toBe(
      Math.ceil(BIG_BASELINE.length / 4),
    );
    expect((row.detail as { intent?: string }).intent).toBe("edit");

    // the outgoing dispatch actually received the diff directive + the baseline
    const wire = mock.dispatches.filter((d) => d.input?.startsWith(marker)).at(-1)!;
    expect(wire).toBeDefined();
    expect(wire.system).toContain(DIFF_DIRECTIVE);
    expect(wire.input).toContain(BASELINE_DELIMITER);
    expect(wire.input).toContain(BIG_BASELINE);
  });

  it("a rewrite-intent request over the same baseline writes NO edit_vs_rewrite row", async () => {
    const u = await makeUser("edit-rewrite@example.com");
    await grant(u.id, agentId);
    const marker = "edit-rewrite-marker-def: rewrite this from scratch";
    await invoke(u.auth, { input: marker, baseline: BIG_BASELINE });

    expect(await editRows(u.id)).toHaveLength(0);
    const wire = mock.dispatches.filter((d) => d.input?.startsWith(marker)).at(-1)!;
    expect(wire.input).not.toContain(BASELINE_DELIMITER);
    expect(wire.system).toBeUndefined();
  });

  it("an edit-intent request with NO baseline writes NO row", async () => {
    const u = await makeUser("edit-none@example.com");
    await grant(u.id, agentId);
    await invoke(u.auth, { input: "edit-none-marker-ghi: fix the typo" });
    expect(await editRows(u.id)).toHaveLength(0);
  });

  it("passthrough routing mode disables the optimization entirely (§12 off switch)", async () => {
    const u = await makeUser("edit-pass@example.com");
    await grant(u.id, agentId);
    expect((await setRoutingMode(u.id, "passthrough")).statusCode).toBe(200);
    const marker = "edit-pass-marker-jkl: fix the typo in the return statement";
    await invoke(u.auth, { input: marker, baseline: BIG_BASELINE });

    expect(await editRows(u.id)).toHaveLength(0);
    const wire = mock.dispatches.filter((d) => d.input?.startsWith(marker)).at(-1)!;
    expect(wire.input).not.toContain(BASELINE_DELIMITER);
  });
});
