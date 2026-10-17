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
 *  - `GET /v1/execution-profiles` and `GET /v1/execution-placements` (I2,
 *    built): profile versions with their relaxations against `restricted`,
 *    and placement decisions with the refusals made before any placement row.
 *  - `GET|PUT /v1/execution-profile-assignments/:kind/:id` (I2, built): the
 *    profile an agent, builder agent or stdio MCP server runs under.
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

export function parseExecutor(raw: unknown): Executor | null {
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
    // only a report for a class this backend can attest was ever evidence; anything else is no report, not a stale one
    const expired = e.attestations.some((a) => a.fresh && allowed.includes(a.isolationClass ?? ""));
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

/** `IDENTITY_PICKER_MAX` (packages/shared identity contract, mirrored; pinned by isolationPlacementModel.test.ts): each picker list's cap */
export const IDENTITY_PICKER_MAX = 1000;

/**
 * `GET /v1/identity/picker-sources` `workerIdentities` (ADR-0188 S6): the active worker_runtime identities an
 * executor may be registered against, as `{id, label}` (the label is the SPIFFE identifier). Null when the answer
 * cannot be read; a malformed option is dropped from the choices (it could not be sent anyway).
 *
 * `truncated` is per list here, though the gateway's flag is one for every list it returns: it is true only when
 * the gateway says something was cut AND this list is at the cap. A shorter list was not cut, whatever another list
 * did. (A per-list flag from the gateway would make this exact: a backend follow-up.)
 */
export function parseWorkerIdentities(value: unknown): { options: Array<{ id: string; label: string }>; truncated: boolean } | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.workerIdentities)) return null;
  const options = v.workerIdentities
    .filter((o): o is { id: string; label: string } => o !== null && typeof o === "object" && uuidOk(String((o as { id?: unknown }).id ?? "")) && str((o as { label?: unknown }).label))
    .map((o) => ({ id: o.id, label: o.label }));
  return { options, truncated: v.truncated === true && v.workerIdentities.length >= IDENTITY_PICKER_MAX };
}

/** the body to post, or what is wrong with the draft. The gateway re-checks all of it. */
export function registerBody(d: RegisterDraft): { error: string } | { body: RegisterBody } {
  if (!uuidOk(d.workloadIdentityId)) return { error: "Choose the worker identity the executor authenticates as." };
  if (!executorNameOk(d.name)) return { error: "Name: 2 to 63 characters, lower-case letters, digits and hyphens, starting with a letter." };
  if (!d.backend) return { error: "Choose the backend." };
  if (!runtimeVersionOk(d.runtimeVersion)) return { error: "Runtime version: 1 to 128 characters, letters, digits and . _ + -" };
  const allowed = BACKEND_CLASSES[d.backend];
  const classes = [...new Set(d.classesDeclared)];
  if (classes.length === 0) return { error: "Choose at least one class the executor is expected to attest." };
  if (classes.some((c) => !allowed.includes(c))) return { error: `The ${d.backend} backend cannot attest every chosen class.` };
  return { body: { workloadIdentityId: d.workloadIdentityId, name: d.name, backend: d.backend, runtimeVersion: d.runtimeVersion, classesDeclared: classes } };
}

// ---------------------------------------------------------------------------
// execution profiles: `GET /v1/execution-profiles` (I2, built)
// ---------------------------------------------------------------------------

export interface ProfileVersion {
  id: string;
  name: string;
  version: number;
  digest: string;
  minClass: IsolationClass;
  shipped: boolean;
  retiredAt: number | null;
  /** fields looser than the shipped `restricted` profile, as the gateway judged them */
  relaxations: string[];
}

const posInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1;

