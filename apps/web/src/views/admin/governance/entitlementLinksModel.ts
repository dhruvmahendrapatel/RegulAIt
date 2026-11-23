/**
 * Apps and agents for one SaaS entitlement source (ADR-0337 §6; owner decision 2026-11-17): the vendor apps the source
 * holds with their agent link, and the vendor app identifiers declared for agents. The shapes of the six routes, their
 * normalisers, and the screen's one declared state machine (owner rule 12), `linksReducer`.
 *
 * The link states are the gateway's: `none`, `auto` (the vendor id exactly equals a declared identifier), `admin` (an
 * administrator linked it, which is the only way a partial or fuzzy match is ever linked) and `unlinked` (removed by
 * an administrator; it is not auto-linked again until an administrator links it). What may happen next is the row's
 * own `lifecycle.transitions`, so a refused action shows the server's reason instead of a guess. A response without
 * this shape is a failed read, never an empty list.
 */

export const LINK_STATES = ["none", "auto", "admin", "unlinked"] as const;
export type LinkState = (typeof LINK_STATES)[number];
export const PLATFORMS = ["m365", "google_workspace", "salesforce", "slack"] as const;
export type Platform = (typeof PLATFORMS)[number];
/** the discovery source kinds that hold SaaS entitlements, and the platform each reads */
export const SOURCE_PLATFORM: Readonly<Record<string, Platform>> = {
  entitlement_m365: "m365",
  entitlement_google_workspace: "google_workspace",
  entitlement_salesforce: "salesforce",
  entitlement_slack: "slack",
};
export const PAGE_SIZE = 50;
/** what the gateway accepts as a vendor app id: 1 to 255 printable ASCII characters, no spaces */
export const EXTERNAL_ID = /^[\x21-\x7e]{1,255}$/;

export interface Transition {
  event: "auto_link" | "link" | "unlink";
  allowed: boolean;
  reason: string | null;
}

export interface EntitlementApp {
  id: string;
  externalId: string;
  appKind: string;
  displayName: string | null;
  publisher: string | null;
  publisherVerified: boolean | null;
  agentId: string | null;
  agentLinkState: LinkState;
  lastSeenAt: string;
  grants: number;
  transitions: Transition[];
}

export interface AgentIdentifier {
  id: string;
  agentId: string;
  platform: Platform;
  externalId: string;
  createdAt: string;
}

export interface Page<T> {
  items: T[];
  nextAfter: string | null;
}

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
function strOrNull(x: unknown, what: string): string | null {
  return x === null || x === undefined ? null : str(x, what);
}
function list(x: unknown, what: string): unknown[] {
  if (!Array.isArray(x)) throw new Malformed(what);
  return x;
}

function transitionsOf(x: unknown): Transition[] {
  const l = obj(x, "lifecycle");
  return list(l.transitions, "lifecycle.transitions").map((t0) => {
    const t = obj(t0, "transition");
    const event = t.event;
    if (event !== "auto_link" && event !== "link" && event !== "unlink") throw new Malformed("transition.event");
    if (typeof t.allowed !== "boolean") throw new Malformed("transition.allowed");
    return { event, allowed: t.allowed, reason: strOrNull(t.reason, "transition.reason") };
  });
}

export function normaliseApps(raw: unknown): Page<EntitlementApp> {
  const r = obj(raw, "apps");
  return {
    nextAfter: strOrNull(r.nextAfter, "nextAfter"),
    items: list(r.items, "items").map((a0) => {
      const a = obj(a0, "app");
      if (!LINK_STATES.includes(a.agentLinkState as LinkState)) throw new Malformed("agentLinkState");
      if (typeof a.grants !== "number") throw new Malformed("grants");
      if (a.publisherVerified !== null && a.publisherVerified !== undefined && typeof a.publisherVerified !== "boolean") throw new Malformed("publisherVerified");
      return {
        id: str(a.id, "id"),
        externalId: str(a.externalId, "externalId"),
        appKind: str(a.appKind, "appKind"),
        displayName: strOrNull(a.displayName, "displayName"),
        publisher: strOrNull(a.publisher, "publisher"),
        publisherVerified: (a.publisherVerified as boolean | null | undefined) ?? null,
        agentId: strOrNull(a.agentId, "agentId"),
        agentLinkState: a.agentLinkState as LinkState,
        lastSeenAt: str(a.lastSeenAt, "lastSeenAt"),
        grants: a.grants,
        transitions: transitionsOf(a.lifecycle),
      };
    }),
  };
}

export function normaliseIdentifier(x: unknown): AgentIdentifier {
  const i = obj(x, "identifier");
  if (!PLATFORMS.includes(i.platform as Platform)) throw new Malformed("platform");
  return { id: str(i.id, "id"), agentId: str(i.agentId, "agentId"), platform: i.platform as Platform, externalId: str(i.externalId, "externalId"), createdAt: str(i.createdAt, "createdAt") };
}

