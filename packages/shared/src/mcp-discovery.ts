/**
 * ADR-0122 — MCP-SERVER DISCOVERY FROM SUPPLIED EVIDENCE.
 *
 * WHAT THIS IS, AND WHAT IT IS NOT. Shadow-AI discovery (ADR-0055) classifies
 * operator-supplied evidence against a frozen catalogue of provider hostnames
 * and SDK package names. It was MCP-BLIND: an MCP server is not a vendor
 * endpoint, so no hostname signature could ever match one, and the finding
 * vocabulary had no kind to record one as.
 *
 * This module closes that, with the same posture and the same honesty: it reads
 * text an operator pastes or uploads. **Nothing here scans, resolves, connects
 * or crawls.** It is evidence triage, not a discovery agent, and the payload
 * says so.
 *
 * WHY A SEPARATE MODULE RATHER THAN CATALOGUE ENTRIES. An MCP server is
 * identified by the SHAPE of a call, not by who operates it — there is no
 * `api.openai.com` equivalent because the interesting ones are self-hosted,
 * on hostnames nobody can enumerate in advance. So detection keys on the
 * protocol's own surface (its transport paths, its version header, its
 * JSON-RPC method names) and reads the HOST off the same line. That is a
 * different matching rule from "does this hostname equal a known vendor's",
 * and folding it into the frozen catalogue would have meant either editing a
 * hash-pinned corpus or pretending a path is a hostname.
 *
 * CONFIDENCE IS GRADED AND NEVER COLLAPSED. A transport path alone is a
 * convention, not a proof — `/sse` in particular belongs to plenty of things
 * that are not MCP. A path corroborated by the protocol version header or a
 * JSON-RPC method name is a different claim, and the two are reported as
 * different confidences rather than averaged into one number.
 */
import { AUDIT_SCRUB_FINGERPRINT_HEX, AUDIT_SCRUB_MARKER_PREFIX, scrubAuditText } from "./audit-scrub.js";
import { sha256Hex } from "./audit-chain.js";
import { redactPII } from "./pii.js";

/** How sure we are that the thing at this host speaks MCP. */
export type McpEvidenceConfidence = "low" | "medium" | "high";

export interface McpEndpointObservation {
  /** the host the evidence points at, lower-cased, port stripped */
  readonly host: string;
  /** the transport path seen, when the evidence carried one */
  readonly path: string | null;
  /** which indicators fired, for the operator to judge — never a score alone */
  readonly indicators: readonly string[];
  readonly confidence: McpEvidenceConfidence;
  /** how many distinct lines contributed */
  readonly occurrences: number;
  /** bounded sample lines so a human can sanity-check the call — scrubbed of
   * credential material and formatted PII BEFORE truncation (AER-020) */
  readonly samples: readonly string[];
}

const SAMPLES_MAX = 3;
const SAMPLE_CHARS = 200;

/**
 * AER-020 (2026-10-03) — THE SAMPLES ARE SCRUBBED BEFORE THEY ARE TRUNCATED.
 *
 * `samples` was documented as "redacted" and was not: a proxy/CASB export line
 * carries whatever the client sent — an `Authorization` header, an API key in
 * a query string, a customer e-mail in a JSON-RPC argument — and the first
 * 200 characters of it went straight into the API response (and, for anyone
 * who pasted it, into the browser). Scrubbing happens HERE, on the full line,
 * for two reasons that are each sufficient on their own: the shape rules need
 * the WHOLE token to recognise it (a key cut at character 200 is a key the
 * scrubber can no longer see and a human can still finish), and the output
 * must never hold a fragment of a credential either way.
 *
 * Two scrubbers compose, both already shared by the rest of the product so
 * there is still exactly one definition of each shape:
 *   1. `scrubAuditText` — ADR-0099's credential scrub over the shared
 *      `CREDENTIAL_MATERIAL_RULES` (AWS keys, PEM, JWT, `api_key = …`,
 *      vendor tokens, this product's own `rgl*_` credentials). Its marker
 *      keeps the kind, length and a fingerprint and loses the value.
 *   2. `redactPII` — §8.4's validated-span PII redaction (email, bounded US
 *      SSN, Luhn-validated card runs, separator-bearing phone), applied
 *      AFTER the credential pass so a digit run inside a token is scrubbed
 *      as the token it is, not as a phone number.
 *
 * Plus ONE log-line shape neither owns: the HTTP `Authorization` header's
 * value as a proxy writes it — `Bearer <opaque>` / `Basic <base64>` with a
 * SPACE, not the `bearer = …` assignment form the shared rule matches. A
 * proxy export is the one place a header value appears verbatim, which is why
 * the shape lives with the log parser rather than in the DLP detector (where it
 * would also fire on every model prompt that mentions the word).
 */
