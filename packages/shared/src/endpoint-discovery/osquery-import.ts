/**
 * ADR-0195 SD3 — osquery results importer (`endpoint_osquery`).
 *
 * Reads the results osqueryd writes for the RegulAIt pack — the filesystem
 * logger's JSON lines, or the same records as one JSON array — in any of
 * osquery's three result shapes:
 *   - event format (one row per line, `columns` + `action: added|removed`);
 *   - snapshot format (`snapshot: [rows]`, `action: snapshot`), which the pack uses;
 *   - batch format (`diffResults: { added: [rows], removed: [rows] }`).
 *
 * NEVER TRUST THE FILE (the ADR-0071 rules, applied here):
 *   - bytes, rows, line length and cell length are bounded before anything is kept;
 *   - every row that is not imported is REFUSED with its line number and counted;
 *     `observations + refusals + removedRows === rowsParsed` always;
 *   - only the columns the pack query allowlists are read; others are discarded,
 *     `decorations` are discarded whole (they can carry a username);
 *   - a row carrying a forbidden column (a value, a command line, contents) is
 *     refused and the cell is never copied;
 *   - usernames, SIDs and device names leave this module only as pseudonyms
 *     from the caller's hook (ADR-0195 decision 20); there is no default hook;
 *   - character scanning only, no regex over file content.
 */
import { pseudonymisePath, pseudonymiseRegistryKey, guardPseudonymHook, type EndpointPseudonymHook } from "./pseudonym.js";
import { ENDPOINT_PACK_NAME, getEndpointPackQuery, type EndpointPackQuery } from "./osquery-pack.js";
import type { EndpointExtensionEcosystem, EndpointObservationKey, EndpointOs, EndpointTrait } from "./endpoint-signatures.js";
import {
  isEnvVarName,
  isForbiddenColumn,
  normaliseColumnName,
  ENDPOINT_IMPORT_MAX_BYTES,
  ENDPOINT_IMPORT_MAX_CELL,
  ENDPOINT_IMPORT_MAX_LINE_BYTES,
  ENDPOINT_IMPORT_MAX_ROWS,
  EndpointImportFormatError,
  type EndpointImportResult,
  type EndpointObservation,
  type EndpointRowRefusal,
} from "./observation.js";

export interface OsqueryImportOptions {
  content: string;
  pseudonymise: EndpointPseudonymHook;
  /** the key the customer gave the pack in their osquery config (default `regulait_ai_discovery`) */
  packName?: string;
  /** the query set to accept (the shipped pack by default); tests inject others */
  resolveQuery?: (name: string) => EndpointPackQuery | undefined;
}

