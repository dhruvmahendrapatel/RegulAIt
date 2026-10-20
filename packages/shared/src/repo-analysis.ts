/**
 * ADR-0195 decisions 5, 6, 14 and 20 — the PURE repo analyser (SD1).
 *
 * Input: a repo's file tree at one commit plus a file reader. Output:
 * observations — dependency names, source imports, provider hosts named in
 * code or config, AI assistant and MCP configuration files, IDE extension ids,
 * env-variable PRESENCE signature ids (lane A6: from `.env.example`, Dockerfiles
 * and CI YAML; the names themselves are never returned), and AI provider key
 * SIGHTINGS — plus counts and a SHA-256 digest of everything read.
 *
 * WHAT IT NEVER KEEPS (decision 6). No file content leaves this function: each
 * file is read, scanned and dropped; only the digest of all bytes read is
 * returned. A detected key is reduced to its 8-character redacted prefix
 * (`KEY_FRAGMENT_KEPT`), its length, the rule that found it and where (path,
 * line, commit). An MCP server is reduced to its name, transport, command
 * basename and URL host: never its arguments or environment. A commit author is
 * passed raw ONLY to the caller's pseudonym hook (SD0, decision 20) and only
 * the hook's return value is kept; with no hook the author is dropped.
 *
 * DETECTION IS DATA (decision 5). This function TRIAGES with the compiled v2
 * catalogue and with an optional `alsoKeep` predicate the caller builds from
 * the deployment's admin catalogue. An observation is not a finding: SD0's
 * findings path matches it against enabled `ai_endpoint_signatures` rows, and a
 * compiled-only hit is a catalogue gap.
 *
 * NO REGEX FROM DATA. Key shapes are the compiled gitleaks-derived
 * `dlp.secret.*` rules (`CREDENTIAL_MATERIAL_RULES`, linear by construction);
 * every other match is a literal string comparison.
 *
 * BOUNDS. Files listed, files read, bytes per file, bytes in total, line length
 * and observations are all capped; hitting a cap is reported, never silent.
 */
import { createHash } from "node:crypto";
import { CREDENTIAL_MATERIAL_RULES } from "./guardrails.js";
import { KEY_FRAGMENT_KEPT, normalizeEvidenceHost } from "./shadow-ai.js";
import {
  SHADOW_AI_CATALOG_V2,
  matchCatalogV2AssistantConfig,
  matchCatalogV2Endpoint,
  matchCatalogV2Extension,
  matchCatalogV2Package,
  type ShadowCatalogV2Entry,
} from "./shadow-catalog-v2.js";
import { manifestKindForPath, readManifest, type RepoEcosystem } from "./repo-manifests.js";
import { envNamePresenceInText } from "./discovery/presence-signatures.js";

export interface RepoAnalysisLimits {
  /** tree entries considered at all */
  maxTreeEntries: number;
  /** files actually read */
  maxFilesRead: number;
  /** a file larger than this (by tree size or read size) is skipped */
  maxFileBytes: number;
  /** bytes read across the whole repo */
  maxTotalBytes: number;
  /** lines longer than this are skipped (minified or generated) */
  maxLineLength: number;
  maxObservations: number;
  /** MCP servers taken from one config file */
  maxMcpServersPerFile: number;
}

export const REPO_ANALYSIS_DEFAULTS: Readonly<RepoAnalysisLimits> = Object.freeze({
  maxTreeEntries: 50_000,
  maxFilesRead: 2_000,
  maxFileBytes: 256 * 1024,
  maxTotalBytes: 32 * 1024 * 1024,
  maxLineLength: 8_192,
  maxObservations: 5_000,
  maxMcpServersPerFile: 100,
});

export interface RepoTreeEntryInput {
  path: string;
  size: number | null;
}

export interface RepoAuthorInput {
  name: string | null;
  email: string | null;
}

