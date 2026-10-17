/**
 * ADR-0195 SD1 — THE REPO SCANNERS (`repo_github`, `repo_gitlab`,
 * `repo_bitbucket`, `repo_azure_devops`), registered in `DISCOVERY_SCANNERS`.
 *
 * Thin wiring: source config → `@regulait/git-provider` read-only readers →
 * the pure `analyseRepo` (packages/shared) → SD0 observations. Nothing here
 * classifies, scores or writes a finding: the worker matches every observation
 * against the enabled admin catalogue (detection is data, decision 5).
 *
 * SOURCE TARGET (key = value, set on the source; changing it on an enabled
 * source is SD0's enable step-up, so every key below is bound to it):
 *   namespace    org / group / workspace / project to list when the scope is
 *                organisation-level (omitted: what the token can see)
 *   baseUrl      the API base for self-hosted or Azure DevOps (required there)
 *   history      "true" scans commit history too (decision 14: an admin
 *                relaxation, off by default; enabling it means a target change,
 *                which is the step-up)
 *   historyDepth commits per repo when history is on (default 20, at most 200)
 * The scope's `include` names repos (`owner/name`); an org-level scope lists them.
 *
 * WHAT IT USES OF THE CONTEXT: `ctx.fetch` only (the egress-guarded fetch);
 * `ctx.throttle()` before every request and `ctx.backoff(res)` on 429/503;
 * `ctx.recordRaw()` with each file read (digested, never kept);
 * `ctx.pseudonymise("commit_author", …)` for every commit author; and
 * `ctx.heartbeat()` before each repo and history commit.
 *
 * WHAT IT DROPS, because an SD0 observation has no field for it: the file
 * path, line and commit of a sighting, `.env.example` variable names, and the
 * launch command of a stdio MCP server. The run's raw-output digest covers
 * what was read.
 */
import {
  EVIDENCE_MAX_ROWS,
  SHADOW_AI_CATALOG_V2,
  analyseRepo,
  type ArtifactSignatureKind,
  type DiscoveryPseudonymKind,
  type DiscoverySourceKind,
  type RepoAnalysisResult,
  type RepoAuthorInput,
  type RepoFileRead,
} from "@regulait/shared";
import {
  GitProviderRateLimitError,
  HistoryScanDisabledError,
  resolveRepoReader,
  type ReadFetchLike,
  type RepoReader,
  type RepoReaderKind,
  type RepoTree,
} from "@regulait/git-provider";

/**
 * The slice of SD0's `ScanContext` / `ScanObservation` / `Scanner` this module
 * uses, declared structurally so it does not import `discovery-scanners.ts`
 * (which imports this module to register it: no import cycle).
 */
export interface RepoScanContext {
  source: {
    id: string;
    name: string;
    kind: DiscoverySourceKind;
    target: Readonly<Record<string, string>>;
    scope: Readonly<{ orgLevel: boolean; include: readonly string[] }>;
  };
  credential: { mode: "federated" | "static"; publicConfig: Readonly<Record<string, string>>; secret: string | null } | null;
  fetch: typeof fetch;
  throttle: () => Promise<void>;
  backoff: (res: Response) => Promise<boolean>;
  recordRaw: (chunk: string | Uint8Array) => void;
  pseudonymise: (kind: DiscoveryPseudonymKind, displayName: string) => Promise<string>;
  heartbeat: () => Promise<boolean>;
  signal: AbortSignal;
}

export interface RepoScanObservation {
  evidenceKind: "repo_scan";
  subjectKind: "repo";
  subject: string;
  count?: number;
  host?: string;
  packageName?: string;
  keyFragment?: string;
  keyLength?: number;
  artifact?: { kind: ArtifactSignatureKind; value: string };
}

export interface RepoScanResult {
  observations: RepoScanObservation[];
  credentialWriteScope?: "read_only" | "write" | "unverified";
}

export interface RepoScanner {
  kind: DiscoverySourceKind;
  requiresCredential: boolean;
  run: (ctx: RepoScanContext) => Promise<RepoScanResult>;
}

export const REPO_SCANNER_KINDS = ["repo_github", "repo_gitlab", "repo_bitbucket", "repo_azure_devops"] as const;
type RepoScannerKind = (typeof REPO_SCANNER_KINDS)[number];

const PROVIDER_OF: Readonly<Record<RepoScannerKind, RepoReaderKind>> = {
  repo_github: "github",
  repo_gitlab: "gitlab",
  repo_bitbucket: "bitbucket",
  repo_azure_devops: "azure_devops",
};

