/**
 * ADR-0187 B5-E — the sidecar engine runner core (protocol client, self-test,
 * egress probe, process-group execution). Each engine image's shim builds on it.
 */
export * from "./egress.js";
export * from "./process.js";
export * from "./runner.js";
