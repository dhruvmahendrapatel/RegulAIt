/**
 * ADR-0189 slice B3 — the CycloneDX 1.7 and 1.6 RENDERER of an AI BOM, pure.
 *
 * Input: a NORMALISED record set (`normaliseAiBomRecords`) and the snapshot
 * metadata. Output: a CycloneDX JSON object, plus the `unrecorded` gaps that
 * drive the compositions. No clock, no randomness, no locale: every list is
 * sorted by a stable key in code-unit order, times come from rows, the serial
 * number is the v8 UUID of the snapshot id (amendment 5).
 *
 * ADR-0176 §4 exception (amendment 1, R12 §1): `@cyclonedx/cyclonedx-library`
 * 10.3.0's model lacks `modelCard`, `data`, `declarations`, `compositions` and
 * service `data`/`endpoints`/`trustZone`, and its serializer silently drops
 * them, so this module writes CycloneDX JSON directly and every output is
 * validated against the official schema the library ships
 * (`ai-bom-cyclonedx-schema.ts`). Ported from spike B0 `renderCycloneDx`
 * with B3's real-table rules:
 *
 *  - R31: each subject kind roots at its own record (use case, agent, builder
 *    agent, install), never through a synthetic use case.
 *  - #280 (4237488595): one model component PER MODEL CARD (a card is one
 *    intended use), with the agent depending on each; no card is picked.
 *    #280 round 12 (4237584891): its version is that card's
 *    `pinned_model_version`; agents have no version column.
 *  - #280 round 12 (4237584880): training provenance is `supplier-declared`
 *    only from a NON-EMPTY `trainingData` claim; a card that declares only a
 *    licence has provenance `unknown`.
 *  - R27/R49: provider data flows per use case; with no use case,
 *    `classification: "unknown"` and the composition is incomplete.
 *  - R29: artifact edges through evidence → scan → card; no edge, no guess.
 *  - R12 + 4237376660: one container per exact (engine, version, image
 *    digest); a scan whose engine run is gone has an explicit unknown assessor.
 *  - #280 round 12 (4237584873): skill components keyed by the (agent, skill)
 *    attachment and depended on by the builder agent, not the subject.
 *  - Round 8 (4237322637): the agent's active and canary config versions are
 *    components with id, version and content digest only.
 *  - #280 (4237488600): training artifacts are components; an inline one is
 *    hashed over its payload's canonical bytes, a remote one is incomplete.
 */
import { aiBomSerialNumber, parseTrainingDatasetChecksum, type AiBomSnapshotTrigger, type AiBomSubjectKind } from "./contract.js";
import { cmpCodeUnits, sortedBy, type AgentRecord, type AiBomRecordSet, type ModelCardRecord } from "./ai-bom-records.js";
import { cycloneDxBomLink, RELEASE_SBOM_KINDS } from "./release-sbom-identity.js";
import canonicalize from "canonicalize";

/** the rendering tool's own name and version (a constant: never a clock or a build stamp) */
export const AI_BOM_BUILDER_NAME = "regulait-ai-bom";
export const AI_BOM_BUILDER_VERSION = "1";

export interface AiBomSnapshotMeta {
  id: string;
  subjectKind: AiBomSubjectKind;
  subjectId: string;
  version: number;
  supersedes: string | null;
  trigger: AiBomSnapshotTrigger;
  /** the database clock read inside the capture transaction */
  createdAt: string;
}

/** one thing the build could not fully describe (R24, R26, R27, R29, R30, R9) */
export interface AiBomGap {
  ref: string;
  field: string;
  reason: string;
}

export type CycloneDxSpecVersion = "1.7" | "1.6";
type Json = string | number | boolean | null | Json[] | { [k: string]: Json };
type Obj = { [k: string]: Json };

// ---------------------------------------------------------------------------
// refs (every bom-ref is unique across the document; ids are uuids)
// ---------------------------------------------------------------------------

export const aiBomRef = {
  useCase: (id: string) => `use-case:${id}`,
  install: () => "install",
  agent: (id: string) => `agent:${id}`,
  builderAgent: (id: string) => `builder-agent:${id}`,
  model: (cardId: string) => `model:${cardId}`,
  modelOfAgent: (agentId: string) => `model:agent:${agentId}`,
  modelCard: (cardId: string) => `modelcard:${cardId}`,
  artifact: (id: string) => `artifact:${id}`,
  trainingArtifact: (id: string) => `training-artifact:${id}`,
  engine: (key: string) => `engine:${key}`,
  trainingDataset: (id: string, v: number) => `dataset:training:${id}:${v}`,
  evalDataset: (id: string, v: number) => `dataset:eval:${id}:${v}`,
  prompt: (promptId: string, tag: string) => `prompt:${promptId}:tag:${tag}`,
  config: (type: string, id: string) => `config:${type}:${id}`,
  provider: (agentId: string) => `service:provider:${agentId}`,
  mcp: (id: string) => `service:mcp:${id}`,
  tool: (serverId: string, toolId: string) => `service:mcp:${serverId}:tool:${toolId}`,
  connector: (id: string) => `service:connector:${id}`,
  skill: (agentId: string, skillId: string) => `skill:${agentId}:${skillId}`,
  memory: (kind: string, builderAgentId: string | null) => `memory:${kind}:${builderAgentId ?? "org"}`,
  devTool: (id: string) => `dev-tool:${id}`,
};

const userRef = (id: string | null) => (id === null ? "not_recorded" : `user:${id}`);
const prop = (name: string, value: string | number | boolean | null | undefined): Obj | null =>
  value === null || value === undefined ? null : { name, value: String(value) };
