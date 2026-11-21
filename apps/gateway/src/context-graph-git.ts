/**
 * ADR-0365 slice 3 (lane E46): the context graph's git source: repositories and pull requests of a bound discovery
 * repo source (ADR-0195), each repository scoped to the project an admin mapped it to.
 *
 * - The credential, egress-guarded fetch and write-scope refusal are the discovery source's, through the same helpers
 *   the repo scanner uses (`openRepoReader`, `scanFederation`, the guarded fetch over the egress allow list). No token
 *   is stored here. A credential that grants write is refused and recorded on the discovery credential, exactly as a
 *   scan records it (the ADR-0336 write-scope state machine), and the source is never read again until replaced.
 * - Strict default: a repository with no mapping row is never projected; no fact row and no node exists for it.
 * - A sync reads the provider FIRST (no database transaction is open during network calls), then writes everything in
 *   one transaction: repository and pull request facts (verbatim, `missing_since` set when a complete listing no longer
 *   has one and cleared when it reappears), their nodes, one project scope per node (its repository's mapping), and
 *   `contains` edges from a repository to its pull requests. Every insert is ON CONFLICT DO NOTHING, so it is idempotent.
 * - Nothing here writes to a provider: the reader is GET-only (`RepoReader`).
 */
import {
  and,
  auditLog,
  contextGraphGitPullRequests,
  contextGraphGitRepoMappings,
  contextGraphGitRepositories,
  contextGraphGitSources,
  discoveryCredentials,
  discoverySources,
  eq,
  isNull,
  sql,
  type Db,
  type SQL,
} from "@regulait/db";
import { discoveryWriteScopeFinal, familySwitchProblem, nextDiscoveryWriteScope, scrubSecrets } from "@regulait/shared";
import { GitProviderRateLimitError, type PullRequestListResult, type RepoSummary } from "@regulait/git-provider";
import { REPO_SCANNER_KINDS, RepoScanError, openRepoReader, type RepoReaderDeps, type RepoScannerKind } from "./discovery-repo-scanner.js";
import { DISCOVERY_BACKOFF_MAX_MS, DISCOVERY_BACKOFF_MAX_TIMES, retryAfterMs, scanFederation, sleep, spacingRateLimiter } from "./discovery-worker.js";
import { loadDiscoverySettings } from "./discovery-posture.js";
import { loadEgressAllowList } from "./custom-providers.js";
import { createGuardedFetch, EgressBlockedError, EgressRedirectError, type EgressResolver } from "./egress-guard.js";
import { decryptSecret } from "./secrets.js";

export const CONTEXT_GRAPH_GIT_LIMITS = Object.freeze({
  /** repositories one listing reads (the repo scanner's bound) */
  maxListedRepos: 1_000,
  /** mapped repositories one sync reads pull requests for (the rest wait for the next sync) */
  maxMappedReposPerSync: 200,
  /** pull requests read per repository, most recent first, every state */
  maxPullRequests: 500,
  /** the longest the provider reads of one sync may take */
  maxFetchSeconds: 600,
});

export const isRepoSourceKind = (k: string): k is RepoScannerKind => (REPO_SCANNER_KINDS as readonly string[]).includes(k);

/** what the sync needs beyond the database: the data key (to decrypt a stored token) and test seams */
export interface ContextGraphGitDeps {
  dataKey?: string | undefined;
  /** TEST SEAM: builds the provider reader; the credential, target and write-scope checks around it stay real */
  resolveReader?: RepoReaderDeps["resolveReader"];
  /** TEST SEAMS for the guarded fetch (never set in production) */
  fetchImpl?: typeof fetch;
  resolve?: EgressResolver;
}

export type GitSyncFailure = { ok: false; status: 404 | 409 | 502 | 503; error: string; detail: string };
export type GitSyncResult =
  | {
      ok: true;
      gitSourceId: string;
      repositories: { listed: number; mapped: number; projected: number; missing: number; deferred: number };
      pullRequests: { read: number; missing: number };
      created: { nodes: number; edges: number; scopes: number };
      removedScopes: number;
    }
  | GitSyncFailure;

const fail = (status: GitSyncFailure["status"], error: string, detail: string): GitSyncFailure => ({ ok: false, status, error, detail });
const lowerName = (s: string) => s.trim().toLowerCase();

