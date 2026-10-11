/**
 * ADR-0190 slice I9: the browser's model of the isolation contract.
 *
 * The SPA does not depend on `@regulait/shared`, so the constants below mirror
 * `packages/shared/src/isolation/{contract,settings}.ts`. `isolationModel.test.ts`
 * imports the shared module at test time and fails on any drift.
 *
 * What the gateway serves today (read at `isolation-routes.ts`):
 *  - `GET /v1/org/settings`: the eight isolation settings (I1, built).
 *  - `GET /v1/executors`: executors with the gateway's own freshness verdict
 *    per profile digest, judged on the database clock (I3, built).
 *  - `GET /v1/execution-profiles` and `GET /v1/execution-placements`: 501
 *    `not_built` stubs until slice I2. Their success bodies are not frozen,
 *    so this model never decodes them.
 *  - No route assigns an execution profile to an agent or an MCP server.
 *
 * Every reader treats the response as unknown input. Anything missing or
 * malformed reads as unmeasured and never as a pass (ADR-0180).
 */
import { ApiError } from "../../../../api/client";

// ---------------------------------------------------------------------------
// classes (decision 1)
// ---------------------------------------------------------------------------

/** the classes a floor or a profile may require: L1 to L3, never L0 */
export const CLASSES = ["hardened_container", "user_space_kernel", "microvm"] as const;
export type IsolationClass = (typeof CLASSES)[number];

/** L1 is a hardened container and is never called a sandbox (decision 11 invariant) */
export const CLASS_LABEL: Readonly<Record<IsolationClass, string>> = {
  hardened_container: "L1 · Hardened container",
  user_space_kernel: "L2 · User-space kernel sandbox",
  microvm: "L3 · MicroVM sandbox",
};

export const isClass = (value: unknown): value is IsolationClass =>
  typeof value === "string" && (CLASSES as readonly string[]).includes(value);

export function classText(value: unknown): string {
  if (isClass(value)) return CLASS_LABEL[value];
  if (value === "customer_declared") return "Customer declared · not verified";
  return "Not reported";
}

// ---------------------------------------------------------------------------
// org settings (decision 11, owner decision A)
// ---------------------------------------------------------------------------

/**
 * Owner decision A (2026-10-11): `warn` is retired and `enforce` is the only
 * value. The gateway refuses anything else with a 400, so the UI shows the
 * setting as fixed and never sends it.
 */
export const ENFORCEMENT = "enforce" as const;

export const SETTING_DEFAULTS = {
  isolationEnforcement: ENFORCEMENT,
  isolationFloorPublic: "user_space_kernel",
  isolationFloorInternal: "user_space_kernel",
  isolationFloorConfidential: "user_space_kernel",
  isolationFloorRegulated: "microvm",
  isolationFloorMcpStdio: "user_space_kernel",
  isolationFloorEngineWorker: "user_space_kernel",
  executorAttestationMaxAgeMinutes: 120,
} as const;
export type SettingKey = keyof typeof SETTING_DEFAULTS;
export const SETTING_KEYS = Object.keys(SETTING_DEFAULTS) as SettingKey[];

export const FLOOR_KEYS = [
  "isolationFloorPublic",
  "isolationFloorInternal",
  "isolationFloorConfidential",
  "isolationFloorRegulated",
  "isolationFloorMcpStdio",
  "isolationFloorEngineWorker",
] as const satisfies readonly SettingKey[];
export type FloorKey = (typeof FLOOR_KEYS)[number];

/** the settings an admin can change here: every floor and the attestation lifetime */
export const EDITABLE_KEYS = [...FLOOR_KEYS, "executorAttestationMaxAgeMinutes"] as const satisfies readonly SettingKey[];
export type EditableKey = (typeof EDITABLE_KEYS)[number];

export const LIFETIME_LIMITS = { min: 60, max: 1440 } as const;

/** the labels of `ISOLATION_SETTING_COPY` (parity-tested) */
export const SETTING_LABEL: Readonly<Record<SettingKey, string>> = {
  isolationEnforcement: "Enforce isolation",
  isolationFloorPublic: "Isolation floor: public projects",
  isolationFloorInternal: "Isolation floor: internal projects",
  isolationFloorConfidential: "Isolation floor: confidential projects",
  isolationFloorRegulated: "Isolation floor: regulated projects",
  isolationFloorMcpStdio: "Isolation floor: local (stdio) MCP servers",
  isolationFloorEngineWorker: "Isolation floor: engine workers",
  executorAttestationMaxAgeMinutes: "Executor attestation lifetime (minutes)",
};

/** the published envelope is `{settings: {...}}`; anything else is unmeasured, never defaulted */
export function settingsFromEnvelope(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value) || !Object.hasOwn(value, "settings")) return null;
  const settings = (value as { settings: unknown }).settings;
  return settings !== null && typeof settings === "object" && !Array.isArray(settings) ? (settings as Record<string, unknown>) : null;
}

