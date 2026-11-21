/**
 * ADR-0351 slice 2 — the EU AI Act deployer-obligation register.
 *
 *   GET  /v1/compliance/deployer-register          every deployer duty: basis, lifecycle state, evidence or attestation
 *   POST /v1/compliance/deployer-register/attest   attest one attested-basis duty (a review date is required; audited)
 *
 * Admin-only through the default gate (neither route is in NON_ADMIN_ROUTES).
 *
 * NOT A NEW FRAMEWORK. The register is a typed view over the ACTIVE `eu-ai-act-deployer` pack (ADR-0058): its
 * controls, its collectors (`runCollector` through `evaluatePack`, org-scoped) and its attestations
 * (`compliance_pack_attestations`). The GET stores nothing. Attesting goes through `recordPackAttestation`, the same
 * write and audit row as the pack route, after the declared lifecycle table (`DEPLOYER_ITEM_TRANSITIONS`) allows it.
 * An observed duty cannot be attested: the table has no `attest` transition for that basis.
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import {
  COMPLIANCE_PACK_DISCLAIMER,
  DEPLOYER_ITEM_TRANSITIONS,
  DEPLOYER_REVIEW_MAX_DAYS,
  EU_AI_ACT_DEPLOYER_FRAMEWORK,
  deployerAttestSchema,
  deployerItemState,
  deployerItemTransition,
  evaluatePackSchema,
  resolveReportPeriod,
  type DeployerItemBasis,
  type PackControlAssessment,
} from "@regulait/shared";
import {
  and,
  compliancePackAttestations,
  compliancePackControls,
  compliancePacks,
  desc,
  eq,
  type Db,
} from "@regulait/db";
import { auditCompliancePack, COMPLIANCE_PACK_RULE_IDS, evaluatePack, recordPackAttestation } from "./compliance-packs.js";

export const DEPLOYER_REGISTER_RULE_IDS = {
  attestRefused: "deployer-register-attest-refused",
} as const;

const registerQuery = z.object({ period: evaluatePackSchema.shape.period }).strict();

/** where a person can look at the rows an observed duty counted (the evaluate route recounts every collector) */
function evidenceLink(packId: string, a: PackControlAssessment, period: { start: string; end: string }) {
  const params = new URLSearchParams({ from: period.start, to: period.end });
  if (a.collector === "audit_decisions") {
    params.set("effect", "deny");
    return { list: `/v1/audit?${params.toString()}`, recount: `/v1/compliance/packs/${packId}/evaluate` };
  }
  if (a.collector === "approvals") return { list: "/v1/approvals?status=approved", recount: `/v1/compliance/packs/${packId}/evaluate` };
  return { list: null, recount: `/v1/compliance/packs/${packId}/evaluate` };
}

async function activePack(db: Db) {
  const [pack] = await db
    .select()
    .from(compliancePacks)
    .where(and(eq(compliancePacks.framework, EU_AI_ACT_DEPLOYER_FRAMEWORK), eq(compliancePacks.status, "active")))
    .orderBy(desc(compliancePacks.version))
    .limit(1);
  return pack ?? null;
}

const noPack = (reply: FastifyReply) =>
  reply.status(404).send({
    error: "deployer_register_not_active",
    detail: `no active '${EU_AI_ACT_DEPLOYER_FRAMEWORK}' pack: seed the default packs (POST /v1/compliance/packs/seed) and activate it`,
  });

