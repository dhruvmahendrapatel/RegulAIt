/**
 * ADR-0102 — the OPERATOR-PROSE credential scrub, for every reason/note column
 * OUTSIDE `audit_log`.
 *
 * THE GAP THIS CLOSES (PENDING S5)
 * --------------------------------
 * ADR-0099 scrubs credentials out of `audit_log` at ADR-0060's chained-insert
 * chokepoint. It covers `audit_log` and nothing else, and the failure that
 * exposed it was reproducible in a single request: an AWS-shaped key typed into
 * an MCP admission-clear reason was stored as
 * `[redacted:aws_key:20:1a5d44a2dca1]` in `audit_log.reason` and **verbatim** in
 * `mcp_servers.admission_clear_reason` — the same string, the same handler, two
 * different outcomes. A reader of the ledger would conclude the secret had been
 * contained. It had not.
 *
 * A schema sweep found 53 free-form `reason`/`note`/`rationale`/`explanation`
 * columns outside `audit_log`; 47 of them hold prose a human types while
 * explaining why they did something, which is exactly where a pasted secret
 * ends up.
 *
 * WHY NOT AT THE ZOD SCHEMAS
 * --------------------------
 * The obvious plan was a scrubbing zod schema that every reason field is parsed
 * through — parse-time coverage, one shared definition. It does not survive
 * contact with the code: there is **no shared reason schema in this repo**.
 * Every one of the ~104 reason/note fields across `apps/gateway` and
 * `packages/shared` is an ad-hoc inline `z.string().min(1).max(N)` written at
 * its own endpoint, and there is no `reasonText()` helper for them to have been
 * built on. Making them scrub would mean editing 104 declarations and then
 * *relying on the 105th to remember* — which is the per-call-site convention
 * ADR-0099 explicitly rejected, wearing a zod costume.
 *
 * WHERE IT IS SITED INSTEAD, AND WHY THAT IS THE SAME ARGUMENT
 * ------------------------------------------------------------
 * ADR-0099 is sound because `createDb` is the ONE place a database handle is
 * constructed in this repo, and ADR-0060 had already put a Proxy there. That
 * Proxy is not audit-specific — it is a handle interceptor that currently only
 * looks at `insert(auditLog)`. **The same interception point sees every insert
 * and every update to every table**, so the structural property that made
 * ADR-0099 work is already available for ordinary table writes; nothing new has
 * to be manufactured.
 *
 * So this file adds a SECOND, composed wrapper: `withProseScrub` intercepts
 * `insert(t).values(...)`, `insert(t).onConflictDoUpdate({ set })` and
 * `update(t).set(...)` for the tables in `PROSE_COLUMNS`, and scrubs exactly the
 * declared string columns with ADR-0099's own `scrubAuditText`. A route that is
 * written next month and does a raw `db.update(approvals).set({ decisionReason })`
 * is covered without its author knowing this file exists, which is the only
 * property worth having here.
 *
 * It is deliberately a SEPARATE wrapper rather than more branches inside
 * `withAuditChain`: the audit chain has a correctness argument about hashing
 * order that this does not share, and conflating them would make both harder to
 * reason about. `createDb` composes them.
 *
 * ONE DETECTOR, NOT TWO
 * ---------------------
 * The scrub is `scrubAuditText` — the same function, over ADR-0042's same
 * `CREDENTIAL_MATERIAL_RULES`. That is not code-reuse tidiness, it is the fix:
 * S5's specific defect is that two records of the same event disagreed, so the
 * marker written into `mcp_servers.admission_clear_reason` MUST be
 * byte-identical to the one written into `audit_log.reason` for the same
 * secret. Identical rules and an identical marker grammar is what makes the two
 * rows correlate rather than contradict. A second detector could drift; there
 * is no second detector, and a test asserts the identity of the function
 * reference.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * --------------------------------
 * - It does not scrub `name`, `title`, `description`, `summary` or `body`
 *   columns. Those are ~34 more columns of free text, and they are a different
 *   argument: a description is content, and this control's whole safety case
 *   rests on being applied to a narrow, enumerated set where prose loses
 *   nothing. See ADR-0102's limits.
 * - It does not scrub reads, exports or in-flight request bodies. A credential
 *   typed into a reason still travels through the process and may appear in a
 *   4xx echo; this is about what is PERSISTED.
 * - It is application-layer, exactly like ADR-0060 and ADR-0099: a `psql`
 *   session or a module that builds its own `pg.Pool` bypasses it.
 */
import { getTableName } from "drizzle-orm";
import { scrubAuditText } from "@regulait/shared";
import * as s from "./schema.js";

/** Marker property: `true` on a handle that already scrubs, so wrapping is
 * idempotent and a doubly-wrapped handle cannot scrub twice. */
const SCRUBBED = Symbol.for("regulait.prose-scrub.wrapped");

/** The scrub applied to a prose column. Re-exported by REFERENCE, never
 * re-implemented — see this file's header, and the test that asserts
 * `PROSE_SCRUB === scrubAuditText`. */
