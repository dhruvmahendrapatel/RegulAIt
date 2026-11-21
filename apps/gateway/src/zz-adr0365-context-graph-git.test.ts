/**
 * ADR-0365 slice 3 (lane E46): the context graph's git source (repositories and pull requests), on a real database
 * through the real routes, with a fake provider reader injected in place of the network (the discovery credential,
 * its decryption, the target checks and the write-scope refusal stay real).
 *
 *  - strict by default: a bound source reads nothing until a repository is mapped (not even the listing), and an
 *    unmapped repository never appears (no fact row, no node) whatever the provider lists;
 *  - a mapped repository's node and its pull request nodes are visible only to members of the mapped project: a
 *    non-member gets [] and a 404 for the node and its neighbourhood, the same answer as a missing id;
 *  - remapping re-scopes at once (no sync needed), unmapping removes the facts and nodes;
 *  - a pull request a complete listing no longer has is marked missing and clears when it reappears; a capped listing
 *    marks nothing;
 *  - a credential that grants write is refused, recorded on the discovery credential and audited, and never read again;
 *  - the scheduled job path runs under `system_task` and audits in the scheduler's name.
 *
 * Global state (M-068): discovery sources (cascading to the git sources), projects and users this file creates are
 * deleted in afterAll.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  and,
  auditLog,
  contextGraphGitPullRequests,
  contextGraphGitRepositories,
  createDb,
  discoveryCredentials,
  discoverySources,
  eq,
  inArray,
  projectMembers,
  projects,
  runMigrations,
  runWithRlsSystem,
  users,
  type Db,
} from "@regulait/db";
import type { PullRequestSummary, RepoReader, RepoSummary } from "@regulait/git-provider";
import { buildApp } from "./app.js";
import { CONTEXT_GRAPH_SYNC_JOB_NAME, contextGraphJobDefinitions } from "./context-graph.js";
import { encryptSecret } from "./secrets.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = randomBytes(4).toString("hex");
const BOOT = `e46cgg-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = createHash("sha256").update(`e46cgg-data-key-${RUN}`).digest("hex");
const NIL = "00000000-0000-0000-0000-000000000000";
const TOKEN = `synthetic-${randomUUID()}`;

/** the fake provider: what it lists, per discovery source, and what it says about the credential */
interface FakeProvider {
  repos: RepoSummary[];
  pulls: Record<string, PullRequestSummary[]>;
  truncatedPulls: boolean;
  scope: "read_only" | "write_scope" | "unverified";
  calls: string[];
}
const providers = new Map<string, FakeProvider>(); // keyed by the token the reader was built with
const pr = (number: number, title: string, state: PullRequestSummary["state"] = "open"): PullRequestSummary => ({
  number,
  title,
  state,
  url: `https://github.example/acme/pull/${number}`,
  createdAt: "2026-11-01T10:00:00.000Z",
  updatedAt: "2026-11-02T10:00:00.000Z",
});
const resolveReader = (_kind: string, opts: { token: string }): RepoReader => {
  const p = providers.get(opts.token);
  if (!p) throw new Error("no fake provider for this token");
  const no = async (): Promise<never> => {
    throw new Error("not used by the context graph");
  };
  return {
    kind: "github",
    historyEnabled: false,
    listRepos: async () => {
      p.calls.push("listRepos");
      return { repos: p.repos, truncated: false };
    },
    listPullRequests: async (repo: string) => {
      p.calls.push(`listPullRequests ${repo}`);
      return { pullRequests: p.pulls[repo] ?? [], truncated: p.truncatedPulls };
    },
    inspectCredential: async () => {
      p.calls.push("inspectCredential");
      return { status: p.scope, scopes: [], detail: "fake" };
    },
    getTree: no,
    readFile: no,
    listCommits: no,
    getTreeAt: no,
  };
};

let db: Db;
let app: ReturnType<typeof buildApp>;
const created = { sources: [] as string[], projects: [] as string[], users: [] as string[] };
const key: Record<string, { authorization: string }> = {};
const uid: Record<string, string> = {};