export function registerDeployerRegisterRoutes(app: FastifyInstance, db: Db): void {
  app.get("/v1/compliance/deployer-register", async (req, reply) => {
    const q = registerQuery.safeParse(req.query ?? {});
    if (!q.success) return reply.status(400).send({ error: "invalid_request", detail: "period must be one of the report periods" });
    const pack = await activePack(db);
    if (!pack) return noPack(reply);
    const now = new Date();
    const period = q.data.period;
    const resolved = resolveReportPeriod(period, now);
    const controls = await db
      .select()
      .from(compliancePackControls)
      .where(eq(compliancePackControls.packId, pack.id))
      .orderBy(compliancePackControls.controlRef);
    const [scorecard, attestations] = await Promise.all([
      evaluatePack(db, {
        pack,
        controls,
        projectIds: null,
        periodStart: resolved.start,
        periodEnd: resolved.end,
        period,
        periodLabel: resolved.label,
        scopeKind: "org",
        scopeId: null,
        now,
      }),
      db
        .select()
        .from(compliancePackAttestations)
        .where(eq(compliancePackAttestations.packId, pack.id))
        .orderBy(desc(compliancePackAttestations.attestedAt)),
    ]);
    const span = { start: resolved.start.toISOString(), end: resolved.end.toISOString() };
    const items = scorecard.controls.map((a) => {
      const basis: DeployerItemBasis = a.attestationRequired ? "attested" : "observed";
      const latest = basis === "attested" ? (attestations.find((x) => x.controlRef === a.controlRef) ?? null) : null;
      const reviewDate = latest?.validUntil ? latest.validUntil.toISOString() : null;
      const state = deployerItemState(basis, { evidenceCount: a.evidenceCount, minEvidenceCount: a.minEvidenceCount, latestAttestation: latest ? { reviewDate } : null }, now);
      const ctl = controls.find((c) => c.controlRef === a.controlRef);
      return {
        controlRef: a.controlRef,
        title: a.title,
        basis,
        state,
        coverage: a.coverage,
        ownerNote: ctl?.ownerNote ?? null,
        ...(basis === "observed"
          ? {
              evidence: {
                collector: a.collector,
                count: a.evidenceCount ?? 0,
                minEvidenceCount: a.minEvidenceCount,
                period: span,
                links: evidenceLink(pack.id, a, span),
              },
              attestation: null,
            }
          : {
              evidence: null,
              attestation: latest
                ? {
                    statement: latest.statement,
                    evidenceRef: latest.evidenceRef,
                    attestedBy: latest.attestedByUserId,
                    attestedAt: latest.attestedAt.toISOString(),
                    reviewDate,
                  }
                : null,
            }),
        // what may happen next, read from the one table: the UI and agents show these, the server enforces them
        allowedEvents: DEPLOYER_ITEM_TRANSITIONS.filter((t) => t.basis === basis && t.from === state).map((t) => ({ event: t.event, to: t.to, by: t.by })),
      };
    });
    const count = (pred: (i: (typeof items)[number]) => boolean) => items.filter(pred).length;
    return {
      pack: { id: pack.id, framework: pack.framework, version: pack.version, title: pack.title },
      period: { period, label: resolved.label, ...span },
      generatedAt: now.toISOString(),
      totals: {
        items: items.length,
        observedBasis: count((i) => i.basis === "observed"),
        attestedBasis: count((i) => i.basis === "attested"),
        observed: count((i) => i.state === "observed"),
        attested: count((i) => i.state === "attested"),
        reviewDue: count((i) => i.state === "review_due"),
        open: count((i) => i.state === "open"),
      },
      lifecycle: { transitions: DEPLOYER_ITEM_TRANSITIONS, reviewMaxDays: DEPLOYER_REVIEW_MAX_DAYS },
      items,
      disclaimer: COMPLIANCE_PACK_DISCLAIMER,
    };
  });

  app.post("/v1/compliance/deployer-register/attest", async (req, reply) => {
    const b = deployerAttestSchema.safeParse(req.body ?? {});
    if (!b.success) {
      return reply.status(400).send({ error: "invalid_request", detail: "send {controlRef, statement, evidenceRef, reviewDate (ISO date-time)}" });
    }
    const pack = await activePack(db);
    if (!pack) return noPack(reply);
    const actor = req.authCtx.userId ?? null;
    const refuse = async (status: number, error: string, detail: string, extra: Record<string, unknown> = {}) => {
      await auditCompliancePack(db, actor, pack.id, DEPLOYER_REGISTER_RULE_IDS.attestRefused, `refused a deployer-register attestation on '${b.data.controlRef}': ${detail} (ADR-0351)`, {
        controlRef: b.data.controlRef,
        framework: pack.framework,
        version: pack.version,
        error,
        ...extra,
      }, "deny");
      return reply.status(status).send({ error, detail });
    };
    const [control] = await db
      .select()
      .from(compliancePackControls)
      .where(and(eq(compliancePackControls.packId, pack.id), eq(compliancePackControls.controlRef, b.data.controlRef)));
    if (!control) return reply.status(404).send({ error: "unknown_register_item" });

    const now = new Date();
    const review = new Date(b.data.reviewDate);
    if (review.getTime() <= now.getTime()) return refuse(400, "review_date_not_future", "the review date must be in the future");
    if (review.getTime() > now.getTime() + DEPLOYER_REVIEW_MAX_DAYS * 86_400_000) {
      return refuse(400, "review_date_too_far", `the review date may be at most ${DEPLOYER_REVIEW_MAX_DAYS} days ahead`);
    }

    const basis: DeployerItemBasis = control.attestationRequired ? "attested" : "observed";
    const [latest] = await db
      .select()
      .from(compliancePackAttestations)
      .where(and(eq(compliancePackAttestations.packId, pack.id), eq(compliancePackAttestations.controlRef, control.controlRef)))
      .orderBy(desc(compliancePackAttestations.attestedAt))
      .limit(1);
    const from = deployerItemState(
      basis,
      // an observed item's state does not matter here: the table has no `attest` for that basis at any state
      { evidenceCount: null, minEvidenceCount: control.minEvidenceCount, latestAttestation: latest ? { reviewDate: latest.validUntil?.toISOString() ?? null } : null },
      now,
    );
    const t = deployerItemTransition(basis, from, "attest");
    if (!t) {
      return refuse(409, "transition_not_allowed", basis === "observed"
        ? `'${control.controlRef}' is observed by the '${control.collector}' collector; a person cannot attest what the system observes`
        : `the register lifecycle does not allow 'attest' from '${from}'`, { basis, from });
    }
    const row = await recordPackAttestation(db, {
      actor,
      pack,
      controlRef: control.controlRef,
      statement: b.data.statement,
      evidenceRef: b.data.evidenceRef,
      validUntil: review,
      detail: { register: "eu-ai-act-deployer", adr: "0351", transition: { from: t.from, event: t.event, to: t.to } },
    });
    return reply.status(201).send({
      item: { controlRef: control.controlRef, basis, state: t.to, previousState: t.from },
      attestation: {
        id: row.id,
        statement: row.statement,
        evidenceRef: row.evidenceRef,
        attestedBy: row.attestedByUserId,
        attestedAt: row.attestedAt.toISOString(),
        reviewDate: review.toISOString(),
      },
      note: `Recorded as an attestation (audited as ${COMPLIANCE_PACK_RULE_IDS.attestationRecorded}), not as evidence the system observed.`,
    });
  });
}
