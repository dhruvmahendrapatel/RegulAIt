/**
 * ADR-0189 slice B3 — the pure AI BOM builder and CycloneDX renderer.
 *
 * Every invariant has a NEGATIVE CONTROL (the forged or widened input that the
 * rule must refuse) beside its positive case (M-002, M-033).
 */
import { createHash } from "node:crypto";
import { describe, expect, it, beforeAll } from "vitest";
import { Models } from "@cyclonedx/cyclonedx-library";
import {
  AI_BOM_INSTALL_SUBJECT_ID,
  AI_BOM_SCAN_VERDICTS,
  AI_BOM_MAX_RECORDS_PER_LIST,
  aiBomInventoryIndex,
  aiBomSerialNumber,
  buildAiBom,
  buildCycloneDxAjv,
  compositionProblems,
  diffAiBomInventory,
  normaliseAiBomRecords,
  renderAiBomCycloneDx,
  safeReference,
  sanitiseAiBomEndpoint,
  validateCycloneDx,
  warmCycloneDxValidators,
  AiBomBuildError,
  AiBomRecordError,
  CYCLONEDX_SCHEMA_FILES,
  type AiBomRecordSet,
  type AiBomSnapshotMeta,
} from "../index.js";
import { readFileSync } from "node:fs";

const u = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const H = (c: string) => c.repeat(64);
const T = "2026-10-10T12:00:00.000Z";
const UC = u(1), AG = u(2), AG2 = u(3), CARD1 = u(4), CARD2 = u(5), CP = u(6), APPR = u(7), EV1 = u(8), EV2 = u(9), EV3 = u(10);
const RUN = u(11), EDS = u(12), TDS = u(13), JOB = u(14), TA1 = u(15), TA2 = u(16), ART = u(17), ART2 = u(18), SCAN = u(19), SCAN2 = u(20);
const ERUN = u(21), PROMPT = u(22), COMMIT = u(23), CV1 = u(24), CV2 = u(25), MCP = u(26), TOOL = u(27), CONN = u(28), BA = u(29), SKILL = u(30), OWNER = u(31), PROJ = u(32), CARD3 = u(33);

