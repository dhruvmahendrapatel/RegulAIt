/**
 * ADR-0242 §6.1 — the admission-scan engine shim (mcpscanner and skillscanner): the runner (main.ts), the task run
 * only in an executor's sandbox (task.ts, task-main.ts), the exchange between them, the adapter and the self-test.
 */
export * from "./adapter.js";
export * from "./config.js";
export * from "./exchange.js";
export * from "./selftest.js";
export * from "./task.js";
export * from "./version.js";
