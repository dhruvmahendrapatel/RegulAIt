/**
 * ADR-0185 (batch 3) — the shared contract: memory retention, MCP protocol
 * methods and upstream transports, owners, the Outlook recipient allow-list.
 *
 * Four slices build on this file in their own modules (I3 + I9 + Outlook, G3,
 * G4, G5). It holds only what they share: the vocabularies (kept in lockstep
 * with the DB CHECKs of migration 0169, because `schema.ts` imports these very
 * constants), the org settings with their strict defaults and what relaxing
 * each one gives up, and the request-body pieces. It decides nothing at
 * request time.
 *
 * SECURE BY DEFAULT (ADR-0180 §1). Every setting below starts at its strict
 * value, migration 0169 wrote it onto the existing org row as for a first
 * load, and an admin relaxes one only through the audited
 * `PUT /v1/org/settings` (`detail.transitions`, and `detail.relaxed` naming
 * every key left looser than its strict default).
 *
 * Does not import the package barrel (index.ts re-exports this file).
 */
import { z } from "zod";
import { canonicalJson } from "./audit-chain.js";

// ---------------------------------------------------------------------------
// Vocabularies
// ---------------------------------------------------------------------------

/** G3: the non-tool MCP methods the proxy can govern. `mcp_protocol_methods`
 * names the ones an org has enabled; empty (the strict default) refuses all. */
export const MCP_PROTOCOL_METHODS = [
  "resources/list",
  "resources/templates/list",
  "resources/read",
  "prompts/list",
  "prompts/get",
  "completion/complete",
  "logging/setLevel",
] as const;
export type McpProtocolMethod = (typeof MCP_PROTOCOL_METHODS)[number];

/** G3: the methods refused ALWAYS, whatever the org enables
 * (`mcp-method-unsupported`). Prefix entries end in `/`. */
export const MCP_PROTOCOL_REFUSED_METHODS = [
  "resources/subscribe",
  "resources/unsubscribe",
  "sampling/",
  "elicitation/",
  "roots/",
] as const;

/** G3: the per-user grant names (existing `POST /v1/grants/tools` with
 * `toolName` set to one of these). A read-only server grant does NOT include
 * them: `readOnlyAll` never covers `surface: "protocol"`. */
export const MCP_PROTOCOL_GRANT_NAMES = ["mcp:resources", "mcp:prompts", "mcp:completion", "mcp:logging"] as const;
export type McpProtocolGrantName = (typeof MCP_PROTOCOL_GRANT_NAMES)[number];

/** G3: which grant a method is decided against, and its read/write kind */
export const MCP_PROTOCOL_METHOD_GRANTS: Readonly<
  Record<McpProtocolMethod, { grant: McpProtocolGrantName; kind: "read" | "write" }>
> = Object.freeze({
  "resources/list": { grant: "mcp:resources", kind: "read" },
  "resources/templates/list": { grant: "mcp:resources", kind: "read" },
  "resources/read": { grant: "mcp:resources", kind: "read" },
  "prompts/list": { grant: "mcp:prompts", kind: "read" },
  "prompts/get": { grant: "mcp:prompts", kind: "read" },
  "completion/complete": { grant: "mcp:completion", kind: "read" },
  "logging/setLevel": { grant: "mcp:logging", kind: "write" },
});

/** G4: how the gateway reaches an MCP upstream (`mcp_servers.transport`) */
export const MCP_UPSTREAM_TRANSPORTS = ["streamable_http", "sse", "stdio"] as const;
export type McpUpstreamTransport = (typeof MCP_UPSTREAM_TRANSPORTS)[number];

/** G4: the `url` a stdio row carries (`mcp_servers_transport_shape`). It is not
 * a reachable destination, so any path that forgets to branch on transport
 * fails the egress check (fails closed). */
export const MCP_STDIO_URL_PREFIX = "stdio:";
export const mcpStdioSentinelUrl = (serverName: string): string => `${MCP_STDIO_URL_PREFIX}${serverName}`;

/** G4: the argv bounds (≤ 64 arguments × 4 KiB, no NUL). The route refuses
 * past them with 400 `mcp_stdio_command_refused` / `invalid_argv`. */
export const MCP_STDIO_LIMITS = Object.freeze({ maxArgs: 64, maxArgBytes: 4096, maxCommandBytes: 4096 });

