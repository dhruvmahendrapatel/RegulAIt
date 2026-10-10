/**
 * ADR-0189 slice B5: the SPDX 3.0.1 RENDERER of an AI BOM, pure.
 *
 * Input: the NORMALISED record set (`normaliseAiBomRecords`), the snapshot
 * metadata and the CycloneDX 1.7 render result built from the same records.
 * Output: an SPDX 3.0.1 JSON-LD object. No clock, no randomness, no locale, no
 * I/O. Ported from spike B0 `renderSpdx` (`spikes/bom-b0/render.mjs`, R12 §5)
 * with the real-table rules of B3:
 *
 *  - ONE ELEMENT SET WITH CYCLONEDX. Every CycloneDX component (and the subject
 *    root) becomes exactly one SPDX element, keyed by its bom-ref, so the two
 *    renderings describe the same things from the same normalised records and
 *    inherit every content-safety rule `normaliseAiBomRecords` applies (R47
 *    endpoints, safe references, length caps, data-claim allowlist). Nothing
 *    here reads a raw field the normaliser did not already pass. A component
 *    kind with no mapping below is a build failure, never silently dropped.
 *  - `ai_AIPackage` per model component (one per model card, #280
 *    4237488595, or the agent's unknown model when it has no card);
 *    `dataset_DatasetPackage` per training and evaluation dataset; files for
 *    model artifacts, training artifacts, prompts, configs and skills; a
 *    `software_Package` for the subject, use cases, agents, builder agents and
 *    scan engines (`container`).
 *  - EVERY HASH: each CycloneDX component hash becomes a `verifiedUsing`
 *    entry on its element (R26: only real SHA-256 values; a legacy or empty
 *    dataset checksum gives none, exactly as in CycloneDX).
 *  - Dependencies are the CycloneDX granted edges between rendered elements;
 *    a model's edge to a training dataset is `trainedOn`, to an evaluation
 *    dataset `testedOn`. A model with no known training data says
 *    `trainedOn NoAssertionElement` with `completeness: noAssertion`. Edges to
 *    services (providers, MCP servers and tools, connectors), data flows,
 *    declarations and memory-store descriptors have no SPDX 3.0.1 element;
 *    they stay in the CycloneDX rendering and the signed native body, and the
 *    document's `comment` says so.
 *  - LICENCES (§3): every package and file has `hasDeclaredLicense` and
 *    `hasConcludedLicense`. Concluded is always `NoAssertionLicense` (we never
 *    conclude). Declared is a `simplelicensing_LicenseExpression` only when
 *    the recorded value (a model card's supplier-declared `license` claim, an
 *    engine's catalogue licence) is EXACTLY one SPDX licence identifier from
 *    the list bundled in the pinned CycloneDX library; anything else
 *    (unknown, a prose name, an exception id, a compound expression) is
 *    `NoAssertionLicense`, never guessed.
 *  - R3 and the B5 entry condition (4237371312): mandatory literal properties
 *    with no recorded value are OMITTED, never filled; `spdxMandatoryMissing`
 *    then names them and the builder records `not_producible` instead of a
 *    rendering. `releaseTime` and `downloadLocation` come only from the
 *    supplier-declared model-card claims, and only when they are already a
 *    valid SPDX DateTime and an https origin that B3's endpoint rule leaves
 *    unchanged (`isSpdxDownloadLocation`).
 *  - B9 (OWNER DECISION 13, R51): the CURRENT supplier-declared values in
 *    `n.spdxFields` (from `ai_bom_spdx_declarations`) fill the properties no
 *    other table records. A model's declared `releaseTime` and
 *    `downloadLocation` come before its card's `data_claims` value; a declared
 *    `packageVersion` is used only when the card has no pinned version. A
 *    dataset gains `builtTime`, `originatedBy` (an Organization), `releaseTime`,
 *    `downloadLocation` and `datasetType`; with no declared type it keeps the
 *    standard's `noAssertion`. Each value passes the same literal checks as
 *    before; one still missing keeps the rendering not_producible.
 *  - IRIs: `https://regulait.invalid/spdx/ai-bom/<snapshot id>/v<version>#…`
 *    with each fragment `<kind>-<sha256(bom-ref)[0:32]>`, so no name, engine id
 *    or provider name ever reaches an IRI except as a digest.
 *  - amendment 5: `created` is truncated to whole seconds.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { bomCanonicalBytes, isBomExportEndpoint } from "./contract.js";
import { cmpCodeUnits, sanitiseAiBomEndpoint, sortedBy, type AiBomRecordSet, type ModelCardRecord } from "./ai-bom-records.js";
import { AI_BOM_BUILDER_NAME, AI_BOM_BUILDER_VERSION, trainingDataDeclared, type AiBomSnapshotMeta, type CycloneDxRenderResult } from "./ai-bom-cyclonedx.js";

export const SPDX_CONTEXT_URL = "https://spdx.org/rdf/3.0.1/spdx-context.jsonld";
export const SPDX_NO_ASSERTION_LICENSE = "expandedlicensing_NoAssertionLicense";
export const SPDX_NO_ASSERTION_ELEMENT = "NoAssertionElement";

/** R11 / R24: the persisted sensitivity vocabulary mapped to the SPDX confidentiality levels */
export const SPDX_CONFIDENTIALITY: Readonly<Record<string, string>> = { public: "clear", internal: "green", confidential: "amber", regulated: "red" };