const AUTHORIZATION_HEADER_VALUE = /\b(bearer|basic)\s+([A-Za-z0-9._~+/=-]{16,})/gi;

export function scrubEvidenceSample(line: string): string {
  let out = scrubAuditText(line);
  AUTHORIZATION_HEADER_VALUE.lastIndex = 0;
  out = out.replace(AUTHORIZATION_HEADER_VALUE, (_m, scheme: string, value: string) =>
    `${scheme} ${AUDIT_SCRUB_MARKER_PREFIX}authorization_header:${value.length}:${sha256Hex(value).slice(0, AUDIT_SCRUB_FINGERPRINT_HEX)}]`,
  );
  return redactPII(out).text;
}

/**
 * The MCP transport paths worth matching, in the spec's own vocabulary.
 * `/mcp` is the Streamable HTTP convention; `/sse` and `/messages` are the
 * older HTTP+SSE transport's two halves. They are matched as a FULL path
 * segment at the end of the path, so `/mcp` matches `/mcp` and `/api/mcp` but
 * not `/mcpartner`.
 */
const TRANSPORT_PATHS = ["/mcp", "/sse", "/messages"] as const;

/**
 * Corroborating indicators. Each one, on its own line, raises what a bare path
 * can claim. `MCP-Protocol-Version` is the header the spec defines; the
 * JSON-RPC method names are the three every MCP session performs.
 */
const CORROBORATORS: ReadonlyArray<{ id: string; re: RegExp; note: string }> = [
  {
    id: "protocol-version-header",
    re: /mcp-protocol-version/i,
    note: "the MCP-Protocol-Version header, which only an MCP client or server sends",
  },
  {
    id: "jsonrpc-initialize",
    re: /"method"\s*:\s*"initialize"/i,
    note: "a JSON-RPC `initialize` call, the first message of every MCP session",
  },
  {
    id: "jsonrpc-tools-list",
    re: /"method"\s*:\s*"tools\/list"/i,
    note: "a JSON-RPC `tools/list` call — an MCP tool-manifest fetch",
  },
  {
    id: "jsonrpc-tools-call",
    re: /"method"\s*:\s*"tools\/call"/i,
    note: "a JSON-RPC `tools/call` — an MCP tool INVOCATION, not merely a handshake",
  },
];

/**
 * MCP SDK and server package names. A dependency is a capability to speak MCP,
 * never proof that anything did — the same caveat the shadow catalogue puts on
 * every SDK signature.
 */
export const MCP_SDK_PACKAGES: ReadonlyArray<{ pattern: string; note: string }> = Object.freeze([
  { pattern: "@modelcontextprotocol/sdk", note: "the official MCP TypeScript SDK on npm — client and server." },
  { pattern: "@modelcontextprotocol/server-", note: "an official MCP reference server package on npm (prefix match)." },
  { pattern: "mcp", note: "the official MCP Python SDK on PyPI. A bare, common word — corroborate before acting." },
  { pattern: "fastmcp", note: "FastMCP, a widely used Python framework for building MCP servers." },
  { pattern: "mcp-server-", note: "the community convention for an MCP server distribution (prefix match)." },
]);

