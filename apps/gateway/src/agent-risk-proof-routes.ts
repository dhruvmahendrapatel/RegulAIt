/**
 * ADR-0345 slice 3: the agent-risk register's read and settings APIs.
 *
 *   GET  /v1/agent-risks                                  the catalogue: every risk, its OWASP references, its
 *                                                         controls and its proofs, each proof with its effective
 *                                                         schedule and its latest result labelled as evidence
 *   GET  /v1/agent-risks/proofs/:proofKey/results         one proof's results, newest first, each labelled
 *   PUT  /v1/agent-risks/proofs/:proofKey/settings        turn a proof on or off, or change its interval
 *
 * All three are admin-only through the default gate (none is in `NON_ADMIN_ROUTES`); the evidence tables are also
 * admin-read under RLS. Nothing here writes evidence: results come only from the proof runner (slice 2a).
 *
 * Secure by default (ADR-0180): a proof with no settings row runs, at its catalogue interval. Turning a proof off, or
 * moving its interval past the catalogue default, is a relaxation, which needs a `settings_relax` step-up bound to
 * the exact values (`requireRelaxStepUp`). Tightening needs none. Every change is audited with its reason, before and
 * after, in the same transaction as the write.
 *
 * Only a passing result whose evidence still holds counts (`countsAsEvidence`); the read shows each label (`verified`,
 * `unsigned`, `unverifiable` with its reason), never a pass without one.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { agentRiskProofResults, agentRiskProofSettings, and, auditLog, desc, eq, lt, or, type Db } from "@regulait/db";
import {
  AGENT_RISK_CATALOG_VERSION,
  AGENT_RISK_PROOF_KEY_PATTERN,
  AGENT_RISKS,
  agentRiskProofByKey,
  agentRiskProofSettingsSchema,
  type AgentRiskProof,
} from "@regulait/shared";
import { checkAgentRiskProofEvidence, countsAsEvidence, latestAgentRiskProofs } from "./agent-risk-proof-evidence.js";
import { requireRelaxStepUp } from "./step-up.js";
import { SYSTEM_ATTRIBUTION_ID } from "./system-attribution.js";

export const AGENT_RISK_PROOF_SETTINGS_RULE_ID = "agent-risk-proof-settings";

/** the largest page of results the history read returns */
export const AGENT_RISK_RESULTS_PAGE_MAX = 100;

const proofParam = z.object({ proofKey: z.string().max(120).regex(AGENT_RISK_PROOF_KEY_PATTERN) }).strict();
const resultsQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(AGENT_RISK_RESULTS_PAGE_MAX).default(25),
    /** keyset cursor: the `cursor` of the previous page (`<finishedAt ISO>_<id>`) */
    cursor: z
      .string()
      .max(80)
      .regex(/^\d{4}-\d{2}-\d{2}T[0-9:.]+Z_[0-9a-f-]{36}$/)
      .optional(),
  })
  .strict();

interface EffectiveSetting {
  enabled: boolean;
  /** null = the catalogue default */
  intervalHours: number | null;
  effectiveIntervalHours: number;
  /** true when this proof runs on its secure default (on, at the catalogue interval) */
  secureDefault: boolean;
  updatedAt: Date | null;
  updatedByUserId: string | null;
}

function effectiveSetting(proof: AgentRiskProof, row: typeof agentRiskProofSettings.$inferSelect | undefined): EffectiveSetting {
  const enabled = row?.enabled ?? true;
  const intervalHours = row?.intervalHours ?? null;
  const effectiveIntervalHours = intervalHours ?? proof.defaultIntervalHours;
  return {
    enabled,
    intervalHours,
    effectiveIntervalHours,
    secureDefault: enabled && effectiveIntervalHours <= proof.defaultIntervalHours,
    updatedAt: row?.updatedAt ?? null,
    updatedByUserId: row?.updatedByUserId ?? null,
  };
}

/**
 * The relaxations a settings write makes, as the `{values}` the step-up is bound to. A value is relaxed when it is
 * looser than the secure default (off, or an interval past the catalogue default) and differs from what is stored.
 */
export function agentRiskProofRelaxations(
  proof: AgentRiskProof,
  current: EffectiveSetting,
  next: { enabled: boolean; intervalHours: number | null },
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const ns = `agentRiskProof.${proof.key}`;
  if (!next.enabled && current.enabled) out[`${ns}.enabled`] = false;
  const nextEffective = next.intervalHours ?? proof.defaultIntervalHours;
  if (nextEffective > proof.defaultIntervalHours && nextEffective !== current.effectiveIntervalHours) {
    out[`${ns}.intervalHours`] = nextEffective;
  }
  return out;
}