export type RepoObservationKind =
  | "dependency"
  | "source_import"
  | "endpoint_reference"
  | "assistant_config"
  | "mcp_server"
  | "ide_extension"
  | "env_presence"
  | "ai_key";

export interface RepoMcpServer {
  name: string;
  transport: "stdio" | "http" | "sse" | "unknown";
  /** basename of the launch command, no arguments */
  command: string | null;
  host: string | null;
}

export interface RepoKeySighting {
  /** the `dlp.secret.*` rule that matched */
  ruleId: string;
  /** at most KEY_FRAGMENT_KEPT characters */
  fragment: string;
  length: number;
}

export interface RepoObservation {
  kind: RepoObservationKind;
  path: string;
  line: number | null;
  commitSha: string;
  ecosystem?: RepoEcosystem | "python" | "javascript" | "go" | "csharp" | "ruby" | "rust";
  packageName?: string;
  host?: string;
  /** ADR-0195 lane A6: the presence signature an env-variable name in the file matched; never the name */
  presenceSignatureId?: string;
  extensionId?: string;
  mcpServer?: RepoMcpServer;
  key?: RepoKeySighting;
  /** the compiled v2 entry it triaged to; null when only `alsoKeep` kept it */
  catalogEntryId: string | null;
  provider: string | null;
}

export interface RepoAnalysisStats {
  filesListed: number;
  filesConsidered: number;
  filesRead: number;
  bytesRead: number;
  skippedTooLarge: number;
  skippedBinary: number;
  skippedByFileCap: number;
  skippedByByteCap: number;
  unreadableManifests: number;
  unparsedConfigs: number;
  observationsDropped: number;
  /** true when any cap cut the analysis short */
  truncated: boolean;
}

export interface RepoAnalysisResult {
  repo: string;
  commitSha: string;
  observations: RepoObservation[];
  stats: RepoAnalysisStats;
  /** SHA-256 over (path NUL content NUL) of every file read, in read order */
  contentDigest: string;
  /** the SD0 pseudonym of the head commit's author; null without a hook */
  authorRef: string | null;
}

export type RepoFileRead =
  | { status: "ok"; content: string }
  | { status: "too_large" }
  | { status: "binary" }
  | { status: "not_found" };

export interface RepoAnalysisInput {
  repo: string;
  commitSha: string;
  entries: ReadonlyArray<RepoTreeEntryInput>;
  /** reads one file at `commitSha` (the git-provider reader, wired by SD1's scanner) */
  readFile: (path: string, maxBytes: number) => Promise<RepoFileRead>;
  author?: RepoAuthorInput | null;
  /** SD0's pseudonym hook: receives the raw author, returns the keyed-hash reference */
  pseudonymiseAuthor?: (author: RepoAuthorInput) => Promise<string>;
  /** keep observations the compiled catalogue does not know (the admin catalogue's own rows) */
  alsoKeep?: (o: { kind: RepoObservationKind; value: string }) => boolean;
  limits?: Partial<RepoAnalysisLimits>;
  catalog?: ReadonlyArray<ShadowCatalogV2Entry>;
}

// ===========================================================================
// FILE SELECTION
// ===========================================================================

/** directories whose contents are not this repo's own code */
const SKIP_DIRS = new Set(["node_modules", "vendor", "third_party", "third-party", ".git", "dist", "build", "target", ".venv", "venv", "__pycache__", "bower_components", "Pods"]);

const SOURCE_EXT: Readonly<Record<string, NonNullable<RepoObservation["ecosystem"]>>> = Object.freeze({
  ".py": "python",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascript",
  ".ts": "javascript",
  ".mts": "javascript",
  ".cts": "javascript",
  ".tsx": "javascript",
  ".go": "go",
  ".cs": "csharp",
  ".rb": "ruby",
  ".rs": "rust",
});

