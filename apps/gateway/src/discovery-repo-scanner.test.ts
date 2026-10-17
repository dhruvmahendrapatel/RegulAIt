/**
 * ADR-0195 SD1 — the repo scanners against SD0's contract, without a database:
 * a fake GitHub API over the scan context's fetch, observations checked by the
 * worker's own `checkObservations`, history gated by the target, the commit
 * author only pseudonymised, rate limits handed to SD0's backoff, the lease
 * heartbeat honoured. Synthetic data only; key shapes are built at runtime.
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DISCOVERY_SCANNERS } from "./discovery-scanners.js";
import { checkObservations } from "./discovery-worker.js";
import { repoScanner, repoTargetProblem, type RepoScanContext } from "./discovery-repo-scanner.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const OLD = "89abcdef0123456789abcdef0123456789abcdef";
const TREE = "fedcba9876543210fedcba9876543210fedcba98";
const API = "https://git.example.test";
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
const key = () => ["sk", "ant", "api03", "R".repeat(44)].join("-");

type Route = (url: URL) => Response | undefined;
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

function githubFake(extra: Route = () => undefined) {
  const files: Record<string, string> = {
    "package.json": JSON.stringify({ dependencies: { "@anthropic-ai/sdk": "1", "left-pad": "1", "@acme/in-house-llm": "2" } }, null, 2),
    ".mcp.json": JSON.stringify({ mcpServers: { files: { command: "/opt/bin/uvx", args: ["--secret-arg"] } } }),
    ".github/copilot-instructions.md": "style",
    ".vscode/extensions.json": JSON.stringify({ recommendations: ["GitHub.copilot"] }),
    ".env.example": "OPENAI_API_KEY=\n",
    "src/a.py": `import openai\nURL = "https://api.groq.com/v1"\nK = "${key()}"\n`,
  };
  const calls: string[] = [];
  const route: Route = (u) => {
    const p = u.pathname + u.search;
    const e = extra(u);
    if (e) return e;
    if (p === "/user") return json({}, 200, { "x-oauth-scopes": "read:org" });
    if (p === "/repos/acme/app") return json({ default_branch: "main" });
    if (p === "/repos/acme/app/branches/main") return json({ commit: { sha: SHA, commit: { author: { name: "Dev", email: "Dev@Example.test" }, tree: { sha: TREE } } } });
    if (p === `/repos/acme/app/git/trees/${TREE}?recursive=1`) return json({ tree: Object.keys(files).map((path) => ({ path, type: "blob", size: files[path]!.length })) });
    if (p === `/repos/acme/app/git/trees/${OLD}?recursive=1`) return json({ tree: [{ path: "old.txt", type: "blob", size: 3 }] });
    if (p === `/repos/acme/app/git/commits/${OLD}`) return json({ tree: { sha: OLD }, author: { name: "Old", email: "old@example.test" } });
    if (p.startsWith("/repos/acme/app/commits?per_page=100")) {
      return json([{ sha: SHA, commit: { author: { name: "Dev", email: "dev@example.test" } } }, { sha: OLD, commit: { author: { name: "Old", email: "old@example.test" } } }]);
    }
    const m = u.pathname.match(/^\/repos\/acme\/app\/contents\/(.+)$/);
    if (m) {
      const path = decodeURIComponent(m[1]!);
      if (path === "old.txt") return json({ type: "file", encoding: "base64", content: b64("x\n"), size: 2 });
      const c = files[path];
      return c === undefined ? json({}, 404) : json({ type: "file", encoding: "base64", content: b64(c), size: c.length });
    }
    return json({ message: `no fake route ${p}` }, 500);
  };
  const fetchImpl = (async (input: string | URL | Request) => {
    const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    calls.push(u.pathname + u.search);
    return route(u)!;
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function ctx(fetchImpl: typeof fetch, over: Partial<RepoScanContext> = {}, target: Record<string, string> = { baseUrl: API }) {
  const pseudonymised: Array<[string, string]> = [];
  const raw: string[] = [];
  let throttles = 0;
  let backoffs = 0;
  let heartbeats = 0;
  const c: RepoScanContext = {
    source: { id: randomUUID(), name: "src", kind: "repo_github", target, scope: { orgLevel: false, include: ["acme/app"] } },
    credential: { mode: "static", publicConfig: {}, secret: `synthetic-${randomUUID()}` },
    fetch: fetchImpl,
    throttle: async () => {
      throttles++;
    },
    backoff: async () => {
      backoffs++;
      return backoffs <= 1;
    },
    recordRaw: (chunk) => {
      raw.push(String(chunk));
    },
    pseudonymise: async (kind, name) => {
      pseudonymised.push([kind, name]);
      return `psn:${"a".repeat(24)}`;
    },
    heartbeat: async () => {
      heartbeats++;
      return true;
    },
    signal: new AbortController().signal,
    catalogue: { matches: (o) => o.packageName === "@acme/in-house-llm" },
    ...over,
  };
  return { c, pseudonymised, raw, counts: () => ({ throttles, backoffs, heartbeats }) };
}

describe("ADR-0195 SD1 repo scanners", () => {
  it("are the registered scanners for the four repo kinds and need a credential", () => {
    for (const k of ["repo_github", "repo_gitlab", "repo_bitbucket", "repo_azure_devops"] as const) {
      expect(DISCOVERY_SCANNERS.get(k)?.requiresCredential).toBe(true);
    }
  });

  it("scans the default-branch head into observations SD0 accepts", async () => {
    const fake = githubFake();
    const t = ctx(fake.fetchImpl);
    const res = await repoScanner("repo_github").run(t.c);
    expect(res.credentialWriteScope).toBe("read_only");
    // the worker's own check accepts every observation
    const checked = checkObservations("repo_github", res.observations, "2026-10-17T00:00:00.000Z");
    expect(checked.length).toBe(res.observations.length);
    expect(res.observations.every((o) => o.subject === "github:acme/app" && o.evidenceKind === "repo_scan" && o.subjectKind === "repo")).toBe(true);
    const flat = res.observations.map((o) => o.packageName ?? o.host ?? o.artifact?.value ?? (o.keyFragment ? `key:${o.keyFragment}:${o.keyLength}` : "?"));
    expect(flat).toEqual(
      expect.arrayContaining(["@anthropic-ai/sdk", "openai", "api.groq.com", ".github/copilot-instructions.md", "github.copilot", `key:${key().slice(0, 8)}:${key().length}`]),
    );
    expect(flat).not.toContain("left-pad");
    // kept only because the admin catalogue (ctx.catalogue) matches it
    expect(flat).toContain("@acme/in-house-llm");
    // every sighting carries where it was found and the head commit's author pseudonym
    for (const o of res.observations) {
      expect(o.location?.path, JSON.stringify(o)).toBeTruthy();
      expect(o.location?.commit).toBe(SHA);
      expect(o.actorPseudonym).toBe(`psn:${"a".repeat(24)}`);
    }
    expect(res.observations.find((o) => o.packageName === "@anthropic-ai/sdk")!.location).toEqual({ path: "package.json", line: 3, commit: SHA });
    expect(res.observations.find((o) => o.keyFragment)!.location).toEqual({ path: "src/a.py", line: 3, commit: SHA });
    // NAMES only: the .env.example variable names and the stdio MCP command basename
    expect(res.observations.find((o) => o.location?.path === ".env.example")!.names).toEqual(["OPENAI_API_KEY"]);
    expect(res.observations.find((o) => o.names?.includes("uvx"))!.artifact).toEqual({ kind: "assistant_config", value: ".mcp.json" });
    expect(res.observations.find((o) => o.artifact?.kind === "assistant_config")!.artifact!.value).toBe(".github/copilot-instructions.md");
    // the author only through SD0's hook, and nothing raw in the result
    expect(t.pseudonymised).toEqual([["commit_author", "dev@example.test"]]);
    const serialised = JSON.stringify(res);
    expect(serialised).not.toContain("example.test");
    expect(serialised).not.toContain(key());
    expect(serialised).not.toContain("secret-arg");
    expect(serialised).not.toContain("/opt/bin");
    // throttled before every request, heartbeat per repo, history untouched
    expect(t.counts().throttles).toBe(fake.calls.length);
    expect(t.counts().heartbeats).toBe(1);
    expect(fake.calls.some((p) => p.includes("/commits"))).toBe(false);
    expect(t.raw.length).toBeGreaterThan(0);
  });

  it("scans history only when the source target turns it on (the enable step-up binds the target)", async () => {
    const fake = githubFake();
    const t = ctx(fake.fetchImpl, {}, { baseUrl: API, history: "true", historyDepth: "5" });
    await repoScanner("repo_github").run(t.c);
    expect(fake.calls).toContain(`/repos/acme/app/git/commits/${OLD}`);
    expect(t.pseudonymised.map((p) => p[1])).toEqual(["dev@example.test", "old@example.test"]);
    const res2 = await repoScanner("repo_github").run(ctx(githubFake().fetchImpl, {}, { baseUrl: API, history: "true" }).c);
    const oldSighting = res2.observations.find((o) => o.location?.path === "old.txt");
    expect(oldSighting).toBeUndefined(); // old.txt holds nothing AI-related: history adds only real sightings
    expect(t.counts().heartbeats).toBe(2);
  });

  it("refuses a write-scoped token before reading any repo", async () => {
    const fake = githubFake((u) => (u.pathname === "/user" ? json({}, 200, { "x-oauth-scopes": "repo" }) : undefined));
    const res = await repoScanner("repo_github").run(ctx(fake.fetchImpl).c);
    expect(res).toEqual({ observations: [], credentialWriteScope: "write" });
    expect(fake.calls).toEqual(["/user"]);
  });

  it("hands 429s to SD0's backoff, and fails the run as rate_limited when it gives up", async () => {
    let n = 0;
    const fake = githubFake((u) => (u.pathname === "/repos/acme/app" && ++n <= 3 ? json({}, 429, { "retry-after": "1" }) : undefined));
    const t = ctx(fake.fetchImpl);
    await expect(repoScanner("repo_github").run(t.c)).rejects.toThrow(/^rate_limited:/);
    expect(t.counts().backoffs).toBe(2); // one retry granted, the second refused
  });

  it("every observation passes SD0's own checks, including location, names and actor", async () => {
    const res = await repoScanner("repo_github").run(ctx(githubFake().fetchImpl).c);
    const checked = checkObservations("repo_github", res.observations, "2026-10-17T00:00:00.000Z");
    expect(checked.some((o) => o.location !== null && o.names !== null)).toBe(true);
  });

  it("shape-checks the source target and fails the run on a bad one before any request", async () => {
    expect(repoTargetProblem("repo_github", { namespace: "acme", baseUrl: "https://ghe.example.test/api/v3", history: "true", historyDepth: "50" })).toBeNull();
    expect(repoTargetProblem("repo_github", { org: "acme" })).toMatch(/not a repo source target key/);
    expect(repoTargetProblem("repo_github", { baseUrl: "http://git.example.test" })).toMatch(/https/);
    expect(repoTargetProblem("repo_github", { baseUrl: "https://u:p@git.example.test" })).toMatch(/credentials/);
    expect(repoTargetProblem("repo_github", { baseUrl: "https://git.example.test/?t=1" })).toMatch(/query/);
    expect(repoTargetProblem("repo_github", { namespace: "../x" })).toMatch(/namespace/);
    expect(repoTargetProblem("repo_github", { history: "yes" })).toMatch(/history/);
    expect(repoTargetProblem("repo_github", { historyDepth: "201" })).toMatch(/historyDepth/);
    expect(repoTargetProblem("repo_azure_devops", {})).toMatch(/baseUrl/);
    const fake = githubFake();
    await expect(repoScanner("repo_github").run(ctx(fake.fetchImpl, {}, { baseUrl: API, history: "maybe" }).c)).rejects.toThrow(/^target_invalid:/);
    expect(fake.calls).toEqual([]);
  });

  it("stops when the lease is lost, and needs a static token", async () => {
    const fake = githubFake();
    await expect(repoScanner("repo_github").run(ctx(fake.fetchImpl, { heartbeat: async () => false }).c)).rejects.toThrow(/^lease_lost:/);
    await expect(
      repoScanner("repo_github").run(ctx(fake.fetchImpl, { credential: { mode: "federated", publicConfig: {}, secret: null } }).c),
    ).rejects.toThrow(/^credential_unusable:/);
  });
});
