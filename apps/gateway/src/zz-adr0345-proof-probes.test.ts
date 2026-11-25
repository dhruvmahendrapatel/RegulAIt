/**
 * ADR-0345 (lane E26) slice 2c, part 1 — the gateway-probe harness, against a real database.
 *
 *  - each built probe passes on the shipped secure defaults, through the enforcing code the live path calls;
 *  - NEGATIVE: relaxing the tenant control a probe reads makes it fail (guardrail mode, pin mode), and an unbuilt
 *    probe is `not_run`;
 *  - the drift probe leaves no fixture behind (its transaction always rolls back);
 *  - through the runner, a probe result is recorded as evidence like any other engine.
 */
import { beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, createDb, eq, approvals, guardrailConfigs, isNull, mcpServers, orgSettings, runMigrations, users, runWithRlsSystem, sql, type Db } from "@regulait/db";
import { AGENT_RISK_GATEWAY_PROBES, AGENT_RISK_PROOF_ORIGIN_TAG, agentRiskProofs } from "@regulait/shared";
import { AGENT_RISK_PROBES_NOT_BUILT, RISK_PROOF_TOOL, runGatewayProbe } from "./agent-risk-proof-probes.js";
import { runAgentRiskProofEngine } from "./agent-risk-proof-runner.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

let db: Db;
const sys = <T>(fn: () => Promise<T>) => runWithRlsSystem("system_task", "test.adr0345.probes", fn);
const BUILT = AGENT_RISK_GATEWAY_PROBES.filter((p) => !AGENT_RISK_PROBES_NOT_BUILT.includes(p));

class Rollback extends Error {}
/** run `fn` against a relaxed setting inside a transaction that is always rolled back */
async function underRelaxed<T>(relax: (tx: Db) => Promise<unknown>, fn: (tx: Db) => Promise<T>): Promise<T> {
  let out: T | undefined;
  try {
    await db.transaction(async (txRaw) => {
      const tx = txRaw as unknown as Db;
      await relax(tx);
      out = await fn(tx);
      throw new Rollback();
    });
  } catch (err) {
    if (!(err instanceof Rollback)) throw err;
  }
  return out as T;
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  // the approval fixtures reference the deployment's own admins (the runner may not create users)
  await db.insert(users).values([
    { email: `e26-probes-a-${process.pid}@example.test`, displayName: "e26 probe admin a", isAdmin: true },
    { email: `e26-probes-b-${process.pid}@example.test`, displayName: "e26 probe admin b", isAdmin: true },
  ]).onConflictDoNothing();
}, 120_000);

describe("ADR-0345 slice 2c: gateway probes on the secure defaults", () => {
  it.each(BUILT)("%s passes through the enforcing code", async (probe) => {
    const r = await sys(() => runGatewayProbe(db, probe));
    expect(r.outcome, JSON.stringify(r.detail)).toBe("pass");
  });

  it("every catalogue probe has a harness (none is left not_run)", () => {
    expect(AGENT_RISK_PROBES_NOT_BUILT).toEqual([]);
    expect(BUILT).toEqual([...AGENT_RISK_GATEWAY_PROBES]);
  });

  it("the fixture probes commit nothing: no sandbox server or approval is left behind", async () => {
    for (const probe of ["mcp_definition_drift", "approval_replay", "approval_expired"] as const) await sys(() => runGatewayProbe(db, probe));
    const tag = `${AGENT_RISK_PROOF_ORIGIN_TAG}-%`;
    expect(await db.select({ id: mcpServers.id }).from(mcpServers).where(sql`${mcpServers.name} like ${tag}`)).toEqual([]);
    expect(await db.select({ id: approvals.id }).from(approvals).where(eq(approvals.toolName, RISK_PROOF_TOOL))).toEqual([]);
  });
});

describe("ADR-0345 slice 2c: a relaxed control fails its probe", () => {
  it("NEGATIVE: prompt-injection guardrail at warn fails the hidden-instruction probe", async () => {
    const r = await sys(() =>
      underRelaxed(
        async (tx) => {
          const orgWhere = and(eq(guardrailConfigs.scope, "org"), isNull(guardrailConfigs.scopeId));
          const [row] = await tx.select({ id: guardrailConfigs.id }).from(guardrailConfigs).where(orgWhere);
          if (row) await tx.update(guardrailConfigs).set({ promptInjectionMode: "warn" }).where(orgWhere);
          else await tx.insert(guardrailConfigs).values({ scope: "org", scopeId: null, promptInjectionMode: "warn" });
        },
        (tx) => runGatewayProbe(tx, "hidden_instruction_in_document"),
      ),
    );
    expect(r.outcome).toBe("fail");
  });

  it("NEGATIVE: definition pin mode at warn fails the drift probe", async () => {
    const r = await sys(() =>
      underRelaxed(
        (tx) => tx.update(orgSettings).set({ mcpDefinitionPinMode: "warn" }),
        (tx) => runGatewayProbe(tx, "mcp_definition_drift"),
      ),
    );
    expect(r).toMatchObject({ outcome: "fail", detail: { refused: false } });
  });
});

describe("ADR-0345 slice 2c part 2: the loop cap reads the org dials", () => {
  it("NEGATIVE: a worker ceiling written around the settings schema (past the 20-turn wall) fails the loop probe", async () => {
    const r = await sys(() =>
      underRelaxed(
        (tx) => tx.update(orgSettings).set({ maxWorkerTurns: 1000, defaultWorkerMaxTurns: 1000 }),
        (tx) => runGatewayProbe(tx, "loop_turn_cap"),
      ),
    );
    expect(r).toMatchObject({ outcome: "fail", detail: { seededLoopCap: 1000 } });
  });
});

describe("ADR-0345 slice 2c: through the runner", () => {
  it("every built probe's catalogue proof runs through runAgentRiskProofEngine and passes", async () => {
    const entries = agentRiskProofs().filter((p) => p.proof.engine === "gateway_probe" && BUILT.includes(p.proof.probe!));
    expect(entries.length).toBe(BUILT.length);
    for (const { proof } of entries) {
      const r = await sys(() => runAgentRiskProofEngine(db, proof, new Date()));
      expect(r.outcome, `${proof.key} ${JSON.stringify(r.detail)}`).toBe("pass");
    }
  });
});

