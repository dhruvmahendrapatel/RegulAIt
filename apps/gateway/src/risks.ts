/**
 * ADR-0081 — THE AI RISK REGISTER, the gateway half (gap L2,
 * docs/product/GAP_ANALYSIS_CREDO_AI_2026-08.md).
 *
 *   `packages/shared/src/risks.ts`   the vocabulary, the fixed category →
 *                                    resolver mapping, the request shapes,
 *                                    the seed library, the disclaimer. Pure.
 *   THIS FILE                        the EVIDENCE RESOLVERS (real SELECTs
 *                                    over real ledgers), the register API,
 *                                    the audited transitions, the audited
 *                                    residual-risk acceptance.
 *
 * THE THREE PROPERTIES THIS FILE EXISTS TO GUARANTEE
 * --------------------------------------------------
 *  1. EVIDENCE IS A QUERY, NEVER A TICK-BOX — the ADR-0058 discipline applied
 *     to risk. `resolveRiskEvidence` is the only way a risk gets a number,
 *     and every branch is a SELECT against a ledger this deployment already
 *     writes — `redteam_runs`, `eval_runs`, `guardrail_configs`, `audit_log`,
 *     the grant tables, `shadow_ai_findings`, `compliance_profiles` — mostly
 *     THROUGH the ADR-0058 `runCollector` queries themselves rather than a
 *     re-implementation. There is no evidence column in migration 0087 for
 *     anyone to set. A category no ledger measures returns
 *     `evidence: "none — attestation only"` outright.
 *
 *  2. MEASURED AND DECLARED NEVER BLEND. The detail response carries the
 *     owner's likelihood/impact under `declared` and the ledger numbers under
 *     `evidence` — two labelled blocks, no combined score, no risk
 *     arithmetic. A 3x3 of two enums is not quantified risk math and this
 *     register does not pretend it is.
 *
 *  3. ACCEPTANCE IS A RECORD, NOT A PATCH. `status` cannot be written by
 *     PATCH (refused BY NAME, 422); open/mitigating/closed move through an
 *     audited transition endpoint; and `accepted` is reachable only through
 *     the admin-only acceptance endpoint, which records who, when, why — and
 *     what every evidence resolver measured at that moment, into the audit
 *     row's detail, so the acceptance stays readable after the ledgers move.
 *
 * WHAT THIS FILE DOES NOT DO — stated because a governance product that
 * overstates itself is worse than one that ships less: nothing here enforces
 * anything. The mitigating controls a risk names are enforced where they
 * always were (pillar 1, ADR-0040/0042, the budget caps); this register makes
 * the measurements legible AS RISK. And nothing auto-creates risks: every row
 * was registered by a person.
 */
import type { FastifyInstance } from "fastify";
import {
  agentGrants,
  agents,
  aiRisks,
  aiUseCases,
  and,
  auditLog,
  connectorGrants,
  count,
  desc,
  eq,
  evalDatasets,
  evalRuns,
  gte,
  inArray,
  lt,
  projects,
  redteamRuns,
  shadowAiFindings,
  toolGrants,
  users,
  type AiRiskRow,
  type Db,
} from "@regulait/db";
import {
  AI_RISK_REGISTER_DISCLAIMER,
  DEFAULT_RISK_LIBRARY,
  RISK_CATEGORY_EVIDENCE,
  acceptRiskSchema,
  createRiskSchema,
  transitionRiskSchema,
  updateRiskSchema,
  type AiRiskCategory,
  type RiskEvidenceResolverId,
} from "@regulait/shared";
import { z } from "zod";
import { runCollector, type CollectorContext } from "./compliance-packs.js";

const NO_IDENTITY = "00000000-0000-0000-0000-000000000000";
const riskIdParam = z.object({ riskId: z.string().uuid() });

/** the evidence window: how far back the period-scoped resolvers look */
export const RISK_EVIDENCE_WINDOW_DAYS = 90;

/** stable rule ids — the strings an operator greps the audit log for */
export const RISK_RULE_IDS = {
  registered: "risk-registered",
  updated: "risk-updated",
  transitioned: (to: string) => `risk-${to}`,
  accepted: "risk-accepted",
} as const;

