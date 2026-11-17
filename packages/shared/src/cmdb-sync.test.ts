import { describe, expect, it } from "vitest";
import {
  CMDB_SYNC_RUN_MACHINE,
  cmdbCiClassesSchema,
  cmdbInstanceUrlProblem,
  cmdbSourceKey,
  createCmdbConnectorSchema,
  storeCmdbCredentialSchema,
} from "./cmdb-sync.js";
import { STATE_MACHINES } from "./state-machines.js";

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
    const m = CMDB_SYNC_RUN_MACHINE;
    expect(m.def.initial).toEqual(["running", "refused"]);
    expect(m.sourcesOf("succeed")).toEqual(["running"]);
    expect(m.sourcesOf("fail")).toEqual(["running"]);
    for (const s of ["succeeded", "failed", "refused"] as const) expect(m.isTerminal(s)).toBe(true);
    expect(m.canMove("running", "refused")).toBe(false);
    expect(STATE_MACHINES.cmdb_sync_run).toBe(m);
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
