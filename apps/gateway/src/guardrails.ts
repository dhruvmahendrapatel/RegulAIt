/**
 * ADR-0042 — the GATEWAY half of the guardrail engine.
 *
 * Division of labour, drawn exactly where §8.4's PII split already is:
 *
 *   `packages/shared/src/guardrails.ts`  the detector registry and the pure
 *                                        evaluation. No I/O, no clock, no db.
 *                                        Counts only, never matched text.
 *   THIS FILE                            resolves WHICH modes are in force for
 *                                        a given call (scope + cascade), writes
 *                                        the audit rows, and owns the admin
 *                                        surface.
 *   `agents-connectors.ts` / `mcp-proxy` the ONE enforcement point, unchanged
 *                                        in position: inside the governed
 *                                        dispatch core, input phase before the
 *                                        provider call and output phase after.
 *
 * THE CEILING RULE, IN ONE LINE
 *
 *     effective(detector) = MAX-strictness( complianceFloor , override ?? orgDefault )
 *
 * MAX has no way to lower anything, which is precisely why the §8.3 cascade is
 * a ceiling and not a peer: a HIPAA profile can force `semantic_dlp` to
 * `block`, and no per-agent row can walk that back. The composition itself
 * lives in `composeGuardrailModes` in the shared package so the resolver, the
 * admin "effective policy" endpoint and the tests all use one definition.
 */
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import {
  agents,
  and,
  auditLog,
  connectors,
  desc,
  eq,
  guardrailConfigs,
  inArray,
  isNull,
  sql,
  type Db,
  type GuardrailConfigRow,
} from "@regulait/db";
import {
  GUARDRAIL_DETECTOR_IDS,
  GUARDRAIL_DEFAULT_MODES,
  GUARDRAIL_FALLBACK_MODE,
  composeGuardrailModes,
  composeGuardrailTerms,
  evaluateGuardrails,
  guardrailCategoryList,
  guardrailRegistry,
  guardrailSampleSchema,
  putGuardrailConfigSchema,
  type GuardrailDetectorId,
  type GuardrailEvaluation,
  type GuardrailFinding,
  type GuardrailMode,
  type GuardrailModes,
  type GuardrailPhase,
  type GuardrailTerms,
} from "@regulait/shared";
import { complianceProfilesForTags, projectClassifications } from "./projects.js";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

// ---------------------------------------------------------------------------
// The mode columns <-> detector ids mapping (one place, not four)
// ---------------------------------------------------------------------------

const MODE_COLUMN: Record<
  Exclude<GuardrailDetectorId, "pii">,
  "promptInjectionMode" | "jailbreakMode" | "toxicityMode" | "semanticDlpMode"
> = {
  prompt_injection: "promptInjectionMode",
  jailbreak: "jailbreakMode",
  toxicity: "toxicityMode",
  semantic_dlp: "semanticDlpMode",
};

/** The detectors this engine configures. PII is a registered detector (it is
 * classifier #1 in the shared registry) but its MODE is the §8.3 cascade's
 * `piiMode` and is not settable here — see the note in the shared write
 * schema. */
export const CONFIGURABLE_DETECTORS = Object.keys(MODE_COLUMN) as Array<
  Exclude<GuardrailDetectorId, "pii">
>;

function rowModes(row: GuardrailConfigRow | undefined | null): Partial<GuardrailModes> {
  if (!row) return {};
  const out: Partial<GuardrailModes> = {};
  for (const id of CONFIGURABLE_DETECTORS) out[id] = row[MODE_COLUMN[id]] as GuardrailMode;
  return out;
}

/** ADR-0181: the modes in force BEFORE a write, for the audit row's old -> new.
 * No row = the shipped defaults (which is what was in force). */
function previousModes(row: GuardrailConfigRow | undefined | null): Partial<GuardrailModes> {
  if (row) return rowModes(row);
  const out: Partial<GuardrailModes> = {};
  for (const id of CONFIGURABLE_DETECTORS) out[id] = GUARDRAIL_DEFAULT_MODES[id];
  return out;
}