/** kept in lockstep with @regulait/shared's ADR-0067 scorer kinds — the
 * subset of EVAL_SCORER_KINDS that measures groundedness. Exported for the
 * ADR-0082 inventory/posture aggregations so "a groundedness eval" means the
 * same thing everywhere. */
export const GROUNDEDNESS_SCORER_KINDS = [
  "claim_support",
  "context_precision",
  "context_recall",
  "answer_relevance",
  "groundedness_judge",
  "answer_relevance_judge",
] as const;

// ---------------------------------------------------------------------------
// THE EVIDENCE RESOLVERS — every number a SELECT, most of them ADR-0058's own
// ---------------------------------------------------------------------------

export interface RiskEvidenceEntry {
  resolver: RiskEvidenceResolverId;
  /** 'measured' = events/results in the window; 'configuration' = current
   * state of a control; 'none' = no ledger measures this category */
  kind: "measured" | "configuration" | "none";
  /** the ledger(s) selected from — null only for 'none' */
  source: string | null;
  /** what was queried, in prose an auditor can re-run */
  queried: string | null;
  /** the numbers, verbatim from the ledger — null only for 'none' */
  measured: Record<string, unknown> | null;
  /** for 'none': the honest empty-handed answer, stated outright */
  evidence?: string;
  note?: string;
}

export interface RiskEvidenceBlock {
  window: { start: string; end: string; days: number };
  /** the slice the queries were scoped to — references, never copies */
  scope: { projectId: string | null; agentId: string | null };
  entries: RiskEvidenceEntry[];
  computedAt: string;
  note: string;
  disclaimer: string;
}

/**
 * Compute a risk's evidence live from the ledgers. The category's resolver
 * list is FIXED in @regulait/shared (`RISK_CATEGORY_EVIDENCE`) — a risk
 * cannot choose its own queries. Where a resolver's semantics are exactly an
 * ADR-0058 collector, `runCollector` runs it — one query implementation, not
 * two that could drift.
 */