export function parseProfileVersion(raw: unknown): ProfileVersion | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const p = raw as Record<string, unknown>;
  if (!str(p.id) || !str(p.name) || !posInt(p.version) || !str(p.digest) || !isClass(p.minClass) || typeof p.shipped !== "boolean") return null;
  if (!Array.isArray(p.relaxations) || !p.relaxations.every((r) => typeof r === "string")) return null;
  if (p.retiredAt !== null && isoMs(p.retiredAt) === null) return null;
  return {
    id: p.id,
    name: p.name,
    version: p.version,
    digest: p.digest,
    minClass: p.minClass,
    shipped: p.shipped,
    retiredAt: p.retiredAt === null ? null : isoMs(p.retiredAt),
    relaxations: p.relaxations as string[],
  };
}

/**
 * The shipped profiles an admin may version but never retire (ADR-0190 I5 follow-up; mirrors
 * `VERSIONABLE_SHIPPED_EXECUTION_PROFILES` in @regulait/shared, checked by the model test). `restricted` and
 * `restricted-microvm` are the strict references: neither versioned nor retired.
 */
export const VERSIONABLE_SHIPPED_PROFILES: readonly string[] = ["engine-worker"];

/** which admin actions a profile version offers (the caller also requires it to be the live latest version) */
export function profileActions(p: Pick<ProfileVersion, "name" | "shipped">): { version: boolean; retire: boolean } {
  const versionedShipped = VERSIONABLE_SHIPPED_PROFILES.includes(p.name);
  return { version: !p.shipped || versionedShipped, retire: !p.shipped && !versionedShipped };
}

type VersionRow = Pick<ProfileVersion, "name" | "version">;
const readable = (rows: readonly unknown[]): VersionRow[] =>
  rows.filter((r): r is VersionRow => r !== null && typeof r === "object" && !("unreadable" in r) && "version" in r);

/** the number a new version of `name` gets: the newest version + 1 (a revert is a new version too, with an earlier version's controls) */
export function nextVersionOf(name: string, rows: readonly unknown[]): number {
  return Math.max(0, ...readable(rows).filter((r) => r.name === name).map((r) => r.version)) + 1;
}

/**
 * What the version route answered, in words. A body equal to an earlier version is a REVERT: a new version carrying
 * the gateway's `revertOf` marker (the earlier version it copies).
 */
export function versionOutcomeText(name: string, out: unknown): string {
  const o = out !== null && typeof out === "object" ? (out as { version?: unknown; revertOf?: { version?: unknown } | null }) : {};
  const v = typeof o.version === "number" ? ` v${o.version}` : "";
  if (o.revertOf && typeof o.revertOf.version === "number") return `Execution profile ${name} reverted to the controls of v${o.revertOf.version}${v ? ` (new version${v})` : ""}`;
  return `Execution profile ${name} versioned${v ? ` as${v}` : ""}`;
}

/** `{profiles: [...]}`; null when the envelope is malformed; a malformed row is kept as `unreadable`, never dropped */
export function parseProfiles(value: unknown): Array<ProfileVersion | { unreadable: true; index: number }> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value) || !Object.hasOwn(value, "profiles")) return null;
  const list = (value as { profiles: unknown }).profiles;
  if (!Array.isArray(list)) return null;
  return list.map((row, index) => parseProfileVersion(row) ?? { unreadable: true as const, index });
}

/** the profiles an admin may assign: every live (not retired) version */
export const assignableProfiles = (list: Array<ProfileVersion | { unreadable: true; index: number }>): ProfileVersion[] =>
  list.filter((p): p is ProfileVersion => !("unreadable" in p) && p.retiredAt === null);

export const profileText = (p: ProfileVersion) => `${p.name} v${p.version} · ${classText(p.minClass)}`;

/** `^[a-z][a-z0-9-]{1,62}$` (EXECUTION_PROFILE_NAME_RE), checked by character (M-074) */
export const profileNameOk = (s: string) =>
  s.length >= 2 && s.length <= 63 && s[0]! >= "a" && s[0]! <= "z" && [...s].every((c) => (c >= "a" && c <= "z") || (c >= "0" && c <= "9") || c === "-");

/**
 * A new profile starts from an existing version's body (`GET /v1/execution-profiles/:name`), renamed and with the
 * chosen minimum class. Every other field is the base's: the gateway judges each field against `restricted`, and a
 * looser one is a step-up and an audited relaxation. Null when the base body is not an object.
 */