function fixture(over: Partial<AiBomRecordSet> = {}): AiBomRecordSet {
  return {
    subject: { kind: "use_case", id: UC },
    install: { installId: null },
    useCases: [{ id: UC, name: "Claims triage", ownerUserId: OWNER, ownerDisplayName: null, dataSensitivity: "confidential", complianceTags: ["soc2", "hipaa"], euAiActTier: "high", status: "approved", intendedAgentIds: [AG] }],
    agents: [
      { id: AG, name: "triage-agent", provider: "provider-a", model: "model-x", expectedServedModel: null, customProviderId: null, lifecycleStatus: "active", ownerUserId: OWNER, ownerDisplayName: null, workloadIdentity: `spiffe://regulait.local/regulait/agent/${AG}`, observedLastSeen: T, observedCount: 7 },
      { id: AG2, name: "custom-agent", provider: "custom", model: null, expectedServedModel: null, customProviderId: CP, lifecycleStatus: "active", ownerUserId: null, ownerDisplayName: null, workloadIdentity: null, observedLastSeen: null, observedCount: 0 },
    ],
    customProviders: [{ id: CP, name: "in-house", wireProtocol: "openai_chat", baseUrl: "https://models.internal.example:8443/v1/chat?token=CANARY_QUERY#CANARY_FRAG", keySet: true }],
    modelCards: [
      { id: CARD1, agentId: AG, customProviderId: null, intendedUse: "Claims triage summaries", limitations: "Not for final decisions", biasFairness: [{ dimension: "age", method: "counterfactual set", status: "assessed", resultRef: null, assessedAt: "2026-09-01" }], dataClaims: { trainingData: "public web corpus (supplier statement)", license: "Apache-2.0", task: "text-generation" }, standardRefs: ["ISO-42001-A.6"], pinnedModelVersion: "2026-06-01" },
      { id: CARD2, agentId: AG, customProviderId: null, intendedUse: "Fraud hints", limitations: null, biasFairness: [], dataClaims: { license: "proprietary" }, standardRefs: [], pinnedModelVersion: null },
      { id: CARD3, agentId: null, customProviderId: CP, intendedUse: "In-house summariser", limitations: null, biasFairness: [], dataClaims: {}, standardRefs: [], pinnedModelVersion: "v3" },
    ],
    modelCardApprovals: [{ id: APPR, cardId: CARD1, status: "approved", decidedAt: "2026-10-01T00:00:00.000Z", validUntil: null }],
    modelCardEvidence: [
      { id: EV1, cardId: CARD1, kind: "eval_run", evalRunId: RUN, externalRef: null, artifactScanId: null, attachedAt: T },
      { id: EV2, cardId: CARD1, kind: "external", evalRunId: null, externalRef: "https://audits.example/report?sig=CANARY_EXTSIG", artifactScanId: null, attachedAt: T },
      { id: EV3, cardId: CARD2, kind: "engine_scan", evalRunId: null, externalRef: null, artifactScanId: SCAN, attachedAt: T },
    ],
    evalRuns: [{ id: RUN, datasetId: EDS, datasetVersion: 2 }],
    evalDatasets: [{ id: EDS, version: 2, name: "triage-golden", casesDigest: H("e") }],
    trainingDatasets: [{ id: TDS, version: 1, name: "claims-ft", checksum: `sha256:${H("d")}:120`, rowCount: 120, piiVerdict: "flagged", projectId: PROJ, projectDataSensitivity: "regulated" }],
    trainingJobs: [{ id: JOB, datasetId: TDS, datasetVersion: 1, method: "lora", baseAgentId: AG, status: "succeeded" }],
    trainingArtifacts: [
      { id: TA1, jobId: JOB, name: "claims-lora", method: "lora", kind: "inline", agentId: AG, modelCardId: CARD1, payloadDigest: H("f"), createdAt: T },
      { id: TA2, jobId: JOB, name: "claims-remote", method: "lora", kind: "remote", agentId: null, modelCardId: null, payloadDigest: null, createdAt: T },
    ],
    modelArtifacts: [
      { id: ART, sha256: H("a"), sizeBytes: 1024, format: "safetensors" },
      { id: ART2, sha256: H("b"), sizeBytes: 2048, format: "pickle" },
    ],
    artifactScans: [
      { id: SCAN, artifactId: ART, engineRunId: ERUN, artifactSha256: H("a"), verdict: "no_known_unsafe", scannerVersion: "0.8.5", createdAt: T },
      { id: SCAN2, artifactId: ART2, engineRunId: null, artifactSha256: H("b"), verdict: "unknown", scannerVersion: "0.8.5", createdAt: T },
    ],
    engineRuns: [{ id: ERUN, engineId: "modelscan", engineVersion: "0.8.5" }],
    engines: [{ id: "modelscan", version: "0.8.5", imageDigest: `sha256:${H("c")}`, licence: "Apache-2.0" }],
    promptTags: [{ promptId: PROMPT, promptName: "triage system", tag: "production", commitId: COMMIT, hash: H("1"), agentId: AG }],
    configVersions: [
      { id: CV1, artifactType: "agent_system_prompt", artifactId: AG, version: 4, status: "active", canaryPct: null, bodyDigest: H("2") },
      { id: CV2, artifactType: "agent_system_prompt", artifactId: AG, version: 5, status: "canary", canaryPct: 10, bodyDigest: H("3") },
    ],
    mcpServers: [{ id: MCP, name: "files", transport: "streamable_http", url: "https://mcp.example/bot123456:ABCDEFsecretpath/api?key=CANARY_MCP", releaseDigest: H("4"), admissionState: "clean", admissionManifestDigest: null, identityPropagation: "none", ownerUserId: null, ownerDisplayName: null }],
    mcpTools: [{ id: TOOL, serverId: MCP, name: "read_file", kind: "read" }],
    connectors: [{ id: CONN, name: "crm", kind: "salesforce", url: null, ownerUserId: OWNER, ownerDisplayName: null, credentialSet: true }],
    grants: [
      { holderKind: "agent", holderId: AG, targetKind: "mcp_tool", targetId: TOOL, source: "identity_tool_grants" },
      { holderKind: "agent", holderId: AG, targetKind: "connector", targetId: CONN, source: "identity_connector_grants" },
    ],
    builderAgents: [],
    builderSkills: [],
    memoryStores: [],
    ...over,
  };
}
const meta = (o: Partial<AiBomSnapshotMeta> = {}): AiBomSnapshotMeta => ({ id: u(900), subjectKind: "use_case", subjectId: UC, version: 1, supersedes: null, trigger: "on_demand", createdAt: T, ...o });
const opts = { cyclonedxVersions: ["1.7", "1.6"] as const };
const cdx = (b: ReturnType<typeof buildAiBom>, f = "cyclonedx-1.7") => JSON.parse(b.renderings.find((r) => r.format === f)!.bytes) as Record<string, any>;
const comp = (doc: Record<string, any>, ref: string) => (doc.components as any[]).find((c) => c["bom-ref"] === ref);
const svc = (doc: Record<string, any>, ref: string) => (doc.services as any[]).find((c) => c["bom-ref"] === ref);
const deps = (doc: Record<string, any>, ref: string) => ((doc.dependencies as any[]).find((d) => d.ref === ref)?.dependsOn ?? []) as string[];
const all = (b: ReturnType<typeof buildAiBom>) => [b.bodyBytes, ...b.renderings.map((r) => r.bytes)].join("\n");
const refused = (fn: () => unknown, pattern: RegExp) => {
  let err: unknown = null;
  try { fn(); } catch (e) { err = e; }
  expect(err, `refused with ${pattern}`).not.toBeNull();
  expect(`${(err as Error).message} ${((err as AiBomBuildError).paths ?? []).join(" ")}`).toMatch(pattern);
};

// a seeded shuffle (no Math.random: reproducible)
function shuffle<T>(list: T[], seed: number): T[] {
  const out = [...list];
  let s = seed;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}
function reorder(v: unknown, seed: number): unknown {
  if (Array.isArray(v)) return shuffle(v.map((x, i) => reorder(x, seed + i)), seed);
  if (v && typeof v === "object") return Object.fromEntries(shuffle(Object.entries(v).map(([k, x], i) => [k, reorder(x, seed + i)] as const), seed));
  return v;
}

