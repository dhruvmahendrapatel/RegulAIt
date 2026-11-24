import { describe, expect, it } from "vitest";
import { createBody, createProblems, deliveryState, EMPTY_DRAFT, errorText, nextTryText, rowActions, type SiemDestination } from "./siemDestinationsModel";

const dest = (over: Partial<SiemDestination> = {}): SiemDestination => ({
  id: "11111111-1111-4111-8111-111111111111",
  name: "splunk",
  kind: "webhook",
  url: "https://siem.example.test/in",
  allowPlaintextHttp: false,
  enabled: true,
  state: "active",
  cursorSeq: 10,
  lag: 0,
  consecutiveFailures: 0,
  nextAttemptAt: null,
  lastAttemptAt: null,
  lastSuccessAt: null,
  lastErrorCode: null,
  deliveredEvents: 0,
  secretRotatedAt: null,
  createdAt: "2026-11-20T00:00:00Z",
  ...over,
});

describe("SIEM destinations model (ADR-0303)", () => {
  it("states delivery: off first, then dead-letter, backoff or delivering", () => {
    expect(deliveryState(dest({ enabled: false, state: "dead_letter" }))).toEqual({ label: "Off", tone: "neutral" });
    expect(deliveryState(dest({ state: "dead_letter" })).tone).toBe("danger");
    expect(deliveryState(dest({ state: "backoff" })).label).toBe("Retrying");
    expect(deliveryState(dest()).label).toBe("Delivering");
  });

  it("explains every stored error code, and shows an unknown one as itself", () => {
    for (const c of ["http_4xx", "http_408", "http_413", "http_429", "http_5xx", "timeout", "network", "egress_blocked", "no_data_key", "secret_unreadable", "tls_handshake"]) {
      expect(errorText(c)).not.toMatch(/^Last error/);
    }
    expect(errorText("brand_new")).toBe("Last error: brand_new.");
    expect(errorText(null)).toBeNull();
  });

  it("reads the next retry forwards, not as 'just now' (review #1108 [1])", () => {
    const now = Date.parse("2026-11-20T12:00:00Z");
    const at = (sec: number) => new Date(now + sec * 1000).toISOString();
    expect(nextTryText(dest({ state: "backoff", nextAttemptAt: at(12 * 60) }), now)).toBe("next try in 12m");
    expect(nextTryText(dest({ state: "backoff", nextAttemptAt: at(3 * 3600 + 5) }), now)).toBe("next try in 3h");
    expect(nextTryText(dest({ state: "backoff", nextAttemptAt: at(20) }), now)).toBe("next try in under a minute");
    expect(nextTryText(dest({ state: "backoff", nextAttemptAt: at(-5) }), now)).toBe("next try now");
    // only a backing-off destination has a next try
    expect(nextTryText(dest({ state: "dead_letter", nextAttemptAt: at(600) }), now)).toBeNull();
    expect(nextTryText(dest({ state: "backoff", nextAttemptAt: null }), now)).toBeNull();
  });

  it("says why recover and rotate are off", () => {
    expect(rowActions(dest()).recover).toMatch(/nothing to recover/);
    expect(rowActions(dest({ state: "backoff" })).recover).toBeNull();
    expect(rowActions(dest({ state: "dead_letter" })).recover).toBeNull();
    expect(rowActions(dest()).rotate).toBeNull();
    // ADR-0351: a syslog destination has no signing secret
    expect(rowActions(dest({ kind: "syslog_tls" })).rotate).toMatch(/Only a webhook/);
  });

  it("checks the URL like the gateway does at create time", () => {
    const base = { ...EMPTY_DRAFT, name: "s" };
    expect(createProblems({ ...base, url: "https://siem.example.test/in" })).toEqual({});
    expect(createProblems({ ...base, url: "http://siem.internal/in" }).url).toMatch(/allow plain http/);
    expect(createProblems({ ...base, url: "http://siem.internal/in", allowPlaintextHttp: true })).toEqual({});
    expect(createProblems({ ...base, url: "https://u:p@siem.example.test/" }).url).toMatch(/credentials/);
    expect(createProblems({ ...base, url: "https://siem.example.test/#x" }).url).toMatch(/fragment/);
    expect(createProblems({ ...base, url: "ftp://siem.example.test/" }).url).toMatch(/Only https/);
    expect(createProblems({ ...base, url: "not a url" }).url).toMatch(/full URL/);
    expect(createProblems({ ...EMPTY_DRAFT, url: "https://x.test" }).name).toMatch(/name/);
    expect(createProblems({ ...base, name: "x".repeat(121), url: "https://x.test" }).name).toMatch(/120/);
  });

  it("sends only what is set, trimmed", () => {
    expect(createBody({ name: " s ", url: " https://x.test ", allowPlaintextHttp: false, startFrom: "now" })).toEqual({ name: "s", url: "https://x.test" });
    expect(createBody({ name: "s", url: "http://x.test", allowPlaintextHttp: true, startFrom: "beginning" })).toEqual({
      name: "s",
      url: "http://x.test",
      allowPlaintextHttp: true,
      startFrom: "beginning",
    });
  });
});
