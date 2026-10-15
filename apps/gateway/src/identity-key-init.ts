/**
 * `node apps/gateway/dist/identity-key-init.js` (`pnpm --filter @regulait/gateway identity-key:init`) —
 * ADR-0188 S7: the installer's step for the identity ISSUER's signing key, the twin of
 * `receipt-key-init.ts`.
 *
 * Engine runners and PDP clients authenticate with DPoP-bound self tokens the issuer signs, so a fresh
 * install with no issuer key could never let one in. This runs the same idempotent, create-exclusive
 * generator the gateway runs on first boot (`ensureInstallIdentityKey`), so the installer and a booting
 * gateway can both run it, in any order or at once, and end with exactly one key. It never overwrites a
 * key and generates nothing while REGULAIT_IDENTITY_SIGNING_KEY is set. Then it RESOLVES the keys
 * exactly as the token endpoint does, so an operator key file the gateway cannot use is reported
 * `invalid` here and fails the install, instead of a refused token at the first runner registration.
 * It prints the key ids (RFC 7638 thumbprints), never the key.
 *
 * Exit codes: 0 a usable key (install-generated or operator-managed); 1 invalid, or generation failed
 * (no token can be issued); 2 REGULAIT_INSTALL_SECRETS_DIR is unset and no operator key is set.
 */
import { ensureInstallIdentityKey, identitySigningKeyConfiguration } from "./identity-signing-keys.js";

const ensure = await ensureInstallIdentityKey(process.env);
const config = await identitySigningKeyConfiguration(process.env);
const kids = config.configuredKids.join(", ");
if (config.source === "install_generated" || config.source === "operator_managed") {
  const how = config.source === "install_generated" ? (ensure.outcome === "created" ? "install-generated on this run" : "install-generated") : "operator-managed";
  console.log(`identity issuer key: ${how}: ${kids}`);
} else {
  const why = ensure.outcome === "failed" ? ` (${ensure.reason}, ${ensure.path})` : "";
  console.error(`identity issuer key: ${config.source}${why} — ${config.note}`);
  process.exit(ensure.outcome === "not_configured" ? 2 : 1);
}
