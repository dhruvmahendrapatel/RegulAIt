/**
 * ADR-0099 — the `audit_log` CREDENTIAL SCRUB, pure half.
 *
 * THE GAP THIS CLOSES
 * -------------------
 * `audit_log` is this product's evidence substrate. Structural avoidance is
 * already good — every credential is encrypted at rest and no endpoint returns
 * one — but `detail` and `reason` are FREE-FORM and are written by hand at
 * thirty-odd call sites behind ~ten separate local `audit()` helpers, plus raw
 * `db.insert(auditLog)` calls. Nothing prevented a caller from interpolating a
 * bearer token into a reason string, and once it is in the ledger it is in the
 * ledger: the row is hash-chained (ADR-0060), so DELETING the secret afterwards
 * is indistinguishable from tampering. The write is the only chance.
 *
 * WHY THIS IS PURE, AND WHERE IT IS CALLED
 * ----------------------------------------
 * Nothing here touches a database, a clock or the network. It is called from
 * `@regulait/db`'s `appendChainedAuditRows` — the ONE place an audit row is
 * built — immediately BEFORE `auditContentHash`. That ordering is load-bearing
 * and is stated at the call site too: scrub after hashing would store a row
 * whose content no longer hashes to its `content_hash`, and ADR-0060's
 * verification would report every scrubbed row as `content_mismatch`. The row
 * that is hashed and the row that is stored are the same object.
 *
 * WHAT IT REPLACES, AND WHAT IT LEAVES ALONE
 * ------------------------------------------
 * Only the MATCHED RUN is replaced; the sentence around it survives byte for
 * byte. `"sync failed for AKIAIOSFODNN7EXAMPLE on host x"` keeps the verb, the
 * host and the word order and loses twenty characters in the middle. A string
 * with no credential in it is returned by IDENTITY — not rebuilt, not
 * normalized, not re-encoded — because an audit ledger whose ordinary content
 * gets mangled is a worse outcome than the risk being closed. uuids, emails,
 * rule ids, model names and prose pass through unchanged, and that is pinned by
 * test as hard as the positive case is.
 *
 * THE REPLACEMENT, AND WHY IT IS NOT `[redacted]`
 * -----------------------------------------------
 * `redactSettings` can afford a bare `[redacted]` marker because it redacts a
 * READ of a row that still exists. This redacts the RECORD. A marker that
 * erased which kind of credential was involved, or that collapsed two different
 * secrets in two different rows into identical text, would damage the ledger in
 * the course of protecting it — an investigator could no longer tell "the same
 * key appeared in both incidents" from "two unrelated keys did".
 *
 * So the marker carries three facts and no secret:
 *
 *     [redacted:<rules>:<length>:<fingerprint>]
 *
 *   * `<rules>` — the `dlp.secret.*` rule id(s) that matched, short form
 *     (`aws_key`, `jwt`, `regulait_token`, …), or `field` when the redaction
 *     was driven by the FIELD NAME rather than the value's shape. Says WHAT
 *     KIND of credential was in the row.
 *   * `<length>` — how many characters were removed. Says HOW MUCH.
 *   * `<fingerprint>` — the first `FINGERPRINT_HEX` hex characters of
 *     SHA-256 over the removed text. Says WHICH ONE, without saying what it
 *     was: the same credential redacted in two rows a month apart produces the
 *     same fingerprint and is correlatable; two different credentials never
 *     collapse into the same marker.
 *
 * This is `redactKeyFragment`'s bargain (ADR-0055 — keep enough to correlate,
 * lose enough to be useless) with the kept part moved from a PREFIX to a HASH,
 * because a prefix of an audit-log secret has no bounded length to hide behind
 * the way a 12-character evidence fragment does.
 *
 * HONEST LIMIT of the fingerprint: it is unsalted SHA-256, truncated. For a
 * HIGH-ENTROPY credential — which is every credential this product mints — that
 * is one-way. For a LOW-ENTROPY one that a caller shoved into a reason string
 * (`password = hunter2`), an attacker holding the ledger can confirm a guess.
 * The fingerprint is a correlation handle, not an encryption of the secret, and
 * it is strictly better than the alternative of storing the value.
 *
 * WHAT IT DELIBERATELY DOES NOT DO — see ADR-0099 for the full list.
 */
import { CREDENTIAL_MATERIAL_RULES } from "./guardrails.js";
import { sha256Hex } from "./audit-chain.js";

/** How many hex characters of the SHA-256 correlation fingerprint survive.
 * 12 hex = 48 bits: collision-free at any ledger size a control plane will
 * ever hold, and short enough that the marker stays readable in a table. */
export const AUDIT_SCRUB_FINGERPRINT_HEX = 12;