export const PROSE_SCRUB: (text: string) => string = scrubAuditText;

/**
 * THE REGISTRY — default-deny, and every entry is a column whose contents are
 * an explanation rather than data.
 *
 * Listing tables explicitly (rather than sniffing column names at runtime) is
 * the point: adding a column to this list is a decision someone makes, and the
 * inventory test below prints exactly what is and is not covered so the ADR's
 * honest-limits section cannot quietly go stale.
 */
const REGISTRY: ReadonlyArray<readonly [object, readonly string[]]> = [
  // --- the S5 reproduction itself ---
  [s.mcpServers, ["admissionClearReason"]],
  // --- governance decisions and overrides (pillar 1) ---
  [s.approvals, ["decisionReason"]],
  [s.approvalDelegations, ["reason"]],
  [s.agentRevocations, ["reason"]],
  [s.connectorRevocations, ["reason"]],
  [s.agents, ["lifecycleReason"]],
  [s.sodRules, ["reason"]],
  [s.decisions, ["rationale"]],
  [s.interceptionScopeRules, ["note"]],
  [s.egressAllowHosts, ["note"]],
  [s.mcpRegistryEntries, ["catalogueReason"]],
  // --- config / workflow lifecycle (pillar 2) ---
  [s.configActivationEvents, ["reason"]],
  [s.configCanaryObservations, ["servedReason", "candidateReason", "failureReason"]],
  [s.workflowTemplates, ["retiredReason"]],
  [s.certRotations, ["reason"]],
  [s.dataKeyAttestations, ["note"]],
  [s.licenseVerifications, ["reason"]],
  [s.onboardingImports, ["reason"]],
  [s.policySimulations, ["note"]],
  // --- spend and billing (pillar 5) ---
  [s.spendScheduledChanges, ["reason"]],
  [s.spendAnomalies, ["explanation", "decisionReason"]],
  [s.billingStatements, ["issueReason"]],
  [s.costImportBatches, ["reason"]],
  [s.importedCostLines, ["supersededReason"]],
  [s.vendorAccountAliases, ["reason"]],
  [s.vendorDomainRules, ["reason"]],
  // --- model risk, evals, red team ---
  [s.evalDatasets, ["note"]],
  [s.evalRuns, ["gateReason", "note"]],
  [s.evalResults, ["judgeRationale"]],
  [s.modelCards, ["note"]],
  [s.modelCardApprovals, ["decisionReason"]],
  [s.modelCardEvidence, ["note"]],
  [s.redteamLibraries, ["note"]],
  [s.redteamProbes, ["note"]],
  [s.redteamRuns, ["gateReason", "note"]],
  [s.trainingDatasets, ["note"]],
  [s.copilotProposals, ["rationale"]],
  // --- compliance, shadow AI, AI inventory ---
  [s.compliancePackControls, ["ownerNote"]],
  [s.shadowAiImports, ["reason"]],
  [s.shadowAiFindings, ["replacementNote", "dispositionReason"]],
  [s.aiEndpointSignatures, ["replacementNote"]],
  [s.aiUseCases, ["retiredReason"]],
  [s.aiVendors, ["retiredReason"]],
  [s.aiRisks, ["acceptanceNote"]],
  // --- machine-written free text that quotes an error ---
  // `statusReason` takes `(err as Error).message` verbatim at several dispatch
  // sites, and an exception message is one of the classic places a connection
  // string or bearer token surfaces. Not operator prose, but the same risk.
  [s.traceSpans, ["statusReason"]],
];

/**
 * DELIBERATELY NOT COVERED, and named here rather than merely absent, so the
 * inventory test can assert the exclusion is a decision and not an oversight.
 *
 * - `audit_log.reason` — ADR-0099 owns it, at the chained-insert path, BEFORE
 *   the row is hashed. Scrubbing it a second time here would be worse than
 *   redundant: the marker text itself (`aws_key:20:…`) is `key: value` shaped
 *   and `dlp.secret.assignment` would match it, nesting a marker inside a
 *   marker. One column, one owner.
 * - `mcp_registry_entries.conflict_reason` — drizzle-typed
 *   `{ enum: ["name_taken", "url_taken"] }`. A credential cannot appear in a
 *   two-member enum.
 * - `usage_events.stop_reason` — the model provider's finish-reason vocabulary
 *   (`end_turn`, `max_tokens`, `cached`), not free text, on the
 *   highest-volume write path in the schema. Excluded on both grounds.
 */
export const PROSE_SCRUB_EXCLUSIONS: readonly string[] = [
  "audit_log.reason",
  "mcp_registry_entries.conflict_reason",
  "usage_events.stop_reason",
];

const PROSE_COLUMNS: ReadonlyMap<object, ReadonlySet<string>> = new Map(
  REGISTRY.map(([table, cols]) => [table, new Set(cols)] as const),
);

/**
 * `table.column` in SQL names for every covered column, DERIVED from the
 * registry rather than restated beside it — a hand-maintained second list is
 * the thing that goes stale. This is what the ADR's covered/not-covered
 * enumeration is checked against.
 */
