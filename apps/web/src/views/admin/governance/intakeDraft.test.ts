/**
 * ADR-0179 / AER-050 — a create whose retry depends on the draft is sent only
 * once the draft (and the Idempotency-Key in it) is on the server. A failed
 * save used to resolve like a successful one; it now answers "failed" and the
 * wizard refuses to send. The browser behaviour (the refusal on screen, the
 * retry, browser Back) is covered by e2e/intake-drafts.mock.spec.ts.
 */
import { describe, expect, it } from "vitest";
import { durableForSubmit } from "./intakeDraft";

describe("ADR-0179 durableForSubmit", () => {
  it("sends only after a save the server holds", () => {
    expect(durableForSubmit({ kind: "saved" })).toBe(true);
  });

  it("refuses after a failed save: the server may hold an older draft without the key", () => {
    expect(durableForSubmit({ kind: "failed", tooLarge: false })).toBe(false);
    expect(durableForSubmit({ kind: "failed", tooLarge: true })).toBe(false);
  });

  it("refuses while the first read has not answered: a saved draft may still be there", () => {
    expect(durableForSubmit({ kind: "not-kept", reason: "loading" })).toBe(false);
    expect(durableForSubmit({ kind: "not-kept", reason: "stopped" })).toBe(false);
    expect(durableForSubmit({ kind: "not-kept", reason: "empty" })).toBe(false);
  });

  it("sends when no draft of this work is kept at all, so none can be resumed without the key", () => {
    expect(durableForSubmit({ kind: "not-kept", reason: "off" })).toBe(true);
    expect(durableForSubmit({ kind: "not-kept", reason: "offer" })).toBe(true);
  });
});
