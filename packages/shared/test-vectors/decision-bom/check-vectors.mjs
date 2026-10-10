#!/usr/bin/env node
/**
 * Checks the ADR-0189 B4 verifier vectors for shape and self-consistency, so a
 * vector cannot rot into one that tests nothing. It imports neither product code
 * nor the generator: node:crypto, and the pinned `canonicalize` (RFC 8785) only.
 *
 * What it proves, per vector:
 *  - keys: each public key is the one its published CANARY seed text derives;
 *  - bundles: the USTAR bytes this file writes from the entries (B4.1) have the
 *    recorded SHA-256; a positive's every layer verifies under its trust root
 *    (manifest, file list, body signature file, receipt, addenda, chain links,
 *    chain.tsv, receipt-keys.json) and its sections re-derive from the facts
 *    (B4.4); P01 equals the ADR's B4.6 fenced blocks byte for byte;
 *  - negatives: the overlay really changes the bundle (or the trust root), the
 *    signature layers it calls authentic verify and the one it breaks does not,
 *    and `projectionConsistent` is true to the bytes;
 *  - AI BOM bundles (B4.9 G12): the same, and A01 to A03 equal the ADR's
 *    `b4-ai-example:` blocks byte for byte;
 *  - expectations: every positive's outcome and cannotProve are what this
 *    file's own reading of B4.8 derives from its checks, and every negative
 *    names its failing check WITH a reason (B4.9 G9);
 *  - finality emission and response rules: a reference reading of B4.5 and of
 *    B4.4 and B4.8's required-checks and outcome rules agrees with every expectation.
 *
 *   node packages/shared/test-vectors/decision-bom/check-vectors.mjs [--vectors <path>]
 */
import assert from "node:assert/strict";
import { createHash, createPrivateKey, createPublicKey, verify } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import canonicalizeModule from "canonicalize";

const canonicalize = canonicalizeModule.default ?? canonicalizeModule;
const dir = new URL("./", import.meta.url);
const argPath = process.argv.indexOf("--vectors");
const vectorsPath = argPath > 0 ? process.argv[argPath + 1] : new URL("b4-vectors.json", dir);
const corpus = JSON.parse(readFileSync(vectorsPath, "utf8"));
const sha = (b) => createHash("sha256").update(b).digest("hex");
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const SPKI = Buffer.from("302a300506032b6570032100", "hex");
const PKCS8 = Buffer.from("302e020100300506032b657004220420", "hex");
let count = 0;
const failures = [];
const check = (name, fn) => {
  try {
    fn();
    count++;
  } catch (e) {
    failures.push(`${name}: ${String(e.message).split("\n")[0]}`);
  }
};

// ---------------------------------------------------------------------------
// vocabulary (ADR-0189 B4.3, B4.4, B4.5)
// ---------------------------------------------------------------------------

const CHECKS = new Set([
  "bundle_manifest_signature", "bundle_manifest_files", "bundle_subject", "bundle_email_scan",
  "body_version", "body_schema", "body_signature", "receipt_signature", "receipt_payload_hash", "receipt_facts_binding",
  "sections_projection", "chain_links", "decision_content_binding", "anchor_record", "anchor_imprint", "tsa_token", "finality",
  "facts_addenda_chain", "facts_addenda_signatures", "ai_bom_link", "rendering_hashes", "serial_number", "supersedes",
]);
/** contract-b4.ts BOM_VERIFY_INVALID_REASONS plus B4.10's v2_receipt_before_boundary */
const INVALID_REASONS = new Set([
  "signature_mismatch", "unknown_key", "unknown_body_version", "schema_violation", "hash_mismatch", "manifest_mismatch", "subject_mismatch",
  "facts_hash_mismatch", "v1_receipt_after_boundary", "v2_receipt_before_boundary", "addendum_chain_break", "section_mismatch", "chain_break",
  "anchor_record_incomplete", "anchor_mismatch", "timestamp_invalid", "rendering_not_in_body", "serial_mismatch", "supersedes_mismatch",
  "bom_link_mismatch", "email_shape", "bundle_unreadable",
]);
const UNVERIFIABLE_REASONS = new Set([
  "preimage_not_exported", "receipt_v1_no_factsHash", "request_facts_not_recorded", "no_timestamp_token", "no_tsa_trust_bundle", "anchor_absent",
  "snapshot_not_in_bundle", "earlier_snapshot_not_in_bundle", "rendering_not_producible", "not_a_bundle",
]);
/** B4.8 (outcomes as amended by B4.10): valid, unverifiable, invalid */
const OUTCOMES = new Set(["valid", "unverifiable", "invalid", "not_run"]);
const FINALITY = new Set(["anchored", "anchored_finite_lock", "anchored_unverified_destination", "chain_signed", "anchored_lapsed"]);
const SECTIONS = ["action", "actors", "approval", "cost", "decision", "model", "outcome", "policy", "principal", "proof", "receipt", "trace"];

/** ADR-0189 B4.9 G14: an email shape, as the spec states it (a linear scan) */
const LOCAL = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]$/;
const LABEL = /^[A-Za-z0-9-]$/;
function hasEmailShape(text) {
  for (let at = text.indexOf("@"); at !== -1; at = text.indexOf("@", at + 1)) {
    if (at === 0 || !LOCAL.test(text[at - 1])) continue;
    let i = at + 1;
    while (i < text.length && LABEL.test(text[i])) i++;
    if (i > at + 1 && text[i] === "." && i + 1 < text.length && LABEL.test(text[i + 1])) return true;
  }
  return false;
}

/** ADR-0189 B4.8: by-design unverifiable results, the outcome rule and the exact cannotProve list */
function byDesign(check, r, ctx) {
  if (r.result !== "unverifiable") return false;
  if (check.startsWith("bundle_")) return r.reason === "not_a_bundle" && ctx.source !== "bundle";
  if (ctx.subject === "decision-bom") {
    return (check === "decision_content_binding" && r.reason === "preimage_not_exported")
      || (check === "receipt_facts_binding" && r.reason === "receipt_v1_no_factsHash" && ctx.receiptPayloadVersion === "v1")
      || (["anchor_record", "anchor_imprint", "tsa_token"].includes(check) && r.reason === "anchor_absent" && ctx.recordedFinality === "chain_signed");
  }
  return check === "supersedes" && r.reason === "earlier_snapshot_not_in_bundle" && ctx.source === "bundle" && ctx.version > 1;
}
function outcomeFor(results, ctx) {
  if (results.some(([, r]) => r.result === "invalid")) return "invalid";
  return results.some(([n, r]) => r.result === "unverifiable" && !byDesign(n, r, ctx)) ? "unverifiable" : "valid";
}
const CANNOT_PROVE = [
  "nothing_omitted_after_anchor", "facts_true", "signing_time_beyond_anchor", "destination_tamper_resistant", "decision_row_content",
  "commitment_after_retain_until", "facts_recorded_at_decision_time", "finite_lock_under_unbounded_retention", "external_commitment", "superseded_snapshot",
];
function cannotProveFor(ctx) {
  const want = ctx.subject === "decision-bom"
    ? ["nothing_omitted_after_anchor", "facts_true", "signing_time_beyond_anchor", "destination_tamper_resistant", "decision_row_content",
      ...(ctx.receiptPayloadVersion === "v1" ? ["facts_recorded_at_decision_time"] : []),
      ...(ctx.reportedFinality === "anchored_lapsed" ? ["commitment_after_retain_until"] : []),
      ...(ctx.recordedFinality === "anchored_finite_lock" ? ["finite_lock_under_unbounded_retention"] : []),
      ...(ctx.recordedFinality === "chain_signed" ? ["external_commitment"] : [])]
    : ["facts_true", "signing_time_beyond_anchor", ...(ctx.source === "bundle" && ctx.version > 1 ? ["superseded_snapshot"] : [])];
  return CANNOT_PROVE.filter((c) => want.includes(c));
}

