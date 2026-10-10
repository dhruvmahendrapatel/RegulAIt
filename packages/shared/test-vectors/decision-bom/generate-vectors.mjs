#!/usr/bin/env node
/**
 * Generates the ADR-0189 B4 verifier vectors (`b4-vectors.json`) and the
 * regenerated primitive corpus (`crypto-vectors.json`) from the SPECIFICATION
 * TEXT ALONE (ADR-0191 decision 4): ADR-0189 "B4 bundle and signature
 * specification" (B4.1 to B4.7) and the decisions and amendments it cites. It
 * imports no product code: node:crypto, node:zlib-free USTAR writing, and the
 * pinned `canonicalize` (RFC 8785, the module the spec names) only.
 *
 * TEST-ONLY: every key is the Ed25519 key whose 32-byte seed is the SHA-256 of
 * a published seed text that contains CANARY. No private key material is
 * written anywhere; the outputs hold public keys, signatures and digests.
 *
 *   node packages/shared/test-vectors/decision-bom/generate-vectors.mjs
 *
 * The output is deterministic: a re-run must leave `git diff` empty.
 * `check-vectors.mjs` re-verifies every digest and signature independently.
 */
import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { writeFileSync } from "node:fs";
import canonicalizeModule from "canonicalize";

const canonicalize = canonicalizeModule.default ?? canonicalizeModule;
const here = new URL("./", import.meta.url);
const sha = (b) => createHash("sha256").update(b).digest("hex");
const canon = (v) => {
  const s = canonicalize(v);
  if (typeof s !== "string") throw new Error("canonicalize returned no string");
  return s;
};
const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const clone = (v) => JSON.parse(JSON.stringify(v));

// ---------------------------------------------------------------------------
// keys (B4.6 "Keys", plus vector-only keys built by the same rule)
// ---------------------------------------------------------------------------

const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function deriveKey(keyId, seedText, role) {
  if (!seedText.includes("CANARY") || !keyId.includes("CANARY")) throw new Error("every test key id and seed text contains CANARY");
  const seed = createHash("sha256").update(seedText, "utf8").digest();
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: "der", type: "pkcs8" });
  const publicKey = createPublicKey(privateKey);
  const x = publicKey.export({ format: "jwk" }).x;
  const raw = Buffer.from(x, "base64url");
  const fingerprint = `sha256:${sha(Buffer.concat([SPKI_ED25519_PREFIX, raw]))}`;
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  return {
    keyId, seedText, role, privateKey,
    pub: { keyId, seedText, role, jwk: { crv: "Ed25519", kty: "OKP", x }, publicKeyPem, fingerprint },
  };
}

const K = {
  R1: deriveKey("TEST-ONLY-CANARY-receipt-key-1", "regulait ADR-0189 B4 spec TEST-ONLY CANARY receipt key seed", "receipt key of the B4.6 worked example"),
  E1: deriveKey("TEST-ONLY-CANARY-export-key-1", "regulait ADR-0189 B4 spec TEST-ONLY CANARY export key seed", "export key of the B4.6 worked example"),
  R2: deriveKey("TEST-ONLY-CANARY-receipt-key-2", "regulait ADR-0189 B4 vectors TEST-ONLY CANARY receipt key 2 seed", "a second trusted receipt key (rotation, addenda)"),
  E2: deriveKey("TEST-ONLY-CANARY-export-key-2", "regulait ADR-0189 B4 vectors TEST-ONLY CANARY export key 2 seed", "an export key listed in the verification keyring only"),
  RX: deriveKey("TEST-ONLY-CANARY-receipt-key-rogue", "regulait ADR-0189 B4 vectors TEST-ONLY CANARY rogue receipt key seed", "an untrusted receipt key (never in a trust root)"),
  EX: deriveKey("TEST-ONLY-CANARY-export-key-rogue", "regulait ADR-0189 B4 vectors TEST-ONLY CANARY rogue export key seed", "an untrusted export key (never in a trust root)"),
};
const signB64url = (key, bytes) => sign(null, Buffer.from(bytes, "utf8"), key.privateKey).toString("base64url");
const signB64 = (key, bytes) => sign(null, Buffer.from(bytes, "utf8"), key.privateKey).toString("base64");

// ---------------------------------------------------------------------------
// literal inputs (B4.6 "Inputs", extended for the vectors)
// ---------------------------------------------------------------------------

const EX = {
  auditId: "a0000000-0000-4000-8000-000000000042",
  bomId: "b0000000-0000-4000-8000-000000000001",
  sponsor: "c0000000-0000-4000-8000-000000000001",
  exporter: "c0000000-0000-4000-8000-000000000002",
  serverId: "d0000000-0000-4000-8000-000000000001",
  connectorId: "d0000000-0000-4000-8000-000000000002",
  usage1: "e0000000-0000-4000-8000-000000000001",
  usage2: "e0000000-0000-4000-8000-000000000002",
  usage3: "e0000000-0000-4000-8000-000000000003",
  trace1: "f0000000-0000-4000-8000-000000000001",
  span1: "f0000000-0000-4000-8000-000000000002",
  trace2: "f0000000-0000-4000-8000-000000000003",
  span2: "f0000000-0000-4000-8000-000000000004",
  span3: "f0000000-0000-4000-8000-000000000005",
  approval1: "a1000000-0000-4000-8000-000000000001",
  approvalDecision1: "a2000000-0000-4000-8000-000000000001",
  identity1: "c1000000-0000-4000-8000-000000000001",
  grant1: "c2000000-0000-4000-8000-000000000001",
  anchorId: "a9000000-0000-4000-8000-000000000001",
  decisionAt: "2026-10-10T12:00:00.000Z",
  exportedAt: "2026-10-10T12:30:00.000Z",
  verificationTime: "2026-10-11T00:00:00.000Z",
};
const h = (text) => sha(Buffer.from(text, "utf8"));
const ZERO64 = "0".repeat(64);

/** chain rows from seq 42 up to `toSeq`: B4.6's row 42, then rows whose prevHash is the previous rowHash */
function chainRows(toSeq = 42) {
  const rows = [];
  let prev = h("TEST-ONLY CANARY audit row 41");
  for (let seq = 42; seq <= toSeq; seq++) {
    const contentHash = seq === 42 ? h("TEST-ONLY CANARY audit row 42 content") : h(`TEST-ONLY CANARY audit row ${seq} content`);
    const rowHash = h(`${prev}${contentHash}`); // packages/shared/src/audit-chain.ts:406-408 as B4.6 cites
    rows.push({ contentHash, prevHash: prev, rowHash, seq });
    prev = rowHash;
  }
  return rows;
}

// row projections: the usage_events and trace_spans column lists are B4.6's (the facts-payload block)
function usageRow(id, { at = "2026-10-10T12:00:00.250Z", inputTokens = 12, outputTokens = 34, costUsd = "0.000123" } = {}) {
  return {
    table: "usage_events", id,
    projection: {
      actorIdentityId: null, agentConfigVersion: null, agentConfigVersionId: null, agentId: null, at, configCanary: false,
      configVersion: null, configVersionId: null, connectorId: null, costUsd, delegationGrantId: null, id, inputTokens,
      model: null, objectType: "mcp_tool", operation: "tool_call", outputTokens, projectId: null, provider: null, refusal: null,
      requestedAgentId: null, servedModel: null, userId: EX.sponsor,
    },
  };
}
function spanRow(id, traceId, { seq = 1, usageEventId = EX.usage1, costUsd = "0.000123", inputTokens = 12, outputTokens = 34 } = {}) {
  return {
    table: "trace_spans", id,
    projection: {
      actorIdentityId: null, agentId: null, auditLogId: EX.auditId, connectorId: null, contentWithheld: true, costUsd,
      delegationGrantId: null, durationMs: 100, endedAt: "2026-10-10T12:00:00.200Z", id, inputTokens, kind: "mcp_tool",
      mcpServerId: EX.serverId, model: null, outputTokens, parentSpanId: null, provider: null, seq,
      startedAt: "2026-10-10T12:00:00.100Z", status: "ok", traceId, usageEventId,
    },
  };
}
/** ASSUMPTION A3: the ADR does not list the approvals / approval_decisions projection columns (B1 shared zod) */
function approvalRow(id, status) {
  return { table: "approvals", id, projection: { decidedAt: "2026-10-10T11:59:00.000Z", id, quorum: 1, status } };
}
function approvalDecisionRow(id, approvalId) {
  return { table: "approval_decisions", id, projection: { approvalId, decidedAt: "2026-10-10T11:59:00.000Z", deciderUserId: EX.sponsor, id, outcome: "approved", stepUpMethod: "passkey" } };
}
/** the row digest: SHA-256 of the canonical {table, projection} (inferred from B4.6's two digests; gap G1) */
const withDigest = (r) => ({ digest: sha(canon({ projection: r.projection, table: r.table })), id: r.id, projection: r.projection, table: r.table });

const baseAction = (target) => ({
  argumentsDigest: h("TEST-ONLY CANARY arguments"), complianceTags: [], contextDigest: null, dataSensitivity: "internal", inputs: [],
  target: target ?? { agentId: null, connectorId: null, kind: "mcp_tool", serverId: EX.serverId, toolName: "search", toolNameHash: null },
});
const basePolicy = () => ({ abacPolicyVersions: [], configVersions: [], governancePolicyEpoch: 7, guardrailConfigDigest: null, killSwitch: "off", modelPolicyRuleIds: [] });
const baseActors = () => ({ actorChain: [], actorIdentityId: null, delegationGrantId: null, sponsorUserId: EX.sponsor });
const baseOutcome = () => ({ effect: "allow", refusalCode: null, upstreamStatusClass: "2xx" });

function makeFacts({ rows, actors = baseActors(), action = baseAction(), model = null, policy = basePolicy(), outcome = baseOutcome(), auditSeq = 42 } = {}) {
  return { action, actors, auditId: EX.auditId, auditSeq, model, outcome, policy, rows: (rows ?? [spanRow(EX.span1, EX.trace1), usageRow(EX.usage1)]).map(withDigest), v: "regulait.decision-facts.v1" };
}

// ---------------------------------------------------------------------------
// B4.4: facts to sections (this generator's projector, from the ADR text)
// ---------------------------------------------------------------------------

/** R23 decimal strings (ECMAScript Number#toString forms), summed exactly; plain notation, no trailing fractional zeros */
function decimalSum(values) {
  let total = 0n;
  let scale = 0;
  const parsed = values.map((s) => {
    const m = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/.exec(s);
    if (!m) throw new Error(`not an R23 decimal: ${s}`);
    const frac = m[2] ?? "";
    const sc = frac.length - Number(m[3] ?? "0");
    return { mant: BigInt(m[1] + frac), sc };
  });
  for (const p of parsed) scale = Math.max(scale, p.sc);
  for (const p of parsed) total += p.sc >= 0 ? p.mant * 10n ** BigInt(scale - p.sc) : p.mant * 10n ** BigInt(scale - p.sc);
  if (scale <= 0) return (total * 10n ** BigInt(-scale)).toString();
  const digits = total.toString().padStart(scale + 1, "0");
  const intPart = digits.slice(0, digits.length - scale);
  const fracPart = digits.slice(digits.length - scale).replace(/0+$/, "");
  return fracPart ? `${intPart}.${fracPart}` : intPart;
}

