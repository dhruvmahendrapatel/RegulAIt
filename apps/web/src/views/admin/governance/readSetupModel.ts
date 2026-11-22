/**
 * A SaaS entitlement source's guided read setup (ADR-0337 §4a and §5a; owner decision D-2026-11-22-06): the shape of
 * `GET /v1/discovery/entitlements/sources/:sourceId/read-setup`, its normaliser, and the screen's one declared state
 * machine (owner rule 12), `readSetupReducer`.
 *
 * Microsoft 365: the Entra activity-log read is off by default. Once a source asks for it, the screen says "not
 * checked" until a read has looked, then whatever that read saw. Only `flowing` is connected. Salesforce: what the
 * least-privilege read sees and cannot see, and the org-wide token opt-in, which needs two keys (the audited org switch
 * and the source's own request). A response without this shape is a failed read, never an empty one.
 */
import { stepUpRefusalOf } from "../../../stepup/stepUp";

export const READ_SETUP_KINDS: ReadonlySet<string> = new Set(["entitlement_m365", "entitlement_salesforce"]);

export const ACTIVITY_STATES = ["off", "not_checked", "not_enabled", "unreadable", "no_activity_yet", "flowing"] as const;
export type ActivityState = (typeof ACTIVITY_STATES)[number];

export interface LastRead {
  coverage: "none" | "app" | "verb";
  note: string;
  recordedAt: string;
}

export interface SetupStep {
  id: string;
  title: string;
  detail: string;
}

export interface M365Setup {
  platform: "m365";
  sourceId: string;
  activityLogs: {
    requested: boolean;
    state: ActivityState;
    permission: string;
    permissionType: string;
    license: string;
    steps: SetupStep[];
    /** only ever an admin-consent URL on Microsoft's sign-in host; anything else is dropped to null */
    consentUrl: string | null;
  };
  lastRead: LastRead | null;
}

export interface SalesforceSetup {
  platform: "salesforce";
  sourceId: string;
  orgTokens: { requested: boolean; allowed: boolean; permission: string; tradeOff: string };
  sees: string[];
  cannotSee: string[];
  lastRead: LastRead | null;
}

export type ReadSetup = M365Setup | SalesforceSetup;

class Malformed extends Error {
  constructor(what: string) {
    super(`The server's answer was not in the expected form (${what}).`);
    this.name = "MalformedResponse";
  }
}
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
function obj(x: unknown, what: string): Record<string, unknown> {
  if (!isObj(x)) throw new Malformed(what);
  return x;
}
function str(x: unknown, what: string): string {
  if (typeof x !== "string") throw new Malformed(what);
  return x;
}
function bool(x: unknown, what: string): boolean {
  if (typeof x !== "boolean") throw new Malformed(what);
  return x;
}
function strs(x: unknown, what: string): string[] {
  if (!Array.isArray(x)) throw new Malformed(what);
  return x.map((s) => str(s, what));
}

const CONSENT_PREFIX = "https://login.microsoftonline.com/";

/** the consent link is shown only as an https URL on Microsoft's sign-in host; the gateway builds it from GUIDs */
export function safeConsentUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.startsWith(CONSENT_PREFIX)) return null;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && u.hostname === "login.microsoftonline.com" ? u.toString() : null;
  } catch {
    return null;
  }
}

function lastReadOf(x: unknown): LastRead | null {
  if (x === null) return null;
  const r = obj(x, "lastRead");
  const coverage = r.coverage;
  if (coverage !== "none" && coverage !== "app" && coverage !== "verb") throw new Malformed("lastRead.coverage");
  return { coverage, note: str(r.note, "lastRead.note"), recordedAt: str(r.recordedAt, "lastRead.recordedAt") };
}

export function normaliseReadSetup(raw: unknown): ReadSetup {
  const r = obj(raw, "read setup");
  const sourceId = str(r.sourceId, "sourceId");
  if (r.platform === "m365") {
    const a = obj(r.activityLogs, "activityLogs");
    if (!ACTIVITY_STATES.includes(a.state as ActivityState)) throw new Malformed("activityLogs.state");
    if (!Array.isArray(a.steps)) throw new Malformed("activityLogs.steps");
    return {
      platform: "m365",
      sourceId,
      activityLogs: {
        requested: bool(a.requested, "activityLogs.requested"),
        state: a.state as ActivityState,
        permission: str(a.permission, "permission"),
        permissionType: str(a.permissionType, "permissionType"),
        license: str(a.license, "license"),
        steps: a.steps.map((s0) => {
          const s = obj(s0, "step");
          return { id: str(s.id, "step.id"), title: str(s.title, "step.title"), detail: str(s.detail, "step.detail") };
        }),
        consentUrl: a.consentUrl === null ? null : safeConsentUrl(str(a.consentUrl, "consentUrl")),
      },
      lastRead: lastReadOf(r.lastRead),
    };
  }
  if (r.platform === "salesforce") {
    const t = obj(r.orgTokens, "orgTokens");
    return {
      platform: "salesforce",
      sourceId,
      orgTokens: { requested: bool(t.requested, "orgTokens.requested"), allowed: bool(t.allowed, "orgTokens.allowed"), permission: str(t.permission, "permission"), tradeOff: str(t.tradeOff, "tradeOff") },
      sees: strs(r.sees, "sees"),
      cannotSee: strs(r.cannotSee, "cannotSee"),
      lastRead: lastReadOf(r.lastRead),
    };
  }
  throw new Malformed("platform");
}

