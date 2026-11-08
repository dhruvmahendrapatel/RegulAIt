/**
 * ADR-0246 — MCP DEFINITION PINNING (rug-pull detection): the pure half.
 *
 * At an MCP server's admission the gateway records a canonical digest of every tool's definition (name, title,
 * description, input and output schema, annotations) and of the server's prompts, resources and resource templates.
 * On every later manifest fetch (a proxied `tools/list`, a governed call's first sync, the on-demand sync and the
 * scheduled re-scan) it compares what the server serves against that record. A silent change (a description edit, a
 * widened schema, an `annotations.readOnlyHint` flipped, a tool added or removed) leaves the item "changed since
 * approval" until an admin re-approves it against the diff.
 *
 * This file decides nothing about the database or the request path. It owns:
 *   - which fields of each kind are pinned, and the digest over them (RFC 8785 JCS via `canonicalize`, SHA-256);
 *   - the plan that turns stored pins plus a fresh observation into inserts, updates and removals;
 *   - the status of a pin, derived from its two digests (never stored);
 *   - the admin diff, an RFC 6902 JSON Patch (`rfc6902`).
 *
 * Design reference: Snyk agent-scan (formerly Invariant mcp-scan, Apache-2.0) pins tool descriptions by hash and
 * reports a change as a rug pull. No code from it is used here; the field choice, the per-kind keys and the
 * derived status are our own.
 */
import canonicalize from "canonicalize";
import { createPatch, type Operation } from "rfc6902";
import { z } from "zod";
import { sha256Hex } from "./audit-chain.js";

export const MCP_DEFINITION_KINDS = ["tool", "prompt", "resource", "resource_template"] as const;
export type McpDefinitionKind = (typeof MCP_DEFINITION_KINDS)[number];

/** 'block' is the strict default (ADR-0180); 'warn' serves a changed item and only audits it. */
export const MCP_DEFINITION_PIN_MODES = ["block", "warn"] as const;
export type McpDefinitionPinMode = (typeof MCP_DEFINITION_PIN_MODES)[number];

/** At most this many items of each kind are pinned per manifest fetch. A tool or prompt beyond it has no pin and
 * is therefore refused under 'block' (fail closed); a resource beyond it is treated like a template-derived URI. */
export const MCP_DEFINITION_PIN_LIMIT_PER_KIND = 1000;

/** The longest key (tool name, prompt name, resource URI, URI template) that is pinned. Longer = not pinnable. */
export const MCP_DEFINITION_KEY_MAX = 2048;

/** The fields each kind is pinned on. Anything else the server sends (`_meta`, `icons`, vendor extensions) does
 * not move the digest, because it does not reach a model or decide a grant. */
export const MCP_DEFINITION_PINNED_FIELDS: Readonly<Record<McpDefinitionKind, readonly string[]>> = {
  tool: ["name", "title", "description", "inputSchema", "outputSchema", "annotations"],
  prompt: ["name", "title", "description", "arguments"],
  resource: ["uri", "name", "title", "description", "mimeType"],
  resource_template: ["uriTemplate", "name", "title", "description", "mimeType"],
};

const KEY_FIELD: Readonly<Record<McpDefinitionKind, string>> = {
  tool: "name",
  prompt: "name",
  resource: "uri",
  resource_template: "uriTemplate",
};

/** What one manifest fetch observed. `null` (or absent) for a kind = not observed this time (the server does not
 * advertise the capability, or the fetch was not attempted): its stored pins are left exactly as they are. An
 * empty array = observed, and the server serves none. */
export interface McpServedDefinitions {
  tools: readonly unknown[];
  prompts?: readonly unknown[] | null | undefined;
  resources?: readonly unknown[] | null | undefined;
  resourceTemplates?: readonly unknown[] | null | undefined;
}

export interface PinnableDefinition {
  kind: McpDefinitionKind;
  name: string;
  definition: Record<string, unknown>;
  digest: string;
}

/** The pinned projection of one served item, or null when it has no usable key. JSON round-tripped first, so the
 * stored jsonb and the digest describe the same value. */
export function pinnableDefinition(kind: McpDefinitionKind, item: unknown): PinnableDefinition | null {
  if (item === null || typeof item !== "object" || Array.isArray(item)) return null;
  const source = item as Record<string, unknown>;
  const key = source[KEY_FIELD[kind]];
  if (typeof key !== "string" || key.length === 0 || key.length > MCP_DEFINITION_KEY_MAX) return null;
  const picked: Record<string, unknown> = {};
  for (const field of MCP_DEFINITION_PINNED_FIELDS[kind]) {
    if (Object.prototype.hasOwnProperty.call(source, field) && source[field] !== undefined) picked[field] = source[field];
  }
  let definition: Record<string, unknown>;
  try {
    definition = JSON.parse(JSON.stringify(picked)) as Record<string, unknown>;
  } catch {
    return null;
  }
  const canonical = canonicalize(definition);
  if (canonical === undefined) return null;
  return { kind, name: key, definition, digest: sha256Hex(canonical) };
}

