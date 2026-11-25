/**
 * ADR-0242 §6.1 — the engine this image is, refused unless it is one of the two (fail closed), and the fixed facts the
 * shim shares with the manifest and the drivers, kept in lockstep with them.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ADMISSION_SCAN_ENGINE_IDS, CONTENTEXTRACT_SUBJECT_FILE, ENGINE_MANIFEST } from "@regulait/shared";
import {
  ADMISSION_ENGINE_ENV,
  ADMISSION_SUBJECT_FILE,
  AdmissionEngineConfigError,
  admissionEngineFromEnv,
  admissionImagePaths,
  driverInputArg,
  driverTimeoutMs,
  isAdmissionScanEngine,
  offlineSwitch,
  parseAdmissionEngine,
  pinnedVersion,
  REMOTE_ANALYZER_ENV,
  SUBJECT_ENGINE_IDS,
} from "./config.js";
import { extractorVersionOf } from "./version.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

describe("the engine id (REGULAIT_ADMISSION_ENGINE, or the task's argv)", () => {
  it("names one of the two admission-scan engines, or nothing starts", () => {
    expect(admissionEngineFromEnv({ [ADMISSION_ENGINE_ENV]: "mcpscanner" })).toBe("mcpscanner");
    expect(admissionEngineFromEnv({ [ADMISSION_ENGINE_ENV]: "skillscanner" })).toBe("skillscanner");
    for (const bad of [undefined, "", "modelscan", "garak", "MCPSCANNER", " mcpscanner", "mcpscanner\n", "../mcpscanner"]) {
      expect(() => admissionEngineFromEnv({ [ADMISSION_ENGINE_ENV]: bad }), String(bad)).toThrow(AdmissionEngineConfigError);
    }
    expect(() => admissionEngineFromEnv({})).toThrow(/must be one of mcpscanner, skillscanner, contentextract$/);
    expect(() => parseAdmissionEngine(42)).toThrow(AdmissionEngineConfigError);
    expect(() => parseAdmissionEngine(["mcpscanner"])).toThrow(AdmissionEngineConfigError);
  });
});

describe("the facts the shim shares with the manifest, the gateway and the drivers", () => {
  it("each engine reads one root file, the one the gateway places (admission-scan-runs.ts)", () => {
    expect(ADMISSION_SUBJECT_FILE).toEqual({ mcpscanner: "tools.json", skillscanner: "SKILL.md", contentextract: "bundle.json" });
    const gateway = readFileSync(path.join(root, "apps/gateway/src/admission-scan-runs.ts"), "utf8");
    expect(gateway).toContain('export const ADMISSION_SCAN_INPUT_FILE = { mcpscanner: "tools.json", skillscanner: "SKILL.md" } as const;');
    // ADR-0362: the extractor's bundle, under the shared name the gateway places it as
    expect(ADMISSION_SUBJECT_FILE.contentextract).toBe(CONTENTEXTRACT_SUBJECT_FILE);
    expect(readFileSync(path.join(root, "apps/gateway/src/content-inspection-runs.ts"), "utf8")).toContain("file: CONTENTEXTRACT_SUBJECT_FILE");
  });

  it("ADR-0362: the content extractor is a third subject engine, with no remote analyzer and the worker's own switch", () => {
    expect(SUBJECT_ENGINE_IDS).toEqual(["mcpscanner", "skillscanner", "contentextract"]);
    expect(admissionEngineFromEnv({ [ADMISSION_ENGINE_ENV]: "contentextract" })).toBe("contentextract");
    expect(isAdmissionScanEngine("contentextract")).toBe(false);
    expect(isAdmissionScanEngine("mcpscanner")).toBe(true);
    const m = ENGINE_MANIFEST.contentextract;
    expect(m.taskEntry).toEqual({ command: "/usr/local/bin/node", args: ["/app/dist/task-main.js", "contentextract"] });
    expect(m.needsModelAccess).toBe(false);
    expect(m.kind).toBe("content_extract");
    expect(Object.keys(m.usageDataEnv)).toEqual([offlineSwitch("contentextract")]);
    expect(offlineSwitch("contentextract")).toBe("REGULAIT_CONTENTEXTRACT_WORKER_ISOLATED");
    expect(REMOTE_ANALYZER_ENV.contentextract).toEqual([]);
    expect(pinnedVersion("contentextract")).toBe(m.version);
    // the extractor reads the bundle FILE, the admission drivers the input ROOT; nothing else differs
    const p = admissionImagePaths("contentextract");
    expect(p).toEqual({ venv: "/opt/contentextract/venv", python: "/opt/contentextract/venv/bin/python", driver: "/opt/contentextract/extract.py" });
    expect(driverInputArg("contentextract", { inputRoot: "/jobs", subjectFile: "/jobs/bundle.json" })).toBe("/jobs/bundle.json");
    expect(driverInputArg("mcpscanner", { inputRoot: "/jobs", subjectFile: "/jobs/tools.json" })).toBe("/jobs");
    expect(driverTimeoutMs("contentextract")).toBeLessThan(driverTimeoutMs("mcpscanner"));
    const dockerfile = readFileSync(path.join(root, "engines/contentextract/Dockerfile"), "utf8");
    expect(dockerfile).toContain(`COPY engines/contentextract/extract.py engines/contentextract/test_extract.py /opt/contentextract/`);
    expect(dockerfile).toContain("python -m venv /opt/contentextract/venv");
    // the version the runner reports is read from the installed extractor, which pins the manifest's
    expect(extractorVersionOf(readFileSync(path.join(root, "engines/contentextract/extract.py"), "utf8"))).toBe(m.version);
    expect(extractorVersionOf('EXTRACTOR_VERSION = "1.0"\nEXTRACTOR_VERSION_X = 2')).toBe("1.0");
    expect(extractorVersionOf('# EXTRACTOR_VERSION = "9"')).toBeNull();
  });

  it("the manifest's task entry is this package's task, with the engine in argv (the init passes no environment)", () => {
    for (const id of ADMISSION_SCAN_ENGINE_IDS) {
      expect(ENGINE_MANIFEST[id].taskEntry).toEqual({ command: "/usr/local/bin/node", args: ["/app/dist/task-main.js", id] });
      expect(ENGINE_MANIFEST[id].needsModelAccess).toBe(false);
      expect(ENGINE_MANIFEST[id].kind).toBe("admission_scan");
      // the one usage-data entry is the worker-attested offline switch
      expect(Object.keys(ENGINE_MANIFEST[id].usageDataEnv)).toEqual([offlineSwitch(id)]);
      expect(ENGINE_MANIFEST[id].usageDataEnv[offlineSwitch(id)]).toBe("1");
    }
    expect(offlineSwitch("mcpscanner")).toBe("REGULAIT_MCPSCANNER_OFFLINE_ANALYZERS_ONLY");
    expect(offlineSwitch("skillscanner")).toBe("REGULAIT_SKILLSCANNER_OFFLINE_ANALYZERS_ONLY");
  });

  it("the remote-analyzer credentials the self-test checks are exactly each driver's REMOTE_SWITCHES", () => {
    for (const id of ADMISSION_SCAN_ENGINE_IDS) {
      const driver = readFileSync(path.join(root, `engines/${id}/scan.py`), "utf8");
      const block = /^REMOTE_SWITCHES = \(([\s\S]*?)\n\)/m.exec(driver)![1]!;
      const names = [...block.matchAll(/"([A-Z0-9_]+)"/g)].map((m) => m[1]);
      expect(names.length).toBeGreaterThan(5);
      expect([...REMOTE_ANALYZER_ENV[id]]).toEqual(names);
      // the image paths the task runs the driver from are the Dockerfile's
      const p = admissionImagePaths(id);
      const dockerfile = readFileSync(path.join(root, `engines/${id}/Dockerfile`), "utf8");
      expect(dockerfile).toContain(`COPY engines/${id}/scan.py ${p.driver}`);
      expect(dockerfile).toContain(`${p.python} -I ${p.driver}`);
    }
  });
});