/**
 * R3 (`AIPackage`) and the B5 entry condition 4237371312 (`DatasetPackage`):
 * the properties SPDX 3.0.1 makes mandatory (minCount 1) that the official
 * SHACL model does not enforce. Checked explicitly beside schema and SHACL.
 */
export const SPDX_MANDATORY: Readonly<Record<string, readonly string[]>> = {
  ai_AIPackage: ["releaseTime", "software_downloadLocation", "software_packageVersion", "software_primaryPurpose", "suppliedBy"],
  dataset_DatasetPackage: ["builtTime", "dataset_datasetType", "originatedBy", "releaseTime", "software_downloadLocation", "software_primaryPurpose"],
};

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };
type Obj = { [k: string]: Json };

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

// ---------------------------------------------------------------------------
// the SPDX licence list, read from the pinned CycloneDX library (no new dependency, ADR-0176)
// ---------------------------------------------------------------------------

let licenceIds: ReadonlySet<string> | null = null;
/**
 * The SPDX licence identifiers bundled in `@cyclonedx/cyclonedx-library`'s
 * `spdx.SNAPSHOT.schema.json` (SPDX licence list 3.29.0 in 10.3.0). That list
 * also holds exception ids, which are not a licence on their own: every id
 * containing "exception" is left out (stricter: a few deprecated
 * `GPL-…-with-…-exception` ids then map to NoAssertion).
 */
export function spdxLicenceIds(): ReadonlySet<string> {
  if (!licenceIds) {
    const require = createRequire(import.meta.url);
    const file = path.join(path.dirname(require.resolve("@cyclonedx/cyclonedx-library/package.json")), "res", "schema", "spdx.SNAPSHOT.schema.json");
    const list = (JSON.parse(readFileSync(file, "utf8")) as { enum: string[] }).enum;
    licenceIds = new Set(list.filter((id) => !id.toLowerCase().includes("exception")));
  }
  return licenceIds;
}
/** a recorded licence is used only when it is EXACTLY one listed identifier (no parsing, no case folding) */
export const isSpdxLicenceId = (v: string | null | undefined): v is string => typeof v === "string" && spdxLicenceIds().has(v);

// ---------------------------------------------------------------------------
// literal checks (linear: fixed length first, then one anchored flat pattern)
// ---------------------------------------------------------------------------