export function registerAgentRiskProofRoutes(app: FastifyInstance, db: Db): void {
  /** the whole register: bounded by the catalogue (a fixed, versioned list), so it is not paginated */
  app.get("/v1/agent-risks", async () => {
    const [settings, latest] = await Promise.all([db.select().from(agentRiskProofSettings), latestAgentRiskProofs(db)]);
    const settingByKey = new Map(settings.map((s) => [s.proofKey, s]));
    const latestByKey = new Map(latest.map((l) => [l.proofKey, l.latest]));
    let proofs = 0;
    let passingWithEvidence = 0;
    const risks = AGENT_RISKS.map((risk) => ({
      key: risk.key,
      title: risk.title,
      registerCategories: risk.registerCategories,
      owaspRefs: risk.owaspRefs,
      owaspAgentic: risk.owaspAgentic,
      controls: risk.controls,
      proofs: risk.proofs.map((proof) => {
        const result = latestByKey.get(proof.key) ?? null;
        proofs += 1;
        const evidenced = result !== null && countsAsEvidence(result.outcome, result.evidence);
        if (evidenced) passingWithEvidence += 1;
        return {
          key: proof.key,
          engine: proof.engine,
          assertion: proof.assertion,
          defaultIntervalHours: proof.defaultIntervalHours,
          setting: effectiveSetting(proof, settingByKey.get(proof.key)),
          latest: result,
          countsAsEvidence: evidenced,
        };
      }),
    }));
    return { catalogVersion: AGENT_RISK_CATALOG_VERSION, summary: { proofs, passingWithEvidence }, risks };
  });

  /** one proof's results, newest first, keyset-paged; each labelled as evidence */
  app.get("/v1/agent-risks/proofs/:proofKey/results", async (req, reply) => {
    const { proofKey } = proofParam.parse(req.params);
    const q = resultsQuery.parse(req.query ?? {});
    if (!agentRiskProofByKey(proofKey)) return reply.status(404).send({ error: "unknown_proof" });
    let after: ReturnType<typeof or> | undefined;
    if (q.cursor) {
      const sep = q.cursor.lastIndexOf("_");
      const at = new Date(q.cursor.slice(0, sep));
      const id = q.cursor.slice(sep + 1);
      if (Number.isNaN(at.getTime())) return reply.status(400).send({ error: "bad_cursor" });
      after = or(lt(agentRiskProofResults.finishedAt, at), and(eq(agentRiskProofResults.finishedAt, at), lt(agentRiskProofResults.id, id)));
    }
    const rows = await db
      .select()
      .from(agentRiskProofResults)
      .where(and(eq(agentRiskProofResults.proofKey, proofKey), after))
      .orderBy(desc(agentRiskProofResults.finishedAt), desc(agentRiskProofResults.id))
      .limit(q.limit + 1);
    const page = rows.slice(0, q.limit);
    const checks = await checkAgentRiskProofEvidence(db, page);
    const last = page[page.length - 1];
    return {
      proofKey,
      results: page.map((r) => {
        const evidence = checks.get(r.id)!;
        return {
          id: r.id,
          catalogVersion: r.catalogVersion,
          trigger: r.trigger,
          outcome: r.outcome,
          startedAt: r.startedAt,
          finishedAt: r.finishedAt,
          detail: r.detail,
          contentHash: r.contentHash,
          signed: r.signature !== null,
          signingKeyId: r.signingKeyId,
          auditLogId: r.auditLogId,
          evidence,
          countsAsEvidence: countsAsEvidence(r.outcome, evidence),
        };
      }),
      nextCursor: rows.length > q.limit && last ? `${last.finishedAt.toISOString()}_${last.id}` : null,
    };
  });

  /** turn a proof on or off, or change its interval; a relaxation needs a `settings_relax` step-up */
  app.put("/v1/agent-risks/proofs/:proofKey/settings", async (req, reply) => {
    const { proofKey } = proofParam.parse(req.params);
    const body = agentRiskProofSettingsSchema.parse(req.body);
    const entry = agentRiskProofByKey(proofKey);
    if (!entry) return reply.status(404).send({ error: "unknown_proof" });
    const { proof } = entry;
    const [stored] = await db.select().from(agentRiskProofSettings).where(eq(agentRiskProofSettings.proofKey, proofKey));
    const before = effectiveSetting(proof, stored);
    const relaxed = agentRiskProofRelaxations(proof, before, body);
    if (!(await requireRelaxStepUp(db, req, reply, relaxed))) return reply;
    const actor = req.authCtx.userId ?? null;
    const after = await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      const [row] = await tx
        .insert(agentRiskProofSettings)
        .values({ proofKey, enabled: body.enabled, intervalHours: body.intervalHours, updatedByUserId: actor })
        .onConflictDoUpdate({
          target: agentRiskProofSettings.proofKey,
          set: { enabled: body.enabled, intervalHours: body.intervalHours, updatedByUserId: actor, updatedAt: new Date() },
        })
        .returning();
      const next = effectiveSetting(proof, row);
      await tx.insert(auditLog).values({
        userId: actor ?? SYSTEM_ATTRIBUTION_ID,
        objectType: "agent_risk_proof",
        objectId: null,
        detail: {
          proofKey,
          via: req.authCtx.via,
          before: { enabled: before.enabled, intervalHours: before.intervalHours },
          after: { enabled: next.enabled, intervalHours: next.intervalHours },
          relaxed: Object.keys(relaxed),
          reason: body.reason,
        },
        effect: "allow",
        ruleId: AGENT_RISK_PROOF_SETTINGS_RULE_ID,
        ruleChain: [],
        reason:
          `agent-risk proof '${proofKey}': ${next.enabled ? `on, every ${next.effectiveIntervalHours}h` : "off"}` +
          `${Object.keys(relaxed).length ? " (a relaxation, stepped up)" : ""} — reason: ${body.reason}`,
      });
      return next;
    });
    return reply.send({ proofKey, setting: after, relaxed: Object.keys(relaxed) });
  });
}
