/**
 * ADR-0236 (P11) — governed MCP bundles in the pure kernel.
 *
 * A bundle grant sits at the ROLE tier: it is consulted only after no direct or role tool grant matched, a per-user
 * revocation subtracts from it, it names exact tools (no wildcard, no read-only-all), every narrowing after the grant
 * step still applies, and with no bundle input every decision is byte-identical to the pre-0236 kernel.
 */
import { describe, expect, it } from "vitest";
import { BUNDLE_DANGEROUS_RULE_ID, DEFAULT_DENY_RULE_ID, evaluate, visibleTools, type BundleToolGrant, type EvaluationInput, type Revocation, type ToolRef } from "./index.js";

const EXEC = { mode: "normal" } as const;
const USER = "user-a";
const SERVER = "server-1";
const OTHER_SERVER = "server-2";

const readTool: ToolRef = { serverId: SERVER, name: "query_database", kind: "read" };
const writeTool: ToolRef = { serverId: SERVER, name: "drop_table", kind: "write" };
const outsideTool: ToolRef = { serverId: SERVER, name: "export_all", kind: "read" };

const bundleGrant = (o: Partial<BundleToolGrant> = {}): BundleToolGrant => ({
  id: "bg-1",
  bundleId: "bundle-1",
  bundleName: "analyst-kit",
  version: 3,
  via: "team",
  serverId: SERVER,
  toolName: readTool.name,
  ...o,
});
const revocation = (o: Partial<Revocation> = {}): Revocation => ({ id: "rev-1", userId: USER, serverId: SERVER, toolName: readTool.name, ...o });

const input = (tool: ToolRef, extra: Partial<EvaluationInput> = {}): EvaluationInput => ({
  actor: null,
  execution: EXEC,
  userId: USER,
  serverId: SERVER,
  tool,
  toolGrants: [],
  serverGrants: [],
  ...extra,
});

