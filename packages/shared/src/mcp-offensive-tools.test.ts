/** ADR-0246 addendum: offensive-tooling classification, target scoping and argument redaction (pure). */
import { describe, expect, it } from "vitest";
import {
  checkTargets,
  classifyOffensiveTools,
  extractTargets,
  normaliseAuthorisedTarget,
  redactArgumentsForAudit,
  type AuthorisedTarget,
} from "./mcp-offensive-tools.js";

describe("classifyOffensiveTools", () => {
  it("reads tool names as words and descriptions as text, by activity", () => {
    const v = classifyOffensiveTools([
      { name: "portScan" },
      { name: "creds", description: "Credential dumping from memory" },
      { name: "c2", description: "Talks to the command-and-control server" },
      { name: "weather", description: "Returns the weather" },
    ]);
    expect(v.highRisk).toBe(true);
    expect(v.categories).toEqual(["network_reconnaissance", "credential_attack", "command_and_control"]);
    expect(v.findings.find((f) => f.tool === "portScan")!.where).toBe("name");
  });

  it("leaves ordinary admin and security-review tools alone", () => {
    for (const description of ["Lists open pull requests", "Rotates the API key", "Reads the audit log", "Scans a document for PII"]) {
      expect(classifyOffensiveTools([{ name: "t", description }]).highRisk, description).toBe(false);
    }
  });
});

describe("targets", () => {
  const list: AuthorisedTarget[] = [
    normaliseAuthorisedTarget("cidr", "10.20.0.0/16")!,
    normaliseAuthorisedTarget("domain", "lab.example.com")!,
    normaliseAuthorisedTarget("host", "192.0.2.7")!,
    normaliseAuthorisedTarget("cidr", "2001:db8::/32")!,
  ];

  it("extracts targets from target-named arguments, one level down too", () => {
    expect(extractTargets({ target: "a", opts: { hosts: ["b", "c"] }, other: "x" })).toEqual(["a", "b", "c"]);
    expect(extractTargets({ ports: "22" })).toEqual([]);
    expect(extractTargets({ target: 42 })).toEqual(["<non-string>"]);
  });

  it("authorises IPs in a CIDR, listed hosts, domains and their subdomains, URLs by host, and contained IPv4 ranges", () => {
    const ok = ["10.20.3.4", "web.lab.example.com", "lab.example.com", "https://api.lab.example.com:8443/x", "192.0.2.7", "10.20.5.0/24", "2001:db8::1", "[2001:db8::2]"];
    expect(checkTargets(ok, list).refused).toEqual([]);
  });

  it("refuses everything else, including look-alikes, wider ranges and unparseable values", () => {
    const bad = ["10.21.0.1", "evil-lab.example.com", "lab.example.com.evil.test", "10.0.0.0/8", "192.0.2.8", "<non-string>", "a b", "2001:db9::1", "-bad-.example"];
    expect(checkTargets(bad, list).refused).toEqual(bad);
  });

  it("normalises admin entries and rejects the wrong shape for the kind", () => {
    expect(normaliseAuthorisedTarget("host", "Scanme.Lab.Example.COM.")).toEqual({ kind: "host", value: "scanme.lab.example.com" });
    expect(normaliseAuthorisedTarget("cidr", "10.0.0.1")).toBeNull();
    expect(normaliseAuthorisedTarget("domain", "localhost")).toBeNull();
    expect(normaliseAuthorisedTarget("cidr", "10.0.0.0/33")).toBeNull();
  });
});

describe("redactArgumentsForAudit", () => {
  it("replaces secret-named values, scrubs credential-shaped strings and bounds the copy", () => {
    const key = ["AK", "IA", "REGULAIT", "FIXTURE0"].join("");
    const out = redactArgumentsForAudit({ target: "10.20.0.1", api_key: "x", password: "y", notes: `use ${key}`, long: "z".repeat(5000) }) as Record<string, string>;
    expect(out.target).toBe("10.20.0.1");
    expect(out.api_key).toBe("[REDACTED]");
    expect(out.password).toBe("[REDACTED]");
    expect(out.notes).not.toContain(key);
    expect(out.long!.length).toBeLessThan(2100);
  });
});
