/**
 * ADR-0195 SD3 — generic MDM/EDR inventory importer (`endpoint_inventory`).
 *
 * Decision 12: no vendor-named MDM or EDR presets. A software inventory export
 * comes in as CSV or JSON with an operator-declared column mapping, or a
 * header inference that REFUSES ON AMBIGUITY, exactly as `generic_mapped`
 * does for evidence (ADR-0071). Table reading reuses ADR-0069's
 * `readSourceTable` (RFC-4180 CSV with true line numbers, and JSON).
 *
 * Every row not imported is refused with its line and counted; unmapped
 * columns are discarded; device names and users leave only as pseudonyms
 * (decision 20).
 */
import { z } from "zod";
import { CostImportFormatError, readSourceTable } from "../cost-import.js";
import { parseEvidenceTimestamp } from "../evidence-adapters.js";
import { guardPseudonymHook, type EndpointPseudonymHook } from "./pseudonym.js";
import type { EndpointObservationKey, EndpointOs, EndpointSignatureKind } from "./endpoint-signatures.js";
import {
  isForbiddenColumn,
  ENDPOINT_IMPORT_MAX_BYTES,
  ENDPOINT_IMPORT_MAX_CELL,
  ENDPOINT_IMPORT_MAX_ROWS,
  EndpointImportFormatError,
  type EndpointImportResult,
  type EndpointObservation,
  type EndpointRowRefusal,
} from "./observation.js";

export const INVENTORY_FIELDS = ["device", "itemName", "itemId", "itemType", "version", "publisher", "user", "os", "observedAt"] as const;
export type InventoryField = (typeof INVENTORY_FIELDS)[number];
const REQUIRED: readonly InventoryField[] = ["device", "itemName"];

export const INVENTORY_ITEM_CLASSES = ["application", "ide_extension", "browser_extension", "package", "process"] as const;
export type InventoryItemClass = (typeof INVENTORY_ITEM_CLASSES)[number];

/** header candidates per field, used ONLY for inference, which refuses on ambiguity */
const ALIASES: Record<InventoryField, readonly string[]> = {
  device: ["device", "device_name", "hostname", "host", "computer", "computer_name", "machine", "machine_name", "asset", "endpoint"],
  itemName: ["app", "app_name", "application", "application_name", "software", "software_name", "program", "program_name", "extension_name", "package", "package_name", "item", "item_name", "name"],
  itemId: ["bundle_id", "bundle_identifier", "app_id", "application_id", "extension_id", "identifier", "package_id", "item_id"],
  itemType: ["type", "item_type", "software_type", "category", "kind"],
  version: ["version", "app_version", "software_version"],
  publisher: ["publisher", "vendor", "developer"],
  user: ["user", "username", "user_name", "assigned_user", "primary_user", "user_email", "email"],
  os: ["os", "platform", "operating_system", "os_name"],
  observedAt: ["observed_at", "last_seen", "last_seen_at", "timestamp", "collected_at", "inventory_date"],
};

/** built-in item type words (lower-case); an operator's `itemTypeValues` overrides and extends them */
const DEFAULT_ITEM_TYPE_VALUES: Readonly<Record<string, InventoryItemClass>> = {
  application: "application",
  app: "application",
  "ide extension": "ide_extension",
  ide_extension: "ide_extension",
  "browser extension": "browser_extension",
  browser_extension: "browser_extension",
  package: "package",
  process: "process",
};

const columnName = z.string().min(1).max(200);
export const inventoryImportConfigSchema = z
  .object({
    mapping: z.partialRecord(z.enum(INVENTORY_FIELDS), columnName).optional(),
    /** cell value (case-insensitive) of the itemType column -> item class */
    itemTypeValues: z.record(z.string().min(1).max(100), z.enum(INVENTORY_ITEM_CLASSES)).optional(),
    /** the class of every row when no itemType column is mapped */
    defaultItemClass: z.enum(INVENTORY_ITEM_CLASSES).default("application"),
  })
  .strict();
export type InventoryImportConfig = z.input<typeof inventoryImportConfigSchema>;

export interface InventoryImportOptions {
  content: string;
  format: "csv" | "json";
  config?: unknown;
  pseudonymise: EndpointPseudonymHook;
}

const norm = (h: string) => {
  let out = "";
  for (const c of h.trim().toLowerCase()) out += c === " " || c === "-" || c === "." ? "_" : c;
  return out;
};