interface GitSnapshot {
  /** the mapped repositories the provider listed, keyed by the MAPPING's lower-cased name */
  listed: Map<string, RepoSummary>;
  /** true when the listing was cut short: an unlisted mapped repo may simply be past the cap, so it is not marked */
  listingTruncated: boolean;
  /** pull requests per mapped, listed repo (same keys) */
  pulls: Map<string, PullRequestListResult>;
  /** mapped repos left for the next sync (past `maxMappedReposPerSync`) */
  deferred: Set<string>;
  listedCount: number;
}

/**
 * Read the provider for one git source: open the discovery source's reader (refusing a write-scope credential, as the
 * scanner does), list its repositories (the source's namespace), keep the mapped ones, and list their pull requests.
 * No database transaction is open here.
 */
async function fetchGitSnapshot(db: Db, gitSourceId: string, actorUserId: string, deps: ContextGraphGitDeps): Promise<GitSnapshot | GitSyncFailure> {
  const [gs] = await db.select().from(contextGraphGitSources).where(eq(contextGraphGitSources.id, gitSourceId));
  if (!gs) return fail(404, "git_source_not_found", "no such context graph git source");
  const [source] = await db.select().from(discoverySources).where(eq(discoverySources.id, gs.discoverySourceId));
  if (!source || !isRepoSourceKind(source.kind)) return fail(404, "git_source_not_found", "the bound discovery source is gone or is not a repository source");
  const kind = source.kind;
  // the discovery source's own gates apply: off until enabled (with its step-up), and its family switch
  if (!source.enabled) return fail(409, "discovery_source_disabled", "the bound discovery source is disabled; an admin enables it under Discovery sources (with a step-up)");
  const familyOff = familySwitchProblem(source.kind, (await loadDiscoverySettings(db)).families);
  if (familyOff) return fail(409, "family_disabled", familyOff);
  const [cred] = await db
    .select()
    .from(discoveryCredentials)
    .where(and(eq(discoveryCredentials.sourceId, source.id), isNull(discoveryCredentials.revokedAt)));
  if (!cred) return fail(409, "credential_missing", "the bound discovery source has no live credential");
  if (discoveryWriteScopeFinal(cred.writeScope)) {
    return fail(409, "credential_refused", "the discovery source's credential was found to grant write access and is refused; replace it with a read-only credential");
  }
  const secrets: string[] = [];
  let secret: string | null = null;
  if (cred.secretCiphertext) {
    if (!deps.dataKey) return fail(503, "data_key_unavailable", "the data key is not configured, so the credential cannot be read");
    try {
      secret = decryptSecret(deps.dataKey, cred.secretCiphertext);
      secrets.push(secret);
    } catch {
      return fail(409, "credential_unreadable", "the credential does not decrypt under the current data key");
    }
  }
  const mappings = await db
    .select({ fullName: contextGraphGitRepoMappings.fullName })
    .from(contextGraphGitRepoMappings)
    .where(eq(contextGraphGitRepoMappings.gitSourceId, gs.id));
  const snapshot: GitSnapshot = { listed: new Map(), listingTruncated: false, pulls: new Map(), deferred: new Set(), listedCount: 0 };
  // strict default: nothing mapped, nothing read (not even the listing)
  if (mappings.length === 0) return snapshot;

  const scope = { orgLevel: source.scope.orgLevel === true, include: [...(source.scope.include ?? [])] };
  const inScope = new Set(scope.include.map(lowerName));
  const mapped = new Set(mappings.map((m) => lowerName(m.fullName)));
  const deadline = AbortSignal.timeout(CONTEXT_GRAPH_GIT_LIMITS.maxFetchSeconds * 1000);
  const guarded = createGuardedFetch({
    allowList: await loadEgressAllowList(db),
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    ...(deps.resolve ? { resolve: deps.resolve } : {}),
  });
  const limiter = spacingRateLimiter();
  let backoffs = 0;
  const ctx = {
    source: {
      id: source.id,
      name: source.name,
      kind: source.kind,
      target: Object.fromEntries(Object.entries(source.target).map(([k, v]) => [k, String(v)])),
      scope,
    },
    credential: { mode: cred.credentialMode, publicConfig: { ...cred.publicConfig }, secret },
    ...(cred.credentialMode === "federated" ? { federation: scanFederation(db, deps.dataKey, source.id, source.kind, cred.publicConfig) } : {}),
    fetch: ((input: string | URL | Request, init?: RequestInit) =>
      guarded(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline })) as typeof fetch,
    throttle: () => limiter.acquire(source.id, deadline),
    backoff: async (res: Response) => {
      if ((res.status !== 429 && res.status !== 503) || backoffs >= DISCOVERY_BACKOFF_MAX_TIMES) return false;
      backoffs += 1;
      await sleep(retryAfterMs(res) ?? Math.min(1000 * 2 ** backoffs, DISCOVERY_BACKOFF_MAX_MS), deadline);
      return true;
    },
    registerSecret: (value: string) => {
      if (typeof value === "string" && value.length > 0 && secrets.length < 64 && !secrets.includes(value)) secrets.push(value);
    },
    signal: deadline,
  };
  const scrub = (e: unknown) => scrubSecrets(e instanceof Error ? e.message : "the provider read failed", secrets).slice(0, 300);
  try {
    const opened = await openRepoReader(kind, ctx, deps.resolveReader ? { resolveReader: deps.resolveReader } : {});
    // ADR-0336 decision 9: the credential's state moves only along the write-scope transitions, as after a scan
    const next = nextDiscoveryWriteScope(cred.writeScope, opened.writeScope);
    if (next) await db.update(discoveryCredentials).set({ writeScope: next }).where(eq(discoveryCredentials.id, cred.id));
    if (opened.writeScope === "write") {
      if (next === "refused") {
        await db.insert(auditLog).values({
          userId: actorUserId,
          objectType: "discovery_source",
          objectId: source.id,
          detail: { subsystem: "context-graph", sourceId: source.id, credentialId: cred.id, kind: source.kind, gitSourceId: gs.id },
          effect: "deny",
          ruleId: "discovery-credential-refused",
          ruleChain: [],
          reason: `the credential of discovery source '${source.name}' grants write access: refused, never used again; the source cannot be enabled, run or synced into the context graph until it is replaced`,
        });
      }
      return fail(409, "credential_has_write_scope", "the credential grants write access; a repository credential must be read-only (ADR-0195 decision 7). Replace it.");
    }
    let reader = opened.reader;
    const listed = await reader.listRepos({
      ...(ctx.source.target.namespace ? { namespace: ctx.source.target.namespace } : {}),
      maxRepos: CONTEXT_GRAPH_GIT_LIMITS.maxListedRepos,
    });
    snapshot.listingTruncated = listed.truncated;
    snapshot.listedCount = listed.repos.length;
    let budget = CONTEXT_GRAPH_GIT_LIMITS.maxMappedReposPerSync;
    for (const repo of listed.repos) {
      const key = lowerName(repo.fullName);
      // only mapped repos, and only inside the discovery source's own repo-level scope when it has one
      if (!mapped.has(key) || (!scope.orgLevel && !inScope.has(key)) || snapshot.listed.has(key)) continue;
      if (budget-- <= 0) {
        snapshot.deferred.add(key);
        continue;
      }
      snapshot.listed.set(key, repo);
      reader = await opened.current();
      snapshot.pulls.set(key, await reader.listPullRequests(repo.fullName, { maxPullRequests: CONTEXT_GRAPH_GIT_LIMITS.maxPullRequests }));
    }
    return snapshot;
  } catch (e) {
    if (e instanceof RepoScanError) return fail(e.code === "credential_unusable" || e.code === "target_invalid" ? 409 : 502, e.code, scrub(e));
    if (e instanceof GitProviderRateLimitError) return fail(502, "rate_limited", "the git provider is still rate-limiting after the back-off; the next sync retries");
    if (e instanceof EgressBlockedError || e instanceof EgressRedirectError) return fail(502, "egress_blocked", scrub(e));
    if (deadline.aborted) return fail(502, "timed_out", `the provider reads did not finish within ${CONTEXT_GRAPH_GIT_LIMITS.maxFetchSeconds} s`);
    return fail(502, "provider_error", scrub(e));
  }
}

