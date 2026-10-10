/**
 * ADR-0189 slice B3 — the AI BOM LOADER, SNAPSHOT FREEZE and DRIFT.
 *
 *  - `loadAiBomRecords(tx, subject, opts)`: reads every source table for one
 *    subject (R31: use case, agent, builder agent, install) into the shared
 *    record set (`AiBomRecordSet`). It selects ONLY allowlisted columns, so no
 *    prompt text, template, skill body, training payload, config body,
 *    credential or free-text note is ever read into memory for a BOM. Values
 *    that must be bound but never leave (eval cases, config bodies, inline
 *    training payloads) are hashed here and only the digest is passed on
 *    (R24/R26, round 8, #280 4237488600).
 *  - `takeAiBomSnapshot(db, …)`: R50 + 4237346650. One dedicated connection
 *    takes the SESSION-level per-subject lock first, then opens one REPEATABLE
 *    READ read-write transaction that allocates the next version, captures,
 *    builds, validates, signs (the receipt key, OWNER DECISION 2) and inserts
 *    the snapshot and its renderings. The audit row follows in its own
 *    transaction while the lock is still held.
 *  - `captureAiBomSnapshotInTx(tx, …)`: the same capture inside an EXISTING
 *    transaction (the shape a sign-off trigger needs, #280 4237493034: capture
 *    inside the triggering transaction). It refuses a transaction that is not
 *    REPEATABLE READ or SERIALIZABLE. A stale version allocation fails on the
 *    contiguous-version guard and the unique constraint and never forks.
 *  - `aiBomDrift(db, …)`: the change list of the live state against the last
 *    signed snapshot (R8). It is not a BOM document.
 *
 * SHIPS DISABLED (R2, R17): `AI_BOM_SNAPSHOTS_RELEASED` is false IN CODE (not a
 * setting), so the snapshot route answers 501 `bom_snapshots_not_released`
 * and `aiBomSnapshotTriggerGate` does nothing. Whichever of B4 and B5 merges
 * second flips it, once every v1 renderer exists.
 */
import { createHash, sign } from "node:crypto";
import {
  agents,
  aiBomSnapshots,
  aiUseCases,
  and,
  artifactScans,
  asc,
  auditLog,
  bomRenderings,
  builderAgentSkills,
  builderAgentTools,
  builderAgents,
  configVersions,
  connectors,
  customModelProviders,
  desc,
  engineRuns,
  engines,
  eq,
  evalCases,
  evalRuns,
  identityConnectorGrants,
  identityServerGrants,
  identityToolGrants,
  inArray,
  isNull,
  mcpServers,
  mcpTools,
  modelArtifacts,
  modelCardApprovals,
  modelCardEvidence,
  modelCards,
  orgSettings,
  ORG_SETTINGS_ID,
  promptCommits,
  prompts,
  promptTags,
  receiptSigningKeys,
  sql,
  trainingArtifacts,
  trainingDatasets,
  trainingJobs,
  usageEvents,
  users,
  BomSubjectBusyError,
  withAiBomSubjectSessionLock,
  workloadIdentities,
  type Db,
} from "@regulait/db";
import {
  AI_BOM_INSTALL_SUBJECT_ID,
  AI_BOM_MAX_RECORDS_PER_LIST,
  aiBomInventoryIndex,
  bomDigestOf,
  bomExpiresAt,
  buildAiBom,
  diffAiBomInventory,
  evalCasesDigest,
  type AiBomBuild,
  type AiBomDriftChange,
  type AiBomRecordSet,
  type AiBomSnapshotTrigger,
  type AiBomSubjectKind,
  type CycloneDxSpecVersion,
} from "@regulait/shared";
import { loadReceiptSigningKey, ReceiptKeyError, sameReceiptPublicKey } from "./decision-receipts.js";
import { retentionFloorDays } from "./org-settings.js";

/**
 * R2/R17: NOT RELEASED. A code constant, never a setting. The PR that merges
 * second of B4 (export-bundle/3) and B5 (SPDX) sets it to true, with tests
 * that download every format as a verified bundle.
 */
export const AI_BOM_SNAPSHOTS_RELEASED = false as boolean;

export class AiBomError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "AiBomError";
  }
}

type Tx = Db;
const uniq = <T>(xs: Iterable<T>): T[] => [...new Set(xs)];
/** PR #287: an install-wide read is bounded; over the cap the snapshot is refused, never truncated */
const CAP = AI_BOM_MAX_RECORDS_PER_LIST;
function capped<T>(rows: T[], what: string): T[] {
  if (rows.length > CAP) throw new AiBomError(422, "ai_bom_too_large", `${what}: more than ${CAP} records; an install AI BOM is refused over the cap`);
  return rows;
}
const iso = (d: Date | string | null | undefined): string | null => (d === null || d === undefined ? null : new Date(d).toISOString());

export interface AiBomSubject {
  kind: AiBomSubjectKind;
  id: string;
}

export interface AiBomLoadOptions {
  /** `bom_person_identifiers`: display names only when relaxed (R45: AI BOMs only), read in this capture */
  personIdentifiers: "id_only" | "display_name";
  /** ADR-0116: the operator-set install id, or null */
  installId: string | null;
}

/** does the subject exist? (404 otherwise; the install always exists) */
async function subjectExists(tx: Tx, s: AiBomSubject): Promise<boolean> {
  if (s.kind === "install") return s.id === AI_BOM_INSTALL_SUBJECT_ID;
  const table = s.kind === "use_case" ? aiUseCases : s.kind === "agent" ? agents : builderAgents;
  const [row] = await tx.select({ id: table.id }).from(table).where(eq(table.id, s.id)).limit(1);
  return !!row;
}

