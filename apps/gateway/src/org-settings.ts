/**
 * ADR-0021 — the ORG-SETTINGS configurability layer (migration 0038).
 *
 * The owner's mandate: "admins must have options to enable/disable features
 * whenever there is a functional or technical choice feasible." This module is
 * the single home for those org-wide functional defaults: the load helper the
 * hot paths call (the exact `interception_settings` pattern — one indexed
 * primary-key select per consultation, belt-and-braces singleton creation),
 * the admin-only GET/PUT endpoints (audited, partial update), the derived
 * "effective mode" helpers that hold the CEILING MODEL (org ≥ user — a
 * setting here only ever narrows what happens below it), and the audit-log
 * auto-prune scheduler.
 *
 * ADR-0181 reversed ADR-0021's "a fresh row changes nothing" rule for
 * security settings: a fresh org_settings row now carries the STRICT value of
 * each one, and an admin relaxes a setting through PUT /v1/org/settings,
 * which audits every change old -> new.
 */

import type { FastifyInstance } from "fastify";
import { decryptSecret, encryptSecret } from "./secrets.js";
import {
  and,
  auditLog,
  complianceProfiles,
  connectorRevocations,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  or,
  count,
  orgSettings,
  ORG_SETTINGS_ID,
  pmConnections,
  revocations,
  sql,
  traceRetentionHolds,
  traces,
  users,
  type Db,
  type OrgSettingsRow,
  type SQL,
} from "@regulait/db";
import {
  ACCOUNTABILITY_SETTING_KEYS,
  accountabilitySettingRelaxed,
  alertTicketSettingsProblem,
  type AccountabilitySettingKey,
  INTERNATIONAL_PII_CATEGORIES,
  type InternationalPiiCategory,
  revocationKindParamSchema,
  ruleKindParamSchema,
  setRevocationScopeSchema,
  setRuleDeployModeSchema,
  updateOrgSettingsSchema,
} from "@regulait/shared";
import { z } from "zod";
// ADR-0070: the OTLP export endpoint is an admin-typed outbound URL and takes
// the SAME write-time egress adjudication every other one takes (ADR-0043).
import { checkCredentialBaseUrl } from "./credential-egress.js";
// ADR-0074: `deployMode` is a VERSIONED field on all three restriction-rule
// types, so this PATCH may not write the row directly — it goes through the one
// choke point, which mints and activates a version when the rule is versioned.
import { applyRuleEdit, currentEffectiveBody, isRuleEditRefusal } from "./rule-writes.js";
import { recordSchedulerFailure, recordSchedulerSuccess } from "./scheduler-health.js";
import { evaluateIpEnvelope, isValidCidr } from "./net-policy.js";
import { countEnabledSsoProviders } from "./sso-providers.js";
import { signInInvariantChecked, signInInvariantWritten, withSignInInvariant } from "./break-glass.js";
import { settingTransitions } from "./setting-transitions.js";

export type { OrgSettingsRow };

/** The singleton row, created on first read if migration seeding was skipped
 * (belt-and-braces; 0038 inserts it) — byte-for-byte the
 * loadInterceptionSettings pattern. */
export async function loadOrgSettings(db: Db): Promise<OrgSettingsRow> {
  const [row] = await db.select().from(orgSettings).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  if (row) return row;
  const [created] = await db
    .insert(orgSettings)
    .values({ id: ORG_SETTINGS_ID })
    .onConflictDoNothing()
    .returning();
  if (created) return created;
  const [again] = await db.select().from(orgSettings).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  if (!again) throw new Error("org_settings singleton missing");
  return again;
}

// ---------------------------------------------------------------------------
// the ceiling model — effective routing mode per technique
// ---------------------------------------------------------------------------

export type EffectiveRoutingMode = "automatic" | "passthrough";

/**
 * The one composition rule for every pillar-6 technique:
 *   - org toggle OFF   -> "passthrough" (the org is the ceiling; no per-user
 *     setting can re-enable a technique the org turned off);
 *   - org toggle ON    -> the user's own routingMode when set (a user's
 *     passthrough always wins — narrowing only), else the ORG DEFAULT for
 *     new/unset users (defaultRoutingMode, 'automatic' = today).
 */
export function effectiveTechniqueMode(
  org: OrgSettingsRow,
  techniqueEnabled: boolean,
  userRoutingMode: string | null | undefined,
): EffectiveRoutingMode {
  if (!techniqueEnabled) return "passthrough";
  if (userRoutingMode === "passthrough") return "passthrough";
  if (userRoutingMode === "automatic") return "automatic";
  return org.defaultRoutingMode === "passthrough" ? "passthrough" : "automatic";
}

/** ADR-0021: the org default piiMode an UNCLASSIFIED (or profile-less)
 * project falls back to. ADR-0181: 'block' by default; 'none' (an audited
 * admin relaxation) maps to null = no enforcement. */
export function orgDefaultPiiMode(org: OrgSettingsRow): "block" | "warn" | "log" | null {
  return org.defaultPiiMode === "none" ? null : org.defaultPiiMode;
}

/**
 * ADR-0117: the international national-identifier jurisdictions this
 * deployment detects, filtered to the ones this build actually implements.
 *
 * The filter is not defensive decoration. The column is jsonb and a
 * deployment can be rolled BACK to a build that knows fewer categories than
 * the row lists; an unknown string must then be ignored rather than silently
 * widening or narrowing anything, and it must never reach a detector lookup
 * that would return undefined. Ships empty, so a deployment that has not
 * opted in gets `[]` and `detectPII` never enters the international module.
 */
