// B0 item 4: a throwaway, PURE AI BOM renderer: a loaded record set in, exact bytes out.
// No clock reads, no randomness, no locale: every list is sorted by a stable key, times come from rows, the serial
// number is derived from the snapshot id, money/size are integers, and bytes are RFC 8785 (`canonicalize`).
// Spike code only; B3/B5 write the product renderers.
import { createHash, createPrivateKey, sign } from 'node:crypto';
import canonicalize from 'canonicalize';
import { findEmails } from './validators.mjs';

export const NATIVE_V = 'regulait.ai-bom.v1';
const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0); // code-unit order, never localeCompare (locale-dependent)
const sortBy = (list, key) => [...(list ?? [])].sort((a, b) => cmp(key(a), key(b)));
const sortStrings = (list) => [...(list ?? [])].sort(cmp);
const stripAlg = (d) => d.replace(/^sha256:/, '');
// An absent value is OMITTED, never written as the strings "null" or "undefined" (PR #265 review).
const prop = (name, value) => (value === null || value === undefined ? null : { name, value: String(value) });
const props = (list) => sortBy(list.filter(Boolean), (p) => `${p.name}\u0000${p.value}`);

/** RFC 9562 version-8 UUID from SHA-256 of a name (the CycloneDX serialNumber, fixed by the snapshot id). */
export function uuidV8FromName(name) {
  const h = createHash('sha256').update(name, 'utf8').digest();
  h[6] = (h[6] & 0x0f) | 0x80;
  h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

// ---------------------------------------------------------------- loader contract (PR #265 review)
// Every record type has an explicit ALLOWLIST. An unknown key is refused, never copied into the signed body, so a
// broad loader query (an agent's system prompt, a prompt commit's template, a skill's body) cannot reach a BOM.
const ALLOWED = {
  snapshot: ['id', 'subjectKind', 'subjectId', 'version', 'supersedesId', 'trigger', 'createdAt', 'basis'],
  basis: ['auditSeq', 'anchorId', 'receiptSeq'],
  install: ['id', 'release', 'sbomRefs'],
  sbomRef: ['kind', 'serial', 'version', 'sha256'],
  useCase: ['id', 'name', 'ownerUserId', 'dataSensitivity', 'complianceTags', 'euAiActTier'],
  agent: ['id', 'name', 'provider', 'requestedModel', 'pinnedModelVersion', 'workloadIdentity', 'modelCardId', 'observed'],
  observed: ['lastSeen', 'count'],
  modelArtifact: ['id', 'agentId', 'sha256', 'format', 'sizeBytes'],
  artifactScan: ['id', 'artifactId', 'engine', 'engineVersion', 'imageDigest', 'verdict', 'evidenceKind', 'evidenceSha256', 'at'],
  // model_card_evidence persists no digest; `sha256` is accepted only when B3 defines one (ADR-0189 R30)
  modelCardEvidence: ['id', 'modelCardId', 'kind', 'artifactScanId', 'sha256', 'at'],
  // ADR-0189 R24: training_datasets has checksum and pii_verdict, classification only via its project, no owner;
  // eval_datasets has none of these, only a digest the loader computes over the version's eval_cases.
  'dataset:training': ['id', 'kind', 'name', 'version', 'checksum', 'piiVerdict', 'projectDataSensitivity'],
  'dataset:eval': ['id', 'kind', 'name', 'version', 'casesDigest'],
  promptCommit: ['id', 'agentId', 'name', 'hash', 'tag'],
  // `authenticated` comes from the provider/connector credential record; absent means not asserted (R30)
  endpoint: ['id', 'agentId', 'provider', 'url', 'trustZone', 'sends', 'receives', 'authenticated'],
  mcpServer: ['id', 'name', 'transport', 'url', 'releaseDigest', 'admission', 'identityPropagation', 'ownerUserId', 'tools', 'authenticated'],
  mcpTool: ['name', 'grantedTo', 'observed'],
  connector: ['id', 'name', 'kind', 'url', 'admissionManifestDigest', 'ownerUserId', 'grantedTo', 'authenticated'],
  memoryStore: ['id', 'agentId', 'kind', 'classification'],
  // builder_agent_skills: the PINNED copy the agent runs (snapshot_digest, NOT NULL default ''), not the library
  // row's nullable override digest
  skill: ['id', 'skillId', 'name', 'snapshotDigest', 'snapshotAdmissionState'],
  evaluation: ['type', 'value', 'slice'],
};
function only(kind, o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error(`${kind}: expected an object`);
  const allowed = ALLOWED[kind];
  const extra = Object.keys(o).filter((k) => !allowed.includes(k));
  if (extra.length) throw new Error(`${kind}: unknown key(s) refused: ${extra.join(', ')}`);
  return Object.fromEntries(allowed.filter((k) => k in o).map((k) => [k, o[k]]));
}

/** Every number in a loaded record must be a safe integer: a larger value was already rounded when it was read, and a
 * float has no place in a signed body (ADR-0189 amendment 5). Refuse, never round. */
export function assertSafeIntegers(value, path = '$') {
  if (typeof value === 'bigint') throw new Error(`bigint at ${path} refused: load it as a checked safe integer`);
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new Error(`unsafe or non-integer number at ${path} refused: ${value}`);
  if (Array.isArray(value)) value.forEach((v, i) => assertSafeIntegers(v, `${path}[${i}]`));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) assertSafeIntegers(v, `${path}.${k}`);
}