export function isSetting(key: SettingKey, value: unknown): boolean {
  if (key === "isolationEnforcement") return value === ENFORCEMENT;
  if (key === "executorAttestationMaxAgeMinutes")
    return typeof value === "number" && Number.isInteger(value) && value >= LIFETIME_LIMITS.min && value <= LIFETIME_LIMITS.max;
  return isClass(value);
}

/** all eight reported and valid; otherwise the card is unmeasured and read-only */
export const settingsComplete = (settings: Record<string, unknown> | null): settings is Record<SettingKey, string | number> =>
  settings !== null && SETTING_KEYS.every((key) => isSetting(key, settings[key]));

/**
 * Is `next` looser than `base`? A lower floor and a longer lifetime are. An
 * unreadable base is judged conservatively: any change from it is a relaxation.
 */
export function settingRelaxed(key: EditableKey, next: string | number, base: unknown): boolean {
  if (!isSetting(key, base)) return true;
  if (key === "executorAttestationMaxAgeMinutes") return typeof next === "number" && next > (base as number);
  return isClass(next) && CLASSES.indexOf(next) < CLASSES.indexOf(base as IsolationClass);
}

export type SettingsDraft = Record<EditableKey, string>;

export const draftFrom = (settings: Record<string, unknown>): SettingsDraft =>
  Object.fromEntries(EDITABLE_KEYS.map((key) => [key, isSetting(key, settings[key]) ? String(settings[key]) : ""])) as SettingsDraft;

function parseDraft(key: EditableKey, raw: string): string | number | null {
  if (key === "executorAttestationMaxAgeMinutes") {
    // a bounded whole number: no regex on caller input (M-074)
    const text = raw.trim();
    if (text === "" || text.length > 5 || ![...text].every((c) => c >= "0" && c <= "9")) return null;
    const n = Number(text);
    return isSetting(key, n) ? n : null;
  }
  return isClass(raw) ? raw : null;
}

/**
 * The body to send: only the fields this person edited (relative to what the
 * form loaded) that still differ from what is stored now, so another admin's
 * unrelated change is kept. `relaxed` lists each change that is looser than
 * the strict default or the stored value; the gateway asks for the step-up.
 */
export function settingChanges(
  loaded: Record<string, unknown>,
  draft: SettingsDraft,
  current: Record<string, unknown>,
): { error: string } | { body: Partial<Record<EditableKey, string | number>>; relaxed: string[] } {
  const body: Partial<Record<EditableKey, string | number>> = {};
  const relaxed: string[] = [];
  for (const key of EDITABLE_KEYS) {
    const next = parseDraft(key, draft[key]);
    if (next === null)
      return { error: `Choose a known isolation class for each floor, and an attestation lifetime of ${LIFETIME_LIMITS.min} to ${LIFETIME_LIMITS.max} whole minutes.` };
    if (next === loaded[key] || next === current[key]) continue;
    body[key] = next;
    if (settingRelaxed(key, next, SETTING_DEFAULTS[key]) || settingRelaxed(key, next, current[key])) relaxed.push(relaxText(key, next));
  }
  return { body, relaxed };
}

function relaxText(key: EditableKey, next: string | number): string {
  return key === "executorAttestationMaxAgeMinutes" ? `${SETTING_LABEL[key]}: ${next}` : `${SETTING_LABEL[key]}: ${classText(next)}`;
}

// ---------------------------------------------------------------------------
// refusals (decision 7, owner decision B)
// ---------------------------------------------------------------------------

/** `409 execution_profile_unavailable` reasons, `EXECUTION_REFUSAL_REASONS` (parity-tested) */
export const REFUSAL_TEXT = {
  no_executor: "No executor can take the call.",
  attestation_stale: "The executor's last passing self-test is too old.",
  class_below_required: "The isolation available is below the class the call requires.",
  executor_quarantined: "The executor is quarantined.",
  profile_retired: "The execution profile is retired.",
  policy_unresolved: "A policy fact the requirement depends on is missing or could not be resolved. This is a configuration fault, not a capacity one.",
} as const;
export type RefusalReason = keyof typeof REFUSAL_TEXT;
export const REFUSAL_REASONS = Object.keys(REFUSAL_TEXT) as RefusalReason[];

/** the per-placement report disagreed with the profile: refused before input, executor quarantined (decision 6) */
export const MISMATCH_TEXT = "The sandbox's own report disagreed with the required profile. Input was refused and the executor quarantined.";

// ---------------------------------------------------------------------------
// route availability
// ---------------------------------------------------------------------------

export type Availability = { kind: "not_built" } | { kind: "forbidden" } | { kind: "failed"; message: string };