describe("ADR-0236 bundle grants in the kernel", () => {
  it("allows a tool the user holds through a bundle, naming the bundle, its version and how it is held", () => {
    const d = evaluate(input(readTool, { bundleToolGrants: [bundleGrant()] }));
    expect(d.effect).toBe("allow");
    expect(d.ruleId).toBe("bg-1");
    expect(d.ruleChain.slice(0, 3).map((t) => [t.rule, t.outcome])).toEqual([
      ["tool-allow-list", "no-match"],
      ["role-tool-allow-list", "no-match"],
      ["bundle-tool-allow-list", "allow"],
    ]);
    expect(d.reason).toContain("analyst-kit");
    expect(d.reason).toContain("v3");
    expect(d.reason).toContain("through a team");
  });

  it("never grants a tool outside the bundle, even on the same server (no wildcard)", () => {
    const d = evaluate(input(outsideTool, { bundleToolGrants: [bundleGrant()] }));
    expect(d.effect).toBe("deny");
    expect(d.ruleId).toBe(DEFAULT_DENY_RULE_ID);
    expect(d.ruleChain.find((t) => t.rule === "bundle-tool-allow-list")?.outcome).toBe("no-match");
  });

  it("never grants a tool on another server, even with the same name", () => {
    const other: ToolRef = { ...readTool, serverId: OTHER_SERVER };
    const d = evaluate({ ...input(other), serverId: OTHER_SERVER, bundleToolGrants: [bundleGrant()] });
    expect(d.effect).toBe("deny");
  });

  it("a per-user revocation of the tool wins over the bundle", () => {
    const d = evaluate(input(readTool, { bundleToolGrants: [bundleGrant()], revocations: [revocation()] }));
    expect(d.effect).toBe("deny");
    expect(d.ruleChain.find((t) => t.rule === "bundle-tool-allow-list")).toEqual({ rule: "bundle-tool-allow-list", outcome: "revoked", grantId: "rev-1" });
  });

  it("a server-wide per-user revocation wins over the bundle", () => {
    const d = evaluate(input(readTool, { bundleToolGrants: [bundleGrant()], revocations: [revocation({ toolName: null })] }));
    expect(d.effect).toBe("deny");
  });

  it("a read-only-scoped revocation removes a bundled WRITE tool and keeps a bundled read", () => {
    const grants = [bundleGrant(), bundleGrant({ id: "bg-2", toolName: writeTool.name, toolTier: "write", maxTier: "write" })];
    const ro = [revocation({ toolName: null, scope: "read_only" })];
    expect(evaluate(input(writeTool, { bundleToolGrants: grants, revocations: ro })).effect).toBe("deny");
    expect(evaluate(input(readTool, { bundleToolGrants: grants, revocations: ro })).effect).toBe("allow");
  });

  it("a revocation of another user does not touch this user's bundle", () => {
    const d = evaluate(input(readTool, { bundleToolGrants: [bundleGrant()], revocations: [revocation({ userId: "user-b" })] }));
    expect(d.effect).toBe("allow");
  });

  it("a direct grant keeps precedence over the bundle (and survives a revocation, as before)", () => {
    const d = evaluate(
      input(readTool, {
        toolGrants: [{ id: "tg-1", userId: USER, serverId: SERVER, toolName: readTool.name }],
        bundleToolGrants: [bundleGrant()],
        revocations: [revocation()],
      }),
    );
    expect(d.effect).toBe("allow");
    expect(d.ruleId).toBe("tg-1");
    expect(d.ruleChain.some((t) => t.rule === "bundle-tool-allow-list")).toBe(false);
  });

  it("the lead ceiling still narrows a bundled tool", () => {
    const d = evaluate(input(readTool, { bundleToolGrants: [bundleGrant()], ceilingTools: ["something_else"] }));
    expect(d.effect).toBe("deny");
    expect(d.ruleId).toBe("lead-ceiling");
  });

  it("an approval rule still pauses a bundled tool", () => {
    const d = evaluate(
      input(readTool, {
        bundleToolGrants: [bundleGrant()],
        approvalRules: [{ id: "ar-1", userId: USER, serverId: SERVER, toolName: readTool.name, writeOnly: false, approverUserId: "approver" }],
      }),
    );
    expect(d.effect).toBe("require_approval");
  });

  it("no bundle input = the pre-0236 rule chain, byte for byte", () => {
    const without = evaluate(input(readTool));
    const empty = evaluate(input(readTool, { bundleToolGrants: [] }));
    expect(empty).toEqual(without);
    expect(without.ruleChain.some((t) => t.rule === "bundle-tool-allow-list")).toBe(false);
  });

  it("visibility follows the same rule: bundled tools show, others and revoked ones do not", () => {
    const tools = [readTool, writeTool, outsideTool];
    const ent = { toolGrants: [], serverGrants: [], bundleToolGrants: [bundleGrant(), bundleGrant({ id: "bg-2", toolName: writeTool.name, toolTier: "write", maxTier: "write" })] };
    expect(visibleTools(USER, SERVER, tools, ent).map((t) => t.name)).toEqual([readTool.name, writeTool.name]);
    expect(visibleTools(USER, SERVER, tools, { ...ent, revocations: [revocation({ toolName: writeTool.name })] }).map((t) => t.name)).toEqual([readTool.name]);
  });

  describe("scope tiers (read < write < dangerous)", () => {
    const writeGrant = (o: Partial<BundleToolGrant> = {}) => bundleGrant({ id: "bg-w", toolName: writeTool.name, toolTier: "write", ...o });

    it("a grant defaults to read: a bundled write tool is not reached", () => {
      expect(evaluate(input(writeTool, { bundleToolGrants: [writeGrant()] })).effect).toBe("deny");
      expect(evaluate(input(writeTool, { bundleToolGrants: [writeGrant({ maxTier: "read" })] })).effect).toBe("deny");
      expect(evaluate(input(writeTool, { bundleToolGrants: [writeGrant({ maxTier: "write" })] })).effect).toBe("allow");
    });

    it("the stricter of the inventory tier and the call's own kind decides", () => {
      // the inventory says read, the call says write: the write tier is what must be reached
      const d = evaluate(input(writeTool, { bundleToolGrants: [writeGrant({ toolTier: "read", maxTier: "read" })] }));
      expect(d.effect).toBe("deny");
    });

    it("a higher-tier grant of the same tool through another bundle still reaches it", () => {
      const d = evaluate(input(writeTool, { bundleToolGrants: [writeGrant({ maxTier: "read" }), writeGrant({ id: "bg-w2", maxTier: "write", via: "role" })] }));
      expect(d.effect).toBe("allow");
      expect(d.ruleId).toBe("bg-w2");
    });

    it("a dangerous tool needs a dangerous-tier grant, and then always pauses for the bundle's approver", () => {
      const danger = (o: Partial<BundleToolGrant> = {}) => writeGrant({ toolTier: "dangerous", approverUserId: "approver-1", approverName: "Ana", ...o });
      expect(evaluate(input(writeTool, { bundleToolGrants: [danger({ maxTier: "write" })] })).effect).toBe("deny");
      const held = evaluate(input(writeTool, { bundleToolGrants: [danger({ maxTier: "dangerous" })] }));
      expect(held.effect).toBe("require_approval");
      expect(held.ruleId).toBe(BUNDLE_DANGEROUS_RULE_ID);
      expect(held.approverUserId).toBe("approver-1");
      const approved = evaluate(input(writeTool, { bundleToolGrants: [danger({ maxTier: "dangerous" })], approvedApprovalId: "ap-1" }));
      expect(approved.effect).toBe("allow");
    });

    it("a dangerous tool with no bundle approver is refused (fail closed)", () => {
      const d = evaluate(input(writeTool, { bundleToolGrants: [writeGrant({ toolTier: "dangerous", maxTier: "dangerous", approverUserId: null })] }));
      expect(d.effect).toBe("deny");
      expect(d.ruleId).toBe(BUNDLE_DANGEROUS_RULE_ID);
    });

    it("the dangerous hold applies only to the bundle path: a direct grant keeps its own rules", () => {
      const d = evaluate(
        input(writeTool, {
          toolGrants: [{ id: "tg-w", userId: USER, serverId: SERVER, toolName: writeTool.name }],
          bundleToolGrants: [writeGrant({ toolTier: "dangerous", maxTier: "dangerous", approverUserId: null })],
        }),
      );
      expect(d.effect).toBe("allow");
      expect(d.ruleId).toBe("tg-w");
    });

    it("a held dangerous tool stays visible (approval-required tools are usable)", () => {
      const ent = { toolGrants: [], serverGrants: [], bundleToolGrants: [writeGrant({ toolTier: "dangerous", maxTier: "dangerous", approverUserId: "approver-1" })] };
      expect(visibleTools(USER, SERVER, [writeTool], ent).map((t) => t.name)).toEqual([writeTool.name]);
    });
  });
});
