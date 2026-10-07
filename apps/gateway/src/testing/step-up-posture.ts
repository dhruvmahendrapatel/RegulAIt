/**
 * ADR-0186 A test fixture: the strict step-up defaults, and the honest way a
 * suite about something ELSE copes with them.
 *
 * Under the strict defaults (`step_up_mode = required`, all six actions) a
 * settings relaxation, a break-glass change, an evidence-hold override, a
 * passkey change and an owner change each need a fresh step-up from a person
 * in a browser session, and an API key can never give one. A suite that pins
 * pre-0186 behaviour by driving those actions through an API key turns
 * step-up off for its own run, explicitly, and puts the strict values back in
 * its afterAll (M-068: global state is removed before the spec ends) — the
 * same pattern as `relaxIdentityForTest`. Step-up itself is proved in
 * `zz-b4a-step-up.test.ts`, under the strict values.
 */
import { BATCH4_STRICT_DEFAULTS } from "@regulait/shared";
import { eq, orgSettings, ORG_SETTINGS_ID, type Db } from "@regulait/db";
import { loadOrgSettings } from "../org-settings.js";

/** turn step-up off for this suite; the returned function restores the strict policy */
export async function relaxStepUpForTest(db: Db): Promise<() => Promise<void>> {
  await loadOrgSettings(db); // the singleton exists
  await db.update(orgSettings).set({ stepUpMode: "off" }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  return async () => {
    await db
      .update(orgSettings)
      .set({
        stepUpMode: BATCH4_STRICT_DEFAULTS.stepUpMode,
        stepUpActions: [...BATCH4_STRICT_DEFAULTS.stepUpActions],
        stepUpMaxAgeSeconds: BATCH4_STRICT_DEFAULTS.stepUpMaxAgeSeconds,
      })
      .where(eq(orgSettings.id, ORG_SETTINGS_ID));
  };
}