/** why a read gave nothing usable. A 501 is the gateway saying the slice is not built. */
export function availabilityOf(error: unknown): Availability {
  if (error instanceof ApiError && error.status === 501) return { kind: "not_built" };
  if (error instanceof ApiError && (error.status === 401 || error.status === 403)) return { kind: "forbidden" };
  return { kind: "failed", message: error instanceof Error ? error.message : "The request failed." };
}

// ---------------------------------------------------------------------------
// executors: `GET /v1/executors` (I3)
// ---------------------------------------------------------------------------

export const BACKENDS = ["runc", "gvisor", "kata", "openshell", "customer"] as const;
export type Backend = (typeof BACKENDS)[number];
const STATUSES = ["active", "quarantined", "revoked"] as const;
type Status = (typeof STATUSES)[number];

/** decision 1 with amendment F, `BACKEND_ATTESTABLE_CLASSES` (parity-tested) */
export const BACKEND_CLASSES: Readonly<Record<Backend, readonly string[]>> = {
  runc: ["hardened_container"],
  gvisor: ["hardened_container", "user_space_kernel"],
  kata: ["hardened_container", "microvm"],
  openshell: ["hardened_container", "microvm"],
  customer: ["customer_declared"],
};

export const QUARANTINE_TEXT: Readonly<Record<string, string>> = {
  execution_profile_mismatch: "a sandbox report disagreed with its profile",
  attestation_failed: "a self-test failed",
  admin: "an administrator quarantined it",
};

export interface ExecutorAttestation {
  profileDigest: string;
  fresh: boolean;
  isolationClass: string | null;
  expiresAt: number | null;
}

export interface Executor {
  id: string;
  name: string;
  backend: Backend;
  runtimeVersion: string;
  status: Status;
  quarantineCode: string | null;
  classesDeclared: string[];
  declaredClass: IsolationClass | null;
  lastSeenAt: number | null;
  attestations: ExecutorAttestation[];
  openOffers: number;
}

const str = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 512;
const isoMs = (v: unknown): number | null => {
  if (typeof v !== "string") return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
};

function parseAttestation(raw: unknown): ExecutorAttestation | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const a = raw as Record<string, unknown>;
  if (!str(a.profileDigest) || typeof a.fresh !== "boolean") return null;
  if (!a.fresh) return { profileDigest: a.profileDigest, fresh: false, isolationClass: null, expiresAt: null };
  // a fresh attestation without its class and a valid expiry is not evidence
  const expiresAt = isoMs(a.expiresAt);
  if (!str(a.class) || expiresAt === null) return null;
  return { profileDigest: a.profileDigest, fresh: true, isolationClass: a.class, expiresAt };
}

function parseExecutor(raw: unknown): Executor | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const e = raw as Record<string, unknown>;
  if (!str(e.executorId) || !str(e.name)) return null;
  if (typeof e.backend !== "string" || !Object.hasOwn(BACKEND_CLASSES, e.backend)) return null;
  if (typeof e.status !== "string" || !(STATUSES as readonly string[]).includes(e.status)) return null;
  if (!Array.isArray(e.classesDeclared) || !e.classesDeclared.every((c) => typeof c === "string")) return null;
  if (!Array.isArray(e.attestations)) return null;
  const attestations: ExecutorAttestation[] = [];
  for (const a of e.attestations) {
    const parsed = parseAttestation(a);
    if (!parsed) return null;
    attestations.push(parsed);
  }
  return {
    id: e.executorId,
    name: e.name,
    backend: e.backend as Backend,
    runtimeVersion: str(e.runtimeVersion) ? e.runtimeVersion : "Not reported",
    status: e.status as Status,
    quarantineCode: typeof e.quarantineCode === "string" ? e.quarantineCode : null,
    classesDeclared: e.classesDeclared as string[],
    declaredClass: isClass(e.declaredClass) ? e.declaredClass : null,
    lastSeenAt: isoMs(e.lastSeenAt),
    attestations,
    openOffers: typeof e.openOffers === "number" && Number.isInteger(e.openOffers) && e.openOffers >= 0 ? e.openOffers : 0,
  };
}

/**
 * `{executors: [...]}`. Null when the envelope is malformed. A malformed row
 * becomes an `unreadable` entry so it is shown and never silently dropped.
 */
export function parseExecutors(value: unknown): Array<Executor | { unreadable: true; index: number }> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value) || !Object.hasOwn(value, "executors")) return null;
  const list = (value as { executors: unknown }).executors;
  if (!Array.isArray(list)) return null;
  return list.map((row, index) => parseExecutor(row) ?? { unreadable: true as const, index });
}

export type Tone = "ok" | "warn" | "danger" | "neutral";
export interface Reading {
  state: string;
  tone: Tone;
  detail: string;
}

