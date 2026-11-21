/**
 * ADR-0315 slice 2 (E3, #1117): the rules behind the "Issued credentials" tab on the Agent credentials page.
 *
 *  - `IssuedCredential` is one row of `GET /v1/agent-credentials/issued` (ADR-0226 list contract).
 *  - `issuedFilters` turns the tab's filter controls into the route's own filters. A grant id is sent only once it is a
 *    whole uuid, because the route refuses anything else.
 *  - `revokeReducer` is the revoke flow's one declared state machine (owner rule 12): closed → asking → revoking, and
 *    back. `REVOKE_NEXT` lists the allowed moves; any other event leaves the state as it is.
 */

export const ISSUED_STATES = ["issued", "revoked"] as const;
export type IssuedState = (typeof ISSUED_STATES)[number];

export interface IssuedCredential {
  jti: string;
  audienceId: string;
  grantId: string;
  statusIndex: number;
  /** the stored revocation only: a grant revoked, an agent halted or the kill switch also stop a credential working */
  state: IssuedState;
  expired: boolean;
  issuedAt: string;
  expiresAt: string;
  revokedAt: string | null;
}

/** the reason the revoke route takes: 1 to 500 characters */
export const REASON_MAX = 500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** what a typed grant id says, or null when it can be sent (empty means "any grant") */
export function grantProblem(text: string): string | null {
  const t = text.trim();
  return t === "" || UUID.test(t) ? null : "Paste the grant's whole id, for example 3f2b…-…; partial ids are not searched.";
}

export function reasonProblem(text: string): string | null {
  const t = text.trim();
  if (t.length === 0) return "Say why it is revoked. The reason is kept in the audit trail.";
  if (t.length > REASON_MAX) return `Keep the reason to ${REASON_MAX} characters (it is ${t.length}).`;
  return null;
}

export interface IssuedFilterDraft {
  audienceId: string;
  state: "" | IssuedState;
  grantId: string;
}
export const NO_FILTERS: IssuedFilterDraft = Object.freeze({ audienceId: "", state: "issued", grantId: "" }) as IssuedFilterDraft;

/** the route's filters for a draft: only what is set, and a grant id only when it is a whole uuid */
export function issuedFilters(d: IssuedFilterDraft): Record<string, string> {
  const out: Record<string, string> = {};
  if (d.audienceId) out.audienceId = d.audienceId;
  if (d.state) out.state = d.state;
  const g = d.grantId.trim();
  if (g && grantProblem(g) === null) out.grantId = g.toLowerCase();
  return out;
}

/** the state words a row shows: the stored state, and whether it has run out */
export function stateWords(c: IssuedCredential): { label: string; tone: "ok" | "neutral" | "warn" } {
  if (c.state === "revoked") return { label: "Revoked", tone: "neutral" };
  if (c.expired) return { label: "Expired", tone: "neutral" };
  return { label: "Issued", tone: "ok" };
}

/** why a row's Revoke is not offered, or null when it is */
export function revokeBlockedReason(c: IssuedCredential, flow: RevokeFlow): string | null {
  if (c.state === "revoked") return "Already revoked.";
  if (flow.kind === "revoking") return "Revoking another credential; wait for it to finish.";
  return null;
}

/** the jti shortened for a sentence (the full one stays in the table and the export) */
export const shortJti = (jti: string) => (jti.length > 14 ? `${jti.slice(0, 6)}…${jti.slice(-6)}` : jti);

// ---- the revoke flow (owner rule 12) -----------------------------------------

export type RevokeFlow =
  | { kind: "closed" }
  | { kind: "asking"; jti: string; reason: string; tried: boolean }
  | { kind: "revoking"; jti: string; reason: string };

export type RevokeEvent =
  | { type: "open"; jti: string }
  | { type: "type"; reason: string }
  | { type: "submit" }
  | { type: "cancel" }
  | { type: "done" }
  | { type: "failed" };

/** the moves each state allows; the reducer ignores every other event */
export const REVOKE_NEXT: Readonly<Record<RevokeFlow["kind"], readonly RevokeEvent["type"][]>> = Object.freeze({
  closed: ["open"],
  asking: ["type", "submit", "cancel"],
  revoking: ["done", "failed"],
});

export const REVOKE_CLOSED: RevokeFlow = Object.freeze({ kind: "closed" }) as RevokeFlow;

export function revokeReducer(s: RevokeFlow, e: RevokeEvent): RevokeFlow {
  if (!REVOKE_NEXT[s.kind].includes(e.type)) return s;
  switch (e.type) {
    case "open":
      return { kind: "asking", jti: e.jti, reason: "", tried: false };
    case "type":
      return s.kind === "asking" ? { ...s, reason: e.reason } : s;
    case "submit":
      if (s.kind !== "asking") return s;
      return reasonProblem(s.reason) === null ? { kind: "revoking", jti: s.jti, reason: s.reason.trim() } : { ...s, tried: true };
    case "cancel":
    case "done":
      return REVOKE_CLOSED;
    case "failed":
      // the dialog stays open with the reason kept, so the admin can retry or cancel
      return s.kind === "revoking" ? { kind: "asking", jti: s.jti, reason: s.reason, tried: false } : s;
  }
}

/** the refusal the route gives in words: 404 means unknown or already revoked */
export const REVOKE_REFUSALS: Readonly<Record<string, string>> = Object.freeze({
  unknown_credential: "That credential is already revoked or no longer exists. The list has been refreshed.",
});
