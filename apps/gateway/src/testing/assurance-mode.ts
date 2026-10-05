/**
 * ADR-0180 test fixture: run a test file's deploy-gate cases with the
 * continuous-assurance checks set to a given mode.
 *
 * The strict default (`enforce`) holds every use case without passing
 * required-test evidence. Suites that pin OTHER gate rules (ADR-0161 approval
 * and stack, ADR-0168 conditions and lifetime, AER-044 selection) set `off` so
 * their exact reason lists stay about those rules; the assurance checks are
 * pinned by zz-adr0180-a3-required-tests.test.ts.
 *
 * Global state (M-068): `restore()` puts the strict default back; call it in
 * the file's afterAll.
 */
import { eq, orgSettings, ORG_SETTINGS_ID, type Db } from "@regulait/db";
import type { AssuranceGateMode } from "@regulait/shared";
import { loadOrgSettings } from "../org-settings.js";

export async function setAssuranceGateModeForTest(db: Db, mode: AssuranceGateMode): Promise<() => Promise<void>> {
  await loadOrgSettings(db); // the singleton exists
  await db.update(orgSettings).set({ assuranceGateMode: mode }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  return async () => {
    await db.update(orgSettings).set({ assuranceGateMode: "enforce" }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  };
}
