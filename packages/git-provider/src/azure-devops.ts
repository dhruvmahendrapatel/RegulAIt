// Azure DevOps Repos adapter — REST 7.1 (ROADMAP Batch A).
//
// Mapping decisions:
// - baseUrl (REQUIRED) is the *organization* URL, e.g.
//   "https://dev.azure.com/{organization}" (on-prem/Server:
//   "https://{server}/tfs/{collection}"). `repo` is
//   "{project}/{repository}" — project and repository are separate path
//   segments in every ADO Repos route, so both ride in the repo string.
// - auth: PAT sent as `Basic base64(":" + pat)` — mirrors the existing
//   pm-provider ADO adapter. ADO's famous gotcha: an invalid/expired PAT
//   often answers **203 + an HTML sign-in page** instead of 401; we detect
//   203 and raise an auth error rather than trying to parse HTML as JSON.
// - branch creation: ADO has no "create branch" endpoint; branches are refs
//   created via POST .../refs with oldObjectId = 40 zeros. That POST returns
//   **HTTP 200 even when the update fails** — the per-update `success` flag
//   must be checked (a `staleOldObjectId` updateStatus on creation means the
//   branch already exists).
// - PR abstraction ↔ ADO pull request; **merge ↔ PR completion** (PATCH
//   status:"completed" + completionOptions). Completion is asynchronous by
//   design: if the PATCH response still shows status "active", we throw a
//   retryable error instead of claiming a merge that has not landed. Before
//   completing we check the PR's mergeStatus and fail fast with 409 on
//   "conflicts".
// - checks ↔ **PR statuses** (GET .../pullrequests/{id}/statuses) — the
//   surface build-validation policies and external services post to. Branch
//   policy *evaluations* (the richer policy API) are deliberately not
//   queried; documented simplification.
// - merge strategies: merge → "noFastForward" (always a merge commit, ADO's
//   default), squash → "squash", rebase → "rebase" (rebase source onto
//   target then fast-forward, no merge commit — same semantics as GitHub's
//   rebase merge). ADO's fourth option "rebaseMerge" (rebase + merge
//   commit) has no counterpart in the abstraction and is not used.

import {
  GitProviderError,
  type CheckRun,
  type CheckStatus,
  type FetchLike,
  type GitProvider,
  type MergeResult,
  type MergeStrategy,
  type PullRequestDetails,
  type PullRequestRef,
  type PullRequestState,
} from "./types.js";

export interface AzureDevOpsAdapterOptions {
  /** personal access token with Code Read & Write scope */
  token: string;
  /** organization URL, e.g. https://dev.azure.com/{organization} */
  baseUrl: string;
  fetchImpl?: FetchLike;
}

const API = "api-version=7.1";
const ZERO_SHA = "0000000000000000000000000000000000000000";

function hintFor(status: number): string {
  switch (status) {
    case 401:
    case 403:
      return " — authentication failed: check the PAT is valid, unexpired, and has 'Code (Read & Write)' scope for this organization";
    case 404:
      return " — not found: check baseUrl is the organization URL (https://dev.azure.com/<organization>) and repo is '<project>/<repository>'";
    default:
      return "";
  }
}

function mapCheckStatus(s: string | undefined): CheckStatus {
  switch (s) {
    case "succeeded":
      return "success";
    case "failed":
    case "error":
      return "failure";
    case "notApplicable":
      return "skipped";
    // pending | notSet | unknown
    default:
      return "pending";
  }
}

function mapPrState(s: string | undefined): PullRequestState {
  if (s === "active") return "open";
  if (s === "completed") return "merged";
  return "closed"; // abandoned | notSet
}