export const REPO_SCAN_LIMITS = Object.freeze({
  maxRepos: 1_000,
  historyDepthDefault: 20,
  historyDepthMax: 200,
});

/** a stable, bounded error a run fails with; never carries the token (the readers scrub it) */
export class RepoScanError extends Error {
  constructor(
    readonly code: "rate_limited" | "lease_lost" | "credential_unusable" | "target_invalid",
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "RepoScanError";
  }
}

const ASSISTANT_PATTERN_BY_ID: ReadonlyMap<string, string> = new Map(
  SHADOW_AI_CATALOG_V2.filter((e) => e.kind === "assistant_config").map((e) => [e.id, e.pattern]),
);

/** the commit author as SD0 pseudonymises it: email when present (stable), else the name */
const authorDisplayName = (a: RepoAuthorInput): string | null => {
  const email = a.email?.trim().toLowerCase();
  if (email) return email.slice(0, 320);
  const name = a.name?.trim();
  return name ? name.slice(0, 200) : null;
};

/**
 * Map one analysed tree onto SD0 observations, merging duplicates into a count.
 * Exported for tests.
 */
export function toScanObservations(subject: string, analysis: RepoAnalysisResult): RepoScanObservation[] {
  const merged = new Map<string, RepoScanObservation>();
  const add = (o: Omit<RepoScanObservation, "evidenceKind" | "subjectKind" | "subject">) => {
    const key = JSON.stringify([o.host ?? "", o.packageName ?? "", o.keyFragment ?? "", o.keyLength ?? "", o.artifact?.kind ?? "", o.artifact?.value ?? ""]);
    const prev = merged.get(key);
    if (prev) {
      prev.count = (prev.count ?? 1) + 1;
      return;
    }
    merged.set(key, { evidenceKind: "repo_scan", subjectKind: "repo", subject, count: 1, ...o });
  };
  for (const o of analysis.observations) {
    switch (o.kind) {
      case "dependency":
      case "source_import":
        if (o.packageName) add({ packageName: o.packageName });
        break;
      case "endpoint_reference":
        if (o.host) add({ host: o.host });
        break;
      case "mcp_server":
        // a remote MCP server is a host; a stdio server's command has no SD0 field
        if (o.mcpServer?.host) add({ host: o.mcpServer.host });
        break;
      case "ai_key":
        if (o.key) add({ keyFragment: o.key.fragment, keyLength: o.key.length });
        break;
      case "assistant_config": {
        // the matched catalogue pattern is the identifier the seed rows carry
        const value = (o.catalogEntryId && ASSISTANT_PATTERN_BY_ID.get(o.catalogEntryId)) || o.path;
        add({ artifact: { kind: "assistant_config", value } });
        break;
      }
      case "ide_extension":
        if (o.extensionId) add({ artifact: { kind: "ide_extension", value: o.extensionId } });
        break;
      case "env_var_name":
        break;
    }
  }
  return [...merged.values()];
}

/** the injected transport: throttle every request, defer 429/503 waits to SD0's backoff */
function scanFetch(ctx: RepoScanContext): ReadFetchLike {
  return async (url, init) => {
    for (;;) {
      await ctx.throttle();
      const res = await ctx.fetch(url, { method: init.method, headers: init.headers, signal: ctx.signal });
      if ((res.status === 429 || res.status === 503) && (await ctx.backoff(res))) continue;
      return res;
    }
  };
}

function historyDepth(target: Readonly<Record<string, string>>): number {
  const raw = target.historyDepth;
  if (raw === undefined) return REPO_SCAN_LIMITS.historyDepthDefault;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new RepoScanError("target_invalid", "historyDepth must be a whole number of commits");
  return Math.min(n, REPO_SCAN_LIMITS.historyDepthMax);
}

async function analyseTree(ctx: RepoScanContext, reader: RepoReader, repo: string, tree: RepoTree): Promise<RepoAnalysisResult> {
  return analyseRepo({
    repo,
    commitSha: tree.commitSha,
    entries: tree.entries,
    readFile: async (path, maxBytes): Promise<RepoFileRead> => {
      const r = await reader.readFile(repo, path, { commitSha: tree.commitSha, maxBytes });
      if (r.status === "ok") {
        ctx.recordRaw(r.content);
        return { status: "ok", content: r.content };
      }
      return { status: r.status };
    },
    author: tree.author,
    pseudonymiseAuthor: async (a) => {
      const display = authorDisplayName(a);
      return display ? ctx.pseudonymise("commit_author", display) : "";
    },
  });
}

