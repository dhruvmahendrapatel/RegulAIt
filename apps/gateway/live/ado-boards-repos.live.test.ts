/**
 * ADR-0326, pilot criterion 3 — Azure DevOps Boards + Repos against a TEST organization.
 *
 * What runs live today is every link the product has on main, through the product's own adapters:
 *   Boards: create a work item, comment on it, read it back (pm-provider `AzureDevOpsProvider`);
 *   Repos: cut a branch, push one commit, open a PR whose description links the work item (`AB#<id>`), read its
 *          statuses and details (git-provider `AzureDevOpsProvider`).
 * The commit is pushed by the TEST through the ADO pushes API, because the product has no commit primitive yet
 * (PILOT_READINESS G3-3); the links nobody has built yet are `todo` below, so the chain's gaps are visible in the
 * report. Everything the test creates is removed in `afterAll`: the PR is abandoned, the branch deleted and the work
 * item deleted. Needs a PAT with Work Items (Read & Write) and Code (Read & Write) on the test organization only.
 */
import { afterAll, describe, expect, it } from "vitest";
import { AzureDevOpsProvider as AdoRepos } from "@regulait/git-provider";
import { AzureDevOpsProvider as AdoBoards } from "@regulait/pm-provider";
import { liveEnabled, liveTitle, need, redact } from "./live-env.js";

const on = liveEnabled("ado");

describe.skipIf(!on)(liveTitle("ado", "Boards work item → branch → commit → Repos PR → checks"), () => {
  const org = on ? need("REGULAIT_LIVE_ADO_ORG") : "";
  const project = on ? need("REGULAIT_LIVE_ADO_PROJECT") : "";
  const repoName = on ? need("REGULAIT_LIVE_ADO_REPO") : "";
  const pat = on ? need("REGULAIT_LIVE_ADO_PAT") : "";
  const baseBranch = process.env.REGULAIT_LIVE_ADO_BASE_BRANCH ?? "main";
  const baseUrl = `https://dev.azure.com/${encodeURIComponent(org)}`;
  const repo = `${project}/${repoName}`;
  const auth = `Basic ${Buffer.from(`:${pat}`).toString("base64")}`;
  const boards = new AdoBoards({ token: pat, baseUrl });
  const repos = new AdoRepos({ token: pat, baseUrl });
  const branch = `regulait-live/${Date.now()}`;
  const created: { workItemId?: string; prId?: string; branchSha?: string } = {};

  async function ado(method: string, pathAndQuery: string, body?: unknown): Promise<Record<string, unknown>> {
    const r = await fetch(`${baseUrl}/${encodeURIComponent(project)}/_apis/${pathAndQuery}`, {
      method,
      headers: { authorization: auth, "content-type": "application/json", accept: "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`ADO ${method} ${pathAndQuery.split("?")[0]} → ${r.status}: ${redact(text).slice(0, 300)}`);
    return text ? (JSON.parse(text) as Record<string, unknown>) : {};
  }

  afterAll(async () => {
    const errors: string[] = [];
    const attempt = async (what: string, fn: () => Promise<unknown>) => {
      try { await fn(); } catch (e) { errors.push(`${what}: ${redact(String(e))}`); }
    };
    if (created.prId) await attempt("abandon PR", () => ado("PATCH", `git/repositories/${encodeURIComponent(repoName)}/pullrequests/${created.prId}?api-version=7.1`, { status: "abandoned" }));
    if (created.branchSha) await attempt("delete branch", () => ado("POST", `git/repositories/${encodeURIComponent(repoName)}/refs?api-version=7.1`, [{ name: `refs/heads/${branch}`, oldObjectId: created.branchSha, newObjectId: "0".repeat(40) }]));
    if (created.workItemId) await attempt("delete work item", () => ado("DELETE", `wit/workitems/${created.workItemId}?api-version=7.1`));
    expect(errors, "live cleanup").toEqual([]);
  });

  it("runs every link that exists on main", async () => {
    const wi = await boards.createWorkItem(project, process.env.REGULAIT_LIVE_ADO_WORK_ITEM_TYPE ?? "Task", { "System.Title": `RegulAIt live test ${branch}` });
    created.workItemId = wi.id;
    expect(wi.id).toMatch(/^\d+$/);

    await repos.createBranch(repo, branch, baseBranch);
    const refs = await ado("GET", `git/repositories/${encodeURIComponent(repoName)}/refs?filter=heads/${encodeURIComponent(branch)}&api-version=7.1`);
    const head = (refs.value as Array<{ objectId: string }>)[0]!.objectId;
    const push = await ado("POST", `git/repositories/${encodeURIComponent(repoName)}/pushes?api-version=7.1`, {
      refUpdates: [{ name: `refs/heads/${branch}`, oldObjectId: head }],
      commits: [{
        comment: `RegulAIt live test commit (AB#${wi.id})`,
        changes: [{ changeType: "add", item: { path: `/regulait-live/${Date.now()}.md` }, newContent: { content: "live test\n", contentType: "rawtext" } }],
      }],
    });
    created.branchSha = (push.refUpdates as Array<{ newObjectId: string }>)[0]!.newObjectId;

    const pr = await repos.openPullRequest(repo, { head: branch, base: baseBranch, title: `RegulAIt live test ${branch}`, body: `Live harness PR. AB#${wi.id}` });
    created.prId = String(pr.id);
    const details = await repos.getPullRequest(repo, created.prId);
    expect(details).toBeTruthy();
    const checks = await repos.listChecks(repo, created.prId);
    expect(Array.isArray(checks)).toBe(true);

    await boards.addComment(project, wi.id, `RegulAIt live test: PR ${created.prId} opened`);
    const back = await boards.getWorkItem(project, wi.id);
    expect(back.id).toBe(wi.id);
  });

  it.todo("a Boards service hook (work item created/assigned) starts a governed workflow instance (gap G3-1)");
  it.todo("an existing work item binds to a workflow instance instead of RegulAIt creating a new one (gap G3-2)");
  it.todo("the build stage commits agent-written code to the branch (gap G3-3)");
  it.todo("ADO PR status checks gate the workflow and RegulAIt posts its own status back (gap G3-4)");
  it.todo("ADO reviewer approval / branch policy is reflected in the merge gate (gap G3-5)");
  it.todo("ADO auth with an Entra service principal or workload identity instead of a PAT (gap G3-6)");
});
