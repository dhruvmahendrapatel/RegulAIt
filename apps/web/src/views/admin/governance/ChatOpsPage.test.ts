/**
 * AER-015 — the ChatOps providers the page OFFERS, and the body it sends.
 * Pure: the exported lists and helpers, no DOM. The cross-package half (these
 * mirrors versus shared's CHATOPS_PROVIDERS, the gateway's outbound list and
 * the send-only verdict) lives in the gateway's adr0121 suite.
 */
import { describe, expect, it } from "vitest";
import {
  CHATOPS_OUTBOUND_PROVIDERS,
  CHATOPS_PROVIDERS,
  CHATOPS_SEND_ONLY_PROVIDERS,
  chatOpsConnectionBody,
  chatOpsProviderLabel,
  chatOpsProviderRegistrable,
  chatOpsProviderUnavailableReason,
} from "./ChatOpsPage";

const base = { name: "n", connectorId: "c", signingSecret: "s3cret-value", defaultChannel: "d", allowFencedDecide: false };

describe("ChatOpsPage — the provider options", () => {
  it("offers outlook alongside slack and teams, each once", () => {
    expect(CHATOPS_PROVIDERS).toContain("outlook");
    expect(CHATOPS_PROVIDERS).toContain("slack");
    expect(CHATOPS_PROVIDERS).toContain("teams");
    expect(new Set(CHATOPS_PROVIDERS).size).toBe(CHATOPS_PROVIDERS.length);
    for (const p of [...CHATOPS_OUTBOUND_PROVIDERS, ...CHATOPS_SEND_ONLY_PROVIDERS]) expect(CHATOPS_PROVIDERS).toContain(p);
  });

  it("no longer calls teams inbound-only — it has an outbound courier (ADR-0113)", () => {
    expect(chatOpsProviderLabel("teams")).toBe("teams");
    expect(chatOpsProviderLabel("teams")).not.toMatch(/inbound only|no outbound/);
    expect(chatOpsProviderLabel("slack")).toBe("slack");
  });

  it("labels outlook as send-only and says it is unavailable while the courier cannot post to it", () => {
    const label = chatOpsProviderLabel("outlook");
    expect(label).toMatch(/^outlook \(/);
    expect(label).toMatch(/send-only/);
    expect(label).toMatch(/no signing secret/);
    // derived from the outbound mirror, not hard-coded: it disappears the day
    // the gateway's outbound list gains outlook and the mirror follows
    expect(label.includes("no outbound sender")).toBe(!CHATOPS_OUTBOUND_PROVIDERS.includes("outlook"));
  });
});

describe("ChatOpsPage — ADR-0179 (AER-015): a provider with no outbound sender cannot be picked", () => {
  it("outlook is offered but not registrable, and the reason names the missing sender and the inbound refusal", () => {
    expect(chatOpsProviderRegistrable("outlook")).toBe(false);
    const reason = chatOpsProviderUnavailableReason("outlook");
    expect(reason).toMatch(/can't be registered for approval cards yet/);
    expect(reason).toMatch(/no outbound sender/);
    expect(reason).toMatch(/Inbound outlook stays refused/);
  });

  it("slack and teams stay registrable, with no reason shown", () => {
    for (const p of ["slack", "teams"]) {
      expect(chatOpsProviderRegistrable(p)).toBe(true);
      expect(chatOpsProviderUnavailableReason(p)).toBeNull();
    }
  });

  it("registrable is exactly the outbound mirror, so the option returns when a sender lands", () => {
    expect(CHATOPS_PROVIDERS.filter(chatOpsProviderRegistrable).sort()).toEqual([...CHATOPS_OUTBOUND_PROVIDERS].sort());
  });
});

describe("ChatOpsPage — the connection body", () => {
  it("sends the signing secret for providers with an inbound path", () => {
    expect(chatOpsConnectionBody({ ...base, provider: "slack" })).toMatchObject({ provider: "slack", signingSecret: "s3cret-value" });
    expect(chatOpsConnectionBody({ ...base, provider: "teams" })).toMatchObject({ signingSecret: "s3cret-value" });
  });

  it("teams may register its bot; a bot-only workspace sends no signing secret; other providers never send bot fields", () => {
    const withBot = chatOpsConnectionBody({ ...base, provider: "teams", botAppId: " app-1 ", botTenantId: "t-1", botOpenidMetadataUrl: "" });
    expect(withBot).toMatchObject({ botAppId: "app-1", botTenantId: "t-1", signingSecret: "s3cret-value" });
    expect(withBot).not.toHaveProperty("botOpenidMetadataUrl");
    const botOnly = chatOpsConnectionBody({ ...base, signingSecret: "", provider: "teams", botAppId: "app-1" });
    expect(botOnly).not.toHaveProperty("signingSecret");
    expect(chatOpsConnectionBody({ ...base, provider: "slack", botAppId: "app-1" })).not.toHaveProperty("botAppId");
    expect(chatOpsConnectionBody({ ...base, signingSecret: "", provider: "teams" })).toHaveProperty("signingSecret", "");
  });

  it("omits it for outlook, which the API would refuse with signing_secret_not_applicable", () => {
    const body = chatOpsConnectionBody({ ...base, provider: "outlook" });
    expect(body).not.toHaveProperty("signingSecret");
    expect(body).toEqual({ name: "n", provider: "outlook", connectorId: "c", defaultChannel: "d", allowFencedDecide: false });
  });
});
