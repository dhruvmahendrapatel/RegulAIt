/**
 * ADR-0215 — FRAMEWORK CONTENT IMPORTS AND A WIDER REGULATORY FEED, the pure half.
 *
 * Control text in a compliance pack (ADR-0058) used to be typed by hand, and the
 * regulatory feed (ADR-0158) was curated by hand. This module turns published,
 * permissively licensed framework data into pack content and feed entries:
 *
 *  - NORMALISERS read an upstream document (an OSCAL catalog, the MITRE ATLAS
 *    YAML release, a Federal Register search result) and return a sorted,
 *    size-bounded list of controls or feed entries. They are pure and
 *    order-independent, so the same upstream bytes always give the same output.
 *  - The vendored SNAPSHOT is what the product reads. A refresh script
 *    (`scripts/refresh-framework-imports.mjs`) downloads upstream and rewrites
 *    the snapshot; the product itself never downloads anything.
 *  - `planFrameworkImport` is a THREE-WAY MERGE of (last accepted import,
 *    current pack, incoming snapshot). An import only brings framework TEXT
 *    (title, description). The mapping (coverage, collector, thresholds,
 *    attestation, owner note) is never touched. Text an admin changed since the
 *    last import, or text that was never imported, is KEPT unless the admin
 *    names that control in `takeIncoming`.
 *  - The result is a NEW pack version (draft). Nothing here edits a pack row.
 *
 * Licences: a source's licence decides what may be stored. Public-domain and
 * permissive licences allow the text. Share-alike or non-commercial content is
 * cited by ID only, and an unknown licence is refused.
 */
import { z } from "zod";
import { canonicalJson, sha256Hex } from "./audit-chain.js";
import { createCompliancePackSchema, type CreateCompliancePackInput, type PackControlInput } from "./compliance-packs.js";
import { REGULATORY_INSTRUMENT_KINDS, REGULATORY_UPDATE_STATUSES, type RegulatoryUpdate } from "./regulatory-intel.js";

// ---------------------------------------------------------------------------
// Licences
// ---------------------------------------------------------------------------

/** licences whose content we may store and show in full */
export const IMPORT_TEXT_LICENCES = [
  "Apache-2.0",
  "MIT",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "CC0-1.0",
  "Unlicense",
  "0BSD",
  /** a work of the US federal government (17 U.S.C. 105) */
  "US-Gov-Public-Domain",
] as const;

/** licences whose content we may only cite by identifier */
export const IMPORT_ID_ONLY_LICENCES = [
  "CC-BY-SA-3.0",
  "CC-BY-SA-4.0",
  "CC-BY-NC-4.0",
  "CC-BY-NC-SA-4.0",
  "CC-BY-NC-ND-4.0",
  "CC-BY-ND-4.0",
] as const;

export type ImportTextPolicy = "text" | "id_only" | "refused";

/** what an import may store for a source under this licence */
export function importTextPolicy(licence: string): ImportTextPolicy {
  if ((IMPORT_TEXT_LICENCES as readonly string[]).includes(licence)) return "text";
  if ((IMPORT_ID_ONLY_LICENCES as readonly string[]).includes(licence)) return "id_only";
  return "refused";
}

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export const FRAMEWORK_IMPORT_SCHEMA = "regulait.framework-import/v1" as const;
export const REGULATORY_FEED_IMPORT_SCHEMA = "regulait.regulatory-feed-import/v1" as const;

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const sha = z.string().regex(/^[0-9a-f]{64}$/);

export const importSourceSchema = z
  .object({
    sourceId: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
    title: z.string().min(1).max(300),
    publisher: z.string().min(1).max(200),
    licence: z.string().min(1).max(64),
    licenceUrl: z.string().url().max(500),
    upstreamUrl: z.string().url().max(500),
    /** the upstream's own version label ("1.0.0", "2026.10") */
    sourceVersion: z.string().min(1).max(64),
    /** the upstream commit or edition the bytes came from */
    upstreamRevision: z.string().min(1).max(100),
    upstreamSha256: sha,
    retrievedOn: ymd,
  })
  .strict();
export type ImportSource = z.infer<typeof importSourceSchema>;

export const importedControlSchema = z
  .object({
    controlRef: z.string().min(1).max(200),
    title: z.string().min(1).max(400),
    description: z.string().max(4000).nullable(),
  })
  .strict();
export type ImportedControl = z.infer<typeof importedControlSchema>;

