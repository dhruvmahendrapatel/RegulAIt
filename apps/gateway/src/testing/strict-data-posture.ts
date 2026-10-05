/**
 * ADR-0181 (strict defaults, SB1) test fixture: give a test file the LAX
 * guardrails / data / runtime posture it pins, explicitly, and put back
 * exactly what was there before.
 *
 * A fresh install now ships strict: the PII floor blocks, guardrails block
 * prompt injection and jailbreak and warn on the rest, trace content is not
 * captured, the env-key fallback, custom providers and LLM training are off,
 * compaction fails closed, the semantic cache is off, strict field rejection
 * is on and a stream request on a block-mode call is rejected. Suites that pin
 * OTHER behaviour (a streaming frame order, a cache hit, a compaction fallback,
 * an env-key dispatch) set the one posture they need here. The strict values
 * themselves are pinned by zz-adr0181-sb1-strict-defaults.test.ts.
 *
 * Every helper writes the singleton rows directly (the precedent of
 * `testing/assurance-mode.ts`) and returns a `restore()` that puts back the
 * PREVIOUS values of exactly the keys it changed. Global state (M-068): call
 * `restore()` in the file's afterAll.
 */
import {
  and,
  eq,
  guardrailConfigs,
  interceptionSettings,
  INTERCEPTION_SETTINGS_ID,
  isNull,
  orgSettings,
  ORG_SETTINGS_ID,
  type Db,
} from "@regulait/db";
import { loadOrgSettings } from "../org-settings.js";
import { loadInterceptionSettings } from "../compat-core.js";

type OrgPatch = Partial<typeof orgSettings.$inferInsert>;
type InterceptionPatch = Partial<typeof interceptionSettings.$inferInsert>;
type GuardrailModePatch = Partial<
  Pick<typeof guardrailConfigs.$inferInsert, "promptInjectionMode" | "jailbreakMode" | "toxicityMode" | "semanticDlpMode">
>;

/** The pre-ADR-0181 values of the SB1 org settings (the lax posture). */
export const PRE_ADR0181_ORG_SETTINGS = {
  defaultPiiMode: "none",
  semanticCachePolicy: "opt_in",
  compactionFailureMode: "fail_open",
  envKeyFallbackEnabled: true,
  customModelProvidersEnabled: true,
  llmTrainingEnabled: true,
  tracingCaptureContent: true,
} as const satisfies OrgPatch;

/** The pre-ADR-0181 values of the SB1 interception settings. */
export const PRE_ADR0181_INTERCEPTION = {
  streamingOnBlockMode: "suppress",
  strictFieldRejection: false,
} as const satisfies InterceptionPatch;

/** The pre-ADR-0181 guardrail posture: every configurable layer at `log`. */
export const PRE_ADR0181_GUARDRAIL_MODES = {
  promptInjectionMode: "log",
  jailbreakMode: "log",
  toxicityMode: "log",
  semanticDlpMode: "log",
} as const satisfies GuardrailModePatch;

function pick<T extends Record<string, unknown>>(row: T, keys: readonly string[]): Partial<T> {
  return Object.fromEntries(keys.map((k) => [k, row[k]])) as Partial<T>;
}

/** Set org_settings keys for a test; `restore()` puts the previous values back. */
export async function setOrgSettingsForTest(db: Db, patch: OrgPatch): Promise<() => Promise<void>> {
  const before = pick(await loadOrgSettings(db), Object.keys(patch)) as OrgPatch;
  await db.update(orgSettings).set(patch).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  return async () => {
    await db.update(orgSettings).set(before).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  };
}

/** Set interception_settings keys for a test; `restore()` puts the previous values back. */
export async function setInterceptionSettingsForTest(db: Db, patch: InterceptionPatch): Promise<() => Promise<void>> {
  const before = pick(await loadInterceptionSettings(db), Object.keys(patch)) as InterceptionPatch;
  await db.update(interceptionSettings).set(patch).where(eq(interceptionSettings.id, INTERCEPTION_SETTINGS_ID));
  return async () => {
    await db.update(interceptionSettings).set(before).where(eq(interceptionSettings.id, INTERCEPTION_SETTINGS_ID));
  };
}

/**
 * Set the ORG-default guardrail modes for a test. With no org row yet, one is
 * created and `restore()` deletes it again (the shipped defaults then apply);
 * otherwise `restore()` puts the previous modes back.
 */
export async function setOrgGuardrailModesForTest(db: Db, modes: GuardrailModePatch): Promise<() => Promise<void>> {
  const orgScope = and(eq(guardrailConfigs.scope, "org"), isNull(guardrailConfigs.scopeId));
  const [existing] = await db.select().from(guardrailConfigs).where(orgScope);
  if (!existing) {
    const [created] = await db.insert(guardrailConfigs).values({ scope: "org", scopeId: null, ...modes }).returning();
    return async () => {
      await db.delete(guardrailConfigs).where(eq(guardrailConfigs.id, created!.id));
    };
  }
  const before = pick(existing, Object.keys(modes)) as GuardrailModePatch;
  await db.update(guardrailConfigs).set(modes).where(eq(guardrailConfigs.id, existing.id));
  return async () => {
    await db.update(guardrailConfigs).set(before).where(eq(guardrailConfigs.id, existing.id));
  };
}

/**
 * The whole pre-ADR-0181 SB1 posture at once — for a suite that pins
 * behaviour across several of these settings (a dispatch-path suite written
 * against the old defaults). Prefer the narrow helpers above when a suite
 * needs only one setting. Pass `false` to leave a group strict.
 */
export async function relaxDataPostureForTest(
  db: Db,
  opts: { org?: OrgPatch | false; interception?: InterceptionPatch | false; guardrails?: GuardrailModePatch | false } = {},
): Promise<() => Promise<void>> {
  const restores: Array<() => Promise<void>> = [];
  if (opts.org !== false) restores.push(await setOrgSettingsForTest(db, opts.org ?? PRE_ADR0181_ORG_SETTINGS));
  if (opts.interception !== false) {
    restores.push(await setInterceptionSettingsForTest(db, opts.interception ?? PRE_ADR0181_INTERCEPTION));
  }
  if (opts.guardrails !== false) {
    restores.push(await setOrgGuardrailModesForTest(db, opts.guardrails ?? PRE_ADR0181_GUARDRAIL_MODES));
  }
  return async () => {
    for (const r of restores.reverse()) await r();
  };
}