/** config-ish text files scanned for hosts and keys (not for imports) */
const CONFIG_EXT = new Set([".json", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf", ".properties", ".env", ".xml"]);

const ENV_TEMPLATE_NAMES = new Set([".env.example", ".env.sample", ".env.template", ".env.dist", "example.env", "sample.env", ".env.defaults"]);

/** CI configs whose `env:`/`variables:` blocks name environment variables (lane A6) */
const CI_YAML_PATHS = new Set([".gitlab-ci.yml", "azure-pipelines.yml", "bitbucket-pipelines.yml", ".circleci/config.yml"]);

const isCiYaml = (path: string) => {
  if (CI_YAML_PATHS.has(path)) return true;
  if (!path.startsWith(".github/workflows/")) return false;
  const rest = path.slice(".github/workflows/".length);
  return !rest.includes("/") && (rest.endsWith(".yml") || rest.endsWith(".yaml"));
};

/** `Dockerfile`, `Containerfile`, `Dockerfile.<variant>` or `<name>.dockerfile` */
const isDockerfile = (b: string) => {
  const l = b.toLowerCase();
  return l === "dockerfile" || l === "containerfile" || l.startsWith("dockerfile.") || l.endsWith(".dockerfile");
};

type FileRole = "manifest" | "source" | "assistant_config" | "env_template" | "env_file" | "extensions_json" | "dockerfile" | "ci_yaml" | "config";

const baseName = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const extOf = (b: string) => {
  const dot = b.lastIndexOf(".");
  return dot <= 0 ? "" : b.slice(dot).toLowerCase();
};

function inSkippedDir(path: string): boolean {
  const segs = path.split("/");
  for (let i = 0; i < segs.length - 1; i++) if (SKIP_DIRS.has(segs[i]!)) return true;
  return false;
}

function roleOf(path: string, catalog: ReadonlyArray<ShadowCatalogV2Entry>): FileRole | null {
  if (inSkippedDir(path)) return null;
  if (matchCatalogV2AssistantConfig(path, catalog)) return "assistant_config";
  if (manifestKindForPath(path)) return "manifest";
  const b = baseName(path);
  if (path === ".vscode/extensions.json") return "extensions_json";
  if (ENV_TEMPLATE_NAMES.has(b.toLowerCase())) return "env_template";
  if (b === ".env" || b.startsWith(".env.")) return "env_file";
  if (isDockerfile(b)) return "dockerfile";
  if (isCiYaml(path)) return "ci_yaml";
  const ext = extOf(b);
  if (ext in SOURCE_EXT) return "source";
  if (CONFIG_EXT.has(ext)) return "config";
  return null;
}

/** read priority: the files that carry the most signal per byte go first */
const ROLE_ORDER: Readonly<Record<FileRole, number>> = { assistant_config: 0, manifest: 1, extensions_json: 2, env_template: 3, env_file: 4, dockerfile: 5, ci_yaml: 5, config: 6, source: 7 };

// ===========================================================================
// SCANNERS — each takes text and emits through `emit`
// ===========================================================================

type Emit = (o: Omit<RepoObservation, "commitSha">) => void;

/** AI-provider subsets of the dlp.secret rules; `provider_token` only for `sk-` */
const KEY_RULES: ReadonlyArray<{ id: string; re: RegExp; provider: string; accept?: (m: string) => boolean }> = (() => {
  const want: Record<string, { provider: string; accept?: (m: string) => boolean }> = {
    "dlp.secret.anthropic_key": { provider: "anthropic" },
    "dlp.secret.openai_key": { provider: "openai" },
    "dlp.secret.provider_token": { provider: "openai", accept: (m) => m.startsWith("sk-") && !m.startsWith("sk-ant-") && !m.startsWith("sk-proj-") && !m.startsWith("sk-svcacct-") && !m.startsWith("sk-admin-") },
    "dlp.secret.google_api_key": { provider: "google" },
  };
  return CREDENTIAL_MATERIAL_RULES.filter((r) => r.id in want).map((r) => ({ id: r.id, re: r.re, ...want[r.id]! }));
})();

export const REPO_KEY_RULE_IDS: ReadonlyArray<string> = KEY_RULES.map((r) => r.id);

function scanKeys(line: string, lineNo: number, path: string, emit: Emit): void {
  for (const rule of KEY_RULES) {
    rule.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.re.exec(line)) !== null) {
      const hit = m[0];
      if (hit.length === 0) {
        rule.re.lastIndex++;
        continue;
      }
      if (rule.accept && !rule.accept(hit)) continue;
      emit({
        kind: "ai_key",
        path,
        line: lineNo,
        key: { ruleId: rule.id, fragment: hit.slice(0, KEY_FRAGMENT_KEPT), length: hit.length },
        catalogEntryId: null,
        provider: rule.provider,
      });
    }
  }
}

