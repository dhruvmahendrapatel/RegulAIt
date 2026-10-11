import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../api/client";
import { bomMetadataApi } from "./bomApi";
import { bomRefusalText } from "./bomModel";

const U = (n: number) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;
const T = "2026-10-10T12:00:00.000Z";
const subject = { kind: "use_case" as const, id: U(1) };

interface Call {
  method: string;
  path: string;
  headers: Record<string, string>;
}
function stubFetch(answer: (call: Call) => { status: number; body: unknown }) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (path: string, init: RequestInit) => {
    const call = { method: init.method ?? "GET", path, headers: (init.headers ?? {}) as Record<string, string> };
    calls.push(call);
    const { status, body } = answer(call);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  });
  return calls;
}
afterEach(() => vi.unstubAllGlobals());

describe("bomMetadataApi against the live B3 routes", () => {
  it("lists a subject's snapshots", async () => {
    const calls = stubFetch(() => ({ status: 200, body: { subject, released: true, snapshots: [] } }));
    expect((await bomMetadataApi.list(subject)).released).toBe(true);
    expect(calls).toMatchObject([{ method: "GET", path: `/v1/ai-bom/use_case/${U(1)}/snapshots` }]);
  });
  it("takes a snapshot with a CSRF-marked POST and reads the 201 record", async () => {
    const calls = stubFetch(() => ({ status: 201, body: { id: U(2), version: 3, serialNumber: `urn:uuid:${U(4)}`, bodySha256: "a".repeat(64) } }));
    expect(await bomMetadataApi.create(subject)).toEqual({ id: U(2), version: 3, serialNumber: `urn:uuid:${U(4)}`, bodySha256: "a".repeat(64) });
    expect(calls[0]).toMatchObject({ method: "POST", path: `/v1/ai-bom/use_case/${U(1)}/snapshots` });
    expect(calls[0]!.headers["x-regulait-csrf"]).toBe("1");
  });
  it("a missing receipt key is a refusal, never a snapshot", async () => {
    stubFetch(() => ({ status: 409, body: { error: "bom_signing_unavailable", missingKey: "receipt", detail: "No receipt signing key is available." } }));
    const err = await bomMetadataApi.create(subject).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(bomRefusalText(err)).toMatch(/nothing was signed or stored/);
  });
  it("an unusable key (503) is told apart from a missing one (409)", async () => {
    stubFetch(() => ({ status: 503, body: { error: "receipt_signing_key_invalid", detail: "The receipt signing key conflicts with its recorded public key." } }));
    expect(bomRefusalText(await bomMetadataApi.create(subject).catch((e: unknown) => e))).toMatch(/cannot be used/);
  });
  it("drift with no snapshot still returns the subject's gaps (R25 item 4)", async () => {
    const gap = { auditId: U(8), at: T, kind: "failed", trigger: "use_case_approval", triggeringObjectId: U(1), code: "fanout_exceeded" };
    stubFetch(() => ({ status: 409, body: { gaps: [gap], gapsTruncated: false, error: "ai_bom_no_snapshot", detail: "none" } }));
    expect(await bomMetadataApi.drift(subject)).toEqual({ kind: "no_snapshot", gaps: { gaps: [gap], gapsTruncated: false } });
  });
  it("drift's other refusals are thrown as themselves", async () => {
    stubFetch(() => ({ status: 500, body: { error: "ai_bom_baseline_unreadable" } }));
    expect(bomRefusalText(await bomMetadataApi.drift(subject).catch((e: unknown) => e))).toMatch(/does not match its hash/);
  });
});
