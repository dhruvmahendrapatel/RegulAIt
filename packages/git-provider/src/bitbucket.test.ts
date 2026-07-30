import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BitbucketProvider } from "./bitbucket.js";
import { GitProviderError } from "./types.js";
import { FakeUpstream } from "./testkit.js";

const REPO = "acme-ws/widgets";

describe("BitbucketProvider (fake upstream over real HTTP)", () => {
  const upstream = new FakeUpstream();
  beforeAll(() => upstream.start());
  afterAll(() => upstream.stop());
  beforeEach(() => upstream.reset());

  const provider = () =>
    new BitbucketProvider({ token: "alice:app-pass-123", baseUrl: upstream.baseUrl });

  it("creates a branch by resolving the source tip hash, with Basic auth from 'user:app_password'", async () => {
    upstream.route("GET", `/repositories/${REPO}/refs/branches/main`, {
      status: 200,
      body: { name: "main", target: { hash: "tip123" } },
    });
    upstream.route("POST", `/repositories/${REPO}/refs/branches`, {
      status: 201,
      body: { name: "feat" },
    });
    await provider().createBranch(REPO, "feat", "main");
    expect(upstream.requests[0]!.headers.authorization).toBe(
      `Basic ${Buffer.from("alice:app-pass-123").toString("base64")}`,
    );
    expect(upstream.requests[1]!.body).toEqual({ name: "feat", target: { hash: "tip123" } });
  });

  it("sends a colon-less token as Bearer (workspace/repo access token convention)", async () => {
    upstream.route("GET", `/repositories/${REPO}/refs/branches/main`, {
      status: 200,
      body: { target: { hash: "tip123" } },
    });
    upstream.route("POST", `/repositories/${REPO}/refs/branches`, { status: 201, body: {} });
    const bearer = new BitbucketProvider({ token: "ATCTT-token", baseUrl: upstream.baseUrl });
    await bearer.createBranch(REPO, "feat", "main");
    expect(upstream.requests[0]!.headers.authorization).toBe("Bearer ATCTT-token");
  });

  it("opens a PR with source/destination branch shape and returns id + html link", async () => {
    upstream.route("POST", `/repositories/${REPO}/pullrequests`, {
      status: 201,
      body: {
        id: 42,
        links: { html: { href: "https://bitbucket.org/acme-ws/widgets/pull-requests/42" } },
      },
    });
    const pr = await provider().openPullRequest(REPO, {
      head: "feat",
      base: "main",
      title: "T",
      body: "B",
    });
    expect(pr).toEqual({
      id: "42",
      url: "https://bitbucket.org/acme-ws/widgets/pull-requests/42",
    });
    expect(upstream.requests[0]!.body).toEqual({
      title: "T",
      description: "B",
      source: { branch: { name: "feat" } },
      destination: { branch: { name: "main" } },
    });
  });

  it("gets a PR and maps OPEN → open with head/base/headSha", async () => {
    upstream.route("GET", `/repositories/${REPO}/pullrequests/42`, {
      status: 200,
      body: {
        id: 42,
        state: "OPEN",
        title: "T",
        links: { html: { href: "https://bitbucket.org/acme-ws/widgets/pull-requests/42" } },
        source: { branch: { name: "feat" }, commit: { hash: "srchash" } },
        destination: { branch: { name: "main" } },
      },
    });
    const pr = await provider().getPullRequest(REPO, "42");
    expect(pr).toEqual({
      id: "42",
      url: "https://bitbucket.org/acme-ws/widgets/pull-requests/42",
      state: "open",
      head: "feat",
      base: "main",
      title: "T",
      headSha: "srchash",
    });
  });

  it("maps MERGED and DECLINED PR states", async () => {
    const body = (state: string) => ({
      status: 200,
      body: { id: 42, state, title: "T", source: {}, destination: {} },
    });
    upstream.route("GET", `/repositories/${REPO}/pullrequests/42`, body("MERGED"));
    expect((await provider().getPullRequest(REPO, "42")).state).toBe("merged");
    upstream.route("GET", `/repositories/${REPO}/pullrequests/42`, body("DECLINED"));
    expect((await provider().getPullRequest(REPO, "42")).state).toBe("closed");
  });

  it("lists checks from PR statuses, mapping states and following pagination", async () => {
    upstream.route("GET", `/repositories/${REPO}/pullrequests/42/statuses`, {
      status: 200,
      body: {
        values: [
          { key: "ci", name: "Pipelines", state: "SUCCESSFUL", url: "https://ci/1" },
          { key: "lint", name: null, state: "FAILED" },
        ],
        next: `${upstream.baseUrl}/repositories/${REPO}/pullrequests/42/statuses?page=2`,
      },
    });
    upstream.route("GET", `/repositories/${REPO}/pullrequests/42/statuses?page=2`, {
      status: 200,
      body: {
        values: [
          { key: "e2e", state: "INPROGRESS" },
          { key: "old", state: "STOPPED" },
        ],
      },
    });
    const checks = await provider().listChecks(REPO, "42");
    expect(checks).toEqual([
      { name: "Pipelines", status: "success", url: "https://ci/1" },
      { name: "lint", status: "failure", url: null },
      { name: "e2e", status: "running", url: null },
      { name: "old", status: "canceled", url: null },
    ]);
  });

  it("merges with 'merge' strategy as merge_commit", async () => {
    upstream.route("POST", `/repositories/${REPO}/pullrequests/42/merge`, {
      status: 200,
      body: { state: "MERGED", merge_commit: { hash: "mhash" } },
    });
    const res = await provider().mergePullRequest(REPO, "42", "merge");
    expect(res).toEqual({ merged: true, sha: "mhash" });
    expect(upstream.requests[0]!.body).toEqual({
      merge_strategy: "merge_commit",
      close_source_branch: false,
    });
  });

  it("merges with 'squash' strategy", async () => {
    upstream.route("POST", `/repositories/${REPO}/pullrequests/42/merge`, {
      status: 200,
      body: { state: "MERGED", merge_commit: { hash: "shash" } },
    });
    const res = await provider().mergePullRequest(REPO, "42", "squash");
    expect(res).toEqual({ merged: true, sha: "shash" });
    expect(upstream.requests[0]!.body).toEqual({
      merge_strategy: "squash",
      close_source_branch: false,
    });
  });

  it("rejects the unsupported 'rebase' strategy without calling Bitbucket (fast_forward is not a rebase)", async () => {
    await expect(provider().mergePullRequest(REPO, "42", "rebase")).rejects.toThrow(
      /does not support a 'rebase' merge strategy.*fast_forward is not a rebase/,
    );
    expect(upstream.requests).toHaveLength(0);
  });

  it("surfaces an async 202 merge as an explicit retryable error, never a silent success", async () => {
    upstream.route("POST", `/repositories/${REPO}/pullrequests/42/merge`, {
      status: 202,
      body: { poll: { url: "https://api.bitbucket.org/poll" } },
    });
    const err = await provider()
      .mergePullRequest(REPO, "42", "merge")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitProviderError);
    expect((err as GitProviderError).status).toBe(202);
    expect((err as Error).message).toMatch(/asynchronously.*poll/);
  });

  it("maps 401 to an actionable app-password message", async () => {
    upstream.route("GET", `/repositories/${REPO}/refs/branches/main`, {
      status: 401,
      body: { type: "error", error: { message: "Unauthorized" } },
    });
    const err = await provider()
      .createBranch(REPO, "b", "main")
      .catch((e: unknown) => e);
    expect((err as GitProviderError).status).toBe(401);
    expect((err as Error).message).toMatch(/username:app_password/);
  });

  it("maps 404 to a workspace/repo_slug hint", async () => {
    upstream.route("GET", `/repositories/${REPO}/pullrequests/999`, {
      status: 404,
      body: { type: "error", error: { message: "Resource not found" } },
    });
    const err = await provider()
      .getPullRequest(REPO, "999")
      .catch((e: unknown) => e);
    expect((err as GitProviderError).status).toBe(404);
    expect((err as Error).message).toMatch(/workspace\/repo_slug/);
  });

  it("maps a 400 merge refusal to an actionable merge-conflict message", async () => {
    upstream.route("POST", `/repositories/${REPO}/pullrequests/42/merge`, {
      status: 400,
      body: { type: "error", error: { message: "There are conflicts" } },
    });
    const err = await provider()
      .mergePullRequest(REPO, "42", "merge")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitProviderError);
    expect((err as GitProviderError).status).toBe(400);
    expect((err as Error).message).toMatch(/merge conflict/);
    expect((err as Error).message).toMatch(/There are conflicts/);
  });
});