/**
 * THE LOADER. Reads only allowlisted columns, scoped to the subject (R31).
 * Run it inside one REPEATABLE READ transaction so every table is read from
 * one consistent snapshot (R22).
 */
export async function loadAiBomRecords(tx: Tx, subject: AiBomSubject, opts: AiBomLoadOptions): Promise<AiBomRecordSet> {
  if (!(await subjectExists(tx, subject))) throw new AiBomError(404, "ai_bom_subject_not_found", "No such AI BOM subject.");
  const install = subject.kind === "install";

  // ---- use cases, builder agents, agents in scope
  const ucCols = { id: aiUseCases.id, name: aiUseCases.name, ownerUserId: aiUseCases.ownerUserId, dataSensitivity: aiUseCases.dataSensitivity, complianceTags: aiUseCases.complianceTags, euAiActTier: aiUseCases.euAiActTier, status: aiUseCases.status, intendedAgentIds: aiUseCases.intendedAgentIds };
  const baCols = { id: builderAgents.id, name: builderAgents.name, modelAgentId: builderAgents.modelAgentId, ownerUserId: builderAgents.ownerUserId };
  let builderRows: Array<{ id: string; name: string; modelAgentId: string | null; ownerUserId: string }> = [];
  let agentIds: string[] = [];
  if (subject.kind === "use_case") {
    const [uc] = await tx.select(ucCols).from(aiUseCases).where(eq(aiUseCases.id, subject.id));
    agentIds = uniq(uc!.intendedAgentIds ?? []);
  } else if (subject.kind === "agent") {
    agentIds = [subject.id];
  } else if (subject.kind === "builder_agent") {
    builderRows = await tx.select(baCols).from(builderAgents).where(eq(builderAgents.id, subject.id));
    agentIds = builderRows[0]!.modelAgentId ? [builderRows[0]!.modelAgentId] : [];
  } else {
    builderRows = capped(await tx.select(baCols).from(builderAgents).where(isNull(builderAgents.archivedAt)).limit(CAP + 1), "builder_agents");
    agentIds = capped(await tx.select({ id: agents.id }).from(agents).limit(CAP + 1), "agents").map((r) => r.id);
    for (const b of builderRows) if (b.modelAgentId) agentIds.push(b.modelAgentId);
  }
  const agentRows = agentIds.length
    ? await tx.select({ id: agents.id, name: agents.name, provider: agents.provider, model: agents.model, expectedServedModel: agents.expectedServedModel, customProviderId: agents.customProviderId, lifecycleStatus: agents.lifecycleStatus, ownerUserId: agents.ownerUserId }).from(agents).where(inArray(agents.id, uniq(agentIds)))
    : [];
  agentIds = agentRows.map((a) => a.id);
  const builderIds = builderRows.map((b) => b.id);

  // R27: the use cases that reference these agents (a use-case subject keeps its own)
  const useCaseRows =
    subject.kind === "use_case"
      ? await tx.select(ucCols).from(aiUseCases).where(eq(aiUseCases.id, subject.id))
      : install
        ? capped(await tx.select(ucCols).from(aiUseCases).limit(CAP + 1), "ai_use_cases")
        : agentIds.length
          ? await tx.select(ucCols).from(aiUseCases).where(sql`${aiUseCases.intendedAgentIds} ?| ${`{${agentIds.join(",")}}`}::text[]`)
          : [];

  // ---- workload identities, observed use
  const identities = agentIds.length || builderIds.length
    ? await tx.select({ id: workloadIdentities.id, agentId: workloadIdentities.agentId, builderAgentId: workloadIdentities.builderAgentId, identifier: workloadIdentities.identifier }).from(workloadIdentities)
        .where(sql`${workloadIdentities.agentId} = any(${`{${agentIds.join(",")}}`}::uuid[]) or ${workloadIdentities.builderAgentId} = any(${`{${builderIds.join(",")}}`}::uuid[])`)
    : [];
  const observed = agentIds.length
    ? await tx.select({ agentId: usageEvents.agentId, lastSeen: sql<Date | string | null>`max(${usageEvents.at})`, n: sql<number>`count(*)::int` }).from(usageEvents).where(inArray(usageEvents.agentId, agentIds)).groupBy(usageEvents.agentId)
    : [];

  // ---- custom providers and model cards
  const providerIds = uniq(agentRows.map((a) => a.customProviderId).filter((x): x is string => !!x));
  const providerRows = providerIds.length
    ? await tx.select({ id: customModelProviders.id, name: customModelProviders.name, wireProtocol: customModelProviders.wireProtocol, baseUrl: customModelProviders.baseUrl, keySet: sql<boolean>`${customModelProviders.keyCiphertext} is not null` }).from(customModelProviders).where(inArray(customModelProviders.id, providerIds))
    : [];
  const cardCols = { id: modelCards.id, agentId: modelCards.agentId, customProviderId: modelCards.customProviderId, intendedUse: modelCards.intendedUse, limitations: modelCards.limitations, biasFairness: modelCards.biasFairness, dataClaims: modelCards.dataClaims, standardRefs: modelCards.standardRefs, pinnedModelVersion: modelCards.pinnedModelVersion };
  const cardRows = agentIds.length || providerIds.length
    ? await tx.select(cardCols).from(modelCards).where(sql`${modelCards.agentId} = any(${`{${agentIds.join(",")}}`}::uuid[]) or ${modelCards.customProviderId} = any(${`{${providerIds.join(",")}}`}::uuid[])`)
    : [];
  const cardIds = cardRows.map((c) => c.id);
  const approvalRows = cardIds.length
    ? await tx.select({ id: modelCardApprovals.id, cardId: modelCardApprovals.cardId, status: modelCardApprovals.status, decidedAt: modelCardApprovals.decidedAt, validUntil: modelCardApprovals.validUntil }).from(modelCardApprovals).where(and(inArray(modelCardApprovals.cardId, cardIds), eq(modelCardApprovals.status, "approved")))
    : [];
  const evidenceRows = cardIds.length
    ? await tx.select({ id: modelCardEvidence.id, cardId: modelCardEvidence.cardId, kind: modelCardEvidence.kind, evalRunId: modelCardEvidence.evalRunId, externalRef: modelCardEvidence.externalRef, artifactScanId: modelCardEvidence.artifactScanId, attachedAt: modelCardEvidence.attachedAt }).from(modelCardEvidence).where(inArray(modelCardEvidence.cardId, cardIds))
    : [];

  // ---- evaluation runs and datasets (R24: digest over the version's cases, which never leave)
  const runIds = uniq(evidenceRows.map((e) => e.evalRunId).filter((x): x is string => !!x));
  const runRows = runIds.length ? await tx.select({ id: evalRuns.id, datasetId: evalRuns.datasetId, datasetVersion: evalRuns.datasetVersion }).from(evalRuns).where(inArray(evalRuns.id, runIds)) : [];
  const evalDatasetRows: AiBomRecordSet["evalDatasets"] = [];
  for (const key of uniq(runRows.map((r) => `${r.datasetId}:${r.datasetVersion}`))) {
    const [id, v] = [key.slice(0, 36), Number(key.slice(37))];
    const [ds] = await tx.execute(sql`select id, version, name from eval_datasets where id = ${id} and version = ${v}`).then((r) => (r as unknown as { rows: Array<{ id: string; version: number; name: string }> }).rows);
    if (!ds) continue;
    const cases = await tx.select().from(evalCases).where(and(eq(evalCases.datasetId, id), eq(evalCases.datasetVersion, v)));
    evalDatasetRows.push({ id: ds.id, version: ds.version, name: ds.name, casesDigest: evalCasesDigest(cases as unknown as Array<Record<string, unknown>>) });
  }

  // ---- training lineage (#280 4237488600)
  const taCols = { id: trainingArtifacts.id, jobId: trainingArtifacts.jobId, name: trainingArtifacts.name, method: trainingArtifacts.method, kind: trainingArtifacts.kind, agentId: trainingArtifacts.agentId, modelCardId: trainingArtifacts.modelCardId, payload: trainingArtifacts.payload, createdAt: trainingArtifacts.createdAt };
  const taRows = install
    ? capped(await tx.select(taCols).from(trainingArtifacts).limit(CAP + 1), "training_artifacts")
    : agentIds.length || cardIds.length
      ? await tx.select(taCols).from(trainingArtifacts).where(sql`${trainingArtifacts.agentId} = any(${`{${agentIds.join(",")}}`}::uuid[]) or ${trainingArtifacts.modelCardId} = any(${`{${cardIds.join(",")}}`}::uuid[])`)
      : [];
  const jobIds = uniq(taRows.map((t) => t.jobId));
  const jobRows = jobIds.length ? await tx.select({ id: trainingJobs.id, datasetId: trainingJobs.datasetId, datasetVersion: trainingJobs.datasetVersion, method: trainingJobs.method, baseAgentId: trainingJobs.baseAgentId, status: trainingJobs.status }).from(trainingJobs).where(inArray(trainingJobs.id, jobIds)) : [];
  const dsRows: AiBomRecordSet["trainingDatasets"] = [];
  for (const key of uniq(jobRows.map((j) => `${j.datasetId}:${j.datasetVersion}`))) {
    const [id, v] = [key.slice(0, 36), Number(key.slice(37))];
    const [d] = await tx.select({ id: trainingDatasets.id, version: trainingDatasets.version, name: trainingDatasets.name, checksum: trainingDatasets.checksum, rowCount: trainingDatasets.rowCount, piiVerdict: trainingDatasets.piiVerdict, projectId: trainingDatasets.projectId }).from(trainingDatasets).where(and(eq(trainingDatasets.id, id), eq(trainingDatasets.version, v)));
    // R24/R30: `projects` records no classification, so a linked project gives none
    if (d) dsRows.push({ ...d, projectDataSensitivity: null });
  }
  // a base agent a job names is part of the lineage; it must be loaded for its edge
  for (const j of jobRows) if (j.baseAgentId && !agentIds.includes(j.baseAgentId)) j.baseAgentId = null;

  // ---- artifacts, scans, engines (R12, R29)
  const scanCols = { id: artifactScans.id, artifactId: artifactScans.artifactId, engineRunId: artifactScans.engineRunId, artifactSha256: artifactScans.artifactSha256, verdict: artifactScans.verdict, scannerVersion: artifactScans.scannerVersion, createdAt: artifactScans.createdAt };
  const scanIds = uniq(evidenceRows.map((e) => e.artifactScanId).filter((x): x is string => !!x));
  const scanRows = install ? capped(await tx.select(scanCols).from(artifactScans).limit(CAP + 1), "artifact_scans") : scanIds.length ? await tx.select(scanCols).from(artifactScans).where(inArray(artifactScans.id, scanIds)) : [];
  const artCols = { id: modelArtifacts.id, sha256: modelArtifacts.sha256, sizeBytes: modelArtifacts.sizeBytes, format: modelArtifacts.format };
  const artIds = uniq(scanRows.map((s) => s.artifactId));
  const artRows = install ? capped(await tx.select(artCols).from(modelArtifacts).limit(CAP + 1), "model_artifacts") : artIds.length ? await tx.select(artCols).from(modelArtifacts).where(inArray(modelArtifacts.id, artIds)) : [];
  const runIdsE = uniq(scanRows.map((s) => s.engineRunId).filter((x): x is string => !!x));
  const engineRunRows = runIdsE.length ? await tx.select({ id: engineRuns.id, engineId: engineRuns.engineId, engineVersion: engineRuns.engineVersion }).from(engineRuns).where(inArray(engineRuns.id, runIdsE)) : [];
  const engineIds = uniq(engineRunRows.map((r) => r.engineId));
  const engineRows = engineIds.length ? await tx.select({ id: engines.id, version: engines.version, imageDigest: engines.imageDigest, licence: engines.licence }).from(engines).where(inArray(engines.id, engineIds)) : [];

  // ---- promoted prompts bound to these agents (the tag positions; never the template)
  const promptRows = agentIds.length
    ? await tx
        .select({ promptId: promptTags.promptId, promptName: prompts.name, tag: promptTags.name, commitId: promptTags.commitId, hash: promptCommits.hash, agentId: sql<string>`${promptCommits.modelConfig} ->> 'agentId'` })
        .from(promptTags)
        .innerJoin(promptCommits, eq(promptCommits.id, promptTags.commitId))
        .innerJoin(prompts, eq(prompts.id, promptTags.promptId))
        .where(sql`(${promptCommits.modelConfig} ->> 'agentId') = any(${`{${agentIds.join(",")}}`}::text[])`)
    : [];

  // ---- active and canary config versions of the agents (digest of the body only, round 8)
  const cvRows = agentIds.length
    ? await tx.select({ id: configVersions.id, artifactType: configVersions.artifactType, artifactId: configVersions.artifactId, version: configVersions.version, status: configVersions.status, canaryPct: configVersions.canaryPct, body: configVersions.body }).from(configVersions)
        .where(and(inArray(configVersions.artifactType, ["agent_system_prompt", "agent_config"]), inArray(configVersions.artifactId, agentIds), inArray(configVersions.status, ["active", "canary"])))
    : [];

  // ---- GRANTED edges (ADR-0082): identity grants of the agents and builder agents, and builder tools
  const idByAgent = new Map(identities.filter((i) => i.agentId).map((i) => [i.id, { kind: "agent", id: i.agentId! }]));
  const idByBuilder = new Map(identities.filter((i) => i.builderAgentId).map((i) => [i.id, { kind: "builder_agent", id: i.builderAgentId! }]));
  const holderOf = (identityId: string) => idByAgent.get(identityId) ?? idByBuilder.get(identityId);
  const identityIds = identities.map((i) => i.id);
  const grants: AiBomRecordSet["grants"] = [];
  if (identityIds.length) {
    for (const g of await tx.select({ identityId: identityToolGrants.identityId, serverId: identityToolGrants.serverId, toolName: identityToolGrants.toolName }).from(identityToolGrants).where(inArray(identityToolGrants.identityId, identityIds))) {
      const [tool] = await tx.select({ id: mcpTools.id }).from(mcpTools).where(and(eq(mcpTools.serverId, g.serverId), eq(mcpTools.name, g.toolName)));
      const h = holderOf(g.identityId)!;
      // a grant to a tool the server no longer lists is a grant to the server's name space: recorded on the server
      grants.push(tool ? { holderKind: h.kind, holderId: h.id, targetKind: "mcp_tool", targetId: tool.id, source: "identity_tool_grants" } : { holderKind: h.kind, holderId: h.id, targetKind: "mcp_server", targetId: g.serverId, source: "identity_tool_grants" });
    }
    for (const g of await tx.select({ identityId: identityServerGrants.identityId, serverId: identityServerGrants.serverId }).from(identityServerGrants).where(inArray(identityServerGrants.identityId, identityIds))) {
      const h = holderOf(g.identityId)!;
      grants.push({ holderKind: h.kind, holderId: h.id, targetKind: "mcp_server", targetId: g.serverId, source: "identity_server_grants" });
    }
    for (const g of await tx.select({ identityId: identityConnectorGrants.identityId, connectorId: identityConnectorGrants.connectorId }).from(identityConnectorGrants).where(inArray(identityConnectorGrants.identityId, identityIds))) {
      const h = holderOf(g.identityId)!;
      grants.push({ holderKind: h.kind, holderId: h.id, targetKind: "connector", targetId: g.connectorId, source: "identity_connector_grants" });
    }
  }
  if (builderIds.length) {
    for (const t of await tx.select({ agentId: builderAgentTools.agentId, kind: builderAgentTools.kind, refId: builderAgentTools.refId }).from(builderAgentTools).where(inArray(builderAgentTools.agentId, builderIds))) {
      grants.push({ holderKind: "builder_agent", holderId: t.agentId, targetKind: t.kind === "connector" ? "connector" : "mcp_tool", targetId: t.refId, source: "builder_agent_tools" });
    }
  }

  // ---- MCP servers, tools, connectors in scope
  const toolGrantIds = uniq(grants.filter((g) => g.targetKind === "mcp_tool").map((g) => g.targetId));
  const grantedTools = toolGrantIds.length ? await tx.select({ id: mcpTools.id, serverId: mcpTools.serverId, name: mcpTools.name, kind: mcpTools.kind }).from(mcpTools).where(inArray(mcpTools.id, toolGrantIds)) : [];
  // a grant whose tool row is gone (builder tools have no FK) is not an edge we can describe
  const liveTools = new Set(grantedTools.map((t) => t.id));
  const keptGrants = grants.filter((g) => g.targetKind !== "mcp_tool" || liveTools.has(g.targetId));
  const serverIds = install ? null : uniq([...grantedTools.map((t) => t.serverId), ...keptGrants.filter((g) => g.targetKind === "mcp_server").map((g) => g.targetId)]);
  const serverCols = { id: mcpServers.id, name: mcpServers.name, transport: mcpServers.transport, url: mcpServers.url, releaseDigest: mcpServers.releaseDigest, admissionState: mcpServers.admissionState, admissionManifestDigest: mcpServers.admissionManifestDigest, identityPropagation: mcpServers.identityPropagation, ownerUserId: mcpServers.ownerUserId };
  const serverRows = serverIds === null ? capped(await tx.select(serverCols).from(mcpServers).limit(CAP + 1), "mcp_servers") : serverIds.length ? await tx.select(serverCols).from(mcpServers).where(inArray(mcpServers.id, serverIds)) : [];
  const serverGranted = new Set(keptGrants.filter((g) => g.targetKind === "mcp_server").map((g) => g.targetId));
  const toolRows = install
    ? capped(await tx.select({ id: mcpTools.id, serverId: mcpTools.serverId, name: mcpTools.name, kind: mcpTools.kind }).from(mcpTools).limit(CAP + 1), "mcp_tools")
    : uniq([
        ...grantedTools,
        // a server grant covers every tool the server lists
        ...(serverGranted.size ? await tx.select({ id: mcpTools.id, serverId: mcpTools.serverId, name: mcpTools.name, kind: mcpTools.kind }).from(mcpTools).where(inArray(mcpTools.serverId, [...serverGranted])) : []),
      ].map((t) => JSON.stringify(t))).map((s) => JSON.parse(s) as { id: string; serverId: string; name: string; kind: "read" | "write" });
  const connIds = install ? null : uniq(keptGrants.filter((g) => g.targetKind === "connector").map((g) => g.targetId));
  const connCols = { id: connectors.id, name: connectors.name, kind: connectors.kind, url: connectors.baseUrl, ownerUserId: connectors.ownerUserId, credentialSet: sql<boolean>`exists (select 1 from "connector_credentials" cc where cc."connector_id" = "connectors"."id")` };
  const connRows = connIds === null ? capped(await tx.select(connCols).from(connectors).limit(CAP + 1), "connectors") : connIds.length ? await tx.select(connCols).from(connectors).where(inArray(connectors.id, connIds)) : [];
  const liveConn = new Set(connRows.map((c) => c.id));
  const finalGrants = keptGrants.filter((g) => g.targetKind !== "connector" || liveConn.has(g.targetId));

  // ---- builder skills (pinned attachment snapshot; never the body) and memory stores
  const skillRows = builderIds.length
    ? await tx.select({ agentId: builderAgentSkills.agentId, skillId: builderAgentSkills.skillId, snapshotName: builderAgentSkills.snapshotName, snapshotDigest: builderAgentSkills.snapshotDigest, snapshotVersion: builderAgentSkills.snapshotVersion, snapshotAdmissionState: builderAgentSkills.snapshotAdmissionState }).from(builderAgentSkills).where(inArray(builderAgentSkills.agentId, builderIds))
    : [];
  const memoryStores: AiBomRecordSet["memoryStores"] = [
    ...builderIds.map((id) => ({ kind: "builder_agent_memory", builderAgentId: id })),
    ...(install ? ["semantic_cache", "conversations", "project_context"].map((kind) => ({ kind, builderAgentId: null })) : []),
  ];

  // ---- display names, only under the relaxation (R45)
  const names = new Map<string, string>();
  if (opts.personIdentifiers === "display_name") {
    const ids = uniq([...useCaseRows.map((u) => u.ownerUserId), ...agentRows.map((a) => a.ownerUserId), ...builderRows.map((b) => b.ownerUserId), ...serverRows.map((s) => s.ownerUserId), ...connRows.map((c) => c.ownerUserId)].filter((x): x is string => !!x));
    if (ids.length) for (const r of await tx.select({ id: users.id, displayName: users.displayName }).from(users).where(inArray(users.id, ids))) names.set(r.id, r.displayName);
  }
  const nameOf = (id: string | null) => (id ? names.get(id) ?? null : null);
  const identityOf = (k: "agentId" | "builderAgentId", id: string) => identities.find((i) => i[k] === id)?.identifier ?? null;

  return {
    subject: { kind: subject.kind, id: subject.id },
    install: install ? { installId: opts.installId } : null,
    useCases: useCaseRows.map((u) => ({ ...u, ownerDisplayName: nameOf(u.ownerUserId), euAiActTier: u.euAiActTier ?? null, complianceTags: u.complianceTags ?? [], intendedAgentIds: uniq(u.intendedAgentIds ?? []) })),
    agents: agentRows.map((a) => {
      const o = observed.find((x) => x.agentId === a.id);
      return { ...a, ownerDisplayName: nameOf(a.ownerUserId), workloadIdentity: identityOf("agentId", a.id), observedLastSeen: iso(o?.lastSeen ?? null), observedCount: o?.n ?? 0 };
    }),
    customProviders: providerRows,
    modelCards: cardRows.map((c) => ({ ...c, biasFairness: (c.biasFairness ?? []).map((b) => ({ dimension: b.dimension, method: b.method, status: b.status, resultRef: b.resultRef ?? null, assessedAt: b.assessedAt ?? null })), dataClaims: c.dataClaims as never, standardRefs: c.standardRefs ?? [] })),
    modelCardApprovals: approvalRows.map((a) => ({ ...a, decidedAt: iso(a.decidedAt), validUntil: iso(a.validUntil) })),
    modelCardEvidence: evidenceRows.map((e) => ({ ...e, attachedAt: iso(e.attachedAt)! })),
    evalRuns: runRows,
    evalDatasets: evalDatasetRows,
    trainingDatasets: dsRows,
    trainingJobs: jobRows,
    trainingArtifacts: taRows.map(({ payload, ...t }) => ({ ...t, payloadDigest: t.kind === "inline" && payload !== null ? bomDigestOf(payload) : null, createdAt: iso(t.createdAt)! })),
    modelArtifacts: artRows,
    artifactScans: scanRows.map((s) => ({ ...s, createdAt: iso(s.createdAt)! })),
    engineRuns: engineRunRows,
    engines: engineRows,
    promptTags: promptRows.filter((p) => agentIds.includes(p.agentId)),
    configVersions: cvRows.map(({ body, ...v }) => ({ ...v, bodyDigest: bomDigestOf(body) })),
    mcpServers: serverRows.map((s) => ({ ...s, ownerDisplayName: nameOf(s.ownerUserId) })),
    mcpTools: toolRows,
    connectors: connRows.map((c) => ({ ...c, ownerDisplayName: nameOf(c.ownerUserId) })),
    grants: finalGrants,
    builderAgents: builderRows.map((b) => ({ ...b, ownerDisplayName: nameOf(b.ownerUserId), workloadIdentity: identityOf("builderAgentId", b.id) })),
    builderSkills: skillRows,
    memoryStores,
  } as AiBomRecordSet;
}

