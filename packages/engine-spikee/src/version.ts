/**
 * ADR-0245 — the spikee version actually installed in the image's venv (never the manifest's claim): read from the
 * installed distribution's METADATA, offline.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

export const SPIKEE_VENV = process.env.REGULAIT_SPIKEE_VENV ?? "/opt/spikee/venv";

export function installedSpikeeVersion(venv = SPIKEE_VENV): string {
  const lib = path.join(venv, "lib");
  for (const py of readdirSync(lib).filter((d) => /^python3\.\d{1,3}$/.test(d))) {
    const site = path.join(lib, py, "site-packages");
    for (const d of readdirSync(site).filter((n) => /^spikee-[0-9A-Za-z.+]{1,64}\.dist-info$/.test(n))) {
      const m = /^Version:[ \t]*(\S{1,64})[ \t]*$/m.exec(readFileSync(path.join(site, d, "METADATA"), "utf8"));
      if (m) return m[1]!;
    }
  }
  throw new Error(`no spikee distribution found under ${venv}`);
}
