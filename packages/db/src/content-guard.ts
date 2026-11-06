/**
 * ADR-0233 (PENDING S6) — the CONTENT-CREDENTIAL GUARD for name/title/description/summary/body columns.
 *
 * ADR-0102 scrubs credential shapes out of operator PROSE (reason, note, rationale) at the `createDb` handle,
 * and it deliberately stopped at CONTENT: a description is something a person may need byte for byte, so a
 * silent redaction would damage the record to protect it. Those columns therefore stored a pasted secret
 * exactly as typed.
 *
 * This file decides the other way round for content: it does not rewrite the text, it REFUSES the write.
 *
 *  - Detection is ADR-0099's `scrubAuditText`, the same function (ADR-0042's credential rules plus the
 *    vendored open-source pipelock secret pack, ADR-0186 V). A content value "carries a credential" exactly
 *    when that function would change it. There is no second detector; a test pins the reference.
 *  - A hit throws `ContentCredentialError`, which names the table, the column, the API field and the rule
 *    labels. It never carries the value. The gateway maps it to `422 credential_in_content`.
 *  - The org may relax the guard (`org_settings.content_credential_guard = false`, a `settings_relax`
 *    step-up through the strictness registry, audited as a relaxation). The setting is read only when the
 *    detector has already matched, so the common path costs one regex pass per registered column and no
 *    query. A missing settings row reads as the strict default.
 *
 * WHERE IT SITS. A third composed wrapper in `createDb`, OUTSIDE `withProseScrub` and `withAuditChain`, over
 * the same three write shapes ADR-0102 intercepts (`insert().values()`, `insert().values().onConflictDoUpdate
 * ({ set })`, `update().set()`), with `transaction()` re-wrapped. A refusal inside a transaction throws before
 * the statement runs, so the caller's transaction rolls back whole. Imports are covered because they write
 * through the same handle.
 *
 * WHAT IT DOES NOT DO (ADR-0233, honest limits): rewrite or report-and-continue; touch jsonb columns; cover a
 * raw `pg` client or `psql`; catch a shapeless secret. Existing rows are reported (`contentCredentialReport`),
 * never rewritten.
 */
import { getTableName } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { addedAuditScrubRules, scrubAuditText } from "@regulait/shared";
import * as s from "./schema.js";

const GUARDED = Symbol.for("regulait.content-guard.wrapped");

/** The detector, by REFERENCE: a content value carries a credential exactly when this changes it. */
export const CONTENT_GUARD_DETECTOR: (text: string) => string = scrubAuditText;

/** The column-name shape S6 names. A test asks Postgres for every text column matching it. */
export const CONTENT_COLUMN_PATTERN = /^(?:[a-z0-9_]+_)?(?:name|title|description|summary|body)$/;

/**
 * THE REGISTRY — operator-typed content. Every entry is a column a person fills in through a form, an API
 * call or an import, where refusing a credential costs the writer one retry and loses nothing.
 * Grouped by family; the families are what the ADR's tests are organised by.
 */
