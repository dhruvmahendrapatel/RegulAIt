/**
 * The ADR-0331 directive signer (Ed25519), as an external-write CONTRACT: the narrow face the endpoint-directive route
 * signs through. It is NULL in production until it is wired to the shared ADR-0334 device-policy key
 * (`device-policy-signer.ts`, owner decision B4); there is deliberately no environment variable or setting that
 * supplies one here (buildApp's code-only test seam injects one).
 *
 * A signature is what makes a directive act on a developer's device (ADR-0331: an endpoint agent edits a config only
 * under a signed directive), so `signPayload` is a classified external write, `device_policy.sign_payload`: every call is
 * the direct body of `runExternalWrite` and stops at once when the execution mode leaves `normal` (external-effects.test.ts enrols every
 * file that imports this module, and the barrier matrix drives it).
 */
export interface DirectiveSigner {
  readonly kind: "directive_signer";
  /** the key id the agent's keyring names (agents/endpoint/internal/enforce: keyIDShape) */
  keyId: string;
  /** the Ed25519 signature (64 bytes) over exactly `payload` */
  signPayload(payload: Buffer): Promise<Buffer>;
}