const HOST_CHAR = (c: string) => (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || (c >= "0" && c <= "9") || c === "." || c === "-";

/** hosts named in a line: after every `://`, plus quoted bare hostnames */
export function hostsInLine(line: string): string[] {
  const out = new Set<string>();
  let at = line.indexOf("://");
  while (at !== -1) {
    let end = at + 3;
    while (end < line.length && end - at < 260 && HOST_CHAR(line[end]!)) end++;
    const h = normalizeEvidenceHost(line.slice(at + 3, end));
    if (h && h.includes(".")) out.add(h);
    at = line.indexOf("://", end);
  }
  for (const q of quotedStrings(line)) {
    if (q.length < 4 || q.length > 253 || !q.includes(".") || ![...q].every(HOST_CHAR)) continue;
    const h = normalizeEvidenceHost(q);
    if (h && /[a-z]/.test(h)) out.add(h);
  }
  return [...out];
}

function quotedStrings(line: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < line.length) {
    const q = line[i];
    if (q === '"' || q === "'" || q === "`") {
      const end = line.indexOf(q, i + 1);
      if (end === -1) break;
      out.push(line.slice(i + 1, end));
      i = end + 1;
    } else i++;
  }
  return out;
}

/** JS/TS module specifiers: from "x", import "x", require("x"), import("x") */
function jsSpecifiers(line: string): string[] {
  const out: string[] = [];
  const take = (from: number) => {
    let i = from;
    while (i < line.length && (line[i] === " " || line[i] === "(")) i++;
    const q = line[i];
    if (q !== '"' && q !== "'" && q !== "`") return;
    const end = line.indexOf(q, i + 1);
    if (end > i + 1) out.push(line.slice(i + 1, end));
  };
  for (const kw of ["from", "import", "require"]) {
    let at = line.indexOf(kw);
    while (at !== -1) {
      const before = at === 0 ? " " : line[at - 1]!;
      if (!/[A-Za-z0-9_$.]/.test(before)) take(at + kw.length);
      at = line.indexOf(kw, at + kw.length);
    }
  }
  return out;
}

/** the npm package a specifier resolves to, or null for relative/builtin */
export function npmPackageOf(spec: string): string | null {
  if (!spec || spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("node:") || spec.includes("://")) return null;
  const segs = spec.split("/");
  if (spec.startsWith("@")) return segs.length >= 2 ? `${segs[0]}/${segs[1]}` : null;
  return segs[0] || null;
}