const UUID_LC = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function projectSections({ receiptPayload, facts, addenda, ruleChain, noFactsReason }) {
  const d = receiptPayload.decision;
  const decision = {
    at: d.at, auditSeq: receiptPayload.audit.seq, effect: d.effect,
    objectId: d.objectId !== null && d.objectId.length <= 256 ? d.objectId : null,
    objectType: d.objectType, ruleChain, ruleId: d.ruleId,
    serverId: d.serverId !== null && UUID_LC.test(d.serverId) ? d.serverId : null,
    toolName: d.toolName,
  };
  const principal = { sponsorUserId: d.userId };
  const rows = facts ? [...facts.rows, ...addenda.flatMap((a) => a.rows)] : [];
  const stable = (list) => list.map((r, i) => ({ r, i })).sort((a, b) => byCodeUnit(a.r.table, b.r.table) || byCodeUnit(a.r.id, b.r.id) || a.i - b.i).map((x) => x.r);
  const approvals = stable(rows.filter((r) => r.table === "approvals" || r.table === "approval_decisions"));
  const usage = rows.filter((r) => r.table === "usage_events").sort((a, b) => byCodeUnit(a.id, b.id));
  const spans = rows.filter((r) => r.table === "trace_spans").sort((a, b) => byCodeUnit(a.id, b.id));
  const missing = facts ? null : { reason: noFactsReason, status: "not_recorded" };
  const nr = (reason) => ({ reason, status: "not_recorded" });
  const rec = { status: "recorded" };
  const costUsd = usage.length === 0 ? null : usage.some((u) => u.projection.costUsd === null) ? null : usage.length === 1 ? usage[0].projection.costUsd : decimalSum(usage.map((u) => u.projection.costUsd));
  const sections = {
    decision, principal,
    actors: facts ? facts.actors : null,
    action: facts ? facts.action : null,
    policy: facts ? facts.policy : null,
    model: facts ? facts.model : null,
    approval: approvals.length ? approvals.map((r) => ({ digest: r.digest, id: r.id, projection: r.projection, table: r.table })) : null,
    outcome: facts ? facts.outcome : null,
    cost: usage.length ? {
      costSource: "usage_events.cost_usd", costUsd,
      inputTokens: usage.reduce((s, u) => s + u.projection.inputTokens, 0),
      outputTokens: usage.reduce((s, u) => s + u.projection.outputTokens, 0),
      usageEventIds: usage.map((u) => u.id),
    } : null,
    trace: spans.length ? { spanIds: spans.map((s) => s.id), traceIds: [...new Set(spans.map((s) => s.projection.traceId))].sort(byCodeUnit) } : null,
  };
  const completeness = {
    decision: rec, receipt: rec, principal: rec,
    actors: missing ?? (facts.actors === null ? nr("pre_identity") : rec),
    action: missing ?? (facts.action === null ? nr("not_captured_by_path") : rec),
    policy: missing ?? (facts.policy === null ? nr("not_captured_by_path") : rec),
    model: missing ?? (facts.model === null ? nr("not_captured_by_path") : rec),
    approval: missing ?? (approvals.length ? rec : nr("no_bound_row")),
    outcome: missing ?? (facts.outcome === null ? nr("not_captured_by_path") : rec),
    cost: missing ?? (usage.length ? rec : nr("no_bound_row")),
    trace: missing ?? (spans.length ? rec : nr("no_bound_row")),
  };
  return { sections, completeness };
}

// ---------------------------------------------------------------------------
// one Decision BOM bundle, with hooks a negative vector uses to break one rule
// ---------------------------------------------------------------------------

const README =
  "RegulAIt signed export bundle (regulait.export-bundle/3, subject decision-bom)\n\n" +
  "TEST-ONLY CANARY EXAMPLE: every key that signed this bundle is a published test key.\n\n" +
  "Verify with an out-of-band trust root only: the export key fingerprint for\n" +
  "manifest.json.sig, and the receipt key for content/decision-bom.json.sig,\n" +
  "the receipt and any addenda. signing-key.pub and receipt-keys.json are\n" +
  "convenience copies, never the trust root.\n\n" +
  "This bundle carries no audit row payloads (ADR-0189 R39): audit/chain.tsv\n" +
  "holds hashes only, so the decision row's content is not disclosed.\n";

/** ASSUMPTION A2: the ADR names these anchor fields by column or prose; the camelCase spelling is this author's */
function makeAnchor({ toSeq, status = "flushed", tamperResistant = true, retainUntil = "2036-10-10T00:00:00.000Z", record } = {}) {
  const last = chainRows(toSeq).at(-1);
  const rec = record ?? { algorithm: "sha256", capturedAt: "2026-10-10T12:05:00.000Z", headAt: "2026-10-10T12:04:59.000Z", payloadVersion: "regulait.audit.v1", rowHash: last.rowHash, seq: last.seq };
  return {
    destination: "s3_object_lock", externalRef: "s3://TEST-ONLY-CANARY-anchors/a9000000.json", flushedAt: "2026-10-10T12:05:01.000Z",
    id: EX.anchorId, record: rec, retainUntil, status, tamperObservationMode: "compliance", tamperObservedAt: "2026-10-10T12:05:01.000Z",
    tamperResistant, tsaMessageImprint: null, tsaNonce: null, tsaPolicyOid: null, tsaRequestSentAt: null, tsaToken: null,
  };
}

function buildDecisionBundle(o = {}) {
  const hk = o.hooks ?? {};
  const version = o.version ?? 1;
  const receiptVersion = o.receiptVersion ?? "v2";
  const bodyKey = o.bodyKey ?? K.R1;
  const receiptKey = o.receiptKey ?? K.R1;
  const exportKey = o.exportKey ?? K.E1;
  const chain = o.chain ?? chainRows(o.anchor ? o.anchor.record.seq : 42);
  const facts = o.facts === undefined ? makeFacts() : o.facts;
  const factsBytes = facts === null ? null : canon(facts);
  const factsStatus = o.factsStatus ?? (facts === null ? "capture_off" : "captured");

  // addenda (R15, R35; B4.2 signed bytes = the payload)
  const addenda = [];
  let prev = factsBytes === null ? null : sha(factsBytes);
  for (const [i, a] of (o.addenda ?? []).entries()) {
    const n = a.n ?? i + 1;
    const payloadObj = { auditId: EX.auditId, n, prevHash: a.prevHash ?? prev, rows: a.rows.map(withDigest), v: "regulait.decision-facts-addendum.v1" };
    const payload = canon(payloadObj);
    const key = a.key ?? K.R1;
    addenda.push({ keyId: a.keyId ?? key.keyId, n, payload, prevHash: payloadObj.prevHash, signature: a.signature ?? signB64url(key, payload), _obj: payloadObj });
    prev = sha(payload);
  }

  const decisionIn = { at: EX.decisionAt, effect: "allow", objectId: null, objectType: "mcp_tool", ruleId: "rule-allow-search", serverId: EX.serverId, toolName: "search", userId: EX.sponsor, ...(o.receiptDecision ?? {}) };
  let receiptPayload = {
    audit: { contentHash: chain[0].contentHash, id: EX.auditId, rowHash: chain[0].rowHash, seq: chain[0].seq },
    decision: decisionIn, keyId: receiptKey.keyId, prev: ZERO64, receiptSeq: 1, v: `regulait.receipt.${receiptVersion}`,
  };
  if (receiptVersion === "v2") {
    receiptPayload.actor = o.receiptActor ?? { chain: null, delegationGrantId: null, identityId: null };
    receiptPayload.factsStatus = factsStatus;
    receiptPayload.factsHash = factsStatus === "capture_off" ? null : sha(factsBytes);
  }
  if (hk.receiptPayload) receiptPayload = hk.receiptPayload(receiptPayload);
  const receiptBytes = hk.receiptBytes ? hk.receiptBytes(receiptPayload) : canon(receiptPayload);
  const receiptSignature = hk.receiptSignature ? hk.receiptSignature(receiptBytes) : signB64url(receiptKey, receiptBytes);

  const ruleChain = o.ruleChain ?? ["rule-allow-search"];
  const parsedAddenda = addenda.map((a) => a._obj);
  const { sections, completeness } = projectSections({ receiptPayload: o.projectFrom ?? receiptPayload, facts, addenda: parsedAddenda, ruleChain, noFactsReason: o.noFactsReason ?? "capture_off" });
  const anchor = o.anchor ?? null;
  completeness.proof = anchor ? { status: "recorded" } : { reason: "anchor_absent", status: "not_recorded" };
  const finality = o.finality ?? (anchor ? "anchored" : "chain_signed");
  let body = {
    ...sections,
    auditId: EX.auditId,
    basis: { aiBomSnapshotId: null, anchorId: anchor ? anchor.id : null, auditSeq: chain.at(-1).seq, receiptSeq: 1 },
    completeness,
    facts: { addenda: addenda.map(({ _obj, ...a }) => a), payload: factsBytes },
    finality,
    id: o.bomId ?? EX.bomId,
    proof: { anchor, chain },
    receipt: { keyId: receiptKey.keyId, payload: receiptBytes, payloadHash: sha(receiptBytes), receiptSeq: 1, signature: receiptSignature },
    supersedes: o.supersedes ?? null,
    v: "regulait.decision-bom.v1",
    version,
  };
  if (hk.body) body = hk.body(body);
  const bodyBytes = hk.bodyBytes ? hk.bodyBytes(body) : canon(body);
  const bodySha = sha(bodyBytes);
  const sigObj = { alg: "Ed25519", keyId: bodyKey.keyId, signature: signB64url(bodyKey, bodyBytes), signedSha256: bodySha };
  const sigFile = hk.sigFile ? hk.sigFile(sigObj, bodyBytes) : canon(sigObj);

  // receipt-keys.json: one entry per distinct key id named by body, receipt and addendum signatures
  const named = new Map();
  for (const key of [bodyKey, receiptKey, ...(o.addenda ?? []).map((a) => a.key ?? K.R1)]) named.set(key.keyId, key);
  let receiptKeys = { keys: [...named.values()].sort((a, b) => byCodeUnit(a.keyId, b.keyId)).map((k) => ({ fingerprint: k.pub.fingerprint, jwk: k.pub.jwk, keyId: k.keyId })) };
  if (hk.receiptKeys) receiptKeys = hk.receiptKeys(receiptKeys);

  const root = o.root ?? `regulait-export-decision-bom-${EX.auditId}-v${version}`;
  let files = new Map();
  files.set("README.txt", o.readme ?? README);
  files.set("audit/chain.tsv", chain.map((c) => `${c.seq}\t${c.contentHash}\t${c.prevHash}\t${c.rowHash}\n`).join(""));
  files.set("content/decision-bom.json", bodyBytes);
  files.set("content/decision-bom.json.sig", sigFile);
  files.set("receipt-keys.json", canon(receiptKeys));
  files.set("signing-key.pub", (o.signingKeyPub ?? exportKey).pub.publicKeyPem);
  if (hk.files) files = hk.files(files);

  const listed = [...files.entries()].map(([path, text]) => ({ path, sha256: sha(Buffer.from(text, "utf8")) })).sort((a, b) => byCodeUnit(a.path, b.path));
  let manifest = {
    audit: { payloadScope: "none", segmentFromSeq: chain[0].seq, segmentRowCount: chain.length, segmentToSeq: chain.at(-1).seq },
    exportedAt: EX.exportedAt, exportedAtSource: "database", exportedByUserId: EX.exporter,
    files: listed,
    installId: o.installId ?? null, installIdSource: o.installIdSource ?? (o.installId ? "operator" : "absent"),
    product: "regulait", schema: "regulait.export-bundle/3",
    signingKeyFingerprint: exportKey.pub.fingerprint, signingKeyId: o.signingKeyId ?? exportKey.keyId,
    subject: {
      descriptor: { aiBomSnapshotId: null, auditId: EX.auditId, bodySha256: bodySha, bomId: body.id, finality: body.finality, formats: [], receiptSeq: 1, version: body.version },
      id: EX.auditId, kind: "decision-bom",
    },
  };
  if (hk.manifest) manifest = hk.manifest(manifest);
  const manifestBytes = hk.manifestBytes ? hk.manifestBytes(manifest) : canon(manifest);
  const manifestSigKey = o.manifestSigner ?? exportKey;
  let manifestSig = `${signB64(manifestSigKey, hk.manifestSignedBytes ? hk.manifestSignedBytes(manifestBytes) : manifestBytes)}\n`;
  if (hk.manifestSig) manifestSig = hk.manifestSig(manifestSig, manifestBytes);
  files.set("manifest.json", manifestBytes);
  files.set("manifest.json.sig", manifestSig);
  if (hk.finalFiles) files = hk.finalFiles(files);

  let entries = [...files.entries()].map(([path, text]) => ({ name: `${root}/${path}`, type: "file", text })).sort((a, b) => byCodeUnit(a.name, b.name));
  if (hk.entries) entries = hk.entries(entries, root);
  return { root, files, entries, body, facts, receiptPayload };
}

// ---------------------------------------------------------------------------
// B4.1 USTAR (this generator's writer; the checker has its own)
// ---------------------------------------------------------------------------