/** Every marker starts with this. A grep for it over the ledger answers "did
 * anything ever try to write a credential into audit?" in one query. */
export const AUDIT_SCRUB_MARKER_PREFIX = "[redacted:";

/**
 * Field names whose VALUE is a credential whatever it looks like.
 *
 * The shape rules cannot help here: a bootstrap token is deploy-time config
 * with no format at all, `REGULAIT_DATA_KEY` is 64 hex characters and
 * looks like any other hex digest, and a connector/model credential is whatever the
 * third party issues. What they DO have is a name, so the name is the signal.
 *
 * Matched on the key NORMALIZED to lowercase alphanumerics, and ONLY on exact
 * equality — never as a substring. That is what keeps `tokensIn: 1200`,
 * `tokenCount`, `apiKeyId`, `scimTokenName` and `secretsScanned` out of it;
 * `token` the credential and `tokens` the billing unit are one keystroke apart
 * in this codebase and a substring rule would eat the cost ledger. The value
 * must also be a STRING: every legitimate `token`-ish field in this product's
 * audit detail is a count, and a count is a number.
 */
const CREDENTIAL_FIELD_NAMES: ReadonlySet<string> = new Set([
  "accesskey",
  "accesskeyid",
  "accesstoken",
  "apikey",
  "apisecret",
  "apitoken",
  "authtoken",
  "authorization",
  "bearertoken",
  "bootstraptoken",
  "clientsecret",
  "credential",
  "credentials",
  "datakey",
  "passphrase",
  "passwd",
  "password",
  "privatekey",
  "refreshtoken",
  "secret",
  "secretaccesskey",
  "secretkey",
  "sessiontoken",
  "signingsecret",
  "token",
  "webhooksecret",
]);

/** Label used when a redaction was driven by the field name, not the shape. */
const FIELD_RULE_LABEL = "field";

/** `dlp.secret.aws_key` -> `aws_key`. Keeps the marker short without inventing
 * a second naming scheme: the short form is the rule id minus its family. */
function shortRuleId(id: string): string {
  return id.startsWith("dlp.secret.") ? id.slice("dlp.secret.".length) : id;
}

function marker(rules: readonly string[], removed: string): string {
  const label = [...new Set(rules)].sort().join("+");
  return `${AUDIT_SCRUB_MARKER_PREFIX}${label}:${removed.length}:${sha256Hex(removed).slice(0, AUDIT_SCRUB_FINGERPRINT_HEX)}]`;
}

/**
 * `dlp.secret.private_key` matches the PEM HEADER LINE only — it is a detector,
 * and detecting the header is enough to count a hit. A scrubber that replaced
 * only the header would leave the entire base64 key body sitting in the row,
 * which is the exact opposite of the point.
 *
 * So the span is EXTENDED, not re-matched: from the end of the header the
 * scrubber walks to just past the matching `-----END …-----`, or to the end of
 * the string if the block is truncated. Extending a span the shared rule found
 * is not a second copy of the rule — there is still exactly one definition of
 * "this looks like a private key", and it is in `guardrails.ts`.
 */
const PEM_END = /-----END\s+[A-Z0-9 ]*?PRIVATE\s+KEY(?:\s+BLOCK)?-----/g;

function extendPemSpan(text: string, headerEnd: number): number {
  PEM_END.lastIndex = headerEnd;
  const m = PEM_END.exec(text);
  return m ? m.index + m[0].length : text.length;
}

/**
 * The mirror image of the PEM extension: `dlp.secret.assignment` matches the
 * WHOLE `api_key = "…"` phrase, name included. Redacting all of it would erase
 * exactly the fact an investigator most needs — WHICH field was leaked — and
 * would make `password = x` and `client_secret = y` indistinguishable in the
 * ledger. So the span is NARROWED to start just after the `:`/`=`, leaving the
 * name and the operator in place. The name is not the secret.
 */
function narrowAssignmentStart(match: string, start: number): number {
  const sep = match.search(/[:=]/);
  if (sep < 0) return start;
  let i = sep + 1;
  while (i < match.length && (match[i] === " " || match[i] === "\t")) i += 1;
  return start + i;
}

interface Span {
  start: number;
  end: number;
  rule: string;
}

/**
 * Scrub one free-form string.
 *
 * Returns the SAME string object when nothing matched. That identity return is
 * the over-scrub guard expressed in code: the common path does not rebuild the
 * string, so it cannot accidentally change it.
 */
