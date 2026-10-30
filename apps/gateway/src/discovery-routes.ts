/**
 * ADR-0195 SD0 — THE DISCOVERY ADMIN ROUTES. Admin-only (none is in
 * NON_ADMIN_ROUTES), every write audited.
 *
 *   GET    /v1/discovery/scanners                         which source kinds have a scanner built (none in SD0)
 *   GET    /v1/discovery/sources                          every source, its credential's metadata, its last run, the posture
 *   POST   /v1/discovery/sources                          create (always disabled; only a kind whose scanner is built)
 *   PATCH  /v1/discovery/sources/:sourceId                edit (compare-and-set on `version`); widening an ENABLED
 *                                                         source's target or scope is the enable step-up
 *   POST   /v1/discovery/sources/:sourceId/enable         `settings_relax` step-up bound to kind, target and scope (CAS)
 *   POST   /v1/discovery/sources/:sourceId/disable        free, always
 *   DELETE /v1/discovery/sources/:sourceId                a disabled source with no live run
 *   PUT    /v1/discovery/sources/:sourceId/credential     federated: free; static: `settings_relax` step-up. CAS on
 *                                                         `replacesCredentialId`. The secret is never returned.
 *                                                         An omitted `mode` is the kind's secure default (A5).
 *   DELETE /v1/discovery/sources/:sourceId/credential     revoke: free; the stored secret is destroyed
 *   POST   /v1/discovery/sources/:sourceId/runs           run now (queues a run; the scan worker takes it)
 *   GET    /v1/discovery/runs                             recent runs, optionally for one source
 *   GET    /v1/discovery/settings                         the warning age and the endpoint retention
 *   PUT    /v1/discovery/settings                         lengthening either is a `settings_relax` step-up (CAS)
 *                                                     turning a wider-source family on (ADR-0218) is the same step-up
 *   POST   /v1/discovery/pseudonyms/:pseudonym/reveal     a `pseudonym_reveal` step-up, audited
 *
 * THE SECRET NEVER LEAVES. No view below returns `secret_ciphertext` or the
 * secret; a credential is described by its mode, its public config (an
 * allowlist of identifier fields per kind and mode, each shape-checked, so no
 * secret can be smuggled in as "public"), whether it holds a secret, its age
 * and its write-scope state.
 *
 * Step-ups follow the ADR-0186 A pattern: the row is locked, the
 * compare-and-set is checked, and only then is the grant spent, so a stale
 * request never burns a grant and a grant is never spent on a write that does
 * not happen.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  and,
  auditLog,
  desc,
  discoveryCredentials,
  discoveryPseudonyms,
  discoveryRuns,
  discoverySettings,
  discoverySources,
  eq,
  inArray,
  isNull,
  sql,
  type Db,
  type DiscoveryCredentialRow,
  type DiscoveryRunRow,
  type DiscoverySourceRow,
} from "@regulait/db";
import {
  DISCOVERY_CREDENTIAL_MODES,
  DISCOVERY_CREDENTIAL_WARNING_MAX_DAYS,
  DISCOVERY_CREDENTIAL_WARNING_MIN_DAYS,
  DISCOVERY_ENDPOINT_RETENTION_MAX_DAYS,
  DISCOVERY_ENDPOINT_RETENTION_MIN_DAYS,
  DISCOVERY_KIND_SPECS,
  DISCOVERY_SCHEDULE_DEFAULT_SECONDS,
  DISCOVERY_SCHEDULE_MAX_SECONDS,
  DISCOVERY_SCHEDULE_MIN_SECONDS,
  DISCOVERY_SOURCE_KINDS,
  DISCOVERY_STEP_UP_KEYS,
  credentialTargetMatch,
  publicConfigProblem,
  defaultCredentialMode,
  scopeWidens,
  DISCOVERY_GATED_FAMILIES,
  familySwitchProblem,
} from "@regulait/shared";
import { checkStepUp, isStepUpPrompt, type StepUpCheckArgs } from "./step-up.js";
import { decryptSecret, encryptSecret } from "./secrets.js";
import { DISCOVERY_SCANNERS, type ScannerRegistry } from "./discovery-scanners.js";
import { discoveryPosture, loadDiscoverySettings } from "./discovery-posture.js";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

// ---------------------------------------------------------------------------
// request schemas
// ---------------------------------------------------------------------------

/** a config key: a short identifier (a linear check: one character class, bounded) */
const configKey = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,39}$/);
const targetSchema = z
  .record(configKey, z.string().trim().min(1).max(512))
  .refine((t) => Object.keys(t).length >= 1 && Object.keys(t).length <= 10, { message: "a target has 1 to 10 fields" });
const scopeSchema = z
  .object({
    orgLevel: z.boolean(),
    include: z.array(z.string().trim().min(1).max(256)).max(500),
  })
  .strict()
  .refine((s) => s.orgLevel || s.include.length > 0, { message: "name at least one item to scan, or choose the organisation-level scope" });
const scheduleSchema = z.number().int().min(DISCOVERY_SCHEDULE_MIN_SECONDS).max(DISCOVERY_SCHEDULE_MAX_SECONDS);
const nameSchema = z.string().trim().min(1).max(120);

const createSchema = z
  .object({
    name: nameSchema,
    kind: z.enum(DISCOVERY_SOURCE_KINDS),
    target: targetSchema,
    scope: scopeSchema,
    scheduleIntervalSeconds: scheduleSchema.optional(),
  })
  .strict();