const SPDX_DATETIME = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/;
/** an SPDX DateTime: `YYYY-MM-DDThh:mm:ssZ`, a real instant, whole seconds */
export function isSpdxDateTime(v: unknown): v is string {
  if (typeof v !== "string" || v.length !== 20 || !SPDX_DATETIME.test(v)) return false;
  const t = Date.parse(v);
  return Number.isFinite(t) && new Date(t).toISOString() === `${v.slice(0, 19)}.000Z`;
}
/**
 * A download location we may export: an https ORIGIN only, exactly as B3's endpoint rule leaves it
 * (`sanitiseAiBomEndpoint`: R47 and #280 4237493036, a path can carry a credential such as `/bot<TOKEN>/`).
 * B3's normaliser already reduces a `downloadLocation` claim to that origin (PR #287 security round); this
 * check is defence in depth: a value with a path, query, fragment or userinfo is not exported, so the
 * property is missing and the rendering is not_producible (R3). The renderer never rewrites it itself.
 */
export function isSpdxDownloadLocation(v: unknown): v is string {
  if (typeof v !== "string" || !v.startsWith("https://") || !isBomExportEndpoint(v)) return false;
  try {
    return sanitiseAiBomEndpoint(v, "downloadLocation") === v;
  } catch {
    return false;
  }
}

/** amendment 5: SPDX `created` in whole seconds, from the row time (`…T..:..:...sssZ`) */
export function spdxCreatedTime(iso: string): string {
  const t = Date.parse(iso);
  if (iso.length !== 24 || !Number.isFinite(t) || new Date(t).toISOString() !== iso) throw new Error("ai-bom spdx: createdAt is not an ISO-8601 UTC time with milliseconds");
  return `${iso.slice(0, 19)}Z`;
}

const claimText = (card: ModelCardRecord | undefined, k: string): string | null => {
  const v = card?.dataClaims[k];
  return typeof v === "string" && v.trim() ? v : null;
};

// ---------------------------------------------------------------------------
// render
// ---------------------------------------------------------------------------

export interface SpdxRenderResult {
  doc: Obj;
}

/** the CycloneDX component kinds carried only in CycloneDX (no SPDX 3.0.1 element) */
const CYCLONEDX_ONLY_PREFIXES = ["memory"] as const;

export const SPDX_DOCUMENT_COMMENT =
  "RegulAIt AI BOM, SPDX 3.0.1 view. The signed regulait.ai-bom.v1 body is the authority. Provider endpoints, MCP servers and tools, connectors, data flows, granted tool edges, scan and evidence declarations, memory-store descriptors and compositions have no SPDX 3.0.1 element and are carried in the CycloneDX rendering only. Concluded licences are never asserted. A relationship marked incomplete has members the build could not fully describe.";

