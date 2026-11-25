/**
 * ADR-0336 slice 1: the agent platform adapter contract (decision 2), its endpoint allow-list (decision 5) and the
 * declared write-scope transitions (decision 9).
 */
import { describe, expect, it } from "vitest";
import {
  DISCOVERY_KIND_SPECS,
  DISCOVERY_SOURCE_KINDS,
  DISCOVERY_WRITE_SCOPE_STATES,
  DISCOVERY_WRITE_SCOPE_TRANSITIONS,
  discoveryWriteScopeFinal,
  nextDiscoveryWriteScope,
} from "@regulait/shared";
import { AGENT_PLATFORM_ADAPTERS, AGENT_PLATFORM_CONTROLS, allowListedFetch } from "./agent-platform-adapters.js";
import { DISCOVERY_SCANNERS } from "./discovery-scanners.js";
import { ReadFailure } from "./discovery-wider-scanners.js";

describe("ADR-0336 decision 2: one adapter list for the agent_registry family", () => {
  const familyKinds = DISCOVERY_SOURCE_KINDS.filter((k) => DISCOVERY_KIND_SPECS[k].family === "agent_registry");

  it("every agent_registry kind has exactly one adapter, and the production registry runs that adapter's scanner", () => {
    expect(AGENT_PLATFORM_ADAPTERS.map((a) => a.kind).sort()).toEqual([...familyKinds].sort());
    for (const a of AGENT_PLATFORM_ADAPTERS) {
      expect(a.scanner.kind).toBe(a.kind);
      expect(DISCOVERY_SCANNERS.get(a.kind)).toBe(a.scanner);
    }
  });

  it("a governed action is declared exactly where a control member executes it (ADR-0338 §3), and every E17 adapter declares its endpoints", () => {
    // the declared verbs and the control's (action, direction) pairs are one set: `unquarantine` is quarantine's reverse
    const verbsOf = (actions: readonly string[]) => actions.flatMap((x) => (x === "quarantine" ? ["quarantine", "unquarantine"] : x === "disable" ? ["disable"] : [x])).sort();
    for (const a of AGENT_PLATFORM_ADAPTERS) {
      const declared = a.governedActions.map((g) => g.action).sort();
      if (!a.control) {
        expect(declared, a.kind).toEqual([]);
        continue;
      }
      expect(declared, a.kind).toEqual(verbsOf(a.control.member.actions));
      expect(a.control.member.acceptedModes.length, a.kind).toBeGreaterThan(0);
      expect(AGENT_PLATFORM_CONTROLS[a.control.registry]).toBe(a.control.member);
    }
    // ADR-0338 slice 1b: Copilot Studio is the one control; Entra, Gemini and AgentCore declare none yet (slice 2)
    expect(Object.keys(AGENT_PLATFORM_CONTROLS)).toEqual(["copilot_studio"]);
    const copilot = AGENT_PLATFORM_ADAPTERS.find((a) => a.kind === "agent_registry_copilot_studio")!;
    expect(copilot.vendor).toBe("microsoft");
    expect(copilot.readEndpoints!.length).toBeGreaterThan(0);
    // the read credential is used with GET only against the vendor (decision 5)
    expect(copilot.readEndpoints!.every((r) => r.method === "GET")).toBe(true);
  });
});

describe("ADR-0336 decision 5: allowListedFetch", () => {
  const calls: string[] = [];
  const base = (async (input: string | URL | Request) => {
    calls.push(String(input));
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  const f = allowListedFetch(base, new Set(["https://org.crm.dynamics.com"]), [{ method: "GET", path: /^\/api\/data\/v9\.2\/bots$/ }]);

  it("admits a declared GET and passes it through unchanged", async () => {
    await f("https://org.crm.dynamics.com/api/data/v9.2/bots?$select=botid");
    expect(calls).toEqual(["https://org.crm.dynamics.com/api/data/v9.2/bots?$select=botid"]);
  });

  it("refuses anything else BEFORE a request is made, as a denied read", async () => {
    calls.length = 0;
    const refused = [
      ["https://org.crm.dynamics.com/api/data/v9.2/bots", { method: "POST" }],
      ["https://org.crm.dynamics.com/api/data/v9.2/bots", { method: "PATCH" }],
      ["https://org.crm.dynamics.com/api/data/v9.2/bots(1)", undefined],
      ["https://org.crm.dynamics.com/api/data/v9.2/bots/../systemusers", undefined],
      ["https://org.crm.dynamics.com/api/data/v9.2/credentials", undefined],
      ["https://other.crm.dynamics.com/api/data/v9.2/bots", undefined],
      ["http://org.crm.dynamics.com/api/data/v9.2/bots", undefined],
      ["https://user:pw@org.crm.dynamics.com/api/data/v9.2/bots", undefined],
      ["https://org.crm.dynamics.com:8443/api/data/v9.2/bots", undefined],
      ["not a url", undefined],
    ] as const;
    for (const [url, init] of refused) {
      const err = await f(url, init).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err, url).toBeInstanceOf(ReadFailure);
      expect((err as ReadFailure).status).toBe("denied");
    }
    expect(calls).toEqual([]);
  });
});

describe("ADR-0336 decision 9: credential write-scope transitions, declared once", () => {
  it("is the declared table: unverified -> read_only | refused, read_only -> refused, refused final", () => {
    expect(DISCOVERY_WRITE_SCOPE_TRANSITIONS).toEqual({ unverified: ["read_only", "refused"], read_only: ["refused"], refused: [] });
    expect(DISCOVERY_WRITE_SCOPE_STATES.filter(discoveryWriteScopeFinal)).toEqual(["refused"]);
  });

  it("moves a credential only along the table", () => {
    expect(nextDiscoveryWriteScope("unverified", "read_only")).toBe("read_only");
    expect(nextDiscoveryWriteScope("unverified", "write")).toBe("refused");
    expect(nextDiscoveryWriteScope("read_only", "write")).toBe("refused");
    // no move: the same state, an unverified run, or out of the final state
    expect(nextDiscoveryWriteScope("read_only", "read_only")).toBeNull();
    expect(nextDiscoveryWriteScope("read_only", "unverified")).toBeNull();
    expect(nextDiscoveryWriteScope("unverified", undefined)).toBeNull();
    expect(nextDiscoveryWriteScope("refused", "read_only")).toBeNull();
    expect(nextDiscoveryWriteScope("refused", "write")).toBeNull();
  });
});
