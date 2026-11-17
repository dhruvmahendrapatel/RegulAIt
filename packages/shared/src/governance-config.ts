/**
 * ADR-0357: governance configuration as code.
 *
 * One document (`apiVersion: regulait.io/governance/v1`, `kind: GovernanceConfig`) holds an org's roles and their
 * grants, role/team/fleet rate limits, MCP bundles, workflow templates and project budgets, referenced by NAME so
 * the file moves between deployments. This module is the pure half: the strict schema, the normal form that makes a
 * document's revision independent of list order, and the plan (the dry-run diff, with every change classified
 * widens / narrows / neutral by the ADR's table). The gateway reads the live configuration, resolves names and
 * writes; nothing here touches a database.
 *
 * Libraries (ADR-0176): zod for the schema (and `z.toJSONSchema` for the published JSON Schema), rfc6902 through
 * `jsonPatch` for each change's patch, ADR-0060's `canonicalJson` for hashing.
 */
import { z } from "zod";
import { canonicalJson, sha256Hex } from "./audit-chain.js";
import { jsonPatch, type JsonPatchOperation } from "./json-patch.js";

export const GOVERNANCE_CONFIG_API_VERSION = "regulait.io/governance/v1";
export const GOVERNANCE_CONFIG_KIND = "GovernanceConfig";

/** bounds: a document is reviewed by a person, so these are generous for an org and tight for an attacker */
export const GOVERNANCE_CONFIG_LIMITS = {
  /** objects per section */
  sectionItems: 2000,
  /** grants / items inside one object */
  innerItems: 2000,
  name: 200,
  description: 2000,
  /** the serialized document, in bytes, checked by the gateway before parsing */
  documentBytes: 4 * 1024 * 1024,
} as const;

const L = GOVERNANCE_CONFIG_LIMITS;
const name = z.string().min(1).max(L.name);
const list = <T extends z.ZodType>(item: T) => z.array(item).max(L.innerItems);
const uuid = z.string().uuid();

export const governanceRoleSchema = z
  .object({
    name,
    description: z.string().max(L.description).nullable().optional(),
    toolGrants: list(z.object({ server: name, tool: name }).strict()).optional(),
    serverGrants: list(z.object({ server: name, readOnlyAll: z.boolean() }).strict()).optional(),
    /** `allowedModes` null or absent = every mode the agent has (unrestricted) */
    agentGrants: list(z.object({ agent: name, allowedModes: z.array(name).max(50).nullable().optional() }).strict()).optional(),
    /** `allowedObjects` null or absent = every object (unrestricted) */
    connectorGrants: list(
      z
        .object({
          connector: name,
          mode: z.enum(["read", "readwrite"]),
          allowedObjects: z.array(name).max(500).nullable().optional(),
        })
        .strict(),
    ).optional(),
  })
  .strict();

export const governanceRateLimitSchema = z
  .object({
    /** user-scoped limits are per-user overrides and are not organisation configuration (ADR-0357 §1) */
    scope: z.enum(["role", "team", "fleet"]),
    /** the role or team name; absent for fleet */
    subject: name.optional(),
    /** absent = every server (`server_scope = all`) */
    server: name.optional(),
    /** absent = the whole server */
    tool: name.optional(),
    deployMode: z.enum(["hosted", "byoc", "air_gapped"]).optional(),
    maxCalls: z.number().int().positive().max(1_000_000_000),
    windowSeconds: z.number().int().positive().max(366 * 24 * 3600),
    writeOnly: z.boolean().optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.scope === "fleet" ? v.subject !== undefined : v.subject === undefined) {
      ctx.addIssue({ code: "custom", path: ["subject"], message: v.scope === "fleet" ? "a fleet limit has no subject" : `a ${v.scope} limit names its ${v.scope}` });
    }
    if (v.tool !== undefined && v.server === undefined) {
      ctx.addIssue({ code: "custom", path: ["tool"], message: "a tool-level limit names its server" });
    }
  });

export const MCP_BUNDLE_TIERS = ["read", "write", "dangerous"] as const;

