// ADR-0340: the compensating git calls (delete a branch, close a pull request) on every adapter. Each is
// idempotent (a branch already gone, a PR already closed answers false instead of failing) and closing a MERGED
// pull request throws, because closing cannot undo a merge.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AzureDevOpsProvider } from "./azure-devops.js";
import { BitbucketProvider } from "./bitbucket.js";
import { GitLabProvider } from "./gitlab.js";
import { GitHubProvider, MockGitProvider } from "./index.js";
import { FakeUpstream } from "./testkit.js";
import { GitProviderError } from "./types.js";

const upstream = new FakeUpstream();
beforeAll(() => upstream.start());
afterAll(() => upstream.stop());
beforeEach(() => upstream.reset());

describe("GitHubProvider compensation calls", () => {
  const p = () => new GitHubProvider({ token: "ghp-secret", baseUrl: upstream.baseUrl });
  const pr = (state: string, merged = false) => ({
    status: 200,
    body: { number: 7, html_url: "u", state, merged, title: "T", head: { ref: "h" }, base: { ref: "main" } },
  });

  it("deletes a branch (204) and treats a missing ref as already gone", async () => {
    upstream.route("DELETE", "/repos/o/r/git/refs/heads/regulait/abc", { status: 204, body: undefined });
    expect(await p().deleteBranch("o/r", "regulait/abc")).toEqual({ deleted: true });
    upstream.route("DELETE", "/repos/o/r/git/refs/heads/regulait/abc", { status: 422, body: { message: "Reference does not exist" } });
    expect(await p().deleteBranch("o/r", "regulait/abc")).toEqual({ deleted: false });
  });

  it("refuses a delete the server rejects, scrubbing the token", async () => {
    upstream.route("DELETE", "/repos/o/r/git/refs/heads/b", { status: 403, body: { message: "bad ghp-secret" } });
    const err = await p().deleteBranch("o/r", "b").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitProviderError);
    expect(String((err as Error).message)).not.toContain("ghp-secret");
  });

  it("closes an open PR, is idempotent on a closed one, refuses a merged one", async () => {
    upstream.route("GET", "/repos/o/r/pulls/7", pr("open"));
    upstream.route("PATCH", "/repos/o/r/pulls/7", { status: 200, body: { number: 7, state: "closed" } });
    expect(await p().closePullRequest("o/r", "7")).toEqual({ closed: true });
    expect(upstream.requests.at(-1)!.body).toEqual({ state: "closed" });
    upstream.route("GET", "/repos/o/r/pulls/7", pr("closed"));
    expect(await p().closePullRequest("o/r", "7")).toEqual({ closed: false });
    upstream.route("GET", "/repos/o/r/pulls/7", pr("closed", true));
    await expect(p().closePullRequest("o/r", "7")).rejects.toThrow(/merged; closing cannot undo it/);
  });
});

describe("GitLabProvider compensation calls", () => {
  const PROJ = encodeURIComponent("group/proj");
  const p = () => new GitLabProvider({ token: "glpat-secret", baseUrl: upstream.baseUrl });
  const mr = (state: string) => ({
    status: 200,
    body: { iid: 5, web_url: "u", state, source_branch: "f", target_branch: "main", title: "T" },
  });

  it("deletes a branch (URL-encoded name) and treats 404 as already gone", async () => {
    const path = `/api/v4/projects/${PROJ}/repository/branches/${encodeURIComponent("regulait/abc")}`;
    upstream.route("DELETE", path, { status: 204, body: undefined });
    expect(await p().deleteBranch("group/proj", "regulait/abc")).toEqual({ deleted: true });
    upstream.route("DELETE", path, { status: 404, body: { message: "404 Branch Not Found" } });
    expect(await p().deleteBranch("group/proj", "regulait/abc")).toEqual({ deleted: false });
  });

  it("closes an MR with state_event=close; closed is idempotent; merged refuses", async () => {
    upstream.route("GET", `/api/v4/projects/${PROJ}/merge_requests/5`, mr("opened"));
    upstream.route("PUT", `/api/v4/projects/${PROJ}/merge_requests/5`, { status: 200, body: { iid: 5, state: "closed" } });
    expect(await p().closePullRequest("group/proj", "5")).toEqual({ closed: true });
    expect(upstream.requests.at(-1)!.body).toEqual({ state_event: "close" });
    upstream.route("GET", `/api/v4/projects/${PROJ}/merge_requests/5`, mr("closed"));
    expect(await p().closePullRequest("group/proj", "5")).toEqual({ closed: false });
    upstream.route("GET", `/api/v4/projects/${PROJ}/merge_requests/5`, mr("merged"));
    await expect(p().closePullRequest("group/proj", "5")).rejects.toThrow(/merged/);
  });
});

