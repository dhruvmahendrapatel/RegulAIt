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
  // ADR-0175 — the same kind of admin override, for a held builder skill and
  // for the release-age cooldown: free prose typed beside a review decision
  [s.builderSkills, ["admitReason"]],
  [s.releaseOverrides, ["reason"]],
  // ADR-0175 A15 — the admin's note on where an energy factor came from
  [s.energyFactors, ["sourceNote"]],
  // ADR-0173 batch 2c — a reviewer's annotation comment (free prose typed
  // beside a score), a judge's rationale (model output that can quote the
  // case, which can quote a secret), and an automation rule's pause reason
  // (fixed codes today, but an unconstrained text column)
  [s.annotationSubmissions, ["comment"]],
  [s.evalJudgeVerdicts, ["rationale"]],
  [s.automationRules, ["pausedReason"]],
  // --- governance decisions and overrides (pillar 1) ---
  [s.approvals, ["decisionReason"]],
  [s.approvalDelegations, ["reason"]],
  [s.agentRevocations, ["reason"]],
  [s.connectorRevocations, ["reason"]],
  // ADR-0124 — the emergency-stop reasons. Operator free prose typed under
  // incident pressure, which is exactly when somebody pastes the credential
  // they are rotating into the explanation. Same reasoning as
  // `mcp_servers.admission_clear_reason`.
  [s.agents, ["lifecycleReason", "haltedReason"]],
  [s.mcpTools, ["haltedReason"]],
  [s.orgSettings, ["executionModeReason"]],
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
  // ADR-0115 — `error` joins `judgeRationale` here, and it is the SAME argument
  // ADR-0102 already made for `trace_spans.status_reason`: this column takes
  // `(e as Error).message` verbatim at two sites in the eval runner
  // (`judge_failed: …`, `external_scorer_failed: …`), and an exception message
  // from an HTTP judge or an external scorer is one of the classic places a
  // bearer token or a connection string surfaces. Measured, not assumed: an
  // S22 probe stored `judge_failed: judge upstream 401 using key
  // AKIAIOSFODNN7EXAMPLE for endpoint` character for character.
  //
  // WHY THIS COLUMN IS SCRUBBED AT WRITE TIME WHILE `output_text` IS NOT:
  // `error` says why the INSTRUMENT fell over. It is never the agent's answer
  // and it is never a red-team defeat's evidence, so redacting a credential
  // out of it destroys nothing a reader needs — the sentence around the marker
  // survives intact, which is exactly ADR-0102's safety case. `output_text` IS
  // the record of what the model said, and ADR-0115 leaves it faithful and
  // redacts it at the presentation boundary instead.
  //
  // It does NOT change red-team failure classification: `classifyDispatchFailure`
  // is fed `detail.errorCode` first (a jsonb field this registry cannot reach)
  // and the codes it matches are bare enum-like strings that no credential rule
  // can match. `eval_results.detail` is deliberately absent from this list:
  // the registry scrubs declared STRING columns only, and a jsonb bag is
  // ADR-0111's `trace_spans.attributes` question, answered there and answered
  // differently here — see ADR-0115.
  [s.evalResults, ["judgeRationale", "error"]],
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
  // ADR-0157 / ADR-0159 — an alert acknowledgement is operator prose; a
  // remediation's rationale embeds risk and agent titles a person typed.
  [s.governanceAlerts, ["ackNote"]],
  // ADR-0168 — a condition-met note is operator prose. ADR-0180 A2: so is an
  // admin's waiver reason (one entry per table: merged here).
  [s.useCaseConditions, ["note", "waiveReason"]],
  // ADR-0180 A10 — why a residual risk is acceptable, and why an acceptance
  // was revoked: prose typed beside a risk decision. The compensating
  // controls are jsonb, which this registry cannot reach (see the exclusions).
  [s.riskAcceptances, ["rationale", "revokeReason"]],
  // ADR-0180 A8 — a steward's note on the autonomy class they declared
  [s.builderAgents, ["autonomyNote"]],
  [s.remediationProposals, ["rationale"]],
  // ADR-0182 (ADR-0175 batch D4, migration 0162) — accountability records.
  // Every new free-text column is registered, titles included: an incident
  // written under pressure, a reviewer's override label, an evidence reference
  // pasted from a ticketing system and a resolution note are exactly where a
  // credential gets pasted, and redacting one from a title loses nothing a
  // reader needs. Feedback bodies and contact details are NOT here: they are
  // REGULAIT_DATA_KEY envelopes (A13), never plaintext.
  [s.decisionRegressionCases, ["label"]],
  [s.aiIncidents, ["title", "summary", "sourceRef", "rootCause", "lessonsLearned"]],
  [s.aiIncidentEvents, ["note"]],
  [s.aiIncidentActions, ["title", "evidenceRef"]],
  [s.aiIncidentNotifications, ["recipient", "reference", "reason"]],
  [s.useCaseFeedback, ["resolutionNote"]],
  [s.aiPolicyDocuments, ["title", "editorialReason"]],
  [s.aiPolicyAcknowledgements, ["evidenceRef"]],
  // ADR-0186 (batch 4, migration 0170): an approver's decision reason (the
  // append-only `approval_decisions` row is scrubbed at its one insert, the
  // same text `approvals.decision_reason` already gets), and a passkey's label
  // and revoke reason.
  [s.approvalDecisions, ["reason"]],
  [s.webauthnCredentials, ["label", "revokeReason"]],
  // --- machine-written free text that quotes an error, and ADR-0111's
  //     EXPORTED OBSERVABILITY COPY ---
  //
  // `statusReason` takes `(err as Error).message` verbatim at several dispatch
  // sites, and an exception message is one of the classic places a connection
  // string or bearer token surfaces. Not operator prose, but the same risk.
  //
  // ADR-0111 — THE EXPORTED OBSERVABILITY COPY.
  //
  // These two are NOT prose, and registering them is a DIFFERENT argument from
  // every entry above. `input_preview` is a governed tool call's ARGUMENTS and
  // `output_preview` is its RESULT (or, on an `llm` span, the prompt and the
  // completion) — content, which this file's header explicitly declines to
  // scrub for `name`/`title`/`description`/`summary`/`body`. Two facts put
  // them on the other side of that line:
  //
  //  1. THEY ARE A DUPLICATE OF A RECORD THAT IS ALREADY SCRUBBED. ADR-0104
  //     writes the SAME tool arguments into `approvals.arguments_preview`
  //     through `scrubAuditDetail`, and ADR-0099 writes the same call's
  //     evidence into `audit_log`. Leaving the trace copy in plaintext is S5's
  //     defect verbatim: one event, two stores, disagreeing about whether the
  //     secret was contained. A description has no scrubbed twin; these do.
  //  2. THEY LEAVE THE PLATFORM. ADR-0070 exports spans over OTLP, and
  //     `otelAttributesForSpan` puts these two columns into
  //     `gen_ai.input.messages` / `gen_ai.output.messages` on the wire. Every
  //     other column here is an at-rest risk; this one is egress to a
  //     third-party backend.
  //
  // WHAT IS LOST. A preview that genuinely contained credential-shaped text no
  // longer shows it. That is a real cost and is stated in ADR-0111: the preview
  // is already a LOSSY surface — truncated at `previewMaxChars` and switched
  // off wholesale by `tracingCaptureContent` — and it is not the record of
  // what was said. `conversation_messages.content` and `eval_results.output_text`
  // are, and ADR-0111 deliberately leaves both untouched.
  [s.traceSpans, ["statusReason", "inputPreview", "outputPreview"]],
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
 * - `trace_retention_holds.release_reason` — a DB CHECK limits it to
 *   `'erasure'` or `'admin'` (ADR-0173 batch 2c); the free-text erasure
 *   reference goes to `audit_log`, which ADR-0099 scrubs.
 * - `risk_acceptances.compensating_controls` — jsonb
 *   (`{controlRef, description}[]`, ADR-0180 A10), and this registry scrubs
 *   declared STRING columns only (the ADR-0115 `eval_results.detail`
 *   answer). The one writer, the risk-acceptance route, scrubs each
 *   `description` with `PROSE_SCRUB` before the insert.
 * - `migration_audit_outbox.reason` — ADR-0181 FX2 (migration 0160): written
 *   only by migration SQL (no application writer, so nothing an operator
 *   typed), and held only until `runMigrations` drains it into
 *   `audit_log.reason` through the chained insert, which ADR-0099 scrubs.
 */
