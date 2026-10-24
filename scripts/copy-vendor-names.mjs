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
 * Every name on a line is checked, not just the first. Comments are found by parsing the file with the TypeScript
 * compiler, so a `//` inside a string literal or JSX text is copy, not a comment.
 *
 * Input placeholders and help text are held to more (F34, owner decision 2026-10-21 on #453): a model id is copy there
 * too, so the JSX `placeholder`, `title`, `label`, `aria-label` and help/hint/description/tip attributes, all JSX text,
 * the strings a `{...}` child prints and the same-file `const` strings either of them names are also checked,
 * case-insensitively, for AI model ids and model-family names (`claude-opus-5`, `gpt-4o`, `gemini`) and for the
 * vendors behind them (`Google`, `Meta`, ...). Everywhere else those words are left alone, where they are identifiers,
 * provider slugs or functional names (a Google Workspace connector). The same holds for what a .tsx file prints by
 * other routes (#492 review): an object-literal `label`/`title`/`placeholder`/`description`/help property (an options
 * array rendered as UI), the first argument of `toast()` and of every state setter named `set` + any letters + `Error`,
 * `Err`, `Notice`, `Message` or `Problem` (`setError`, `setFormError`, `setErr`, `setProblem`), and the string a
 * `.map(...)` callback in a `{...}` child returns (also through `.join(...)` and an array literal's elements). Not
 * followed: a string passed to any other call (a local helper's parameter, so `notice("intendedUse")` stays a key),
 * and a const imported from another file (that needs the whole program's module resolution; the shared copy modules
 * are scanned for proper nouns as roots instead).
 *
 * Docs are not copy surfaces and are not scanned. The operational commands in internal/product/DEMO_REAL_ACCOUNTS.md
 * and internal/product/DEMO_TEARDOWN.md name cloud AI services and their API hosts; they are kept as functional
 * exceptions (owner decision 2026-10-21, https://github.com/dhruvmahendrapatel/RegulAIt/issues/453#issuecomment-6327272521).
 *
 * ALLOWED_LINES are the reviewed exceptions, one line each, each with its reason and the names it excuses. An entry
 * that matches no line (stale) or more than one (ambiguous) is itself reported, so the list cannot quietly outlive or
 * outgrow what it excuses.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

export const VENDOR_NAMES = [
  "OpenAI", "Anthropic", "Claude", "ChatGPT", "Gemini", "GitHub Copilot", "Microsoft Copilot", "Mistral", "Cohere",
  "Grok", "Perplexity", "DeepSeek", "Cursor", "Lovable", "Bedrock", "Vertex AI", "Groq", "Ollama", "LocalAI",
  "LM Studio", "vLLM", "Llama", "Hugging Face", "Langfuse", "Helicone", "LangSmith", "Zscaler", "Netskope",
  "Witness AI", "Windsurf", "Codeium", "Replit", "Tabnine", "Cline", "Roo Code",
];

/** model ids and families, matched case-insensitively and only on the help surfaces (HELP_ATTRS and JSX text) */
export const MODEL_PATTERNS = [
  "claude(?:-[a-z0-9.]+)*", "gpt-?[0-9][a-z0-9.-]*", "chatgpt", "gemini(?:-[a-z0-9.]+)*", "gemma(?:-?[0-9][a-z0-9.-]*)?",
  "llama(?:-?[0-9][a-z0-9.-]*)?", "mistral(?:-[a-z0-9.]+)*", "mixtral(?:-[a-z0-9.]+)*", "codestral", "grok(?:-[a-z0-9.]+)*",
  "deepseek(?:-[a-z0-9.]+)*", "qwen[0-9.]*(?:-[a-z0-9.]+)*", "phi-[0-9][a-z0-9.-]*", "command-r[a-z0-9+-]*",
  "o[134]-(?:mini|preview|pro)", "dall-?e(?:-[0-9])?",
];
/** the vendors behind those models, matched as proper nouns, again only on the help surfaces */
export const HELP_VENDOR_NAMES = ["Google", "Meta", "Microsoft", "Amazon", "xAI", "Alibaba", "IBM", "Nvidia", "NVIDIA"];
/** JSX attributes that carry hint or help copy */
export const HELP_ATTRS = /^(placeholder|title|label|aria-label|hint|help|helpText|description|tip|info|caption|aria-description)$/;
/** object-literal properties a .tsx file renders as UI text (an options array's `label`, a card's `description`) */
export const HELP_PROPS = /^(placeholder|title|label|hint|help|helpText|description|tip|caption)$/;
/** calls whose first argument the UI shows: the `useToast()` toast and the set*Error/Err/Notice/Message/Problem setters */
export const UI_TEXT_CALLS = /^(toast|set[A-Za-z]*(Error|Err|Notice|Message|Problem))$/;

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
const IDP = "sign-in button labels of the identity providers an SSO broker offers (functional names, not AI products)";

const CLIENT_ACCESS = "apps/web/src/views/admin/identity/ClientAccessPage.tsx";
const FORMAT = "apps/web/src/api/format.ts";
const SNIPPETS = "apps/web/src/views/models/snippets.ts";

/**
 * The reviewed exceptions. Each one names a file, a substring of exactly ONE line of it (or that line's whole
 * trimmed text, where a substring would also match a neighbour) and the names it excuses on that line, and must match
 * exactly one flagged line: zero is stale, more than one is ambiguous, and both are reported. Every listed name is in
 * the entry's own `contains`/`equals` text (a test checks it). Another vendor name added to an excepted line is still
 * a hit, and there is no whole-file skip, so a vendor name added on any other line of an excepted file is a hit too.
 */
export const ALLOWED_LINES = [
  { file: CLIENT_ACCESS, contains: '<Field label="POST /v1/messages (Anthropic-shaped)">', names: ["Anthropic"], why: COMPAT },
  { file: CLIENT_ACCESS, contains: '<Field label="POST /v1/chat/completions (OpenAI-shaped)">', names: ["OpenAI"], why: COMPAT },
  { file: "apps/web/src/views/admin/settings/GettingStartedPage.tsx", contains: 'on.push("Anthropic compat on")', names: ["Anthropic"], why: COMPAT },
  { file: "apps/web/src/views/admin/settings/GettingStartedPage.tsx", contains: 'on.push("OpenAI compat on")', names: ["OpenAI"], why: COMPAT },
  { file: "apps/gateway/src/openapi.ts", contains: '"POST /v1/messages": { summary: "Anthropic-shaped compatibility surface', names: ["Anthropic"], why: COMPAT },
  { file: "apps/gateway/src/openapi.ts", contains: '"POST /v1/chat/completions": { summary: "OpenAI-shaped compatibility surface', names: ["OpenAI"], why: COMPAT },

  { file: CLIENT_ACCESS, contains: '{ client: "Claude Code", model: "ANTHROPIC_BASE_URL', names: ["Claude"], why: GUIDE },
  { file: CLIENT_ACCESS, contains: '{ client: "Cursor", model: "OpenAI-compatible base URL', names: ["Cursor", "OpenAI"], why: GUIDE },
  { file: CLIENT_ACCESS, contains: '{ client: "Cline", model: "OpenAI- or Anthropic-compatible base URL"', names: ["Cline", "OpenAI", "Anthropic"], why: GUIDE },
  { file: CLIENT_ACCESS, contains: '{ client: "Roo Code", model: "OpenAI- or Anthropic-compatible base URL"', names: ["Roo Code", "OpenAI", "Anthropic"], why: GUIDE },
  { file: CLIENT_ACCESS, contains: '{ client: "GitHub Copilot", model: "NOT SUPPORTED', names: ["GitHub Copilot"], why: GUIDE },
  { file: CLIENT_ACCESS, contains: "Anthropic- or OpenAI-compatible base URL can have its model calls governed here", names: ["Anthropic", "OpenAI"], why: GUIDE },
  { file: CLIENT_ACCESS, contains: '{ v: "claude-code", l: "Claude Code" }', names: ["Claude"], why: GUIDE },
  { file: CLIENT_ACCESS, contains: '{ v: "cursor", l: "Cursor" }', names: ["Cursor"], why: GUIDE },
  { file: CLIENT_ACCESS, contains: '{ v: "cline", l: "Cline" }', names: ["Cline"], why: GUIDE },
  { file: CLIENT_ACCESS, contains: '{ v: "roo", l: "Roo Code" }', names: ["Roo Code"], why: GUIDE },
  { file: CLIENT_ACCESS, contains: 'const nm = opts.client === "cline" ? "Cline" : "Roo Code";', names: ["Cline", "Roo Code"], why: GUIDE },
  { file: CLIENT_ACCESS, contains: '{ v: "generic-anthropic", l: "Generic Anthropic-compatible" }', names: ["Anthropic"], why: GUIDE },
  { file: CLIENT_ACCESS, contains: '{ v: "generic-openai", l: "Generic OpenAI-compatible" }', names: ["OpenAI"], why: GUIDE },
  { file: CLIENT_ACCESS, contains: "`# Model calls -> regulAIt (Anthropic-shaped)", names: ["Anthropic"], why: GUIDE },
  { file: CLIENT_ACCESS, contains: '"Claude Code sends the key as x-api-key;', names: ["Claude"], why: GUIDE },
  { file: CLIENT_ACCESS, contains: "`# Cursor -> Settings -> Models -> OpenAI API Key -> Override base URL", names: ["Cursor", "OpenAI"], why: GUIDE },
  { file: CLIENT_ACCESS, contains: '"Cursor takes an OpenAI-compatible endpoint,', names: ["Cursor", "OpenAI"], why: GUIDE },
  { file: CLIENT_ACCESS, contains: '"Cursor sends no custom headers on MODEL calls', names: ["Cursor"], why: GUIDE },
  { file: CLIENT_ACCESS, contains: "-> Settings -> API Provider: OpenAI Compatible", names: ["OpenAI"], why: GUIDE },
  { file: CLIENT_ACCESS, contains: "# or API Provider: Anthropic, with a custom base URL", names: ["Anthropic"], why: GUIDE },
  { file: CLIENT_ACCESS, contains: "`For the Anthropic shape instead, use provider: anthropic", names: ["Anthropic"], why: GUIDE },
  { file: CLIENT_ACCESS, contains: "# base URL for any Anthropic SDK: ${base}", names: ["Anthropic"], why: GUIDE },
  { file: CLIENT_ACCESS, contains: "x-api-key is the alias Anthropic clients send.", names: ["Anthropic"], why: GUIDE },
  { file: CLIENT_ACCESS, contains: "# base URL for any OpenAI SDK: ${base}/v1", names: ["OpenAI"], why: GUIDE },

  { file: "apps/gateway/src/compat-anthropic.ts", contains: "roles are valid in the Anthropic Messages shape;", names: ["Anthropic"], why: WIRE },
  { file: "apps/gateway/src/compat-anthropic.ts", contains: 'rejectUnsupportedFields(raw, ANTHROPIC_SUPPORTED_FIELDS, "Anthropic")', names: ["Anthropic"], why: WIRE },
  { file: "apps/gateway/src/compat-openai.ts", contains: 'rejectUnsupportedFields(raw, OPENAI_SUPPORTED_FIELDS, "OpenAI")', names: ["OpenAI"], why: WIRE },

  { file: "apps/gateway/src/builder-catalog.ts", contains: 'C("huggingface", "Hugging Face",', names: ["Hugging Face"], why: CATALOGUE },
  { file: "apps/gateway/src/builder-catalog.ts", contains: 'C("perplexity", "Perplexity",', names: ["Perplexity"], why: CATALOGUE },

  { file: "packages/shared/src/cost-import.ts", contains: 'displayName: "OpenAI console usage export"', names: ["OpenAI"], why: COST },
  { file: "packages/shared/src/cost-import.ts", contains: 'displayName: "Anthropic console usage export"', names: ["Anthropic"], why: COST },

  { file: FORMAT, contains: 'mcp: "MCP", mrm: "MRM", nist: "NIST", openai: "OpenAI",', names: ["OpenAI"], why: SLUGS },
  { file: FORMAT, contains: 'anthropic: "Anthropic",', names: ["Anthropic"], why: SLUGS },
  { file: FORMAT, equals: 'openai: "OpenAI",', names: ["OpenAI"], why: SLUGS },
  { file: FORMAT, contains: 'mistral: "Mistral",', names: ["Mistral"], why: SLUGS },
  { file: FORMAT, contains: 'cohere: "Cohere",', names: ["Cohere"], why: SLUGS },
  { file: FORMAT, contains: 'aws_bedrock: "AWS Bedrock",', names: ["Bedrock"], why: SLUGS },
  { file: FORMAT, contains: 'azure_openai: "Azure OpenAI",', names: ["OpenAI"], why: SLUGS },
  { file: FORMAT, contains: 'google_vertex: "Google Vertex AI",', names: ["Vertex AI"], why: SLUGS },

  { file: "apps/web/src/views/admin/identity/SsoPage.tsx", contains: "shows “Continue with Microsoft / Google / GitHub” on the sign-in page", names: ["Microsoft", "Google"], why: IDP },

  { file: SNIPPETS, contains: '{ id: "anthropic", label: "Anthropic SDK" }', names: ["Anthropic"], why: SDK },
  { file: SNIPPETS, contains: "`\\n# Anthropic-shaped instead:\\n`", names: ["Anthropic"], why: SDK },
  { file: SNIPPETS, contains: '`import OpenAI from "openai";', names: ["OpenAI"], why: SDK },
  { file: SNIPPETS, contains: "`const client = new OpenAI({", names: ["OpenAI"], why: SDK },
  { file: SNIPPETS, contains: "`from openai import OpenAI", names: ["OpenAI"], why: SDK },
  { file: SNIPPETS, contains: "`client = OpenAI(", names: ["OpenAI"], why: SDK },
  { file: SNIPPETS, contains: '`import Anthropic from "@anthropic-ai/sdk";', names: ["Anthropic"], why: SDK },
  { file: SNIPPETS, contains: "`const client = new Anthropic({", names: ["Anthropic"], why: SDK },
];

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const VENDOR_RE = new RegExp(`(?<![A-Za-z0-9_])(${VENDOR_NAMES.map(escape).join("|")})(?![A-Za-z0-9_])`, "g");
const HELP_VENDOR_RE = new RegExp(`(?<![A-Za-z0-9_])(${HELP_VENDOR_NAMES.map(escape).join("|")})(?![A-Za-z0-9_])`, "g");
const MODEL_RE = new RegExp(`(?<![A-Za-z0-9_])(${MODEL_PATTERNS.join("|")})(?![A-Za-z0-9_])`, "gi");

/** the comment ranges of a source text, from the TypeScript parser (so `//` inside a string or JSX text is not one) */
function commentRanges(file, text) {
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const ranges = new Map();
  const add = (rs) => rs?.forEach((r) => ranges.set(r.pos, r.end));
  const visit = (node) => {
    if (node.kind === ts.SyntaxKind.JsxText) return;
    add(ts.getLeadingCommentRanges(text, node.pos));
    add(ts.getTrailingCommentRanges(text, node.end));
    node.getChildren(sf).forEach(visit);
  };
  visit(sf);
  return ranges;
}

/** the text with its comments blanked (newlines kept, so line numbers hold) */
function stripComments(file, text) {
  const out = text.split("");
  for (const [pos, end] of commentRanges(file, text)) for (let i = pos; i < end; i++) if (out[i] !== "\n") out[i] = " ";
  return out.join("");
}

/** a line that is a comment on its own: a fragment of a block comment parses as code, so it is skipped by shape */
const wholeLineComment = (line) => /^\s*(\/\/|\/\*|\*)/.test(line);

/** the line with its comments removed; a whole-line comment becomes "" */
export function codeOf(line) {
  return wholeLineComment(line) ? "" : stripComments("line.ts", line);
}

/**
 * the [start, end) ranges of a file's help surfaces: help attributes' string text, every JSX text node, the strings
 * an element prints from a `{...}` child (`<p>{"..."}</p>`, a template literal, either branch of `a ? "x" : "y"`, a
 * `+` / `||` / `??` operand, what a `.map(...)` callback returns), an object literal's HELP_PROPS values, the first
 * argument of a UI_TEXT_CALLS call, and the initialiser of a same-file `const` any of those names (`placeholder={PH}`)
 */
function helpRanges(file, text) {
  if (!file.endsWith(".tsx")) return [];
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const ranges = [];
  // every same-file `const NAME = <string or template>`; a name declared twice resolves to both
  const consts = new Map();
  const collect = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
      && ts.isVariableDeclarationList(node.parent) && node.parent.flags & ts.NodeFlags.Const) {
      consts.set(node.name.text, [...(consts.get(node.name.text) ?? []), node.initializer]);
    }
    node.forEachChild(collect);
  };
  collect(sf);
  const resolving = new Set();
  const constant = (node) => {
    const name = node.text;
    if (resolving.has(name)) return;
    resolving.add(name);
    for (const init of consts.get(name) ?? []) printed(init);
    resolving.delete(name);
  };
  const isReference = (node) => ts.isIdentifier(node) && !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)
    && !(ts.isPropertyAssignment(node.parent) && node.parent.name === node);
  const literal = (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node)
      || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      ranges.push([node.getStart(sf), node.end]);
      return true;
    }
    return false;
  };
  // an attribute's value: every string in it, and every const it names
  const strings = (node) => {
    if (literal(node)) return;
    if (isReference(node)) constant(node);
    node.forEachChild(strings);
  };
  // what an expression prints: its own strings, not those of a call, comparison or nested element inside it
  const printed = (node) => {
    if (!node || literal(node)) return;
    if (ts.isTemplateExpression(node)) {
      literal(node.head);
      node.templateSpans.forEach((span) => {
        printed(span.expression);
        literal(span.literal);
      });
    } else if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) printed(node.expression);
    else if (ts.isConditionalExpression(node)) {
      printed(node.whenTrue);
      printed(node.whenFalse);
    } else if (ts.isBinaryExpression(node) && [ts.SyntaxKind.PlusToken, ts.SyntaxKind.BarBarToken,
      ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.AmpersandAmpersandToken].includes(node.operatorToken.kind)) {
      if (node.operatorToken.kind !== ts.SyntaxKind.AmpersandAmpersandToken) printed(node.left);
      printed(node.right);
    } else if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === "map" && node.arguments[0] && ts.isFunctionLike(node.arguments[0])) returned(node.arguments[0]);
    // `list.map(...).join(", ")` and `[...a.map(...), ...b]` print their elements
    else if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "join") {
      printed(node.expression.expression);
    } else if (ts.isArrayLiteralExpression(node)) node.elements.forEach(printed);
    else if (ts.isSpreadElement(node)) printed(node.expression);
    else if (isReference(node)) constant(node);
  };
  // what a `.map(...)` callback returns: its expression body, or each `return` of its own block
  const returned = (fn) => {
    if (!fn.body) return;
    if (!ts.isBlock(fn.body)) return printed(fn.body);
    const walkReturns = (node) => {
      if (ts.isReturnStatement(node)) printed(node.expression);
      else if (!ts.isFunctionLike(node)) node.forEachChild(walkReturns);
    };
    fn.body.forEachChild(walkReturns);
  };
  const callee = (call) => (ts.isIdentifier(call.expression) ? call.expression.text
    : ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text : "");
  const visit = (node) => {
    if (node.kind === ts.SyntaxKind.JsxText) ranges.push([node.pos, node.end]);
    else if (ts.isJsxAttribute(node) && HELP_ATTRS.test(node.name.getText(sf)) && node.initializer) strings(node.initializer);
    else if (ts.isJsxExpression(node) && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))) printed(node.expression);
    else if (ts.isPropertyAssignment(node) && ts.isObjectLiteralExpression(node.parent)
      && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) && HELP_PROPS.test(node.name.text)) printed(node.initializer);
    else if (ts.isCallExpression(node) && UI_TEXT_CALLS.test(callee(node))) printed(node.arguments[0]);
    node.forEachChild(visit);
  };
  visit(sf);
  return ranges;
}