export function orgPiiInternationalCategories(
  org: OrgSettingsRow,
): readonly InternationalPiiCategory[] {
  const raw = org.piiInternationalCategories ?? [];
  return INTERNATIONAL_PII_CATEGORIES.filter((c) => raw.includes(c));
}

/** ADR-0117: the same value, resolved from the database. This is what the
 * dispatch paths call — one indexed singleton read, exactly as
 * `orgDefaultPiiMode`'s caller already does. */
export async function piiInternationalCategories(
  db: Db,
): Promise<readonly InternationalPiiCategory[]> {
  return orgPiiInternationalCategories(await loadOrgSettings(db));
}

/** ADR-0021: whether the platform-key ENV fallback may engage for `provider`.
 * Gate only — the caller still resolves the env var itself. */
export function envFallbackAllowed(org: OrgSettingsRow, provider: string): boolean {
  if (!org.envKeyFallbackEnabled) return false;
  return (org.envFallbackProviders ?? []).includes(provider);
}

// ---------------------------------------------------------------------------
// audit retention — the global floor, now composed with the org default
// ---------------------------------------------------------------------------

export interface RetentionFloor {
  retainedDays: number | null;
  /** the profile tags (or the marker 'org_default') that set the floor */
  floorSource: string[];
  cutoff: Date | null;
  prunable: number;
  /** A4: the EFFECTIVE per-mode overrides — only those exceeding the global
   * floor (an override at/below the floor is inert under MAX composition) */
  modeOverrides: Array<{ mode: string; retainedDays: number; cutoff: Date }>;
}

/** A4 (migration 0044): the per-mode overrides that actually extend past the
 * global floor. MAX-only by construction: an override <= the floor changes
 * nothing (the floor already retains longer), so it is dropped here — and an
 * override can never shorten anything because it only ever EXCLUDES rows from
 * a prune the global floor would otherwise perform. */
export function effectiveModeOverrides(
  modeAuditRetention: Partial<Record<string, number>> | null | undefined,
  globalRetainedDays: number,
  now: number = Date.now(),
): Array<{ mode: string; retainedDays: number; cutoff: Date }> {
  return Object.entries(modeAuditRetention ?? {})
    .filter((e): e is [string, number] => typeof e[1] === "number" && e[1] > globalRetainedDays)
    .map(([mode, days]) => ({
      mode,
      retainedDays: days,
      cutoff: new Date(now - days * 24 * 3600 * 1000),
    }));
}

/** the prune predicate under the composed floor: older than the global cutoff,
 * EXCEPT rows whose deploy mode has a longer override and are still inside
 * that override's window. Null-mode rows (unknown / pre-0044 / not
 * deploy-scoped) always follow the global floor alone. */
function prunableWhere(
  cutoff: Date,
  overrides: Array<{ mode: string; cutoff: Date }>,
): SQL {
  const conds: SQL[] = [lt(auditLog.at, cutoff)];
  for (const o of overrides) {
    // keep (i.e. exclude from prune) rows of this mode newer than the
    // override's cutoff. NULL-mode rows must NOT be protected — `ne` alone is
    // NULL-poisoned in SQL, hence the explicit isNull arm.
    conds.push(
      or(
        isNull(auditLog.deployMode),
        ne(auditLog.deployMode, o.mode as "hosted" | "byoc" | "air_gapped"),
        lt(auditLog.at, o.cutoff),
      )!,
    );
  }
  return and(...conds)!;
}

/**
 * The global retention floor + how many audit rows currently sit below it.
 * Composition rule (ADR-0021): a compliance-profile floor ALWAYS wins upward —
 * effective = max(profile floor, org defaultAuditRetentionDays). The org
 * default only ADDS a retention where no profile set one; it can never shorten
 * a framework's audit trail. Both null (the default) = nothing is ever
 * eligible for pruning (fail-safe: keep all) — unchanged behaviour.
 */
async function composedRetention(db: Db) {
  const [profiles, org] = await Promise.all([
    db.select().from(complianceProfiles),
    loadOrgSettings(db),
  ]);
  const withDays = profiles.filter(
    (p): p is typeof p & { auditRetentionDays: number } => p.auditRetentionDays != null,
  );
  const profileFloor = withDays.length
    ? withDays.reduce((m, p) => Math.max(m, p.auditRetentionDays), 0)
    : null;
  const orgDays = org.defaultAuditRetentionDays;
  const retainedDays =
    profileFloor != null && orgDays != null
      ? Math.max(profileFloor, orgDays)
      : (profileFloor ?? orgDays);
  return { withDays, org, orgDays, retainedDays };
}

/** ADR-0173 batch 2c (K): the composed §8.3 floor in days (null = no floor,
 * keep everything), without counting prunable rows. A trace retention hold is
 * bounded by it (at most twice the floor, at most three years). */
export async function retentionFloorDays(db: Db): Promise<number | null> {
  return (await composedRetention(db)).retainedDays;
}

