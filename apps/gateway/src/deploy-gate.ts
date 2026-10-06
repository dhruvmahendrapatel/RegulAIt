/**
 * ADR-0161 — `POST /v1/gates/deploy`: the CI/CD deploy gate.
 *
 * Gathers governance state the platform already keeps — the use case and its
 * approved stack, each agent's availability, the ADR-0045 MRM dispatch gate
 * (called, not re-implemented), and active ADR-0157 monitor alerts on the use
 * case or its agents — and hands it to the pure `evaluateDeployGate`. Every
 * evaluation is audited (`deploy-gate-allowed` / `deploy-gate-denied`) with
 * the pipeline's `ref` and `environment`, so "what did the gate say about
 * build 4417?" has an answer.
 *
 * Callable by an admin or by the use case's OWNER (a pipeline runs as a
 * service account that owns the use cases it ships). Always 200 with a
 * decision on a known use case — the pipeline acts on `decision`.
 *
 * ADR-0180 — CONTINUOUS ASSURANCE (A3 owns the composition). The org's
 * `assurance_gate_mode` (default `enforce`) governs four live checks, each
 * read through its owner's interface function:
 *   - measured conditions      `evaluateUseCaseConditions` (A2), persist false
 *   - required AI test classes `requiredTestStatus` (A3)
 *   - autonomy floors          `autonomyFloorFor` (A8)
 *   - residual risk            `residualPosition` (A10)
 * `enforce` holds on them, `warn` lists them as warnings, `off` skips them and
 * the response says `assurance: skipped (mode off)`. A check that throws is
 * reported (`assurance_check_unavailable`), never passed. Monitor alerts of the
 * six assurance rules are NOT re-read as `open_high_alert`: the live checks
 * above cover the same facts, and the mode — not the alert — decides whether
 * they hold the release (otherwise `off` could never turn them off).
 *
 * ADR-0182 A12 — THE INCIDENT REGISTER. `incident_gate_mode` (strict default
 * `enforce`) governs one more check: an open or contained serious, high or
 * critical AI incident on the use case holds the gate (`open_serious_incident`
 * / `open_high_incident`); `warn` reports it; `off` skips it and the response
 * says `incidentGate: skipped (mode off)`.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  agents,
  aiUseCases,
  and,
  auditLog,
  eq,
  gt,
  inArray,
  isNull,
  modelCardApprovals,
  modelCards,
  ne,
  or,
  governanceAlerts,
  useCaseConditions,
  type Db,
} from "@regulait/db";
import {
  ASSURANCE_MONITOR_RULE_IDS,
  evaluateDeployGate,
  evaluateMrmGate,
  type AutonomyFloorResult,
  type ConditionVerdict,
  type DeployGateAgentInput,
  type RequiredTestStatus,
  type ResidualPosition,
} from "@regulait/shared";
import { loadCardsForSubject } from "./mrm.js";
import { loadOrgSettings } from "./org-settings.js";
import { loadAssuranceGateMode } from "./assurance-settings.js";
import { evaluateUseCaseConditions } from "./condition-metrics.js";
import { requiredTestStatus } from "./required-tests.js";
import { autonomyFloorFor } from "./autonomy.js";
import { residualPosition } from "./risk-tolerance.js";
import { incidentGateInputs } from "./incidents.js";

export const DEPLOY_GATE_RULE_IDS = { allowed: "deploy-gate-allowed", denied: "deploy-gate-denied" } as const;

const body = z
  .object({
    useCaseId: z.string().uuid(),
    /**
     * the agents this release ships. AER-044: a selection never narrows what
     * the gate checks — the whole approved stack is always evaluated, so an
     * omitted list, `[]` and a subset all check every intended agent (a halt or
     * MRM refusal on any of them blocks); an agent outside the stack blocks.
     */
    agentIds: z.array(z.string().uuid()).max(50).optional(),
    /** free text from the pipeline, e.g. "staging", "eu-west" — recorded, never interpreted */
    environment: z.string().trim().min(1).max(64).optional(),
    /** build / commit / release identifier — recorded for the audit trail */
    ref: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

