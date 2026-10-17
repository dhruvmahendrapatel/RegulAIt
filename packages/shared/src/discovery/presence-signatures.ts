/**
 * ADR-0195 lane A6: PRESENCE signatures. An environment-variable NAME (an AI
 * provider key variable in `.env.example`, a CI config or a Dockerfile, or in
 * an endpoint's environment) or an AI CLI binary name, matched only by its
 * presence.
 *
 * Data minimisation (master decision, 2026-10-17): a match records only THAT a
 * catalogue signature matched and the signature's id. The observed variable
 * name is never returned, stored or shown, and a value is never read: the text
 * scanner below slices only the candidate name on each line and moves to the
 * next line with `indexOf`, so no value substring is ever created.
 *
 * Detection is data (ADR-0083 §3): the catalogue below is frozen data with
 * per-entry provenance, and matching is whole-name equality. No regex is taken
 * from data; the only patterns are the fixed shape checks here.
 *
 * NOT YET WIRED: the admin catalogue (`ai_endpoint_signatures`) closes its
 * `kind` CHECK over the migration 0202 kinds, so `env_name` and `cli` rows
 * cannot be stored yet and `AI_SIGNATURE_KINDS` does not list them. The
 * migration that widens it, and the wiring into `classifyObservation`, the
 * SD1 repo scanner and the SD3 endpoint importers, are follow-ups (ADR-0195,
 * "As built: lane A6").
 */

/** the presence kinds (pending the admin-catalogue migration) */
export const PRESENCE_SIGNATURE_KINDS = ["env_name", "cli"] as const;
export type PresenceSignatureKind = (typeof PRESENCE_SIGNATURE_KINDS)[number];

/** the endpoint agent's environment-variable name shape: linear, one bounded class */
export const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;
export const ENV_NAME_MAX = 128;
/** a CLI binary's base name, lower-cased, without a `.exe` suffix: linear, one bounded class */
export const CLI_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** a presence signature's id: linear, one bounded class */
export const PRESENCE_SIGNATURE_ID_PATTERN = /^(env|cli)\.[a-z0-9][a-z0-9_.-]{0,95}$/;

/** names one call may check; more is refused rather than silently cut */
export const PRESENCE_NAMES_MAX = 5_000;
/** the longest text `envNamePresenceInText` scans (the evidence byte bound) */
export const PRESENCE_TEXT_MAX = 2_000_000;

export const isEnvName = (name: string): boolean =>
  typeof name === "string" && name.length <= ENV_NAME_MAX && ENV_NAME_PATTERN.test(name);

export interface PresenceSignature {
  /** stable, opaque catalogue id: the only thing a match records */
  id: string;
  provider: string;
  kind: PresenceSignatureKind;
  /** the variable name (env_name) or binary base name (cli). Never a regular expression. */
  value: string;
  /** how sure the row is: a generic name (one also used outside AI) is low */
  confidence: "high" | "medium" | "low";
  /** the source registry's tool id, for grouping and provenance */
  toolId: string;
  provenance: string;
}

export interface PresenceMatch {
  signatureId: string;
  provider: string;
  kind: PresenceSignatureKind;
  confidence: PresenceSignature["confidence"];
}

const REGISTRY =
  "github.com/AmanSK5/shadow-ai-guard@12b7bbf733032d7822b2fb16e88b0f7a1399d1da registry/registry.yaml (Apache-2.0, NOTICE in vendor/shadow-ai-guard)";

const row = (
  id: string,
  provider: string,
  kind: PresenceSignatureKind,
  value: string,
  toolId: string,
  confidence: PresenceSignature["confidence"] = "high",
): PresenceSignature => Object.freeze({ id, provider, kind, value, confidence, toolId, provenance: REGISTRY });

/**
 * v1, pinned by entry count and SHA-256 in the test. Every name is taken from
 * the registry's `env_vars` and `cli.binaries` fields at the pinned commit
 * (`registry.yaml` sha256 94bb061fa84025e8f08d7cc4f141d3b3b2a073ddb06d65285ecaef5471150fa9).
 */
