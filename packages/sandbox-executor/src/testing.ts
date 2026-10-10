/**
 * Test-only exports: the fake backend and the fake gateway. Never imported by
 * `main.ts` (a fake backend attests isolation that does not exist, and the
 * gateway cannot tell).
 */
export * from "./fake-backend.js";
export * from "./fake-gateway.js";