/**
 * The attestation chip for one executor. Freshness is the gateway's verdict
 * (database clock). The device clock may only take assurance away: a report
 * the gateway called fresh reads as expired once its expiry passes on this
 * screen, and nothing ever turns green on the device clock alone.
 */
export function executorReading(e: Executor, now: number): Reading {
  if (e.status === "revoked") return { state: "Revoked", tone: "danger", detail: "Terminal. A new executor needs a new identity and key." };
  if (e.status === "quarantined")
    return {
      state: "Quarantined",
      tone: "danger",
      detail: `Places nothing: ${e.quarantineCode ? QUARANTINE_TEXT[e.quarantineCode] ?? e.quarantineCode : "reason not reported"}. It must be re-enabled and pass a new self-test.`,
    };
  const allowed = BACKEND_CLASSES[e.backend];
  const fresh = e.attestations.filter((a) => a.fresh && a.expiresAt !== null && a.expiresAt > now && allowed.includes(a.isolationClass ?? ""));
  if (fresh.length === 0) {
    const expired = e.attestations.some((a) => a.fresh);
    return expired
      ? { state: "Stale", tone: "warn", detail: "The last passing self-test has expired. It cannot justify a placement." }
      : { state: "No fresh report", tone: "neutral", detail: "No passing self-test within the attestation lifetime. Its classes do not count." };
  }
  const until = Math.min(...fresh.map((a) => a.expiresAt!));
  if (e.backend === "customer") {
    return {
      state: "Customer declared",
      tone: "warn",
      detail: e.declaredClass
        ? `An administrator mapped it to ${classText(e.declaredClass)}. Its isolation is declared, not verified.`
        : "Not mapped to a class, so it satisfies no requirement (the strict default).",
    };
  }
  const classes = [...new Set(fresh.map((a) => a.isolationClass!))].filter(isClass).sort((x, y) => CLASSES.indexOf(y) - CLASSES.indexOf(x));
  return {
    state: "Fresh report",
    tone: "ok",
    detail: `Software-attested ${classes.map(classText).join(", ")} until ${new Date(until).toISOString()}. The gateway decides each placement.`,
  };
}

// ---------------------------------------------------------------------------
// registering an executor: `POST /v1/executors` (I3, `registerExecutorSchema`)
// ---------------------------------------------------------------------------

export interface RegisterDraft {
  workloadIdentityId: string;
  name: string;
  backend: Backend | "";
  runtimeVersion: string;
  classesDeclared: string[];
}
export interface RegisterBody {
  workloadIdentityId: string;
  name: string;
  backend: Backend;
  runtimeVersion: string;
  classesDeclared: string[];
}

const lower = (c: string) => c >= "a" && c <= "z";
const digit = (c: string) => c >= "0" && c <= "9";
/** `^[a-z][a-z0-9-]{1,62}$`, checked by character (M-074: no regex on caller input) */
export const executorNameOk = (s: string) =>
  s.length >= 2 && s.length <= 63 && lower(s[0]!) && [...s].every((c) => lower(c) || digit(c) || c === "-");
/** `^[A-Za-z0-9._+-]+$`, 1 to 128 characters */
export const runtimeVersionOk = (s: string) =>
  s.length >= 1 && s.length <= 128 && [...s].every((c) => lower(c) || (c >= "A" && c <= "Z") || digit(c) || ".-_+".includes(c));

const hex = (c: string) => digit(c) || (c >= "a" && c <= "f") || (c >= "A" && c <= "F");
/** a UUID's 8-4-4-4-12 hex shape, checked by character */
export const uuidOk = (s: string) =>
  s.length === 36 && [...s].every((c, i) => ([8, 13, 18, 23].includes(i) ? c === "-" : hex(c)));

/** the body to post, or what is wrong with the draft. The gateway re-checks all of it. */
export function registerBody(d: RegisterDraft): { error: string } | { body: RegisterBody } {
  if (!uuidOk(d.workloadIdentityId)) return { error: "Worker identity id: the identity's UUID, for example 8d4b1f8e-0000-4000-8000-000000000001." };
  if (!executorNameOk(d.name)) return { error: "Name: 2 to 63 characters, lower-case letters, digits and hyphens, starting with a letter." };
  if (!d.backend) return { error: "Choose the backend." };
  if (!runtimeVersionOk(d.runtimeVersion)) return { error: "Runtime version: 1 to 128 characters, letters, digits and . _ + -" };
  const allowed = BACKEND_CLASSES[d.backend];
  const classes = [...new Set(d.classesDeclared)];
  if (classes.length === 0) return { error: "Choose at least one class the executor is expected to attest." };
  if (classes.some((c) => !allowed.includes(c))) return { error: `The ${d.backend} backend cannot attest every chosen class.` };
  return { body: { workloadIdentityId: d.workloadIdentityId, name: d.name, backend: d.backend, runtimeVersion: d.runtimeVersion, classesDeclared: classes } };
}
