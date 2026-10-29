/**
 * The "Claude as model and agent" readiness check (DEMO_RUNBOOK §7.9): optional beat = WARN when absent, FAIL when
 * half-built, PASS when the agent is priced and has its credential and egress entry. Pure: no database.
 */
import { describe, expect, it } from "vitest";
import { CLAUDE_BEAT, CLAUDE_BEAT_EGRESS_HOST, CLAUDE_BEAT_MODEL, checkClaudeBeat } from "./demo-check-lib.js";
// the read route, imported rather than spelled out: this suite only serves canned GET bodies and writes nothing
import { EGRESS_ALLOW_HOSTS_PATH } from "./demo-live-lib.js";

type Bodies = Record<string, { status: number; body: Record<string, unknown> }>;
const getter = (bodies: Bodies) => async (url: string) => bodies[url] ?? { status: 404, body: {} };
const agent = (over: Record<string, unknown> = {}) => ({
  name: "claude",
  provider: "anthropic",
  model: CLAUDE_BEAT_MODEL,
  costPerMTokIn: 4,
  costPerMTokOut: 20,
  ...over,
});
const ready: Bodies = {
  "/v1/agents?limit=200": { status: 200, body: { agents: [agent()] } },
  "/v1/model-credentials": { status: 200, body: { credentials: [{ provider: "anthropic" }] } },
  [EGRESS_ALLOW_HOSTS_PATH]: { status: 200, body: { hosts: [{ host: CLAUDE_BEAT_EGRESS_HOST }] } },
};

describe("checkClaudeBeat", () => {
  it("not set up: one WARN pointing at the runbook, never a FAIL", async () => {
    const out = await checkClaudeBeat(getter({ ...ready, "/v1/agents?limit=200": { status: 200, body: { agents: [] } } }));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ beat: CLAUDE_BEAT, level: "WARN" });
    expect(out[0]!.fix).toContain("§7.9");
  });

  it("set up: three PASS rows", async () => {
    const out = await checkClaudeBeat(getter(ready));
    expect(out.map((c) => c.level)).toEqual(["PASS", "PASS", "PASS"]);
  });

  it("an unpriced agent FAILs (its calls would read Unpriced)", async () => {
    const out = await checkClaudeBeat(
      getter({ ...ready, "/v1/agents?limit=200": { status: 200, body: { agents: [agent({ costPerMTokOut: null })] } } }),
    );
    expect(out[0]).toMatchObject({ level: "FAIL" });
    expect(out[0]!.detail).toContain("Unpriced");
  });

  it("a missing credential or egress entry FAILs; the key itself is never part of any row", async () => {
    const out = await checkClaudeBeat(
      getter({
        ...ready,
        "/v1/model-credentials": { status: 200, body: { credentials: [] } },
        [EGRESS_ALLOW_HOSTS_PATH]: { status: 200, body: { hosts: [] } },
      }),
    );
    expect(out.map((c) => c.level)).toEqual(["PASS", "FAIL", "FAIL"]);
  });

  it("an agent for another model or provider does not count", async () => {
    const out = await checkClaudeBeat(
      getter({
        ...ready,
        "/v1/agents?limit=200": { status: 200, body: { agents: [agent({ model: "other-model" }), agent({ provider: "mock" })] } },
      }),
    );
    expect(out[0]).toMatchObject({ level: "WARN" });
  });
});