describe("BitbucketProvider compensation calls", () => {
  const REPO = "acme-ws/widgets";
  const p = () => new BitbucketProvider({ token: "alice:app-pass-123", baseUrl: upstream.baseUrl });
  const pr = (state: string) => ({ status: 200, body: { id: 42, state, title: "T", source: {}, destination: {} } });

  it("deletes a branch and treats 404 as already gone", async () => {
    const path = `/repositories/${REPO}/refs/branches/${encodeURIComponent("regulait/abc")}`;
    upstream.route("DELETE", path, { status: 204, body: undefined });
    expect(await p().deleteBranch(REPO, "regulait/abc")).toEqual({ deleted: true });
    upstream.route("DELETE", path, { status: 404, body: { error: { message: "not found" } } });
    expect(await p().deleteBranch(REPO, "regulait/abc")).toEqual({ deleted: false });
  });

  it("declines an open PR; DECLINED is idempotent; MERGED refuses", async () => {
    upstream.route("GET", `/repositories/${REPO}/pullrequests/42`, pr("OPEN"));
    upstream.route("POST", `/repositories/${REPO}/pullrequests/42/decline`, { status: 200, body: { id: 42, state: "DECLINED" } });
    expect(await p().closePullRequest(REPO, "42")).toEqual({ closed: true });
    upstream.route("GET", `/repositories/${REPO}/pullrequests/42`, pr("DECLINED"));
    expect(await p().closePullRequest(REPO, "42")).toEqual({ closed: false });
    upstream.route("GET", `/repositories/${REPO}/pullrequests/42`, pr("MERGED"));
    await expect(p().closePullRequest(REPO, "42")).rejects.toThrow(/merged/);
  });
});

describe("AzureDevOpsProvider compensation calls", () => {
  const BASE = "/Proj/_apis/git/repositories/widgets";
  const API = "api-version=7.1";
  const p = () => new AzureDevOpsProvider({ token: "pat-secret", baseUrl: upstream.baseUrl });
  const pr = (status: string) => ({
    status: 200,
    body: { pullRequestId: 9, status, title: "T", sourceRefName: "refs/heads/f", targetRefName: "refs/heads/main", repository: { webUrl: "w" } },
  });

  it("deletes a branch by its exact ref with a zero newObjectId; a missing ref is already gone", async () => {
    upstream.route("GET", `${BASE}/refs?filter=${encodeURIComponent("heads/feat")}&${API}`, {
      status: 200,
      body: { value: [{ name: "refs/heads/feature-x", objectId: "other" }, { name: "refs/heads/feat", objectId: "tip" }] },
    });
    upstream.route("POST", `${BASE}/refs?${API}`, { status: 200, body: { value: [{ success: true, updateStatus: "succeeded" }] } });
    expect(await p().deleteBranch("Proj/widgets", "feat")).toEqual({ deleted: true });
    expect(upstream.requests.at(-1)!.body).toEqual([
      { name: "refs/heads/feat", oldObjectId: "tip", newObjectId: "0000000000000000000000000000000000000000" },
    ]);
    upstream.route("GET", `${BASE}/refs?filter=${encodeURIComponent("heads/feat")}&${API}`, {
      status: 200,
      body: { value: [{ name: "refs/heads/feature-x", objectId: "other" }] },
    });
    expect(await p().deleteBranch("Proj/widgets", "feat")).toEqual({ deleted: false });
  });

  it("a ref update ADO reports as failed (HTTP 200) throws", async () => {
    upstream.route("GET", `${BASE}/refs?filter=${encodeURIComponent("heads/feat")}&${API}`, {
      status: 200,
      body: { value: [{ name: "refs/heads/feat", objectId: "tip" }] },
    });
    upstream.route("POST", `${BASE}/refs?${API}`, { status: 200, body: { value: [{ success: false, updateStatus: "staleOldObjectId" }] } });
    await expect(p().deleteBranch("Proj/widgets", "feat")).rejects.toThrow(/staleOldObjectId/);
  });

  it("abandons an active PR; abandoned is idempotent; completed refuses", async () => {
    upstream.route("GET", `${BASE}/pullrequests/9?${API}`, pr("active"));
    upstream.route("PATCH", `${BASE}/pullrequests/9?${API}`, { status: 200, body: { pullRequestId: 9, status: "abandoned" } });
    expect(await p().closePullRequest("Proj/widgets", "9")).toEqual({ closed: true });
    expect(upstream.requests.at(-1)!.body).toEqual({ status: "abandoned" });
    upstream.route("GET", `${BASE}/pullrequests/9?${API}`, pr("abandoned"));
    expect(await p().closePullRequest("Proj/widgets", "9")).toEqual({ closed: false });
    upstream.route("GET", `${BASE}/pullrequests/9?${API}`, pr("completed"));
    await expect(p().closePullRequest("Proj/widgets", "9")).rejects.toThrow(/completed/);
  });
});

describe("MockGitProvider compensation calls", () => {
  it("deletes branches and closes PRs idempotently; a merged PR refuses", async () => {
    const m = new MockGitProvider();
    await m.createBranch("o/r", "b", "main");
    const pr = await m.openPullRequest("o/r", { head: "b", base: "main", title: "T", body: "" });
    expect(await m.closePullRequest("o/r", pr.id)).toEqual({ closed: true });
    expect((await m.getPullRequest("o/r", pr.id)).state).toBe("closed");
    expect(await m.closePullRequest("o/r", pr.id)).toEqual({ closed: false });
    expect(await m.deleteBranch("o/r", "b")).toEqual({ deleted: true });
    expect(await m.deleteBranch("o/r", "b")).toEqual({ deleted: false });
    await m.createBranch("o/r", "c", "main");
    const pr2 = await m.openPullRequest("o/r", { head: "c", base: "main", title: "T", body: "" });
    await m.mergePullRequest("o/r", pr2.id, "merge");
    await expect(m.closePullRequest("o/r", pr2.id)).rejects.toThrow(/merged/);
  });
});