/** candidate package names for one source line, by language */
function importCandidates(eco: NonNullable<RepoObservation["ecosystem"]>, line: string, state: { goBlock: boolean }): string[] {
  const t = line.trim();
  switch (eco) {
    case "python": {
      let mod: string | null = null;
      if (t.startsWith("import ")) mod = t.slice(7).split(/[\s,;]/)[0] ?? null;
      else if (t.startsWith("from ")) mod = t.slice(5).split(/\s/)[0] ?? null;
      if (!mod || mod.startsWith(".")) return [];
      const parts = mod.split(".");
      const out = [parts[0]!];
      if (parts.length > 1) out.push(`${parts[0]}-${parts[1]}`);
      // `from google import genai` names the google-genai distribution
      const imp = t.startsWith("from ") ? t.indexOf(" import ") : -1;
      if (imp !== -1 && parts.length === 1) {
        const first = t.slice(imp + 8).split(/[\s,()]/).find((x) => x.length > 0);
        if (first) out.push(`${parts[0]}-${first}`);
      }
      return out;
    }
    case "javascript":
      return jsSpecifiers(line).map(npmPackageOf).filter((p): p is string => p !== null);
    case "go": {
      if (t === "import (") {
        state.goBlock = true;
        return [];
      }
      if (state.goBlock && t === ")") {
        state.goBlock = false;
        return [];
      }
      if (!state.goBlock && !t.startsWith("import ")) return [];
      const path = quotedStrings(t)[0];
      if (!path) return [];
      const segs = path.split("/");
      const out: string[] = [];
      for (let n = segs.length; n >= Math.min(3, segs.length); n--) out.push(segs.slice(0, n).join("/"));
      return out;
    }
    case "csharp": {
      if (!t.startsWith("using ") || t.includes("=") || t.includes("(")) return [];
      const ns = t.slice(6).replace(/;$/, "").replace(/^static /, "").trim();
      const segs = ns.split(".");
      const out: string[] = [];
      for (let n = segs.length; n >= 1; n--) out.push(segs.slice(0, n).join("."));
      return out;
    }
    case "ruby": {
      if (!t.startsWith("require ") && !t.startsWith("require(")) return [];
      const name = quotedStrings(t)[0];
      return name ? [name.split("/")[0]!] : [];
    }
    case "rust": {
      let rest: string | null = null;
      if (t.startsWith("use ")) rest = t.slice(4);
      else if (t.startsWith("extern crate ")) rest = t.slice(13);
      if (!rest) return [];
      const name = rest.split(/[:;\s{]/)[0];
      return name && !["crate", "self", "super", "std", "core", "alloc"].includes(name) ? [name] : [];
    }
    default:
      return [];
  }
}

function mcpServers(doc: unknown, max: number): RepoMcpServer[] | null {
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) return null;
  const rec = doc as Record<string, unknown>;
  const table = rec.mcpServers ?? rec.servers;
  if (table === null || typeof table !== "object" || Array.isArray(table)) return [];
  const out: RepoMcpServer[] = [];
  for (const [name, raw] of Object.entries(table as Record<string, unknown>)) {
    if (out.length >= max) break;
    const s = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    const url = typeof s.url === "string" ? s.url : typeof s.serverUrl === "string" ? s.serverUrl : null;
    const command = typeof s.command === "string" ? s.command : null;
    const type = typeof s.type === "string" ? s.type.toLowerCase() : typeof s.transport === "string" ? s.transport.toLowerCase() : "";
    let host: string | null = null;
    if (url) {
      try {
        host = normalizeEvidenceHost(new URL(url).hostname);
      } catch {
        host = null;
      }
    }
    const transport: RepoMcpServer["transport"] = type === "sse" ? "sse" : url ? "http" : command ? "stdio" : "unknown";
    // the FIRST whitespace token is the program; only then its basename. Splitting on `/` first would let an
    // argument such as `--token abc/SECRETPART` become the "command" (review of #402)
    const program = command ? (command.trim().split(/\s+/)[0] ?? "") : "";
    const cmdBase = program ? (program.split(/[\\/]/).pop() ?? "").slice(0, 100) : null;
    out.push({ name: name.slice(0, 100), transport, command: cmdBase || null, host });
  }
  return out;
}

const MCP_CONFIG_IDS = new Set(["cfg-mcp-json", "cfg-vscode-mcp-json", "cfg-gemini-settings", "cfg-cursor-mcp-json"]);

// ===========================================================================
// THE ANALYSER
// ===========================================================================

