/**
 * ADR-0187 B5-E — the sidecar engine runner core (protocol client, self-test, egress probe), the RUNNER side only.
 * ADR-0190 I5: the runner never runs an engine. Its task bridge hands each run to an executor's sandbox; the
 * process-group runner and the in-sandbox task helper are in `@regulait/engine-runner/worker`, which no runner entry
 * point may import (`adr0190-i5-engine-runner-no-spawn.test.ts`).
 */
export * from "./egress.js";
export * from "./runner.js";
export * from "./loop.js";
export * from "./artifact.js";
export * from "./key.js";
export * from "./task-bridge.js";
export { fsyncDir } from "./durable.js";