export function newProfileBody(base: unknown, name: string, minClass: IsolationClass): Record<string, unknown> | null {
  if (base === null || typeof base !== "object" || Array.isArray(base)) return null;
  return { ...(base as Record<string, unknown>), name, minClass };
}

/** the body of one version from `GET /v1/execution-profiles/:name` (`{versions: [{id, body}]}`) */
export function versionBody(value: unknown, id: string): unknown {
  if (value === null || typeof value !== "object" || !Array.isArray((value as { versions?: unknown }).versions)) return null;
  const v = ((value as { versions: unknown[] }).versions as Array<Record<string, unknown>>).find((x) => x && x.id === id);
  return v?.body ?? null;
}

// ---------------------------------------------------------------------------
// profile assignment: `GET|PUT /v1/execution-profile-assignments/:kind/:id` (I2, built)
// ---------------------------------------------------------------------------

export type AssignmentTargetKind = "agent" | "builder_agent" | "mcp_server";

export interface Assignment {
  assigned: ProfileVersion | null;
  effective: ProfileVersion;
  source: "assigned" | "shipped_default";
}

/** a malformed answer is unmeasured (null), never "the default" */
export function parseAssignment(value: unknown): Assignment | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const a = value as Record<string, unknown>;
  const effective = parseProfileVersion(a.effective);
  if (!effective || (a.source !== "assigned" && a.source !== "shipped_default")) return null;
  const assigned = a.assigned === null ? null : parseProfileVersion(a.assigned);
  if (a.assigned !== null && !assigned) return null;
  if ((a.source === "assigned") !== (assigned !== null)) return null;
  return { assigned, effective, source: a.source };
}

// ---------------------------------------------------------------------------
// placements: `GET /v1/execution-placements` (I2, built)
// ---------------------------------------------------------------------------

/** decision 7: which floor set the required class */
export const REQUIRED_BY_TEXT: Readonly<Record<string, string>> = {
  workload_kind: "the workload kind",
  data_sensitivity: "the project's data sensitivity",
  compliance_tag: "a compliance tag",
  autonomy_class: "the agent's autonomy class",
  configured_profile: "the configured profile",
  unknown_agent: "an unknown or low-assurance agent",
  parent_grant: "the parent delegation",
};

/** `offered` (I4): a governed stdio call's placement chose an executor and is awaiting the sandbox's report */
const OUTCOMES = ["placed", "refused", "mismatch", "offered"] as const;
export interface Placement {
  id: string;
  workloadKind: string;
  requiredClass: IsolationClass;
  requiredBy: string;
  outcome: (typeof OUTCOMES)[number];
  refusalCode: string | null;
  appliedClass: string | null;
  executorName: string | null;
  profileName: string | null;
  profileVersion: number | null;
  createdAt: number;
}
export interface UnrecordedRefusal {
  auditId: string;
  at: number;
  code: string | null;
  unresolvedFact: string | null;
}

function parsePlacement(raw: unknown): Placement | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const p = raw as Record<string, unknown>;
  const createdAt = isoMs(p.createdAt);
  if (!str(p.id) || !str(p.workloadKind) || !isClass(p.requiredClass) || !str(p.requiredBy) || createdAt === null) return null;
  if (typeof p.outcome !== "string" || !(OUTCOMES as readonly string[]).includes(p.outcome)) return null;
  const opt = (v: unknown) => (typeof v === "string" && v.length > 0 && v.length <= 512 ? v : null);
  // a refusal or a mismatch names its code; a placement names the class it ran under
  if ((p.outcome === "refused" || p.outcome === "mismatch") && !opt(p.refusalCode)) return null;
  if ((p.outcome === "placed" || p.outcome === "offered") && !opt(p.appliedClass)) return null;
  return {
    id: p.id,
    workloadKind: p.workloadKind,
    requiredClass: p.requiredClass,
    requiredBy: p.requiredBy,
    outcome: p.outcome as Placement["outcome"],
    refusalCode: opt(p.refusalCode),
    appliedClass: opt(p.appliedClass),
    executorName: opt(p.executorName),
    profileName: opt(p.profileName),
    profileVersion: posInt(p.profileVersion) ? p.profileVersion : null,
    createdAt,
  };
}