// ---------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------

export interface AiBomSettings {
  cyclonedxVersions: CycloneDxSpecVersion[];
  personIdentifiers: "id_only" | "display_name";
  rateLimitPerMinute: number;
}
export async function loadAiBomSettings(tx: Tx): Promise<AiBomSettings> {
  const [row] = await tx.select({ v: orgSettings.cyclonedxExportVersions, p: orgSettings.bomPersonIdentifiers, r: orgSettings.bomExportRateLimitPerMinute }).from(orgSettings).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  // a missing row is the strict default (ADR-0180)
  const versions = ((row?.v as string[] | undefined) ?? ["1.7"]).filter((x): x is CycloneDxSpecVersion => x === "1.7" || x === "1.6");
  return {
    cyclonedxVersions: versions.includes("1.7") ? versions : ["1.7", ...versions],
    personIdentifiers: row?.p === "display_name" ? "display_name" : "id_only",
    rateLimitPerMinute: typeof row?.r === "number" ? row.r : 30,
  };
}

// ---------------------------------------------------------------------------
// the freeze
// ---------------------------------------------------------------------------

export interface TakeSnapshotInput {
  subject: AiBomSubject;
  trigger: AiBomSnapshotTrigger;
  actorUserId: string | null;
  installId?: string | null;
}
export interface TakenSnapshot {
  id: string;
  version: number;
  serialNumber: string;
  bodySha256: string;
  build: AiBomBuild;
}

