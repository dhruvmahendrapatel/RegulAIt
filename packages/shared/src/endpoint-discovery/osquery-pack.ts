/**
 * ADR-0195 SD3 decision 18 — THE OSQUERY QUERY PACK (no-agent option).
 *
 * RegulAIt ships QUERIES ONLY. osquery itself (Apache-2.0 / GPL-2.0 dual
 * licence) is the customer's, deployed through their own MDM or EDR; nothing
 * of osquery is bundled, linked or downloaded by RegulAIt.
 *
 * The pack is GENERATED from the enabled endpoint signature seed, so the
 * device filters only what the catalogue can match: a fleet does not ship its
 * whole software inventory to answer "which AI tools are installed". Each
 * query's definition also carries the column allowlist the importer applies,
 * so the pack and the importer cannot drift apart.
 *
 * WHAT THE PACK NEVER SELECTS: environment variable VALUES, process command
 * lines, file contents or hashes of them, registry value data, browsing
 * history. Only standard osquery tables are used; each query names its tables
 * and platform below and in the customer doc.
 *
 * VERIFICATION STATUS (M-041): the pack's JSON shape is validated by the test
 * suite. Executing it under osqueryi has NOT been done in this build
 * environment (osquery is not installed here); see
 * docs/deployment/ENDPOINT_QUERY_PACK.md "Verification status".
 */
import {
  ENDPOINT_SIGNATURE_SEED,
  endpointSeedValues,
  type EndpointExtensionEcosystem,
  type EndpointMatchType,
  type EndpointOs,
  type EndpointSignatureKind,
  type EndpointSignatureSeed,
} from "./endpoint-signatures.js";

export const ENDPOINT_PACK_NAME = "regulait_ai_discovery";
/** daily, ADR-0195 decision 9's default schedule */
export const ENDPOINT_PACK_INTERVAL_SECONDS = 86_400;

export type OsqueryPlatform = "darwin" | "windows" | "linux" | "posix" | "all";

/** What a column means to the importer. A column not listed for its query is discarded. */
export type EndpointColumnRole =
  | { role: "key"; matchTypes: ReadonlyArray<Exclude<EndpointMatchType, "trait_set" | "config_path" | "listening_port">> }
  /** a path: pseudonymised; contributes traits; optionally a config_path key or a basename key */
  | { role: "path"; configPath?: boolean; basenameAs?: "cli_binary" }
  | { role: "registry_key" }
  | { role: "user" }
  | { role: "port" }
  | { role: "address" }
  | { role: "version" }
  /** macOS apps.element: background agent flag */
  | { role: "element" }
  /** chrome_extensions.browser_type */
  | { role: "browser_type" }
  /** kept as a bounded informational string (publisher, vendor, protocol, file type) */
  | { role: "info" };

export interface EndpointPackQuery {
  name: string;
  platform: OsqueryPlatform;
  /** standard osquery tables this query reads */
  tables: readonly string[];
  /** the OS an observation from this query is on, when the platform pins it */
  os: EndpointOs | null;
  kindHint: EndpointSignatureKind;
  /** the ecosystem extension keys from this query belong to (browser_type refines chromium) */
  ecosystem?: EndpointExtensionEcosystem;
  description: string;
  columns: Readonly<Record<string, EndpointColumnRole>>;
  /** null when the seed has nothing for this query to look for: the query is then left out of the pack */
  sql: string | null;
}

/** Quote a list of seed values as SQL string literals. Values are validated
 * by the seed schema (no quotes, no backslashes); this re-checks and throws. */
function sqlList(values: readonly string[]): string {
  for (const v of values) {
    if ([...v].some((c) => c < " " || c > "~" || c === "'" || c === "\\" || c === '"')) {
      throw new Error(`a seed value is unsafe in a SQL literal: ${JSON.stringify(v)}`);
    }
  }
  return `(${values.map((v) => `'${v}'`).join(", ")})`;
}

/** SQL LIKE literal for a path: backslashes allowed here because the pattern is ours, quotes still refused */
function likeLit(pattern: string): string {
  if ([...pattern].some((c) => c < " " || c > "~" || c === "'")) throw new Error(`unsafe LIKE pattern ${JSON.stringify(pattern)}`);
  return `'${pattern}'`;
}

const nonEmpty = (xs: readonly string[]) => xs.length > 0;
const anyOf = (clauses: ReadonlyArray<string | null>) => clauses.filter((c): c is string => c !== null).join(" OR ");