beforeAll(() => warmCycloneDxValidators(), 60_000);

describe("ADR-0176 §4 exception re-check (amendment 1)", () => {
  it("the pinned library's Component model still has no modelCard or data field, so we emit JSON ourselves", () => {
    const c = new Models.Component("machine-learning-model" as never, "x") as unknown as Record<string, unknown>;
    expect("modelCard" in c).toBe(false);
    expect("data" in c).toBe(false);
    const bom = new Models.Bom() as unknown as Record<string, unknown>;
    expect("declarations" in bom).toBe(false);
    expect("compositions" in bom).toBe(false);
  });
});

describe("exact bytes (§5, amendment 5)", () => {
  it("are identical across input orderings of every list and every key", () => {
    const a = buildAiBom(fixture(), meta(), opts);
    for (const seed of [1, 7, 42, 1234]) {
      const shuffled = reorder(fixture(), seed) as AiBomRecordSet;
      expect(JSON.stringify(shuffled)).not.toBe(JSON.stringify(fixture())); // the input really is reordered
      const b = buildAiBom(shuffled, meta(), opts);
      expect(b.bodyBytes).toBe(a.bodyBytes);
      expect(b.renderings.map((r) => r.bytes)).toEqual(a.renderings.map((r) => r.bytes));
    }
  });
  it("negative control: one changed fact changes the bytes", () => {
    const a = buildAiBom(fixture(), meta(), opts);
    const f = fixture();
    f.modelArtifacts[0]!.sizeBytes = 1025;
    expect(buildAiBom(f, meta(), opts).bodyBytes).not.toBe(a.bodyBytes);
  });
  it("the native body carries each rendering's sha256 and length, and the v8 serial of the snapshot id", () => {
    const b = buildAiBom(fixture(), meta(), opts);
    for (const r of b.renderings) {
      expect(b.body.renderings[r.format]).toMatchObject({ status: "rendered", sha256: createHash("sha256").update(r.bytes).digest("hex"), bytes: Buffer.byteLength(r.bytes) });
    }
    expect(b.body.serialNumber).toBe(`urn:uuid:${aiBomSerialNumber(u(900))}`);
    expect(cdx(b).serialNumber).toBe(b.body.serialNumber);
    expect(b.basis.length).toBeGreaterThan(20);
  });
  it("1.6 is rendered only when the setting adds it; 1.7 is always required", () => {
    const b = buildAiBom(fixture(), meta(), { cyclonedxVersions: ["1.7"] });
    expect(Object.keys(b.body.renderings)).toEqual(["cyclonedx-1.7"]);
    refused(() => buildAiBom(fixture(), meta(), { cyclonedxVersions: ["1.6"] }), /1\.7 is always rendered/);
  });
});

describe("official schema validation, offline, both versions", () => {
  const subjects = () => {
    const ba = { id: BA, name: "helper", modelAgentId: AG, ownerUserId: OWNER, ownerDisplayName: null, workloadIdentity: null };
    const skill = { agentId: BA, skillId: SKILL, snapshotName: "summarise", snapshotDigest: H("5"), snapshotVersion: 2, snapshotAdmissionState: "admitted" };
    return [
      { f: fixture(), m: meta() },
      { f: fixture({ subject: { kind: "agent", id: AG } }), m: meta({ subjectKind: "agent", subjectId: AG }) },
      { f: fixture({ subject: { kind: "builder_agent", id: BA }, builderAgents: [ba], builderSkills: [skill], memoryStores: [{ kind: "builder_agent_memory", builderAgentId: BA }] }), m: meta({ subjectKind: "builder_agent", subjectId: BA }) },
      { f: fixture({ subject: { kind: "install", id: AI_BOM_INSTALL_SUBJECT_ID }, install: { installId: "acme-prod-eu" }, builderAgents: [ba], builderSkills: [skill], memoryStores: [{ kind: "semantic_cache", builderAgentId: null }] }), m: meta({ subjectKind: "install", subjectId: AI_BOM_INSTALL_SUBJECT_ID }) },
    ];
  };
  it("R31: one snapshot of each of the four subject kinds builds and validates against 1.7 and 1.6", () => {
    for (const { f, m } of subjects()) {
      const b = buildAiBom(f, m, opts);
      for (const v of ["1.7", "1.6"] as const) {
        const r = validateCycloneDx(cdx(b, `cyclonedx-${v}`), v);
        expect(r.errors, `${m.subjectKind} ${v}`).toEqual([]);
      }
      expect(cdx(b).metadata.component.properties).toContainEqual({ name: "regulait:subject:kind", value: m.subjectKind });
    }
  });
  it("each kind roots at its own record, never a synthetic use case", () => {
    const [, agent, builder, install] = subjects().map(({ f, m }) => cdx(buildAiBom(f, m, opts)));
    expect(agent!.metadata.component.name).toBe("triage-agent");
    expect(builder!.metadata.component.name).toBe("helper");
    expect(install!.metadata.component["bom-ref"]).toBe("install");
    expect(install!.metadata.component.properties).toContainEqual({ name: "regulait:install:id", value: "acme-prod-eu" });
    // the internal nil key is never exported as an identity (R20)
    expect(JSON.stringify(install!.metadata)).not.toContain(AI_BOM_INSTALL_SUBJECT_ID);
  });
  it("negative control: the schema refuses a data flow without classification and an email in an email-typed field", () => {
    const doc = cdx(buildAiBom(fixture(), meta(), opts));
    const noClass = structuredClone(doc);
    delete (noClass.services as any[]).find((x) => x["bom-ref"] === `service:provider:${AG}`).data[0].classification;
    expect(validateCycloneDx(noClass, "1.7").valid).toBe(false);
    const withEmail = structuredClone(doc);
    withEmail.metadata.manufacturer = { name: "x", contact: [{ email: "someone@example.com" }] };
    expect(validateCycloneDx(withEmail, "1.7").valid).toBe(false);
    delete withEmail.metadata.manufacturer.contact;
    expect(validateCycloneDx(withEmail, "1.7").valid).toBe(true);
  });
  it("amendment 2: iri-reference is the ASCII uri-reference check; the library's accept-all would pass a non-ASCII IRI", () => {
    const doc = cdx(buildAiBom(fixture(), meta(), opts));
    doc.externalReferences = [{ type: "website", url: "https://exämple.test/ü" }];
    expect(validateCycloneDx(doc, "1.7").valid).toBe(false);
    const loose = buildCycloneDxAjv({ iriReference: "accept-all" }).compile(JSON.parse(readFileSync(CYCLONEDX_SCHEMA_FILES["1.7"], "utf8")));
    expect(loose(doc)).toBe(true);
  }, 60_000);
});

