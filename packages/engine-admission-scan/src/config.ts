/**
 * ADR-0242 §6.1 — which admission-scan engine this image is, and the fixed facts about it.
 *
 * One package serves both images (`engines/mcpscanner`, `engines/skillscanner`): the runner reads its engine from
 * `REGULAIT_ADMISSION_ENGINE` (the image sets it), the task from its argv (the manifest's `taskEntry`: the sandbox init
 * gives the workload no environment but PATH and HOME). Anything that is not one of the two engines is refused before
 * the runner or the task does anything (fail closed).
 */
import { ADMISSION_SCAN_ENGINE_IDS, ADMISSION_SCAN_ENGINES, ENGINE_MANIFEST, type AdmissionScanEngineId } from "@regulait/shared";

export const ADMISSION_ENGINE_ENV = "REGULAIT_ADMISSION_ENGINE";

export class AdmissionEngineConfigError extends Error {}

/** a value naming one of the two admission-scan engines, or a refusal */
export function parseAdmissionEngine(value: unknown): AdmissionScanEngineId {
  if (typeof value === "string" && (ADMISSION_SCAN_ENGINE_IDS as readonly string[]).includes(value)) return value as AdmissionScanEngineId;
  throw new AdmissionEngineConfigError(`${ADMISSION_ENGINE_ENV} must be one of ${ADMISSION_SCAN_ENGINE_IDS.join(", ")}`);
}

export function admissionEngineFromEnv(env: NodeJS.ProcessEnv = process.env): AdmissionScanEngineId {
  return parseAdmissionEngine(env[ADMISSION_ENGINE_ENV]);
}

/**
 * The one input file each driver reads, at the input root: the name the gateway places the subject under
 * (apps/gateway/src/admission-scan-runs.ts `ADMISSION_SCAN_INPUT_FILE`; the gateway refuses any other).
 */
export const ADMISSION_SUBJECT_FILE: Readonly<Record<AdmissionScanEngineId, string>> = Object.freeze({ mcpscanner: "tools.json", skillscanner: "SKILL.md" });

/** the installed distribution whose METADATA names the engine's version (never the manifest's claim) */
export const ADMISSION_ENGINE_DISTRIBUTION: Readonly<Record<AdmissionScanEngineId, string>> = Object.freeze({
  mcpscanner: "cisco_ai_mcp_scanner",
  skillscanner: "cisco_ai_skill_scanner",
});

/** where each image installs its engine and our driver (engines/<id>/Dockerfile) */
export function admissionImagePaths(engine: AdmissionScanEngineId): { venv: string; python: string; driver: string } {
  const base = `/opt/${engine}`;
  return { venv: `${base}/venv`, python: `${base}/venv/bin/python`, driver: `${base}/scan.py` };
}

/** the manifest's worker-attested switch for this engine (its one usage-data entry) */
export function offlineSwitch(engine: AdmissionScanEngineId): string {
  const sw = ENGINE_MANIFEST[engine].workerAttestedSwitches;
  if (sw.length !== 1) throw new AdmissionEngineConfigError(`${engine}: expected exactly one worker-attested switch`);
  return sw[0]!;
}

/**
 * Every credential or endpoint that would turn on a remote analyzer, as each driver lists them (`REMOTE_SWITCHES` in
 * engines/<id>/scan.py; config.test.ts keeps the two in lockstep). The worker's self-test reports the offline switch
 * only when none is set in the environment the driver is started with (the driver also refuses to run then).
 */
export const REMOTE_ANALYZER_ENV: Readonly<Record<AdmissionScanEngineId, readonly string[]>> = Object.freeze({
  mcpscanner: Object.freeze([
    "MCP_SCANNER_API_KEY",
    "MCP_SCANNER_ENDPOINT",
    "MCP_SCANNER_LLM_API_KEY",
    "MCP_SCANNER_LLM_BASE_URL",
    "MCP_SCANNER_LLM_MODEL",
    "VIRUSTOTAL_API_KEY",
    "MCP_SCANNER_VIRUSTOTAL_API_KEY",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "AWS_ACCESS_KEY_ID",
    "AWS_PROFILE",
  ]),
  skillscanner: Object.freeze([
    "SKILL_SCANNER_LLM_API_KEY",
    "SKILL_SCANNER_LLM_MODEL",
    "SKILL_SCANNER_LLM_BASE_URL",
    "SKILL_SCANNER_META_LLM_API_KEY",
    "SKILL_SCANNER_SYSTEM_ONE_ENDPOINT",
    "VIRUSTOTAL_API_KEY",
    "AI_DEFENSE_API_KEY",
    "AI_DEFENSE_API_URL",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "GEMINI_API_KEY",
    "AWS_ACCESS_KEY_ID",
    "AWS_PROFILE",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "AZURE_OPENAI_API_KEY",
  ]),
});

/** the engine's pinned version (the manifest's and the shared interpreter's: one value) */
export function pinnedVersion(engine: AdmissionScanEngineId): string {
  return ADMISSION_SCAN_ENGINES[engine].version;
}

/**
 * The driver's time limit inside the sandbox. Both drivers refuse an input over 8 MiB; a scan of that is seconds.
 * The bound sits well inside the engine-worker profile's per-call wall clock (1800 s), which the executor enforces.
 */
export const ADMISSION_DRIVER_TIMEOUT_MS = 10 * 60 * 1000;