/** N11: a keyset cursor the gateway emitted; anything else ends that list's paging */
const cursorOf = (v: unknown): string | null => (typeof v === "string" && v.length > 0 && v.length <= 256 ? v : null);

/** `{placements, refusalsWithoutPlacement}` and each list's next-page cursor; null when the envelope is malformed */
export function parsePlacements(value: unknown): {
  placements: Array<Placement | { unreadable: true; index: number }>;
  unrecorded: Array<UnrecordedRefusal | { unreadable: true; index: number }>;
  nextCursor: string | null;
  refusalsNextCursor: string | null;
} | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.placements) || !Array.isArray(v.refusalsWithoutPlacement)) return null;
  return {
    placements: v.placements.map((row, index) => parsePlacement(row) ?? { unreadable: true as const, index }),
    unrecorded: v.refusalsWithoutPlacement.map((row, index) => {
      const r = (row ?? {}) as Record<string, unknown>;
      const at = isoMs(r.at);
      if (!str(r.auditId) || at === null) return { unreadable: true as const, index };
      return { auditId: r.auditId, at, code: typeof r.code === "string" ? r.code : null, unresolvedFact: typeof r.unresolvedFact === "string" ? r.unresolvedFact : null };
    }),
    nextCursor: cursorOf(v.nextCursor),
    refusalsNextCursor: cursorOf(v.refusalsNextCursor),
  };
}

/** N11: the next page of `GET /v1/execution-placements` continues only the lists that have a cursor */
export function placementsPageUrl(page: { cursor: string | null; refusalsCursor: string | null } | null): string {
  const q = new URLSearchParams({ limit: "50" });
  if (page?.cursor) q.set("cursor", page.cursor);
  if (page?.refusalsCursor) q.set("refusalsCursor", page.refusalsCursor);
  return `/v1/execution-placements?${q.toString()}`;
}

/**
 * `GET /v1/execution-placements/:placementId`: the decision with the audit row it was recorded under; null when
 * unreadable. `report` tells apart no report (a null hash: nothing was started) from a hash that is there but is
 * not a SHA-256, which is never shown as "none". `attestationStrength` is the gateway's own word for the evidence,
 * null when it is missing or not one this build knows.
 */
export function parsePlacementDetail(value: unknown): {
  id: string;
  auditId: string | null;
  auditRuleId: string | null;
  auditReason: string | null;
  report: { kind: "none" } | { kind: "hash"; sha256: string } | { kind: "unreadable" };
  attestationStrength: AttestationStrength | null;
} | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (!str(v.id)) return null;
  const audit = v.audit !== null && typeof v.audit === "object" && !Array.isArray(v.audit) ? (v.audit as Record<string, unknown>) : null;
  const text = (x: unknown) => (typeof x === "string" && x.length > 0 && x.length <= 4096 ? x : null);
  return {
    id: v.id,
    auditId: audit ? text(audit.id) : null,
    auditRuleId: audit ? text(audit.ruleId) : null,
    auditReason: audit ? text(audit.reason) : null,
    report:
      v.reportSha256 === null
        ? { kind: "none" }
        : typeof v.reportSha256 === "string" && /^[0-9a-f]{64}$/.test(v.reportSha256)
          ? { kind: "hash", sha256: v.reportSha256 }
          : { kind: "unreadable" },
    attestationStrength: oneOfStrength(v.attestationStrength),
  };
}

