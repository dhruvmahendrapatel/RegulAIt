/**
 * ADR-0211 (P17) — THE RISK-TREATMENT SWITCH: may a risk be recorded as
 * `transferred` or `avoided`?
 *
 *   off  (the DEFAULT — secure by default, ADR-0180) POST /v1/risks/:riskId/
 *        treatment is refused, and the refusal is audited
 *   on   owners and admins may record either treatment, with evidence and an
 *        accountable owner
 *
 * Turning it ON is a relaxation: a treated risk leaves the live counts, and an
 * avoided one leaves the ratings. So it is a `settings_relax` step-up, and the
 * write is audited with the value it replaced in the same transaction. Turning
 * it OFF needs no step-up and leaves every recorded treatment as it is.
 *
 * It is a column on the `org_settings` singleton (migration 0229). This module
 * is its ONLY writer: the general `PUT /v1/org/settings` schema is strict and
 * does not accept the key.
 */
import type { FastifyInstance } from "fastify";
import { auditLog, eq, orgSettings, ORG_SETTINGS_ID, type Db } from "@regulait/db";
import { setRiskTreatmentsEnabledSchema } from "@regulait/shared";
import { loadOrgSettings } from "./org-settings.js";
import { CHANGED_CONCURRENTLY, relaxedAgainst, requireRelaxStepUp } from "./step-up.js";

const NO_IDENTITY = "00000000-0000-0000-0000-000000000000";

export const RISK_TREATMENTS_PATH = "/v1/org/settings/risk-treatments";
export const RISK_TREATMENTS_RULE_ID = "risk-treatments-set";
/** the strict default */
export const RISK_TREATMENTS_DEFAULT = false;

function view(enabled: boolean, updatedAt: Date | null) {
  return {
    enabled,
    defaultEnabled: RISK_TREATMENTS_DEFAULT,
    strictDefault: enabled === RISK_TREATMENTS_DEFAULT,
    meaning: enabled
      ? "owners and admins may record a risk as transferred or avoided, with evidence and an owner"
      : "a risk can be open, mitigating, accepted or closed; transferred and avoided are refused",
    updatedAt: updatedAt ? updatedAt.toISOString() : null,
  };
}

/** Admin-only (neither route is in NON_ADMIN_ROUTES). */
export function registerRiskTreatmentSettingsRoutes(app: FastifyInstance, db: Db): void {
  app.get(RISK_TREATMENTS_PATH, async () => {
    const org = await loadOrgSettings(db);
    return view(org.riskTreatmentsEnabled, org.updatedAt);
  });

  app.put(RISK_TREATMENTS_PATH, async (req, reply) => {
    const body = setRiskTreatmentsEnabledSchema.parse(req.body ?? {});
    const current = await loadOrgSettings(db);
    const relaxed = relaxedAgainst(
      { riskTreatmentsEnabled: body.enabled },
      current,
      { riskTreatmentsEnabled: RISK_TREATMENTS_DEFAULT },
    );
    if (!(await requireRelaxStepUp(db, req, reply, relaxed))) return reply;
    const row = await db.transaction(async (tx) => {
      const [before] = await tx
        .select({ enabled: orgSettings.riskTreatmentsEnabled })
        .from(orgSettings)
        .where(eq(orgSettings.id, ORG_SETTINGS_ID))
        .for("update");
      const from = before!.enabled;
      if (from !== current.riskTreatmentsEnabled) return null;
      const [after] = await tx
        .update(orgSettings)
        .set({ riskTreatmentsEnabled: body.enabled, updatedBy: req.authCtx.userId, updatedAt: new Date() })
        .where(eq(orgSettings.id, ORG_SETTINGS_ID))
        .returning();
      await tx.insert(auditLog).values({
        userId: req.authCtx.userId ?? NO_IDENTITY,
        objectType: "org_settings",
        objectId: null,
        detail: {
          via: req.authCtx.via,
          setting: "riskTreatmentsEnabled",
          from,
          to: body.enabled,
          changed: from !== body.enabled,
          strictDefault: RISK_TREATMENTS_DEFAULT,
        },
        effect: "allow",
        ruleId: RISK_TREATMENTS_RULE_ID,
        ruleChain: [],
        reason:
          from === body.enabled
            ? `risk treatments written unchanged (${body.enabled ? "on" : "off"})`
            : body.enabled
              ? "transferred and avoided risk treatments turned ON — RELAXED from the strict default (off)"
              : "transferred and avoided risk treatments turned OFF; treatments already recorded stay as they are",
      });
      return after!;
    });
    if (!row) return reply.status(CHANGED_CONCURRENTLY.status).send(CHANGED_CONCURRENTLY.body);
    return view(row.riskTreatmentsEnabled, row.updatedAt);
  });
}
