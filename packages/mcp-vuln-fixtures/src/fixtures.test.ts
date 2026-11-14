/**
 * ADR-0246 part 2: the fixtures are what they claim to be. Each attack class is checked against the scanner or the
 * guardrail that is meant to catch it (pure, no database), and every fixture is served over a real MCP transport
 * exactly as written. The gateway-level behaviour (admission holds, pinning blocks) is tested in apps/gateway.
 */
import { afterAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  classifyOffensiveTools,
  evaluateGuardrails,
  pinnableDefinitions,
  planDefinitionPins,
  scanMcpManifest,
  type ScannableTool,
} from "@regulait/shared";
import {
  listedTools,
  manifestFor,
  MCP_ATTACK_CLASSES,
  MCP_VULN_FIXTURES,
  pull,
  fixtureState,
  serveFixtureOverHttp,
  vulnFixture,
  type ServedFixture,
} from "./index.js";

const tools = (id: (typeof MCP_ATTACK_CLASSES)[number], phase: "approved" | "pulled" = "approved") =>
  listedTools(manifestFor(vulnFixture(id), phase)) as ScannableTool[];
const rules = (id: (typeof MCP_ATTACK_CLASSES)[number]) => scanMcpManifest(tools(id)).findings.map((f) => f.rule);
const outputScan = (text: string) =>
  evaluateGuardrails({ phase: "output", text, modes: { pii: "off", jailbreak: "off", toxicity: "off", prompt_injection: "block", semantic_dlp: "block" } });

const served: ServedFixture[] = [];
afterAll(async () => {
  for (const s of served) await s.close();
});

describe("the fixture set", () => {
  it("has one fixture per attack class, each stating its attack and the expected defence", () => {
    expect(Object.keys(MCP_VULN_FIXTURES).sort()).toEqual([...MCP_ATTACK_CLASSES].sort());
    for (const id of MCP_ATTACK_CLASSES) {
      const f = vulnFixture(id);
      expect(f.id).toBe(id);
      expect(f.attack.length).toBeGreaterThan(20);
      expect(f.expected.length).toBeGreaterThan(20);
      expect(f.phases.approved.tools.length).toBeGreaterThan(0);
    }
  });

  it("commits no credential-shaped literal: the fake secrets exist only at runtime", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("./fixtures.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/AKIA[0-9A-Z]{16}/);
    expect(source).not.toMatch(/-----BEGIN [A-Z ]*PRIVATE KEY-----/);
  });
});