/** B1's projection column lists (contract.ts:328-363), as B4.9 G2 restates the two approval tables */
const PROJECTION_COLUMNS = {
  approvals: ["id", "objectType", "serverId", "toolName", "ruleId", "connectorId", "projectId", "approverUserId", "namedApproverUserId", "approverRoleId", "status", "requestedAt", "decidedBy", "decidedAt", "argumentsDigest", "contextDigest", "approvalScope", "quorum", "signatureMode", "expiresAt"],
  approval_decisions: ["id", "approvalId", "deciderUserId", "principalUserId", "decision", "stepUpMethod", "credentialId", "signedDigest", "counterBefore", "decidedAt"],
  usage_events: ["id", "at", "userId", "objectType", "agentId", "requestedAgentId", "connectorId", "operation", "provider", "model", "servedModel", "inputTokens", "outputTokens", "costUsd", "refusal", "projectId", "configVersionId", "configVersion", "configCanary", "agentConfigVersionId", "agentConfigVersion", "actorIdentityId", "delegationGrantId"],
  trace_spans: ["id", "traceId", "parentSpanId", "seq", "kind", "status", "startedAt", "endedAt", "durationMs", "usageEventId", "auditLogId", "agentId", "mcpServerId", "connectorId", "provider", "model", "inputTokens", "outputTokens", "costUsd", "contentWithheld", "actorIdentityId", "delegationGrantId"],
};
/** B4.9 G4: decisionBomAnchorSchema's keys */
const ANCHOR_KEYS = ["destination", "externalRef", "flushedAt", "id", "observationMode", "observedAt", "record", "retainUntil", "status", "tamperResistant", "tsa"];
/** B4.9 G3: decisionFactsAddendumSchema's keys */
const ADDENDUM_KEYS = ["auditId", "n", "postActionVerification", "prev", "rows", "v"];

