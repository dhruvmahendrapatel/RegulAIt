import { describe, expect, it } from "vitest";
import { ApiError } from "../../api/client";
import { refusalWords } from "./detailModel";

describe("refusalWords", () => {
  it("names a route's own code in the caller's words, and offers no retry for a 403", () => {
    const w = refusalWords("statement", new ApiError(403, { error: "billing_scope_not_entitled" }), {
      billing_scope_not_entitled: "Outside your scope.",
    });
    expect(w).toEqual({ title: "You don't have access to this statement", body: "Outside your scope.", retry: false });
  });

  it("says a missing record is missing, not a load failure", () => {
    const w = refusalWords("rate card", new ApiError(404, { error: "unknown_rate_card" }));
    expect(w.title).toBe("No such rate card");
    expect(w.body).toMatch(/no rate card with this ID/);
    expect(w.retry).toBe(false);
  });

  it("reads a malformed id as one, with an article that fits the noun", () => {
    const w = refusalWords("import batch", new ApiError(400, { error: "validation", issues: [{ path: "importId", message: "Invalid uuid" }] }));
    expect(w.title).toBe("This is not an import batch reference");
    expect(w.body).toContain("Import ID is not a valid ID");
    expect(w.retry).toBe(false);
  });

  it("keeps Retry for a server failure and a network error", () => {
    expect(refusalWords("job", new ApiError(500, { error: "internal" })).retry).toBe(true);
    const net = refusalWords("job", new Error("Couldn't reach the server"));
    expect(net).toEqual({ title: "Couldn't load this job", body: "Couldn't reach the server", retry: true });
  });
});
