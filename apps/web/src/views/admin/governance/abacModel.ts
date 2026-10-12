/**
 * ADR-0040 — the pure half of the ABAC editor: turning the "new version" and
 * "simulate a request" forms into exactly the bodies
 * `POST /v1/abac/policies/:id/versions` and `POST /v1/abac/simulate` accept
 * (apps/gateway/src/abac.ts `versionBodySchema` / `simulateSchema`), and the
 * refusals those routes return, as sentences.
 */
import type { AbacPolicySummary, AbacPolicyVersion } from "../../../api/adminTypes";
import type { RefusalSentences } from "./refusalCopy";

/** the gateway's bounds (abac.ts versionBodySchema) */
export const ABAC_LIMITS = { sourceMax: 20_000, timezoneMax: 64, testCasesMax: 100 } as const;

export type AbacMode = "forbid" | "require_approval";

export interface VersionForm {
  source: string;
  mode: AbacMode;
  timezone: string;
  approverUserId: string;
  /** JSON array text, or blank for no stored tests */
  testCases: string;
}

/** the editor opens on the newest version, so an edit is a change to what is there */
export function versionFormFrom(versions: readonly AbacPolicyVersion[], policy?: AbacPolicySummary | null): VersionForm {
  const newest = [...versions].sort((x, y) => y.version - x.version)[0];
  if (newest) {
    return {
      source: newest.source,
      mode: newest.mode,
      timezone: newest.timezone,
      approverUserId: newest.approverUserId ?? "",
      testCases: newest.testCases && newest.testCases.length ? JSON.stringify(newest.testCases, null, 2) : "",
    };
  }
  return {
    source: policy?.source ?? "",
    mode: policy?.mode ?? "forbid",
    timezone: policy?.timezone ?? "UTC",
    approverUserId: policy?.approverUserId ?? "",
    testCases: "",
  };
}

export type Built<T> = { ok: true; body: T } | { ok: false; problem: string };

export interface VersionBody {
  source: string;
  mode: AbacMode;
  timezone: string;
  approverUserId: string | null;
  testCases?: Array<Record<string, unknown>>;
}

export function versionBody(form: VersionForm): Built<VersionBody> {
  const source = form.source.trim();
  if (!source) return { ok: false, problem: "The Cedar policy is empty. A version must say what it forbids." };
  if (source.length > ABAC_LIMITS.sourceMax) {
    return { ok: false, problem: `The policy is ${source.length} characters; the limit is ${ABAC_LIMITS.sourceMax}.` };
  }
  const timezone = form.timezone.trim();
  if (!timezone) return { ok: false, problem: "Name the timezone the policy reads times in (for example UTC)." };
  if (timezone.length > ABAC_LIMITS.timezoneMax) return { ok: false, problem: "The timezone name is too long." };
  if (form.mode === "require_approval" && !form.approverUserId) {
    return { ok: false, problem: "A pause-for-approval version must name who signs off." };
  }
  const body: VersionBody = {
    source,
    mode: form.mode,
    timezone,
    approverUserId: form.mode === "require_approval" ? form.approverUserId : null,
  };
  const raw = form.testCases.trim();
  if (raw) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ok: false, problem: "The test cases are not valid JSON. Give an array of cases, or leave the box empty." };
    }
    if (!Array.isArray(parsed)) return { ok: false, problem: "The test cases must be a JSON array of cases." };
    if (parsed.length > ABAC_LIMITS.testCasesMax) {
      return { ok: false, problem: `At most ${ABAC_LIMITS.testCasesMax} test cases per version.` };
    }
    const bad = parsed.findIndex((c) => c === null || typeof c !== "object" || Array.isArray(c));
    if (bad !== -1) return { ok: false, problem: `Test case ${bad + 1} is not an object.` };
    body.testCases = parsed as Array<Record<string, unknown>>;
  }
  return { ok: true, body };
}

export interface SimulateForm {
  userId: string;
  serverId: string;
  toolName: string;
  projectId: string;
  /** a `<input type="datetime-local">` value, read in the browser's zone; blank = now */
  at: string;
  sessionOrigin: string;
  /** "" = not stated, "yes" / "no" */
  mfa: "" | "yes" | "no";
}

