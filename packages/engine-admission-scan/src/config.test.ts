/**
 * ADR-0242 §6.1 — the engine this image is, refused unless it is one of the two (fail closed), and the fixed facts the
 * shim shares with the manifest and the drivers, kept in lockstep with them.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ADMISSION_SCAN_ENGINE_IDS, ENGINE_MANIFEST } from "@regulait/shared";
import { ADMISSION_ENGINE_ENV, ADMISSION_SUBJECT_FILE, AdmissionEngineConfigError, admissionEngineFromEnv, admissionImagePaths, offlineSwitch, parseAdmissionEngine, REMOTE_ANALYZER_ENV } from "./config.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

describe("the engine id (REGULAIT_ADMISSION_ENGINE, or the task's argv)", () => {
  it("names one of the two admission-scan engines, or nothing starts", () => {
    expect(admissionEngineFromEnv({ [ADMISSION_ENGINE_ENV]: "mcpscanner" })).toBe("mcpscanner");
    expect(admissionEngineFromEnv({ [ADMISSION_ENGINE_ENV]: "skillscanner" })).toBe("skillscanner");
    for (const bad of [undefined, "", "modelscan", "garak", "MCPSCANNER", " mcpscanner", "mcpscanner\n", "../mcpscanner"]) {
      expect(() => admissionEngineFromEnv({ [ADMISSION_ENGINE_ENV]: bad }), String(bad)).toThrow(AdmissionEngineConfigError);
    }
    expect(() => admissionEngineFromEnv({})).toThrow(/must be one of mcpscanner, skillscanner/);
    expect(() => parseAdmissionEngine(42)).toThrow(AdmissionEngineConfigError);
    expect(() => parseAdmissionEngine(["mcpscanner"])).toThrow(AdmissionEngineConfigError);
  });
});

describe("the facts the shim shares with the manifest, the gateway and the drivers", () => {
  it("each engine reads one root file, the one the gateway places (admission-scan-runs.ts)", () => {
    expect(ADMISSION_SUBJECT_FILE).toEqual({ mcpscanner: "tools.json", skillscanner: "SKILL.md" });
    const gateway = readFileSync(path.join(root, "apps/gateway/src/admission-scan-runs.ts"), "utf8");
    expect(gateway).toContain('export const ADMISSION_SCAN_INPUT_FILE = { mcpscanner: "tools.json", skillscanner: "SKILL.md" } as const;');
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
