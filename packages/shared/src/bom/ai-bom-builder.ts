/**
 * ADR-0189 slice B3 — the PURE AI BOM BUILDER: a loaded record set and the
 * snapshot metadata in, the exact bytes of the signed native body
 * (`regulait.ai-bom.v1`) and of each CycloneDX rendering out.
 *
 * A pure function of its inputs (§5 "exact bytes"): no clock, no randomness,
 * no locale, no I/O beyond the bundled schema files; input order does not
 * matter (`normaliseAiBomRecords` sorts every list). The renderings are
 * produced once, validated against the official schema, and their SHA-256
 * and byte length go INSIDE the native body, which is what gets signed (R7).
 *
 * Invariants checked here, each a refusal (never a redaction):
 *  - R10: no email shape anywhere, keys included, in the native body or any
 *    rendering (the broad spike B0 scan: any `@` with a non-space character on
 *    each side, so dotless and quoted forms are caught; fail closed);
 *  - the composition rule: never `complete`, and every gap is in a
 *    non-complete composition (not relaxable);
 *  - every bom-ref is unique;
 *  - canonical JSON carries safe integers and ASCII object keys only (the B1
 *    security round's number/key rule);
 *  - the B1 zod contract `aiBomNativeBodySchema` (serial number, install key,
 *    supersedes, R47 endpoint shape).
 */
import {
  AI_BOM_INSTALL_SUBJECT_ID,
  AI_BOM_VERSION,
  aiBomNativeBodySchema,
  aiBomSerialNumber,
  bomCanonicalBytes,
  bomDigestOf,
  bomJsonSafeIssues,
  bomSha256,
  type AiBomNativeBody,
  type BomRenderingFormat,
} from "./contract.js";
import { AI_BOM_RECORD_LISTS, AI_BOM_RECORD_TABLES, aiBomRecordKey, cmpCodeUnits, normaliseAiBomRecords, sortedBy, type AiBomRecordSet } from "./ai-bom-records.js";
import { renderAiBomCycloneDx, type AiBomGap, type AiBomSnapshotMeta, type CycloneDxRenderResult, type CycloneDxSpecVersion } from "./ai-bom-cyclonedx.js";
import { cycloneDxValidatorId, validateCycloneDx } from "./ai-bom-cyclonedx-schema.js";
import { renderAiBomSpdx, spdxMandatoryMissing } from "./ai-bom-spdx.js";
import { spdxValidatorId, validateSpdx } from "./ai-bom-spdx-schema.js";

export class AiBomBuildError extends Error {
  constructor(message: string, readonly paths: string[] = []) {
    super(`ai-bom build refused: ${message}${paths.length ? ` (${paths.slice(0, 8).join("; ")})` : ""}`);
    this.name = "AiBomBuildError";
  }
}

// ---------------------------------------------------------------------------
// invariant scans
// ---------------------------------------------------------------------------

