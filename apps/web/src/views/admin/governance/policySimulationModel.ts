/**
 * ADR-0059 — the blast-radius settings form, as pure functions:
 * `PUT /v1/policy-simulations/settings` takes `policySimulationSettingsSchema`
 * (packages/shared/src/policy-simulation.ts): every field optional, the two
 * numbers bounded. Turning `requirePreviewBeforeActivate` off is the one
 * relaxation (the gateway asks for a `settings_relax` step-up), so the form
 * says it before it is sent.
 */
import type { RefusalSentences } from "./refusalCopy";

/** mirrors POLICY_SIMULATION_MAX_WINDOW_DAYS / POLICY_SIMULATION_MAX_ROWS (pinned by the unit test) */
export const POLICY_SIMULATION_BOUNDS = { maxWindowDays: 180, maxRows: 20_000 } as const;

export interface PolicySimulationSettings {
  requirePreviewBeforeActivate: boolean;
  defaultWindowDays: number;
  defaultRowCap: number;
  updatedByUserId?: string | null;
  updatedAt?: string;
}

export interface PolicySimulationSettingsResponse {
  settings: PolicySimulationSettings;
  note: string;
  defaults: { windowDays: number; rowCap: number };
}

export interface SettingsForm {
  requirePreviewBeforeActivate: boolean;
  defaultWindowDays: string;
  defaultRowCap: string;
}

export const settingsFormFrom = (s: PolicySimulationSettings): SettingsForm => ({
  requirePreviewBeforeActivate: s.requirePreviewBeforeActivate,
  defaultWindowDays: String(s.defaultWindowDays),
  defaultRowCap: String(s.defaultRowCap),
});

export interface SettingsBody {
  requirePreviewBeforeActivate?: boolean;
  defaultWindowDays?: number;
  defaultRowCap?: number;
}

const wholeIn = (raw: string, max: number): number | null => {
  if (!/^\d+$/.test(raw.trim())) return null;
  const n = Number(raw.trim());
  return n >= 1 && n <= max ? n : null;
};

/** only the fields that changed; a problem sentence when a number is out of range */
export function settingsBody(
  form: SettingsForm,
  current: PolicySimulationSettings,
): { ok: true; body: SettingsBody; relaxes: boolean } | { ok: false; problem: string } {
  const windowDays = wholeIn(form.defaultWindowDays, POLICY_SIMULATION_BOUNDS.maxWindowDays);
  if (windowDays === null) {
    return { ok: false, problem: `The default window must be a whole number of days from 1 to ${POLICY_SIMULATION_BOUNDS.maxWindowDays}.` };
  }
  const rowCap = wholeIn(form.defaultRowCap, POLICY_SIMULATION_BOUNDS.maxRows);
  if (rowCap === null) {
    return { ok: false, problem: `The row cap must be a whole number from 1 to ${POLICY_SIMULATION_BOUNDS.maxRows.toLocaleString("en-US")}.` };
  }
  const body: SettingsBody = {};
  if (form.requirePreviewBeforeActivate !== current.requirePreviewBeforeActivate) {
    body.requirePreviewBeforeActivate = form.requirePreviewBeforeActivate;
  }
  if (windowDays !== current.defaultWindowDays) body.defaultWindowDays = windowDays;
  if (rowCap !== current.defaultRowCap) body.defaultRowCap = rowCap;
  return { ok: true, body, relaxes: body.requirePreviewBeforeActivate === false };
}

export const POLICY_SIMULATION_REFUSALS: RefusalSentences = {
  unknown_simulation: "That preview no longer exists.",
  simulation_scope_denied: "This preview covers people outside what you may see, so it cannot be opened here.",
  changed_concurrently: "Someone changed these settings while you were saving, so nothing was written. Reload and repeat the change.",
};