function ustar(entries) {
  const blocks = [];
  for (const e of entries) {
    const body = Buffer.from(e.text ?? "", "utf8");
    const hdr = Buffer.alloc(512, 0);
    let name = e.name;
    let prefix = "";
    if (Buffer.byteLength(name) > 99) {
      const cut = name.lastIndexOf("/", 154);
      prefix = name.slice(0, cut);
      name = name.slice(cut + 1);
    }
    hdr.write(name, 0, 100, "utf8");
    hdr.write("0000644\0", 100, "latin1");
    hdr.write("0000000\0", 108, "latin1");
    hdr.write("0000000\0", 116, "latin1");
    const size = e.type === "file" ? body.length : 0;
    hdr.write(size.toString(8).padStart(11, "0") + "\0", 124, "latin1");
    hdr.write("00000000000\0", 136, "latin1");
    hdr.write(" ".repeat(8), 148, "latin1");
    hdr.write(e.type === "file" ? "0" : e.type === "directory" ? "5" : "2", 156, "latin1");
    if (e.type === "symlink") hdr.write(e.linkname ?? "", 157, 100, "utf8");
    hdr.write("ustar\0", 257, "latin1");
    hdr.write("00", 263, "latin1");
    if (prefix) hdr.write(prefix, 345, 155, "utf8");
    const sum = hdr.reduce((s, b) => s + b, 0);
    hdr.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "latin1");
    blocks.push(hdr);
    if (size > 0) {
      blocks.push(body);
      const pad = (512 - (size % 512)) % 512;
      if (pad) blocks.push(Buffer.alloc(pad, 0));
    }
  }
  blocks.push(Buffer.alloc(1024, 0));
  return Buffer.concat(blocks);
}

// ---------------------------------------------------------------------------
// trust roots
// ---------------------------------------------------------------------------

const receiptKeyring = (keys, receiptV2FromAuditSeq = 42) => ({ keyring: { keys: keys.map((k) => ({ jwk: k.pub.jwk, keyId: k.keyId })), receiptV2FromAuditSeq } });
const exportKeyring = (keys, ownKey = null) => ({ keyring: keys.map((k) => ({ fingerprint: k.pub.fingerprint, keyId: k.keyId, publicKeyPem: k.pub.publicKeyPem })), ownKey: ownKey ? { keyId: ownKey.keyId, publicKeyPem: ownKey.pub.publicKeyPem } : null });
const trust = ({ receipt = receiptKeyring([K.R1]), exp = exportKeyring([K.E1]), verificationTime = EX.verificationTime, mode = "offline" } = {}) => ({ mode, receipt, export: exp, verificationTime });

// ---------------------------------------------------------------------------
// expectations
// ---------------------------------------------------------------------------

const V = { result: "valid" };
const U = (reason) => ({ reason, result: "unverifiable" });
const I = (reason) => (reason ? { reason, result: "invalid" } : { result: "invalid" });
const ABSENT = "absent";
const NOT_INVALID = "not_invalid";

function positiveChecks({ receiptVersion = "v2", boundary = 42, seq = 42, anchored = false, addenda = false } = {}) {
  const v1Reason = receiptVersion === "v1" ? (boundary !== null && seq >= boundary ? I("v1_receipt_after_boundary") : U("receipt_v1_no_factsHash")) : V;
  return {
    bundle_manifest_signature: V, bundle_manifest_files: V, bundle_subject: V, bundle_email_scan: V,
    body_version: V, body_schema: V, body_signature: V,
    receipt_signature: V, receipt_payload_hash: V, receipt_facts_binding: v1Reason,
    sections_projection: V, chain_links: V, decision_content_binding: U("preimage_not_exported"),
    anchor_record: anchored ? V : U("anchor_absent"),
    anchor_imprint: anchored ? NOT_INVALID : U("anchor_absent"),
    tsa_token: anchored ? NOT_INVALID : U("anchor_absent"),
    finality: V,
    facts_addenda_chain: addenda ? V : ABSENT, facts_addenda_signatures: addenda ? V : ABSENT,
    ai_bom_link: ABSENT,
  };
}

// ---------------------------------------------------------------------------
// the vectors
// ---------------------------------------------------------------------------

const positives = [];
const negatives = [];
const builtById = new Map();

const SPEC = {
  files: "B4.1 'Files' table", root: "B4.1 'Root directory'", manifest: "B4.1 'The manifest'", tar: "B4.1 'Tar order and headers'",
  buildOrder: "B4.1 'Build order' (R21)", signed: "B4.1 'What is signed'",
  alg: "B4.2 'Algorithm and key'", signedBytes: "B4.2 'Signed bytes' table", encoding: "B4.2 'Encoding'", sigFile: "B4.2 'Signature file'",
  findOnline: "B4.2 'Finding the key', online bullet (export keyring, master decision contract round 2)", findOffline: "B4.2 'Finding the key', offline bullet",
  unknownKey: "B4.2 'Finding the key', unknown_key bullet", boundaryTrust: "B4.2 'Finding the key', receipt v2 boundary bullet",
  receipt: "B4.3 receipt section (R48)", v1: "B4.3 v1 bullet", v2: "B4.3 v2 bullet", factsHash: "B4.3 factsHash bullet", boundary: "B4.3 v2 boundary bullet (R34, R42, R43)",
  rPayloadHash: "B4.3 verifier checks: receipt_payload_hash", rSig: "B4.3 verifier checks: receipt_signature", rFacts: "B4.3 verifier checks: receipt_facts_binding", rActor: "B4.3 verifier checks: v2 actor bullet",
  sources: "B4.4 'Sources'", table: "B4.4 sections table", noFacts: "B4.4 'Decided here': no facts bullet", notApplicable: "B4.4 'Decided here': never not_applicable",
  projection: "B4.4 'Decided here': sections_projection bullet", omitted: "B4.4 'Decided here': checks that do not apply", required: "B4.4 'Required checks' (B4C-01)",
  fixed: "B4.4 'Required checks': fixed results", sectionsAgg: "B4.4 'Sections' (B4C-02)",
  emitted: "B4.5 emitted-state bullets", freezeRule: "B4.5 freeze rule (floor and accept)", verifierFinality: "B4.5 verifier finality check",
  example: "B4.6 worked example", r1: "R1 complete canonical anchor record", r39: "R39 no audit preimage", r44: "R44 retain_until",
  r21: "R21 whole-bundle email scan", r37: "R37 exact facts", r35: "R35 addendum chain", r15: "R15 addendum signatures", r46: "R46 v1 facts not claimed", r23: "R23 lossless cost",
  owner2: "§5 / OWNER DECISION 2 domain separation by v", s6: "§6 verification offline, out-of-band trust root",
};

function addPositive(id, { spec, title, build = {}, trustRoot = trust(), checks, extra = {}, assumptions = [] }) {
  const b = buildDecisionBundle(build);
  builtById.set(id, { b, build });
  const tar = ustar(b.entries);
  positives.push({
    id, polarity: "positive", subject: "decision-bom", title, spec, assumptions,
    trust: trustRoot,
    bundle: { root: b.root, entries: b.entries, tarSha256: sha(tar), tarBytes: tar.length },
    expect: {
      outcome: "valid_with_unverifiable",
      checks,
      recordedFinality: b.body.finality,
      reportedFinality: extra.reportedFinality ?? b.body.finality,
      receiptPayloadVersion: b.receiptPayload.v === "regulait.receipt.v1" ? "v1" : "v2",
      sections: "every section valid; completeness equal to the body's",
      ...extra.expect,
    },
    authentic: { manifest: true, body: true, receipt: true, addenda: (build.addenda ?? []).length ? true : "none" },
    projectionConsistent: true,
  });
}

/** a negative is its base positive rebuilt with hooks; stored as an overlay of changed entries */
function addNegative(id, { base = "P01", spec, title, build = {}, trustRoot, expect, authentic, projectionConsistent = true, assumptions = [] }) {
  const baseEntry = builtById.get(base);
  const b = buildDecisionBundle({ ...baseEntry.build, ...build, hooks: { ...(build.hooks ?? {}) } });
  const tar = ustar(b.entries);
  const baseVec = positives.find((p) => p.id === base);
  const baseNames = new Map(baseVec.bundle.entries.map((e) => [e.name, e]));
  const sameOrder = b.entries.length === baseVec.bundle.entries.length && b.entries.every((e, i) => e.name === baseVec.bundle.entries[i].name && e.type === baseVec.bundle.entries[i].type);
  let bundle;
  if (sameOrder) {
    const changed = {};
    for (const e of b.entries) if (baseNames.get(e.name).text !== e.text) changed[e.name] = e.text;
    if (Object.keys(changed).length === 0 && !trustRoot) throw new Error(`${id}: the mutation changed nothing`);
    bundle = { base, replace: changed, tarSha256: sha(tar), tarBytes: tar.length };
  } else {
    bundle = { base, entries: b.entries, tarSha256: sha(tar), tarBytes: tar.length };
  }
  negatives.push({
    id, polarity: "negative", subject: "decision-bom", title, spec, assumptions,
    trust: trustRoot ?? baseVec.trust,
    bundle,
    expect: { outcome: "invalid", ...expect },
    authentic: authentic ?? { manifest: true, body: true, receipt: true, addenda: baseVec.authentic.addenda },
    projectionConsistent,
  });
}

// --- positives ---------------------------------------------------------------

