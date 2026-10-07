/**
 * ADR-0180 §2 — THE ASSURANCE GATE MODE: how the deploy gate treats the
 * continuous-assurance (D3) checks.
 *
 *   enforce  (the DEFAULT — secure by default, ADR-0180 §1) the gate holds on
 *            failing measurable conditions, missing/stale/failing required
 *            tests, unmet autonomy floors and residual risk above tolerance
 *   warn     the gate reports them without holding
 *   off      the gate skips them, and its response says they were skipped
 *
 * It is a column on the `org_settings` singleton (migration 0155). This module
 * is its ONLY writer: the general `PUT /v1/org/settings` schema is strict and
 * does not accept the key, so relaxing the gate is always this one admin-only
 * act, audited with the value it replaced and the value it set.
 */
import type { FastifyInstance } from "fastify";
import { auditLog, eq, orgSettings, ORG_SETTINGS_ID, type Db } from "@regulait/db";
import {
  ASSURANCE_DEFAULTS,
  setAssuranceGateModeSchema,
  type AssuranceGateMode,
} from "@regulait/shared";
import { loadOrgSettings } from "./org-settings.js";
import { relaxedAgainst, requireRelaxStepUp } from "./step-up.js";

const NO_IDENTITY = "00000000-0000-0000-0000-000000000000";

export const ASSURANCE_GATE_MODE_PATH = "/v1/org/settings/assurance-gate-mode";
export const ASSURANCE_GATE_MODE_RULE_ID = "assurance-gate-mode-set";

const MODE_MEANING: Record<AssuranceGateMode, string> = {
  enforce: "the deploy gate holds on the continuous-assurance checks",
  warn: "the deploy gate reports the continuous-assurance checks without holding",
  off: "the deploy gate skips the continuous-assurance checks and says they were skipped",
};

/** the org's current mode, for the deploy gate and anything else that reads it */
export async function loadAssuranceGateMode(db: Db): Promise<AssuranceGateMode> {
  return (await loadOrgSettings(db)).assuranceGateMode;
}

function view(mode: AssuranceGateMode, updatedAt: Date | null) {
  return {
    mode,
    defaultMode: ASSURANCE_DEFAULTS.gateMode,
    strictDefault: mode === ASSURANCE_DEFAULTS.gateMode,
    meaning: MODE_MEANING[mode],
    updatedAt: updatedAt ? updatedAt.toISOString() : null,
  };
}

/** Admin-only (neither route is in NON_ADMIN_ROUTES). */
export function registerAssuranceSettingsRoutes(app: FastifyInstance, db: Db): void {
  app.get(ASSURANCE_GATE_MODE_PATH, async () => {
    const org = await loadOrgSettings(db);
    return view(org.assuranceGateMode, org.updatedAt);
  });

  app.put(ASSURANCE_GATE_MODE_PATH, async (req, reply) => {
    const body = setAssuranceGateModeSchema.parse(req.body ?? {});
    // make sure the singleton exists before locking it
    const current = await loadOrgSettings(db);
    // ADR-0186 A: below `enforce` is a relaxation, and needs a settings_relax step-up here as on the settings PUT
    const relaxed = relaxedAgainst({ assuranceGateMode: body.mode }, current, { assuranceGateMode: ASSURANCE_DEFAULTS.gateMode });
    if (!(await requireRelaxStepUp(db, req, reply, relaxed))) return reply;
    const actor = req.authCtx.userId ?? NO_IDENTITY;
    const now = new Date();
    const row = await db.transaction(async (tx) => {
      const [before] = await tx
        .select({ mode: orgSettings.assuranceGateMode })
        .from(orgSettings)
        .where(eq(orgSettings.id, ORG_SETTINGS_ID))
        .for("update");
      const from = before!.mode;
      const [after] = await tx
        .update(orgSettings)
        .set({ assuranceGateMode: body.mode, updatedBy: req.authCtx.userId, updatedAt: now })
        .where(eq(orgSettings.id, ORG_SETTINGS_ID))
        .returning();
      const relaxed = from === "enforce" && body.mode !== "enforce";
      await tx.insert(auditLog).values({
        userId: actor,
        objectType: "org_settings",
        objectId: null,
        detail: {
          via: req.authCtx.via,
          setting: "assuranceGateMode",
          from,
          to: body.mode,
          changed: from !== body.mode,
          strictDefault: ASSURANCE_DEFAULTS.gateMode,
        },
        effect: "allow",
        ruleId: ASSURANCE_GATE_MODE_RULE_ID,
        ruleChain: [],
        reason:
          from === body.mode
            ? `assurance gate mode written unchanged (${body.mode})`
            : `assurance gate mode changed from ${from} to ${body.mode}: ${MODE_MEANING[body.mode]}` +
              (relaxed ? " — RELAXED below the strict default (enforce)" : ""),
      });
      return after!;
    });
    return view(row.assuranceGateMode, row.updatedAt);
  });
}
