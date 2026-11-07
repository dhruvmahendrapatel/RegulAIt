// Owner decision 2026-11-07 (#738, amendment 5): Dependabot auto-merge covers semver-PATCH only, with a 7-day
// cooldown and green required checks. These tests pin the workflow and the config to that, so widening it is a
// visible edit to a reviewed file.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { describe, expect, it } from "vitest";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(path.join(repo, p), "utf8");
const wf = yaml.load(read(".github/workflows/dependabot-auto-merge.yml"));
const job = wf.jobs.patch;
const queue = job.steps.find((s) => (s.run ?? "").includes("gh pr merge"));

describe("Dependabot auto-merge (patch only)", () => {
  it("runs on pull_request, never pull_request_target, and checks out nothing", () => {
    expect(Object.keys(wf.on)).toEqual(["pull_request"]);
    expect(wf.permissions).toEqual({ contents: "read" });
    expect(job.steps.some((s) => String(s.uses ?? "").startsWith("actions/checkout"))).toBe(false);
  });

  it("acts only on Dependabot's own PRs from this repository", () => {
    expect(job.if).toContain("github.event.pull_request.user.login == 'dependabot[bot]'");
    expect(job.if).toContain("github.actor == 'dependabot[bot]'");
    expect(job.if).toContain("github.event.pull_request.head.repo.full_name == github.repository");
  });

  it("queues a semver-patch update of the root workspace or an action, and nothing else", () => {
    expect(queue.if).toContain("steps.meta.outputs.update-type == 'version-update:semver-patch'");
    expect(queue.if).not.toMatch(/semver-minor|semver-major/);
    expect(queue.if).toContain("steps.meta.outputs.package-ecosystem == 'npm_and_yarn' && steps.meta.outputs.directory == '/'");
    expect(queue.if).toContain("steps.meta.outputs.package-ecosystem == 'github_actions'");
    expect(queue.if).not.toMatch(/docker|pip|engines/);
  });

  it("enables auto-merge with a merge commit, never merging directly or approving", () => {
    expect(queue.run.trim()).toBe('gh pr merge --auto --merge "$PR_URL"');
    const all = job.steps.map((s) => s.run ?? "").join("\n");
    expect(all).not.toMatch(/--squash|--rebase|--admin|gh pr review/);
  });

  it("pins dependabot/fetch-metadata by commit", () => {
    expect(job.steps[0].uses).toMatch(/^dependabot\/fetch-metadata@[0-9a-f]{40}$/);
  });
});

describe("the 7-day cooldown", () => {
  const cfg = yaml.load(read(".github/dependabot.yml"));
  it("is set on every npm and github-actions entry, and patch and minor are grouped apart where auto-merge applies", () => {
    for (const u of cfg.updates.filter((x) => x["package-ecosystem"] === "npm" || x["package-ecosystem"] === "github-actions")) {
      expect(u.cooldown?.["default-days"], u.directory).toBe(7);
    }
    for (const u of cfg.updates.filter((x) => (x["package-ecosystem"] === "npm" && x.directory === "/") || x["package-ecosystem"] === "github-actions")) {
      for (const g of Object.values(u.groups ?? {})) expect(g["update-types"]?.length, u.directory).toBe(1);
    }
  });

  it("pnpm resolves no version younger than 7 days", () => {
    expect(yaml.load(read("pnpm-workspace.yaml")).minimumReleaseAge).toBe(10080);
  });
});
