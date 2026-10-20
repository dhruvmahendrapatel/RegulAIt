// ADR-0195 decisions 13-14: the READ-ONLY repository surface the repo scanner
// uses. It is deliberately a separate interface from `GitProvider` (which can
// create branches, open and merge PRs): a scanner holds a `RepoReader`, and a
// `RepoReader` has no method that can write. Every request it makes is a GET.

import type { GitProviderKind } from "../types.js";

/** the response shape the readers need; the global `Response` satisfies it */
export interface ReadResponse {
  status: number;
  headers?: { get(name: string): string | null };
  /** the streamed body (the global Response has one): lets a read stop at its byte cap */
  body?: ReadableStream<Uint8Array> | null;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

/**
 * The injected transport. It is REQUIRED (no default to the global fetch):
 * every outbound scanner call goes through the gateway's guarded fetch and the
 * egress allow list (ADR-0195 decision 8), and a reader built without one
 * cannot be constructed. Only GET is ever passed.
 */
export type ReadFetchLike = (
  url: string,
  init: { method: "GET" | "HEAD"; headers: Record<string, string> },
) => Promise<ReadResponse>;

export type RepoReaderKind = Exclude<GitProviderKind, "mock">;

export interface RepoSummary {
  /** the provider's repo address, the same string `getTree`/`readFile` take */
  fullName: string;
  /** branch name without refs/heads/; null for an empty repo */
  defaultBranch: string | null;
  archived: boolean;
}

export interface RepoListResult {
  repos: RepoSummary[];
  /** true when `maxRepos` or the page cap stopped the listing early */
  truncated: boolean;
}

/** the raw author of a commit, handed ONLY to the SD0 pseudonym hook (ADR-0195 rule 20) */
export interface RawCommitAuthor {
  name: string | null;
  email: string | null;
}

export interface TreeEntry {
  /** path from the repo root, `/`-separated, no leading slash */
  path: string;
  /** bytes when the provider reports it (GitHub, Bitbucket); null otherwise */
  size: number | null;
}

export interface RepoTree {
  repo: string;
  /** the branch the tree was read from (the default branch for `getTree`) */
  ref: string | null;
  commitSha: string;
  /** raw author of `commitSha`, when the provider returned it with the ref */
  author: RawCommitAuthor | null;
  /** files only (blobs); directories and submodules are left out */
  entries: TreeEntry[];
  /** true when the provider or `maxTreeEntries` cut the listing short */
  truncated: boolean;
}

export type ReadFileResult =
  | { status: "ok"; content: string; size: number }
  | { status: "too_large"; size: number | null }
  | { status: "binary"; size: number | null }
  | { status: "not_found" };

export interface CommitSummary {
  sha: string;
  author: RawCommitAuthor | null;
  committedAt: string | null;
}

/**
 * What the provider lets us learn about the credential's scopes (ADR-0195
 * decision 7): `write_scope` is refused by the caller; `unverified` is shown on
 * the source's posture row as "write scope unverified".
 */
export interface CredentialScopeReport {
  status: "read_only" | "write_scope" | "unverified";
  scopes: string[];
  detail: string;
}

export interface ListReposOptions {
  /** org / group / workspace / project to list; omitted = what the credential can see */
  namespace?: string;
  maxRepos?: number;
}

export interface TreeOptions {
  maxTreeEntries?: number;
}

export interface ReadFileOptions {
  /** the commit sha from `getTree` (never a moving branch name) */
  commitSha: string;
  maxBytes?: number;
}

export interface ListCommitsOptions {
  /** branch to walk; defaults to the repo's default branch */
  ref?: string;
  maxCommits?: number;
}

export interface RepoReader {
  readonly kind: RepoReaderKind;
  /** true only when the source was granted the history relaxation */
  readonly historyEnabled: boolean;
  listRepos(opts?: ListReposOptions): Promise<RepoListResult>;
  /** the default branch head: the only tree a scan reads unless history is enabled */
  getTree(repo: string, opts?: TreeOptions): Promise<RepoTree>;
  readFile(repo: string, path: string, opts: ReadFileOptions): Promise<ReadFileResult>;
  inspectCredential(): Promise<CredentialScopeReport>;
  /** HISTORY (relaxation, off by default): throws unless `allowHistory` was set */
  listCommits(repo: string, opts?: ListCommitsOptions): Promise<CommitSummary[]>;
  /** HISTORY (relaxation, off by default): the tree at an older commit */
  getTreeAt(repo: string, commitSha: string, opts?: TreeOptions): Promise<RepoTree>;
}

/**
 * ADR-0195 A5: what a reader's `token` is. `token` (the default): a provider token the admin stored.
 * `github_app_installation`: a GitHub App installation access token (GitHub only). `entra_access_token`: a Microsoft
 * Entra ID access token for Azure DevOps (Azure DevOps only). Both short-lived kinds are obtained per run by the caller.
 */
export type RepoCredentialKind = "token" | "github_app_installation" | "entra_access_token";

export interface RepoReaderOptions {
  token: string;
  /** ADR-0195 A5: defaults to `token`; a kind the provider does not take is refused by the reader */
  credentialKind?: RepoCredentialKind;
  baseUrl?: string;
  fetchImpl: ReadFetchLike;
  /**
   * ADR-0195 decision 14: scanning history is an admin relaxation (step-up,
   * gated by SD0). Off unless the caller passes true.
   */
  allowHistory?: boolean;
  /** 429 / rate-limit handling; defaults in `http.ts` */
  maxRetries?: number;
  /** the longest single wait honoured before giving up with a retry-after */
  maxWaitMs?: number;
  /** test seam for the backoff wait */
  sleep?: (ms: number) => Promise<void>;
  /** clock for X-RateLimit-Reset arithmetic (test seam) */
  now?: () => number;
  /** hard cap on pages followed by any one listing */
  maxPages?: number;
  /**
   * TEST SEAM ONLY: accept a plain-http API base (the package's fake upstream).
   * The gateway never sets it; without it a base that is not https is refused.
   */
  allowInsecureHttpForTests?: boolean;
}

export const REPO_READ_DEFAULTS = Object.freeze({
  maxRepos: 1_000,
  maxTreeEntries: 50_000,
  maxPages: 200,
  /** default per-file read cap */
  maxFileBytes: 512 * 1024,
  /** no caller can raise a single read above this */
  maxFileBytesCeiling: 2 * 1024 * 1024,
  maxCommits: 500,
  /** cap on any metadata (listing, tree, ref) JSON body; past it the read fails with a bounded error */
  maxMetadataBytes: 16 * 1024 * 1024,
  maxRetries: 4,
  maxWaitMs: 60_000,
  baseBackoffMs: 1_000,
});
