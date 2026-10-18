// GitHub (and GitHub Enterprise Server) read-only reader, REST v3.

import { GitProviderError } from "../types.js";
import {
  assertCommitSha,
  base64EnvelopeCap,
  readJsonCapped,
  clampLimit,
  decodeBase64Text,
  encodeRepoPath,
  HistoryScanDisabledError,
  nextLinkFromHeader,
  ReadClient,
  encodeRepo,
} from "./http.js";
import {
  REPO_READ_DEFAULTS,
  type CommitSummary,
  type CredentialScopeReport,
  type ListCommitsOptions,
  type ListReposOptions,
  type ReadFileOptions,
  type ReadFileResult,
  type RepoListResult,
  type RepoReader,
  type RepoReaderOptions,
  type RepoTree,
  type TreeEntry,
  type TreeOptions,
} from "./types.js";

const hint = (status: number): string =>
  status === 401
    ? " (token rejected)"
    : status === 404
      ? " (not found, or the token cannot see it: repo is 'owner/name')"
      : "";

/**
 * ALLOW-LIST (secure by default, ADR-0180): the classic-token scopes known to
 * be read-only. Any other scope (repo, gist, user, project, write:*, admin:*,
 * codespace, delete:*, workflow, an unknown future scope) counts as write.
 * A classic token cannot read private repos without `repo`, which can write,
 * so private-repo scanning needs a fine-grained read-only token (reported as
 * "unverified": GitHub does not expose fine-grained permissions this way).
 */
const GITHUB_READ_ONLY_SCOPES = new Set([
  "read:org",
  "read:user",
  "user:email",
  "read:packages",
  "read:discussion",
  "read:project",
  "read:gpg_key",
  "read:public_key",
  "read:repo_hook",
  "read:ssh_signing_key",
  "read:enterprise",
  "read:audit_log",
]);

interface GhRepo {
  full_name?: string;
  default_branch?: string | null;
  archived?: boolean;
}
interface GhCommit {
  sha?: string;
  commit?: { author?: { name?: string; email?: string; date?: string } | null; tree?: { sha?: string } };
}

export class GitHubRepoReader implements RepoReader {
  readonly kind = "github" as const;
  readonly historyEnabled: boolean;
  private readonly http: ReadClient;
  /** only whether the token has a classic prefix is kept, never the token */
  private readonly classicToken: boolean;
  /** ADR-0195 A5: a GitHub App installation token (repos come from /installation/repositories; /user is not readable) */
  private readonly installation: boolean;

  constructor(opts: RepoReaderOptions) {
    const kind = opts.credentialKind ?? "token";
    if (kind !== "token" && kind !== "github_app_installation") throw new GitProviderError(`github does not take a ${kind} credential`);
    this.installation = kind === "github_app_installation";
    this.historyEnabled = opts.allowHistory === true;
    this.classicToken = !this.installation && (opts.token.startsWith("ghp_") || opts.token.startsWith("gho_"));
    this.http = new ReadClient({
      label: "github",
      baseUrl: opts.baseUrl ?? "https://api.github.com",
      token: opts.token,
      authHeaders: { authorization: `Bearer ${opts.token}`, accept: "application/vnd.github+json" },
      opts,
    });
  }

  async listRepos(opts: ListReposOptions = {}): Promise<RepoListResult> {
    const max = clampLimit(opts.maxRepos, REPO_READ_DEFAULTS.maxRepos);
    let next: string | null = opts.namespace
      ? `/orgs/${encodeURIComponent(opts.namespace)}/repos?per_page=100&type=all`
      : this.installation
        ? "/installation/repositories?per_page=100"
        : "/user/repos?per_page=100&affiliation=owner,collaborator,organization_member";
    const repos: RepoListResult["repos"] = [];
    let pages = 0;
    while (next) {
      if (pages++ >= this.http.maxPages || repos.length >= max) return { repos: repos.slice(0, max), truncated: true };
      const { body, res } = await this.http.getJson<GhRepo[] | { repositories?: GhRepo[] }>(next, hint);
      // an installation's listing wraps the repositories in an object
      const page = Array.isArray(body) ? body : Array.isArray(body?.repositories) ? body.repositories : [];
      for (const r of page) {
        if (typeof r.full_name !== "string") continue;
        repos.push({ fullName: r.full_name, defaultBranch: r.default_branch ?? null, archived: r.archived === true });
      }
      next = nextLinkFromHeader(this.http.header(res, "link"));
    }
    return { repos: repos.slice(0, max), truncated: repos.length > max };
  }

  private async tree(r: string, treeSha: string, opts: TreeOptions): Promise<{ entries: TreeEntry[]; truncated: boolean }> {
    const max = clampLimit(opts.maxTreeEntries, REPO_READ_DEFAULTS.maxTreeEntries);
    const { body } = await this.http.getJson<{ tree?: { path?: string; type?: string; size?: number }[]; truncated?: boolean }>(
      `/repos/${r}/git/trees/${assertCommitSha(treeSha)}?recursive=1`,
      hint,
    );
    const entries: TreeEntry[] = [];
    for (const t of body.tree ?? []) {
      if (t.type !== "blob" || typeof t.path !== "string") continue;
      entries.push({ path: t.path, size: typeof t.size === "number" ? t.size : null });
    }
    return { entries: entries.slice(0, max), truncated: body.truncated === true || entries.length > max };
  }