export async function retentionFloor(db: Db): Promise<RetentionFloor> {
  const { withDays, org, orgDays, retainedDays } = await composedRetention(db);
  if (retainedDays == null) {
    // no global floor = keep everything = nothing prunable. A4: per-mode
    // overrides are irrelevant here — they can only EXTEND retention, and
    // "keep all" is already the maximum (fail-safe unchanged).
    return { retainedDays: null, floorSource: [], cutoff: null, prunable: 0, modeOverrides: [] };
  }
  const floorSource = withDays
    .filter((p) => p.auditRetentionDays === retainedDays)
    .map((p) => p.tag);
  if (orgDays != null && orgDays === retainedDays) floorSource.push("org_default");
  const cutoff = new Date(Date.now() - retainedDays * 24 * 3600 * 1000);
  // A4: MAX-only per-mode overrides — rows of an overridden mode stay retained
  // for the longer window; everything else prunes under the global floor.
  const modeOverrides = effectiveModeOverrides(org.modeAuditRetention, retainedDays);
  const [row] = await db
    .select({ n: count() })
    .from(auditLog)
    .where(prunableWhere(cutoff, modeOverrides));
  return { retainedDays, floorSource, cutoff, prunable: row?.n ?? 0, modeOverrides };
}

/** One prune pass under the composed floor. Deletes nothing when no floor is
 * set. The prune is itself audited (a meta row newer than every cutoff), with
 * `auto` marking scheduler-driven passes apart from the admin's POST. */
export async function runAuditPruneOnce(
  db: Db,
  actorUserId: string | null,
  auto: boolean,
): Promise<{
  deleted: number;
  /** ADR-0070: traces removed under the SAME §8.3 floor, in the same pass */
  tracesDeleted: number;
  retainedDays: number | null;
  floorSource: string[];
}> {
  const f = await retentionFloor(db);
  if (f.retainedDays == null || f.cutoff == null) {
    return { deleted: 0, tracesDeleted: 0, retainedDays: null, floorSource: [] };
  }
  // A4: prune under the COMPOSED floor — the global cutoff, minus rows a
  // longer per-mode override still retains (MAX-only: never shortens).
  //
  // ADR-0179 review, finding 4 — THE DELETE AND ITS META ROW ARE ONE
  // TRANSACTION. The meta row is the only record that rows were removed, and
  // its cutoff is the replay's lookback horizon (`loadAuditLookbackHorizon`),
  // so a delete committed without it would leave history silently missing and
  // a replay counting a truncated window as complete. Both land or neither.
  const cutoff = f.cutoff;
  const retainedDays = f.retainedDays;
  const deleted = await db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Db;
    const removed = await tx
      .delete(auditLog)
      .where(prunableWhere(cutoff, f.modeOverrides))
      .returning({ id: auditLog.id });
    await tx.insert(auditLog).values({
      userId: actorUserId ?? "00000000-0000-0000-0000-000000000000",
      objectType: "project",
      objectId: null,
      detail: {
        phase: "audit-retention-prune",
        deleted: removed.length,
        retainedDays,
        floorSource: f.floorSource,
        cutoff,
        ...(f.modeOverrides.length
          ? {
              modeOverrides: f.modeOverrides.map((o) => ({
                mode: o.mode,
                retainedDays: o.retainedDays,
              })),
            }
          : {}),
        ...(auto ? { auto: true } : {}),
      },
      effect: "allow",
      ruleId: "audit-log-pruned",
      ruleChain: [],
      reason: `pruned ${removed.length} audit row(s) older than ${retainedDays}d (floor from [${f.floorSource.join(", ")}])${auto ? " — scheduled auto-prune" : ""}`,
    });
    return removed;
  });
  // ADR-0070 — TRACES PRUNE ON THE SAME FLOOR, IN THE SAME PASS.
  //
  // This is why migration 0082 added no trace-retention knob. A span carries
  // prompts, tool arguments and outputs — the most sensitive data in this
  // system — and a separate dial would let an operator keep them for a year
  // under a framework whose cascade says ninety days. So trace retention IS the
  // §8.3 audit-retention floor, composed exactly the same way, applied here.
  //
  // The per-deploy-mode overrides above are deliberately NOT applied: they key
  // off `audit_log.deploy_mode`, which a trace has no equivalent of, and
  // inventing one would mean guessing. The global floor is used, which is the
  // SHORTER of the two and therefore the safe direction. Spans go with their
  // trace by ON DELETE CASCADE — one delete, no orphans.
  //
  // ADR-0173 batch 2c (K) — RETENTION HOLDS. A trace an automation rule held
  // (`trace_retention_holds`, at most 2x this floor and 3 years) is skipped
  // while its hold is live and unreleased, and deleted by the first pass after
  // the hold expires. A hold an erasure request released protects nothing.
  let tracesDeleted = 0;
  try {
    const removed = await db
      .delete(traces)
      .where(
        and(
          lt(traces.startedAt, f.cutoff),
          sql`not exists (select 1 from ${traceRetentionHolds} where ${traceRetentionHolds.traceId} = ${traces.id} and ${traceRetentionHolds.releasedAt} is null and ${traceRetentionHolds.holdUntil} > ${new Date().toISOString()}::timestamptz)`,
        ),
      )
      .returning({ id: traces.id });
    tracesDeleted = removed.length;
  } catch {
    // never let trace pruning fail the audit prune it rides along with
    tracesDeleted = 0;
  }
  return {
    deleted: deleted.length,
    tracesDeleted,
    retainedDays: f.retainedDays,
    floorSource: f.floorSource,
  };
}

/**
 * Boot-scheduled auto-prune (ADR-0021). OFF by default (autoPruneEnabled=false
 * = today's manual-POST-only behaviour). The timer ticks hourly (unref'd so it
 * never keeps a test process alive), re-reads the settings each tick — so an
 * admin's change takes effect without a restart — and prunes when the
 * configured interval has elapsed since the last pass. Returns the stop
 * function the app's onClose hook calls.
 */
export interface SchedulerTickState {
  lastRunAt: number;
}

/** ONE tick of the auto-prune scheduler. Exported so a test can drive it
 * without waiting an hour — the timer below is the only other caller. */