export function normaliseIdentifiers(raw: unknown): Page<AgentIdentifier> {
  const r = obj(raw, "identifiers");
  return { nextAfter: strOrNull(r.nextAfter, "nextAfter"), items: list(r.items, "items").map(normaliseIdentifier) };
}

export function normaliseDeclared(raw: unknown): { identifier: AgentIdentifier; autoLinked: string[] } {
  const r = obj(raw, "declared");
  return { identifier: normaliseIdentifier(r.identifier), autoLinked: list(r.autoLinked, "autoLinked").map((a) => str(a, "autoLinked")) };
}

/** a transition the row allows, or why not (the server's words); a transition the row does not list is not offered */
export function can(app: EntitlementApp, event: Transition["event"]): { ok: true } | { ok: false; why: string } {
  const t = app.transitions.find((x) => x.event === event);
  if (!t) return { ok: false, why: "Not offered for this app." };
  return t.allowed ? { ok: true } : { ok: false, why: t.reason ?? "Not allowed in its current state." };
}

export const LINK_COPY: Record<LinkState, { label: string; tone: "neutral" | "info" | "ok" | "warn"; detail: string }> = {
  none: { label: "Not linked", tone: "neutral", detail: "No agent is linked to this app." },
  auto: { label: "Linked automatically", tone: "info", detail: "Its vendor app id exactly matches an identifier declared for the agent." },
  admin: { label: "Linked by an administrator", tone: "ok", detail: "An administrator linked it by hand." },
  unlinked: { label: "Unlinked", tone: "warn", detail: "An administrator removed the link. It is not linked automatically again until an administrator links it." },
};

// ---- the screen's one reducer: one change at a time ------------------------

export type Change =
  | { kind: "link"; app: EntitlementApp; agentId: string }
  | { kind: "unlink"; app: EntitlementApp }
  | { kind: "declare"; agentId: string; externalId: string }
  | { kind: "remove"; identifier: AgentIdentifier };

export type Flow =
  | { phase: "idle" }
  | { phase: "editing"; change: Change }
  | { phase: "submitting"; change: Change }
  | { phase: "done"; change: Change; autoLinked: number | null }
  | { phase: "failed"; change: Change; message: string };

export type FlowEvent =
  | { type: "open"; change: Change }
  | { type: "edit"; change: Change }
  | { type: "cancel" }
  | { type: "submit" }
  | { type: "succeeded"; autoLinked?: number }
  | { type: "failed"; message: string }
  | { type: "dismiss" };

/** why a change cannot be sent yet, in words; null when it can */
export function changeProblem(c: Change): string | null {
  if (c.kind === "link" && !c.agentId) return "Choose an agent.";
  if (c.kind === "declare") {
    if (!c.agentId) return "Choose an agent.";
    if (!c.externalId) return "Enter the vendor app id.";
    if (!EXTERNAL_ID.test(c.externalId)) return "The app id is 1 to 255 printable characters, with no spaces.";
  }
  return null;
}

export function linksReducer(f: Flow, e: FlowEvent): Flow {
  switch (e.type) {
    case "open":
      return f.phase === "submitting" ? f : { phase: "editing", change: e.change };
    case "edit":
      return f.phase === "editing" || f.phase === "failed" ? { phase: "editing", change: e.change } : f;
    case "cancel":
    case "dismiss":
      return f.phase === "submitting" || f.phase === "idle" ? f : { phase: "idle" };
    case "submit":
      if (f.phase !== "editing" && f.phase !== "failed") return f;
      return changeProblem(f.change) ? f : { phase: "submitting", change: f.change };
    case "succeeded":
      return f.phase === "submitting" ? { phase: "done", change: f.change, autoLinked: e.autoLinked ?? null } : f;
    case "failed":
      return f.phase === "submitting" ? { phase: "failed", change: f.change, message: e.message } : f;
  }
}

// ---- the whole screen's state: the change flow and the two lists' cursors -------

export type ListName = "apps" | "ids";
export interface ScreenState {
  flow: Flow;
  /** the `after` cursor of each page loaded so far, first page first (null is the first page) */
  cursors: Record<ListName, Array<string | null>>;
}
export type ScreenEvent = FlowEvent | { type: "more"; list: ListName; after: string };

export const initialScreen: ScreenState = { flow: { phase: "idle" }, cursors: { apps: [null], ids: [null] } };

export function screenReducer(s: ScreenState, e: ScreenEvent): ScreenState {
  if (e.type === "more") {
    const have = s.cursors[e.list];
    return have.includes(e.after) ? s : { ...s, cursors: { ...s.cursors, [e.list]: [...have, e.after] } };
  }
  const flow = linksReducer(s.flow, e);
  return flow === s.flow ? s : { ...s, flow };
}
