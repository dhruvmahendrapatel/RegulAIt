/**
 * `node apps/gateway/dist/receipt-key-init.js` (`pnpm --filter @regulait/gateway receipt-key:init`) —
 * ADR-0189 R25 item 12: the installer's step for the install-generated receipt signing key.
 *
 * The same idempotent, create-exclusive generator the gateway runs on first boot
 * (receipt-signing-key.ts), so the installer and a booting gateway can both run it, in any order or at
 * once, and end with exactly one key. It never overwrites a key, and does nothing while the operator
 * variables (REGULAIT_RECEIPT_SIGNING_KEY / _ID) are set. It prints the key id and the public-key
 * fingerprint, never the key.
 *
 * Exit codes: 0 a key exists (created, reused or operator-managed); 1 generation failed (sign-offs stay
 * refused); 2 REGULAIT_INSTALL_SECRETS_DIR is unset, so there is nowhere to keep a key.
 */
import { describeInstallReceiptKey, ensureInstallReceiptKey } from "./receipt-signing-key.js";

const result = ensureInstallReceiptKey(process.env);
const line = `receipt signing key: ${describeInstallReceiptKey(result)}`;
if (result.outcome === "failed" || result.outcome === "not_configured") {
  console.error(line);
  process.exit(result.outcome === "failed" ? 1 : 2);
}
console.log(line);
