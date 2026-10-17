/**
 * Shared helpers for the three adapters: turning an SDK error into an honest capability status, collecting
 * observations and capability rows, aggregating audit-log calls per principal, and digesting the result.
 */
import { createHash } from "node:crypto";
import type {
  CapabilityReport,
  CapabilityStatus,
  CloudObservation,
  CloudProvider,
  CloudScanContext,
  CloudScanResult,
} from "./types.js";

const EGRESS_ERROR_NAMES = new Set(["EgressBlockedError", "EgressRedirectError"]);
const AWS_DENIED = new Set([
  "AccessDeniedException",
  "AccessDenied",
  "UnauthorizedOperation",
  "UnauthorizedException",
  "AuthorizationErrorException",
  "InvalidClientTokenId",
  "UnrecognizedClientException",
  "ExpiredTokenException",
]);
const AZURE_DENIED = new Set(["AuthorizationFailed", "AuthenticationFailed", "InvalidAuthenticationToken", "Forbidden"]);
const NETWORK_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT"]);

function* causes(err: unknown): Generator<Record<string, unknown>> {
  let cur: unknown = err;
  for (let depth = 0; depth < 8 && cur && typeof cur === "object"; depth++) {
    yield cur as Record<string, unknown>;
    cur = (cur as { cause?: unknown }).cause;
  }
}