const props = (list: Array<Obj | null>): Obj[] => sortedBy(list.filter((p): p is Obj => p !== null), (p) => `${p.name}\u0000${p.value}`);
const withProps = (list: Array<Obj | null>): Obj => {
  const p = props(list);
  return p.length ? { properties: p } : {};
};
const ownerProps = (id: string | null, displayName: string | null): Array<Obj | null> => [
  prop("regulait:owner", userRef(id)),
  // R45: only for AI BOMs, only when relaxed, read in the same capture
  prop("regulait:owner:displayName", displayName),
];

/** the model card approval in force at snapshot time: approved, not lapsed, newest decision */
export function approvalInForce(n: AiBomRecordSet, cardId: string, at: string): string | null {
  const live = n.modelCardApprovals.filter((a) => a.cardId === cardId && a.status === "approved" && (a.validUntil === null || a.validUntil > at));
  const newest = sortedBy(live, (a) => `${a.decidedAt ?? ""}\u0000${a.id}`).pop();
  return newest?.id ?? null;
}

/** #280 round 12: provenance only from a NON-EMPTY training-data claim */
export const trainingDataDeclared = (card: ModelCardRecord): boolean =>
  typeof card.dataClaims.trainingData === "string" ? card.dataClaims.trainingData.trim().length > 0 : card.dataClaims.trainingData === true;

const claimText = (card: ModelCardRecord, k: string): string | null => {
  const v = card.dataClaims[k];
  return typeof v === "string" && v.trim() ? v : null;
};

// ---------------------------------------------------------------------------
// scope: which records hang off which (all derived, never invented)
// ---------------------------------------------------------------------------

interface Scope {
  cardsByAgent: Map<string, ModelCardRecord[]>;
  cardsByProvider: Map<string, ModelCardRecord[]>;
}

function scopeOf(n: AiBomRecordSet): Scope {
  const cardsByAgent = new Map<string, ModelCardRecord[]>();
  const cardsByProvider = new Map<string, ModelCardRecord[]>();
  for (const c of n.modelCards) {
    const [map, key] = c.agentId ? [cardsByAgent, c.agentId] : [cardsByProvider, c.customProviderId!];
    map.set(key, [...(map.get(key) ?? []), c]);
  }
  return { cardsByAgent, cardsByProvider };
}

// ---------------------------------------------------------------------------
// render
// ---------------------------------------------------------------------------

export interface CycloneDxRenderResult {
  doc: Obj;
  gaps: AiBomGap[];
  compositions: Array<{ aggregate: "complete" | "incomplete" | "unknown"; assemblies: string[] }>;
}

/** the reasons whose members are `unknown` rather than `incomplete` */
const UNKNOWN_REASONS = new Set(["no_model_card"]);

