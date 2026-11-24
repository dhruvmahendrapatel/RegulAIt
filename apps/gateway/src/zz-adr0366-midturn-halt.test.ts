/**
 * ADR-0366 (#1134 security review [1]) — a builder agent contained MID-TURN makes no further call.
 *
 * The mock model asks for a tool on every step (`<<use-tool-loop:NAME>>`, a name outside the toolbox, so each step
 * ends in a refused tool call and the loop takes another model step). A test-only trigger on this scratch database
 * halts the agent the moment its FIRST tool step is recorded: after model step 1, before step 2. With the halt
 * re-read in `stepGate`, the turn stops there; without it, the loop would run on to its step cap.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, auditLog, builderAgents, eq, sql } from "@regulait/db";
import { resolveModelProvider, type MockModelProvider } from "@regulait/model-provider";
import { builderKit, type BuilderKit, type Person } from "./testing/builder-fixture.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";
import { relaxStrictAdmissionForTest } from "./testing/strict-admission.js";

const mock = resolveModelProvider({ provider: "mock" }) as MockModelProvider;
let k: BuilderKit;
let owner: Person;
let model: string;
let restoreGates: () => Promise<unknown>;
let restoreAdmission: () => Promise<unknown>;

beforeAll(async () => {
  // a scratch database: the halt trigger below exists only here
  k = await builderKit("a366mt", { scratch: true, relaxAutonomyGate: true });
  restoreGates = await relaxGovernanceGatesForTest(k.db, { mrmEnforced: false, dispatchAttributionRequired: false });
  restoreAdmission = await relaxStrictAdmissionForTest(k.db);
  owner = await k.person("owner");
  model = await k.model("m");
  await k.grantModel(owner.id, model);
  await k.db.execute(sql.raw(`
    CREATE OR REPLACE FUNCTION a366_halt_on_first_step() RETURNS trigger LANGUAGE plpgsql
      SET search_path = pg_catalog, public, pg_temp AS $$
    BEGIN
      UPDATE builder_agents SET halted_at = now(), halted_reason = 'contained (ADR-0366): a366 mid-turn test'
       WHERE id = (SELECT agent_id FROM builder_threads WHERE id = NEW.thread_id) AND halted_at IS NULL;
      RETURN NEW;
    END $$;
    DROP TRIGGER IF EXISTS a366_halt_on_first_step ON builder_tool_steps;
    CREATE TRIGGER a366_halt_on_first_step AFTER INSERT ON builder_tool_steps
      FOR EACH ROW EXECUTE FUNCTION a366_halt_on_first_step();
  `));
}, 180_000);

afterAll(async () => {
  await restoreAdmission?.();
  await restoreGates?.();
  await k?.close();
});

describe("ADR-0366: a containment that lands mid-turn stops the turn", () => {
  it("halted after model step 1: no model step 2, refused builder_agent_halted, audited", async () => {
    const r = await k.req("POST", "/v1/builder/agents", owner.auth, {
      name: `a366 midturn ${k.RUN}`,
      connectionFormat: "shared",
      computerUse: false,
      projectId: owner.projectId,
      modelAgentId: model,
    });
    expect(r.statusCode, r.body).toBe(201);
    const agentId = r.json().agent.id as string;
    const mark = mock.dispatches.length;
    const turn = await k.req("POST", `/v1/builder/agents/${agentId}/chat`, owner.auth, { message: "go <<use-tool-loop:a366_absent_tool>>" });
    // exactly one model step ran; the halt that landed after it refused the next one
    expect(mock.dispatches.length - mark).toBe(1);
    const [row] = await k.db.select({ haltedAt: builderAgents.haltedAt }).from(builderAgents).where(eq(builderAgents.id, agentId));
    expect(row!.haltedAt).not.toBeNull();
    const refused = await k.db
      .select({ detail: auditLog.detail })
      .from(auditLog)
      .where(and(eq(auditLog.objectId, agentId), eq(auditLog.ruleId, "builder-agent-halted-refused")));
    expect(refused.length).toBeGreaterThanOrEqual(1);
    expect((refused[0]!.detail as Record<string, unknown>).phase).toBe("step");
    // the turn reports the halt (a refusal note on the thread, or the refusal itself)
    expect(turn.body).toContain("halted");
    // a new turn is refused at once, before any model call
    const mark2 = mock.dispatches.length;
    const again = await k.req("POST", `/v1/builder/agents/${agentId}/chat`, owner.auth, { message: "again" });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe("builder_agent_halted");
    expect(mock.dispatches.length).toBe(mark2);
  });
});