addPositive("P01", {
  spec: [SPEC.example, SPEC.files, SPEC.manifest, SPEC.tar, SPEC.sigFile, SPEC.v2],
  title: "The B4.6 worked example, byte for byte: chain_signed, v2 receipt (captured), one usage event and one span",
  checks: positiveChecks(),
});
addPositive("P02", {
  spec: [SPEC.v1, SPEC.rFacts, SPEC.r46, SPEC.fixed],
  title: "v1 receipt below a known boundary (100): facts carried but receipt_facts_binding is unverifiable receipt_v1_no_factsHash",
  build: { receiptVersion: "v1" },
  trustRoot: trust({ receipt: receiptKeyring([K.R1], 100) }),
  checks: positiveChecks({ receiptVersion: "v1", boundary: 100 }),
});
addPositive("P03", {
  spec: [SPEC.v1, SPEC.rFacts, SPEC.boundaryTrust],
  title: "v1 receipt with no boundary in the trust root: receipt_v1_no_factsHash",
  build: { receiptVersion: "v1" },
  trustRoot: trust({ receipt: receiptKeyring([K.R1], null) }),
  checks: positiveChecks({ receiptVersion: "v1", boundary: null }),
});
addPositive("P04", {
  spec: [SPEC.v2, SPEC.rFacts, SPEC.noFacts, SPEC.table],
  title: "v2 receipt with factsStatus capture_off: facts.payload null, every fact section not_recorded capture_off",
  build: { facts: null, factsStatus: "capture_off", noFactsReason: "capture_off" },
  checks: positiveChecks(),
});
addPositive("P05", {
  spec: [SPEC.noFacts, SPEC.v1, SPEC.rFacts],
  title: "v1 receipt, decision made before B2 (no capture-status row): every fact section not_recorded pre_facts",
  build: { receiptVersion: "v1", facts: null, noFactsReason: "pre_facts" },
  trustRoot: trust({ receipt: receiptKeyring([K.R1], 100) }),
  checks: positiveChecks({ receiptVersion: "v1", boundary: 100 }),
});
addPositive("P06", {
  spec: [SPEC.noFacts],
  title: "v1 receipt with no facts and reason capture_off: a verifier given a v1 receipt accepts either reason",
  build: { receiptVersion: "v1", facts: null, noFactsReason: "capture_off" },
  trustRoot: trust({ receipt: receiptKeyring([K.R1], 100) }),
  checks: positiveChecks({ receiptVersion: "v1", boundary: 100 }),
});
addPositive("P07", {
  spec: [SPEC.table, SPEC.r23, "B4.7-3 exact decimal sum"],
  title: "cost over three usage events: exact decimal sum of R23 strings (0.1 + 0.2 + 1e-7 = 0.3000001), ids sorted; spans over two traces",
  build: {
    facts: makeFacts({ rows: [
      usageRow(EX.usage3, { costUsd: "1e-7", inputTokens: 1, outputTokens: 2 }),
      spanRow(EX.span3, EX.trace2, { seq: 3, usageEventId: EX.usage3 }),
      usageRow(EX.usage1, { costUsd: "0.1" }),
      spanRow(EX.span1, EX.trace1),
      usageRow(EX.usage2, { costUsd: "0.2", inputTokens: 100, outputTokens: 200 }),
      spanRow(EX.span2, EX.trace1, { seq: 2, usageEventId: EX.usage2 }),
    ] }),
  },
  checks: positiveChecks(),
});
addPositive("P08", {
  spec: [SPEC.table, "B4.7-3 exact decimal sum"],
  title: "cost over two usage events whose sum has no fractional part: 0.25 + 0.75 = \"1\" (no trailing zeros, no exponent)",
  build: { facts: makeFacts({ rows: [usageRow(EX.usage1, { costUsd: "0.25" }), usageRow(EX.usage2, { costUsd: "0.75" })] }) },
  checks: positiveChecks(),
});
addPositive("P09", {
  spec: [SPEC.signedBytes, SPEC.r35, SPEC.r15, SPEC.sources, SPEC.omitted],
  title: "two signed addenda (n=1 a usage event, n=2 a span) chained from facts_hash; sections take facts.rows then addenda rows",
  build: { facts: makeFacts({ rows: [] }), addenda: [{ rows: [usageRow(EX.usage1)] }, { rows: [spanRow(EX.span1, EX.trace1)] }] },
  checks: positiveChecks({ addenda: true }),
  assumptions: ["A4"],
});
addPositive("P10", {
  spec: [SPEC.files, SPEC.findOffline, SPEC.r15],
  title: "an addendum signed by a second trusted receipt key: receipt-keys.json carries both ids, sorted by keyId",
  build: { facts: makeFacts({ rows: [spanRow(EX.span1, EX.trace1)] }), addenda: [{ rows: [usageRow(EX.usage1)], key: K.R2 }] },
  trustRoot: trust({ receipt: receiptKeyring([K.R1, K.R2]) }),
  checks: positiveChecks({ addenda: true }),
  assumptions: ["A4"],
});
addPositive("P11", {
  spec: [SPEC.table],
  title: "approval rows: verbatim {table,id,projection,digest}, stable-sorted by table then id (approval_decisions before approvals); a re-bound approval appears twice",
  build: {
    facts: makeFacts({ rows: [approvalRow(EX.approval1, "pending"), approvalDecisionRow(EX.approvalDecision1, EX.approval1), spanRow(EX.span1, EX.trace1), usageRow(EX.usage1)] }),
    addenda: [{ rows: [approvalRow(EX.approval1, "approved")] }],
  },
  checks: positiveChecks({ addenda: true }),
  assumptions: ["A3", "A4"],
});
addPositive("P12", {
  spec: [SPEC.table],
  title: "facts.actors null: actors section null, completeness not_recorded pre_identity",
  build: { facts: makeFacts({ actors: null }) },
  checks: positiveChecks(),
});
addPositive("P13", {
  spec: [SPEC.table],
  title: "decision section: a 300-character objectId is null in the body (over 256); connector call with serverId null",
  build: {
    receiptDecision: { objectId: `connector-object-${"x".repeat(283)}`, objectType: "connector", serverId: null, toolName: "query", ruleId: "rule-allow-connector" },
    ruleChain: ["rule-allow-connector"],
    facts: makeFacts({ action: baseAction({ agentId: null, connectorId: EX.connectorId, kind: "connector", serverId: null, toolName: "query", toolNameHash: null }), rows: [usageRow(EX.usage1)] }),
  },
  checks: positiveChecks(),
});
addPositive("P14", {
  spec: [SPEC.table, SPEC.emitted, SPEC.verifierFinality, SPEC.r1, SPEC.r44],
  title: "anchored: flushed, tamperResistant true, retainUntil 2036; chain 42..44 up to the anchor record seq; proof recorded",
  build: { anchor: makeAnchor({ toSeq: 44 }) },
  checks: positiveChecks({ anchored: true }),
  assumptions: ["A2", "G5"],
});
addPositive("P15", {
  spec: [SPEC.emitted, SPEC.verifierFinality],
  title: "anchored_unverified_destination: flushed to a destination observed not tamper-resistant (retainUntil null)",
  build: { anchor: makeAnchor({ toSeq: 42, tamperResistant: false, retainUntil: null }), finality: "anchored_unverified_destination" },
  checks: positiveChecks({ anchored: true }),
  assumptions: ["A2", "G5"],
});
addPositive("P16", {
  spec: [SPEC.emitted, SPEC.freezeRule, SPEC.verifierFinality],
  title: "anchored_unverified_destination as emitted under refuse with unbounded retention (tamperResistant true, retainUntil set): structurally valid",
  build: { anchor: makeAnchor({ toSeq: 42 }), finality: "anchored_unverified_destination" },
  checks: positiveChecks({ anchored: true }),
  assumptions: ["A2", "G5"],
});
addPositive("P17", {
  spec: [SPEC.emitted, SPEC.verifierFinality],
  title: "anchored_finite_lock (emitted only under accept): reported as recorded, with finite_lock_under_unbounded_retention added",
  build: { anchor: makeAnchor({ toSeq: 42 }), finality: "anchored_finite_lock" },
  checks: positiveChecks({ anchored: true }),
  extra: { expect: { finalityNotes: ["finite_lock_under_unbounded_retention"] } },
  assumptions: ["A2", "G5", "G6"],
});
addPositive("P18", {
  spec: [SPEC.verifierFinality, SPEC.r44],
  title: "anchored, verification time after retainUntil: reported anchored_lapsed with commitment_after_retain_until; the body is unchanged",
  build: { anchor: makeAnchor({ toSeq: 42, retainUntil: "2026-10-10T23:00:00.000Z" }) },
  checks: positiveChecks({ anchored: true }),
  extra: { reportedFinality: "anchored_lapsed", expect: { finalityNotes: ["commitment_after_retain_until"] } },
  assumptions: ["A2", "G5", "G6"],
});
addPositive("P19", {
  spec: [SPEC.verifierFinality],
  title: "anchored, verification time exactly equal to retainUntil: lapsed (\"not after the verification time\")",
  build: { anchor: makeAnchor({ toSeq: 42, retainUntil: EX.verificationTime }) },
  checks: positiveChecks({ anchored: true }),
  extra: { reportedFinality: "anchored_lapsed", expect: { finalityNotes: ["commitment_after_retain_until"] } },
  assumptions: ["A2", "G5", "G6", "G7"],
});
addPositive("P20", {
  spec: [SPEC.findOnline],
  title: "online: the manifest is signed by an export key listed only in the verification keyring (no own key configured)",
  build: { exportKey: K.E2 },
  trustRoot: trust({ mode: "online", exp: exportKeyring([K.E2]) }),
  checks: positiveChecks(),
});
addPositive("P21", {
  spec: [SPEC.findOnline],
  title: "online: the deployment's own configured export key is trusted with an empty keyring",
  trustRoot: trust({ mode: "online", exp: exportKeyring([], K.E1) }),
  checks: positiveChecks(),
});
addPositive("P22", {
  spec: [SPEC.findOffline],
  title: "offline: receipt trust root as pinned fingerprints matched against receipt-keys.json; export trust root as a pinned fingerprint",
  trustRoot: { mode: "offline", receipt: { pinnedFingerprints: [K.R1.pub.fingerprint], receiptV2FromAuditSeq: 42 }, export: { pinnedFingerprints: [K.E1.pub.fingerprint] }, verificationTime: EX.verificationTime },
  checks: positiveChecks(),
});
addPositive("P23", {
  spec: [SPEC.root, "B4.4 'Freezing' item 5", SPEC.manifest],
  title: "version 2 superseding version 1: root ends -v2, supersedes is v1's id, descriptor.version 2",
  build: { version: 2, bomId: "b0000000-0000-4000-8000-000000000002", supersedes: EX.bomId, facts: makeFacts({ rows: [spanRow(EX.span1, EX.trace1)] }), addenda: [{ rows: [usageRow(EX.usage1)] }] },
  checks: positiveChecks({ addenda: true }),
  assumptions: ["A4"],
});
addPositive("P24", {
  spec: [SPEC.manifest],
  title: "an operator-set installId (not email-shaped) with installIdSource operator",
  build: { installId: "TEST-ONLY-CANARY-install-7" },
  checks: positiveChecks(),
});
addPositive("P25", {
  spec: [SPEC.rActor, SPEC.v2],
  title: "v2 receipt naming an actor identity and grant equal to facts.actors (receipt chain and actorChain are not compared)",
  build: {
    receiptActor: { chain: [EX.identity1], delegationGrantId: EX.grant1, identityId: EX.identity1 },
    facts: makeFacts({ actors: { actorChain: ["spiffe://TEST-ONLY-CANARY.example/regulait/agent/c1000000-0000-4000-8000-000000000001"], actorIdentityId: EX.identity1, delegationGrantId: EX.grant1, sponsorUserId: EX.sponsor } }),
  },
  checks: positiveChecks(),
});
addPositive("P26", {
  spec: [SPEC.projection, SPEC.fixed],
  title: "decision.ruleChain is not recomputed by sections_projection: a body with a two-entry ruleChain is still valid_with_unverifiable",
  build: { ruleChain: ["rule-allow-search", "rule-base-default"] },
  checks: positiveChecks(),
});

// --- negatives ---------------------------------------------------------------

const flipLastHex = (s) => s.slice(0, -1) + (s.at(-1) === "0" ? "1" : "0");
const reSignBodyOnly = { manifest: true, body: true, receipt: true };

// envelope: manifest signature and keys
addNegative("N-M01", { spec: [SPEC.manifest, SPEC.signed], title: "manifest.json.sig signs other bytes (manifest edited after signing)",
  build: { hooks: { manifestSignedBytes: (b) => b.replace("\"exportedAtSource\":\"database\"", "\"exportedAtSource\":\"database\" ") } },
  expect: { checks: { bundle_manifest_signature: I() } }, authentic: { manifest: false, body: true, receipt: true } });
addNegative("N-M02", { spec: [SPEC.findOnline, SPEC.unknownKey], title: "signingKeyId names a key in neither the keyring nor the own key (rogue export key)",
  build: { exportKey: K.EX }, trustRoot: trust({ mode: "online", exp: exportKeyring([K.E1], K.E2) }),
  expect: { checks: { bundle_manifest_signature: I("unknown_key") } }, authentic: { manifest: "untrusted", body: true, receipt: true } });
addNegative("N-M03", { spec: [SPEC.findOnline, SPEC.s6], title: "a rogue key signs the manifest under E1's key id, with its own signing-key.pub and fingerprint: the bundle key is never trusted",
  build: { manifestSigner: K.EX, signingKeyPub: K.EX, hooks: { manifest: (m) => ({ ...m, signingKeyFingerprint: K.EX.pub.fingerprint }) } },
  expect: { checks: { bundle_manifest_signature: I() } }, authentic: { manifest: false, body: true, receipt: true } });
addNegative("N-M04", { spec: [SPEC.unknownKey], title: "the export trust root holds E1's id twice with different keys",
  trustRoot: trust({ exp: { keyring: [{ fingerprint: K.E1.pub.fingerprint, keyId: K.E1.keyId, publicKeyPem: K.E1.pub.publicKeyPem }, { fingerprint: K.E2.pub.fingerprint, keyId: K.E1.keyId, publicKeyPem: K.E2.pub.publicKeyPem }], ownKey: null } }),
  expect: { checks: { bundle_manifest_signature: I("unknown_key") }, onlineKeyringLoad: "refused (each id once)" }, authentic: { manifest: "untrusted", body: true, receipt: true } });
addNegative("N-M05", { spec: [SPEC.findOnline], title: "online keyring entry whose fingerprint does not match its key: the keyring is refused at load",
  trustRoot: trust({ mode: "online", exp: { keyring: [{ fingerprint: K.E2.pub.fingerprint, keyId: K.E1.keyId, publicKeyPem: K.E1.pub.publicKeyPem }], ownKey: null } }),
  expect: { outcome: "not_run", onlineKeyringLoad: "refused (fingerprint does not match its key)" }, authentic: { manifest: "untrusted", body: true, receipt: true } });
addNegative("N-M06", { spec: [SPEC.manifest, SPEC.encoding], title: "manifest.json.sig as unpadded base64url instead of padded standard base64 and a newline",
  build: { hooks: { manifestSig: (s) => Buffer.from(s.trim(), "base64").toString("base64url") } },
  expect: { checks: { bundle_manifest_signature: I() } }, authentic: { manifest: "encoding", body: true, receipt: true } });