export interface PinnableSet {
  definitions: PinnableDefinition[];
  /** the kinds this fetch observed (see McpServedDefinitions) */
  observedKinds: Set<McpDefinitionKind>;
  /** items not pinned: no usable key, a duplicate key (the first one served is pinned), or over the per-kind cap */
  skipped: Array<{ kind: McpDefinitionKind; reason: "no_key" | "duplicate" | "over_limit" }>;
}

export function pinnableDefinitions(served: McpServedDefinitions): PinnableSet {
  const lists: Array<[McpDefinitionKind, readonly unknown[] | null | undefined]> = [
    ["tool", served.tools],
    ["prompt", served.prompts],
    ["resource", served.resources],
    ["resource_template", served.resourceTemplates],
  ];
  const definitions: PinnableDefinition[] = [];
  const observedKinds = new Set<McpDefinitionKind>();
  const skipped: PinnableSet["skipped"] = [];
  for (const [kind, list] of lists) {
    if (!Array.isArray(list)) continue;
    observedKinds.add(kind);
    const seen = new Set<string>();
    for (const item of list) {
      const def = pinnableDefinition(kind, item);
      if (!def) {
        skipped.push({ kind, reason: "no_key" });
        continue;
      }
      if (seen.has(def.name)) {
        skipped.push({ kind, reason: "duplicate" });
        continue;
      }
      if (seen.size >= MCP_DEFINITION_PIN_LIMIT_PER_KIND) {
        skipped.push({ kind, reason: "over_limit" });
        continue;
      }
      seen.add(def.name);
      definitions.push(def);
    }
  }
  return { definitions, observedKinds, skipped };
}

export type McpDefinitionPinStatus = "approved" | "changed" | "added" | "removed";

/** Derived from the two digests; the table stores no status column (ADR-0200: one fact in one place). */
export function definitionPinStatus(approvedDigest: string | null, observedDigest: string | null): McpDefinitionPinStatus {
  if (approvedDigest === null) return "added";
  if (observedDigest === null) return "removed";
  return approvedDigest === observedDigest ? "approved" : "changed";
}

export interface StoredDefinitionPin {
  kind: McpDefinitionKind;
  name: string;
  approvedDigest: string | null;
  observedDigest: string | null;
}

export interface DefinitionPinPlan {
  /** served now, never pinned before: a new row with no approval */
  added: PinnableDefinition[];
  /** served now with a different digest from the one last observed */
  reobserved: Array<{ pin: StoredDefinitionPin; observed: PinnableDefinition }>;
  /** pinned, of a kind this fetch observed, and no longer served */
  gone: StoredDefinitionPin[];
}

/** What a fresh observation changes. Items whose observed digest is unchanged are not in the plan at all, so an
 * unchanged manifest costs no write. */
export function planDefinitionPins(stored: readonly StoredDefinitionPin[], observed: PinnableSet): DefinitionPinPlan {
  const byKey = new Map(stored.map((p) => [`${p.kind}\u0000${p.name}`, p]));
  const plan: DefinitionPinPlan = { added: [], reobserved: [], gone: [] };
  const servedKeys = new Set<string>();
  for (const def of observed.definitions) {
    const key = `${def.kind}\u0000${def.name}`;
    servedKeys.add(key);
    const pin = byKey.get(key);
    if (!pin) plan.added.push(def);
    else if (pin.observedDigest !== def.digest) plan.reobserved.push({ pin, observed: def });
  }
  for (const pin of stored) {
    if (!observed.observedKinds.has(pin.kind)) continue;
    if (pin.observedDigest === null) continue;
    if (!servedKeys.has(`${pin.kind}\u0000${pin.name}`)) plan.gone.push(pin);
  }
  return plan;
}

/** The admin diff: an RFC 6902 JSON Patch that turns the approved definition into the served one. An added item
 * diffs from `{}`, a removed one to `{}`. */
export function definitionDiff(
  approved: Record<string, unknown> | null,
  observed: Record<string, unknown> | null,
): Operation[] {
  return createPatch(approved ?? {}, observed ?? {});
}

const DIGEST = z.string().regex(/^[0-9a-f]{64}$/, "a SHA-256 digest (64 lowercase hex characters)");

/** POST /v1/servers/:serverId/definition-pins/approve. Each item names the observed digest the admin reviewed
 * (`null` for a removed item), so an approval can never cover a definition that changed after it was read. */
export const approveMcpDefinitionPinsSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            kind: z.enum(MCP_DEFINITION_KINDS),
            name: z.string().min(1).max(MCP_DEFINITION_KEY_MAX),
            observedDigest: DIGEST.nullable(),
          })
          .strict(),
      )
      .min(1)
      .max(100),
    reason: z.string().trim().min(1).max(2000),
  })
  .strict();
export type ApproveMcpDefinitionPins = z.infer<typeof approveMcpDefinitionPinsSchema>;