export function renderAiBomCycloneDx(n: AiBomRecordSet, meta: AiBomSnapshotMeta, specVersion: CycloneDxSpecVersion): CycloneDxRenderResult {
  const sc = scopeOf(n);
  const components: Obj[] = [];
  const services: Obj[] = [];
  const deps = new Map<string, Set<string>>();
  const gaps: AiBomGap[] = [];
  const gap = (ref: string, field: string, reason: string) => gaps.push({ ref, field, reason });
  const dep = (from: string, to?: string) => {
    if (!deps.has(from)) deps.set(from, new Set());
    if (to) deps.get(from)!.add(to);
  };
  const agentsById = new Map(n.agents.map((a) => [a.id, a]));
  const providersById = new Map(n.customProviders.map((p) => [p.id, p]));
  const cardsById = new Map(n.modelCards.map((c) => [c.id, c]));

  // ------------------------------------------------------------- the subject root (R31)
  let subjectRef: string;
  let root: Obj;
  if (meta.subjectKind === "use_case") {
    const u = n.useCases.find((x) => x.id === meta.subjectId);
    if (!u) throw new Error("ai-bom: the use case subject is not in the record set");
    subjectRef = aiBomRef.useCase(u.id);
    root = {
      type: "application", "bom-ref": subjectRef, name: u.name,
      ...withProps([
        prop("regulait:subject:kind", "use_case"), prop("regulait:useCase:id", u.id), ...ownerProps(u.ownerUserId, u.ownerDisplayName),
        prop("regulait:dataSensitivity", u.dataSensitivity), prop("regulait:euAiAct:tier", u.euAiActTier), prop("regulait:useCase:status", u.status),
        ...u.complianceTags.map((t) => prop("regulait:compliance:tag", t)),
      ]),
    };
    dep(subjectRef);
    for (const a of u.intendedAgentIds) {
      if (agentsById.has(a)) dep(subjectRef, aiBomRef.agent(a));
      else gap(subjectRef, "intendedAgent", "intended_agent_not_found");
    }
  } else if (meta.subjectKind === "agent") {
    const a = agentsById.get(meta.subjectId);
    if (!a) throw new Error("ai-bom: the agent subject is not in the record set");
    subjectRef = aiBomRef.agent(a.id);
    root = { type: "application", "bom-ref": `subject:${subjectRef}`, name: a.name, ...withProps([prop("regulait:subject:kind", "agent"), prop("regulait:agent:id", a.id)]) };
    dep(`subject:${subjectRef}`, subjectRef);
  } else if (meta.subjectKind === "builder_agent") {
    const b = n.builderAgents.find((x) => x.id === meta.subjectId);
    if (!b) throw new Error("ai-bom: the builder agent subject is not in the record set");
    subjectRef = aiBomRef.builderAgent(b.id);
    root = { type: "application", "bom-ref": `subject:${subjectRef}`, name: b.name, ...withProps([prop("regulait:subject:kind", "builder_agent"), prop("regulait:builderAgent:id", b.id)]) };
    dep(`subject:${subjectRef}`, subjectRef);
  } else {
    subjectRef = aiBomRef.install();
    root = {
      type: "application", "bom-ref": subjectRef, name: "RegulAIt install",
      ...withProps([
        prop("regulait:subject:kind", "install"),
        // ADR-0116: the operator-set install id, or said to be absent; the internal nil key is never exported (R20)
        prop("regulait:install:id", n.install?.installId ?? "not_recorded"),
      ]),
    };
    dep(subjectRef);
    for (const u of n.useCases) dep(subjectRef, aiBomRef.useCase(u.id));
    for (const a of n.agents) dep(subjectRef, aiBomRef.agent(a.id));
    for (const b of n.builderAgents) dep(subjectRef, aiBomRef.builderAgent(b.id));
    // R9 (B7): BOM-Link to ADR-0184's SBOMs ONLY from a signature-verified release identity (the records'
    // normaliser refuses anything else); without one, no externalReferences and said so
    const sboms = n.releaseSboms ?? [];
    if (!sboms.length) gap(subjectRef, "externalReferences", "release_sbom_identity_not_available");
    else {
      for (const k of RELEASE_SBOM_KINDS) if (!sboms.some((x) => x.kind === k)) gap(subjectRef, `externalReferences:${k}`, "release_sbom_identity_not_available");
      root.externalReferences = sboms.map((x) => ({
        type: "bom",
        url: cycloneDxBomLink(x.serialNumber, x.version),
        comment: `ADR-0184 ${x.kind} SBOM of this release (identity basis: ${x.identityBasis})`,
        hashes: [{ alg: "SHA-256", content: x.sha256 }],
      }));
      const r = root as { properties?: Obj[] };
      r.properties = props([
        ...(r.properties ?? []),
        prop("regulait:release:commit", sboms[0]!.releaseCommit),
        prop("regulait:release:imageDigest", sboms.find((x) => x.kind === "image")?.imageDigest ?? null),
      ]);
    }
    for (const u of n.useCases) {
      components.push({
        type: "application", "bom-ref": aiBomRef.useCase(u.id), name: u.name,
        ...withProps([
          prop("regulait:useCase:id", u.id), ...ownerProps(u.ownerUserId, u.ownerDisplayName), prop("regulait:dataSensitivity", u.dataSensitivity),
          prop("regulait:euAiAct:tier", u.euAiActTier), prop("regulait:useCase:status", u.status), ...u.complianceTags.map((t) => prop("regulait:compliance:tag", t)),
        ]),
      });
      dep(aiBomRef.useCase(u.id));
      for (const a of u.intendedAgentIds) if (agentsById.has(a)) dep(aiBomRef.useCase(u.id), aiBomRef.agent(a));
    }
  }

  // ------------------------------------------------------------- agents, their model cards, providers, flows
  const modelComponent = (card: ModelCardRecord, supplier: string, approvedId: string | null): Obj => {
    const ref = aiBomRef.model(card.id);
    const declaredTraining = trainingDataDeclared(card);
    const licence = claimText(card, "license");
    if (!licence) gap(ref, "license", "not_declared");
    if (!declaredTraining) gap(ref, "trainingData", "not_declared");
    if (card.pinnedModelVersion === null) gap(ref, "version", "pinned_model_version_not_recorded");
    // the datasets this card's model was trained or tested on, derived (never invented)
    const datasets = sortedBy(
      [
        ...n.trainingArtifacts.filter((t) => t.modelCardId === card.id).flatMap((t) => {
          const job = n.trainingJobs.find((j) => j.id === t.jobId);
          return job ? [aiBomRef.trainingDataset(job.datasetId, job.datasetVersion)] : [];
        }),
        ...n.modelCardEvidence.filter((e) => e.cardId === card.id && e.kind === "eval_run").flatMap((e) => {
          const run = n.evalRuns.find((r) => r.id === e.evalRunId);
          return run ? [aiBomRef.evalDataset(run.datasetId, run.datasetVersion)] : [];
        }),
      ].filter((v, i, all) => all.indexOf(v) === i),
      (x) => x,
    );
    const task = claimText(card, "task");
    const arch = claimText(card, "architecture");
    const modelCard: Obj = {
      "bom-ref": aiBomRef.modelCard(card.id),
      modelParameters: {
        // amendment 8: supplier-declared only; model_cards has no task or architecture column
        ...(task ? { task } : {}),
        ...(arch ? { modelArchitecture: arch } : {}),
        ...(datasets.length ? { datasets: datasets.map((d) => ({ ref: d })) } : {}),
      },
      considerations: {
        // one card is one intended use (model_cards_agent_use_uq): one use-case string, never split
        useCases: [card.intendedUse],
        ...(card.limitations ? { technicalLimitations: [card.limitations] } : {}),
        // a declared assessment SLOT, not a mitigation we performed; method/status as properties
        ...(card.biasFairness.length ? { ethicalConsiderations: card.biasFairness.map((b) => ({ name: b.dimension })) } : {}),
      },
      ...withProps([
        prop("regulait:modelCard:id", card.id),
        prop("regulait:modelCard:approval", approvedId ?? "none_in_force"),
        // standard_refs are display-only identifiers or prose: properties, never URLs (R30)
        ...card.standardRefs.map((x) => prop("regulait:standardRef", x)),
        ...card.biasFairness.map((b) => prop("regulait:biasFairness:assessment", canonicalize(b) as string)),
        // supplier claims as recorded (OWNER DECISION 10)
        ...Object.keys(card.dataClaims).sort(cmpCodeUnits).map((k) => prop(`regulait:supplierClaim:${k}`, card.dataClaims[k] as string | number | boolean)),
      ]),
    };
    dep(ref);
    for (const d of datasets) dep(ref, d);
    return {
      type: "machine-learning-model", "bom-ref": ref, name: `model-card-${card.id}`,
      supplier: { name: supplier },
      ...(card.pinnedModelVersion ? { version: card.pinnedModelVersion } : {}),
      // amendment 8: a declared licence is stated, else stated as unknown (never omitted)
      licenses: [licence ? { license: { name: licence, acknowledgement: "declared" } } : { license: { name: "unknown" } }],
      modelCard,
      ...withProps([
        prop("regulait:modelCard:id", card.id),
        prop("regulait:model:version", card.pinnedModelVersion ? null : "not_recorded"),
        prop("regulait:trainingData:provenance", declaredTraining ? "supplier-declared" : "unknown"),
        prop("regulait:license:status", licence ? "supplier-declared" : "unknown"),
      ]),
    };
  };

  const useCasesOfAgent = (agentId: string) => n.useCases.filter((u) => u.intendedAgentIds.includes(agentId));
  const providerService = (a: AgentRecord): Obj => {
    const ref = aiBomRef.provider(a.id);
    const custom = a.customProviderId ? providersById.get(a.customProviderId) : undefined;
    if (a.customProviderId && !custom) gap(ref, "customProvider", "custom_provider_not_found");
    // R30: authenticated only from a recorded credential state; built-in providers record none here
    const auth = custom ? { authenticated: custom.keySet } : {};
    if (!custom) gap(ref, "authenticated", "not_recorded");
    // R27: one flow pair per use case that references the agent; a use-case subject keeps its single pair
    const flowUseCases = meta.subjectKind === "use_case" ? n.useCases.filter((u) => u.id === meta.subjectId) : useCasesOfAgent(a.id);
    const data: Obj[] = [];
    const flowProps: Array<Obj | null> = [];
    if (flowUseCases.length) {
      for (const u of sortedBy(flowUseCases, (x) => x.id)) {
        data.push({ flow: "outbound", classification: u.dataSensitivity, name: `use-case:${u.id}:outbound` });
        data.push({ flow: "inbound", classification: u.dataSensitivity, name: `use-case:${u.id}:inbound` });
        flowProps.push(prop("regulait:dataFlow:useCase", u.id));
      }
    } else {
      // R49: CycloneDX requires the field; unknown is said in it
      data.push({ flow: "outbound", classification: "unknown" }, { flow: "inbound", classification: "unknown" });
      flowProps.push(prop("regulait:dataFlow:classification", "unknown"));
      gap(ref, "dataFlow", "no_use_case_references_agent");
    }
    dep(ref);
    return {
      "bom-ref": ref, name: `${a.provider} endpoint for agent ${a.id}`, provider: { name: a.provider },
      ...(custom?.baseUrl ? { endpoints: [custom.baseUrl] } : {}),
      ...auth,
      trustZone: custom ? "custom-provider" : "external-provider",
      data,
      ...withProps([...flowProps, prop("regulait:provider:custom", custom ? custom.id : null), prop("regulait:provider:wireProtocol", custom?.wireProtocol)]),
    };
  };

  for (const a of n.agents) {
    const ref = aiBomRef.agent(a.id);
    const cards = sc.cardsByAgent.get(a.id) ?? [];
    const providerCards = a.customProviderId ? sc.cardsByProvider.get(a.customProviderId) ?? [] : [];
    components.push({
      type: "application", "bom-ref": ref, name: a.name, supplier: { name: a.provider },
      ...withProps([
        prop("regulait:agent:id", a.id), prop("regulait:model:requested", a.model), prop("regulait:model:expectedServed", a.expectedServedModel),
        prop("regulait:agent:lifecycle", a.lifecycleStatus), ...ownerProps(a.ownerUserId, a.ownerDisplayName),
        prop("regulait:identity:uri", a.workloadIdentity),
        // ADR-0082: OBSERVED use is a property, never a dependency edge
        prop("regulait:observed:lastSeen", a.observedLastSeen), prop("regulait:observed:count", a.observedCount),
      ]),
    });
    dep(ref);
    for (const c of [...cards, ...providerCards]) dep(ref, aiBomRef.model(c.id));
    if (!cards.length && !providerCards.length) {
      // no card: the model is unknown, said so, never inferred
      const mref = aiBomRef.modelOfAgent(a.id);
      components.push({
        type: "machine-learning-model", "bom-ref": mref, name: a.model ?? `${a.provider} model`, supplier: { name: a.provider },
        licenses: [{ license: { name: "unknown" } }],
        ...withProps([prop("regulait:model:version", "not_recorded"), prop("regulait:trainingData:provenance", "unknown"), prop("regulait:license:status", "unknown")]),
      });
      dep(ref, mref);
      dep(mref);
      gap(mref, "modelCard", "no_model_card");
    }
    services.push(providerService(a));
    dep(ref, aiBomRef.provider(a.id));
  }
  for (const c of n.modelCards) {
    const supplier = c.agentId ? agentsById.get(c.agentId)?.provider : providersById.get(c.customProviderId!)?.name;
    if (!supplier) throw new Error(`ai-bom: model card ${c.id} has no subject in the record set`);
    components.push(modelComponent(c, supplier, approvalInForce(n, c.id, meta.createdAt)));
  }

  // ------------------------------------------------------------- config versions (round 8, 4237322637)
  for (const v of n.configVersions) {
    const ref = aiBomRef.config(v.artifactType, v.id);
    components.push({
      type: "data", "bom-ref": ref, name: `${v.artifactType} ${v.artifactId} v${v.version}`, version: String(v.version),
      hashes: [{ alg: "SHA-256", content: v.bodyDigest }],
      data: [{ type: "configuration", name: `${v.artifactType}:${v.id}` }],
      ...withProps([
        prop("regulait:config:id", v.id), prop("regulait:config:status", v.status), prop("regulait:config:canaryPct", v.canaryPct),
        prop("regulait:config:digestOf", "config_versions.body (RFC 8785)"),
      ]),
    });
    dep(ref);
    if (agentsById.has(v.artifactId)) dep(aiBomRef.agent(v.artifactId), ref);
  }

  // ------------------------------------------------------------- model artifacts and their edges (R29)
  const scansById = new Map(n.artifactScans.map((s) => [s.id, s]));
  for (const art of n.modelArtifacts) {
    const ref = aiBomRef.artifact(art.id);
    components.push({
      type: "file", "bom-ref": ref, name: `model-artifact-${art.id}`, hashes: [{ alg: "SHA-256", content: art.sha256 }],
      ...withProps([prop("regulait:artifact:format", art.format), prop("regulait:artifact:sizeBytes", art.sizeBytes)]),
    });
    dep(ref);
    const cardIds = n.modelCardEvidence
      .filter((e) => e.kind === "engine_scan" && e.artifactScanId && scansById.get(e.artifactScanId)?.artifactId === art.id)
      .map((e) => e.cardId)
      .filter((id) => cardsById.has(id));
    if (!cardIds.length) gap(ref, "dependency", "no_model_card_evidence_path");
    for (const id of cardIds) dep(aiBomRef.model(id), ref); // many-to-many: every edge kept
  }

  // ------------------------------------------------------------- engines: one container per exact scanner (R12)
  const engineOf = new Map<string, { key: string; engineId: string; version: string; imageDigest: string | null } | null>();
  for (const s of n.artifactScans) {
    const run = s.engineRunId ? n.engineRuns.find((r) => r.id === s.engineRunId) : undefined;
    if (!run) {
      engineOf.set(s.id, null); // 4237376660: explicit unknown assessor, nothing invented
      continue;
    }
    const engine = n.engines.find((e) => e.id === run.engineId);
    // the image digest is recorded for the engine's CURRENT version only; a different run version has none
    const imageDigest = engine && engine.version === run.engineVersion ? engine.imageDigest : null;
    engineOf.set(s.id, { key: `${run.engineId}/${run.engineVersion}/${imageDigest ?? "image-digest-not-recorded"}`, engineId: run.engineId, version: run.engineVersion, imageDigest });
  }
  const engines = sortedBy([...new Map([...engineOf.values()].filter((e): e is NonNullable<typeof e> => e !== null).map((e) => [e.key, e])).values()], (e) => e.key);
  for (const e of engines) {
    const ref = aiBomRef.engine(e.key);
    components.push({
      type: "container", "bom-ref": ref, name: e.engineId, version: e.version,
      ...(e.imageDigest ? { hashes: [{ alg: "SHA-256", content: e.imageDigest }] } : {}),
    });
    if (!e.imageDigest) gap(ref, "imageDigest", "not_recorded_for_this_version");
    dep(ref);
  }
  for (const s of n.artifactScans) if (!engineOf.get(s.id)) gap(`claim:${s.id}`, "assessor", "engine_run_not_recorded");

  // ------------------------------------------------------------- datasets (R24, R26, round 13)
  for (const d of n.trainingDatasets) {
    const ref = aiBomRef.trainingDataset(d.id, d.version);
    const parsed = parseTrainingDatasetChecksum(d.checksum, d.rowCount);
    const pii = d.piiVerdict !== "clean"; // R11: flagged/blocked are known sensitive; clean is not proof of absence
    components.push({
      type: "data", "bom-ref": ref, name: d.name, version: String(d.version),
      ...(parsed.kind === "sha256" ? { hashes: [{ alg: "SHA-256", content: parsed.sha256 }] } : {}),
      data: [{ type: "dataset", name: d.name, ...(d.projectDataSensitivity ? { classification: d.projectDataSensitivity } : {}), ...(pii ? { sensitiveData: ["pii"] } : {}) }],
      ...withProps([
        prop("regulait:dataset:kind", "training"), prop("regulait:dataset:piiVerdict", d.piiVerdict),
        prop("regulait:dataset:digestOf", parsed.kind === "sha256" ? "training_datasets.checksum" : null),
        prop("regulait:dataset:rowCount", parsed.kind === "sha256" ? parsed.rowCount : null),
        prop("regulait:dataset:legacyChecksum", parsed.kind === "legacy" ? parsed.value : null),
        prop("regulait:dataset:owner", "not_recorded"),
      ]),
    });
    dep(ref);
    gap(ref, "owner", "no_owner_column");
    // `projects` has no classification column today: a linked project gives none either (R24, R30)
    if (!d.projectDataSensitivity) gap(ref, "classification", d.projectId ? "project_classification_not_recorded" : "no_project");
    if (parsed.kind !== "sha256") gap(ref, "hash", parsed.kind === "legacy" ? "legacy_checksum" : "empty_checksum");
  }
  for (const d of n.evalDatasets) {
    const ref = aiBomRef.evalDataset(d.id, d.version);
    components.push({
      type: "data", "bom-ref": ref, name: d.name, version: String(d.version),
      hashes: [{ alg: "SHA-256", content: d.casesDigest }],
      data: [{ type: "dataset", name: d.name }],
      ...withProps([
        prop("regulait:dataset:kind", "eval"), prop("regulait:dataset:piiVerdict", "not_scanned"),
        prop("regulait:dataset:digestOf", "eval_cases"), prop("regulait:dataset:owner", "not_recorded"),
      ]),
    });
    dep(ref);
    gap(ref, "metadata", "eval_dataset_metadata_not_recorded");
  }

  // ------------------------------------------------------------- training artifacts (#280 4237488600)
  for (const t of n.trainingArtifacts) {
    const ref = aiBomRef.trainingArtifact(t.id);
    const job = n.trainingJobs.find((j) => j.id === t.jobId);
    components.push({
      type: "machine-learning-model", "bom-ref": ref, name: t.name,
      ...(t.payloadDigest ? { hashes: [{ alg: "SHA-256", content: t.payloadDigest }] } : {}),
      ...withProps([
        prop("regulait:training:method", t.method), prop("regulait:training:artifactKind", t.kind),
        prop("regulait:training:digestOf", t.payloadDigest ? "training_artifacts.payload (RFC 8785)" : "not_recorded"),
        prop("regulait:training:jobId", t.jobId), prop("regulait:training:jobStatus", job?.status),
        // the remote location is never exported (it may be a signed URL)
        prop("regulait:training:location", t.kind === "remote" ? "not_exported" : null),
      ]),
    });
    dep(ref);
    if (!t.payloadDigest) gap(ref, "hash", "remote_artifact_digest_not_recorded");
    if (job) {
      dep(ref, aiBomRef.trainingDataset(job.datasetId, job.datasetVersion));
      if (job.baseAgentId && agentsById.has(job.baseAgentId)) dep(ref, aiBomRef.agent(job.baseAgentId));
    } else gap(ref, "trainingJob", "not_found");
    if (t.agentId && agentsById.has(t.agentId)) dep(aiBomRef.agent(t.agentId), ref);
    if (t.modelCardId && cardsById.has(t.modelCardId)) dep(aiBomRef.model(t.modelCardId), ref);
  }

  // ------------------------------------------------------------- promoted prompts
  for (const p of n.promptTags) {
    const ref = aiBomRef.prompt(p.promptId, p.tag);
    components.push({
      type: "data", "bom-ref": ref, name: p.promptName, version: p.tag,
      hashes: [{ alg: "SHA-256", content: p.hash }],
      data: [{ type: "configuration", name: p.promptName }],
      ...withProps([prop("regulait:prompt:id", p.promptId), prop("regulait:prompt:commitId", p.commitId), prop("regulait:prompt:tag", p.tag)]),
    });
    dep(ref);
    if (agentsById.has(p.agentId)) dep(aiBomRef.agent(p.agentId), ref);
  }

  // ------------------------------------------------------------- builder agents, their skills and memory
  for (const b of n.builderAgents) {
    const ref = aiBomRef.builderAgent(b.id);
    components.push({
      type: "application", "bom-ref": ref, name: b.name,
      ...withProps([prop("regulait:builderAgent:id", b.id), ...ownerProps(b.ownerUserId, b.ownerDisplayName), prop("regulait:identity:uri", b.workloadIdentity)]),
    });
    dep(ref);
    if (b.modelAgentId && agentsById.has(b.modelAgentId)) dep(ref, aiBomRef.agent(b.modelAgentId));
    else gap(ref, "model", "no_model_agent");
  }
  for (const k of n.builderSkills) {
    const ref = aiBomRef.skill(k.agentId, k.skillId);
    components.push({
      type: "data", "bom-ref": ref, name: k.snapshotName || `skill-${k.skillId}`, version: String(k.snapshotVersion),
      ...(k.snapshotDigest ? { hashes: [{ alg: "SHA-256", content: k.snapshotDigest }] } : {}),
      data: [{ type: "configuration", name: k.snapshotName || `skill-${k.skillId}` }],
      ...withProps([
        prop("regulait:skill:admissionState", k.snapshotAdmissionState), prop("regulait:skill:libraryId", k.skillId),
        prop("regulait:skill:digestOf", k.snapshotDigest ? "builder_agent_skills.snapshot_digest" : "not_recorded"),
      ]),
    });
    dep(ref);
    if (!k.snapshotDigest) gap(ref, "hash", "snapshot_digest_empty");
    dep(aiBomRef.builderAgent(k.agentId), ref); // from the builder agent, never the subject
  }
  for (const m of n.memoryStores) {
    const ref = aiBomRef.memory(m.kind, m.builderAgentId);
    components.push({
      type: "data", "bom-ref": ref, name: `memory store ${m.kind}`,
      data: [{ type: "other", name: `memory-store-${m.kind}`, description: "store descriptor only; contents never included" }],
      ...withProps([prop("regulait:memory:kind", m.kind)]),
    });
    dep(ref);
    gap(ref, "classification", "not_recorded");
    if (m.builderAgentId) dep(aiBomRef.builderAgent(m.builderAgentId), ref);
    else dep(subjectRef, ref);
  }

  // ------------------------------------------------------------- MCP servers, tools, connectors
  for (const m of n.mcpServers) {
    const ref = aiBomRef.mcp(m.id);
    const tools = n.mcpTools.filter((t) => t.serverId === m.id);
    services.push({
      "bom-ref": ref, name: m.name,
      ...(m.url ? { endpoints: [m.url] } : {}),
      ...(tools.length ? { services: tools.map((t) => ({ "bom-ref": aiBomRef.tool(m.id, t.id), name: t.name, ...withProps([prop("regulait:tool:kind", t.kind)]) })) } : {}),
      ...withProps([
        prop("regulait:mcp:transport", m.transport), prop("regulait:mcp:releaseDigest", m.releaseDigest ?? "not_recorded"),
        prop("regulait:mcp:admissionManifestDigest", m.admissionManifestDigest ?? "not_recorded"),
        prop("regulait:admission:state", m.admissionState), prop("regulait:identity:propagation", m.identityPropagation),
        ...ownerProps(m.ownerUserId, m.ownerDisplayName),
      ]),
    });
    dep(ref);
    for (const t of tools) dep(aiBomRef.tool(m.id, t.id));
  }
  for (const c of n.connectors) {
    const ref = aiBomRef.connector(c.id);
    services.push({
      "bom-ref": ref, name: c.name, ...(c.url ? { endpoints: [c.url] } : {}), authenticated: c.credentialSet,
      ...withProps([prop("regulait:connector:kind", c.kind), ...ownerProps(c.ownerUserId, c.ownerDisplayName)]),
    });
    dep(ref);
  }
  // GRANTED edges only (ADR-0082)
  const toolsById = new Map(n.mcpTools.map((t) => [t.id, t]));
  for (const g of n.grants) {
    const from = g.holderKind === "agent" ? aiBomRef.agent(g.holderId) : aiBomRef.builderAgent(g.holderId);
    const to = g.targetKind === "mcp_server" ? aiBomRef.mcp(g.targetId)
      : g.targetKind === "connector" ? aiBomRef.connector(g.targetId)
      : toolsById.has(g.targetId) ? aiBomRef.tool(toolsById.get(g.targetId)!.serverId, g.targetId) : null;
    if (to === null) throw new Error(`ai-bom: grant to tool ${g.targetId} without its tool record`);
    dep(from, to);
  }

  // ------------------------------------------------------------- B7: the AI tools that MADE the release
  // (PathForward "inventory of AI tools in the development stack"): formulation, never install components
  const devTools = n.devStackTools ?? [];
  const formulation: Obj[] = [];
  if (devTools.length) {
    formulation.push({
      "bom-ref": "formulation:development-stack",
      components: devTools.map((t) => {
        const ref = aiBomRef.devTool(t.id);
        // the inventory describes tools by role and names no supplier, product or model version (B7)
        gap(ref, "version", "dev_stack_version_not_recorded");
        return {
          type: "application", "bom-ref": ref, name: t.id, description: t.description,
          ...withProps([
            prop("regulait:devStack:category", t.category), prop("regulait:devStack:deployment", t.deployment),
            prop("regulait:devStack:networkEgress", t.networkEgress), prop("regulait:devStack:repositoryAccess", t.repositoryAccess),
            prop("regulait:devStack:outputControl", t.outputControl), prop("regulait:devStack:introducedOn", t.introducedOn),
            ...t.dataShared.map((d) => prop("regulait:devStack:dataShared", d)), ...t.governedBy.map((a) => prop("regulait:devStack:governedBy", a)),
          ]),
        };
      }),
    });
  }

  // ------------------------------------------------------------- declarations, compositions, document
  const decl = declarations(n, engineOf, gaps);
  const allRefs = new Set<string>([root["bom-ref"] as string, ...components.map((c) => c["bom-ref"] as string), ...services.flatMap(serviceRefs)]);
  // every dependency names a declared bom-ref (a dangling edge is a build failure, never silently dropped)
  for (const [from, set] of deps) for (const to of [from, ...set]) if (!allRefs.has(to)) throw new Error(`ai-bom: dependency names an undeclared ref ${to}`);

  const compositions = compositionsOf(root["bom-ref"] as string, gaps);
  const doc: Obj = {
    bomFormat: "CycloneDX",
    specVersion,
    serialNumber: `urn:uuid:${aiBomSerialNumber(meta.id)}`,
    version: meta.version,
    metadata: {
      timestamp: meta.createdAt,
      tools: { components: [{ type: "application", name: AI_BOM_BUILDER_NAME, version: AI_BOM_BUILDER_VERSION }] },
      component: root,
      ...withProps([prop("regulait:snapshot:id", meta.id), prop("regulait:snapshot:trigger", meta.trigger), prop("regulait:snapshot:supersedes", meta.supersedes)]),
    },
    components: sortedBy(components, (c) => c["bom-ref"] as string),
    services: sortedBy(services, (c) => c["bom-ref"] as string),
    dependencies: sortedBy([...deps].map(([r, set]) => ({ ref: r, ...(set.size ? { dependsOn: [...set].sort(cmpCodeUnits) } : {}) })), (d) => d.ref),
    compositions: compositions.map((c, i) => ({ "bom-ref": `composition:${i}`, aggregate: c.aggregate, assemblies: c.assemblies })),
    ...(decl ? { declarations: decl } : {}),
    ...(formulation.length ? { formulation } : {}),
  };
  return { doc, gaps: sortedBy(gaps, (g) => `${g.ref}\u0000${g.field}\u0000${g.reason}`), compositions };
}