/** every vendor name in one file's copy, one hit per occurrence: [{ file, line, name, text }] */
export function scanText(file, text) {
  const hits = [];
  // only a file that could hold a hit is parsed (the whole tree is scanned on every test run)
  const has = (re) => {
    re.lastIndex = 0;
    const found = re.test(text);
    re.lastIndex = 0;
    return found;
  };
  const maybeHelp = file.endsWith(".tsx") && (has(HELP_VENDOR_RE) || has(MODEL_RE));
  if (!has(VENDOR_RE) && !maybeHelp) return hits;
  const help = maybeHelp ? helpRanges(file, text) : [];
  const code = stripComments(file, text);
  const lines = text.split("\n");
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  const lineOf = (pos) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const found = [];
  for (const m of code.matchAll(VENDOR_RE)) found.push({ pos: m.index, name: m[1] });
  for (const [start, end] of help) {
    const part = code.slice(start, end);
    for (const m of [...part.matchAll(HELP_VENDOR_RE), ...part.matchAll(MODEL_RE)]) {
      // a VENDOR_NAMES hit on the same text ("Claude", "Gemini") is already reported
      if (!found.some((f) => f.pos === start + m.index)) found.push({ pos: start + m.index, name: m[1] });
    }
  }
  found.sort((x, y) => x.pos - y.pos);
  for (const { pos, name } of found) {
    const i = lineOf(pos);
    if (wholeLineComment(lines[i])) continue;
    hits.push({ file, line: i + 1, name, text: lines[i].trim() });
  }
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

/** an exception covers a hit by a substring of its line (`contains`) or the line's whole trimmed text (`equals`), and
 * only for the names it lists */
const coversLine = (a, text) => (a.equals !== undefined ? text === a.equals : text.includes(a.contains));
const covers = (a, hit) => a.file === hit.file && coversLine(a, hit.text) && a.names.includes(hit.name);

/** { hits, stale }: hits not covered by an exception, and exceptions that do not cover exactly one line */
export function findVendorNames(root, files = copyFiles(root), read = (f) => readFileSync(path.join(root, f), "utf8")) {
  const lines = new Map(ALLOWED_LINES.map((a) => [a, new Set()]));
  const hits = [];
  for (const file of files) {
    for (const hit of scanText(file, read(file))) {
      const allow = ALLOWED_LINES.filter((a) => covers(a, hit));
      for (const a of allow) lines.get(a).add(hit.line);
      if (allow.length === 0) hits.push(hit);
    }
  }
  const stale = ALLOWED_LINES.filter((a) => lines.get(a).size !== 1).map(
    (a) => `${a.file}: ${a.contains ?? a.equals} (covers ${lines.get(a).size} lines, must cover exactly 1)`,
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
