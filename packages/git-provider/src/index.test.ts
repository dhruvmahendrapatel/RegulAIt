import { describe, expect, it } from "vitest";
import {
  GitHubProvider,
  GitProviderError,
  MockGitProvider,
  resolveProvider,
} from "./index.js";

describe("MockGitProvider", () => {
  it("branch → PR → merge round-trip", async () => {
    const p = new MockGitProvider();
    await p.createBranch("org/repo", "feature-1", "main");
    const pr = await p.openPullRequest("org/repo", {
      head: "feature-1",
      base: "main",
      title: "t",
      body: "b",
    });
    expect(pr.id).toBe("1");
    const merged = await p.mergePullRequest("org/repo", pr.id, "squash");
    expect(merged).toEqual({ merged: true, sha: "sha-merge-1" });
    await expect(p.mergePullRequest("org/repo", pr.id, "squash")).rejects.toThrow(
      /already merged/,
    );
  });

  it("fails on unknown base branch, duplicate branch, unknown head, unknown pr", async () => {
    const p = new MockGitProvider();
    await expect(p.createBranch("r", "b", "ghost")).rejects.toThrow(/unknown base/);
    await p.createBranch("r", "b", "main");
    await expect(p.createBranch("r", "b", "main")).rejects.toThrow(/exists/);
    await expect(
      p.openPullRequest("r", { head: "ghost", base: "main", title: "t", body: "b" }),
    ).rejects.toThrow(/unknown head/);
    await expect(p.mergePullRequest("r", "99", "merge")).rejects.toThrow(/unknown pr/);
  });
});

describe("GitHubProvider", () => {
  function stubFetch(routes: Record<string, { status: number; body: unknown }>) {
    const calls: { url: string; method: string; body?: unknown }[] = [];
    const impl = async (url: string, init?: { method?: string; body?: string }) => {
      const key = `${init?.method ?? "GET"} ${url}`;
      calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body) : undefined });
      const route = routes[key];
      if (!route) throw new Error(`unexpected request ${key}`);
      return {
        status: route.status,
        json: async () => route.body,
        text: async () => JSON.stringify(route.body),
      };
    };
    return { impl, calls };
  }

  it("creates a branch from the base ref sha", async () => {
    const { impl, calls } = stubFetch({
      "GET https://api.github.com/repos/o/r/git/ref/heads/main": {
        status: 200,
        body: { object: { sha: "abc123" } },
      },
      "POST https://api.github.com/repos/o/r/git/refs": { status: 201, body: {} },
    });
    const p = new GitHubProvider({ token: "t", fetchImpl: impl });
    await p.createBranch("o/r", "regulait/change-1", "main");
    expect(calls[1]!.body).toEqual({ ref: "refs/heads/regulait/change-1", sha: "abc123" });
  });

  it("opens PRs and merges with the configured strategy", async () => {
    const { impl, calls } = stubFetch({
      "POST https://api.github.com/repos/o/r/pulls": {
        status: 201,
        body: { number: 7, html_url: "https://github.com/o/r/pull/7" },
      },
      "PUT https://api.github.com/repos/o/r/pulls/7/merge": {
        status: 200,
        body: { merged: true, sha: "deadbeef" },
      },
    });
    const p = new GitHubProvider({ token: "t", fetchImpl: impl });
    const pr = await p.openPullRequest("o/r", { head: "h", base: "main", title: "T", body: "B" });
    expect(pr).toEqual({ id: "7", url: "https://github.com/o/r/pull/7" });
    const res = await p.mergePullRequest("o/r", pr.id, "squash");
    expect(res).toEqual({ merged: true, sha: "deadbeef" });
    expect(calls[1]!.body).toEqual({ merge_method: "squash" });
  });

  it("wraps provider errors with status codes", async () => {
    const { impl } = stubFetch({
      "POST https://api.github.com/repos/o/r/pulls": { status: 422, body: { message: "no diff" } },
    });
    const p = new GitHubProvider({ token: "t", fetchImpl: impl });
    await expect(
      p.openPullRequest("o/r", { head: "h", base: "main", title: "T", body: "B" }),
    ).rejects.toThrow(GitProviderError);
  });
});

describe("resolveProvider", () => {
  it("rejects interface-ready but unimplemented providers explicitly", () => {
    expect(() => resolveProvider({ provider: "gitlab", token: "t" })).toThrow(/not implemented/);
  });

  it("returns a shared mock so state persists across resolutions", async () => {
    const a = resolveProvider({ provider: "mock", token: "" });
    const b = resolveProvider({ provider: "mock", token: "" });
    await a.createBranch("shared/repo", "x", "main");
    await expect(b.createBranch("shared/repo", "x", "main")).rejects.toThrow(/exists/);
  });
});