export async function resolveRiskEvidence(
  db: Db,
  risk: Pick<AiRiskRow, "category" | "projectId" | "agentId">,
  now: Date = new Date(),
): Promise<RiskEvidenceBlock> {
  const periodEnd = now;
  const periodStart = new Date(now.getTime() - RISK_EVIDENCE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const projectIds = risk.projectId ? [risk.projectId] : null;
  const ctx = (params: CollectorContext["params"]): CollectorContext => ({
    periodStart,
    periodEnd,
    projectIds,
    // memberIds is consulted only by the 'approvals' collector, which no risk
    // resolver uses; keep the "null exactly when projectIds is null" contract
    memberIds: projectIds === null ? null : [],
    params,
  });

  const entries: RiskEvidenceEntry[] = [];
  for (const resolver of RISK_CATEGORY_EVIDENCE[risk.category as AiRiskCategory]) {
    switch (resolver) {
      case "none": {
        entries.push({
          resolver,
          kind: "none",
          source: null,
          queried: null,
          measured: null,
          evidence: "none — attestation only",
          note:
            "no ledger in this deployment measures this category; the register says so rather " +
            "than inventing a proxy. The mitigating control here is procedural and the " +
            "customer's own.",
        });
        break;
      }

      case "redteam_asr": {
        // ADR-0068's statistics, surfaced verbatim: the pooled ASR rides with
        // its trial denominator and measurement-quality label, never alone.
        const where = and(
          gte(redteamRuns.startedAt, periodStart),
          lt(redteamRuns.startedAt, periodEnd),
          ...(risk.agentId ? [eq(redteamRuns.agentId, risk.agentId)] : []),
          ...(projectIds === null ? [] : [inArray(redteamRuns.projectId, projectIds)]),
        );
        const [n] = await db.select({ n: count() }).from(redteamRuns).where(where);
        const [latest] = await db
          .select({
            id: redteamRuns.id,
            asr: redteamRuns.asr,
            asrLower: redteamRuns.asrLower,
            asrUpper: redteamRuns.asrUpper,
            asrTrials: redteamRuns.asrTrials,
            measurementQuality: redteamRuns.measurementQuality,
            platformHeld: redteamRuns.platformHeld,
            startedAt: redteamRuns.startedAt,
          })
          .from(redteamRuns)
          .where(where)
          .orderBy(desc(redteamRuns.startedAt))
          .limit(1);
        entries.push({
          resolver,
          kind: "measured",
          source: "redteam_runs",
          queried:
            "red-team runs started in the window" +
            (risk.agentId ? ", scoped to this risk's agent" : "") +
            (projectIds ? ", scoped to this risk's project" : "") +
            "; the latest run's pooled attack-success rate with its Wilson interval, trial " +
            "denominator, and measurement-quality label (ADR-0068)",
          measured: {
            runsInWindow: n?.n ?? 0,
            latestRun: latest
              ? {
                  id: latest.id,
                  asr: latest.asr,
                  asrLower: latest.asrLower,
                  asrUpper: latest.asrUpper,
                  asrTrials: latest.asrTrials,
                  measurementQuality: latest.measurementQuality,
                  platformHeld: latest.platformHeld,
                  startedAt: latest.startedAt,
                }
              : null,
          },
          note:
            (n?.n ?? 0) === 0
              ? "no red-team run in the window — an unmeasured attack surface, not a resisted one"
              : undefined,
        });
        break;
      }

      case "guardrail_config": {
        const configsAtBlock = await runCollector(db, "guardrail_configs", ctx({
          detector: "prompt_injection",
          minMode: "block",
        }));
        entries.push({
          resolver,
          kind: "configuration",
          source: "guardrail_configs",
          queried:
            "guardrail configs with prompt-injection detection at 'block' (ADR-0042) — " +
            "configuration evidence: a quiet period is not proof a runtime control exists",
          measured: { configsAtBlock },
        });
        break;
      }

      case "pii_denials": {
        const denials = await runCollector(db, "audit_decisions", ctx({
          effect: "deny",
          ruleIdPrefix: "pii-",
        }));
        entries.push({
          resolver,
          kind: "measured",
          source: "audit_log",
          queried:
            "audit_log rows in the window with effect='deny' and rule_id starting 'pii-' — " +
            "every PII block the gateway actually performed",
          measured: { denials },
        });
        break;
      }

      case "pii_cascade_config": {
        const profilesForcingBlock = await runCollector(db, "compliance_profile_cascade", ctx({
          cascadeAspect: "pii_block",
        }));
        entries.push({
          resolver,
          kind: "configuration",
          source: "compliance_profiles",
          queried:
            "compliance profiles whose §8.3 cascade forces PII block mode — the configuration " +
            "evidence beside the denial trail",
          measured: { profilesForcingBlock },
        });
        break;
      }

      case "governed_denials": {
        const [mcpTool, agent, connector] = await Promise.all([
          runCollector(db, "audit_decisions", ctx({ effect: "deny", objectType: "mcp_tool" })),
          runCollector(db, "audit_decisions", ctx({ effect: "deny", objectType: "agent" })),
          runCollector(db, "audit_decisions", ctx({ effect: "deny", objectType: "connector" })),
        ]);
        entries.push({
          resolver,
          kind: "measured",
          source: "audit_log",
          queried:
            "audit_log deny rows in the window for mcp_tool, agent, and connector objects — " +
            "the governed-denial trail proving default-deny decides real calls",
          measured: {
            mcpTool,
            agent,
            connector,
            total: (mcpTool ?? 0) + (agent ?? 0) + (connector ?? 0),
          },
        });
        break;
      }

      case "abac_policies": {
        const activePolicies = await runCollector(db, "abac_policies_active", ctx({}));
        entries.push({
          resolver,
          kind: "configuration",
          source: "abac_policies",
          queried: "enabled ABAC policies with an active version (ADR-0040)",
          measured: { activePolicies },
        });
        break;
      }

      case "active_grants": {
        const [tools, agentsN, connectorsN] = await Promise.all([
          db.select({ n: count() }).from(toolGrants),
          db.select({ n: count() }).from(agentGrants),
          db.select({ n: count() }).from(connectorGrants),
        ]);
        entries.push({
          resolver,
          kind: "configuration",
          source: "tool_grants, agent_grants, connector_grants",
          queried:
            "the live standing-grant inventory: per-user tool, agent, and connector grants — " +
            "state evidence, org-wide (grants are not project-scoped objects)",
          measured: {
            toolGrants: tools[0]?.n ?? 0,
            agentGrants: agentsN[0]?.n ?? 0,
            connectorGrants: connectorsN[0]?.n ?? 0,
          },
        });
        break;
      }

      case "budget_refusals": {
        // one count per ENFORCEMENT POINT, so the evidence says which ceiling
        // actually refused — reusing the ADR-0058 audit query for each
        const [projectCaps, runCaps, nodeCaps, virtualKeys] = await Promise.all([
          runCollector(db, "audit_decisions", ctx({ effect: "deny", ruleIdPrefix: "project-budget" })),
          runCollector(db, "audit_decisions", ctx({ effect: "deny", ruleIdPrefix: "run-budget" })),
          runCollector(db, "audit_decisions", ctx({ effect: "deny", ruleIdPrefix: "node-budget" })),
          runCollector(db, "audit_decisions", ctx({ effect: "deny", ruleIdPrefix: "virtual-key-budget" })),
        ]);
        entries.push({
          resolver,
          kind: "measured",
          source: "audit_log",
          queried:
            "audit_log deny rows in the window from each budget enforcement point: project " +
            "caps, orchestration run/node caps, virtual-key exhaustion (pillar 5)",
          measured: {
            projectCaps,
            runCaps,
            nodeCaps,
            virtualKeys,
            total: (projectCaps ?? 0) + (runCaps ?? 0) + (nodeCaps ?? 0) + (virtualKeys ?? 0),
          },
        });
        break;
      }

      case "groundedness_evals": {
        const where = and(
          gte(evalRuns.startedAt, periodStart),
          lt(evalRuns.startedAt, periodEnd),
          inArray(evalDatasets.scorerKind, [...GROUNDEDNESS_SCORER_KINDS]),
          ...(risk.agentId ? [eq(evalRuns.agentId, risk.agentId)] : []),
          ...(projectIds === null ? [] : [inArray(evalRuns.projectId, projectIds)]),
        );
        const joined = db
          .select({ n: count() })
          .from(evalRuns)
          .innerJoin(
            evalDatasets,
            and(
              eq(evalRuns.datasetId, evalDatasets.id),
              eq(evalRuns.datasetVersion, evalDatasets.version),
            ),
          );
        const [n] = await joined.where(where);
        const [latest] = await db
          .select({
            id: evalRuns.id,
            scorerKind: evalDatasets.scorerKind,
            passRate: evalRuns.passRate,
            meanScore: evalRuns.meanScore,
            cases: evalRuns.cases,
            startedAt: evalRuns.startedAt,
          })
          .from(evalRuns)
          .innerJoin(
            evalDatasets,
            and(
              eq(evalRuns.datasetId, evalDatasets.id),
              eq(evalRuns.datasetVersion, evalDatasets.version),
            ),
          )
          .where(where)
          .orderBy(desc(evalRuns.startedAt))
          .limit(1);
        entries.push({
          resolver,
          kind: "measured",
          source: "eval_runs",
          queried:
            "eval runs in the window whose dataset's default scorer is an ADR-0067 " +
            "groundedness metric" +
            (risk.agentId ? ", scoped to this risk's agent" : "") +
            "; the latest such run's pass rate and case count",
          measured: {
            runsInWindow: n?.n ?? 0,
            latestRun: latest ?? null,
          },
          note:
            (n?.n ?? 0) === 0
              ? "no groundedness eval in the window — hallucination is unmeasured here, not absent"
              : undefined,
        });
        break;
      }

      case "shadow_findings": {
        const [open] = await db
          .select({ n: count() })
          .from(shadowAiFindings)
          .where(eq(shadowAiFindings.disposition, "open"));
        const [total] = await db.select({ n: count() }).from(shadowAiFindings);
        const [seenInWindow] = await db
          .select({ n: count() })
          .from(shadowAiFindings)
          .where(
            and(gte(shadowAiFindings.lastSeenAt, periodStart), lt(shadowAiFindings.lastSeenAt, periodEnd)),
          );
        entries.push({
          resolver,
          kind: "measured",
          source: "shadow_ai_findings",
          queried:
            "shadow-AI findings (ADR-0071): open vs total dispositions, and findings last " +
            "seen inside the window — org-wide, because unsanctioned usage has no project",
          measured: {
            open: open?.n ?? 0,
            total: total?.n ?? 0,
            seenInWindow: seenInWindow?.n ?? 0,
          },
        });
        break;
      }

      default: {
        // an unknown resolver is NOT silently skipped — same posture as
        // runCollector's unknown-collector branch
        throw new Error(`unknown risk evidence resolver '${resolver as string}'`);
      }
    }
  }

  return {
    window: {
      start: periodStart.toISOString(),
      end: periodEnd.toISOString(),
      days: RISK_EVIDENCE_WINDOW_DAYS,
    },
    scope: { projectId: risk.projectId ?? null, agentId: risk.agentId ?? null },
    entries,
    computedAt: now.toISOString(),
    note:
      "computed live from this deployment's own ledgers — nothing here is stored on the risk " +
      "row, and nothing a human declares changes these numbers",
    disclaimer: AI_RISK_REGISTER_DISCLAIMER,
  };
}

/** the compact evidence summary an acceptance freezes into its audit row */
function summarizeEvidence(block: RiskEvidenceBlock): Array<Record<string, unknown>> {
  return block.entries.map((e) => ({
    resolver: e.resolver,
    kind: e.kind,
    ...(e.measured ? { measured: e.measured } : { evidence: e.evidence ?? null }),
  }));
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function registerRiskRoutes(app: FastifyInstance, db: Db): void {
  async function validateReferences(body: {
    projectId?: string | null;
    agentId?: string | null;
    useCaseId?: string | null;
  }): Promise<{ ok: true } | { ok: false; field: string }> {
    if (body.projectId) {
      const [p] = await db.select({ id: projects.id }).from(projects).where(eq(projects.id, body.projectId));
      if (!p) return { ok: false, field: "projectId" };
    }
    if (body.agentId) {
      const [a] = await db.select({ id: agents.id }).from(agents).where(eq(agents.id, body.agentId));
      if (!a) return { ok: false, field: "agentId" };
    }
    if (body.useCaseId) {
      const [u] = await db
        .select({ id: aiUseCases.id })
        .from(aiUseCases)
        .where(eq(aiUseCases.id, body.useCaseId));
      if (!u) return { ok: false, field: "useCaseId" };
    }
    return { ok: true };
  }

  // The seed library and the resolver vocabulary — static data, so the UI's
  // "register from library" picker and the API tell one story.
  app.get("/v1/risks/library", async () => ({
    library: DEFAULT_RISK_LIBRARY,
    categoryEvidence: RISK_CATEGORY_EVIDENCE,
    disclaimer: AI_RISK_REGISTER_DISCLAIMER,
  }));

  // Register: non-admin on purpose — naming a risk is the front door, and the
  // person walking through it owns what they register. Admins may assign an
  // owner; everyone else is refused an ownerUserId that is not their own.
  app.post("/v1/risks", async (req, reply) => {
    const body = createRiskSchema.parse(req.body);
    const callerId = req.authCtx.userId;
    const ownerUserId = body.ownerUserId ?? callerId;
    if (!ownerUserId) {
      return reply.status(400).send({
        error: "owner_required",
        detail: "the bootstrap token has no identity — name an ownerUserId for the risk",
      });
    }
    if (!req.authCtx.isAdmin && ownerUserId !== callerId) {
      return reply.status(403).send({
        error: "forbidden",
        detail: "only an admin can register a risk owned by someone else",
      });
    }
    const [owner] = await db.select({ id: users.id }).from(users).where(eq(users.id, ownerUserId));
    if (!owner) return reply.status(400).send({ error: "invalid_reference", field: "ownerUserId" });
    const refs = await validateReferences(body);
    if (!refs.ok) return reply.status(400).send({ error: "invalid_reference", field: refs.field });

    const [row] = await db
      .insert(aiRisks)
      .values({
        title: body.title,
        description: body.description,
        category: body.category,
        ownerUserId,
        likelihood: body.likelihood,
        impact: body.impact,
        mitigation: body.mitigation ?? null,
        projectId: body.projectId ?? null,
        agentId: body.agentId ?? null,
        useCaseId: body.useCaseId ?? null,
        status: "open",
      })
      .returning();
    await db.insert(auditLog).values({
      userId: callerId ?? NO_IDENTITY,
      objectType: "ai_risk",
      objectId: row!.id,
      detail: {
        phase: "registered",
        title: body.title,
        category: body.category,
        likelihood: body.likelihood,
        impact: body.impact,
        ownerUserId,
        projectId: body.projectId ?? null,
        agentId: body.agentId ?? null,
        useCaseId: body.useCaseId ?? null,
      },
      effect: "allow",
      ruleId: RISK_RULE_IDS.registered,
      ruleChain: [],
      reason:
        `AI risk '${body.title}' registered (category ${body.category}) — likelihood/impact are ` +
        `the owner's DECLARED judgments; evidence is computed from the ledgers at read time`,
    });
    return reply.status(201).send(row);
  });

  // List: fleet for admins, own risks for everyone else — the same scoping
  // shape as GET /v1/use-cases.
  app.get("/v1/risks", async (req, reply) => {
    const q = z
      .object({
        status: z.enum(["open", "mitigating", "accepted", "closed"]).optional(),
        category: z
          .enum([
            "tool_misuse",
            "scope_drift",
            "prompt_injection",
            "data_leakage_pii",
            "over_permissioning",
            "budget_overrun",
            "hallucination",
            "shadow_ai",
          ])
          .optional(),
      })
      .parse(req.query);
    const conditions = [];
    if (q.status) conditions.push(eq(aiRisks.status, q.status));
    if (q.category) conditions.push(eq(aiRisks.category, q.category));
    if (!req.authCtx.isAdmin) {
      if (!req.authCtx.userId) return reply.status(403).send({ error: "bootstrap_has_no_risks" });
      conditions.push(eq(aiRisks.ownerUserId, req.authCtx.userId));
    }
    const rows = await db
      .select()
      .from(aiRisks)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(aiRisks.createdAt))
      .limit(200);
    const ownerIds = [...new Set(rows.map((r) => r.ownerUserId))];
    const ownerRows = ownerIds.length
      ? await db
          .select({ id: users.id, displayName: users.displayName, email: users.email })
          .from(users)
          .where(inArray(users.id, ownerIds))
      : [];
    const ownerName = new Map(ownerRows.map((u) => [u.id, u.displayName || u.email]));
    return {
      risks: rows.map((r) => ({ ...r, ownerName: ownerName.get(r.ownerUserId) ?? null })),
      disclaimer: AI_RISK_REGISTER_DISCLAIMER,
    };
  });

  // Detail: the row split into DECLARED (the human's judgments and the
  // acceptance record) and EVIDENCE (the live ledger queries) — labelled,
  // side by side, never blended.
  app.get("/v1/risks/:riskId", async (req, reply) => {
    const { riskId } = riskIdParam.parse(req.params);
    const [row] = await db.select().from(aiRisks).where(eq(aiRisks.id, riskId));
    if (!row) return reply.status(404).send({ error: "not_found" });
    if (!req.authCtx.isAdmin && req.authCtx.userId !== row.ownerUserId) {
      return reply.status(403).send({
        error: "forbidden",
        detail: "a risk is visible to its owner and to admins",
      });
    }
    return {
      risk: row,
      declared: {
        likelihood: row.likelihood,
        impact: row.impact,
        status: row.status,
        mitigation: row.mitigation,
        acceptance:
          row.status === "accepted"
            ? {
                acceptedByUserId: row.acceptedByUserId,
                acceptedAt: row.acceptedAt,
                note: row.acceptanceNote,
              }
            : null,
        note: "human judgments and decisions — never blended into the computed evidence beside them",
      },
      evidence: await resolveRiskEvidence(db, row),
    };
  });

  // Edit-while-live. `status`, `category`, and the acceptance fields are
  // refused BY NAME — each points at the endpoint that owns the act.
  app.patch("/v1/risks/:riskId", async (req, reply) => {
    const { riskId } = riskIdParam.parse(req.params);
    const raw = (req.body ?? {}) as Record<string, unknown>;
    if ("status" in raw) {
      return reply.status(422).send({
        error: "status_is_transitioned_not_patched",
        detail:
          "a risk's status moves only through POST /v1/risks/:riskId/transition (audited) or " +
          "POST /v1/risks/:riskId/accept (the residual-risk record) — never by PATCH",
      });
    }
    if ("acceptedByUserId" in raw || "acceptedAt" in raw || "acceptanceNote" in raw || "evidence" in raw) {
      return reply.status(422).send({
        error: "computed_or_audited_not_patched",
        detail:
          "evidence is computed from the ledgers at read time and the acceptance record is " +
          "written only by POST /v1/risks/:riskId/accept — neither is editable",
      });
    }
    if ("category" in raw) {
      return reply.status(422).send({
        error: "category_is_the_evidence_key",
        detail:
          "the category decides which ledgers evidence this risk — changing it would silently " +
          "re-link the measurements. Close this risk and register the scenario under the " +
          "right category instead",
      });
    }
    const body = updateRiskSchema.parse(req.body);
    const [row] = await db.select().from(aiRisks).where(eq(aiRisks.id, riskId));
    if (!row) return reply.status(404).send({ error: "not_found" });
    if (!req.authCtx.isAdmin && req.authCtx.userId !== row.ownerUserId) {
      return reply.status(403).send({
        error: "forbidden",
        detail: "a risk is editable by its owner and by admins",
      });
    }
    if (row.status === "accepted" || row.status === "closed") {
      return reply.status(409).send({
        error: "risk_not_editable",
        detail: `a ${row.status} risk is a decided record — editing it would change what was ${row.status}`,
      });
    }
    const refs = await validateReferences(body);
    if (!refs.ok) return reply.status(400).send({ error: "invalid_reference", field: refs.field });
    const [updated] = await db
      .update(aiRisks)
      .set({
        ...(body.title !== undefined ? { title: body.title } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.likelihood !== undefined ? { likelihood: body.likelihood } : {}),
        ...(body.impact !== undefined ? { impact: body.impact } : {}),
        ...(body.mitigation !== undefined ? { mitigation: body.mitigation } : {}),
        ...(body.projectId !== undefined ? { projectId: body.projectId } : {}),
        ...(body.agentId !== undefined ? { agentId: body.agentId } : {}),
        ...(body.useCaseId !== undefined ? { useCaseId: body.useCaseId } : {}),
        updatedAt: new Date(),
      })
      .where(eq(aiRisks.id, riskId))
      .returning();
    await db.insert(auditLog).values({
      userId: req.authCtx.userId ?? NO_IDENTITY,
      objectType: "ai_risk",
      objectId: riskId,
      detail: { phase: "updated", fields: Object.keys(body) },
      effect: "allow",
      ruleId: RISK_RULE_IDS.updated,
      ruleChain: [],
      reason: `AI risk '${row.title}' updated while ${row.status}`,
    });
    return updated;
  });

  // Transition: open <-> mitigating, either -> closed. Audited. `accepted` is
  // NOT reachable here — acceptance is its own act with its own record.
  app.post("/v1/risks/:riskId/transition", async (req, reply) => {
    const { riskId } = riskIdParam.parse(req.params);
    const raw = (req.body ?? {}) as Record<string, unknown>;
    if (raw.status === "accepted") {
      return reply.status(422).send({
        error: "acceptance_is_its_own_act",
        detail:
          "residual-risk acceptance is recorded through POST /v1/risks/:riskId/accept — an " +
          "audited, admin-only act naming who accepted and why — never as an ordinary transition",
      });
    }
    const body = transitionRiskSchema.parse(req.body);
    const [row] = await db.select().from(aiRisks).where(eq(aiRisks.id, riskId));
    if (!row) return reply.status(404).send({ error: "not_found" });
    if (!req.authCtx.isAdmin && req.authCtx.userId !== row.ownerUserId) {
      return reply.status(403).send({
        error: "forbidden",
        detail: "a risk is transitioned by its owner and by admins",
      });
    }
    if (row.status === "accepted" || row.status === "closed") {
      return reply.status(409).send({
        error: "risk_terminal",
        detail: `a ${row.status} risk does not move again — register a new risk if the scenario returns`,
      });
    }
    if (row.status === body.status) {
      return reply.status(409).send({ error: "already_in_status" });
    }
    const [updated] = await db
      .update(aiRisks)
      .set({ status: body.status, updatedAt: new Date() })
      .where(eq(aiRisks.id, riskId))
      .returning();
    await db.insert(auditLog).values({
      userId: req.authCtx.userId ?? NO_IDENTITY,
      objectType: "ai_risk",
      objectId: riskId,
      detail: { phase: "transition", from: row.status, to: body.status, reason: body.reason },
      effect: "allow",
      ruleId: RISK_RULE_IDS.transitioned(body.status),
      ruleChain: [],
      reason: `AI risk '${row.title}' moved ${row.status} -> ${body.status}: ${body.reason}`,
    });
    return updated;
  });

  // Accept: admin-only (the default gate), reason required, audited — THE
  // RESIDUAL-RISK RECORD. The audit row freezes what every evidence resolver
  // measured at the moment of acceptance, so "what did they accept, on what
  // evidence?" stays answerable after the ledgers move on.
  app.post("/v1/risks/:riskId/accept", async (req, reply) => {
    const { riskId } = riskIdParam.parse(req.params);
    const body = acceptRiskSchema.parse(req.body);
    const [row] = await db.select().from(aiRisks).where(eq(aiRisks.id, riskId));
    if (!row) return reply.status(404).send({ error: "not_found" });
    if (row.status === "accepted") return reply.status(409).send({ error: "already_accepted" });
    if (row.status === "closed") {
      return reply.status(409).send({
        error: "risk_terminal",
        detail: "a closed risk has nothing left to accept",
      });
    }
    const now = new Date();
    const evidence = await resolveRiskEvidence(db, row, now);
    const [updated] = await db
      .update(aiRisks)
      .set({
        status: "accepted",
        acceptedByUserId: req.authCtx.userId ?? null,
        acceptedAt: now,
        acceptanceNote: body.note,
        updatedAt: now,
      })
      .where(eq(aiRisks.id, riskId))
      .returning();
    await db.insert(auditLog).values({
      userId: req.authCtx.userId ?? NO_IDENTITY,
      objectType: "ai_risk",
      objectId: riskId,
      detail: {
        phase: "accepted",
        from: row.status,
        note: body.note,
        declared: { likelihood: row.likelihood, impact: row.impact },
        evidenceAtAcceptance: summarizeEvidence(evidence),
        evidenceWindow: evidence.window,
      },
      effect: "allow",
      ruleId: RISK_RULE_IDS.accepted,
      ruleChain: [],
      reason:
        `residual risk '${row.title}' ACCEPTED: ${body.note} — a recorded decision, not a ` +
        `control; the evidence measured at acceptance rides in this row's detail`,
    });
    return {
      ...updated,
      evidenceAtAcceptance: evidence,
      note:
        "acceptance is a record, not a control — nothing about enforcement changed. The " +
        "evidence at the moment of acceptance is frozen into the audit trail.",
    };
  });
}
