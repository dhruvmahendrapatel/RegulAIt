/**
 * The device-policy signer (Ed25519, the ADR-0298 policy-signing key path), as an external-write CONTRACT.
 *
 * Owner answer B4 (2026-11-15): one rotatable device-policy signer signs endpoint and browser policies; it is built by
 * the browser lane and is not on main yet. Until it lands it is NULL in production; there is deliberately no
 * environment variable or setting that supplies a key (buildApp's code-only test seam injects one).
 *
 * A signature is what makes a directive act on a developer's device (ADR-0331: an endpoint agent edits a config only
 * under a signed directive), so `signPayload` is a classified external write, `device_policy.sign_payload`: every call is
 * the direct body of `runExternalWrite` and stops at once when the execution mode leaves `normal` (external-effects.test.ts enrols every
 * file that imports this module, and the barrier matrix drives it).
 */
export interface DevicePolicySigner {
  readonly kind: "device_policy_signer";
  /** the key id the agent's keyring names (agents/endpoint/internal/enforce: keyIDShape) */
  keyId: string;
  /** the Ed25519 signature (64 bytes) over exactly `payload` */
  signPayload(payload: Buffer): Promise<Buffer>;
}
