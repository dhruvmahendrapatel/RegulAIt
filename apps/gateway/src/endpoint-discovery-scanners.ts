/**
 * ADR-0195 SD3 — the two no-agent endpoint source kinds in SD0's scanner registry.
 *
 * `endpoint_osquery` and `endpoint_inventory` are FED BY UPLOAD: the customer's
 * own osquery or MDM/EDR produces the file and an admin imports it through
 * `POST /v1/discovery/sources/:sourceId/endpoint-imports` (endpoint-import-routes.ts).
 * RegulAIt never reaches out to a device, so the scanner itself observes
 * nothing. SD0 never schedules an upload-fed kind; a "run now" of one succeeds
 * with zero observations, calls nothing and reads no credential.
 */
import type { Scanner } from "./discovery-scanners.js";

const uploadFed = (kind: "endpoint_osquery" | "endpoint_inventory" | "endpoint_agent"): Scanner => ({
  kind,
  requiresCredential: false,
  run: async () => ({ observations: [] }),
});

export const ENDPOINT_IMPORT_SCANNERS: readonly Scanner[] = Object.freeze([uploadFed("endpoint_osquery"), uploadFed("endpoint_inventory")]);

/**
 * ADR-0195 SD4b: the RegulAIt endpoint agent's source kind. Also fed by upload: the agents send signed reports
 * (endpoint-agent-routes.ts) and the ingest job commits them as runs of this source; a "run now" observes nothing.
 */
export const ENDPOINT_AGENT_SCANNER: Scanner = Object.freeze(uploadFed("endpoint_agent"));