/** contract `ATTESTATION_STRENGTH` (mirrored; pinned by isolationPlacementModel.test.ts): the only strength a report has today */
export const ATTESTATION_STRENGTHS = ["software_attested"] as const;
export type AttestationStrength = (typeof ATTESTATION_STRENGTHS)[number];
const oneOfStrength = (x: unknown): AttestationStrength | null => ((ATTESTATION_STRENGTHS as readonly unknown[]).includes(x) ? (x as AttestationStrength) : null);
/** an attestation strength in words; null (missing or unknown) is said, never assumed */
export const strengthText = (s: AttestationStrength | null): string => (s === "software_attested" ? "software-attested" : "attestation strength not reported");

/** a refusal code in words: decision 7's reasons, or the mismatch */
export const refusalText = (code: string | null): string =>
  code === "execution_profile_mismatch" ? MISMATCH_TEXT : code && Object.hasOwn(REFUSAL_TEXT, code) ? REFUSAL_TEXT[code as RefusalReason] : "Reason not reported.";

// ---------------------------------------------------------------------------
// executor lifecycle (I3): detail, attestation history, and the admin acts
// ---------------------------------------------------------------------------

/** one row of `GET /v1/executors/:executorId/attestations` (newest first, at most 100) */
export interface AttestationRecord {
  id: string;
  profileDigest: string;
  isolationClass: string;
  verdict: "pass" | "fail";
  reportSha256: string;
  observedAt: number;
  expiresAt: number;
}

function parseAttestationRecord(raw: unknown): AttestationRecord | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const a = raw as Record<string, unknown>;
  const observedAt = isoMs(a.observedAt);
  const expiresAt = isoMs(a.expiresAt);
  if (!str(a.id) || !str(a.profileDigest) || !str(a.class) || !str(a.reportSha256) || observedAt === null || expiresAt === null) return null;
  if (a.verdict !== "pass" && a.verdict !== "fail") return null;
  return { id: a.id, profileDigest: a.profileDigest, isolationClass: a.class, verdict: a.verdict, reportSha256: a.reportSha256, observedAt, expiresAt };
}

/** `{attestations: [...]}`; null when the envelope is malformed. An unreadable row is kept as unreadable, never dropped. */
export function parseAttestationHistory(value: unknown): Array<AttestationRecord | { unreadable: true; index: number }> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value) || !Object.hasOwn(value, "attestations")) return null;
  const list = (value as { attestations: unknown }).attestations;
  if (!Array.isArray(list)) return null;
  return list.map((row, index) => parseAttestationRecord(row) ?? { unreadable: true as const, index });
}

/**
 * A pass counts only for a class the executor's backend can attest, and only
 * until it expires; the device clock may only take assurance away.
 */
export function attestationRecordText(r: AttestationRecord, backend: Backend, now: number): { label: string; tone: Tone } {
  if (r.verdict === "fail") return { label: "Failed", tone: "danger" };
  if (!BACKEND_CLASSES[backend].includes(r.isolationClass)) return { label: "Not evidence for this backend", tone: "neutral" };
  return r.expiresAt > now ? { label: "Passed", tone: "ok" } : { label: "Passed, expired", tone: "neutral" };
}

export type ExecutorAct = "quarantine" | "reenable" | "revoke" | "declared_class";

/**
 * What an admin may do to this executor now, and why not otherwise. Mirrors
 * the gateway's checks so a control is never offered that it would refuse;
 * the gateway re-checks every one.
 */
export function executorActs(e: Pick<Executor, "status" | "backend">): Record<ExecutorAct, { ok: true } | { ok: false; reason: string }> {
  const revoked = { ok: false as const, reason: "This executor is revoked. That is terminal: a new executor needs a new identity and key." };
  return {
    quarantine:
      e.status === "active"
        ? { ok: true }
        : e.status === "quarantined"
          ? { ok: false, reason: "Already quarantined: it places nothing until re-enabled." }
          : revoked,
    reenable:
      e.status === "quarantined"
        ? { ok: true }
        : e.status === "active"
          ? { ok: false, reason: "Only a quarantined executor can be re-enabled." }
          : revoked,
    revoke: e.status === "revoked" ? revoked : { ok: true },
    declared_class:
      e.backend !== "customer"
        ? { ok: false, reason: "Only a customer plane maps its declared isolation to a class. Other backends prove their class by self-test." }
        : e.status === "revoked"
          ? revoked
          : { ok: true },
  };
}

