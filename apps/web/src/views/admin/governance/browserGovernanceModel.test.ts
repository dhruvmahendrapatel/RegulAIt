import { describe, expect, it } from "vitest";
import { EVENT_CODE, eventCodeText, isUuid, modeBody, modeOf, modeRelaxes, parseAccountDomains, shortKey, tokenState, type BrowserTokenView } from "./browserGovernanceModel";

const token = (over: Partial<BrowserTokenView> = {}): BrowserTokenView => ({
  tokenId: "t",
  label: "Group A",
  deviceCap: 10,
  devicesEnrolled: 2,
  devicesActive: 2,
  expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  revokedAt: null,
  createdAt: new Date().toISOString(),
  ...over,
});

describe("browser governance model (ADR-0334)", () => {
  it("reads the mode as one choice and writes it back", () => {
    expect(modeOf({ enabled: false, mode: "enforce" })).toBe("off");
    expect(modeOf({ enabled: true, mode: "audit" })).toBe("audit");
    expect(modeBody("off")).toEqual({ enabled: false });
    expect(modeBody("enforce")).toEqual({ enabled: true, mode: "enforce" });
  });

  it("knows which moves are relaxations (the gateway's step-ups)", () => {
    expect(modeRelaxes("off", "enforce")).toBe(true);
    expect(modeRelaxes("enforce", "audit")).toBe(true);
    expect(modeRelaxes("audit", "enforce")).toBe(false);
    expect(modeRelaxes("enforce", "off")).toBe(false);
  });

  it("parses account domains: lower case, de-duplicated, sorted, bounded", () => {
    expect(parseAccountDomains("Corp.Example, labs.example\ncorp.example")).toEqual({ domains: ["corp.example", "labs.example"], problem: null });
    expect(parseAccountDomains("").domains).toEqual([]);
    expect(parseAccountDomains("person@corp.example").problem).toMatch(/not a domain/);
    expect(parseAccountDomains(Array.from({ length: 21 }, (_, i) => `d${i}.example`).join(" ")).problem).toMatch(/At most 20/);
  });

  it("derives a token's state in the gateway's order", () => {
    expect(tokenState(token())).toBe("active");
    expect(tokenState(token({ devicesEnrolled: 10 }))).toBe("exhausted");
    expect(tokenState(token({ expiresAt: new Date(Date.now() - 1000).toISOString(), devicesEnrolled: 10 }))).toBe("expired");
    expect(tokenState(token({ revokedAt: new Date().toISOString() }))).toBe("revoked");
  });

  it("says every event code in words", () => {
    for (const code of ["site_denied", "no_site_rule", "execution_posture", "user_disabled", "no_valid_policy", "site_not_in_policy", "account_not_allowed", "account_signed_out", "dlp_match"]) {
      expect(EVENT_CODE[code]).toBeTruthy();
    }
    expect(eventCodeText("something_new")).toBe("something new");
  });

  it("shortens keys and checks capture ids", () => {
    expect(shortKey("abcdefghijklmnopqrstuvwxyz")).toBe("abcdefgh…uvwxyz");
    expect(shortKey("short")).toBe("short");
    expect(isUuid("11111111-1111-4111-8111-111111111111")).toBe(true);
    expect(isUuid("not-a-uuid")).toBe(false);
  });
});
