// Shared contract for the git-provider package (WORKFLOW_ENGINE_SPEC.md §5).
// Kept in a leaf module so the per-provider adapter files (gitlab.ts,
// bitbucket.ts, azure-devops.ts) and the registry in index.ts can all import
// it without circular imports.

export type GitProviderKind = "github" | "gitlab" | "bitbucket" | "azure_devops" | "mock";

export type MergeStrategy = "merge" | "squash" | "rebase";

export interface PullRequestRef {
  /** provider-native PR/MR identifier, stringified */
  id: string;
  url: string;
}

/**
 * Neutral PR lifecycle state. Provider vocab maps as:
 * - GitHub: open → open; closed+merged → merged; closed → closed
 * - GitLab: opened → open; merged → merged; closed/locked → closed
 * - Bitbucket: OPEN → open; MERGED → merged; DECLINED/SUPERSEDED → closed
 * - Azure DevOps: active → open; completed → merged; abandoned → closed
 */
export type PullRequestState = "open" | "merged" | "closed";

export interface PullRequestDetails extends PullRequestRef {
  state: PullRequestState;
  /** source branch name, without any refs/heads/ prefix */
  head: string;
  /** target branch name, without any refs/heads/ prefix */
  base: string;
  title: string;
  /** sha of the head commit when the provider exposes it (checks anchor here) */
  headSha: string | null;
}

/**
 * Neutral CI-check status. "pending" covers queued/created/not-started,
 * "running" covers in-progress; terminal states are success/failure/
 * canceled/skipped. Unknown provider states map to "pending" (never to
 * success — a governance gate must not pass on an unrecognized state).
 */
export type CheckStatus = "pending" | "running" | "success" | "failure" | "canceled" | "skipped";

export interface CheckRun {
  name: string;
  status: CheckStatus;
  url: string | null;
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
  getPullRequest(repo: string, prId: string): Promise<PullRequestDetails>;
  /** CI checks/statuses attached to the PR's head commit */
  listChecks(repo: string, prId: string): Promise<CheckRun[]>;
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

export type FetchLike = (url: string, init?: {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}) => Promise<{ status: number; json(): Promise<unknown>; text(): Promise<string> }>;
