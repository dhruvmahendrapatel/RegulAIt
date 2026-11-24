/**
 * ADR-0193 addendum (E50), review R2 finding 1 on PR #1133: no credential that is not a person can reach the memory
 * and shared-context write routes, so an agent acting under its own credential cannot omit the causal context there.
 *
 * Each non-person principal is held to an allow-list of routes (a delegated workload token, a virtual key, an engine
 * runner or enrolment token, a PDP client, an endpoint agent, a browser extension). This pins that none of those
 * lists names a memory or context write route. A change that adds one fails here, which is the moment to require a
 * server-derived causal context for that principal (ADR-0193 open question 2) before the floor can be skipped by
 * omission.
 */
import { describe, expect, it } from "vitest";
import { BROWSER_EXTENSION_TOKEN_ROUTES } from "./browser-device.js";
import { ENDPOINT_AGENT_TOKEN_ROUTES } from "./endpoint-agent.js";
import { ALL_RUNNER_ROUTES, PDP_CLIENT_ROUTES } from "./engine-runner-auth.js";
import { WORKLOAD_ROUTES } from "./oauth/resource.js";
import { ENGINE_KEY_ALLOWED_ROUTES, VIRTUAL_KEY_ALLOWED_ROUTES } from "./virtual-keys.js";

const MEMORY_WRITE_ROUTES = [
  "POST /v1/projects/:projectId/context",
  "POST /v1/projects/:projectId/context/promote",
  "POST /v1/builder/agents/:id/memory",
] as const;

const NON_PERSON_ALLOW_LISTS: Record<string, ReadonlySet<string>> = {
  "workload (delegated) token": WORKLOAD_ROUTES,
  "virtual key (dispatch)": VIRTUAL_KEY_ALLOWED_ROUTES,
  "virtual key (engine)": ENGINE_KEY_ALLOWED_ROUTES,
  "engine runner / enrolment": ALL_RUNNER_ROUTES,
  "PDP client": PDP_CLIENT_ROUTES,
  "endpoint agent": ENDPOINT_AGENT_TOKEN_ROUTES,
  "browser extension": BROWSER_EXTENSION_TOKEN_ROUTES,
};

describe("E50: memory writes are reachable only by a person's own credential", () => {
  it.each(Object.entries(NON_PERSON_ALLOW_LISTS))("%s cannot reach a memory or context write route", (_name, allowed) => {
    expect(allowed.size).toBeGreaterThan(0); // a real list, not an empty stand-in
    expect(MEMORY_WRITE_ROUTES.filter((r) => allowed.has(r))).toEqual([]);
  });
});
