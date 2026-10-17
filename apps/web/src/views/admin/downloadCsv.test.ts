/**
 * `downloadCsv`: every failure reaches the caller's `onError` and resolves false. Callers `void` the promise, so a
 * rejection would be unhandled; that includes a body that breaks off while it is read.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadCsv } from "./adminKit";

afterEach(() => vi.unstubAllGlobals());

describe("downloadCsv", () => {
  it("a body that fails mid-read is reported and resolves false, never a rejection", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: true, status: 200, blob: () => Promise.reject(new TypeError("network error")) }));
    const errors: string[] = [];
    await expect(downloadCsv("/v1/audit.csv", "audit.csv", (m) => errors.push(m))).resolves.toBe(false);
    expect(errors).toEqual(["The download was interrupted before it finished. Try again."]);
  });

  it("a request that never reaches the gateway is reported the same way", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new TypeError("offline")));
    const errors: string[] = [];
    await expect(downloadCsv("/v1/audit.csv", "audit.csv", (m) => errors.push(m))).resolves.toBe(false);
    expect(errors).toEqual(["The download could not reach the gateway. Check the connection and try again."]);
  });
});
