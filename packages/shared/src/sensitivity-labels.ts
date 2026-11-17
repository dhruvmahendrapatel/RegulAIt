/**
 * ADR-0363 slice 1 — customer sensitivity labels as inputs to the gateway's data-sensitivity decisions.
 *
 * This module is the vendor-neutral half: it reads the label a file or message CARRIES (embedded metadata), and turns
 * (label, org mapping) into one decision. It is pure: no network, no database, no clock. The gateway passes in the
 * label definitions it read from the provider (Microsoft Graph for Purview) and the org's mapping.
 *
 * Providers. Each provider is a `LabelProvider`: an id and a reader of embedded labels. Microsoft Purview / MIP is the
 * first. Google Workspace (Drive labels) and others add a provider here and a definition source in the gateway; the
 * decision code below does not change.
 *
 * Purview metadata, read without the MIP SDK (its licence is not on the ADR-0176 list). Microsoft documents the format
 * as clear text so that third-party apps can read it (learn.microsoft.com/purview/sensitivity-labels; MS-OFFCRYPTO
 * "LabelInfo versus Custom Document Properties"):
 *   - Office Open XML (docx/xlsx/pptx): `docMetadata/LabelInfo.xml` (`<clbl:label id=… enabled=… siteId=…/>`, written
 *     when protected co-authoring is on), else `docProps/custom.xml` properties `MSIP_Label_<guid>_Enabled|SiteId|Method`.
 *   - Email: the `MSIP_Labels` header, `MSIP_Label_<guid>_Enabled=True; MSIP_Label_<guid>_SiteId=…; …`.
 *   - PDF: the same `MSIP_Label_<guid>_*` keys in the document information / XMP metadata.
 *   - An encrypted (RMS-protected) Office file is an OLE compound file, not a zip. Its content cannot be read or scanned
 *     at all, so it is reported as `protected` and decided as the strictest outcome (fail closed).
 *
 * Bounds. Only the two small XML parts are inflated, each capped by its declared size; the PDF scan reads at most the
 * first and last 256 KiB as Latin-1 and uses a fixed literal search, not a regex over record input (M-061 rule).
 */
import { unzipSync } from "fflate";
import { XMLParser } from "fast-xml-parser";

export const LABEL_PROVIDERS = ["microsoft_purview"] as const;
export type LabelProviderId = (typeof LABEL_PROVIDERS)[number];

/** where in the content the label was read */
export const LABEL_SOURCES = ["ooxml_labelinfo", "ooxml_custom_props", "email_header", "pdf_metadata"] as const;
export type LabelSource = (typeof LABEL_SOURCES)[number];

/** one label a piece of content carries */
export interface ContentLabel {
  provider: LabelProviderId;
  /** the provider's label id (Purview: the label GUID, lower case, no braces) */
  labelId: string;
  /** the tenant that applied it (Purview: the `SiteId`, the Entra tenant id), null when the metadata omits it */
  tenantId: string | null;
  source: LabelSource;
}

/** what reading a file found; `protected` means the content is encrypted and unreadable */
export type EmbeddedLabelRead =
  | { kind: "labels"; labels: ContentLabel[] }
  | { kind: "none" }
  | { kind: "protected" }
  | { kind: "unreadable"; reason: "zip_part_too_large" | "corrupt" };

/** a label definition from the provider (Purview: Graph `security/informationProtection/sensitivityLabels`) */
export interface LabelDefinition {
  provider: LabelProviderId;
  labelId: string;
  name: string;
  parentLabelId: string | null;
  /** the provider's ordering, higher = more sensitive (Purview: `sensitivity`), null when absent */
  rank: number | null;
  active: boolean;
}

export interface LabelProvider {
  id: LabelProviderId;
  /** read the labels embedded in decoded content; `mediaType` may be null when unknown */
  readEmbedded(bytes: Uint8Array, mediaType: string | null): EmbeddedLabelRead;
  /** read the labels from message headers (email); [] when the provider has none */
  readHeaders(headers: Readonly<Record<string, string>>): ContentLabel[];
}

// ---------------------------------------------------------------------------------------------------------------
// Microsoft Purview / MIP
// ---------------------------------------------------------------------------------------------------------------

