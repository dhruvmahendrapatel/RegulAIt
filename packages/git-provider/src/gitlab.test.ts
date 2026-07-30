import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GitLabProvider } from "./gitlab.js";
import { GitProviderError } from "./types.js";
import { FakeUpstream } from "./testkit.js";

const REPO = "group/proj";
const PROJ = encodeURIComponent(REPO); // group%2Fproj

describe("GitLabProvider (fake upstream over real HTTP)", () => {
  const upstream = new FakeUpstream();
  beforeAll(() => upstream.start());
  afterAll(() => upstream.stop());
  beforeEach(() => upstream.reset());

  const provider = () => new GitLabProvider({ token: "glpat-secret", baseUrl: upstream.baseUrl });

  it("creates a branch via POST repository/branches with PRIVATE-TOKEN auth and URL-encoded project path", async () => {
    upstream.route("POST", `/api/v4/projects/${PROJ}/repository/branches`, {
      status: 201,
      body: { name: "regulait/change-1" },
    });
    await provider().createBranch(REPO, "regulait/change-1", "main");
    const req = upstream.requests[0]!;
    expect(req.url).toBe(`/api/v4/projects/${PROJ}/repository/branches`);
    expect(req.headers["private-token"]).toBe("glpat-secret");
    expect(req.headers.authorization).toBeUndefined();
    expect(req.body).toEqual({ branch: "regulait/change-1", ref: "main" });
  });

  it("appends /api/v4 to a bare instance baseUrl but not to an already-suffixed one", async () => {
    upstream.route("POST", `/api/v4/projects/${PROJ}/repository/branches`, {
      status: 201,
      body: {},
    });
    const suffixed = new GitLabProvider({ token: "t", baseUrl: `${upstream.baseUrl}/api/v4` });
    await suffixed.createBranch(REPO, "b1", "main");
    expect(upstream.requests[0]!.url).toBe(`/api/v4/projects/${PROJ}/repository/branches`);
  });

  it("opens an MR (source/target_branch vocabulary) and returns the iid, not the global id", async () => {
    upstream.route("POST", `/api/v4/projects/${PROJ}/merge_requests`, {
      status: 201,
      body: { id: 991234, iid: 5, web_url: "https://gitlab.com/group/proj/-/merge_requests/5" },
    });
    const pr = await provider().openPullRequest(REPO, {
      head: "feat",
      base: "main",
      title: "T",
      body: "B",
    });
    expect(pr).toEqual({ id: "5", url: "https://gitlab.com/group/proj/-/merge_requests/5" });
    expect(upstream.requests[0]!.body).toEqual({
      source_branch: "feat",
      target_branch: "main",
      title: "T",
      description: "B",
    });
  });

  it("gets an MR and maps opened → open", async () => {
    upstream.route("GET", `/api/v4/projects/${PROJ}/merge_requests/5`, {
      status: 200,
      body: {
        iid: 5,
        web_url: "https://gitlab.com/group/proj/-/merge_requests/5",
        state: "opened",
        source_branch: "feat",
        target_branch: "main",
        title: "T",
        sha: "headsha1",
      },
    });
    const pr = await provider().getPullRequest(REPO, "5");
    expect(pr).toEqual({
      id: "5",
      url: "https://gitlab.com/group/proj/-/merge_requests/5",
      state: "open",
      head: "feat",
      base: "main",
      title: "T",
      headSha: "headsha1",
    });
  });

  it("maps merged and closed MR states", async () => {
    const body = (state: string) => ({
      status: 200,
      body: { iid: 5, web_url: "u", state, source_branch: "f", target_branch: "m", title: "t" },
    });
    upstream.route("GET", `/api/v4/projects/${PROJ}/merge_requests/5`, body("merged"));
    expect((await provider().getPullRequest(REPO, "5")).state).toBe("merged");
    upstream.route("GET", `/api/v4/projects/${PROJ}/merge_requests/5`, body("closed"));
    expect((await provider().getPullRequest(REPO, "5")).state).toBe("closed");
  });

  it("lists checks from the head commit statuses with status mapping", async () => {
    upstream.route("GET", `/api/v4/projects/${PROJ}/merge_requests/5`, {
      status: 200,
      body: { iid: 5, web_url: "u", state: "opened", source_branch: "f", target_branch: "m", title: "t", sha: "abc" },
    });
    upstream.route("GET", `/api/v4/projects/${PROJ}/repository/commits/abc/statuses`, {
      status: 200,
      body: [
        { name: "build", status: "success", target_url: "https://ci/1" },
        { name: "lint", status: "failed" },
        { name: "e2e", status: "running" },
        { name: "deploy", status: "manual" },
        { name: "flaky", status: "canceled" },
        { name: "docs", status: "skipped" },
      ],
    });
    const checks = await provider().listChecks(REPO, "5");
    expect(checks).toEqual([
      { name: "build", status: "success", url: "https://ci/1" },
      { name: "lint", status: "failure", url: null },
      { name: "e2e", status: "running", url: null },
      { name: "deploy", status: "pending", url: null },
      { name: "flaky", status: "canceled", url: null },
      { name: "docs", status: "skipped", url: null },
    ]);
  });

  it("merges with 'merge' strategy (squash=false) and returns the merge commit sha", async () => {
    upstream.route("PUT", `/api/v4/projects/${PROJ}/merge_requests/5/merge`, {
      status: 200,
      body: { state: "merged", merge_commit_sha: "mergesha", sha: "headsha" },
    });
    const res = await provider().mergePullRequest(REPO, "5", "merge");
    expect(res).toEqual({ merged: true, sha: "mergesha" });
    expect(upstream.requests[0]!.body).toEqual({ squash: false });
  });

  it("merges with 'squash' strategy (squash=true) and prefers the squash commit sha", async () => {
    upstream.route("PUT", `/api/v4/projects/${PROJ}/merge_requests/5/merge`, {
      status: 200,
      body: { state: "merged", merge_commit_sha: null, squash_commit_sha: "squashsha", sha: "headsha" },
    });
    const res = await provider().mergePullRequest(REPO, "5", "squash");
    expect(res).toEqual({ merged: true, sha: "squashsha" });
    expect(upstream.requests[0]!.body).toEqual({ squash: true });
  });

  it("rejects the unsupported 'rebase' strategy without calling GitLab", async () => {
    await expect(provider().mergePullRequest(REPO, "5", "rebase")).rejects.toThrow(
      /gitlab does not support a per-merge 'rebase' strategy.*project-level/,
    );
    expect(upstream.requests).toHaveLength(0);
  });

  it("maps 401 to an actionable PRIVATE-TOKEN message", async () => {
    upstream.route("POST", `/api/v4/projects/${PROJ}/repository/branches`, {
      status: 401,
      body: { message: "401 Unauthorized" },
    });
    const err = await provider()
      .createBranch(REPO, "b", "main")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitProviderError);
    expect((err as GitProviderError).status).toBe(401);
    expect((err as Error).message).toMatch(/access token with 'api' scope.*PRIVATE-TOKEN/);
  });

  it("maps 404 to a project-path hint (GitLab 404s on invisible projects)", async () => {
    upstream.route("GET", `/api/v4/projects/${PROJ}/merge_requests/9`, {
      status: 404,
      body: { message: "404 Project Not Found" },
    });
    const err = await provider()
      .getPullRequest(REPO, "9")
      .catch((e: unknown) => e);
    expect((err as GitProviderError).status).toBe(404);
    expect((err as Error).message).toMatch(/'group\/project'.*cannot see/);
  });

  it("maps a 406 merge refusal to an actionable merge-conflict message", async () => {
    upstream.route("PUT", `/api/v4/projects/${PROJ}/merge_requests/5/merge`, {
      status: 406,
      body: { message: "Branch cannot be merged" },
    });
    const err = await provider()
      .mergePullRequest(REPO, "5", "merge")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitProviderError);
    expect((err as GitProviderError).status).toBe(406);
    expect((err as Error).message).toMatch(/merge conflict/);
    expect((err as Error).message).toMatch(/Branch cannot be merged/);
  });
});
