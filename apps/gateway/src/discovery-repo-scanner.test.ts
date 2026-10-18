/**
 * ADR-0195 SD1 — the repo scanners against SD0's contract, without a database:
 * a fake GitHub API over the scan context's fetch, observations checked by the
 * worker's own `checkObservations`, history gated by the target, the commit
 * author only pseudonymised, rate limits handed to SD0's backoff, the lease
 * heartbeat honoured. Synthetic data only; key shapes are built at runtime.
 */
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { decodeJwt, decodeProtectedHeader } from "jose";
import type { RepoReader, RepoReaderOptions } from "@regulait/git-provider";
import { describe, expect, it } from "vitest";
import { DISCOVERY_SCANNERS } from "./discovery-scanners.js";
import { checkObservations, ObservationRefused } from "./discovery-worker.js";
import { repoScanner, repoTargetProblem, toScanObservations, type RepoScanContext } from "./discovery-repo-scanner.js";

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
  const registered: string[] = [];
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
    registerSecret: (v) => {
      registered.push(v);
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
  return { c, pseudonymised, raw, registered, counts: () => ({ throttles, backoffs, heartbeats }) };
}

describe("ADR-0195 SD1 repo scanners", () => {
  it("are the registered scanners for the four repo kinds and need a credential", () => {
    for (const k of ["repo_github", "repo_gitlab", "repo_bitbucket", "repo_azure_devops"] as const) {
      expect(DISCOVERY_SCANNERS.get(k)?.requiresCredential).toBe(true);
      // the routes call this at save time
      const org = { orgLevel: true, include: [] as string[] };
      expect(DISCOVERY_SCANNERS.get(k)?.validateTarget?.({ org: "x" }, org)).toMatch(/not a repo source target key/);
      expect(DISCOVERY_SCANNERS.get(k)?.validateTarget?.({ namespace: "acme", baseUrl: "https://git.example.test" }, org)).toBeNull();
    }
  });

  it("scans the default-branch head into observations SD0 accepts", async () => {
    const fake = githubFake();
    const t = ctx(fake.fetchImpl);
    const res = await repoScanner("repo_github").run(t.c);
    // a non-classic token with an allow-listed scope header proves nothing: the reader says unverified
    expect(res.credentialWriteScope).toBe("unverified");
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
    // ADR-0195 lane A6: the .env.example names become presence signature ids; NAMES only for the MCP command basename
    const envSighting = res.observations.find((o) => o.location?.path === ".env.example")!;
    expect(envSighting.presence).toEqual(["env.openai.api-key"]);
    expect(envSighting.names).toBeUndefined();
    expect(res.observations.flatMap((o) => o.names ?? [])).toEqual(["uvx"]);
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
    // the derived Basic forms of the token are registered for scrubbing
    expect(t.registered).toContain(Buffer.from(`:${t.c.credential!.secret}`).toString("base64"));
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

  it("passes the reader's verdict through: read_only for a classic read-only token, unverified with no scope header", async () => {
    const classic = ["gh", "p_", "D".repeat(36)].join("");
    const asClassic = { credential: { mode: "static" as const, publicConfig: {}, secret: classic } };
    expect((await repoScanner("repo_github").run(ctx(githubFake().fetchImpl, asClassic).c)).credentialWriteScope).toBe("read_only");
    const noHeader = githubFake((u) => (u.pathname === "/user" ? json({}) : undefined));
    expect((await repoScanner("repo_github").run(ctx(noHeader.fetchImpl, asClassic).c)).credentialWriteScope).toBe("unverified");
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
    expect(checked.some((o) => o.presence?.includes("env.openai.api-key"))).toBe(true);
  });

  it("ADR-0195 lane A6: the worker refuses an env-variable name a repo scanner sends as a name", () => {
    const analysis = {
      commitSha: SHA,
      observations: [{ kind: "mcp_server", path: ".mcp.json", line: null, commitSha: SHA, mcpServer: { name: "s", transport: "stdio", command: "OPENAI_API_KEY", host: null }, catalogEntryId: null, provider: null }],
    } as unknown as Parameters<typeof toScanObservations>[1];
    // the scanner itself never forwards an env-shaped command basename as a name
    const obs = toScanObservations("github:acme/app", analysis, null);
    expect(obs.flatMap((o) => o.names ?? [])).toEqual([]);
    // and if a scanner did, SD0 refuses the run's observations rather than store the name
    const forged = [{ evidenceKind: "repo_scan" as const, subjectKind: "repo" as const, subject: "github:acme/app", names: ["OPENAI_API_KEY"] }];
    expect(() => checkObservations("repo_github", forged, "2026-10-17T00:00:00.000Z")).toThrow(ObservationRefused);
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
    const v = (k: "repo_github" | "repo_gitlab" | "repo_bitbucket" | "repo_azure_devops", include: string[]) =>
      DISCOVERY_SCANNERS.get(k)!.validateTarget!({ namespace: "acme", baseUrl: "https://git.example.test" }, { orgLevel: false, include });
    expect(v("repo_github", ["acme/app"])).toBeNull();
    expect(v("repo_github", ["acme/app/extra"])).toMatch(/owner\/name/);
    expect(v("repo_bitbucket", ["ws"])).toMatch(/owner\/name/);
    expect(v("repo_gitlab", ["grp/sub/proj"])).toBeNull();
    expect(v("repo_gitlab", ["grp/../proj"])).toMatch(/group\/project/);
    expect(v("repo_azure_devops", ["Proj A/svc"])).toBeNull();
    expect(v("repo_github", [])).toMatch(/at least one/);
    const fake = githubFake();
    await expect(repoScanner("repo_github").run(ctx(fake.fetchImpl, {}, { baseUrl: API, history: "maybe" }).c)).rejects.toThrow(/^target_invalid:/);
    expect(fake.calls).toEqual([]);
  });

  it("stops when the lease is lost, and needs a usable credential", async () => {
    const fake = githubFake();
    await expect(repoScanner("repo_github").run(ctx(fake.fetchImpl, { heartbeat: async () => false }).c)).rejects.toThrow(/^lease_lost:/);
    // federated, but this deployment has no GitHub App (the variables are unset in tests)
    await expect(
      repoScanner("repo_github").run(ctx(fake.fetchImpl, { credential: { mode: "federated", publicConfig: { appId: "1", installationId: "2" }, secret: null } }).c),
    ).rejects.toThrow(/^credential_unusable: .*REGULAIT_GITHUB_APP_ID/);
    // ADR-0195 A5: neither a federated nor a stored credential: refused before any call
    const none = githubFake();
    await expect(repoScanner("repo_github").run(ctx(none.fetchImpl, { credential: null }).c)).rejects.toThrow(/^credential_unusable:/);
    expect(none.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// ADR-0195 A5: federated git-provider credentials
// ---------------------------------------------------------------------------

const APP_ID = "424242";
const INSTALLATION = "777";
const appKey = () => generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
const TENANT = "00000000-0000-4000-8000-0000000000a1";
const CLIENT = "00000000-0000-4000-8000-0000000000b2";
const ADO = "https://dev.azure.com/acme";

/** the GitHub fake plus the installation-token exchange (POST) and the installation's repository list */
function githubAppFake(
  grant: Record<string, string> = { contents: "read", metadata: "read" },
  status = 201,
  /** the n-th exchange's answer (0-based), in place of the default */
  answer?: (n: number, minted: string) => Response | undefined,
) {
  const fake = githubFake((u) =>
    u.pathname === "/installation/repositories" ? json({ total_count: 1, repositories: [{ full_name: "acme/app", default_branch: "main" }] }) : undefined,
  );
  const minted = `ghs_synthetic${randomUUID().replaceAll("-", "")}`;
  const exchanges: Array<{ url: string; auth: string; body: unknown }> = [];
  const seenAuth: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    if (init?.method === "POST" && u.pathname === `/app/installations/${INSTALLATION}/access_tokens`) {
      exchanges.push({ url: u.href, auth, body: JSON.parse(String(init.body)) });
      const own = answer?.(exchanges.length - 1, minted);
      if (own) return own;
      return status === 201
        ? json({ token: minted, expires_at: "2099-01-01T00:00:00Z", permissions: grant, repository_selection: "selected" }, 201)
        : json({ message: "Bad credentials" }, status);
    }
    seenAuth.push(auth);
    return fake.fetchImpl(input, init);
  }) as typeof fetch;
  return { fetchImpl, calls: fake.calls, exchanges, seenAuth, minted };
}

const ghFederated = { mode: "federated" as const, publicConfig: { appId: APP_ID, installationId: INSTALLATION }, secret: null };

describe("ADR-0195 A5 federated git credentials", () => {
  it("GitHub: exchanges a short App JWT for a read-only installation token and scans with it", async () => {
    const key = appKey();
    const fake = githubAppFake();
    const t = ctx(fake.fetchImpl, { credential: ghFederated, source: { id: randomUUID(), name: "src", kind: "repo_github", target: { baseUrl: API }, scope: { orgLevel: true, include: [] } } });
    const res = await repoScanner("repo_github", { federation: { githubApp: () => ({ appId: APP_ID, privateKey: key, apiUrl: API }) } }).run(t.c);
    expect(fake.exchanges).toHaveLength(1);
    const ex = fake.exchanges[0]!;
    expect(ex.url).toBe(`${API}/app/installations/${INSTALLATION}/access_tokens`);
    // downscoped to read-only, whatever the App itself holds
    expect(ex.body).toEqual({ permissions: { contents: "read", metadata: "read" } });
    const jwt = ex.auth.slice("Bearer ".length);
    expect(decodeProtectedHeader(jwt).alg).toBe("RS256");
    const claims = decodeJwt(jwt);
    expect(claims.iss).toBe(APP_ID);
    expect(claims.exp! - claims.iat!).toBeLessThanOrEqual(600);
    // the installation token reads the repos; /user is never asked (an installation token cannot read it)
    expect(fake.seenAuth.every((a) => a === `Bearer ${fake.minted}`)).toBe(true);
    expect(fake.calls).toContain("/installation/repositories?per_page=100");
    expect(fake.calls).not.toContain("/user");
    expect(res.credentialWriteScope).toBe("read_only");
    expect(res.observations.length).toBeGreaterThan(0);
    // the JWT and the token are registered for scrubbing
    expect(t.registered).toEqual(expect.arrayContaining([jwt, fake.minted]));
  });

  it("GitHub: refuses a credential naming another App (wrong audience), a write grant, and a rejected JWT", async () => {
    const key = appKey();
    const app = { githubApp: () => ({ appId: APP_ID, privateKey: key, apiUrl: API }) };
    const other = githubAppFake();
    await expect(
      repoScanner("repo_github", { federation: app }).run(ctx(other.fetchImpl, { credential: { ...ghFederated, publicConfig: { appId: "999", installationId: INSTALLATION } } }).c),
    ).rejects.toThrow(/^credential_unusable: the credential names GitHub App 999/);
    expect(other.exchanges).toEqual([]);

    const write = githubAppFake({ contents: "write", metadata: "read" });
    const res = await repoScanner("repo_github", { federation: app }).run(ctx(write.fetchImpl, { credential: ghFederated }).c);
    expect(res).toEqual({ observations: [], credentialWriteScope: "write" });
    expect(write.calls).toEqual([]);

    const rejected = githubAppFake(undefined, 401);
    const t = ctx(rejected.fetchImpl, { credential: ghFederated });
    const err = await repoScanner("repo_github", { federation: app }).run(t.c).catch((e: Error) => e);
    expect(String(err)).toMatch(/credential_unusable: .*rejected the App's JWT/);
    expect(String(err)).not.toContain(rejected.exchanges[0]!.auth.slice(7));
  });

  it("GitHub: re-exchanges the installation token before it expires", async () => {
    const key = appKey();
    const fake = githubAppFake();
    const clock = Date.parse("2099-01-01T00:00:00Z") - 4 * 60_000; // inside the refresh margin of the token's expiry
    const t = ctx(fake.fetchImpl, { credential: ghFederated });
    await repoScanner("repo_github", { federation: { githubApp: () => ({ appId: APP_ID, privateKey: key, apiUrl: API }), now: () => clock } }).run(t.c);
    expect(fake.exchanges.length).toBe(2);
  });

  it("GitHub: a refreshed token that grants write is refused, and nothing is read with it", async () => {
    const key = appKey();
    let readsAtRefresh = -1;
    const fake = githubAppFake(undefined, 201, (n, minted) => {
      if (n !== 1) return undefined;
      readsAtRefresh = fake.calls.length;
      return json({ token: `${minted}x`, expires_at: "2099-01-01T00:00:00Z", permissions: { contents: "write", metadata: "read" } }, 201);
    });
    const clock = Date.parse("2099-01-01T00:00:00Z") - 4 * 60_000;
    const t = ctx(fake.fetchImpl, { credential: ghFederated });
    const err = await repoScanner("repo_github", { federation: { githubApp: () => ({ appId: APP_ID, privateKey: key, apiUrl: API }), now: () => clock } })
      .run(t.c)
      .catch((e: Error) => e);
    expect(String(err)).toMatch(/credential_unusable: the refreshed federated token grants write scope/);
    expect(fake.exchanges).toHaveLength(2);
    expect(readsAtRefresh).toBeGreaterThanOrEqual(0);
    expect(fake.calls.length).toBe(readsAtRefresh);
  });

  it("GitHub: the App JWT goes only to the deployment's GitHub API; a source on another host is refused before signing", async () => {
    const key = appKey();
    const app = { githubApp: () => ({ appId: APP_ID, privateKey: key, apiUrl: API }) };
    for (const target of [{ baseUrl: "https://collector.example.test" }, {}] as Array<Record<string, string>>) {
      const fake = githubAppFake();
      const t = ctx(fake.fetchImpl, { credential: ghFederated }, target);
      const err = await repoScanner("repo_github", { federation: app }).run(t.c).catch((e: Error) => e);
      expect(String(err), JSON.stringify(target)).toMatch(
        /^RepoScanError: credential_unusable: a federated GitHub source reads through this deployment's configured GitHub API \(REGULAIT_GITHUB_APP_API_URL\)/,
      );
      // the stored run error names the setting, never its value (an environment variable value is never echoed)
      expect((err as Error).message).not.toContain(new URL(API).host);
      expect(fake.exchanges).toEqual([]);
      expect(fake.calls).toEqual([]);
      // nothing was signed: no JWT was registered
      expect(t.registered).toEqual([]);
    }
  });

  it("GitHub: the origin match is exact and normalised; the path may differ, the port may not", async () => {
    const key = appKey();
    const apiUrl = "https://ghe.example.test/api/v3";
    const app = { githubApp: () => ({ appId: APP_ID, privateKey: key, apiUrl }) };
    const run = async (baseUrl: string) => {
      const seen: Array<{ method: string; url: string }> = [];
      const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
        seen.push({ method: init?.method ?? "GET", url: new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).href });
        return json({ message: "Bad credentials" }, 401);
      }) as typeof fetch;
      const t = ctx(fetchImpl, { credential: ghFederated }, { baseUrl });
      const err = await repoScanner("repo_github", { federation: app }).run(t.c).catch((e: Error) => e);
      return { err: String(err), seen, registered: t.registered };
    };
    // same origin, another path (or the default port written out): accepted, and the JWT goes only to the configured API
    for (const baseUrl of ["https://ghe.example.test/other", "https://ghe.example.test:443/"]) {
      const r = await run(baseUrl);
      expect(r.err, baseUrl).not.toMatch(/configured GitHub API/);
      expect(r.seen, baseUrl).toEqual([{ method: "POST", url: `${apiUrl}/app/installations/${INSTALLATION}/access_tokens` }]);
      expect(r.registered.length, baseUrl).toBeGreaterThan(0);
    }
    // another port is another origin: refused before signing
    const r = await run("https://ghe.example.test:8443");
    expect(r.err).toMatch(/^RepoScanError: credential_unusable: a federated GitHub source reads through this deployment's configured GitHub API/);
    expect(r.seen).toEqual([]);
    expect(r.registered).toEqual([]);
  });

  it("GitHub: a repo-level scope narrows the installation token to its repositories", async () => {
    const key = appKey();
    const fake = githubAppFake();
    const t = ctx(fake.fetchImpl, {
      credential: ghFederated,
      source: { id: randomUUID(), name: "src", kind: "repo_github", target: { baseUrl: API }, scope: { orgLevel: false, include: ["acme/app", " acme/app ", "acme/lib"] } },
    });
    await repoScanner("repo_github", { federation: { githubApp: () => ({ appId: APP_ID, privateKey: key, apiUrl: API }) } }).run(t.c).catch(() => null);
    expect(fake.exchanges[0]!.body).toEqual({ repositories: ["app", "lib"], permissions: { contents: "read", metadata: "read" } });
  });

  it("GitHub: a token GitHub reports no permissions for is refused (write scope cannot be verified)", async () => {
    const key = appKey();
    const app = { githubApp: () => ({ appId: APP_ID, privateKey: key, apiUrl: API }) };
    for (const permissions of [undefined, {}, ["contents"]]) {
      const fake = githubAppFake(undefined, 201, (_n, minted) => json({ token: minted, expires_at: "2099-01-01T00:00:00Z", ...(permissions ? { permissions } : {}) }, 201));
      const t = ctx(fake.fetchImpl, { credential: ghFederated });
      await expect(repoScanner("repo_github", { federation: app }).run(t.c), JSON.stringify(permissions)).rejects.toThrow(
        /^credential_unusable: GitHub reported no permissions for the installation token/,
      );
      expect(fake.calls).toEqual([]);
    }
  });

  it("GitHub: a failed exchange that still carries a token registers it for scrubbing and never echoes it", async () => {
    const key = appKey();
    const fake = githubAppFake(undefined, 201, (_n, minted) => json({ token: minted, message: `internal error for ${minted}` }, 500));
    const t = ctx(fake.fetchImpl, { credential: ghFederated });
    const err = await repoScanner("repo_github", { federation: { githubApp: () => ({ appId: APP_ID, privateKey: key, apiUrl: API }) } })
      .run(t.c)
      .catch((e: Error) => e);
    expect(String(err)).toMatch(/credential_unusable: the installation token exchange failed: GitHub answered 500/);
    expect(String(err)).not.toContain(fake.minted);
    expect(t.registered).toContain(fake.minted);
    expect(fake.calls).toEqual([]);
  });

  /** a reader stub that records how the scanner built it */
  function stubReader(built: RepoReaderOptions[]) {
    return (_kind: string, opts: RepoReaderOptions): RepoReader => {
      built.push(opts);
      return {
        kind: "azure_devops",
        historyEnabled: false,
        listRepos: async () => ({ repos: [], truncated: false }),
        getTree: async (repo: string) => ({ repo, ref: null, commitSha: null, author: null, entries: [], truncated: false }),
        readFile: async () => ({ status: "missing" }),
        inspectCredential: async () => ({ status: "read_only", scopes: [], detail: "" }),
        listCommits: async () => [],
        getTreeAt: async (repo: string) => ({ repo, ref: null, commitSha: null, author: null, entries: [], truncated: false }),
      } as unknown as RepoReader;
    };
  }

  /** Entra's endpoints, answering the token request with `token` (or an AADSTS error) */
  function entraFake(answer: "ok" | "wrong_audience") {
    const assertions: string[] = [];
    const scopes: string[] = [];
    const accessToken = `synthetic-entra-${randomUUID()}`;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (u.hostname !== "login.microsoftonline.com") return json({ message: "unexpected host" }, 500);
      if (u.pathname.endsWith("/discovery/instance")) {
        return json({
          tenant_discovery_endpoint: `https://login.microsoftonline.com/${TENANT}/v2.0/.well-known/openid-configuration`,
          "api-version": "1.1",
          metadata: [{ preferred_network: "login.microsoftonline.com", preferred_cache: "login.windows.net", aliases: ["login.microsoftonline.com", "login.windows.net"] }],
        });
      }
      if (u.pathname.endsWith("/.well-known/openid-configuration")) {
        return json({
          token_endpoint: `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`,
          authorization_endpoint: `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize`,
          issuer: `https://login.microsoftonline.com/${TENANT}/v2.0`,
          end_session_endpoint: `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/logout`,
          jwks_uri: `https://login.microsoftonline.com/${TENANT}/discovery/v2.0/keys`,
        });
      }
      if (u.pathname.endsWith("/oauth2/v2.0/token")) {
        const form = new URLSearchParams(typeof init?.body === "string" ? init.body : "");
        assertions.push(form.get("client_assertion") ?? "");
        scopes.push(form.get("scope") ?? "");
        if (answer === "wrong_audience") {
          return json(
            { error: "invalid_client", error_description: "AADSTS700212: No matching federated identity record found for presented assertion audience 'x'.", error_codes: [700212] },
            400,
          );
        }
        return json({ token_type: "Bearer", expires_in: 3600, ext_expires_in: 3600, access_token: accessToken });
      }
      return json({ message: "no route" }, 500);
    }) as typeof fetch;
    return { fetchImpl, assertions, scopes, accessToken };
  }

  const adoFederated = { mode: "federated" as const, publicConfig: { tenantId: TENANT, clientId: CLIENT }, secret: null };
  const adoSource = { id: randomUUID(), name: "ado", kind: "repo_azure_devops" as const, target: { baseUrl: ADO }, scope: { orgLevel: false, include: ["proj/repo"] } };

  it("Azure DevOps: exchanges a federation token at Entra and reads with the Entra access token (Bearer)", async () => {
    const entra = entraFake("ok");
    const audiences: string[] = [];
    const minted = `synthetic-federation-${randomUUID()}`;
    const built: RepoReaderOptions[] = [];
    const t = ctx(entra.fetchImpl, {
      source: adoSource,
      credential: adoFederated,
      federation: {
        sourceToken: async (aud) => {
          audiences.push(aud);
          return minted;
        },
      },
    });
    const res = await repoScanner("repo_azure_devops", { resolveReader: stubReader(built) }).run(t.c);
    // every token the run minted was for Entra's token-exchange audience (the credential library may ask more than once)
    expect(audiences.length).toBeGreaterThan(0);
    expect(new Set(audiences)).toEqual(new Set(["api://AzureADTokenExchange"]));
    expect(entra.assertions).toEqual([minted]);
    expect(entra.scopes[0]).toContain("499b84ac-1321-427f-aa17-267ca6975798/.default");
    expect(built).toHaveLength(1);
    expect(built[0]!.token).toBe(entra.accessToken);
    expect(built[0]!.credentialKind).toBe("entra_access_token");
    // an Entra token carries no Azure DevOps scopes: honest "unverified"
    expect(res.credentialWriteScope).toBe("unverified");
    expect(t.registered).toEqual(expect.arrayContaining([minted, entra.accessToken]));
  });

  it("Azure DevOps: a federated credential with no matching audience is refused without leaking the assertion", async () => {
    const entra = entraFake("wrong_audience");
    const minted = `synthetic-federation-${randomUUID()}`;
    const t = ctx(entra.fetchImpl, { source: adoSource, credential: adoFederated, federation: { sourceToken: async () => minted } });
    const err = await repoScanner("repo_azure_devops", { resolveReader: stubReader([]) }).run(t.c).catch((e: Error) => e);
    expect(String(err)).toMatch(/^RepoScanError: credential_unusable: .*AADSTS700212.*api:\/\/AzureADTokenExchange/);
    expect(String(err)).not.toContain(minted);

    // the minter itself refuses an audience the credential does not name: no token, no Entra call
    const refusing = entraFake("ok");
    const t2 = ctx(refusing.fetchImpl, {
      source: adoSource,
      credential: adoFederated,
      federation: { sourceToken: async (aud) => Promise.reject(new Error(`federation audience '${aud}' is not one this credential names`)) },
    });
    await expect(repoScanner("repo_azure_devops", { resolveReader: stubReader([]) }).run(t2.c)).rejects.toThrow(/^credential_unusable:/);
    expect(refusing.assertions).toEqual([]);
  });

  it("GitLab and Bitbucket: the stored read-only token is the fallback; a federated credential is refused", async () => {
    for (const kind of ["repo_gitlab", "repo_bitbucket"] as const) {
      const built: RepoReaderOptions[] = [];
      const fetchImpl = (async () => json({}, 500)) as unknown as typeof fetch;
      const src = { id: randomUUID(), name: "g", kind, target: {}, scope: { orgLevel: false, include: ["acme/app"] } };
      const secret = `synthetic-${randomUUID()}`;
      await repoScanner(kind, { resolveReader: stubReader(built) }).run(ctx(fetchImpl, { source: src, credential: { mode: "static", publicConfig: {}, secret } }).c);
      expect(built.map((b) => [b.token, b.credentialKind])).toEqual([[secret, "token"]]);
      const fed = ctx(fetchImpl, { source: src, credential: { mode: "federated", publicConfig: {}, secret: null }, federation: { sourceToken: async () => "x" } });
      await expect(repoScanner(kind, { resolveReader: stubReader([]) }).run(fed.c)).rejects.toThrow(/^credential_unusable: .*accepts no external OIDC token/);
    }
  });
});