/** the receipt key, checked against its recorded public key; 409 when there is none (no unsigned fallback, ever) */
function snapshotKey() {
  let key: ReturnType<typeof loadReceiptSigningKey>;
  try {
    key = loadReceiptSigningKey();
  } catch (e) {
    if (e instanceof ReceiptKeyError) throw new AiBomError(503, "receipt_signing_key_invalid", e.message);
    throw e;
  }
  if (!key) throw new AiBomError(409, "bom_signing_unavailable", "No receipt signing key is configured (REGULAIT_RECEIPT_SIGNING_KEY); an AI BOM snapshot is never stored unsigned.");
  return key;
}

interface PreparedSnapshot {
  id: string;
  version: number;
  prevId: string | null;
  createdAt: string;
  expiresAt: Date | null;
  build: AiBomBuild;
  signature: string;
  key: NonNullable<ReturnType<typeof loadReceiptSigningKey>>;
  keyRecorded: boolean;
}

async function assertRepeatableRead(tx: Tx): Promise<void> {
  const level = (await tx.execute(sql`select current_setting('transaction_isolation') as l`)) as unknown as { rows: Array<{ l: string }> };
  if (!["repeatable read", "serializable"].includes(level.rows[0]!.l)) {
    throw new AiBomError(500, "ai_bom_capture_isolation", "an AI BOM capture needs a REPEATABLE READ transaction");
  }
}