addNegative("N-M07", { spec: [SPEC.files, "B4.2 'Encoding': manifest signature ends with a newline"], title: "manifest.json.sig without its trailing newline",
  build: { hooks: { manifestSig: (s) => s.trim() } },
  expect: { checks: { bundle_manifest_signature: I() } }, authentic: { manifest: "encoding", body: true, receipt: true } });
addNegative("N-M08", { spec: [SPEC.files], title: "manifest.json not canonical (pretty-printed) yet correctly signed",
  build: { hooks: { manifestBytes: (m) => JSON.stringify(m, null, 1) } }, expect: {} });
// envelope: file membership
addNegative("N-M09", { spec: [SPEC.manifest, "B4.4 'Required checks': bundle_manifest_files"], title: "README.txt changed after the manifest listed its SHA-256",
  build: { hooks: { finalFiles: (f) => { f.set("README.txt", f.get("README.txt").replace("published test key", "published test key!")); return f; } } },
  expect: { checks: { bundle_manifest_files: I() } } });
addNegative("N-M10", { spec: [SPEC.files, SPEC.r39], title: "an extra audit/rows/42.payload entry in the archive, not in the manifest (R39: no audit preimage)",
  build: { hooks: { finalFiles: (f) => { f.set("audit/rows/42.payload", "{\"TEST-ONLY\":\"CANARY preimage\"}"); return f; } } },
  expect: { checks: { bundle_manifest_files: I() } } });
addNegative("N-M11", { spec: [SPEC.files, SPEC.r39], title: "audit/rows/42.payload listed in a re-signed manifest: no such file may exist in a BOM bundle",
  build: { hooks: { files: (f) => { f.set("audit/rows/42.payload", "{\"TEST-ONLY\":\"CANARY preimage\"}"); return f; } } },
  expect: {} });
addNegative("N-M12", { spec: [SPEC.manifest], title: "a file listed in the manifest is missing from the archive",
  build: { hooks: { finalFiles: (f) => { f.delete("signing-key.pub"); return f; } } },
  expect: { checks: { bundle_manifest_files: I() } } });
addNegative("N-M13", { spec: [SPEC.manifest], title: "manifest.files not sorted by path (re-signed)",
  build: { hooks: { manifest: (m) => ({ ...m, files: [...m.files].reverse() }) } }, expect: {} });
addNegative("N-M14", { spec: [SPEC.manifest], title: "manifest.files lists manifest.json itself (re-signed)",
  build: { hooks: { manifest: (m) => ({ ...m, files: [...m.files, { path: "manifest.json", sha256: ZERO64 }].sort((a, b) => byCodeUnit(a.path, b.path)) }) } }, expect: {} });
addNegative("N-M15", { spec: [SPEC.manifest], title: "manifest.files lists one path twice (re-signed)",
  build: { hooks: { manifest: (m) => ({ ...m, files: [...m.files, m.files[0]].sort((a, b) => byCodeUnit(a.path, b.path)) }) } }, expect: {} });
addNegative("N-M16", { spec: [SPEC.files], title: "a directory entry in the archive (no directory entry exists)",
  build: { hooks: { entries: (e, root) => [{ name: `${root}/content/`, type: "directory", text: "" }, ...e].sort((a, b) => byCodeUnit(a.name, b.name)) } }, expect: {} });
addNegative("N-M17", { spec: [SPEC.root], title: "entries under two root directories",
  build: { hooks: { entries: (e, root) => e.map((x) => (x.name.endsWith("/README.txt") ? { ...x, name: x.name.replace(root, `${root}-other`) } : x)).sort((a, b) => byCodeUnit(a.name, b.name)) } }, expect: {} });
addNegative("N-M18", { spec: ["ADR-0116 amendment 2026-10-03 (non-regular entries)", SPEC.files], title: "a symlink entry in the archive",
  build: { hooks: { entries: (e, root) => [...e, { name: `${root}/content/link`, type: "symlink", linkname: "../manifest.json", text: "" }].sort((a, b) => byCodeUnit(a.name, b.name)) } }, expect: {} });
addNegative("N-M19", { spec: [SPEC.root], title: "root directory named -v2 for a version 1 Decision BOM",
  build: { root: `regulait-export-decision-bom-${EX.auditId}-v2` }, expect: {} });
// envelope: manifest fields
addNegative("N-M20", { spec: [SPEC.buildOrder, SPEC.r21, SPEC.manifest], title: "email-shaped operator installId (signed): the email scan covers manifest.json",
  build: { installId: "ops-TEST-ONLY-CANARY@example.com" }, expect: { checks: { bundle_email_scan: I() } } });
addNegative("N-M21", { spec: [SPEC.manifest], title: "installId non-null with installIdSource absent (re-signed)",
  build: { hooks: { manifest: (m) => ({ ...m, installId: "TEST-ONLY-CANARY-install-7", installIdSource: "absent" }) } }, expect: {} });
addNegative("N-M22", { spec: [SPEC.buildOrder, SPEC.r21], title: "an email address in README.txt (listed and signed)",
  build: { readme: README.replace("convenience copies", "convenience copies (questions: TEST-ONLY-CANARY@example.com)") },
  expect: { checks: { bundle_email_scan: I() } } });
addNegative("N-M23", { spec: [SPEC.manifest, SPEC.sigFile], title: "descriptor.bodySha256 differs from content/decision-bom.json (re-signed manifest)",
  build: { hooks: { manifest: (m) => ({ ...m, subject: { ...m.subject, descriptor: { ...m.subject.descriptor, bodySha256: flipLastHex(m.subject.descriptor.bodySha256) } } }) } },
  expect: { checks: { bundle_subject: I() } } });
addNegative("N-M24", { spec: [SPEC.manifest], title: "subject.id is not the auditId (re-signed)",
  build: { hooks: { manifest: (m) => ({ ...m, subject: { ...m.subject, id: EX.bomId } }) } }, expect: { checks: { bundle_subject: I() } } });
addNegative("N-M25", { spec: [SPEC.manifest], title: "audit.segmentToSeq does not equal the last proof.chain seq (re-signed)",
  build: { hooks: { manifest: (m) => ({ ...m, audit: { ...m.audit, segmentToSeq: 43 } }) } }, expect: {} });
addNegative("N-M26", { spec: [SPEC.manifest], title: "schema regulait.export-bundle/2 on a BOM bundle (re-signed)",
  build: { hooks: { manifest: (m) => ({ ...m, schema: "regulait.export-bundle/2" }) } }, expect: {} });
addNegative("N-M27", { spec: [SPEC.manifest], title: "descriptor.finality differs from the body's finality (re-signed)",
  build: { hooks: { manifest: (m) => ({ ...m, subject: { ...m.subject, descriptor: { ...m.subject.descriptor, finality: "anchored" } } }) } }, expect: { checks: { bundle_subject: I() } } });
addNegative("N-M28", { spec: [SPEC.manifest], title: "audit.payloadScope other than none (re-signed)",
  build: { hooks: { manifest: (m) => ({ ...m, audit: { ...m.audit, payloadScope: "decision_row" } }) } }, expect: {} });

// body signature
addNegative("N-B01", { spec: [SPEC.signedBytes, SPEC.sigFile], title: "body signature made over other bytes (signedSha256 matches the file, signature does not)",
  build: { hooks: { sigFile: (s, bytes) => canon({ ...s, signature: signB64url(K.R1, `${bytes} `) }) } },
  expect: { checks: { body_signature: I() } }, authentic: { manifest: true, body: false, receipt: true } });
addNegative("N-B02", { spec: [SPEC.sigFile], title: "signature file's signedSha256 is not the SHA-256 of the body file",
  build: { hooks: { sigFile: (s) => canon({ ...s, signedSha256: flipLastHex(s.signedSha256) }) } }, expect: { checks: { body_signature: I() } } });
addNegative("N-B03", { spec: [SPEC.sigFile], title: "signature file not canonical (keys out of order)",
  build: { hooks: { sigFile: (s) => JSON.stringify({ signature: s.signature, keyId: s.keyId, alg: s.alg, signedSha256: s.signedSha256 }) } }, expect: {} });
addNegative("N-B04", { spec: [SPEC.encoding, SPEC.sigFile], title: "body signature as padded standard base64 (88 characters), not 86-character base64url",
  build: { hooks: { sigFile: (s) => canon({ ...s, signature: Buffer.from(s.signature, "base64url").toString("base64") }) } },
  expect: { checks: { body_signature: I() } }, authentic: { manifest: true, body: "encoding", receipt: true } });
addNegative("N-B05", { spec: [SPEC.sigFile], title: "signature file alg is not Ed25519",
  build: { hooks: { sigFile: (s) => canon({ ...s, alg: "EdDSA" }) } }, expect: { checks: { body_signature: I() } } });
addNegative("N-B06", { spec: [SPEC.unknownKey, SPEC.findOffline], title: "body signed by a receipt key the trust root does not hold (R2, carried in receipt-keys.json)",
  build: { bodyKey: K.R2 }, expect: { checks: { body_signature: I("unknown_key") } }, authentic: { manifest: true, body: "untrusted", receipt: true } });
addNegative("N-B07", { spec: [SPEC.s6, SPEC.findOffline], title: "a rogue key signs the body and receipt under R1's id; receipt-keys.json carries the rogue JWK: bundled keys are never the trust root",
  build: { hooks: {
    receiptSignature: (bytes) => signB64url(K.RX, bytes),
    sigFile: (s, bytes) => canon({ ...s, signature: signB64url(K.RX, bytes) }),
    receiptKeys: (rk) => ({ keys: rk.keys.map((k) => ({ ...k, fingerprint: K.RX.pub.fingerprint, jwk: K.RX.pub.jwk })) }),
  } },
  expect: { checks: { body_signature: I(), receipt_signature: I() } }, authentic: { manifest: true, body: false, receipt: false } });
addNegative("N-B08", { spec: [SPEC.owner2, SPEC.signedBytes], title: "domain separation: the signature file carries the receipt's signature",
  build: { hooks: { sigFile: (s, bytes) => canon({ ...s, signature: JSON.parse(bytes).receipt.signature }) } },
  expect: { checks: { body_signature: I() } }, authentic: { manifest: true, body: false, receipt: true } });
addNegative("N-B09", { spec: [SPEC.owner2, "§5 every verifier rejects an unknown v"], title: "body v is regulait.decision-bom.v2, correctly signed",
  build: { hooks: { body: (b) => ({ ...b, v: "regulait.decision-bom.v2" }) } }, expect: { checks: { body_version: I() } } });
addNegative("N-B10", { spec: [SPEC.files, SPEC.signedBytes], title: "body not canonical (pretty-printed) but signed over those bytes",
  build: { hooks: { bodyBytes: (b) => JSON.stringify(b, null, 1) } }, expect: {} });
addNegative("N-B11", { spec: [SPEC.unknownKey], title: "the receipt trust root holds R1's id twice with different keys",
  trustRoot: trust({ receipt: { keyring: { keys: [{ jwk: K.R1.pub.jwk, keyId: K.R1.keyId }, { jwk: K.R2.pub.jwk, keyId: K.R1.keyId }], receiptV2FromAuditSeq: 42 } } }),
  expect: { checks: { body_signature: I("unknown_key"), receipt_signature: I("unknown_key") } }, authentic: { manifest: true, body: "untrusted", receipt: "untrusted" } });
addNegative("N-B12", { spec: [SPEC.findOffline], title: "offline pinned receipt fingerprint does not match receipt-keys.json's entry for that id",
  trustRoot: { mode: "offline", receipt: { pinnedFingerprints: [K.R2.pub.fingerprint], receiptV2FromAuditSeq: 42 }, export: { pinnedFingerprints: [K.E1.pub.fingerprint] }, verificationTime: EX.verificationTime },
  expect: { checks: { body_signature: I("unknown_key"), receipt_signature: I("unknown_key") } }, authentic: { manifest: true, body: "untrusted", receipt: "untrusted" } });

// receipt
addNegative("N-R01", { spec: [SPEC.rPayloadHash], title: "receipt.payloadHash is not the SHA-256 of payload",
  build: { hooks: { body: (b) => ({ ...b, receipt: { ...b.receipt, payloadHash: flipLastHex(b.receipt.payloadHash) } }) } }, expect: { checks: { receipt_payload_hash: I() } } });