async function alive(ctx: RepoScanContext): Promise<void> {
  if (ctx.signal.aborted) throw new RepoScanError("lease_lost", "the run's time is up");
  if (!(await ctx.heartbeat())) throw new RepoScanError("lease_lost", "the run's lease was lost; another worker owns it");
}

export function repoScanner(kind: RepoScannerKind, deps: { resolveReader?: typeof resolveRepoReader } = {}): RepoScanner {
  const resolve = deps.resolveReader ?? resolveRepoReader;
  return {
    kind,
    requiresCredential: true,
    run: async (ctx) => {
      const token = ctx.credential?.secret ?? null;
      if (!token) {
        throw new RepoScanError(
          "credential_unusable",
          "a repo source needs a static read-only token; federated git credentials are not supported by the repo scanner yet",
        );
      }
      const target = ctx.source.target;
      const history = target.history === "true";
      const depth = history ? historyDepth(target) : 0;
      const reader = resolve(PROVIDER_OF[kind], {
        token,
        ...(target.baseUrl ? { baseUrl: target.baseUrl } : {}),
        fetchImpl: scanFetch(ctx),
        allowHistory: history,
        // 429/503 waits are SD0's (ctx.backoff); a limit still hit after them fails the run
        maxRetries: 0,
      });

      try {
        const scope = await reader.inspectCredential();
        if (scope.status === "write_scope") return { observations: [], credentialWriteScope: "write" };

        let repos: string[];
        if (ctx.source.scope.orgLevel) {
          const listed = await reader.listRepos({
            ...(target.namespace ? { namespace: target.namespace } : {}),
            maxRepos: REPO_SCAN_LIMITS.maxRepos,
          });
          repos = listed.repos.filter((r) => !r.archived && r.defaultBranch !== null).map((r) => r.fullName);
        } else {
          repos = ctx.source.scope.include.map((r) => r.trim()).filter(Boolean).slice(0, REPO_SCAN_LIMITS.maxRepos);
        }

        const out: RepoScanObservation[] = [];
        const subjectPrefix = PROVIDER_OF[kind];
        for (const repo of repos) {
          if (out.length >= EVIDENCE_MAX_ROWS) break;
          await alive(ctx);
          const subject = `${subjectPrefix}:${repo}`;
          const tree = await reader.getTree(repo);
          if (!tree.commitSha) continue;
          out.push(...toScanObservations(subject, await analyseTree(ctx, reader, repo, tree)));

          if (history) {
            const commits = await reader.listCommits(repo, { ...(tree.ref ? { ref: tree.ref } : {}), maxCommits: depth });
            for (const c of commits) {
              if (c.sha === tree.commitSha || out.length >= EVIDENCE_MAX_ROWS) continue;
              await alive(ctx);
              const old = await reader.getTreeAt(repo, c.sha);
              out.push(...toScanObservations(subject, await analyseTree(ctx, reader, repo, { ...old, author: c.author ?? old.author })));
            }
          }
        }
        return {
          observations: mergeAcrossTrees(out).slice(0, EVIDENCE_MAX_ROWS),
          credentialWriteScope: scope.status === "read_only" ? "read_only" : "unverified",
        };
      } catch (err) {
        if (err instanceof GitProviderRateLimitError) {
          const after = err.retryAfterMs === null ? "" : ` (the provider asked for ${Math.ceil(err.retryAfterMs / 1000)} s)`;
          throw new RepoScanError("rate_limited", `the git provider is still rate-limiting after the back-off${after}; the next scheduled run retries`);
        }
        if (err instanceof HistoryScanDisabledError) throw new RepoScanError("target_invalid", err.message);
        throw err;
      }
    },
  };
}

/** the same sighting in several trees (history) is one observation with a summed count */
function mergeAcrossTrees(obs: RepoScanObservation[]): RepoScanObservation[] {
  const m = new Map<string, RepoScanObservation>();
  for (const o of obs) {
    const key = JSON.stringify([o.subject, o.host ?? "", o.packageName ?? "", o.keyFragment ?? "", o.keyLength ?? "", o.artifact?.kind ?? "", o.artifact?.value ?? ""]);
    const prev = m.get(key);
    if (prev) prev.count = (prev.count ?? 1) + (o.count ?? 1);
    else m.set(key, { ...o });
  }
  return [...m.values()];
}

/** the four production repo scanners */
export const REPO_SCANNERS: readonly RepoScanner[] = REPO_SCANNER_KINDS.map((k) => repoScanner(k));