export function registerDeployGateRoutes(app: FastifyInstance, db: Db): void {
  app.post("/v1/gates/deploy", async (req, reply) => {
    const b = body.parse(req.body);
    const callerId = req.authCtx.userId ?? null;
    const [uc] = await db.select().from(aiUseCases).where(eq(aiUseCases.id, b.useCaseId));
    if (!uc) return reply.status(404).send({ error: "unknown_use_case" });
    if (!req.authCtx.isAdmin && callerId !== uc.ownerUserId) {
      return reply.status(403).send({
        error: "forbidden",
        detail: "the deploy gate answers for a use case's owner (e.g. its pipeline's service account) or an admin",
      });
    }
    const now = new Date();
    const intended = (uc.intendedAgentIds ?? []) as string[];
    // AER-044: the approved stack plus any requested extras (the same union the
    // evaluator checks) — `[]` and a subset cannot drop an intended agent.
    const checkIds = [...new Set([...intended, ...(b.agentIds ?? [])])];

    const agentRows = checkIds.length
      ? await db.select().from(agents).where(inArray(agents.id, checkIds))
      : [];
    const approved = checkIds.length
      ? await db
          .selectDistinct({ agentId: modelCards.agentId })
          .from(modelCardApprovals)
          .innerJoin(modelCards, eq(modelCards.id, modelCardApprovals.cardId))
          .where(
            and(
              inArray(modelCards.agentId, checkIds),
              eq(modelCardApprovals.status, "approved"),
              or(isNull(modelCardApprovals.validUntil), gt(modelCardApprovals.validUntil, now)),
            ),
          )
      : [];
    const approvedSet = new Set(approved.map((a) => a.agentId));
    const agentMap = new Map<string, DeployGateAgentInput>();
    // The MRM gate's DECISION, evaluated with the same card loading as the
    // dispatch gate but without its dispatch-phase side effects (the
    // staleness-recertification audit row is a dispatch event, not a pipeline
    // check — that deepening still applies at runtime).
    const org = await loadOrgSettings(db);
    for (const a of agentRows) {
      let refusal: { detail: string } | null = null;
      if (org.mrmEnforced) {
        const cards = [
          ...(await loadCardsForSubject(db, { agentId: a.id, customProviderId: null })),
          ...(a.customProviderId ? await loadCardsForSubject(db, { customProviderId: a.customProviderId }) : []),
        ];
        const d = evaluateMrmGate({ enforced: true, cards, now });
        if (!d.allowed) refusal = { detail: d.detail };
      }
      agentMap.set(a.id, {
        id: a.id,
        name: a.name,
        halted: a.haltedAt !== null,
        enabled: a.enabled,
        lifecycleStatus: a.lifecycleStatus,
        mrmRefusal: refusal ? refusal.detail : null,
        modelCardApproved: approvedSet.has(a.id),
      });
    }

    // active alerts whose subject is this use case, or one of the checked
    // agents under it (pair keys) or on its own
    const alertRows = await db
      .select({
        id: governanceAlerts.id,
        ruleId: governanceAlerts.ruleId,
        severity: governanceAlerts.severity,
        status: governanceAlerts.status,
        title: governanceAlerts.title,
        subjectKey: governanceAlerts.subjectKey,
      })
      .from(governanceAlerts)
      .where(ne(governanceAlerts.status, "resolved"));
    const ucKey = `use_case:${uc.id}`;
    const agentKeys = new Set(checkIds.map((id) => `agent:${id}`));
    const assuranceRules = new Set<string>(ASSURANCE_MONITOR_RULE_IDS);
    const alerts = alertRows.filter((a) => {
      if (assuranceRules.has(a.ruleId)) return false;
      const parts = a.subjectKey.split(">");
      if (parts[0] === ucKey) return true;
      return parts.length === 1 && agentKeys.has(parts[0]!);
    });

    // ADR-0168 — open BEFORE-go-live conditions the approval imposed. Only the
    // MANUAL ones here: a measured condition (ADR-0180) is closed by evidence
    // and read through the assurance checks below, under the org's mode.
    const blockingConditions = await db
      .select({ id: useCaseConditions.id, text: useCaseConditions.text })
      .from(useCaseConditions)
      .where(
        and(
          eq(useCaseConditions.useCaseId, uc.id),
          eq(useCaseConditions.status, "open"),
          eq(useCaseConditions.blocking, true),
          eq(useCaseConditions.kind, "manual"),
        ),
      )
      .orderBy(useCaseConditions.dueAt, useCaseConditions.id);

    // ADR-0180 — the continuous-assurance checks, live, as the mode says
    const assuranceMode = await loadAssuranceGateMode(db);
    const assurance: {
      conditionVerdicts?: ConditionVerdict[];
      requiredTests?: RequiredTestStatus[];
      autonomy?: AutonomyFloorResult | null;
      residualRisks?: ResidualPosition[];
    } = {};
    const assuranceErrors: Array<{ check: string; error: string }> = [];
    const attempt = async <T>(check: string, f: () => Promise<T>): Promise<T | undefined> => {
      try {
        return await f();
      } catch (e) {
        assuranceErrors.push({ check, error: e instanceof Error ? e.message : String(e) });
        return undefined; // reported as `assurance_check_unavailable`, never passed
      }
    };
    if (assuranceMode !== "off") {
      const verdicts = await attempt("conditions", () => evaluateUseCaseConditions(db, uc.id, now, { persist: false }));
      if (verdicts) {
        // a measured before-go-live condition with no verdict yet has no
        // passing evidence: it reads `not_run`, never met
        const measuredOpen = await db
          .select()
          .from(useCaseConditions)
          .where(
            and(
              eq(useCaseConditions.useCaseId, uc.id),
              eq(useCaseConditions.status, "open"),
              eq(useCaseConditions.blocking, true),
              ne(useCaseConditions.kind, "manual"),
            ),
          );
        const seen = new Set(verdicts.map((v) => v.conditionId));
        assurance.conditionVerdicts = [
          ...verdicts,
          ...measuredOpen
            .filter((c) => !seen.has(c.id))
            .map(
              (c): ConditionVerdict => ({
                conditionId: c.id,
                useCaseId: uc.id,
                kind: c.kind,
                text: c.text,
                blocking: c.blocking,
                status: "open",
                state: "not_run",
                measurement: null,
                onBreach: (c.onBreach ?? "alert") as ConditionVerdict["onBreach"],
                consecutiveBreaches: c.consecutiveBreaches ?? 0,
                evaluatedAt: null,
              }),
            ),
        ];
      }
      assurance.requiredTests = await attempt("required_tests", () =>
        requiredTestStatus(db, { id: uc.id, euAiActTier: uc.euAiActTier, intendedAgentIds: intended }, now),
      );
      const floor = await attempt("autonomy", () => autonomyFloorFor(db, { id: uc.id, projectId: uc.projectId }));
      if (floor !== undefined) assurance.autonomy = floor;
      assurance.residualRisks = await attempt("residual_risk", () => residualPosition(db, uc.id, now));
    }

    // ADR-0182 A12 — the use case's AI incidents that are not closed, and the
    // org's `incident_gate_mode` (strict default `enforce`)
    const incidentGate = await incidentGateInputs(db, uc.id, org);

    const result = evaluateDeployGate({
      useCase: {
        id: uc.id,
        name: uc.name,
        status: uc.status,
        intendedAgentIds: intended,
        approvedUntil: uc.approvedUntil,
      },
      requestedAgentIds: b.agentIds ?? null,
      agents: agentMap,
      alerts,
      openBlockingConditions: blockingConditions,
      now,
      assuranceMode,
      ...assurance,
      incidentMode: incidentGate.mode,
      incidents: incidentGate.incidents,
    });

    await db.insert(auditLog).values({
      userId: callerId ?? "00000000-0000-0000-0000-000000000000",
      objectType: "deploy_gate",
      objectId: uc.id,
      detail: {
        decision: result.decision,
        environment: b.environment ?? null,
        ref: b.ref ?? null,
        agents: result.agentsChecked,
        requestedAgents: b.agentIds ?? null,
        reasons: result.reasons.map((r) => ({ code: r.code, severity: r.severity, ref: r.ref ?? null })),
        // ADR-0168: which conditions held the gate, and the lifetime it read
        ...(blockingConditions.length > 0 ? { openBlockingConditionIds: blockingConditions.map((c) => c.id) } : {}),
        approvedUntil: uc.approvedUntil ? uc.approvedUntil.toISOString() : null,
        // ADR-0180: the mode the checks ran under, and any check that could not run
        assurance: result.assurance ?? null,
        // ADR-0182 A12: the mode the incident check ran under
        incidentGate: result.incidentGate ?? null,
        ...(assuranceErrors.length ? { assuranceErrors } : {}),
      },
      effect: result.decision === "allow" ? "allow" : "deny",
      ruleId: result.decision === "allow" ? DEPLOY_GATE_RULE_IDS.allowed : DEPLOY_GATE_RULE_IDS.denied,
      ruleChain: [],
      reason:
        `deploy gate ${result.decision === "allow" ? "allowed" : "denied"} use case '${uc.name}'` +
        `${b.environment ? ` for ${b.environment}` : ""}${b.ref ? ` (${b.ref})` : ""}: ` +
        `${result.reasons.filter((r) => r.severity === "block").length} blocking, ` +
        `${result.reasons.filter((r) => r.severity === "warn").length} warning`,
    });

    return {
      decision: result.decision,
      useCase: {
        id: uc.id,
        name: uc.name,
        status: uc.status,
        euAiActTier: uc.euAiActTier,
        approvedUntil: uc.approvedUntil ? uc.approvedUntil.toISOString() : null,
      },
      agentsChecked: result.agentsChecked,
      agentsRequested: b.agentIds ?? null,
      reasons: result.reasons,
      // ADR-0180: how the continuous-assurance checks were applied, e.g.
      // { mode: "off", status: "skipped", label: "skipped (mode off)" }
      assurance: result.assurance,
      // ADR-0182 A12: how open incidents were applied, e.g.
      // { mode: "off", status: "skipped", label: "skipped (mode off)" }
      incidentGate: result.incidentGate,
      environment: b.environment ?? null,
      ref: b.ref ?? null,
      evaluatedAt: now.toISOString(),
      note:
        "The pipeline enforces `decision`; a warning does not fail the gate. Dispatch enforcement (MRM incl. " +
        "staleness recertification, halts, entitlements) is unchanged and still applies at runtime. " +
        `Continuous-assurance checks: ${result.assurance?.label ?? "not evaluated"}. ` +
        `Open AI incidents: ${result.incidentGate?.label ?? "not evaluated"}.`,
    };
  });
}
