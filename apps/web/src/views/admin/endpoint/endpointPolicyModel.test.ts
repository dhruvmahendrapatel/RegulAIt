/**
 * ADR-0350 (lane E31): the Endpoint policy model against the live contract. The SPA mirrors the shared vocabularies
 * and the gateway's request bounds, so these tests read the sources and fail on drift. Synthetic data only.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as m from "./endpointPolicyModel";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const shared = async (): Promise<Any> =>
  import(/* @vite-ignore */ new URL("../../../../../../packages/shared/src/endpoint-command-exceptions.ts", import.meta.url).pathname);
const gatewaySource = () => readFileSync(new URL("../../../../../gateway/src/endpoint-command-exceptions.ts", import.meta.url), "utf8");

const U = (n: number) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;
const ME = U(1);
const OTHER = U(2);
const THIRD = U(3);

function exception(over: Partial<m.CommandException> = {}): m.CommandException {
  const state = over.state ?? "requested";
  return {
    id: U(10),
    deviceId: U(20),
    ruleId: "deny-exec-terraform-apply",
    verdict: "ask",
    hours: 4,
    reason: "synthetic reason",
    termsDigest: "a".repeat(64),
    requestedBy: OTHER,
    approverUserId: ME,
    state,
    lifecycle: {
      machine: "endpoint_command_exception",
      state,
      terminal: false,
      transitions: [
        { event: "approve", to: "approved", allowed: state === "requested", by: ["approver"], summary: "", ...(state === "requested" ? {} : { reason: `an exception that is ${state} cannot be moved to approved` }) },
        { event: "reject", to: "rejected", allowed: state === "requested", by: ["admin"], summary: "" },
        { event: "cancel", to: "cancelled", allowed: state === "requested", by: ["user"], summary: "" },
        { event: "revoke", to: "revoked", allowed: state === "approved", by: ["admin"], summary: "", ...(state === "approved" ? {} : { reason: "the exception has already expired" }) },
      ],
    },
    decidedBy: null,
    decidedAt: null,
    decisionReason: null,
    notAfter: null,
    revokedAt: null,
    createdAt: "2026-11-19T10:00:00.000Z",
    ...over,
  };
}

describe("the mirrored vocabularies match @regulait/shared and the gateway", () => {
  it("verdicts, kinds, states, bounds and the rule id shape", async () => {
    const s = await shared();
    expect(m.ENDPOINT_GROUP_RULE_KINDS).toEqual(s.ENDPOINT_GROUP_RULE_KINDS);
    expect([...m.ENDPOINT_GROUP_RULE_VERDICTS].sort()).toEqual([...s.ENDPOINT_GROUP_RULE_VERDICTS].sort());
    expect(m.ENDPOINT_EXCEPTION_VERDICTS).toEqual(s.ENDPOINT_EXCEPTION_VERDICTS);
    expect(m.ENDPOINT_EXCEPTION_STATES).toEqual(s.ENDPOINT_EXCEPTION_STATES);
    expect(m.ENDPOINT_EXCEPTION_DEFAULT_MAX_HOURS).toBe(s.ENDPOINT_EXCEPTION_DEFAULT_MAX_HOURS);
    expect(m.ENDPOINT_EXCEPTION_HARD_MAX_HOURS).toBe(s.ENDPOINT_EXCEPTION_HARD_MAX_HOURS);
    expect(m.ENDPOINT_RULE_ID.source).toBe(s.ENDPOINT_RULE_ID.source);
    expect(Math.max(...m.DURATION_CHOICES)).toBeLessThanOrEqual(s.ENDPOINT_EXCEPTION_HARD_MAX_HOURS);
  });

  it("the request bounds are the gateway's own", () => {
    const g = gatewaySource();
    expect(g).toContain(`regex(/${m.GLOB.source}/`);
    expect(g).toContain(`.max(${m.GLOB_MAX})`);
    expect(g).toContain(`.max(${m.ARGV_MAX})`);
    expect(g).toContain(`regex(/${m.ABSOLUTE_PATH.source}/`);
    expect(g).toContain(`z.enum([${m.FILE_ACCESS.map((x) => `"${x}"`).join(", ")}])`);
    expect(g).toContain(`z.enum([${m.PACKAGE_ECOSYSTEMS.map((x) => `"${x}"`).join(", ")}])`);
    expect(g).toContain(`.max(${m.GROUP_NAME_MAX})`);
    expect(g).toContain(`.max(${m.GROUP_DESCRIPTION_MAX})`);
    expect(g).toContain(`reason: z.string().trim().min(1).max(${m.REASON_MAX})`);
  });
});