export function renderAiBomSpdx(n: AiBomRecordSet, meta: AiBomSnapshotMeta, cdx: CycloneDxRenderResult): SpdxRenderResult {
  const doc = cdx.doc as { metadata: { component: Obj }; components: Obj[]; dependencies: Array<{ ref: string; dependsOn?: string[] }> };
  const base = `https://regulait.invalid/spdx/ai-bom/${meta.id}/v${meta.version}`;
  const iri = (k: string) => `${base}#${k}`;
  const ci = "_:creationinfo";
  const ids = new Map<string, string>(); // bom-ref -> spdxId
  const used = new Set<string>();
  const idFor = (ref: string): string => {
    const known = ids.get(ref);
    if (known) return known;
    const prefix = ref.slice(0, ref.indexOf(":") === -1 ? ref.length : ref.indexOf(":"));
    const id = iri(`${prefix}-${sha256(ref).slice(0, 32)}`);
    if (used.has(id)) throw new Error(`ai-bom spdx: identifier collision for ${ref}`);
    used.add(id);
    ids.set(ref, id);
    return id;
  };
  const elements: Obj[] = [];
  const el = (o: Obj): string => {
    elements.push({ ...o, creationInfo: ci });
    return o.spdxId as string;
  };

  const installOrg = el({ type: "Organization", spdxId: iri("org-install"), name: n.install?.installId ? `RegulAIt install ${n.install.installId}` : "RegulAIt install (install id not recorded)" });
  const tool = el({ type: "Tool", spdxId: iri("tool"), name: `${AI_BOM_BUILDER_NAME}/${AI_BOM_BUILDER_VERSION}` });
  const suppliers = new Map<string, string>();
  const supplier = (name: string): string => {
    if (!suppliers.has(name)) suppliers.set(name, el({ type: "Organization", spdxId: iri(`supplier-${sha256(name).slice(0, 32)}`), name }));
    return suppliers.get(name)!;
  };
  const licences = new Map<string, string>();
  const licence = (id: string): string => {
    if (!licences.has(id)) licences.set(id, el({ type: "simplelicensing_LicenseExpression", spdxId: iri(`license-${sha256(id).slice(0, 32)}`), simplelicensing_licenseExpression: id }));
    return licences.get(id)!;
  };
  const declared = new Map<string, string>(); // spdxId -> declared licence target

  const verified = (c: Obj): Obj => {
    const hashes = (Array.isArray(c.hashes) ? c.hashes : []) as Array<{ alg: string; content: string }>;
    for (const h of hashes) if (h.alg !== "SHA-256") throw new Error(`ai-bom spdx: unexpected hash algorithm ${h.alg}`);
    return hashes.length ? { verifiedUsing: sortedBy(hashes, (h) => h.content).map((h) => ({ type: "Hash", algorithm: "sha256", hashValue: h.content })) } : {};
  };
  const cardsById = new Map(n.modelCards.map((c) => [c.id, c]));
  const agentsById = new Map(n.agents.map((a) => [a.id, a]));
  const trainingDs = new Map(n.trainingDatasets.map((d) => [`${d.id}:${d.version}`, d]));
  const enginesById = new Map(n.engines.map((e) => [e.id, e]));
  const declaredFields = new Map((n.spdxFields ?? []).map((f) => [`${f.subjectKind}:${f.subjectId}`, f]));

  // ------------------------------------------------------------- the subject root (R31: its own record, never synthetic)
  const root = doc.metadata.component;
  const rootRef = root["bom-ref"] as string;
  const subjectId = el({ type: "software_Package", spdxId: idFor(rootRef), name: root.name as string, software_primaryPurpose: "application", suppliedBy: installOrg });

  // ------------------------------------------------------------- one element per CycloneDX component
  for (const c of doc.components) {
    const ref = c["bom-ref"] as string;
    const prefix = ref.slice(0, ref.indexOf(":"));
    const name = c.name as string;
    if ((CYCLONEDX_ONLY_PREFIXES as readonly string[]).includes(prefix)) continue;
    const spdxId = idFor(ref);
    switch (prefix) {
      case "use-case":
      case "builder-agent":
        el({ type: "software_Package", spdxId, name, software_primaryPurpose: "application" });
        break;
      case "agent": {
        const a = agentsById.get(ref.slice("agent:".length));
        if (!a) throw new Error(`ai-bom spdx: agent ${ref} not in the record set`);
        el({ type: "software_Package", spdxId, name, software_primaryPurpose: "application", suppliedBy: supplier(a.provider) });
        break;
      }
      case "model": {
        const agentModel = ref.startsWith("model:agent:");
        const card = agentModel ? undefined : cardsById.get(ref.slice("model:".length));
        if (!agentModel && !card) throw new Error(`ai-bom spdx: model card ${ref} not in the record set`);
        const supplierName = (c.supplier as { name: string } | undefined)?.name;
        if (!supplierName) throw new Error(`ai-bom spdx: model ${ref} has no supplier`);
        const decl = card ? declaredFields.get(`model_card:${card.id}`) : undefined;
        // R51: a declared value first, then the card's supplier-declared claim (B5's source)
        const releaseTime = decl?.releaseTime ?? claimText(card, "releaseTime");
        const downloadLocation = decl?.downloadLocation ?? claimText(card, "downloadLocation");
        const packageVersion = card?.pinnedModelVersion ?? decl?.packageVersion ?? null;
        const training = card && trainingDataDeclared(card) ? `supplier-declared: ${String(card.dataClaims.trainingData)}` : "unknown";
        const arch = claimText(card, "architecture");
        el({
          type: "ai_AIPackage", spdxId, name,
          software_primaryPurpose: "model",
          suppliedBy: supplier(supplierName),
          // #280 round 12: the card's pinned version, else (R51) a declared one; an agent has no version column. Never a placeholder (R3).
          ...(packageVersion ? { software_packageVersion: packageVersion } : {}),
          // R3: supplier-declared only, and only when already a valid SPDX literal; otherwise omitted (not_producible)
          ...(isSpdxDateTime(releaseTime) ? { releaseTime } : {}),
          ...(isSpdxDownloadLocation(downloadLocation) ? { software_downloadLocation: downloadLocation } : {}),
          ai_autonomyType: "noAssertion",
          ai_useSensitivePersonalInformation: "noAssertion",
          ai_informationAboutTraining: training,
          ...(card ? { ai_informationAboutApplication: card.intendedUse } : {}),
          ...(card?.limitations ? { ai_limitation: card.limitations } : {}),
          ...(arch ? { ai_typeOfModel: [arch] } : {}),
          ...(card?.standardRefs.length ? { ai_standardCompliance: card.standardRefs } : {}),
        });
        const declaredLicence = claimText(card, "license");
        if (isSpdxLicenceId(declaredLicence)) declared.set(spdxId, licence(declaredLicence));
        break;
      }
      case "dataset": {
        const training = ref.startsWith("dataset:training:");
        const d = training ? trainingDs.get(ref.slice("dataset:training:".length)) : undefined;
        if (training && !d) throw new Error(`ai-bom spdx: training dataset ${ref} not in the record set`);
        // `dataset:<training|eval>:<row id>:<version>`: the row id is the 36 characters after the kind prefix
        const rowId = ref.slice(training ? "dataset:training:".length : "dataset:eval:".length).slice(0, 36);
        const dd = declaredFields.get(`${training ? "training_dataset" : "eval_dataset"}:${rowId}`);
        el({
          type: "dataset_DatasetPackage", spdxId, name, software_packageVersion: c.version as string,
          software_primaryPurpose: "data",
          // R51: declared values only, each re-checked; builtTime, originatedBy, releaseTime and
          // downloadLocation have no no-assertion form, so a missing one is omitted and the rendering is not_producible
          ...(isSpdxDateTime(dd?.builtTime) ? { builtTime: dd!.builtTime } : {}),
          ...(dd?.originatedBy ? { originatedBy: [supplier(dd.originatedBy)] } : {}),
          ...(isSpdxDateTime(dd?.releaseTime) ? { releaseTime: dd!.releaseTime } : {}),
          ...(isSpdxDownloadLocation(dd?.downloadLocation) ? { software_downloadLocation: dd!.downloadLocation } : {}),
          // the standard's own no-assertion value when no type is declared (R3)
          dataset_datasetType: dd?.datasetType.length ? [...dd.datasetType] : ["noAssertion"],
          // R24: training classification only from the linked project; evaluation datasets have none
          ...(d?.projectDataSensitivity ? { dataset_confidentialityLevel: SPDX_CONFIDENTIALITY[d.projectDataSensitivity]! } : {}),
          // R11: flagged/blocked are known sensitive; clean (and an unscanned eval set) is no assertion
          dataset_hasSensitivePersonalInformation: d && d.piiVerdict !== "clean" ? "yes" : "noAssertion",
          ...verified(c),
        });
        break;
      }
      case "artifact":
      case "training-artifact":
        el({ type: "software_File", spdxId, name, software_primaryPurpose: "model", ...verified(c) });
        break;
      case "prompt":
      case "config":
      case "skill":
        el({ type: "software_File", spdxId, name, software_primaryPurpose: "configuration", ...verified(c) });
        break;
      case "engine": {
        const engineId = name;
        el({ type: "software_Package", spdxId, name, software_primaryPurpose: "container", software_packageVersion: c.version as string, ...verified(c) });
        const e = enginesById.get(engineId);
        if (e && isSpdxLicenceId(e.licence)) declared.set(spdxId, licence(e.licence));
        break;
      }
      default:
        throw new Error(`ai-bom spdx: no SPDX mapping for component kind ${prefix} (${ref})`);
    }
  }

  // ------------------------------------------------------------- relationships
  const rels: Obj[] = [];
  const rel = (from: string, type: string, to: string[], extra: Obj = {}) => {
    const sortedTo = [...to].sort(cmpCodeUnits);
    rels.push({ type: "Relationship", spdxId: iri(`rel-${sha256(bomCanonicalBytes([from, type, sortedTo]))}`.slice(0, 4 + 32)), from, relationshipType: type, to: sortedTo, ...extra });
  };
  const gapRefs = new Set(cdx.gaps.map((g) => g.ref));
  const modelHasTraining = new Set<string>();
  for (const d of doc.dependencies) {
    const from = ids.get(d.ref);
    if (!from) continue; // a service, a memory store or a tool: CycloneDX only
    const groups = new Map<string, string[]>();
    for (const to of d.dependsOn ?? []) {
      const target = ids.get(to);
      if (!target) continue;
      const fromModel = d.ref.startsWith("model:") || d.ref.startsWith("training-artifact:");
      const type = fromModel && to.startsWith("dataset:training:") ? "trainedOn" : fromModel && to.startsWith("dataset:eval:") ? "testedOn" : "dependsOn";
      if (type === "trainedOn") modelHasTraining.add(d.ref);
      groups.set(type, [...(groups.get(type) ?? []), target]);
    }
    for (const [type, to] of groups) {
      // the subject's assembly is always incomplete (the CycloneDX composition rule); so is any member with a gap
      const incomplete = d.ref === rootRef || gapRefs.has(d.ref);
      rel(from, type, to, incomplete ? { completeness: "incomplete" } : {});
    }
  }
  for (const c of doc.components) {
    const ref = c["bom-ref"] as string;
    if (ref.startsWith("model:") && !modelHasTraining.has(ref)) rel(ids.get(ref)!, "trainedOn", [SPDX_NO_ASSERTION_ELEMENT], { completeness: "noAssertion" });
  }
  // licences (§3): declared and concluded on every package and file, NoAssertion where unknown
  for (const e of [...elements]) {
    if (!["software_Package", "software_File", "ai_AIPackage", "dataset_DatasetPackage"].includes(e.type as string)) continue;
    const id = e.spdxId as string;
    rel(id, "hasDeclaredLicense", [declared.get(id) ?? SPDX_NO_ASSERTION_LICENSE]);
    rel(id, "hasConcludedLicense", [SPDX_NO_ASSERTION_LICENSE]);
  }
  for (const r of rels) el(r);

  const all = sortedBy(elements, (x) => x.spdxId as string);
  for (let i = 1; i < all.length; i++) if (all[i - 1]!.spdxId === all[i]!.spdxId) throw new Error(`ai-bom spdx: duplicate element ${String(all[i]!.spdxId)}`);
  const document: Obj = {
    type: "SpdxDocument", spdxId: iri("document"), creationInfo: ci,
    name: `AI BOM ${meta.subjectKind} ${meta.subjectId} v${meta.version}`,
    comment: SPDX_DOCUMENT_COMMENT,
    rootElement: [subjectId],
    element: all.map((x) => x.spdxId as string),
    profileConformance: ["ai", "core", "dataset", "simpleLicensing", "software"],
  };
  const creation: Obj = { type: "CreationInfo", "@id": ci, specVersion: "3.0.1", created: spdxCreatedTime(meta.createdAt), createdBy: [installOrg], createdUsing: [tool] };
  return { doc: { "@context": SPDX_CONTEXT_URL, "@graph": [creation, document, ...all] } };
}

/**
 * R3 + 4237371312: every mandatory property that an `ai_AIPackage` or
 * `dataset_DatasetPackage` of `doc` lacks, as sorted unique `<class>.<property>`
 * names. Empty means producible. Independent of the renderer: it reads the doc.
 */
export function spdxMandatoryMissing(doc: unknown): string[] {
  const graph = ((doc ?? {}) as { "@graph"?: unknown })["@graph"];
  if (!Array.isArray(graph)) return ["SpdxDocument.@graph"];
  const out = new Set<string>();
  for (const e of graph as Array<Record<string, unknown>>) {
    const required = SPDX_MANDATORY[e?.type as string];
    if (!required) continue;
    for (const p of required) {
      const v = e[p];
      if (v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0)) out.add(`${e.type as string}.${p}`);
    }
  }
  return [...out].sort(cmpCodeUnits);
}