export const frameworkImportSnapshotSchema = z
  .object({
    schema: z.literal(FRAMEWORK_IMPORT_SCHEMA),
    source: importSourceSchema.extend({ framework: z.string().min(1).max(64) }).strict(),
    controls: z.array(importedControlSchema).min(1).max(500),
  })
  .strict()
  .superRefine((s, ctx) => {
    const refs = s.controls.map((c) => c.controlRef);
    if (new Set(refs).size !== refs.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "duplicate controlRef" });
    if (refs.some((r) => !r.startsWith(`${s.source.framework}:`))) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "every controlRef must start with the framework id" });
    }
    if (canonicalJson(refs) !== canonicalJson([...refs].sort())) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "controls must be sorted by controlRef" });
    }
    if (importTextPolicy(s.source.licence) === "refused") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `licence '${s.source.licence}' is not allowed for imports` });
    }
  });
export type FrameworkImportSnapshot = z.infer<typeof frameworkImportSnapshotSchema>;

export const importedFeedEntrySchema = z
  .object({
    key: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,99}$/),
    jurisdiction: z.string().min(1).max(40),
    instrument: z.string().min(1).max(300),
    title: z.string().min(1).max(500),
    summary: z.string().min(1).max(1200),
    instrumentKind: z.enum(REGULATORY_INSTRUMENT_KINDS),
    effectiveDate: ymd,
    status: z.enum(REGULATORY_UPDATE_STATUSES),
    frameworks: z.array(z.string().min(1).max(64)).max(20),
    controlRefs: z.array(z.string().min(1).max(200)).max(50),
    sourceUrl: z.string().url().max(500),
    verifiedOn: ymd,
  })
  .strict();

export const regulatoryFeedSnapshotSchema = z
  .object({
    schema: z.literal(REGULATORY_FEED_IMPORT_SCHEMA),
    source: importSourceSchema,
    entries: z.array(importedFeedEntrySchema).max(500),
  })
  .strict()
  .superRefine((s, ctx) => {
    const keys = s.entries.map((e) => e.key);
    if (new Set(keys).size !== keys.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "duplicate feed key" });
    if (canonicalJson(keys) !== canonicalJson([...keys].sort())) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "entries must be sorted by key" });
    }
    if (importTextPolicy(s.source.licence) !== "text") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `licence '${s.source.licence}' does not allow feed text` });
    }
  });
export type RegulatoryFeedSnapshot = z.infer<typeof regulatoryFeedSnapshotSchema>;

/** the content hash an import is identified by: canonical JSON, so key order is not a change */
export function importContentSha256(snapshot: { source: unknown; controls?: unknown; entries?: unknown }): string {
  return sha256Hex(canonicalJson(snapshot));
}

// ---------------------------------------------------------------------------
// Normalisers (pure, deterministic)
// ---------------------------------------------------------------------------

/** cut to `max` characters, marking the cut, so a long upstream text always fits the column */
function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

/** markdown links to their text: upstream links are relative to the publisher's site */
const unlink = (s: string) => s.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");

const byRef = (a: { controlRef: string }, b: { controlRef: string }) =>
  a.controlRef < b.controlRef ? -1 : a.controlRef > b.controlRef ? 1 : 0;

function applyPolicy(controls: ImportedControl[], licence: string): ImportedControl[] {
  const policy = importTextPolicy(licence);
  if (policy === "refused") throw new Error(`licence '${licence}' is not allowed for imports`);
  const out =
    policy === "text"
      ? controls
      : controls.map((c) => ({ controlRef: c.controlRef, title: c.controlRef.slice(c.controlRef.indexOf(":") + 1), description: null }));
  return [...out].sort(byRef);
}

interface OscalPart {
  name?: string;
  prose?: string;
  parts?: OscalPart[];
}
interface OscalControl {
  id: string;
  class?: string;
  props?: Array<{ name?: string; value?: string }>;
  title?: string;
  parts?: OscalPart[];
  controls?: OscalControl[];
}
interface OscalGroup {
  controls?: OscalControl[];
  groups?: OscalGroup[];
}

/**
 * An OSCAL catalog to imported controls. `classes` picks which control classes
 * are controls in the pack (an AI RMF "subcategory", not its "category"); a
 * control the catalog marks withdrawn is left out. The
 * OSCAL id's underscores become hyphens so `GOVERN_1.1` matches the existing
 * `nist-ai-rmf:GOVERN-1.1` refs.
 */
