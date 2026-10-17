// GitLab (gitlab.com and self-managed) read-only reader, REST v4.
// Pagination follows the offset `x-next-page` header (empty on the last page).

import {
  assertCommitSha,
  clampLimit,
  decodeBase64Text,
  encodeRepoPath,
  HistoryScanDisabledError,
  ReadClient,
  repoSegments,
} from "./http.js";
import {
  REPO_READ_DEFAULTS,
  type CommitSummary,
  type CredentialScopeReport,
  type ListCommitsOptions,
  type ListReposOptions,
  type ReadFileOptions,
  type ReadFileResult,
  type ReadResponse,
  type RepoListResult,
  type RepoReader,
  type RepoReaderOptions,
  type RepoTree,
  type TreeEntry,
  type TreeOptions,
} from "./types.js";
import { trimTrailingSlashes } from "../url.js";

const hint = (status: number): string =>
  status === 401
    ? " (token rejected: a personal/project/group access token is sent as PRIVATE-TOKEN)"
    : status === 404
      ? " (not found, or the token cannot see it: repo is 'group/project')"
      : "";

/** scopes that can write; `read_api` and `read_repository` are what a scan needs */
const GITLAB_WRITE_SCOPES = new Set(["api", "write_repository", "write_registry", "sudo", "admin_mode", "k8s_proxy", "create_runner", "manage_runner"]);

interface GlProject {
  path_with_namespace?: string;
  default_branch?: string | null;
  archived?: boolean;
}

export class GitLabRepoReader implements RepoReader {
  readonly kind = "gitlab" as const;
  readonly historyEnabled: boolean;
  private readonly http: ReadClient;

  constructor(opts: RepoReaderOptions) {
    this.historyEnabled = opts.allowHistory === true;
    const root = trimTrailingSlashes(opts.baseUrl ?? "https://gitlab.com/api/v4");
    this.http = new ReadClient({
      label: "gitlab",
      baseUrl: root.endsWith("/api/v4") ? root : `${root}/api/v4`,
      token: opts.token,
      authHeaders: { "private-token": opts.token, accept: "application/json" },
      opts,
    });
  }

  private project(repo: string): string {
    return encodeURIComponent(repoSegments(repo, 2).join("/"));
  }

  /** follow x-next-page until done, the item cap or the page cap */
  private async paged<T>(first: string, max: number, take: (item: T) => void, count: () => number): Promise<boolean> {
    const sep = first.includes("?") ? "&" : "?";
    let page: string | null = "1";
    let pages = 0;
    while (page) {
      if (pages++ >= this.http.maxPages || count() >= max) return true;
      const got: { body: T[]; res: ReadResponse } = await this.http.getJson<T[]>(`${first}${sep}page=${encodeURIComponent(page)}`, hint);
      for (const item of Array.isArray(got.body) ? got.body : []) take(item);
      const next: string = (this.http.header(got.res, "x-next-page") ?? "").trim();
      page = next && [...next].every((c) => c >= "0" && c <= "9") && next.length <= 9 ? next : null;
    }
    return count() > max;
  }

  async listRepos(opts: ListReposOptions = {}): Promise<RepoListResult> {
    const max = clampLimit(opts.maxRepos, REPO_READ_DEFAULTS.maxRepos);
    const first = opts.namespace
      ? `/groups/${encodeURIComponent(opts.namespace)}/projects?include_subgroups=true&archived=false&per_page=100`
      : "/projects?membership=true&archived=false&per_page=100";
    const repos: RepoListResult["repos"] = [];
    const truncated = await this.paged<GlProject>(
      first,
      max,
      (p) => {
        if (typeof p.path_with_namespace === "string") {
          repos.push({ fullName: p.path_with_namespace, defaultBranch: p.default_branch ?? null, archived: p.archived === true });
        }
      },
      () => repos.length,
    );
    return { repos: repos.slice(0, max), truncated };
  }

  private async tree(repo: string, sha: string, opts: TreeOptions): Promise<{ entries: TreeEntry[]; truncated: boolean }> {
    const max = clampLimit(opts.maxTreeEntries, REPO_READ_DEFAULTS.maxTreeEntries);
    const entries: TreeEntry[] = [];
    const truncated = await this.paged<{ path?: string; type?: string }>(
      `/projects/${this.project(repo)}/repository/tree?ref=${assertCommitSha(sha)}&recursive=true&per_page=100`,
      max,
      (t) => {
        if (t.type === "blob" && typeof t.path === "string") entries.push({ path: t.path, size: null });
      },
      () => entries.length,
    );
    return { entries: entries.slice(0, max), truncated };
  }