export function proseScrubInventory(): string[] {
  const out: string[] = [];
  for (const [table, cols] of REGISTRY) {
    const t = getTableName(table as never);
    for (const col of cols) {
      const c = (table as Record<string, { name?: string }>)[col];
      out.push(`${t}.${c?.name ?? col}`);
    }
  }
  return out.sort();
}

/**
 * Scrub the declared prose columns of one values object.
 *
 * Returns the SAME object when nothing changed — the overwhelmingly common
 * case, and the over-scrub guard expressed in code: an unchanged write is not
 * rebuilt, so it cannot be accidentally altered.
 *
 * ONLY string values are touched. A `null`, a number, or a drizzle `sql`
 * expression passes through untouched, because scrubbing is defined over text
 * and a fabricated `sql` chunk would be a correctness bug, not a redaction.
 */
function scrubOne<T>(cols: ReadonlySet<string>, values: T): T {
  if (values === null || typeof values !== "object" || Array.isArray(values)) return values;
  const obj = values as Record<string, unknown>;
  let changed: Record<string, unknown> | undefined;
  for (const key of cols) {
    const v = obj[key];
    if (typeof v !== "string" || v.length === 0) continue;
    const scrubbed = PROSE_SCRUB(v);
    if (scrubbed === v) continue;
    changed ??= { ...obj };
    changed[key] = scrubbed;
  }
  return (changed ?? values) as T;
}

/** `.values()` accepts one row or an array of them. */
function scrubValues<T>(cols: ReadonlySet<string>, values: T): T {
  if (!Array.isArray(values)) return scrubOne(cols, values);
  let changed = false;
  const next = values.map((row) => {
    const s2 = scrubOne(cols, row);
    if (s2 !== row) changed = true;
    return s2;
  });
  return (changed ? next : values) as T;
}

type Fn = (...args: unknown[]) => unknown;

/**
 * Shadow ONE method on a freshly-built drizzle builder.
 *
 * The builder is created per call and thrown away, so an own-property shadow of
 * a prototype method is safe and — unlike a second Proxy — cannot interfere
 * with drizzle's private class fields or with `this` inside the real method.
 */
function shadow<T extends object>(builder: T, method: string, wrap: (orig: Fn) => Fn): T {
  const orig = (builder as Record<string, unknown>)[method];
  if (typeof orig !== "function") return builder;
  (builder as Record<string, unknown>)[method] = wrap((orig as Fn).bind(builder));
  return builder;
}

/**
 * Wrap a drizzle handle so writes to registered prose columns are scrubbed.
 *
 * Composed OUTSIDE `withAuditChain` in `createDb`, and `transaction()` re-wraps
 * the handle drizzle hands the callback, so a write inside a caller's own
 * transaction — which is how `POST /v1/approvals/:id/decision` records its
 * decision reason — is covered exactly like a top-level one.
 *
 * Everything not registered passes straight through, including
 * `insert(auditLog)`, which reaches the audit chain's builder untouched.
 */
export function withProseScrub<T extends object>(target: T): T {
  if ((target as Record<symbol, unknown>)[SCRUBBED]) return target;

  return new Proxy(target, {
    get(t, prop) {
      if (prop === SCRUBBED) return true;

      if (prop === "insert" || prop === "update") {
        const build = Reflect.get(t, prop, t) as (table: unknown) => object;
        if (typeof build !== "function") return build;
        return (table: unknown) => {
          const builder = build.call(t, table);
          const cols = PROSE_COLUMNS.get(table as object);
          if (!cols || builder === null || typeof builder !== "object") return builder;
          if (prop === "update") return shadow(builder, "set", (orig) => (v) => orig(scrubValues(cols, v)));
          // `insert(t).values(v)` returns the object that carries
          // `.onConflictDoUpdate({ set })` — an UPSERT is a write of the same
          // columns and is registered here too (`egress_allow_hosts.note` is
          // written exactly that way today).
          return shadow(builder, "values", (orig) => (v) => {
            const inserted = orig(scrubValues(cols, v));
            if (inserted === null || typeof inserted !== "object") return inserted;
            return shadow(inserted, "onConflictDoUpdate", (doUpdate) => (cfg) => {
              const c = cfg as { set?: unknown } | null;
              if (!c || typeof c !== "object" || c.set === undefined) return doUpdate(cfg);
              return doUpdate({ ...c, set: scrubValues(cols, c.set) });
            });
          });
        };
      }

      if (prop === "transaction") {
        return (cb: (tx: unknown) => unknown, config?: unknown) =>
          (t as unknown as { transaction: (c: (tx: unknown) => unknown, cfg?: unknown) => unknown }).transaction(
            (tx: unknown) => cb(withProseScrub(tx as object)),
            config,
          );
      }

      // Same receiver/binding discipline as `withAuditChain`: read with the
      // TARGET as receiver so a getter touching `this` does not re-enter the
      // proxy, and bind methods for the same reason.
      const value = Reflect.get(t, prop, t);
      return typeof value === "function" ? (value as Fn).bind(t) : value;
    },
  });
}