export function normaliseOscalCatalog(
  doc: unknown,
  opts: { framework: string; classes: readonly string[]; licence: string },
): ImportedControl[] {
  const catalog = (doc as { catalog?: OscalGroup }).catalog;
  if (!catalog || typeof catalog !== "object") throw new Error("not an OSCAL catalog document");
  const out: ImportedControl[] = [];
  const visitControl = (c: OscalControl) => {
    const withdrawn = (c.props ?? []).some((p) => p.name === "status" && p.value === "withdrawn");
    if (opts.classes.includes(c.class ?? "") && !withdrawn) {
      const prose = (c.parts ?? []).find((p) => (p.name === "statement" || p.name === "overview") && p.prose)?.prose;
      const label = clip(c.title ?? c.id, 120);
      out.push({
        controlRef: `${opts.framework}:${c.id.replace(/_/g, "-")}`,
        title: clip(prose ? `${label} — ${prose}` : label, 400),
        description: null,
      });
    }
    for (const child of c.controls ?? []) visitControl(child);
  };
  const visitGroup = (g: OscalGroup) => {
    for (const c of g.controls ?? []) visitControl(c);
    for (const child of g.groups ?? []) visitGroup(child);
  };
  visitGroup(catalog);
  if (out.length === 0) throw new Error(`the catalog has no controls of class ${opts.classes.join(", ")}`);
  return applyPolicy(out, opts.licence);
}

/**
 * The MITRE ATLAS release (YAML, already parsed) to imported controls. Each
 * mitigation is a control; its description lists the techniques it mitigates.
 */
export function normaliseAtlasRelease(doc: unknown, opts: { framework: string; licence: string }): ImportedControl[] {
  const d = doc as {
    mitigations?: Record<string, { id?: string; name?: string; description?: string }>;
    relationships?: Record<string, { mitigates?: Array<{ target?: string }> }>;
  };
  if (!d.mitigations || typeof d.mitigations !== "object") throw new Error("not an ATLAS release document");
  const out: ImportedControl[] = [];
  for (const [key, m] of Object.entries(d.mitigations)) {
    const id = m.id ?? key;
    const techniques = [
      ...new Set((d.relationships?.[id]?.mitigates ?? []).map((r) => r.target).filter((t): t is string => !!t)),
    ].sort();
    const body = unlink(m.description ?? "");
    const tail = techniques.length ? ` Mitigates ATLAS techniques: ${techniques.join(", ")}.` : "";
    out.push({
      controlRef: `${opts.framework}:${id}`,
      title: clip(`${id} — ${m.name ?? id}`, 400),
      description: body || tail ? clip(`${clip(body, 4000 - tail.length)}${tail}`, 4000) : null,
    });
  }
  return applyPolicy(out, opts.licence);
}

interface FederalRegisterDoc {
  document_number?: string;
  title?: string;
  type?: string;
  abstract?: string | null;
  publication_date?: string;
  effective_on?: string | null;
  html_url?: string;
  agencies?: Array<{ name?: string; raw_name?: string }>;
}

/** what makes a Federal Register document about AI: its title names AI, or its abstract names the phrase */
const AI_PHRASE = /\bartificial intelligence\b|\bmachine learning\b/i;
const AI_ACRONYM = /\bAI\b/;
const aboutAi = (title: string, abstract: string) => AI_PHRASE.test(title) || AI_ACRONYM.test(title) || AI_PHRASE.test(abstract);

/**
 * Federal Register search results to feed entries. Rules, proposed rules and
 * presidential documents whose title or abstract is about AI. Status is
 * computed against the retrieval date, so the output depends only on its input.
 * Entries map to no pack control: the feed says so instead of guessing.
 */
