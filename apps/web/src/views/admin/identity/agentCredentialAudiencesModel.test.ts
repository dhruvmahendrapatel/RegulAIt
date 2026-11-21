import { describe, expect, it } from "vitest";
import { audienceProblem, createBody, draftProblems, EMPTY_AUDIENCE, EMPTY_SCOPE, hasProblems, relaxations, scopeProblem, scopeResource, type AudienceDraft } from "./agentCredentialAudiencesModel";

const SRV = "11111111-1111-4111-8111-111111111111";
const CON = "22222222-2222-4222-8222-222222222222";
const AGT = "33333333-3333-4333-8333-333333333333";
const ok: AudienceDraft = {
  ...EMPTY_AUDIENCE,
  name: " payments ",
  audience: " https://api.example.test/payments ",
  scopes: [{ ...EMPTY_SCOPE, resourceId: SRV, toolName: " create_refund ", kind: "write", scope: "payments:refund" }],
};

describe("agent credential audiences model (ADR-0315)", () => {
  it("checks the audience URI like the gateway does", () => {
    expect(audienceProblem("https://api.example.test/x")).toBeNull();
    expect(audienceProblem("")).toMatch(/Enter/);
    expect(audienceProblem("http://api.example.test/")).toMatch(/https/);
    expect(audienceProblem("https://u:p@api.example.test/")).toMatch(/credentials/);
    expect(audienceProblem("https://api.example.test/?a=1")).toMatch(/query/);
    expect(audienceProblem("https://api.example.test/#f")).toMatch(/fragment/);
    expect(audienceProblem("not a url")).toMatch(/full URL/);
    expect(audienceProblem(`https://x.test/${"a".repeat(512)}`)).toMatch(/512/);
  });

  it("checks each scope row: a resource, a tool for an MCP row, and an RFC 6749 scope token", () => {
    expect(scopeProblem(ok.scopes[0]!)).toBeNull();
    expect(scopeProblem({ ...EMPTY_SCOPE, scope: "x" })).toMatch(/Choose the mcp tool/);
    expect(scopeProblem({ ...EMPTY_SCOPE, resourceId: SRV, scope: "x" })).toMatch(/tool name/);
    expect(scopeProblem({ type: "connector", resourceId: CON, toolName: "", kind: "read", scope: "has space" })).toMatch(/no spaces/);
    expect(scopeProblem({ type: "agent", resourceId: AGT, toolName: "", kind: "read", scope: 'a"b' })).toMatch(/quotes/);
    expect(scopeProblem({ type: "agent", resourceId: AGT, toolName: "", kind: "read", scope: "agent:run" })).toBeNull();
  });

  it("bounds the lifetime and requires a scope map", () => {
    expect(hasProblems(draftProblems(ok))).toBe(false);
    expect(draftProblems({ ...ok, maxTtlSeconds: "59" }).maxTtlSeconds).toMatch(/60 to 900/);
    expect(draftProblems({ ...ok, maxTtlSeconds: "901" }).maxTtlSeconds).toBeDefined();
    expect(draftProblems({ ...ok, maxTtlSeconds: "1.5" }).maxTtlSeconds).toBeDefined();
    expect(draftProblems({ ...ok, scopes: [] }).scopes).toMatch(/at least one/);
    expect(draftProblems({ ...ok, name: "" }).name).toMatch(/name/);
  });

  it("sends the gateway's shape, trimmed, one resource field per row type", () => {
    const body = createBody({
      ...ok,
      scopes: [ok.scopes[0]!, { type: "connector", resourceId: CON, toolName: "ignored", kind: "read", scope: "c:r" }, { type: "agent", resourceId: AGT, toolName: "", kind: "write", scope: "a:w" }],
    });
    expect(body).toEqual({
      name: "payments",
      audience: "https://api.example.test/payments",
      algorithm: "ES256",
      binding: "dpop",
      maxTtlSeconds: 300,
      scopes: [
        { type: "mcp_tool", serverId: SRV, toolName: "create_refund", kind: "write", scope: "payments:refund" },
        { type: "connector", connectorId: CON, kind: "read", scope: "c:r" },
        { type: "agent", agentId: AGT, kind: "write", scope: "a:w" },
      ],
    });
  });

  it("names what a registration loosens: bearer and a longer life, nothing at the defaults", () => {
    expect(relaxations(EMPTY_AUDIENCE)).toEqual([]);
    expect(relaxations({ binding: "bearer", maxTtlSeconds: "600" })).toHaveLength(2);
    expect(relaxations({ binding: "dpop", maxTtlSeconds: "300" })).toEqual([]);
  });

  it("names a scope row's resource, and an unknown id as itself", () => {
    const names = { server: (id: string) => (id === SRV ? "Payments MCP" : id), connector: (id: string) => id, agent: (id: string) => id };
    expect(scopeResource({ type: "mcp_tool", serverId: SRV, toolName: "t", connectorId: null, agentId: null, kind: "read", scope: "s" }, names)).toBe("Payments MCP · t");
    expect(scopeResource({ type: "connector", serverId: null, toolName: null, connectorId: CON, agentId: null, kind: "read", scope: "s" }, names)).toBe(CON);
  });
});
