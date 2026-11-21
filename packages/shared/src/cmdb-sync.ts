/**
 * ADR-0358 (lane E39) — CMDB sync: the shared contract (pure, no I/O).
 *
 * The AI asset inventory (agents, MCP servers, models, endpoints) is pushed to a CMDB as configuration items through a
 * vendor-neutral adapter (ServiceNow first), export only by default. This module holds the request schemas, the run
 * lifecycle (one declared transition table) and the source key every exported item carries.
 */
import { z } from "zod";
import { defineMachine } from "./state-machine.js";

export const CMDB_KIND_VALUES = ["servicenow"] as const;
export type CmdbKind = (typeof CMDB_KIND_VALUES)[number];
export const CMDB_ASSET_KIND_VALUES = ["agent", "mcp_server", "model", "endpoint"] as const;
export type CmdbAssetKind = (typeof CMDB_ASSET_KIND_VALUES)[number];

/** the default CI class for every asset kind (a generic application CI); configurable per connector */
export const CMDB_DEFAULT_CI_CLASS = "cmdb_ci_appl";
export const CMDB_DEFAULT_SOURCE_NAME = "RegulAIt";

export const CMDB_LIMITS = Object.freeze({
  /** assets exported per pass (each kind is read in name order up to this bound in total) */
  maxItemsPerPass: 2_000,
  /** items per IRE request */
  pushBatchSize: 100,
  /** sys_ids per ownership read-back request */
  readBatchSize: 100,
  /** a response bigger than this is refused (bytes) */
  maxResponseBytes: 2_000_000,
  timeoutMs: 15_000,
  /** a `running` row older than this is closed as `stale` before a new run opens */
  staleRunMinutes: 30,
  reasonMax: 500,
});

/** ServiceNow table (class) names: lowercase letters, digits and underscores, starting with a letter */
const CI_CLASS = z.string().regex(/^[a-z][a-z0-9_]{1,79}$/, "a CI class is a CMDB table name such as cmdb_ci_appl");
/** an IRE data source name (a discovery_source choice value) */
const SOURCE_NAME = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,39}$/, "a source name is 1-40 letters, digits, spaces, '_', '.' or '-'");

export const cmdbCiClassesSchema = z
  .object({ agent: CI_CLASS, mcp_server: CI_CLASS, model: CI_CLASS, endpoint: CI_CLASS })
  .strict();
export type CmdbCiClasses = z.infer<typeof cmdbCiClassesSchema>;
export const CMDB_DEFAULT_CI_CLASSES: CmdbCiClasses = Object.freeze({
  agent: CMDB_DEFAULT_CI_CLASS,
  mcp_server: CMDB_DEFAULT_CI_CLASS,
  model: CMDB_DEFAULT_CI_CLASS,
  endpoint: CMDB_DEFAULT_CI_CLASS,
});

/** an https origin: no path, query, fragment or credentials */
export function cmdbInstanceUrlProblem(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "instanceUrl is not a URL";
  }
  if (u.protocol !== "https:") return "instanceUrl must be https";
  if (u.username || u.password) return "instanceUrl must not carry credentials";
  if ((u.pathname !== "/" && u.pathname !== "") || u.search || u.hash) return "instanceUrl is an origin only (https://<instance>.service-now.com)";
  return null;
}

const reason = z.string().trim().min(1).max(CMDB_LIMITS.reasonMax);

export const createCmdbConnectorSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    kind: z.enum(CMDB_KIND_VALUES),
    instanceUrl: z.string().min(1).max(300),
    sourceName: SOURCE_NAME.optional(),
    ciClasses: cmdbCiClassesSchema.partial().optional(),
  })
  .strict();

export const updateCmdbConfigSchema = z
  .object({
    instanceUrl: z.string().min(1).max(300).optional(),
    sourceName: SOURCE_NAME.optional(),
    ciClasses: cmdbCiClassesSchema.partial().optional(),
    readBackOwnership: z.boolean().optional(),
    reason,
  })
  .strict();

export const storeCmdbCredentialSchema = z
  .object({
    username: z.string().trim().min(1).max(200),
    password: z.string().min(1).max(1_000),
    /** compare-and-set: the live credential being replaced, or null when there is none */
    replacesCredentialId: z.string().uuid().nullable(),
    reason,
  })
  .strict();

export const setCmdbEnabledSchema = z.object({ enabled: z.boolean(), reason }).strict();

// ---------------------------------------------------------------------------
// the run lifecycle (owner build rule 12, ADR-0348): one declared machine, reused by the writer and readable by agents
// ---------------------------------------------------------------------------

export const CMDB_SYNC_RUN_STATES = ["running", "succeeded", "failed", "refused"] as const;
export type CmdbSyncRunState = (typeof CMDB_SYNC_RUN_STATES)[number];

/** a run opens `running` (or is written already `refused`); `running` ends in exactly one terminal state */
export const CMDB_SYNC_RUN_MACHINE = defineMachine({
  id: "cmdb_sync_run",
  stored: "cmdb_sync_runs.status",
  states: CMDB_SYNC_RUN_STATES,
  initial: ["running", "refused"],
  terminal: ["succeeded", "failed", "refused"],
  transitions: {
    succeed: {
      from: ["running"],
      to: "succeeded",
      by: ["system", "admin"],
      summary: "the pass finished: every confirmed item is linked, the rest are retried next pass",
    },
    fail: {
      from: ["running"],
      to: "failed",
      by: ["system", "admin"],
      summary: "the pass stopped on a fixed error code (or was found stale); nothing unconfirmed was linked",
    },
  },
});
export type CmdbSyncRunEvent = (typeof CMDB_SYNC_RUN_MACHINE.events)[number];

// ---------------------------------------------------------------------------
// the exported item
// ---------------------------------------------------------------------------

/** the stable key sent as IRE's source_native_key: the same asset is the same CI on every push */
export function cmdbSourceKey(kind: CmdbAssetKind, id: string): string {
  return `regulait:${kind}:${id}`;
}

export interface CmdbExportItem {
  kind: CmdbAssetKind;
  sourceKey: string;
  /** the display name only: no prompt, configuration, credential, email or free text */
  name: string;
}