export async function auditPruneTick(db: Db, state: SchedulerTickState): Promise<void> {
  try {
    const org = await loadOrgSettings(db);
    if (!org.autoPruneEnabled) return;
    const intervalMs = Math.max(1, org.pruneIntervalHours) * 3600 * 1000;
    if (Date.now() - state.lastRunAt < intervalMs) return;
    state.lastRunAt = Date.now();
    await runAuditPruneOnce(db, null, true);
    recordSchedulerSuccess("audit-prune");
  } catch (err) {
    // ADR-0031 item 6: a failed pass still never crashes the gateway and the
    // next tick still retries — but it is no longer INVISIBLE. This logs,
    // marks the scheduler unhealthy on /v1/health/schedulers, and writes an
    // audit row; it never throws.
    await recordSchedulerFailure(db, "audit-prune", err);
  }
}

export function startAuditPruneScheduler(db: Db): () => void {
  const state: SchedulerTickState = { lastRunAt: 0 };
  const timer = setInterval(() => void auditPruneTick(db, state), 3600 * 1000);
  timer.unref?.();
  return () => clearInterval(timer);
}

// ---------------------------------------------------------------------------
// admin endpoints — GET/PUT /v1/org/settings
// ---------------------------------------------------------------------------

/** the providers the env fallback can ever resolve, mirroring
 * ENV_FALLBACK_PROVIDERS in agents-connectors (kept local to avoid an import
 * cycle — agents-connectors imports this module) */
const ENV_KEY_NAMES: ReadonlyArray<{ provider: string; envVar: string; aliases: string[] }> = [
  { provider: "anthropic", envVar: "ANTHROPIC_API_KEY", aliases: [] },
  { provider: "openai", envVar: "OPENAI_API_KEY", aliases: [] },
  { provider: "google", envVar: "GOOGLE_API_KEY", aliases: ["GEMINI_API_KEY"] },
  { provider: "xai", envVar: "XAI_API_KEY", aliases: [] },
];

/** which conventional platform-key env vars are currently PRESENT on this
 * server — names and booleans ONLY, never a value. The admin UI shows this so
 * "turn the env fallback off" is an informed decision. */
export function envKeyPresence(): Array<{ provider: string; envVar: string; present: boolean }> {
  return ENV_KEY_NAMES.map(({ provider, envVar, aliases }) => {
    const names = [envVar, ...aliases];
    const setName = names.find((n) => (process.env[n]?.length ?? 0) > 0);
    return { provider, envVar: setName ?? envVar, present: setName !== undefined };
  });
}

/** GET/PUT the org-wide functional defaults. ADMIN-ONLY — deliberately absent
 * from NON_ADMIN_ROUTES, exactly like the interception settings endpoints.
 * PUT is a partial update; every write is audited (objectType org_settings)
 * with the changed keys in the detail. */
/**
 * ADR-0070 — the ONE redaction this settings surface performs. An OTLP
 * collector header is conventionally a bearer token, and this endpoint is
 * admin-readable, so the VALUES never leave: the key names do (an operator has
 * to be able to see which headers are set) and each value renders as a fixed
 * marker. Same discipline as every credential surface in this codebase — the
 * write is accepted, the read never returns the secret.
 */
export function redactSettings(row: OrgSettingsRow): OrgSettingsRow {
  const headers = row.tracingOtlpHeaders as Record<string, string> | null;
  // the envelope is not a secret, but it is not a setting either — it never
  // leaves on the read
  const base = { ...row, tracingOtlpHeadersCiphertext: null };
  if (!headers) return base;
  return { ...base, tracingOtlpHeaders: otlpHeaderMarkers(headers) };
}

// ---------------------------------------------------------------------------
// ADR-0167 (SEC-06) — the OTLP collector headers are a CREDENTIAL.
//
// They were plaintext jsonb: readable from a pg_dump, outside the
// REGULAIT_DATA_KEY custody story (ADR-0063), untouched by a key rotation.
// Since migration 0128 the VALUES live in `tracing_otlp_headers_ciphertext`
// as one envelope over the JSON map, and the jsonb column carries only the
// header NAMES with every value replaced by the marker below — so the settings
// screen still lists which headers are set, and the hash-chained audit row an
// update writes carries the marker map, never a token.
// ---------------------------------------------------------------------------

/** the value every header carries in the jsonb column and on every read */
export const OTLP_HEADER_MARKER = "[redacted]";

export function otlpHeaderMarkers(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.keys(headers).map((k) => [k, OTLP_HEADER_MARKER]));
}

/** the two columns a settings write sets for the submitted `tracingOtlpHeaders` */
export function otlpHeadersForWrite(
  headers: Record<string, string> | null | undefined,
  dataKey: string | undefined,
):
  | { ok: true; columns: { tracingOtlpHeaders?: Record<string, string> | null; tracingOtlpHeadersCiphertext?: string | null } }
  | { ok: false } {
  if (headers === undefined) return { ok: true, columns: {} };
  if (headers === null || Object.keys(headers).length === 0) {
    return { ok: true, columns: { tracingOtlpHeaders: null, tracingOtlpHeadersCiphertext: null } };
  }
  if (!dataKey) return { ok: false };
  return {
    ok: true,
    columns: {
      tracingOtlpHeaders: otlpHeaderMarkers(headers),
      tracingOtlpHeadersCiphertext: encryptSecret(dataKey, JSON.stringify(headers)),
    },
  };
}