const MAX_XML_PART = 1024 * 1024;
const PDF_WINDOW = 256 * 1024;
const LABEL_INFO_PART = "docMetadata/LabelInfo.xml";
const CUSTOM_PROPS_PART = "docProps/custom.xml";
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** "{ABC…}" or "abc…" → lower-case GUID, or null when it is not one */
export function normaliseGuid(raw: string | undefined | null): string | null {
  if (typeof raw !== "string") return null;
  let s = raw.trim().toLowerCase();
  if (s.startsWith("{") && s.endsWith("}")) s = s.slice(1, -1);
  return s.length === 36 && GUID.test(s) ? s : null;
}

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  processEntities: false,
  htmlEntities: false,
  ignoreDeclaration: true,
  ignorePiTags: true,
  parseTagValue: false,
  parseAttributeValue: false,
  maxNestedTags: 32,
});

const asArray = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const truthy = (v: unknown) => typeof v === "string" && ["1", "true"].includes(v.trim().toLowerCase());

/**
 * MSIP key/value pairs → labels. Keys look like `MSIP_Label_<guid>_<Attribute>`; a label counts only when its
 * `Enabled` attribute is true (a removed label leaves `Enabled=False` behind).
 */
export function labelsFromMsipPairs(pairs: Iterable<[string, string]>, source: LabelSource): ContentLabel[] {
  const byId = new Map<string, { enabled: boolean; tenantId: string | null }>();
  const prefix = "msip_label_";
  for (const [k, v] of pairs) {
    const key = k.trim();
    if (key.length < prefix.length + 38 || key.slice(0, prefix.length).toLowerCase() !== prefix) continue;
    const id = normaliseGuid(key.slice(prefix.length, prefix.length + 36));
    if (!id || key[prefix.length + 36] !== "_") continue;
    const attr = key.slice(prefix.length + 37).toLowerCase();
    const cur = byId.get(id) ?? { enabled: false, tenantId: null };
    if (attr === "enabled") cur.enabled = truthy(v);
    else if (attr === "siteid") cur.tenantId = normaliseGuid(v);
    byId.set(id, cur);
  }
  const out: ContentLabel[] = [];
  for (const [labelId, s] of byId) {
    if (s.enabled) out.push({ provider: "microsoft_purview", labelId, tenantId: s.tenantId, source });
  }
  return out;
}

/** the `MSIP_Labels` email header: `k=v; k=v; …` */
export function labelsFromMsipHeader(value: string): ContentLabel[] {
  const pairs: [string, string][] = [];
  for (const part of value.slice(0, 64 * 1024).split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0) pairs.push([part.slice(0, eq), part.slice(eq + 1)]);
  }
  return labelsFromMsipPairs(pairs, "email_header");
}

function labelsFromLabelInfo(text: string): ContentLabel[] {
  const doc = xml.parse(text) as Record<string, unknown>;
  const root = (doc.labelList ?? {}) as Record<string, unknown>;
  const out: ContentLabel[] = [];
  for (const l of asArray(root.label as Record<string, string> | Record<string, string>[] | undefined)) {
    const id = normaliseGuid(l["@_id"]);
    if (!id || !truthy(l["@_enabled"])) continue;
    // `removed="1"` marks a label taken off the document
    if (truthy(l["@_removed"])) continue;
    out.push({ provider: "microsoft_purview", labelId: id, tenantId: normaliseGuid(l["@_siteId"]), source: "ooxml_labelinfo" });
  }
  return out;
}

function labelsFromCustomProps(text: string): ContentLabel[] {
  const doc = xml.parse(text) as Record<string, unknown>;
  const root = (doc.Properties ?? {}) as Record<string, unknown>;
  const pairs: [string, string][] = [];
  for (const p of asArray(root.property as Record<string, unknown> | Record<string, unknown>[] | undefined)) {
    const name = p["@_name"];
    if (typeof name !== "string") continue;
    // the value sits in a typed child, e.g. <vt:lpwstr>true</vt:lpwstr>
    const child = Object.entries(p).find(([k]) => !k.startsWith("@_"));
    const value = child && typeof child[1] === "string" ? child[1] : "";
    pairs.push([name, value]);
  }
  return labelsFromMsipPairs(pairs, "ooxml_custom_props");
}

