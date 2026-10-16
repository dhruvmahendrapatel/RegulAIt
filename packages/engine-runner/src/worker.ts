/**
 * ADR-0190 I5 — the WORKER side of the engine core, for code that runs INSIDE an engine task's sandbox only: the
 * process-group runner (the engine itself is a child process group of the task) and the task helper (input, task
 * secret, gateway channel, result frames). A runner entry point never imports this module: the static guard
 * `adr0190-i5-engine-runner-no-spawn.test.ts` walks every runner's import closure.
 */
export * from "./process.js";
export * from "./sandbox-task.js";