addNegative("N-R02", { spec: [SPEC.rPayloadHash], title: "receipt payload not canonical (re-hashed and re-signed over the non-canonical bytes)",
  build: { hooks: { receiptBytes: (p) => JSON.stringify(p) } }, expect: { checks: { receipt_payload_hash: I() } } });
addNegative("N-R03", { spec: [SPEC.rPayloadHash, SPEC.owner2], title: "receipt v regulait.receipt.v3: parses as neither v1 nor v2",
  build: { hooks: { receiptPayload: (p) => ({ ...p, v: "regulait.receipt.v3" }) } }, expect: { checks: { receipt_payload_hash: I() } } });
addNegative("N-R04", { spec: [SPEC.rSig], title: "receipt signature does not verify (signed over other bytes)",
  build: { hooks: { receiptSignature: (bytes) => signB64url(K.R1, `${bytes} `) } }, expect: { checks: { receipt_signature: I() } }, authentic: { manifest: true, body: true, receipt: false } });
addNegative("N-R05", { spec: [SPEC.rSig, SPEC.unknownKey], title: "receipt signed by a key the trust root does not hold (R2)",
  build: { receiptKey: K.R2 }, expect: { checks: { receipt_signature: I("unknown_key") } }, authentic: { manifest: true, body: true, receipt: "untrusted" } });
addNegative("N-R06", { spec: [SPEC.rSig], title: "payload.keyId differs from receipt.keyId",
  build: { hooks: { receiptPayload: (p) => ({ ...p, keyId: K.R2.keyId }) } }, expect: { checks: { receipt_signature: I() } } });
addNegative("N-R07", { spec: [SPEC.rSig], title: "payload.receiptSeq differs from receipt.receiptSeq",
  build: { hooks: { receiptPayload: (p) => ({ ...p, receiptSeq: 2 }) } }, expect: { checks: { receipt_signature: I() } }, projectionConsistent: true });
addNegative("N-R08", { spec: [SPEC.rSig], title: "payload.audit.rowHash is not proof.chain[0].rowHash",
  build: { hooks: { receiptPayload: (p) => ({ ...p, audit: { ...p.audit, rowHash: flipLastHex(p.audit.rowHash) } }) } }, expect: { checks: { receipt_signature: I() } } });
addNegative("N-R09", { spec: [SPEC.rSig], title: "payload.audit.id is not the body's auditId",
  build: { hooks: { receiptPayload: (p) => ({ ...p, audit: { ...p.audit, id: "a0000000-0000-4000-8000-000000000043" } }) } }, expect: { checks: { receipt_signature: I() } } });
addNegative("N-R10", { spec: [SPEC.rFacts, SPEC.factsHash, SPEC.r37], title: "v2 captured: factsHash is not the SHA-256 of facts.payload",
  build: { hooks: { receiptPayload: (p) => ({ ...p, factsHash: flipLastHex(p.factsHash) }) } }, expect: { checks: { receipt_facts_binding: I("facts_hash_mismatch") } } });
addNegative("N-R11", { spec: [SPEC.rFacts], title: "v2 capture_off but facts.payload is not null",
  build: { factsStatus: "capture_off" }, expect: { checks: { receipt_facts_binding: I() } } });
addNegative("N-R12", { base: "P02", spec: [SPEC.rFacts, SPEC.boundary, SPEC.fixed], title: "v1 receipt at a seq at or above the known boundary (boundary 42, seq 42)",
  trustRoot: trust({ receipt: receiptKeyring([K.R1], 42) }), expect: { checks: { receipt_facts_binding: I("v1_receipt_after_boundary") } } });
addNegative("N-R13", { base: "P25", spec: [SPEC.rActor], title: "v2 actor.identityId differs from actors.actorIdentityId",
  build: { receiptActor: { chain: [EX.identity1], delegationGrantId: EX.grant1, identityId: "c1000000-0000-4000-8000-000000000009" } }, expect: {} });
addNegative("N-R14", { base: "P25", spec: [SPEC.rActor], title: "v2 actor.delegationGrantId differs from actors.delegationGrantId",
  build: { receiptActor: { chain: [EX.identity1], delegationGrantId: "c2000000-0000-4000-8000-000000000009", identityId: EX.identity1 } }, expect: {} });

// sections
const sectionBreak = (fn) => ({ hooks: { body: fn } });
addNegative("N-S01", { spec: [SPEC.projection, SPEC.sectionsAgg], title: "cost.inputTokens changed in the signed body", build: sectionBreak((b) => ({ ...b, cost: { ...b.cost, inputTokens: 13 } })),
  expect: { checks: { sections_projection: I("section_mismatch") }, sections: { cost: "invalid" } }, projectionConsistent: false });
addNegative("N-S02", { spec: [SPEC.projection], title: "completeness.model claims recorded while facts.model is null", build: sectionBreak((b) => ({ ...b, completeness: { ...b.completeness, model: { status: "recorded" } } })),
  expect: { checks: { sections_projection: I("section_mismatch") }, sections: { model: "invalid" } }, projectionConsistent: false });
addNegative("N-S03", { base: "P11", spec: [SPEC.table, SPEC.projection], title: "the duplicate approval binding is collapsed to one entry", build: sectionBreak((b) => ({ ...b, approval: b.approval.filter((x, i, a) => a.findIndex((y) => y.id === x.id && y.table === x.table) === i) })),
  expect: { checks: { sections_projection: I("section_mismatch") }, sections: { approval: "invalid" } }, projectionConsistent: false, assumptions: ["A3", "A4"] });
addNegative("N-S04", { spec: [SPEC.projection, SPEC.table], title: "decision.toolName changed (decision is recomputed except ruleChain)", build: sectionBreak((b) => ({ ...b, decision: { ...b.decision, toolName: "fetch" } })),
  expect: { checks: { sections_projection: I("section_mismatch") }, sections: { decision: "invalid" } }, projectionConsistent: false });
addNegative("N-S05", { spec: [SPEC.projection, SPEC.table], title: "principal.sponsorUserId is not the receipt's decision.userId", build: sectionBreak((b) => ({ ...b, principal: { sponsorUserId: EX.exporter } })),
  expect: { checks: { sections_projection: I("section_mismatch") }, sections: { principal: "invalid" } }, projectionConsistent: false });
addNegative("N-S06", { base: "P08", spec: [SPEC.table, "B4.7-3 exact decimal sum"], title: "cost.costUsd \"1.0\" (a trailing fractional zero) for 0.25 + 0.75", build: sectionBreak((b) => ({ ...b, cost: { ...b.cost, costUsd: "1.0" } })),
  expect: { checks: { sections_projection: I("section_mismatch") }, sections: { cost: "invalid" } }, projectionConsistent: false });
addNegative("N-S07", { base: "P07", spec: [SPEC.table, SPEC.r23], title: "cost.costUsd computed in binary floating point (0.1 + 0.2 + 1e-7 as doubles: 0.30000010000000005) rather than the exact decimal sum 0.3000001",
  build: sectionBreak((b) => ({ ...b, cost: { ...b.cost, costUsd: String(0.1 + 0.2 + 1e-7) } })),
  expect: { checks: { sections_projection: I("section_mismatch") }, sections: { cost: "invalid" } }, projectionConsistent: false });
addNegative("N-S08", { base: "P07", spec: [SPEC.table], title: "trace.spanIds not sorted", build: sectionBreak((b) => ({ ...b, trace: { ...b.trace, spanIds: [...b.trace.spanIds].reverse() } })),
  expect: { checks: { sections_projection: I("section_mismatch") }, sections: { trace: "invalid" } }, projectionConsistent: false });
addNegative("N-S09", { spec: [SPEC.notApplicable, SPEC.projection], title: "completeness.approval not_applicable (B4 never emits it; a gap is never inferred)",
  build: sectionBreak((b) => ({ ...b, completeness: { ...b.completeness, approval: { status: "not_applicable" } } })),
  expect: { checks: { sections_projection: I("section_mismatch") }, sections: { approval: "invalid" } }, projectionConsistent: false });
addNegative("N-S10", { base: "P04", spec: [SPEC.noFacts, SPEC.projection], title: "v2 capture_off receipt but completeness says pre_facts",
  build: { noFactsReason: "pre_facts" }, expect: { checks: { sections_projection: I("section_mismatch") } }, projectionConsistent: false });
addNegative("N-S11", { base: "P13", spec: [SPEC.table], title: "decision.objectId carries the 300-character objectId (over 256 must be null)",
  build: { hooks: { body: (b) => ({ ...b, decision: { ...b.decision, objectId: `connector-object-${"x".repeat(283)}` } }) } },
  expect: { checks: { sections_projection: I("section_mismatch") }, sections: { decision: "invalid" } }, projectionConsistent: false });
addNegative("N-S12", { spec: [SPEC.table, SPEC.projection], title: "action section differs from facts.action (dataSensitivity edited)", build: sectionBreak((b) => ({ ...b, action: { ...b.action, dataSensitivity: "public" } })),
  expect: { checks: { sections_projection: I("section_mismatch") }, sections: { action: "invalid" } }, projectionConsistent: false });
addNegative("N-S13", { base: "P12", spec: [SPEC.table], title: "facts.actors null but completeness.actors not_captured_by_path instead of pre_identity",
  build: sectionBreak((b) => ({ ...b, completeness: { ...b.completeness, actors: { reason: "not_captured_by_path", status: "not_recorded" } } })),
  expect: { checks: { sections_projection: I("section_mismatch") }, sections: { actors: "invalid" } }, projectionConsistent: false });
addNegative("N-S14", { base: "P09", spec: [SPEC.sources, SPEC.table], title: "rows from an addendum left out of the cost section",
  build: sectionBreak((b) => ({ ...b, cost: null, completeness: { ...b.completeness, cost: { reason: "no_bound_row", status: "not_recorded" } } })),
  expect: { checks: { sections_projection: I("section_mismatch") }, sections: { cost: "invalid" } }, projectionConsistent: false, assumptions: ["A4"] });

// chain
addNegative("N-C01", { base: "P14", spec: ["§6 chain links", SPEC.table], title: "a chain row's rowHash is not SHA-256(prevHash || contentHash)",
  build: { chain: chainRows(44).map((r) => (r.seq === 43 ? { ...r, rowHash: flipLastHex(r.rowHash) } : r)) },
  expect: { checks: { chain_links: I() } }, assumptions: ["A2", "G5"] });
addNegative("N-C02", { base: "P14", spec: ["§6 chain links"], title: "chain rows do not link (row 44's prevHash is not row 43's rowHash; rowHash recomputed)",
  build: { chain: (() => { const c = chainRows(44); c[2] = { ...c[2], prevHash: ZERO64, rowHash: h(`${ZERO64}${c[2].contentHash}`) }; return c; })(),
    anchor: (() => { const c = chainRows(44); const last = h(`${ZERO64}${c[2].contentHash}`); const a = makeAnchor({ toSeq: 44 }); return { ...a, record: { ...a.record, rowHash: last } }; })() },
  expect: { checks: { chain_links: I() } }, assumptions: ["A2", "G5"] });
addNegative("N-C03", { spec: [SPEC.files], title: "audit/chain.tsv differs from proof.chain (listed and signed)",
  build: { hooks: { files: (f) => { f.set("audit/chain.tsv", f.get("audit/chain.tsv").replace(/^42\t/, "41\t")); return f; } } }, expect: {} });
addNegative("N-C04", { spec: [SPEC.table], title: "chain_signed but proof.chain holds two rows (it is the decision row alone)",
  build: { chain: chainRows(43) }, expect: {} });

// anchor and finality (verifier side)
addNegative("N-F01", { base: "P14", spec: [SPEC.r1], title: "anchor record seq is not the last chain row's seq",
  build: { chain: chainRows(43) }, expect: { checks: { anchor_record: I() } }, assumptions: ["A2", "G5"] });
addNegative("N-F02", { base: "P14", spec: [SPEC.r1], title: "anchor record rowHash is not the last chain row's rowHash",
  build: { anchor: (() => { const a = makeAnchor({ toSeq: 44 }); return { ...a, record: { ...a.record, rowHash: flipLastHex(a.record.rowHash) } }; })() },
  expect: { checks: { anchor_record: I() } }, assumptions: ["A2", "G5"] });
