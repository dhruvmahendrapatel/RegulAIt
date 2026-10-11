/**
 * Vitest setup file (apps/gateway/vitest.config.ts `setupFiles`) — TEST ONLY.
 *
 * ADR-0189 R25 item 6: under the strict defaults (`ai_bom_snapshot_triggers =
 * sign_off_events`, `ai_bom_snapshot_without_key = refuse`) every sign-off
 * (a use-case or model-card approval, evidence attached, a prompt or agent
 * config promotion, a server clear, a skill admission) is REFUSED with 409
 * `bom_signing_unavailable` while no receipt signing key is configured. A real
 * deployment holds that key (ADR-0116); so does this suite, so the suite tests
 * what ships: each sign-off commits and then takes its signed AI BOM snapshot.
 *
 * The key is derived from a fixed, public seed, so every test file (and every
 * shard on its own database) records the SAME key under the SAME key id, and no
 * file can trip the "key conflicts with its recorded public key" refusal by
 * minting a second key under one id. It signs nothing outside this suite and
 * is worth nothing as a secret.
 *
 * It is set only when the caller's environment names no receipt key. A test
 * that needs NO key (the `no_key` states, the 409 refusals) deletes these two
 * variables and restores them afterwards, as those tests already do.
 */
import { createHash, createPrivateKey } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export const TEST_RECEIPT_KEY_ID = "vitest-suite-receipt";

if (!process.env.REGULAIT_RECEIPT_SIGNING_KEY && !process.env.REGULAIT_RECEIPT_SIGNING_KEY_ID) {
  // RFC 8410 PKCS#8 wrapper for a raw Ed25519 seed: SEQUENCE { version 0, AlgorithmIdentifier id-Ed25519, OCTET STRING { OCTET STRING seed } }
  const seed = createHash("sha256").update("regulait gateway vitest suite receipt key (test only)").digest();
  const der = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]);
  const pem = createPrivateKey({ key: der, format: "der", type: "pkcs8" }).export({ format: "pem", type: "pkcs8" }) as string;
  const dir = path.join(tmpdir(), "regulait-vitest-receipt-key");
  const file = path.join(dir, "receipt.pem");
  // A file left by an earlier run (or another checkout) is used only when it holds
  // exactly this key: anything else would sign under TEST_RECEIPT_KEY_ID with a
  // different key and trip the recorded-public-key refusal. It is rewritten through
  // a per-process temporary file and a rename, so a parallel worker never reads a
  // half-written key.
  let current: string | null = null;
  try {
    current = existsSync(file) ? readFileSync(file, "utf8") : null;
  } catch {
    current = null;
  }
  if (current !== pem) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = path.join(dir, `receipt.pem.${process.pid}.${Date.now()}.tmp`);
    writeFileSync(tmp, pem, { mode: 0o600 });
    renameSync(tmp, file);
  }
  process.env.REGULAIT_RECEIPT_SIGNING_KEY = file;
  process.env.REGULAIT_RECEIPT_SIGNING_KEY_ID = TEST_RECEIPT_KEY_ID;
}