const startsWith = (b: Uint8Array, sig: readonly number[]) => sig.every((x, i) => b[i] === x);
const ZIP = [0x50, 0x4b, 0x03, 0x04] as const;
const CFB = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] as const;
const PDF = [0x25, 0x50, 0x44, 0x46, 0x2d] as const; // %PDF-

function readOoxml(bytes: Uint8Array): EmbeddedLabelRead {
  let tooLarge = false;
  let parts: Record<string, Uint8Array>;
  try {
    parts = unzipSync(bytes, {
      filter: (f) => {
        if (f.name !== LABEL_INFO_PART && f.name !== CUSTOM_PROPS_PART) return false;
        if (f.originalSize > MAX_XML_PART || f.size > MAX_XML_PART) {
          tooLarge = true;
          return false;
        }
        return true;
      },
    });
  } catch {
    return { kind: "unreadable", reason: "corrupt" };
  }
  if (tooLarge) return { kind: "unreadable", reason: "zip_part_too_large" };
  const dec = new TextDecoder("utf-8", { fatal: false });
  try {
    // LabelInfo.xml is authoritative when present (MS-OFFCRYPTO): custom.xml may hold a stale copy
    const info = parts[LABEL_INFO_PART];
    if (info && info.byteLength <= MAX_XML_PART) {
      const labels = labelsFromLabelInfo(dec.decode(info));
      return labels.length ? { kind: "labels", labels } : { kind: "none" };
    }
    const custom = parts[CUSTOM_PROPS_PART];
    if (custom && custom.byteLength <= MAX_XML_PART) {
      const labels = labelsFromCustomProps(dec.decode(custom));
      return labels.length ? { kind: "labels", labels } : { kind: "none" };
    }
  } catch {
    return { kind: "unreadable", reason: "corrupt" };
  }
  return { kind: "none" };
}

/** PDF: literal scan of the head and tail windows (info dictionary and XMP sit there) for MSIP pairs */
function readPdf(bytes: Uint8Array): EmbeddedLabelRead {
  const latin1 = new TextDecoder("latin1");
  const windows =
    bytes.byteLength <= PDF_WINDOW * 2
      ? [latin1.decode(bytes)]
      : [latin1.decode(bytes.subarray(0, PDF_WINDOW)), latin1.decode(bytes.subarray(bytes.byteLength - PDF_WINDOW))];
  const pairs: [string, string][] = [];
  const needle = "msip_label_";
  for (const w of windows) {
    const lower = w.toLowerCase();
    let at = lower.indexOf(needle);
    while (at !== -1 && pairs.length < 256) {
      // key runs to the first delimiter; value is the next (…) literal or the element text up to "<"
      let end = at;
      while (end < w.length && end - at < 96 && /[A-Za-z0-9_-]/.test(w[end]!)) end++;
      const key = w.slice(at, end);
      let rest = w.slice(end, end + 160);
      const open = rest.search(/[(>]/);
      let value = "";
      if (open !== -1) {
        rest = rest.slice(open + 1);
        const close = rest.search(/[)<]/);
        value = close === -1 ? "" : rest.slice(0, close);
      }
      pairs.push([key, value]);
      at = lower.indexOf(needle, end);
    }
  }
  const labels = labelsFromMsipPairs(pairs, "pdf_metadata");
  return labels.length ? { kind: "labels", labels } : { kind: "none" };
}

export const purviewLabelProvider: LabelProvider = Object.freeze({
  id: "microsoft_purview" as const,
  readEmbedded(bytes: Uint8Array): EmbeddedLabelRead {
    if (startsWith(bytes, CFB)) return { kind: "protected" };
    if (startsWith(bytes, ZIP)) return readOoxml(bytes);
    if (startsWith(bytes, PDF)) return readPdf(bytes);
    return { kind: "none" };
  },
  readHeaders(headers: Readonly<Record<string, string>>): ContentLabel[] {
    for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === "msip_labels") return labelsFromMsipHeader(v);
    return [];
  },
});

export const LABEL_PROVIDER_REGISTRY: Readonly<Record<LabelProviderId, LabelProvider>> = Object.freeze({
  microsoft_purview: purviewLabelProvider,
});

