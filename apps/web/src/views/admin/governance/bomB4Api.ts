/**
 * ADR-0189 B4 routes, as the gateway serves them (`apps/gateway/src/bom-routes.ts`,
 * contract `packages/shared/src/bom/contract-b4.ts` after round 2, 55a945e):
 *
 *   GET  /v1/decisions/:auditId/bom[?version=]          the signed Decision BOM (assembled and frozen on first read)
 *   GET  /v1/decisions/:auditId/bom/bundle?version=      its export-bundle/3
 *   GET  /v1/ai-bom/snapshots/:id?format=                one snapshot in one format, inside an export-bundle/3
 *   GET  /v1/ai-bom/snapshots/:id/bundle                 one snapshot with every rendered format
 *   POST /v1/boms/verify                                 the verifier, online, against the deployment's recorded keys
 *
 * All five are gated in the handler by `bom_export_roles` (403 `bom_export_forbidden`)
 * and audited. OWNER DECISION 9: reading and exporting need no step-up
 * (`capabilities.exportRequiresStepUp` is always false). Exports and verify
 * (which posts) are still wrapped in `withStepUp`, the web convention for
 * exports and writes, so if the gateway ever asks for one it is prompted for
 * rather than failed.
 *
 * A download is saved only after its transport checks pass: the contract's
 * bundle headers, the expected subject and body digest, gzip magic, and the
 * archive's SHA-256 against `x-regulait-bundle-sha256`. Those checks catch a
 * truncated or substituted download; they are not the signature check. The
 * signatures are checked by `verify` (here) or offline (`scripts/verify-bom.mjs`).
 */
import { api } from "../../../api/client";
import { withStepUp } from "../../../stepup/stepUp";
import {
  BomEvidenceError,
  SHA256_HEX,
  checkedAuditId,
  readDecisionBom,
  readVerifyReport,
  type BomFormat,
  type BomSnapshot,
  type DecisionBomView,
  type VerifyExpectation,
  type VerifyView,
} from "./bomModel";

/** contract-b4 `BOM_VERIFY_MAX_BUNDLE_BYTES` */
export const BOM_VERIFY_MAX_BUNDLE_BYTES = 8 * 1024 * 1024;

export interface BomDownload {
  blob: Blob;
  filename: string;
  archiveSha256: string;
  exportKeyId: string;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (n) => n.toString(16).padStart(2, "0")).join("");
}

/** the transport checks every BOM download passes before it is saved (contract-b4 `bomBundleHeadersSchema`) */
export async function checkBundle(blob: Blob, headers: Headers, subject: "ai-bom" | "decision-bom", bodySha256: string): Promise<BomDownload> {
  const refuse = (why: string): never => {
    throw new BomEvidenceError(`The download was not saved: ${why}.`);
  };
  const h = (name: string) => headers.get(name);
  const disposition = h("content-disposition") ?? "";
  const match = /^attachment; filename="(regulait-[A-Za-z0-9._-]+\.tar\.gz)"$/.exec(disposition);
  if (h("content-type") !== "application/gzip" || !match || disposition.length > 256) refuse("it is not a BOM bundle");
  if (h("x-regulait-bundle-schema") !== "regulait.export-bundle/3") refuse("it is not an export-bundle/3");
  if (h("x-regulait-bundle-subject") !== subject) refuse("it holds a different kind of BOM than requested");
  if (h("x-regulait-bom-body-sha256") !== bodySha256) refuse("it holds a different BOM body than the one shown");
  const archiveSha = h("x-regulait-bundle-sha256") ?? "";
  const keyId = h("x-regulait-export-signing-key-id") ?? "";
  if (!SHA256_HEX.test(archiveSha) || !SHA256_HEX.test(h("x-regulait-bundle-manifest-sha256") ?? "") || !/^[A-Za-z0-9._:-]{1,128}$/.test(keyId) || !/^sha256:[0-9a-f]{64}$/.test(h("x-regulait-export-signing-key-fingerprint") ?? "")) {
    refuse("its integrity headers are missing");
  }
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (bytes.length < 2 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) refuse("it is not gzip data");
  if ((await sha256Hex(bytes)) !== archiveSha) refuse("its bytes do not match the digest the gateway sent, so it may be truncated");
  return { blob, filename: match![1]!, archiveSha256: archiveSha, exportKeyId: keyId };
}

/** base64 of a file, in chunks (a spread of 8 MiB would overflow the call stack) */
async function base64Of(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

const verifyCall = async (body: Record<string, unknown>, expected: VerifyExpectation): Promise<VerifyView> =>
  readVerifyReport(await withStepUp((headers) => api.postWithHeaders<unknown>("/v1/boms/verify", body, headers)).then((r) => r.body), expected);

export interface BomEvidencePort {
  /** read (and, the first time, freeze) a decision's BOM; `version` omitted = the newest */
  decision(auditId: string, version?: number): Promise<DecisionBomView>;
  downloadDecision(view: DecisionBomView): Promise<BomDownload>;
  downloadSnapshot(snapshot: BomSnapshot, format: BomFormat | "all"): Promise<BomDownload>;
  verifyDecision(auditId: string, version: number): Promise<VerifyView>;
  verifySnapshot(snapshotId: string): Promise<VerifyView>;
  verifyBundle(file: Blob): Promise<VerifyView>;
}

export const bomB4Api: BomEvidencePort = {
  async decision(auditId, version) {
    const id = checkedAuditId(auditId);
    const q = version === undefined ? "" : `?version=${version}`;
    const view = readDecisionBom(await api.get<unknown>(`/v1/decisions/${id}/bom${q}`), id);
    if (version !== undefined && view.bom.version !== version) throw new BomEvidenceError("The gateway answered with a different Decision BOM version than the one asked for. Nothing is shown.");
    // the summary's digest is over the exact stored body; checked here, not trusted
    if ((await sha256Hex(new TextEncoder().encode(view.body))) !== view.bom.bodySha256) {
      throw new BomEvidenceError("The Decision BOM's body does not match its digest. Nothing is shown.");
    }
    const { body: _body, ...shown } = view;
    return shown;
  },
  async downloadDecision(view) {
    const res = await withStepUp((headers) => api.getBlob(view.bundleHref, headers));
    return checkBundle(res.body, res.headers, "decision-bom", view.bom.bodySha256);
  },
  async downloadSnapshot(snapshot, format) {
    const path = format === "all" ? `/v1/ai-bom/snapshots/${snapshot.id}/bundle` : `/v1/ai-bom/snapshots/${snapshot.id}?format=${encodeURIComponent(format)}`;
    const res = await withStepUp((headers) => api.getBlob(path, headers));
    return checkBundle(res.body, res.headers, "ai-bom", snapshot.bodySha256);
  },
  verifyDecision: (auditId, version) => verifyCall({ source: "decision_bom", auditId: checkedAuditId(auditId), version }, { source: "decision_bom", auditId: checkedAuditId(auditId), version }),
  verifySnapshot: (snapshotId) => verifyCall({ source: "ai_bom_snapshot", snapshotId }, { source: "ai_bom_snapshot", snapshotId }),
  async verifyBundle(file) {
    if (file.size === 0) throw new BomEvidenceError("That file is empty. Nothing was verified.");
    if (file.size > BOM_VERIFY_MAX_BUNDLE_BYTES) throw new BomEvidenceError("That file is larger than the 8 MiB a BOM bundle may be. Nothing was verified.");
    return verifyCall({ source: "bundle", bundleBase64: await base64Of(file) }, { source: "bundle" });
  },
};