export const governanceMcpBundleSchema = z
  .object({
    name,
    description: z.string().max(L.description).nullable().optional(),
    archived: z.boolean().optional(),
    approverUserId: uuid.nullable().optional(),
    items: list(z.object({ server: name, tool: name }).strict()).optional(),
    grants: list(
      z
        .object({ role: name.optional(), team: name.optional(), maxTier: z.enum(MCP_BUNDLE_TIERS).optional() })
        .strict()
        .refine((g) => (g.role === undefined) !== (g.team === undefined), { message: "a bundle grant names exactly one of role or team" }),
    ).optional(),
  })
  .strict();

export const governanceWorkflowTemplateSchema = z
  .object({
    name,
    /** the workflow kernel's definition; validated by the kernel at plan time (the builder publish check) */
    definition: z.record(z.string(), z.unknown()),
    retired: z.boolean().optional(),
    /** computed on export (SHA-256 of the canonical definition); ignored on plan */
    contentHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  })
  .strict();

export const governanceBudgetSchema = z
  .object({
    project: name,
    budgetUsd: z.number().positive().max(1e12),
    period: z.enum(["none", "monthly"]).optional(),
    alertThresholdPct: z.number().int().min(1).max(100).optional(),
    /** who decides an overage. Required for a budget the file creates or changes; null only where the live
     * approver's account was removed (the column is SET NULL), and then no overage can be approved */
    approverUserId: uuid.nullable(),
  })
  .strict();

const section = <T extends z.ZodType>(item: T) => z.array(item).max(L.sectionItems).optional();

export const governanceConfigSpecSchema = z
  .object({
    roles: section(governanceRoleSchema),
    rateLimits: section(governanceRateLimitSchema),
    mcpBundles: section(governanceMcpBundleSchema),
    workflowTemplates: section(governanceWorkflowTemplateSchema),
    budgets: section(governanceBudgetSchema),
  })
  .strict();

export const governanceConfigSchema = z
  .object({
    apiVersion: z.literal(GOVERNANCE_CONFIG_API_VERSION),
    kind: z.literal(GOVERNANCE_CONFIG_KIND),
    metadata: z
      .object({
        revision: z.string().regex(/^[0-9a-f]{64}$/).optional(),
        exportedAt: z.string().max(64).optional(),
      })
      .strict()
      .optional(),
    spec: governanceConfigSpecSchema,
  })
  .strict();

export type GovernanceRole = z.infer<typeof governanceRoleSchema>;
export type GovernanceRateLimit = z.infer<typeof governanceRateLimitSchema>;
export type GovernanceMcpBundle = z.infer<typeof governanceMcpBundleSchema>;
export type GovernanceWorkflowTemplate = z.infer<typeof governanceWorkflowTemplateSchema>;
export type GovernanceBudget = z.infer<typeof governanceBudgetSchema>;
export type GovernanceConfigSpec = z.infer<typeof governanceConfigSpecSchema>;
export type GovernanceConfig = z.infer<typeof governanceConfigSchema>;

export const GOVERNANCE_CONFIG_SECTIONS = ["roles", "rateLimits", "mcpBundles", "workflowTemplates", "budgets"] as const;
export type GovernanceConfigSection = (typeof GOVERNANCE_CONFIG_SECTIONS)[number];