/** amendment 5: the AI BOM serial number (contract.ts:191-199, as B4.9 G12 cites it) */
function aiBomSerial(id) {
  const x = createHash("sha256").update(`regulait:ai-bom:${id.toLowerCase()}`, "utf8").digest();
  x[6] = (x[6] & 0x0f) | 0x80;
  x[8] = (x[8] & 0x3f) | 0x80;
  const s = x.subarray(0, 16).toString("hex");
  return `urn:uuid:${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
}

// ---------------------------------------------------------------------------
// keys
// ---------------------------------------------------------------------------

const pubFromSeedText = (seedText) => createPublicKey(createPrivateKey({ key: Buffer.concat([PKCS8, createHash("sha256").update(seedText, "utf8").digest()]), format: "der", type: "pkcs8" }));
for (const k of corpus.keys) {
  check(`key ${k.keyId} derives from its CANARY seed text`, () => {
    assert.ok(k.keyId.includes("CANARY") && k.seedText.includes("CANARY"));
    const pub = pubFromSeedText(k.seedText);
    assert.equal(pub.export({ format: "jwk" }).x, k.jwk.x);
    assert.equal(pub.export({ type: "spki", format: "pem" }).toString(), k.publicKeyPem);
    assert.equal(k.fingerprint, `sha256:${sha(Buffer.concat([SPKI, Buffer.from(k.jwk.x, "base64url")]))}`);
    assert.equal(k.fingerprint, `sha256:${sha(pub.export({ type: "spki", format: "der" }))}`);
  });
}

// ---------------------------------------------------------------------------
// USTAR writer (B4.1 "Tar order and headers"), independent of the generator
// ---------------------------------------------------------------------------

function tarOf(entries) {
  const parts = [];
  for (const e of entries) {
    const body = Buffer.from(e.text ?? "", "utf8");
    const header = Buffer.alloc(512);
    let [prefix, name] = ["", e.name];
    if (Buffer.byteLength(name) > 99) {
      const at = name.lastIndexOf("/", 154);
      [prefix, name] = [name.slice(0, at), name.slice(at + 1)];
    }
    const size = e.type === "file" ? body.length : 0;
    const put = (off, s) => header.write(s, off, "latin1");
    header.write(name, 0, "utf8");
    put(100, "0000644\0");
    put(108, "0000000\0");
    put(116, "0000000\0");
    put(124, `${size.toString(8).padStart(11, "0")}\0`);
    put(136, "00000000000\0");
    put(148, "        ");
    put(156, { file: "0", directory: "5", symlink: "2" }[e.type]);
    if (e.linkname) header.write(e.linkname, 157, "utf8");
    put(257, "ustar\0");
    put(263, "00");
    if (prefix) header.write(prefix, 345, "utf8");
    let sum = 0;
    for (const b of header) sum += b;
    put(148, `${sum.toString(8).padStart(6, "0")}\0 `);
    parts.push(header);
    if (size) parts.push(body, Buffer.alloc((512 - (size % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// trust roots (B4.2 "Finding the key")
// ---------------------------------------------------------------------------

const spkiFingerprint = (pem) => `sha256:${sha(createPublicKey(pem).export({ type: "spki", format: "der" }))}`;
/** the one trusted export public key for a key id, or null (unknown_key, or a keyring refused at load) */
function exportKeyFor(trust, keyId, bundledPem) {
  const t = trust.export;
  if (t.pinnedFingerprints) return bundledPem && t.pinnedFingerprints.includes(spkiFingerprint(bundledPem)) ? bundledPem : null; // ADR-0116 --fingerprint
  if (t.keyring.some((e) => e.fingerprint && e.fingerprint !== spkiFingerprint(e.publicKeyPem))) return null;
  const pems = new Set(t.keyring.filter((e) => e.keyId === keyId).map((e) => e.publicKeyPem));
  if (t.ownKey && t.ownKey.keyId === keyId) pems.add(t.ownKey.publicKeyPem);
  return pems.size === 1 ? [...pems][0] : null;
}
/** the one trusted receipt JWK for a key id, or null */
function receiptKeyFor(trust, keyId, receiptKeysFile) {
  const t = trust.receipt;
  if (t.pinnedFingerprints) {
    const entry = receiptKeysFile.keys.find((k) => k.keyId === keyId);
    if (!entry) return null;
    return t.pinnedFingerprints.includes(`sha256:${sha(Buffer.concat([SPKI, Buffer.from(entry.jwk.x, "base64url")]))}`) ? entry.jwk : null;
  }
  const xs = new Set(t.keyring.keys.filter((k) => k.keyId === keyId).map((k) => k.jwk.x));
  return xs.size === 1 ? { crv: "Ed25519", kty: "OKP", x: [...xs][0] } : null;
}
const boundaryOf = (trust) => (trust.receipt.keyring ? trust.receipt.keyring.receiptV2FromAuditSeq : trust.receipt.receiptV2FromAuditSeq);

const B64URL86 = /^[A-Za-z0-9_-]{86}$/;
const B64STD88 = /^[A-Za-z0-9+/]{86}==$/;
/** "true" | "false" | "untrusted" | "encoding" for one signature layer */
function layer(trustedKey, bytes, sigText, encoding) {
  if (!trustedKey) return "untrusted";
  if (!encoding) return "encoding";
  try {
    return verify(null, Buffer.from(bytes, "utf8"), createPublicKey(trustedKey), Buffer.from(sigText, encoding === "std" ? "base64" : "base64url")) ? "true" : "false";
  } catch {
    return "false";
  }
}
const urlEnc = (s) => (B64URL86.test(s) ? "url" : false);

// ---------------------------------------------------------------------------
// B4.4 projection (this checker's own reading)
// ---------------------------------------------------------------------------

function decimalSum(list) {
  const terms = list.map((s) => {
    const m = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/.exec(s);
    assert.ok(m, `R23 decimal ${s}`);
    const f = m[2] ?? "";
    return [BigInt(m[1] + f), f.length - Number(m[3] ?? 0)];
  });
  const scale = Math.max(0, ...terms.map(([, sc]) => sc));
  const total = terms.reduce((acc, [v, sc]) => acc + v * 10n ** BigInt(scale - sc), 0n).toString().padStart(scale + 1, "0");
  const int = total.slice(0, total.length - scale);
  let frac = total.slice(total.length - scale);
  while (frac.endsWith("0")) frac = frac.slice(0, -1);
  return frac ? `${int}.${frac}` : int;
}

function project(body) {
  const receipt = JSON.parse(body.receipt.payload);
  const facts = body.facts.payload === null ? null : JSON.parse(body.facts.payload);
  const adds = body.facts.addenda.map((a) => JSON.parse(a.payload));
  const d = receipt.decision;
  const bound = facts ? [...facts.rows, ...adds.flatMap((a) => a.rows)] : [];
  // B4.9 G15: a usage event or span bound twice has no valid projection
  const once = bound.filter((r) => r.table === "usage_events" || r.table === "trace_spans").map((r) => `${r.table}\u0000${r.id}`);
  assert.equal(new Set(once).size, once.length, "a usage event or span is bound once");
  // B4.3 v2 bullet (B4.9 G9: under sections_projection): the receipt's actor equals the recorded actors
  if (receipt.v === "regulait.receipt.v2" && facts?.actors) {
    assert.equal(receipt.actor.identityId, facts.actors.actorIdentityId);
    assert.equal(receipt.actor.delegationGrantId, facts.actors.delegationGrantId);
  }
  const pick = (tables) => bound.filter((r) => tables.includes(r.table));
  const approvals = pick(["approvals", "approval_decisions"]).map((r, i) => [r, i]).sort(([a, i], [b, j]) => cmp(a.table, b.table) || cmp(a.id, b.id) || i - j).map(([r]) => ({ digest: r.digest, id: r.id, projection: r.projection, table: r.table }));
  const usage = pick(["usage_events"]).sort((a, b) => cmp(a.id, b.id));
  const spans = pick(["trace_spans"]).sort((a, b) => cmp(a.id, b.id));
  const costs = usage.map((u) => u.projection.costUsd);
  // a v1 receipt cannot tell pre_facts from capture_off, so the body's reason is accepted (B4.4 'no facts')
  const reason = receipt.v === "regulait.receipt.v2" ? (receipt.factsStatus === "capture_off" ? "capture_off" : "pre_facts") : body.completeness.action?.reason;
  const gap = { reason, status: "not_recorded" };
  const rec = { status: "recorded" };
  const nr = (r) => ({ reason: r, status: "not_recorded" });
  const fact = (v, r) => (facts === null ? gap : v === null ? nr(r) : rec);
  const rows = (list) => (facts === null ? gap : list.length ? rec : nr("no_bound_row"));
  return {
    sections: {
      decision: {
        at: d.at, auditSeq: receipt.audit.seq, effect: d.effect, objectId: d.objectId !== null && d.objectId.length <= 256 ? d.objectId : null,
        objectType: d.objectType, ruleChain: body.decision.ruleChain, ruleId: d.ruleId,
        serverId: d.serverId !== null && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(d.serverId) ? d.serverId : null, toolName: d.toolName,
      },
      principal: { sponsorUserId: d.userId },
      actors: facts?.actors ?? null, action: facts?.action ?? null, policy: facts?.policy ?? null, model: facts?.model ?? null, outcome: facts?.outcome ?? null,
      approval: approvals.length ? approvals : null,
      cost: usage.length ? {
        costSource: "usage_events.cost_usd", costUsd: costs.includes(null) ? null : costs.length === 1 ? costs[0] : decimalSum(costs),
        inputTokens: usage.reduce((s, u) => s + u.projection.inputTokens, 0), outputTokens: usage.reduce((s, u) => s + u.projection.outputTokens, 0), usageEventIds: usage.map((u) => u.id),
      } : null,
      trace: spans.length ? { spanIds: spans.map((s) => s.id), traceIds: [...new Set(spans.map((s) => s.projection.traceId))].sort(cmp) } : null,
      // B4.9 G13: basis is recomputed too
      basis: { aiBomSnapshotId: facts?.model?.aiBomSnapshotId ?? null, anchorId: body.proof.anchor ? body.proof.anchor.id : null, auditSeq: body.proof.chain.at(-1).seq, receiptSeq: body.receipt.receiptSeq },
    },
    completeness: {
      action: fact(facts?.action ?? null, "not_captured_by_path"),
      actors: fact(facts?.actors ?? null, "pre_identity"),
      approval: rows(approvals), cost: rows(usage), decision: rec,
      model: fact(facts?.model ?? null, "not_captured_by_path"), outcome: fact(facts?.outcome ?? null, "not_captured_by_path"),
      policy: fact(facts?.policy ?? null, "not_captured_by_path"), principal: rec,
      proof: body.proof.anchor === null ? nr("anchor_absent") : rec, receipt: rec, trace: rows(spans),
    },
  };
}
function projectionHolds(body) {
  try {
    const p = project(body);
    for (const [k, v] of Object.entries(p.sections)) if (canonicalize(body[k]) !== canonicalize(v)) return false;
    return canonicalize(body.completeness) === canonicalize(p.completeness);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// bundles
// ---------------------------------------------------------------------------

const positives = new Map(corpus.positives.map((p) => [p.id, p]));
function entriesOf(v) {
  if (v.bundle.entries) return v.bundle.entries;
  const replace = v.bundle.replace ?? {};
  return positives.get(v.bundle.base).bundle.entries.map((e) => (e.name in replace ? { ...e, text: replace[e.name] } : e));
}
/** the root that holds manifest.json (a malformed archive may have entries under another root) */
const rootOf = (entries) => {
  const m = entries.find((e) => e.name.endsWith("/manifest.json")) ?? entries[0];
  return m.name.slice(0, m.name.indexOf("/"));
};
function filesOf(entries) {
  const root = rootOf(entries);
  return new Map(entries.filter((e) => e.type === "file" && e.name.startsWith(`${root}/`)).map((e) => [e.name.slice(root.length + 1), e.text]));
}

/** every signature layer of a Decision BOM bundle under its trust root */
function layers(files, trust) {
  const manifestText = files.get("manifest.json");
  const manifest = JSON.parse(manifestText);
  const sigText = files.get("manifest.json.sig") ?? "";
  const mEnc = sigText.endsWith("\n") && B64STD88.test(sigText.slice(0, -1)) ? "std" : false;
  const rk = JSON.parse(files.get("receipt-keys.json"));
  const bodyText = files.get("content/decision-bom.json");
  const body = JSON.parse(bodyText);
  const sigFile = JSON.parse(files.get("content/decision-bom.json.sig"));
  const jwk = (k) => k && { key: k, format: "jwk" };
  const out = {
    manifest: layer(exportKeyFor(trust, manifest.signingKeyId, files.get("signing-key.pub")), manifestText, sigText.slice(0, -1), mEnc),
    body: layer(jwk(receiptKeyFor(trust, sigFile.keyId, rk)), bodyText, sigFile.signature, urlEnc(sigFile.signature)),
    receipt: layer(jwk(receiptKeyFor(trust, body.receipt.keyId, rk)), body.receipt.payload, body.receipt.signature, urlEnc(body.receipt.signature)),
    addenda: "none",
  };
  if (files.has("content/ai-bom.json")) {
    const s = JSON.parse(files.get("content/ai-bom.json.sig"));
    out.aiBom = layer(jwk(receiptKeyFor(trust, s.keyId, rk)), files.get("content/ai-bom.json"), s.signature, urlEnc(s.signature));
  }
  if (body.facts.addenda.length) {
    const each = body.facts.addenda.map((a) => layer(jwk(receiptKeyFor(trust, a.keyId, rk)), a.payload, a.signature, urlEnc(a.signature)));
    out.addenda = each.every((x) => x === "true") ? "true" : each.includes("untrusted") ? "untrusted" : "false";
  }
  return { out, manifest, body, sigFile, rk };
}
const asFlag = (x) => (x === true ? "true" : x === false ? "false" : x);

const FILES = ["README.txt", "audit/chain.tsv", "content/decision-bom.json", "content/decision-bom.json.sig", "manifest.json", "manifest.json.sig", "receipt-keys.json", "signing-key.pub"];

function checkPositiveBundle(v) {
  const entries = v.bundle.entries;
  const files = filesOf(entries);
  const root = rootOf(entries);
  const { out, manifest, body, sigFile, rk } = layers(files, v.trust);
  assert.deepEqual(out, { manifest: "true", body: "true", receipt: "true", addenda: asFlag(v.authentic.addenda), ...("aiBom" in v.authentic ? { aiBom: "true" } : {}) }, "every layer verifies");
  // B4.1 layout
  assert.equal(root, `regulait-export-decision-bom-${body.auditId}-v${body.version}`);
  assert.deepEqual(entries.map((e) => e.name), entries.map((e) => e.name).sort(cmp), "entries sorted by full name");
  assert.ok(entries.every((e) => e.type === "file" && e.name.startsWith(`${root}/`)), "regular files under one root");
  const linkedFiles = files.has("content/ai-bom.json") ? ["content/ai-bom.json", "content/ai-bom.json.sig"] : [];
  const fileSet = [...FILES, ...linkedFiles].sort(cmp);
  assert.deepEqual([...files.keys()].sort(cmp), fileSet);
  for (const p of ["manifest.json", "content/decision-bom.json", "content/decision-bom.json.sig", "receipt-keys.json"]) assert.equal(canonicalize(JSON.parse(files.get(p))), files.get(p), `${p} canonical, no trailing newline`);
  // the manifest
  assert.equal(manifest.schema, "regulait.export-bundle/3");
  assert.deepEqual(manifest.files, fileSet.filter((p) => !p.startsWith("manifest.json")).map((path) => ({ path, sha256: sha(Buffer.from(files.get(path), "utf8")) })));
  assert.equal(manifest.signingKeyFingerprint, spkiFingerprint(files.get("signing-key.pub")));
  assert.equal(manifest.subject.id, body.auditId);
  assert.equal(manifest.subject.kind, "decision-bom");
  const desc = manifest.subject.descriptor;
  assert.deepEqual(desc, { aiBomSnapshotId: body.basis.aiBomSnapshotId, auditId: body.auditId, bodySha256: sha(files.get("content/decision-bom.json")), bomId: body.id, finality: body.finality, formats: [], receiptSeq: body.receipt.receiptSeq, version: body.version });
  assert.deepEqual(manifest.audit, { payloadScope: "none", segmentFromSeq: body.proof.chain[0].seq, segmentRowCount: body.proof.chain.length, segmentToSeq: body.proof.chain.at(-1).seq });
  assert.equal(manifest.installId === null, manifest.installIdSource === "absent");
  assert.ok(entries.every((e) => !hasEmailShape(e.text)), "no email shape anywhere (B4.9 G14)");
  // the signature file
  assert.deepEqual(Object.keys(sigFile), ["alg", "keyId", "signature", "signedSha256"]);
  assert.equal(sigFile.alg, "Ed25519");
  assert.equal(sigFile.signedSha256, desc.bodySha256);
  // the receipt (B4.3)
  const payload = JSON.parse(body.receipt.payload);
  assert.equal(canonicalize(payload), body.receipt.payload);
  assert.equal(sha(body.receipt.payload), body.receipt.payloadHash);
  assert.equal(payload.keyId, body.receipt.keyId);
  assert.equal(payload.receiptSeq, body.receipt.receiptSeq);
  assert.deepEqual(payload.audit, { contentHash: body.proof.chain[0].contentHash, id: body.auditId, rowHash: body.proof.chain[0].rowHash, seq: body.decision.auditSeq });
  const boundary = boundaryOf(v.trust);
  if (payload.v === "regulait.receipt.v2") {
    assert.equal(v.expect.receiptPayloadVersion, "v2");
    if (payload.factsStatus === "capture_off") assert.ok(payload.factsHash === null && body.facts.payload === null);
    else assert.equal(payload.factsHash, sha(body.facts.payload));
    assert.ok(boundary !== null && body.decision.auditSeq >= boundary, "a v2 receipt needs a recorded boundary at or below its seq (B4.9 G10)");
    assert.deepEqual(v.expect.checks.receipt_facts_binding, { result: "valid" });
    if (body.actors) {
      assert.equal(payload.actor.identityId, body.actors.actorIdentityId);
      assert.equal(payload.actor.delegationGrantId, body.actors.delegationGrantId);
    }
  } else {
    assert.equal(payload.v, "regulait.receipt.v1");
    assert.equal(v.expect.receiptPayloadVersion, "v1");
    assert.ok(boundary === null || body.decision.auditSeq < boundary);
    assert.deepEqual(v.expect.checks.receipt_facts_binding, { reason: "receipt_v1_no_factsHash", result: "unverifiable" });
  }
  // the addendum chain (R35) and row digests (R5, R18)
  let prev = body.facts.payload === null ? null : sha(body.facts.payload);
  body.facts.addenda.forEach((a, i) => {
    assert.equal(a.n, i + 1);
    assert.equal(a.prevHash, prev);
    const ap = JSON.parse(a.payload);
    assert.deepEqual(Object.keys(ap).sort(cmp), ADDENDUM_KEYS, "addendum payload keys (B4.9 G3)");
    assert.ok(ap.n === a.n && ap.prev === a.prevHash && ap.auditId === body.auditId, "addendum n, prev and auditId agree (B4.9 G3)");
    assert.equal(ap.v, "regulait.decision-facts-addendum.v1");
    assert.equal(canonicalize(JSON.parse(a.payload)), a.payload);
    prev = sha(a.payload);
  });
  const facts = body.facts.payload === null ? null : JSON.parse(body.facts.payload);
  if (facts) assert.equal(canonicalize(facts), body.facts.payload);
  for (const r of facts ? [...facts.rows, ...body.facts.addenda.flatMap((a) => JSON.parse(a.payload).rows)] : []) {
    assert.equal(r.digest, sha(canonicalize({ projection: r.projection, table: r.table })), "row digest (B4.9 G1)");
    assert.deepEqual(Object.keys(r.projection).sort(cmp), [...PROJECTION_COLUMNS[r.table]].sort(cmp), `${r.table} projection is the B1 column list (B4.9 G2)`);
  }
  // the chain (§6) and chain.tsv
  body.proof.chain.forEach((r, i) => {
    assert.equal(r.rowHash, sha(`${r.prevHash}${r.contentHash}`));
    if (i) assert.equal(r.prevHash, body.proof.chain[i - 1].rowHash);
    assert.equal(r.seq, body.proof.chain[0].seq + i);
  });
  assert.equal(files.get("audit/chain.tsv"), body.proof.chain.map((c) => `${c.seq}\t${c.contentHash}\t${c.prevHash}\t${c.rowHash}\n`).join(""));
  // receipt-keys.json: one entry per distinct key id named, sorted, fingerprints by rule
  assert.deepEqual(rk.keys.map((k) => k.keyId), [...new Set([sigFile.keyId, body.receipt.keyId, ...body.facts.addenda.map((a) => a.keyId)])].sort(cmp));
  for (const k of rk.keys) assert.equal(k.fingerprint, `sha256:${sha(Buffer.concat([SPKI, Buffer.from(k.jwk.x, "base64url")]))}`);
  // anchor (R1) and finality (B4.5, structural)
  const a = body.proof.anchor;
  assert.equal(body.finality === "chain_signed", a === null);
  if (a) {
    assert.deepEqual(Object.keys(a).sort(cmp), ANCHOR_KEYS, "proof.anchor keys (B4.9 G4)");
    assert.deepEqual(Object.keys(a.record).sort(cmp), ["algorithm", "capturedAt", "headAt", "payloadVersion", "rowHash", "seq"]);
    assert.equal(a.record.seq, body.proof.chain.at(-1).seq);
    assert.equal(a.record.rowHash, body.proof.chain.at(-1).rowHash);
    assert.equal(a.status, "flushed");
    const strong = body.finality === "anchored" || body.finality === "anchored_finite_lock";
    if (strong) assert.ok(a.tamperResistant === true && a.retainUntil !== null);
    const lapsed = strong && !(Date.parse(a.retainUntil) > Date.parse(v.trust.verificationTime));
    assert.equal(v.expect.reportedFinality, lapsed ? "anchored_lapsed" : body.finality);
  } else assert.equal(v.expect.reportedFinality, "chain_signed");
  assert.equal(v.expect.recordedFinality, body.finality);
  assert.deepEqual(body.basis, { aiBomSnapshotId: facts?.model?.aiBomSnapshotId ?? null, anchorId: a ? a.id : null, auditSeq: body.proof.chain.at(-1).seq, receiptSeq: body.receipt.receiptSeq });
  // the linked AI BOM (B4.9): carried with its signature file, or reported snapshot_not_in_bundle
  const link = body.basis.aiBomSnapshotId;
  if (files.has("content/ai-bom.json")) {
    const ai = JSON.parse(files.get("content/ai-bom.json"));
    assert.equal(ai.snapshot.id, link);
    assert.equal(JSON.parse(files.get("content/ai-bom.json.sig")).signedSha256, sha(files.get("content/ai-bom.json")));
    assert.deepEqual(v.expect.checks.ai_bom_link, { result: "valid" });
  } else assert.deepEqual(v.expect.checks.ai_bom_link, link === null ? "absent" : { reason: "snapshot_not_in_bundle", result: "unverifiable" });
  // sections (B4.4)
  assert.ok(projectionHolds(body), "sections and completeness re-derive from the facts and the receipt");
  assert.deepEqual(Object.keys(body.completeness), SECTIONS);
  // the expected checks agree with what the bundle holds
  const c = v.expect.checks;
  assert.equal(c.facts_addenda_chain === "absent", body.facts.addenda.length === 0);
  assert.equal(c.anchor_record?.reason === "anchor_absent", a === null);
  if (a && a.tsa === null) for (const n of ["anchor_imprint", "tsa_token"]) assert.deepEqual(c[n], { reason: "no_timestamp_token", result: "unverifiable" }, `${n} with no token (B4.9 G5)`);
  assert.deepEqual(c.decision_content_binding, { reason: "preimage_not_exported", result: "unverifiable" });
  // B4.8: the outcome and cannotProve follow from the checks and the bundle
  const ctx = { subject: "decision-bom", source: "bundle", receiptPayloadVersion: v.expect.receiptPayloadVersion, recordedFinality: body.finality, reportedFinality: v.expect.reportedFinality };
  assert.equal(v.expect.outcome, outcomeFor(Object.entries(c).filter(([, r]) => r !== "absent"), ctx), "outcome (B4.8)");
  assert.deepEqual(v.expect.cannotProve, cannotProveFor(ctx), "cannotProve (B4.8)");
}

/** an AI BOM bundle (B4.9 G12) */
const AI_FORMATS = ["native", "cyclonedx-1.7", "cyclonedx-1.6", "spdx-3.0.1"];
function aiLayers(files, trust) {
  const manifestText = files.get("manifest.json");
  const manifest = JSON.parse(manifestText);
  const sigText = files.get("manifest.json.sig") ?? "";
  const mEnc = sigText.endsWith("\n") && B64STD88.test(sigText.slice(0, -1)) ? "std" : false;
  const rk = JSON.parse(files.get("receipt-keys.json"));
  const sigFile = JSON.parse(files.get("content/ai-bom.json.sig"));
  const key = receiptKeyFor(trust, sigFile.keyId, rk);
  return {
    out: {
      manifest: layer(exportKeyFor(trust, manifest.signingKeyId, files.get("signing-key.pub")), manifestText, sigText.slice(0, -1), mEnc),
      body: layer(key && { key, format: "jwk" }, files.get("content/ai-bom.json"), sigFile.signature, urlEnc(sigFile.signature)),
    },
    manifest, sigFile, rk,
  };
}
function checkAiPositive(v) {
  const entries = v.bundle.entries;
  const files = filesOf(entries);
  const root = rootOf(entries);
  const { out, manifest, sigFile, rk } = aiLayers(files, v.trust);
  assert.deepEqual(out, { manifest: "true", body: "true" }, "every layer verifies");
  const bodyText = files.get("content/ai-bom.json");
  const body = JSON.parse(bodyText);
  assert.equal(canonicalize(body), bodyText);
  assert.equal(body.v, "regulait.ai-bom.v1");
  const carried = [...files.keys()].filter((p) => /^content\/ai-bom\.[a-z0-9.-]+\.json$/.test(p) && p !== "content/ai-bom.json.sig").map((p) => p.slice("content/ai-bom.".length, -".json".length));
  const formats = AI_FORMATS.filter((f) => f === "native" || carried.includes(f));
  assert.equal(root, `regulait-export-ai-bom-${body.snapshot.id}-${formats.length === 1 ? "native" : formats[1]}`);
  assert.ok(entries.every((e) => e.type === "file" && e.name.startsWith(`${root}/`)), "regular files under one root");
  const fileSet = ["README.txt", "content/ai-bom.json", "content/ai-bom.json.sig", ...carried.map((f) => `content/ai-bom.${f}.json`), "manifest.json", "manifest.json.sig", "receipt-keys.json", "signing-key.pub"].sort(cmp);
  assert.deepEqual([...files.keys()].sort(cmp), fileSet);
  assert.deepEqual(manifest.files, fileSet.filter((p) => !p.startsWith("manifest.json")).map((path) => ({ path, sha256: sha(Buffer.from(files.get(path), "utf8")) })));
  assert.equal(manifest.audit, null);
  assert.equal(manifest.subject.kind, "ai-bom");
  assert.equal(manifest.subject.id, body.snapshot.id);
  const s = body.snapshot;
  assert.deepEqual(manifest.subject.descriptor, { bodySha256: sha(bodyText), formats, serialNumber: body.serialNumber, snapshotId: s.id, subjectId: s.subjectId, subjectKind: s.subjectKind, trigger: s.trigger, version: s.version });
  assert.equal(manifest.signingKeyFingerprint, spkiFingerprint(files.get("signing-key.pub")));
  assert.ok(entries.every((e) => !hasEmailShape(e.text)), "no email shape anywhere");
  assert.deepEqual(Object.keys(sigFile), ["alg", "keyId", "signature", "signedSha256"]);
  assert.equal(sigFile.signedSha256, sha(bodyText));
  assert.deepEqual(rk.keys.map((k) => k.keyId), [sigFile.keyId]);
  // serial number and rendering commitments
  assert.equal(body.serialNumber, aiBomSerial(s.id));
  assert.equal(s.version === 1, s.supersedes === null);
  for (const f of carried) {
    const r = body.renderings[f];
    assert.ok(r && r.status === "rendered" && r.sha256 === sha(files.get(`content/ai-bom.${f}.json`)) && r.bytes === Buffer.byteLength(files.get(`content/ai-bom.${f}.json`)), `rendering ${f} commitment`);
  }
  const c = v.expect.checks;
  assert.deepEqual(c.supersedes, s.version > 1 ? { reason: "earlier_snapshot_not_in_bundle", result: "unverifiable" } : "absent");
  assert.deepEqual(c.rendering_hashes, carried.length ? { ref: carried[0], result: "valid" } : "absent");
  const ctx = { subject: "ai-bom", source: "bundle", version: s.version };
  assert.equal(v.expect.outcome, outcomeFor(Object.entries(c).filter(([, r]) => r !== "absent"), ctx), "outcome (B4.8)");
  assert.deepEqual(v.expect.cannotProve, cannotProveFor(ctx), "cannotProve (B4.8)");
  assert.deepEqual(v.expect.identity, { serialNumber: body.serialNumber, snapshotId: s.id, subject: "ai-bom", subjectId: s.subjectId, subjectKind: s.subjectKind, version: s.version });
}

function checkAgainstAdrExample(v) {
  const lines = readFileSync(new URL("../../../../docs/decisions/0189-batch6-decision-bom-ai-bom.md", dir), "utf8").split("\n");
  const block = (name) => {
    const i = lines.indexOf(`\`\`\`text b4-example:${name}`);
    assert.ok(i >= 0, `ADR block ${name}`);
    const out = [];
    for (let j = i + 1; lines[j] !== "```"; j++) out.push(lines[j]);
    return out.join("\n");
  };
  for (const [p, text] of filesOf(v.bundle.entries)) assert.equal(block(p), text.endsWith("\n") ? text.slice(0, -1) : text, p);
  const tarLine = block("tar.sha256");
  assert.ok(tarLine.startsWith(`${v.bundle.tarSha256}  `) && tarLine.includes(`${v.bundle.tarBytes} bytes`), "tar digest");
}