const REGISTRY: ReadonlyArray<readonly [object, readonly string[]]> = [
  // --- templates and packs ---
  [s.workflowTemplates, ["name"]],
  [s.compliancePacks, ["title", "description"]],
  [s.compliancePackControls, ["title", "description"]],
  [s.reportDefinitions, ["name", "description"]],
  [s.prompts, ["name", "description"]],
  [s.supplierQuestionnaires, ["name", "description"]],
  [s.supplierSubmissions, ["fileName"]],
  [s.executionProfiles, ["name", "body"]],
  // --- agents and builder ---
  [s.agents, ["name"]],
  [s.a2aAgents, ["name"]],
  [s.a2aAgentCredentials, ["headerName"]],
  [s.builderAgents, ["name", "description"]],
  [s.builderAgentSubagents, ["name", "description"]],
  [s.builderAgentSchedules, ["name"]],
  [s.builderSkills, ["name", "description", "body"]],
  [s.orchestrationRuns, ["name"]],
  // --- projects, initiatives and the AI inventory ---
  [s.projects, ["name"]],
  [s.initiatives, ["name"]],
  [s.teams, ["name"]],
  [s.aiUseCases, ["name", "description"]],
  [s.aiVendors, ["name", "description"]],
  [s.aiRisks, ["title", "description"]],
  [s.kris, ["name", "scoreName"]],
  [s.processingRecords, ["name"]],
  [s.trustPublications, ["title"]],
  [s.trustCenterProfile, ["displayName"]],
  // --- access control and identity configuration ---
  [s.roles, ["name", "description"]],
  [s.abacPolicies, ["name", "description"]],
  [s.approvalAssignmentRules, ["name"]],
  [s.approvalSavedViews, ["name"]],
  [s.approvalSlaPolicies, ["name"]],
  [s.sodRules, ["name"]],
  [s.apiKeys, ["name"]],
  [s.virtualKeys, ["name"]],
  [s.scimTokens, ["name"]],
  [s.auditorGrants, ["auditorName"]],
  [s.oidcProviders, ["name"]],
  [s.modelSigningKeys, ["name"]],
  [s.samlProviders, ["name"]],
  [s.grantCertificationCampaigns, ["name"]],
  // --- connections, servers and integrations ---
  [s.mcpServers, ["name"]],
  [s.mcpServerUpstreamCredentials, ["headerName"]],
  [s.mcpRegistries, ["name"]],
  [s.connectors, ["name"]],
  [s.customModelProviders, ["name"]],
  [s.gitConnections, ["name"]],
  [s.pmConnections, ["name"]],
  [s.chatopsConnections, ["name"]],
  [s.webhookSubscriptions, ["name"]],
  [s.deployTargets, ["name"]],
  [s.discoverySources, ["name"]],
  [s.engineRunners, ["name"]],
  [s.executors, ["name"]],
  [s.externalScorers, ["name"]],
  [s.orgSettings, ["tracingOtlpServiceName"]],
  // --- evaluation, monitoring, spend ---
  [s.evalDatasets, ["name"]],
  [s.annotationQueues, ["name", "description"]],
  [s.redteamLibraries, ["name"]],
  [s.trainingDatasets, ["name"]],
  [s.trainingJobs, ["name"]],
  [s.monitoringDashboards, ["name"]],
  [s.automationRules, ["name"]],
  [s.policySimulations, ["policyName"]],
  [s.rateCards, ["name", "description"]],
];

export type ContentGuardExclusion =
  | "prose_owned_by_adr0102"
  | "audit_owned_by_adr0099"
  | "tool_reference"
  | "platform_copy"
  | "ingested"
  | "machine"
  | "conversation"
  | "signed_evidence"
  | "check_constrained";

/** Why each exclusion category is not guarded. Printed into ADR-0233's table by the inventory test. */
export const CONTENT_GUARD_EXCLUSION_REASONS: Readonly<Record<ContentGuardExclusion, string>> = {
  prose_owned_by_adr0102: "already scrubbed by ADR-0102's prose registry; one column, one owner",
  audit_owned_by_adr0099: "audit_log is scrubbed by ADR-0099 before it is hashed",
  tool_reference:
    "an identifier the upstream MCP server chose; refusing it would make that tool ungovernable (no grant, rule or revocation could name it)",
  platform_copy: "a copy the platform makes of a guarded or ingested column; the source is where the decision is made",
  ingested:
    "text read from an external system (an MCP server, a registry, an IdP, a cloud account, an SDK); refusing it would break the sync, not stop the paste",
  machine: "written by the platform from its own identifiers or generated text, never typed by an operator",
  conversation: "a conversation record, governed at the presentation boundary by ADR-0112",
  signed_evidence: "canonical bytes that are hashed and signed; derived from columns that are guarded or excluded above",
  check_constrained: "a DB CHECK limits it to a short lowercase identifier (at most 32 characters), which no credential rule matches",
};

