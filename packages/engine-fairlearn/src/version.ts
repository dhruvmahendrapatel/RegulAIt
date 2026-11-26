/**
 * ADR-0346 — the fairlearn version actually installed in the image's venv (never the manifest's claim): read from the
 * installed distribution's METADATA, offline. Every pattern is anchored, with bounded and non-overlapping repeats.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

export const FAIRLEARN_VENV = process.env.REGULAIT_FAIRLEARN_VENV ?? "/opt/fairlearn/venv";

export function installedFairlearnVersion(venv = FAIRLEARN_VENV): string {
  const lib = path.join(venv, "lib");
  for (const py of readdirSync(lib).filter((d) => /^python3\.\d{1,3}$/.test(d))) {
    const site = path.join(lib, py, "site-packages");
    for (const d of readdirSync(site).filter((n) => /^fairlearn-[0-9A-Za-z.+]{1,64}\.dist-info$/.test(n))) {
      const m = /^Version:[ \t]*(\S{1,64})[ \t]*$/m.exec(readFileSync(path.join(site, d, "METADATA"), "utf8"));
      if (m) return m[1]!;
    }
  }
  throw new Error(`no fairlearn distribution found under ${venv}`);
}
