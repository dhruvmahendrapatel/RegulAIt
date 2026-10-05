/**
 * ADR-0181 test fixture: run a test file with some of the SB2 governance gates
 * relaxed.
 *
 * The strict defaults refuse an unattributed dispatch, an agent with no
 * approved model card, a dispatch on a project whose linked use case is not
 * approved, a compat or MCP call with no project header, a per-user BYO model
 * credential, and an unpreviewed ABAC activation. Suites that pin OTHER
 * behaviour (routing, budgets, guardrails, the proxy's allow-lists …) relax
 * exactly the gates they would otherwise trip, by name, here. The gates
 * themselves are pinned by their own suites and by
 * zz-adr0181-sb2-strict-governance-defaults.test.ts.
 *
 * Global state (M-068): the returned `restore()` puts the strict defaults back
 * (not "what was there before"); call it in the file's afterAll.
 */
import {
  eq,
  interceptionSettings,
  INTERCEPTION_SETTINGS_ID,
  orgSettings,
  ORG_SETTINGS_ID,
  policySimulationSettings,
  type Db,
} from "@regulait/db";
import { loadInterceptionSettings } from "../compat-core.js";
import { loadOrgSettings } from "../org-settings.js";
import { loadPolicySimulationSettings } from "../policy-simulation.js";

export interface GovernanceGates {
  useCaseGateMode: "off" | "warn" | "enforce";
  dispatchAttributionRequired: boolean;
  mrmEnforced: boolean;
  mrmStalenessRecertEnabled: boolean;
  requireProjectAttribution: boolean;
  requireMcpAttribution: boolean;
  keyCustodyEnforced: boolean;
  requirePreviewBeforeActivate: boolean;
}

/** the ADR-0181 defaults — what `restore()` writes back */
export const STRICT_GOVERNANCE_GATES: GovernanceGates = {
  useCaseGateMode: "enforce",
  dispatchAttributionRequired: true,
  mrmEnforced: true,
  mrmStalenessRecertEnabled: true,
  requireProjectAttribution: true,
  requireMcpAttribution: true,
  keyCustodyEnforced: true,
  requirePreviewBeforeActivate: true,
};

/** every SB2 gate relaxed — for suites written before ADR-0181 that pin
 * behaviour none of these gates is about */
export const LAX_GOVERNANCE_GATES: GovernanceGates = {
  useCaseGateMode: "off",
  dispatchAttributionRequired: false,
  mrmEnforced: false,
  mrmStalenessRecertEnabled: false,
  requireProjectAttribution: false,
  requireMcpAttribution: false,
  keyCustodyEnforced: false,
  requirePreviewBeforeActivate: false,
};

async function write(db: Db, g: Partial<GovernanceGates>): Promise<void> {
  const org = {
    ...(g.useCaseGateMode !== undefined ? { useCaseGateMode: g.useCaseGateMode } : {}),
    ...(g.dispatchAttributionRequired !== undefined ? { dispatchAttributionRequired: g.dispatchAttributionRequired } : {}),
    ...(g.mrmEnforced !== undefined ? { mrmEnforced: g.mrmEnforced } : {}),
    ...(g.mrmStalenessRecertEnabled !== undefined ? { mrmStalenessRecertEnabled: g.mrmStalenessRecertEnabled } : {}),
  };
  const icp = {
    ...(g.requireProjectAttribution !== undefined ? { requireProjectAttribution: g.requireProjectAttribution } : {}),
    ...(g.requireMcpAttribution !== undefined ? { requireMcpAttribution: g.requireMcpAttribution } : {}),
    ...(g.keyCustodyEnforced !== undefined ? { keyCustodyEnforced: g.keyCustodyEnforced } : {}),
  };
  if (Object.keys(org).length > 0) {
    await loadOrgSettings(db); // the singleton exists
    await db.update(orgSettings).set(org).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  }
  if (Object.keys(icp).length > 0) {
    await loadInterceptionSettings(db);
    await db.update(interceptionSettings).set(icp).where(eq(interceptionSettings.id, INTERCEPTION_SETTINGS_ID));
  }
  if (g.requirePreviewBeforeActivate !== undefined) {
    await loadPolicySimulationSettings(db);
    await db
      .update(policySimulationSettings)
      .set({ requirePreviewBeforeActivate: g.requirePreviewBeforeActivate })
      .where(eq(policySimulationSettings.id, "singleton"));
  }
}

/**
 * Relax the named gates (default: all of them) for this file. Returns the
 * restore function, which writes the STRICT defaults back for every gate it
 * touched.
 */
export async function relaxGovernanceGatesForTest(
  db: Db,
  gates: Partial<GovernanceGates> = LAX_GOVERNANCE_GATES,
): Promise<() => Promise<void>> {
  await write(db, gates);
  const touched = Object.fromEntries(
    Object.keys(gates).map((k) => [k, STRICT_GOVERNANCE_GATES[k as keyof GovernanceGates]]),
  ) as Partial<GovernanceGates>;
  return async () => {
    await write(db, touched);
  };
}