for (const v of corpus.positives) {
  check(`${v.id} shape`, () => {
    assert.equal(v.polarity, "positive");
    assert.ok(v.title && v.spec.length > 0 && v.trust && v.bundle.entries.length);
    for (const [n, r] of Object.entries(v.expect.checks)) {
      assert.ok(CHECKS.has(n), n);
      assert.ok(r === "absent" || ["valid", "unverifiable"].includes(r.result), `${n} on a positive`);
      if (r !== "absent" && r.result === "unverifiable") assert.ok(UNVERIFIABLE_REASONS.has(r.reason), `${n} reason`);
    }
    assert.ok(OUTCOMES.has(v.expect.outcome) && v.expect.outcome !== "invalid");
    if (v.subject === "decision-bom") assert.ok(FINALITY.has(v.expect.reportedFinality));
  });
  check(`${v.id} tar bytes`, () => {
    const tar = tarOf(v.bundle.entries);
    assert.equal(sha(tar), v.bundle.tarSha256);
    assert.equal(tar.length, v.bundle.tarBytes);
  });
  check(`${v.id} every layer verifies and every section re-derives`, () => (v.subject === "ai-bom" ? checkAiPositive(v) : checkPositiveBundle(v)));
}
check("P01 equals the B4.6 worked example byte for byte", () => checkAgainstAdrExample(positives.get("P01")));
check("A01 to A03 carry the B4.9 AI BOM worked example byte for byte", () => {
  const lines = readFileSync(new URL("../../../../docs/decisions/0189-batch6-decision-bom-ai-bom.md", dir), "utf8").split("\n");
  const block = (name) => {
    const i = lines.indexOf(`\`\`\`text b4-ai-example:${name}`);
    assert.ok(i >= 0, `ADR block ${name}`);
    const out = [];
    for (let j = i + 1; lines[j] !== "\`\`\`"; j++) out.push(lines[j]);
    return out.join("\n");
  };
  assert.equal(filesOf(positives.get("A01").bundle.entries).get("content/ai-bom.json"), block("v1/content/ai-bom.json"));
  assert.equal(filesOf(positives.get("A02").bundle.entries).get("content/ai-bom.cyclonedx-1.7.json"), block("v1/content/ai-bom.cyclonedx-1.7.json"));
  assert.equal(filesOf(positives.get("A03").bundle.entries).get("content/ai-bom.json"), block("v2/content/ai-bom.json"));
});