export async function analyseRepo(input: RepoAnalysisInput): Promise<RepoAnalysisResult> {
  const limits: RepoAnalysisLimits = { ...REPO_ANALYSIS_DEFAULTS, ...(input.limits ?? {}) };
  const catalog = input.catalog ?? SHADOW_AI_CATALOG_V2;
  const keep = input.alsoKeep ?? (() => false);
  const commitSha = input.commitSha;
  const observations: RepoObservation[] = [];
  const seen = new Set<string>();
  const stats: RepoAnalysisStats = {
    filesListed: input.entries.length,
    filesConsidered: 0,
    filesRead: 0,
    bytesRead: 0,
    skippedTooLarge: 0,
    skippedBinary: 0,
    skippedByFileCap: 0,
    skippedByByteCap: 0,
    unreadableManifests: 0,
    unparsedConfigs: 0,
    observationsDropped: 0,
    truncated: input.entries.length > limits.maxTreeEntries,
  };
  const digest = createHash("sha256");

  const emit: Emit = (o) => {
    const key = [o.kind, o.path, o.line ?? "", o.packageName ?? "", o.host ?? "", o.presenceSignatureId ?? "", o.extensionId ?? "", o.mcpServer?.name ?? "", o.key?.ruleId ?? "", o.key?.fragment ?? ""].join("\u0000");
    if (seen.has(key)) return;
    seen.add(key);
    if (observations.length >= limits.maxObservations) {
      stats.observationsDropped++;
      stats.truncated = true;
      return;
    }
    observations.push({ ...o, commitSha });
  };

  const emitPackage = (kind: "dependency" | "source_import", path: string, line: number | null, eco: NonNullable<RepoObservation["ecosystem"]>, names: string[]) => {
    for (const name of names) {
      const hit = matchCatalogV2Package(name, catalog);
      if (hit || keep({ kind, value: name })) {
        emit({ kind, path, line, ecosystem: eco, packageName: name, catalogEntryId: hit?.id ?? null, provider: hit?.provider ?? null });
        if (kind === "source_import") return; // one package per import line
      }
    }
  };

  const scanHostsAndKeys = (path: string, content: string) => {
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (line.length > limits.maxLineLength) continue;
      scanKeys(line, i + 1, path, emit);
      for (const host of hostsInLine(line)) {
        const hit = matchCatalogV2Endpoint(host, catalog);
        if (hit || keep({ kind: "endpoint_reference", value: host })) {
          emit({ kind: "endpoint_reference", path, line: i + 1, host, catalogEntryId: hit?.id ?? null, provider: hit?.provider ?? null });
        }
      }
    }
  };

  // 1. select and order the files to read
  const candidates: { path: string; size: number | null; role: FileRole }[] = [];
  for (const e of input.entries.slice(0, limits.maxTreeEntries)) {
    if (typeof e.path !== "string" || e.path.length === 0 || e.path.length > 4_096) continue;
    const role = roleOf(e.path, catalog);
    if (!role) continue;
    candidates.push({ path: e.path, size: e.size, role });
  }
  candidates.sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || a.path.localeCompare(b.path));
  stats.filesConsidered = candidates.length;

  // 2. assistant config files are observations by PRESENCE, before any read
  for (const c of candidates) {
    if (c.role !== "assistant_config") continue;
    const hit = matchCatalogV2AssistantConfig(c.path, catalog)!;
    emit({ kind: "assistant_config", path: c.path, line: null, catalogEntryId: hit.id, provider: hit.provider });
  }

  // 3. read, scan, drop
  for (const c of candidates) {
    if (c.size !== null && c.size > limits.maxFileBytes) {
      stats.skippedTooLarge++;
      continue;
    }
    if (stats.filesRead >= limits.maxFilesRead) {
      stats.skippedByFileCap++;
      stats.truncated = true;
      continue;
    }
    if (stats.bytesRead >= limits.maxTotalBytes) {
      stats.skippedByByteCap++;
      stats.truncated = true;
      continue;
    }
    const read = await input.readFile(c.path, limits.maxFileBytes);
    if (read.status === "too_large") {
      stats.skippedTooLarge++;
      continue;
    }
    if (read.status === "binary") {
      stats.skippedBinary++;
      continue;
    }
    if (read.status !== "ok") continue;
    const content = read.content;
    const bytes = Buffer.byteLength(content);
    if (bytes > limits.maxFileBytes) {
      stats.skippedTooLarge++;
      continue;
    }
    stats.filesRead++;
    stats.bytesRead += bytes;
    digest.update(c.path).update("\u0000").update(content).update("\u0000");

    // keys and hosts are scanned in every file we read
    scanHostsAndKeys(c.path, content);

    switch (c.role) {
      case "manifest": {
        const kind = manifestKindForPath(c.path)!;
        const m = readManifest(kind, content);
        if (!m.ok) stats.unreadableManifests++;
        for (const d of m.dependencies) emitPackage("dependency", c.path, d.line, d.ecosystem, [d.name]);
        break;
      }
      case "source": {
        const eco = SOURCE_EXT[extOf(baseName(c.path))]!;
        const state = { goBlock: false };
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]!;
          if (line.length > limits.maxLineLength) continue;
          const names = importCandidates(eco, line, state);
          if (names.length > 0) emitPackage("source_import", c.path, i + 1, eco, names);
        }
        break;
      }
      case "assistant_config": {
        const hit = matchCatalogV2AssistantConfig(c.path, catalog)!;
        if (MCP_CONFIG_IDS.has(hit.id)) {
          let doc: unknown;
          try {
            doc = JSON.parse(content);
          } catch {
            // JSONC (comments) is not parsed: see the note in THIRD_PARTY.md
            stats.unparsedConfigs++;
            break;
          }
          for (const s of mcpServers(doc, limits.maxMcpServersPerFile) ?? []) {
            emit({ kind: "mcp_server", path: c.path, line: null, mcpServer: s, ...(s.host ? { host: s.host } : {}), catalogEntryId: hit.id, provider: hit.provider });
          }
        }
        break;
      }
      case "extensions_json": {
        let doc: unknown;
        try {
          doc = JSON.parse(content);
        } catch {
          stats.unparsedConfigs++;
          break;
        }
        const recs = doc !== null && typeof doc === "object" ? (doc as Record<string, unknown>).recommendations : null;
        for (const id of Array.isArray(recs) ? recs.slice(0, 500) : []) {
          if (typeof id !== "string" || id.length > 200) continue;
          const hit = matchCatalogV2Extension(id, catalog);
          if (hit || keep({ kind: "ide_extension", value: id.toLowerCase() })) {
            emit({ kind: "ide_extension", path: c.path, line: null, extensionId: id.toLowerCase(), catalogEntryId: hit?.id ?? null, provider: hit?.provider ?? null });
          }
        }
        break;
      }
      case "env_template":
      case "dockerfile":
      case "ci_yaml": {
        // ADR-0195 lane A6: presence only. The matcher slices each line's candidate NAME, never a value, and
        // returns signature ids; the names are not returned, kept or passed on (master decision, 2026-10-17)
        const format = c.role === "env_template" ? "dotenv" : c.role === "dockerfile" ? "dockerfile" : "ci_yaml";
        let matches: ReturnType<typeof envNamePresenceInText> = [];
        try {
          matches = envNamePresenceInText(content, format);
        } catch {
          stats.unparsedConfigs++;
          break;
        }
        for (const m of matches) {
          emit({ kind: "env_presence", path: c.path, line: null, presenceSignatureId: m.signatureId, catalogEntryId: null, provider: m.provider });
        }
        break;
      }
      default:
        break;
    }
  }

  let authorRef: string | null = null;
  if (input.author && input.pseudonymiseAuthor && (input.author.name || input.author.email)) {
    authorRef = await input.pseudonymiseAuthor({ name: input.author.name, email: input.author.email });
  }

  return {
    repo: input.repo,
    commitSha,
    observations,
    stats,
    contentDigest: digest.digest("hex"),
    authorRef,
  };
}