export const PRESENCE_SIGNATURES_V1: ReadonlyArray<PresenceSignature> = Object.freeze([
  row("env.anthropic.api-key", "anthropic", "env_name", "ANTHROPIC_API_KEY", "claude"),
  row("env.anthropic.auth-token", "anthropic", "env_name", "ANTHROPIC_AUTH_TOKEN", "claude"),
  row("env.anthropic.code-oauth-token", "anthropic", "env_name", "CLAUDE_CODE_OAUTH_TOKEN", "claude-code"),
  row("env.openai.api-key", "openai", "env_name", "OPENAI_API_KEY", "chatgpt"),
  row("env.openai.codex-api-key", "openai", "env_name", "CODEX_API_KEY", "codex-cli"),
  row("env.google.gemini-api-key", "google", "env_name", "GEMINI_API_KEY", "gemini-cli"),
  // a Google Cloud API key serves many non-AI APIs too
  row("env.google.api-key", "google", "env_name", "GOOGLE_API_KEY", "gemini-cli", "low"),
  row("env.cursor.api-key", "cursor", "env_name", "CURSOR_API_KEY", "cursor"),
  row("env.perplexity.api-key", "perplexity", "env_name", "PERPLEXITY_API_KEY", "perplexity"),
  row("env.deepseek.api-key", "deepseek", "env_name", "DEEPSEEK_API_KEY", "deepseek"),
  row("env.mistral.api-key", "mistral", "env_name", "MISTRAL_API_KEY", "mistral"),
  row("env.huggingface.api-key", "huggingface", "env_name", "HUGGINGFACE_API_KEY", "hugging-face"),
  row("env.huggingface.token", "huggingface", "env_name", "HF_TOKEN", "hugging-face"),
  // short, generic binary names: other programs may share them
  row("cli.anthropic.claude", "anthropic", "cli", "claude", "claude-code", "medium"),
  row("cli.openai.codex", "openai", "cli", "codex", "codex-cli", "medium"),
  row("cli.google.gemini", "google", "cli", "gemini", "gemini-cli", "medium"),
]);

const toMatch = (s: PresenceSignature): PresenceMatch => ({
  signatureId: s.id,
  provider: s.provider,
  kind: s.kind,
  confidence: s.confidence,
});

function collect(kind: PresenceSignatureKind, catalogue: readonly PresenceSignature[], hit: (value: string) => boolean) {
  const out: PresenceMatch[] = [];
  for (const s of catalogue) if (s.kind === kind && hit(s.value)) out.push(toMatch(s));
  return out.sort((a, b) => (a.signatureId < b.signatureId ? -1 : a.signatureId > b.signatureId ? 1 : 0));
}

function boundedNames(names: Iterable<string>): string[] {
  const list: string[] = [];
  for (const n of names) {
    if (list.length >= PRESENCE_NAMES_MAX) throw new RangeError(`at most ${PRESENCE_NAMES_MAX} names per call`);
    list.push(n);
  }
  return list;
}

/**
 * Env-variable names (an osquery row, an MDM export column, the agent's
 * report) against the catalogue. A name that fails the endpoint agent's shape
 * check is skipped. Returns one match per signature, never the names.
 */
export function matchEnvNames(
  names: Iterable<string>,
  catalogue: readonly PresenceSignature[] = PRESENCE_SIGNATURES_V1,
): PresenceMatch[] {
  const seen = new Set<string>();
  for (const n of boundedNames(names)) if (isEnvName(n)) seen.add(n);
  return collect("env_name", catalogue, (v) => seen.has(v));
}

/**
 * The base name of a CLI binary path: the last `/` or `\` segment, lower-cased,
 * without a trailing `.exe`. Null when it is not a plausible binary name.
 */
export function cliBaseName(raw: string): string | null {
  if (typeof raw !== "string" || raw.length > 4096) return null;
  const cut = Math.max(raw.lastIndexOf("/"), raw.lastIndexOf("\\"));
  let base = raw.slice(cut + 1).toLowerCase();
  if (base.endsWith(".exe")) base = base.slice(0, -4);
  return CLI_NAME_PATTERN.test(base) ? base : null;
}

/** CLI binary names or paths against the catalogue. Returns one match per signature, never the names. */
export function matchCliNames(
  binaries: Iterable<string>,
  catalogue: readonly PresenceSignature[] = PRESENCE_SIGNATURES_V1,
): PresenceMatch[] {
  const seen = new Set<string>();
  for (const b of boundedNames(binaries)) {
    const base = cliBaseName(b);
    if (base) seen.add(base);
  }
  return collect("cli", catalogue, (v) => seen.has(v));
}

/** the text formats the line scanner understands */
export const ENV_TEXT_FORMATS = ["dotenv", "dockerfile", "ci_yaml"] as const;
export type EnvTextFormat = (typeof ENV_TEXT_FORMATS)[number];

const isUpper = (c: number) => c >= 65 && c <= 90;
const isNameChar = (c: number) => isUpper(c) || (c >= 48 && c <= 57) || c === 95;
const isBlank = (c: number) => c === 32 || c === 9;

