import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  type ActionOverride,
  type ActionVerdict,
  compileActionRules,
  type DeviceActionRule,
  ENDPOINT_ACTIONS,
  gatewayHttpVerdict,
  gatewayMcpActionVerdict,
  httpAction,
} from "./endpoint-actions.js";
import type { EffectiveMcpPolicy } from "./managed-settings.js";

interface Scenario {
  name: string;
  servers: { serverId: string; name: string; upstreamHost: string; tools: string[] }[];
  overrides: ActionOverride[];
  deviceRules: DeviceActionRule[];
  cases: {
    action: string;
    expect: ActionVerdict;
    mcp: { server: string; tool: string } | null;
    http: { method: string; url: string }[];
    cli: string[];
  }[];
}

const fixture = JSON.parse(readFileSync(new URL("./endpoint-actions-conformance.json", import.meta.url), "utf8")) as {
  scenarios: Scenario[];
};

function effectiveOf(s: Scenario): EffectiveMcpPolicy {
  return {
    subject: { kind: "user", id: "u-1" },
    servers: s.servers.map((x) => ({ serverId: x.serverId, name: x.name, gatewayUrl: `https://gw.test/mcp/${x.serverId}`, tools: [...x.tools].sort() })),
  };
}

function compiled(s: Scenario): DeviceActionRule[] {
  const host = new Map(s.servers.map((x) => [x.serverId, x.upstreamHost]));
  return compileActionRules(effectiveOf(s), (id) => host.get(id) ?? null, s.overrides);
}

describe("ADR-0350 §9 endpoint actions", () => {
  it("catalogue ids are unique, well formed, and every action has all three routes", () => {
    const ids = ENDPOINT_ACTIONS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const a of ENDPOINT_ACTIONS) {
      expect(a.id).toMatch(/^[a-z0-9]+(\.[a-z0-9-]+){2}$/);
      expect(a.mcp.tools.length).toBeGreaterThan(0);
      expect(a.cli.length).toBeGreaterThan(0);
      expect(a.http.length).toBeGreaterThan(0);
      for (const h of a.http) expect(h.path).toMatch(/^(\/([a-z0-9_-]+|\*))+$/);
    }
  });

  it("the fixture's device rules are exactly what the compiler emits (the device gets the gateway's answer)", () => {
    for (const s of fixture.scenarios) expect(s.deviceRules, s.name).toEqual(compiled(s));
  });

  it("every case covers every route the catalogue has, and the gateway routes agree with the expectation", () => {
    for (const s of fixture.scenarios) {
      const rules = compiled(s);
      for (const c of s.cases) {
        const name = `${s.name}: ${c.action}`;
        expect(c.cli.length, name).toBeGreaterThan(0);
        expect(c.http.length, name).toBeGreaterThan(0);
        if (c.mcp) expect(gatewayMcpActionVerdict(effectiveOf(s), rules, c.mcp.server, c.mcp.tool), name).toBe(c.expect);
        for (const h of c.http) {
          expect(httpAction(h.method, h.url)?.id, name).toBe(c.action);
          expect(gatewayHttpVerdict(rules, h.method, h.url), name).toBe(c.expect);
        }
      }
    }
  });

  it("an override can only tighten, and an unknown override is refused", () => {
    const s = fixture.scenarios[0]!;
    const host = () => "api.githubcopilot.com";
    const loosened = compileActionRules(effectiveOf(s), host, [{ action: "github.gist.create", verdict: "allow" }]);
    expect(loosened.find((r) => r.action === "github.gist.create")?.verdict).toBe("deny");
    expect(() => compileActionRules(effectiveOf(s), host, [{ action: "nope", verdict: "deny" }])).toThrow();
  });

  it("unknown or malformed HTTP calls are not an action", () => {
    expect(httpAction("GET", "https://api.github.com/gists")).toBeNull();
    expect(httpAction("POST", "not a url")).toBeNull();
    expect(httpAction("POST", "https://api.github.com/gists/extra")).toBeNull();
    expect(httpAction("POST", "https://API.github.com/gists/")?.id).toBe("github.gist.create");
  });
});
