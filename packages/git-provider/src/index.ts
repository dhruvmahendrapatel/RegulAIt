// Provider-agnostic git operations (WORKFLOW_ENGINE_SPEC.md §5: PR/merge
// stages must work across GitHub, GitLab, Bitbucket, and Azure DevOps).
// This package defines the neutral interface (types.ts) and ships five
// adapters behind it: GitHub (here), GitLab / Bitbucket Cloud / Azure DevOps
// (per-provider files, ROADMAP Batch A), and an in-memory mock for tests and
// air-gapped development. Unsupported per-provider merge strategies fail
// with an explicit GitProviderError — never a silent substitution — per the
// no-silent-promises rule.

import {
  GitProviderError,
  type CheckRun,
  type CheckStatus,
  type FetchLike,
  type GitProvider,
  type GitProviderKind,
  type MergeResult,
  type MergeStrategy,
  type PullRequestDetails,
  type PullRequestRef,
} from "./types.js";
import { GitLabProvider } from "./gitlab.js";
import { BitbucketProvider } from "./bitbucket.js";
import { AzureDevOpsProvider } from "./azure-devops.js";

export * from "./types.js";
export { GitLabProvider, type GitLabAdapterOptions } from "./gitlab.js";
export { BitbucketProvider, type BitbucketAdapterOptions } from "./bitbucket.js";
export { AzureDevOpsProvider, type AzureDevOpsAdapterOptions } from "./azure-devops.js";

// ---------------------------------------------------------------------------
// GitHub adapter — REST v3, token auth, injectable fetch (tests stub it).
// ---------------------------------------------------------------------------

export interface GitHubAdapterOptions {
  token: string;
  /** api base, defaults to https://api.github.com (GHE: https://<host>/api/v3) */
  baseUrl?: string;
  fetchImpl?: FetchLike;
}

function mapGithubCheck(status: string | undefined, conclusion: string | null | undefined): CheckStatus {
  if (status !== "completed") return status === "in_progress" ? "running" : "pending";
  switch (conclusion) {
    case "success":
      return "success";
    case "cancelled":
      return "canceled";
    case "skipped":
    case "neutral":
    case "stale":
      return "skipped";
    // failure | timed_out | action_required | unknown-terminal
    default:
      return "failure";
  }
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

  async getPullRequest(repo: string, prId: string): Promise<PullRequestDetails> {
    const pr = (await this.request("GET", `/repos/${repo}/pulls/${prId}`)) as {
      number: number;
      html_url: string;
      state: string;
      merged?: boolean;
      title: string;
      head: { ref: string; sha?: string | null };
      base: { ref: string };
    };
    return {
      id: String(pr.number),
      url: pr.html_url,
      state: pr.state === "open" ? "open" : pr.merged ? "merged" : "closed",
      head: pr.head.ref,
      base: pr.base.ref,
      title: pr.title,
      headSha: pr.head.sha ?? null,
    };
  }

  async listChecks(repo: string, prId: string): Promise<CheckRun[]> {
    // checks anchor to the PR head sha; GitHub Actions and modern CI report
    // as check-runs (the legacy commit-status API is not queried).
    const pr = await this.getPullRequest(repo, prId);
    if (!pr.headSha) return [];
    const res = (await this.request(
      "GET",
      `/repos/${repo}/commits/${pr.headSha}/check-runs`,
    )) as {
      check_runs?: {
        name?: string;
        status?: string;
        conclusion?: string | null;
        html_url?: string | null;
      }[];
    };
    return (res.check_runs ?? []).map((c) => ({
      name: c.name ?? "check",
      status: mapGithubCheck(c.status, c.conclusion),
      url: c.html_url ?? null,
    }));
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
    {
      head: string;
      base: string;
      title: string;
      body: string;
      merged: boolean;
      strategy?: MergeStrategy;
      checks: CheckRun[];
    }
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
    state.prs.set(id, { ...params, merged: false, checks: [] });
    return { id, url: `mock://${repo}/pull/${id}` };
  }

  async getPullRequest(repo: string, prId: string): Promise<PullRequestDetails> {
    const state = this.repoState(repo);
    const pr = state.prs.get(prId);
    if (!pr) throw new GitProviderError(`unknown pr '${prId}'`, 404);
    return {
      id: prId,
      url: `mock://${repo}/pull/${prId}`,
      state: pr.merged ? "merged" : "open",
      head: pr.head,
      base: pr.base,
      title: pr.title,
      headSha: state.branches.get(pr.head) ?? null,
    };
  }

  async listChecks(repo: string, prId: string): Promise<CheckRun[]> {
    const pr = this.repoState(repo).prs.get(prId);
    if (!pr) throw new GitProviderError(`unknown pr '${prId}'`, 404);
    return pr.checks;
  }

  /** test/air-gapped helper: seed the checks returned for a PR */
  setChecks(repo: string, prId: string, checks: CheckRun[]): void {
    const pr = this.repoState(repo).prs.get(prId);
    if (!pr) throw new GitProviderError(`unknown pr '${prId}'`, 404);
    pr.checks = checks;
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
    case "gitlab":
      return new GitLabProvider({
        token: config.token,
        ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
        ...(fetchImpl ? { fetchImpl } : {}),
      });
    case "bitbucket":
      return new BitbucketProvider({
        token: config.token,
        ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
        ...(fetchImpl ? { fetchImpl } : {}),
      });
    case "azure_devops":
      if (!config.baseUrl) {
        throw new GitProviderError(
          "azure_devops requires a baseUrl (the organization URL, e.g. https://dev.azure.com/<organization>)",
        );
      }
      return new AzureDevOpsProvider({
        token: config.token,
        baseUrl: config.baseUrl,
        ...(fetchImpl ? { fetchImpl } : {}),
      });
    case "mock":
      return sharedMock;
  }
}
