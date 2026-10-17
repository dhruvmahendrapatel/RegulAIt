// ADR-0195 SD1: the read-only repo readers, one per git provider.

import { GitProviderError } from "../types.js";
import { AzureDevOpsRepoReader } from "./azure-devops.js";
import { BitbucketRepoReader } from "./bitbucket.js";
import { GitHubRepoReader } from "./github.js";
import { GitLabRepoReader } from "./gitlab.js";
import type { RepoReader, RepoReaderKind, RepoReaderOptions } from "./types.js";

export * from "./types.js";
export {
  GitProviderRateLimitError,
  HistoryScanDisabledError,
  nextLinkFromHeader,
  parseRetryAfterMs,
} from "./http.js";
export { GitHubRepoReader, GitLabRepoReader, BitbucketRepoReader, AzureDevOpsRepoReader };

export const REPO_READER_KINDS: ReadonlyArray<RepoReaderKind> = Object.freeze([
  "github",
  "gitlab",
  "bitbucket",
  "azure_devops",
]);

/** build the reader for a source; `fetchImpl` must be the gateway's guarded fetch */
export function resolveRepoReader(kind: string, opts: RepoReaderOptions): RepoReader {
  switch (kind) {
    case "github":
      return new GitHubRepoReader(opts);
    case "gitlab":
      return new GitLabRepoReader(opts);
    case "bitbucket":
      return new BitbucketRepoReader(opts);
    case "azure_devops":
      return new AzureDevOpsRepoReader(opts);
    default:
      throw new GitProviderError(`no repo reader for git provider kind '${kind.slice(0, 40)}'`, 400);
  }
}