/** "detector=old->new" for every detector, in one line of audit prose */
function modeTransitions(before: Partial<GuardrailModes>, after: Partial<GuardrailModes>): string {
  return CONFIGURABLE_DETECTORS.map((d) =>
    before[d] === after[d] ? `${d}=${after[d]}` : `${d}=${before[d]}->${after[d]}`,
  ).join(", ");
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export interface GuardrailProvenance {
  detector: GuardrailDetectorId;
  orgDefault: GuardrailMode;
  override: GuardrailMode | null;
  /** the strictest mode any of the project's compliance profiles demands */
  complianceFloor: GuardrailMode | null;
  effective: GuardrailMode;
}

export interface GuardrailPolicy {
  modes: GuardrailModes;
  terms: GuardrailTerms;
  provenance: GuardrailProvenance[];
  /** at least one detector is not 'off' — lets a caller skip all the work */
  active: boolean;
  /** an INPUT-phase detector is at 'block' */
  blocksInput: boolean;
  /** an OUTPUT-phase detector is at 'block'. This is the flag that decides
   * whether a stream may be delivered live (see the streaming note below). */
  blocksOutput: boolean;
}

/** The org-default row, or undefined when an admin has never touched the
 * settings (in which case `GUARDRAIL_DEFAULT_MODES` — ADR-0181's strict
 * shipped posture: block prompt injection and jailbreak, warn on the rest —
 * applies). */
export async function loadOrgGuardrailConfig(db: Db): Promise<GuardrailConfigRow | undefined> {
  const [row] = await db
    .select()
    .from(guardrailConfigs)
    .where(and(eq(guardrailConfigs.scope, "org"), isNull(guardrailConfigs.scopeId)));
  return row;
}

/**
 * Resolve the modes and term lists in force for ONE call.
 *
 * Precedence, and why it is this way round:
 *   - `orgDefault` is the deployment's baseline. Absent = the shipped posture
 *     (ADR-0181: block prompt injection and jailbreak, warn on the other
 *     layers); an admin relaxes it through PUT /v1/guardrails/config.
 *   - an `agent`/`connector` override REPLACES the org default for that object
 *     (an admin tuning one noisy agent should not have to restate the org's
 *     other three layers) …
 *   - … and is then MAX-composed with the compliance floor, which is what
 *     makes the floor un-relaxable.
 * A call with no project attribution simply has no floor; the org default and
 * any override still apply, because they are org policy, not project policy.
 */
export async function resolveGuardrailPolicy(
  db: Db,
  args: {
    projectId?: string | null | undefined;
    agentId?: string | null | undefined;
    connectorId?: string | null | undefined;
  },
): Promise<GuardrailPolicy> {
  const scopeId = args.agentId ?? args.connectorId ?? null;
  const scope: "agent" | "connector" | null = args.agentId
    ? "agent"
    : args.connectorId
      ? "connector"
      : null;

  const [orgRow, overrideRow] = await Promise.all([
    loadOrgGuardrailConfig(db),
    scope && scopeId
      ? db
          .select()
          .from(guardrailConfigs)
          .where(and(eq(guardrailConfigs.scope, scope), eq(guardrailConfigs.scopeId, scopeId)))
          .then((r) => r[0])
      : Promise.resolve(undefined),
  ]);

  const orgModes: Partial<GuardrailModes> = orgRow ? rowModes(orgRow) : { ...GUARDRAIL_DEFAULT_MODES };
  const overrideModes = overrideRow ? rowModes(overrideRow) : null;

  // the §8.3 floor: MAX across every profile the project's tags resolve to
  let floor: Partial<GuardrailModes> | null = null;
  if (args.projectId) {
    const tags = await projectClassifications(db, args.projectId);
    if (tags.length > 0) {
      const profiles = await complianceProfilesForTags(db, tags);
      const declared = profiles
        .map((p) => p.guardrailModes)
        .filter((m): m is Partial<GuardrailModes> => !!m);
      if (declared.length > 0) floor = composeGuardrailModes(...declared);
    }
  }

  const local = overrideModes ?? orgModes;
  const modes = composeGuardrailModes(local, floor);
  // PII is never configured here — its mode is the cascade's piiMode, enforced
  // on its own dedicated path. Force 'off' so nothing can double-enforce it.
  modes.pii = "off";

  const terms = composeGuardrailTerms(
    orgRow?.customTerms ?? null,
    overrideRow?.customTerms ?? null,
  );

  const provenance: GuardrailProvenance[] = CONFIGURABLE_DETECTORS.map((id) => ({
    detector: id,
    orgDefault: (orgModes[id] ?? GUARDRAIL_FALLBACK_MODE) as GuardrailMode,
    override: (overrideModes?.[id] ?? null) as GuardrailMode | null,
    complianceFloor: (floor?.[id] ?? null) as GuardrailMode | null,
    effective: modes[id],
  }));

  const registry = guardrailRegistry();
  const atBlock = (phase: GuardrailPhase) =>
    registry.some((d) => d.phases.includes(phase) && modes[d.id] === "block");

  return {
    modes,
    terms,
    provenance,
    active: GUARDRAIL_DETECTOR_IDS.some((id) => modes[id] !== "off"),
    blocksInput: atBlock("input"),
    blocksOutput: atBlock("output"),
  };
}

// ---------------------------------------------------------------------------
// The dispatch-facing shape + audit
// ---------------------------------------------------------------------------

/** The counts-only guardrail outcome threaded onto a dispatch response. Same
 * contract as `DispatchPii`: category counts, never matched substrings. */
export interface DispatchGuardrails {
  action: "block" | "warn" | "log";
  phase: GuardrailPhase;
  findings: Array<{
    detector: GuardrailDetectorId;
    category: string;
    count: number;
    mode: GuardrailMode;
  }>;
  /** true when a block replaced the model/connector output with the marker */
  withheld: boolean;
  /** ADR-0042 streaming residual: true when live delta streaming was withheld
   * and the response buffered, because an output detector is at `block`. */
  streamBuffered?: boolean;
}

export function flattenFindings(findings: readonly GuardrailFinding[]): DispatchGuardrails["findings"] {
  return findings.flatMap((f) =>
    f.hits.map((h) => ({ detector: f.detector, category: h.category, count: h.count, mode: f.mode })),
  );
}

/**
 * ONE audit row per guardrail event, into the SINGLE existing audit log.
 *
 * Every outcome is recorded, `log` included — unlike §8.4's PII path, whose
 * `log` mode is silent in the audit log and records counts in the usage detail
 * only. The reason for the difference is deliberate: the whole point of the
 * ADR's "observe-then-tune" default posture is that an admin can look at what
 * the layers WOULD have blocked before turning them up, and that report has to
 * come from somewhere. `guardrail-logged` rows are `effect: 'allow'`, so they
 * never masquerade as denials.
 */
export async function recordGuardrailDecision(
  db: Pick<Db, "insert">,
  args: {
    userId: string;
    objectType: "agent" | "connector" | "mcp_server";
    objectId: string | null;
    projectId?: string | null | undefined;
    evaluation: GuardrailEvaluation;
    outcome: "blocked" | "warned" | "logged";
    /** extra context for the violations view (surface, agent, tool, …) */
    detail?: Record<string, unknown>;
  },
  // ADR-0070: the audit row's id is returned so a trace span can REFERENCE the
  // guardrail decision rather than restating it. null = there was nothing to
  // record (no findings), which is the overwhelmingly common case.
): Promise<string | null> {
  const { evaluation, outcome } = args;
  if (evaluation.findings.length === 0) return null;
  const relevant = outcome === "blocked" ? evaluation.blocking : evaluation.findings;
  const categories = guardrailCategoryList(relevant);
  const [row] = await db.insert(auditLog).values({
    userId: args.userId,
    objectType: args.objectType,
    objectId: args.objectId,
    detail: {
      phase: "guardrail",
      guardrail: {
        phase: evaluation.phase,
        outcome,
        action: evaluation.action,
        // COUNTS ONLY — detector, category, count, mode. Never the text.
        findings: flattenFindings(evaluation.findings),
      },
      ...(args.projectId ? { projectId: args.projectId } : {}),
      ...(args.detail ?? {}),
    },
    effect: outcome === "blocked" ? "deny" : "allow",
    ruleId: `guardrail-${outcome}`,
    ruleChain: [],
    reason:
      outcome === "blocked"
        ? `${evaluation.phase} blocked by guardrail: ${categories}`
        : outcome === "warned"
          ? `guardrail hit on ${evaluation.phase} (${categories}) — warned, call proceeded`
          : `guardrail hit on ${evaluation.phase} (${categories}) — observed in log mode, call proceeded`,
  }).returning({ id: auditLog.id });
  return row?.id ?? null;
}

/** The outcome verb an evaluation's action maps to for the audit row. */
export function guardrailOutcome(
  evaluation: GuardrailEvaluation,
): "blocked" | "warned" | "logged" | null {
  if (evaluation.findings.length === 0) return null;
  return evaluation.action === "block" ? "blocked" : evaluation.action === "warn" ? "warned" : "logged";
}

/** Run one phase. Thin wrapper so every enforcement site reads identically and
 * nobody forgets to exclude PII (which has its own dedicated path). */
export function runGuardrails(
  policy: GuardrailPolicy,
  phase: GuardrailPhase,
  text: string,
): GuardrailEvaluation {
  return evaluateGuardrails({
    phase,
    text,
    modes: policy.modes,
    terms: policy.terms,
    exclude: ["pii"],
  });
}

// ---------------------------------------------------------------------------
// Admin surface
// ---------------------------------------------------------------------------

const scopeParam = z.object({
  scope: z.enum(["agent", "connector"]),
  scopeId: z.string().uuid(),
});

export function registerGuardrailRoutes(app: FastifyInstance, db: Db): void {
  const audit = async (
    userId: string | null,
    objectId: string | null,
    ruleId: string,
    reason: string,
    detail: Record<string, unknown>,
  ) => {
    await db.insert(auditLog).values({
      // the bootstrap token has no user row; the audit column is NOT NULL, so
      // the nil uuid stands in — the same convention the ABAC admin surface uses
      userId: userId ?? NIL_UUID,
      objectType: "org_settings",
      objectId,
      detail: { phase: "guardrail-config", ...detail },
      effect: "allow",
      ruleId,
      ruleChain: [],
      reason,
    });
  };

  /**
   * The registry, verbatim from the code — including each detector's honest
   * `limits` string. The admin screen renders that next to the switch, so a
   * person turning a layer to `block` reads what it cannot do at the moment
   * they decide, not in an ADR they will never open.
   */
  app.get("/v1/guardrails/detectors", async () => ({
    detectors: guardrailRegistry().map((d) => ({
      id: d.id,
      tier: d.tier,
      phases: d.phases,
      summary: d.summary,
      limits: d.limits,
      ruleCount: d.ruleIds.length,
      ruleIds: d.ruleIds,
      configurable: d.id !== "pii",
    })),
    modes: ["off", "log", "warn", "block"],
    shippedDefaults: GUARDRAIL_DEFAULT_MODES,
    note:
      "Every detector shipped here is HEURISTIC — deterministic local pattern rules, no model. " +
      "They catch literal, unobfuscated phrasings and will both miss novel attacks and fire on " +
      "benign text that discusses these topics. Defence in depth, not a proof of safety.",
  }));

  /** org default + every override, with the agent/connector names resolved. */
  app.get("/v1/guardrails/config", async () => {
    const rows = await db.select().from(guardrailConfigs);
    const org = rows.find((r) => r.scope === "org");
    const overrides = rows.filter((r) => r.scope !== "org");
    const agentIds = overrides.filter((o) => o.scope === "agent").map((o) => o.scopeId!);
    const connectorIds = overrides.filter((o) => o.scope === "connector").map((o) => o.scopeId!);
    const [agentRows, connectorRows] = await Promise.all([
      agentIds.length
        ? db.select({ id: agents.id, name: agents.name }).from(agents).where(inArray(agents.id, agentIds))
        : Promise.resolve([]),
      connectorIds.length
        ? db
            .select({ id: connectors.id, name: connectors.name })
            .from(connectors)
            .where(inArray(connectors.id, connectorIds))
        : Promise.resolve([]),
    ]);
    const names = new Map([...agentRows, ...connectorRows].map((r) => [r.id, r.name]));
    return {
      org: org ?? null,
      /** what applies when `org` is null — the ADR's shipped posture */
      shippedDefaults: GUARDRAIL_DEFAULT_MODES,
      orgModes: org ? rowModes(org) : GUARDRAIL_DEFAULT_MODES,
      overrides: overrides.map((o) => ({
        ...o,
        modes: rowModes(o),
        targetName: names.get(o.scopeId!) ?? null,
      })),
    };
  });

  /** The resolved policy for a hypothetical call, with provenance — "why is
   * semantic_dlp at block for this agent on this project?" answered without
   * making anyone reconstruct the composition in their head. */
  app.get("/v1/guardrails/effective", async (req) => {
    const q = z
      .object({
        projectId: z.string().uuid().optional(),
        agentId: z.string().uuid().optional(),
        connectorId: z.string().uuid().optional(),
      })
      .parse(req.query);
    const policy = await resolveGuardrailPolicy(db, q);
    return {
      modes: policy.modes,
      terms: policy.terms,
      provenance: policy.provenance,
      active: policy.active,
      blocksInput: policy.blocksInput,
      blocksOutput: policy.blocksOutput,
      streamingNote: policy.blocksOutput
        ? "An output-phase detector is at 'block', so responses for this scope are BUFFERED: no delta reaches a client before the completed text has been scanned."
        : "No output-phase detector is at 'block'; delta streaming is delivered live.",
    };
  });

  const upsert = async (
    scope: "org" | "agent" | "connector",
    scopeId: string | null,
    body: z.infer<typeof putGuardrailConfigSchema>,
    actor: string | null,
  ) => {
    const existing = scopeId
      ? (
          await db
            .select()
            .from(guardrailConfigs)
            .where(and(eq(guardrailConfigs.scope, scope), eq(guardrailConfigs.scopeId, scopeId)))
        )[0]
      : await loadOrgGuardrailConfig(db);
    const base = existing ? rowModes(existing) : { ...GUARDRAIL_DEFAULT_MODES };
    const next: Record<string, unknown> = {};
    for (const id of CONFIGURABLE_DETECTORS) {
      next[MODE_COLUMN[id]] = body.modes?.[id] ?? base[id] ?? GUARDRAIL_FALLBACK_MODE;
    }
    const values = {
      scope,
      scopeId,
      ...next,
      customTerms: body.customTerms ?? existing?.customTerms ?? {},
      updatedByUserId: actor,
      updatedAt: new Date(),
    } as typeof guardrailConfigs.$inferInsert;
    const [row] = existing
      ? await db
          .update(guardrailConfigs)
          .set(values)
          .where(eq(guardrailConfigs.id, existing.id))
          .returning()
      : await db.insert(guardrailConfigs).values(values).returning();
    return row!;
  };

  app.put("/v1/guardrails/config", async (req, reply) => {
    const body = putGuardrailConfigSchema.parse(req.body);
    const actor = req.authCtx.userId ?? null;
    const before = previousModes(await loadOrgGuardrailConfig(db));
    const row = await upsert("org", null, body, actor);
    await audit(
      actor,
      row.id,
      "guardrail-config-updated",
      `org guardrail defaults set — ${modeTransitions(before, rowModes(row))}. A compliance profile can still RAISE any of these for a classified project; nothing here can lower a framework floor.`,
      { scope: "org", modes: rowModes(row), previousModes: before },
    );
    return reply.status(200).send({ config: row, modes: rowModes(row) });
  });

  app.put("/v1/guardrails/config/:scope/:scopeId", async (req, reply) => {
    const { scope, scopeId } = scopeParam.parse(req.params);
    const body = putGuardrailConfigSchema.parse(req.body);
    // the target must exist — an override pointing at nothing is a
    // configuration that silently never applies
    const [target] =
      scope === "agent"
        ? await db.select({ id: agents.id, name: agents.name }).from(agents).where(eq(agents.id, scopeId))
        : await db
            .select({ id: connectors.id, name: connectors.name })
            .from(connectors)
            .where(eq(connectors.id, scopeId));
    if (!target) return reply.status(404).send({ error: `unknown_${scope}` });
    const actor = req.authCtx.userId ?? null;
    // the override's previous modes; with no override yet, the org default was in force
    const [existingOverride] = await db
      .select()
      .from(guardrailConfigs)
      .where(and(eq(guardrailConfigs.scope, scope), eq(guardrailConfigs.scopeId, scopeId)));
    const before = previousModes(existingOverride ?? (await loadOrgGuardrailConfig(db)));
    const row = await upsert(scope, scopeId, body, actor);
    await audit(
      actor,
      row.id,
      "guardrail-config-updated",
      `guardrail override for ${scope} '${target.name}' — ${modeTransitions(before, rowModes(row))}. It replaces the org default for this object and is still MAX-composed with any compliance floor.`,
      { scope, scopeId, targetName: target.name, modes: rowModes(row), previousModes: before },
    );
    return reply.status(200).send({ config: row, modes: rowModes(row) });
  });

  app.delete("/v1/guardrails/config/:scope/:scopeId", async (req, reply) => {
    const { scope, scopeId } = scopeParam.parse(req.params);
    const [row] = await db
      .delete(guardrailConfigs)
      .where(and(eq(guardrailConfigs.scope, scope), eq(guardrailConfigs.scopeId, scopeId)))
      .returning();
    if (!row) return reply.status(404).send({ error: "unknown_override" });
    await audit(
      req.authCtx.userId ?? null,
      row.id,
      "guardrail-config-deleted",
      `guardrail override for ${scope} ${scopeId} removed — the org default applies again`,
      { scope, scopeId },
    );
    return reply.status(200).send({ deleted: true });
  });

  /**
   * Recent violations. A QUERY over the one audit log, not a second ledger —
   * `guardrail-blocked | guardrail-warned | guardrail-logged` rows, newest
   * first. Everything shown is counts-only by construction.
   */
  app.get("/v1/guardrails/violations", async (req) => {
    const q = z
      .object({
        limit: z.coerce.number().int().min(1).max(500).default(50),
        outcome: z.enum(["blocked", "warned", "logged"]).optional(),
      })
      .parse(req.query);
    const ruleIds = q.outcome
      ? [`guardrail-${q.outcome}`]
      : ["guardrail-blocked", "guardrail-warned", "guardrail-logged"];
    const rows = await db
      .select()
      .from(auditLog)
      .where(inArray(auditLog.ruleId, ruleIds))
      .orderBy(desc(auditLog.at))
      .limit(q.limit);
    const counts = await db
      .select({ ruleId: auditLog.ruleId, n: sql<number>`count(*)::int` })
      .from(auditLog)
      .where(
        inArray(auditLog.ruleId, ["guardrail-blocked", "guardrail-warned", "guardrail-logged"]),
      )
      .groupBy(auditLog.ruleId);
    return {
      violations: rows,
      totals: Object.fromEntries(counts.map((c) => [c.ruleId.replace("guardrail-", ""), c.n])),
      note: "Sourced from the single audit log — the same table every other governed decision lands in. Counts only; no matched content is stored anywhere.",
    };
  });

  /**
   * The tuning sandbox: run every detector over a sample string and report the
   * counts, WITHOUT enforcing anything and without a provider call. This is how
   * an admin measures a layer's false-positive profile on their own corpus
   * before moving it off `log` — the ADR's "built to be tuned into strictness"
   * made operable.
   */
  app.post("/v1/guardrails/sample", async (req) => {
    const body = guardrailSampleSchema.parse(req.body);
    // every configurable detector forced to 'log' so the sandbox reports what
    // WOULD fire regardless of the org's current posture
    const modes = Object.fromEntries(
      GUARDRAIL_DETECTOR_IDS.map((id) => [id, "log" as GuardrailMode]),
    ) as GuardrailModes;
    const orgRow = await loadOrgGuardrailConfig(db);
    const terms = composeGuardrailTerms(orgRow?.customTerms ?? null);
    const evaluation = evaluateGuardrails({ phase: body.phase, text: body.text, modes, terms });
    return {
      phase: body.phase,
      findings: flattenFindings(evaluation.findings),
      clean: evaluation.findings.length === 0,
      note: "Detection only — nothing was enforced, audited as a violation, or dispatched.",
    };
  });
}
