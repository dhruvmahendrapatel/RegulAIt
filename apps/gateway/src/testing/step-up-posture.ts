/**
 * ADR-0186 A test fixture: the strict step-up defaults, and the honest way a
 * suite about something ELSE copes with them.
 *
 * Under the strict defaults (`step_up_mode = required`, every kind in
 * `STEP_UP_ACTION_KINDS`, nine today) an approval decision, a settings
 * relaxation, a break-glass change, an evidence-hold override, a passkey
 * change, an owner change, an identity administration write, a name reveal and a signing-key
 * operation each need a
 * fresh step-up from a person in a browser session, and an API key can never
 * give one. A suite that pins
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

/**
 * PR #378 review: these helpers turn step-up off or remove people's step-up methods on a database. They are test
 * fixtures and run only under a test runner (VITEST set, or NODE_ENV=test); anywhere else they throw before touching
 * anything. `step-up-posture-guard.test.ts` pins, statically, that no product source imports this file.
 */
function assertUnderTest(helper: string): void {
  // vitest sets VITEST; a deployment sets no NODE_ENV=test, so this fails closed everywhere else
  if (process.env.VITEST === undefined && process.env.NODE_ENV !== "test") {
    throw new Error(`${helper} is a test fixture: it runs only under a test runner (VITEST set or NODE_ENV=test)`);
  }
}

/** turn step-up off for this suite; the returned function restores the strict policy */
export async function relaxStepUpForTest(db: Db): Promise<() => Promise<void>> {
  assertUnderTest("relaxStepUpForTest");
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
 * PR #378: step-up off for ONE setup call, then the policy put back exactly as found. A suite that allow-lists its
 * loopback doubles with the private-range / plaintext opt-ins (a stepped-up relaxation, ADR-0186 A) through the
 * bootstrap credential cannot rely on first-admin setup: another suite on the shared database may already have an
 * admin with a step-up method. Scoped to the call, not the suite, so nothing else the suite does runs relaxed.
 * The call (and its egress route literal) stays in the suite, where the egress-cleanup preflight reads it.
 */
export async function relaxStepUpAround<T>(db: Db, call: () => Promise<T>): Promise<T> {
  assertUnderTest("relaxStepUpAround");
  await loadOrgSettings(db); // the singleton exists
  const [found] = await db
    .select({ mode: orgSettings.stepUpMode })
    .from(orgSettings)
    .where(eq(orgSettings.id, ORG_SETTINGS_ID));
  await db.update(orgSettings).set({ stepUpMode: "off" }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  try {
    return await call();
  } finally {
    await db
      .update(orgSettings)
      .set({ stepUpMode: found?.mode ?? BATCH4_STRICT_DEFAULTS.stepUpMode })
      .where(eq(orgSettings.id, ORG_SETTINGS_ID));
  }
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
  assertUnderTest("forgetStepUpMethodsForTest");
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