const patchSchema = z
  .object({
    version: z.number().int().min(1),
    name: nameSchema.optional(),
    target: targetSchema.optional(),
    scope: scopeSchema.optional(),
    scheduleIntervalSeconds: scheduleSchema.optional(),
  })
  .strict();
const versionSchema = z.object({ version: z.number().int().min(1) }).strict();
const credentialSchema = z
  .object({
    // ADR-0195 A5: omitted = the kind's secure default (federated where the provider supports it)
    mode: z.enum(DISCOVERY_CREDENTIAL_MODES).optional(),
    // checked against the kind's allowlist (DISCOVERY_PUBLIC_CONFIG) in the route
    publicConfig: z
      .record(configKey, z.string().trim().min(1).max(1024))
      .refine((c) => Object.keys(c).length <= 20, { message: "at most 20 public config fields" })
      .default({}),
    secret: z.string().min(1).max(16384).optional(),
    replacesCredentialId: z.string().uuid().nullable(),
  })
  .strict();
const settingsSchema = z
  .object({
    version: z.number().int().min(1),
    credentialWarningAgeDays: z.number().int().min(DISCOVERY_CREDENTIAL_WARNING_MIN_DAYS).max(DISCOVERY_CREDENTIAL_WARNING_MAX_DAYS).optional(),
    endpointRetentionDays: z.number().int().min(DISCOVERY_ENDPOINT_RETENTION_MIN_DAYS).max(DISCOVERY_ENDPOINT_RETENTION_MAX_DAYS).optional(),
    // ADR-0218: the wider-source family switches; turning one on is a relaxation, turning one off is free
    families: z
      .object({ saas: z.boolean().optional(), identity: z.boolean().optional(), ml_platform: z.boolean().optional() })
      .strict()
      .optional(),
  })
  .strict();
const uuidParam = z.object({ sourceId: z.string().uuid() });
const pseudonymParam = z.object({ pseudonym: z.string().regex(/^psn:[0-9a-f]{24}$/) });
const runsQuery = z.object({ sourceId: z.string().uuid().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) });

// ---------------------------------------------------------------------------
// views (never the secret)
// ---------------------------------------------------------------------------

export interface DiscoveryCredentialView {
  id: string;
  mode: DiscoveryCredentialRow["credentialMode"];
  publicConfig: Record<string, string>;
  hasSecret: boolean;
  writeScope: DiscoveryCredentialRow["writeScope"];
  createdAt: string;
  ageDays: number;
  /** a static secret older than the warning age */
  ageWarning: boolean;
}

/** M-075: a credential's age in whole days on the database clock */
const ageDaysSql = sql<number>`floor(extract(epoch from (now() - ${discoveryCredentials.createdAt})) / 86400)::int`;
type CredentialWithAge = DiscoveryCredentialRow & { ageDays: number };

function credentialView(c: CredentialWithAge, warningAgeDays: number): DiscoveryCredentialView {
  const ageDays = Math.max(0, Number(c.ageDays));
  return {
    id: c.id,
    mode: c.credentialMode,
    publicConfig: { ...c.publicConfig },
    hasSecret: c.secretCiphertext !== null,
    writeScope: c.writeScope,
    createdAt: c.createdAt.toISOString(),
    ageDays,
    ageWarning: c.credentialMode === "static" && ageDays >= warningAgeDays,
  };
}

export function runView(r: DiscoveryRunRow) {
  return {
    id: r.id,
    sourceId: r.sourceId,
    kind: r.kind,
    trigger: r.trigger,
    requestedBy: r.requestedBy,
    status: r.status,
    attempt: r.attempt,
    sourceVersion: r.sourceVersion,
    leaseExpiresAt: r.leaseExpiresAt?.toISOString() ?? null,
    startedAt: r.startedAt?.toISOString() ?? null,
    finishedAt: r.finishedAt?.toISOString() ?? null,
    observed: r.observed,
    matched: r.matched,
    findingsCreated: r.findingsCreated,
    findingsUpdated: r.findingsUpdated,
    catalogueGaps: r.catalogueGaps,
    readOutcomes: r.readOutcomes,
    rawOutputSha256: r.rawOutputSha256,
    errorCode: r.errorCode,
    errorDetail: r.errorDetail,
    createdAt: r.createdAt.toISOString(),
  };
}

function sourceView(s: DiscoverySourceRow, registry: ScannerRegistry, cred: CredentialWithAge | undefined, lastRun: DiscoveryRunRow | undefined, warningAgeDays: number) {
  return {
    id: s.id,
    name: s.name,
    kind: s.kind,
    target: s.target,
    scope: s.scope,
    enabled: s.enabled,
    scheduleIntervalSeconds: s.scheduleIntervalSeconds,
    version: s.version,
    nextRunAt: s.nextRunAt?.toISOString() ?? null,
    lastRunAt: s.lastRunAt?.toISOString() ?? null,
    enabledAt: s.enabledAt?.toISOString() ?? null,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
    scannerBuilt: registry.has(s.kind),
    credential: cred ? credentialView(cred, warningAgeDays) : null,
    lastRun: lastRun ? runView(lastRun) : null,
  };
}

// ---------------------------------------------------------------------------
// step-up facts
// ---------------------------------------------------------------------------

/** enabling a source, or widening an enabled one: bound to its kind, target and scope */
/**
 * Enabling a source, or widening an enabled one: bound to its kind, target, scope AND the live credential it will scan
 * with (review of #403), so a credential swapped between the grant and its spend makes the grant fail.
 */