export function normaliseFederalRegister(results: unknown, opts: { retrievedOn: string }): RegulatoryUpdate[] {
  if (!Array.isArray(results)) throw new Error("expected the Federal Register results array");
  const kinds: Record<string, { kind: RegulatoryUpdate["instrumentKind"]; label: string }> = {
    Rule: { kind: "law", label: "Final rule" },
    "Proposed Rule": { kind: "law", label: "Proposed rule" },
    "Presidential Document": { kind: "law", label: "Presidential document" },
  };
  const out = new Map<string, RegulatoryUpdate>();
  for (const raw of results as FederalRegisterDoc[]) {
    const t = raw.type ? kinds[raw.type] : undefined;
    if (!t || !raw.document_number || !raw.title || !raw.html_url || !raw.publication_date) continue;
    if (!aboutAi(raw.title, raw.abstract ?? "")) continue;
    if (!/^https:\/\/www\.federalregister\.gov\//.test(raw.html_url)) continue;
    const proposed = raw.type === "Proposed Rule";
    const effectiveDate = (!proposed && raw.effective_on) || raw.publication_date;
    const agencies = [...new Set((raw.agencies ?? []).map((a) => a.name ?? a.raw_name ?? "").filter(Boolean))].sort();
    const key = `us-fr-${raw.document_number.toLowerCase()}`;
    out.set(key, {
      key,
      jurisdiction: "US",
      instrument: clip(`Federal Register ${raw.document_number}${agencies.length ? ` (${agencies.join("; ")})` : ""}`, 300),
      title: clip(raw.title, 500),
      summary: clip(raw.abstract || `${t.label} published in the Federal Register.`, 1200),
      instrumentKind: t.kind,
      effectiveDate,
      status: proposed ? "proposed" : effectiveDate > opts.retrievedOn ? "upcoming" : "in_force",
      frameworks: [],
      controlRefs: [],
      sourceUrl: raw.html_url,
      verifiedOn: opts.retrievedOn,
    });
  }
  return [...out.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

// ---------------------------------------------------------------------------
// The three-way merge
// ---------------------------------------------------------------------------

export const IMPORT_CHANGE_KINDS = [
  /** new in the source: added unmapped */
  "added",
  /** unchanged by an admin since the last import, so the new text is taken */
  "text_updated",
  /** text already matches the source */
  "unchanged",
  /** an admin changed it (or it was never imported) and the source differs: kept */
  "kept_edited",
  /** an admin changed it, and chose to take the source text for this import */
  "edited_replaced",
  /** in the pack but not in the source: kept, never deleted */
  "not_in_source",
] as const;
export type ImportChangeKind = (typeof IMPORT_CHANGE_KINDS)[number];

export interface ImportControlText {
  title: string;
  description: string | null;
}

export interface ImportControlChange {
  controlRef: string;
  kind: ImportChangeKind;
  current: ImportControlText | null;
  incoming: ImportControlText | null;
  /** for an edited control: the source text differs from what the last accepted import brought */
  upstreamChanged?: boolean;
}

/** the pack an import lands on: the latest version of the framework */
export interface ImportBasePack {
  version: number;
  title: string;
  description: string | null;
  cascadeTag: string | null;
  cascadePreset: Record<string, unknown> | null;
  controls: PackControlInput[];
}

export interface FrameworkImportPlan {
  framework: string;
  sourceId: string;
  sourceVersion: string;
  contentSha256: string;
  fromVersion: number | null;
  toVersion: number;
  changes: ImportControlChange[];
  summary: Record<ImportChangeKind, number>;
  /** nothing to review: nothing would change, and no edited control has new source text */
  noChange: boolean;
  /** `takeIncoming` refs that name no kept control — a caller error */
  unknownResolutions: string[];
  proposedPack: CreateCompliancePackInput;
}

const textOf = (c: { title: string; description?: string | null | undefined }): ImportControlText => ({
  title: c.title,
  description: c.description ?? null,
});
const sameText = (a: ImportControlText, b: ImportControlText) => a.title === b.title && a.description === b.description;

/**
 * Plan an import. `baseline` is the snapshot of the last ACCEPTED import of this
 * source (null if none): a control whose current text still equals the baseline
 * was not edited by an admin, so the new text may replace it. Any other
 * difference is an edit and is kept unless named in `takeIncoming`.
 */
export function planFrameworkImport(args: {
  snapshot: FrameworkImportSnapshot;
  baseline: ImportedControl[] | null;
  current: ImportBasePack | null;
  takeIncoming?: readonly string[];
}): FrameworkImportPlan {
  const { snapshot, current } = args;
  const framework = snapshot.source.framework;
  const take = new Set(args.takeIncoming ?? []);
  const baseline = new Map((args.baseline ?? []).map((c) => [c.controlRef, textOf(c)]));
  const incoming = new Map(snapshot.controls.map((c) => [c.controlRef, c]));
  const existing = new Map((current?.controls ?? []).map((c) => [c.controlRef, c]));
  const refs = [...new Set([...incoming.keys(), ...existing.keys()])].sort();

  const changes: ImportControlChange[] = [];
  const controls: PackControlInput[] = [];
  const keptRefs = new Set<string>();
  /** kept edits whose source text is new since the last accepted import: worth an admin's review */
  let freshKept = 0;
  for (const ref of refs) {
    const inc = incoming.get(ref);
    const cur = existing.get(ref);
    if (!inc) {
      changes.push({ controlRef: ref, kind: "not_in_source", current: textOf(cur!), incoming: null });
      controls.push(cur!);
      continue;
    }
    const incText = textOf(inc);
    if (!cur) {
      changes.push({ controlRef: ref, kind: "added", current: null, incoming: incText });
      controls.push({
        controlRef: ref,
        title: inc.title,
        description: inc.description,
        coverage: "unaddressed",
        collector: "none",
        collectorParams: {},
        minEvidenceCount: 1,
        attestationRequired: false,
        ownerNote: null,
      });
      continue;
    }
    const curText = textOf(cur);
    let kind: ImportChangeKind;
    let upstreamChanged: boolean | undefined;
    if (sameText(curText, incText)) kind = "unchanged";
    else {
      const base = baseline.get(ref);
      const edited = !base || !sameText(base, curText);
      if (!edited) kind = "text_updated";
      else {
        keptRefs.add(ref);
        upstreamChanged = !base || !sameText(base, incText);
        kind = take.has(ref) ? "edited_replaced" : "kept_edited";
        if (kind === "kept_edited" && upstreamChanged) freshKept += 1;
      }
    }
    changes.push({ controlRef: ref, kind, current: curText, incoming: incText, ...(upstreamChanged === undefined ? {} : { upstreamChanged }) });
    const useIncoming = kind === "text_updated" || kind === "edited_replaced";
    controls.push({ ...cur, ...(useIncoming ? { title: incText.title, description: incText.description } : {}) });
  }

  const summary = Object.fromEntries(IMPORT_CHANGE_KINDS.map((k) => [k, 0])) as Record<ImportChangeKind, number>;
  for (const c of changes) summary[c.kind] += 1;
  const contentSha256 = importContentSha256(snapshot);
  const s = snapshot.source;
  const proposedPack = createCompliancePackSchema.parse({
    framework,
    version: (current?.version ?? 0) + 1,
    title: current?.title ?? clip(`${s.title} (imported)`, 300),
    description:
      current?.description ??
      `Control text imported from ${s.publisher}'s published ${s.title} (${s.sourceVersion}). ` +
        "Every imported control starts unmapped until an admin maps it to evidence.",
    provenance: {
      source: clip(`${s.publisher} — ${s.title}`, 300),
      catalogueRevision: clip(`${s.sourceVersion} (${s.upstreamRevision})`, 200),
      reviewedBy: null,
      reviewedOn: null,
      note: clip(
        `Imported from ${s.upstreamUrl} under ${s.licence} (${s.licenceUrl}), retrieved ${s.retrievedOn}, ` +
          `upstream sha256 ${s.upstreamSha256}, content sha256 ${contentSha256}.`,
        2000,
      ),
    },
    cascadeTag: current?.cascadeTag ?? null,
    cascadePreset: current?.cascadePreset ?? null,
    controls,
  });
  return {
    framework,
    sourceId: s.sourceId,
    sourceVersion: s.sourceVersion,
    contentSha256,
    fromVersion: current?.version ?? null,
    toVersion: proposedPack.version,
    changes,
    summary,
    noChange: summary.added + summary.text_updated + summary.edited_replaced + freshKept === 0,
    unknownResolutions: [...take].filter((r) => !keptRefs.has(r)).sort(),
    proposedPack,
  };
}

// ---------------------------------------------------------------------------
// The feed diff
// ---------------------------------------------------------------------------

export interface FeedImportDiff {
  added: string[];
  removed: string[];
  changed: string[];
  unchanged: number;
  noChange: boolean;
}

/** what accepting `next` would change against the feed entries accepted before */
export function diffFeedEntries(previous: readonly RegulatoryUpdate[] | null, next: readonly RegulatoryUpdate[]): FeedImportDiff {
  const prev = new Map((previous ?? []).map((e) => [e.key, canonicalJson(e)]));
  const nxt = new Map(next.map((e) => [e.key, canonicalJson(e)]));
  const added = [...nxt.keys()].filter((k) => !prev.has(k)).sort();
  const removed = [...prev.keys()].filter((k) => !nxt.has(k)).sort();
  const changed = [...nxt.keys()].filter((k) => prev.has(k) && prev.get(k) !== nxt.get(k)).sort();
  const unchanged = nxt.size - added.length - changed.length;
  return { added, removed, changed, unchanged, noChange: added.length + removed.length + changed.length === 0 };
}

/**
 * The feed a reader sees: the hand-curated entries plus every accepted import.
 * A curated entry wins a key collision, because a person verified it.
 */
export function mergeRegulatoryFeeds(
  curated: readonly RegulatoryUpdate[],
  imported: ReadonlyArray<readonly RegulatoryUpdate[]>,
): RegulatoryUpdate[] {
  const out = new Map(curated.map((e) => [e.key, e]));
  for (const list of imported) for (const e of list) if (!out.has(e.key)) out.set(e.key, e);
  return [...out.values()];
}