/** the JSON Schema served to editors and CI (`GET /v1/governance-config/schema`) */
export function governanceConfigJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(governanceConfigSchema, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------------------------------------------
// Normal form: defaults filled in, every list sorted by its key, so equal configurations have equal bytes.
// ---------------------------------------------------------------------------------------------------------------

const byKey = <T>(key: (v: T) => string) => (a: T, b: T) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
const sortedSet = (xs: readonly string[] | null | undefined): string[] | null => (xs == null ? null : [...new Set(xs)].sort());

export interface NormalRole {
  name: string;
  description: string | null;
  toolGrants: { server: string; tool: string }[];
  serverGrants: { server: string; readOnlyAll: boolean }[];
  agentGrants: { agent: string; allowedModes: string[] | null }[];
  connectorGrants: { connector: string; mode: "read" | "readwrite"; allowedObjects: string[] | null }[];
}
export interface NormalRateLimit {
  scope: "role" | "team" | "fleet";
  subject: string | null;
  server: string | null;
  tool: string | null;
  deployMode: "hosted" | "byoc" | "air_gapped" | null;
  maxCalls: number;
  windowSeconds: number;
  writeOnly: boolean;
}
export interface NormalMcpBundle {
  name: string;
  description: string | null;
  archived: boolean;
  approverUserId: string | null;
  items: { server: string; tool: string }[];
  grants: { role: string | null; team: string | null; maxTier: (typeof MCP_BUNDLE_TIERS)[number] }[];
}
export interface NormalWorkflowTemplate {
  name: string;
  definition: Record<string, unknown>;
  retired: boolean;
}
export interface NormalBudget {
  project: string;
  budgetUsd: number;
  period: "none" | "monthly";
  alertThresholdPct: number;
  approverUserId: string | null;
}
export interface NormalSpec {
  roles?: NormalRole[];
  rateLimits?: NormalRateLimit[];
  mcpBundles?: NormalMcpBundle[];
  workflowTemplates?: NormalWorkflowTemplate[];
  budgets?: NormalBudget[];
}

/** the identity of a rate limit: everything except its values */
export function rateLimitKey(r: Pick<NormalRateLimit, "scope" | "subject" | "server" | "tool" | "deployMode">): string {
  return [r.scope, r.subject ?? "*", r.server ?? "*", r.tool ?? "*", r.deployMode ?? "*"].join("|");
}
const toolKey = (g: { server: string; tool: string }) => `${g.server}\u0000${g.tool}`;
const grantSubjectKey = (g: { role: string | null; team: string | null }) => (g.role !== null ? `role:${g.role}` : `team:${g.team}`);

export function normalizeRole(r: GovernanceRole): NormalRole {
  return {
    name: r.name,
    description: r.description ?? null,
    toolGrants: dedupe((r.toolGrants ?? []).map((g) => ({ server: g.server, tool: g.tool })), toolKey),
    serverGrants: dedupe((r.serverGrants ?? []).map((g) => ({ server: g.server, readOnlyAll: g.readOnlyAll })), (g) => g.server),
    agentGrants: dedupe((r.agentGrants ?? []).map((g) => ({ agent: g.agent, allowedModes: sortedSet(g.allowedModes) })), (g) => g.agent),
    connectorGrants: dedupe(
      (r.connectorGrants ?? []).map((g) => ({ connector: g.connector, mode: g.mode, allowedObjects: sortedSet(g.allowedObjects) })),
      (g) => g.connector,
    ),
  };
}
export function normalizeRateLimit(r: GovernanceRateLimit): NormalRateLimit {
  return {
    scope: r.scope,
    subject: r.subject ?? null,
    server: r.server ?? null,
    tool: r.tool ?? null,
    deployMode: r.deployMode ?? null,
    maxCalls: r.maxCalls,
    windowSeconds: r.windowSeconds,
    writeOnly: r.writeOnly ?? false,
  };
}
export function normalizeMcpBundle(b: GovernanceMcpBundle): NormalMcpBundle {
  return {
    name: b.name,
    description: b.description ?? null,
    archived: b.archived ?? false,
    approverUserId: b.approverUserId ?? null,
    items: dedupe((b.items ?? []).map((i) => ({ server: i.server, tool: i.tool })), toolKey),
    grants: dedupe(
      (b.grants ?? []).map((g) => ({ role: g.role ?? null, team: g.team ?? null, maxTier: g.maxTier ?? "read" })),
      grantSubjectKey,
    ),
  };
}
export function normalizeWorkflowTemplate(t: GovernanceWorkflowTemplate): NormalWorkflowTemplate {
  return { name: t.name, definition: t.definition, retired: t.retired ?? false };
}
export function normalizeBudget(b: GovernanceBudget): NormalBudget {
  return {
    project: b.project,
    budgetUsd: b.budgetUsd,
    period: b.period ?? "none",
    alertThresholdPct: b.alertThresholdPct ?? 80,
    approverUserId: b.approverUserId,
  };
}

/** a duplicate key keeps the LAST entry (a later line in a file overrides an earlier one) and the list is sorted */
function dedupe<T>(xs: T[], key: (v: T) => string): T[] {
  const m = new Map<string, T>();
  for (const x of xs) m.set(key(x), x);
  return [...m.values()].sort(byKey(key));
}

/** Duplicate top-level keys inside a section are an error, not an override: two roles named "eng" is a mistake. */
export function duplicateKeys(spec: GovernanceConfigSpec): { section: GovernanceConfigSection; key: string }[] {
  const out: { section: GovernanceConfigSection; key: string }[] = [];
  const check = (section: GovernanceConfigSection, keys: string[]) => {
    const seen = new Set<string>();
    for (const k of keys) {
      if (seen.has(k)) out.push({ section, key: k });
      seen.add(k);
    }
  };
  if (spec.roles) check("roles", spec.roles.map((r) => r.name));
  if (spec.rateLimits) check("rateLimits", spec.rateLimits.map((r) => rateLimitKey(normalizeRateLimit(r))));
  if (spec.mcpBundles) check("mcpBundles", spec.mcpBundles.map((b) => b.name));
  if (spec.workflowTemplates) check("workflowTemplates", spec.workflowTemplates.map((t) => t.name));
  if (spec.budgets) check("budgets", spec.budgets.map((b) => b.project));
  return out;
}

export function normalizeSpec(spec: GovernanceConfigSpec): NormalSpec {
  const out: NormalSpec = {};
  if (spec.roles) out.roles = spec.roles.map(normalizeRole).sort(byKey((r) => r.name));
  if (spec.rateLimits) out.rateLimits = spec.rateLimits.map(normalizeRateLimit).sort(byKey((r) => `${rateLimitKey(r)}|${r.maxCalls}|${r.windowSeconds}|${r.writeOnly}`));
  if (spec.mcpBundles) out.mcpBundles = spec.mcpBundles.map(normalizeMcpBundle).sort(byKey((b) => b.name));
  if (spec.workflowTemplates) out.workflowTemplates = spec.workflowTemplates.map(normalizeWorkflowTemplate).sort(byKey((t) => t.name));
  if (spec.budgets) out.budgets = spec.budgets.map(normalizeBudget).sort(byKey((b) => b.project));
  return out;
}

/** SHA-256 of the canonical normal form: equal configurations have equal revisions whatever their order or format */
export function specRevision(spec: NormalSpec): string {
  return sha256Hex(canonicalJson(spec));
}

/** the live configuration as the exported document (YAML or JSON is the gateway's choice of bytes) */
export function toGovernanceDocument(spec: NormalSpec, exportedAt: string): GovernanceConfig {
  const out: GovernanceConfigSpec = {};
  // drop the normal form's nulls and defaults so the file a person reads holds only what was set
  if (spec.roles)
    out.roles = spec.roles.map((r) => ({
      name: r.name,
      ...(r.description !== null ? { description: r.description } : {}),
      ...(r.toolGrants.length ? { toolGrants: r.toolGrants } : {}),
      ...(r.serverGrants.length ? { serverGrants: r.serverGrants } : {}),
      ...(r.agentGrants.length ? { agentGrants: r.agentGrants.map((g) => ({ agent: g.agent, ...(g.allowedModes !== null ? { allowedModes: g.allowedModes } : {}) })) } : {}),
      ...(r.connectorGrants.length
        ? { connectorGrants: r.connectorGrants.map((g) => ({ connector: g.connector, mode: g.mode, ...(g.allowedObjects !== null ? { allowedObjects: g.allowedObjects } : {}) })) }
        : {}),
    }));
  if (spec.rateLimits)
    out.rateLimits = spec.rateLimits.map((r) => ({
      scope: r.scope,
      ...(r.subject !== null ? { subject: r.subject } : {}),
      ...(r.server !== null ? { server: r.server } : {}),
      ...(r.tool !== null ? { tool: r.tool } : {}),
      ...(r.deployMode !== null ? { deployMode: r.deployMode } : {}),
      maxCalls: r.maxCalls,
      windowSeconds: r.windowSeconds,
      ...(r.writeOnly ? { writeOnly: true } : {}),
    }));
  if (spec.mcpBundles)
    out.mcpBundles = spec.mcpBundles.map((b) => ({
      name: b.name,
      ...(b.description !== null ? { description: b.description } : {}),
      ...(b.archived ? { archived: true } : {}),
      ...(b.approverUserId !== null ? { approverUserId: b.approverUserId } : {}),
      ...(b.items.length ? { items: b.items } : {}),
      ...(b.grants.length ? { grants: b.grants.map((g) => ({ ...(g.role !== null ? { role: g.role } : { team: g.team! }), maxTier: g.maxTier })) } : {}),
    }));
  if (spec.workflowTemplates)
    out.workflowTemplates = spec.workflowTemplates.map((t) => ({
      name: t.name,
      definition: t.definition,
      ...(t.retired ? { retired: true } : {}),
      contentHash: sha256Hex(canonicalJson(t.definition)),
    }));
  if (spec.budgets) out.budgets = spec.budgets.map((b) => ({ ...b }));
  return {
    apiVersion: GOVERNANCE_CONFIG_API_VERSION,
    kind: GOVERNANCE_CONFIG_KIND,
    metadata: { revision: specRevision(spec), exportedAt },
    spec: out,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The plan: every change, classified by ADR-0357 §3.
// ---------------------------------------------------------------------------------------------------------------

export type ChangeEffect = "widens" | "narrows" | "neutral";
export interface ChangeFinding {
  effect: ChangeEffect;
  /** a short, stable, machine-readable code (agents read plans too) */
  code: string;
  /** what exactly, in plain words */
  detail: string;
}
export interface GovernanceChange {
  section: GovernanceConfigSection;
  /** the object's natural key inside its section */
  key: string;
  op: "create" | "update" | "delete";
  /** widens if any finding widens, else narrows if any narrows, else neutral */
  effect: ChangeEffect;
  findings: ChangeFinding[];
  before: unknown;
  after: unknown;
  patch: JsonPatchOperation[];
}

const W = (code: string, detail: string): ChangeFinding => ({ effect: "widens", code, detail });
const N = (code: string, detail: string): ChangeFinding => ({ effect: "narrows", code, detail });
const O = (code: string, detail: string): ChangeFinding => ({ effect: "neutral", code, detail });

function overall(findings: readonly ChangeFinding[]): ChangeEffect {
  if (findings.some((f) => f.effect === "widens")) return "widens";
  if (findings.some((f) => f.effect === "narrows")) return "narrows";
  return "neutral";
}

/** a restriction list: null = unrestricted. Moving to a superset (or to null) widens; to a subset narrows. */
function compareRestriction(before: string[] | null, after: string[] | null, label: string, out: ChangeFinding[]) {
  if (JSON.stringify(before) === JSON.stringify(after)) return;
  if (after === null) return void out.push(W(`${label}_unrestricted`, `${label} set to unrestricted`));
  if (before === null) return void out.push(N(`${label}_restricted`, `${label} restricted to ${after.join(", ") || "nothing"}`));
  const gained = after.filter((x) => !before.includes(x));
  const lost = before.filter((x) => !after.includes(x));
  if (gained.length) out.push(W(`${label}_gained`, `${label} gained ${gained.join(", ")}`));
  if (lost.length) out.push(N(`${label}_lost`, `${label} lost ${lost.join(", ")}`));
}

/** diff two keyed lists; `onBoth` classifies an object present on both sides */
function keyedDiff<T>(
  before: readonly T[],
  after: readonly T[],
  key: (v: T) => string,
  added: (v: T) => ChangeFinding[],
  removed: (v: T) => ChangeFinding[],
  onBoth: (a: T, b: T) => ChangeFinding[],
): ChangeFinding[] {
  const out: ChangeFinding[] = [];
  const bm = new Map(before.map((v) => [key(v), v]));
  const am = new Map(after.map((v) => [key(v), v]));
  for (const [k, v] of am) {
    const b = bm.get(k);
    out.push(...(b === undefined ? added(v) : onBoth(b, v)));
  }
  for (const [k, v] of bm) if (!am.has(k)) out.push(...removed(v));
  return out;
}

function roleFindings(before: NormalRole | null, after: NormalRole | null): ChangeFinding[] {
  const empty: NormalRole = { name: "", description: null, toolGrants: [], serverGrants: [], agentGrants: [], connectorGrants: [] };
  const b = before ?? empty;
  const a = after ?? empty;
  const out: ChangeFinding[] = [];
  if (after === null) out.push(N("role_removed", `role ${before!.name} removed (its holders lose its grants)`));
  if (before !== null && after !== null && b.description !== a.description) out.push(O("description_changed", "description changed"));
  out.push(
    ...keyedDiff(
      b.toolGrants,
      a.toolGrants,
      toolKey,
      (g) => [W("tool_grant_added", `tool ${g.server}/${g.tool} granted`)],
      (g) => [N("tool_grant_removed", `tool ${g.server}/${g.tool} no longer granted`)],
      () => [],
    ),
    ...keyedDiff(
      b.serverGrants,
      a.serverGrants,
      (g) => g.server,
      (g) => [W("server_grant_added", `server ${g.server} granted${g.readOnlyAll ? " (read-only tools)" : ""}`)],
      (g) => [N("server_grant_removed", `server ${g.server} no longer granted`)],
      // `readOnlyAll: true` grants every read-kind tool on the server; false confers nothing (the API refuses it as
      // an inert grant), so gaining it widens and losing it narrows
      (x, y) =>
        x.readOnlyAll === y.readOnlyAll
          ? []
          : [y.readOnlyAll ? W("server_grant_widened", `server ${y.server}: now grants every read tool`) : N("server_grant_narrowed", `server ${y.server}: no longer grants its read tools`)],
    ),
    ...keyedDiff(
      b.agentGrants,
      a.agentGrants,
      (g) => g.agent,
      (g) => [W("agent_grant_added", `agent ${g.agent} granted`)],
      (g) => [N("agent_grant_removed", `agent ${g.agent} no longer granted`)],
      (x, y) => {
        const f: ChangeFinding[] = [];
        compareRestriction(x.allowedModes, y.allowedModes, `agent_${y.agent}_modes`, f);
        return f;
      },
    ),
    ...keyedDiff(
      b.connectorGrants,
      a.connectorGrants,
      (g) => g.connector,
      (g) => [W("connector_grant_added", `connector ${g.connector} granted (${g.mode})`)],
      (g) => [N("connector_grant_removed", `connector ${g.connector} no longer granted`)],
      (x, y) => {
        const f: ChangeFinding[] = [];
        if (x.mode !== y.mode)
          f.push(y.mode === "readwrite" ? W("connector_mode_widened", `connector ${y.connector}: read → readwrite`) : N("connector_mode_narrowed", `connector ${y.connector}: readwrite → read`));
        compareRestriction(x.allowedObjects, y.allowedObjects, `connector_${y.connector}_objects`, f);
        return f;
      },
    ),
  );
  if (before === null && out.length === 0) out.push(O("role_created", `role ${after!.name} created with no grants`));
  return out;
}

function rateLimitFindings(before: NormalRateLimit | null, after: NormalRateLimit | null): ChangeFinding[] {
  if (after === null) return [W("rate_limit_removed", `limit ${before!.maxCalls}/${before!.windowSeconds}s removed`)];
  if (before === null) return [N("rate_limit_added", `limit ${after.maxCalls}/${after.windowSeconds}s added`)];
  const out: ChangeFinding[] = [];
  if (after.maxCalls > before.maxCalls) out.push(W("max_calls_raised", `maxCalls ${before.maxCalls} → ${after.maxCalls}`));
  if (after.maxCalls < before.maxCalls) out.push(N("max_calls_lowered", `maxCalls ${before.maxCalls} → ${after.maxCalls}`));
  if (after.windowSeconds < before.windowSeconds) out.push(W("window_shortened", `window ${before.windowSeconds}s → ${after.windowSeconds}s`));
  if (after.windowSeconds > before.windowSeconds) out.push(N("window_lengthened", `window ${before.windowSeconds}s → ${after.windowSeconds}s`));
  if (after.writeOnly !== before.writeOnly)
    out.push(after.writeOnly ? W("write_only_set", "now counts write tools only") : N("write_only_cleared", "now counts every call"));
  return out;
}

const TIER_RANK: Record<(typeof MCP_BUNDLE_TIERS)[number], number> = { read: 0, write: 1, dangerous: 2 };

function bundleFindings(before: NormalMcpBundle | null, after: NormalMcpBundle | null): ChangeFinding[] {
  const empty: NormalMcpBundle = { name: "", description: null, archived: true, approverUserId: null, items: [], grants: [] };
  const b = before ?? empty;
  const a = after ?? { ...empty, archived: true };
  const out: ChangeFinding[] = [];
  if (after === null) out.push(N("bundle_archived", `bundle ${before!.name} archived (missing from the file)`));
  else if (before !== null && b.archived !== a.archived)
    out.push(a.archived ? N("bundle_archived", "bundle archived") : W("bundle_unarchived", "bundle un-archived"));
  if (before !== null && after !== null && b.description !== a.description) out.push(O("description_changed", "description changed"));
  if (after !== null && b.approverUserId !== a.approverUserId)
    out.push(
      a.approverUserId === null
        ? N("approver_cleared", "no approver: dangerous calls through the bundle are refused")
        : W("approver_changed", "the dangerous-call approver changed"),
    );
  if (after !== null) {
    out.push(
      ...keyedDiff(
        b.items,
        a.items,
        toolKey,
        (i) => [W("bundle_item_added", `tool ${i.server}/${i.tool} added`)],
        (i) => [N("bundle_item_removed", `tool ${i.server}/${i.tool} removed`)],
        () => [],
      ),
      ...keyedDiff(
        b.grants,
        a.grants,
        grantSubjectKey,
        (g) => [W("bundle_grant_added", `granted to ${grantSubjectKey(g)} up to ${g.maxTier}`)],
        (g) => [N("bundle_grant_removed", `no longer granted to ${grantSubjectKey(g)}`)],
        (x, y) =>
          TIER_RANK[y.maxTier] > TIER_RANK[x.maxTier]
            ? [W("bundle_tier_raised", `${grantSubjectKey(y)}: ${x.maxTier} → ${y.maxTier}`)]
            : TIER_RANK[y.maxTier] < TIER_RANK[x.maxTier]
              ? [N("bundle_tier_lowered", `${grantSubjectKey(y)}: ${x.maxTier} → ${y.maxTier}`)]
              : [],
      ),
    );
  }
  if (before === null && out.every((f) => f.effect !== "widens")) out.push(O("bundle_created", `bundle ${a.name} created`));
  return out;
}

function templateFindings(before: NormalWorkflowTemplate | null, after: NormalWorkflowTemplate | null): ChangeFinding[] {
  if (after === null) return before!.retired ? [] : [N("template_retired", `template ${before!.name} retired (missing from the file)`)];
  if (before === null) return [W("template_created", "a new template (a definition cannot be proven stricter)")];
  const out: ChangeFinding[] = [];
  if (canonicalJson(before.definition) !== canonicalJson(after.definition))
    out.push(W("definition_changed", "definition changed (a definition change cannot be proven stricter)"));
  if (before.retired !== after.retired) out.push(after.retired ? N("template_retired", "template retired") : W("template_unretired", "template un-retired"));
  return out;
}

function budgetFindings(before: NormalBudget | null, after: NormalBudget | null): ChangeFinding[] {
  if (after === null) return [W("budget_removed", `budget ${before!.budgetUsd} removed`)];
  if (before === null) return [N("budget_added", `budget ${after.budgetUsd} set`)];
  const out: ChangeFinding[] = [];
  if (after.budgetUsd > before.budgetUsd) out.push(W("budget_raised", `budget ${before.budgetUsd} → ${after.budgetUsd}`));
  if (after.budgetUsd < before.budgetUsd) out.push(N("budget_lowered", `budget ${before.budgetUsd} → ${after.budgetUsd}`));
  if (after.alertThresholdPct > before.alertThresholdPct) out.push(W("alert_threshold_raised", `alert at ${before.alertThresholdPct}% → ${after.alertThresholdPct}%`));
  if (after.alertThresholdPct < before.alertThresholdPct) out.push(N("alert_threshold_lowered", `alert at ${before.alertThresholdPct}% → ${after.alertThresholdPct}%`));
  if (after.period !== before.period)
    // a monthly cap resets every month, so over time it allows more spend than the same lifetime cap
    out.push(after.period === "monthly" ? W("period_monthly", "lifetime → monthly (the cap now resets each month)") : N("period_lifetime", "monthly → lifetime"));
  if (after.approverUserId !== before.approverUserId)
    out.push(after.approverUserId === null ? N("approver_cleared", "no overage approver: an overage cannot be approved") : W("approver_changed", "the overage approver changed"));
  return out;
}

function sectionChanges<T>(
  section: GovernanceConfigSection,
  before: readonly T[],
  after: readonly T[],
  key: (v: T) => string,
  classify: (b: T | null, a: T | null) => ChangeFinding[],
): GovernanceChange[] {
  const out: GovernanceChange[] = [];
  const bm = new Map<string, T[]>();
  for (const v of before) bm.set(key(v), [...(bm.get(key(v)) ?? []), v]);
  const am = new Map(after.map((v) => [key(v), v]));
  const keys = [...new Set([...bm.keys(), ...am.keys()])].sort();
  for (const k of keys) {
    const [b = null, ...extra] = bm.get(k) ?? [];
    const a = am.get(k) ?? null;
    // live duplicates (possible for rate limits, which have no unique key): the first pairs, the rest are deleted
    for (const x of extra) push(k, x, null);
    push(k, b, a);
  }
  return out;

  function push(k: string, b: T | null, a: T | null) {
    if (b !== null && a !== null && canonicalJson(b) === canonicalJson(a)) return;
    const findings = classify(b, a);
    out.push({
      section,
      key: k,
      op: b === null ? "create" : a === null ? "delete" : "update",
      effect: overall(findings),
      findings,
      before: b,
      after: a,
      patch: jsonPatch(b, a),
    });
  }
}

export interface GovernancePlan {
  apiVersion: typeof GOVERNANCE_CONFIG_API_VERSION;
  /** the revision of the live configuration the plan was computed against */
  liveRevision: string;
  /** the revision of the desired configuration (sections present in the file only) */
  desiredRevision: string;
  /** binds apply to exactly this plan: sha256 of {liveRevision, desiredRevision} */
  planHash: string;
  sections: GovernanceConfigSection[];
  changes: GovernanceChange[];
  summary: { create: number; update: number; delete: number; widens: number; narrows: number; neutral: number };
}

/**
 * The dry run. `live` is the full live configuration in normal form; `desired` holds only the sections the file
 * names (a section absent from the file is not touched, ADR-0357 §2). Pure and deterministic.
 */
export function planGovernanceConfig(live: Required<NormalSpec>, desired: NormalSpec): GovernancePlan {
  const sections = GOVERNANCE_CONFIG_SECTIONS.filter((s) => desired[s] !== undefined);
  const changes: GovernanceChange[] = [];
  if (desired.roles) changes.push(...sectionChanges("roles", live.roles, desired.roles, (r) => r.name, roleFindings));
  if (desired.rateLimits) changes.push(...sectionChanges("rateLimits", live.rateLimits, desired.rateLimits, rateLimitKey, rateLimitFindings));
  if (desired.mcpBundles) {
    // an archived bundle missing from the file is already in the state "missing" means
    const liveBundles = live.mcpBundles.filter((b) => !b.archived || desired.mcpBundles!.some((d) => d.name === b.name));
    changes.push(...sectionChanges("mcpBundles", liveBundles, desired.mcpBundles, (b) => b.name, bundleFindings));
  }
  if (desired.workflowTemplates) changes.push(...sectionChanges("workflowTemplates", live.workflowTemplates, desired.workflowTemplates, (t) => t.name, templateFindings));
  if (desired.budgets) changes.push(...sectionChanges("budgets", live.budgets, desired.budgets, (b) => b.project, budgetFindings));
  const liveRevision = specRevision(live);
  const desiredRevision = specRevision(desired);
  const count = (f: (c: GovernanceChange) => boolean) => changes.filter(f).length;
  return {
    apiVersion: GOVERNANCE_CONFIG_API_VERSION,
    liveRevision,
    desiredRevision,
    planHash: sha256Hex(canonicalJson({ liveRevision, desiredRevision })),
    sections,
    changes,
    summary: {
      create: count((c) => c.op === "create"),
      update: count((c) => c.op === "update"),
      delete: count((c) => c.op === "delete"),
      widens: count((c) => c.effect === "widens"),
      narrows: count((c) => c.effect === "narrows"),
      neutral: count((c) => c.effect === "neutral"),
    },
  };
}

/** what a widening apply's `settings_relax` step-up is bound to: each widening change and its findings' codes */
export function planWidenings(plan: GovernancePlan): { section: GovernanceConfigSection; key: string; codes: string[] }[] {
  return plan.changes
    .filter((c) => c.effect === "widens")
    .map((c) => ({ section: c.section, key: c.key, codes: c.findings.filter((f) => f.effect === "widens").map((f) => f.code) }));
}
