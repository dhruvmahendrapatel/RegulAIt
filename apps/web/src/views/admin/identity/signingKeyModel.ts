/**
 * ADR-0188 — the gateway issuer's signing keys and one delegation grant's
 * detail, the browser's model. Mirrors `IdentitySigningKeyView`,
 * `IDENTITY_SIGNING_KID_PATTERN` and `DelegationGrantDetailView` in
 * `packages/shared/src/identity/contract.ts`; `signingKeyModel.test.ts` pins
 * the refusal codes to `apps/gateway/src/identity-signing-keys.ts`.
 *
 * Only PUBLIC halves are ever shown. A new key's private half is a deploy-time
 * secret: the operator configures it first, and rotating here activates it.
 */
import type { DelegationAllocationView, DelegationGrantView } from "./workloadIdentityModel";

export interface IdentitySigningKeyView {
  kid: string;
  algorithm: string;
  publicJwk: { kty: string; crv: string; x: string; kid?: string };
  createdAt: string;
  activatedAt: string | null;
  retiredAt: string | null;
  revokedAt: string | null;
}
/** ADR-0188 S7: where the private halves come from (`IdentitySigningKeyConfigurationView`) */
export type IdentitySigningKeySource = "operator_managed" | "install_generated" | "missing" | "invalid";
export interface IdentitySigningKeyConfigurationView {
  source: IdentitySigningKeySource;
  configuredKids: string[];
  note: string;
}
export const SIGNING_KEY_SOURCE_TEXT: Record<IdentitySigningKeySource, string> = {
  install_generated: "Install-generated",
  operator_managed: "Operator-managed",
  missing: "Missing",
  invalid: "Unusable",
};
export interface IdentitySigningKeyListView {
  items: IdentitySigningKeyView[];
  configuration?: IdentitySigningKeyConfigurationView;
}
export interface DelegationGrantDetailView extends DelegationGrantView {
  allocation: DelegationAllocationView | null;
  childAllocations: DelegationAllocationView[];
}

/** `^[A-Za-z0-9._:-]{1,128}$`, checked by character (M-074: no regex on caller input) */
export function kidOk(kid: string): boolean {
  if (kid.length < 1 || kid.length > 128) return false;
  for (const c of kid) {
    const ok = (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || (c >= "0" && c <= "9") || "._:-".includes(c);
    if (!ok) return false;
  }
  return true;
}

export type SigningKeyState = "active" | "retired" | "revoked" | "recorded";

/** a key's state: revoked wins; then retired; then active once activated; otherwise only recorded */
export function signingKeyState(k: Pick<IdentitySigningKeyView, "activatedAt" | "retiredAt" | "revokedAt">): SigningKeyState {
  if (k.revokedAt) return "revoked";
  if (k.retiredAt) return "retired";
  if (k.activatedAt) return "active";
  return "recorded";
}

export const SIGNING_KEY_STATE_TEXT: Readonly<Record<SigningKeyState, string>> = {
  active: "Signs new tokens now.",
  retired: "No longer signs. Its public half stays published until every token it signed has expired.",
  revoked: "Every token it signed is refused. Never undone.",
  recorded: "Recorded but never activated.",
};

/** the signing-key refusal codes, in words (pinned to identity-signing-keys.ts by the test) */
export const SIGNING_KEY_REFUSALS: Readonly<Record<string, string>> = {
  signing_key_not_found: "That signing key no longer exists. Refresh the list.",
  signing_key_unknown: "That key id is not among the keys configured on this deployment. Ask the operator to configure it first.",
  signing_key_already_recorded: "That key has already been used or revoked. Configure a new key to rotate to.",
  signing_key_already_revoked: "That signing key is already revoked.",
  signing_key_ambiguous: "More than one configured key is available. Name the one to activate.",
  signing_key_unavailable: "No configured key is available to rotate to. Ask the operator to configure a new key first.",
  signing_key_config_invalid: "The deployment's signing key configuration cannot be read. Ask the operator to fix it; nothing was changed.",
};

export function signingKeyRefusal(code: unknown): string | null {
  return typeof code === "string" && Object.hasOwn(SIGNING_KEY_REFUSALS, code) ? SIGNING_KEY_REFUSALS[code]! : null;
}
