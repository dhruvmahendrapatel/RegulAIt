// Azure DevOps Repos read-only reader, REST 7.1. `baseUrl` is the
// organization URL (https://dev.azure.com/{organization}, or a Server
// collection URL); `repo` is "{project}/{repository}". A 203 with an HTML
// sign-in page is ADO's answer to a bad PAT and is raised as an auth error.

import {
  assertCommitSha,
  clampLimit,
  encodeRepoPath,
  HistoryScanDisabledError,
  ReadClient,
  readJsonCapped,
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
import { GitProviderError } from "../types.js";

const API = "api-version=7.1";

const hint = (status: number): string =>
  status === 401 || status === 403
    ? " (authentication failed: check the PAT is valid and has 'Code (Read)' scope)"
    : status === 404
      ? " (not found: baseUrl is the organization URL and repo is '<project>/<repository>')"
      : "";

const stripHeads = (ref: string | null | undefined): string | null =>
  ref ? (ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref) : null;

interface AdoRepo {
  name?: string;
  defaultBranch?: string;
  isDisabled?: boolean;
  project?: { name?: string };
}
interface AdoCommit {
  commitId?: string;
  author?: { name?: string; email?: string; date?: string };
}

export class AzureDevOpsRepoReader implements RepoReader {
  readonly kind = "azure_devops" as const;
  readonly historyEnabled: boolean;
  private readonly http: ReadClient;

  constructor(opts: RepoReaderOptions) {
    if (!opts.baseUrl) {
      throw new GitProviderError("azure_devops requires a baseUrl (the organization URL, e.g. https://dev.azure.com/<organization>)");
    }
    this.historyEnabled = opts.allowHistory === true;
    this.http = new ReadClient({
      label: "azure_devops",
      baseUrl: opts.baseUrl,
      token: opts.token,
      authHeaders: { authorization: `Basic ${Buffer.from(`:${opts.token}`, "utf8").toString("base64")}`, accept: "application/json" },
      opts,
    });
  }

  private async json<T>(path: string): Promise<{ body: T; res: ReadResponse }> {
    const res = await this.http.getOk(path, hint);
    if (res.status === 203) throw new GitProviderError("azure_devops GET failed (HTTP 203: sign-in page)" + hint(401), 401);
    return { body: await this.http.metadataJson<T>(res), res };
  }

  private repoPath(repo: string): string {
    const [project, ...rest] = repoSegments(repo, 2);
    return `/${encodeURIComponent(project!)}/_apis/git/repositories/${encodeURIComponent(rest.join("/"))}`;
  }

  async listRepos(opts: ListReposOptions = {}): Promise<RepoListResult> {
    const max = clampLimit(opts.maxRepos, REPO_READ_DEFAULTS.maxRepos);
    const scope = opts.namespace ? `/${encodeURIComponent(opts.namespace)}` : "";
    const repos: RepoListResult["repos"] = [];
    let token: string | null = null;
    let pages = 0;
    do {
      if (pages++ >= this.http.maxPages || repos.length >= max) return { repos: repos.slice(0, max), truncated: true };
      const cont: string = token ? `&continuationToken=${encodeURIComponent(token)}` : "";
      const { body, res } = await this.json<{ value?: AdoRepo[] }>(`${scope}/_apis/git/repositories?${API}${cont}`);
      for (const r of body.value ?? []) {
        if (typeof r.name !== "string" || typeof r.project?.name !== "string") continue;
        repos.push({ fullName: `${r.project.name}/${r.name}`, defaultBranch: stripHeads(r.defaultBranch), archived: r.isDisabled === true });
      }
      token = this.http.header(res, "x-ms-continuationtoken");
    } while (token);
    return { repos: repos.slice(0, max), truncated: repos.length > max };
  }

  private async tree(repo: string, sha: string, opts: TreeOptions): Promise<{ entries: TreeEntry[]; truncated: boolean }> {
    const max = clampLimit(opts.maxTreeEntries, REPO_READ_DEFAULTS.maxTreeEntries);
    const { body } = await this.json<{ value?: { path?: string; isFolder?: boolean; gitObjectType?: string; size?: number }[] }>(
      `${this.repoPath(repo)}/items?scopePath=%2F&recursionLevel=Full&versionDescriptor.version=${assertCommitSha(sha)}&versionDescriptor.versionType=commit&${API}`,
    );
    const entries: TreeEntry[] = [];
    for (const v of body.value ?? []) {
      if (v.isFolder || typeof v.path !== "string" || (v.gitObjectType && v.gitObjectType !== "blob")) continue;
      const path = v.path.startsWith("/") ? v.path.slice(1) : v.path;
      if (path) entries.push({ path, size: typeof v.size === "number" ? v.size : null });
    }
    return { entries: entries.slice(0, max), truncated: entries.length > max };
  }

  private async headCommit(repo: string, branch: string): Promise<AdoCommit | null> {
    const { body } = await this.json<{ value?: AdoCommit[] }>(
      `${this.repoPath(repo)}/commits?searchCriteria.itemVersion.version=${encodeURIComponent(branch)}&searchCriteria.$top=1&${API}`,
    );
    return body.value?.[0] ?? null;
  }

  async getTree(repo: string, opts: TreeOptions = {}): Promise<RepoTree> {
    const { body: meta } = await this.json<AdoRepo>(`${this.repoPath(repo)}?${API}`);
    const branch = stripHeads(meta.defaultBranch);
    if (!branch) return { repo, ref: null, commitSha: "", author: null, entries: [], truncated: false };
    const head = await this.headCommit(repo, branch);
    const sha = head?.commitId ?? "";
    if (!sha) return { repo, ref: branch, commitSha: "", author: null, entries: [], truncated: false };
    const { entries, truncated } = await this.tree(repo, sha, opts);
    return {
      repo,
      ref: branch,
      commitSha: sha,
      author: head?.author ? { name: head.author.name ?? null, email: head.author.email ?? null } : null,
      entries,
      truncated,
    };
  }

  async readFile(repo: string, path: string, opts: ReadFileOptions): Promise<ReadFileResult> {
    const maxBytes = clampLimit(opts.maxBytes, REPO_READ_DEFAULTS.maxFileBytes, REPO_READ_DEFAULTS.maxFileBytesCeiling);
    const filePath = encodeURIComponent(`/${decodeURIComponent(encodeRepoPath(path))}`);
    const res = await this.http.get(
      `${this.repoPath(repo)}/items?path=${filePath}&versionDescriptor.version=${assertCommitSha(opts.commitSha)}&versionDescriptor.versionType=commit&includeContent=true&$format=json&${API}`,
    );
    if (res.status === 404) return { status: "not_found" };
    if (res.status === 203) throw new GitProviderError("azure_devops GET failed (HTTP 203: sign-in page)" + hint(401), 401);
    if (res.status >= 400) await this.http.fail(res, hint);
    // JSON-escaped content can grow up to 6x (\uXXXX); the envelope is read under a cap, never in full
    const capped = await readJsonCapped<{ content?: string; contentMetadata?: { isBinary?: boolean }; size?: number }>(res, maxBytes * 6 + 16_384);
    if (capped.tooLarge || !capped.body) return { status: "too_large", size: null };
    const body = capped.body;
    const size = typeof body.size === "number" ? body.size : null;
    if (size !== null && size > maxBytes) return { status: "too_large", size };
    if (body.contentMetadata?.isBinary) return { status: "binary", size };
    if (typeof body.content !== "string") return { status: "binary", size };
    const bytes = Buffer.byteLength(body.content);
    if (bytes > maxBytes) return { status: "too_large", size: size ?? bytes };
    if (body.content.includes("\u0000")) return { status: "binary", size };
    return { status: "ok", content: body.content, size: size ?? bytes };
  }

  async inspectCredential(): Promise<CredentialScopeReport> {
    return {
      status: "unverified",
      scopes: [],
      detail: "Azure DevOps does not let a PAT read its own scopes; write scope unverified (issue the PAT with 'Code (Read)' only)",
    };
  }

  async listCommits(repo: string, opts: ListCommitsOptions = {}): Promise<CommitSummary[]> {
    if (!this.historyEnabled) throw new HistoryScanDisabledError();
    const max = clampLimit(opts.maxCommits, REPO_READ_DEFAULTS.maxCommits, 10_000);
    const ref = opts.ref ? `searchCriteria.itemVersion.version=${encodeURIComponent(opts.ref)}&` : "";
    const { body } = await this.json<{ value?: AdoCommit[] }>(
      `${this.repoPath(repo)}/commits?${ref}searchCriteria.$top=${max}&${API}`,
    );
    return (body.value ?? [])
      .filter((c): c is AdoCommit & { commitId: string } => typeof c.commitId === "string")
      .slice(0, max)
      .map((c) => ({
        sha: c.commitId,
        author: c.author ? { name: c.author.name ?? null, email: c.author.email ?? null } : null,
        committedAt: c.author?.date ?? null,
      }));
  }

  async getTreeAt(repo: string, commitSha: string, opts: TreeOptions = {}): Promise<RepoTree> {
    if (!this.historyEnabled) throw new HistoryScanDisabledError();
    const { body } = await this.json<AdoCommit>(`${this.repoPath(repo)}/commits/${assertCommitSha(commitSha)}?${API}`);
    const { entries, truncated } = await this.tree(repo, commitSha, opts);
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