/** CAPTURE (R22): read everything from one REPEATABLE READ snapshot, allocate the version, build, sign. Writes nothing. */
async function prepareAiBomSnapshot(tx: Tx, input: TakeSnapshotInput): Promise<PreparedSnapshot> {
  await assertRepeatableRead(tx);
  const key = snapshotKey();
  const [recorded] = await tx.select().from(receiptSigningKeys).where(eq(receiptSigningKeys.keyId, key.keyId));
  if (recorded && (!sameReceiptPublicKey(recorded.publicJwk, key.jwk) || recorded.retiredAt)) throw new AiBomError(503, "receipt_signing_key_invalid", "The receipt signing key conflicts with its recorded public key.");
  const settings = await loadAiBomSettings(tx);
  const [prev] = await tx.select({ id: aiBomSnapshots.id, version: aiBomSnapshots.version }).from(aiBomSnapshots)
    .where(and(eq(aiBomSnapshots.subjectKind, input.subject.kind), eq(aiBomSnapshots.subjectId, input.subject.id))).orderBy(desc(aiBomSnapshots.version)).limit(1);
  const head = (await tx.execute(sql`select gen_random_uuid()::text as id, now() as at`)) as unknown as { rows: Array<{ id: string; at: Date | string }> };
  const id = head.rows[0]!.id;
  const createdAt = new Date(head.rows[0]!.at).toISOString(); // the DB clock at the capture
  const records = await loadAiBomRecords(tx, input.subject, { personIdentifiers: settings.personIdentifiers, installId: input.installId ?? null });
  const version = (prev?.version ?? 0) + 1;
  const build = buildAiBom(records, { id, subjectKind: input.subject.kind, subjectId: input.subject.id, version, supersedes: prev?.id ?? null, trigger: input.trigger, createdAt }, { cyclonedxVersions: settings.cyclonedxVersions });
  const signature = sign(null, Buffer.from(build.bodyBytes, "utf8"), key.privateKey).toString("base64url");
  const expiresAt = bomExpiresAt(new Date(createdAt), await retentionFloorDays(tx));
  return { id, version, prevId: prev?.id ?? null, createdAt, expiresAt, build, signature, key, keyRecorded: !!recorded };
}

