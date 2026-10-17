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
 * CREDENTIALS: a static read-only token only. A federated credential is
 * refused (`credential_unusable`) until git-provider federation exists.
 *
 * WHAT IT USES OF THE CONTEXT: `ctx.fetch` only (the egress-guarded fetch);
 * `ctx.throttle()` before every request and `ctx.backoff(res)` on 429/503;
 * `ctx.recordRaw()` with each file read (digested, never kept);
 * `ctx.pseudonymise("commit_author", …)` for the author of each commit read;
 * `ctx.heartbeat()` before each repo and history commit; and
 * `ctx.catalogue.matches()` to keep sightings only an admin-added row knows.
 *
 * WHAT EACH OBSERVATION CARRIES (decision 6): the matchable value (package,
 * host, key prefix and length, or artifact), its location (path, line, commit),
 * NAMES only where they apply (a stdio MCP server's command basename,
 * `.env.example` variable names), and `actorPseudonym`: the pseudonym of the
 * author of the commit the tree was read at. That is the commit's author, not
 * a per-line blame.
 */
import {
  EVIDENCE_MAX_ROWS,
  SHADOW_AI_CATALOG_V2,
  analyseRepo,
  type ArtifactSignatureKind,
  type DiscoveryPseudonymKind,
  type DiscoveryReadOutcome,
  type DiscoverySourceKind,
  type RepoAnalysisResult,
  type RepoAuthorInput,
  type RepoFileRead,
  type RepoObservationKind,
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
 * The parts of SD0's `ScanContext` / `ScanObservation` / `Scanner` this module
 * uses, declared structurally so it does not import `discovery-scanners.ts`
 * (which imports this module to register it: no import cycle).
 */
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
  location?: { path: string; line?: number; commit?: string };
  names?: string[];
  actorPseudonym?: string;
}

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
  registerSecret: (value: string) => void;
  recordRaw: (chunk: string | Uint8Array) => void;
  pseudonymise: (kind: DiscoveryPseudonymKind, displayName: string) => Promise<string>;
  heartbeat: () => Promise<boolean>;
  signal: AbortSignal;
  catalogue: { matches: (observation: RepoScanObservation) => boolean };
}

export interface RepoScanResult {
  observations: RepoScanObservation[];
  credentialWriteScope?: "read_only" | "write" | "unverified";
  readOutcomes?: DiscoveryReadOutcome[];
}