/** DELIBERATELY NOT GUARDED — named, with a category, so the inventory test can tell a decision from an oversight. */
export const CONTENT_GUARD_EXCLUSIONS: Readonly<Record<string, ContentGuardExclusion>> = {
  "ai_incident_actions.title": "prose_owned_by_adr0102",
  "ai_incidents.summary": "prose_owned_by_adr0102",
  "ai_incidents.title": "prose_owned_by_adr0102",
  "ai_policy_documents.title": "prose_owned_by_adr0102",
  "audit_log.tool_name": "audit_owned_by_adr0099",
  "approval_rules.tool_name": "tool_reference",
  "approvals.tool_name": "tool_reference",
  "config_canary_observations.tool_name": "tool_reference",
  "data_scope_rules.tool_name": "tool_reference",
  "grant_certification_items.tool_name": "tool_reference",
  "identity_tool_grants.tool_name": "tool_reference",
  "policy_simulation_flips.tool_name": "tool_reference",
  "rate_limits.tool_name": "tool_reference",
  "revocations.tool_name": "tool_reference",
  "role_tool_grants.tool_name": "tool_reference",
  "sod_rule_sides.tool_name": "tool_reference",
  "sod_rules.a_tool_name": "tool_reference",
  "sod_rules.b_tool_name": "tool_reference",
  "tool_grants.tool_name": "tool_reference",
  "approvals.review_role_name": "platform_copy",
  "billing_statements.rate_card_name": "platform_copy",
  "builder_agent_skills.snapshot_name": "platform_copy",
  "engine_runs.workflow_check_name": "platform_copy",
  "eval_runs.agent_name": "platform_copy",
  "eval_runs.workflow_check_name": "platform_copy",
  "mcp_servers.registry_entry_name": "platform_copy",
  "mrm_retest_runs.source_name": "platform_copy",
  "policy_simulation_flips.project_name": "platform_copy",
  "redteam_runs.agent_name": "platform_copy",
  "redteam_runs.library_name": "platform_copy",
  "scheduler_runs.job_name": "platform_copy",
  "use_case_decision_records.intake_template_name": "platform_copy",
  "cert_inventory.common_name": "ingested",
  "imported_cost_lines.description": "ingested",
  "infra_resources.name": "ingested",
  "mcp_registry_entries.description": "ingested",
  "mcp_registry_entries.title": "ingested",
  "mcp_registry_entries.upstream_name": "ingested",
  "mcp_tools.description": "ingested",
  "mcp_tools.name": "ingested",
  "scim_groups.display_name": "ingested",
  "trace_scores.name": "ingested",
  "users.display_name": "ingested",
  "builder_tool_steps.display_name": "machine",
  "builder_tool_steps.name": "machine",
  "copilot_proposals.title": "machine",
  "data_backfills.name": "machine",
  "data_key_reencryption_failures.column_name": "machine",
  "data_key_reencryption_failures.table_name": "machine",
  "data_key_reencryption_progress.column_name": "machine",
  "data_key_reencryption_progress.table_name": "machine",
  "eval_judge_verdicts.judge_name": "machine",
  "governance_alerts.title": "machine",
  "remediation_proposals.title": "machine",
  "scheduler_jobs.description": "machine",
  "scheduler_jobs.name": "machine",
  "trace_spans.name": "machine",
  "traces.name": "machine",
  "training_artifacts.name": "machine",
  "builder_threads.title": "conversation",
  "conversations.summary": "conversation",
  "conversations.title": "conversation",
  "ai_bom_snapshots.body": "signed_evidence",
  "decision_boms.body": "signed_evidence",
  "model_artifact_signatures.resource_name": "signed_evidence",
  "model_artifact_signatures.signed_name": "signed_evidence",
  "prompt_tags.name": "check_constrained",
};

/** One entry per table, enforced (a repeated table would silently drop the earlier entry's columns). */
const GUARD_COLUMNS: ReadonlyMap<object, ReadonlySet<string>> = (() => {
  const m = new Map<object, ReadonlySet<string>>();
  for (const [table, cols] of REGISTRY) {
    if (m.has(table)) throw new Error(`content-guard registry lists ${getTableName(table as never)} twice — merge the entries`);
    m.set(table, new Set(cols));
  }
  return m;
})();

const sqlName = (table: object, key: string) =>
  (table as Record<string, { name?: string }>)[key]?.name ?? key;

/** `table.column` (SQL names) for every guarded column, derived from the registry. */
export function contentGuardInventory(): string[] {
  const out: string[] = [];
  for (const [table, cols] of REGISTRY) {
    const t = getTableName(table as never);
    for (const col of cols) out.push(`${t}.${sqlName(table, col)}`);
  }
  return out.sort();
}

/** Every guarded column with the drizzle key, for the existing-rows report. */
export function contentGuardColumns(): { table: string; column: string; field: string }[] {
  const out: { table: string; column: string; field: string }[] = [];
  for (const [table, cols] of REGISTRY) {
    const t = getTableName(table as never);
    for (const col of cols) out.push({ table: t, column: sqlName(table, col), field: col });
  }
  return out.sort((a, b) => `${a.table}.${a.column}`.localeCompare(`${b.table}.${b.column}`));
}

