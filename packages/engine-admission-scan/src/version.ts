/**
 * ADR-0242 §6.1 — the engine version actually installed in the image (never the manifest's claim), read offline:
 *   - an admission-scan engine: from the installed distribution's METADATA in the image's venv, as modelscan's runner;
 *   - the content extractor (ADR-0362): from `EXTRACTOR_VERSION` in the installed extract.py, which is our own code and
 *     no distribution (content-inspection.test.ts keeps it equal to the manifest's version).
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { ADMISSION_ENGINE_DISTRIBUTION, admissionImagePaths, isAdmissionScanEngine, type SubjectEngineId } from "./config.js";

/** `EXTRACTOR_VERSION = "x.y.z"` on a line of its own in extract.py */
export function extractorVersionOf(source: string): string | null {
  const m = /^EXTRACTOR_VERSION = "([0-9A-Za-z.+-]{1,32})"$/m.exec(source);
  return m ? m[1]! : null;
}

export function installedAdmissionEngineVersion(engine: SubjectEngineId, venv = admissionImagePaths(engine).venv): string {
  if (!isAdmissionScanEngine(engine)) {
    const driver = path.join(path.dirname(venv), "extract.py");
    const v = extractorVersionOf(readFileSync(driver, "utf8"));
    if (!v) throw new Error(`no EXTRACTOR_VERSION in ${driver}`);
    return v;
  }
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