/** `PUT /v1/executors/:executorId/declared-class`: a class, or null to unmap (the strict default) */
export function declaredClassBody(value: string): { class: IsolationClass | null } | null {
  if (value === "") return { class: null };
  return isClass(value) ? { class: value } : null;
}

/** the executor routes' refusal codes, in words (pinned to isolation-routes.ts by the test) */
export const EXECUTOR_REFUSALS: Readonly<Record<string, string>> = {
  invalid_executor_id: "That executor id could not be read. Refresh the list.",
  executor_not_found: "That executor no longer exists. Refresh the list.",
  executor_revoked: "This executor is revoked. Nothing can change it now.",
  executor_already_quarantined: "This executor is already quarantined. Refresh to see its current state.",
  executor_not_quarantined: "This executor is not quarantined, so there is nothing to re-enable. Refresh to see its current state.",
  executor_already_revoked: "This executor is already revoked.",
  not_a_customer_plane: "Only a customer plane maps its declared isolation to a class.",
};

export function executorRefusal(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  const code = error.payload.error;
  return typeof code === "string" && Object.hasOwn(EXECUTOR_REFUSALS, code) ? EXECUTOR_REFUSALS[code]! : null;
}

// ---------------------------------------------------------------------------
// owner decision C: a person's own stdio call, `GET /v1/execution-person-stdio-relaxations` and
// `PUT /v1/execution-person-stdio-relaxations/:scopeKind/:scopeId` (built)
// ---------------------------------------------------------------------------

/** where the relaxation is set (mirrors `PERSON_STDIO_RELAXATION_SCOPES`): never org-wide */
export const PERSON_STDIO_SCOPES = ["mcp_server", "project"] as const;
export type PersonStdioScope = (typeof PERSON_STDIO_SCOPES)[number];

export interface PersonStdioRelaxation {
  id: string;
  scopeKind: PersonStdioScope;
  scopeId: string;
  scopeName: string | null;
  createdAt: number;
}

/**
 * The active relaxations. The answer must say it lowers L3 to L2 and nothing else (owner decision C); any other
 * shape, or a row that cannot be read, makes the whole list unmeasured (null), never "none relaxed".
 */
export function parsePersonStdioRelaxations(value: unknown): PersonStdioRelaxation[] | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (v.default !== "microvm" || v.relaxedTo !== "user_space_kernel" || !Array.isArray(v.relaxations)) return null;
  const out: PersonStdioRelaxation[] = [];
  for (const raw of v.relaxations) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
    const r = raw as Record<string, unknown>;
    const createdAt = isoMs(r.createdAt);
    if (!str(r.id) || !str(r.scopeId) || createdAt === null) return null;
    if (typeof r.scopeKind !== "string" || !(PERSON_STDIO_SCOPES as readonly string[]).includes(r.scopeKind)) return null;
    if (r.from !== "microvm" || r.to !== "user_space_kernel") return null;
    if (r.scopeName !== null && !str(r.scopeName)) return null;
    out.push({ id: r.id, scopeKind: r.scopeKind as PersonStdioScope, scopeId: r.scopeId, scopeName: r.scopeName as string | null, createdAt });
  }
  return out;
}

/** the relaxation in force for one scope: undefined when the list is unmeasured, null when none */
export function relaxationFor(list: PersonStdioRelaxation[] | null, scopeKind: PersonStdioScope, scopeId: string): PersonStdioRelaxation | null | undefined {
  if (list === null) return undefined;
  return list.find((r) => r.scopeKind === scopeKind && r.scopeId === scopeId) ?? null;
}

// ---------------------------------------------------------------------------
// owner decision D: the admin-set project sensitivity, `GET /v1/execution-project-sensitivities` and
// `PUT /v1/execution-project-sensitivities/:projectId` (built)
// ---------------------------------------------------------------------------