export interface RepoScanner {
  kind: DiscoverySourceKind;
  requiresCredential: boolean;
  run: (ctx: RepoScanContext) => Promise<RepoScanResult>;
  validateTarget: (target: Readonly<Record<string, string>>, scope: Readonly<{ orgLevel: boolean; include: readonly string[] }>) => string | null;
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
  /** SD0's location.path bound */
  pathMax: 512,
  /** SD0's names bounds */
  namesMax: 50,
  readOutcomesMax: 100,
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

/** SD0's name rule: a letter or `_`, then up to 127 of `[A-Za-z0-9_.-]` (checked without a regex) */
export function isScanName(n: string): boolean {
  if (n.length < 1 || n.length > 128) return false;
  const first = n[0]!;
  if (!((first >= "A" && first <= "Z") || (first >= "a" && first <= "z") || first === "_")) return false;
  for (const c of n) {
    const ok = (c >= "A" && c <= "Z") || (c >= "a" && c <= "z") || (c >= "0" && c <= "9") || c === "_" || c === "." || c === "-";
    if (!ok) return false;
  }
  return true;
}

/** the commit author as SD0 pseudonymises it: email when present (stable), else the name */
const authorDisplayName = (a: RepoAuthorInput): string | null => {
  const email = a.email?.trim().toLowerCase();
  if (email) return email.slice(0, 320);
  const name = a.name?.trim();
  return name ? name.slice(0, 200) : null;
};

const isCommit = (sha: string) => sha.length >= 7 && sha.length <= 64 && [...sha].every((c) => "0123456789abcdef".includes(c));

/** the value fields an observation is matched on (location, names and actor excluded) */
const valueKey = (o: RepoScanObservation) =>
  JSON.stringify([o.host ?? "", o.packageName ?? "", o.keyFragment ?? "", o.keyLength ?? "", o.artifact?.kind ?? "", o.artifact?.value ?? ""]);

/**
 * Map one analysed tree onto SD0 observations: one per distinct value and
 * location, duplicates merged into a count. Exported for tests.
 */
export function toScanObservations(subject: string, analysis: RepoAnalysisResult, actorPseudonym: string | null): RepoScanObservation[] {
  const merged = new Map<string, RepoScanObservation>();
  const commit = isCommit(analysis.commitSha.toLowerCase()) ? analysis.commitSha.toLowerCase() : null;
  const envNamesByPath = new Map<string, Set<string>>();
  const add = (
    o: Pick<RepoScanObservation, "host" | "packageName" | "keyFragment" | "keyLength" | "artifact" | "names">,
    path: string,
    line: number | null,
  ) => {
    const location: RepoScanObservation["location"] =
      path.length > 0 && path.length <= REPO_SCAN_LIMITS.pathMax
        ? { path, ...(line !== null && line >= 1 ? { line } : {}), ...(commit ? { commit } : {}) }
        : undefined;
    const full: RepoScanObservation = {
      evidenceKind: "repo_scan",
      subjectKind: "repo",
      subject,
      count: 1,
      ...o,
      ...(location ? { location } : {}),
      ...(actorPseudonym ? { actorPseudonym } : {}),
    };
    const key = JSON.stringify([valueKey(full), path, line ?? "", (o.names ?? []).join(",")]);
    const prev = merged.get(key);
    if (prev) prev.count = (prev.count ?? 1) + 1;
    else merged.set(key, full);
  };
  for (const o of analysis.observations) {
    switch (o.kind) {
      case "dependency":
      case "source_import":
        if (o.packageName) add({ packageName: o.packageName }, o.path, o.line);
        break;
      case "endpoint_reference":
        if (o.host) add({ host: o.host }, o.path, o.line);
        break;
      case "mcp_server": {
        const value = (o.catalogEntryId && ASSISTANT_PATTERN_BY_ID.get(o.catalogEntryId)) || o.path;
        const cmd = o.mcpServer?.command && isScanName(o.mcpServer.command) ? [o.mcpServer.command] : undefined;
        if (o.mcpServer?.host) add({ host: o.mcpServer.host }, o.path, o.line);
        // a stdio server: the config file's artifact, with the command basename as a NAME
        else if (cmd) add({ artifact: { kind: "assistant_config", value }, names: cmd }, o.path, o.line);
        break;
      }
      case "ai_key":
        if (o.key) add({ keyFragment: o.key.fragment, keyLength: o.key.length }, o.path, o.line);
        break;
      case "assistant_config": {
        // the matched catalogue pattern is the identifier the seed rows carry
        const value = (o.catalogEntryId && ASSISTANT_PATTERN_BY_ID.get(o.catalogEntryId)) || o.path;
        add({ artifact: { kind: "assistant_config", value } }, o.path, o.line);
        break;
      }
      case "ide_extension":
        if (o.extensionId) add({ artifact: { kind: "ide_extension", value: o.extensionId } }, o.path, o.line);
        break;
      case "env_var_name":
        if (o.envVarName && isScanName(o.envVarName)) {
          const set = envNamesByPath.get(o.path) ?? new Set<string>();
          set.add(o.envVarName);
          envNamesByPath.set(o.path, set);
        }
        break;
    }
  }
  // `.env.example` names: one observation per file, NAMES only (values are never read)
  for (const [path, names] of envNamesByPath) {
    add({ names: [...names].slice(0, REPO_SCAN_LIMITS.namesMax) }, path, null);
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

/** the target keys a repo source accepts; anything else is refused (secure by default) */
export const REPO_TARGET_KEYS = ["namespace", "baseUrl", "history", "historyDepth"] as const;

const NAMESPACE_OK = (v: string) =>
  v.length >= 1 &&
  v.length <= 200 &&
  [...v].every((c) => (c >= "A" && c <= "Z") || (c >= "a" && c <= "z") || (c >= "0" && c <= "9") || c === "-" || c === "_" || c === "." || c === "/" || c === " ") &&
  !v.split("/").some((seg) => seg === "" || seg === "." || seg === "..");

/**
 * Shape-check a repo source's target. Null when every key is known and well
 * formed; otherwise the problem. `baseUrl` is an https URL with no
 * credentials, query or fragment (the egress allow list still decides whether
 * its host may be reached); Azure DevOps needs one (its organisation URL).
 */
export function repoTargetProblem(kind: string, target: Readonly<Record<string, string>>): string | null {
  for (const key of Object.keys(target)) {
    if (!(REPO_TARGET_KEYS as readonly string[]).includes(key)) {
      return `'${key.slice(0, 40)}' is not a repo source target key (allowed: ${REPO_TARGET_KEYS.join(", ")})`;
    }
  }
  const { namespace, baseUrl, history, historyDepth } = target;
  if (namespace !== undefined && !NAMESPACE_OK(namespace)) return "namespace must be 1 to 200 characters of letters, digits, space, '-', '_', '.' or '/'";
  if (baseUrl !== undefined) {
    let u: URL;
    try {
      u = new URL(baseUrl);
    } catch {
      return "baseUrl is not a URL";
    }
    if (u.protocol !== "https:" || u.username !== "" || u.password !== "" || u.search !== "" || u.hash !== "" || baseUrl.length > 1024) {
      return "baseUrl must be an https URL with no credentials, query or fragment";
    }
  } else if (kind === "repo_azure_devops") {
    return "an Azure DevOps source needs baseUrl (the organisation URL)";
  }
  if (history !== undefined && history !== "true" && history !== "false") return "history must be 'true' or 'false'";
  if (historyDepth !== undefined) {
    const n = Number(historyDepth);
    if (!/^[0-9]{1,3}$/.test(historyDepth) || n < 1 || n > REPO_SCAN_LIMITS.historyDepthMax) {
      return `historyDepth must be a whole number from 1 to ${REPO_SCAN_LIMITS.historyDepthMax}`;
    }
  }
  return null;
}

/** how many path segments a repo address has, per provider: GitHub/Bitbucket owner/name, ADO project/repo, GitLab group(s)/project */
const REPO_SEGMENTS: Readonly<Record<RepoScannerKind, readonly [number, number]>> = {
  repo_github: [2, 2],
  repo_bitbucket: [2, 2],
  repo_azure_devops: [2, 2],
  repo_gitlab: [2, 21],
};

const SEGMENT_OK = (seg: string) =>
  seg.length >= 1 &&
  seg.length <= 200 &&
  seg !== "." &&
  seg !== ".." &&
  [...seg].every((c) => (c >= "A" && c <= "Z") || (c >= "a" && c <= "z") || (c >= "0" && c <= "9") || c === "-" || c === "_" || c === "." || c === " ");

/** each named repo in a non-org-level scope must be a well-formed address for its provider */
export function repoScopeProblem(kind: string, scope: Readonly<{ orgLevel: boolean; include: readonly string[] }>): string | null {
  if (scope.orgLevel) return null;
  const bounds = REPO_SEGMENTS[kind as RepoScannerKind];
  if (!bounds) return null;
  if (scope.include.length === 0) return "a repo-level scope names at least one repository";
  for (const raw of scope.include) {
    const segs = raw.trim().split("/");
    if (segs.length < bounds[0] || segs.length > bounds[1] || !segs.every(SEGMENT_OK)) {
      const shape = kind === "repo_gitlab" ? "group/project (subgroups allowed)" : kind === "repo_azure_devops" ? "project/repository" : "owner/name";
      return `scope entry '${raw.slice(0, 80)}' is not a ${shape} repository address`;
    }
  }
  return null;
}

function historyDepth(target: Readonly<Record<string, string>>): number {
  const raw = target.historyDepth;
  return raw === undefined ? REPO_SCAN_LIMITS.historyDepthDefault : Number(raw);
}

/** an analyser `alsoKeep` that asks the admin catalogue (read-only) about a value the compiled one does not know */
function adminKeep(ctx: RepoScanContext, subject: string): (o: { kind: RepoObservationKind; value: string }) => boolean {
  const base = { evidenceKind: "repo_scan" as const, subjectKind: "repo" as const, subject };
  return ({ kind, value }) => {
    switch (kind) {
      case "dependency":
      case "source_import":
        return ctx.catalogue.matches({ ...base, packageName: value });
      case "endpoint_reference":
        return ctx.catalogue.matches({ ...base, host: value });
      case "ide_extension":
        return ctx.catalogue.matches({ ...base, artifact: { kind: "ide_extension", value } });
      default:
        return false;
    }
  };
}

async function analyseTree(
  ctx: RepoScanContext,
  reader: RepoReader,
  repo: string,
  subject: string,
  tree: RepoTree,
): Promise<{ analysis: RepoAnalysisResult; actor: string | null }> {
  let actor: string | null = null;
  const analysis = await analyseRepo({
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
      actor = display ? await ctx.pseudonymise("commit_author", display) : null;
      return actor ?? "";
    },
    alsoKeep: adminKeep(ctx, subject),
  });
  return { analysis, actor };
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
    validateTarget: (target, scope) => repoTargetProblem(kind, target) ?? repoScopeProblem(kind, scope),
    run: async (ctx) => {
      const token = ctx.credential?.mode === "static" ? ctx.credential.secret : null;
      if (!token) {
        throw new RepoScanError(
          "credential_unusable",
          "a repo source needs a static read-only token; federated git credentials are not supported by the repo scanner yet",
        );
      }
      const target = ctx.source.target;
      const problem = repoTargetProblem(kind, target) ?? repoScopeProblem(kind, ctx.source.scope);
      if (problem) throw new RepoScanError("target_invalid", problem);
      // the auth header forms derived from the token (Basic base64) are secrets too: scrub them from any stored text
      ctx.registerSecret(Buffer.from(token, "utf8").toString("base64"));
      ctx.registerSecret(Buffer.from(`:${token}`, "utf8").toString("base64"));
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
      const outcomes: DiscoveryReadOutcome[] = [];
      const outcome = (o: DiscoveryReadOutcome) => {
        if (outcomes.length < REPO_SCAN_LIMITS.readOutcomesMax) outcomes.push(o);
      };

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
          if (listed.truncated) outcome({ read: "repository list", status: "skipped", detail: `listing stopped at ${REPO_SCAN_LIMITS.maxRepos} repositories` });
        } else {
          repos = ctx.source.scope.include.map((r) => r.trim()).filter(Boolean).slice(0, REPO_SCAN_LIMITS.maxRepos);
        }

        const out: RepoScanObservation[] = [];
        const subjectPrefix = PROVIDER_OF[kind];
        for (const repo of repos) {
          if (out.length >= EVIDENCE_MAX_ROWS) {
            outcome({ read: `repository ${repo}`.slice(0, 200), status: "skipped", detail: "the run's observation limit was reached" });
            continue;
          }
          await alive(ctx);
          const subject = `${subjectPrefix}:${repo}`;
          const tree = await reader.getTree(repo);
          if (!tree.commitSha) {
            outcome({ read: `repository ${repo}`.slice(0, 200), status: "skipped", detail: "empty repository (no default branch head)" });
            continue;
          }
          const head = await analyseTree(ctx, reader, repo, subject, tree);
          out.push(...toScanObservations(subject, head.analysis, head.actor));
          if (tree.truncated || head.analysis.stats.truncated) {
            outcome({ read: `repository ${repo}`.slice(0, 200), status: "read", detail: "read partially: a file, size or count limit was reached" });
          }

          if (history) {
            const commits = await reader.listCommits(repo, { ...(tree.ref ? { ref: tree.ref } : {}), maxCommits: depth });
            for (const c of commits) {
              if (c.sha === tree.commitSha || out.length >= EVIDENCE_MAX_ROWS) continue;
              await alive(ctx);
              const old = await reader.getTreeAt(repo, c.sha);
              const past = await analyseTree(ctx, reader, repo, subject, { ...old, author: c.author ?? old.author });
              out.push(...toScanObservations(subject, past.analysis, past.actor));
            }
          }
        }
        return {
          observations: mergeAcrossTrees(out).slice(0, EVIDENCE_MAX_ROWS),
          credentialWriteScope: scope.status === "read_only" ? "read_only" : "unverified",
          ...(outcomes.length > 0 ? { readOutcomes: outcomes } : {}),
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

/**
 * The same sighting (same value, path and line) in several trees is one
 * observation: the first one kept is the head's (its commit and author), the
 * count sums every tree it appeared in.
 */
function mergeAcrossTrees(obs: RepoScanObservation[]): RepoScanObservation[] {
  const m = new Map<string, RepoScanObservation>();
  for (const o of obs) {
    const key = JSON.stringify([o.subject, valueKey(o), o.location?.path ?? "", o.location?.line ?? "", (o.names ?? []).join(",")]);
    const prev = m.get(key);
    if (prev) prev.count = (prev.count ?? 1) + (o.count ?? 1);
    else m.set(key, { ...o });
  }
  return [...m.values()];
}

/** the four production repo scanners */
export const REPO_SCANNERS: readonly RepoScanner[] = REPO_SCANNER_KINDS.map((k) => repoScanner(k));