describe("no content, no credential, no email (OWNER DECISION 5, R10, R47, #280)", () => {
  it("R47 + #280 4237493036: endpoints keep scheme://host[:port] only; query, fragment and credential-bearing PATH never appear", () => {
    const b = buildAiBom(fixture(), meta(), opts);
    for (const canary of ["CANARY_QUERY", "CANARY_FRAG", "CANARY_MCP", "ABCDEFsecretpath", "bot123456", "/v1/chat"]) expect(all(b)).not.toContain(canary);
    const doc = cdx(b);
    expect(svc(doc, `service:mcp:${MCP}`).endpoints).toEqual(["https://mcp.example"]);
    expect(svc(doc, `service:provider:${AG2}`).endpoints).toEqual(["https://models.internal.example:8443"]);
    expect(sanitiseAiBomEndpoint("https://h.example/bot1:XYZ/x", "t")).toBe("https://h.example");
  });
  it("negative control: an endpoint with userinfo refuses the snapshot", () => {
    const f = fixture();
    f.connectors[0]!.url = "https://user:pass@crm.example/api";
    refused(() => buildAiBom(f, meta(), opts), /userinfo/);
  });
  it("a stdio server and a governance-only connector have no endpoints field", () => {
    const f = fixture();
    f.mcpServers[0] = { ...f.mcpServers[0]!, transport: "stdio", url: "stdio:local files" };
    const doc = cdx(buildAiBom(f, meta(), opts));
    expect(svc(doc, `service:mcp:${MCP}`).endpoints).toBeUndefined();
    expect(svc(doc, `service:connector:${CONN}`).endpoints).toBeUndefined();
  });
  it("R10: an email anywhere refuses, naming the path; control: the same build without it passes", () => {
    for (const mutate of [
      (f: AiBomRecordSet) => { f.useCases[0]!.name = "Owner jane@example.com"; },
      (f: AiBomRecordSet) => { f.modelCards[0]!.limitations = "ask ops@localhost"; },
      (f: AiBomRecordSet) => { f.modelCards[0]!.dataClaims = { trainingData: "\"Fred B\"@example.com" }; },
      (f: AiBomRecordSet) => { f.agents[0]!.name = "user@[192.0.2.1]"; },
    ]) {
      const f = fixture();
      mutate(f);
      refused(() => buildAiBom(f, meta(), opts), /email-shaped/);
    }
    expect(() => buildAiBom(fixture(), meta(), opts)).not.toThrow();
  });
  it("loader contract: an unknown key (a system prompt, a template, a payload) is refused, never copied", () => {
    for (const [list, extra] of [["agents", { systemPrompt: "CANARY_SYSTEM" }], ["promptTags", { template: "CANARY_TEMPLATE" }], ["trainingArtifacts", { payload: { w: 1 } }], ["builderSkills", { body: "x" }]] as const) {
      const f = fixture({ builderSkills: [{ agentId: BA, skillId: SKILL, snapshotName: "s", snapshotDigest: "", snapshotVersion: 1, snapshotAdmissionState: "clean" }], builderAgents: [{ id: BA, name: "b", modelAgentId: null, ownerUserId: null, ownerDisplayName: null, workloadIdentity: null }] });
      ((f as any)[list][0] as Record<string, unknown>) = { ...(f as any)[list][0], ...extra };
      refused(() => normaliseAiBomRecords(f), /unknown key/);
    }
  });
  it("round 9 (4237344238): data_claims accept allowlisted scalar keys only; nested values and unknown keys are refused", () => {
    for (const claims of [{ trainingData: { nested: "x" } }, { trainingData: ["a"] }, { rawPrompt: "x" }, { license: "x".repeat(513) }, { task: 1.5 }]) {
      const f = fixture();
      f.modelCards[0]!.dataClaims = claims as never;
      refused(() => normaliseAiBomRecords(f), /data_claims|longer than|safe integer|unknown/);
    }
  });
  it("#280 4237488597: evidence references render safely (URL origin, identifier, or SHA-256 only)", () => {
    const b = buildAiBom(fixture(), meta(), opts);
    expect(all(b)).not.toContain("CANARY_EXTSIG");
    const doc = cdx(b);
    const ev = (doc.declarations.evidence as any[]).find((e) => e["bom-ref"] === `evidence:mce:${EV2}`);
    expect(ev.description).toBe("externalRef:url:https://audits.example; digest: not_recorded");
    expect((doc.declarations.evidence as any[]).find((e) => e["bom-ref"] === `evidence:mce:${EV1}`).description).toBe(`evalRunId:${RUN}; digest: not_recorded`);
    expect(safeReference("ticket AUDIT-12 with token sk-live-CANARY", "t")).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(safeReference("AUDIT-12", "t")).toBe("id:AUDIT-12");
    // R30: never a fabricated evidence digest
    expect(all(b)).not.toContain("sha256:undefined");
  });
});

