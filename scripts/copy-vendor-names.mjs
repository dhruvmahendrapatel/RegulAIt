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
 * ALLOWED_FILES and ALLOWED_LINES are the reviewed exceptions, each with its reason. A stale entry (one that no
 * longer matches anything) is itself reported, so the list cannot quietly outlive what it excuses.
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
export const COPY_ROOTS = ["apps/web/src", "apps/gateway/src", "packages/shared/src/evidence-adapters.ts"];

const EXCLUDED = /(\.test\.|\.spec\.|\/fixtures?\/|\/e2e\/|\.generated\.|\.d\.ts$)/;
const SOURCE = /\.(ts|tsx)$/;

/** reviewed exceptions — a whole file */
export const ALLOWED_FILES = {
  "apps/web/src/api/format.ts": "provider slug -> display name map (provider identifiers, not prose)",
  "apps/web/src/views/models/snippets.ts": "SDK code samples: the package and class names are code",
  "apps/web/src/views/admin/identity/ClientAccessPage.tsx": "OWNER QUESTION (F31): per-client setup guide names the client it configures",
  "apps/gateway/src/builder-catalog.ts": "OWNER QUESTION (F31): connector catalogue data (a connector picker names what it connects to)",
  "apps/gateway/src/openapi.ts": "OWNER QUESTION (F31): compat-surface summaries name the wire protocol",
  "apps/gateway/src/compat-anthropic.ts": "wire-protocol errors returned to API clients of that protocol",
  "apps/gateway/src/compat-openai.ts": "wire-protocol errors returned to API clients of that protocol",
};

/** reviewed exceptions — one line, by a substring of it */
export const ALLOWED_LINES = [
  { file: "apps/web/src/views/admin/settings/GettingStartedPage.tsx", contains: '"Anthropic compat on"', why: "OWNER QUESTION (F31): status chip names the compat toggle" },
  { file: "apps/web/src/views/admin/settings/GettingStartedPage.tsx", contains: '"OpenAI compat on"', why: "OWNER QUESTION (F31): status chip names the compat toggle" },
  { file: "apps/web/src/views/admin/integrations/CustomProvidersPage.tsx", contains: '{ v: "openai_chat", l: "openai_chat', why: "OWNER QUESTION (F31): adapter picker option" },
  { file: "apps/web/src/views/admin/integrations/CustomProvidersPage.tsx", contains: '{ v: "anthropic_messages", l: "anthropic_messages', why: "OWNER QUESTION (F31): adapter picker option" },
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

/** { hits, stale }: hits not covered by an exception, and exceptions that cover nothing */
export function findVendorNames(root, files = copyFiles(root), read = (f) => readFileSync(path.join(root, f), "utf8")) {
  const usedFiles = new Set();
  const usedLines = new Set();
  const hits = [];
  for (const file of files) {
    for (const hit of scanText(file, read(file))) {
      if (ALLOWED_FILES[file]) { usedFiles.add(file); continue; }
      const allow = ALLOWED_LINES.find((a) => a.file === file && hit.text.includes(a.contains));
      if (allow) { usedLines.add(allow); continue; }
      hits.push(hit);
    }
  }
  const stale = [
    ...Object.keys(ALLOWED_FILES).filter((f) => !usedFiles.has(f)),
    ...ALLOWED_LINES.filter((a) => !usedLines.has(a)).map((a) => `${a.file}: ${a.contains}`),
  ];
  return { hits, stale };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const { hits, stale } = findVendorNames(root);
  for (const h of hits) console.error(`${h.file}:${h.line}: '${h.name}' in copy: ${h.text}`);
  for (const s of stale) console.error(`stale exception: ${s}`);
  process.exit(hits.length || stale.length ? 1 : 0);
}
