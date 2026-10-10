/**
 * ADR-0186 V, decision 32 — OUTBOUND CREDENTIAL AUDIENCE, enforced at dispatch.
 *
 * A `pipelock-secrets` rule may name the hosts its credential belongs to (a
 * GitHub token to GitHub, a cloud API key to that cloud). A governed call whose
 * CALLER-SUPPLIED content carries such a credential to any other host is
 * refused, before anything is sent: 403 `credential_audience_violation` on the
 * connector route, the same code in the MCP error's data on the MCP surfaces.
 *
 * What is scanned, and what is not (the owner's decision, 2026-10-10):
 *  - SCANNED: the caller's own content — tool and protocol arguments, connector
 *    `object` and `payload` — decoded to strings recursively (every string
 *    value and object key; a string carrying `%` escapes is also scanned
 *    percent-decoded). That is every caller-controlled URL, query and body
 *    surface these paths forward: the caller sets no upstream header and no
 *    upstream URL on either path.
 *  - NOT SCANNED, STRUCTURALLY: what the gateway adds itself — the connector
 *    credential it decrypts, the upstream URL and any credential in it. The
 *    scan takes the caller's content as its only input and runs before the
 *    adapter or transport is built, so an injected credential is never in the
 *    text. Nothing is exempted by matching on a value.
 *  - stdio MCP is out of scope: it has no host to have an audience.
 *
 * The audit row records the rule ids, a match count each and the destination
 * host, never the credential, a fragment of it or a hash of it.
 *
 * Performance: the decoded strings are joined once and scanned once per
 * destination with the vendored pack matcher (RE2, linear time, candidate
 * gates), so a gate-dense argument tree costs one linear pass, not one per
 * leaf. Joining can only add matches across a field boundary, which refuses
 * more, never less.
 */
import { auditLog, type Db } from "@regulait/db";
import { credentialAudienceViolations, type VendoredDetectionPack } from "@regulait/shared";
import { loadOrgSettings } from "./org-settings.js";

export const CREDENTIAL_AUDIENCE_RULE_ID = "credential-audience-violation";
export const CREDENTIAL_AUDIENCE_ERROR = "credential_audience_violation";

/** a destination no audience names: a credential bound for it is never permitted */
const UNRESOLVED_DESTINATION = "https://unresolved-destination.invalid/";

/**
 * Pack rules that match PERSONAL DATA, not a credential, and so have no
 * audience to violate. Personal data in a call's content is governed by the
 * §8.4 piiMode cascade (block / warn / log / redact per project, with the org
 * floor), which an org or project may set below block; refusing it here would
 * silently override that choice on every outbound call. The audit path still
 * redacts these shapes (audit-scrub.ts) and the DLP guardrail still counts them.
 */
export const NON_CREDENTIAL_RULES: ReadonlySet<string> = new Set(["pipelock.secrets.social_security_number"]);

export interface AudienceViolation {
  rule: string;
  count: number;
}

