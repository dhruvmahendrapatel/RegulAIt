import { describe, expect, it } from "vitest";
import { compileRobotPlanSteps, newRobotRunKey, openRobotSecret, sealRobotSecret, originAllowed, robotEgressTargets, robotRunPlanSchema, robotRunResultSchema, smokescreenAcl } from "./robots-run.js";

describe("ADR-0364 S3 robot run contract", () => {
  it("builds an enforce-only Smokescreen ACL from the allowed hosts", () => {
    const acl = smokescreenAcl(["https://b.example.com", "https://a.example.com:8443", "https://a.example.com"]);
    expect(acl).toContain("action: enforce");
    expect(acl).not.toMatch(/action: (open|report)/);
    expect(acl.match(/^    - /gm)).toHaveLength(2);
    expect(robotEgressTargets(["https://a.example.com:8443", "https://a.example.com"])).toEqual([
      { host: "a.example.com", port: 443 },
      { host: "a.example.com", port: 8443 },
    ]);
  });

  it("refuses a non-https origin and a host that is not a DNS name", () => {
    expect(() => smokescreenAcl(["http://a.example.com"])).toThrow();
    expect(() => smokescreenAcl(["https://localhost"])).toThrow();
  });

  it("checks origins exactly in the browser second line", () => {
    const allowed = ["https://a.example.com"];
    expect(originAllowed("https://a.example.com/x?y=1", allowed)).toBe(true);
    expect(originAllowed("https://a.example.com:444/", allowed)).toBe(false);
    expect(originAllowed("http://a.example.com/", allowed)).toBe(false);
    expect(originAllowed("https://evil.example.com/", allowed)).toBe(false);
  });

  it("compiles inputs to literals and secrets to references, never values", () => {
    const steps = compileRobotPlanSteps(
      [
        { op: "goto", url: "https://a.example.com/login" },
        { op: "fill", selector: "#u", input: "user" },
        { op: "fill", selector: "#p", secret: "PASSWORD" },
        { op: "read", selector: "#total", output: "total" },
      ],
      { user: "alice" },
    );
    expect(steps[1]).toEqual({ op: "fill", selector: "#u", value: "alice" });
    expect(steps[2]).toEqual({ op: "fill_secret", selector: "#p", secretRef: "PASSWORD" });
    expect(() => compileRobotPlanSteps([{ op: "fill", selector: "#u", input: "missing" }], {})).toThrow();
  });

  it("validates plans and results strictly", () => {
    const plan = {
      runId: "00000000-0000-4000-8000-000000000001",
      kind: "test",
      allowedOrigins: ["https://a.example.com"],
      steps: [{ op: "goto", url: "https://a.example.com" }],
      secrets: [],
      limits: { wallClockMs: 1000, actionTimeoutMs: 1000, outputChars: 10, downloadBytes: 10 },
      screenshots: "masked",
    };
    expect(robotRunPlanSchema.safeParse(plan).success).toBe(true);
    expect(robotRunPlanSchema.safeParse({ ...plan, limits: { ...plan.limits, wallClockMs: 3_600_000 } }).success).toBe(false);
    expect(robotRunResultSchema.safeParse({ status: "succeeded", stepsCompleted: 1, outputs: {} }).success).toBe(true);
    expect(robotRunResultSchema.safeParse({ status: "failed", stepsCompleted: 0, outputs: {} }).success).toBe(false);
  });

  it("seals secret values to one run and one ref", () => {
    const key = newRobotRunKey();
    expect(key).toMatch(/^[\x21-\x7e]{1,1024}$/);
    const sealed = sealRobotSecret(key, "run-1", "PASSWORD", "hunter2-canary");
    expect(sealed).not.toContain("hunter2");
    expect(openRobotSecret(key, "run-1", "PASSWORD", sealed)).toBe("hunter2-canary");
    expect(() => openRobotSecret(key, "run-2", "PASSWORD", sealed)).toThrow();
    expect(() => openRobotSecret(key, "run-1", "OTHER", sealed)).toThrow();
    expect(() => openRobotSecret(newRobotRunKey(), "run-1", "PASSWORD", sealed)).toThrow();
  });
});
