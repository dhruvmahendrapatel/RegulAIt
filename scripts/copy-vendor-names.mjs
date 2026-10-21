/**
 * No AI vendor or competitor name in product UI copy (F31, owner decision 2026-10-17).
 *
 *   node scripts/copy-vendor-names.mjs     exit 1 and list each hit, else exit 0
 *
 * AI products may appear as detection-catalogue data, in findings, and as demo seed registry records — never in prose
 * or UI copy. This guard reads the copy SURFACES only: the web app's source, the gateway's source, and the shared
 * modules whose sentences the UI prints verbatim. Catalogue, seed, fixture and generated files are outside its roots
 * or excluded by name, and comments are skipped (they are not copy).
 *
 * Matching is case-sensitive on the proper noun at a word boundary, so a provider slug (`openai`), an adapter id
 * (`openai_chat`) or an identifier (`anthropicCompatEnabled`) is never a hit. "Copilot" alone is our own feature's
 * name, so only the vendor-qualified forms are listed.
 *
 * ALLOWED_LINES are the reviewed exceptions, one line each, each with its reason. An entry that matches no line (stale)
 * or more than one (ambiguous) is itself reported, so the list cannot quietly outlive or outgrow what it excuses.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const VENDOR_NAMES = [
  "OpenAI", "Anthropic", "Claude", "ChatGPT", "Gemini", "GitHub Copilot", "Microsoft Copilot", "Mistral", "Cohere",
  "Grok", "Perplexity", "DeepSeek", "Cursor", "Lovable", "Bedrock", "Vertex AI", "Groq", "Ollama", "LocalAI",
  "LM Studio", "vLLM", "Llama", "Hugging Face", "Langfuse", "Helicone", "LangSmith", "Zscaler", "Netskope",
  "Witness AI", "Windsurf", "Codeium", "Replit", "Tabnine",
];

/** the copy surfaces: directories walked, plus single shared modules whose text the UI prints verbatim */
export const COPY_ROOTS = [
  "apps/web/src",
  "apps/gateway/src",
  "packages/shared/src/evidence-adapters.ts",
  "packages/shared/src/cost-import.ts",
  "packages/shared/src/demo-intake/scenario-library.ts",
];

const EXCLUDED = /(\.test\.|\.spec\.|\/fixtures?\/|\/e2e\/|\.generated\.|\.d\.ts$)/;
const SOURCE = /\.(ts|tsx)$/;

const OWNER = "owner decision 2026-10-21";
const COMPAT = `${OWNER}: compat labels keep vendor-style names`;
const GUIDE = `${OWNER}: the per-client setup guide names the client it configures`;
const WIRE = `${OWNER}: wire-protocol error message returned to clients of that protocol`;
const CATALOGUE = `${OWNER}: connector catalogue entry names what it connects to`;
const COST = `${OWNER}: display name of a vendor-specific cost-import adapter`;
const SLUGS = "provider slug -> display name map (provider identifiers, not prose)";
const SDK = "SDK code sample: the package and class names are code";

const CLIENT_ACCESS = "apps/web/src/views/admin/identity/ClientAccessPage.tsx";
const FORMAT = "apps/web/src/api/format.ts";
const SNIPPETS = "apps/web/src/views/models/snippets.ts";

/**
 * The reviewed exceptions. Each one names a file and a substring of exactly ONE line of it (or that line's whole
 * trimmed text, where a substring would also match a neighbour), and must match exactly one flagged line: zero is
 * stale, more than one is ambiguous, and both are reported. There is no whole-file skip, so a vendor name added on any
 * other line of an excepted file is still a hit.
 */