/** parameter names whose value is a secret wherever it appears as `name=value` in an error message */
const SECRET_PARAMS = ["key", "token", "secret", "signature", "sig", "password", "assertion", "credential", "code"];
const isNameChar = (c: number): boolean =>
  (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 45 || c === 46;
const VALUE_END = new Set(["&", " ", '"', "'", ",", ";", ")", "]", "}", "\n", "\r", "\t"]);

/**
 * Remove secrets from an error message, then keep the first 200 characters (review of #404, finding 5):
 * everything after `Bearer ` is dropped, and the value of every `<name>=` whose name ends in one of
 * SECRET_PARAMS (`key=`, `access_token=`, `X-Amz-Signature=`, `client_secret=` ...) is replaced up to its delimiter.
 * A character scan, not a regex.
 */
export function redact(message: string): string {
  let text = message;
  const bearer = text.toLowerCase().indexOf("bearer ");
  if (bearer >= 0) text = `${text.slice(0, bearer)}Bearer [redacted]`;
  let out = "";
  let i = 0;
  while (i < text.length) {
    // the next separator: `=` (query strings, form bodies) or `:` (JSON and YAML, `"access_token":"..."`)
    let eq = i;
    while (eq < text.length && text[eq] !== "=" && text[eq] !== ":") eq++;
    if (eq >= text.length) {
      out += text.slice(i);
      break;
    }
    // the name: optional whitespace and a closing quote, then the run of letters, digits, `_`, `-` or `.`
    let end = eq;
    while (end > i && text[end - 1] === " ") end--;
    if (end > i && (text[end - 1] === '"' || text[end - 1] === "'")) end--;
    let start = end;
    while (start > i && isNameChar(text.charCodeAt(start - 1))) start--;
    const name = text.slice(start, end).toLowerCase();
    out += text.slice(i, eq + 1);
    i = eq + 1;
    if (name.length > 0 && SECRET_PARAMS.some((p) => name.endsWith(p))) {
      while (i < text.length && text[i] === " ") out += text[i++];
      const quote = text[i] === '"' || text[i] === "'" ? text[i]! : null;
      if (quote) {
        // a quoted value runs to the matching quote
        const close = text.indexOf(quote, i + 1);
        out += `${quote}[redacted]${quote}`;
        i = close < 0 ? text.length : close + 1;
      } else {
        let end = i;
        while (end < text.length && !VALUE_END.has(text[end]!)) end++;
        if (end > i) out += "[redacted]";
        i = end;
      }
    }
  }
  return out.length > 200 ? `${out.slice(0, 200)}...` : out;
}

/** map any SDK or transport error to a capability status and a secret-free detail */
export function classifyError(err: unknown): { status: CapabilityStatus; detail: string } {
  for (const e of causes(err)) {
    const name = typeof e.name === "string" ? e.name : "";
    const message = typeof e.message === "string" ? e.message : "";
    if (EGRESS_ERROR_NAMES.has(name) || message.includes("egress blocked (")) {
      return { status: "unreachable", detail: `egress guard refused the call: ${redact(message)}` };
    }
  }
  for (const e of causes(err)) {
    const name = typeof e.name === "string" ? e.name : "";
    const code = e.code;
    const metadata = e.$metadata as { httpStatusCode?: number } | undefined;
    const status = typeof e.statusCode === "number" ? e.statusCode : typeof e.status === "number" ? e.status : metadata?.httpStatusCode;
    const message = typeof e.message === "string" ? e.message : String(err);
    if (AWS_DENIED.has(name)) return { status: "denied", detail: `${name}: ${redact(message)}` };
    if (typeof code === "string" && AZURE_DENIED.has(code)) return { status: "denied", detail: `${code}: ${redact(message)}` };
    // gRPC status codes, which google-gax also uses in REST fallback: 7 PERMISSION_DENIED, 16 UNAUTHENTICATED
    if (code === 7 || code === 16) return { status: "denied", detail: redact(message) };
    if (status === 401 || status === 403) return { status: "denied", detail: `HTTP ${status}: ${redact(message)}` };
    if (typeof code === "string" && NETWORK_CODES.has(code)) return { status: "unreachable", detail: `${code}: ${redact(message)}` };
  }
  const message = err instanceof Error ? err.message : String(err);
  if (message === "fetch failed") return { status: "unreachable", detail: "network error" };
  // MSAL (Azure identity) replaces any transport failure, an egress refusal included, with `network_error` and drops
  // the cause. Either way the token endpoint was not reached.
  const code = (err as { errorCode?: unknown })?.errorCode;
  if (code === "network_error" || message.startsWith("network_error")) {
    return { status: "unreachable", detail: "the identity endpoint could not be reached (egress allow list or network)" };
  }
  return { status: "error", detail: redact(message) };
}

/** collects one scan's observations and capability rows */
export class ScanCollector {
  readonly observations: CloudObservation[] = [];
  readonly capabilities: CapabilityReport[] = [];
  readonly #startedAt: Date;
  constructor(readonly provider: CloudProvider, readonly ctx: CloudScanContext) {
    this.#startedAt = new Date();
  }

  ok(capability: string, scope: string | null, items: number, detail?: string): void {
    this.capabilities.push({ capability, scope, status: "read", items, ...(detail ? { detail } : {}) });
  }

  report(capability: string, scope: string | null, status: CapabilityStatus, detail: string): void {
    this.capabilities.push({ capability, scope, status, detail });
  }

  failed(capability: string, scope: string | null, err: unknown): void {
    const { status, detail } = classifyError(err);
    this.capabilities.push({ capability, scope, status, detail });
  }

  /** run one read; on failure record the honest status instead of throwing */
  async attempt<T>(capability: string, scope: string | null, read: () => Promise<T[]>, onItems: (items: T[]) => void | Promise<void>, detail?: (items: T[]) => string | undefined): Promise<T[] | null> {
    try {
      const items = await read();
      await onItems(items);
      this.ok(capability, scope, items.length, detail?.(items));
      return items;
    } catch (err) {
      this.failed(capability, scope, err);
      return null;
    }
  }

  add(obs: CloudObservation): void {
    this.observations.push(obs);
  }

  finish(): CloudScanResult {
    const sorted = [...this.observations].sort((a, b) =>
      `${a.subjectKind}|${a.serviceKey}|${a.subject}|${a.location ?? ""}|${a.signalSource}`.localeCompare(
        `${b.subjectKind}|${b.serviceKey}|${b.subject}|${b.location ?? ""}|${b.signalSource}`,
      ),
    );
    return {
      provider: this.provider,
      observations: sorted,
      capabilities: this.capabilities,
      digest: digestObservations(sorted),
      startedAt: this.#startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
    };
  }
}

/** SHA-256 over a canonical JSON of the observations (rule 6) */
export function digestObservations(observations: CloudObservation[]): string {
  const canonical = JSON.stringify(observations, (_k, v: unknown) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)));
    }
    return v;
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/** follow a token-paged list call up to `maxPages` pages */
export async function paginate<P, T>(
  maxPages: number,
  fetchPage: (token: string | undefined) => Promise<P>,
  itemsOf: (page: P) => T[] | undefined,
  nextOf: (page: P) => string | undefined | null,
): Promise<T[]> {
  const out: T[] = [];
  let token: string | undefined;
  for (let i = 0; i < maxPages; i++) {
    const page = await fetchPage(token);
    out.push(...(itemsOf(page) ?? []));
    const next = nextOf(page);
    if (!next) return out;
    token = next;
  }
  return out;
}

