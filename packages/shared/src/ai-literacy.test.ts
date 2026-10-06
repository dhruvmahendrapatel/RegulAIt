/**
 * ADR-0182 A14 — the pure literacy rules. Each case pins one rule and fails with the rule reverted.
 */
import { describe, expect, it } from "vitest";
import {
  AI_LITERACY_ARTICLE_4_TEXT,
  acceptedVersions,
  ackExpiresAt,
  aiLiteracyCurrent,
  aiPolicyContentDigest,
  aiTrainingCurrentOf,
  audienceIncludes,
  coveragePct,
  expiresWithinNotice,
  literacyMissing,
  literacyStatusOf,
  type LiteracyDocumentInput,
} from "./ai-literacy.js";

const NOW = new Date("2026-10-06T12:00:00.000Z");
const day = (n: number) => new Date(NOW.getTime() + n * 86_400_000);
const doc = (over: Partial<LiteracyDocumentInput> = {}): LiteracyDocumentInput => ({
  documentId: "d2",
  key: "aup",
  version: 2,
  kind: "acceptable_use",
  title: "Acceptable use",
  acceptedVersions: [2],
  ...over,
});
const ack = (version: number, expiresInDays: number, key = "aup") => ({
  key,
  version,
  method: "acknowledged" as const,
  acknowledgedAt: day(-10),
  expiresAt: day(expiresInDays),
});

describe("audience", () => {
  it("everyone, a team, a role; a narrowed audience leaves others out", () => {
    const m = { teamIds: ["t1"], roleIds: ["r1"] };
    expect(audienceIncludes({ all: true, teamIds: [], roleIds: [] }, m)).toBe(true);
    expect(audienceIncludes({ all: false, teamIds: ["t1"], roleIds: [] }, m)).toBe(true);
    expect(audienceIncludes({ all: false, teamIds: [], roleIds: ["r1"] }, m)).toBe(true);
    expect(audienceIncludes({ all: false, teamIds: ["t2"], roleIds: ["r2"] }, m)).toBe(false);
  });
  it("a malformed audience applies to everyone, never to nobody", () => {
    expect(audienceIncludes(null, { teamIds: [], roleIds: [] })).toBe(true);
  });
});

describe("the editorial chain (no grace period on a material version)", () => {
  const h = (version: number, editorial: boolean, published = true) => ({
    version,
    editorial,
    publishedAt: published ? day(-version) : null,
  });
  it("a material version accepts only itself", () => {
    expect(acceptedVersions([h(1, false), h(2, false)], 2)).toEqual([2]);
  });
  it("an editorial version accepts the version it replaced, recursively, and stops at a material one", () => {
    expect(acceptedVersions([h(1, false), h(2, false), h(3, true), h(4, true)], 4)).toEqual([4, 3, 2]);
  });
  it("a draft never published is skipped", () => {
    expect(acceptedVersions([h(1, false), h(2, false, false), h(3, true)], 3)).toEqual([3, 1]);
  });
});

describe("literacyStatusOf / aiLiteracyCurrent", () => {
  it("nothing applies: not required, vacuously current; the ABAC attribute is NOT vacuously true", () => {
    const s = literacyStatusOf([], [], NOW);
    expect(s).toEqual({ required: false, current: true, documents: [] });
    expect(aiTrainingCurrentOf(s)).toBe(false);
  });
  it("no acknowledgement: missing, not current, named", () => {
    const s = literacyStatusOf([doc()], [], NOW);
    expect(s.current).toBe(false);
    expect(s.documents[0]!.state).toBe("missing");
    expect(literacyMissing(s)).toEqual(['"Acceptable use" (aup v2, missing)']);
  });
  it("acknowledged at the current version and unexpired: current", () => {
    expect(aiLiteracyCurrent([doc()], [ack(2, 30)], NOW)).toBe(true);
    expect(aiTrainingCurrentOf(literacyStatusOf([doc()], [ack(2, 30)], NOW))).toBe(true);
  });
  it("an expired acknowledgement is not current", () => {
    const s = literacyStatusOf([doc()], [ack(2, -1)], NOW);
    expect(s.current).toBe(false);
    expect(s.documents[0]!.state).toBe("expired");
  });
  it("an acknowledgement of a version a material version replaced is superseded", () => {
    const s = literacyStatusOf([doc()], [ack(1, 300)], NOW);
    expect(s.documents[0]!.state).toBe("superseded");
    expect(s.current).toBe(false);
  });
  it("an editorial version keeps the earlier acknowledgement", () => {
    const s = literacyStatusOf([doc({ version: 3, acceptedVersions: [3, 2] })], [ack(2, 30)], NOW);
    expect(s.current).toBe(true);
    expect(s.documents[0]!.acknowledgedVersion).toBe(2);
  });
  it("every applicable document must be current", () => {
    const docs = [doc(), doc({ documentId: "t1", key: "training", kind: "training", version: 1, acceptedVersions: [1] })];
    expect(aiLiteracyCurrent(docs, [ack(2, 30)], NOW)).toBe(false);
    expect(aiLiteracyCurrent(docs, [ack(2, 30), ack(1, 30, "training")], NOW)).toBe(true);
  });
});

describe("dates, digests, coverage, copy", () => {
  it("expiry is whole UTC days after the acknowledgement", () => {
    expect(ackExpiresAt(NOW, 365).toISOString()).toBe("2027-10-06T12:00:00.000Z");
  });
  it("the 14-day notice window", () => {
    expect(expiresWithinNotice(day(13), NOW)).toBe(true);
    expect(expiresWithinNotice(day(15), NOW)).toBe(false);
    expect(expiresWithinNotice(day(-1), NOW)).toBe(false);
  });
  it("the digest moves with the title, the source and the version", () => {
    const base = { key: "aup", kind: "acceptable_use" as const, version: 1, title: "AUP", url: "https://example.com/a", attachmentId: null };
    const d = aiPolicyContentDigest(base);
    expect(d).toMatch(/^[0-9a-f]{64}$/);
    expect(aiPolicyContentDigest({ ...base, title: "AUP 2" })).not.toBe(d);
    expect(aiPolicyContentDigest({ ...base, url: "https://example.com/b" })).not.toBe(d);
    expect(aiPolicyContentDigest({ ...base, version: 2 })).not.toBe(d);
  });
  it("coverage rounds down, so 99.9% never reads as 100%", () => {
    expect(coveragePct(999, 1000)).toBe(99);
    expect(coveragePct(0, 0)).toBe(100);
  });
  it("Article 4 copy uses the amended wording and claims no guaranteed level", () => {
    expect(AI_LITERACY_ARTICLE_4_TEXT).toContain("support the development of AI literacy");
    expect(AI_LITERACY_ARTICLE_4_TEXT).not.toMatch(/ensure|sufficient level/);
  });
});
