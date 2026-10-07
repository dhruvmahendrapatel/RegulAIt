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
  OUTLOOK_RECIPIENT_ALLOW_LIST_MAX,
  canonicalOutlookRecipients,
  chatOpsConnectionBody,
  outlookRecipientChange,
  chatOpsProviderLabel,
  chatOpsProviderRegistrable,
  chatOpsProviderUnavailableReason,
  outlookCredentialToken,
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

  it("labels outlook as send-only, and no longer unavailable once the courier can post to it (ADR-0183 2.6)", () => {
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
  it("ADR-0183 2.6: outlook has its sender now, so it is registrable and shows no reason", () => {
    expect(CHATOPS_OUTBOUND_PROVIDERS).toContain("outlook");
    expect(chatOpsProviderRegistrable("outlook")).toBe(true);
    expect(chatOpsProviderUnavailableReason("outlook")).toBeNull();
    expect(chatOpsProviderLabel("outlook")).toBe("outlook (send-only by design, no signing secret)");
  });

  it("a provider not in the outbound mirror is still refused, with the reason", () => {
    expect(chatOpsProviderRegistrable("webex")).toBe(false);
    expect(chatOpsProviderUnavailableReason("webex")).toMatch(/no outbound sender/);
  });

  it("slack, teams and outlook are registrable, with no reason shown", () => {
    for (const p of ["slack", "teams", "outlook"]) {
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

describe("ChatOpsPage — ADR-0183 2.6: the outlook app registration", () => {
  const four = { tenantId: " contoso.onmicrosoft.com ", clientId: " client-1 ", clientSecret: "s3cret ", senderMailbox: " approvals@acme.test " };

  it("maps the four fields onto the connector credential's JSON shape", () => {
    const out = outlookCredentialToken(four);
    expect("token" in out && out.token && JSON.parse(out.token)).toEqual({
      appId: "client-1",
      appPassword: "s3cret ", // a secret is taken exactly as typed
      tenantId: "contoso.onmicrosoft.com",
      senderUpn: "approvals@acme.test",
    });
  });

  it("none filled = use the connector's stored credential; some filled = refused, never half-written", () => {
    expect(outlookCredentialToken({ tenantId: "", clientId: "", clientSecret: "", senderMailbox: "" })).toEqual({ token: null });
    const partial = outlookCredentialToken({ ...four, clientSecret: "" });
    expect("error" in partial && partial.error).toMatch(/all four/);
  });
});

describe("ChatOpsPage — Outlook recipients are counted in their canonical form (PR #181 review)", () => {
  // 51 non-blank lines that canonicalise to 50 distinct mailboxes: the gateway
  // accepts this list, so the page must not refuse it before sending.
  const fiftyOneLines = [
    ...Array.from({ length: 50 }, (_, i) => `  Person${i}@Example.test `),
    "person0@example.test",
    "",
  ].join("\n");

  it("trims, lower-cases and de-duplicates before the limit is applied", () => {
    const canonical = canonicalOutlookRecipients(fiftyOneLines);
    expect(canonical).toHaveLength(OUTLOOK_RECIPIENT_ALLOW_LIST_MAX);
    expect(canonical[0]).toBe("person0@example.test");
    expect(canonicalOutlookRecipients("A@x.test\r\n a@x.test\n\nb@x.test")).toEqual(["a@x.test", "b@x.test"]);
  });

  it("matches the gateway's shared canonicaliser on the same inputs", async () => {
    // runtime-only import: the SPA does not depend on @regulait/shared
    const sharedPath = new URL("../../../../../../packages/shared/src/batch3.ts", import.meta.url).pathname;
    const shared = (await import(/* @vite-ignore */ sharedPath)) as {
      OUTLOOK_RECIPIENT_ALLOW_LIST_MAX: number;
      outlookRecipientAllowListProblem: (provider: string, list: readonly string[]) => { ok: boolean; value?: string[] };
    };
    expect(OUTLOOK_RECIPIENT_ALLOW_LIST_MAX).toBe(shared.OUTLOOK_RECIPIENT_ALLOW_LIST_MAX);
    for (const text of [fiftyOneLines, "A@x.test\r\n a@x.test\n\nb@x.test", " Cab@Example.test "]) {
      const lines = text.split(/\r?\n/).filter((line) => line.trim() !== "");
      const verdict = shared.outlookRecipientAllowListProblem("outlook", lines);
      expect(verdict.ok, text).toBe(true);
      expect(canonicalOutlookRecipients(text)).toEqual(verdict.value);
    }
  });
});

describe("ChatOpsPage — an Outlook save sends only a real change, classified against the stored list (PR #181 review)", () => {
  it("an unchanged canonical list is not sent", () => {
    const loaded = ["cab@example.test", "security@example.test"];
    expect(outlookRecipientChange(loaded, " CAB@example.test\nsecurity@example.test\n", loaded)).toEqual({ kind: "unchanged" });
    expect(outlookRecipientChange(loaded, "security@example.test\ncab@example.test", loaded)).toEqual({ kind: "unchanged" });
  });

  it("a recipient another admin removed since load counts as an addition", () => {
    const loaded = ["cab@example.test", "security@example.test"];
    const now = ["security@example.test"];
    expect(outlookRecipientChange(loaded, "cab@example.test", now)).toEqual({ kind: "save", recipients: ["cab@example.test"], adds: true });
    // a removal against what is stored now is a tightening
    expect(outlookRecipientChange(loaded, "security@example.test", now)).toEqual({ kind: "save", recipients: ["security@example.test"], adds: false });
  });

  it("asks for confirmation when the stored list could not be re-read", () => {
    expect(outlookRecipientChange(["a@x.test", "b@x.test"], "a@x.test", null)).toEqual({ kind: "save", recipients: ["a@x.test"], adds: true });
  });
});