export function inferInventoryMapping(
  headers: readonly string[],
): { ok: true; mapping: Partial<Record<InventoryField, string>> } | { ok: false; reason: string } {
  const byNorm = new Map<string, string>();
  for (const h of headers) if (!byNorm.has(norm(h))) byNorm.set(norm(h), h);
  const mapping: Partial<Record<InventoryField, string>> = {};
  const used = new Set<string>();
  for (const field of INVENTORY_FIELDS) {
    const candidates = [...new Set(ALIASES[field].filter((a) => byNorm.has(a)).map((a) => byNorm.get(a)!))].filter((c) => !used.has(c));
    if (REQUIRED.includes(field)) {
      if (candidates.length === 0) {
        return { ok: false, reason: `no '${field}' column could be inferred from headers [${headers.join(", ")}] — supply \`config.mapping\`` };
      }
      if (candidates.length > 1) {
        return { ok: false, reason: `the '${field}' column is ambiguous (${candidates.join(", ")} all match) — supply \`config.mapping\` rather than have RegulAIt guess` };
      }
    } else if (candidates.length !== 1) {
      continue; // an ambiguous optional column is simply not mapped
    }
    mapping[field] = candidates[0]!;
    used.add(candidates[0]!);
  }
  return { ok: true, mapping };
}

function parseOs(raw: string): EndpointOs | null {
  const v = raw.trim().toLowerCase();
  if (v.startsWith("mac") || v.startsWith("darwin") || v.startsWith("os x")) return "darwin";
  if (v.startsWith("win")) return "windows";
  for (const p of ["linux", "ubuntu", "debian", "rhel", "red hat", "fedora", "centos", "suse", "rocky", "alma"]) if (v.startsWith(p)) return "linux";
  return null;
}

const CLASS_KIND: Record<InventoryItemClass, EndpointSignatureKind> = {
  application: "desktop_app",
  ide_extension: "ide_extension",
  browser_extension: "browser_extension",
  package: "desktop_app",
  process: "desktop_app",
};

function keysFor(cls: InventoryItemClass, name: string, id: string | null): EndpointObservationKey[] {
  switch (cls) {
    case "application":
      return [
        { matchType: "app_name", value: name },
        { matchType: "executable_name", value: name },
        ...(id ? [{ matchType: "bundle_id" as const, value: id }] : []),
      ];
    case "ide_extension":
      return [{ matchType: "ide_extension_id", value: id ?? name }];
    case "browser_extension":
      return [{ matchType: "browser_extension_id", value: id ?? name }];
    case "package":
      return [
        { matchType: "npm_package", value: name },
        { matchType: "cli_binary", value: name },
        { matchType: "app_name", value: name },
      ];
    case "process":
      return [
        { matchType: "process_name", value: name },
        { matchType: "executable_name", value: name },
      ];
  }
}