export function enableStepUpArgs(sourceId: string, kind: string, target: unknown, scope: unknown, credentialId: string | null): StepUpCheckArgs {
  return { kind: "settings_relax", facts: { values: { [DISCOVERY_STEP_UP_KEYS.enable]: { sourceId, kind, target, scope, credentialId } } } };
}

/** per-kind target requirements the gateway can check (SD2 matches credentials against them) */
function targetProblem(kind: string, target: Record<string, string>): string | null {
  if (kind === "cloud_aws" && !/^[0-9]{12}$/.test(target.accountId ?? "")) return "an AWS source's target needs accountId (12 digits)";
  return null;
}
/** storing a credential on an ENABLED source whose account cannot be matched to the target: the enable step-up, with the config */
export function credentialOnEnabledStepUpArgs(sourceId: string, kind: string, target: unknown, scope: unknown, mode: string, publicConfig: Record<string, string>): StepUpCheckArgs {
  return { kind: "settings_relax", facts: { values: { [DISCOVERY_STEP_UP_KEYS.enable]: { sourceId, kind, target, scope, credential: { mode, publicConfig } } } } };
}
/** revealing the name behind one pseudonym: its own step-up kind (not a settings relaxation), bound to the pseudonym */
export function pseudonymRevealStepUpArgs(pseudonym: string): StepUpCheckArgs {
  return { kind: "pseudonym_reveal", facts: { op: "pseudonym_reveal", pseudonym } };
}
export function staticCredentialStepUpArgs(sourceId: string, kind: string, replacesCredentialId: string | null): StepUpCheckArgs {
  return { kind: "settings_relax", facts: { values: { [DISCOVERY_STEP_UP_KEYS.staticCredential]: { sourceId, kind, replacesCredentialId } } } };
}

// ---------------------------------------------------------------------------
// routes
// ---------------------------------------------------------------------------

interface Refusal {
  status: number;
  body: Record<string, unknown>;
}
const refusal = (status: number, error: string, detail: string, extra: Record<string, unknown> = {}): Refusal => ({ status, body: { error, detail, ...extra } });
const isRefusal = (x: unknown): x is Refusal => typeof x === "object" && x !== null && "status" in x && "body" in x;

const isUniqueViolation = (e: unknown): boolean => {
  const err = e as { code?: string; cause?: { code?: string } } | null;
  return err?.code === "23505" || err?.cause?.code === "23505";
};

