// Bitbucket Cloud read-only reader, REST 2.0. Listings page through the
// absolute `next` link in the body, checked to stay on the API origin.

import {
  assertCommitSha,
  clampLimit,
  encodeRepo,
  encodeRepoPath,
  HistoryScanDisabledError,
  looksBinary,
  ReadClient,
  splitRawAuthor,
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
    ? " (credential rejected: 'username:app_password' is sent as Basic, anything else as Bearer)"
    : status === 404
      ? " (not found: repo is 'workspace/repo_slug')"
      : "";

/** how deep the recursive `src` listing goes; deeper trees are reported truncated */
const BITBUCKET_MAX_DEPTH = 30;

interface BbPage<T> {
  values?: T[];
  next?: string;
}
interface BbCommit {
  hash?: string;
  date?: string;
  author?: { raw?: string };
}

export class BitbucketRepoReader implements RepoReader {
  readonly kind = "bitbucket" as const;
  readonly historyEnabled: boolean;
  private readonly http: ReadClient;

  constructor(opts: RepoReaderOptions) {
    this.historyEnabled = opts.allowHistory === true;
    const auth = opts.token.includes(":")
      ? `Basic ${Buffer.from(opts.token, "utf8").toString("base64")}`
      : `Bearer ${opts.token}`;
    this.http = new ReadClient({
      label: "bitbucket",
      baseUrl: opts.baseUrl ?? "https://api.bitbucket.org/2.0",
      token: opts.token,
      authHeaders: { authorization: auth, accept: "application/json" },
      opts,
    });
  }

  private async paged<T>(first: string, max: number, take: (item: T) => void, count: () => number): Promise<boolean> {
    let next: string | null = first;
    let pages = 0;
    while (next) {
      if (pages++ >= this.http.maxPages || count() >= max) return true;
      const page: { body: BbPage<T> } = await this.http.getJson<BbPage<T>>(next, hint);
      const body: BbPage<T> = page.body;
      for (const v of body.values ?? []) take(v);
      next = typeof body.next === "string" ? body.next : null;
    }
    return count() > max;
  }

  async listRepos(opts: ListReposOptions = {}): Promise<RepoListResult> {
    const max = clampLimit(opts.maxRepos, REPO_READ_DEFAULTS.maxRepos);
    const first = opts.namespace
      ? `/repositories/${encodeURIComponent(opts.namespace)}?pagelen=100`
      : "/repositories?role=member&pagelen=100";
    const repos: RepoListResult["repos"] = [];
    const truncated = await this.paged<{ full_name?: string; mainbranch?: { name?: string } | null }>(
      first,
      max,
      (r) => {
        if (typeof r.full_name === "string") {
          repos.push({ fullName: r.full_name, defaultBranch: r.mainbranch?.name ?? null, archived: false });
        }
      },
      () => repos.length,
    );
    return { repos: repos.slice(0, max), truncated };
  }

  private async tree(r: string, sha: string, opts: TreeOptions): Promise<{ entries: TreeEntry[]; truncated: boolean }> {
    const max = clampLimit(opts.maxTreeEntries, REPO_READ_DEFAULTS.maxTreeEntries);
    const entries: TreeEntry[] = [];
    let deepest = 0;
    const truncated = await this.paged<{ type?: string; path?: string; size?: number }>(
      `/repositories/${r}/src/${assertCommitSha(sha)}/?max_depth=${BITBUCKET_MAX_DEPTH}&pagelen=100`,
      max,
      (v) => {
        if (typeof v.path !== "string") return;
        deepest = Math.max(deepest, v.path.split("/").length);
        if (v.type === "commit_file") entries.push({ path: v.path, size: typeof v.size === "number" ? v.size : null });
      },
      () => entries.length,
    );
    return { entries: entries.slice(0, max), truncated: truncated || deepest > BITBUCKET_MAX_DEPTH };
  }

  async getTree(repo: string, opts: TreeOptions = {}): Promise<RepoTree> {
    const r = encodeRepo(repo, 2);
    const { body: meta } = await this.http.getJson<{ mainbranch?: { name?: string } | null }>(`/repositories/${r}`, hint);
    const branch = meta.mainbranch?.name ?? null;
    if (!branch) return { repo, ref: null, commitSha: "", author: null, entries: [], truncated: false };
    const { body: b } = await this.http.getJson<{ target?: BbCommit }>(
      `/repositories/${r}/refs/branches/${encodeURIComponent(branch)}`,
      hint,
    );
    const sha = b.target?.hash ?? "";
    const { entries, truncated } = await this.tree(r, sha, opts);
    return { repo, ref: branch, commitSha: sha, author: splitRawAuthor(b.target?.author?.raw), entries, truncated };
  }

  async readFile(repo: string, path: string, opts: ReadFileOptions): Promise<ReadFileResult> {
    const maxBytes = clampLimit(opts.maxBytes, REPO_READ_DEFAULTS.maxFileBytes, REPO_READ_DEFAULTS.maxFileBytesCeiling);
    const res = await this.http.get(
      `/repositories/${encodeRepo(repo, 2)}/src/${assertCommitSha(opts.commitSha)}/${encodeRepoPath(path)}`,
    );
    if (res.status === 404) return { status: "not_found" };
    if (res.status >= 400) await this.http.fail(res, hint);
    const declared = Number(this.http.header(res, "content-length") ?? "NaN");
    if (Number.isFinite(declared) && declared > maxBytes) return { status: "too_large", size: declared };
    const text = await res.text();
    const size = Buffer.byteLength(text);
    if (size > maxBytes) return { status: "too_large", size };
    if (looksBinary(text)) return { status: "binary", size };
    return { status: "ok", content: text, size };
  }

  async inspectCredential(): Promise<CredentialScopeReport> {
    const res = await this.http.getOk("/user", hint);
    const raw = this.http.header(res, "x-oauth-scopes");
    if (raw === null) {
      return { status: "unverified", scopes: [], detail: "Bitbucket did not report this credential's scopes; write scope unverified" };
    }
    const scopes = raw.split(",").map((s) => s.trim()).filter(Boolean);
    const write = scopes.filter((s) => s.endsWith(":write") || s.endsWith(":admin") || s.endsWith(":delete") || s === "repository:write" || s === "admin");
    return write.length > 0
      ? { status: "write_scope", scopes, detail: `the credential grants write scope(s): ${write.join(", ")}` }
      : { status: "read_only", scopes, detail: "credential scopes are read-only" };
  }

  async listCommits(repo: string, opts: ListCommitsOptions = {}): Promise<CommitSummary[]> {
    if (!this.historyEnabled) throw new HistoryScanDisabledError();
    const max = clampLimit(opts.maxCommits, REPO_READ_DEFAULTS.maxCommits);
    const ref = opts.ref ? `/${encodeURIComponent(opts.ref)}` : "";
    const out: CommitSummary[] = [];
    await this.paged<BbCommit>(
      `/repositories/${encodeRepo(repo, 2)}/commits${ref}?pagelen=100`,
      max,
      (c) => {
        if (typeof c.hash === "string") out.push({ sha: c.hash, author: splitRawAuthor(c.author?.raw), committedAt: c.date ?? null });
      },
      () => out.length,
    );
    return out.slice(0, max);
  }

  async getTreeAt(repo: string, commitSha: string, opts: TreeOptions = {}): Promise<RepoTree> {
    if (!this.historyEnabled) throw new HistoryScanDisabledError();
    const r = encodeRepo(repo, 2);
    const { body } = await this.http.getJson<BbCommit>(`/repositories/${r}/commit/${assertCommitSha(commitSha)}`, hint);
    const { entries, truncated } = await this.tree(r, commitSha, opts);
    return { repo, ref: null, commitSha, author: splitRawAuthor(body.author?.raw), entries, truncated };
  }
}
