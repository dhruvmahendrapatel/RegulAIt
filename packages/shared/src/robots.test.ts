import { describe, expect, it } from "vitest";
import { normaliseRobotOrigin, robotContentDigest, robotToolName, validateStepsScript } from "./robots.js";

describe("ADR-0364 robots (shared)", () => {
  it("normalises https named-host origins only", () => {
    expect(normaliseRobotOrigin("https://Portal.Example.com")).toEqual({ ok: true, origin: "https://portal.example.com" });
    expect(normaliseRobotOrigin("https://portal.example.com/login").ok).toBe(false);
    expect(normaliseRobotOrigin("https://portal.example.com:8443")).toEqual({ ok: true, origin: "https://portal.example.com:8443" });
    for (const bad of ["http://portal.example.com", "https://10.0.0.1", "https://[::1]", "https://user:pw@portal.example.com", "https://localhost", "ftp://x.example.com"]) {
      expect(normaliseRobotOrigin(bad).ok, bad).toBe(false);
    }
  });

  it("names the tool by slug and version", () => {
    expect(robotToolName("invoice_bot", 3)).toBe("robot_invoice_bot_v3");
  });

  it("validates steps against the allow-list, bindings and schemas", () => {
    const ctx = {
      allowedOrigins: ["https://portal.example.com"],
      secretNames: ["PW"],
      inputSchema: { type: "object", properties: { user: {} } },
      outputSchema: { type: "object", properties: { total: {} } },
    };
    const ok = validateStepsScript(
      JSON.stringify({ steps: [{ op: "goto", url: "https://portal.example.com/" }, { op: "fill", selector: "#p", secret: "PW" }, { op: "read", selector: "#t", output: "total" }] }),
      ctx,
    );
    expect(ok.ok).toBe(true);
    const bad = validateStepsScript(
      JSON.stringify({
        steps: [
          { op: "goto", url: "https://other.example.com/" },
          { op: "fill", selector: "#p", secret: "NOPE" },
          { op: "fill", selector: "#p", value: "a", input: "user" },
          { op: "read", selector: "#t", output: "missing" },
        ],
      }),
      ctx,
    );
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.problems.map((p) => p.step)).toEqual([0, 1, 2, 3]);
    expect(validateStepsScript("not json", ctx).ok).toBe(false);
  });

  it("the content digest ignores ordering but not content", () => {
    const base = {
      scriptFormat: "steps_v1" as const,
      script: "{}",
      compiledSha256: null,
      compilerVersion: null,
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      allowedOrigins: ["https://a.example.com", "https://b.example.com"],
      secretBindings: [
        { name: "A", origin: "https://a.example.com", liveSecretId: "1" },
        { name: "B", origin: "https://b.example.com", liveSecretId: "2" },
      ],
    };
    const d = robotContentDigest(base);
    expect(robotContentDigest({ ...base, allowedOrigins: [...base.allowedOrigins].reverse(), secretBindings: [...base.secretBindings].reverse() })).toBe(d);
    expect(robotContentDigest({ ...base, script: "{ }" })).not.toBe(d);
    expect(robotContentDigest({ ...base, secretBindings: [{ ...base.secretBindings[0]!, liveSecretId: "3" }, base.secretBindings[1]!] })).not.toBe(d);
  });
});