export function importEndpointInventory(opts: InventoryImportOptions): EndpointImportResult {
  const pseudonymise = guardPseudonymHook(opts.pseudonymise);
  const parsedCfg = inventoryImportConfigSchema.safeParse(opts.config ?? {});
  if (!parsedCfg.success) {
    throw new EndpointImportFormatError(`invalid inventory config: ${parsedCfg.error.issues[0]?.message ?? "schema validation failed"}`, {
      importer: "endpoint_inventory",
    });
  }
  const cfg = parsedCfg.data;
  if (opts.format !== "csv" && opts.format !== "json") {
    throw new EndpointImportFormatError("an inventory export is csv or json", { importer: "endpoint_inventory" });
  }
  if (Buffer.byteLength(opts.content, "utf8") > ENDPOINT_IMPORT_MAX_BYTES) {
    throw new EndpointImportFormatError(`the file is over the ${ENDPOINT_IMPORT_MAX_BYTES}-byte endpoint import bound — split the export`, {
      importer: "endpoint_inventory",
    });
  }
  let table;
  try {
    table = readSourceTable({ content: opts.content, format: opts.format }, "endpoint_inventory");
  } catch (e) {
    if (e instanceof CostImportFormatError) {
      throw new EndpointImportFormatError(e.message, { importer: "endpoint_inventory", ...(e.detail.headersFound ? { found: e.detail.headersFound } : {}) });
    }
    throw e;
  }
  if (table.records.length > ENDPOINT_IMPORT_MAX_ROWS) {
    throw new EndpointImportFormatError(`the file carries ${table.records.length} rows, over the ${ENDPOINT_IMPORT_MAX_ROWS}-row bound — split the export`, {
      importer: "endpoint_inventory",
    });
  }

  let mapping: Partial<Record<InventoryField, string>>;
  if (cfg.mapping) {
    mapping = cfg.mapping;
    const missingReq = REQUIRED.filter((f) => !mapping[f]);
    if (missingReq.length > 0) {
      throw new EndpointImportFormatError(`the mapping must name the ${missingReq.join(" and ")} column(s)`, { importer: "endpoint_inventory", missing: missingReq });
    }
    const known = new Set(table.headers.map((h) => h.trim().toLowerCase()));
    const missing = Object.entries(mapping)
      .filter(([, col]) => !known.has(String(col).trim().toLowerCase()))
      .map(([f, col]) => `${f} -> '${col}'`);
    if (missing.length > 0) {
      throw new EndpointImportFormatError(`the file does not carry the mapped column(s) ${missing.join(", ")}`, {
        importer: "endpoint_inventory",
        missing,
        found: table.headers,
      });
    }
  } else {
    const inferred = inferInventoryMapping(table.headers);
    if (!inferred.ok) throw new EndpointImportFormatError(inferred.reason, { importer: "endpoint_inventory", found: table.headers });
    mapping = inferred.mapping;
  }
  const forbiddenTarget = Object.values(mapping).find((c) => isForbiddenColumn(String(c)));
  if (forbiddenTarget) {
    throw new EndpointImportFormatError(`the column '${forbiddenTarget}' may not be mapped: values, command lines and contents are never imported`, {
      importer: "endpoint_inventory",
    });
  }
  // a Map, never an object: a cell reading `constructor` or `__proto__` must not resolve a prototype member
  const typeValues = new Map<string, InventoryItemClass>(Object.entries(DEFAULT_ITEM_TYPE_VALUES));
  for (const [k, v] of Object.entries(cfg.itemTypeValues ?? {})) typeValues.set(k.trim().toLowerCase(), v);
  // a value-bearing column is refused on every row that fills it, mapped or not (as the osquery importer does)
  const forbiddenHeaders = table.headers.filter((h) => isForbiddenColumn(h));

  const observations: EndpointObservation[] = [];
  const refusals: EndpointRowRefusal[] = [];
  const devices = new Set<string>();
  let rowsWithoutTimestamp = 0;

  for (const rec of table.records) {
    const cell = (f: InventoryField): { ok: true; value: string | null } | { ok: false; reason: string } => {
      const col = mapping[f];
      if (!col) return { ok: true, value: null };
      const raw = (rec.get(col) ?? "").trim();
      if (raw.length === 0 || raw === "-") return { ok: true, value: null };
      if (raw.length > ENDPOINT_IMPORT_MAX_CELL) return { ok: false, reason: `the '${col}' cell is over ${ENDPOINT_IMPORT_MAX_CELL} characters` };
      return { ok: true, value: raw };
    };
    const values: Partial<Record<InventoryField, string | null>> = {};
    let refusal: EndpointRowRefusal | null = null;
    const filledForbidden = forbiddenHeaders.find((h) => (rec.get(h) ?? "").trim().length > 0);
    if (filledForbidden) {
      refusals.push({
        line: rec.line,
        reason: `the row carries the column '${filledForbidden}' — values, command lines and contents are never imported; the row is refused and the cell discarded`,
        field: filledForbidden,
      });
      continue;
    }
    for (const f of INVENTORY_FIELDS) {
      const c = cell(f);
      if (!c.ok) {
        refusal = { line: rec.line, reason: c.reason, field: mapping[f]! };
        break;
      }
      values[f] = c.value;
    }
    if (!refusal) {
      for (const f of REQUIRED) {
        if (!values[f]) {
          refusal = {
            line: rec.line,
            reason: `the required '${f}' column '${mapping[f]}' is empty on this row — defaulting it would invent an observation`,
            field: mapping[f]!,
          };
          break;
        }
      }
    }
    let cls: InventoryItemClass = cfg.defaultItemClass;
    if (!refusal && mapping.itemType) {
      const t = values.itemType?.toLowerCase() ?? null;
      const mapped = t === null ? undefined : typeValues.get(t);
      if (!mapped) {
        refusal = {
          line: rec.line,
          reason: `the item type '${(values.itemType ?? "").slice(0, 60)}' is not one RegulAIt knows — map it with \`config.itemTypeValues\``,
          field: mapping.itemType,
        };
      } else cls = mapped;
    }
    let observedAt: string | null = null;
    if (!refusal && values.observedAt) {
      const ts = parseEvidenceTimestamp(values.observedAt);
      if (!ts.ok) refusal = { line: rec.line, reason: `'${mapping.observedAt}': ${ts.reason}`, field: mapping.observedAt! };
      else observedAt = ts.value;
    }
    if (refusal) {
      refusals.push(refusal);
      continue;
    }
    const device = pseudonymise({ kind: "device", value: values.device! });
    const user = values.user ? pseudonymise({ kind: "device_user", value: values.user }) : null;
    devices.add(device);
    if (observedAt === null) rowsWithoutTimestamp += 1;
    observations.push({
      source: "endpoint_inventory",
      line: rec.line,
      query: null,
      kindHint: CLASS_KIND[cls],
      device,
      user,
      os: values.os ? parseOs(values.os) : null,
      observedAt,
      keys: keysFor(cls, values.itemName!, values.itemId ?? null),
      traits: [],
      location: null,
      version: values.version ?? null,
      info: values.publisher ? { publisher: values.publisher } : {},
    });
  }

  return {
    source: "endpoint_inventory",
    observations,
    refusals,
    removedRows: 0,
    rowsParsed: table.records.length,
    rowsWithoutTimestamp,
    devices: devices.size,
  };
}
