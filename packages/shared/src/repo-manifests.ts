/**
 * ADR-0195 decision 14 — dependency-manifest readers for the repo scanner.
 *
 * Each reader takes a manifest's TEXT and returns the declared dependency
 * NAMES with the line they sit on (where it can be found). Versions, scripts
 * and every other field are ignored; nothing here is stored as content.
 *
 * OPEN SOURCE FIRST (ADR-0176). TOML (pyproject.toml, Pipfile, Cargo.toml,
 * Gradle version catalogues) is parsed with `smol-toml` and XML (pom.xml,
 * *.csproj, packages.config, Directory.Packages.props) with `fast-xml-parser`,
 * entity expansion off. npm, requirements.txt and go.mod reuse the ADR-0083
 * readers in `shadow-discovery.ts`. Gradle build scripts and Gemfiles are
 * Groovy/Kotlin and Ruby programs: no parser can evaluate them safely, so a
 * bounded line scan reads the literal coordinates they declare and says so.
 * syft (Apache-2.0) was evaluated (ADR-0195 decision 11): it inventories a
 * checked-out filesystem or image, while the scanner deliberately never clones
 * (it reads a bounded set of files through the provider API and keeps no
 * content), and it would add a binary to the image. Not adopted; recorded in
 * THIRD_PARTY.md.
 */
import { XMLParser } from "fast-xml-parser";
import { parse as parseToml } from "smol-toml";
import { parseGoModManifest, parsePackageJsonManifest, parseRequirementsManifest } from "./shadow-discovery.js";

export const REPO_ECOSYSTEMS = ["npm", "pypi", "go", "maven", "gradle", "nuget", "rubygems", "cargo"] as const;
export type RepoEcosystem = (typeof REPO_ECOSYSTEMS)[number];

export interface RepoDependency {
  ecosystem: RepoEcosystem;
  name: string;
  /** 1-based line of the first mention, when found */
  line: number | null;
}

export type ManifestKind =
  | "package_json"
  | "requirements_txt"
  | "pyproject_toml"
  | "pipfile"
  | "go_mod"
  | "pom_xml"
  | "gradle_script"
  | "gradle_catalog"
  | "nuget_project"
  | "packages_config"
  | "gemfile"
  | "cargo_toml";

const NAME_MAX = 214;

/** classify a repo path as a manifest by its file name; null when it is not one */
export function manifestKindForPath(path: string): ManifestKind | null {
  const slash = path.lastIndexOf("/");
  const base = path.slice(slash + 1);
  const lower = base.toLowerCase();
  if (base === "package.json") return "package_json";
  if (lower.startsWith("requirements") && lower.endsWith(".txt")) return "requirements_txt";
  if (base === "pyproject.toml") return "pyproject_toml";
  if (base === "Pipfile") return "pipfile";
  if (base === "go.mod") return "go_mod";
  if (base === "pom.xml") return "pom_xml";
  if (base === "build.gradle" || base === "build.gradle.kts") return "gradle_script";
  if (lower.endsWith(".versions.toml") && path.includes("gradle/")) return "gradle_catalog";
  if (lower.endsWith(".csproj") || lower.endsWith(".fsproj") || lower.endsWith(".vbproj") || base === "Directory.Packages.props") {
    return "nuget_project";
  }
  if (base === "packages.config") return "packages_config";
  if (base === "Gemfile") return "gemfile";
  if (base === "Cargo.toml") return "cargo_toml";
  return null;
}

/**
 * Line numbers for one file, computed once: the offsets of every newline are
 * indexed a single time and each lookup is a binary search. The search for a
 * needle resumes from the previous hit (manifests list dependencies in file
 * order), wrapping round once, so a whole manifest is located in about one
 * pass rather than one pass per dependency.
 */
export class LineLocator {
  private readonly newlines: number[] = [];
  private cursor = 0;

  constructor(private readonly content: string) {
    for (let i = content.indexOf("\n"); i !== -1; i = content.indexOf("\n", i + 1)) this.newlines.push(i);
  }