addNegative("N-F03", { base: "P14", spec: [SPEC.r1], title: "anchor record without capturedAt: a proof without all six fields is invalid, not unverifiable",
  build: { anchor: (() => { const a = makeAnchor({ toSeq: 44 }); const { capturedAt, ...rec } = a.record; return { ...a, record: rec }; })() },
  expect: { checks: { anchor_record: I() } }, assumptions: ["A2", "G5"] });
addNegative("N-F04", { spec: [SPEC.verifierFinality], title: "finality chain_signed but proof.anchor is not null",
  build: { anchor: makeAnchor({ toSeq: 42 }), finality: "chain_signed" }, expect: { checks: { finality: I() } }, assumptions: ["A2"] });
addNegative("N-F05", { base: "P14", spec: [SPEC.verifierFinality, SPEC.table], title: "finality anchored but proof.anchor is null",
  build: { anchor: null, chain: chainRows(42), finality: "anchored" }, expect: { checks: { finality: I() } } });
addNegative("N-F06", { base: "P14", spec: [SPEC.verifierFinality], title: "finality anchored with tamperResistant false",
  build: { anchor: makeAnchor({ toSeq: 44, tamperResistant: false }) }, expect: { checks: { finality: I() } }, assumptions: ["A2"] });
addNegative("N-F07", { base: "P14", spec: [SPEC.verifierFinality], title: "finality anchored with retainUntil null",
  build: { anchor: makeAnchor({ toSeq: 44, retainUntil: null }) }, expect: { checks: { finality: I() } }, assumptions: ["A2"] });
addNegative("N-F08", { base: "P14", spec: [SPEC.verifierFinality], title: "finality anchored with anchor.status not flushed",
  build: { anchor: makeAnchor({ toSeq: 44, status: "pending" }) }, expect: { checks: { finality: I() } }, assumptions: ["A2"] });
addNegative("N-F09", { base: "P15", spec: [SPEC.verifierFinality], title: "finality anchored_unverified_destination with anchor.status not flushed",
  build: { anchor: makeAnchor({ toSeq: 42, tamperResistant: false, retainUntil: null, status: "pending" }) }, expect: { checks: { finality: I() } }, assumptions: ["A2"] });
addNegative("N-F10", { base: "P17", spec: [SPEC.verifierFinality], title: "finality anchored_finite_lock with tamperResistant false",
  build: { anchor: makeAnchor({ toSeq: 42, tamperResistant: false }) }, expect: { checks: { finality: I() } }, assumptions: ["A2"] });
addNegative("N-F11", { base: "P14", spec: [SPEC.table, SPEC.projection], title: "anchored body whose completeness.proof still says not_recorded anchor_absent",
  build: { hooks: { body: (b) => ({ ...b, completeness: { ...b.completeness, proof: { reason: "anchor_absent", status: "not_recorded" } } }) } },
  expect: { checks: { sections_projection: I("section_mismatch") }, sections: { proof: "invalid" } }, projectionConsistent: false, assumptions: ["A2"] });

// addenda
addNegative("N-A01", { base: "P09", spec: [SPEC.r35, "R5 verifier checks the chain back to factsHash"], title: "addendum 1's prevHash is not facts_hash",
  build: { addenda: [{ rows: [usageRow(EX.usage1)], prevHash: ZERO64 }, { rows: [spanRow(EX.span1, EX.trace1)] }] }, expect: { checks: { facts_addenda_chain: I() } }, assumptions: ["A4"] });
addNegative("N-A02", { base: "P09", spec: [SPEC.r15, SPEC.signedBytes], title: "addendum 2's signature does not verify",
  build: { addenda: [{ rows: [usageRow(EX.usage1)] }, { rows: [spanRow(EX.span1, EX.trace1)], signature: signB64url(K.R1, "TEST-ONLY CANARY other bytes") }] },
  expect: { checks: { facts_addenda_signatures: I() } }, authentic: { manifest: true, body: true, receipt: true, addenda: false }, assumptions: ["A4"] });
addNegative("N-A03", { base: "P09", spec: [SPEC.r35], title: "addenda numbered 1 and 3 (a gap)",
  build: { addenda: [{ rows: [usageRow(EX.usage1)] }, { rows: [spanRow(EX.span1, EX.trace1)], n: 3 }] }, expect: { checks: { facts_addenda_chain: I() } }, assumptions: ["A4"] });
addNegative("N-A04", { base: "P09", spec: [SPEC.r15, SPEC.unknownKey], title: "addendum signed by a key the trust root does not hold (RX)",
  build: { addenda: [{ rows: [usageRow(EX.usage1)], key: K.RX }, { rows: [spanRow(EX.span1, EX.trace1)] }] },
  expect: { checks: { facts_addenda_signatures: I("unknown_key") } }, authentic: { manifest: true, body: true, receipt: true, addenda: "untrusted" }, assumptions: ["A4"] });
addNegative("N-A05", { base: "P09", spec: [SPEC.signedBytes, SPEC.r15], title: "an addendum signature made over the receipt payload bytes (domain separation by v)",
  build: { addenda: [{ rows: [usageRow(EX.usage1)] }, { rows: [spanRow(EX.span1, EX.trace1)], signature: "__RECEIPT__" }],
    hooks: { body: (b) => ({ ...b, facts: { ...b.facts, addenda: b.facts.addenda.map((a) => (a.signature === "__RECEIPT__" ? { ...a, signature: b.receipt.signature } : a)) } }) } },
  expect: { checks: { facts_addenda_signatures: I() } }, authentic: { manifest: true, body: true, receipt: true, addenda: false }, assumptions: ["A4"] });

// ---------------------------------------------------------------------------
// B4.5 finality as emitted (server side, data only)
// ---------------------------------------------------------------------------

const RANK = { anchored: 4, anchored_finite_lock: 3, anchored_unverified_destination: 2, chain_signed: 1 };
const freezeAt = "2026-10-10T13:00:00.000Z";
const anchorIn = (o = {}) => ({ status: "flushed", tamperResistant: true, retainUntil: "2036-10-10T00:00:00.000Z", timestampGranted: false, ...o });
const emission = [];
const em = (id, title, input, expect, spec = [SPEC.emitted, SPEC.freezeRule]) => emission.push({ id, title, spec, input: { freezeAt, timestampMode: "optional", finiteLockFinality: "refuse", retentionEnd: "2033-10-10T12:00:00.000Z", ...input }, expect });
em("E01", "no flushed anchor, floor anchored", { anchor: null, floor: "anchored" }, { pending: "anchor_not_flushed" });
em("E02", "no flushed anchor, floor chain_signed", { anchor: null, floor: "chain_signed" }, { freeze: "chain_signed", shortOf: "anchor_not_flushed" });
em("E03", "anchor not yet flushed counts as no flushed anchor", { anchor: anchorIn({ status: "pending" }), floor: "anchored_unverified_destination" }, { pending: "anchor_not_flushed" });
em("E04", "tamper_resistant false, floor anchored", { anchor: anchorIn({ tamperResistant: false }), floor: "anchored" }, { pending: "destination_not_tamper_resistant" });
em("E05", "tamper_resistant false, floor anchored_unverified_destination", { anchor: anchorIn({ tamperResistant: false }), floor: "anchored_unverified_destination" }, { freeze: "anchored_unverified_destination", shortOf: "destination_not_tamper_resistant" });
em("E06", "tamper_resistant false, floor chain_signed: the emitted state is the strongest supported, never the floor", { anchor: anchorIn({ tamperResistant: false }), floor: "chain_signed" }, { freeze: "anchored_unverified_destination", shortOf: "destination_not_tamper_resistant" });
em("E07", "timestamps required and none granted, floor anchored", { anchor: anchorIn(), timestampMode: "required", floor: "anchored" }, { pending: "timestamp_pending" });
em("E08", "timestamps required and none granted, floor anchored_unverified_destination", { anchor: anchorIn(), timestampMode: "required", floor: "anchored_unverified_destination" }, { freeze: "anchored_unverified_destination", shortOf: "timestamp_pending" });
em("E09", "retain_until null, floor anchored", { anchor: anchorIn({ retainUntil: null }), floor: "anchored" }, { pending: "lock_not_recorded" });
em("E10", "retain_until not after the freeze time (equal), floor anchored", { anchor: anchorIn({ retainUntil: freezeAt }), floor: "anchored" }, { pending: "lock_lapsed" });
em("E11", "retain_until before the end of the evidence retention, floor anchored", { anchor: anchorIn({ retainUntil: "2030-01-01T00:00:00.000Z" }), floor: "anchored" }, { pending: "lock_shorter_than_retention" });
em("E12", "retain_until before the end of the evidence retention, floor anchored_unverified_destination", { anchor: anchorIn({ retainUntil: "2030-01-01T00:00:00.000Z" }), floor: "anchored_unverified_destination" }, { freeze: "anchored_unverified_destination", shortOf: "lock_shorter_than_retention" });
em("E13", "retain_until equal to the end of the evidence retention: anchored (only 'before' is short)", { anchor: anchorIn({ retainUntil: "2033-10-10T12:00:00.000Z" }), floor: "anchored" }, { freeze: "anchored" });
em("E14", "everything recorded, floor anchored", { anchor: anchorIn(), floor: "anchored" }, { freeze: "anchored" });
em("E15", "unbounded retention, refuse, floor anchored_unverified_destination", { anchor: anchorIn(), retentionEnd: null, floor: "anchored_unverified_destination" }, { freeze: "anchored_unverified_destination", shortOf: "retention_unbounded" });
em("E16", "unbounded retention, refuse, floor chain_signed", { anchor: anchorIn(), retentionEnd: null, floor: "chain_signed" }, { freeze: "anchored_unverified_destination", shortOf: "retention_unbounded" });
em("E17", "unbounded retention, refuse, floor anchored: pending with retention_unbounded", { anchor: anchorIn(), retentionEnd: null, floor: "anchored" }, { pending: "retention_unbounded" });
em("E18", "unbounded retention, accept, floor anchored: anchored_finite_lock freezes whatever the floor", { anchor: anchorIn(), retentionEnd: null, finiteLockFinality: "accept", floor: "anchored" }, { freeze: "anchored_finite_lock" });
em("E19", "unbounded retention, accept, floor chain_signed", { anchor: anchorIn(), retentionEnd: null, finiteLockFinality: "accept", floor: "chain_signed" }, { freeze: "anchored_finite_lock" });
em("E20", "timestamps required and granted, everything recorded", { anchor: anchorIn({ timestampGranted: true }), timestampMode: "required", floor: "anchored" }, { freeze: "anchored" });

// ---------------------------------------------------------------------------
// B4.4 required-checks rules over a verify response (abstract response shape)
// ---------------------------------------------------------------------------

