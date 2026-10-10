/**
 * ADR-0189 "B4 bundle and signature specification (pre-build, 2026-10-10)" §B4.6:
 * the ONE worked example, built from literal values so that the specification,
 * not B4's code, is what it exercises. TEST-ONLY: every key here is derived from
 * a published seed string that contains CANARY; nothing in this file is, or may
 * ever be configured as, a deployment key.
 *
 * `adr0189-b4-spec-example.test.ts` rebuilds this example, checks every file
 * byte for byte against the fenced blocks in the ADR, re-derives every section
 * from the facts with its own projector, and verifies all three signatures with
 * the PUBLIC keys only. `scripts/bom-b4-spec-example.mjs` writes the bundle to
 * disk for anyone writing verifier vectors.
 *
 * Pure: no clock, no database, no network. Times and ids are literals.
 */
import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { gunzipSync } from "node:zlib";
import {
  auditRowHash,
  bomCanonicalBytes,
  bomRowDigest,
  bomSha256,
  projectBomRow,
  receiptCanonicalBytes,
  type DecisionReceiptPayloadV2,
} from "@regulait/shared";
import { buildTarGz, publicKeyFingerprint } from "../export-bundle.js";

// ---------------------------------------------------------------------------
// the TEST-ONLY keys (§B4.6.1): Ed25519 seeds derived from published strings
// ---------------------------------------------------------------------------

export const CANARY_RECEIPT_KEY_ID = "TEST-ONLY-CANARY-receipt-key-1";
export const CANARY_EXPORT_KEY_ID = "TEST-ONLY-CANARY-export-key-1";
export const CANARY_RECEIPT_SEED_TEXT = "regulait ADR-0189 B4 spec TEST-ONLY CANARY receipt key seed";
export const CANARY_EXPORT_SEED_TEXT = "regulait ADR-0189 B4 spec TEST-ONLY CANARY export key seed";

/** RFC 8410 PKCS#8 wrapper of a raw 32-byte Ed25519 seed */
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
/** RFC 8410 SubjectPublicKeyInfo prefix of a raw 32-byte Ed25519 public key */
export const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function canaryKey(seedText: string) {
  const seed = createHash("sha256").update(seedText, "utf8").digest();
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: "der", type: "pkcs8" });
  const publicKey = createPublicKey(privateKey as unknown as string); // a KeyObject, as export-bundle.ts:200 passes it
  const jwk = publicKey.export({ format: "jwk" }) as { kty: string; crv: string; x: string };
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  return { privateKey, jwk: { kty: "OKP" as const, crv: "Ed25519" as const, x: jwk.x }, publicKeyPem, fingerprint: publicKeyFingerprint(publicKeyPem) };
}

// ---------------------------------------------------------------------------
// the literal inputs
// ---------------------------------------------------------------------------

export const EX = {
  auditId: "a0000000-0000-4000-8000-000000000042",
  bomId: "b0000000-0000-4000-8000-000000000001",
  sponsorUserId: "c0000000-0000-4000-8000-000000000001",
  exporterUserId: "c0000000-0000-4000-8000-000000000002",
  serverId: "d0000000-0000-4000-8000-000000000001",
  usageEventId: "e0000000-0000-4000-8000-000000000001",
  traceId: "f0000000-0000-4000-8000-000000000001",
  spanId: "f0000000-0000-4000-8000-000000000002",
  auditSeq: 42,
  decisionAt: "2026-10-10T12:00:00.000Z",
  exportedAt: "2026-10-10T12:30:00.000Z",
  /** synthetic: the preimages are never exported (R39), so any digest serves */
  prevHash: createHash("sha256").update("TEST-ONLY CANARY audit row 41", "utf8").digest("hex"),
  contentHash: createHash("sha256").update("TEST-ONLY CANARY audit row 42 content", "utf8").digest("hex"),
  argumentsDigest: createHash("sha256").update("TEST-ONLY CANARY arguments", "utf8").digest("hex"),
} as const;

export const BUNDLE_ROOT = `regulait-export-decision-bom-${EX.auditId}-v1`;

export const EXAMPLE_README =
  "RegulAIt signed export bundle (regulait.export-bundle/3, subject decision-bom)\n" +
  "\n" +
  "TEST-ONLY CANARY EXAMPLE: every key that signed this bundle is a published test key.\n" +
  "\n" +
  "Verify with an out-of-band trust root only: the export key fingerprint for\n" +
  "manifest.json.sig, and the receipt key for content/decision-bom.json.sig,\n" +
  "the receipt and any addenda. signing-key.pub and receipt-keys.json are\n" +
  "convenience copies, never the trust root.\n" +
  "\n" +
  "This bundle carries no audit row payloads (ADR-0189 R39): audit/chain.tsv\n" +
  "holds hashes only, so the decision row's content is not disclosed.\n";

