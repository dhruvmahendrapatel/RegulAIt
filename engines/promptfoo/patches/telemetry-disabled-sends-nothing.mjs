#!/usr/bin/env node
/**
 * ADR-0187 B5-P — the minimal promptfoo patch the ADR allows ("Defaults taken: Images").
 *
 * WHAT IT FIXES. In promptfoo 0.123.1 and 0.124.1 (and every build we read), `Telemetry.record()` with
 * PROMPTFOO_DISABLE_TELEMETRY=1 calls `recordTelemetryDisabled()`, which calls `sendEvent()`, which
 * POSTs a "telemetry disabled" event to the vendor's collector with `fetchWithProxy` — so the
 * documented opt-out is not a zero-egress switch (R9, confirmed for 0.123.1 in R10 §promptfoo; re-read in 0.124.1, ADR-0187 decision 176).
 *
 * THE PATCH. One statement at the top of every copy of `sendEvent` (the bundle carries the class
 * four times: three ESM chunks and one CJS chunk): `if (this.disabled) return;`. Nothing else
 * changes. Network denial on the `engines` network stays the real control; this only stops the
 * attempt, so the egress log of a correctly configured runner is empty.
 *
 * FAIL CLOSED. The script refuses (exit 1) unless it finds exactly the expected number of copies,
 * each exactly once, and re-reads every file afterwards to prove the guard is present. A promptfoo
 * upgrade that moves or renames the code therefore breaks the image build instead of silently
 * shipping an unpatched engine. Usage: node telemetry-disabled-sends-nothing.mjs <promptfoo dir>.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const EXPECTED_COPIES = 4;
const NEEDLE = "\tsendEvent(eventName, properties) {\n";
const GUARD = "\t\tif (this.disabled) return; // regulait: PROMPTFOO_DISABLE_TELEMETRY sends nothing\n";

export function patchTelemetry(promptfooDir) {
  const srcDir = join(promptfooDir, "dist", "src");
  const files = readdirSync(srcDir).filter((f) => /^telemetry-[A-Za-z0-9_-]+\.(c?js)$/.test(f));
  const patched = [];
  for (const f of files) {
    const path = join(srcDir, f);
    const text = readFileSync(path, "utf8");
    const count = text.split(NEEDLE).length - 1;
    if (count === 0) continue;
    if (count !== 1) throw new Error(`${f}: expected one sendEvent, found ${count}`);
    if (text.includes(GUARD)) throw new Error(`${f}: already patched`);
    writeFileSync(path, text.replace(NEEDLE, NEEDLE + GUARD));
    patched.push(f);
  }
  if (patched.length !== EXPECTED_COPIES) {
    throw new Error(`expected ${EXPECTED_COPIES} telemetry copies to patch, patched ${patched.length} (${patched.join(", ")})`);
  }
  for (const f of patched) {
    const after = readFileSync(join(srcDir, f), "utf8");
    if (!after.includes(NEEDLE + GUARD)) throw new Error(`${f}: guard missing after patch`);
  }
  return patched;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const dir = process.argv[2];
  if (!dir) {
    console.error("usage: telemetry-disabled-sends-nothing.mjs <promptfoo package dir>");
    process.exit(2);
  }
  try {
    const patched = patchTelemetry(dir);
    console.log(`patched ${patched.length} telemetry copies: ${patched.join(", ")}`);
  } catch (e) {
    console.error(`telemetry patch refused: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