/** binary install locations searched for AI CLIs, per OS. `%` is the per-user wildcard. */
const CLI_DIRS: Record<EndpointOs, readonly string[]> = {
  darwin: ["/usr/local/bin/", "/opt/homebrew/bin/", "/Users/%/.local/bin/", "/Users/%/.npm-global/bin/"],
  linux: ["/usr/local/bin/", "/usr/bin/", "/home/%/.local/bin/", "/home/%/.npm-global/bin/", "/root/.local/bin/"],
  windows: ["C:\\Users\\%\\AppData\\Roaming\\npm\\"],
};

const HOME_PREFIX: Record<EndpointOs, readonly string[]> = {
  darwin: ["/Users/%/"],
  linux: ["/home/%/", "/root/"],
  windows: ["C:\\Users\\%\\"],
};

/** Build the pack queries from a seed (the shipped seed by default). */
export function buildEndpointPackQueries(seed: readonly EndpointSignatureSeed[] = ENDPOINT_SIGNATURE_SEED): EndpointPackQuery[] {
  const v = (mt: EndpointMatchType, opts: Parameters<typeof endpointSeedValues>[1] = {}) =>
    endpointSeedValues(mt, { ...opts, seed });

  const macAppNames = v("app_name", { os: "darwin" });
  const macBundles = v("bundle_id", { os: "darwin" });
  const winAppNames = v("app_name", { os: "windows" });
  const procNames = [
    ...new Set([...v("process_name"), ...v("executable_name"), ...v("cli_binary")]),
  ].sort();
  const vscodeIds = v("ide_extension_id", { ecosystems: ["vscode"] });
  const jetbrainsIds = v("ide_extension_id", { ecosystems: ["jetbrains"] });
  const chromiumIds = v("browser_extension_id", { ecosystems: ["chrome", "edge"] });
  const firefoxIds = v("browser_extension_id", { ecosystems: ["firefox"] });
  const safariIds = v("browser_extension_id", { ecosystems: ["safari"] });
  const runtimeProcs = [
    ...new Set(
      seed
        .filter((s) => s.enabled && s.kind === "local_runtime" && (s.matchType === "process_name" || s.matchType === "executable_name" || s.matchType === "cli_binary"))
        .map((s) => s.value.toLowerCase()),
    ),
  ].sort();
  // package names: app names and local runtime names only. CLI binary names ('gemini', 'codex') are too often
  // the names of unrelated distribution packages to be read as AI tools.
  const linuxPkgNames = [...new Set([...v("app_name", { os: "linux" }), ...runtimeProcs])].filter((n) => !n.includes(" ")).sort();
  const ports = v("listening_port");
  const npmPkgs = v("npm_package");
  const envNames = v("env_var_name");
  const cliBins = v("cli_binary");

  const pathOr = (patterns: readonly string[]) => patterns.map((p) => `path LIKE ${likeLit(p)}`).join(" OR ");
  const configPatterns = (os: EndpointOs) =>
    v("config_path", { os }).flatMap((rel) =>
      HOME_PREFIX[os].map((h) => h + (os === "windows" ? rel.split("/").join("\\") : rel)),
    );
  const cliPatterns = (os: EndpointOs) =>
    cliBins.flatMap((b) => CLI_DIRS[os].flatMap((d) => (os === "windows" ? [`${d}${b}.cmd`, `${d}${b}.exe`] : [`${d}${b}`])));

  const q: EndpointPackQuery[] = [
    {
      name: "ai_apps_macos",
      platform: "darwin",
      tables: ["apps"],
      os: "darwin",
      kindHint: "desktop_app",
      description: "Installed macOS applications whose bundle name or bundle identifier is in the AI catalogue.",
      columns: {
        name: { role: "key", matchTypes: ["app_name"] },
        bundle_identifier: { role: "key", matchTypes: ["bundle_id"] },
        bundle_short_version: { role: "version" },
        path: { role: "path" },
        element: { role: "element" },
      },
      sql:
        nonEmpty(macAppNames) || nonEmpty(macBundles)
          ? `SELECT name, bundle_identifier, bundle_short_version, path, element FROM apps WHERE ${anyOf([
              nonEmpty(macAppNames) ? `lower(name) IN ${sqlList(macAppNames)}` : null,
              nonEmpty(macBundles) ? `lower(bundle_identifier) IN ${sqlList(macBundles)}` : null,
            ])};`
          : null,
    },
    {
      name: "ai_programs_windows",
      platform: "windows",
      tables: ["programs"],
      os: "windows",
      kindHint: "desktop_app",
      description: "Installed Windows programs whose display name is in the AI catalogue (exact name; a display name that carries a version number is not matched).",
      columns: {
        name: { role: "key", matchTypes: ["app_name"] },
        version: { role: "version" },
        publisher: { role: "info" },
      },
      sql: nonEmpty(winAppNames) ? `SELECT name, version, publisher FROM programs WHERE lower(name) IN ${sqlList(winAppNames)};` : null,
    },
    {
      name: "ai_deb_packages_linux",
      platform: "linux",
      tables: ["deb_packages"],
      os: "linux",
      kindHint: "desktop_app",
      description: "Debian packages whose name matches an AI app or local runtime name in the catalogue.",
      columns: { name: { role: "key", matchTypes: ["app_name", "process_name"] }, version: { role: "version" } },
      sql: nonEmpty(linuxPkgNames) ? `SELECT name, version FROM deb_packages WHERE lower(name) IN ${sqlList(linuxPkgNames)};` : null,
    },
    {
      name: "ai_rpm_packages_linux",
      platform: "linux",
      tables: ["rpm_packages"],
      os: "linux",
      kindHint: "desktop_app",
      description: "RPM packages whose name matches an AI app or local runtime name in the catalogue.",
      columns: { name: { role: "key", matchTypes: ["app_name", "process_name"] }, version: { role: "version" } },
      sql: nonEmpty(linuxPkgNames) ? `SELECT name, version FROM rpm_packages WHERE lower(name) IN ${sqlList(linuxPkgNames)};` : null,
    },
    {
      name: "ai_running_processes",
      platform: "all",
      tables: ["processes"],
      os: null,
      kindHint: "desktop_app",
      description: "Running processes whose name is an AI app executable, AI CLI or local runtime in the catalogue. The command line is never selected.",
      columns: {
        name: { role: "key", matchTypes: ["process_name", "executable_name", "cli_binary"] },
        path: { role: "path" },
      },
      sql: nonEmpty(procNames) ? `SELECT name, path FROM processes WHERE lower(name) IN ${sqlList(procNames)};` : null,
    },
    {
      name: "ai_ide_extensions_vscode",
      platform: "all",
      tables: ["users", "vscode_extensions"],
      os: null,
      kindHint: "ide_extension",
      ecosystem: "vscode",
      description: "VS Code-family editor extensions (publisher.name) in the AI catalogue, per local user.",
      columns: {
        username: { role: "user" },
        extension_id: { role: "key", matchTypes: ["ide_extension_id"] },
        version: { role: "version" },
        vscode_edition: { role: "info" },
      },
      sql: nonEmpty(vscodeIds)
        ? `SELECT u.username AS username, lower(e.publisher || '.' || e.name) AS extension_id, e.version AS version, e.vscode_edition AS vscode_edition FROM users u CROSS JOIN vscode_extensions e USING (uid) WHERE lower(e.publisher || '.' || e.name) IN ${sqlList(vscodeIds)};`
        : null,
    },
    {
      name: "ai_ide_extensions_jetbrains",
      platform: "all",
      tables: ["users", "jetbrains_plugins"],
      os: null,
      kindHint: "ide_extension",
      ecosystem: "jetbrains",
      description: "JetBrains IDE plugins whose name is in the AI catalogue, per local user.",
      columns: {
        username: { role: "user" },
        name: { role: "key", matchTypes: ["ide_extension_id"] },
        version: { role: "version" },
        vendor: { role: "info" },
        product_type: { role: "info" },
      },
      sql: nonEmpty(jetbrainsIds)
        ? `SELECT u.username AS username, p.name AS name, p.version AS version, p.vendor AS vendor, p.product_type AS product_type FROM users u CROSS JOIN jetbrains_plugins p USING (uid) WHERE lower(p.name) IN ${sqlList(jetbrainsIds)};`
        : null,
    },
    {
      name: "ai_browser_extensions_chromium",
      platform: "all",
      tables: ["users", "chrome_extensions"],
      os: null,
      kindHint: "browser_extension",
      ecosystem: "chrome",
      description: "Chromium-family browser extensions (Chrome, Edge and others osquery reads) whose id is in the AI catalogue, per local user.",
      columns: {
        username: { role: "user" },
        browser_type: { role: "browser_type" },
        identifier: { role: "key", matchTypes: ["browser_extension_id"] },
        name: { role: "info" },
        version: { role: "version" },
      },
      sql: nonEmpty(chromiumIds)
        ? `SELECT u.username AS username, c.browser_type AS browser_type, c.identifier AS identifier, c.name AS name, c.version AS version FROM users u CROSS JOIN chrome_extensions c USING (uid) WHERE lower(c.identifier) IN ${sqlList(chromiumIds)};`
        : null,
    },
    {
      name: "ai_browser_extensions_firefox",
      platform: "all",
      tables: ["users", "firefox_addons"],
      os: null,
      kindHint: "browser_extension",
      ecosystem: "firefox",
      description: "Firefox add-ons whose id is in the AI catalogue, per local user.",
      columns: {
        username: { role: "user" },
        identifier: { role: "key", matchTypes: ["browser_extension_id"] },
        name: { role: "info" },
        version: { role: "version" },
      },
      sql: nonEmpty(firefoxIds)
        ? `SELECT u.username AS username, f.identifier AS identifier, f.name AS name, f.version AS version FROM users u CROSS JOIN firefox_addons f USING (uid) WHERE lower(f.identifier) IN ${sqlList(firefoxIds)};`
        : null,
    },
    {
      name: "ai_browser_extensions_safari",
      platform: "darwin",
      tables: ["users", "safari_extensions"],
      os: "darwin",
      kindHint: "browser_extension",
      ecosystem: "safari",
      description: "Safari extensions whose identifier is in the AI catalogue, per local user.",
      columns: {
        username: { role: "user" },
        identifier: { role: "key", matchTypes: ["browser_extension_id"] },
        name: { role: "info" },
        version: { role: "version" },
      },
      sql: nonEmpty(safariIds)
        ? `SELECT u.username AS username, s.identifier AS identifier, s.name AS name, s.version AS version FROM users u CROSS JOIN safari_extensions s USING (uid) WHERE lower(s.identifier) IN ${sqlList(safariIds)};`
        : null,
    },
    {
      name: "ai_local_runtime_listeners",
      platform: "all",
      tables: ["listening_ports", "processes"],
      os: null,
      kindHint: "local_runtime",
      description: "Listening sockets owned by a local model runtime, or on a local runtime's default port. The command line is never selected.",
      columns: {
        name: { role: "key", matchTypes: ["process_name", "executable_name", "cli_binary"] },
        path: { role: "path" },
        port: { role: "port" },
        address: { role: "address" },
        protocol: { role: "info" },
      },
      sql:
        nonEmpty(runtimeProcs) || nonEmpty(ports)
          ? `SELECT p.name AS name, p.path AS path, l.port AS port, l.address AS address, l.protocol AS protocol FROM listening_ports l JOIN processes p USING (pid) WHERE ${anyOf([
              nonEmpty(runtimeProcs) ? `lower(p.name) IN ${sqlList(runtimeProcs)}` : null,
              nonEmpty(ports) ? `l.port IN (${ports.map(Number).join(", ")})` : null,
            ])};`
          : null,
    },
    {
      name: "ai_cli_npm_global",
      platform: "all",
      tables: ["npm_packages"],
      os: null,
      kindHint: "desktop_app",
      description: "Globally installed npm packages that are AI CLIs in the catalogue.",
      columns: { name: { role: "key", matchTypes: ["npm_package"] }, version: { role: "version" }, path: { role: "path" } },
      sql: nonEmpty(npmPkgs) ? `SELECT name, version, path FROM npm_packages WHERE lower(name) IN ${sqlList(npmPkgs)};` : null,
    },
    ...(["darwin", "linux", "windows"] as const).map(
      (os): EndpointPackQuery => ({
        name: `ai_cli_binaries_${os === "darwin" ? "macos" : os}`,
        platform: os,
        tables: ["file"],
        os,
        kindHint: "desktop_app",
        description: "AI CLI binaries present in common install directories. Name, path and type only; the file is never read or hashed.",
        columns: { path: { role: "path", basenameAs: "cli_binary" }, type: { role: "info" } },
        sql: nonEmpty(cliBins) ? `SELECT path, type FROM file WHERE ${pathOr(cliPatterns(os))};` : null,
      }),
    ),
    {
      name: "ai_env_var_names_posix",
      platform: "posix",
      tables: ["process_envs", "processes"],
      os: null,
      kindHint: "assistant_config",
      description: "NAMES of AI-related environment variables set in running processes. The value is never selected.",
      columns: {
        process_name: { role: "key", matchTypes: ["process_name"] },
        key: { role: "key", matchTypes: ["env_var_name"] },
      },
      sql: nonEmpty(envNames)
        ? `SELECT DISTINCT p.name AS process_name, e.key AS key FROM process_envs e JOIN processes p USING (pid) WHERE e.key IN ${sqlList(envNames)};`
        : null,
    },
    {
      name: "ai_env_var_names_windows",
      platform: "windows",
      tables: ["registry"],
      os: "windows",
      kindHint: "assistant_config",
      description: "NAMES of AI-related environment variables in the per-user and system environment registry keys. The value data is never selected.",
      columns: { key: { role: "registry_key" }, name: { role: "key", matchTypes: ["env_var_name"] } },
      sql: nonEmpty(envNames)
        ? `SELECT key, name FROM registry WHERE (key LIKE 'HKEY_USERS\\%\\Environment' OR key = 'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment') AND name IN ${sqlList(envNames)};`
        : null,
    },
    ...(["darwin", "linux", "windows"] as const).map((os): EndpointPackQuery => {
      const pats = configPatterns(os);
      return {
        name: `ai_config_files_${os === "darwin" ? "macos" : os}`,
        platform: os,
        tables: ["file"],
        os,
        kindHint: "assistant_config",
        description: "AI assistant and MCP config files or directories present in user homes. Path, type and modification time only; contents are never read or hashed.",
        columns: { path: { role: "path", configPath: true }, type: { role: "info" }, mtime: { role: "info" } },
        sql: nonEmpty(pats) ? `SELECT path, type, mtime FROM file WHERE ${pathOr(pats)};` : null,
      };
    }),
    {
      name: "hidden_assistant_lan_listeners",
      platform: "all",
      tables: ["listening_ports", "processes"],
      os: null,
      kindHint: "local_runtime",
      description: "Programs run from a user, hidden or temp directory that accept connections on every interface (LAN remote control). A trait lead; the command line is never selected.",
      columns: {
        name: { role: "key", matchTypes: ["process_name"] },
        path: { role: "path" },
        port: { role: "port" },
        address: { role: "address" },
        protocol: { role: "info" },
      },
      sql:
        "SELECT p.name AS name, p.path AS path, l.port AS port, l.address AS address, l.protocol AS protocol FROM listening_ports l JOIN processes p USING (pid) " +
        "WHERE l.address IN ('0.0.0.0', '::') AND (p.path LIKE '/Users/%' OR p.path LIKE '/home/%' OR p.path LIKE '/tmp/%' OR p.path LIKE '/private/tmp/%' OR p.path LIKE '/var/folders/%' OR p.path LIKE 'C:\\Users\\%');",
    },
    {
      name: "hidden_assistant_background_apps_macos",
      platform: "darwin",
      tables: ["apps"],
      os: "darwin",
      kindHint: "desktop_app",
      description: "User-installed macOS apps that declare themselves background agents (no Dock icon or window). A trait lead.",
      columns: {
        name: { role: "key", matchTypes: ["app_name"] },
        bundle_identifier: { role: "key", matchTypes: ["bundle_id"] },
        path: { role: "path" },
        element: { role: "element" },
      },
      sql: "SELECT name, bundle_identifier, path, element FROM apps WHERE path LIKE '/Users/%' AND (element = '1' OR element = 'true');",
    },
  ];
  return q;
}