for (const v of corpus.negatives) {
  check(`${v.id} shape`, () => {
    assert.equal(v.polarity, "negative");
    assert.ok(v.title && v.spec.length > 0, "names its spec paragraph");
    assert.ok(positives.has(v.bundle.base), "has a positive base");
    assert.ok(v.expect.outcome === "invalid" || v.expect.outcome === "not_run");
    if (v.expect.outcome === "invalid") assert.ok(Object.keys(v.expect.checks ?? {}).length > 0, "names its failing check (B4.9 G9)");
    for (const [n, r] of Object.entries(v.expect.checks ?? {})) {
      assert.ok(CHECKS.has(n), n);
      assert.equal(r.result, "invalid", `${n}: a negative's named checks are invalid`);
      assert.ok(INVALID_REASONS.has(r.reason), `${n}: names an invalid reason (B4.9 G9)`);
    }
  });
  check(`${v.id} mutation is real and isolated`, () => {
    const base = positives.get(v.bundle.base);
    const entries = entriesOf(v);
    const tar = tarOf(entries);
    assert.equal(sha(tar), v.bundle.tarSha256);
    assert.equal(tar.length, v.bundle.tarBytes);
    assert.ok(sha(tar) !== base.bundle.tarSha256 || canonicalize(v.trust) !== canonicalize(base.trust), "the vector differs from its base");
    const want = Object.fromEntries(Object.entries(v.authentic).map(([k, x]) => [k, asFlag(x)]));
    if (v.subject === "ai-bom") {
      assert.deepEqual(aiLayers(filesOf(entries), v.trust).out, want, "authentic layers as declared");
      return;
    }
    const { out, body } = layers(filesOf(entries), v.trust);
    assert.deepEqual(out, { addenda: "none", ...want }, "authentic layers as declared");
    assert.equal(projectionHolds(body), v.projectionConsistent, "projectionConsistent as declared");
  });
}