describe("#280 B3 entry conditions on the model and evidence mapping", () => {
  it("4237488595: one model component per model card, the agent depends on each, none is picked", () => {
    const doc = cdx(buildAiBom(fixture(), meta(), opts));
    expect(deps(doc, `agent:${AG}`)).toEqual(expect.arrayContaining([`model:${CARD1}`, `model:${CARD2}`]));
    expect(comp(doc, `model:${CARD1}`).modelCard.considerations.useCases).toEqual(["Claims triage summaries"]);
    expect(comp(doc, `model:${CARD2}`).modelCard.considerations.useCases).toEqual(["Fraud hints"]);
    // a custom provider's card hangs off every agent using that provider
    expect(deps(doc, `agent:${AG2}`)).toContain(`model:${CARD3}`);
  });
  it("round 12 4237584891: the version is the card's pinned_model_version; agents carry none", () => {
    const doc = cdx(buildAiBom(fixture(), meta(), opts));
    expect(comp(doc, `model:${CARD1}`).version).toBe("2026-06-01");
    expect(comp(doc, `model:${CARD2}`).version).toBeUndefined();
    expect(comp(doc, `model:${CARD2}`).properties).toContainEqual({ name: "regulait:model:version", value: "not_recorded" });
    expect(comp(doc, `agent:${AG}`).version).toBeUndefined();
  });
  it("round 12 4237584880: a card declaring only a licence has training provenance unknown; a training claim makes it supplier-declared", () => {
    const doc = cdx(buildAiBom(fixture(), meta(), opts));
    const prov = (ref: string) => (comp(doc, ref).properties as any[]).find((p) => p.name === "regulait:trainingData:provenance").value;
    expect(prov(`model:${CARD2}`)).toBe("unknown");
    expect(prov(`model:${CARD1}`)).toBe("supplier-declared");
    const f = fixture();
    f.modelCards[0]!.dataClaims = { trainingData: "   ", license: "x" };
    expect((comp(cdx(buildAiBom(f, meta(), opts)), `model:${CARD1}`).properties as any[]).find((p) => p.name === "regulait:trainingData:provenance").value).toBe("unknown");
  });
  it("amendment 8: a missing licence is stated as unknown and its model is in an incomplete composition", () => {
    const b = buildAiBom(fixture(), meta(), opts);
    expect(comp(cdx(b), `model:${CARD3}`).licenses).toEqual([{ license: { name: "unknown" } }]);
    expect(b.body.compositions.some((c) => c.aggregate === "incomplete" && c.assemblies.includes(`model:${CARD3}`))).toBe(true);
  });
  it("round 12 4237584874: scan verdicts use the persisted enum only; any other value is refused", () => {
    for (const v of AI_BOM_SCAN_VERDICTS) {
      const f = fixture();
      f.artifactScans[0]!.verdict = v;
      expect(() => normaliseAiBomRecords(f)).not.toThrow();
    }
    const f = fixture();
    f.artifactScans[0]!.verdict = "safe";
    refused(() => normaliseAiBomRecords(f), /verdict/);
  });
  it("4237376660: a scan whose engine run is gone has an explicit unknown assessor and an incomplete gap; nothing is invented", () => {
    const b = buildAiBom(fixture(), meta(), opts);
    const doc = cdx(b);
    expect((doc.declarations.attestations as any[]).find((a) => a.summary === `scan ${SCAN2}`).assessor).toBe("assessor:unknown");
    expect(b.gaps).toContainEqual({ ref: `claim:${SCAN2}`, field: "assessor", reason: "engine_run_not_recorded" });
    // the scan with a run names the exact engine, version and image digest (R12)
    expect(comp(doc, `engine:modelscan/0.8.5/${H("c")}`).hashes).toEqual([{ alg: "SHA-256", content: H("c") }]);
  });
  it("R29: an artifact edge only through evidence → scan → card; an artifact with no path has no edge and is incomplete", () => {
    const b = buildAiBom(fixture(), meta(), opts);
    expect(deps(cdx(b), `model:${CARD2}`)).toContain(`artifact:${ART}`);
    expect(b.gaps).toContainEqual({ ref: `artifact:${ART2}`, field: "dependency", reason: "no_model_card_evidence_path" });
  });
  it("4237488600: training artifacts are components; inline is hashed over its payload digest, remote is incomplete and has no location", () => {
    const b = buildAiBom(fixture(), meta(), opts);
    const doc = cdx(b);
    expect(comp(doc, `training-artifact:${TA1}`).hashes).toEqual([{ alg: "SHA-256", content: H("f") }]);
    expect(comp(doc, `training-artifact:${TA2}`).hashes).toBeUndefined();
    expect(b.gaps).toContainEqual({ ref: `training-artifact:${TA2}`, field: "hash", reason: "remote_artifact_digest_not_recorded" });
    expect(deps(doc, `training-artifact:${TA1}`)).toContain(`dataset:training:${TDS}:1`);
  });
  it("round 8 4237322637: active and canary system-prompt config versions are components with id, version and digest only", () => {
    const doc = cdx(buildAiBom(fixture(), meta(), opts));
    const c = comp(doc, `config:agent_system_prompt:${CV2}`);
    expect(c).toMatchObject({ version: "5", hashes: [{ alg: "SHA-256", content: H("3") }] });
    expect(deps(doc, `agent:${AG}`)).toEqual(expect.arrayContaining([`config:agent_system_prompt:${CV1}`, `config:agent_system_prompt:${CV2}`]));
  });
  it("round 12 4237584873: skills are keyed by the (agent, skill) attachment, pinned, and depended on by the builder agent", () => {
    const BA2 = u(40);
    const bas = [BA, BA2].map((id) => ({ id, name: `b-${id.slice(-2)}`, modelAgentId: AG, ownerUserId: null, ownerDisplayName: null, workloadIdentity: null }));
    const skills = [
      { agentId: BA, skillId: SKILL, snapshotName: "summarise", snapshotDigest: H("5"), snapshotVersion: 2, snapshotAdmissionState: "admitted" },
      { agentId: BA2, skillId: SKILL, snapshotName: "summarise", snapshotDigest: H("6"), snapshotVersion: 3, snapshotAdmissionState: "clean" },
    ];
    const f = fixture({ subject: { kind: "install", id: AI_BOM_INSTALL_SUBJECT_ID }, builderAgents: bas, builderSkills: skills });
    const doc = cdx(buildAiBom(f, meta({ subjectKind: "install", subjectId: AI_BOM_INSTALL_SUBJECT_ID }), opts));
    expect(comp(doc, `skill:${BA}:${SKILL}`).hashes[0].content).toBe(H("5"));
    expect(comp(doc, `skill:${BA2}:${SKILL}`).hashes[0].content).toBe(H("6"));
    expect(deps(doc, `builder-agent:${BA}`)).toContain(`skill:${BA}:${SKILL}`);
    expect(deps(doc, "install")).not.toContain(`skill:${BA}:${SKILL}`);
  });
});