  /** the 1-based line holding character offset `at` */
  lineAt(at: number): number {
    let lo = 0;
    let hi = this.newlines.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.newlines[mid]! < at) lo = mid + 1;
      else hi = mid;
    }
    return lo + 1;
  }

  /** the line of the next occurrence of `needle` from the last hit (wrapping once), or null */
  line(needle: string): number | null {
    if (!needle) return null;
    let at = this.content.indexOf(needle, this.cursor);
    if (at === -1 && this.cursor > 0) at = this.content.indexOf(needle);
    if (at === -1) return null;
    this.cursor = at + needle.length;
    return this.lineAt(at);
  }
}

/** the 1-based line of the first occurrence of `needle`, or null (one-off lookups) */
export function lineOf(content: string, needle: string): number | null {
  const at = needle ? content.indexOf(needle) : -1;
  return at === -1 ? null : new LineLocator(content).lineAt(at);
}

/** PEP 508: the name ends at the first version, marker, extra or URL character */
export function pep508Name(spec: string): string | null {
  const s = spec.trim();
  let end = 0;
  while (end < s.length && end < NAME_MAX) {
    const c = s[end]!;
    const ok = (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || (c >= "0" && c <= "9") || c === "." || c === "_" || c === "-";
    if (!ok) break;
    end++;
  }
  return end > 0 ? s.slice(0, end) : null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

function tomlDoc(content: string): Record<string, unknown> | null {
  try {
    const doc = parseToml(content);
    return isRecord(doc) ? doc : null;
  } catch {
    return null;
  }
}

function push(out: RepoDependency[], seen: Set<string>, ecosystem: RepoEcosystem, name: string | null, loc: LineLocator, needle?: string): void {
  if (!name || name.length > NAME_MAX) return;
  const key = `${ecosystem}\u0000${name}`;
  if (seen.has(key)) return;
  seen.add(key);
  out.push({ ecosystem, name, line: loc.line(needle ?? name) });
}

function pyproject(doc: Record<string, unknown>, loc: LineLocator): RepoDependency[] {
  const out: RepoDependency[] = [];
  const seen = new Set<string>();
  const specs = (v: unknown) => {
    if (Array.isArray(v)) for (const s of v) if (typeof s === "string") push(out, seen, "pypi", pep508Name(s), loc);
  };
  const project = isRecord(doc.project) ? doc.project : {};
  specs(project.dependencies);
  if (isRecord(project["optional-dependencies"])) for (const v of Object.values(project["optional-dependencies"])) specs(v);
  if (isRecord(doc["dependency-groups"])) for (const v of Object.values(doc["dependency-groups"])) specs(v);
  const poetry = isRecord(doc.tool) && isRecord(doc.tool.poetry) ? doc.tool.poetry : null;
  const keys = (v: unknown) => {
    if (isRecord(v)) for (const k of Object.keys(v)) if (k.toLowerCase() !== "python") push(out, seen, "pypi", k, loc);
  };
  if (poetry) {
    keys(poetry.dependencies);
    keys(poetry["dev-dependencies"]);
    if (isRecord(poetry.group)) for (const g of Object.values(poetry.group)) if (isRecord(g)) keys(g.dependencies);
  }
  return out;
}

function pipfile(doc: Record<string, unknown>, loc: LineLocator): RepoDependency[] {
  const out: RepoDependency[] = [];
  const seen = new Set<string>();
  for (const section of ["packages", "dev-packages"]) {
    const v = doc[section];
    if (isRecord(v)) for (const k of Object.keys(v)) push(out, seen, "pypi", k, loc);
  }
  return out;
}

function cargo(doc: Record<string, unknown>, loc: LineLocator): RepoDependency[] {
  const out: RepoDependency[] = [];
  const seen = new Set<string>();
  const table = (v: unknown) => {
    if (!isRecord(v)) return;
    for (const [k, spec] of Object.entries(v)) {
      // `alias = { package = "real-name", ... }` declares real-name
      const real = isRecord(spec) && typeof spec.package === "string" ? spec.package : k;
      push(out, seen, "cargo", real, loc);
    }
  };
  for (const s of ["dependencies", "dev-dependencies", "build-dependencies"]) table(doc[s]);
  if (isRecord(doc.workspace)) table(doc.workspace.dependencies);
  if (isRecord(doc.target)) {
    for (const t of Object.values(doc.target)) {
      if (isRecord(t)) for (const s of ["dependencies", "dev-dependencies", "build-dependencies"]) table(t[s]);
    }
  }
  return out;
}

function gradleCatalog(doc: Record<string, unknown>, loc: LineLocator): RepoDependency[] {
  if (!isRecord(doc.libraries)) return [];
  const out: RepoDependency[] = [];
  const seen = new Set<string>();
  for (const lib of Object.values(doc.libraries)) {
    let coord: string | null = null;
    if (typeof lib === "string") coord = lib.split(":").slice(0, 2).join(":");
    else if (isRecord(lib)) {
      if (typeof lib.module === "string") coord = lib.module;
      else if (typeof lib.group === "string" && typeof lib.name === "string") coord = `${lib.group}:${lib.name}`;
    }
    if (coord && coord.split(":").length === 2) push(out, seen, "gradle", coord, loc, coord.split(":")[1]);
  }
  return out;
}

/** quoted substrings of a line, without a regex */
function quoted(line: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < line.length) {
    const q = line[i];
    if (q === '"' || q === "'") {
      const end = line.indexOf(q, i + 1);
      if (end === -1) break;
      out.push(line.slice(i + 1, end));
      i = end + 1;
    } else i++;
  }
  return out;
}

const COORD_OK = (s: string) => s.length > 0 && s.length <= 120 && [...s].every((c) => /[A-Za-z0-9._-]/.test(c));

/**
 * Gradle build scripts: the literal `group:artifact[:version]` strings on
 * lines that name a dependency configuration. A coordinate assembled from
 * variables or a version catalogue reference (`libs.x`) is invisible here.
 */
function gradleScript(content: string): RepoDependency[] {
  const out: RepoDependency[] = [];
  const seen = new Set<string>();
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.length > 2_000) continue;
    for (const q of quoted(line)) {
      const parts = q.split(":");
      if (parts.length < 2 || parts.length > 4 || !COORD_OK(parts[0]!) || !COORD_OK(parts[1]!) || !parts[0]!.includes(".")) continue;
      const name = `${parts[0]}:${parts[1]}`;
      const key = `gradle\u0000${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ ecosystem: "gradle", name, line: i + 1 });
    }
  }
  return out;
}

/** Gemfile: `gem "name"` lines (Ruby, read literally) */
function gemfile(content: string): RepoDependency[] {
  const out: RepoDependency[] = [];
  const seen = new Set<string>();
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i]!.trim();
    if (t.length > 2_000 || !(t.startsWith("gem ") || t.startsWith("gem("))) continue;
    const name = quoted(t)[0];
    if (!name || !COORD_OK(name)) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ ecosystem: "rubygems", name, line: i + 1 });
  }
  return out;
}

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  processEntities: false,
  htmlEntities: false,
  ignoreDeclaration: true,
  ignorePiTags: true,
  parseTagValue: false,
  parseAttributeValue: false,
  maxNestedTags: 64,
});

function xmlDoc(content: string): Record<string, unknown> | null {
  try {
    const doc: unknown = xml.parse(content);
    return isRecord(doc) ? doc : null;
  } catch {
    return null;
  }
}

/** visit every element named `tag` in a parsed XML tree (depth-bounded) */
function elements(node: unknown, tag: string, visit: (el: Record<string, unknown>) => void, depth = 0): void {
  if (depth > 64 || node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const n of node) elements(n, tag, visit, depth + 1);
    return;
  }
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (k === tag) for (const el of Array.isArray(v) ? v : [v]) if (isRecord(el)) visit(el);
    if (typeof v === "object") elements(v, tag, visit, depth + 1);
  }
}

const text = (v: unknown): string | null => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : null);

function pom(doc: Record<string, unknown>, loc: LineLocator): RepoDependency[] {
  const out: RepoDependency[] = [];
  const seen = new Set<string>();
  elements(doc, "dependency", (d) => {
    const g = text(d.groupId);
    const a = text(d.artifactId);
    if (g && a && COORD_OK(g) && COORD_OK(a)) push(out, seen, "maven", `${g}:${a}`, loc, `<artifactId>${a}</artifactId>`);
  });
  return out;
}

function nugetProject(doc: Record<string, unknown>, loc: LineLocator): RepoDependency[] {
  const out: RepoDependency[] = [];
  const seen = new Set<string>();
  for (const tag of ["PackageReference", "PackageVersion"]) {
    elements(doc, tag, (el) => {
      const id = text(el["@_Include"]) ?? text(el["@_Update"]);
      if (id && COORD_OK(id)) push(out, seen, "nuget", id, loc);
    });
  }
  return out;
}

function packagesConfig(doc: Record<string, unknown>, loc: LineLocator): RepoDependency[] {
  const out: RepoDependency[] = [];
  const seen = new Set<string>();
  elements(doc, "package", (el) => {
    const id = text(el["@_id"]);
    if (id && COORD_OK(id)) push(out, seen, "nuget", id, loc);
  });
  return out;
}

const lineFromOrigin = (origin: string): number | null =>
  origin.startsWith("line ") ? Number(origin.slice(5)) || null : null;

/**
 * Read one manifest. Total: an unreadable manifest yields no dependencies
 * (and `ok: false`) rather than throwing, so one broken file never stops a
 * repo scan.
 */
export function readManifest(kind: ManifestKind, content: string): { ok: boolean; dependencies: RepoDependency[] } {
  try {
    switch (kind) {
      case "package_json":
        return {
          ok: true,
          dependencies: (() => {
            const loc = new LineLocator(content);
            return dedupe(parsePackageJsonManifest(content).map((e) => ({ ecosystem: "npm" as const, name: e.name, line: loc.line(`"${e.name}"`) })));
          })(),
        };
      case "requirements_txt":
        return { ok: true, dependencies: dedupe(parseRequirementsManifest(content).map((e) => ({ ecosystem: "pypi" as const, name: e.name, line: lineFromOrigin(e.origin) }))) };
      case "go_mod":
        return { ok: true, dependencies: dedupe(parseGoModManifest(content).map((e) => ({ ecosystem: "go" as const, name: e.name, line: lineFromOrigin(e.origin) }))) };
      case "pyproject_toml":
        return wrap(content, pyproject, tomlDoc);
      case "pipfile":
        return wrap(content, pipfile, tomlDoc);
      case "cargo_toml":
        return wrap(content, cargo, tomlDoc);
      case "gradle_catalog":
        return wrap(content, gradleCatalog, tomlDoc);
      case "pom_xml":
        return wrap(content, pom, xmlDoc);
      case "nuget_project":
        return wrap(content, nugetProject, xmlDoc);
      case "packages_config":
        return wrap(content, packagesConfig, xmlDoc);
      case "gradle_script":
        return { ok: true, dependencies: gradleScript(content) };
      case "gemfile":
        return { ok: true, dependencies: gemfile(content) };
    }
  } catch {
    return { ok: false, dependencies: [] };
  }
}

/** parse ONCE, then read the dependencies from the parsed document */
function wrap(
  content: string,
  read: (doc: Record<string, unknown>, loc: LineLocator) => RepoDependency[],
  parse: (c: string) => Record<string, unknown> | null,
): { ok: boolean; dependencies: RepoDependency[] } {
  const doc = parse(content);
  if (doc === null) return { ok: false, dependencies: [] };
  return { ok: true, dependencies: read(doc, new LineLocator(content)) };
}

function dedupe(deps: RepoDependency[]): RepoDependency[] {
  const seen = new Set<string>();
  return deps.filter((d) => {
    const k = `${d.ecosystem}\u0000${d.name}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
