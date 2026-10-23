/**
 * `demo:gate` (finding #11 of the #522 deep scan; owner: staging): with no environment given, the gate is asked about
 * `staging`, and the printed command and decision line name it. Driven by stub API answers (no Postgres); the
 * DB-backed run is in zz-c11-demo-check.test.ts.
 */
import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { DEMO_GATE_DEFAULT_ENVIRONMENT, runDemoGate } from "./demo-gate-lib.js";

type Json = Record<string, any>;

function stubApp(gateBodies: Json[]): FastifyInstance {
  return {
    inject: async (o: { method: string; url: string; payload?: Json }) => {
      const ok = (status: number, body: Json) => ({ statusCode: status, json: () => body });
      if (o.method === "GET" && o.url === "/v1/users") return ok(200, { users: [{ id: "u-ada", email: "admin@regulait.local" }] });
      if (o.method === "POST" && o.url === "/v1/users/u-ada/keys") return ok(201, { token: "k" });
      if (o.method === "GET" && o.url === "/v1/use-cases") return ok(200, { useCases: [{ id: "uc1", name: "Real-Time Fraud Detection Engine", status: "approved", euAiActTier: "high" }] });
      if (o.method === "POST" && o.url === "/v1/gates/deploy") {
        gateBodies.push(o.payload ?? {});
        return ok(200, { decision: "deny", reasons: [{ severity: "block", code: "open_high_alert", message: "an open high alert" }], assurance: { label: "enforced" } });
      }
      return ok(404, {});
    },
  } as unknown as FastifyInstance;
}

describe("demo:gate default environment", () => {
  it("is staging", () => expect(DEMO_GATE_DEFAULT_ENVIRONMENT).toBe("staging"));

  it("asks the gate about staging when no environment is given, and prints it", async () => {
    const sent: Json[] = [];
    const r = await runDemoGate(stubApp(sent), { bootstrapToken: "t", useCase: "Real-Time Fraud Detection Engine", ref: "r1" });
    expect(sent).toEqual([{ useCaseId: "uc1", environment: "staging", ref: "r1" }]);
    expect(r.lines[0]).toBe('$ regulait gate deploy --use-case "Real-Time Fraud Detection Engine" --env staging --ref r1');
    expect(r.lines[2]).toBe('DENY  "Real-Time Fraud Detection Engine" (approved, EU AI Act tier high) → staging');
    expect(r.exitCode).toBe(1);
  });

  it("an explicit environment still wins", async () => {
    const sent: Json[] = [];
    const r = await runDemoGate(stubApp(sent), { bootstrapToken: "t", useCase: "fraud", environment: "production", ref: "r2" });
    expect(sent[0]!.environment).toBe("production");
    expect(r.lines[0]).toContain("--env production");
  });
});