describe("datasets (R11, R24, R26, #280 round 13)", () => {
  it("a training checksum gives a SHA-256 hash and a row count; flagged PII is sensitive data; classification from the project", () => {
    const doc = cdx(buildAiBom(fixture(), meta(), opts));
    const d = comp(doc, `dataset:training:${TDS}:1`);
    expect(d.hashes).toEqual([{ alg: "SHA-256", content: H("d") }]);
    expect(d.data[0]).toMatchObject({ classification: "regulated", sensitiveData: ["pii"] });
    expect(d.properties).toContainEqual({ name: "regulait:dataset:rowCount", value: "120" });
  });
  it("round 13: an unsafe, over-long or disagreeing row count is refused (B1's parseTrainingDatasetChecksum)", () => {
    for (const [checksum, rows] of [[`sha256:${H("d")}:9007199254740993`, 0], [`sha256:${H("d")}:${"1".repeat(17)}`, 0], [`sha256:${H("d")}:121`, 120], [`sha256:${H("d")}`, 120]] as const) {
      const f = fixture();
      f.trainingDatasets[0] = { ...f.trainingDatasets[0]!, checksum, rowCount: rows };
      refused(() => normaliseAiBomRecords(f), /checksum/);
    }
  });
  it("a legacy fnv1a32 checksum is never relabelled SHA-256; an empty one gives no hash; both are incomplete", () => {
    for (const [checksum, reason] of [["fnv1a32:0badf00d", "legacy_checksum"], ["", "empty_checksum"]] as const) {
      const f = fixture();
      f.trainingDatasets[0]!.checksum = checksum;
      const b = buildAiBom(f, meta(), opts);
      const d = comp(cdx(b), `dataset:training:${TDS}:1`);
      expect(d.hashes).toBeUndefined();
      expect(b.gaps).toContainEqual({ ref: `dataset:training:${TDS}:1`, field: "hash", reason });
    }
  });
  it("R11: a clean verdict has no sensitiveData entry at all; an unknown verdict is refused", () => {
    const f = fixture();
    f.trainingDatasets[0]!.piiVerdict = "clean";
    expect(comp(cdx(buildAiBom(f, meta(), opts)), `dataset:training:${TDS}:1`).data[0].sensitiveData).toBeUndefined();
    f.trainingDatasets[0]!.piiVerdict = "maybe";
    refused(() => normaliseAiBomRecords(f), /piiVerdict/);
  });
  it("R24: an evaluation dataset has its cases digest, no classification or owner, and is incomplete", () => {
    const b = buildAiBom(fixture(), meta(), opts);
    const d = comp(cdx(b), `dataset:eval:${EDS}:2`);
    expect(d.hashes).toEqual([{ alg: "SHA-256", content: H("e") }]);
    expect(d.data[0].classification).toBeUndefined();
    expect(d.properties).toContainEqual({ name: "regulait:dataset:digestOf", value: "eval_cases" });
    expect(b.gaps.some((g) => g.ref === `dataset:eval:${EDS}:2`)).toBe(true);
  });
});