  async getTree(repo: string, opts: TreeOptions = {}): Promise<RepoTree> {
    const r = encodeRepo(repo, 2);
    const { body: meta } = await this.http.getJson<GhRepo>(`/repos/${r}`, hint);
    const branch = meta.default_branch ?? null;
    if (!branch) return { repo, ref: null, commitSha: "", author: null, entries: [], truncated: false };
    const { body: b } = await this.http.getJson<{ commit?: GhCommit }>(
      `/repos/${r}/branches/${encodeURIComponent(branch)}`,
      hint,
    );
    const sha = b.commit?.sha ?? "";
    const treeSha = b.commit?.commit?.tree?.sha ?? sha;
    const a = b.commit?.commit?.author;
    const { entries, truncated } = await this.tree(r, treeSha, opts);
    return {
      repo,
      ref: branch,
      commitSha: sha,
      author: a ? { name: a.name ?? null, email: a.email ?? null } : null,
      entries,
      truncated,
    };
  }

  async readFile(repo: string, path: string, opts: ReadFileOptions): Promise<ReadFileResult> {
    const r = encodeRepo(repo, 2);
    const maxBytes = clampLimit(opts.maxBytes, REPO_READ_DEFAULTS.maxFileBytes, REPO_READ_DEFAULTS.maxFileBytesCeiling);
    const res = await this.http.get(`/repos/${r}/contents/${encodeRepoPath(path)}?ref=${assertCommitSha(opts.commitSha)}`);
    if (res.status === 404) return { status: "not_found" };
    if (res.status >= 400) await this.http.fail(res, hint);
    // the base64 envelope is read under a byte cap: a large file is never fully downloaded
    const capped = await readJsonCapped<{ type?: string; encoding?: string; content?: string; size?: number }>(res, base64EnvelopeCap(maxBytes));
    if (capped.tooLarge || !capped.body) return { status: "too_large", size: null };
    const body = capped.body;
    const size = typeof body.size === "number" ? body.size : null;
    if (body.type !== "file") return { status: "not_found" };
    if (size !== null && size > maxBytes) return { status: "too_large", size };
    // files over 1 MB come back with encoding "none" and no content
    if (body.encoding !== "base64" || typeof body.content !== "string") return { status: "too_large", size };
    const text = decodeBase64Text(body.content);
    if (text === null) return { status: "binary", size };
    if (Buffer.byteLength(text) > maxBytes) return { status: "too_large", size };
    return { status: "ok", content: text, size: size ?? Buffer.byteLength(text) };
  }

  async inspectCredential(): Promise<CredentialScopeReport> {
    // an installation token cannot read /user; its permissions are what the token exchange granted (the caller checks them)
    if (this.installation) {
      return { status: "unverified", scopes: [], detail: "a GitHub App installation token reports its permissions only at the token exchange" };
    }
    const res = await this.http.getOk("/user", hint);
    const raw = this.http.header(res, "x-oauth-scopes");
    const scopes = (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const write = scopes.filter((s) => !GITHUB_READ_ONLY_SCOPES.has(s));
    if (write.length > 0) return { status: "write_scope", scopes, detail: `the token grants write scope(s): ${write.join(", ")}` };
    // read_only only when GitHub reported a non-empty, fully allow-listed scope set for a classic token;
    // an empty or absent header (fine-grained or app tokens) proves nothing
    if (this.classicToken && scopes.length > 0) return { status: "read_only", scopes, detail: "classic token with read-only scopes" };
    return {
      status: "unverified",
      scopes,
      detail: "GitHub did not report a read-only scope set for this token (fine-grained and app tokens report none); write scope unverified",
    };
  }

  async listCommits(repo: string, opts: ListCommitsOptions = {}): Promise<CommitSummary[]> {
    if (!this.historyEnabled) throw new HistoryScanDisabledError();
    const r = encodeRepo(repo, 2);
    const max = clampLimit(opts.maxCommits, REPO_READ_DEFAULTS.maxCommits);
    const ref = opts.ref ? `&sha=${encodeURIComponent(opts.ref)}` : "";
    let next: string | null = `/repos/${r}/commits?per_page=100${ref}`;
    const out: CommitSummary[] = [];
    let pages = 0;
    while (next && out.length < max && pages++ < this.http.maxPages) {
      const { body, res } = await this.http.getJson<GhCommit[]>(next, hint);
      for (const c of Array.isArray(body) ? body : []) {
        if (typeof c.sha !== "string") continue;
        const a = c.commit?.author;
        out.push({ sha: c.sha, author: a ? { name: a.name ?? null, email: a.email ?? null } : null, committedAt: a?.date ?? null });
      }
      next = nextLinkFromHeader(this.http.header(res, "link"));
    }
    return out.slice(0, max);
  }

  async getTreeAt(repo: string, commitSha: string, opts: TreeOptions = {}): Promise<RepoTree> {
    if (!this.historyEnabled) throw new HistoryScanDisabledError();
    const r = encodeRepo(repo, 2);
    const { body } = await this.http.getJson<{ sha?: string; tree?: { sha?: string }; author?: { name?: string; email?: string } }>(
      `/repos/${r}/git/commits/${assertCommitSha(commitSha)}`,
      hint,
    );
    const { entries, truncated } = await this.tree(r, body.tree?.sha ?? commitSha, opts);
    return {
      repo,
      ref: null,
      commitSha,
      author: body.author ? { name: body.author.name ?? null, email: body.author.email ?? null } : null,
      entries,
      truncated,
    };
  }
}