/** R10, spike B0 §11: any `@` with a non-space character on both sides */
const EMAIL_BROAD = /[^\s@]@[^\s@]/u;
export function findEmailShapesBroad(value: unknown, at = "$"): string[] {
  const hits: string[] = [];
  const walk = (v: unknown, p: string) => {
    if (typeof v === "string") {
      if (EMAIL_BROAD.test(v)) hits.push(p);
    } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${p}[${i}]`));
    else if (v !== null && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) {
        if (EMAIL_BROAD.test(k)) hits.push(`${p}{key ${JSON.stringify(k)}}`);
        walk(x, `${p}.${k}`);
      }
    }
  };
  walk(value, at);
  return hits;
}

/** canonical JSON rule (the B1 security round): B1's `bomJsonSafeIssues`, one definition for facts and AI BOMs */
export const findNonCanonicalShapes = (value: unknown): string[] => bomJsonSafeIssues(value);

/** every `bom-ref` in a CycloneDX document; duplicates are reported */
export function duplicateBomRefs(doc: unknown): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v !== null && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) {
        if (k === "bom-ref" && typeof x === "string") (seen.has(x) ? dupes : seen).add(x);
        else walk(x);
      }
    }
  };
  walk(doc);
  return [...dupes].sort(cmpCodeUnits);
}

/**
 * THE COMPOSITION INVARIANT on a rendered document: no `complete` aggregate
 * anywhere, and every gap's ref (other than a declaration claim) is an
 * assembly of some non-complete composition. Returns the problems.
 */
export function compositionProblems(doc: { compositions?: unknown }, gaps: readonly AiBomGap[]): string[] {
  const comps = (Array.isArray(doc.compositions) ? doc.compositions : []) as Array<{ aggregate?: string; assemblies?: string[] }>;
  const out: string[] = [];
  const covered = new Set<string>();
  const gapRefs = new Set(gaps.filter((g) => !g.ref.startsWith("claim:")).map((g) => g.ref));
  comps.forEach((c, i) => {
    if (c.aggregate === "complete") {
      const bad = (c.assemblies ?? []).filter((a) => gapRefs.has(a));
      out.push(bad.length ? `composition ${i} is complete with unrecorded member(s) ${bad.join(", ")}` : `composition ${i} is complete`);
    } else for (const a of c.assemblies ?? []) covered.add(a);
  });
  for (const r of gapRefs) if (!covered.has(r)) out.push(`gap ${r} is in no incomplete composition`);
  return out;
}

// ---------------------------------------------------------------------------
// build
// ---------------------------------------------------------------------------

export interface AiBomRendering {
  format: BomRenderingFormat;
  bytes: string;
  sha256: string;
  byteLength: number;
  validator: string;
}

export interface AiBomBuild {
  /** the normalised record set the body was built from */
  records: AiBomRecordSet;
  body: AiBomNativeBody;
  /** the exact RFC 8785 bytes that are signed and stored */
  bodyBytes: string;
  bodySha256: string;
  renderings: AiBomRendering[];
  gaps: AiBomGap[];
  /** R22: each loaded record's table, key and SHA-256 */
  basis: AiBomNativeBody["snapshot"]["basis"];
}

export interface AiBomBuildOptions {
  /** `cyclonedx_export_versions`: 1.7 always; 1.6 when the admin added it */
  cyclonedxVersions: readonly CycloneDxSpecVersion[];
}

const formatOf = (v: CycloneDxSpecVersion): BomRenderingFormat => (v === "1.7" ? "cyclonedx-1.7" : "cyclonedx-1.6");

/** the subject's own record, by kind (R31) */
function subjectRecord(n: AiBomRecordSet): Record<string, unknown> {
  switch (n.subject.kind) {
    case "use_case": {
      const u = n.useCases.find((x) => x.id === n.subject.id);
      if (!u) throw new AiBomBuildError("the use case subject is not in the record set");
      return { kind: "use_case", ...u };
    }
    case "agent": {
      const a = n.agents.find((x) => x.id === n.subject.id);
      if (!a) throw new AiBomBuildError("the agent subject is not in the record set");
      return { kind: "agent", ...a };
    }
    case "builder_agent": {
      const b = n.builderAgents.find((x) => x.id === n.subject.id);
      if (!b) throw new AiBomBuildError("the builder agent subject is not in the record set");
      return { kind: "builder_agent", ...b };
    }
    case "install":
      return { kind: "install", installId: n.install?.installId ?? null };
  }
}

export function buildAiBom(records: AiBomRecordSet, meta: AiBomSnapshotMeta, opts: AiBomBuildOptions): AiBomBuild {
  const n = normaliseAiBomRecords(records);
  if (n.subject.kind !== meta.subjectKind || n.subject.id !== meta.subjectId) throw new AiBomBuildError("the record set is for another subject");
  if (meta.subjectKind === "install" && meta.subjectId !== AI_BOM_INSTALL_SUBJECT_ID) throw new AiBomBuildError("the install subject key is the nil uuid (R20)");
  const versions = [...new Set(opts.cyclonedxVersions)];
  if (!versions.includes("1.7")) throw new AiBomBuildError("CycloneDX 1.7 is always rendered (OWNER DECISION 6)");

  let gaps: AiBomGap[] = [];
  let compositions: CycloneDxRenderResult["compositions"] = [];
  let cdx17: CycloneDxRenderResult | null = null;
  const renderings: AiBomRendering[] = [];
  for (const v of versions.sort(cmpCodeUnits).reverse()) {
    const r = renderAiBomCycloneDx(n, meta, v);
    const problems = [
      ...compositionProblems(r.doc as { compositions?: unknown }, r.gaps),
      ...duplicateBomRefs(r.doc).map((d) => `duplicate bom-ref ${d}`),
      ...findNonCanonicalShapes(r.doc),
    ];
    if (problems.length) throw new AiBomBuildError(`CycloneDX ${v} invariants`, problems);
    const emails = findEmailShapesBroad(r.doc);
    if (emails.length) throw new AiBomBuildError(`email-shaped value in cyclonedx-${v}`, emails);
    const checked = validateCycloneDx(r.doc, v);
    if (!checked.valid) throw new AiBomBuildError(`CycloneDX ${v} schema validation failed`, checked.errors.map((e) => `${e.path} ${e.message}`));
    const bytes = bomCanonicalBytes(r.doc);
    renderings.push({ format: formatOf(v), bytes, sha256: bomSha256(bytes), byteLength: Buffer.byteLength(bytes, "utf8"), validator: cycloneDxValidatorId(v) });
    if (v === "1.7") {
      gaps = r.gaps;
      compositions = r.compositions;
      cdx17 = r;
    }
  }

  // ------------------------------------------------------------- SPDX 3.0.1 (slice B5; R2: every v1 renderer at freeze)
  // R3 + 4237371312: a mandatory literal property with no recorded value means NO SPDX rendering for this snapshot;
  // the signed body records `not_producible` with the missing property names. Never a placeholder.
  const notProducible: Partial<Record<BomRenderingFormat, { status: "not_producible"; missing: string[] }>> = {};
  {
    const spdx = renderAiBomSpdx(n, meta, cdx17!).doc;
    const missing = spdxMandatoryMissing(spdx);
    if (missing.length) notProducible["spdx-3.0.1"] = { status: "not_producible", missing };
    else {
      const problems = findNonCanonicalShapes(spdx);
      if (problems.length) throw new AiBomBuildError("SPDX 3.0.1 invariants", problems);
      const emails = findEmailShapesBroad(spdx);
      if (emails.length) throw new AiBomBuildError("email-shaped value in spdx-3.0.1", emails);
      const checked = validateSpdx(spdx);
      if (!checked.valid) throw new AiBomBuildError("SPDX 3.0.1 schema validation failed", checked.errors.map((e) => `${e.path} ${e.message}`));
      const bytes = bomCanonicalBytes(spdx);
      renderings.push({ format: "spdx-3.0.1", bytes, sha256: bomSha256(bytes), byteLength: Buffer.byteLength(bytes, "utf8"), validator: spdxValidatorId() });
    }
  }

  const basis = sortedBy(
    AI_BOM_RECORD_LISTS.flatMap((list) =>
      (n[list] as unknown as Array<Record<string, unknown>>).map((rec) => ({ table: AI_BOM_RECORD_TABLES[list], id: aiBomRecordKey(list, rec), sha256: bomDigestOf(rec) })),
    ),
    (b) => `${b.table}\u0000${b.id}`,
  );
  const recordsOut = Object.fromEntries(AI_BOM_RECORD_LISTS.map((list) => [list, n[list]]));
  const candidate = {
    v: AI_BOM_VERSION,
    snapshot: { id: meta.id, subjectKind: meta.subjectKind, subjectId: meta.subjectId, version: meta.version, supersedes: meta.supersedes, trigger: meta.trigger, createdAt: meta.createdAt, basis },
    serialNumber: `urn:uuid:${aiBomSerialNumber(meta.id)}`,
    subject: subjectRecord(n),
    records: recordsOut,
    unrecorded: gaps,
    compositions,
    renderings: {
      ...Object.fromEntries(renderings.map((r) => [r.format, { status: "rendered", sha256: r.sha256, bytes: r.byteLength, validator: r.validator }])),
      ...notProducible,
    },
  };
  const shapes = findNonCanonicalShapes(candidate);
  if (shapes.length) throw new AiBomBuildError("native body is not canonical-safe", shapes);
  const emails = findEmailShapesBroad(candidate);
  if (emails.length) throw new AiBomBuildError("email-shaped value in the native body", emails);
  const parsed = aiBomNativeBodySchema.safeParse(candidate);
  if (!parsed.success) throw new AiBomBuildError("native body fails the regulait.ai-bom.v1 contract", parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`));
  const bodyBytes = bomCanonicalBytes(candidate);
  return { records: n, body: parsed.data, bodyBytes, bodySha256: bomSha256(bodyBytes), renderings, gaps, basis };
}