export interface ExampleBundle {
  /** path (relative to the bundle root) -> exact bytes */
  files: Map<string, Buffer>;
  /** the uncompressed USTAR bytes and the served gzip bytes */
  tar: Buffer;
  archive: Buffer;
  body: Record<string, unknown>;
  bodyBytes: string;
  facts: Record<string, unknown>;
  factsBytes: string;
  receiptPayload: DecisionReceiptPayloadV2;
  manifest: Record<string, unknown>;
  keys: { receipt: { keyId: string; jwk: { kty: "OKP"; crv: "Ed25519"; x: string }; fingerprint: string }; export: { keyId: string; publicKeyPem: string; fingerprint: string } };
}

export function buildB4SpecExample(): ExampleBundle {
  const receiptKey = canaryKey(CANARY_RECEIPT_SEED_TEXT);
  const exportKey = canaryKey(CANARY_EXPORT_SEED_TEXT);

  const usage = projectBomRow("usage_events", {
    id: EX.usageEventId, at: "2026-10-10T12:00:00.250Z", userId: EX.sponsorUserId, objectType: "mcp_tool", agentId: null,
    requestedAgentId: null, connectorId: null, operation: "tool_call", provider: null, model: null, servedModel: null,
    inputTokens: 12, outputTokens: 34, costUsd: 0.000123, refusal: null, projectId: null, configVersionId: null,
    configVersion: null, configCanary: false, agentConfigVersionId: null, agentConfigVersion: null, actorIdentityId: null,
    delegationGrantId: null,
  });
  const span = projectBomRow("trace_spans", {
    id: EX.spanId, traceId: EX.traceId, parentSpanId: null, seq: 1, kind: "mcp_tool", status: "ok",
    startedAt: "2026-10-10T12:00:00.100Z", endedAt: "2026-10-10T12:00:00.200Z", durationMs: 100, usageEventId: EX.usageEventId,
    auditLogId: EX.auditId, agentId: null, mcpServerId: EX.serverId, connectorId: null, provider: null, model: null,
    inputTokens: 12, outputTokens: 34, costUsd: 0.000123, contentWithheld: true, actorIdentityId: null, delegationGrantId: null,
  });

  const facts = {
    v: "regulait.decision-facts.v1",
    auditId: EX.auditId,
    auditSeq: EX.auditSeq,
    action: {
      argumentsDigest: EX.argumentsDigest,
      contextDigest: null,
      target: { kind: "mcp_tool", serverId: EX.serverId, toolName: "search", toolNameHash: null, connectorId: null, agentId: null },
      inputs: [],
      dataSensitivity: "internal",
      complianceTags: [],
    },
    policy: { governancePolicyEpoch: 7, abacPolicyVersions: [], configVersions: [], guardrailConfigDigest: null, modelPolicyRuleIds: [], killSwitch: "off" },
    model: null,
    actors: { sponsorUserId: EX.sponsorUserId, actorIdentityId: null, delegationGrantId: null, actorChain: [] },
    outcome: { effect: "allow", refusalCode: null, upstreamStatusClass: "2xx" },
    rows: [
      { table: "trace_spans", id: EX.spanId, projection: span, digest: bomRowDigest("trace_spans", span) },
      { table: "usage_events", id: EX.usageEventId, projection: usage, digest: bomRowDigest("usage_events", usage) },
    ],
  };
  const factsBytes = bomCanonicalBytes(facts);
  const factsHash = bomSha256(factsBytes);

  const rowHash = auditRowHash(EX.prevHash, EX.contentHash);
  const receiptPayload: DecisionReceiptPayloadV2 = {
    v: "regulait.receipt.v2",
    receiptSeq: 1,
    audit: { id: EX.auditId, seq: EX.auditSeq, rowHash, contentHash: EX.contentHash },
    decision: { at: EX.decisionAt, userId: EX.sponsorUserId, objectType: "mcp_tool", objectId: null, serverId: EX.serverId, toolName: "search", effect: "allow", ruleId: "rule-allow-search" },
    prev: "0".repeat(64),
    keyId: CANARY_RECEIPT_KEY_ID,
    actor: { identityId: null, delegationGrantId: null, chain: null },
    factsStatus: "captured",
    factsHash,
  };
  const receiptBytes = receiptCanonicalBytes(receiptPayload);
  const receiptSignature = sign(null, Buffer.from(receiptBytes, "utf8"), receiptKey.privateKey).toString("base64url");

  const body = {
    v: "regulait.decision-bom.v1",
    id: EX.bomId,
    auditId: EX.auditId,
    version: 1,
    supersedes: null,
    finality: "chain_signed",
    decision: { auditSeq: EX.auditSeq, at: EX.decisionAt, objectType: "mcp_tool", objectId: null, serverId: EX.serverId, toolName: "search", effect: "allow", ruleId: "rule-allow-search", ruleChain: ["rule-allow-search"] },
    receipt: { receiptSeq: 1, payloadHash: bomSha256(receiptBytes), keyId: CANARY_RECEIPT_KEY_ID, payload: receiptBytes, signature: receiptSignature },
    principal: { sponsorUserId: EX.sponsorUserId },
    actors: facts.actors,
    action: facts.action,
    policy: facts.policy,
    model: null,
    approval: null,
    outcome: facts.outcome,
    cost: { usageEventIds: [EX.usageEventId], inputTokens: 12, outputTokens: 34, costUsd: "0.000123", costSource: "usage_events.cost_usd" },
    trace: { traceIds: [EX.traceId], spanIds: [EX.spanId] },
    proof: { chain: [{ seq: EX.auditSeq, contentHash: EX.contentHash, prevHash: EX.prevHash, rowHash }], anchor: null },
    facts: { payload: factsBytes, addenda: [] },
    completeness: {
      decision: { status: "recorded" },
      receipt: { status: "recorded" },
      principal: { status: "recorded" },
      actors: { status: "recorded" },
      action: { status: "recorded" },
      policy: { status: "recorded" },
      model: { status: "not_recorded", reason: "not_captured_by_path" },
      approval: { status: "not_recorded", reason: "no_bound_row" },
      outcome: { status: "recorded" },
      cost: { status: "recorded" },
      trace: { status: "recorded" },
      proof: { status: "not_recorded", reason: "anchor_absent" },
    },
    basis: { auditSeq: EX.auditSeq, anchorId: null, receiptSeq: 1, aiBomSnapshotId: null },
  };
  const bodyBytes = bomCanonicalBytes(body);
  const bodySha256 = bomSha256(bodyBytes);
  const bodySignature = sign(null, Buffer.from(bodyBytes, "utf8"), receiptKey.privateKey).toString("base64url");

  const files = new Map<string, Buffer>();
  files.set("README.txt", Buffer.from(EXAMPLE_README, "utf8"));
  files.set("audit/chain.tsv", Buffer.from(`${EX.auditSeq}\t${EX.contentHash}\t${EX.prevHash}\t${rowHash}\n`, "utf8"));
  files.set("content/decision-bom.json", Buffer.from(bodyBytes, "utf8"));
  files.set("content/decision-bom.json.sig", Buffer.from(bomCanonicalBytes({ alg: "Ed25519", keyId: CANARY_RECEIPT_KEY_ID, signature: bodySignature, signedSha256: bodySha256 }), "utf8"));
  files.set("receipt-keys.json", Buffer.from(bomCanonicalBytes({ keys: [{ keyId: CANARY_RECEIPT_KEY_ID, jwk: receiptKey.jwk, fingerprint: receiptKey.fingerprint }] }), "utf8"));
  files.set("signing-key.pub", Buffer.from(exportKey.publicKeyPem, "utf8"));

  const listed = [...files.entries()]
    .map(([path, bytes]) => ({ path, sha256: createHash("sha256").update(bytes).digest("hex") }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const manifest = {
    schema: "regulait.export-bundle/3",
    product: "regulait",
    installId: null,
    installIdSource: "absent",
    exportedAt: EX.exportedAt,
    exportedAtSource: "database",
    exportedByUserId: EX.exporterUserId,
    subject: {
      kind: "decision-bom",
      id: EX.auditId,
      descriptor: { auditId: EX.auditId, bomId: EX.bomId, version: 1, finality: "chain_signed", bodySha256, receiptSeq: 1, aiBomSnapshotId: null, formats: [] },
    },
    files: listed,
    audit: { payloadScope: "none", segmentFromSeq: EX.auditSeq, segmentToSeq: EX.auditSeq, segmentRowCount: 1 },
    signingKeyId: CANARY_EXPORT_KEY_ID,
    signingKeyFingerprint: exportKey.fingerprint,
  };
  const manifestBytes = Buffer.from(bomCanonicalBytes(manifest), "utf8");
  files.set("manifest.json", manifestBytes);
  files.set("manifest.json.sig", Buffer.from(`${sign(null, manifestBytes, exportKey.privateKey).toString("base64")}\n`, "utf8"));

  const entries = [...files.entries()]
    .map(([path, bytes]) => ({ path: `${BUNDLE_ROOT}/${path}`, body: bytes }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const archive = buildTarGz(entries);

  return {
    files,
    tar: gunzipSync(archive),
    archive,
    body,
    bodyBytes,
    facts,
    factsBytes,
    receiptPayload,
    manifest,
    keys: {
      receipt: { keyId: CANARY_RECEIPT_KEY_ID, jwk: receiptKey.jwk, fingerprint: receiptKey.fingerprint },
      export: { keyId: CANARY_EXPORT_KEY_ID, publicKeyPem: exportKey.publicKeyPem, fingerprint: exportKey.fingerprint },
    },
  };
}