const percentDecoded = (s: string): string | null => {
  if (!s.includes("%")) return null;
  try {
    return decodeURIComponent(s);
  } catch {
    // a malformed escape elsewhere must not hide a well-formed one
    return s.replace(/%([0-9A-Fa-f]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
  }
};

/** Every string a caller supplied, decoded, joined once (iterative: no recursion depth limit to trip). */
export function callerSuppliedText(...values: unknown[]): string {
  const parts: string[] = [];
  const seen = new WeakSet<object>();
  const stack: unknown[] = [...values].reverse();
  const addString = (s: string) => {
    if (!s) return;
    parts.push(s);
    const decoded = percentDecoded(s);
    if (decoded !== null && decoded !== s) parts.push(decoded);
  };
  while (stack.length > 0) {
    const v = stack.pop();
    if (typeof v === "string") addString(v);
    else if (Array.isArray(v)) {
      if (seen.has(v)) continue;
      seen.add(v);
      for (let i = v.length - 1; i >= 0; i--) stack.push(v[i]);
    } else if (v !== null && typeof v === "object") {
      if (seen.has(v)) continue;
      seen.add(v);
      const entries = Object.entries(v as Record<string, unknown>);
      for (let i = entries.length - 1; i >= 0; i--) {
        stack.push(entries[i]![1]);
        stack.push(entries[i]![0]);
      }
    }
    // numbers, booleans and null carry no credential text
  }
  return parts.join("\n");
}

/**
 * The credentials in `text` that may not go to every one of `destinations`.
 * `[]` = nothing leaves the gateway (no outbound host), so nothing to refuse;
 * `null` = the destination cannot be named, so no audience exemption applies.
 * With several destinations a credential is permitted only if every one is in
 * its audience (the call may reach any of them).
 */
export function audienceViolations(
  text: string,
  destinations: readonly string[] | null,
  packs?: readonly VendoredDetectionPack[],
): AudienceViolation[] {
  if (!text) return [];
  const targets = destinations === null ? [UNRESOLVED_DESTINATION] : destinations;
  const merged = new Map<string, number>();
  for (const raw of targets) {
    let target = UNRESOLVED_DESTINATION;
    try {
      target = new URL(raw).href;
    } catch {
      // unparseable: no exemption
    }
    for (const hit of credentialAudienceViolations(text, target, { packs })) {
      if (NON_CREDENTIAL_RULES.has(hit.rule)) continue;
      merged.set(hit.rule, Math.max(merged.get(hit.rule) ?? 0, hit.count));
    }
  }
  return [...merged].map(([rule, count]) => ({ rule, count })).sort((a, b) => a.rule.localeCompare(b.rule));
}

/** the destination's host for the audit row (never userinfo, path or query) */
function auditHosts(destinations: readonly string[] | null): Array<string | null> {
  if (destinations === null) return [null];
  return destinations.map((d) => {
    try {
      return new URL(d).host;
    } catch {
      return null;
    }
  });
}

export interface AudienceRefusal {
  reason: string;
  violations: AudienceViolation[];
}

/**
 * The dispatch-time check. Returns null when the call may proceed (the org
 * setting is `off`, the secrets pack is off, or nothing matched outside its
 * audience); otherwise writes ONE deny audit row and returns the refusal.
 */
export async function refuseOutboundCredentialAudience(
  db: Db,
  input: {
    userId: string;
    surface: "mcp_tool" | "mcp_protocol" | "connector";
    /** the caller's content only: never anything the gateway adds */
    content: readonly unknown[];
    destinations: readonly string[] | null;
    projectId: string | null;
    /** the audit row's subject columns */
    subject: { serverId?: string; toolName?: string | null; objectType?: "connector"; objectId?: string };
    detail?: Record<string, unknown>;
  },
): Promise<AudienceRefusal | null> {
  if (input.destinations !== null && input.destinations.length === 0) return null;
  const settings = await loadOrgSettings(db);
  if (settings.outboundCredentialAudience !== "enforce") return null;
  const violations = audienceViolations(callerSuppliedText(...input.content), input.destinations, settings.vendoredDetectionPacks);
  if (violations.length === 0) return null;
  const hosts = auditHosts(input.destinations);
  const total = violations.reduce((n, v) => n + v.count, 0);
  const reason =
    `${CREDENTIAL_AUDIENCE_ERROR}: the call's own content carries ${total} credential match(es) ` +
    `(${violations.map((v) => v.rule).join(", ")}) whose service is not ` +
    `${hosts.length === 1 && hosts[0] ? `'${hosts[0]}'` : "every destination of this call"}; nothing was sent`;
  await db.insert(auditLog).values({
    userId: input.userId,
    ...(input.subject.serverId ? { serverId: input.subject.serverId } : {}),
    ...(input.subject.toolName !== undefined ? { toolName: input.subject.toolName } : {}),
    ...(input.subject.objectType ? { objectType: input.subject.objectType } : {}),
    ...(input.subject.objectId ? { objectId: input.subject.objectId } : {}),
    detail: {
      ...(input.detail ?? {}),
      phase: "credential-audience",
      surface: input.surface,
      // rule ids and counts only — never the credential, a fragment or a hash of it
      violations,
      destinationHosts: hosts,
      projectId: input.projectId,
      receiptClass: "decision",
    },
    effect: "deny",
    ruleId: CREDENTIAL_AUDIENCE_RULE_ID,
    ruleChain: [],
    reason,
  });
  return { reason, violations };
}

/** Is outbound audience enforcement in force right now? (the setting AND the secrets pack) */
export function outboundAudienceEnforced(settings: {
  outboundCredentialAudience: string;
  vendoredDetectionPacks: readonly string[];
}): boolean {
  return settings.outboundCredentialAudience === "enforce" && settings.vendoredDetectionPacks.includes("pipelock-secrets");
}