const serviceRefs = (s: Obj): string[] => [s["bom-ref"] as string, ...((s.services as Obj[] | undefined) ?? []).flatMap(serviceRefs)];

/**
 * THE COMPOSITION RULE (not relaxable): the subject's own assembly is always
 * `incomplete` (third-party model internals are at best supplier-declared);
 * every gap's ref sits in an `incomplete` (or, with no model card, `unknown`)
 * composition grouped by reason; nothing is ever `complete`.
 */
export function compositionsOf(subjectRef: string, gaps: readonly AiBomGap[]): CycloneDxRenderResult["compositions"] {
  const byReason = new Map<string, Set<string>>();
  for (const g of gaps) {
    if (g.ref.startsWith("claim:")) continue; // declarations are not assemblies; their gap is in the claim itself
    if (!byReason.has(g.reason)) byReason.set(g.reason, new Set());
    byReason.get(g.reason)!.add(g.ref);
  }
  return [
    { aggregate: "incomplete" as const, assemblies: [subjectRef] },
    ...[...byReason.keys()].sort(cmpCodeUnits).map((reason) => ({
      aggregate: UNKNOWN_REASONS.has(reason) ? ("unknown" as const) : ("incomplete" as const),
      assemblies: [...byReason.get(reason)!].sort(cmpCodeUnits),
    })),
  ];
}