async function mkUser(label: string) {
  const u = await app.inject({ method: "POST", url: "/v1/users", headers: AUTH, payload: { email: `e46cgg-${label}-${RUN}@example.com`, displayName: `e46 ${label}` } });
  expect(u.statusCode, u.body).toBe(201);
  uid[label] = u.json().id as string;
  created.users.push(uid[label]!);
  const k = await app.inject({ method: "POST", url: `/v1/users/${uid[label]}/keys`, headers: AUTH, payload: { name: "k" } });
  key[label] = { authorization: `Bearer ${k.json().token}` };
}
async function mkProject(label: string, members: string[]) {
  const [p] = await db.insert(projects).values({ name: `e46cgg-${label}-${RUN}` }).returning({ id: projects.id });
  created.projects.push(p!.id);
  for (const m of members) await db.insert(projectMembers).values({ projectId: p!.id, userId: uid[m]!, role: "viewer" });
  return p!.id;
}
/** an enabled repo discovery source with a static read-only token, and the fake provider behind that token */
async function mkDiscoverySource(label: string, opts: { kind?: string; orgLevel?: boolean; include?: string[] } = {}) {
  const token = `${TOKEN}-${label}`;
  const [s] = await db
    .insert(discoverySources)
    .values({
      name: `e46cgg-${label}-${RUN}`,
      kind: (opts.kind ?? "repo_github") as typeof discoverySources.$inferInsert.kind,
      target: { namespace: "acme" },
      scope: { orgLevel: opts.orgLevel ?? true, include: opts.include ?? [] },
      enabled: true,
      enabledAt: new Date(),
      enabledBy: uid.alice!,
      createdBy: uid.alice!,
    })
    .returning({ id: discoverySources.id });
  created.sources.push(s!.id);
  await db.insert(discoveryCredentials).values({ sourceId: s!.id, credentialMode: "static", publicConfig: {}, secretCiphertext: encryptSecret(DATA_KEY, token), createdBy: uid.alice! });
  const fake: FakeProvider = { repos: [], pulls: {}, truncatedPulls: false, scope: "unverified", calls: [] };
  providers.set(token, fake);
  return { id: s!.id, fake };
}
const bind = (discoverySourceId: string, headers = AUTH) => app.inject({ method: "POST", url: "/v1/context-graph/git-sources", headers, payload: { discoverySourceId } });
const map = (gitSourceId: string, fullName: string, projectId: string) =>
  app.inject({ method: "PUT", url: `/v1/context-graph/git-sources/${gitSourceId}/repositories`, headers: AUTH, payload: { fullName, projectId } });
const sync = (gitSourceId: string) => app.inject({ method: "POST", url: `/v1/context-graph/git-sources/${gitSourceId}/sync`, headers: AUTH, payload: {} });
type NodeView = { id: string; kind: string; label: string; state: string | null; missing: boolean; externalUrl: string | null; provider: string; sourceId: string };
const nodesAs = async (who: string, qs = "") => {
  const r = await app.inject({ method: "GET", url: `/v1/context-graph/nodes?limit=200${qs}`, headers: key[who] ?? AUTH });
  expect(r.statusCode, r.body).toBe(200);
  return r.json().items as NodeView[];
};
const gitNodesAs = async (who: string, gitSourceId: string) => (await nodesAs(who, `&sourceId=${gitSourceId}`)).filter((n) => n.kind.startsWith("git_"));

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY, contextGraphGit: { resolveReader } });
  for (const l of ["alice", "bob", "carol"]) await mkUser(l);
}, 120_000);

afterAll(async () => {
  if (created.sources.length) await db.delete(discoverySources).where(inArray(discoverySources.id, created.sources));
  if (created.projects.length) await db.delete(projects).where(inArray(projects.id, created.projects));
  if (created.users.length) await db.delete(users).where(inArray(users.id, created.users));
  await app?.close();
});