/** drain an async iterator up to `max` items */
export async function take<T>(iter: AsyncIterable<T>, max: number): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iter) {
    out.push(item);
    if (out.length >= max) break;
  }
  return out;
}

interface PrincipalTally {
  rawIdentifier: string;
  container: string;
  location: string | null;
  serviceKey: string;
  operations: Set<string>;
  attributes: Map<string, Set<string>>;
  callCount: number;
  firstSeen: string;
  lastSeen: string;
}

/**
 * Groups audit-log calls by calling principal (decision 16: "grouped by calling principal"). Raw identifiers stay
 * inside this object and are pseudonymised on `flush`; only the pseudonym reaches an observation.
 */
export class PrincipalAggregator {
  readonly #tallies = new Map<string, PrincipalTally>();
  constructor(readonly provider: CloudProvider) {}

  record(call: {
    rawIdentifier: string;
    container: string;
    location: string | null;
    serviceKey: string;
    operation: string;
    at: string;
    attributes?: Record<string, string | undefined>;
  }): void {
    const key = `${call.serviceKey}|${call.container}|${call.location ?? ""}|${call.rawIdentifier}`;
    let t = this.#tallies.get(key);
    if (!t) {
      t = {
        rawIdentifier: call.rawIdentifier,
        container: call.container,
        location: call.location,
        serviceKey: call.serviceKey,
        operations: new Set(),
        attributes: new Map(),
        callCount: 0,
        firstSeen: call.at,
        lastSeen: call.at,
      };
      this.#tallies.set(key, t);
    }
    t.callCount += 1;
    t.operations.add(call.operation);
    if (call.at < t.firstSeen) t.firstSeen = call.at;
    if (call.at > t.lastSeen) t.lastSeen = call.at;
    for (const [k, v] of Object.entries(call.attributes ?? {})) {
      if (!v) continue;
      const set = t.attributes.get(k) ?? new Set<string>();
      if (set.size < 10) set.add(v);
      t.attributes.set(k, set);
    }
  }

  get size(): number {
    return this.#tallies.size;
  }

  async flush(collector: ScanCollector, resourceType = "principal"): Promise<void> {
    for (const t of this.#tallies.values()) {
      const subject = await collector.ctx.pseudonymise({ provider: this.provider, rawIdentifier: t.rawIdentifier });
      const attributes: Record<string, string> = {};
      for (const [k, v] of t.attributes) attributes[k] = [...v].sort().join(",");
      collector.add({
        provider: this.provider,
        subjectKind: "cloud_principal",
        subject,
        serviceKey: t.serviceKey,
        signalSource: "cloud_audit_log",
        resourceType,
        location: t.location,
        container: t.container,
        callCount: t.callCount,
        operations: [...t.operations].sort(),
        firstSeen: t.firstSeen,
        lastSeen: t.lastSeen,
        ...(Object.keys(attributes).length ? { attributes } : {}),
      });
    }
    this.#tallies.clear();
  }
}

export function lookbackStart(ctx: CloudScanContext, maxDays: number): Date {
  const days = Math.max(1, Math.min(ctx.auditLookbackDays, maxDays));
  return new Date(ctx.now.getTime() - days * 86_400_000);
}