/** read with every registered provider; protected wins, then labels, then unreadable, then none */
export function readEmbeddedLabels(bytes: Uint8Array, mediaType: string | null): EmbeddedLabelRead {
  const labels: ContentLabel[] = [];
  let unreadable: EmbeddedLabelRead | null = null;
  for (const p of Object.values(LABEL_PROVIDER_REGISTRY)) {
    const r = p.readEmbedded(bytes, mediaType);
    if (r.kind === "protected") return r;
    if (r.kind === "labels") labels.push(...r.labels);
    if (r.kind === "unreadable") unreadable = r;
  }
  if (labels.length) return { kind: "labels", labels };
  return unreadable ?? { kind: "none" };
}

// ---------------------------------------------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------------------------------------------

/** what happens to labelled content on its way to a model; ordered least → most strict */
export const LABEL_ACTIONS = ["allow", "redact", "block"] as const;
export type LabelAction = (typeof LABEL_ACTIONS)[number];
const strictness = (a: LabelAction) => LABEL_ACTIONS.indexOf(a);
export const stricterAction = (a: LabelAction, b: LabelAction): LabelAction => (strictness(a) >= strictness(b) ? a : b);

/** the data-sensitivity scale the compliance cascade already uses (ADR-0018 dimension) */
export const LABEL_DATA_SENSITIVITIES = ["public", "internal", "confidential", "restricted"] as const;
export type LabelDataSensitivity = (typeof LABEL_DATA_SENSITIVITIES)[number];
const sensitivityRank = (s: LabelDataSensitivity) => LABEL_DATA_SENSITIVITIES.indexOf(s);

/** one admin mapping row: a provider label → an action and a data-sensitivity level */
export interface LabelMappingRule {
  provider: LabelProviderId;
  labelId: string;
  action: LabelAction;
  sensitivity: LabelDataSensitivity;
}

/** the org's label policy; every field defaults to its strict value (ADR-0180) */
export interface LabelPolicy {
  /** the tenants whose labels are honoured as mapped; a label from any other tenant is treated as unmapped */
  trustedTenantIds: readonly string[];
  rules: readonly LabelMappingRule[];
  /** a label with no mapping row (or from an untrusted tenant). Strict default: block */
  unmappedAction: LabelAction;
  /** encrypted content we cannot read. Strict default: block */
  protectedAction: LabelAction;
  /** content whose metadata could not be read (corrupt, oversized part). Strict default: block */
  unreadableAction: LabelAction;
}

export const DEFAULT_LABEL_POLICY: LabelPolicy = Object.freeze({
  trustedTenantIds: Object.freeze([]) as readonly string[],
  rules: Object.freeze([]) as readonly LabelMappingRule[],
  unmappedAction: "block",
  protectedAction: "block",
  unreadableAction: "block",
});

export interface LabelDecision {
  action: LabelAction;
  /** the highest data sensitivity among the labels; null when nothing was labelled */
  sensitivity: LabelDataSensitivity | null;
  /** why, one entry per label or condition, for the audit row (ids only, never content) */
  reasons: Array<
    | { kind: "mapped"; provider: LabelProviderId; labelId: string; action: LabelAction }
    | { kind: "unmapped"; provider: LabelProviderId; labelId: string; untrustedTenant: boolean }
    | { kind: "protected" }
    | { kind: "unreadable" }
  >;
}

/**
 * The one decision: the strictest action and highest sensitivity over every label. A label is mapped only when its
 * tenant is trusted (or the metadata names no tenant and exactly one tenant is trusted) and a rule names it.
 */
export function decideLabels(read: EmbeddedLabelRead | { kind: "labels"; labels: ContentLabel[] }, policy: LabelPolicy): LabelDecision {
  if (read.kind === "none") return { action: "allow", sensitivity: null, reasons: [] };
  if (read.kind === "protected") return { action: policy.protectedAction, sensitivity: "restricted", reasons: [{ kind: "protected" }] };
  if (read.kind === "unreadable") return { action: policy.unreadableAction, sensitivity: null, reasons: [{ kind: "unreadable" }] };
  const trusted = new Set(policy.trustedTenantIds.map((t) => normaliseGuid(t) ?? t));
  let action: LabelAction = "allow";
  let sensitivity: LabelDataSensitivity | null = null;
  const reasons: LabelDecision["reasons"] = [];
  for (const l of read.labels) {
    const tenantOk = l.tenantId ? trusted.has(l.tenantId) : trusted.size === 1;
    const rule = tenantOk ? policy.rules.find((r) => r.provider === l.provider && r.labelId === l.labelId) : undefined;
    if (rule) {
      action = stricterAction(action, rule.action);
      if (sensitivity === null || sensitivityRank(rule.sensitivity) > sensitivityRank(sensitivity)) sensitivity = rule.sensitivity;
      reasons.push({ kind: "mapped", provider: l.provider, labelId: l.labelId, action: rule.action });
    } else {
      action = stricterAction(action, policy.unmappedAction);
      sensitivity = "restricted";
      reasons.push({ kind: "unmapped", provider: l.provider, labelId: l.labelId, untrustedTenant: !tenantOk });
    }
  }
  return { action, sensitivity, reasons };
}

