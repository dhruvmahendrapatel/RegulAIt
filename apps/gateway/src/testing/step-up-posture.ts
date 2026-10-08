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
import {
  and,
  eq,
  federatedIdentities,
  inArray,
  isNull,
  orgSettings,
  ORG_SETTINGS_ID,
  users,
  webauthnCredentials,
  type Db,
} from "@regulait/db";
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

/**
 * B4S-06 (M-068: global state is removed before the suite ends). The bootstrap
 * credential passes a step-up only while no ACTIVE admin has a usable step-up
 * method, and every suite shares one database — so a suite that leaves an admin
 * with an authenticator app, a passkey or an SSO link behind changes what the
 * bootstrap credential may do in every suite after it. A suite that enrols one
 * calls this in its afterAll for the admins it created: their TOTP is turned
 * off (secret cleared), their passkeys revoked and their SSO links removed.
 * Nothing else about the accounts changes.
 */
export async function forgetStepUpMethodsForTest(db: Db, userIds: ReadonlyArray<string | null | undefined>): Promise<void> {
  const ids = userIds.filter((id): id is string => typeof id === "string" && id.length > 0);
  if (ids.length === 0) return;
  await db
    .update(users)
    .set({ totpEnabled: false, totpSecretCiphertext: null, totpLastUsedStep: null })
    .where(inArray(users.id, ids));
  await db
    .update(webauthnCredentials)
    .set({ revokedAt: new Date(), revokeReason: "test suite finished (B4S-06 cleanup)" })
    .where(and(inArray(webauthnCredentials.userId, ids), isNull(webauthnCredentials.revokedAt)));
  await db.delete(federatedIdentities).where(inArray(federatedIdentities.userId, ids));
}
