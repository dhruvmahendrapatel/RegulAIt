// GitLab adapter — REST v4 (ROADMAP Batch A).
//
// Mapping decisions (the MR-vocabulary mapping is the real design work here):
// - PR abstraction ↔ GitLab **Merge Request**. An MR carries two identifiers:
//   a global `id` and a project-scoped `iid`. Every merge_requests endpoint
//   addresses the MR by `iid`, so PullRequestRef.id stores the **iid**.
// - `repo` is the project path with namespace ("group/subgroup/project"),
//   URL-encoded into the /projects/:id path parameter.
// - checks ↔ **commit statuses of the MR head sha** — GitLab CI pipelines
//   (and external CI) report per-job statuses there, so this is the closest
//   faithful mapping of "PR checks".
// - auth: the connection token is sent as the `PRIVATE-TOKEN` header, which
//   accepts personal/project/group access tokens — the shapes an admin
//   pastes into a git connection. OAuth2 bearer tokens are NOT supported by
//   this adapter (they would need `Authorization: Bearer`); documented
//   trade-off, revisit if a connection ever stores OAuth tokens.
// - baseUrl: either the instance root ("https://gitlab.example.com") or the
//   full API base ("https://gitlab.example.com/api/v4") — the "/api/v4"
//   suffix is appended when missing. Defaults to https://gitlab.com/api/v4.
// - merge strategies: "merge" → PUT /merge with squash=false; "squash" →
//   squash=true (per-MR squash is supported by the API). "rebase" is
//   REJECTED with a clear error: GitLab's merge method (merge commit vs
//   fast-forward, optionally with semi-linear rebase) is a *project-level
//   setting*, not a per-merge-request choice, so a faithful per-call rebase
//   merge does not exist and substituting one silently is forbidden.
//   Caveat: a project's "squash commits" setting of always/never can
//   override the per-MR squash flag server-side.

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
import { scrubSecrets } from "@regulait/shared";
import { trimTrailingSlashes } from "./url.js";

export interface GitLabAdapterOptions {
  /** personal/project/group access token with `api` scope (sent as PRIVATE-TOKEN) */
  token: string;
  /** instance root or full API base; "/api/v4" is appended when missing */
  baseUrl?: string;
  fetchImpl?: FetchLike;
}

function hintFor(status: number): string {
  switch (status) {
    case 401:
      return " — token rejected: expected a GitLab personal/project/group access token with 'api' scope (sent as PRIVATE-TOKEN)";
    case 403:
      return " — token is valid but lacks permission on this project";
    case 404:
      return " — not found: check the project path format 'group/project' (GitLab also returns 404 for projects the token cannot see)";
    default:
      return "";
  }
}

function mapCheckStatus(s: string | undefined): CheckStatus {
  switch (s) {
    case "success":
      return "success";
    case "failed":
      return "failure";
    case "running":
      return "running";
    case "canceled":
      return "canceled";
    case "skipped":
      return "skipped";
    // created | pending | manual | scheduled | waiting_for_resource | unknown
    default:
      return "pending";
  }
}

function mapPrState(s: string | undefined): PullRequestState {
  if (s === "opened") return "open";
  if (s === "merged") return "merged";
  return "closed"; // closed | locked
}

export class GitLabProvider implements GitProvider {
  readonly kind = "gitlab" as const;
  private readonly base: string;
  private readonly token: string;
  private readonly fetchImpl: FetchLike;

  constructor(opts: GitLabAdapterOptions) {
    let base = trimTrailingSlashes(opts.baseUrl ?? "https://gitlab.com/api/v4");
    if (!/\/api\/v4$/.test(base)) base = `${base}/api/v4`;
    this.base = base;
    this.token = opts.token;
    this.fetchImpl = opts.fetchImpl ?? (fetch as unknown as FetchLike);
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await this.fetchImpl(`${this.base}${path}`, {
      method,
      headers: {
        "private-token": this.token,
        accept: "application/json",
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    if (res.status >= 400) {
      throw new GitProviderError(
        `gitlab ${method} ${path} failed (${res.status}): ${scrubSecrets(text, [this.token])}${hintFor(res.status)}`,
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

  private proj(repo: string): string {
    return encodeURIComponent(repo);
  }

  async createBranch(repo: string, branch: string, fromBranch: string): Promise<void> {
    await this.request("POST", `/projects/${this.proj(repo)}/repository/branches`, {
      branch,
      ref: fromBranch,
    });
  }

  async openPullRequest(
    repo: string,
    params: { head: string; base: string; title: string; body: string },
  ): Promise<PullRequestRef> {
    const mr = (await this.request("POST", `/projects/${this.proj(repo)}/merge_requests`, {
      source_branch: params.head,
      target_branch: params.base,
      title: params.title,
      description: params.body,
    })) as { iid: number; web_url: string };
    return { id: String(mr.iid), url: mr.web_url };
  }

  async getPullRequest(repo: string, prId: string): Promise<PullRequestDetails> {
    const mr = (await this.request(
      "GET",
      `/projects/${this.proj(repo)}/merge_requests/${prId}`,
    )) as {
      iid: number;
      web_url: string;
      state?: string;
      source_branch: string;
      target_branch: string;
      title: string;
      sha?: string | null;
    };
    return {
      id: String(mr.iid),
      url: mr.web_url,
      state: mapPrState(mr.state),
      head: mr.source_branch,
      base: mr.target_branch,
      title: mr.title,
      headSha: mr.sha ?? null,
    };
  }

  async listChecks(repo: string, prId: string): Promise<CheckRun[]> {
    const pr = await this.getPullRequest(repo, prId);
    if (!pr.headSha) return [];
    const statuses = (await this.request(
      "GET",
      `/projects/${this.proj(repo)}/repository/commits/${pr.headSha}/statuses`,
    )) as { name?: string; status?: string; target_url?: string | null }[] | null;
    return (statuses ?? []).map((s) => ({
      name: s.name ?? "status",
      status: mapCheckStatus(s.status),
      url: s.target_url ?? null,
    }));
  }

  async mergePullRequest(
    repo: string,
    prId: string,
    strategy: MergeStrategy,
  ): Promise<MergeResult> {
    if (strategy === "rebase") {
      throw new GitProviderError(
        "gitlab does not support a per-merge 'rebase' strategy — the merge method (merge commit vs fast-forward/semi-linear) is a project-level GitLab setting, not a per-MR API option; use 'merge' or 'squash', or configure fast-forward merges on the GitLab project itself",
      );
    }
    try {
      const mr = (await this.request(
        "PUT",
        `/projects/${this.proj(repo)}/merge_requests/${prId}/merge`,
        { squash: strategy === "squash" },
      )) as {
        state?: string;
        merge_commit_sha?: string | null;
        squash_commit_sha?: string | null;
        sha?: string | null;
      };
      return {
        merged: mr.state === "merged",
        sha: mr.merge_commit_sha ?? mr.squash_commit_sha ?? mr.sha ?? null,
      };
    } catch (err) {
      // GitLab's merge refusals: 405 (MR draft/closed/pipeline gate),
      // 406 ("Branch cannot be merged" — merge conflict), 409 (head sha
      // moved), 422. Surface an actionable message on top of the raw body.
      if (
        err instanceof GitProviderError &&
        (err.status === 405 || err.status === 406 || err.status === 409 || err.status === 422)
      ) {
        throw new GitProviderError(
          `gitlab refused to merge MR !${prId}: ${err.message} — a 405/406/409 here usually means a merge conflict, a draft/closed MR, or a required pipeline that has not passed; resolve in GitLab and retry`,
          err.status,
        );
      }
      throw err;
    }
  }
}