/** scans and every model_card_evidence row as claims with evidence and an exact assessor (R12, R30) */
function declarations(n: AiBomRecordSet, engineOf: Map<string, { key: string } | null>, gaps: AiBomGap[]): Obj | null {
  if (!n.artifactScans.length && !n.modelCardEvidence.length) return null;
  const assessors = new Map<string, Obj>();
  const assessorFor = (key: string | null) => {
    const ref = key ? `assessor:${key}` : "assessor:unknown";
    // an unknown assessor states nothing about itself: no thirdParty claim either way
    if (!assessors.has(ref)) assessors.set(ref, key ? { "bom-ref": ref, thirdParty: false } : { "bom-ref": ref });
    return ref;
  };
  const claims: Obj[] = [];
  const evidence: Obj[] = [];
  const attestations: Obj[] = [];
  for (const s of n.artifactScans) {
    const e = engineOf.get(s.id) ?? null;
    claims.push({
      "bom-ref": `claim:${s.id}`, target: aiBomRef.artifact(s.artifactId),
      predicate: `artifact scan verdict: ${s.verdict}`, evidence: [`evidence:${s.id}`],
    });
    evidence.push({
      "bom-ref": `evidence:${s.id}`, propertyName: "regulait:scan:verdict",
      // artifact_scans persists the scanned artifact's sha256, never a digest of the scan evidence (R30)
      description: `verdict ${s.verdict}; scanner ${s.scannerVersion}; scanned artifact sha256:${s.artifactSha256}; evidence digest: not_recorded`,
      created: s.createdAt, data: [{ name: `scan-${s.id}`, classification: "internal" }],
    });
    attestations.push({ summary: `scan ${s.id}`, assessor: assessorFor(e?.key ?? null), map: [{ claims: [`claim:${s.id}`] }] });
  }
  const scans = new Map(n.artifactScans.map((s) => [s.id, s]));
  for (const e of n.modelCardEvidence) {
    let assessor: string;
    const refs = [`evidence:mce:${e.id}`];
    let reference: string;
    if (e.kind === "engine_scan") {
      const scan = scans.get(e.artifactScanId!);
      if (!scan) throw new Error(`ai-bom: engine_scan evidence ${e.id} has no artifact scan in the record set`);
      assessor = assessorFor(engineOf.get(scan.id)?.key ?? null);
      refs.push(`evidence:${scan.id}`);
      reference = `artifactScanId:${scan.id}`;
    } else if (e.kind === "eval_run") {
      if (!assessors.has("assessor:regulait-eval")) assessors.set("assessor:regulait-eval", { "bom-ref": "assessor:regulait-eval", thirdParty: false });
      assessor = "assessor:regulait-eval";
      reference = `evalRunId:${e.evalRunId}`;
    } else {
      if (!assessors.has("assessor:external")) assessors.set("assessor:external", { "bom-ref": "assessor:external", thirdParty: true });
      assessor = "assessor:external";
      reference = `externalRef:${e.externalRef}`; // safe form (#280 4237488597)
    }
    claims.push({ "bom-ref": `claim:mce:${e.id}`, target: aiBomRef.model(e.cardId), predicate: `${e.kind} supports model card ${e.cardId}`, evidence: refs.sort(cmpCodeUnits) });
    evidence.push({
      "bom-ref": `evidence:mce:${e.id}`, propertyName: `regulait:modelCardEvidence:${e.kind}`,
      // R30: no digest is persisted for model_card_evidence; the kind-specific reference is
      description: `${reference}; digest: not_recorded`,
      created: e.attachedAt, data: [{ name: `model-card-evidence-${e.id}`, classification: "internal" }],
    });
    attestations.push({ summary: `model card evidence ${e.id}`, assessor, map: [{ claims: [`claim:mce:${e.id}`] }] });
  }
  void gaps;
  return {
    assessors: sortedBy([...assessors.values()], (a) => a["bom-ref"] as string),
    claims: sortedBy(claims, (c) => c["bom-ref"] as string),
    evidence: sortedBy(evidence, (c) => c["bom-ref"] as string),
    attestations: sortedBy(attestations, (a) => a.summary as string),
  };
}
