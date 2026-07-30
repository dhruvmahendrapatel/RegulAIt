import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AzureDevOpsProvider } from "./azure-devops.js";
import { GitProviderError } from "./types.js";
import { FakeUpstream } from "./testkit.js";

const REPO = "Proj/widgets";
const BASE = "/Proj/_apis/git/repositories/widgets";
const API = "api-version=7.1";

describe("AzureDevOpsProvider (fake upstream over real HTTP)", () => {
  const upstream = new FakeUpstream();
  beforeAll(() => upstream.start());
  afterAll(() => upstream.stop());
  beforeEach(() => upstream.reset());

  const provider = () => new AzureDevOpsProvider({ token: "pat-secret", baseUrl: upstream.baseUrl });

  const prBody = (over: Record<string, unknown> = {}) => ({
    pullRequestId: 9,
    status: "active",
    title: "T",
    sourceRefName: "refs/heads/feat",
    targetRefName: "refs/heads/main",
    mergeStatus: "succeeded",
    lastMergeSourceCommit: { commitId: "srccommit" },
    repository: { webUrl: "https://dev.azure.com/acme/Proj/_git/widgets" },
    ...over,
  });

  it("creates a branch via refs lookup + POST refs with zero oldObjectId and PAT Basic auth", async () => {
    upstream.route("GET", `${BASE}/refs?filter=heads%2Fmain&${API}`, {
      status: 200,
      body: { value: [{ name: "refs/heads/main", objectId: "tipsha" }] },
    });
    upstream.route("POST", `${BASE}/refs?${API}`, {
      status: 200,
      body: { value: [{ success: true, updateStatus: "succeeded" }] },
    });
    await provider().createBranch(REPO, "feat", "main");
    expect(upstream.requests[0]!.headers.authorization).toBe(
      `Basic ${Buffer.from(":pat-secret").toString("base64")}`,
    );
    expect(upstream.requests[1]!.body).toEqual([
      {
        name: "refs/heads/feat",
        oldObjectId: "0000000000000000000000000000000000000000",
        newObjectId: "tipsha",
      },
    ]);
  });

  it("fails branch creation when the HTTP-200 refs response carries success:false (ADO gotcha)", async () => {
    upstream.route("GET", `${BASE}/refs?filter=heads%2Fmain&${API}`, {
      status: 200,
      body: { value: [{ name: "refs/heads/main", objectId: "tipsha" }] },
    });
    upstream.route("POST", `${BASE}/refs?${API}`, {
      status: 200,
      body: { value: [{ success: false, updateStatus: "staleOldObjectId" }] },
    });
    const err = await provider()
      .createBranch(REPO, "feat", "main")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitProviderError);
    expect((err as Error).message).toMatch(/staleOldObjectId.*already exists/);
  });

  it("404s branch creation when the prefix filter has no exact ref match", async () => {
    upstream.route("GET", `${BASE}/refs?filter=heads%2Fmain&${API}`, {
      status: 200,
      body: { value: [{ name: "refs/heads/main-old", objectId: "x" }] },
    });
    const err = await provider()
      .createBranch(REPO, "feat", "main")
      .catch((e: unknown) => e);
    expect((err as GitProviderError).status).toBe(404);
    expect((err as Error).message).toMatch(/base branch 'main' not found/);
  });

  it("opens a PR with refs/heads names and returns a human web URL", async () => {
    upstream.route("POST", `${BASE}/pullrequests?${API}`, { status: 201, body: prBody() });
    const pr = await provider().openPullRequest(REPO, {
      head: "feat",
      base: "main",
      title: "T",
      body: "B",
    });
    expect(pr).toEqual({
      id: "9",
      url: "https://dev.azure.com/acme/Proj/_git/widgets/pullrequest/9",
    });
    expect(upstream.requests[0]!.body).toEqual({
      sourceRefName: "refs/heads/feat",
      targetRefName: "refs/heads/main",
      title: "T",
      description: "B",
    });
  });

  it("gets a PR, maps active → open, and strips refs/heads/ prefixes", async () => {
    upstream.route("GET", `${BASE}/pullrequests/9?${API}`, { status: 200, body: prBody() });
    const pr = await provider().getPullRequest(REPO, "9");
    expect(pr).toEqual({
      id: "9",
      url: "https://dev.azure.com/acme/Proj/_git/widgets/pullrequest/9",
      state: "open",
      head: "feat",
      base: "main",
      title: "T",
      headSha: "srccommit",
    });
  });

  it("maps completed → merged and abandoned → closed", async () => {
    upstream.route("GET", `${BASE}/pullrequests/9?${API}`, {
      status: 200,
      body: prBody({ status: "completed" }),
    });
    expect((await provider().getPullRequest(REPO, "9")).state).toBe("merged");
    upstream.route("GET", `${BASE}/pullrequests/9?${API}`, {
      status: 200,
      body: prBody({ status: "abandoned" }),
    });
    expect((await provider().getPullRequest(REPO, "9")).state).toBe("closed");
  });

  it("lists checks from PR statuses with genre-prefixed names and state mapping", async () => {
    upstream.route("GET", `${BASE}/pullrequests/9/statuses?${API}`, {
      status: 200,
      body: {
        value: [
          {
            context: { name: "ci-build", genre: "continuous-integration" },
            state: "succeeded",
            targetUrl: "https://ci/1",
          },
          { context: { name: "lint" }, state: "failed" },
          { context: { name: "scan" }, state: "error" },
          { context: { name: "queued" }, state: "pending" },
          { context: { name: "na" }, state: "notApplicable" },
        ],
      },
    });
    const checks = await provider().listChecks(REPO, "9");
    expect(checks).toEqual([
      { name: "continuous-integration/ci-build", status: "success", url: "https://ci/1" },
      { name: "lint", status: "failure", url: null },
      { name: "scan", status: "failure", url: null },
      { name: "queued", status: "pending", url: null },
      { name: "na", status: "skipped", url: null },
    ]);
  });

  const mergeRoutes = (patchBody: Record<string, unknown>) => {
    upstream.route("GET", `${BASE}/pullrequests/9?${API}`, { status: 200, body: prBody() });
    upstream.route("PATCH", `${BASE}/pullrequests/9?${API}`, {
      status: 200,
      body: prBody(patchBody),
    });
  };

  it("merges via PR completion: 'merge' → noFastForward with the lastMergeSourceCommit", async () => {
    mergeRoutes({ status: "completed", lastMergeCommit: { commitId: "mergedsha" } });
    const res = await provider().mergePullRequest(REPO, "9", "merge");
    expect(res).toEqual({ merged: true, sha: "mergedsha" });
    expect(upstream.requests[1]!.body).toEqual({
      status: "completed",
      lastMergeSourceCommit: { commitId: "srccommit" },
      completionOptions: { mergeStrategy: "noFastForward", deleteSourceBranch: false },
    });
  });

  it("maps 'squash' and 'rebase' to ADO's squash and rebase completion strategies", async () => {
    mergeRoutes({ status: "completed", lastMergeCommit: { commitId: "s1" } });
    await provider().mergePullRequest(REPO, "9", "squash");
    expect(
      (upstream.requests[1]!.body as { completionOptions: { mergeStrategy: string } })
        .completionOptions.mergeStrategy,
    ).toBe("squash");
    upstream.reset();
    mergeRoutes({ status: "completed", lastMergeCommit: { commitId: "r1" } });
    const res = await provider().mergePullRequest(REPO, "9", "rebase");
    expect(res).toEqual({ merged: true, sha: "r1" });
    expect(
      (upstream.requests[1]!.body as { completionOptions: { mergeStrategy: string } })
        .completionOptions.mergeStrategy,
    ).toBe("rebase");
  });

  it("fails fast with 409 when the merge preview reports conflicts, without attempting completion", async () => {
    upstream.route("GET", `${BASE}/pullrequests/9?${API}`, {
      status: 200,
      body: prBody({ mergeStatus: "conflicts" }),
    });
    const err = await provider()
      .mergePullRequest(REPO, "9", "merge")
      .catch((e: unknown) => e);
    expect((err as GitProviderError).status).toBe(409);
    expect((err as Error).message).toMatch(/merge conflicts.*resolve/);
    expect(upstream.requests).toHaveLength(1); // no PATCH sent
  });

  it("treats a still-active PATCH response as async completion and throws instead of claiming success", async () => {
    mergeRoutes({ status: "active" });
    const err = await provider()
      .mergePullRequest(REPO, "9", "merge")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitProviderError);
    expect((err as Error).message).toMatch(/asynchronously.*poll/);
  });

  it("maps 401 to an actionable PAT-scope message", async () => {
    upstream.route("GET", `${BASE}/pullrequests/9?${API}`, {
      status: 401,
      body: { message: "TF400813: not authorized" },
    });
    const err = await provider()
      .getPullRequest(REPO, "9")
      .catch((e: unknown) => e);
    expect((err as GitProviderError).status).toBe(401);
    expect((err as Error).message).toMatch(/Code \(Read & Write\)/);
  });

  it("detects ADO's 203 HTML sign-in page as an auth failure", async () => {
    upstream.route("GET", `${BASE}/pullrequests/9?${API}`, {
      status: 203,
      body: "<html>Sign in to your account</html>",
    });
    const err = await provider()
      .getPullRequest(REPO, "9")
      .catch((e: unknown) => e);
    expect((err as GitProviderError).status).toBe(203);
    expect((err as Error).message).toMatch(/PAT was not accepted/);
  });

  it("maps 404 to a baseUrl/repo-format hint", async () => {
    upstream.route("GET", `${BASE}/pullrequests/404?${API}`, {
      status: 404,
      body: { message: "TF401180: pull request not found" },
    });
    const err = await provider()
      .getPullRequest(REPO, "404")
      .catch((e: unknown) => e);
    expect((err as GitProviderError).status).toBe(404);
    expect((err as Error).message).toMatch(/<project>\/<repository>/);
  });

  it("rejects a repo without a '<project>/<repository>' shape and a missing baseUrl", async () => {
    await expect(provider().getPullRequest("just-a-repo", "9")).rejects.toThrow(
      /must be '<project>\/<repository>'/,
    );
    expect(
      () => new AzureDevOpsProvider({ token: "t", baseUrl: "" }),
    ).toThrow(/requires a baseUrl/);
  });
});