/**
 * The REAL headers, for the one place they are used: the export request.
 * Decrypts the envelope when there is one; a pre-0128 row that was never
 * backfilled (no key at boot) still exports its plaintext values, because
 * refusing would turn an upgrade into an outage with nothing gained.
 */
export function otlpHeadersForExport(
  org: Pick<OrgSettingsRow, "tracingOtlpHeaders" | "tracingOtlpHeadersCiphertext">,
  dataKey: string | undefined,
): { ok: true; headers: Record<string, string> } | { ok: false; detail: string } {
  if (org.tracingOtlpHeadersCiphertext) {
    if (!dataKey) {
      return {
        ok: false,
        detail:
          "the OTLP collector headers are stored under REGULAIT_DATA_KEY, which this process does not hold — set it before exporting",
      };
    }
    const parsed = JSON.parse(decryptSecret(dataKey, org.tracingOtlpHeadersCiphertext)) as Record<string, string>;
    return { ok: true, headers: parsed };
  }
  const legacy = (org.tracingOtlpHeaders ?? {}) as Record<string, string>;
  return {
    ok: true,
    headers: Object.fromEntries(Object.entries(legacy).filter(([, v]) => v !== OTLP_HEADER_MARKER)),
  };
}

/**
 * Boot-time backfill: a row whose jsonb still carries real values and whose
 * envelope is empty is a pre-0128 deployment — envelope it now. Idempotent;
 * a second call finds nothing to do. Called from boot.ts after the data-key
 * gate, so the key it uses is the one the deployment has just proved.
 */
export async function backfillOtlpHeaderCiphertext(db: Db, dataKey: string): Promise<"enveloped" | "nothing"> {
  const [row] = await db.select().from(orgSettings).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  if (!row || row.tracingOtlpHeadersCiphertext) return "nothing";
  const legacy = row.tracingOtlpHeaders as Record<string, string> | null;
  if (!legacy) return "nothing";
  const real = Object.fromEntries(Object.entries(legacy).filter(([, v]) => v !== OTLP_HEADER_MARKER));
  if (Object.keys(real).length === 0) return "nothing";
  await db
    .update(orgSettings)
    .set({
      tracingOtlpHeaders: otlpHeaderMarkers(real),
      tracingOtlpHeadersCiphertext: encryptSecret(dataKey, JSON.stringify(real)),
    })
    .where(eq(orgSettings.id, ORG_SETTINGS_ID));
  return "enveloped";
}

function approvalTtlPosture(row: OrgSettingsRow): "bounded" | "nonexpiring_high_risk" {
  return row.approvalTtlHours == null ? "nonexpiring_high_risk" : "bounded";
}

/** true when a settings write can change who is able to sign in */
function touchesSignIn(body: { ssoOnly?: unknown; localSignIn?: unknown; breakGlassUserIds?: unknown }): boolean {
  return body.ssoOnly !== undefined || body.localSignIn !== undefined || body.breakGlassUserIds !== undefined;
}

/**
 * The sign-in lockout guards on an org-settings write, over the row RE-READ
 * under the sign-in invariant lock (`withSignInInvariant`, AER-056). Returns
 * the refusal (status + body; nothing is saved) or null.
 *
 *  - ADR-0025/0036: sso_only without a single enabled SSO provider would
 *    strand every human login behind a door that does not exist. OIDC and
 *    SAML are co-equal federated paths, so the count covers both, through the
 *    SAME helper the provider CRUD surfaces use — two copies would drift.
 *  - ADR-0174 — break-glass local sign-in. Every named break-glass account
 *    must be a real, ACTIVE ADMIN; and the mode may only engage when somebody
 *    can still get in: at least one enabled SSO provider (the front door) and
 *    at least one break-glass admin with a password (the spare key). Checked
 *    over the MERGED values, like the API-key TTL dials.
 */
async function signInModeRefusal(
  tx: Pick<Db, "select">,
  locked: OrgSettingsRow,
  body: { ssoOnly?: boolean; localSignIn?: OrgSettingsRow["localSignIn"]; breakGlassUserIds?: string[] | null },
): Promise<{ status: 422; body: Record<string, unknown> } | null> {
  if (body.ssoOnly === true) {
    const enabled = await countEnabledSsoProviders(tx);
    if (enabled.total === 0) {
      return {
        status: 422,
        body: {
          error: "sso_only_needs_a_provider",
          detail:
            "enable at least one SSO provider (OIDC or SAML) before turning sso_only on — otherwise nobody can sign in",
        },
      };
    }
  }
  if (body.breakGlassUserIds && body.breakGlassUserIds.length > 0) {
    const ids = [...new Set(body.breakGlassUserIds)];
    const found = await tx
      .select({ id: users.id, isAdmin: users.isAdmin, disabledAt: users.disabledAt })
      .from(users)
      .where(inArray(users.id, ids));
    const bad = ids.filter((id) => {
      const u = found.find((f) => f.id === id);
      return !u || !u.isAdmin || u.disabledAt !== null;
    });
    if (bad.length > 0) {
      return {
        status: 422,
        body: {
          error: "invalid_break_glass_user",
          detail: "every break-glass account must be an existing, active administrator — nothing was saved",
          invalid: bad,
        },
      };
    }
  }
  if (body.localSignIn !== undefined || body.breakGlassUserIds !== undefined) {
    const nextMode = body.localSignIn ?? locked.localSignIn;
    const nextIds = body.breakGlassUserIds !== undefined ? body.breakGlassUserIds : locked.breakGlassUserIds;
    if (nextMode === "break_glass_only") {
      const enabled = await countEnabledSsoProviders(tx);
      if (enabled.total === 0) {
        return {
          status: 422,
          body: {
            error: "break_glass_needs_sso_provider",
            detail:
              "enable at least one SSO provider (OIDC or SAML) before restricting email sign-in to break-glass admins — otherwise only they could sign in",
          },
        };
      }
      const usable =
        nextIds && nextIds.length > 0
          ? await tx
              .select({ id: users.id })
              .from(users)
              .where(
                and(
                  inArray(users.id, nextIds),
                  eq(users.isAdmin, true),
                  isNull(users.disabledAt),
                  isNotNull(users.passwordHash),
                ),
              )
          : [];
      if (usable.length === 0) {
        return {
          status: 422,
          body: {
            error: "break_glass_needs_admin",
            detail:
              "name at least one active administrator who has a password as a break-glass account before restricting email sign-in",
          },
        };
      }
    }
  }
  return null;
}

