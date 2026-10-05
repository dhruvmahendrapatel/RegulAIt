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

  it("labels outlook as send-only and says what the courier cannot do yet", () => {
    const label = chatOpsProviderLabel("outlook");
    expect(label).toMatch(/^outlook \(/);
    expect(label).toMatch(/send-only/);
    expect(label).toMatch(/no signing secret/);
    // derived from the outbound mirror, not hard-coded: it disappears the day
    // the gateway's outbound list gains outlook and the mirror follows
    expect(label.includes("cannot post")).toBe(!CHATOPS_OUTBOUND_PROVIDERS.includes("outlook"));
  });
});

describe("ChatOpsPage — the connection body", () => {
  it("sends the signing secret for providers with an inbound path", () => {
    expect(chatOpsConnectionBody({ ...base, provider: "slack" })).toMatchObject({ provider: "slack", signingSecret: "s3cret-value" });
    expect(chatOpsConnectionBody({ ...base, provider: "teams" })).toMatchObject({ signingSecret: "s3cret-value" });
  });

  it("omits it for outlook, which the API would refuse with signing_secret_not_applicable", () => {
    const body = chatOpsConnectionBody({ ...base, provider: "outlook" });
    expect(body).not.toHaveProperty("signingSecret");
    expect(body).toEqual({ name: "n", provider: "outlook", connectorId: "c", defaultChannel: "d", allowFencedDecide: false });
  });
});