function stripRef(ref: string | undefined): string {
  return (ref ?? "").replace(/^refs\/heads\//, "");
}

export class AzureDevOpsProvider implements GitProvider {
  readonly kind = "azure_devops" as const;
  private readonly base: string;
  private readonly auth: string;
  private readonly fetchImpl: FetchLike;

  constructor(opts: AzureDevOpsAdapterOptions) {
    if (!opts.baseUrl) {
      throw new GitProviderError(
        "azure_devops requires a baseUrl (the organization URL, e.g. https://dev.azure.com/<organization>)",
      );
    }
    this.base = opts.baseUrl.replace(/\/+$/, "");
    this.auth = `Basic ${Buffer.from(`:${opts.token}`).toString("base64")}`;
    this.fetchImpl = opts.fetchImpl ?? (fetch as unknown as FetchLike);
  }

  private split(repo: string): { project: string; repository: string } {
    const idx = repo.indexOf("/");
    if (idx <= 0 || idx === repo.length - 1) {
      throw new GitProviderError(
        `azure_devops repo must be '<project>/<repository>', got '${repo}'`,
      );
    }
    return {
      project: encodeURIComponent(repo.slice(0, idx)),
      repository: encodeURIComponent(repo.slice(idx + 1)),
    };
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await this.fetchImpl(`${this.base}${path}`, {
      method,
      headers: {
        authorization: this.auth,
        accept: "application/json",
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (res.status === 203) {
      // ADO answers bad credentials with 203 + an HTML sign-in page.
      throw new GitProviderError(
        `azure_devops ${method} ${path} returned 203 (non-authoritative sign-in page) — the PAT was not accepted; check it is valid, unexpired, and scoped to this organization`,
        203,
      );
    }
    const text = await res.text();
    if (res.status >= 400) {
      throw new GitProviderError(
        `azure_devops ${method} ${path} failed (${res.status}): ${text}${hintFor(res.status)}`,
        res.status,
      );
    }
    if (!text) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }

  async createBranch(repo: string, branch: string, fromBranch: string): Promise<void> {
    const { project, repository } = this.split(repo);
    const refs = (await this.request(
      "GET",
      `/${project}/_apis/git/repositories/${repository}/refs?filter=${encodeURIComponent(`heads/${fromBranch}`)}&${API}`,
    )) as { value?: { name?: string; objectId?: string }[] } | null;
    // ?filter= is a prefix match — insist on the exact ref.
    const match = (refs?.value ?? []).find((r) => r.name === `refs/heads/${fromBranch}`);
    if (!match?.objectId) {
      throw new GitProviderError(
        `azure_devops base branch '${fromBranch}' not found in '${repo}'`,
        404,
      );
    }
    const result = (await this.request(
      "POST",
      `/${project}/_apis/git/repositories/${repository}/refs?${API}`,
      [{ name: `refs/heads/${branch}`, oldObjectId: ZERO_SHA, newObjectId: match.objectId }],
    )) as { value?: { success?: boolean; updateStatus?: string }[] } | null;
    const update = result?.value?.[0];
    if (!update?.success) {
      // ADO returns HTTP 200 for failed ref updates; the success flag is
      // authoritative. staleOldObjectId on a zero oldObjectId means the
      // branch already exists.
      throw new GitProviderError(
        `azure_devops ref create for '${branch}' in '${repo}' failed (updateStatus=${update?.updateStatus ?? "unknown"}) — 'staleOldObjectId' here means the branch already exists`,
        409,
      );
    }
  }

  async openPullRequest(
    repo: string,
    params: { head: string; base: string; title: string; body: string },
  ): Promise<PullRequestRef> {
    const { project, repository } = this.split(repo);
    const pr = (await this.request(
      "POST",
      `/${project}/_apis/git/repositories/${repository}/pullrequests?${API}`,
      {
        sourceRefName: `refs/heads/${params.head}`,
        targetRefName: `refs/heads/${params.base}`,
        title: params.title,
        description: params.body,
      },
    )) as { pullRequestId: number; repository?: { webUrl?: string } };
    return { id: String(pr.pullRequestId), url: this.webUrl(pr, project, repository) };
  }

  /** the API's `url` field is an API link; build the human web URL instead */
  private webUrl(
    pr: { pullRequestId: number; repository?: { webUrl?: string } },
    project: string,
    repository: string,
  ): string {
    const root = pr.repository?.webUrl ?? `${this.base}/${project}/_git/${repository}`;
    return `${root}/pullrequest/${pr.pullRequestId}`;
  }

  async getPullRequest(repo: string, prId: string): Promise<PullRequestDetails> {
    const { project, repository } = this.split(repo);
    const pr = (await this.request(
      "GET",
      `/${project}/_apis/git/repositories/${repository}/pullrequests/${prId}?${API}`,
    )) as {
      pullRequestId: number;
      status?: string;
      title?: string;
      sourceRefName?: string;
      targetRefName?: string;
      lastMergeSourceCommit?: { commitId?: string };
      repository?: { webUrl?: string };
    };
    return {
      id: String(pr.pullRequestId),
      url: this.webUrl(pr, project, repository),
      state: mapPrState(pr.status),
      head: stripRef(pr.sourceRefName),
      base: stripRef(pr.targetRefName),
      title: pr.title ?? "",
      headSha: pr.lastMergeSourceCommit?.commitId ?? null,
    };
  }

  async listChecks(repo: string, prId: string): Promise<CheckRun[]> {
    const { project, repository } = this.split(repo);
    const res = (await this.request(
      "GET",
      `/${project}/_apis/git/repositories/${repository}/pullrequests/${prId}/statuses?${API}`,
    )) as {
      value?: {
        context?: { name?: string; genre?: string | null };
        state?: string;
        targetUrl?: string | null;
      }[];
    } | null;
    return (res?.value ?? []).map((s) => ({
      name: s.context?.genre
        ? `${s.context.genre}/${s.context?.name ?? "status"}`
        : (s.context?.name ?? "status"),
      status: mapCheckStatus(s.state),
      url: s.targetUrl ?? null,
    }));
  }

  async mergePullRequest(
    repo: string,
    prId: string,
    strategy: MergeStrategy,
  ): Promise<MergeResult> {
    const { project, repository } = this.split(repo);
    const strategyMap: Record<MergeStrategy, string> = {
      merge: "noFastForward",
      squash: "squash",
      rebase: "rebase",
    };
    // Completion needs the exact source commit being merged; fetch the PR
    // first, and fail fast on a known-conflicted merge preview.
    const current = (await this.request(
      "GET",
      `/${project}/_apis/git/repositories/${repository}/pullrequests/${prId}?${API}`,
    )) as { mergeStatus?: string; lastMergeSourceCommit?: { commitId?: string } };
    if (current.mergeStatus === "conflicts") {
      throw new GitProviderError(
        `azure_devops PR ${prId} has merge conflicts (mergeStatus=conflicts) — resolve the conflicts in Azure DevOps, then re-run the merge`,
        409,
      );
    }
    const commitId = current.lastMergeSourceCommit?.commitId;
    if (!commitId) {
      throw new GitProviderError(
        `azure_devops PR ${prId} has no lastMergeSourceCommit yet (mergeStatus=${current.mergeStatus ?? "unknown"}) — the merge preview may still be computing; retry shortly`,
      );
    }
    const done = (await this.request(
      "PATCH",
      `/${project}/_apis/git/repositories/${repository}/pullrequests/${prId}?${API}`,
      {
        status: "completed",
        lastMergeSourceCommit: { commitId },
        completionOptions: { mergeStrategy: strategyMap[strategy], deleteSourceBranch: false },
      },
    )) as { status?: string; lastMergeCommit?: { commitId?: string } };
    if (done.status !== "completed") {
      // PR completion runs asynchronously server-side; never report a merge
      // that has not landed.
      throw new GitProviderError(
        `azure_devops accepted the completion request but PR ${prId} is still '${done.status ?? "unknown"}' — completion runs asynchronously; poll the PR and re-run the merge once it settles`,
      );
    }
    return { merged: true, sha: done.lastMergeCommit?.commitId ?? null };
  }
}
