// Provider-agnostic git operations (WORKFLOW_ENGINE_SPEC.md §5: PR/merge
// stages must work across GitHub, GitLab, Bitbucket, and Azure DevOps).
// This package defines the neutral interface and ships two adapters:
// GitHub (REST, injectable fetch) and an in-memory mock for tests and
// air-gapped development. GitLab/Bitbucket/Azure DevOps are additional
// adapter files behind the same interface — the registry rejects them
// explicitly until implemented, per the no-silent-promises rule.

export type GitProviderKind = "github" | "gitlab" | "bitbucket" | "azure_devops" | "mock";

export type MergeStrategy = "merge" | "squash" | "rebase";

export interface PullRequestRef {
  /** provider-native PR/MR identifier, stringified */
  id: string;
  url: string;
}

export interface MergeResult {
  merged: boolean;
  sha: string | null;
}

export interface GitProvider {
  readonly kind: GitProviderKind;
  createBranch(repo: string, branch: string, fromBranch: string): Promise<void>;
  openPullRequest(
    repo: string,
    params: { head: string; base: string; title: string; body: string },
  ): Promise<PullRequestRef>;
  mergePullRequest(repo: string, prId: string, strategy: MergeStrategy): Promise<MergeResult>;
}

export class GitProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// GitHub adapter — REST v3, token auth, injectable fetch (tests stub it).
// ---------------------------------------------------------------------------

type FetchLike = (url: string, init?: {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}) => Promise<{ status: number; json(): Promise<unknown>; text(): Promise<string> }>;

export interface GitHubAdapterOptions {
  token: string;
  /** api base, defaults to https://api.github.com (GHE: https://<host>/api/v3) */
  baseUrl?: string;
  fetchImpl?: FetchLike;
}

export class GitHubProvider implements GitProvider {
  readonly kind = "github" as const;
  private readonly base: string;
  private readonly token: string;
  private readonly fetchImpl: FetchLike;

  constructor(opts: GitHubAdapterOptions) {
    this.base = (opts.baseUrl ?? "https://api.github.com").replace(/\/$/, "");
    this.token = opts.token;
    this.fetchImpl = opts.fetchImpl ?? (fetch as unknown as FetchLike);
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await this.fetchImpl(`${this.base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
        "user-agent": "regulait-gateway",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (res.status >= 400) {
      throw new GitProviderError(`github ${method} ${path} failed: ${await res.text()}`, res.status);
    }
    return res.json();
  }

  async createBranch(repo: string, branch: string, fromBranch: string): Promise<void> {
    const ref = (await this.request("GET", `/repos/${repo}/git/ref/heads/${fromBranch}`)) as {
      object: { sha: string };
    };
    await this.request("POST", `/repos/${repo}/git/refs`, {
      ref: `refs/heads/${branch}`,
      sha: ref.object.sha,
    });
  }

  async openPullRequest(
    repo: string,
    params: { head: string; base: string; title: string; body: string },
  ): Promise<PullRequestRef> {
    const pr = (await this.request("POST", `/repos/${repo}/pulls`, params)) as {
      number: number;
      html_url: string;
    };
    return { id: String(pr.number), url: pr.html_url };
  }

  async mergePullRequest(
    repo: string,
    prId: string,
    strategy: MergeStrategy,
  ): Promise<MergeResult> {
    const res = (await this.request("PUT", `/repos/${repo}/pulls/${prId}/merge`, {
      merge_method: strategy,
    })) as { merged: boolean; sha: string | null };
    return { merged: res.merged, sha: res.sha ?? null };
  }
}

// ---------------------------------------------------------------------------
// Mock adapter — in-memory, for tests and air-gapped development.
// ---------------------------------------------------------------------------

interface MockRepoState {
  branches: Map<string, string>;
  prs: Map<
    string,
    { head: string; base: string; title: string; body: string; merged: boolean; strategy?: MergeStrategy }
  >;
  nextPr: number;
}

export class MockGitProvider implements GitProvider {
  readonly kind = "mock" as const;
  readonly repos = new Map<string, MockRepoState>();

  private repoState(repo: string): MockRepoState {
    let state = this.repos.get(repo);
    if (!state) {
      state = { branches: new Map([["main", "sha-main-0"]]), prs: new Map(), nextPr: 1 };
      this.repos.set(repo, state);
    }
    return state;
  }

  async createBranch(repo: string, branch: string, fromBranch: string): Promise<void> {
    const state = this.repoState(repo);
    const fromSha = state.branches.get(fromBranch);
    if (!fromSha) throw new GitProviderError(`unknown base branch '${fromBranch}'`, 404);
    if (state.branches.has(branch)) throw new GitProviderError(`branch '${branch}' exists`, 422);
    state.branches.set(branch, `sha-${branch}-0`);
  }

  async openPullRequest(
    repo: string,
    params: { head: string; base: string; title: string; body: string },
  ): Promise<PullRequestRef> {
    const state = this.repoState(repo);
    if (!state.branches.has(params.head)) {
      throw new GitProviderError(`unknown head branch '${params.head}'`, 422);
    }
    const id = String(state.nextPr++);
    state.prs.set(id, { ...params, merged: false });
    return { id, url: `mock://${repo}/pull/${id}` };
  }

  async mergePullRequest(
    repo: string,
    prId: string,
    strategy: MergeStrategy,
  ): Promise<MergeResult> {
    const pr = this.repoState(repo).prs.get(prId);
    if (!pr) throw new GitProviderError(`unknown pr '${prId}'`, 404);
    if (pr.merged) throw new GitProviderError(`pr '${prId}' already merged`, 405);
    pr.merged = true;
    pr.strategy = strategy;
    return { merged: true, sha: `sha-merge-${prId}` };
  }
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export interface ProviderConnectionConfig {
  provider: GitProviderKind;
  token: string;
  baseUrl?: string | null;
}

/** shared mock instance so state persists across resolutions in one process */
const sharedMock = new MockGitProvider();

export function resolveProvider(
  config: ProviderConnectionConfig,
  fetchImpl?: FetchLike,
): GitProvider {
  switch (config.provider) {
    case "github":
      return new GitHubProvider({
        token: config.token,
        ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
        ...(fetchImpl ? { fetchImpl } : {}),
      });
    case "mock":
      return sharedMock;
    case "gitlab":
    case "bitbucket":
    case "azure_devops":
      throw new GitProviderError(
        `provider '${config.provider}' is interface-ready but its adapter is not implemented yet`,
      );
  }
}