/** The queries of the shipped pack (only those with something to look for). */
export const ENDPOINT_PACK_QUERIES: ReadonlyArray<EndpointPackQuery> = Object.freeze(
  buildEndpointPackQueries().filter((q) => q.sql !== null),
);

export interface OsqueryPackJson {
  queries: Record<
    string,
    { query: string; interval: number; platform?: string; description: string; snapshot: true; removed: false }
  >;
}

/** The osquery pack document (osquery's pack format: a `queries` map). */
export function buildOsqueryPack(queries: readonly EndpointPackQuery[] = ENDPOINT_PACK_QUERIES): OsqueryPackJson {
  const out: OsqueryPackJson = { queries: {} };
  for (const q of queries) {
    if (q.sql === null) continue;
    out.queries[q.name] = {
      query: q.sql,
      interval: ENDPOINT_PACK_INTERVAL_SECONDS,
      ...(q.platform === "all" ? {} : { platform: q.platform }),
      description: `${q.description} Tables: ${q.tables.join(", ")}.`,
      snapshot: true,
      removed: false,
    };
  }
  return out;
}

/** The exact bytes of the shipped pack file (stable key order, two-space indent, trailing newline). */
export function renderOsqueryPack(queries: readonly EndpointPackQuery[] = ENDPOINT_PACK_QUERIES): string {
  return `${JSON.stringify(buildOsqueryPack(queries), null, 2)}\n`;
}

export function getEndpointPackQuery(name: string): EndpointPackQuery | undefined {
  return ENDPOINT_PACK_QUERIES.find((q) => q.name === name);
}
