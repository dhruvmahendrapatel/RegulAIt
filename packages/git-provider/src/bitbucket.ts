// Bitbucket Cloud adapter — REST 2.0 (ROADMAP Batch A).
//
// Mapping decisions:
// - `repo` is "workspace/repo_slug" (the two path segments under
//   /repositories/...).
// - auth: the connection token is expected in the Bitbucket Cloud
//   app-password convention "username:app_password" and is sent as HTTP
//   Basic. A token WITHOUT a colon is treated as a workspace/repository
//   access token (or OAuth access token) and sent as `Authorization:
//   Bearer` instead. Both shapes documented for the admin UI.
// - checks ↔ **pull request statuses** (GET .../pullrequests/{id}/statuses),
//   the commit-status rollup Bitbucket Pipelines and external CI report to.
//   The endpoint is paginated; we follow `next` links to completion.
// - branch creation needs the source tip hash first (GET
//   refs/branches/{from} → target.hash), then POST refs/branches.
// - merge strategies: merge → "merge_commit", squash → "squash". "rebase"
//   is REJECTED with a clear error: Bitbucket Cloud offers
//   merge_commit | squash | fast_forward, and fast_forward is NOT a rebase
//   (it refuses when the destination has diverged instead of replaying the
//   commits), so substituting it would be a silent approximation.
// - a 202 from POST .../merge means Bitbucket queued the merge
//   asynchronously; we throw an explicit retryable error instead of
//   reporting a merge that has not happened yet.

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

export interface BitbucketAdapterOptions {
  /** "username:app_password" (Basic) or a workspace/repo access token (Bearer) */
  token: string;
  /** defaults to https://api.bitbucket.org/2.0 */
  baseUrl?: string;
  fetchImpl?: FetchLike;
}

function hintFor(status: number): string {
  switch (status) {
    case 401:
      return " — authentication failed: expected the token as 'username:app_password' (sent as Basic) or a workspace/repository access token (sent as Bearer); check the app password has 'repository:write' and 'pullrequest:write' scopes";
    case 403:
      return " — the credential is valid but lacks permission on this repository";
    case 404:
      return " — not found: check the repo format 'workspace/repo_slug'";
    default:
      return "";
  }
}

function mapCheckStatus(s: string | undefined): CheckStatus {
  switch (s) {
    case "SUCCESSFUL":
      return "success";
    case "FAILED":
      return "failure";
    case "INPROGRESS":
      return "running";
    case "STOPPED":
      return "canceled";
    default:
      return "pending";
  }
}

function mapPrState(s: string | undefined): PullRequestState {
  if (s === "OPEN") return "open";
  if (s === "MERGED") return "merged";
  return "closed"; // DECLINED | SUPERSEDED
}

export class BitbucketProvider implements GitProvider {
  readonly kind = "bitbucket" as const;
  private readonly base: string;
  private readonly auth: string;
  private readonly fetchImpl: FetchLike;

  constructor(opts: BitbucketAdapterOptions) {
    this.base = (opts.baseUrl ?? "https://api.bitbucket.org/2.0").replace(/\/+$/, "");
    this.auth = opts.token.includes(":")
      ? `Basic ${Buffer.from(opts.token).toString("base64")}`
      : `Bearer ${opts.token}`;
    this.fetchImpl = opts.fetchImpl ?? (fetch as unknown as FetchLike);
  }

