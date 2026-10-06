import { describe, expect, it } from "vitest";
import { AzureDevOpsProvider } from "./azure-devops.js";
import { BitbucketProvider } from "./bitbucket.js";
import { GitLabProvider } from "./gitlab.js";
import { trimTrailingSlashes } from "./url.js";

// CodeQL js/polynomial-redos (ADR-0184): `/\/+$/` on a base URL was quadratic
// in a run of slashes that does not end the string (50,000 took about 2 s).
describe("base-URL trailing-slash trim is linear time", () => {
  const pathological = "https://git.example/" + "/".repeat(400_000) + "x";

  it("each adapter constructor finishes well inside a second on 400,000 slashes", () => {
    for (const make of [
      () => new AzureDevOpsProvider({ token: "synthetic", baseUrl: pathological }),
      () => new BitbucketProvider({ token: "synthetic", baseUrl: pathological }),
      () => new GitLabProvider({ token: "synthetic", baseUrl: pathological }),
    ]) {
      const t0 = performance.now();
      make();
      expect(performance.now() - t0).toBeLessThan(1000);
    }
  });

  it("returns exactly what the replaced regex returned", () => {
    const samples = ["", "/", "///", "https://dev.azure.com/org", "https://dev.azure.com/org/", "https://gitlab.example.com/api/v4//",
      "a/b//c///", "//x//", "https://h/ /", "x/ "];
    let a = 11;
    const next = () => (a = (a * 1103515245 + 12345) >>> 0) / 4294967296;
    for (let i = 0; i < 3000; i++) {
      let s = "";
      for (let j = 0, n = Math.floor(next() * 12); j < n; j++) s += ["/", "x", ".", ":", " "][Math.floor(next() * 5)];
      samples.push(s);
    }
    for (const s of samples) expect(trimTrailingSlashes(s), JSON.stringify(s)).toBe(s.replace(/\/+$/, ""));
  });

  it("the adapters still build the same request URLs", async () => {
    const seen: string[] = [];
    const fetchImpl = async (url: string) => {
      seen.push(url);
      return new Response("{}", { status: 404 });
    };
    const gl = new GitLabProvider({ token: "synthetic", baseUrl: "https://gitlab.example.com///", fetchImpl: fetchImpl as never });
    await gl.getPullRequest("group/repo", "1").catch(() => undefined);
    expect(seen.length).toBe(1);
    expect(seen[0]!.startsWith("https://gitlab.example.com/api/v4/")).toBe(true);
  });
});