// ---------------------------------------------------------------------------
// B4.5 finality as emitted: a reference reading
// ---------------------------------------------------------------------------

const RANK = corpus.finalityEmission.ranks;
function emit(i) {
  const a = i.anchor;
  const at = (state, shortOf) => ({ state, shortOf });
  let s;
  if (!a || a.status !== "flushed") s = at("chain_signed", "anchor_not_flushed");
  else if (!a.tamperResistant) s = at("anchored_unverified_destination", "destination_not_tamper_resistant");
  else if (i.timestampMode === "required" && !a.timestampGranted) s = at("anchored_unverified_destination", "timestamp_pending");
  else if (a.retainUntil === null) s = at("anchored_unverified_destination", "lock_not_recorded");
  else if (!(Date.parse(a.retainUntil) > Date.parse(i.freezeAt))) s = at("anchored_unverified_destination", "lock_lapsed");
  else if (i.retentionEnd === null) s = i.finiteLockFinality === "accept" ? at("anchored_finite_lock", null) : at("anchored_unverified_destination", "retention_unbounded");
  else if (Date.parse(a.retainUntil) < Date.parse(i.retentionEnd)) s = at("anchored_unverified_destination", "lock_shorter_than_retention");
  else s = at("anchored", null);
  const freezes = s.state === "anchored_finite_lock" || RANK[s.state] >= RANK[i.floor];
  if (!freezes) return { pending: s.shortOf };
  return s.shortOf ? { freeze: s.state, shortOf: s.shortOf } : { freeze: s.state };
}
for (const e of corpus.finalityEmission.vectors) {
  check(`${e.id} finality as emitted`, () => {
    assert.ok(e.spec.length > 0);
    if (e.input.finiteLockFinality === "refuse") assert.notEqual(e.expect.freeze, "anchored_finite_lock", "never emitted under refuse");
    assert.deepEqual(emit(e.input), e.expect);
  });
}

