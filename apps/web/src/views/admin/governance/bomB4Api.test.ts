import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../api/client";
import { bomB4Api, checkBundle } from "./bomB4Api";
import { BomEvidenceError, bomRefusalText, type BomSnapshot } from "./bomModel";

const U = (n: number) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;
const T = "2026-10-10T12:00:00.000Z";
const BODY = "b".repeat(64);
const gzip = new Uint8Array([0x1f, 0x8b, 8, 0, 1, 2, 3, 4]);
const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const snapshot: BomSnapshot = { id: U(70), version: 2, serialNumber: `urn:uuid:${U(72)}`, trigger: "on_demand", bodySha256: BODY, keyId: "receipt-2026", createdAt: T, formats: ["cyclonedx-1.7"] };

const bundleHeaders = (over: Record<string, string> = {}) =>
  new Headers({
    "content-type": "application/gzip",
    "content-disposition": `attachment; filename="regulait-ai-bom-${U(70)}-v2.tar.gz"`,
    "x-regulait-bundle-schema": "regulait.export-bundle/3",
    "x-regulait-bundle-subject": "ai-bom",
    "x-regulait-bundle-sha256": sha(gzip),
    "x-regulait-bundle-manifest-sha256": "c".repeat(64),
    "x-regulait-export-signing-key-id": "export-2026",
    "x-regulait-export-signing-key-fingerprint": `sha256:${"d".repeat(64)}`,
    "x-regulait-bom-body-sha256": BODY,
    ...over,
  });

const paths: string[] = [];
function stubFetch(answer: (path: string, init: RequestInit) => Response) {
  paths.length = 0;
  vi.stubGlobal("fetch", async (path: string, init: RequestInit) => {
    paths.push(`${init.method ?? "GET"} ${path}`);
    return answer(path, init);
  });
}
afterEach(() => vi.unstubAllGlobals());

describe("download transport checks (contract-b4 bomBundleHeadersSchema)", () => {
  it("accepts a bundle whose bytes match the digest the gateway sent, and names it as the gateway did", async () => {
    const d = await checkBundle(new Blob([gzip]), bundleHeaders(), "ai-bom", BODY);
    expect(d.filename).toBe(`regulait-ai-bom-${U(70)}-v2.tar.gz`);
    expect(d.archiveSha256).toBe(sha(gzip));
  });
  it.each([
    ["truncated bytes", { "x-regulait-bundle-sha256": "e".repeat(64) }, /may be truncated/],
    ["another BOM body", { "x-regulait-bom-body-sha256": "f".repeat(64) }, /different BOM body/],
    ["the other subject", { "x-regulait-bundle-subject": "decision-bom" }, /different kind of BOM/],
    ["not a bundle", { "content-type": "application/json" }, /not a BOM bundle/],
    ["an old bundle schema", { "x-regulait-bundle-schema": "regulait.export-bundle/1" }, /export-bundle\/3/],
    ["no export key fingerprint", { "x-regulait-export-signing-key-fingerprint": "" }, /integrity headers/],
  ])("refuses %s, and saves nothing", async (_name, over, why) => {
    await expect(checkBundle(new Blob([gzip]), bundleHeaders(over), "ai-bom", BODY)).rejects.toThrow(why);
  });
  it("refuses bytes that are not gzip", async () => {
    const text = new TextEncoder().encode("not gzip");
    await expect(checkBundle(new Blob([text]), bundleHeaders({ "x-regulait-bundle-sha256": sha(text) }), "ai-bom", BODY)).rejects.toThrow(/not gzip/);
  });
});

describe("bomB4Api against the live B4 routes", () => {
  it("downloads one format or every rendered format, from the routes the gateway serves", async () => {
    stubFetch(() => new Response(gzip, { status: 200, headers: bundleHeaders() }));
    await bomB4Api.downloadSnapshot(snapshot, "native");
    await bomB4Api.downloadSnapshot(snapshot, "cyclonedx-1.7");
    await bomB4Api.downloadSnapshot(snapshot, "all");
    expect(paths).toEqual([
      `GET /v1/ai-bom/snapshots/${U(70)}?format=native`,
      `GET /v1/ai-bom/snapshots/${U(70)}?format=cyclonedx-1.7`,
      `GET /v1/ai-bom/snapshots/${U(70)}/bundle`,
    ]);
  });
  it("a download refusal arrives as the gateway's own code (no export key, integrity failure, not rendered)", async () => {
    stubFetch(() => Response.json({ error: "bom_signing_unavailable", missingKey: "export" }, { status: 409 }));
    expect(bomRefusalText(await bomB4Api.downloadSnapshot(snapshot, "native").catch((e: unknown) => e))).toMatch(/No export signing key/);
    stubFetch(() => Response.json({ error: "bom_integrity_failure", detail: "x" }, { status: 500 }));
    expect(bomRefusalText(await bomB4Api.downloadSnapshot(snapshot, "native").catch((e: unknown) => e))).toMatch(/integrity re-check/);
    stubFetch(() => Response.json({ error: "format_not_rendered_for_snapshot", formats: ["native", "cyclonedx-1.7"] }, { status: 404 }));
    expect(bomRefusalText(await bomB4Api.downloadSnapshot(snapshot, "spdx-3.0.1").catch((e: unknown) => e))).toMatch(/never produced afterwards/);
  });
  it("verifies a stored snapshot by id, and a bundle as base64", async () => {
    const bodies: unknown[] = [];
    stubFetch((_p, init) => {
      bodies.push(JSON.parse(String(init.body)));
      return Response.json({ error: "bom_export_forbidden" }, { status: 403 });
    });
    await expect(bomB4Api.verifySnapshot(U(70))).rejects.toBeInstanceOf(ApiError);
    await expect(bomB4Api.verifyBundle(new Blob([gzip]))).rejects.toBeInstanceOf(ApiError);
    expect(bodies).toEqual([{ source: "ai_bom_snapshot", snapshotId: U(70) }, { source: "bundle", bundleBase64: Buffer.from(gzip).toString("base64") }]);
    expect(paths).toEqual(["POST /v1/boms/verify", "POST /v1/boms/verify"]);
  });
  it("refuses an empty or oversized bundle before sending it", async () => {
    stubFetch(() => Response.json({}, { status: 500 }));
    await expect(bomB4Api.verifyBundle(new Blob([]))).rejects.toBeInstanceOf(BomEvidenceError);
    await expect(bomB4Api.verifyBundle(new Blob([new Uint8Array(8 * 1024 * 1024 + 1)]))).rejects.toThrow(/8 MiB/);
    expect(paths).toEqual([]);
  });
  it("a Decision BOM not final yet is the 409 with its reason, never an empty BOM", async () => {
    stubFetch(() => Response.json({ error: "bom_anchor_pending", reason: "anchor_not_flushed", retryAfterSeconds: 300 }, { status: 409 }));
    const err = await bomB4Api.decision(U(1)).catch((e: unknown) => e);
    expect(bomRefusalText(err)).toMatch(/not final yet: the audit anchor covering it has not been written yet.*300 seconds/);
    expect(paths).toEqual([`GET /v1/decisions/${U(1)}/bom`]);
  });
  it("asks for a named version, and refuses an invalid audit id before sending", async () => {
    stubFetch(() => Response.json({ error: "bom_version_not_found" }, { status: 404 }));
    await bomB4Api.decision(U(1), 2).catch(() => null);
    expect(paths).toEqual([`GET /v1/decisions/${U(1)}/bom?version=2`]);
    await expect(bomB4Api.decision("not-an-id")).rejects.toBeInstanceOf(BomEvidenceError);
    expect(paths).toHaveLength(1);
  });
});