describe("the add-rule form", () => {
  it("splits a command into argv words and suggests a valid rule id", () => {
    const d = { ...m.emptyRuleDraft(), command: "terraform  apply *" };
    expect(m.ruleBody(d)).toEqual({ body: { kind: "exec", ruleId: "deny-exec-terraform-apply", verdict: "deny", rule: { argv: ["terraform", "apply", "*"] } } });
    expect(m.ENDPOINT_RULE_ID.test(m.suggestedRuleId({ ...d, command: "X".repeat(200) }))).toBe(true);
  });

  it("refuses what the gateway would refuse, in words", () => {
    expect(m.ruleBody({ ...m.emptyRuleDraft(), command: "curl * | sh" })).toMatchObject({ problem: expect.stringContaining("no spaces, pipes or quotes") });
    expect(m.ruleBody({ ...m.emptyRuleDraft(), kind: "file", path: "relative/.env" })).toMatchObject({ problem: expect.stringContaining("absolute") });
    expect(m.ruleBody({ ...m.emptyRuleDraft(), command: "ls", ruleId: "Bad Id" })).toMatchObject({ problem: expect.stringContaining("rule id") });
    expect(m.ruleBody({ ...m.emptyRuleDraft(), command: Array.from({ length: 33 }, () => "a").join(" ") })).toMatchObject({ problem: expect.stringContaining("32") });
  });

  it("file and package rules", () => {
    expect(m.ruleBody({ ...m.emptyRuleDraft(), kind: "file", verdict: "ask", access: "read", path: "**/.env*", ruleId: "env-files" })).toEqual({
      body: { kind: "file", ruleId: "env-files", verdict: "ask", rule: { access: "read", path: "**/.env*" } },
    });
    const pkg = m.ruleBody({ ...m.emptyRuleDraft(), kind: "package", ecosystem: "pypi", name: "*" });
    expect(pkg).toEqual({ body: { kind: "package", ruleId: "deny-package-pypi", verdict: "deny", rule: { ecosystem: "pypi", name: "*" } } });
    expect(m.rulePattern({ kind: "package", rule: { ecosystem: "npm", name: "left-pad" } })).toBe("npm:left-pad");
  });
});

describe("who may decide an exception", () => {
  it("self-approval is never possible, and the reason names the approver", () => {
    const mine = exception({ requestedBy: ME, approverUserId: OTHER });
    expect(m.approveBlock(mine, ME, "Sam Synthetic")).toMatch(/You requested this exception, so you can't approve it\. Sam Synthetic/);
    expect(m.rejectBlock(mine, ME)).toMatch(/cancel it instead/);
    expect(m.cancelBlock(mine, ME)).toBeNull();
  });

  it("only the named approver approves; any other admin may reject", () => {
    const x = exception({ approverUserId: THIRD });
    expect(m.approveBlock(x, ME, "Sam Synthetic")).toMatch(/Only the approver this request names, Sam Synthetic/);
    expect(m.rejectBlock(x, ME)).toBeNull();
    expect(m.approveBlock(exception(), ME, "You")).toBeNull();
    expect(m.cancelBlock(exception(), ME)).toMatch(/Only the admin who requested it/);
  });

  it("the lifecycle table decides by state: an expired exception cannot be revoked", () => {
    expect(m.revokeBlock(exception({ state: "approved" }))).toBeNull();
    expect(m.revokeBlock(exception({ state: "expired" }))).toBe("the exception has already expired");
    expect(m.approveBlock(exception({ state: "rejected" }), ME, "You")).toMatch(/rejected cannot be moved/);
  });

  it("longer than the default maximum needs a second step-up; the tab counts what waits on me", () => {
    expect(m.approveStepUps({ hours: 24 })).toBe(1);
    expect(m.approveStepUps({ hours: 72 })).toBe(2);
    expect(m.awaitingMe([exception(), exception({ requestedBy: ME, approverUserId: OTHER }), exception({ state: "approved" })], ME)).toBe(1);
    expect(m.awaitingMe([exception()], null)).toBe(0);
  });

  it("words for durations and states", () => {
    expect([1, 4, 24, 72, 168].map(m.hoursText)).toEqual(["1 hour", "4 hours", "1 day", "3 days", "7 days"]);
    expect(m.stateLabel(exception({ requestedBy: ME }), ME)).toBe("Requested (yours)");
    expect(m.stateLabel(exception({ state: "approved" }), ME)).toBe("Active");
    expect(m.stateLabel(exception({ state: "expired" }), ME)).toBe("Expired");
  });
});
