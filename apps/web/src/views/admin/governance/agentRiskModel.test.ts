/**
 * ADR-0339 — the agent risk and identity model. The SPA mirrors the shared vocabularies (it does not import
 * @regulait/shared at runtime), so these tests import the shared source and fail on drift.
 */
import { describe, expect, it } from "vitest";
import * as m from "./agentRiskModel";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const shared = async (file: string): Promise<Any> => import(/* @vite-ignore */ new URL(`../../../../../../packages/shared/src/${file}`, import.meta.url).pathname);

describe("the mirrored vocabularies match @regulait/shared", () => {
  it("risk kinds, bands, triggers and ownership flags", async () => {
    const s = await shared("agent-risk-score.ts");
    expect(m.AGENT_RISK_SUBJECT_KINDS).toEqual(s.AGENT_RISK_SUBJECT_KINDS);
    expect(m.AGENT_RISK_BANDS).toEqual(s.AGENT_RISK_BANDS);
    expect(m.AGENT_RISK_TRIGGERS).toEqual(s.AGENT_RISK_TRIGGERS);
    expect(m.AGENT_OWNERSHIP_FLAGS).toEqual(s.AGENT_OWNERSHIP_FLAGS);
  });

  it("authorship, identity kinds, providers, statuses and identifier shapes", async () => {
    const s = await shared("agent-identity.ts");
    expect(m.AGENT_AUTHOR_SOURCES).toEqual(s.AGENT_AUTHOR_SOURCES);
    expect(m.AGENT_NHI_KINDS).toEqual(s.AGENT_NHI_KINDS);
    expect(m.AGENT_NHI_PROVIDERS).toEqual(s.AGENT_NHI_PROVIDERS);
    expect(m.AGENT_NHI_LINK_STATUSES).toEqual(s.AGENT_NHI_LINK_STATUSES);
    for (const p of m.AGENT_NHI_PROVIDERS) {
      expect(m.AGENT_NHI_ID_PATTERNS[p].map(String), p).toEqual(s.AGENT_NHI_ID_PATTERNS[p].map(String));
    }
  });

  it("every vocabulary value has words", () => {
    for (const b of m.AGENT_RISK_BANDS) expect(m.BAND_LABEL[b]).toBeTruthy();
    for (const t of m.AGENT_RISK_TRIGGERS) expect(m.TRIGGER_LABEL[t]).toBeTruthy();
    for (const f of m.AGENT_OWNERSHIP_FLAGS) expect(m.FLAG_LABEL[f]).toBeTruthy();
    for (const a of m.AGENT_AUTHOR_SOURCES) expect(m.AUTHOR_LABEL[a]).toBeTruthy();
    for (const k of m.AGENT_NHI_KINDS) expect(m.NHI_KIND_LABEL[k]).toBeTruthy();
    for (const p of m.AGENT_NHI_PROVIDERS) expect(m.NHI_PROVIDER_LABEL[p] && m.NHI_ID_HINT[p]).toBeTruthy();
    for (const st of m.AGENT_NHI_LINK_STATUSES) expect(m.LINK_STATUS_LABEL[st]).toBeTruthy();
  });
});

describe("staging a link", () => {
  it("checks the identifier against the provider's shape, as the gateway does", () => {
    expect(m.linkProblems({ ...m.EMPTY_LINK, externalId: "" }).externalId).toBe("Enter the identifier the provider issued.");
    expect(m.linkProblems({ ...m.EMPTY_LINK, externalId: "not-an-arn" }).externalId).toMatch(/^That is not an identifier AWS issues\./);
    expect(m.linkProblems({ ...m.EMPTY_LINK, externalId: "arn:aws:iam::123456789012:role/agent-runner" })).toEqual({});
    expect(m.linkProblems({ ...m.EMPTY_LINK, provider: "okta", externalId: "0oabcdefghijklmnopqr" })).toEqual({});
    expect(m.linkProblems({ ...m.EMPTY_LINK, provider: "other", externalId: "a b" }).externalId).toBeDefined();
    expect(m.linkProblems({ ...m.EMPTY_LINK, externalId: "arn:aws:iam::123456789012:role/x", note: "x".repeat(501) }).note).toBeDefined();
  });

  it("sends the trimmed identifier and drops an empty note", () => {
    expect(m.linkBody({ kind: "oauth_client", provider: "okta", externalId: " 0oabcdefghijklmnopqr ", note: "  " })).toEqual({ kind: "oauth_client", provider: "okta", externalId: "0oabcdefghijklmnopqr" });
    expect(m.linkBody({ ...m.EMPTY_LINK, externalId: "x", note: " runner " }).note).toBe("runner");
  });
});

describe("paths and sentences", () => {
  it("builds the list and history urls with the cursor only when there is one", () => {
    expect(m.rankedUrl("agent", null)).toBe("/v1/agent-risk?kind=agent&limit=50");
    expect(m.rankedUrl("builder_agent", "abc")).toBe("/v1/agent-risk?kind=builder_agent&limit=50&cursor=abc");
    expect(m.historyUrl("agent", "id1", null)).toBe("/v1/agent-risk/agent/id1/history?limit=20");
  });

  it("says what a sweep did", () => {
    expect(m.sweepSentence({ scored: 3, dropped: 0, failed: 0, changed: 0 })).toBe("Recompute finished: 3 scored.");
    expect(m.sweepSentence({ scored: 3, dropped: 0, failed: 1, changed: 2 })).toBe("Recompute finished: 3 scored, 2 changed band or score, 1 could not be scored and will be retried.");
  });

  it("says how widely a combination fix reaches", () => {
    const o = { rank: 1, action: "remove" as const, leg: "private_data" as const, targets: [], cost: 1, title: "t" };
    expect(m.sharedText({ ...o, sharedWith: 0 })).toBe("");
    expect(m.sharedText({ ...o, sharedWith: 1 })).toBe("1 other agent also holds this");
    expect(m.sharedText({ ...o, sharedWith: 4 })).toBe("4 holdings by other agents");
  });
});
