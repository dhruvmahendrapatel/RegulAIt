#!/usr/bin/env node
// Offline: build @regulait/shared first. No HTTP requests or external key service.
import { readFileSync, statSync } from "node:fs";
import { verifyReceiptBundle, isReceiptBundle } from "../packages/shared/dist/receipts/verify.js";
const paths = process.argv.slice(2);
if (paths.length < 1 || paths.length > 2) {
  process.stderr.write("Usage: node scripts/verify-receipts.mjs bundle.json [trusted-keys.json]\n");
  process.exit(2);
}
try {
  const read = (path) => {
    if (statSync(path).size > 10 * 1024 * 1024) throw new Error("Input exceeds the 10 MiB offline bound");
    return JSON.parse(readFileSync(path, "utf8"));
  };
  const bundle = read(paths[0]);
  if (!isReceiptBundle(bundle)) throw new Error("Malformed receipt bundle");
  // An operator may replace untrusted bundle keys with an independently pinned
  // key list. Missing keys then remain unverifiable instead of trusting the bundle.
  if (paths[1]) bundle.keys = read(paths[1]).keys;
  const result = verifyReceiptBundle(bundle);
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  process.exit(result.results.some((r) => r.status === "invalid") ? 1 : result.results.length === 0 || result.results.some((r) => r.status === "unverifiable") ? 2 : 0);
} catch {
  process.stderr.write("Could not verify receipt inputs. Check the JSON format, public keys and file size.\n");
  process.exit(2);
}
