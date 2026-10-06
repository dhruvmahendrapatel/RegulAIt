/**
 * ADR-0181 (agent SC) — THE ONE TEST HELPER for the admission, egress and
 * monitor defaults this batch made strict.
 *
 * A fresh deployment now ships `mcpAdmissionMode: enforce`, a 7-day release-age
 * cooldown, private MCP ranges CLOSED, compiled vendor endpoints adjudicated
 * (`egressCompiledDefaultPolicy: strict`), and backup verification and
 * stale-credential alerts ON. A test that pins UNRELATED behaviour (a proxy's
 * argument handling, a grant's precedence) against a local MCP double on
 * 127.0.0.1 must not fail on a posture it is not about — and it must not get
 * its lax posture by the default being weakened either (the batch's first
 * rule). So it asks for exactly the relaxations it needs, by name, here, and
 * puts back exactly what it found when it is done (M-068: a spec that changes
 * shared org settings restores them).
 *
 *   const restore = await relaxStrictAdmissionForTest(db, ["mcpPrivateRangesDefault", "minReleaseAgeDays"]);
 *   ...
 *   afterAll(() => restore());
 *
 * The suite shares ONE database and ONE org_settings singleton across files
 * (fileParallelism: false), so "put back what it found" — never "put back the
 * value the author remembered as the default" — is the only restore that keeps
 * the next file honest.
 */
import { eq, orgSettings, ORG_SETTINGS_ID, type Db, type OrgSettingsRow } from "@regulait/db";
import { loadOrgSettings } from "../org-settings.js";

/** the lax value of each strict default this helper may relax */
export const SC_LAX_POSTURE = {
  mcpAdmissionMode: "off",
  minReleaseAgeDays: 0,
  mcpPrivateRangesDefault: true,
  egressCompiledDefaultPolicy: "inherit",
  backupVerifyEnabled: false,
  staleCredentialAlerts: false,
} as const satisfies Partial<OrgSettingsRow>;

/** the strict value ADR-0181 ships for each (what a fresh org reads) */
export const SC_STRICT_DEFAULTS = {
  mcpAdmissionMode: "enforce",
  minReleaseAgeDays: 7,
  mcpPrivateRangesDefault: false,
  egressCompiledDefaultPolicy: "strict",
  backupVerifyEnabled: true,
  staleCredentialAlerts: true,
} as const satisfies Partial<OrgSettingsRow>;

export type ScRelaxable = keyof typeof SC_LAX_POSTURE;

/** The relaxations a test against a LOCAL MCP double ordinarily needs: the
 * double listens on 127.0.0.1 (private ranges) and was registered seconds ago
 * (the release-age cooldown). Admission stays `enforce`: a clean manifest is
 * admitted under it, so a test that is not about admission is unaffected. */
export const LOCAL_MCP_DOUBLE: readonly ScRelaxable[] = ["mcpPrivateRangesDefault", "minReleaseAgeDays"];

/**
 * Relax the named strict defaults for the duration of a test file. Returns the
 * restore function, which writes back the values found (not the shipped
 * defaults — see the header).
 */
export async function relaxStrictAdmissionForTest(
  db: Db,
  keys: readonly ScRelaxable[] = LOCAL_MCP_DOUBLE,
): Promise<() => Promise<void>> {
  const before = await loadOrgSettings(db);
  const saved: Partial<Record<ScRelaxable, unknown>> = {};
  const lax: Partial<Record<ScRelaxable, unknown>> = {};
  for (const k of keys) {
    saved[k] = before[k];
    lax[k] = SC_LAX_POSTURE[k];
  }
  await db
    .update(orgSettings)
    .set(lax as Partial<OrgSettingsRow>)
    .where(eq(orgSettings.id, ORG_SETTINGS_ID));
  return async () => {
    await db
      .update(orgSettings)
      .set(saved as Partial<OrgSettingsRow>)
      .where(eq(orgSettings.id, ORG_SETTINGS_ID));
  };
}