// The model_cards row (packages/db schema.ts) as the loader reads it, plus three joined fields. Columns that are read
// but never rendered are dropped here by name; any other key is refused.
const CARD_COLUMNS = ['id', 'intendedUse', 'dataClaims', 'limitations', 'biasFairness', 'standardRefs'];
const CARD_DROPPED = ['agentId', 'customProviderId', 'note', 'pinnedModelVersion', 'createdByUserId', 'createdAt', 'updatedAt'];
const CARD_JOINED = ['approvedId', 'datasetIds', 'evaluations'];
// BiasFairnessEntry: assessedBy and note are free text about people and are not rendered
const BIAS_RENDERED = ['dimension', 'method', 'status', 'resultRef', 'assessedAt'];
const BIAS_DROPPED = ['assessedBy', 'note'];
const BIAS_STATUSES = ['not_assessed', 'in_progress', 'assessed', 'waived'];

// data_claims is an arbitrary jsonb record (z.record(z.unknown())), so it is PROJECTED to a typed safe shape before
// signing: allowlisted keys only, each a length-capped string, a safe integer or a boolean. A nested object or array
// (where raw content could hide) or any other key is refused, never copied (ADR-0189 B3 entry condition, round 9).
export const DATA_CLAIM_KEYS = ['trainingData', 'task', 'architecture', 'license', 'retention', 'releaseTime', 'downloadLocation'];
export const DATA_CLAIM_MAX_CHARS = 512;
function safeClaims(c) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) throw new Error('modelCard: dataClaims must be an object');
  const out = {};
  for (const [k, v] of Object.entries(c)) {
    if (!DATA_CLAIM_KEYS.includes(k)) throw new Error(`modelCard.dataClaims: unknown key refused: ${JSON.stringify(k)}`);
    if (typeof v === 'string') {
      if (v.length > DATA_CLAIM_MAX_CHARS) throw new Error(`modelCard.dataClaims.${k}: longer than ${DATA_CLAIM_MAX_CHARS} characters`);
    } else if (!(typeof v === 'boolean' || (typeof v === 'number' && Number.isSafeInteger(v)))) {
      throw new Error(`modelCard.dataClaims.${k}: only a string, safe integer or boolean is allowed`);
    }
    out[k] = v;
  }
  return out;
}

/** Map a persisted model card (intended_use text, limitations text|null, bias_fairness BiasFairnessEntry[], data_claims
 * an arbitrary supplier record) to the renderer's shape. Never splits a string, never invents a claim. */
