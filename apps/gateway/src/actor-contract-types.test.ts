/**
 * ADR-0188 S2 — the kernel's dependency-free actor types (`packages/policy-kernel/src/actor.ts`) must accept every
 * value S1's zod contract (`packages/shared/src/identity/contract.ts`) admits. The assignments below are the test:
 * `pnpm -r build` typechecks this file, so a field S1 adds or widens that the kernel twin lacks fails the build.
 * The runtime half checks a parsed S1 value is usable by the kernel's helpers as-is.
 */
import { describe, expect, it } from "vitest";
import {
  actorChainSchema,
  delegationScopeSchema,
  type ActorChain as SharedActorChain,
  type ActorChainLink as SharedActorChainLink,
  type ActorEntitlements as SharedActorEntitlements,
  type AgentEntitlementMode as SharedAgentEntitlementMode,
  type DelegationScope as SharedDelegationScope,
  type DelegationScopeItem as SharedDelegationScopeItem,
} from "@regulait/shared";
import {
  scopeCovers,
  scopeSubset,
  type ActorChain,
  type ActorChainLink,
  type ActorEntitlements,
  type AgentEntitlementMode,
  type DelegationScope,
  type DelegationScopeItem,
} from "@regulait/policy-kernel";

// compile-time: S1 → kernel assignability (the direction S3 and S4 rely on)
type Assignable<From, To> = From extends To ? true : false;
const checks: [
  Assignable<SharedActorChainLink, ActorChainLink>,
  Assignable<SharedActorChain, ActorChain>,
  Assignable<SharedDelegationScopeItem, DelegationScopeItem>,
  Assignable<SharedDelegationScope, DelegationScope>,
  Assignable<SharedActorEntitlements, ActorEntitlements>,
  Assignable<SharedAgentEntitlementMode, AgentEntitlementMode>,
] = [true, true, true, true, true, true];

describe("ADR-0188 S2 — S1 contract types are assignable to the kernel's actor types", () => {
  it("every pairing typechecks (the tuple above fails `pnpm -r build` otherwise)", () => {
    expect(checks.every(Boolean)).toBe(true);
  });

  it("a parsed S1 chain and scope are usable by the kernel helpers without conversion", () => {
    const sid = "11111111-1111-4111-8111-111111111111";
    const chain: ActorChain = actorChainSchema.parse({
      sponsorUserId: "22222222-2222-4222-8222-222222222222",
      delegationGrantId: "33333333-3333-4333-8333-333333333333",
      depth: 1,
      actors: [{ identityId: "44444444-4444-4444-8444-444444444444", kind: "agent", identifier: "spiffe://regulait.local/regulait/agent/a1" }],
    });
    expect(chain.actors[0]!.kind).toBe("agent");
    const parent: DelegationScope = delegationScopeSchema.parse([{ type: "mcp_tool", serverId: sid, toolNames: ["a", "b"], kind: "read" }]);
    const child: DelegationScope = delegationScopeSchema.parse([{ type: "mcp_tool", serverId: sid, toolNames: ["a"], kind: "read" }]);
    expect(scopeSubset(child, parent)).toBe(true);
    expect(scopeSubset(parent, child)).toBe(false);
    expect(scopeCovers(child, { type: "mcp_tool", serverId: sid, toolName: "a", kind: "read" })).toBe(true);
    // strict (decision 27): write does not include read
    expect(scopeCovers(child, { type: "mcp_tool", serverId: sid, toolName: "a", kind: "write" })).toBe(false);
  });
});