export const ALLOWED_LINES = [
  { file: CLIENT_ACCESS, contains: '<Field label="POST /v1/messages (Anthropic-shaped)">', why: COMPAT },
  { file: CLIENT_ACCESS, contains: '<Field label="POST /v1/chat/completions (OpenAI-shaped)">', why: COMPAT },
  { file: "apps/web/src/views/admin/settings/GettingStartedPage.tsx", contains: 'on.push("Anthropic compat on")', why: COMPAT },
  { file: "apps/web/src/views/admin/settings/GettingStartedPage.tsx", contains: 'on.push("OpenAI compat on")', why: COMPAT },
  { file: "apps/gateway/src/openapi.ts", contains: '"POST /v1/messages": { summary: "Anthropic-shaped compatibility surface', why: COMPAT },
  { file: "apps/gateway/src/openapi.ts", contains: '"POST /v1/chat/completions": { summary: "OpenAI-shaped compatibility surface', why: COMPAT },

  { file: CLIENT_ACCESS, contains: '{ client: "Claude Code", model: "ANTHROPIC_BASE_URL', why: GUIDE },
  { file: CLIENT_ACCESS, contains: '{ client: "Cursor", model: "OpenAI-compatible base URL', why: GUIDE },
  { file: CLIENT_ACCESS, contains: '{ client: "Cline", model: "OpenAI- or Anthropic-compatible base URL"', why: GUIDE },
  { file: CLIENT_ACCESS, contains: '{ client: "Roo Code", model: "OpenAI- or Anthropic-compatible base URL"', why: GUIDE },
  { file: CLIENT_ACCESS, contains: '{ client: "GitHub Copilot", model: "NOT SUPPORTED', why: GUIDE },
  { file: CLIENT_ACCESS, contains: "Anthropic- or OpenAI-compatible base URL can have its model calls governed here", why: GUIDE },
  { file: CLIENT_ACCESS, contains: '{ v: "claude-code", l: "Claude Code" }', why: GUIDE },
  { file: CLIENT_ACCESS, contains: '{ v: "cursor", l: "Cursor" }', why: GUIDE },
  { file: CLIENT_ACCESS, contains: '{ v: "generic-anthropic", l: "Generic Anthropic-compatible" }', why: GUIDE },
  { file: CLIENT_ACCESS, contains: '{ v: "generic-openai", l: "Generic OpenAI-compatible" }', why: GUIDE },
  { file: CLIENT_ACCESS, contains: "`# Model calls -> regulAIt (Anthropic-shaped)", why: GUIDE },
  { file: CLIENT_ACCESS, contains: '"Claude Code sends the key as x-api-key;', why: GUIDE },
  { file: CLIENT_ACCESS, contains: "`# Cursor -> Settings -> Models -> OpenAI API Key -> Override base URL", why: GUIDE },
  { file: CLIENT_ACCESS, contains: '"Cursor takes an OpenAI-compatible endpoint,', why: GUIDE },
  { file: CLIENT_ACCESS, contains: '"Cursor sends no custom headers on MODEL calls', why: GUIDE },
  { file: CLIENT_ACCESS, contains: "-> Settings -> API Provider: OpenAI Compatible", why: GUIDE },
  { file: CLIENT_ACCESS, contains: "# or API Provider: Anthropic, with a custom base URL", why: GUIDE },
  { file: CLIENT_ACCESS, contains: "`For the Anthropic shape instead, use provider: anthropic", why: GUIDE },
  { file: CLIENT_ACCESS, contains: "# base URL for any Anthropic SDK: ${base}", why: GUIDE },
  { file: CLIENT_ACCESS, contains: "x-api-key is the alias Anthropic clients send.", why: GUIDE },
  { file: CLIENT_ACCESS, contains: "# base URL for any OpenAI SDK: ${base}/v1", why: GUIDE },

  { file: "apps/gateway/src/compat-anthropic.ts", contains: "roles are valid in the Anthropic Messages shape;", why: WIRE },
  { file: "apps/gateway/src/compat-anthropic.ts", contains: 'rejectUnsupportedFields(raw, ANTHROPIC_SUPPORTED_FIELDS, "Anthropic")', why: WIRE },
  { file: "apps/gateway/src/compat-openai.ts", contains: 'rejectUnsupportedFields(raw, OPENAI_SUPPORTED_FIELDS, "OpenAI")', why: WIRE },

  { file: "apps/gateway/src/builder-catalog.ts", contains: 'C("huggingface", "Hugging Face",', why: CATALOGUE },
  { file: "apps/gateway/src/builder-catalog.ts", contains: 'C("perplexity", "Perplexity",', why: CATALOGUE },

  { file: "packages/shared/src/cost-import.ts", contains: 'displayName: "OpenAI console usage export"', why: COST },
  { file: "packages/shared/src/cost-import.ts", contains: 'displayName: "Anthropic console usage export"', why: COST },

  { file: FORMAT, contains: 'mcp: "MCP", mrm: "MRM", nist: "NIST", openai: "OpenAI",', why: SLUGS },
  { file: FORMAT, contains: 'anthropic: "Anthropic",', why: SLUGS },
  { file: FORMAT, equals: 'openai: "OpenAI",', why: SLUGS },
  { file: FORMAT, contains: 'mistral: "Mistral",', why: SLUGS },
  { file: FORMAT, contains: 'cohere: "Cohere",', why: SLUGS },
  { file: FORMAT, contains: 'aws_bedrock: "AWS Bedrock",', why: SLUGS },
  { file: FORMAT, contains: 'azure_openai: "Azure OpenAI",', why: SLUGS },
  { file: FORMAT, contains: 'google_vertex: "Google Vertex AI",', why: SLUGS },

  { file: SNIPPETS, contains: '{ id: "anthropic", label: "Anthropic SDK" }', why: SDK },
  { file: SNIPPETS, contains: "`\\n# Anthropic-shaped instead:\\n`", why: SDK },
  { file: SNIPPETS, contains: '`import OpenAI from "openai";', why: SDK },
  { file: SNIPPETS, contains: "`const client = new OpenAI({", why: SDK },
  { file: SNIPPETS, contains: "`from openai import OpenAI", why: SDK },
  { file: SNIPPETS, contains: "`client = OpenAI(", why: SDK },
  { file: SNIPPETS, contains: '`import Anthropic from "@anthropic-ai/sdk";', why: SDK },
  { file: SNIPPETS, contains: "`const client = new Anthropic({", why: SDK },
];

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const VENDOR_RE = new RegExp(`(?<![A-Za-z0-9_])(${VENDOR_NAMES.map(escape).join("|")})(?![A-Za-z0-9_])`);