/** The refusal. Carries WHERE and WHAT KIND, never the value. */
export class ContentCredentialError extends Error {
  readonly code = "credential_in_content";
  readonly status = 422;
  constructor(
    readonly table: string,
    readonly column: string,
    readonly field: string,
    readonly rules: readonly string[],
  ) {
    super(
      `${field} looks like it contains a credential (${rules.join(", ") || "credential"}); ` +
        `remove it and save again (ADR-0233)`,
    );
    this.name = "ContentCredentialError";
  }
}

/** The rule labels a content value trips, or `null` when it is clean (the identity-return path). */
export function contentCredentialRules(text: string): string[] | null {
  if (typeof text !== "string" || text.length === 0) return null;
  const scrubbed = CONTENT_GUARD_DETECTOR(text);
  if (scrubbed === text) return null;
  return addedAuditScrubRules(text, scrubbed);
}

interface Hit {
  table: string;
  column: string;
  field: string;
  rules: string[];
}

function firstHitIn(table: object, cols: ReadonlySet<string>, values: unknown): Hit | null {
  const rows = Array.isArray(values) ? values : [values];
  for (const row of rows) {
    if (row === null || typeof row !== "object") continue;
    const obj = row as Record<string, unknown>;
    for (const key of cols) {
      const v = obj[key];
      if (typeof v !== "string") continue;
      const rules = contentCredentialRules(v);
      if (rules) return { table: getTableName(table as never), column: sqlName(table, key), field: key, rules };
    }
  }
  return null;
}

type Fn = (...args: unknown[]) => unknown;

function shadow<T extends object>(builder: T, method: string, wrap: (orig: Fn) => Fn): T {
  const orig = (builder as Record<string, unknown>)[method];
  if (typeof orig !== "function") return builder;
  (builder as Record<string, unknown>)[method] = wrap((orig as Fn).bind(builder));
  return builder;
}

/** Is the guard on for this install? Read through the caller's own handle (inside its transaction when it has one). */
async function guardEnforced(handle: object): Promise<boolean> {
  const exec = (handle as { execute?: (q: unknown) => Promise<unknown> }).execute;
  if (typeof exec !== "function") return true;
  const res = (await exec.call(handle, sql`select content_credential_guard as enforced from org_settings limit 1`)) as {
    rows?: { enforced?: unknown }[];
  };
  const row = res?.rows?.[0];
  // fail closed: no row, or an unreadable value, is the strict default
  return !(row && row.enforced === false);
}

/**
 * Arm a built statement with a pending hit: when it runs, the org setting is read and the statement either
 * proceeds (relaxed) or is refused before it reaches Postgres. `then`/`catch`/`finally` all go through
 * `execute`, so shadowing it covers `await`. `prepare()` cannot await a setting, so a statement carrying a
 * hit is refused there unconditionally (fail closed; no write path in this repo prepares an insert/update).
 */
function arm<B extends object>(builder: B, handle: object, hit: Hit): B {
  if (builder === null || typeof builder !== "object") return builder;
  shadow(builder, "execute", (orig) => async (...args: unknown[]) => {
    if (await guardEnforced(handle)) throw new ContentCredentialError(hit.table, hit.column, hit.field, hit.rules);
    return orig(...args);
  });
  shadow(builder, "prepare", () => () => {
    throw new ContentCredentialError(hit.table, hit.column, hit.field, hit.rules);
  });
  return builder;
}

/**
 * Wrap a drizzle handle so a write of credential-shaped text into a registered content column is refused
 * (unless the org relaxed the guard). Composed OUTSIDE `withProseScrub` in `createDb`; everything not
 * registered passes straight through.
 */
export function withContentGuard<T extends object>(target: T): T {
  if ((target as Record<symbol, unknown>)[GUARDED]) return target;

  return new Proxy(target, {
    get(t, prop) {
      if (prop === GUARDED) return true;

      if (prop === "insert" || prop === "update") {
        const build = Reflect.get(t, prop, t) as (table: unknown) => object;
        if (typeof build !== "function") return build;
        return (table: unknown) => {
          const builder = build.call(t, table);
          const cols = GUARD_COLUMNS.get(table as object);
          if (!cols || builder === null || typeof builder !== "object") return builder;
          if (prop === "update") {
            return shadow(builder, "set", (orig) => (v) => {
              const built = orig(v) as object;
              const hit = firstHitIn(table as object, cols, v);
              return hit ? arm(built, t, hit) : built;
            });
          }
          return shadow(builder, "values", (orig) => (v) => {
            const inserted = orig(v) as object;
            if (inserted === null || typeof inserted !== "object") return inserted;
            const hit = firstHitIn(table as object, cols, v);
            if (hit) arm(inserted, t, hit);
            return shadow(inserted, "onConflictDoUpdate", (doUpdate) => (cfg) => {
              const out = doUpdate(cfg);
              const c = cfg as { set?: unknown } | null;
              if (hit || !c || typeof c !== "object" || c.set === undefined) return out;
              const setHit = firstHitIn(table as object, cols, c.set);
              if (setHit && out !== null && typeof out === "object") arm(out, t, setHit);
              return out;
            });
          });
        };
      }

      if (prop === "transaction") {
        return (cb: (tx: unknown) => unknown, config?: unknown) =>
          (t as unknown as { transaction: (c: (tx: unknown) => unknown, cfg?: unknown) => unknown }).transaction(
            (tx: unknown) => cb(withContentGuard(tx as object)),
            config,
          );
      }

      const value = Reflect.get(t, prop, t);
      return typeof value === "function" ? (value as Fn).bind(t) : value;
    },
  });
}

