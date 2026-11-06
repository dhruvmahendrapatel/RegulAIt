/**
 * Batch I-2 (owner amendment, #453): the Enforcement posture page keeps its settings cards behind tabs, so each tab's
 * label carries that card's unresolved state. Anything that reads unknown, not reported, disabled or as a warning
 * counts; a tab with nothing unresolved shows only its name. A tab never hides a warning without saying so (ADR-0180).
 *
 * Each function reads the same data the card renders from, with the card's own predicates, so the label and the card
 * cannot disagree. `null` means "still loading": the label shows the name until the read settles.
 */
import { plural } from "../../../api/format";
import { discoveryPostureRows } from "../governance/DiscoveryPostureCard";
import type { DiscoveryPostureView } from "../governance/discoverySourcesModel";
import {
  EDITABLE_KEYS,
  SETTING_DEFAULTS,
  SETTING_KEYS,
  isSetting,
  settingRelaxed,
  settingsComplete,
  settingsFromEnvelope,
} from "../integrations/isolation/isolationModel";
import { BOM_POSTURE_SETTINGS, bomRelaxed, bomStoredValue, receiptKeyUsable, type ReceiptSigningKeyPosture } from "./BomPostureCard";
import { specsFor, storedValue } from "./orgSettingSpecs";
import { parseReceiptKeys } from "./receiptKeysModel";

export interface Unresolved {
  /** reads unknown or not reported */
  unknown: number;
  /** a warning, a relaxation or a disabled capability */
  warnings: number;
}

/** one query's state: `data` undefined while loading or after a failed first read */
export interface Read {
  data: unknown;
  failed: boolean;
}

const settled = (r: Read) => r.data !== undefined || r.failed;

/** "Isolation · 2 unknown", "Discovery · 1 warning", or just the name when nothing is unresolved */
export function tabLabel(name: string, u: Unresolved | null): string {
  if (!u) return name;
  const parts = [u.unknown > 0 ? `${u.unknown.toLocaleString()} unknown` : null, u.warnings > 0 ? plural(u.warnings, "warning") : null];
  const shown = parts.filter((p): p is string => p !== null);
  return shown.length ? `${name} · ${shown.join(" · ")}` : name;
}

/** `OrgSettingsCard`: a key that reads unknown, or one that reads "relaxed (audited)" */
export function orgSettingsUnresolved(keys: readonly string[], read: Read): Unresolved | null {
  if (!settled(read)) return null;
  const stored = settingsFromEnvelope(read.data);
  const u: Unresolved = { unknown: 0, warnings: 0 };
  for (const spec of specsFor(keys)) {
    const value = stored ? storedValue(spec, stored[spec.key]) : undefined;
    if (value === undefined) u.unknown += 1;
    else if (spec.isRelaxed(value)) u.warnings += 1;
  }
  return u;
}

/** `BomPostureCard`: the receipt key, the recorded keys, and each BOM setting */
export function bomUnresolved(read: Read, receiptKey: ReceiptSigningKeyPosture | undefined, keys: Read): Unresolved | null {
  if (!settled(read) || !settled(keys)) return null;
  const stored = settingsFromEnvelope(read.data);
  const u: Unresolved = { unknown: 0, warnings: 0 };
  const usable = receiptKeyUsable(receiptKey);
  if (usable === null) u.unknown += 1;
  else if (!usable) u.warnings += 1; // "Decision BOM: unavailable (no signing key)"
  if (keys.data === undefined || parseReceiptKeys(keys.data) === null) u.unknown += 1;
  for (const setting of BOM_POSTURE_SETTINGS) {
    const value = stored ? bomStoredValue(setting, stored[setting.key]) : null;
    if (value === null) u.unknown += 1;
    else if (bomRelaxed(setting, value)) u.warnings += 1;
  }
  return u;
}

/** `IsolationSettingsCard`: unmeasured values read "Not reported"; measured ones may read "Relaxed · audited" */
export function isolationUnresolved(read: Read): Unresolved | null {
  if (!settled(read)) return null;
  const settings = settingsFromEnvelope(read.data);
  if (!settingsComplete(settings)) {
    return { unknown: SETTING_KEYS.filter((k) => !isSetting(k, settings?.[k])).length, warnings: 0 };
  }
  return { unknown: 0, warnings: EDITABLE_KEYS.filter((k) => settingRelaxed(k, settings[k], SETTING_DEFAULTS[k])).length };
}

/** `DiscoveryPostureCard`: every row whose count reads as a warning; a posture the gateway did not report is unknown */
export function discoveryUnresolved(posture: DiscoveryPostureView | undefined): Unresolved {
  if (!posture) return { unknown: 1, warnings: 0 };
  return { unknown: 0, warnings: discoveryPostureRows(posture).filter((r) => r.tone === "warn" || r.tone === "danger").length };
}
