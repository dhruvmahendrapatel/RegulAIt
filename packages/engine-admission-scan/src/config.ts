/**
 * ADR-0242 §6.1 — which SUBJECT engine this image is, and the fixed facts about it.
 *
 * One package serves every subject-engine image: the two admission-scan engines (`engines/mcpscanner`,
 * `engines/skillscanner`) and, ADR-0362 slice 1b, the content extractor (`engines/contentextract`). Each runs one
 * gateway-placed input file through one offline driver of ours in the task sandbox and returns the driver's report
 * unread; what the report means is the gateway's business (an admission verdict, or extracted text), never this
 * package's. The runner reads its engine from `REGULAIT_ADMISSION_ENGINE` (the image sets it), the task from its argv
 * (the manifest's `taskEntry`: the sandbox init gives the workload no environment but PATH and HOME). Anything that is
 * not one of these engines is refused before the runner or the task does anything (fail closed).
 */
import {
  ADMISSION_SCAN_ENGINE_IDS,
  ADMISSION_SCAN_ENGINES,
  CONTENTEXTRACT_ENGINE_VERSION,
  CONTENTEXTRACT_SUBJECT_FILE,
  ENGINE_MANIFEST,
  type AdmissionScanEngineId,
} from "@regulait/shared";

export const ADMISSION_ENGINE_ENV = "REGULAIT_ADMISSION_ENGINE";

/** every engine this shim serves: the admission-scan engines, then the content extractor (ADR-0362) */
export const SUBJECT_ENGINE_IDS: readonly SubjectEngineId[] = Object.freeze([...ADMISSION_SCAN_ENGINE_IDS, "contentextract"]);
export type SubjectEngineId = AdmissionScanEngineId | "contentextract";

export class AdmissionEngineConfigError extends Error {}

/** a value naming one of the subject engines, or a refusal */
export function parseAdmissionEngine(value: unknown): SubjectEngineId {
  if (typeof value === "string" && (SUBJECT_ENGINE_IDS as readonly string[]).includes(value)) return value as SubjectEngineId;
  throw new AdmissionEngineConfigError(`${ADMISSION_ENGINE_ENV} must be one of ${SUBJECT_ENGINE_IDS.join(", ")}`);
}

export function admissionEngineFromEnv(env: NodeJS.ProcessEnv = process.env): SubjectEngineId {
  return parseAdmissionEngine(env[ADMISSION_ENGINE_ENV]);
}

/** is this one of the admission-scan engines (whose report the gateway reads as an admission verdict)? */
export function isAdmissionScanEngine(engine: SubjectEngineId): engine is AdmissionScanEngineId {
  return (ADMISSION_SCAN_ENGINE_IDS as readonly string[]).includes(engine);
}

/**
 * The one input file each driver reads, at the input root: the name the gateway places the subject under
 * (apps/gateway/src/admission-scan-runs.ts `ADMISSION_SCAN_INPUT_FILE`, and `CONTENTEXTRACT_SUBJECT_FILE` for the
 * extractor's bundle, content-inspection-runs.ts; the gateway refuses any other).
 */
export const ADMISSION_SUBJECT_FILE: Readonly<Record<SubjectEngineId, string>> = Object.freeze({
  mcpscanner: "tools.json",
  skillscanner: "SKILL.md",
  contentextract: CONTENTEXTRACT_SUBJECT_FILE,
});

/** the installed distribution whose METADATA names the engine's version (never the manifest's claim) */
export const ADMISSION_ENGINE_DISTRIBUTION: Readonly<Record<AdmissionScanEngineId, string>> = Object.freeze({
  mcpscanner: "cisco_ai_mcp_scanner",
  skillscanner: "cisco_ai_skill_scanner",
});

/** where each image installs its engine and our driver (engines/<id>/Dockerfile) */
export function admissionImagePaths(engine: SubjectEngineId): { venv: string; python: string; driver: string } {
  const base = `/opt/${engine}`;
  return { venv: `${base}/venv`, python: `${base}/venv/bin/python`, driver: `${base}/${engine === "contentextract" ? "extract.py" : "scan.py"}` };
}

/**
 * What the driver is given as its input argument. The admission drivers read the input ROOT (the one file there) and
 * echo what they read; the extractor reads the bundle FILE itself (`extract.py <bundle.json> <result.json>`). Either
 * way the gateway's file is the only file at the root (`runSandboxTask`'s `subjectFiles` checks that first).
 */
export function driverInputArg(engine: SubjectEngineId, paths: { inputRoot: string; subjectFile: string }): string {
  return engine === "contentextract" ? paths.subjectFile : paths.inputRoot;
}

/** the manifest's worker-attested switch for this engine (its one usage-data entry) */
export function offlineSwitch(engine: SubjectEngineId): string {
  const sw = ENGINE_MANIFEST[engine].workerAttestedSwitches;
  if (sw.length !== 1) throw new AdmissionEngineConfigError(`${engine}: expected exactly one worker-attested switch`);
  return sw[0]!;
}

/**
 * Every credential or endpoint that would turn on a remote analyzer, as each driver lists them (`REMOTE_SWITCHES` in
 * engines/<id>/scan.py; config.test.ts keeps the two in lockstep). The worker's self-test reports the offline switch
 * only when none is set in the environment the driver is started with (the driver also refuses to run then).
 */
export const REMOTE_ANALYZER_ENV: Readonly<Record<SubjectEngineId, readonly string[]>> = Object.freeze({
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
  // ADR-0362: the extractor has no remote analyzer and reads no credential or environment (engines/contentextract/extract.py)
  contentextract: Object.freeze([]),
});

/** the engine's pinned version (the manifest's and the shared interpreter's: one value) */
export function pinnedVersion(engine: SubjectEngineId): string {
  return engine === "contentextract" ? CONTENTEXTRACT_ENGINE_VERSION : ADMISSION_SCAN_ENGINES[engine].version;
}

/**
 * The driver's time limit inside the sandbox. Both drivers refuse an input over 8 MiB; a scan of that is seconds.
 * The bound sits well inside the engine-worker profile's per-call wall clock (1800 s), which the executor enforces.
 */
export const ADMISSION_DRIVER_TIMEOUT_MS = 10 * 60 * 1000;
/**
 * ADR-0362: the extractor's limit. Its own clock stops it at 20 s (`deadlineMs`, CONTENT_EXTRACT_HARD_LIMITS); this is
 * the backstop for a parser that ignores its clock, well inside the run's deadline.
 */
export const CONTENTEXTRACT_DRIVER_TIMEOUT_MS = 60 * 1000;

export function driverTimeoutMs(engine: SubjectEngineId): number {
  return engine === "contentextract" ? CONTENTEXTRACT_DRIVER_TIMEOUT_MS : ADMISSION_DRIVER_TIMEOUT_MS;
}