/** case-insensitive `word` at `i`, followed by a blank; the index after the blanks, else -1 */
function keyword(text: string, i: number, end: number, word: string): number {
  if (i + word.length >= end) return -1;
  if (text.slice(i, i + word.length).toLowerCase() !== word) return -1;
  let j = i + word.length;
  if (!isBlank(text.charCodeAt(j))) return -1;
  while (j < end && isBlank(text.charCodeAt(j))) j++;
  return j;
}

/** the name at `i` (at most ENV_NAME_MAX + 1 characters read) and the index after it */
function nameAt(text: string, i: number, end: number): { name: string; next: number } | null {
  if (i >= end || !isUpper(text.charCodeAt(i))) return null;
  let j = i;
  while (j < end && j - i <= ENV_NAME_MAX && isNameChar(text.charCodeAt(j))) j++;
  if (j - i > ENV_NAME_MAX) return null;
  return { name: text.slice(i, j), next: j };
}

function skipBlanks(text: string, i: number, end: number) {
  while (i < end && isBlank(text.charCodeAt(i))) i++;
  return i;
}

/** the one candidate name a line declares, or null. Reads only up to the name and the character after it. */
function lineName(text: string, start: number, end: number, format: EnvTextFormat): string | null {
  let i = skipBlanks(text, start, end);
  if (format === "dotenv") {
    const e = keyword(text, i, end, "export");
    if (e >= 0) i = e;
    const n = nameAt(text, i, end);
    if (!n) return null;
    return text.charCodeAt(skipBlanks(text, n.next, end)) === 61 /* = */ ? n.name : null;
  }
  if (format === "dockerfile") {
    let e = keyword(text, i, end, "env");
    if (e < 0) e = keyword(text, i, end, "arg");
    if (e < 0) return null;
    const n = nameAt(text, e, end);
    if (!n) return null;
    // `ENV NAME=v`, `ENV NAME v`, `ARG NAME`, `ARG NAME=v`
    const c = text.charCodeAt(n.next);
    return n.next >= end || c === 61 || isBlank(c) || c === 13 ? n.name : null;
  }
  // ci_yaml: `NAME: …`, `- NAME=…`, `- NAME: …`, or `name: NAME` (a variables list)
  if (text.charCodeAt(i) === 45 /* - */ && isBlank(text.charCodeAt(i + 1))) i = skipBlanks(text, i + 1, end);
  const e = keyword(text, i, end, "name:");
  if (e >= 0) {
    const n = nameAt(text, e, end);
    if (!n) return null;
    const after = skipBlanks(text, n.next, end);
    return after >= end || text.charCodeAt(after) === 13 || text.charCodeAt(after) === 35 /* # */ ? n.name : null;
  }
  const n = nameAt(text, i, end);
  if (!n) return null;
  const c = text.charCodeAt(skipBlanks(text, n.next, end));
  return c === 58 /* : */ || c === 61 /* = */ ? n.name : null;
}

/**
 * The presence of catalogue env names in a config file's text (`.env.example`,
 * a Dockerfile, a CI config). Each line yields at most one candidate name,
 * sliced from before its `=` or `:`; values are never sliced, and the names are
 * not returned. A text longer than `PRESENCE_TEXT_MAX` is refused.
 *
 * Limits (stated, not hidden): one name per line, so a Dockerfile
 * `ENV A=1 B=2` yields only `A`; continuation lines and YAML flow mappings are
 * not parsed.
 */
export function envNamePresenceInText(
  text: string,
  format: EnvTextFormat,
  catalogue: readonly PresenceSignature[] = PRESENCE_SIGNATURES_V1,
): PresenceMatch[] {
  if (typeof text !== "string") throw new TypeError("text must be a string");
  if (text.length > PRESENCE_TEXT_MAX) throw new RangeError(`at most ${PRESENCE_TEXT_MAX} characters per text`);
  if (!(ENV_TEXT_FORMATS as readonly string[]).includes(format)) throw new RangeError("unknown text format");
  const wanted = new Set(catalogue.filter((s) => s.kind === "env_name").map((s) => s.value));
  const seen = new Set<string>();
  let start = 0;
  while (start <= text.length) {
    const nl = text.indexOf("\n", start);
    const end = nl < 0 ? text.length : nl;
    const name = lineName(text, start, end, format);
    if (name !== null && wanted.has(name)) seen.add(name);
    if (nl < 0) break;
    start = nl + 1;
  }
  return collect("env_name", catalogue, (v) => seen.has(v));
}