export function modelCardFromRow(row) {
  const extra = Object.keys(row).filter((k) => ![...CARD_COLUMNS, ...CARD_DROPPED, ...CARD_JOINED].includes(k));
  if (extra.length) throw new Error(`modelCard: unknown key(s) refused: ${extra.join(', ')}`);
  if (typeof row.intendedUse !== 'string' || !row.intendedUse.trim()) throw new Error('modelCard: intendedUse must be non-empty text');
  if (row.limitations !== null && row.limitations !== undefined && typeof row.limitations !== 'string') throw new Error('modelCard: limitations must be text or null');
  const claims = safeClaims(row.dataClaims ?? {});
  const bias = (row.biasFairness ?? []).map((b) => {
    const unknown = Object.keys(b).filter((k) => ![...BIAS_RENDERED, ...BIAS_DROPPED].includes(k));
    if (unknown.length) throw new Error(`modelCard.biasFairness: unknown key(s) refused: ${unknown.join(', ')}`);
    if (!BIAS_STATUSES.includes(b.status)) throw new Error(`modelCard.biasFairness: unknown status ${JSON.stringify(b.status)}`);
    return Object.fromEntries(BIAS_RENDERED.filter((k) => b[k] !== undefined && b[k] !== null).map((k) => [k, b[k]]));
  });
  const str = (v) => (typeof v === 'string' && v.trim() ? v : null);
  return {
    id: row.id,
    approvedId: row.approvedId ?? null,
    intendedUse: row.intendedUse,
    limitations: str(row.limitations),
    // a TOTAL order: every rendered field is in the key, so equal dimension and method never tie on input order
    biasFairness: sortBy(bias, (b) => canonicalize(b)),
    // supplier-declared only (OWNER DECISION 10): an empty record is "unknown", never an inferred claim
    dataClaims: claims,
    declared: Object.keys(claims).length > 0,
    task: str(claims.task),
    architecture: str(claims.architecture),
    license: str(claims.license),
    standardRefs: sortStrings(row.standardRefs),
    datasetIds: sortStrings(row.datasetIds),
    evaluations: sortBy((row.evaluations ?? []).map((e) => only('evaluation', e)), (e) => canonicalize(e)), // total order on every rendered field
  };
}

