import { describe, expect, it } from "vitest";
import {
  CMDB_SYNC_RUN_INITIAL_STATES,
  CMDB_SYNC_RUN_STATES,
  CMDB_SYNC_RUN_TRANSITIONS,
  cmdbCiClassesSchema,
  cmdbInstanceUrlProblem,
  cmdbRunCanTransition,
  cmdbRunStatesBefore,
  cmdbSourceKey,
  createCmdbConnectorSchema,
  storeCmdbCredentialSchema,
} from "./cmdb-sync.js";

describe("ADR-0358 CMDB sync contract", () => {
  it("accepts an https origin only", () => {
    expect(cmdbInstanceUrlProblem("https://acme.service-now.com")).toBeNull();
    expect(cmdbInstanceUrlProblem("https://acme.service-now.com/")).toBeNull();
    expect(cmdbInstanceUrlProblem("http://acme.service-now.com")).toMatch(/https/);
    expect(cmdbInstanceUrlProblem("https://u:p@acme.service-now.com")).toMatch(/credentials/);
    expect(cmdbInstanceUrlProblem("https://acme.service-now.com/api?x=1")).toMatch(/origin/);
    expect(cmdbInstanceUrlProblem("not a url")).toMatch(/not a URL/);
  });

  it("CI classes are table names", () => {
    expect(cmdbCiClassesSchema.partial().safeParse({ agent: "cmdb_ci_appl" }).success).toBe(true);
    for (const bad of ["Cmdb", "cmdb ci", "x;drop", "../t", "a"]) expect(cmdbCiClassesSchema.partial().safeParse({ agent: bad }).success, bad).toBe(false);
  });

  it("the run lifecycle: running ends once; terminal states have no way out", () => {
    expect(CMDB_SYNC_RUN_INITIAL_STATES).toEqual(["running", "refused"]);
    expect(cmdbRunStatesBefore("succeeded")).toEqual(["running"]);
    expect(cmdbRunStatesBefore("failed")).toEqual(["running"]);
    for (const s of CMDB_SYNC_RUN_STATES) if (s !== "running") expect(CMDB_SYNC_RUN_TRANSITIONS[s]).toEqual([]);
    expect(cmdbRunCanTransition("running", "refused")).toBe(false);
  });

  it("the source key is stable and kind-scoped", () => {
    expect(cmdbSourceKey("agent", "abc")).toBe("regulait:agent:abc");
    expect(cmdbSourceKey("model", "openai/gpt")).toBe("regulait:model:openai/gpt");
  });

  it("requests are strict and need a reason where they change trust", () => {
    expect(createCmdbConnectorSchema.safeParse({ name: "x", kind: "jira", instanceUrl: "https://a" }).success).toBe(false);
    expect(storeCmdbCredentialSchema.safeParse({ username: "u", password: "p", replacesCredentialId: null }).success).toBe(false);
    expect(storeCmdbCredentialSchema.safeParse({ username: "u", password: "p", replacesCredentialId: null, reason: "r" }).success).toBe(true);
  });
});