// ---------------------------------------------------------------------------
// B4.4 required checks and aggregation: a reference reading
// ---------------------------------------------------------------------------

const REQUIRED = ["body_version", "body_schema", "body_signature", "receipt_signature", "receipt_payload_hash", "receipt_facts_binding", "sections_projection", "chain_links", "decision_content_binding", "anchor_record", "anchor_imprint", "tsa_token", "finality"];
const REQUIRED_AI = ["body_version", "body_schema", "body_signature", "serial_number"];
const BUNDLE = ["bundle_manifest_signature", "bundle_manifest_files", "bundle_subject", "bundle_email_scan"];
const ANCHOR_CHECKS = ["anchor_record", "anchor_imprint", "tsa_token"];
/** B4.4 required checks and fixed results, with B4.8's outcome, by-design and cannotProve rules (as B4.10 puts them in the contract) */
function conforms(r) {
  const by = new Map();
  for (const c of r.checks) {
    if (!CHECKS.has(c.name)) return false;
    const kindOk = c.result === "valid" ? c.reason === undefined : c.result === "invalid" ? INVALID_REASONS.has(c.reason) : UNVERIFIABLE_REASONS.has(c.reason);
    if (!kindOk) return false;
    by.set(c.name, [...(by.get(c.name) ?? []), c]);
  }
  for (const list of by.values()) if (list.length > 1 && (list.some((c) => !c.ref) || new Set(list.map((c) => c.ref)).size !== list.length)) return false;
  const sections = Object.values(r.sections ?? {});
  if (sections.includes("unverifiable")) return false; // B4.8: a section is valid or invalid in v1
  const ai = r.subject === "ai_bom";
  const ctx = { subject: ai ? "ai-bom" : "decision-bom", source: r.source, receiptPayloadVersion: r.receiptPayloadVersion, recordedFinality: r.finality, reportedFinality: r.finality, version: r.version ?? 1 };
  const outcome = sections.includes("invalid") ? "invalid" : outcomeFor(r.checks.map((c) => [c.name, c]), ctx);
  if (r.outcome !== outcome) return false;
  if (r.storedKind && r.storedKind !== r.subject) return false;
  if (canonicalize(r.cannotProve) !== canonicalize(cannotProveFor(ctx))) return false;
  const all = (n, pred) => (by.get(n) ?? []).every(pred);
  // fixed results hold on whatever is reported, whatever the outcome
  for (const n of BUNDLE) {
    if (r.source === "stored" && !all(n, (c) => c.result === "unverifiable" && c.reason === "not_a_bundle")) return false;
    if (r.source === "bundle" && !all(n, (c) => c.reason !== "not_a_bundle")) return false;
  }
  if (r.checks.some((c) => c.reason === "not_a_bundle" && !BUNDLE.includes(c.name))) return false;
  if (!ai) {
    if (!all("decision_content_binding", (c) => c.result === "unverifiable" && c.reason === "preimage_not_exported")) return false;
    const v1Reasons = ["receipt_v1_no_factsHash", "v1_receipt_after_boundary"];
    if (r.receiptPayloadVersion === "v1" && !all("receipt_facts_binding", (c) => (c.result === "unverifiable" && c.reason === "receipt_v1_no_factsHash") || (c.result === "invalid" && c.reason === "v1_receipt_after_boundary"))) return false;
    if (r.receiptPayloadVersion !== "v1" && r.checks.some((c) => v1Reasons.includes(c.reason))) return false;
    if (!all("sections_projection", (c) => c.result !== "unverifiable")) return false;
    if (r.finality === "chain_signed") {
      for (const n of ANCHOR_CHECKS) if (!all(n, (c) => c.result === "unverifiable" && c.reason === "anchor_absent")) return false;
    } else if (r.checks.some((c) => c.reason === "anchor_absent")) return false;
  } else if (r.version === 1 && by.has("supersedes")) return false;
  if (outcome === "invalid") return true;
  // a non-invalid response reports every required check
  const required = [...(ai ? REQUIRED_AI : REQUIRED), ...(r.source === "bundle" ? BUNDLE : []), ...(ai && r.version > 1 ? ["supersedes"] : [])];
  return required.every((n) => by.has(n));
}
for (const q of corpus.responseRules) {
  check(`${q.id} response rule`, () => {
    assert.ok(q.spec.length > 0);
    assert.equal(conforms(q.response), q.conforms);
  });
}
for (const x of corpus.assembly) check(`${x.id} assembly shape`, () => assert.ok(x.spec.length > 0 && x.given && x.expect));