/** Normalise a loaded record set: row order and key order are NOT inputs, and only allowlisted fields go through. */
export function normalise(r) {
  assertSafeIntegers(r);
  const observed = (o) => (o ? only('observed', o) : null);
  const dataset = (d) => {
    const kind = { training: 'dataset:training', eval: 'dataset:eval' }[d?.kind];
    if (!kind) throw new Error(`dataset: unknown kind ${JSON.stringify(d?.kind)}`);
    return only(kind, d);
  };
  const snapshot = only('snapshot', r.snapshot);
  if (snapshot.basis) snapshot.basis = only('basis', snapshot.basis);
  const install = only('install', r.install);
  return {
    snapshot,
    install: { ...install, sbomRefs: sortBy((install.sbomRefs ?? []).map((x) => only('sbomRef', x)), (x) => x.serial) },
    useCase: (({ complianceTags, ...u }) => ({ ...u, complianceTags: sortStrings(complianceTags) }))(only('useCase', r.useCase)),
    agents: sortBy((r.agents ?? []).map((a) => { const o = only('agent', a); return { ...o, observed: observed(o.observed) }; }), (a) => a.id),
    modelCards: sortBy((r.modelCards ?? []).map(modelCardFromRow), (m) => m.id),
    modelArtifacts: sortBy((r.modelArtifacts ?? []).map((x) => only('modelArtifact', x)), (a) => a.id),
    artifactScans: sortBy((r.artifactScans ?? []).map((x) => only('artifactScan', x)), (s) => s.id),
    modelCardEvidence: sortBy((r.modelCardEvidence ?? []).map((x) => only('modelCardEvidence', x)), (e) => e.id),
    datasets: sortBy((r.datasets ?? []).map(dataset), (d) => d.id),
    promptCommits: sortBy((r.promptCommits ?? []).map((x) => only('promptCommit', x)), (p) => p.id),
    // R47: endpoints are sanitised HERE, so neither the signed native body nor any rendering ever holds a query,
    // fragment or userinfo
    endpoints: sortBy((r.endpoints ?? []).map((x) => only('endpoint', x)).map((e) => ({ ...e, url: cleanUrl(e.url, `endpoint ${e.id}`) })), (e) => e.id),
    mcpServers: sortBy((r.mcpServers ?? []).map((x) => only('mcpServer', x)), (s) => s.id).map((s) => ({
      ...s,
      url: s.transport === 'stdio' ? null : cleanUrl(s.url, `mcp server ${s.id}`), // stdio: the sentinel is not an endpoint
      tools: sortBy((s.tools ?? []).map((t) => only('mcpTool', t)), (t) => t.name).map((t) => ({ ...t, grantedTo: sortStrings(t.grantedTo), observed: observed(t.observed) })),
    })),
    connectors: sortBy((r.connectors ?? []).map((x) => only('connector', x)), (c) => c.id).map((c) => ({ ...c, url: cleanUrl(c.url, `connector ${c.id}`), grantedTo: sortStrings(c.grantedTo) })),
    memoryStores: sortBy((r.memoryStores ?? []).map((x) => only('memoryStore', x)), (m) => m.id),
    skills: sortBy((r.skills ?? []).map((x) => only('skill', x)), (s) => s.id),
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
// owner columns are ON DELETE SET NULL: a null owner is `not_recorded`, never `user:null`
const userRef = (id) => (id === null || id === undefined ? 'not_recorded' : `user:${id}`);
// training_datasets.pii_verdict is `clean | flagged | blocked` (TRAINING_SCAN_VERDICTS). ADR-0189 R11: flagged and
// blocked are known sensitive data; clean is NOT proof of absence (noAssertion in SPDX); anything else is refused.
export const PII_VERDICTS = ['clean', 'flagged', 'blocked'];
const piiKnown = (v) => {
  if (!PII_VERDICTS.includes(v)) throw new Error(`unknown pii_verdict: ${JSON.stringify(v)}`);
  return v !== 'clean';
};
// ADR-0189 R26: training_datasets.checksum is `sha256:<hex>:<rows>` (datasetChecksum); a pre-0176 `fnv1a32:` value is
// kept as a property only (never relabelled SHA-256); empty means no hash; any other form is refused.
export function parseTrainingChecksum(v) {
  if (v === '' || v === null || v === undefined) return { sha256: null, rowCount: null, legacy: null };
  const m = /^sha256:([0-9a-f]{64}):(0|[1-9][0-9]*)$/.exec(v);
  if (m) return { sha256: m[1], rowCount: Number(m[2]), legacy: null };
  if (/^fnv1a32:[0-9a-f]{1,8}(:[0-9]+)?$/.test(v)) return { sha256: null, rowCount: null, legacy: v };
  throw new Error(`unparseable training checksum: ${JSON.stringify(v)}`);
}
const datasetDigest = (d) => (d.kind === 'training' ? parseTrainingChecksum(d.checksum) : { sha256: d.casesDigest, rowCount: null, legacy: null });

// R11: a clean verdict is not proof of absence, so it gets NO sensitiveData entry at all (not an empty list)
const sensitive = (v) => (piiKnown(v) ? { sensitiveData: ['pii'] } : {});
// amendment 8: a model licence is stated when the supplier declared one, else stated as unknown (never omitted)
// CycloneDX `authenticated` only from a recorded boolean; never asserted by default
const authOf = (x) => {
  if (x.authenticated === undefined || x.authenticated === null) return {};
  if (typeof x.authenticated !== 'boolean') throw new Error('authenticated must be a boolean when recorded');
  return { authenticated: x.authenticated };
};
const HEX64 = /^[0-9a-f]{64}$/;
export const SKILL_ADMISSION_STATES = ['unscanned', 'clean', 'held', 'refused', 'admitted'];
// ADR-0189 R47: an exported endpoint is scheme, host, port and path only. Query and fragment (where a token may sit)
// are always dropped; userinfo refuses the snapshot. Not relaxable.
export function sanitiseEndpoint(url, what) {
  let u;
  try { u = new URL(url); } catch { throw new Error(`${what}: endpoint is not an absolute URL`); }
  if (u.username || u.password) throw new Error(`${what}: endpoint carries userinfo; refused`);
  return `${u.protocol}//${u.host}${u.pathname}`;
}
const cleanUrl = (url, what) => (url === null || url === undefined ? null : sanitiseEndpoint(url, what));
const endpointsOf = (url, what) => (url === null || url === undefined ? {} : { endpoints: [sanitiseEndpoint(url, what)] });
// a digest is stated only when the record carries a real one; never `sha256:undefined`
const digestText = (v, what) => {
  if (v === undefined || v === null) return 'digest: not_recorded';
  if (!HEX64.test(v)) throw new Error(`${what}: malformed sha256`);
  return `sha256:${v}`;
};
const modelLicense = (card) => (card?.license
  ? [{ license: { name: card.license, acknowledgement: 'declared' } }]
  : [{ license: { name: 'unknown' } }]);
// one container component per exact scanner artifact (engine, version, image), never per engine name (ADR-0189 R12)
const scannerKey = (x) => `${x.engine}/${x.engineVersion}/${stripAlg(x.imageDigest)}`;
const MODEL_CARD_EVIDENCE_KINDS = ['eval_run', 'external', 'engine_scan'];

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
      licenses: modelLicense(card),
      properties: props([
        prop('regulait:agent:id', a.id),
        prop('regulait:model:requested', a.requestedModel),
        prop('regulait:identity:uri', a.workloadIdentity),
        prop('regulait:trainingData:provenance', card?.declared ? 'supplier-declared' : 'unknown'),
        prop('regulait:license:status', card?.license ? 'supplier-declared' : 'unknown'),
        ...(a.pinnedModelVersion ? [] : [prop('regulait:model:version', 'not_recorded')]),
        ...(a.observed ? [prop('regulait:observed:lastSeen', a.observed.lastSeen), prop('regulait:observed:count', a.observed.count)] : []),
      ]),
    };
    if (card) {
      c.modelCard = {
        'bom-ref': ref.card(card.id),
        modelParameters: {
          // supplier-declared in data_claims only; model_cards has no task or architecture column
          ...(card.task ? { task: card.task } : {}),
          ...(card.architecture ? { modelArchitecture: card.architecture } : {}),
          datasets: card.datasetIds.map((d) => ({ ref: ref.dataset(d) })),
        },
        quantitativeAnalysis: {
          performanceMetrics: card.evaluations.map((e) => ({ type: e.type, value: e.value, slice: e.slice })),
        },
        considerations: {
          // one card is one intended use (model_cards_agent_use_uq): one use case, never split into characters
          useCases: [card.intendedUse],
          ...(card.limitations ? { technicalLimitations: [card.limitations] } : {}),
          // a declared assessment slot (dimension), not a mitigation we performed; its method and status are properties
          ...(card.biasFairness.length ? { ethicalConsiderations: card.biasFairness.map((b) => ({ name: b.dimension })) } : {}),
        },
        properties: props([
          prop('regulait:modelCard:id', card.id),
          prop('regulait:modelCard:approval', card.approvedId),
          // standard_refs are display-only control identifiers or prose, never URLs: properties, not externalReferences
          ...card.standardRefs.map((x) => prop('regulait:standardRef', x)),
          ...card.biasFairness.map((b) => prop('regulait:biasFairness:assessment', canonicalize(b))),
          // supplier claims as recorded (OWNER DECISION 10); none renders as provenance `unknown` above
          ...Object.keys(card.dataClaims).sort(cmp).map((k) => prop(`regulait:supplierClaim:${k}`,
            typeof card.dataClaims[k] === 'string' ? card.dataClaims[k] : canonicalize(card.dataClaims[k]))),
        ]),
      };
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
  const engines = sortBy([...new Map(n.artifactScans.map((x) => [scannerKey(x), x])).values()], scannerKey);
  for (const e of engines) {
    components.push({
      type: 'container',
      'bom-ref': ref.engine(scannerKey(e)),
      name: e.engine,
      version: e.engineVersion,
      hashes: [{ alg: 'SHA-256', content: stripAlg(e.imageDigest) }],
    });
    dep(ref.engine(scannerKey(e)));
  }
  // ADR-0189 R24: only what each dataset table records. No owner (the creator is not the owner), no invented hash.
  const datasetGaps = [];
  for (const d of n.datasets) {
    const training = d.kind === 'training';
    const { sha256: digest, rowCount, legacy } = datasetDigest(d);
    const classification = training ? (d.projectDataSensitivity ?? null) : null;
    components.push({
      type: 'data',
      'bom-ref': ref.dataset(d.id),
      name: d.name,
      version: String(d.version),
      ...(digest ? { hashes: [{ alg: 'SHA-256', content: digest }] } : {}),
      data: [{
        type: 'dataset',
        name: d.name,
        ...(classification ? { classification } : {}),
        ...(training ? sensitive(d.piiVerdict) : {}),
      }],
      properties: props([
        prop('regulait:dataset:kind', d.kind),
        prop('regulait:dataset:piiVerdict', training ? d.piiVerdict : 'not_scanned'),
        prop('regulait:dataset:digestOf', training ? (digest ? 'training_datasets.checksum' : null) : 'eval_cases'),
        prop('regulait:dataset:rowCount', rowCount),
        prop('regulait:dataset:legacyChecksum', legacy),
        prop('regulait:dataset:owner', 'not_recorded'),
      ]),
    });
    // every dataset lacks an owner, and evaluation datasets also lack a classification and a PII scan
    datasetGaps.push(ref.dataset(d.id));
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
    if (!SKILL_ADMISSION_STATES.includes(k.snapshotAdmissionState)) throw new Error(`skill ${k.id}: unknown admission state ${JSON.stringify(k.snapshotAdmissionState)}`);
    if (k.snapshotDigest !== '' && !HEX64.test(k.snapshotDigest)) throw new Error(`skill ${k.id}: malformed snapshot digest`);
    components.push({
      type: 'data', 'bom-ref': ref.skill(k.id), name: k.name,
      ...(k.snapshotDigest ? { hashes: [{ alg: 'SHA-256', content: k.snapshotDigest }] } : {}),
      data: [{ type: 'configuration', name: k.name }],
      properties: props([
        prop('regulait:skill:admissionState', k.snapshotAdmissionState),
        prop('regulait:skill:digestOf', k.snapshotDigest ? 'builder_agent_skills.snapshot_digest' : 'not_recorded'),
        prop('regulait:skill:libraryId', k.skillId),
      ]),
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
      ...endpointsOf(e.url, `endpoint ${e.id}`), ...authOf(e), trustZone: e.trustZone,
      data: [{ flow: 'outbound', classification: e.sends }, { flow: 'inbound', classification: e.receives }],
    });
    dep(ref.agent(e.agentId), ref.endpoint(e.id));
    dep(ref.endpoint(e.id));
  }
  for (const m of n.mcpServers) {
    services.push({
      'bom-ref': ref.mcp(m.id), name: m.name,
      // a stdio server's url is the `stdio:<name>` sentinel, not an endpoint: none is emitted
      ...(m.transport === 'stdio' ? {} : endpointsOf(m.url, `mcp server ${m.id}`)), ...authOf(m),
      services: m.tools.map((t) => ({
        'bom-ref': ref.tool(m.id, t.name), name: t.name,
        ...(t.observed ? { properties: props([prop('regulait:observed:lastSeen', t.observed.lastSeen), prop('regulait:observed:count', t.observed.count)]) } : {}),
      })),
      properties: props([
        prop('regulait:mcp:transport', m.transport), prop('regulait:mcp:releaseDigest', m.releaseDigest ?? 'not_recorded'),
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
      // a governance-only connector has no base_url: no endpoints field at all
      'bom-ref': ref.connector(c.id), name: c.name, ...endpointsOf(c.url, `connector ${c.id}`), ...authOf(c),
      properties: props([prop('regulait:connector:kind', c.kind), prop('regulait:connector:admissionManifestDigest', c.admissionManifestDigest), prop('regulait:owner', userRef(c.ownerUserId))]),
    });
    dep(ref.connector(c.id));
    for (const g of c.grantedTo) dep(ref.agent(g), ref.connector(c.id));
  }

  const unknownAgents = n.agents.filter((a) => !a.modelCardId).map((a) => ref.agent(a.id));
  const unknownLicence = n.agents.filter((a) => !(a.modelCardId && cards.get(a.modelCardId)?.license)).map((a) => ref.agent(a.id));
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
    // the release's SBOMs describe the whole install: linked only from an install-scope BOM (§3)
    ...(s.subjectKind !== 'install' ? {} : { externalReferences: n.install.sbomRefs.map((x) => ({
      type: 'bom', url: `urn:cdx:${x.serial.replace(/^urn:uuid:/, '')}/${x.version}`,
      hashes: [{ alg: 'SHA-256', content: x.sha256 }], comment: `${x.kind} SBOM of release ${n.install.release}`,
    })) }),
    dependencies: sortBy([...deps].map(([r, set]) => ({ ref: r, ...(set.size ? { dependsOn: sortStrings([...set]) } : {}) })), (d) => d.ref),
    compositions: [
      // third-party model internals are supplier-declared at best: never `complete`
      { 'bom-ref': 'composition:subject', aggregate: 'incomplete', assemblies: [subject] },
      ...(unknownAgents.length ? [{ 'bom-ref': 'composition:no-model-card', aggregate: 'unknown', assemblies: unknownAgents }] : []),
      ...(unknownLicence.length ? [{ 'bom-ref': 'composition:licence-unknown', aggregate: 'incomplete', assemblies: sortStrings(unknownLicence) }] : []),
      ...(datasetGaps.length ? [{ 'bom-ref': 'composition:dataset-metadata-not-recorded', aggregate: 'incomplete', assemblies: sortStrings(datasetGaps) }] : []),
    ],
    declarations: declarations(n, engines),
  };
  return doc;
}

/** Engine scans AND every model_card_evidence row (eval_run, external, engine_scan) as claims (ADR-0189 §3, R12). */
function declarations(n, engines) {
  const scans = new Map(n.artifactScans.map((x) => [x.id, x]));
  const assessors = engines.map((e) => ({ 'bom-ref': `assessor:${scannerKey(e)}`, thirdParty: false }));
  const claims = n.artifactScans.map((x) => ({
    'bom-ref': `claim:${x.id}`, target: ref.artifact(x.artifactId),
    predicate: `${x.evidenceKind} by ${x.engine} ${x.engineVersion}: ${x.verdict}`, evidence: [`evidence:${x.id}`],
  }));
  const evidence = n.artifactScans.map((x) => ({
    // artifact_scans persists the scanned artifact's sha256, not a digest of the scan evidence (R30)
    'bom-ref': `evidence:${x.id}`, propertyName: 'regulait:scan:verdict', description: digestText(x.evidenceSha256, `artifact scan ${x.id}`),
    created: x.at, data: [{ name: `scan-${x.id}`, classification: 'internal' }],
  }));
  const attestations = n.artifactScans.map((x) => ({
    summary: `scan ${x.id}`, assessor: `assessor:${scannerKey(x)}`, map: [{ claims: [`claim:${x.id}`] }],
  }));
  const needsInternal = n.modelCardEvidence.some((e) => e.kind === 'eval_run');
  const needsExternal = n.modelCardEvidence.some((e) => e.kind === 'external');
  if (needsInternal) assessors.push({ 'bom-ref': 'assessor:regulait-eval', thirdParty: false });
  if (needsExternal) assessors.push({ 'bom-ref': 'assessor:external', thirdParty: true });
  for (const e of n.modelCardEvidence) {
    if (!MODEL_CARD_EVIDENCE_KINDS.includes(e.kind)) throw new Error(`unknown model_card_evidence kind: ${JSON.stringify(e.kind)}`);
    let assessor;
    let evidenceRefs = [`evidence:mce:${e.id}`];
    if (e.kind === 'engine_scan') {
      // packages/shared/src/mrm.ts: engine_scan evidence requires an artifact_scan_id
      const scan = scans.get(e.artifactScanId);
      if (!scan) throw new Error(`engine_scan evidence ${e.id} has no artifact scan in the snapshot`);
      assessor = `assessor:${scannerKey(scan)}`;
      evidenceRefs = [...evidenceRefs, `evidence:${scan.id}`];
    } else {
      assessor = e.kind === 'eval_run' ? 'assessor:regulait-eval' : 'assessor:external';
    }
    claims.push({
      'bom-ref': `claim:mce:${e.id}`, target: ref.card(e.modelCardId),
      predicate: `${e.kind} supports model card ${e.modelCardId}`, evidence: sortStrings(evidenceRefs),
    });
    evidence.push({
      'bom-ref': `evidence:mce:${e.id}`, propertyName: `regulait:modelCardEvidence:${e.kind}`,
      // no digest is persisted for model_card_evidence: state one only when the record carries a real one
      description: digestText(e.sha256, `model_card_evidence ${e.id}`),
      created: e.at, data: [{ name: `model-card-evidence-${e.id}`, classification: 'internal' }],
    });
    attestations.push({ summary: `model card evidence ${e.id}`, assessor, map: [{ claims: [`claim:mce:${e.id}`] }] });
  }
  return {
    assessors: sortBy(assessors, (a) => a['bom-ref']),
    claims: sortBy(claims, (c) => c['bom-ref']),
    evidence: sortBy(evidence, (c) => c['bom-ref']),
    attestations: sortBy(attestations, (a) => a.summary),
  };
}

// ---------------------------------------------------------------- SPDX 3.0.1
const toSecond = (iso) => iso.replace(/\.\d+Z$/, 'Z'); // SPDX DateTime has no fractional seconds
// the persisted vocabulary (AI_USE_CASE_DATA_SENSITIVITIES): public | internal | confidential | regulated
export const CONFIDENTIALITY = { public: 'clear', internal: 'green', confidential: 'amber', regulated: 'red' };
const confidentialityOf = (v) => {
  if (!Object.hasOwn(CONFIDENTIALITY, v)) throw new Error(`unknown data sensitivity: ${JSON.stringify(v)}`);
  return CONFIDENTIALITY[v];
};

export function renderSpdx(n) {
  const s = n.snapshot;
  const base = `https://regulait.invalid/spdx/${encodeURIComponent(n.install.id)}/ai-bom/${encodeURIComponent(s.id)}/${s.version}`;
  const id = (k) => `${base}#${k}`;
  const ci = '_:creationinfo';
  const g = [];
  const el = (o) => { g.push({ ...o, creationInfo: ci }); return o.spdxId; };
  const org = el({ type: 'Organization', spdxId: id('org-install'), name: `RegulAIt install ${n.install.id}` });
  const tool = el({ type: 'Tool', spdxId: id('tool'), name: 'regulait-bom-b0-spike' });
  const suppliers = new Map();
  // an IRI fragment from an opaque digest of the provider name, never the raw name (which may hold spaces etc.)
  for (const a of n.agents) if (!suppliers.has(a.provider)) suppliers.set(a.provider, el({ type: 'Organization', spdxId: id(`supplier-${sha256(a.provider).slice(0, 32)}`), name: a.provider }));
  const subject = el({ type: 'software_Package', spdxId: id('subject'), name: n.useCase.name, software_primaryPurpose: 'application', suppliedBy: org });
  const rels = [];
  const rel = (from, type, to, extra = {}) => rels.push({ type: 'Relationship', spdxId: id(`rel-${rels.length}`), from, relationshipType: type, to, ...extra });
  const cards = new Map(n.modelCards.map((m) => [m.id, m]));
  const dsId = new Map();
  for (const d of n.datasets) {
    const training = d.kind === 'training';
    const digest = datasetDigest(d).sha256;
    const level = training && d.projectDataSensitivity ? confidentialityOf(d.projectDataSensitivity) : null;
    dsId.set(d.id, el({
      type: 'dataset_DatasetPackage', spdxId: id(`dataset-${encodeURIComponent(d.id)}`), name: d.name, software_packageVersion: String(d.version),
      software_primaryPurpose: 'data', dataset_datasetType: ['noAssertion'],
      ...(level ? { dataset_confidentialityLevel: level } : {}),
      dataset_hasSensitivePersonalInformation: training && piiKnown(d.piiVerdict) ? 'yes' : 'noAssertion',
      ...(digest ? { verifiedUsing: [{ type: 'Hash', algorithm: 'sha256', hashValue: digest }] } : {}),
      suppliedBy: org,
    }));
  }
  for (const a of n.agents) {
    const card = a.modelCardId ? cards.get(a.modelCardId) : null;
    // EVERY artifact of the agent, as the CycloneDX rendering lists them (never only the first)
    const arts = n.modelArtifacts.filter((x) => x.agentId === a.id);
    const pkgId = el({
      type: 'ai_AIPackage', spdxId: id(`agent-${encodeURIComponent(a.id)}`), name: a.name,
      ...(a.pinnedModelVersion ? { software_packageVersion: a.pinnedModelVersion } : {}),
      software_primaryPurpose: 'model', suppliedBy: suppliers.get(a.provider),
      ai_autonomyType: 'noAssertion',
      ai_informationAboutTraining: card?.declared ? `supplier-declared: ${canonicalize(card.dataClaims)}` : 'unknown',
      ...(card ? { ai_domain: [card.intendedUse] } : {}),
      ...(card?.limitations ? { ai_limitation: card.limitations } : {}),
      ...(card?.architecture ? { ai_typeOfModel: [card.architecture] } : {}),
      ...(arts.length ? { verifiedUsing: arts.map((x) => ({ type: 'Hash', algorithm: 'sha256', hashValue: x.sha256 })) } : {}),
    });
    rel(subject, 'dependsOn', [pkgId]);
    // licences are mandatory relationships in the AI profile; unknown is stated, never omitted (ADR-0189 §3)
    // a supplier-declared licence name is not an SPDX licence expression, so SPDX keeps NoAssertion and the
    // CycloneDX rendering carries the declared name (spike scope; B5 maps declared SPDX ids)
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
  // ADR-0189 R10: a whole-document scan of every key and string, because the idn-email format covers only fields the
  // schema types as email. Fail closed: refuse (never redact) and name every path.
  for (const [k, v] of Object.entries({ native: nativeBytes, ...renderings })) {
    const hits = findEmails(JSON.parse(v));
    if (hits.length) throw new Error(`email-shaped string in ${k} at ${hits.join(', ')}`);
  }
  const signature = sign(null, Buffer.from(nativeBytes, 'utf8'), testKey).toString('base64');
  const bytes = { native: nativeBytes, ...renderings };
  return {
    bytes,
    sha256: Object.fromEntries(Object.entries(bytes).map(([k, v]) => [k, sha256(v)])),
    signature,
  };
}