/** FREEZE: the key row (first use), the snapshot and its renderings, and (when given) the audit row, in the caller's transaction */
async function insertPreparedSnapshot(tx: Tx, p: PreparedSnapshot, input: TakeSnapshotInput, opts: { audit: boolean }): Promise<TakenSnapshot> {
  if (!p.keyRecorded) await tx.insert(receiptSigningKeys).values({ keyId: p.key.keyId, publicJwk: p.key.jwk, firstUsedAt: new Date(p.createdAt) }).onConflictDoNothing();
  await tx.insert(aiBomSnapshots).values({
    id: p.id, subjectKind: input.subject.kind, subjectId: input.subject.id, version: p.version, serialNumber: p.build.body.serialNumber.slice("urn:uuid:".length), supersedesId: p.prevId,
    trigger: input.trigger, basis: { rows: p.build.basis.length, sha256: bomDigestOf(p.build.basis) }, body: p.build.bodyBytes, bodySha256: p.build.bodySha256,
    signature: p.signature, keyId: p.key.keyId, expiresAt: p.expiresAt, createdBy: input.actorUserId, createdAt: new Date(p.createdAt),
  } as never);
  for (const r of p.build.renderings) {
    await tx.insert(bomRenderings).values({ aiBomSnapshotId: p.id, format: r.format, bytes: r.bytes, sha256: r.sha256, validator: r.validator } as never);
  }
  if (opts.audit) {
    await tx.insert(auditLog).values({
      userId: input.actorUserId ?? "00000000-0000-0000-0000-000000000000", objectType: "audit_export", objectId: p.id, effect: "allow",
      ruleId: "ai-bom-snapshot-taken", ruleChain: [], reason: "AI BOM snapshot frozen and signed",
      detail: { subjectKind: input.subject.kind, subjectId: input.subject.id, version: p.version, trigger: input.trigger, bodySha256: p.build.bodySha256 },
    });
  }
  return { id: p.id, version: p.version, serialNumber: p.build.body.serialNumber, bodySha256: p.build.bodySha256, build: p.build };
}