/** A guarded column holding credential-shaped text TODAY. Ids and rule labels only, never the value. */
export interface ContentCredentialFinding {
  table: string;
  column: string;
  field: string;
  rowId: string;
  rules: string[];
}

/**
 * ADR-0233 — REPORT existing rows, never rewrite them. Scans each guarded column of tables keyed by `id`,
 * a bounded number of rows per column (newest-first is not assumed; a full scan is an admin action), and
 * returns where the detector matches. The value never leaves this function.
 */
export const CONTENT_REPORT_DEFAULT_ROW_BUDGET = 200_000;
export const CONTENT_REPORT_MAX_ROW_BUDGET = 2_000_000;

export async function contentCredentialReport(
  db: { execute: (q: unknown) => Promise<unknown> },
  opts: { perColumnLimit?: number; rowBudget?: number } = {},
): Promise<{
  findings: ContentCredentialFinding[];
  scannedColumns: number;
  truncatedColumns: string[];
  /** review finding 4: rows read in total, and the columns left unscanned when the budget ran out */
  scannedRows: number;
  rowBudget: number;
  incomplete: boolean;
  unscannedColumns: string[];
}> {
  const perColumnLimit = Math.min(Math.max(opts.perColumnLimit ?? 50, 1), 500);
  const rowBudget = Math.min(Math.max(opts.rowBudget ?? CONTENT_REPORT_DEFAULT_ROW_BUDGET, 500), CONTENT_REPORT_MAX_ROW_BUDGET);
  const findings: ContentCredentialFinding[] = [];
  const truncatedColumns: string[] = [];
  const unscannedColumns: string[] = [];
  let scannedColumns = 0;
  let scannedRows = 0;
  for (const { table, column, field } of contentGuardColumns()) {
    // a column is either scanned to the end (or to its finding cap) or listed as unscanned: never half-reported
    if (scannedRows >= rowBudget) {
      unscannedColumns.push(`${table}.${column}`);
      continue;
    }
    scannedColumns++;
    let found = 0;
    let truncated = false;
    let lastId: string | null = null;
    // keyset pages of 500 so a large table is never read into memory at once
    while (!truncated) {
      const page = (await db.execute(
        sql`select id::text as id, ${sql.identifier(column)} as v from ${sql.identifier(table)}
            where ${sql.identifier(column)} is not null and length(${sql.identifier(column)}) > 0
            ${lastId === null ? sql`` : sql`and id::text > ${lastId}`}
            order by id::text limit 500`,
      )) as { rows?: { id: string; v: string }[] };
      const rows = page.rows ?? [];
      scannedRows += rows.length;
      for (const r of rows) {
        const rules = contentCredentialRules(r.v);
        if (!rules) continue;
        if (found >= perColumnLimit) {
          truncatedColumns.push(`${table}.${column}`);
          truncated = true;
          break;
        }
        findings.push({ table, column, field, rowId: r.id, rules });
        found++;
      }
      if (rows.length < 500) break;
      if (scannedRows >= rowBudget) {
        // the budget ran out mid-column: say so rather than imply the column is clean
        truncatedColumns.push(`${table}.${column}`);
        break;
      }
      lastId = rows[rows.length - 1]!.id;
    }
  }
  return {
    findings,
    scannedColumns,
    truncatedColumns,
    scannedRows,
    rowBudget,
    incomplete: unscannedColumns.length > 0 || truncatedColumns.length > 0,
    unscannedColumns,
  };
}
