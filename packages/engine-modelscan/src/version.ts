/**
 * ADR-0187 B5-M — the modelscan version actually installed in the image's venv (never the
 * manifest's claim): read from the installed distribution's METADATA, offline.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

export const MODELSCAN_VENV = process.env.REGULAIT_MODELSCAN_VENV ?? "/opt/modelscan/venv";

export function installedModelscanVersion(venv = MODELSCAN_VENV): string {
  const lib = path.join(venv, "lib");
  for (const py of readdirSync(lib).filter((d) => /^python3\.\d+$/.test(d))) {
    const site = path.join(lib, py, "site-packages");
    for (const d of readdirSync(site).filter((n) => /^modelscan-[^/]+\.dist-info$/.test(n))) {
      const m = /^Version:\s*(\S+)\s*$/m.exec(readFileSync(path.join(site, d, "METADATA"), "utf8"));
      if (m) return m[1]!;
    }
  }
  throw new Error(`no modelscan distribution found under ${venv}`);
}