export function registerDiscoveryRoutes(app: FastifyInstance, db: Db, opts: { dataKey?: string | undefined; registry?: ScannerRegistry } = {}): void {
  const registry = opts.registry ?? DISCOVERY_SCANNERS;
  const actor = (req: FastifyRequest) => req.authCtx.userId ?? NIL_UUID;
  const audit = (
    t: Db,
    req: FastifyRequest,
    objectType: "discovery_source" | "discovery_credential" | "discovery_run" | "discovery_settings" | "discovery_pseudonym",
    objectId: string | null,
    ruleId: string,
    effect: "allow" | "deny",
    reason: string,
    detail: Record<string, unknown>,
  ) =>
    t.insert(auditLog).values({
      userId: actor(req),
      objectType,
      objectId,
      detail: { subsystem: "shadow-ai-discovery", ...detail },
      effect,
      ruleId,
      ruleChain: [],
      reason,
    });

  /** spend a step-up inside a locked transaction; a refusal is returned (a prompt is not audited, other refusals are) */
  const spendStepUp = async (req: FastifyRequest, args: StepUpCheckArgs, objectId: string | null): Promise<Refusal | null> => {
    const out = await checkStepUp(db, req, args, { spend: true });
    if (out.ok) return null;
    if (!isStepUpPrompt(out.body)) {
      await audit(db, req, "discovery_source", objectId, "discovery-step-up-refused", "deny", `a discovery change was refused: ${String(out.body.error)}`, {
        actionKind: args.kind,
        error: out.body.error,
      });
    }
    return { status: out.status, body: out.body };
  };

  const send = (reply: FastifyReply, r: Refusal) => reply.status(r.status).send(r.body);
  const badRequest = (reply: FastifyReply, err: z.ZodError) =>
    reply.status(400).send({ error: "invalid_request", detail: err.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ") });

  const lockSource = async (t: Db, sourceId: string) =>
    (await t.select().from(discoverySources).where(eq(discoverySources.id, sourceId)).for("update"))[0];
  const liveCredential = async (t: Db, sourceId: string): Promise<CredentialWithAge | undefined> =>
    (
      await t
        .select({ cred: discoveryCredentials, ageDays: ageDaysSql })
        .from(discoveryCredentials)
        .where(and(eq(discoveryCredentials.sourceId, sourceId), isNull(discoveryCredentials.revokedAt)))
    ).map((r) => ({ ...r.cred, ageDays: r.ageDays }))[0];

  const versionConflict = (current: number) =>
    refusal(409, "version_conflict", "this source changed since you loaded it, so nothing was written: reload it and repeat the change", { currentVersion: current });

  // -------------------------------------------------------------------------
  app.get("/v1/discovery/scanners", async () => ({
    kinds: DISCOVERY_SOURCE_KINDS.map((kind) => {
      const spec = DISCOVERY_KIND_SPECS[kind];
      const scanner = registry.get(kind);
      return {
        kind,
        label: spec.label,
        family: spec.family,
        slice: spec.slice,
        uploadFed: spec.uploadFed === true,
        evidenceKinds: spec.evidenceKinds,
        subjectKinds: spec.subjectKinds,
        built: scanner !== undefined,
        requiresCredential: scanner?.requiresCredential ?? null,
      };
    }),
  }));

  app.get("/v1/discovery/sources", async () => {
    const settings = await loadDiscoverySettings(db);
    const sources = await db.select().from(discoverySources).orderBy(discoverySources.name);
    const ids = sources.map((s) => s.id);
    const creds: CredentialWithAge[] = ids.length
      ? (
          await db
            .select({ cred: discoveryCredentials, ageDays: ageDaysSql })
            .from(discoveryCredentials)
            .where(and(inArray(discoveryCredentials.sourceId, ids), isNull(discoveryCredentials.revokedAt)))
        ).map((r) => ({ ...r.cred, ageDays: r.ageDays }))
      : [];
    const lastRuns = ids.length
      ? await db
          .selectDistinctOn([discoveryRuns.sourceId])
          .from(discoveryRuns)
          .where(inArray(discoveryRuns.sourceId, ids))
          .orderBy(discoveryRuns.sourceId, desc(discoveryRuns.createdAt))
      : [];
    const credBy = new Map(creds.map((c) => [c.sourceId, c]));
    const runBy = new Map(lastRuns.map((r) => [r.sourceId, r]));
    return {
      sources: sources.map((s) => sourceView(s, registry, credBy.get(s.id), runBy.get(s.id), settings.credentialWarningAgeDays)),
      posture: await discoveryPosture(db),
    };
  });

  app.post("/v1/discovery/sources", async (req, reply) => {
    const parsed = createSchema.safeParse(req.body ?? {});
    if (!parsed.success) return badRequest(reply, parsed.error);
    const body = parsed.data;
    const tp = targetProblem(body.kind, body.target);
    if (tp) return send(reply, refusal(400, "target_invalid", tp));
    if (!registry.has(body.kind)) {
      return send(reply, refusal(409, "scanner_not_built", `no scanner is built for ${body.kind} yet (ADR-0195 ${DISCOVERY_KIND_SPECS[body.kind].slice}); a source of this kind cannot be created`));
    }
    // ADR-0218: a wider-source family is off until an admin turns it on
    const createFamilyOff = familySwitchProblem(body.kind, (await loadDiscoverySettings(db)).families);
    if (createFamilyOff) return send(reply, refusal(409, "family_disabled", createFamilyOff));
    // secure by default: a target the kind's scanner rejects is refused at save time, not at run time
    const createProblem = registry.get(body.kind)!.validateTarget?.(body.target, body.scope) ?? null;
    if (createProblem) return send(reply, refusal(400, "target_invalid", createProblem));
    try {
      const row = await db.transaction(async (tx) => {
        const t = tx as unknown as Db;
        const [created] = await t
          .insert(discoverySources)
          .values({
            name: body.name,
            kind: body.kind,
            target: body.target,
            scope: body.scope,
            scheduleIntervalSeconds: body.scheduleIntervalSeconds ?? DISCOVERY_SCHEDULE_DEFAULT_SECONDS,
            createdBy: actor(req),
          })
          .returning();
        await audit(t, req, "discovery_source", created!.id, "discovery-source-created", "allow", `discovery source '${body.name}' (${body.kind}) created, disabled`, {
          kind: body.kind,
          target: body.target,
          scope: body.scope,
        });
        return created!;
      });
      const settings = await loadDiscoverySettings(db);
      return reply.status(201).send(sourceView(row, registry, undefined, undefined, settings.credentialWarningAgeDays));
    } catch (e) {
      if (isUniqueViolation(e)) return send(reply, refusal(409, "name_taken", `a discovery source named '${body.name}' already exists`));
      throw e;
    }
  });

  app.patch("/v1/discovery/sources/:sourceId", async (req, reply) => {
    const p = uuidParam.safeParse(req.params);
    if (!p.success) return badRequest(reply, p.error);
    const parsed = patchSchema.safeParse(req.body ?? {});
    if (!parsed.success) return badRequest(reply, parsed.error);
    const body = parsed.data;
    try {
      const out = await db.transaction(async (tx): Promise<Refusal | DiscoverySourceRow> => {
        const t = tx as unknown as Db;
        const s = await lockSource(t, p.data.sourceId);
        if (!s) return refusal(404, "not_found", "no such discovery source");
        if (s.version !== body.version) return versionConflict(s.version);
        // a target the kind's scanner rejects is refused before any grant is spent or anything is written
        const patchProblem =
          body.target !== undefined || body.scope !== undefined
            ? (registry
                .get(s.kind)
                ?.validateTarget?.(
                  body.target ?? Object.fromEntries(Object.entries(s.target).map(([k, v]) => [k, String(v)])),
                  body.scope ?? { orgLevel: s.scope.orgLevel === true, include: [...(s.scope.include ?? [])] },
                ) ?? null)
            : null;
        if (patchProblem) return refusal(400, "target_invalid", patchProblem);
        const target = body.target ?? s.target;
        const tp = body.target ? targetProblem(s.kind, body.target) : null;
        if (tp) return refusal(400, "target_invalid", tp);
        const scope = body.scope ?? s.scope;
        const targetChanged = body.target !== undefined && JSON.stringify(body.target) !== JSON.stringify(s.target);
        const widened = body.scope !== undefined && scopeWidens(s.scope, body.scope);
        // a duplicate name is refused BEFORE any grant is spent (review of #403)
        if (body.name !== undefined && body.name.toLowerCase() !== s.name.toLowerCase()) {
          const [dup] = await t
            .select({ id: discoverySources.id })
            .from(discoverySources)
            .where(sql`lower(${discoverySources.name}) = lower(${body.name}) AND ${discoverySources.id} <> ${s.id}`);
          if (dup) return refusal(409, "name_taken", "another discovery source already has that name");
        }
        // decision 1: widening an ENABLED source (a new target, more items, an org-level scope) is the enable step-up
        if (s.enabled && (targetChanged || widened)) {
          const r = await spendStepUp(req, enableStepUpArgs(s.id, s.kind, target, scope, (await liveCredential(t, s.id))?.id ?? null), s.id);
          if (r) return r;
        }
        const [row] = await t
          .update(discoverySources)
          .set({
            ...(body.name !== undefined ? { name: body.name } : {}),
            target,
            scope,
            ...(body.scheduleIntervalSeconds !== undefined ? { scheduleIntervalSeconds: body.scheduleIntervalSeconds } : {}),
            version: s.version + 1,
            updatedAt: sql`now()`,
          })
          .where(eq(discoverySources.id, s.id))
          .returning();
        await audit(t, req, "discovery_source", s.id, s.enabled && (targetChanged || widened) ? "discovery-source-widened" : "discovery-source-updated", "allow",
          `discovery source '${row!.name}' updated${s.enabled && (targetChanged || widened) ? " (widened while enabled, with a step-up)" : ""}`,
          { kind: s.kind, before: { name: s.name, target: s.target, scope: s.scope, scheduleIntervalSeconds: s.scheduleIntervalSeconds }, after: { name: row!.name, target, scope, scheduleIntervalSeconds: row!.scheduleIntervalSeconds } });
        return row!;
      });
      if (isRefusal(out)) return send(reply, out);
      const settings = await loadDiscoverySettings(db);
      return sourceView(out, registry, await liveCredential(db, out.id), undefined, settings.credentialWarningAgeDays);
    } catch (e) {
      if (isUniqueViolation(e)) return send(reply, refusal(409, "name_taken", "another discovery source already has that name"));
      throw e;
    }
  });

  app.post("/v1/discovery/sources/:sourceId/enable", async (req, reply) => {
    const p = uuidParam.safeParse(req.params);
    if (!p.success) return badRequest(reply, p.error);
    const parsed = versionSchema.safeParse(req.body ?? {});
    if (!parsed.success) return badRequest(reply, parsed.error);
    const out = await db.transaction(async (tx): Promise<Refusal | DiscoverySourceRow> => {
      const t = tx as unknown as Db;
      const s = await lockSource(t, p.data.sourceId);
      if (!s) return refusal(404, "not_found", "no such discovery source");
      if (s.version !== parsed.data.version) return versionConflict(s.version);
      if (s.enabled) return refusal(409, "already_enabled", "this source is already enabled");
      const scanner = registry.get(s.kind);
      if (!scanner) return refusal(409, "scanner_not_built", `no scanner is built for ${s.kind} yet (ADR-0195 ${DISCOVERY_KIND_SPECS[s.kind].slice})`);
      const enableFamilyOff = familySwitchProblem(s.kind, (await loadDiscoverySettings(t)).families);
      if (enableFamilyOff) return refusal(409, "family_disabled", enableFamilyOff);
      const enableCred = await liveCredential(t, s.id);
      if (scanner.requiresCredential && !enableCred) {
        return refusal(409, "credential_missing", "store a credential for this source before enabling it");
      }
      if (enableCred?.writeScope === "refused") {
        return refusal(409, "credential_refused", "this source's credential grants write access and is refused; replace it with a read-only credential first");
      }
      const r = await spendStepUp(req, enableStepUpArgs(s.id, s.kind, s.target, s.scope, enableCred?.id ?? null), s.id);
      if (r) return r;
      const [row] = await t
        .update(discoverySources)
        // an upload-fed kind (osquery results, MDM/EDR exports) has no schedule: it is never queued by time
        .set({ enabled: true, enabledAt: sql`now()`, enabledBy: actor(req), nextRunAt: DISCOVERY_KIND_SPECS[s.kind].uploadFed ? null : sql`now()`, version: s.version + 1, updatedAt: sql`now()` })
        .where(eq(discoverySources.id, s.id))
        .returning();
      await audit(t, req, "discovery_source", s.id, "discovery-source-enabled", "allow",
        `discovery source '${s.name}' (${s.kind}) ENABLED: RegulAIt will scan it read-only on its schedule`,
        { kind: s.kind, target: s.target, scope: s.scope, scheduleIntervalSeconds: s.scheduleIntervalSeconds });
      return row!;
    });
    if (isRefusal(out)) return send(reply, out);
    const settings = await loadDiscoverySettings(db);
    return sourceView(out, registry, await liveCredential(db, out.id), undefined, settings.credentialWarningAgeDays);
  });

  // disabling is always free and needs no compare-and-set: stopping a scan must never be refused for staleness
  app.post("/v1/discovery/sources/:sourceId/disable", async (req, reply) => {
    const p = uuidParam.safeParse(req.params);
    if (!p.success) return badRequest(reply, p.error);
    const out = await db.transaction(async (tx): Promise<Refusal | DiscoverySourceRow> => {
      const t = tx as unknown as Db;
      const s = await lockSource(t, p.data.sourceId);
      if (!s) return refusal(404, "not_found", "no such discovery source");
      if (!s.enabled) return s;
      const [row] = await t
        .update(discoverySources)
        .set({ enabled: false, disabledAt: sql`now()`, disabledBy: actor(req), nextRunAt: null, version: s.version + 1, updatedAt: sql`now()` })
        .where(eq(discoverySources.id, s.id))
        .returning();
      // a queued run never starts; a running one is refused at its next check and its results still land (it was authorised)
      await t.execute(sql`
        UPDATE discovery_runs SET status = 'failed', error_code = 'source_disabled', error_detail = 'the source was disabled before the run started',
               finished_at = now() WHERE source_id = ${s.id} AND status = 'queued'`);
      await audit(t, req, "discovery_source", s.id, "discovery-source-disabled", "allow", `discovery source '${s.name}' (${s.kind}) disabled`, { kind: s.kind });
      return row!;
    });
    if (isRefusal(out)) return send(reply, out);
    const settings = await loadDiscoverySettings(db);
    return sourceView(out, registry, await liveCredential(db, out.id), undefined, settings.credentialWarningAgeDays);
  });

  app.delete("/v1/discovery/sources/:sourceId", async (req, reply) => {
    const p = uuidParam.safeParse(req.params);
    if (!p.success) return badRequest(reply, p.error);
    const out = await db.transaction(async (tx): Promise<Refusal | { deleted: string }> => {
      const t = tx as unknown as Db;
      const s = await lockSource(t, p.data.sourceId);
      if (!s) return refusal(404, "not_found", "no such discovery source");
      if (s.enabled) return refusal(409, "disable_first", "disable this source before deleting it");
      const [live] = await t.select({ id: discoveryRuns.id }).from(discoveryRuns).where(and(eq(discoveryRuns.sourceId, s.id), inArray(discoveryRuns.status, ["queued", "running"])));
      if (live) return refusal(409, "run_in_progress", "a scan of this source is still running; delete it once the run finishes");
      await t.delete(discoverySources).where(eq(discoverySources.id, s.id));
      await audit(t, req, "discovery_source", s.id, "discovery-source-deleted", "allow",
        `discovery source '${s.name}' (${s.kind}) deleted with its credential and run history; its findings and import records stay`,
        { kind: s.kind, target: s.target, scope: s.scope });
      return { deleted: s.id };
    });
    if (isRefusal(out)) return send(reply, out);
    return out;
  });

  app.put("/v1/discovery/sources/:sourceId/credential", async (req, reply) => {
    const p = uuidParam.safeParse(req.params);
    if (!p.success) return badRequest(reply, p.error);
    const parsed = credentialSchema.safeParse(req.body ?? {});
    if (!parsed.success) return badRequest(reply, parsed.error);
    const parsedBody = parsed.data;
    const modeProblem = (mode: "federated" | "static"): Refusal | null => {
      if (mode === "federated" && parsedBody.secret !== undefined) {
        return refusal(400, "federated_has_no_secret", "a federated credential is short-lived and has no stored secret; use static mode for a stored secret (a relaxation)");
      }
      if (mode === "static" && parsedBody.secret === undefined) return refusal(400, "secret_required", "a static credential needs its secret");
      if (mode === "static" && !opts.dataKey) return refusal(503, "data_key_unavailable", "the data key is not configured, so a secret cannot be stored encrypted");
      return null;
    };
    if (parsedBody.mode !== undefined) {
      const early = modeProblem(parsedBody.mode);
      if (early) return send(reply, early);
    }
    const out = await db.transaction(async (tx): Promise<Refusal | DiscoveryCredentialRow> => {
      const t = tx as unknown as Db;
      const s = await lockSource(t, p.data.sourceId);
      if (!s) return refusal(404, "not_found", "no such discovery source");
      // ADR-0195 A5 (secure by default): an omitted mode is federated wherever the provider supports it
      const body = { ...parsedBody, mode: parsedBody.mode ?? defaultCredentialMode(s.kind) };
      if (parsedBody.mode === undefined) {
        const late = modeProblem(body.mode);
        if (late) return late;
      }
      // review of #403: an ALLOWLIST of identifier fields per kind and mode, each shape-checked; anything else
      // (a key, a token, a service-account file, the server-generated externalId in any spelling) is refused
      const configProblem = publicConfigProblem(s.kind, body.mode, body.publicConfig);
      if (configProblem) return refusal(400, "public_config_refused", configProblem);
      const targetMatch = credentialTargetMatch(s.kind, s.target, body.publicConfig);
      if (targetMatch === "mismatch") {
        return refusal(400, "credential_target_mismatch", "the credential names a different account or tenant than the source's target");
      }
      const live = await liveCredential(t, s.id);
      if ((live?.id ?? null) !== body.replacesCredentialId) {
        return refusal(409, "credential_conflict", live
          ? `this source already has a credential (${live.id}); name it in replacesCredentialId to replace it`
          : "this source has no credential; replacesCredentialId must be null");
      }
      // decision 3: a stored static secret is a relaxation; a federated credential is the default and free.
      // Review of #403: on an ENABLED source, a credential whose account cannot be checked against the target could
      // point the scan somewhere else, so storing it is the enable step-up, bound to the source AND the new config
      const steps: StepUpCheckArgs[] = [];
      if (body.mode === "static") steps.push(staticCredentialStepUpArgs(s.id, s.kind, body.replacesCredentialId));
      if (s.enabled && targetMatch !== "match") steps.push(credentialOnEnabledStepUpArgs(s.id, s.kind, s.target, s.scope, body.mode, body.publicConfig));
      for (const args of steps) {
        const pre = await checkStepUp(db, req, args, { spend: false });
        if (!pre.ok) return { status: pre.status, body: pre.body };
      }
      for (const args of steps) {
        const r = await spendStepUp(req, args, s.id);
        if (r) return r;
      }
      if (live) {
        await t
          .update(discoveryCredentials)
          .set({ revokedAt: sql`now()`, revokedBy: actor(req), secretCiphertext: null })
          .where(eq(discoveryCredentials.id, live.id));
      }
      // decision 3: the AWS external ID is generated per source, never chosen by the admin; it is shown so the
      // admin can put it in the role's trust policy, and kept across a replacement so the trust policy holds
      const publicConfig: Record<string, string> = { ...body.publicConfig };
      if (s.kind === "cloud_aws" && body.mode === "federated") {
        publicConfig.externalId = live?.publicConfig.externalId ?? `regulait-${randomUUID()}`;
      }
      const [row] = await t
        .insert(discoveryCredentials)
        .values({
          sourceId: s.id,
          credentialMode: body.mode,
          publicConfig,
          secretCiphertext: body.mode === "static" ? encryptSecret(opts.dataKey!, body.secret!) : null,
          createdBy: actor(req),
        })
        .returning();
      await audit(t, req, "discovery_credential", row!.id, live ? "discovery-credential-replaced" : "discovery-credential-stored", "allow",
        `${body.mode} credential ${live ? "replaced" : "stored"} for discovery source '${s.name}'${body.mode === "static" ? " (a stored static secret: a relaxation, confirmed with a step-up)" : ""}`,
        { sourceId: s.id, kind: s.kind, mode: body.mode, publicConfigKeys: Object.keys(publicConfig).sort(), replacedCredentialId: live?.id ?? null });
      return row!;
    });
    if (isRefusal(out)) return send(reply, out);
    const settings = await loadDiscoverySettings(db);
    return credentialView({ ...out, ageDays: 0 }, settings.credentialWarningAgeDays);
  });

  app.delete("/v1/discovery/sources/:sourceId/credential", async (req, reply) => {
    const p = uuidParam.safeParse(req.params);
    if (!p.success) return badRequest(reply, p.error);
    const out = await db.transaction(async (tx): Promise<Refusal | { revoked: string }> => {
      const t = tx as unknown as Db;
      const s = await lockSource(t, p.data.sourceId);
      if (!s) return refusal(404, "not_found", "no such discovery source");
      const live = await liveCredential(t, s.id);
      if (!live) return refusal(404, "no_credential", "this source has no live credential");
      await t
        .update(discoveryCredentials)
        .set({ revokedAt: sql`now()`, revokedBy: actor(req), secretCiphertext: null })
        .where(eq(discoveryCredentials.id, live.id));
      await audit(t, req, "discovery_credential", live.id, "discovery-credential-revoked", "allow",
        `credential of discovery source '${s.name}' revoked; its stored secret was destroyed`, { sourceId: s.id, kind: s.kind, mode: live.credentialMode });
      return { revoked: live.id };
    });
    if (isRefusal(out)) return send(reply, out);
    return out;
  });

  app.post("/v1/discovery/sources/:sourceId/runs", async (req, reply) => {
    const p = uuidParam.safeParse(req.params);
    if (!p.success) return badRequest(reply, p.error);
    const [s] = await db.select().from(discoverySources).where(eq(discoverySources.id, p.data.sourceId));
    if (!s) return send(reply, refusal(404, "not_found", "no such discovery source"));
    if (!s.enabled) return send(reply, refusal(409, "source_disabled", "enable this source before running it"));
    const scanner = registry.get(s.kind);
    if (!scanner) return send(reply, refusal(409, "scanner_not_built", `no scanner is built for ${s.kind} yet`));
    const runFamilyOff = familySwitchProblem(s.kind, (await loadDiscoverySettings(db)).families);
    if (runFamilyOff) return send(reply, refusal(409, "family_disabled", runFamilyOff));
    const runCred = await liveCredential(db, s.id);
    if (scanner.requiresCredential && !runCred) {
      return send(reply, refusal(409, "credential_missing", "store a credential for this source first"));
    }
    if (runCred?.writeScope === "refused") {
      return send(reply, refusal(409, "credential_refused", "this source's credential grants write access and is refused; replace it first"));
    }
    const [run] = await db
      .insert(discoveryRuns)
      .values({ sourceId: s.id, trigger: "manual", requestedBy: actor(req), status: "queued", sourceVersion: s.version, kind: s.kind })
      .onConflictDoNothing({ target: discoveryRuns.sourceId, where: sql`status IN ('queued', 'running')` })
      .returning();
    if (!run) return send(reply, refusal(409, "run_already_queued", "a scan of this source is already queued or running"));
    await audit(db, req, "discovery_run", run.id, "discovery-run-queued", "allow", `discovery run of '${s.name}' queued by an admin`, {
      sourceId: s.id,
      trigger: "manual",
      kind: s.kind,
      target: s.target,
      scope: s.scope,
    });
    return reply.status(202).send(runView(run));
  });

  app.get("/v1/discovery/runs", async (req, reply) => {
    const q = runsQuery.safeParse(req.query ?? {});
    if (!q.success) return badRequest(reply, q.error);
    const rows = await db
      .select()
      .from(discoveryRuns)
      .where(q.data.sourceId ? eq(discoveryRuns.sourceId, q.data.sourceId) : undefined)
      .orderBy(desc(discoveryRuns.createdAt))
      .limit(q.data.limit);
    return { runs: rows.map(runView) };
  });

  app.get("/v1/discovery/settings", async () => loadDiscoverySettings(db));

  app.put("/v1/discovery/settings", async (req, reply) => {
    const parsed = settingsSchema.safeParse(req.body ?? {});
    if (!parsed.success) return badRequest(reply, parsed.error);
    const body = parsed.data;
    const out = await db.transaction(async (tx): Promise<Refusal | true> => {
      const t = tx as unknown as Db;
      const [row] = await t.select().from(discoverySettings).where(eq(discoverySettings.id, 1)).for("update");
      if (!row) return refusal(500, "settings_missing", "the discovery settings row is missing (migration 0202 inserts it)");
      if (row.version !== body.version) {
        return refusal(409, "version_conflict", "the discovery settings changed since you loaded them; reload and repeat the change", { currentVersion: row.version });
      }
      // a longer warning age or a longer retention is a relaxation (ADR-0195 decisions 3 and 20); shorter is free
      const relaxed: Record<string, unknown> = {};
      if (body.credentialWarningAgeDays !== undefined && body.credentialWarningAgeDays > row.credentialWarningAgeDays) {
        relaxed[DISCOVERY_STEP_UP_KEYS.warningAge] = body.credentialWarningAgeDays;
      }
      if (body.endpointRetentionDays !== undefined && body.endpointRetentionDays > row.endpointRetentionDays) {
        relaxed[DISCOVERY_STEP_UP_KEYS.retention] = body.endpointRetentionDays;
      }
      // ADR-0218: turning a wider-source family ON is a relaxation, bound to exactly the families being turned on
      const beforeFamilies = { saas: row.saasSourcesEnabled, identity: row.identitySourcesEnabled, ml_platform: row.mlPlatformSourcesEnabled };
      const afterFamilies = { ...beforeFamilies, ...(body.families ?? {}) };
      const turnedOn = DISCOVERY_GATED_FAMILIES.filter((f) => afterFamilies[f] && !beforeFamilies[f]);
      if (turnedOn.length > 0) relaxed[DISCOVERY_STEP_UP_KEYS.families] = turnedOn;
      if (Object.keys(relaxed).length > 0) {
        const r = await spendStepUp(req, { kind: "settings_relax", facts: { values: relaxed } }, null);
        if (r) return r;
      }
      await t
        .update(discoverySettings)
        .set({
          ...(body.credentialWarningAgeDays !== undefined ? { credentialWarningAgeDays: body.credentialWarningAgeDays } : {}),
          ...(body.endpointRetentionDays !== undefined ? { endpointRetentionDays: body.endpointRetentionDays } : {}),
          saasSourcesEnabled: afterFamilies.saas,
          identitySourcesEnabled: afterFamilies.identity,
          mlPlatformSourcesEnabled: afterFamilies.ml_platform,
          version: row.version + 1,
          updatedBy: actor(req),
          updatedAt: sql`now()`,
        })
        .where(eq(discoverySettings.id, 1));
      await audit(t, req, "discovery_settings", null, Object.keys(relaxed).length ? "discovery-settings-relaxed" : "discovery-settings-updated", "allow",
        `discovery settings updated${Object.keys(relaxed).length ? " (relaxed, with a step-up)" : ""}`,
        { before: { credentialWarningAgeDays: row.credentialWarningAgeDays, endpointRetentionDays: row.endpointRetentionDays, families: beforeFamilies }, after: { credentialWarningAgeDays: body.credentialWarningAgeDays ?? row.credentialWarningAgeDays, endpointRetentionDays: body.endpointRetentionDays ?? row.endpointRetentionDays, families: afterFamilies } });
      return true;
    });
    if (isRefusal(out)) return send(reply, out);
    return loadDiscoverySettings(db);
  });

  app.post("/v1/discovery/pseudonyms/:pseudonym/reveal", async (req, reply) => {
    const p = pseudonymParam.safeParse(req.params);
    if (!p.success) return badRequest(reply, p.error);
    if (!opts.dataKey) return send(reply, refusal(503, "data_key_unavailable", "the data key is not configured, so no display name can be read"));
    const dataKey = opts.dataKey;
    // under the row lock: decrypt FIRST, and spend the grant only when there is a name to give (review of #403)
    const out = await db.transaction(async (tx): Promise<Refusal | { pseudonym: string; kind: string; displayName: string }> => {
      const t = tx as unknown as Db;
      const [row] = await t.select().from(discoveryPseudonyms).where(eq(discoveryPseudonyms.pseudonym, p.data.pseudonym)).for("update");
      if (!row) return refusal(404, "not_found", "no such pseudonym (it may have passed its retention)");
      let displayName: string;
      try {
        displayName = decryptSecret(dataKey, row.displayNameCiphertext);
      } catch {
        return refusal(500, "unreadable", "this display name does not decrypt under the current data key");
      }
      const r = await spendStepUp(req, pseudonymRevealStepUpArgs(row.pseudonym), null);
      if (r) return r;
      // the audit names WHICH pseudonym was revealed and by whom, never the name itself
      await audit(t, req, "discovery_pseudonym", row.id, "discovery-pseudonym-revealed", "allow", `pseudonym ${row.pseudonym} (${row.kind}) revealed by an admin`, {
        pseudonym: row.pseudonym,
        kind: row.kind,
      });
      return { pseudonym: row.pseudonym, kind: row.kind, displayName };
    });
    if (isRefusal(out)) return send(reply, out);
    return out;
  });
}
