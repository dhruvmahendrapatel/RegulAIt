// ADR-0195 SD1: the read-only repo readers against a fake upstream over real
// HTTP. Response bodies are synthetic, shaped after each provider's documented
// REST responses (no recorded customer data). Tokens are derived at runtime.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeUpstream } from "../testkit.js";
import { GitProviderError } from "../types.js";
import { readCapped } from "./http.js";
import {
  REPO_READ_DEFAULTS,
  GitProviderRateLimitError,
  HistoryScanDisabledError,
  nextLinkFromHeader,
  parseRetryAfterMs,
  resolveRepoReader,
  type ReadFetchLike,
  type RepoReader,
  type RepoReaderKind,
} from "./index.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const TREE_SHA = "fedcba9876543210fedcba9876543210fedcba98";
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

describe("repo readers (ADR-0195 SD1)", () => {
  const upstream = new FakeUpstream();
  const token = `synthetic-${randomUUID()}`;
  const sleeps: number[] = [];
  const fetchImpl: ReadFetchLike = (url, init) => fetch(url, init);
  beforeAll(() => upstream.start());
  afterAll(() => upstream.stop());
  beforeEach(() => {
    upstream.reset();
    sleeps.length = 0;
  });

  const reader = (
    kind: RepoReaderKind,
    extra: { allowHistory?: boolean; maxRetries?: number; maxWaitMs?: number; baseUrl?: string; token?: string; insecureHttp?: boolean } = {},
  ): RepoReader =>
    resolveRepoReader(kind, {
      token: extra.token ?? token,
      baseUrl: extra.baseUrl ?? upstream.baseUrl,
      fetchImpl,
      // the fake upstream is plain http on loopback: only the explicit test seam accepts it
      allowInsecureHttpForTests: extra.insecureHttp ?? true,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      now: () => 1_700_000_000_000,
      ...(extra.allowHistory !== undefined ? { allowHistory: extra.allowHistory } : {}),
      ...(extra.maxRetries !== undefined ? { maxRetries: extra.maxRetries } : {}),
      ...(extra.maxWaitMs !== undefined ? { maxWaitMs: extra.maxWaitMs } : {}),
    });

  const onlyGets = () => expect(upstream.requests.every((r) => r.method === "GET" || r.method === "HEAD")).toBe(true);

  it("refuses to build a reader without an injected (guarded) fetch", () => {
    expect(() =>
      resolveRepoReader("github", { token, fetchImpl: undefined as unknown as ReadFetchLike }),
    ).toThrow(/guarded fetch/);
    expect(() => resolveRepoReader("mock", { token, fetchImpl })).toThrow(GitProviderError);
    expect(() => resolveRepoReader("azure_devops", { token, fetchImpl })).toThrow(/baseUrl/);
  });

  describe("GitHub", () => {
    it("lists repos across Link-header pages", async () => {
      upstream.route("GET", "/user/repos?per_page=100&affiliation=owner,collaborator,organization_member", {
        status: 200,
        body: [{ full_name: "acme/one", default_branch: "main", archived: false }],
        headers: { link: `<${upstream.baseUrl}/user/repos?page=2>; rel="next", <${upstream.baseUrl}/user/repos?page=2>; rel="last"` },
      });
      upstream.route("GET", "/user/repos?page=2", {
        status: 200,
        body: [{ full_name: "acme/two", default_branch: null, archived: true }],
      });
      const out = await reader("github").listRepos();
      expect(out).toEqual({
        repos: [
          { fullName: "acme/one", defaultBranch: "main", archived: false },
          { fullName: "acme/two", defaultBranch: null, archived: true },
        ],
        truncated: false,
      });
      expect(upstream.requests[0]!.headers.authorization).toBe(`Bearer ${token}`);
      onlyGets();
    });

    it("refuses a pagination link to another origin", async () => {
      upstream.route("GET", "/orgs/acme/repos?per_page=100&type=all", {
        status: 200,
        body: [],
        headers: { link: '<https://elsewhere.invalid/x>; rel="next"' },
      });
      await expect(reader("github").listRepos({ namespace: "acme" })).rejects.toThrow(/another origin/);
    });

    it("reads the default-branch head tree (files only) with the head commit's raw author", async () => {
      upstream.route("GET", "/repos/acme/one", { status: 200, body: { default_branch: "main" } });
      upstream.route("GET", "/repos/acme/one/branches/main", {
        status: 200,
        body: { commit: { sha: SHA, commit: { author: { name: "Dev One", email: "dev1@example.test" }, tree: { sha: TREE_SHA } } } },
      });
      upstream.route("GET", `/repos/acme/one/git/trees/${TREE_SHA}?recursive=1`, {
        status: 200,
        body: {
          truncated: false,
          tree: [
            { path: "src", type: "tree" },
            { path: "package.json", type: "blob", size: 120 },
            { path: "vendor/lib", type: "commit" },
          ],
        },
      });
      const tree = await reader("github").getTree("acme/one");
      expect(tree).toEqual({
        repo: "acme/one",
        ref: "main",
        commitSha: SHA,
        author: { name: "Dev One", email: "dev1@example.test" },
        entries: [{ path: "package.json", size: 120 }],
        truncated: false,
      });
      onlyGets();
    });

    it("reads a file at a commit; reports too_large, binary and not_found", async () => {
      upstream.route("GET", `/repos/acme/one/contents/a%20b/package.json?ref=${SHA}`, {
        status: 200,
        body: { type: "file", encoding: "base64", content: b64('{"name":"x"}'), size: 12 },
      });
      upstream.route("GET", `/repos/acme/one/contents/big.json?ref=${SHA}`, {
        status: 200,
        body: { type: "file", encoding: "none", content: "", size: 5_000_000 },
      });
      upstream.route("GET", `/repos/acme/one/contents/img.bin?ref=${SHA}`, {
        status: 200,
        body: { type: "file", encoding: "base64", content: Buffer.from([0x89, 0, 1]).toString("base64"), size: 3 },
      });
      upstream.route("GET", `/repos/acme/one/contents/gone?ref=${SHA}`, { status: 404, body: { message: "Not Found" } });
      const r = reader("github");
      expect(await r.readFile("acme/one", "a b/package.json", { commitSha: SHA })).toEqual({ status: "ok", content: '{"name":"x"}', size: 12 });
      expect(await r.readFile("acme/one", "big.json", { commitSha: SHA })).toEqual({ status: "too_large", size: 5_000_000 });
      expect(await r.readFile("acme/one", "img.bin", { commitSha: SHA })).toEqual({ status: "binary", size: 3 });
      expect(await r.readFile("acme/one", "gone", { commitSha: SHA })).toEqual({ status: "not_found" });
      await expect(r.readFile("acme/one", "../etc/passwd", { commitSha: SHA })).rejects.toThrow(/invalid file path/);
      await expect(r.readFile("acme/one", "x", { commitSha: "main" })).rejects.toThrow(/invalid commit sha/);
      await expect(r.getTree("acme/../x")).rejects.toThrow(/invalid repo/);
      await expect(r.getTree("acme/one/extra")).rejects.toThrow(/invalid repo/);
      onlyGets();
    });

    it("backs off on 429 using Retry-After, then succeeds", async () => {
      let calls = 0;
      upstream.route("GET", "/repos/acme/one", () =>
        ++calls === 1 ? { status: 429, body: {}, headers: { "retry-after": "2" } } : { status: 200, body: { default_branch: null } },
      );
      const tree = await reader("github").getTree("acme/one");
      expect(tree.entries).toEqual([]);
      expect(sleeps).toEqual([2000]);
      expect(calls).toBe(2);
    });

    it("treats a spent primary limit (403, remaining 0) as a rate limit and gives up with a retry-after", async () => {
      upstream.route("GET", "/repos/acme/one", {
        status: 403,
        body: { message: "API rate limit exceeded" },
        headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(1_700_000_000 + 3600) },
      });
      const err = await reader("github").getTree("acme/one").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(GitProviderRateLimitError);
      expect((err as GitProviderRateLimitError).retryAfterMs).toBe(3_600_000);
      expect(sleeps).toEqual([]); // an hour is longer than maxWaitMs: no sleeping inside a run
    });

    it("stops after maxRetries with exponential backoff when no hint is sent", async () => {
      upstream.route("GET", "/repos/acme/one", { status: 429, body: {} });
      await expect(reader("github", { maxRetries: 2 }).getTree("acme/one")).rejects.toBeInstanceOf(GitProviderRateLimitError);
      expect(sleeps).toEqual([1000, 2000]);
      expect(upstream.requests).toHaveLength(3);
    });

    it("maxRetries 0 gives up at once without sleeping (the caller owns the waiting)", async () => {
      upstream.route("GET", "/repos/acme/one", { status: 429, body: {}, headers: { "retry-after": "1" } });
      await expect(reader("github", { maxRetries: 0 }).getTree("acme/one")).rejects.toBeInstanceOf(GitProviderRateLimitError);
      expect(sleeps).toEqual([]);
      expect(upstream.requests).toHaveLength(1);
    });

    it("scrubs the token out of an upstream error", async () => {
      upstream.route("GET", "/repos/acme/one", { status: 500, body: { echoed: token } });
      const err = (await reader("github").getTree("acme/one").catch((e: unknown) => e)) as Error;
      expect(err).toBeInstanceOf(GitProviderError);
      expect(err.message).not.toContain(token);
    });

    it("history is off by default and on only with allowHistory", async () => {
      await expect(reader("github").listCommits("acme/one")).rejects.toBeInstanceOf(HistoryScanDisabledError);
      await expect(reader("github").getTreeAt("acme/one", SHA)).rejects.toBeInstanceOf(HistoryScanDisabledError);
      expect(upstream.requests).toHaveLength(0);
      upstream.route("GET", "/repos/acme/one/commits?per_page=100", {
        status: 200,
        body: [{ sha: SHA, commit: { author: { name: "Dev", email: "d@example.test", date: "2026-10-01T00:00:00Z" } } }],
      });
      const commits = await reader("github", { allowHistory: true }).listCommits("acme/one");
      expect(commits).toEqual([{ sha: SHA, author: { name: "Dev", email: "d@example.test" }, committedAt: "2026-10-01T00:00:00Z" }]);
    });

    it("reports a classic token with write scopes, and an unreported scope as unverified", async () => {
      // a classic-prefixed token, assembled at runtime (no secret-shaped literal)
      const classic = ["gh", "p_", "C".repeat(36)].join("");
      upstream.route("GET", "/user", { status: 200, body: {}, headers: { "x-oauth-scopes": "repo, read:org" } });
      expect((await reader("github").inspectCredential()).status).toBe("write_scope");
      upstream.reset();
      upstream.route("GET", "/user", { status: 200, body: {}, headers: { "x-oauth-scopes": "read:org, read:user" } });
      expect((await reader("github", { token: classic }).inspectCredential()).status).toBe("read_only");
      // the same allow-listed header on a token without a classic prefix proves nothing
      expect((await reader("github").inspectCredential()).status).toBe("unverified");
      // an EMPTY header: unverified for a non-classic token, and for a classic one
      upstream.reset();
      upstream.route("GET", "/user", { status: 200, body: {}, headers: { "x-oauth-scopes": "" } });
      expect((await reader("github").inspectCredential()).status).toBe("unverified");
      expect((await reader("github", { token: classic }).inspectCredential()).status).toBe("unverified");
      for (const scope of ["gist", "user", "project", "write:discussion", "admin:gpg_key", "codespace", "delete:packages", "brand:new"]) {
        upstream.reset();
        upstream.route("GET", "/user", { status: 200, body: {}, headers: { "x-oauth-scopes": `read:org, ${scope}` } });
        expect((await reader("github").inspectCredential()).status, scope).toBe("write_scope");
      }
      upstream.reset();
      upstream.route("GET", "/user", { status: 200, body: {} });
      expect((await reader("github").inspectCredential()).status).toBe("unverified");
    });
  });

  describe("GitLab", () => {
    const P = encodeURIComponent("grp/sub/proj");
    it("lists projects through x-next-page", async () => {
      upstream.route("GET", "/api/v4/groups/grp/projects?include_subgroups=true&archived=false&per_page=100&page=1", {
        status: 200,
        body: [{ path_with_namespace: "grp/sub/proj", default_branch: "main" }],
        headers: { "x-next-page": "2" },
      });
      upstream.route("GET", "/api/v4/groups/grp/projects?include_subgroups=true&archived=false&per_page=100&page=2", {
        status: 200,
        body: [{ path_with_namespace: "grp/other", default_branch: "trunk" }],
        headers: { "x-next-page": "" },
      });
      const out = await reader("gitlab").listRepos({ namespace: "grp" });
      expect(out.repos.map((r) => r.fullName)).toEqual(["grp/sub/proj", "grp/other"]);
      expect(upstream.requests[0]!.headers["private-token"]).toBe(token);
      onlyGets();
    });

    it("reads the head tree and a file", async () => {
      upstream.route("GET", `/api/v4/projects/${P}`, { status: 200, body: { default_branch: "main" } });
      upstream.route("GET", `/api/v4/projects/${P}/repository/branches/main`, {
        status: 200,
        body: { commit: { id: SHA, author_name: "Dev Two", author_email: "dev2@example.test" } },
      });
      upstream.route("GET", `/api/v4/projects/${P}/repository/tree?ref=${SHA}&recursive=true&per_page=100&page=1`, {
        status: 200,
        body: [
          { path: "app", type: "tree" },
          { path: "app/requirements.txt", type: "blob" },
        ],
      });
      upstream.route("HEAD", `/api/v4/projects/${P}/repository/files/app%2Frequirements.txt?ref=${SHA}`, {
        status: 200,
        body: {},
        headers: { "x-gitlab-size": "7" },
      });
      upstream.route("GET", `/api/v4/projects/${P}/repository/files/app%2Frequirements.txt?ref=${SHA}`, {
        status: 200,
        body: { size: 7, encoding: "base64", content: b64("openai\n") },
      });
      const r = reader("gitlab");
      const tree = await r.getTree("grp/sub/proj");
      expect(tree.entries).toEqual([{ path: "app/requirements.txt", size: null }]);
      expect(tree.author).toEqual({ name: "Dev Two", email: "dev2@example.test" });
      expect(await r.readFile("grp/sub/proj", "app/requirements.txt", { commitSha: SHA })).toEqual({ status: "ok", content: "openai\n", size: 7 });
      onlyGets();
    });

    it("never downloads a file whose HEAD size is past the cap", async () => {
      upstream.route("HEAD", `/api/v4/projects/${P}/repository/files/big.json?ref=${SHA}`, { status: 200, body: {}, headers: { "x-gitlab-size": "9000000" } });
      expect(await reader("gitlab").readFile("grp/sub/proj", "big.json", { commitSha: SHA })).toEqual({ status: "too_large", size: 9_000_000 });
      expect(upstream.requests.map((r) => r.method)).toEqual(["HEAD"]);
    });

    it("refuses a token with the api scope, or any scope not on the read-only allow-list", async () => {
      upstream.route("GET", "/api/v4/personal_access_tokens/self", { status: 200, body: { scopes: ["api"] } });
      expect((await reader("gitlab").inspectCredential()).status).toBe("write_scope");
      upstream.reset();
      upstream.route("GET", "/api/v4/personal_access_tokens/self", { status: 200, body: { scopes: ["read_api", "read_repository"] } });
      expect((await reader("gitlab").inspectCredential()).status).toBe("read_only");
      for (const scope of ["self_rotate", "ai_features", "write_virtual_registry", "some_future_scope"]) {
        upstream.reset();
        upstream.route("GET", "/api/v4/personal_access_tokens/self", { status: 200, body: { scopes: ["read_api", scope] } });
        expect((await reader("gitlab").inspectCredential()).status, scope).toBe("write_scope");
      }
    });
  });

  describe("Bitbucket", () => {
    it("lists, reads the tree through body next links, and reads a raw file", async () => {
      upstream.route("GET", "/repositories/ws?pagelen=100", {
        status: 200,
        body: { values: [{ full_name: "ws/app", mainbranch: { name: "main" } }], next: `${upstream.baseUrl}/repositories/ws?pagelen=100&page=2` },
      });
      upstream.route("GET", "/repositories/ws?pagelen=100&page=2", { status: 200, body: { values: [] } });
      upstream.route("GET", "/repositories/ws/app", { status: 200, body: { mainbranch: { name: "main" } } });
      upstream.route("GET", "/repositories/ws/app/refs/branches/main", {
        status: 200,
        body: { target: { hash: SHA, author: { raw: "Dev Three <dev3@example.test>" } } },
      });
      upstream.route("GET", `/repositories/ws/app/src/${SHA}/?max_depth=30&pagelen=100`, {
        status: 200,
        body: {
          values: [
            { type: "commit_directory", path: "svc" },
            { type: "commit_file", path: "svc/go.mod", size: 40 },
          ],
        },
      });
      upstream.route("GET", `/repositories/ws/app/src/${SHA}/svc/go.mod`, { status: 200, body: "module x\n" });
      const r = reader("bitbucket");
      expect((await r.listRepos({ namespace: "ws" })).repos).toEqual([{ fullName: "ws/app", defaultBranch: "main", archived: false }]);
      const tree = await r.getTree("ws/app");
      expect(tree.entries).toEqual([{ path: "svc/go.mod", size: 40 }]);
      expect(tree.author).toEqual({ name: "Dev Three", email: "dev3@example.test" });
      expect(await r.readFile("ws/app", "svc/go.mod", { commitSha: SHA })).toEqual({ status: "ok", content: "module x\n", size: 9 });
      expect(upstream.requests[0]!.headers.authorization).toBe(`Bearer ${token}`);
      onlyGets();
    });
  });

  describe("Bitbucket caps and scopes", () => {
    it("stops reading a raw file past the cap (no Content-Length), and treats unknown scopes as write", async () => {
      upstream.route("GET", `/repositories/ws/app/src/${SHA}/big.txt`, { status: 200, body: "x".repeat(300_000) });
      expect((await reader("bitbucket").readFile("ws/app", "big.txt", { commitSha: SHA, maxBytes: 1_000 })).status).toBe("too_large");
      upstream.route("GET", "/user", { status: 200, body: {}, headers: { "x-oauth-scopes": "repository, account" } });
      expect((await reader("bitbucket").inspectCredential()).status).toBe("read_only");
      for (const scope of ["webhook", "pipeline:variable", "repository:write", "pullrequest", "issue", "wiki", "new-thing"]) {
        upstream.reset();
        upstream.route("GET", "/user", { status: 200, body: {}, headers: { "x-oauth-scopes": `repository, ${scope}` } });
        expect((await reader("bitbucket").inspectCredential()).status, scope).toBe("write_scope");
      }
      await expect(reader("bitbucket").getTree("ws/app/extra")).rejects.toThrow(/invalid repo/);
    });
  });

  describe("API base", () => {
    it("must be https with no credentials, query or fragment; plain http only through the explicit test seam", () => {
      for (const baseUrl of ["http://git.example.test", "https://u:p@git.example.test", "https://git.example.test/?a=1", "https://git.example.test/#x", "not a url"]) {
        expect(() => reader("github", { baseUrl, insecureHttp: false }), baseUrl).toThrow(/baseUrl/);
      }
      // loopback is NOT special: without the seam, http on 127.0.0.1 is refused too
      expect(() => reader("github", { baseUrl: upstream.baseUrl, insecureHttp: false })).toThrow(/baseUrl/);
      expect(() => reader("github", { baseUrl: "https://ghe.example.test/api/v3", insecureHttp: false })).not.toThrow();
    });
  });

  describe("byte caps", () => {
    /** a body that hands out `chunks` chunks of `size` bytes and counts how many were pulled */
    function countingBody(chunks: number, size: number) {
      let pulled = 0;
      let cancelled = false;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (pulled >= chunks) return controller.close();
          pulled++;
          controller.enqueue(new Uint8Array(size).fill(0x61));
        },
        cancel() {
          cancelled = true;
        },
      }, { highWaterMark: 0 });
      return { stream, pulled: () => pulled, cancelled: () => cancelled };
    }
    const res = (body: ReadableStream<Uint8Array>, headers: Record<string, string> = {}) => ({
      status: 200,
      headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
      body,
      json: async () => {
        throw new Error("json() must not be called");
      },
      text: async () => {
        throw new Error("text() must not be called");
      },
    });

    it("cancels the stream at the first chunk past the cap", async () => {
      const b = countingBody(100, 1_000);
      const out = await readCapped(res(b.stream), 2_500);
      expect(out.text).toBeNull();
      expect(b.pulled()).toBe(3); // 1000 + 1000 + 1000 > 2500: stopped on the third chunk
      expect(b.cancelled()).toBe(true);
    });

    it("reads no chunk when Content-Length is already over the cap", async () => {
      const b = countingBody(100, 1_000);
      const out = await readCapped(res(b.stream, { "content-length": "100000" }), 2_500);
      expect(out).toEqual({ text: null, bytes: 100_000 });
      expect(b.pulled()).toBe(0);
    });

    it("returns the text when the body fits", async () => {
      const b = countingBody(2, 1_000);
      expect((await readCapped(res(b.stream), 2_500)).text).toBe("a".repeat(2_000));
    });

    it("an empty or malformed scope list is unverified, never read_only (Bitbucket empty header; GitLab {}, [], non-string entries)", async () => {
      upstream.route("GET", "/user", { status: 200, body: {}, headers: { "x-oauth-scopes": "" } });
      expect((await reader("bitbucket").inspectCredential()).status).toBe("unverified");
      for (const body of [{}, { scopes: [] }, { scopes: ["read_api", 42] }, { scopes: ["read_api", null] }]) {
        upstream.reset();
        upstream.route("GET", "/api/v4/personal_access_tokens/self", { status: 200, body });
        expect((await reader("gitlab").inspectCredential()).status, JSON.stringify(body)).toBe("unverified");
      }
    });

    it("GitLab token scopes and Azure DevOps JSON are read under the metadata cap", async () => {
      const over = { "content-length": String(REPO_READ_DEFAULTS.maxMetadataBytes + 1) };
      upstream.route("GET", "/api/v4/personal_access_tokens/self", { status: 200, body: { scopes: ["read_api"] }, headers: over });
      await expect(reader("gitlab").inspectCredential()).rejects.toThrow(/metadata cap/);
      upstream.route("GET", "/org/_apis/git/repositories?api-version=7.1", { status: 200, body: { value: [] }, headers: over });
      await expect(reader("azure_devops", { baseUrl: `${upstream.baseUrl}/org` }).listRepos()).rejects.toThrow(/metadata cap/);
    });

    it("refuses a metadata body over the metadata cap with a bounded error", async () => {
      upstream.route("GET", "/repos/acme/huge", { status: 200, body: {}, headers: { "content-length": String(REPO_READ_DEFAULTS.maxMetadataBytes + 1) } });
      await expect(reader("github").getTree("acme/huge")).rejects.toThrow(/metadata cap/);
    });
  });

  describe("Azure DevOps", () => {
    it("lists with continuation tokens, reads the head tree and a file", async () => {
      upstream.route("GET", "/org/_apis/git/repositories?api-version=7.1", {
        status: 200,
        body: { value: [{ name: "svc", project: { name: "Proj A" }, defaultBranch: "refs/heads/main" }] },
        headers: { "x-ms-continuationtoken": "tok2" },
      });
      upstream.route("GET", "/org/_apis/git/repositories?api-version=7.1&continuationToken=tok2", {
        status: 200,
        body: { value: [{ name: "old", project: { name: "Proj A" }, isDisabled: true }] },
      });
      const repoBase = "/org/Proj%20A/_apis/git/repositories/svc";
      upstream.route("GET", `${repoBase}?api-version=7.1`, { status: 200, body: { defaultBranch: "refs/heads/main" } });
      upstream.route("GET", `${repoBase}/commits?searchCriteria.itemVersion.version=main&searchCriteria.$top=1&api-version=7.1`, {
        status: 200,
        body: { value: [{ commitId: SHA, author: { name: "Dev Four", email: "dev4@example.test" } }] },
      });
      upstream.route(
        "GET",
        `${repoBase}/items?scopePath=%2F&recursionLevel=Full&versionDescriptor.version=${SHA}&versionDescriptor.versionType=commit&api-version=7.1`,
        {
          status: 200,
          body: {
            value: [
              { path: "/", isFolder: true },
              { path: "/src", isFolder: true },
              { path: "/src/app.csproj", gitObjectType: "blob" },
            ],
          },
        },
      );
      upstream.route(
        "GET",
        `${repoBase}/items?path=%2Fsrc%2Fapp.csproj&versionDescriptor.version=${SHA}&versionDescriptor.versionType=commit&includeContent=true&$format=json&api-version=7.1`,
        { status: 200, body: { content: "<Project/>", contentMetadata: { isBinary: false } } },
      );
      const r = reader("azure_devops", { baseUrl: `${upstream.baseUrl}/org` });
      const list = await r.listRepos();
      expect(list.repos).toEqual([
        { fullName: "Proj A/svc", defaultBranch: "main", archived: false },
        { fullName: "Proj A/old", defaultBranch: null, archived: true },
      ]);
      const tree = await r.getTree("Proj A/svc");
      expect(tree.entries).toEqual([{ path: "src/app.csproj", size: null }]);
      expect(await r.readFile("Proj A/svc", "src/app.csproj", { commitSha: SHA })).toEqual({ status: "ok", content: "<Project/>", size: 10 });
      expect(upstream.requests[0]!.headers.authorization).toBe(`Basic ${Buffer.from(`:${token}`).toString("base64")}`);
      expect((await r.inspectCredential()).status).toBe("unverified");
      onlyGets();
    });

    it("raises the 203 sign-in page as an auth error", async () => {
      upstream.route("GET", "/org/_apis/git/repositories?api-version=7.1", { status: 203, body: "<html>sign in</html>" });
      const err = await reader("azure_devops", { baseUrl: `${upstream.baseUrl}/org` }).listRepos().catch((e: unknown) => e);
      expect((err as GitProviderError).status).toBe(401);
    });
  });

  it("header parsers are total", () => {
    expect(nextLinkFromHeader(null)).toBeNull();
    expect(nextLinkFromHeader('<https://a.test/x?page=2>; rel="next"')).toBe("https://a.test/x?page=2");
    expect(nextLinkFromHeader('<https://a.test/x?page=9>; rel="last"')).toBeNull();
    expect(parseRetryAfterMs("5", 0)).toBe(5000);
    expect(parseRetryAfterMs("not a date", 0)).toBeNull();
    expect(parseRetryAfterMs(new Date(10_000).toUTCString(), 0)).toBe(10_000);
  });
});
