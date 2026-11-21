/**
 * ADR-0056 §5 amendment — the copilot narrator red-team gate, as pure functions for its settings card
 * (`GET/PUT /v1/copilot/redteam-gate`).
 *
 * An agent may narrate a copilot answer only after a passing red-team run on the one designated library: enough
 * trials, every required class answered and resisted at or above the floor, the same model and system prompt it
 * serves now, and recent enough. Turning the gate off, a longer window, a lower floor, fewer trials, or ANY change of
 * library is a relaxation (the gateway asks for a `settings_relax` step-up), so the form says so before it is sent.
 * The rules here mirror `copilotRedteamRelaxed` in apps/gateway/src/copilot-redteam-gate.ts.
 */
import type { RefusalSentences } from "./refusalCopy";

/** mirrors COPILOT_REDTEAM_MAX_AGE_LIMIT_DAYS and RED_TEAM_MAX_TRIALS (pinned by the unit test) */
export const REDTEAM_GATE_BOUNDS = { maxAgeDays: 365, maxTrials: 25 } as const;

export interface RedteamGateSettings {
  enabled: boolean;
  maxAgeDays: number;
  /** a fraction, 0 to 1; shown as a percentage */
  minResistRate: number;
  libraryId: string | null;
  minTrials: number;
  requiredClasses: string[];
}

/** for one agent: may it narrate, and which run decided it */
export interface RedteamGateVerdict {
  allowed: boolean;
  runId: string | null;
  reason: string;
}

export interface RedteamGateStatus {
  settings: RedteamGateSettings;
  agentId?: string;
  verdict?: RedteamGateVerdict;
}

export interface GateForm {
  enabled: boolean;
  maxAgeDays: string;
  /** a whole percentage, 0 to 100 */
  minResistPercent: string;
  libraryId: string;
  minTrials: string;
}

export interface GateBody {
  enabled?: boolean;
  maxAgeDays?: number;
  minResistRate?: number;
  libraryId?: string | null;
  minTrials?: number;
}

export const gateFormFrom = (s: RedteamGateSettings): GateForm => ({
  enabled: s.enabled,
  maxAgeDays: String(s.maxAgeDays),
  minResistPercent: String(Math.round(s.minResistRate * 100)),
  libraryId: s.libraryId ?? "",
  minTrials: String(s.minTrials),
});

const wholeIn = (raw: string, min: number, max: number): number | null => {
  if (!/^\d+$/.test(raw.trim())) return null;
  const n = Number(raw.trim());
  return n >= min && n <= max ? n : null;
};

/** what a change loosens, in the words the confirmation shows; empty when nothing does */
export function relaxations(body: GateBody, current: RedteamGateSettings): string[] {
  const out: string[] = [];
  if (body.enabled === false && current.enabled) out.push("turns the gate off, so any agent may narrate");
  if (body.maxAgeDays !== undefined && body.maxAgeDays > current.maxAgeDays) out.push(`accepts older runs (up to ${body.maxAgeDays} days)`);
  if (body.minResistRate !== undefined && body.minResistRate < current.minResistRate) {
    out.push(`lowers the floor to ${Math.round(body.minResistRate * 100)}% resisted`);
  }
  if (body.minTrials !== undefined && body.minTrials < current.minTrials) out.push(`needs fewer trials per probe (${body.minTrials})`);
  if (body.libraryId !== undefined && body.libraryId !== current.libraryId) {
    out.push(body.libraryId === null ? "clears the library, so no agent may narrate" : "changes which library decides");
  }
  return out;
}

/** only the fields that changed; a problem sentence when a value is out of range */
export function gateBody(
  form: GateForm,
  current: RedteamGateSettings,
): { ok: true; body: GateBody; relaxes: string[] } | { ok: false; problem: string } {
  const maxAgeDays = wholeIn(form.maxAgeDays, 1, REDTEAM_GATE_BOUNDS.maxAgeDays);
  if (maxAgeDays === null) return { ok: false, problem: `The window must be a whole number of days from 1 to ${REDTEAM_GATE_BOUNDS.maxAgeDays}.` };
  const percent = wholeIn(form.minResistPercent, 0, 100);
  if (percent === null) return { ok: false, problem: "The floor must be a whole percentage from 0 to 100." };
  const minTrials = wholeIn(form.minTrials, 1, REDTEAM_GATE_BOUNDS.maxTrials);
  if (minTrials === null) return { ok: false, problem: `Trials per probe must be a whole number from 1 to ${REDTEAM_GATE_BOUNDS.maxTrials}.` };
  const body: GateBody = {};
  if (form.enabled !== current.enabled) body.enabled = form.enabled;
  if (maxAgeDays !== current.maxAgeDays) body.maxAgeDays = maxAgeDays;
  // compare in whole percent, so a stored 0.995 is not "changed" by a form that shows 100
  if (percent !== Math.round(current.minResistRate * 100)) body.minResistRate = percent / 100;
  if (minTrials !== current.minTrials) body.minTrials = minTrials;
  const libraryId = form.libraryId === "" ? null : form.libraryId;
  if (libraryId !== current.libraryId) body.libraryId = libraryId;
  return { ok: true, body, relaxes: relaxations(body, current) };
}

/** the card's one-line state, and its tone */
export function gateState(s: RedteamGateSettings): { label: string; tone: "ok" | "warn" | "danger" } {
  if (!s.enabled) return { label: "Gate off: any agent may narrate", tone: "danger" };
  if (!s.libraryId) return { label: "Gate on, no library chosen: no agent may narrate", tone: "warn" };
  return { label: "Gate on", tone: "ok" };
}

export const REDTEAM_GATE_REFUSALS: RefusalSentences = {
  bootstrap_cannot_change_copilot_redteam_gate: "The setup token cannot change this gate. Sign in as a named admin.",
  unknown_redteam_library: "That red-team library no longer exists.",
  redteam_library_not_published: "Only a published red-team library can decide. Publish it first, or choose another.",
  unknown_agent: "That agent no longer exists.",
  changed_concurrently: "Someone changed these settings while you were saving, so nothing was written. Reload and repeat the change.",
};