/** each state in words: only `flowing` says connected */
export const ACTIVITY_COPY: Record<ActivityState, { label: string; tone: "neutral" | "warn" | "danger" | "info" | "ok"; detail: string }> = {
  off: { label: "Off", tone: "neutral", detail: "This source does not ask for the activity log. It is off by default; no app is judged unused." },
  not_checked: { label: "Not checked yet", tone: "neutral", detail: "This source asks for the activity log, but no read has looked since. Run the source to check." },
  not_enabled: { label: "Not enabled", tone: "warn", detail: "The last read could not use the activity log: the permission, consent or licence is not in place yet." },
  unreadable: { label: "Could not be read", tone: "danger", detail: "The last read reached the activity log but could not read it." },
  no_activity_yet: { label: "No activity yet", tone: "info", detail: "The last read reached the activity log, but no sign-ins have arrived yet. It is not connected until they do." },
  flowing: { label: "Connected", tone: "ok", detail: "The last read saw sign-in activity arriving." },
};

// ---- the screen's one reducer: one change at a time ------------------------

export type Change =
  | { kind: "activityLogs"; on: boolean }
  | { kind: "orgSwitch"; on: boolean }
  | { kind: "sourceTokens"; on: boolean };

export type Flow =
  | { phase: "idle" }
  | { phase: "confirming"; change: Change }
  | { phase: "submitting"; change: Change }
  | { phase: "stepping"; change: Change }
  | { phase: "done"; change: Change }
  | { phase: "failed"; change: Change; message: string }
  | { phase: "declined"; change: Change };

export type FlowEvent =
  | { type: "ask"; change: Change }
  | { type: "cancel" }
  | { type: "submit" }
  | { type: "stepUpRequested" }
  | { type: "succeeded" }
  | { type: "failed"; error: unknown; message: string }
  | { type: "dismiss" };

const busy = (f: Flow) => f.phase === "submitting" || f.phase === "stepping";

export function readSetupReducer(f: Flow, e: FlowEvent): Flow {
  switch (e.type) {
    case "ask":
      return busy(f) ? f : { phase: "confirming", change: e.change };
    case "cancel":
      return f.phase === "confirming" || f.phase === "failed" || f.phase === "declined" ? { phase: "idle" } : f;
    case "submit":
      return f.phase === "confirming" || f.phase === "failed" || f.phase === "declined" ? { phase: "submitting", change: f.change } : f;
    case "stepUpRequested":
      return f.phase === "submitting" ? { phase: "stepping", change: f.change } : f;
    case "succeeded":
      return busy(f) ? { phase: "done", change: f.change } : f;
    case "failed":
      if (!busy(f)) return f;
      return stepUpRefusalOf(e.error) ? { phase: "declined", change: f.change } : { phase: "failed", change: f.change, message: e.message };
    case "dismiss":
      return busy(f) ? f : { phase: "idle" };
  }
}

/** what a change does, in the confirm dialog's words */
export function changeCopy(c: Change, tradeOff?: string): { title: string; body: string; confirm: string; stepUp: boolean } {
  switch (c.kind) {
    case "activityLogs":
      return c.on
        ? { title: "Ask for the activity log", body: "This source's reads will also ask Microsoft Entra for its sign-in activity log, so unused grants can be judged. It widens what the source reads; on an enabled source you will be asked to confirm it's you.", confirm: "Ask for the activity log", stepUp: true }
        : { title: "Stop asking for the activity log", body: "Reads stop using the activity log, and no app is judged unused.", confirm: "Stop asking", stepUp: false };
    case "orgSwitch":
      return c.on
        ? { title: "Allow org-wide token reads", body: `Salesforce sources may then ask to read org-wide OAuth tokens. ${tradeOff ?? ""} This is audited, and you will be asked to confirm it's you.`.trim(), confirm: "Allow org-wide token reads", stepUp: true }
        : { title: "Stop allowing org-wide token reads", body: "No Salesforce source reads org-wide tokens any more.", confirm: "Stop allowing", stepUp: false };
    case "sourceTokens":
      return c.on
        ? { title: "Read org-wide tokens for this source", body: `${tradeOff ?? ""} On an enabled source you will be asked to confirm it's you.`.trim(), confirm: "Read org-wide tokens", stepUp: true }
        : { title: "Stop reading org-wide tokens", body: "This source goes back to the least-privilege read.", confirm: "Stop reading tokens", stepUp: false };
  }
}