/** the git nodes (repository and pull request) of one source, optionally of one mapped repository, with the project
 * their mapping names: the target of every scope write */
function gitNodeTargets(gitSourceId: string, fullName: string | null): SQL {
  const one = fullName === null ? sql`` : sql`AND lower(r.full_name) = lower(${fullName})`;
  return sql`
    SELECT n.id AS node_id, m.project_id FROM context_graph_git_repositories r
    JOIN context_graph_git_repo_mappings m ON m.git_source_id = r.git_source_id AND m.full_name = r.full_name
    JOIN context_graph_nodes n ON n.git_repository_id = r.id
    WHERE r.git_source_id = ${gitSourceId}::uuid ${one}
    UNION ALL
    SELECT n.id, m.project_id FROM context_graph_git_pull_requests p
    JOIN context_graph_git_repositories r ON r.id = p.repository_id
    JOIN context_graph_git_repo_mappings m ON m.git_source_id = r.git_source_id AND m.full_name = r.full_name
    JOIN context_graph_nodes n ON n.git_pull_request_id = p.id
    WHERE r.git_source_id = ${gitSourceId}::uuid ${one}`;
}

/**
 * Give every git node of a source (or of one repository) exactly its mapping's project scope, in the caller's
 * transaction: rows for any other project are removed (the old project's members lose sight at once) and the mapped
 * one is added. Returns how many scope rows were removed and added.
 */
