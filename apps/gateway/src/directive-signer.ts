/**
 * The ADR-0331 directive signer (Ed25519), as an external-write CONTRACT: the narrow face the endpoint-directive route
 * signs through. In production it is the shared ADR-0334 device-policy key (`device-policy-signer.ts`, owner decision
 * B4), adapted by `devicePolicyDirectiveSigner` below; buildApp's code-only test seam may inject another.
 *
 * A signature is what makes a directive act on a developer's device (ADR-0331: an endpoint agent edits a config only
 * under a signed directive), so `signPayload` is a classified external write, `device_policy.sign_payload`: every call is
 * the direct body of `runExternalWrite` and stops at once when the execution mode leaves `normal` (external-effects.test.ts enrols every
 * file that imports this module, and the barrier matrix drives it).
 */
import { sign } from "node:crypto";
import { resolveDevicePolicySigner, type DevicePolicySigner } from "./device-policy-signer.js";

export interface DirectiveSigner {
  readonly kind: "directive_signer";
  /** the key id the agent's keyring names (agents/endpoint/internal/enforce: keyIDShape) */
  keyId: string;
  /** the Ed25519 signature (64 bytes) over exactly `payload` */
  signPayload(payload: Buffer): Promise<Buffer>;
}

/**
 * Owner decision B4 (ADR-0334): the directive signer IS the shared device-policy key, adopted here (ADR-0331
 * addendum, slice 3). The adapter only signs; it is resolved again for every directive read, so a rotation of the
 * active key (REGULAIT_DEVICE_POLICY_ACTIVE_KEY_ID) applies to the next read without a restart. No key, or a key file
 * that does not parse, is `null`: the directive route then answers `503 directive_signer_unavailable` and serves nothing.
 */
export function devicePolicyDirectiveSigner(s: DevicePolicySigner): DirectiveSigner {
  const privateKey = s.active.privateKey;
  return {
    kind: "directive_signer",
    keyId: s.active.keyId,
    signPayload: async (payload: Buffer) => sign(null, payload, privateKey),
  };
}

/** the directive signer from the device-policy key, or null when there is none (never created here) */
export async function resolveDirectiveSigner(env: NodeJS.ProcessEnv = process.env): Promise<DirectiveSigner | null> {
  const key = await resolveDevicePolicySigner(env);
  return key.state === "ok" ? devicePolicyDirectiveSigner(key.signer) : null;
}