export const EMPTY_SIMULATE_FORM: SimulateForm = {
  userId: "",
  serverId: "",
  toolName: "",
  projectId: "",
  at: "",
  sessionOrigin: "",
  mfa: "",
};

export interface SimulateBody {
  userId: string;
  serverId: string;
  toolName: string;
  projectId?: string;
  at?: string;
  sessionOrigin?: string;
  mfaCompleted?: boolean;
}

export function simulateBody(form: SimulateForm): Built<SimulateBody> {
  if (!form.userId) return { ok: false, problem: "Choose the user the request would be made as." };
  if (!form.serverId) return { ok: false, problem: "Choose the MCP server." };
  if (!form.toolName) return { ok: false, problem: "Choose the tool." };
  const body: SimulateBody = { userId: form.userId, serverId: form.serverId, toolName: form.toolName };
  if (form.projectId) body.projectId = form.projectId;
  if (form.at.trim()) {
    const when = new Date(form.at);
    if (Number.isNaN(when.getTime())) return { ok: false, problem: "The hypothetical time is not a date and time." };
    body.at = when.toISOString();
  }
  if (form.sessionOrigin.trim()) body.sessionOrigin = form.sessionOrigin.trim();
  if (form.mfa) body.mfaCompleted = form.mfa === "yes";
  return { ok: true, body };
}

export interface AbacSimulation {
  attributes: Record<string, unknown>;
  activePolicies: Array<{ id: string; name: string; mode: AbacMode; version: number; timezone: string }>;
  abacDecision: {
    effect: "permit" | "forbid" | "require_approval";
    policyName?: string | null;
    policyVersion?: number | null;
    matchedPolicyIds?: string[];
    approverName?: string | null;
    approverUserId?: string | null;
    reason?: string | null;
  } | null;
  note: string;
}

/** what the ABAC layer said, in words — a `permit` is never an allow */
export function simulationSentence(sim: AbacSimulation): string {
  const d = sim.abacDecision;
  if (!d) return "No ABAC policy is active, so the ABAC layer adds nothing: the entitlement model alone decides this call.";
  const which = d.policyName ? `'${d.policyName}'${d.policyVersion ? ` v${d.policyVersion}` : ""}` : "an active policy";
  if (d.effect === "forbid") return `Denied by ${which}. The call would be refused even if the user holds a grant for it.`;
  if (d.effect === "require_approval") {
    return `Paused by ${which} for approval${d.approverName || d.approverUserId ? ` by ${d.approverName ?? d.approverUserId}` : ""}.`;
  }
  return "No active policy forbids this. That is not an allow: the user's grants still decide whether the call is permitted at all.";
}

export interface AbacSuiteRun {
  policies: Array<{
    policyId: string;
    name: string;
    version: number;
    passed: number;
    failed: number;
    results: Array<{ name: string; expected: string; actual: string; passed: boolean }>;
  }>;
  passed: number;
  failed: number;
}

export const ABAC_REFUSALS: RefusalSentences = {
  invalid_policy: "The policy did not validate against the attribute schema, so nothing was stored.",
  invalid_timezone: "That timezone is not one this deployment can resolve. Use an IANA name such as UTC or Europe/London.",
  approver_required: "A pause-for-approval version must name the approver its paused calls go to.",
  unknown_policy: "This policy no longer exists. Reload the list.",
  unknown_tool: "That server has no tool with this name. Reload the tool list and choose again.",
  blast_radius_not_previewed:
    "This deployment requires a blast-radius preview of this exact version before it is activated. Run one under Simulation, then activate.",
};

/** the 422 `invalid_policy` body carries the validator's own errors */
export function validationErrorsOf(payload: Record<string, unknown> | null | undefined): Array<{ message: string; help?: string | null }> {
  const errors = payload?.errors;
  if (!Array.isArray(errors)) return [];
  return errors
    .filter((e): e is { message: string; help?: string | null } => typeof e === "object" && e !== null && typeof (e as { message?: unknown }).message === "string")
    .map((e) => ({ message: e.message, help: e.help ?? null }));
}
