/**
 * ADR-0179 / AER-050 — a create whose retry depends on the draft is sent only
 * once the draft (and the Idempotency-Key in it) is on the server. A failed
 * save used to resolve like a successful one; it now answers "failed" and the
 * wizard refuses to send. The browser behaviour (the refusal on screen, the
 * retry, browser Back) is covered by e2e/intake-drafts.mock.spec.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DRAFT_OWNER_HEADER, draftOwnerHeaders, draftPath, durableForSubmit, putOnExit } from "./intakeDraft";

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

/**
 * ADR-0179 security review, item 6 — the exit save (a keepalive PUT sent as
 * the page goes, possibly queued behind a slow save) names the person whose
 * draft the page loaded, so the gateway refuses it if it arrives under the
 * next person's cookie after a sign-out and sign-in on the same browser.
 */
describe("ADR-0179 the exit save names whose draft it is", () => {
  const sent: Array<{ url: string; init: RequestInit }> = [];
  beforeEach(() => {
    sent.length = 0;
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      sent.push({ url, init });
      return new Response("{}", { status: 200 });
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("sends the owner precondition with the keepalive save", async () => {
    const ok = await putOnExit(draftPath("new"), JSON.stringify({ step: 2 }), "user-a");
    expect(ok).toBe(true);
    expect(sent).toHaveLength(1);
    const headers = sent[0]!.init.headers as Record<string, string>;
    expect(headers[DRAFT_OWNER_HEADER]).toBe("user-a");
    expect(sent[0]!.init.keepalive).toBe(true);
    expect(sent[0]!.init.method).toBe("PUT");
  });

  it("names no one when the page loaded no person's draft", () => {
    expect(draftOwnerHeaders(null)).toEqual({});
    expect(draftOwnerHeaders("user-b")).toEqual({ [DRAFT_OWNER_HEADER]: "user-b" });
  });

  it("a save refused because the person changed is not durable for a keyed submit", () => {
    expect(durableForSubmit({ kind: "not-kept", reason: "owner-changed" })).toBe(false);
  });
});