/** the line with its comments removed; a whole-line comment becomes "" */
export function codeOf(line) {
  const t = line.trimStart();
  if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return "";
  return line.replace(/\/\*.*?\*\//g, "").replace(/(^|\s)\/\/\s.*$/, "$1");
}

/** every vendor name in one file's copy: [{ file, line, name, text }] */
export function scanText(file, text) {
  const hits = [];
  text.split("\n").forEach((raw, i) => {
    const m = VENDOR_RE.exec(codeOf(raw));
    if (m) hits.push({ file, line: i + 1, name: m[1], text: raw.trim() });
  });
  return hits;
}

function walk(root, rel) {
  const abs = path.join(root, rel);
  if (SOURCE.test(rel)) return [rel];
  return readdirSync(abs, { withFileTypes: true }).flatMap((e) => {
    const child = `${rel}/${e.name}`;
    return e.isDirectory() ? walk(root, child) : e.isFile() && SOURCE.test(e.name) ? [child] : [];
  });
}

/** the copy files under the roots (walked on disk, so an unstaged new file is checked too) */
export function copyFiles(root) {
  return COPY_ROOTS.flatMap((r) => walk(root, r)).filter((f) => !EXCLUDED.test(f));
}

/** an exception covers a flagged line by a substring of it (`contains`) or by its whole trimmed text (`equals`) */
const covers = (a, text) => (a.equals !== undefined ? text === a.equals : text.includes(a.contains));

/** { hits, stale }: hits not covered by an exception, and exceptions that do not cover exactly one line */
export function findVendorNames(root, files = copyFiles(root), read = (f) => readFileSync(path.join(root, f), "utf8")) {
  const used = new Map(ALLOWED_LINES.map((a) => [a, 0]));
  const hits = [];
  for (const file of files) {
    for (const hit of scanText(file, read(file))) {
      const allow = ALLOWED_LINES.filter((a) => a.file === file && covers(a, hit.text));
      for (const a of allow) used.set(a, used.get(a) + 1);
      if (allow.length === 0) hits.push(hit);
    }
  }
  const stale = ALLOWED_LINES.filter((a) => used.get(a) !== 1).map(
    (a) => `${a.file}: ${a.contains ?? a.equals} (covers ${used.get(a)} lines, must cover exactly 1)`,
  );
  return { hits, stale };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const { hits, stale } = findVendorNames(root);
  for (const h of hits) console.error(`${h.file}:${h.line}: '${h.name}' in copy: ${h.text}`);
  for (const s of stale) console.error(`stale exception: ${s}`);
  process.exit(hits.length || stale.length ? 1 : 0);
}
