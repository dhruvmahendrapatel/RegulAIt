import { beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { costEvents, createDb, eq, runMigrations, type Db } from "@regulait/db";
import { resolveModelProvider, type MockModelProvider } from "@regulait/model-provider";
import { buildApp } from "./app.js";

/**
 * PILLAR 6 §8 — file preprocessing, end to end: a dispatch carrying large
 * reference/file content is deterministically shrunk (redundant whitespace
 * collapsed, long data blobs elided) WITHOUT changing meaning before the model
 * sees it — the REDUCED reference flows to the model and ONE file_preprocessing
 * estimate row lands in the per-technique ledger; absent/small reference
 * content, content with nothing to strip, and the per-user "passthrough" off
 * switch each write NO row and leave the dispatch unchanged. File preprocessing
 * is a pure cost annotation — it never changes the served agent, model,
 * entitlement, or governance.
 *
 * Shares one database with the other gateway suites (fileParallelism is off);
 * everything here is prefixed fpp- and ledger asserts filter by user id. The
 * shared mock is process-wide, so wire asserts locate this suite's dispatch by
 * a unique input marker.
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "fpp-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = "d".repeat(64);

const REFERENCE_DELIMITER = "----- REFERENCE -----";

// A big reference (≥ 800 chars → ≥ 200 estimated tokens) full of redundant
// whitespace + blank-line runs: "alpha     beta" collapses to "alpha beta" and
// the 4 blank lines collapse to 1, so preprocessing REALLY shrinks it.
const REDUNDANT_LINE = "alpha     beta     gamma     delta";
const BIG_REFERENCE = (REDUNDANT_LINE + "   \n\n\n\n\n").repeat(30);
const COLLAPSED_FORM = "alpha beta gamma delta";

// A big but already-clean reference: over the minimum, no redundant whitespace
// to collapse → preprocessing produces no reduction → no row.
const CLEAN_REFERENCE = "the quick brown fox jumps over the lazy dog\n".repeat(40);

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

const fppRows = async (userId: string) =>
  (await db.select().from(costEvents).where(eq(costEvents.userId, userId))).filter(
    (r) => r.technique === "file_preprocessing",
  );

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
  mock = resolveModelProvider({ provider: "mock" }) as MockModelProvider;

  agentId = await makeAgent("fpp-agent");

  const project = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/projects",
    payload: { name: "fpp-project" },
  });
  expect(project.statusCode).toBe(201);
  projectId = project.json().id;
});

describe("file preprocessing estimate row + reduced-reference threading", () => {
  it("a large redundant reference writes a file_preprocessing row and sends the REDUCED reference", async () => {
    const u = await makeUser("fpp-yes@example.com");
    await grant(u.id, agentId);
    const marker = "fpp-yes-marker-abc: summarize the attached reference";
    await invoke(u.auth, { input: marker, referenceContent: BIG_REFERENCE });

    const rows = await fppRows(u.id);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.ruleId).toBe("file-preprocessing");
    expect(row.servedAgentId).toBe(agentId);
    expect(row.projectId).toBe(projectId);
    expect(row.estimatedTokensSaved).toBeGreaterThan(0);
    // dollars = saved INPUT tokens × served INPUT price
    expect(row.estimatedCostSavedUsd!).toBeGreaterThan(0);
    expect(row.estimationBasis).toContain("file-preprocessing");
    expect((row.detail as { referenceChars?: number }).referenceChars).toBe(BIG_REFERENCE.length);
    expect((row.detail as { savedTokens?: number }).savedTokens).toBe(row.estimatedTokensSaved);

    // the outgoing dispatch received the REDUCED reference, not the raw content
    const wire = mock.dispatches.filter((d) => d.input?.startsWith(marker)).at(-1)!;
    expect(wire).toBeDefined();
    expect(wire.input).toContain(REFERENCE_DELIMITER);
    expect(wire.input).toContain(COLLAPSED_FORM); // collapsed form present
    expect(wire.input).not.toContain(REDUNDANT_LINE); // raw redundant form gone
    // the reference block the model saw is shorter than the raw reference
    const block = wire.input!.slice(wire.input!.indexOf(REFERENCE_DELIMITER));
    expect(block.length).toBeLessThan(BIG_REFERENCE.length);
  });

  it("an absent reference writes NO row and leaves the input unchanged", async () => {
    const u = await makeUser("fpp-none@example.com");
    await grant(u.id, agentId);
    const marker = "fpp-none-marker-def: plain request";
    await invoke(u.auth, { input: marker });
    expect(await fppRows(u.id)).toHaveLength(0);
    const wire = mock.dispatches.filter((d) => d.input?.startsWith(marker)).at(-1)!;
    expect(wire.input).not.toContain(REFERENCE_DELIMITER);
  });

  it("a small reference writes NO row (below the minimum)", async () => {
    const u = await makeUser("fpp-small@example.com");
    await grant(u.id, agentId);
    await invoke(u.auth, { input: "fpp-small-marker-ghi: request", referenceContent: "tiny   ref\n\n\nx" });
    expect(await fppRows(u.id)).toHaveLength(0);
  });

  it("a large already-clean reference writes NO row (no reduction)", async () => {
    const u = await makeUser("fpp-clean@example.com");
    await grant(u.id, agentId);
    const marker = "fpp-clean-marker-jkl: request";
    await invoke(u.auth, { input: marker, referenceContent: CLEAN_REFERENCE });
    expect(await fppRows(u.id)).toHaveLength(0);
    // still attached (additive), just unprocessed
    const wire = mock.dispatches.filter((d) => d.input?.startsWith(marker)).at(-1)!;
    expect(wire.input).toContain(REFERENCE_DELIMITER);
    expect(wire.input).toContain(CLEAN_REFERENCE);
  });

  it("passthrough routing mode disables preprocessing entirely (§12 off switch)", async () => {
    const u = await makeUser("fpp-pass@example.com");
    await grant(u.id, agentId);
    expect((await setRoutingMode(u.id, "passthrough")).statusCode).toBe(200);
    const marker = "fpp-pass-marker-mno: summarize the attached reference";
    await invoke(u.auth, { input: marker, referenceContent: BIG_REFERENCE });

    expect(await fppRows(u.id)).toHaveLength(0);
    // off switch: the raw (unprocessed) reference is still attached, byte-for-byte
    const wire = mock.dispatches.filter((d) => d.input?.startsWith(marker)).at(-1)!;
    expect(wire.input).toContain(REFERENCE_DELIMITER);
    expect(wire.input).toContain(REDUNDANT_LINE); // raw form survives untouched
  });
});