describe("data flows (R27, R49)", () => {
  it("an agent snapshot carries one flow pair per referencing use case; an unreferenced agent says unknown and is incomplete", () => {
    const UC2 = u(41);
    const f = fixture({ subject: { kind: "agent", id: AG } });
    f.useCases.push({ ...f.useCases[0]!, id: UC2, dataSensitivity: "public" });
    const b = buildAiBom(f, meta({ subjectKind: "agent", subjectId: AG }), opts);
    const flows = svc(cdx(b), `service:provider:${AG}`).data as any[];
    expect(flows.map((x) => x.classification).sort()).toEqual(["confidential", "confidential", "public", "public"]);
    const other = svc(cdx(b), `service:provider:${AG2}`);
    expect(other.data).toEqual([{ flow: "outbound", classification: "unknown" }, { flow: "inbound", classification: "unknown" }]);
    expect(b.gaps).toContainEqual({ ref: `service:provider:${AG2}`, field: "dataFlow", reason: "no_use_case_references_agent" });
  });
  it("R30: authenticated only from a credential record; built-in providers omit it", () => {
    const doc = cdx(buildAiBom(fixture(), meta(), opts));
    expect(svc(doc, `service:provider:${AG}`).authenticated).toBeUndefined();
    expect(svc(doc, `service:provider:${AG2}`).authenticated).toBe(true);
  });
});

describe("compositions (§7 invariant: never complete with an unrecorded member)", () => {
  it("a real build has no complete aggregate and every gap is in an incomplete or unknown composition", () => {
    const b = buildAiBom(fixture(), meta(), opts);
    const doc = cdx(b);
    expect(compositionProblems(doc, b.gaps)).toEqual([]);
    expect((doc.compositions as any[]).every((c) => c.aggregate !== "complete")).toBe(true);
  });
  it("negative controls: a forged complete composition and a gap left out of every composition are both reported", () => {
    const b = buildAiBom(fixture(), meta(), opts);
    const forged = cdx(b);
    forged.compositions[1].aggregate = "complete";
    expect(compositionProblems(forged, b.gaps).join()).toMatch(/complete with unrecorded member/);
    const dropped = cdx(b);
    dropped.compositions = dropped.compositions.slice(0, 1);
    expect(compositionProblems(dropped, b.gaps).join()).toMatch(/in no incomplete composition/);
  });
  it("an agent with no model card is an unknown model, never inferred", () => {
    const f = fixture();
    f.modelCards = f.modelCards.filter((c) => c.agentId !== AG);
    f.modelCardEvidence = [];
    f.trainingArtifacts = f.trainingArtifacts.map((t) => ({ ...t, modelCardId: null }));
    const b = buildAiBom(f, meta(), opts);
    expect(b.body.compositions).toContainEqual({ aggregate: "unknown", assemblies: [`model:agent:${AG}`] });
  });
});

describe("render pipeline guards", () => {
  it("unsafe integers and bigints are refused before canonicalisation", () => {
    const f = fixture();
    f.modelArtifacts[0]!.sizeBytes = 2 ** 53;
    refused(() => normaliseAiBomRecords(f), /safe integer/);
  });
  it("a record loaded twice is refused (no silent dedupe)", () => {
    const f = fixture();
    f.modelArtifacts.push({ ...f.modelArtifacts[0]! });
    refused(() => normaliseAiBomRecords(f), /loaded twice/);
  });
  it("a dangling dependency (a card's dataset not loaded) fails the build instead of being dropped", () => {
    const f = fixture();
    f.trainingDatasets = [];
    refused(() => renderAiBomCycloneDx(normaliseAiBomRecords(f), meta(), "1.7"), /undeclared ref/);
  });
  it("the display-name relaxation (R45, AI BOMs only) renders the captured name; the default renders ids only", () => {
    const f = fixture();
    expect(all(buildAiBom(f, meta(), opts))).not.toContain("Jane Owner");
    f.useCases[0]!.ownerDisplayName = "Jane Owner";
    expect(cdx(buildAiBom(f, meta(), opts)).metadata.component.properties).toContainEqual({ name: "regulait:owner:displayName", value: "Jane Owner" });
  });
});