/** I9: an owned row's state, as `GET /v1/servers` / `GET /v1/connectors` report it */
export const OWNERSHIP_STATES = ["owned", "unowned", "orphaned"] as const;
export type OwnershipState = (typeof OWNERSHIP_STATES)[number];

/** Outlook: at most this many extra recipients per connection */
export const OUTLOOK_RECIPIENT_ALLOW_LIST_MAX = 50;

// ---------------------------------------------------------------------------
// Org settings: the strict defaults, the bounds, what relaxing gives up
// ---------------------------------------------------------------------------

/** the bounds (zod and the DB CHECKs of migration 0169 hold the same numbers) */
export const BATCH3_SETTING_LIMITS = {
  semanticCacheTtlSeconds: { min: 1, max: 2_592_000 },
  conversationRetentionDays: { min: 1, max: 2555 },
} as const;

/** THE STRICT DEFAULTS. The column defaults of migration 0169 (and the 3600 s
 * cache TTL that predates it) are these values; a fresh org reads exactly this. */
export const BATCH3_STRICT_DEFAULTS = Object.freeze({
  semanticCacheTtlSeconds: 3600,
  conversationRetentionDays: 30,
  mcpProtocolMethods: [] as McpProtocolMethod[],
  mcpUpstreamTransports: ["streamable_http"] as McpUpstreamTransport[],
});
export type Batch3Settings = {
  -readonly [K in keyof typeof BATCH3_STRICT_DEFAULTS]: (typeof BATCH3_STRICT_DEFAULTS)[K];
};
export type Batch3SettingKey = keyof Batch3Settings;
export const BATCH3_SETTING_KEYS = Object.keys(BATCH3_STRICT_DEFAULTS) as Batch3SettingKey[];

/** What the strict default does, and what an admin gives up by relaxing it. */
export const BATCH3_SETTING_COPY: Readonly<Record<Batch3SettingKey, { label: string; strict: string; relaxed: string }>> = {
  semanticCacheTtlSeconds: {
    label: "Semantic cache lifetime (seconds)",
    strict: "3600 seconds: a cached answer is served for an hour and then deleted, unless an open incident holds it.",
    relaxed: "A longer lifetime (up to 30 days) keeps prompts and answers stored, and served again, for longer.",
  },
  conversationRetentionDays: {
    label: "Conversation retention (days)",
    strict:
      "30 days after the last message a conversation is deleted, unless an incident that is not closed holds it.",
    relaxed: "A longer retention (up to 2555 days) keeps what people asked and what agents answered for longer.",
  },
  mcpProtocolMethods: {
    label: "MCP methods beyond tools",
    strict: "None: the gateway relays tool listing and tool calls only; every other MCP method is refused.",
    relaxed:
      "Each enabled method (resources, prompts, completion, logging) is relayed to users who hold its grant, " +
      "after the same per-user decision and content scans as a tool call.",
  },
  mcpUpstreamTransports: {
    label: "MCP upstream transports",
    strict: "Streamable HTTP only, through the egress guard.",
    relaxed:
      "SSE reaches servers over the older event-stream transport (same egress guard); stdio lets the gateway start " +
      "a local command, and also needs the host to name the directories such commands may live in.",
  },
};

const sameJson = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);

/**
 * Is `value` a RELAXATION of the strict default for `key`? Longer lifetimes,
 * any enabled protocol method, and any transport beyond Streamable HTTP are
 * relaxations; a shorter lifetime or dropping a transport is stricter.
 */
export function batch3SettingRelaxed<K extends Batch3SettingKey>(key: K, value: Batch3Settings[K]): boolean {
  switch (key) {
    case "semanticCacheTtlSeconds":
    case "conversationRetentionDays":
      return (value as number) > (BATCH3_STRICT_DEFAULTS[key] as number);
    case "mcpProtocolMethods":
      return (value as McpProtocolMethod[]).length > 0;
    case "mcpUpstreamTransports": {
      const strict = BATCH3_STRICT_DEFAULTS.mcpUpstreamTransports as readonly string[];
      return (value as McpUpstreamTransport[]).some((t) => !strict.includes(t));
    }
    default:
      return !sameJson(value, BATCH3_STRICT_DEFAULTS[key]);
  }
}