/**
 * Capture, build, sign and insert one snapshot inside the CALLER's
 * transaction, which must be REPEATABLE READ or SERIALIZABLE (R22): the shape
 * a sign-off trigger needs (#280 4237493034). A stale version allocation is
 * refused by the contiguous-version guard and the unique constraint; it never
 * forks.
 *
 * TODO(ADR-0189 R50, R17): this in-transaction path cannot take the
 * per-subject lock BEFORE its snapshot (the caller's transaction already has
 * one), and it writes no audit row (an audit append under REPEATABLE READ can
 * read a stale chain tip after its lock wait). Both are settled when the
 * release PR wires triggers: the triggering transaction must take the session
 * lock first and append its audit row through a READ COMMITTED step. Until
 * then it is reachable only through the inert `aiBomSnapshotTriggerGate`.
 */
export async function captureAiBomSnapshotInTx(tx: Tx, input: TakeSnapshotInput): Promise<TakenSnapshot> {
  return insertPreparedSnapshot(tx, await prepareAiBomSnapshot(tx, input), input, { audit: false });
}

/**
 * THE ON-DEMAND FREEZE (R50, 4237346650, PR #287): session lock first (bounded
 * wait, single-flight); the capture in one REPEATABLE READ READ ONLY
 * transaction; then ONE write transaction holding the snapshot, its
 * renderings AND its audit row, so neither exists without the other; then
 * unlock. The write is READ COMMITTED because the audit chain append reads its
 * tip after its own lock wait, which a REPEATABLE READ snapshot would make
 * stale. The session lock spans both, so no other writer of this subject can
 * land between them, and the version guard re-checks contiguity at insert.
 */