/** Pull a host out of a log line: a URL, or a bare host:port token. */
function hostFrom(line: string): { host: string; path: string | null } | null {
  const url = /https?:\/\/([A-Za-z0-9._-]+)(?::\d+)?(\/[^\s"'\\)]*)?/i.exec(line);
  if (url) {
    return { host: url[1]!.toLowerCase(), path: url[2] ?? null };
  }
  // proxy formats often log `host:port` and the path separately
  const bare = /\b([a-z0-9][a-z0-9.-]*\.[a-z]{2,}|localhost|\d{1,3}(?:\.\d{1,3}){3})(?::\d+)\b/i.exec(line);
  if (bare) {
    const p = /\s(\/[^\s"']*)/.exec(line);
    return { host: bare[1]!.toLowerCase(), path: p ? p[1]! : null };
  }
  return null;
}

/** Does this path end in an MCP transport segment? */
function transportPathOf(path: string | null): string | null {
  if (!path) return null;
  const clean = path.split("?")[0]!.replace(/\/+$/, "");
  for (const t of TRANSPORT_PATHS) {
    if (clean === t || clean.endsWith(t)) return t;
  }
  return null;
}

/**
 * Read supplied evidence and report the hosts that look like they speak MCP.
 *
 * PURE. No clock, no network, no database. The caller decides what is
 * registered and what is therefore unregistered — this function has no opinion
 * about the estate, only about the text.
 */
export function findMcpEndpoints(content: string): McpEndpointObservation[] {
  const byHost = new Map<
    string,
    { host: string; path: string | null; indicators: Set<string>; occurrences: number; samples: string[] }
  >();

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const hit = hostFrom(line);
    if (!hit) continue;
    const transport = transportPathOf(hit.path);
    const corroborated = CORROBORATORS.filter((c) => c.re.test(line));
    // A line earns attention only if it carries a transport path or a
    // corroborator. Everything else is somebody else's traffic.
    if (!transport && corroborated.length === 0) continue;

    const entry =
      byHost.get(hit.host) ??
      { host: hit.host, path: null, indicators: new Set<string>(), occurrences: 0, samples: [] };
    entry.occurrences += 1;
    if (transport) {
      entry.path = entry.path ?? transport;
      entry.indicators.add(`transport-path:${transport}`);
    }
    for (const c of corroborated) entry.indicators.add(c.id);
    // scrub the FULL line first, truncate second — see `scrubEvidenceSample`
    if (entry.samples.length < SAMPLES_MAX) entry.samples.push(scrubEvidenceSample(line).slice(0, SAMPLE_CHARS));
    byHost.set(hit.host, entry);
  }

  return [...byHost.values()].map((e) => {
    const indicators = [...e.indicators].sort();
    const hasCorroborator = indicators.some((i) => !i.startsWith("transport-path:"));
    const hasInvocation = indicators.includes("jsonrpc-tools-call");
    // GRADED, NOT AVERAGED. An invocation is the strongest thing a log can
    // show: something actually called a tool. A handshake or the version
    // header is strong. A bare path is a convention.
    const confidence: McpEvidenceConfidence = hasInvocation
      ? "high"
      : hasCorroborator
        ? "high"
        : "medium";
    return {
      host: e.host,
      path: e.path,
      indicators,
      confidence,
      occurrences: e.occurrences,
      samples: e.samples,
    };
  });
}

/** What this module does and does not do, returned on the API so a reader of
 * the payload never has to infer the posture from marketing. */
export const MCP_DISCOVERY_POSTURE =
  "MCP discovery classifies evidence YOU supply — a proxy/CASB export, a gateway log, a manifest. " +
  "Nothing is scanned, resolved, crawled or connected to, and no network call is made. A host is " +
  "reported as UNREGISTERED when it appears in your evidence and matches no server in this " +
  "deployment's MCP registry; that is a statement about your registry and your evidence, not a " +
  "claim to have searched your estate.";