  /** urlOrPath may be an absolute URL (pagination `next` links) or a path */
  private async request(
    method: string,
    urlOrPath: string,
    body?: unknown,
  ): Promise<{ status: number; data: unknown }> {
    const url = urlOrPath.startsWith("http") ? urlOrPath : `${this.base}${urlOrPath}`;
    const res = await this.fetchImpl(url, {
      method,
      headers: {
        authorization: this.auth,
        accept: "application/json",
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    if (res.status >= 400) {
      throw new GitProviderError(
        `bitbucket ${method} ${urlOrPath} failed (${res.status}): ${text}${hintFor(res.status)}`,
        res.status,
      );
    }
    let data: unknown = null;
    if (text) {
      try {
        data = JSON.parse(text) as unknown;
      } catch {
        data = text;
      }
    }
    return { status: res.status, data };
  }

  async createBranch(repo: string, branch: string, fromBranch: string): Promise<void> {
    const src = (
      await this.request(
        "GET",
        `/repositories/${repo}/refs/branches/${encodeURIComponent(fromBranch)}`,
      )
    ).data as { target?: { hash?: string } };
    const hash = src.target?.hash;
    if (!hash) {
      throw new GitProviderError(
        `bitbucket base branch '${fromBranch}' in '${repo}' has no target hash`,
        404,
      );
    }
    await this.request("POST", `/repositories/${repo}/refs/branches`, {
      name: branch,
      target: { hash },
    });
  }

  async openPullRequest(
    repo: string,
    params: { head: string; base: string; title: string; body: string },
  ): Promise<PullRequestRef> {
    const pr = (
      await this.request("POST", `/repositories/${repo}/pullrequests`, {
        title: params.title,
        description: params.body,
        source: { branch: { name: params.head } },
        destination: { branch: { name: params.base } },
      })
    ).data as { id: number; links?: { html?: { href?: string } } };
    return { id: String(pr.id), url: pr.links?.html?.href ?? "" };
  }

  async getPullRequest(repo: string, prId: string): Promise<PullRequestDetails> {
    const pr = (await this.request("GET", `/repositories/${repo}/pullrequests/${prId}`))
      .data as {
      id: number;
      state?: string;
      title: string;
      links?: { html?: { href?: string } };
      source?: { branch?: { name?: string }; commit?: { hash?: string } };
      destination?: { branch?: { name?: string } };
    };
    return {
      id: String(pr.id),
      url: pr.links?.html?.href ?? "",
      state: mapPrState(pr.state),
      head: pr.source?.branch?.name ?? "",
      base: pr.destination?.branch?.name ?? "",
      title: pr.title,
      headSha: pr.source?.commit?.hash ?? null,
    };
  }

  async listChecks(repo: string, prId: string): Promise<CheckRun[]> {
    const out: CheckRun[] = [];
    let next: string | null = `/repositories/${repo}/pullrequests/${prId}/statuses`;
    while (next) {
      const page = (await this.request("GET", next)).data as {
        values?: { key?: string; name?: string | null; state?: string; url?: string | null }[];
        next?: string;
      };
      for (const s of page.values ?? []) {
        out.push({
          name: s.name ?? s.key ?? "status",
          status: mapCheckStatus(s.state),
          url: s.url ?? null,
        });
      }
      next = page.next ?? null;
    }
    return out;
  }

  async mergePullRequest(
    repo: string,
    prId: string,
    strategy: MergeStrategy,
  ): Promise<MergeResult> {
    if (strategy === "rebase") {
      throw new GitProviderError(
        "bitbucket cloud does not support a 'rebase' merge strategy — it offers merge_commit, squash, and fast_forward, and fast_forward is not a rebase (it refuses on diverged branches instead of replaying commits); use 'merge' or 'squash'",
      );
    }
    try {
      const { status, data } = await this.request(
        "POST",
        `/repositories/${repo}/pullrequests/${prId}/merge`,
        {
          merge_strategy: strategy === "squash" ? "squash" : "merge_commit",
          close_source_branch: false,
        },
      );
      if (status === 202) {
        throw new GitProviderError(
          `bitbucket queued the merge of PR #${prId} asynchronously (202) — poll the pull request state and re-run the merge once it settles`,
          202,
        );
      }
      const pr = data as { state?: string; merge_commit?: { hash?: string } };
      return { merged: pr.state === "MERGED", sha: pr.merge_commit?.hash ?? null };
    } catch (err) {
      if (
        err instanceof GitProviderError &&
        (err.status === 400 || err.status === 409 || err.status === 555)
      ) {
        // Bitbucket reports unmergeable PRs as 400 (error.message describes
        // the conflict) and transient merge-backend failures as 555.
        throw new GitProviderError(
          `bitbucket refused to merge PR #${prId}: ${err.message} — this usually means a merge conflict or a PR that is not open; resolve in Bitbucket and retry`,
          err.status,
        );
      }
      throw err;
    }
  }
}