export async function takeAiBomSnapshot(db: Db, input: TakeSnapshotInput): Promise<TakenSnapshot> {
  snapshotKey(); // refuse before taking any lock when there is no key (409, nothing half-done)
  try {
    return await withAiBomSubjectSessionLock(db, input.subject.kind, input.subject.id, async (bound) => {
      const b = bound as unknown as Db;
      const prepared = await b.transaction((tx) => prepareAiBomSnapshot(tx as unknown as Db, input), { isolationLevel: "repeatable read", accessMode: "read only" });
      return b.transaction((tx) => insertPreparedSnapshot(tx as unknown as Db, prepared, input, { audit: true }), { isolationLevel: "read committed" });
    });
  } catch (e) {
    if (e instanceof BomSubjectBusyError) throw new AiBomError(409, "bom_snapshot_busy", e.message);
    throw e;
  }
}

/**
 * OWNER DECISION 8 / R25: the sign-off trigger hook. Inert until the R17 switch
 * flips (R2: "triggers do nothing before the switch"); it then takes the
 * snapshot inside the triggering REPEATABLE READ transaction (#280 4237493034).
 */
export async function aiBomSnapshotTriggerGate(tx: Tx, input: TakeSnapshotInput): Promise<{ status: "not_released" } | { status: "taken"; snapshot: TakenSnapshot }> {
  if (!AI_BOM_SNAPSHOTS_RELEASED) return { status: "not_released" };
  return { status: "taken", snapshot: await captureAiBomSnapshotInTx(tx, input) };
}

// ---------------------------------------------------------------------------
// drift (R8)
// ---------------------------------------------------------------------------

export interface AiBomDrift {
  evidence: false;
  subject: AiBomSubject;
  baseline: { snapshotId: string; version: number; createdAt: string; serialNumber: string };
  changes: AiBomDriftChange[];
}

/**
 * The change list of the live state against the newest signed snapshot.
 * The live side is rendered in memory only and never stored, signed or
 * returned; the response holds refs, versions and hashes.
 */
export async function aiBomDrift(db: Db, subject: AiBomSubject, installId: string | null): Promise<AiBomDrift> {
  return db.transaction(
    async (txRaw) => {
      const tx = txRaw as unknown as Db;
      if (!(await subjectExists(tx, subject))) throw new AiBomError(404, "ai_bom_subject_not_found", "No such AI BOM subject.");
      const [snap] = await tx.select({ id: aiBomSnapshots.id, version: aiBomSnapshots.version, createdAt: aiBomSnapshots.createdAt, serialNumber: aiBomSnapshots.serialNumber }).from(aiBomSnapshots)
        .where(and(eq(aiBomSnapshots.subjectKind, subject.kind), eq(aiBomSnapshots.subjectId, subject.id))).orderBy(desc(aiBomSnapshots.version)).limit(1);
      // R8: drift needs a signed snapshot to compare with; there is no unsigned draft to fall back on
      if (!snap) throw new AiBomError(409, "ai_bom_no_snapshot", "This subject has no signed AI BOM snapshot to compare with.");
      const [rendering] = await tx.select({ bytes: bomRenderings.bytes, sha256: bomRenderings.sha256 }).from(bomRenderings)
        .where(and(eq(bomRenderings.aiBomSnapshotId, snap.id), eq(bomRenderings.format, "cyclonedx-1.7")));
      if (!rendering || createHash("sha256").update(rendering.bytes, "utf8").digest("hex") !== rendering.sha256) {
        throw new AiBomError(500, "ai_bom_baseline_unreadable", "The baseline snapshot's CycloneDX 1.7 rendering is missing or does not match its hash.");
      }
      const records = await loadAiBomRecords(tx, subject, { personIdentifiers: "id_only", installId });
      const live = buildAiBom(records, { id: snap.id, subjectKind: subject.kind, subjectId: subject.id, version: snap.version, supersedes: null, trigger: "on_demand", createdAt: new Date(snap.createdAt).toISOString() }, { cyclonedxVersions: ["1.7"] });
      const liveDoc = JSON.parse(live.renderings.find((r) => r.format === "cyclonedx-1.7")!.bytes) as unknown;
      return {
        evidence: false as const,
        subject,
        baseline: { snapshotId: snap.id, version: snap.version, createdAt: new Date(snap.createdAt).toISOString(), serialNumber: `urn:uuid:${snap.serialNumber}` },
        changes: diffAiBomInventory(aiBomInventoryIndex(JSON.parse(rendering.bytes)), aiBomInventoryIndex(liveDoc)),
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

/** the subject's snapshot list (metadata only; downloads are bundles, B4) */
export async function listAiBomSnapshots(db: Db, subject: AiBomSubject) {
  const rows = await db.select({ id: aiBomSnapshots.id, version: aiBomSnapshots.version, serialNumber: aiBomSnapshots.serialNumber, trigger: aiBomSnapshots.trigger, bodySha256: aiBomSnapshots.bodySha256, keyId: aiBomSnapshots.keyId, createdAt: aiBomSnapshots.createdAt })
    .from(aiBomSnapshots).where(and(eq(aiBomSnapshots.subjectKind, subject.kind), eq(aiBomSnapshots.subjectId, subject.id))).orderBy(asc(aiBomSnapshots.version));
  const formats = rows.length
    ? await db.select({ id: bomRenderings.aiBomSnapshotId, format: bomRenderings.format }).from(bomRenderings).where(inArray(bomRenderings.aiBomSnapshotId, rows.map((r) => r.id)))
    : [];
  return rows.map((r) => ({ ...r, serialNumber: `urn:uuid:${r.serialNumber}`, createdAt: r.createdAt.toISOString(), formats: formats.filter((f) => f.id === r.id).map((f) => f.format).sort() }));
}