// ---------------------------------------------------------------------------
// drift (R8): a change list, never a BOM document
// ---------------------------------------------------------------------------

export interface AiBomInventoryEntry {
  ref: string;
  version: string | null;
  hashes: string[];
}

/** the components and services (nested included) of a CycloneDX doc, by bom-ref */
export function aiBomInventoryIndex(doc: unknown): Map<string, AiBomInventoryEntry> {
  const out = new Map<string, AiBomInventoryEntry>();
  const add = (x: Record<string, unknown>) => {
    const ref = x["bom-ref"];
    if (typeof ref !== "string") return;
    const hashes = Array.isArray(x.hashes) ? (x.hashes as Array<{ alg: string; content: string }>).map((h) => `${h.alg}:${h.content}`).sort(cmpCodeUnits) : [];
    out.set(ref, { ref, version: typeof x.version === "string" ? x.version : null, hashes });
  };
  const d = (doc ?? {}) as Record<string, unknown>;
  for (const c of (d.components as Array<Record<string, unknown>> | undefined) ?? []) add(c);
  const services = (list: Array<Record<string, unknown>> | undefined) => {
    for (const s of list ?? []) {
      add(s);
      services(s.services as Array<Record<string, unknown>> | undefined);
    }
  };
  services(d.services as Array<Record<string, unknown>> | undefined);
  return out;
}

