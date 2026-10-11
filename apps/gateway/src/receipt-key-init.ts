/**
 * `node apps/gateway/dist/receipt-key-init.js` (`pnpm --filter @regulait/gateway receipt-key:init`) —
 * ADR-0189 R25 item 12: the installer's step for the receipt signing key.
 *
 * It runs the same idempotent, create-exclusive generator the gateway runs on first boot
 * (receipt-signing-key.ts), so the installer and a booting gateway can both run it, in any order or at
 * once, and end with exactly one key. It never overwrites a key and generates nothing while the
 * operator variables (REGULAIT_RECEIPT_SIGNING_KEY / _ID) are set. Then it RESOLVES the key exactly as
 * a signer does, so an operator key the gateway cannot use (unreadable, a wrong path, only one of the two
 * variables) is reported `invalid` here and fails the install, instead of a 503 at the first sign-off.
 * It prints the key id and the public-key fingerprint, never the key.
 *
 * Exit codes: 0 a usable key (install-generated or operator-managed); 1 invalid, or generation failed
 * (sign-offs stay refused); 2 REGULAIT_INSTALL_SECRETS_DIR is unset and no operator key is set.
 */
import { checkReceiptSigningKey } from "./receipt-signing-key.js";

const check = checkReceiptSigningKey(process.env);
const line = `receipt signing key: ${check.line}`;
if (check.exitCode === 0) console.log(line);
else {
  console.error(line);
  process.exit(check.exitCode);
}