export function scrubAuditText(text: string): string {
  if (!text) return text;

  const spans: Span[] = [];
  for (const rule of CREDENTIAL_MATERIAL_RULES) {
    // The RegExp objects are module constants shared with `runRules`, and every
    // one carries /g — reset before use or a previous scan's lastIndex decides
    // where this one starts.
    rule.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.re.exec(text)) !== null) {
      if (m[0].length === 0) {
        rule.re.lastIndex += 1;
        continue;
      }
      let start = m.index;
      let end = start + m[0].length;
      if (rule.id === "dlp.secret.private_key") end = extendPemSpan(text, end);
      if (rule.id === "dlp.secret.assignment") start = narrowAssignmentStart(m[0], start);
      spans.push({ start, end, rule: shortRuleId(rule.id) });
    }
  }
  if (spans.length === 0) return text;

  // Two rules can match overlapping runs (an `api_key = eyJ…` trips both
  // `assignment` and `jwt`). Merging first means ONE marker per credential
  // rather than a marker nested inside another marker's replaced text.
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  const out: string[] = [];
  let cursor = 0;
  let i = 0;
  while (i < spans.length) {
    let { start, end } = spans[i]!;
    const rules = [spans[i]!.rule];
    let j = i + 1;
    while (j < spans.length && spans[j]!.start < end) {
      end = Math.max(end, spans[j]!.end);
      rules.push(spans[j]!.rule);
      j += 1;
    }
    out.push(text.slice(cursor, start), marker(rules, text.slice(start, end)));
    cursor = end;
    i = j;
  }
  out.push(text.slice(cursor));
  return out.join("");
}

/** Normalize a key for `CREDENTIAL_FIELD_NAMES` lookup: lowercase, and drop
 * every non-alphanumeric so `api_key`, `api-key` and `apiKey` are one name. */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Scrub a `detail`/`ruleChain`-shaped JSON value, recursively.
 *
 * Structure is preserved exactly: keys, array order, numbers, booleans, nulls
 * and nesting are untouched, and an unchanged subtree is returned BY IDENTITY
 * so an object with no credential in it is the same object afterwards.
 *
 * `depth` exists because `detail` is caller-supplied JSON and this runs inside
 * the audit write path: a pathological nesting must not be able to blow the
 * stack and take the audit row (and its transaction) down with it. Past the
 * limit the subtree is passed through unscrubbed rather than dropped — losing
 * evidence would be the worse failure — and ADR-0099 records it as a residue.
 */
const MAX_DEPTH = 24;

export function scrubAuditDetail(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return scrubAuditText(value);
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return value;

  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((el) => {
      const s = scrubAuditDetail(el, depth + 1);
      if (s !== el) changed = true;
      return s;
    });
    return changed ? next : value;
  }

  // A Date (or anything with toJSON) is a leaf as far as the canonicalizer is
  // concerned; walking its own properties would be meaningless.
  if (typeof (value as { toJSON?: unknown }).toJSON === "function") return value;

  const obj = value as Record<string, unknown>;
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    let s: unknown;
    if (typeof v === "string" && v.length > 0 && CREDENTIAL_FIELD_NAMES.has(normalizeKey(k))) {
      // Named a credential: the WHOLE value goes, whatever it looks like. This
      // is the only path that catches a bootstrap token or the data key.
      s = marker([FIELD_RULE_LABEL], v);
    } else {
      s = scrubAuditDetail(v, depth + 1);
    }
    if (s !== v) changed = true;
    next[k] = s;
  }
  return changed ? next : value;
}

/** The free-form audit columns this scrubber owns. `ruleId`/`ruleChain` are a
 * controlled vocabulary of policy identifiers and are deliberately NOT here —
 * see ADR-0099's residues. */
export interface ScrubbableAuditRow {
  detail?: unknown;
  reason?: unknown;
  toolName?: unknown;
}

/**
 * Scrub the free-form fields of one audit row.
 *
 * Returns the SAME row object when nothing changed, so the overwhelmingly
 * common case adds one allocation-free pass and nothing else to every audit
 * write. MUST be called before the row is hashed — see this file's header.
 */
export function scrubAuditRow<T extends ScrubbableAuditRow>(row: T): T {
  const detail = scrubAuditDetail(row.detail);
  const reason = typeof row.reason === "string" ? scrubAuditText(row.reason) : row.reason;
  const toolName = typeof row.toolName === "string" ? scrubAuditText(row.toolName) : row.toolName;
  if (detail === row.detail && reason === row.reason && toolName === row.toolName) return row;
  // Only OVERWRITE, never introduce: a row that had no `toolName` key must not
  // come out of here with `toolName: undefined`, because "absent" and "present
  // and undefined" are different inputs to the canonicalizer's rule 4.
  const next = { ...row } as T;
  if (detail !== row.detail) (next as ScrubbableAuditRow).detail = detail;
  if (reason !== row.reason) (next as ScrubbableAuditRow).reason = reason;
  if (toolName !== row.toolName) (next as ScrubbableAuditRow).toolName = toolName;
  return next;
}