export const PROSE_SCRUB_EXCLUSIONS: readonly string[] = [
  "audit_log.reason",
  "mcp_registry_entries.conflict_reason",
  "migration_audit_outbox.reason",
  "risk_acceptances.compensating_controls",
  "trace_retention_holds.release_reason",
  "usage_events.stop_reason",
];

/**
 * ONE ENTRY PER TABLE, enforced rather than assumed.
 *
 * `new Map(pairs)` keeps the LAST value for a repeated key, so a second entry
 * for a table already in the registry would silently DROP the first one's
 * columns while `proseScrubInventory()` — which reads the array — kept
 * reporting them as covered. That is a scrub that looks registered and is not,
 * which is the exact failure class this file exists to prevent. ADR-0111 added
 * two columns to a table that already had one and would have hit it.
 */
const PROSE_COLUMNS: ReadonlyMap<object, ReadonlySet<string>> = (() => {
  const m = new Map<object, ReadonlySet<string>>();
  for (const [table, cols] of REGISTRY) {
    if (m.has(table)) {
      throw new Error(
        `prose-scrub registry lists ${getTableName(table as never)} twice — ` +
          `merge the column lists into one entry, or the earlier one is silently dropped`,
      );
    }
    m.set(table, new Set(cols));
  }
  return m;
})();

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
