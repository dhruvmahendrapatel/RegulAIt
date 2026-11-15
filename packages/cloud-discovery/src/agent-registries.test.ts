import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AGENTCORE_MAX_RUNTIMES, listAgentCoreRuntimes } from "./agent-registries.js";
import { awsSts, fakeCloud, installNetworkTripwire, json, synthetic, type RecordedCall } from "./test-cloud.js";

const ACCOUNT = "111122223333";
const ROLE = `arn:aws:iam::${ACCOUNT}:role/regulait-registry-import`;

const runtime = (region: string, n: number) => ({
  agentRuntimeArn: `arn:aws:bedrock-agentcore:${region}:${ACCOUNT}:runtime/agent_${n}-abc`,
  agentRuntimeId: `agent_${n}-abc`,
  agentRuntimeName: `agent_${n}`,
  agentRuntimeVersion: "3",
  description: `runtime ${n}`,
  status: "READY",
  lastUpdatedAt: `2026-11-0${n}T10:00:00Z`,
});

/** the fake control plane: two pages in us-east-1, one in eu-west-1, AccessDenied in ap-south-1 */
function agentCore(call: RecordedCall): Response | undefined {
  const host = call.url.hostname;
  if (!host.startsWith("bedrock-agentcore-control.")) return undefined;
  const region = host.split(".")[1]!;
  // ListAgentRuntimes is a REST-JSON POST to /runtimes/ with maxResults and nextToken in the query string (a read)
  if (call.method !== "POST" || call.url.pathname !== "/runtimes/") return json({ message: "unexpected" }, 400);
  if (region === "ap-south-1") return json({ message: "denied" }, 403, { "x-amzn-errortype": "AccessDeniedException" });
  if (region === "us-east-1") {
    return call.url.searchParams.get("nextToken") === "p2"
      ? json({ agentRuntimes: [runtime(region, 2)] })
      : json({ agentRuntimes: [runtime(region, 1), { agentRuntimeName: "no-arn" }], nextToken: "p2" });
  }
  return json({ agentRuntimes: [runtime(region, 3)] });
}

describe("ADR-0314: AgentCore runtime listing", () => {
  let tripwire: Awaited<ReturnType<typeof installNetworkTripwire>>;
  beforeAll(async () => {
    tripwire = await installNetworkTripwire();
  });
  afterAll(() => {
    tripwire.restore();
    expect(tripwire.escaped).toEqual([]);
  });

  it("signs with the exchanged web-identity session, follows nextToken, and reports a denied region as incomplete", async () => {
    const cloud = fakeCloud([(c) => awsSts(c, ACCOUNT), agentCore]);
    const secrets: string[] = [];
    const out = await listAgentCoreRuntimes(
      { fetch: cloud.fetch, credential: { mode: "aws_web_identity", roleArn: ROLE }, oidcToken: async () => synthetic("oidc"), onSecret: (s) => secrets.push(s) },
      ["us-east-1", "eu-west-1", "ap-south-1"],
    );
    expect(cloud.unrouted.map((c) => `${c.method} ${c.url.href}`)).toEqual([]);
    expect(out.runtimes.map((r) => [r.region, r.agentRuntimeName, r.status])).toEqual([
      ["us-east-1", "agent_1", "READY"],
      ["us-east-1", "agent_2", "READY"],
      ["eu-west-1", "agent_3", "READY"],
    ]);
    expect(out.runtimes[0]!.lastUpdatedAt).toMatch(/^20\d\d-/);
    expect(out.regions).toEqual([
      { region: "us-east-1", status: "ok" },
      { region: "eu-west-1", status: "ok" },
      { region: "ap-south-1", status: "denied", detail: "AccessDeniedException" },
    ]);
    expect(out.complete).toBe(false);
    // every request to the control plane is the SigV4-signed list call and nothing else (read-only)
    const cp = cloud.calls.filter((c) => c.url.hostname.startsWith("bedrock-agentcore-control."));
    expect(cp.length).toBe(4);
    expect(cp.every((c) => c.url.pathname === "/runtimes/" && (c.headers.get("authorization") ?? "").startsWith("AWS4-HMAC-SHA256"))).toBe(true);
    // the exchanged session credentials were handed to the scrubber before use
    expect(secrets.length).toBeGreaterThanOrEqual(3);
  });

  it("a fully read listing is complete", async () => {
    const cloud = fakeCloud([(c) => awsSts(c, ACCOUNT), agentCore]);
    const out = await listAgentCoreRuntimes({ fetch: cloud.fetch, credential: { mode: "aws_web_identity", roleArn: ROLE }, oidcToken: async () => synthetic("oidc") }, ["eu-west-1"]);
    expect(out.regions).toEqual([{ region: "eu-west-1", status: "ok" }]);
    expect(out.complete).toBe(true);
    expect(out.runtimes).toHaveLength(1);
  });

  it("refuses a region that is not an AWS region name (it would pick the signed request's host)", async () => {
    const cloud = fakeCloud([(c) => awsSts(c, ACCOUNT), agentCore]);
    await expect(
      listAgentCoreRuntimes({ fetch: cloud.fetch, credential: { mode: "aws_web_identity", roleArn: ROLE }, oidcToken: async () => synthetic("oidc") }, ["evil.example.com/x"]),
    ).rejects.toThrow(/not an AWS region/);
    expect(cloud.calls).toHaveLength(0);
    expect(AGENTCORE_MAX_RUNTIMES).toBe(5000);
  });
});
