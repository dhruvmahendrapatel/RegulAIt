/**
 * ADR-0338 §3: the contract a vendor adapter's `control` member implements (Copilot Studio first, slice 1b). Gateway-local
 * so the external-effects barrier (external-effects.test.ts CONTRACTS) classifies its writes: `apply` is the operation
 * `vendor_agent_control.apply` (takes an agent out of service, the one dial exemption) and `reverse` is
 * `vendor_agent_control.reverse` (puts it back). `actions` and `readState` are reads. No vendor is named here.
 */
import type { ControlResult, VendorAgentControlAction, VendorAgentState } from "@regulait/shared";

/** The agent to act on, taken only from a discovered registry record: an admin never types a vendor id. */
export interface VendorAgentRef {
  readonly recordId: string;
  readonly sourceId: string;
  readonly registry: string;
  readonly externalId: string;
}

/**
 * Everything a control call may use. The fetch is the tenant's guarded fetch (egress allow-list, SSRF guard); an
 * adapter holds no fetch of its own. The token comes from the source's `platform_write` credential, server side.
 */
export interface ControlContext {
  readonly fetch: typeof globalThis.fetch;
  readonly signal: AbortSignal;
  readonly token: string;
}

export interface VendorAgentControl {
  readonly kind: "vendor_agent_control";
  /** the actions this vendor documents a control for */
  readonly actions: readonly VendorAgentControlAction[];
  /** read the agent's current service state (the vendor's documented read; never lists the inventory) */
  readState(ctx: ControlContext, ref: VendorAgentRef): Promise<VendorAgentState>;
  /** take the agent out of service by `action`; idempotent at the vendor */
  apply(ctx: ControlContext, ref: VendorAgentRef, action: VendorAgentControlAction): Promise<ControlResult>;
  /** put the agent back into service, undoing `action`; idempotent at the vendor */
  reverse(ctx: ControlContext, ref: VendorAgentRef, action: VendorAgentControlAction): Promise<ControlResult>;
}