const requiredDecision = ["body_version", "body_schema", "body_signature", "receipt_signature", "receipt_payload_hash", "receipt_facts_binding", "sections_projection", "chain_links", "decision_content_binding", "anchor_record", "anchor_imprint", "tsa_token", "finality"];
const bundleChecks = ["bundle_manifest_signature", "bundle_manifest_files", "bundle_subject", "bundle_email_scan"];
const ok = (name) => (name === "decision_content_binding" ? { name, result: "unverifiable", reason: "preimage_not_exported" } : name.startsWith("anchor_") || name === "tsa_token" ? { name, result: "unverifiable", reason: "anchor_absent" } : { name, result: "valid" });
const goodChecks = () => [...bundleChecks, ...requiredDecision].map(ok);
const responseRules = [];
const rr = (id, title, spec, response, conforms) => responseRules.push({ id, title, spec, response, conforms });
rr("Q01", "the B4.6 report: every required check, fixed results, outcome valid_with_unverifiable", [SPEC.required, SPEC.example], { source: "bundle", subject: "decision_bom", finality: "chain_signed", outcome: "valid_with_unverifiable", checks: goodChecks() }, true);
rr("Q02", "a non-invalid outcome missing the finality check", [SPEC.required], { source: "bundle", subject: "decision_bom", finality: "chain_signed", outcome: "valid_with_unverifiable", checks: goodChecks().filter((c) => c.name !== "finality") }, false);
rr("Q03", "decision_content_binding reported valid", [SPEC.fixed], { source: "bundle", subject: "decision_bom", finality: "chain_signed", outcome: "valid_with_unverifiable", checks: goodChecks().map((c) => (c.name === "decision_content_binding" ? { name: c.name, result: "valid" } : c)) }, false);
rr("Q04", "a Decision BOM outcome valid (impossible: decision_content_binding is always unverifiable)", [SPEC.fixed, SPEC.sectionsAgg], { source: "bundle", subject: "decision_bom", finality: "chain_signed", outcome: "valid", checks: goodChecks() }, false);
rr("Q05", "a stored source reporting bundle_manifest_signature valid", [SPEC.required], { source: "stored", subject: "decision_bom", finality: "chain_signed", outcome: "valid_with_unverifiable", checks: [...requiredDecision.map(ok), { name: "bundle_manifest_signature", result: "valid" }] }, false);
rr("Q06", "a stored source reporting the bundle checks unverifiable not_a_bundle", [SPEC.required], { source: "stored", subject: "decision_bom", finality: "chain_signed", outcome: "valid_with_unverifiable", checks: [...requiredDecision.map(ok), ...bundleChecks.map((name) => ({ name, result: "unverifiable", reason: "not_a_bundle" }))] }, true);
rr("Q07", "a bundle source reporting not_a_bundle", [SPEC.required], { source: "bundle", subject: "decision_bom", finality: "chain_signed", outcome: "valid_with_unverifiable", checks: goodChecks().map((c) => (c.name === "bundle_subject" ? { name: c.name, result: "unverifiable", reason: "not_a_bundle" } : c)) }, false);
rr("Q08", "a check reported twice without distinct non-null refs", [SPEC.required], { source: "bundle", subject: "decision_bom", finality: "chain_signed", outcome: "valid_with_unverifiable", checks: [...goodChecks(), { name: "chain_links", result: "valid" }] }, false);
rr("Q09", "a v2 receipt with receipt_facts_binding unverifiable receipt_v1_no_factsHash", [SPEC.fixed], { source: "bundle", subject: "decision_bom", receiptPayloadVersion: "v2", finality: "chain_signed", outcome: "valid_with_unverifiable", checks: goodChecks().map((c) => (c.name === "receipt_facts_binding" ? { name: c.name, result: "unverifiable", reason: "receipt_v1_no_factsHash" } : c)) }, false);
rr("Q10", "a v1 receipt with receipt_facts_binding valid", [SPEC.fixed], { source: "bundle", subject: "decision_bom", receiptPayloadVersion: "v1", finality: "chain_signed", outcome: "valid_with_unverifiable", checks: goodChecks() }, false);
rr("Q11", "anchor_absent on an anchored BOM's anchor checks", [SPEC.fixed], { source: "bundle", subject: "decision_bom", finality: "anchored", outcome: "valid_with_unverifiable", checks: goodChecks() }, false);
rr("Q12", "sections_projection reported unverifiable", [SPEC.sectionsAgg], { source: "bundle", subject: "decision_bom", finality: "chain_signed", outcome: "valid_with_unverifiable", checks: goodChecks().map((c) => (c.name === "sections_projection" ? { name: c.name, result: "unverifiable", reason: "preimage_not_exported" } : c)) }, false);
rr("Q13", "an invalid check with outcome valid_with_unverifiable (any invalid gives invalid)", [SPEC.sectionsAgg], { source: "bundle", subject: "decision_bom", finality: "chain_signed", outcome: "valid_with_unverifiable", checks: goodChecks().map((c) => (c.name === "chain_links" ? { name: c.name, result: "invalid" } : c)) }, false);
rr("Q14", "a stored ai_bom_snapshot source used for a Decision BOM", [SPEC.required, "B4.4 'Required checks': stored source names its own subject (B4C-03)"], { source: "stored", storedKind: "ai_bom_snapshot", subject: "decision_bom", finality: "chain_signed", outcome: "valid_with_unverifiable", checks: requiredDecision.map(ok) }, false);
rr("Q15", "a missing required check with outcome invalid is admissible (a response missing one can only be invalid)", [SPEC.required], { source: "bundle", subject: "decision_bom", finality: "chain_signed", outcome: "invalid", checks: [{ name: "bundle_manifest_signature", result: "invalid" }] }, true);

// ---------------------------------------------------------------------------
// assembly refusals (server side; given / expect, no bytes)
// ---------------------------------------------------------------------------

const assembly = [
  { id: "X01", spec: ["B4.4 'Freezing' item 2"], given: "receipt unsigned and no receipt key configured", expect: { status: 409, code: "bom_signing_unavailable", missingKey: "receipt" } },
  { id: "X02", spec: ["B4.4 'Freezing' item 2"], given: "receipt key configured, receipt not yet signed by the sweep", expect: { status: 409, code: "bom_anchor_pending", reason: "receipt_unsigned", retryAfter: true } },
  { id: "X03", spec: ["B4.4 'Freezing' item 2", "R15"], given: "receipt signed; an addendum present at the final recheck has no signature row; key configured", expect: { status: 409, code: "bom_anchor_pending" } },
  { id: "X04", spec: ["B4.4 'Decided here': duplicate binding bullet"], given: "one usage_events id bound in facts.rows and again in addendum 1", expect: { status: 500, code: "bom_integrity_failure", frozen: false } },
  { id: "X05", spec: ["B4.4 'Decided here': digest recheck bullet"], given: "a bound row whose stored digest does not match SHA-256 of its canonical projection", expect: { status: 500, code: "bom_integrity_failure", frozen: false } },
  { id: "X06", spec: ["B4.4 'Decided here': digest recheck bullet", "R35"], given: "addendum 2's prev_hash is not addendum 1's facts_hash", expect: { status: 500, code: "bom_integrity_failure", frozen: false } },
  { id: "X07", spec: [SPEC.table + ": principal row"], given: "facts.actors.sponsorUserId differs from the receipt's decision.userId", expect: { status: 500, code: "bom_integrity_failure" } },
  { id: "X08", spec: [SPEC.table + ": decision row"], given: "audit_log.rule_chain holds 65 entries", expect: { status: 422, code: "bom_decision_not_eligible" } },
  { id: "X09", spec: ["B4.4 'Freezing' item 4", "R10"], given: "an email shape inside the assembled body", expect: { status: 422, code: "bom_export_refused", names: "file body and the JSON path, never the value" } },
  { id: "X10", spec: [SPEC.buildOrder], given: "REGULAIT_INSTALL_ID is email-shaped at bundle build", expect: { status: 422, code: "bom_export_refused", names: "manifest.json and the JSON path, never the value" } },
  { id: "X11", spec: ["B4.4 'Freezing' item 5"], given: "a second request whose rebuilt body differs from the newest version only in id, version and supersedes", expect: { newVersion: false, returns: "the newest frozen version" } },
  { id: "X12", spec: ["B4.4 'Freezing' item 5"], given: "a late addendum signed after version 1 froze", expect: { newVersion: true, version: 2, supersedes: "version 1's id", version1Edited: false } },
  { id: "X13", spec: ["B4.4 'Freezing' item 1"], given: "two concurrent first requests", expect: { sameFrozenVersion: true } },
  { id: "X14", spec: [SPEC.emitted], given: "the emitted state, not the floor, is written into body.finality and descriptor.finality", expect: { bodyFinality: "emitted state", descriptorFinality: "emitted state" } },
];

// ---------------------------------------------------------------------------
// output
// ---------------------------------------------------------------------------

const keys = Object.values(K).map((k) => k.pub);
const out = {
  format: "regulait.b4-spec-vectors.v1",
  note: "TEST-ONLY CANARY vectors written from ADR-0189 B4.1-B4.7 text alone (ADR-0191 decision 4). Every key is derived from its published seedText (seed = SHA-256 of the UTF-8 text); no private key is stored. See README.md for the field meanings, the assumptions A1-A4 and the gaps G1-G15.",
  keys,
  verificationTime: EX.verificationTime,
  positives,
  negatives,
  finalityEmission: { ranks: RANK, vectors: emission },
  responseRules,
  assembly,
};
writeFileSync(new URL("b4-vectors.json", here), `${JSON.stringify(out, null, 1)}\n`);

// ---------------------------------------------------------------------------
// crypto-vectors.json: #312's primitive corpus, regenerated with CANARY-seeded keys
// ---------------------------------------------------------------------------

const PA = deriveKey("TEST-ONLY-CANARY-primitive-key-A", "regulait ADR-0189 B4 vectors TEST-ONLY CANARY primitive key A seed", "pinned root A");
const PB = deriveKey("TEST-ONLY-CANARY-primitive-key-B", "regulait ADR-0189 B4 vectors TEST-ONLY CANARY primitive key B seed", "pinned root B");
const spki = (k) => createPublicKey(k.privateKey).export({ type: "spki", format: "der" }).toString("base64");
const b7 = "{\"decision\":{\"seq\":7},\"v\":\"regulait.decision-bom.v1\"}";
const r2 = `{"factsHash":"${h("{\"audit_seq\":7}")}","v":"regulait.receipt.v2"}`;
const prim = (id, bytes, signer, signedBytes, pinned, valid, domain, refs, title) => ({ id, title, bytes, signatureBase64: signB64(signer, signedBytes), pinnedSpkiDerBase64: spki(pinned), pinnedKeyId: pinned.keyId, expectedPrimitiveSignatureValid: valid, expectedRecognisedBomDomain: domain, refs });
const crypto = {
  format: "regulait.b4-primitive-vectors.v2",
  note: "Adopted from PR #312 (X46 draft) and regenerated with CANARY-seeded keys. Primitive Ed25519 and v-domain fixtures only: the small objects are not schema-complete bodies; b4-vectors.json holds the route-valid bundles.",
  keys: [PA.pub, PB.pub].map(({ keyId, seedText, role, fingerprint }) => ({ keyId, seedText, role, fingerprint })),
  primitives: [
    prim("K01", b7, PA, b7, PA, true, true, ["§5", "§6"], "authentic body under pinned root A"),
    prim("K02", b7.replace(":7}", ":8}"), PA, b7, PA, false, true, ["Test strategy: Signature and binding"], "altered signed bytes"),
    prim("K03", b7, PA, b7, PB, false, true, ["§6"], "authentic signature, wrong pinned key"),
    prim("K04", b7, PB, b7, PA, false, true, ["§6", "ADR-0116 §1"], "fresh signature by B, verified under original root A"),
    prim("K05", b7, PB, b7, PB, true, true, ["§6"], "the same signature under a separately supplied root B (never a bundled key)"),
    prim("K06", r2, PA, r2, PA, true, false, ["§5", "OWNER DECISION 2"], "a valid receipt v2 signature is not a BOM domain"),
    prim("K07", b7, PA, r2, PA, false, true, ["§5"], "a receipt signature presented over BOM bytes"),
    prim("K08", "{\"v\":\"regulait.decision-bom.v999\"}", PA, "{\"v\":\"regulait.decision-bom.v999\"}", PA, true, false, ["§5"], "unknown v with a valid primitive signature"),
    prim("K09", "{\"v\":\"regulait.ai-bom.v1\"}", PA, "{\"v\":\"regulait.ai-bom.v1\"}", PA, true, true, ["R19"], "AI BOM v domain"),
    prim("K10", b7, PA, `${b7}\n`, PA, false, true, ["§5", "B4.1 Files: no trailing newline"], "signature over the bytes plus a trailing newline"),
  ],
  facts: { canonicalBytes: "{\"audit_seq\":7}", sha256: h("{\"audit_seq\":7}"), nonCanonicalBytes: "{ \"audit_seq\":7 }", nonCanonicalSha256: h("{ \"audit_seq\":7 }"), refs: ["R37", "R48"] },
  rendering: { bytes: "{\"bomFormat\":\"CycloneDX\",\"specVersion\":\"1.7\"}", sha256: h("{\"bomFormat\":\"CycloneDX\",\"specVersion\":\"1.7\"}"), utf8ByteLength: 45, mutationBytes: "{\"bomFormat\":\"CycloneDX\",\"specVersion\":\"1.6\"}", refs: ["R7", "R19"] },
};
writeFileSync(new URL("crypto-vectors.json", here), `${JSON.stringify(crypto, null, 2)}\n`);
console.log(`wrote b4-vectors.json: ${positives.length} positive, ${negatives.length} negative, ${emission.length} finality-emission, ${responseRules.length} response-rule, ${assembly.length} assembly; crypto-vectors.json: ${crypto.primitives.length} primitives`);
