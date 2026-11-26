import { describe, expect, it } from "vitest";
import { factorLabel, factorSentence, factorTone, resetBlock, resetSummary, type ExternalFactorView } from "./externalSecondFactor";

const fmt = (iso: string) => `<${iso}>`;
const view = (over: Partial<ExternalFactorView>): ExternalFactorView => ({ state: "none", enrolledAt: null, failedAttempts: 0, lockedAt: null, ...over });

describe("external second factor model (ADR-0240)", () => {
  it("labels and tones every state, and an unknown one as unknown", () => {
    expect(factorLabel("active")).toBe("Active");
    expect(factorTone("locked")).toBe("danger");
    expect(factorLabel("something_new")).toBe("Unknown");
    expect(factorTone("something_new")).toBe("neutral");
  });

  it("says what each state means for the holder", () => {
    expect(factorSentence(view({ state: "none" }), fmt)).toMatch(/first time they open a sign-in link/);
    expect(factorSentence(view({ state: "enrolling" }), fmt)).toMatch(/new secret/);
    expect(factorSentence(view({ state: "active", enrolledAt: "2026-11-01" }), fmt)).toContain("<2026-11-01>");
    expect(factorSentence(view({ state: "locked", lockedAt: "2026-11-02" }), fmt)).toMatch(/Locked <2026-11-02>.*until you reset it/);
  });

  it("turns the reset off, with a reason, only when there is nothing to reset", () => {
    expect(resetBlock(undefined)).toMatch(/Loading/);
    expect(resetBlock(view({ state: "none" }))).toMatch(/Nothing to reset/);
    expect(resetBlock(view({ state: "enrolling" }))).toBeNull();
    expect(resetBlock(view({ state: "active" }))).toBeNull();
    expect(resetBlock(view({ state: "locked" }))).toBeNull();
  });

  it("summarises a reset and always says to send a new link", () => {
    const s = resetSummary({ reset: true, hadFactor: true, sessionsEnded: 2, linksRevoked: 1 });
    expect(s).toBe("Second factor reset. 2 sessions ended. 1 unused link revoked. Send a new link so they can set it up again.");
    expect(resetSummary({ reset: true, hadFactor: false, sessionsEnded: 0, linksRevoked: 0 })).toMatch(/^Nothing was set up.*Send a new link/);
  });
});