describe("ADR-0365 slice 3: the git source", () => {
  let projectA: string;
  let projectB: string;
  let gitSourceId: string;
  let fake: FakeProvider;

  beforeAll(async () => {
    projectA = await mkProject("a", ["alice"]);
    projectB = await mkProject("b", ["bob"]);
    const src = await mkDiscoverySource("main");
    fake = src.fake;
    fake.repos = [
      { fullName: "acme/one", defaultBranch: "main", archived: false },
      { fullName: "acme/two", defaultBranch: "main", archived: false },
    ];
    fake.pulls = { "acme/one": [pr(1, "First change", "merged"), pr(2, "Second change")], "acme/two": [pr(9, "Unmapped repo change")] };
    const b = await bind(src.id);
    expect(b.statusCode, b.body).toBe(201);
    gitSourceId = b.json().id as string;
  });

  it("binding is admin-only and once per discovery source; a non-repository source is refused", async () => {
    expect((await bind(created.sources[0]!, key.alice)).statusCode).toBe(403);
    const again = await bind(created.sources[0]!);
    expect([again.statusCode, again.json().error]).toEqual([409, "already_bound"]);
    const cloud = await mkDiscoverySource("cloud", { kind: "cloud_aws" });
    const r = await bind(cloud.id);
    expect([r.statusCode, r.json().error]).toEqual([409, "not_a_repository_source"]);
    expect((await app.inject({ method: "GET", url: "/v1/context-graph/git-sources", headers: key.alice! })).statusCode).toBe(403);
  });

  it("strict default: with nothing mapped a sync reads nothing from the provider and projects nothing", async () => {
    const r = await sync(gitSourceId);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().repositories).toMatchObject({ mapped: 0, projected: 0 });
    expect(fake.calls).toEqual([]);
    expect(await gitNodesAs("root", gitSourceId)).toEqual([]);
  });

  it("an unmapped repository never appears; a mapped one and its pull requests reach members of the mapped project only", async () => {
    const m = await map(gitSourceId, "acme/one", projectA);
    expect(m.statusCode, m.body).toBe(201);
    const r = await sync(gitSourceId);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ repositories: { listed: 2, mapped: 1, projected: 1, missing: 0 }, pullRequests: { read: 2, missing: 0 }, created: { nodes: 3, edges: 2, scopes: 3 } });
    // only the mapped repo's pull requests were asked for; the unmapped repo left no fact row and no node
    expect(fake.calls.filter((c) => c.startsWith("listPullRequests"))).toEqual(["listPullRequests acme/one"]);
    expect(await db.select().from(contextGraphGitRepositories).where(eq(contextGraphGitRepositories.fullName, "acme/two"))).toEqual([]);
    const all = await gitNodesAs("root", gitSourceId);
    expect(all.map((n) => n.label).sort()).toEqual(["First change", "Second change", "acme/one"]);
    expect(all.some((n) => n.label.includes("Unmapped"))).toBe(false);

    const alice = await gitNodesAs("alice", gitSourceId);
    expect(alice.map((n) => [n.kind, n.label, n.state, n.provider]).sort()).toEqual([
      ["git_pull_request", "First change", "merged", "github"],
      ["git_pull_request", "Second change", "open", "github"],
      ["git_repository", "acme/one", null, "github"],
    ]);
    expect(alice.find((n) => n.label === "Second change")!.externalUrl).toBe("https://github.example/acme/pull/2");
    expect(alice.every((n) => n.sourceId === gitSourceId && !n.missing)).toBe(true);
    // the kind filter reaches git nodes too
    expect((await nodesAs("alice", "&kind=git_repository")).map((n) => n.label)).toContain("acme/one");

    // a non-member (bob: project B; carol: nothing) gets [] and a 404, exactly like a missing id
    const repoNode = alice.find((n) => n.kind === "git_repository")!;
    for (const who of ["bob", "carol"]) {
      expect(await gitNodesAs(who, gitSourceId)).toEqual([]);
      const one = await app.inject({ method: "GET", url: `/v1/context-graph/nodes/${repoNode.id}`, headers: key[who]! });
      const missing = await app.inject({ method: "GET", url: `/v1/context-graph/nodes/${randomUUID()}`, headers: key[who]! });
      expect([one.statusCode, one.json()]).toEqual([404, missing.json()]);
      expect((await app.inject({ method: "GET", url: `/v1/context-graph/nodes/${repoNode.id}/neighbours`, headers: key[who]! })).statusCode).toBe(404);
    }
    // the member walks from the repository to its pull requests over `contains` edges
    const nb = await app.inject({ method: "GET", url: `/v1/context-graph/nodes/${repoNode.id}/neighbours`, headers: key.alice! });
    expect(nb.statusCode, nb.body).toBe(200);
    expect((nb.json().nodes as NodeView[]).map((n) => n.label).sort()).toEqual(["First change", "Second change"]);
    expect((nb.json().edges as { kind: string }[]).map((e) => e.kind)).toEqual(["contains", "contains"]);

    // idempotent: a second sync creates nothing
    const again = await sync(gitSourceId);
    expect(again.json().created).toEqual({ nodes: 0, edges: 0, scopes: 0 });
  });

  it("remapping re-scopes at once: the old project's members lose sight before any sync", async () => {
    const m = await map(gitSourceId, "ACME/One", projectB); // the same repository, whatever its case
    expect(m.statusCode, m.body).toBe(200);
    expect(m.json().fullName).toBe("acme/one");
    expect(await gitNodesAs("alice", gitSourceId)).toEqual([]);
    expect((await gitNodesAs("bob", gitSourceId)).map((n) => n.label).sort()).toEqual(["First change", "Second change", "acme/one"]);
    const rules = await db.select({ ruleId: auditLog.ruleId }).from(auditLog).where(and(eq(auditLog.objectType, "context_graph_git_source"), eq(auditLog.objectId, gitSourceId)));
    expect(rules.map((r) => r.ruleId)).toEqual(
      expect.arrayContaining(["context-graph-git-source-bound", "context-graph-git-repository-mapped", "context-graph-git-repository-remapped", "context-graph-git-synced"]),
    );
  });

  it("a pull request a complete listing no longer has is marked missing, and clears when it reappears", async () => {
    fake.pulls["acme/one"] = [pr(1, "First change", "merged")];
    expect((await sync(gitSourceId)).json().pullRequests).toEqual({ read: 1, missing: 1 });
    const second = (await gitNodesAs("bob", gitSourceId)).find((n) => n.label === "Second change")!;
    expect(second.missing).toBe(true);
    // a capped listing proves nothing about older PRs: it marks nothing
    fake.pulls["acme/one"] = [];
    fake.truncatedPulls = true;
    expect((await sync(gitSourceId)).json().pullRequests).toEqual({ read: 0, missing: 0 });
    fake.truncatedPulls = false;
    fake.pulls["acme/one"] = [pr(1, "First change", "merged"), pr(2, "Second change, retitled", "closed")];
    await sync(gitSourceId);
    const back = (await gitNodesAs("bob", gitSourceId)).find((n) => n.id === second.id)!;
    expect([back.missing, back.label, back.state]).toEqual([false, "Second change, retitled", "closed"]);
    const [row] = await db.select().from(contextGraphGitPullRequests).where(eq(contextGraphGitPullRequests.title, "Second change, retitled"));
    expect(row!.missingSince).toBeNull();
  });

  it("the scheduled job (as system_task) syncs the bound git source and audits in the scheduler's name", async () => {
    fake.pulls["acme/one"] = [...fake.pulls["acme/one"]!, pr(3, "Third change")];
    const def = contextGraphJobDefinitions({ dataKey: DATA_KEY, git: { resolveReader } }).find((j) => j.name === CONTEXT_GRAPH_SYNC_JOB_NAME)!;
    const out = (await runWithRlsSystem("system_task", "test.context-graph-sync", () => def.run({ db, actorUserId: null, now: new Date(), runId: NIL }))) as {
      detail: { git: { synced: number; failed: unknown[] } };
    };
    expect(out.detail.git.failed).toEqual([]);
    expect(out.detail.git.synced).toBeGreaterThanOrEqual(1);
    expect((await gitNodesAs("bob", gitSourceId)).map((n) => n.label)).toContain("Third change");
    const rows = await db
      .select({ userId: auditLog.userId })
      .from(auditLog)
      .where(and(eq(auditLog.objectType, "context_graph_git_source"), eq(auditLog.objectId, gitSourceId), eq(auditLog.ruleId, "context-graph-git-synced")));
    expect(rows.map((r) => r.userId)).toContain(NIL);
  });

  it("a repository missing from a complete listing is marked missing; unmapping removes its facts and nodes", async () => {
    fake.repos = [{ fullName: "acme/two", defaultBranch: "main", archived: false }];
    expect((await sync(gitSourceId)).json().repositories).toMatchObject({ projected: 0, missing: 1 });
    expect((await gitNodesAs("bob", gitSourceId)).find((n) => n.kind === "git_repository")!.missing).toBe(true);
    const del = await app.inject({ method: "DELETE", url: `/v1/context-graph/git-sources/${gitSourceId}/repositories?fullName=acme%2Fone`, headers: AUTH });
    expect(del.statusCode, del.body).toBe(204);
    expect(await gitNodesAs("root", gitSourceId)).toEqual([]);
    expect(await db.select().from(contextGraphGitRepositories).where(eq(contextGraphGitRepositories.gitSourceId, gitSourceId))).toEqual([]);
    expect((await app.inject({ method: "DELETE", url: `/v1/context-graph/git-sources/${gitSourceId}/repositories?fullName=acme%2Fone`, headers: AUTH })).statusCode).toBe(404);
  });

  it("a repo-level discovery source maps only the repositories its scope names", async () => {
    const src = await mkDiscoverySource("scoped", { orgLevel: false, include: ["acme/one"] });
    const b = await bind(src.id);
    expect(b.statusCode, b.body).toBe(201);
    const out = await map(b.json().id as string, "acme/other", projectA);
    expect([out.statusCode, out.json().error]).toEqual([409, "repository_out_of_scope"]);
    const bad = await map(b.json().id as string, "not-a-repo", projectA);
    expect(bad.statusCode).toBe(400);
    expect((await app.inject({ method: "DELETE", url: `/v1/context-graph/git-sources/${b.json().id}`, headers: AUTH })).statusCode).toBe(204);
  });

  it("a credential that grants write is refused, recorded on the discovery credential and audited, and never read again", async () => {
    const src = await mkDiscoverySource("writer");
    src.fake.scope = "write_scope";
    src.fake.repos = [{ fullName: "acme/one", defaultBranch: "main", archived: false }];
    const b = await bind(src.id);
    expect(b.statusCode, b.body).toBe(201);
    const id = b.json().id as string;
    expect((await map(id, "acme/one", projectA)).statusCode).toBe(201);
    const r = await sync(id);
    expect([r.statusCode, r.json().error]).toEqual([409, "credential_has_write_scope"]);
    expect(src.fake.calls).toEqual(["inspectCredential"]); // no listing with a write credential
    const [cred] = await db.select({ writeScope: discoveryCredentials.writeScope }).from(discoveryCredentials).where(eq(discoveryCredentials.sourceId, src.id));
    expect(cred!.writeScope).toBe("refused");
    const audit = await db.select({ effect: auditLog.effect }).from(auditLog).where(and(eq(auditLog.objectType, "discovery_source"), eq(auditLog.objectId, src.id), eq(auditLog.ruleId, "discovery-credential-refused")));
    expect(audit.map((a) => a.effect)).toEqual(["deny"]);
    const next = await sync(id);
    expect([next.statusCode, next.json().error]).toEqual([409, "credential_refused"]);
    expect(src.fake.calls).toEqual(["inspectCredential"]);
    expect(await gitNodesAs("root", id)).toEqual([]);
    // a refused source cannot be bound again either (after unbinding)
    expect((await app.inject({ method: "DELETE", url: `/v1/context-graph/git-sources/${id}`, headers: AUTH })).statusCode).toBe(204);
    expect((await bind(src.id)).json().error).toBe("credential_refused");
  });

  it("unbinding removes everything the git source brought in", async () => {
    expect((await map(gitSourceId, "acme/two", projectA)).statusCode).toBe(201);
    await sync(gitSourceId);
    expect((await gitNodesAs("alice", gitSourceId)).length).toBe(2); // acme/two and its one PR
    expect((await app.inject({ method: "DELETE", url: `/v1/context-graph/git-sources/${gitSourceId}`, headers: AUTH })).statusCode).toBe(204);
    expect(await gitNodesAs("root", gitSourceId)).toEqual([]);
    expect((await sync(gitSourceId)).statusCode).toBe(404);
  });
});