export const AI_BOM_DRIFT_CHANGES = ["added", "removed", "changed_hash", "changed_version"] as const;
export interface AiBomDriftChange {
  ref: string;
  change: (typeof AI_BOM_DRIFT_CHANGES)[number];
  before: { version: string | null; hashes: string[] } | null;
  after: { version: string | null; hashes: string[] } | null;
}

/** the change list of `live` against `baseline`, sorted by ref then change */
export function diffAiBomInventory(baseline: Map<string, AiBomInventoryEntry>, live: Map<string, AiBomInventoryEntry>): AiBomDriftChange[] {
  const out: AiBomDriftChange[] = [];
  const view = (e: AiBomInventoryEntry) => ({ version: e.version, hashes: e.hashes });
  for (const [ref, b] of baseline) {
    const l = live.get(ref);
    if (!l) out.push({ ref, change: "removed", before: view(b), after: null });
    else {
      if (b.hashes.join("\n") !== l.hashes.join("\n")) out.push({ ref, change: "changed_hash", before: view(b), after: view(l) });
      if (b.version !== l.version) out.push({ ref, change: "changed_version", before: view(b), after: view(l) });
    }
  }
  for (const [ref, l] of live) if (!baseline.has(ref)) out.push({ ref, change: "added", before: null, after: view(l) });
  return sortedBy(out, (c) => `${c.ref}\u0000${c.change}`);
}