/** problems with an admin's mapping (empty = valid); definitions are the ones read from the provider */
export function labelPolicyProblems(policy: LabelPolicy, definitions: readonly LabelDefinition[]): string[] {
  const out: string[] = [];
  const known = new Set(definitions.map((d) => `${d.provider}:${d.labelId}`));
  const seen = new Set<string>();
  for (const t of policy.trustedTenantIds) if (!normaliseGuid(t)) out.push(`trusted tenant "${t}" is not a GUID`);
  for (const r of policy.rules) {
    const key = `${r.provider}:${r.labelId}`;
    if (!LABEL_PROVIDERS.includes(r.provider)) out.push(`unknown provider "${r.provider}"`);
    if (!LABEL_ACTIONS.includes(r.action)) out.push(`label ${r.labelId}: unknown action "${r.action}"`);
    if (!LABEL_DATA_SENSITIVITIES.includes(r.sensitivity)) out.push(`label ${r.labelId}: unknown sensitivity "${r.sensitivity}"`);
    if (seen.has(key)) out.push(`label ${r.labelId} is mapped twice`);
    seen.add(key);
    if (!known.has(key)) out.push(`label ${r.labelId} is not among the provider's label definitions`);
  }
  for (const a of [policy.unmappedAction, policy.protectedAction, policy.unreadableAction])
    if (!LABEL_ACTIONS.includes(a)) out.push(`unknown action "${a}"`);
  return out;
}

/** true when `next` relaxes `prev` anywhere (a looser action or sensitivity, a new trusted tenant): a step-up change */
export function labelPolicyRelaxes(prev: LabelPolicy, next: LabelPolicy): boolean {
  for (const k of ["unmappedAction", "protectedAction", "unreadableAction"] as const)
    if (strictness(next[k]) < strictness(prev[k])) return true;
  const prevTenants = new Set(prev.trustedTenantIds);
  if (next.trustedTenantIds.some((t) => !prevTenants.has(t))) return true;
  for (const r of next.rules) {
    const old = prev.rules.find((p) => p.provider === r.provider && p.labelId === r.labelId);
    // a new row maps a label that was falling to `unmappedAction`; compare against that
    const oldAction = old ? old.action : prev.unmappedAction;
    if (strictness(r.action) < strictness(oldAction)) return true;
    if (old && sensitivityRank(r.sensitivity) < sensitivityRank(old.sensitivity)) return true;
    if (!old && sensitivityRank(r.sensitivity) < sensitivityRank("restricted")) return true;
  }
  return false;
}

/** Graph `sensitivityLabel` JSON → definitions; drops entries without a GUID id or a name */
export function purviewDefinitionsFromGraph(value: unknown): LabelDefinition[] {
  const items = Array.isArray((value as { value?: unknown })?.value) ? ((value as { value: unknown[] }).value) : [];
  const out: LabelDefinition[] = [];
  for (const raw of items.slice(0, 2000)) {
    const r = raw as Record<string, unknown>;
    const labelId = normaliseGuid(typeof r.id === "string" ? r.id : null);
    const name = typeof r.name === "string" ? r.name.slice(0, 256) : typeof r.displayName === "string" ? r.displayName.slice(0, 256) : null;
    if (!labelId || !name) continue;
    const parent = r.parent as Record<string, unknown> | null | undefined;
    out.push({
      provider: "microsoft_purview",
      labelId,
      name,
      parentLabelId: normaliseGuid(typeof parent?.id === "string" ? parent.id : null),
      rank: typeof r.sensitivity === "number" && Number.isFinite(r.sensitivity) ? r.sensitivity : null,
      active: r.isActive !== false,
    });
  }
  return out;
}