  async getTree(repo: string, opts: TreeOptions = {}): Promise<RepoTree> {
    const id = this.project(repo);
    const { body: meta } = await this.http.getJson<GlProject>(`/projects/${id}`, hint);
    const branch = meta.default_branch ?? null;
    if (!branch) return { repo, ref: null, commitSha: "", author: null, entries: [], truncated: false };
    const { body: b } = await this.http.getJson<{ commit?: { id?: string; author_name?: string; author_email?: string } }>(
      `/projects/${id}/repository/branches/${encodeURIComponent(branch)}`,
      hint,
    );
    const sha = b.commit?.id ?? "";
    const { entries, truncated } = await this.tree(repo, sha, opts);
    return {
      repo,
      ref: branch,
      commitSha: sha,
      author: b.commit ? { name: b.commit.author_name ?? null, email: b.commit.author_email ?? null } : null,
      entries,
      truncated,
    };
  }

  async readFile(repo: string, path: string, opts: ReadFileOptions): Promise<ReadFileResult> {
    const maxBytes = clampLimit(opts.maxBytes, REPO_READ_DEFAULTS.maxFileBytes, REPO_READ_DEFAULTS.maxFileBytesCeiling);
    const encodedPath = encodeURIComponent(decodeURIComponent(encodeRepoPath(path)));
    const res = await this.http.get(
      `/projects/${this.project(repo)}/repository/files/${encodedPath}?ref=${assertCommitSha(opts.commitSha)}`,
    );
    if (res.status === 404) return { status: "not_found" };
    if (res.status >= 400) await this.http.fail(res, hint);
    const body = (await res.json()) as { size?: number; encoding?: string; content?: string };
    const size = typeof body.size === "number" ? body.size : null;
    if (size !== null && size > maxBytes) return { status: "too_large", size };
    if (body.encoding !== "base64" || typeof body.content !== "string") return { status: "binary", size };
    const text = decodeBase64Text(body.content);
    if (text === null) return { status: "binary", size };
    if (Buffer.byteLength(text) > maxBytes) return { status: "too_large", size };
    return { status: "ok", content: text, size: size ?? Buffer.byteLength(text) };
  }

  async inspectCredential(): Promise<CredentialScopeReport> {
    const res = await this.http.get("/personal_access_tokens/self");
    if (res.status === 404 || res.status === 403) {
      return { status: "unverified", scopes: [], detail: "this GitLab version or token type cannot report its scopes; write scope unverified" };
    }
    if (res.status >= 400) await this.http.fail(res, hint);
    const body = (await res.json()) as { scopes?: unknown };
    const scopes = Array.isArray(body.scopes) ? body.scopes.filter((s): s is string => typeof s === "string") : [];
    const write = scopes.filter((s) => GITLAB_WRITE_SCOPES.has(s));
    return write.length > 0
      ? { status: "write_scope", scopes, detail: `the token grants write scope(s): ${write.join(", ")}` }
      : { status: "read_only", scopes, detail: "token scopes are read-only" };
  }

  async listCommits(repo: string, opts: ListCommitsOptions = {}): Promise<CommitSummary[]> {
    if (!this.historyEnabled) throw new HistoryScanDisabledError();
    const max = clampLimit(opts.maxCommits, REPO_READ_DEFAULTS.maxCommits);
    const ref = opts.ref ? `&ref_name=${encodeURIComponent(opts.ref)}` : "";
    const out: CommitSummary[] = [];
    await this.paged<{ id?: string; author_name?: string; author_email?: string; committed_date?: string }>(
      `/projects/${this.project(repo)}/repository/commits?per_page=100${ref}`,
      max,
      (c) => {
        if (typeof c.id === "string") {
          out.push({ sha: c.id, author: { name: c.author_name ?? null, email: c.author_email ?? null }, committedAt: c.committed_date ?? null });
        }
      },
      () => out.length,
    );
    return out.slice(0, max);
  }

  async getTreeAt(repo: string, commitSha: string, opts: TreeOptions = {}): Promise<RepoTree> {
    if (!this.historyEnabled) throw new HistoryScanDisabledError();
    const { body } = await this.http.getJson<{ id?: string; author_name?: string; author_email?: string }>(
      `/projects/${this.project(repo)}/repository/commits/${assertCommitSha(commitSha)}`,
      hint,
    );
    const { entries, truncated } = await this.tree(repo, commitSha, opts);
    return {
      repo,
      ref: null,
      commitSha,
      author: { name: body.author_name ?? null, email: body.author_email ?? null },
      entries,
      truncated,
    };
  }
}
