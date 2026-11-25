/**
 * ADR-0362 — the content-extraction engine (`contentextract`), the pure half the manifest, the runner shim and the
 * gateway share.
 *
 * The engine is our own extractor (`engines/contentextract/extract.py`): it turns the files of one gateway request or
 * response into text, or refuses a file with one closed reason (`content-inspection.ts`). It runs only as an
 * `engine_worker` task in the executor's sandbox (ADR-0190 I5): no network, no secret, no model access, a read-only
 * input holding exactly the gateway's bundle. It decides nothing; the gateway runs its own detectors on the text.
 *
 * Its runs are `subject` runs with trigger `inspection`, started only by the gateway (never POST /v1/engine-runs or a
 * schedule). The subject is the bundle the gateway encrypted when it queued the run; its digest is the bundle's sha256.
 */

/** the extractor's version (`EXTRACTOR_VERSION` in extract.py; the shim reads the installed file, a test keeps both equal) */
export const CONTENTEXTRACT_ENGINE_VERSION = "0.1.0";

/** the one input file the extractor reads, at the task's input root (the gateway places it, the runner never does) */
export const CONTENTEXTRACT_SUBJECT_FILE = "bundle.json";

/**
 * The manifest's one worker-attested switch. The extractor has no telemetry, update check, download or remote
 * analyzer, so it has no usage-data switch of its own; as modelscan's `REGULAIT_MODELSCAN_SCANNER_ISOLATED`, this is
 * the worker's own self-test in the task sandbox (no egress, no runner credential in reach), reported through the
 * runner, or rested on a fresh executor attestation before the first enable.
 */
export const CONTENTEXTRACT_WORKER_SELF_TEST_SWITCH = "REGULAIT_CONTENTEXTRACT_WORKER_ISOLATED";

/** the run config every content-extraction run carries (one standard set, no params beyond the placement) */
export const CONTENTEXTRACT_SET = "extract";

/**
 * The largest bundle the extractor reads (`MAX_BUNDLE_BYTES` in extract.py; content-inspection.test.ts keeps both
 * equal): the files' base64 and a little JSON. The gateway queues nothing larger (fail closed, audited).
 */
export const CONTENTEXTRACT_MAX_BUNDLE_BYTES = 96 * 1024 * 1024;
