/**
 * CodeQL js/polynomial-redos (PR #117) — the base-URL trailing-slash trim was
 * `/\/+$/`, which rescans every run of slashes that is not at the end: a URL
 * with many `/` followed by anything else cost O(n²). Now a linear trim.
 */
import { describe, expect, it } from "vitest";
import { BaseClient } from "./base-client.js";

function clientFor(baseUrl: string, seen: string[]): BaseClient {
  return new BaseClient({
    baseUrl,
    apiKey: "rgl_test",
    fetch: (async (url: string) => {
      seen.push(url);
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof globalThis.fetch,
  });
}

describe("BaseClient base-URL trim", () => {
  it("is linear on many '/' not at the end (the alert's input)", () => {
    const baseUrl = "https://x" + "/".repeat(50_000) + "a";
    const start = performance.now();
    clientFor(baseUrl, []);
    expect(performance.now() - start).toBeLessThan(100);
  });

  it("still drops every trailing slash and nothing else", async () => {
    for (const [baseUrl, expected] of [
      ["https://api.example.com", "https://api.example.com/v1/x"],
      ["https://api.example.com/", "https://api.example.com/v1/x"],
      ["https://api.example.com///", "https://api.example.com/v1/x"],
      ["https://api.example.com//base//", "https://api.example.com//base/v1/x"],
      ["https://api.example.com/" + "/".repeat(50_000), "https://api.example.com/v1/x"],
    ] as const) {
      const seen: string[] = [];
      await clientFor(baseUrl, seen).request("GET", "/v1/x");
      expect(seen).toEqual([expected]);
    }
  });
});