/** which of the changed keys are batch-3 settings now looser than their strict default */
export function relaxedBatch3Keys(changed: Record<string, unknown>): Batch3SettingKey[] {
  return BATCH3_SETTING_KEYS.filter((k) => k in changed && batch3SettingRelaxed(k, changed[k] as never));
}

const boundedInt = (b: { min: number; max: number }) => z.number().int().min(b.min).max(b.max);
const uniqueSubset = <T extends readonly [string, ...string[]]>(values: T) =>
  z
    .array(z.enum(values))
    .max(values.length)
    .refine((a) => new Set(a).size === a.length, "each value at most once")
    // stored in vocabulary order, so the same set always reads (and audits) the same
    .transform((a) => values.filter((v) => a.includes(v)) as T[number][]);

/**
 * The batch-3 fields of `PUT /v1/org/settings` (spread into
 * `updateOrgSettingsSchema`). Every one is optional (a partial update); out of
 * range or unknown values are a 400.
 */
export const batch3OrgSettingsFields = {
  /** strict 3600; longer, up to 30 days, relaxes it */
  semanticCacheTtlSeconds: boundedInt(BATCH3_SETTING_LIMITS.semanticCacheTtlSeconds).optional(),
  /** strict 30; longer, up to 2555, relaxes it */
  conversationRetentionDays: boundedInt(BATCH3_SETTING_LIMITS.conversationRetentionDays).optional(),
  /** strict []; any method relaxes it */
  mcpProtocolMethods: uniqueSubset(MCP_PROTOCOL_METHODS).optional(),
  /** strict ["streamable_http"]; sse or stdio relaxes it */
  mcpUpstreamTransports: uniqueSubset(MCP_UPSTREAM_TRANSPORTS).optional(),
} as const;

// ---------------------------------------------------------------------------
// Request-body pieces
// ---------------------------------------------------------------------------

/** G4: a stdio upstream — an absolute command and a fixed argv, never a shell
 * line. Structural only: the route applies the host rules (absolute, inside
 * an allowed directory, not world-writable, argv bounds) and answers 400
 * `mcp_stdio_command_refused` with a `code`. */
export const mcpStdioSpecSchema = z
  .object({
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
  })
  .strict();
export type McpStdioSpec = z.infer<typeof mcpStdioSpecSchema>;

/** I9: `PUT /v1/servers/:serverId/owner` and `PUT /v1/connectors/:connectorId/owner` */
export const setOwnerSchema = z.object({ ownerUserId: z.string().uuid().nullable() }).strict();
export type SetOwnerInput = z.infer<typeof setOwnerSchema>;

/** Outlook: the PATCH field. Structural only, so the route can answer with the
 * contract's codes (`invalid_recipient`, `allow_list_too_long`, `outlook_only`)
 * through `outlookRecipientAllowListProblem`. */
export const outlookRecipientAllowListField = z.array(z.string());

const mailbox = z.string().email().max(200);

/**
 * Outlook: check and normalise an allow-list for a connection of `provider`.
 * Exact mailboxes only (no `@domain` entries), lower-cased, trimmed,
 * de-duplicated, at most 50. Returns the stored form or the refusal.
 */
export function outlookRecipientAllowListProblem(
  provider: string,
  list: readonly string[],
):
  | { ok: true; value: string[] }
  | { ok: false; error: "outlook_only" | "allow_list_too_long" | "invalid_recipient"; detail: string; invalid?: string[] } {
  if (provider !== "outlook" && list.length > 0) {
    return { ok: false, error: "outlook_only", detail: "a recipient allow-list applies to an outlook connection only" };
  }
  const value = [...new Set(list.map((m) => m.trim().toLowerCase()))];
  if (value.length > OUTLOOK_RECIPIENT_ALLOW_LIST_MAX) {
    return {
      ok: false,
      error: "allow_list_too_long",
      detail: `at most ${OUTLOOK_RECIPIENT_ALLOW_LIST_MAX} recipients; nothing was saved`,
    };
  }
  const invalid = value.filter((m) => !mailbox.safeParse(m).success);
  if (invalid.length > 0) {
    return {
      ok: false,
      error: "invalid_recipient",
      detail: "each entry must be one exact mailbox address (no domains, no display names); nothing was saved",
      invalid,
    };
  }
  return { ok: true, value };
}