const isPackNameChar = (c: string) => (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || (c >= "0" && c <= "9") || c === "_" || c === "-";

/** `pack<d><packName><d><query>` for any one-character delimiter d, or a bare query name. */
export function resolveOsqueryResultName(name: string, packName: string): string {
  if (name.startsWith("pack") && name.length > 5) {
    const d = name[4]!;
    const prefix = `pack${d}${packName}${d}`;
    if (name.startsWith(prefix)) return name.slice(prefix.length);
  }
  return name;
}

function parseUnixTime(raw: unknown): string | null {
  let n: number | null = null;
  if (typeof raw === "number" && Number.isInteger(raw)) n = raw;
  else if (typeof raw === "string" && raw.length > 0 && raw.length <= 12 && [...raw].every((c) => c >= "0" && c <= "9")) n = Number(raw);
  // 2000-01-01 .. 2100-01-01
  if (n === null || n < 946_684_800 || n > 4_102_444_800) return null;
  return new Date(n * 1000).toISOString();
}

const lower = (s: string) => s.toLowerCase();

function inferOs(path: string | null): EndpointOs | null {
  if (!path) return null;
  if (path.length >= 3 && path[1] === ":" && (path[2] === "\\" || path[2] === "/")) return "windows";
  if (path.startsWith("/Users/") || path.startsWith("/Applications/") || path.startsWith("/System/") || path.startsWith("/opt/homebrew/")) return "darwin";
  if (path.startsWith("/home/") || path.startsWith("/usr/") || path.startsWith("/snap/")) return "linux";
  return null;
}

function pathTraits(raw: string, homeRelative: string | null): EndpointTrait[] {
  const t: EndpointTrait[] = [];
  const p = lower(raw.split("\\").join("/"));
  const temp = p.startsWith("/tmp/") || p.startsWith("/private/tmp/") || p.startsWith("/var/folders/") || p.includes("/appdata/local/temp/");
  if (homeRelative !== null || temp || p.includes("/appdata/")) t.push("user_writable_path");
  if (p.split("/").some((seg) => seg.length > 1 && seg.startsWith(".") && seg !== "..")) t.push("hidden_path");
  return t;
}

function basename(raw: string): string {
  const p = raw.split("\\").join("/");
  const b = p.slice(p.lastIndexOf("/") + 1);
  const l = lower(b);
  return l.endsWith(".cmd") || l.endsWith(".exe") ? b.slice(0, -4) : b;
}

function isPort(v: string): boolean {
  if (v.length === 0 || v.length > 5 || ![...v].every((c) => c >= "0" && c <= "9")) return false;
  const n = Number(v);
  return n >= 1 && n <= 65535;
}

interface LineRecord {
  line: number;
  value: unknown;
}

function splitRecords(content: string): LineRecord[] {
  const trimmed = content.trimStart();
  if (trimmed.startsWith("[")) {
    let doc: unknown;
    try {
      doc = JSON.parse(content);
    } catch (e) {
      // the parser's message quotes a snippet of the file: never repeated
      void e;
      throw new EndpointImportFormatError("the file starts like a JSON array but is not valid JSON", {
        importer: "endpoint_osquery",
      });
    }
    if (!Array.isArray(doc)) throw new EndpointImportFormatError("a JSON results file must be an array of result records", { importer: "endpoint_osquery" });
    return doc.map((value, i) => ({ line: i + 1, value }));
  }
  const out: LineRecord[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    let text = lines[i]!;
    if (text.endsWith("\r")) text = text.slice(0, -1);
    if (text.trim().length === 0) continue;
    if (text.length > ENDPOINT_IMPORT_MAX_LINE_BYTES) {
      out.push({ line: i + 1, value: Symbol.for("too-long") });
      continue;
    }
    try {
      out.push({ line: i + 1, value: JSON.parse(text) });
    } catch {
      out.push({ line: i + 1, value: Symbol.for("not-json") });
    }
  }
  return out;
}

export function importOsqueryResults(opts: OsqueryImportOptions): EndpointImportResult {
  const pseudonymise = guardPseudonymHook(opts.pseudonymise);
  const packName = opts.packName ?? ENDPOINT_PACK_NAME;
  if (packName.length === 0 || packName.length > 100 || ![...packName].every(isPackNameChar)) {
    throw new EndpointImportFormatError("packName is letters, digits, '_' or '-' (1..100)", { importer: "endpoint_osquery" });
  }
  if (Buffer.byteLength(opts.content, "utf8") > ENDPOINT_IMPORT_MAX_BYTES) {
    throw new EndpointImportFormatError(`the file is over the ${ENDPOINT_IMPORT_MAX_BYTES}-byte endpoint import bound — split the export`, {
      importer: "endpoint_osquery",
    });
  }
  const resolve = opts.resolveQuery ?? getEndpointPackQuery;

  const observations: EndpointObservation[] = [];
  const refusals: EndpointRowRefusal[] = [];
  const devices = new Set<string>();
  let removedRows = 0;
  let rowsParsed = 0;
  let rowsWithoutTimestamp = 0;

  const count = (n: number) => {
    rowsParsed += n;
    if (rowsParsed > ENDPOINT_IMPORT_MAX_ROWS) {
      throw new EndpointImportFormatError(`the file carries more than ${ENDPOINT_IMPORT_MAX_ROWS} result rows — split the export`, {
        importer: "endpoint_osquery",
      });
    }
  };

  for (const rec of splitRecords(opts.content)) {
    const { line, value } = rec;
    if (typeof value === "symbol") {
      count(1);
      refusals.push({
        line,
        reason: value === Symbol.for("too-long") ? `the line is over ${ENDPOINT_IMPORT_MAX_LINE_BYTES} characters` : "the line is not valid JSON",
      });
      continue;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      count(1);
      refusals.push({ line, reason: "a result record is a JSON object" });
      continue;
    }
    const r = value as Record<string, unknown>;

    // collect the rows this record carries, and how many were removals
    let rows: unknown[] = [];
    let removed = 0;
    if (Array.isArray(r.snapshot)) {
      rows = r.snapshot;
    } else if (r.diffResults && typeof r.diffResults === "object") {
      const d = r.diffResults as Record<string, unknown>;
      rows = Array.isArray(d.added) ? d.added : [];
      removed = Array.isArray(d.removed) ? d.removed.length : 0;
    } else if (r.columns !== undefined) {
      if (r.action === "removed") removed = 1;
      else rows = [r.columns];
    } else {
      count(1);
      refusals.push({ line, reason: "the record carries none of `snapshot`, `diffResults` or `columns` — not an osquery result record" });
      continue;
    }
    count(rows.length + removed);
    removedRows += removed;
    if (rows.length === 0) continue;

    const refuseAll = (reason: string, field?: string) => {
      rows.forEach((_, item) => refusals.push({ line, ...(rows.length > 1 ? { item } : {}), reason, ...(field ? { field } : {}) }));
    };

    const host = r.hostIdentifier;
    if (typeof host !== "string" || host.trim().length === 0 || host.length > 255) {
      refuseAll("the record has no usable `hostIdentifier` — an observation with no device observes nothing", "hostIdentifier");
      continue;
    }
    if (typeof r.name !== "string" || r.name.length === 0 || r.name.length > 255) {
      refuseAll("the record has no query `name`", "name");
      continue;
    }
    const queryName = resolveOsqueryResultName(r.name, packName);
    const query = resolve(queryName);
    if (!query) {
      refuseAll("the record's query is not one of the RegulAIt pack — results of other queries are not imported", "name");
      continue;
    }
    const device = pseudonymise({ kind: "device", value: host.trim() });
    const observedAt = parseUnixTime(r.unixTime);

    rows.forEach((row, idx) => {
      const item = rows.length > 1 ? { item: idx } : {};
      const refuse = (reason: string, field?: string) => refusals.push({ line, ...item, reason, ...(field ? { field } : {}) });
      if (typeof row !== "object" || row === null || Array.isArray(row)) return refuse("a result row is a JSON object of column values");
      const cols = row as Record<string, unknown>;
      const forbiddenKey = Object.keys(cols).find((k) => isForbiddenColumn(k));
      if (forbiddenKey) {
        const forbidden = normaliseColumnName(forbiddenKey);
        return refuse(`the row carries the value-bearing column '${forbidden}' — values, command lines and contents are never imported; the row is refused and the cell discarded`, forbidden);
      }
      const cells = new Map<string, string>();
      for (const col of Object.keys(query.columns)) {
        const v = cols[col];
        if (v === undefined || v === null) continue;
        if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") return refuse(`column '${col}' is not a scalar`, col);
        const s = String(v);
        if (s.length > ENDPOINT_IMPORT_MAX_CELL) return refuse(`column '${col}' is over ${ENDPOINT_IMPORT_MAX_CELL} characters`, col);
        cells.set(col, s);
      }
      const r2 = buildObservation(query, cells, pseudonymise);
      if (!r2.ok) return refuse(r2.reason, r2.field);
      const obs: EndpointObservation = {
        source: "endpoint_osquery",
        line,
        ...item,
        query: query.name,
        kindHint: query.kindHint,
        device,
        user: r2.user,
        os: query.os ?? inferOs(r2.rawPath),
        observedAt,
        keys: r2.keys,
        traits: r2.traits,
        location: r2.location,
        version: r2.version,
        info: r2.info,
      };
      if (observedAt === null) rowsWithoutTimestamp += 1;
      devices.add(device);
      observations.push(obs);
    });
  }

  return {
    source: "endpoint_osquery",
    observations,
    refusals,
    removedRows,
    rowsParsed,
    rowsWithoutTimestamp,
    devices: devices.size,
  };
}

type Built =
  | {
      ok: true;
      keys: EndpointObservationKey[];
      traits: EndpointTrait[];
      user: string | null;
      location: string | null;
      rawPath: string | null;
      version: string | null;
      info: Record<string, string>;
    }
  | { ok: false; reason: string; field?: string };

function buildObservation(query: EndpointPackQuery, cells: Map<string, string>, pseudonymise: EndpointPseudonymHook): Built {
  let ecosystem: EndpointExtensionEcosystem | undefined = query.ecosystem;
  for (const [col, role] of Object.entries(query.columns)) {
    if (role.role === "browser_type" && cells.has(col)) ecosystem = lower(cells.get(col)!).startsWith("edge") ? "edge" : "chrome";
  }
  const keys: EndpointObservationKey[] = [];
  const traits = new Set<EndpointTrait>();
  const info: Record<string, string> = {};
  let user: string | null = null;
  let location: string | null = null;
  let rawPath: string | null = null;
  let version: string | null = null;
  const addKey = (k: EndpointObservationKey) => {
    if (!keys.some((x) => x.matchType === k.matchType && x.value === k.value)) keys.push(k);
  };

  for (const [col, role] of Object.entries(query.columns)) {
    const raw = cells.get(col);
    if (raw === undefined || raw.trim().length === 0) continue;
    const value = raw.trim();
    switch (role.role) {
      case "key":
        if (role.matchTypes.includes("env_var_name") && !isEnvVarName(value)) {
          return { ok: false, reason: `column '${col}' is not an environment variable name — names only, never values`, field: col };
        }
        for (const mt of role.matchTypes) {
          const isExt = mt === "ide_extension_id" || mt === "browser_extension_id";
          addKey({ matchType: mt, value, ...(isExt && ecosystem ? { ecosystem } : {}) });
        }
        break;
      case "path": {
        const p = pseudonymisePath(value, pseudonymise);
        rawPath = value;
        location = p.path;
        if (p.userPseudonym) user = p.userPseudonym;
        for (const t of pathTraits(value, p.homeRelative)) traits.add(t);
        if (role.configPath && p.homeRelative !== null && p.homeRelative.length > 0) addKey({ matchType: "config_path", value: p.homeRelative });
        if (role.basenameAs) {
          const b = basename(value);
          if (b.length > 0) addKey({ matchType: role.basenameAs, value: b });
        }
        break;
      }
      case "registry_key": {
        const k = pseudonymiseRegistryKey(value, pseudonymise);
        location = k.key;
        if (k.userPseudonym) user = k.userPseudonym;
        break;
      }
      case "user":
        user = pseudonymise({ kind: "device_user", value });
        break;
      case "port":
        if (!isPort(value)) return { ok: false, reason: `the ${col} column is not a port number 1..65535`, field: col };
        addKey({ matchType: "listening_port", value: String(Number(value)) });
        break;
      case "address":
        // only the fact is kept; a concrete LAN address is not stored
        if (value === "0.0.0.0" || value === "::" || value === "*") traits.add("listen_all_interfaces");
        break;
      case "element":
        if (value === "1" || lower(value) === "true") traits.add("background_agent");
        break;
      case "version":
        version = value;
        break;
      case "browser_type":
      case "info":
        info[col] = value;
        break;
    }
  }
  if (keys.length === 0 && traits.size === 0) {
    return { ok: false, reason: "the row carries no value the catalogue can match (every key column is empty)" };
  }
  return { ok: true, keys, traits: [...traits].sort(), user, location, rawPath, version, info };
}