// ---------------------------------------------------------------------------
// corpus-wide
// ---------------------------------------------------------------------------

check("vector ids are unique", () => {
  const ids = [...corpus.positives, ...corpus.negatives, ...corpus.finalityEmission.vectors, ...corpus.responseRules, ...corpus.assembly].map((v) => v.id);
  assert.equal(new Set(ids).size, ids.length);
});
check("no private key material, and every seed text contains CANARY, in every file of this directory", () => {
  const pemHeader = ["-----BEGIN", "PRIVATE KEY-----"].join(" ");
  for (const name of readdirSync(dir)) {
    const text = readFileSync(new URL(name, dir), "utf8");
    assert.ok(!text.includes(pemHeader), `${name} holds a PEM private key`);
    for (const m of text.matchAll(/"seedText": ?"([^"]*)"/g)) assert.ok(m[1].includes("CANARY"), `${name}: ${m[1]}`);
  }
});

// the primitive corpus adopted from PR #312, regenerated with CANARY-seeded keys
const prim = JSON.parse(readFileSync(new URL("crypto-vectors.json", dir), "utf8"));
for (const c of prim.primitives) {
  check(`${c.id} primitive signature`, () => {
    const pinned = prim.keys.find((k) => k.keyId === c.pinnedKeyId);
    assert.ok(pinned.seedText.includes("CANARY") && pinned.keyId.includes("CANARY"));
    assert.equal(pubFromSeedText(pinned.seedText).export({ type: "spki", format: "der" }).toString("base64"), c.pinnedSpkiDerBase64);
    assert.equal(`sha256:${sha(Buffer.from(c.pinnedSpkiDerBase64, "base64"))}`, pinned.fingerprint);
    const key = createPublicKey({ key: Buffer.from(c.pinnedSpkiDerBase64, "base64"), format: "der", type: "spki" });
    assert.equal(verify(null, Buffer.from(c.bytes), key, Buffer.from(c.signatureBase64, "base64")), c.expectedPrimitiveSignatureValid);
    const parsed = JSON.parse(c.bytes);
    assert.equal(canonicalize(parsed), c.bytes);
    assert.equal(["regulait.decision-bom.v1", "regulait.ai-bom.v1"].includes(parsed.v), c.expectedRecognisedBomDomain);
  });
}
check("primitive facts and rendering digests", () => {
  assert.equal(sha(prim.facts.canonicalBytes), prim.facts.sha256);
  assert.equal(sha(prim.facts.nonCanonicalBytes), prim.facts.nonCanonicalSha256);
  assert.deepEqual(JSON.parse(prim.facts.canonicalBytes), JSON.parse(prim.facts.nonCanonicalBytes));
  assert.equal(sha(prim.rendering.bytes), prim.rendering.sha256);
  assert.equal(Buffer.byteLength(prim.rendering.bytes), prim.rendering.utf8ByteLength);
  assert.notEqual(sha(prim.rendering.mutationBytes), prim.rendering.sha256);
});
const semantic = JSON.parse(readFileSync(new URL("semantic-vectors.json", dir), "utf8"));
check("semantic obligations: unique ids, each cites the ADR", () => {
  assert.equal(new Set(semantic.cases.map((c) => c.id)).size, semantic.cases.length);
  for (const c of semantic.cases) assert.ok(c.refs.length > 0 && c.given && c.operation && c.expected, c.id);
});

const summary = `${corpus.positives.length} positive, ${corpus.negatives.length} negative, ${corpus.finalityEmission.vectors.length} finality-emission, ${corpus.responseRules.length} response-rule, ${corpus.assembly.length} assembly vectors; ${prim.primitives.length} primitives; ${semantic.cases.length} semantic obligations`;
if (failures.length) {
  console.error(`FAIL ${failures.length} of ${count + failures.length} checks (${summary})`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log(`PASS ${count} checks (${summary})`);
