/**
 * ADR-0338 §3: the contract a vendor adapter's `control` member implements (Copilot Studio first, slice 1b). Gateway-local
 * so the external-effects barrier (external-effects.test.ts CONTRACTS) classifies its writes: `apply` is the operation
 * `vendor_agent_control.apply` (takes an agent out of service, the one dial exemption) and `reverse` is
 * `vendor_agent_control.reverse` (puts it back). `actions` and `readState` are reads. No vendor is named here.
 */
import type { ControlResult, DiscoveryStoredCredentialMode, VendorAgentControlAction, VendorAgentState } from "@regulait/shared";

/** The agent to act on, taken only from a discovered registry record: an admin never types a vendor id. */
export interface VendorAgentRef {
  readonly recordId: string;
  readonly sourceId: string;
  readonly registry: string;
  /** reported by the vendor through discovery, so untrusted: an adapter path-encodes it (`encodeURIComponent`) and
   * never splices it into a host or an unescaped query (#1096 security review, nit 1) */
  readonly externalId: string;
  /** the vendor locator besides the agent id (Copilot Studio: the Power Platform environment id), from the record's
   * vendor attributes through `locatorOf`; untrusted in the same way, so shape-checked and path-encoded */
  readonly locator: string | null;
}

/**
 * How the control obtains its token from the source's `platform_write` credential. Entra only in slice 1b (Copilot
 * Studio); the token is requested for exactly `scope`, through the guarded fetch.
 */
export interface ControlTokenSpec {
  readonly provider: "entra";
  readonly scope: string;
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
  /** ADR-0338 §3a: the credential modes the vendor accepts for control; `delegated` only where it is documented */
  readonly acceptedModes: readonly DiscoveryStoredCredentialMode[];
  readonly token: ControlTokenSpec;
  /** the locator the vendor needs besides the agent id, from the record's vendor attributes; absent for a vendor that
   * needs none. Null when the record has none: the request is then refused (`vendor_locator_missing`) before anything
   * is queued */
  locatorOf?(vendorAttributes: Readonly<Record<string, unknown>>): string | null;
  /** read the agent's current service state (the vendor's documented read; never lists the inventory) */
  readState(ctx: ControlContext, ref: VendorAgentRef): Promise<VendorAgentState>;
  /** take the agent out of service by `action`; idempotent at the vendor */
  apply(ctx: ControlContext, ref: VendorAgentRef, action: VendorAgentControlAction): Promise<ControlResult>;
  /** put the agent back into service, undoing `action`; idempotent at the vendor */
  reverse(ctx: ControlContext, ref: VendorAgentRef, action: VendorAgentControlAction): Promise<ControlResult>;
}