/** ADR-0182 (D4): which of the changed keys are accountability settings now
 * set looser than their strict default (`ACCOUNTABILITY_SETTING_COPY` says
 * what each one gives up) */
export function relaxedAccountabilityKeys(changed: Record<string, unknown>): AccountabilitySettingKey[] {
  return ACCOUNTABILITY_SETTING_KEYS.filter(
    (k) => k in changed && accountabilitySettingRelaxed(k, changed[k] as never),
  );
}

export function registerOrgSettingsRoutes(app: FastifyInstance, db: Db, opts: { dataKey?: string } = {}) {
  app.get("/v1/org/settings", async () => {
    const settings = await loadOrgSettings(db);
    return { settings: redactSettings(settings), approvalTtlPosture: approvalTtlPosture(settings), envKeys: envKeyPresence() };
  });

  app.put("/v1/org/settings", async (req, reply) => {
    // ADR-0039: confirmIpLockout is a write-only confirm flag for the
    // self-lockout guard below — stripped here so it never reaches the row.
    const { confirmIpLockout, ...body } = updateOrgSettingsSchema.parse(req.body);
    // ADR-0022: the default infra-remediation approver must be a real, ACTIVE
    // user — a disabled or unknown default would silently dead-letter every
    // proposed remediation.
    if (body.infraApproverUserId) {
      const [approver] = await db
        .select({ id: users.id, disabledAt: users.disabledAt })
        .from(users)
        .where(eq(users.id, body.infraApproverUserId));
      if (!approver) return reply.status(422).send({ error: "unknown_approver" });
      if (approver.disabledAt) {
        return reply.status(422).send({
          error: "approver_disabled",
          detail: "the chosen infra approver account is deactivated",
        });
      }
    }
    // The sign-in lockout guards (ADR-0025/0036 sso_only, ADR-0174
    // break-glass) run further down, INSIDE the sign-in invariant lock, over
    // the row as re-read under that lock (AER-056). `before` here serves only
    // the checks that do not count sign-in doors.
    const before = await loadOrgSettings(db);
    // ADR-0039: CIDR blocks are validated at WRITE time — a malformed block
    // would silently match nothing at evaluation time (fail closed per
    // entry), so the honest failure is a 400 here, before anything is saved.
    if (body.sessionIpAllowlist) {
      const bad = body.sessionIpAllowlist.filter((c) => !isValidCidr(c));
      if (bad.length > 0) {
        return reply.status(400).send({
          error: "invalid_cidr",
          detail: `malformed CIDR block(s): ${bad.join(", ")} — nothing was saved`,
          invalid: bad,
        });
      }
    }
    // ADR-0039 self-lockout guard (mirrors the sso_only guard above): saving
    // an enforce_continuous posture whose allow-list excludes the admin's OWN
    // current IP would revoke their session on their next request — refused
    // unless the explicit confirm flag rides along, so a fat-fingered block
    // cannot strand every admin out of the portal. (The BYOC/air-gapped
    // operator recovery is the deploy-time bootstrap token, which ADR-0039
    // keeps exempt from IP policy by design.)
    if (body.sessionIpPolicy !== undefined || body.sessionIpAllowlist !== undefined) {
      const nextPolicy = body.sessionIpPolicy ?? before.sessionIpPolicy;
      const nextList =
        body.sessionIpAllowlist !== undefined ? body.sessionIpAllowlist : before.sessionIpAllowlist;
      if (nextPolicy === "enforce_continuous" && nextList && nextList.length > 0) {
        const decision = evaluateIpEnvelope(nextList, req.ip ?? null);
        if (!decision.allowed && confirmIpLockout !== true) {
          return reply.status(409).send({
            error: "ip_policy_lockout",
            detail: `enforce_continuous with this allow-list excludes your own current IP (${req.ip ?? "undeterminable"}) — your session would be revoked on your next request. Pass confirmIpLockout: true to save anyway.`,
            clientIp: req.ip ?? null,
          });
        }
      }
    }
    // ADR-0098 — the two API-key lifetime dials must stay coherent WITH EACH
    // OTHER AND WITH THE ROW ALREADY SAVED. A PATCH that lowers the ceiling
    // below an existing default (or raises the default above an existing
    // ceiling) would leave every no-argument issuance refusing itself, so the
    // check runs over the MERGED values, not just the submitted ones. The
    // database holds the same rule as a CHECK constraint; this is the honest
    // 422 an admin sees instead of a 500.
    if (body.apiKeyDefaultTtlDays !== undefined || body.apiKeyMaxTtlDays !== undefined) {
      const nextDefault =
        body.apiKeyDefaultTtlDays !== undefined ? body.apiKeyDefaultTtlDays : before.apiKeyDefaultTtlDays;
      const nextMax =
        body.apiKeyMaxTtlDays !== undefined ? body.apiKeyMaxTtlDays : before.apiKeyMaxTtlDays;
      if (nextDefault !== null && nextMax !== null && nextDefault > nextMax) {
        return reply.status(422).send({
          error: "api_key_ttl_ordering",
          detail:
            `apiKeyDefaultTtlDays (${nextDefault}) cannot exceed apiKeyMaxTtlDays (${nextMax}) — ` +
            `every key issued with no explicit expiry would be refused by the ceiling it was given. Nothing was saved.`,
        });
      }
    }
    // ADR-0182 S5 (PF-14): automatic alert tickets go to the ONE PM connection
    // an admin named — never an implicit choice (ADR-0180). Checked over the
    // MERGED values, so auto_high needs the connection in this write or an
    // earlier one.
    if (body.alertTicketMode !== undefined || body.alertTicketConnectionId !== undefined) {
      const mode = body.alertTicketMode ?? before.alertTicketMode;
      const connectionId =
        body.alertTicketConnectionId !== undefined ? body.alertTicketConnectionId : before.alertTicketConnectionId;
      const [conn] = connectionId
        ? await db.select({ id: pmConnections.id }).from(pmConnections).where(eq(pmConnections.id, connectionId))
        : [];
      const problem = alertTicketSettingsProblem({ mode, connectionId, connectionExists: Boolean(conn) });
      if (problem) return reply.status(422).send(problem);
    }
    // ADR-0070 — THE OTLP ENDPOINT IS AN ADMIN-TYPED OUTBOUND URL, so it goes
    // behind ADR-0043's guard at WRITE time exactly as `mcp_servers.url` and
    // `oidc_providers.issuerUrl` do. Refusing here means an operator learns the
    // host is not allow-listed while they are configuring it, rather than at
    // 3am when an export silently 403s. It is re-adjudicated on every export
    // anyway (DNS can be re-pointed, an allow entry can be withdrawn) — this is
    // the early, honest failure, not the enforcement point.
    if (body.tracingOtlpEndpoint) {
      const { decision } = await checkCredentialBaseUrl(db, body.tracingOtlpEndpoint);
      if (!decision.ok) {
        return reply.status(400).send({
          error: "egress_blocked",
          detail:
            `the OTLP endpoint was refused by the egress guard: ${decision.reason}. Nothing was saved. ` +
            `Add the host to the egress allow-list first — RegulAIt does not open an outbound ` +
            `telemetry connection to a destination no admin approved.`,
        });
      }
    }
    // ADR-0167 (SEC-06): the collector headers are enveloped before they touch
    // the row; without a data key they are refused rather than stored in the
    // clear, exactly as a connector credential is.
    const otlpWrite = otlpHeadersForWrite(body.tracingOtlpHeaders, opts.dataKey);
    if (!otlpWrite.ok) {
      return reply.status(503).send({
        error: "no_data_key",
        detail:
          "set REGULAIT_DATA_KEY before storing OTLP collector headers — they are a credential and are stored enveloped, never in the clear. Nothing was saved.",
      });
    }
    // AER-056: the sign-in lockout guards, the write and its audit row are one
    // transaction under the sign-in invariant lock, so engaging (or
    // re-pointing) break-glass / sso_only cannot race a provider disable, a
    // demotion or a SCIM deactivation that each passed their own count.
    const out = await withSignInInvariant(db, async (tx, locked) => {
      const refusal = await signInModeRefusal(tx, locked, body);
      if (refusal) return refusal;
      if (touchesSignIn(body)) await signInInvariantChecked("org-settings");
      const [row] = await tx
        .update(orgSettings)
        .set({
          ...body,
          ...otlpWrite.columns,
          updatedBy: req.authCtx.userId,
          updatedAt: new Date(),
        })
        .where(eq(orgSettings.id, ORG_SETTINGS_ID))
        .returning();
      if (touchesSignIn(body)) await signInInvariantWritten("org-settings");
      const after = row ?? locked;
      // the audit row is hash-chained and admin-readable: the submitted header
      // VALUES must not land in it, so the diff carries the marker map
      const submitted: Record<string, unknown> = {
        ...body,
        ...(body.tracingOtlpHeaders ? { tracingOtlpHeaders: otlpHeaderMarkers(body.tracingOtlpHeaders) } : {}),
      };
      const changed = Object.fromEntries(
        Object.entries(submitted).filter(
          ([k, v]) => JSON.stringify((locked as Record<string, unknown>)[k]) !== JSON.stringify(v),
        ),
      );
      // ADR-0181: every relaxation of a strict default is audited old -> new,
      // from the same redacted view as `after` (no credential material).
      const lockedRedacted = redactSettings(locked) as unknown as Record<string, unknown>;
      // ADR-0182 (D4): the accountability settings this write leaves RELAXED
      // from their strict default, named in the detail and the reason
      const relaxed = relaxedAccountabilityKeys(changed);
      await tx.insert(auditLog).values({
        // bootstrap has no user identity; the nil uuid marks a non-user actor,
        // as elsewhere in the codebase, and `via` records which it was.
        userId: req.authCtx.userId ?? "00000000-0000-0000-0000-000000000000",
        objectType: "org_settings",
        objectId: null,
        // ADR-0181: a relaxation is legible as old -> new. `transitions` holds
        // {from, to} per changed key, taken from the same redacted row as `after`.
        detail: {
          via: req.authCtx.via,
          changed,
          transitions: settingTransitions(lockedRedacted, changed, ["tracingOtlpHeaders"]),
          ...(relaxed.length > 0 ? { relaxed } : {}),
          after: redactSettings(after),
          approvalTtlPosture: approvalTtlPosture(after),
        },
        effect: "allow",
        ruleId: "org-settings-updated",
        ruleChain: [],
        reason:
          (Object.keys(changed).length > 0
            ? `org settings updated: ${Object.keys(changed).join(", ")}`
            : "org settings written with no effective change") +
          (relaxed.length > 0 ? ` — RELAXED from the strict default: ${relaxed.join(", ")}` : ""),
      });
      return { after };
    });
    if ("status" in out) return reply.status(out.status).send(out.body);
    const { after } = out;
    return reply.send({ settings: redactSettings(after), approvalTtlPosture: approvalTtlPosture(after) });
  });

  // -------------------------------------------------------------------------
  // A4 (ADR-0027) — deploy-mode scope on pillar-1 restriction rules.
  // Admin-only like everything in this module. Registered here (an existing
  // admin governance module) rather than beside the rule POSTs: setting the
  // mode scope is a policy-posture edit, and this keeps the rule-creation
  // endpoints byte-identical (default = mode-unscoped = today).
  // -------------------------------------------------------------------------
  /**
   * ADR-0074 — the rule kind an admin names in the URL, mapped to the
   * `config_versions` ARTIFACT TYPE rather than to a drizzle table.
   *
   * The table map this used to be was the reason the defect was invisible to a
   * naive `.update(approvalRules)` grep: the write went through a local
   * variable. `deployMode` is a VERSIONED field for all three types, so the
   * write now goes through the one choke point and mints a version when the
   * artifact is versioned.
   */
  const RULE_ARTIFACT_TYPES = {
    approvals: "approval_rule",
    "rate-limits": "rate_limit",
    "data-scopes": "data_scope_rule",
  } as const;

  app.patch("/v1/rules/:kind/:ruleId/deploy-mode", async (req, reply) => {
    const { kind, ruleId } = z
      .object({ kind: ruleKindParamSchema, ruleId: z.string().uuid() })
      .parse(req.params);
    const body = setRuleDeployModeSchema.parse(req.body);
    // read the current scope first, so the audit row keeps the before/after
    // pair A4 shipped — the choke point adds the versioning half beside it
    // rather than replacing a record somebody already reads
    const beforeMode =
      ((await currentEffectiveBody(db, RULE_ARTIFACT_TYPES[kind], ruleId))?.deployMode as string | null) ?? null;
    const res = await applyRuleEdit<{ id: string; deployMode: string | null }>(db, {
      artifactType: RULE_ARTIFACT_TYPES[kind],
      artifactId: ruleId,
      patch: { deployMode: body.deployMode ?? null },
      actorUserId: req.authCtx.userId ?? null,
      label: `deploy-mode set via PATCH /v1/rules/${kind}/:id/deploy-mode`,
      reason:
        body.deployMode == null
          ? `${kind} rule deploy-mode scope cleared (mode-unscoped — applies to every call)`
          : `${kind} rule scoped to deploy mode '${body.deployMode}'`,
      auditObjectType: "restriction_rule",
      auditRuleId: "rule-deploy-mode-set",
      auditDetail: {
        phase: "rule-deploy-mode",
        ruleKind: kind,
        before: beforeMode,
        after: body.deployMode ?? null,
      },
    });
    if (isRuleEditRefusal(res)) {
      return reply.status(res.status).send({ error: res.error, detail: res.detail });
    }
    return reply.send({ ...res.row, versionMinted: res.mintedVersion, note: res.note });
  });

  // -------------------------------------------------------------------------
  // O9 (ADR-0027) — partial revocations. A revocation is CREATED total
  // ('full', the ADR-0019 semantics); this admin-only edit narrows it to
  // read_only (write-classified tools/ops denied, reads allowed) or restores
  // full. MCP + connector revocations only — agent revocations have no
  // read/write op classification to scope by.
  // -------------------------------------------------------------------------
  const REVOCATION_TABLES = { mcp: revocations, connectors: connectorRevocations } as const;

  app.patch("/v1/revocations/:kind/:revocationId/scope", async (req, reply) => {
    const { kind, revocationId } = z
      .object({ kind: revocationKindParamSchema, revocationId: z.string().uuid() })
      .parse(req.params);
    const body = setRevocationScopeSchema.parse(req.body);
    const table = REVOCATION_TABLES[kind];
    const [before] = await db.select().from(table).where(eq(table.id, revocationId));
    if (!before) return reply.status(404).send({ error: "unknown_revocation" });
    const [row] = await db
      .update(table)
      .set({ scope: body.scope })
      .where(eq(table.id, revocationId))
      .returning();
    await db.insert(auditLog).values({
      userId: req.authCtx.userId ?? "00000000-0000-0000-0000-000000000000",
      objectType: "revocation",
      objectId: revocationId,
      detail: { phase: "revocation-scope", revocationKind: kind, before: before.scope, after: body.scope },
      effect: "allow",
      ruleId: "revocation-scope-set",
      ruleChain: [],
      reason:
        body.scope === "read_only"
          ? `${kind} revocation '${revocationId}' narrowed to read_only — write-classified ${kind === "mcp" ? "tools" : "operations"} stay denied, reads are allowed again`
          : `${kind} revocation '${revocationId}' restored to full — every ${kind === "mcp" ? "tool" : "operation"} denied (the ADR-0019 total semantics)`,
    });
    return reply.send(row);
  });
}