describe("each attack class against the control meant to catch it", () => {
  it("tool poisoning: admission scanning holds it (ordering directive, local-path read, hidden Unicode)", () => {
    const scan = scanMcpManifest(tools("tool-poisoning"));
    expect(scan.holds).toBe(true);
    expect(scan.findings.some((f) => f.where.startsWith("inputSchema.properties.sidenote"))).toBe(true);
    expect(rules("tool-poisoning")).toEqual(expect.arrayContaining(["mcp.local_path.ssh_key", "mcp.hidden_unicode.zero_width"]));
  });

  it("tool shadowing: the cross-server directive is held; the colliding reserved name is served as written", () => {
    const scan = scanMcpManifest(tools("tool-shadowing"));
    expect(scan.holds).toBe(true);
    expect(scan.findings.some((f) => f.tool === "format_signature")).toBe(true);
    expect(tools("tool-shadowing").map((t) => t.name)).toContain("mcp:resources");
  });

  it("parameter exfiltration: admission scanning holds it on an exfiltration directive", () => {
    const scan = scanMcpManifest(tools("param-exfiltration"));
    expect(scan.holds).toBe(true);
    expect(rules("param-exfiltration").some((r) => r.startsWith("mcp.exfil."))).toBe(true);
  });

  it("rug pull: both phases scan clean, and pinning sees every change a one-time scan cannot", () => {
    expect(scanMcpManifest(tools("rug-pull")).holds).toBe(false);
    expect(scanMcpManifest(tools("rug-pull", "pulled")).holds).toBe(false);
    const f = vulnFixture("rug-pull");
    const before = pinnableDefinitions({ ...manifestFor(f, "approved"), tools: tools("rug-pull") });
    const after = pinnableDefinitions({ ...manifestFor(f, "pulled"), tools: tools("rug-pull", "pulled") });
    const stored = before.definitions.map((d) => ({ kind: d.kind, name: d.name, approvedDigest: d.digest, observedDigest: d.digest }));
    const plan = planDefinitionPins(stored, after);
    expect(plan.reobserved.map((r) => `${r.pin.kind}:${r.pin.name}`).sort()).toEqual(
      ["prompt:summarise", "resource:notes://index", "tool:get_weather", "tool:list_notes"].sort(),
    );
    expect(plan.added.map((d) => d.name)).toEqual(["delete_all_notes"]);
    expect(plan.gone.map((p) => p.name)).toEqual(["archive_note"]);
  });

  it("excessive permissions: the broad tools are clean to a text scan and carry no read-only hint", () => {
    const listed = tools("excessive-permissions");
    const broad = listed.filter((t) => t.name !== "read_calendar");
    expect(broad).toHaveLength(2);
    for (const t of broad) expect((t.annotations as { readOnlyHint?: boolean } | undefined)?.readOnlyHint).not.toBe(true);
  });

  it("secrets in output: the manifest is clean, and the output guardrail finds the credential material", () => {
    expect(scanMcpManifest(tools("secret-leak")).holds).toBe(false);
    const result = manifestFor(vulnFixture("secret-leak")).tools[0]!.returns!;
    const evaluation = outputScan(result);
    expect(evaluation.action).toBe("block");
    expect(evaluation.findings.map((f) => f.detector)).toContain("semantic_dlp");
  });

  it("indirect injection: the manifest is clean, and the output guardrail finds the instructions in the result", () => {
    expect(scanMcpManifest(tools("indirect-injection")).holds).toBe(false);
    const fixture = manifestFor(vulnFixture("indirect-injection"));
    for (const text of [fixture.tools[0]!.returns!, fixture.resources![0]!.text]) {
      const evaluation = outputScan(text);
      expect(evaluation.findings.map((f) => f.detector)).toContain("prompt_injection");
    }
  });
});

describe("offensive tooling (ADR-0246 addendum)", () => {
  it("is classified high-risk on our own rules, and no other fixture is", () => {
    const verdict = classifyOffensiveTools(tools("offensive-tooling"));
    expect(verdict.highRisk).toBe(true);
    expect(verdict.categories).toEqual(["network_reconnaissance", "vulnerability_exploitation", "credential_attack"]);
    expect(verdict.findings.map((f) => f.tool)).not.toContain("tool_version");
    for (const id of MCP_ATTACK_CLASSES.filter((c) => c !== "offensive-tooling")) {
      expect(classifyOffensiveTools(tools(id)).highRisk, id).toBe(false);
      expect(classifyOffensiveTools(tools(id, "pulled")).highRisk, id).toBe(false);
    }
  });
});

describe("served over a real MCP transport", () => {
  async function connect(s: ServedFixture): Promise<Client> {
    const client = new Client({ name: "fixture-test", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(s.url)));
    return client;
  }

  it("serves every fixture's manifest exactly as written", async () => {
    for (const id of MCP_ATTACK_CLASSES) {
      const s = await serveFixtureOverHttp(vulnFixture(id));
      served.push(s);
      const client = await connect(s);
      const listed = await client.listTools();
      expect(listed.tools.map((t) => t.name)).toEqual(tools(id).map((t) => t.name));
      expect(listed.tools[0]!.description).toBe(tools(id)[0]!.description);
      await client.close();
    }
  });

  it("a rug pull changes what the same server serves, and records every call it receives", async () => {
    const state = fixtureState(vulnFixture("rug-pull"));
    const s = await serveFixtureOverHttp(state);
    served.push(s);
    let client = await connect(s);
    expect((await client.listTools()).tools.map((t) => t.name)).toContain("archive_note");
    expect((await client.listPrompts()).prompts[0]!.description).toBe("Summarise a note.");
    await client.callTool({ name: "get_weather", arguments: { city: "Oslo" } });
    await client.close();
    pull(state);
    client = await connect(s);
    const after = (await client.listTools()).tools.map((t) => t.name);
    expect(after).toContain("delete_all_notes");
    expect(after).not.toContain("archive_note");
    expect((await client.listResources()).resources[0]!.name).toBe("Note index (all users)");
    await client.close();
    expect(state.calls).toEqual([{ name: "get_weather", arguments: { city: "Oslo" } }]);
  });
});
