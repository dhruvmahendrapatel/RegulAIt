/**
 * ADR-0242 §6.1 — the engine version actually installed in the image's venv (never the manifest's claim): read from
 * the installed distribution's METADATA, offline, as modelscan's runner does.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { AdmissionScanEngineId } from "@regulait/shared";
import { ADMISSION_ENGINE_DISTRIBUTION, admissionImagePaths } from "./config.js";

export function installedAdmissionEngineVersion(engine: AdmissionScanEngineId, venv = admissionImagePaths(engine).venv): string {
  const dist = ADMISSION_ENGINE_DISTRIBUTION[engine];
  const lib = path.join(venv, "lib");
  for (const py of readdirSync(lib).filter((d) => /^python3\.\d+$/.test(d))) {
    const site = path.join(lib, py, "site-packages");
    for (const d of readdirSync(site).filter((n) => n.startsWith(`${dist}-`) && n.endsWith(".dist-info"))) {
      const m = /^Version:\s*(\S+)\s*$/m.exec(readFileSync(path.join(site, d, "METADATA"), "utf8"));
      if (m) return m[1]!;
    }
  }
  throw new Error(`no ${dist} distribution found under ${venv}`);
}