/** mirrors `PLACEMENT_SENSITIVITIES`, least to most strict */
export const SENSITIVITIES = ["public", "internal", "confidential", "regulated"] as const;
export type Sensitivity = (typeof SENSITIVITIES)[number];
export const SENSITIVITY_LABEL: Readonly<Record<Sensitivity, string>> = {
  public: "Public",
  internal: "Internal",
  confidential: "Confidential",
  regulated: "Regulated",
};
const isSensitivity = (v: unknown): v is Sensitivity => typeof v === "string" && (SENSITIVITIES as readonly string[]).includes(v);

export interface ProjectSensitivity {
  projectId: string;
  name: string;
  useCaseCount: number;
  useCaseSensitivity: Sensitivity | null;
  adminSensitivity: Sensitivity | null;
  /** null = the fact does not resolve: isolable calls in this project are refused (policy unresolved) */
  effectiveSensitivity: Sensitivity | null;
  personStdioRelaxationId: string | null;
}

function parseProjectSensitivity(raw: unknown): ProjectSensitivity | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const p = raw as Record<string, unknown>;
  if (!str(p.projectId) || !str(p.name) || typeof p.useCaseCount !== "number" || !Number.isInteger(p.useCaseCount) || p.useCaseCount < 0) return null;
  const opt = (v: unknown): Sensitivity | null | false => (v === null ? null : isSensitivity(v) ? v : false);
  const uc = opt(p.useCaseSensitivity);
  const admin = opt(p.adminSensitivity);
  const eff = opt(p.effectiveSensitivity);
  if (uc === false || admin === false || eff === false) return null;
  if (p.personStdioRelaxationId !== null && !str(p.personStdioRelaxationId)) return null;
  return {
    projectId: p.projectId,
    name: p.name,
    useCaseCount: p.useCaseCount,
    useCaseSensitivity: uc,
    adminSensitivity: admin,
    effectiveSensitivity: eff,
    personStdioRelaxationId: p.personStdioRelaxationId as string | null,
  };
}

/** every project, or null when the answer cannot be read (unmeasured, never an empty list) */
export function parseProjectSensitivities(value: unknown): ProjectSensitivity[] | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const list = (value as { projects?: unknown }).projects;
  if (!Array.isArray(list)) return null;
  const out: ProjectSensitivity[] = [];
  for (const raw of list) {
    const p = parseProjectSensitivity(raw);
    if (!p) return null;
    out.push(p);
  }
  return out;
}

/** the PUT body for a select value: "" clears the field (null) */
export function projectSensitivityBody(value: string): { sensitivity: Sensitivity | null } | null {
  if (value === "") return { sensitivity: null };
  return isSensitivity(value) ? { sensitivity: value } : null;
}

/** does the admin field raise the project above its use cases? (owner decision D: below them it has no effect) */
export function adminFieldRaises(p: Pick<ProjectSensitivity, "useCaseSensitivity" | "adminSensitivity">): boolean {
  if (p.adminSensitivity === null) return false;
  if (p.useCaseSensitivity === null) return true;
  return SENSITIVITIES.indexOf(p.adminSensitivity) > SENSITIVITIES.indexOf(p.useCaseSensitivity);
}

/** the owner decision C and D routes' refusal codes, in words (pinned to isolation-subject-routes.ts by the test) */
export const SUBJECT_REFUSALS: Readonly<Record<string, string>> = {
  invalid_scope: "That server or project could not be read. Refresh the page.",
  scope_not_found: "That server or project no longer exists. Refresh the page.",
  not_a_stdio_server: "Only a local (stdio) MCP server has an isolation floor to relax.",
  invalid_project_id: "That project id could not be read. Refresh the list.",
  project_not_found: "That project no longer exists. Refresh the list.",
  changed_concurrently: "This changed while your request was being checked, so nothing was saved. Reload and try again.",
};

export function subjectRefusal(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  const code = error.payload.error;
  return typeof code === "string" && Object.hasOwn(SUBJECT_REFUSALS, code) ? SUBJECT_REFUSALS[code]! : null;
}
