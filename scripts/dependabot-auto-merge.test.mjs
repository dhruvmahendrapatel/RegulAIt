// Owner decision 2026-11-07 (#738, amendment 5): Dependabot auto-merge covers semver-PATCH only, with a 7-day
// cooldown and green required checks. These tests pin the workflow and the config to that, so widening it is a
// visible edit to a reviewed file.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { describe, expect, it } from "vitest";
import { MIN_DAYS, actionPublished, checkAges } from "./dependabot-release-age.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(path.join(repo, p), "utf8");
const wf = yaml.load(read(".github/workflows/dependabot-auto-merge.yml"));
const job = wf.jobs.patch;
const queue = job.steps.find((s) => (s.run ?? "").includes("gh pr merge --auto"));
const step = (id) => job.steps.find((s) => s.id === id);

describe("Dependabot auto-merge (patch only)", () => {
  it("runs on pull_request, never pull_request_target, and checks out only the base commit's age-gate script", () => {
    expect(Object.keys(wf.on)).toEqual(["pull_request"]);
    expect(wf.permissions).toEqual({ contents: "read" });
    const checkouts = Object.values(wf.jobs).flatMap((j) => j.steps).filter((s) => String(s.uses ?? "").startsWith("actions/checkout"));
    expect(checkouts).toHaveLength(1);
    expect(checkouts[0].with).toMatchObject({
      ref: "${{ github.event.pull_request.base.sha }}",
      "persist-credentials": false,
      "sparse-checkout": "scripts/dependabot-release-age.mjs",
    });
  });

  it("queues only for Dependabot's own commit, run and PR from this repository (no re-run by anyone else)", () => {
    for (const c of ["github.event.pull_request.user.login == 'dependabot[bot]'", "github.actor == 'dependabot[bot]'",
      "github.triggering_actor == 'dependabot[bot]'", "github.event.pull_request.head.repo.full_name == github.repository"]) {
      expect(job.if).toContain(c);
    }
    expect(job.if).not.toContain("||");
  });

  it("calls a semver-patch update of the root workspace or an action eligible, and nothing else", () => {
    const run = step("eligible").run;
    expect(run).toContain('[ "$UPDATE_TYPE" = version-update:semver-patch ]');
    expect(run).toContain('[ "$ECOSYSTEM" = npm_and_yarn ] && [ "$DIRECTORY" = / ]');
    expect(run).toContain('[ "$ECOSYSTEM" = github_actions ]');
    expect(run).not.toMatch(/semver-minor|semver-major|docker|pip|engines/);
    expect(run.match(/ok=true/g)).toHaveLength(2);
  });

  it("queues only when eligible AND every new version is old enough", () => {
    expect(queue.if).toBe("steps.eligible.outputs.patch == 'true' && steps.age.outputs.old_enough == 'true'");
    expect(step("age").if).toBe("steps.eligible.outputs.patch == 'true'");
    expect(step("age").run.trim()).toBe("node scripts/dependabot-release-age.mjs");
    expect(step("age").env.UPDATED_DEPS).toBe("${{ steps.meta.outputs.updated-dependencies-json }}");
    const ids = job.steps.map((s) => s.id ?? s.name);
    expect(ids.indexOf("age")).toBeLessThan(ids.indexOf("Queue it"));
  });

  it("enables auto-merge for the exact head commit with a merge commit, never merging directly or approving", () => {
    expect(queue.run.trim()).toBe('gh pr merge --auto --merge --match-head-commit "$HEAD_SHA" "$PR_URL"');
    expect(queue.env.HEAD_SHA).toBe("${{ github.event.pull_request.head.sha }}");
    const all = Object.values(wf.jobs).flatMap((j) => j.steps).map((s) => s.run ?? "").join("\n");
    expect(all).not.toMatch(/--squash|--rebase|--admin|gh pr review/);
  });

  it("turns auto-merge off when anyone but Dependabot pushes to or re-runs on a Dependabot PR", () => {
    const d = wf.jobs.disarm;
    expect(d.if).toContain("github.event.pull_request.user.login == 'dependabot[bot]'");
    expect(d.if).toContain("(github.actor != 'dependabot[bot]' || github.triggering_actor != 'dependabot[bot]')");
    expect(d.steps.at(-1).run).toContain('gh pr merge --disable-auto "$PR_URL"');
    expect(wf.on.pull_request.types).toEqual(expect.arrayContaining(["opened", "synchronize", "reopened"]));
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

  // pnpm's `minimumReleaseAge` is deliberately not set: `pnpm deploy --legacy` (every engine image build) re-resolves
  // and refuses a version the lockfile already holds when it is younger than the limit, so a fresh security fix in
  // the lockfile would break every image build. The Dependabot cooldown is the gate (#746 CI, 2026-11-08).
  it("does not set pnpm's minimumReleaseAge, which breaks the engine image builds", () => {
    expect(yaml.load(read("pnpm-workspace.yaml")).minimumReleaseAge).toBeUndefined();
  });
});

// #746 review finding 1: security updates skip the cooldown, so the workflow checks the age itself and fails closed.
describe("the release-age gate", () => {
  const NOW = Date.parse("2026-11-08T00:00:00Z");
  const daysAgo = (n) => new Date(NOW - n * 24 * 60 * 60 * 1000).toISOString();
  const deps = (...v) => JSON.stringify(v.map(([dependencyName, newVersion]) => ({ dependencyName, newVersion })));
  const at = (table) => (_eco, name, version) => table[`${name}@${version}`];

  it("requires 7 days", () => expect(MIN_DAYS).toBe(7));

  it("passes only when every new version is at least 7 days old", () => {
    const lookup = at({ "a@1.0.1": daysAgo(8), "b@2.0.3": daysAgo(7.01) });
    expect(checkAges(deps(["a", "1.0.1"], ["b", "2.0.3"]), "npm_and_yarn", { now: NOW, lookup })).toEqual({ ok: true, reasons: [] });
  });

  it("refuses a version published under 7 days ago, even when the others are old", () => {
    const lookup = at({ "a@1.0.1": daysAgo(30), "b@2.0.3": daysAgo(2) });
    const r = checkAges(deps(["a", "1.0.1"], ["b", "2.0.3"]), "npm_and_yarn", { now: NOW, lookup });
    expect(r.ok).toBe(false);
    expect(r.reasons.join()).toContain("b@2.0.3");
  });

  it("fails closed on a lookup error, a missing or unreadable date, an empty or unreadable list, or another ecosystem", () => {
    const boom = () => { throw new Error("registry down"); };
    expect(checkAges(deps(["a", "1.0.1"]), "npm_and_yarn", { now: NOW, lookup: boom }).ok).toBe(false);
    expect(checkAges(deps(["a", "1.0.1"]), "npm_and_yarn", { now: NOW, lookup: () => undefined }).ok).toBe(false);
    expect(checkAges(deps(["a", "1.0.1"]), "npm_and_yarn", { now: NOW, lookup: () => "not a date" }).ok).toBe(false);
    expect(checkAges("[]", "npm_and_yarn", { now: NOW, lookup: () => daysAgo(30) }).ok).toBe(false);
    expect(checkAges("", "npm_and_yarn", { now: NOW, lookup: () => daysAgo(30) }).ok).toBe(false);
    expect(checkAges(undefined, "npm_and_yarn", { now: NOW, lookup: () => daysAgo(30) }).ok).toBe(false);
    expect(checkAges(deps(["a", ""]), "npm_and_yarn", { now: NOW, lookup: () => daysAgo(30) }).ok).toBe(false);
    expect(checkAges(deps(["a", "1.0.1"]), "docker", { now: NOW, lookup: () => daysAgo(30) }).ok).toBe(false);
  });

  it("dates an action by its GitHub release, never by a bare tag", () => {
    const calls = [];
    const run = (_cmd, args) => {
      calls.push(args[1]);
      if (args[1] === "repos/actions/checkout/releases/tags/v7.0.2") return "2026-10-01T00:00:00Z\n";
      throw new Error("404");
    };
    expect(actionPublished("actions/checkout", "7.0.2", run)).toBe("2026-10-01T00:00:00Z");
    expect(() => actionPublished("owner/no-release", "1.2.3", () => { throw new Error("404"); })).toThrow(/no GitHub release/);
    expect(calls[0]).toBe("repos/actions/checkout/releases/tags/v7.0.2");
  });
});
