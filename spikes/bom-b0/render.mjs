// B0 item 4: a throwaway, PURE AI BOM renderer: a loaded record set in, exact bytes out.
// No clock reads, no randomness, no locale: every list is sorted by a stable key, times come from rows, the serial
// number is derived from the snapshot id, money/size are integers, and bytes are RFC 8785 (`canonicalize`).
// Spike code only; B3/B5 write the product renderers.
import { createHash, createPrivateKey, sign } from 'node:crypto';
import canonicalize from 'canonicalize';

export const NATIVE_V = 'regulait.ai-bom.v1';
const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0); // code-unit order, never localeCompare (locale-dependent)
const sortBy = (list, key) => [...(list ?? [])].sort((a, b) => cmp(key(a), key(b)));
const sortStrings = (list) => [...(list ?? [])].sort(cmp);
const stripAlg = (d) => d.replace(/^sha256:/, '');
const prop = (name, value) => ({ name, value: String(value) });
const props = (list) => sortBy(list, (p) => `${p.name}\u0000${p.value}`);

/** RFC 9562 version-8 UUID from SHA-256 of a name (the CycloneDX serialNumber, fixed by the snapshot id). */
export function uuidV8FromName(name) {
  const h = createHash('sha256').update(name, 'utf8').digest();
  h[6] = (h[6] & 0x0f) | 0x80;
  h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

/** Normalise a loaded record set: row order and key order are NOT inputs. */
export function normalise(r) {
  const tools = (s) => sortBy(s.tools, (t) => t.name).map((t) => ({ ...t, grantedTo: sortStrings(t.grantedTo) }));
  return {
    snapshot: r.snapshot,
    install: { ...r.install, sbomRefs: sortBy(r.install.sbomRefs, (x) => x.serial) },
    useCase: { ...r.useCase, complianceTags: sortStrings(r.useCase.complianceTags) },
    agents: sortBy(r.agents, (a) => a.id),
    modelCards: sortBy(r.modelCards, (m) => m.id).map((m) => ({
      ...m,
      datasetIds: sortStrings(m.datasetIds),
      standardRefs: sortStrings(m.standardRefs),
      intendedUse: sortStrings(m.intendedUse),
      limitations: sortStrings(m.limitations),
      biasFairness: sortBy(m.biasFairness, (b) => b.name),
      evaluations: sortBy(m.evaluations, (e) => `${e.type}\u0000${e.slice}`),
      dataClaims: m.dataClaims && { ...m.dataClaims, sources: sortStrings(m.dataClaims.sources) },
    })),
    modelArtifacts: sortBy(r.modelArtifacts, (a) => a.id),
    artifactScans: sortBy(r.artifactScans, (s) => s.id),
    datasets: sortBy(r.datasets, (d) => d.id),
    promptCommits: sortBy(r.promptCommits, (p) => p.id),
    endpoints: sortBy(r.endpoints, (e) => e.id),
    mcpServers: sortBy(r.mcpServers, (s) => s.id).map((s) => ({ ...s, tools: tools(s) })),
    connectors: sortBy(r.connectors, (c) => c.id).map((c) => ({ ...c, grantedTo: sortStrings(c.grantedTo) })),
    memoryStores: sortBy(r.memoryStores, (m) => m.id),
    skills: sortBy(r.skills, (s) => s.id),
  };
}

// ---------------------------------------------------------------- CycloneDX 1.7 / 1.6
const ref = {
  subject: (id) => `subject:${id}`,
  agent: (id) => `agent:${id}`,
  card: (id) => `modelcard:${id}`,
  artifact: (id) => `artifact:${id}`,
  engine: (id) => `engine:${id}`,
  dataset: (id) => `dataset:${id}`,
  prompt: (id) => `prompt:${id}`,
  endpoint: (id) => `service:endpoint:${id}`,
  mcp: (id) => `service:mcp:${id}`,
  tool: (sid, name) => `service:mcp:${sid}:tool:${name}`,
  connector: (id) => `service:connector:${id}`,
  memory: (id) => `memory:${id}`,
  skill: (id) => `skill:${id}`,
};
const userRef = (id) => `user:${id}`;
const sensitive = (v) => (v === 'contains_pii' ? ['pii'] : []);

export function renderCycloneDx(n, specVersion) {
  const s = n.snapshot;
  const cards = new Map(n.modelCards.map((m) => [m.id, m]));
  const components = [];
  const services = [];
  const deps = new Map();
  const dep = (from, to) => {
    if (!deps.has(from)) deps.set(from, new Set());
    if (to) deps.get(from).add(to);
  };
  const subject = ref.subject(n.useCase.id);
  dep(subject);

  for (const a of n.agents) {
    const card = a.modelCardId ? cards.get(a.modelCardId) : null;
    const c = {
      type: 'machine-learning-model',
      'bom-ref': ref.agent(a.id),
      name: a.name,
      supplier: { name: a.provider },
      ...(a.pinnedModelVersion ? { version: a.pinnedModelVersion } : {}),
      properties: props([
        prop('regulait:agent:id', a.id),
        prop('regulait:model:requested', a.requestedModel),
        prop('regulait:identity:uri', a.workloadIdentity),
        prop('regulait:trainingData:provenance', card?.dataClaims?.declared ? 'supplier-declared' : 'unknown'),
        ...(a.pinnedModelVersion ? [] : [prop('regulait:model:version', 'not_recorded')]),
        ...(a.observed ? [prop('regulait:observed:lastSeen', a.observed.lastSeen), prop('regulait:observed:count', a.observed.count)] : []),
      ]),
    };
    if (card) {
      c.modelCard = {
        'bom-ref': ref.card(card.id),
        modelParameters: {
          task: card.task,
          modelArchitecture: card.architecture,
          datasets: card.datasetIds.map((d) => ({ ref: ref.dataset(d) })),
        },
        quantitativeAnalysis: {
          performanceMetrics: card.evaluations.map((e) => ({ type: e.type, value: e.value, slice: e.slice })),
        },
        considerations: {
          useCases: card.intendedUse,
          technicalLimitations: card.limitations,
          ethicalConsiderations: card.biasFairness.map((b) => ({ name: b.name, mitigationStrategy: b.mitigation })),
        },
        properties: props([
          prop('regulait:modelCard:id', card.id),
          prop('regulait:modelCard:approval', card.approvedId),
          ...card.dataClaims.sources.map((src) => prop('regulait:trainingData:source', src)),
        ]),
      };
      c.externalReferences = sortBy(card.standardRefs.map((u) => ({ type: 'documentation', url: u, comment: 'standard reference' })), (x) => x.url);
    }
    components.push(c);
    dep(subject, c['bom-ref']);
    dep(c['bom-ref']);
  }
  for (const art of n.modelArtifacts) {
    components.push({
      type: 'file',
      'bom-ref': ref.artifact(art.id),
      name: `model-artifact-${art.id}`,
      hashes: [{ alg: 'SHA-256', content: art.sha256 }],
      properties: props([prop('regulait:artifact:format', art.format), prop('regulait:artifact:sizeBytes', art.sizeBytes)]),
    });
    dep(ref.agent(art.agentId), ref.artifact(art.id));
    dep(ref.artifact(art.id));
  }
  const engines = sortBy([...new Map(n.artifactScans.map((x) => [x.engine, x])).values()], (x) => x.engine);
  for (const e of engines) {
    components.push({
      type: 'container',
      'bom-ref': ref.engine(e.engine),
      name: e.engine,
      version: e.engineVersion,
      hashes: [{ alg: 'SHA-256', content: stripAlg(e.imageDigest) }],
    });
    dep(ref.engine(e.engine));
  }
  for (const d of n.datasets) {
    components.push({
      type: 'data',
      'bom-ref': ref.dataset(d.id),
      name: d.name,
      version: d.version,
      hashes: [{ alg: 'SHA-256', content: d.checksum }],
      data: [{
        type: 'dataset',
        name: d.name,
        classification: d.classification,
        sensitiveData: sensitive(d.piiVerdict),
        governance: { owners: [{ contact: { 'bom-ref': `${userRef(d.ownerUserId)}:${d.id}`, name: userRef(d.ownerUserId) } }] },
      }],
      properties: props([prop('regulait:dataset:kind', d.kind), prop('regulait:dataset:piiVerdict', d.piiVerdict)]),
    });
    dep(ref.dataset(d.id));
  }
  for (const p of n.promptCommits) {
    components.push({
      type: 'data', 'bom-ref': ref.prompt(p.id), name: p.name,
      hashes: [{ alg: 'SHA-256', content: p.hash }],
      data: [{ type: 'configuration', name: p.name }],
      properties: props([prop('regulait:prompt:tag', p.tag)]),
    });
    dep(ref.agent(p.agentId), ref.prompt(p.id));
    dep(ref.prompt(p.id));
  }
  for (const k of n.skills) {
    components.push({
      type: 'data', 'bom-ref': ref.skill(k.id), name: k.name,
      hashes: [{ alg: 'SHA-256', content: stripAlg(k.admittedDigest) }],
      data: [{ type: 'configuration', name: k.name }],
    });
    dep(subject, ref.skill(k.id));
    dep(ref.skill(k.id));
  }
  for (const m of n.memoryStores) {
    components.push({
      type: 'data', 'bom-ref': ref.memory(m.id), name: `memory-store-${m.id}`,
      data: [{ type: 'other', name: `memory-store-${m.id}`, classification: m.classification, description: 'store descriptor only; contents never included' }],
      properties: props([prop('regulait:memory:kind', m.kind)]),
    });
    dep(ref.agent(m.agentId), ref.memory(m.id));
    dep(ref.memory(m.id));
  }
  for (const e of n.endpoints) {
    services.push({
      'bom-ref': ref.endpoint(e.id), provider: { name: e.provider }, name: `${e.provider}-endpoint`,
      endpoints: [e.url], authenticated: true, trustZone: e.trustZone,
      data: [{ flow: 'outbound', classification: e.sends }, { flow: 'inbound', classification: e.receives }],
    });
    dep(ref.agent(e.agentId), ref.endpoint(e.id));
    dep(ref.endpoint(e.id));
  }
  for (const m of n.mcpServers) {
    services.push({
      'bom-ref': ref.mcp(m.id), name: m.name, endpoints: [m.url], authenticated: true,
      services: m.tools.map((t) => ({
        'bom-ref': ref.tool(m.id, t.name), name: t.name,
        ...(t.observed ? { properties: props([prop('regulait:observed:lastSeen', t.observed.lastSeen), prop('regulait:observed:count', t.observed.count)]) } : {}),
      })),
      properties: props([
        prop('regulait:mcp:transport', m.transport), prop('regulait:mcp:releaseDigest', m.releaseDigest),
        prop('regulait:admission:state', m.admission), prop('regulait:identity:propagation', m.identityPropagation),
        prop('regulait:owner', userRef(m.ownerUserId)),
      ]),
    });
    dep(ref.mcp(m.id));
    for (const t of m.tools) {
      dep(ref.tool(m.id, t.name));
      for (const g of t.grantedTo) dep(ref.agent(g), ref.tool(m.id, t.name));
    }
  }
  for (const c of n.connectors) {
    services.push({
      'bom-ref': ref.connector(c.id), name: c.name, endpoints: [c.url], authenticated: true,
      properties: props([prop('regulait:connector:kind', c.kind), prop('regulait:connector:admissionManifestDigest', c.admissionManifestDigest), prop('regulait:owner', userRef(c.ownerUserId))]),
    });
    dep(ref.connector(c.id));
    for (const g of c.grantedTo) dep(ref.agent(g), ref.connector(c.id));
  }

  const unknownAgents = n.agents.filter((a) => !a.modelCardId).map((a) => ref.agent(a.id));
  const doc = {
    bomFormat: 'CycloneDX',
    specVersion,
    serialNumber: `urn:uuid:${uuidV8FromName(`regulait:ai-bom:${s.id}`)}`,
    version: s.version,
    metadata: {
      timestamp: s.createdAt,
      tools: { components: [{ type: 'application', name: 'regulait-bom-b0-spike', version: '0.0.0' }] },
      component: {
        type: 'application', 'bom-ref': subject, name: n.useCase.name,
        properties: props([
          prop('regulait:subject:kind', s.subjectKind), prop('regulait:owner', userRef(n.useCase.ownerUserId)),
          prop('regulait:dataSensitivity', n.useCase.dataSensitivity), prop('regulait:euAiAct:tier', n.useCase.euAiActTier),
          ...n.useCase.complianceTags.map((t) => prop('regulait:compliance:tag', t)),
        ]),
      },
      properties: props([prop('regulait:snapshot:id', s.id), prop('regulait:snapshot:trigger', s.trigger), prop('regulait:snapshot:supersedes', s.supersedesId)]),
    },
    components: sortBy(components, (c) => c['bom-ref']),
    services: sortBy(services, (c) => c['bom-ref']),
    externalReferences: n.install.sbomRefs.map((x) => ({
      type: 'bom', url: `urn:cdx:${x.serial.replace(/^urn:uuid:/, '')}/${x.version}`,
      hashes: [{ alg: 'SHA-256', content: x.sha256 }], comment: `${x.kind} SBOM of release ${n.install.release}`,
    })),
    dependencies: sortBy([...deps].map(([r, set]) => ({ ref: r, ...(set.size ? { dependsOn: sortStrings([...set]) } : {}) })), (d) => d.ref),
    compositions: [
      // third-party model internals are supplier-declared at best: never `complete`
      { 'bom-ref': 'composition:subject', aggregate: 'incomplete', assemblies: [subject] },
      ...(unknownAgents.length ? [{ 'bom-ref': 'composition:no-model-card', aggregate: 'unknown', assemblies: unknownAgents }] : []),
    ],
    declarations: {
      assessors: engines.map((e) => ({ 'bom-ref': `assessor:${e.engine}`, thirdParty: false })),
      claims: n.artifactScans.map((x) => ({
        'bom-ref': `claim:${x.id}`, target: ref.artifact(x.artifactId),
        predicate: `${x.evidenceKind} by ${x.engine} ${x.engineVersion}: ${x.verdict}`, evidence: [`evidence:${x.id}`],
      })),
      evidence: n.artifactScans.map((x) => ({
        'bom-ref': `evidence:${x.id}`, propertyName: 'regulait:scan:verdict', description: `sha256:${x.evidenceSha256}`,
        created: x.at, data: [{ name: `scan-${x.id}`, classification: 'internal' }],
      })),
      attestations: n.artifactScans.map((x) => ({
        summary: `scan ${x.id}`, assessor: `assessor:${x.engine}`, map: [{ claims: [`claim:${x.id}`] }],
      })),
    },
  };
  return doc;
}

// ---------------------------------------------------------------- SPDX 3.0.1
const toSecond = (iso) => iso.replace(/\.\d+Z$/, 'Z'); // SPDX DateTime has no fractional seconds
const confidentiality = { public: 'clear', internal: 'green', confidential: 'amber', restricted: 'red' };

export function renderSpdx(n) {
  const s = n.snapshot;
  const base = `https://regulait.invalid/spdx/${n.install.id}/ai-bom/${s.id}/${s.version}`;
  const id = (k) => `${base}#${k}`;
  const ci = '_:creationinfo';
  const g = [];
  const el = (o) => { g.push({ ...o, creationInfo: ci }); return o.spdxId; };
  const org = el({ type: 'Organization', spdxId: id('org-install'), name: `RegulAIt install ${n.install.id}` });
  const tool = el({ type: 'Tool', spdxId: id('tool'), name: 'regulait-bom-b0-spike' });
  const suppliers = new Map();
  for (const a of n.agents) if (!suppliers.has(a.provider)) suppliers.set(a.provider, el({ type: 'Organization', spdxId: id(`supplier-${a.provider}`), name: a.provider }));
  const subject = el({ type: 'software_Package', spdxId: id('subject'), name: n.useCase.name, software_primaryPurpose: 'application', suppliedBy: org });
  const rels = [];
  const rel = (from, type, to, extra = {}) => rels.push({ type: 'Relationship', spdxId: id(`rel-${rels.length}`), from, relationshipType: type, to, ...extra });
  const cards = new Map(n.modelCards.map((m) => [m.id, m]));
  const dsId = new Map();
  for (const d of n.datasets) {
    dsId.set(d.id, el({
      type: 'dataset_DatasetPackage', spdxId: id(`dataset-${d.id}`), name: d.name, software_packageVersion: d.version,
      software_primaryPurpose: 'data', dataset_datasetType: ['noAssertion'],
      dataset_confidentialityLevel: confidentiality[d.classification],
      dataset_hasSensitivePersonalInformation: d.piiVerdict === 'contains_pii' ? 'yes' : 'noAssertion',
      verifiedUsing: [{ type: 'Hash', algorithm: 'sha256', hashValue: d.checksum }],
      suppliedBy: org,
    }));
  }
  for (const a of n.agents) {
    const card = a.modelCardId ? cards.get(a.modelCardId) : null;
    const art = n.modelArtifacts.find((x) => x.agentId === a.id);
    const pkgId = el({
      type: 'ai_AIPackage', spdxId: id(`agent-${a.id}`), name: a.name,
      ...(a.pinnedModelVersion ? { software_packageVersion: a.pinnedModelVersion } : {}),
      software_primaryPurpose: 'model', suppliedBy: suppliers.get(a.provider),
      ai_autonomyType: 'noAssertion',
      ai_informationAboutTraining: card?.dataClaims?.declared ? `supplier-declared: ${card.dataClaims.sources.join('; ')}` : 'unknown',
      ...(card ? { ai_limitation: card.limitations.join('; '), ai_typeOfModel: [card.architecture], ai_domain: card.intendedUse } : {}),
      ...(art ? { verifiedUsing: [{ type: 'Hash', algorithm: 'sha256', hashValue: art.sha256 }] } : {}),
    });
    rel(subject, 'dependsOn', [pkgId]);
    // licences are mandatory relationships in the AI profile; unknown is stated, never omitted (ADR-0189 §3)
    rel(pkgId, 'hasDeclaredLicense', ['expandedlicensing_NoAssertionLicense']);
    rel(pkgId, 'hasConcludedLicense', ['expandedlicensing_NoAssertionLicense']);
    if (card) {
      const train = card.datasetIds.filter((d) => n.datasets.find((x) => x.id === d)?.kind === 'training').map((d) => dsId.get(d));
      const test = card.datasetIds.filter((d) => n.datasets.find((x) => x.id === d)?.kind === 'eval').map((d) => dsId.get(d));
      if (train.length) rel(pkgId, 'trainedOn', train);
      if (test.length) rel(pkgId, 'testedOn', test);
    } else {
      rel(pkgId, 'trainedOn', ['NoAssertionElement'], { completeness: 'noAssertion' });
    }
  }
  for (const d of dsId.values()) {
    rel(d, 'hasDeclaredLicense', ['expandedlicensing_NoAssertionLicense']);
    rel(d, 'hasConcludedLicense', ['expandedlicensing_NoAssertionLicense']);
  }
  rel(subject, 'hasDeclaredLicense', ['expandedlicensing_NoAssertionLicense']);
  rel(subject, 'hasConcludedLicense', ['expandedlicensing_NoAssertionLicense']);
  for (const r of rels) el(r);
  const elements = sortStrings(g.map((x) => x.spdxId));
  const docObj = {
    type: 'SpdxDocument', spdxId: id('document'), creationInfo: ci, name: `AI BOM ${s.subjectKind} ${s.subjectId} v${s.version}`,
    rootElement: [subject], element: elements, profileConformance: ['ai', 'core', 'dataset', 'software'],
  };
  const creation = { type: 'CreationInfo', '@id': ci, specVersion: '3.0.1', created: toSecond(s.createdAt), createdBy: [org], createdUsing: [tool] };
  return {
    '@context': 'https://spdx.org/rdf/3.0.1/spdx-context.jsonld',
    '@graph': [creation, docObj, ...sortBy(g, (x) => x.spdxId)],
  };
}

// ---------------------------------------------------------------- native body, signing
// SYNTHETIC test key from a fixed seed (Ed25519 is deterministic). Never a product key.
const SEED = createHash('sha256').update('regulait-b0-synthetic-signing-seed', 'utf8').digest();
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const testKey = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, SEED]), format: 'der', type: 'pkcs8' });

export function renderAll(records) {
  const n = normalise(records);
  const renderings = {
    'cyclonedx-1.7': canonicalize(renderCycloneDx(n, '1.7')),
    'cyclonedx-1.6': canonicalize(renderCycloneDx(n, '1.6')),
    'spdx-3.0.1': canonicalize(renderSpdx(n)),
  };
  const { snapshot: _s, useCase: _u, ...rest } = n;
  const native = {
    v: NATIVE_V,
    snapshot: n.snapshot,
    serialNumber: `urn:uuid:${uuidV8FromName(`regulait:ai-bom:${n.snapshot.id}`)}`,
    subject: n.useCase,
    records: rest,
    renderings: Object.fromEntries(Object.entries(renderings).map(([k, v]) => [k, { sha256: sha256(v), bytes: Buffer.byteLength(v, 'utf8') }])),
  };
  const nativeBytes = canonicalize(native);
  const signature = sign(null, Buffer.from(nativeBytes, 'utf8'), testKey).toString('base64');
  const bytes = { native: nativeBytes, ...renderings };
  return {
    bytes,
    sha256: Object.fromEntries(Object.entries(bytes).map(([k, v]) => [k, sha256(v)])),
    signature,
  };
}