export async function rescopeGitNodes(tx: Db, gitSourceId: string, fullName: string | null): Promise<{ removed: number; added: number }> {
  const targets = gitNodeTargets(gitSourceId, fullName);
  const removed = await tx.execute(sql`
    WITH t AS (${targets})
    DELETE FROM context_graph_node_scopes s USING t WHERE s.node_id = t.node_id AND s.project_id <> t.project_id RETURNING s.node_id`);
  const added = await tx.execute(sql`
    INSERT INTO context_graph_node_scopes (node_id, project_id) SELECT t.node_id, t.project_id FROM (${targets}) t
    ON CONFLICT DO NOTHING RETURNING node_id`);
  return { removed: removed.rows.length, added: added.rows.length };
}

/** Write one snapshot in the caller's transaction (facts, nodes, scopes, edges, audit). */
async function applyGitSnapshot(tx: Db, gitSourceId: string, snap: GitSnapshot, actorUserId: string): Promise<GitSyncResult> {
  const [gs] = await tx.select().from(contextGraphGitSources).where(eq(contextGraphGitSources.id, gitSourceId)).for("update");
  if (!gs) return fail(404, "git_source_not_found", "no such context graph git source");
  // the mappings as they are NOW: a repo unmapped while the provider was read is not written
  const mappings = await tx.select().from(contextGraphGitRepoMappings).where(eq(contextGraphGitRepoMappings.gitSourceId, gs.id));
  let projected = 0;
  let missing = 0;
  let prsRead = 0;
  let prsMissing = 0;
  for (const m of mappings) {
    const key = lowerName(m.fullName);
    const repo = snap.listed.get(key);
    if (!repo) {
      // a mapped repo a complete listing does not have is missing (a deferred or truncated one is only unread)
      if (!snap.listingTruncated && !snap.deferred.has(key)) {
        const r = await tx
          .update(contextGraphGitRepositories)
          .set({ missingSince: sql`coalesce(${contextGraphGitRepositories.missingSince}, now())` })
          .where(and(eq(contextGraphGitRepositories.gitSourceId, gs.id), eq(contextGraphGitRepositories.fullName, m.fullName)))
          .returning({ id: contextGraphGitRepositories.id });
        missing += r.length;
      }
      continue;
    }
    projected += 1;
    // the repository fact is stored under the mapping's spelling (the composite foreign key to the mapping)
    const [row] = await tx
      .insert(contextGraphGitRepositories)
      .values({ gitSourceId: gs.id, fullName: m.fullName, defaultBranch: repo.defaultBranch, archived: repo.archived })
      .onConflictDoUpdate({
        target: [contextGraphGitRepositories.gitSourceId, contextGraphGitRepositories.fullName],
        set: { defaultBranch: repo.defaultBranch, archived: repo.archived, lastSeenAt: sql`now()`, missingSince: null },
      })
      .returning({ id: contextGraphGitRepositories.id });
    const repositoryId = row!.id;
    const pulls = snap.pulls.get(key);
    if (!pulls) continue;
    const seen = new Set<number>();
    const items = pulls.pullRequests.filter((p) => (seen.has(p.number) ? false : (seen.add(p.number), true)));
    prsRead += items.length;
    for (let i = 0; i < items.length; i += 250) {
      const chunk = items.slice(i, i + 250);
      await tx
        .insert(contextGraphGitPullRequests)
        .values(
          chunk.map((p) => ({
            repositoryId,
            number: p.number,
            title: p.title,
            state: p.state,
            url: p.url,
            providerCreatedAt: p.createdAt ? new Date(p.createdAt) : null,
            providerUpdatedAt: p.updatedAt ? new Date(p.updatedAt) : null,
          })),
        )
        .onConflictDoUpdate({
          target: [contextGraphGitPullRequests.repositoryId, contextGraphGitPullRequests.number],
          set: {
            title: sql`excluded.title`,
            state: sql`excluded.state`,
            url: sql`excluded.url`,
            providerCreatedAt: sql`excluded.provider_created_at`,
            providerUpdatedAt: sql`excluded.provider_updated_at`,
            lastSeenAt: sql`now()`,
            missingSince: null,
          },
        });
    }
    // a complete listing that no longer has a PR marks it missing; a capped listing proves nothing about older ones
    if (!pulls.truncated) {
      const numbers = [...seen];
      const gone = await tx.execute(sql`
        UPDATE context_graph_git_pull_requests SET missing_since = coalesce(missing_since, now())
        WHERE repository_id = ${repositoryId}::uuid AND missing_since IS NULL
          ${numbers.length ? sql`AND number NOT IN (${sql.join(numbers.map((n) => sql`${n}`), sql`, `)})` : sql``}
        RETURNING id`);
      prsMissing += gone.rows.length;
    }
  }

  // nodes for every fact row of the source (idempotent), their scopes, and the repository-to-PR edges
  const created = { nodes: 0, edges: 0, scopes: 0 };
  created.nodes += (
    await tx.execute(sql`
      INSERT INTO context_graph_nodes (kind, git_repository_id)
      SELECT 'git_repository', r.id FROM context_graph_git_repositories r WHERE r.git_source_id = ${gs.id}::uuid
      ON CONFLICT DO NOTHING RETURNING id`)
  ).rows.length;
  created.nodes += (
    await tx.execute(sql`
      INSERT INTO context_graph_nodes (kind, git_pull_request_id)
      SELECT 'git_pull_request', p.id FROM context_graph_git_pull_requests p
      JOIN context_graph_git_repositories r ON r.id = p.repository_id WHERE r.git_source_id = ${gs.id}::uuid
      ON CONFLICT DO NOTHING RETURNING id`)
  ).rows.length;
  const scoped = await rescopeGitNodes(tx, gs.id, null);
  created.scopes += scoped.added;
  created.edges += (
    await tx.execute(sql`
      INSERT INTO context_graph_edges (from_node_id, to_node_id, kind)
      SELECT rn.id, pn.id, 'contains' FROM context_graph_git_pull_requests p
      JOIN context_graph_git_repositories r ON r.id = p.repository_id
      JOIN context_graph_nodes rn ON rn.git_repository_id = r.id
      JOIN context_graph_nodes pn ON pn.git_pull_request_id = p.id
      WHERE r.git_source_id = ${gs.id}::uuid
      ON CONFLICT DO NOTHING RETURNING id`)
  ).rows.length;

  await tx.update(contextGraphGitSources).set({ lastSyncedAt: sql`now()` }).where(eq(contextGraphGitSources.id, gs.id));
  const repositories = { listed: snap.listedCount, mapped: mappings.length, projected, missing, deferred: snap.deferred.size };
  const pullRequests = { read: prsRead, missing: prsMissing };
  await tx.insert(auditLog).values({
    userId: actorUserId,
    objectType: "context_graph_git_source",
    objectId: gs.id,
    detail: { subsystem: "context-graph", discoverySourceId: gs.discoverySourceId, repositories, pullRequests, created, removedScopes: scoped.removed },
    effect: "allow",
    ruleId: "context-graph-git-synced",
    ruleChain: [],
    reason:
      `context graph git source ${gs.id} synced: ${projected} of ${mappings.length} mapped repositor(ies) projected, ${missing} missing, ` +
      `${prsRead} pull request(s) read, ${prsMissing} missing; ${created.nodes} node(s), ${created.edges} edge(s), ${created.scopes} scope row(s) created` +
      (snap.deferred.size ? `; ${snap.deferred.size} repositor(ies) wait for the next sync` : ""),
  });
  return { ok: true, gitSourceId: gs.id, repositories, pullRequests, created, removedScopes: scoped.removed };
}

/**
 * Sync one git source: read the provider (outside any transaction), then write it in one transaction. Runs as the
 * caller's scope: an admin route, or the scheduler's `system_task`.
 */
export async function syncContextGraphGitSource(db: Db, args: { gitSourceId: string; actorUserId: string; deps?: ContextGraphGitDeps }): Promise<GitSyncResult> {
  const snap = await fetchGitSnapshot(db, args.gitSourceId, args.actorUserId, args.deps ?? {});
  if ("ok" in snap) return snap;
  return db.transaction((tx) => applyGitSnapshot(tx as unknown as Db, args.gitSourceId, snap, args.actorUserId));
}