describe("drift (R8): a change list of refs, versions and hashes only", () => {
  it("reports added, removed, changed hash and changed version", () => {
    const base = aiBomInventoryIndex(cdx(buildAiBom(fixture(), meta(), opts)));
    const f = fixture();
    f.modelArtifacts[0]!.sha256 = H("9");
    f.modelCards[0]!.pinnedModelVersion = "2026-07-01";
    f.connectors = [];
    f.grants = f.grants.filter((g) => g.targetKind !== "connector");
    f.promptTags.push({ promptId: u(50), promptName: "new", tag: "production", commitId: u(51), hash: H("7"), agentId: AG });
    const live = aiBomInventoryIndex(cdx(buildAiBom(f, meta(), opts)));
    const changes = diffAiBomInventory(base, live).map((c) => `${c.change} ${c.ref}`);
    expect(changes).toEqual(expect.arrayContaining([`changed_hash artifact:${ART}`, `changed_version model:${CARD1}`, `removed service:connector:${CONN}`, `added prompt:${u(50)}:tag:production`]));
    expect(diffAiBomInventory(base, base)).toEqual([]);
  });
});

describe("security review round (PR #287): free-form references and claims never leave raw", () => {
  const leaks = (f: AiBomRecordSet, canary: string) => {
    const b = buildAiBom(f, meta(), opts);
    return [b.bodyBytes, ...b.renderings.map((r) => r.bytes)].some((x) => x.includes(canary));
  };
  const withRef = (ref: string) => {
    const f = fixture();
    f.modelCardEvidence[1] = { ...f.modelCardEvidence[1]!, externalRef: ref };
    f.modelCards[0]!.biasFairness = [{ ...f.modelCards[0]!.biasFairness[0]!, resultRef: ref }];
    return f;
  };
  it("HIGH: a reference is an identifier of known shape, a sanitised URL origin, or a SHA-256 — never raw", () => {
    const outcomes: string[] = [];
    for (const [ref, canary] of [
      ["api_key=sk-live-CANARY123", "CANARY123"],
      ["https:/files.internal.corp/bot99:SECRETTOK/api", "SECRETTOK"],
      ["id:SECRETTOK=abc", "SECRETTOK"],
      ["token=SECRETTOK", "SECRETTOK"],
    ] as const) {
      let leaked: boolean | "refused";
      try { leaked = leaks(withRef(ref), canary); } catch { leaked = "refused"; }
      outcomes.push(`${ref} -> ${leaked === true ? "LEAKED" : leaked}`);
    }
    expect(outcomes.filter((o) => o.endsWith("LEAKED"))).toEqual([]);
    expect(safeReference("AUDIT-12", "t")).toBe("id:AUDIT-12");
    expect(safeReference("id:AUDIT-12", "t")).toBe("id:AUDIT-12");
    expect(safeReference("id:SECRETTOK=abc", "t")).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(safeReference("https:/files.internal.corp/bot99:SECRETTOK/api", "t")).toBe("url:https://files.internal.corp");
  });
  it("MEDIUM: URL-shaped claims, standard refs and bias methods keep the origin only; secret-shaped free text is refused", () => {
    const urlCases: Array<[(f: AiBomRecordSet) => void, string]> = [
      [(f) => { f.modelCards[0]!.dataClaims = { downloadLocation: "https://bucket.s3.test/w.bin?X-Amz-Signature=CANARYSIG" }; }, "CANARYSIG"],
      [(f) => { f.modelCards[0]!.standardRefs = ["https://std.test/doc?token=CANARYSTD"]; }, "CANARYSTD"],
      [(f) => { f.modelCards[0]!.biasFairness = [{ dimension: "age", method: "https://eval.test/run?key=CANARYBIAS", status: "assessed", resultRef: null, assessedAt: null }]; }, "CANARYBIAS"],
      [(f) => { f.modelCards[0]!.dataClaims = { trainingData: "corpus key sk-live-CANARYTRAIN0123456789abcdef" }; }, "CANARYTRAIN"],
    ];
    const outcomes: string[] = [];
    for (const [mutate, canary] of urlCases) {
      const f = fixture();
      mutate(f);
      let leaked: boolean | "refused";
      try { leaked = leaks(f, canary); } catch { leaked = "refused"; }
      outcomes.push(`${canary} -> ${leaked === true ? "LEAKED" : leaked}`);
    }
    expect(outcomes.filter((o) => o.endsWith("LEAKED"))).toEqual([]);
  });
  it("assessedAt and releaseTime must be timestamps", () => {
    const f = fixture();
    f.modelCards[0]!.biasFairness = [{ ...f.modelCards[0]!.biasFairness[0]!, assessedAt: "token=SECRET" }];
    refused(() => normaliseAiBomRecords(f), /assessedAt/);
    const g = fixture();
    g.modelCards[0]!.dataClaims = { releaseTime: "next tuesday" };
    refused(() => normaliseAiBomRecords(g), /releaseTime/);
  });
  it("LOW: a refusal names the field and rule, never the record value", () => {
    const f = fixture();
    f.artifactScans[0]!.verdict = "SECRETVERDICT";
    let msg = "";
    try { normaliseAiBomRecords(f); } catch (e) { msg = (e as Error).message; }
    expect(msg).toMatch(/verdict/);
    expect(msg).not.toContain("SECRETVERDICT");
  });
  it("LOW: a record list over the cap is refused", () => {
    const f = fixture();
    f.mcpTools = Array.from({ length: AI_BOM_MAX_RECORDS_PER_LIST + 1 }, (_, i) => ({ id: u(100000 + i), serverId: MCP, name: `t${i}`, kind: "read" }));
    refused(() => normaliseAiBomRecords(f), /cap/);
  });
});
