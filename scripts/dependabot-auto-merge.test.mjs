// Owner decision 2026-11-07 (#738, amendment 5): Dependabot auto-merge covers semver-PATCH only, with a 7-day
// cooldown and green required checks. These tests pin the workflow and the config to that, so widening it is a
// visible edit to a reviewed file.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { describe, expect, it } from "vitest";
import { MIN_DAYS, actionPublished, checkAges } from "./dependabot-release-age.mjs";
import { REQUIRED_CHECKS, checkEnforced, liveApi } from "./dependabot-required-checks.mjs";

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
    });
    expect(checkouts[0].with["sparse-checkout"].trim().split("\n")).toEqual([
      "scripts/dependabot-release-age.mjs",
      "scripts/dependabot-required-checks.mjs",
    ]);
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
    expect(queue.if.split(/\s*&&\s*/).map((c) => c.trim())).toEqual([
      "steps.eligible.outputs.patch == 'true'",
      "steps.gate.outputs.enforced == 'true'",
      "steps.age.outputs.old_enough == 'true'",
    ]);
    expect(queue.if).not.toContain("||");
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

// #759 merged with red and queued checks: main required none, so `--auto` merged at once. The job now queues only when
// the base branch enforces all six required checks, read from the API at run time, and fails closed otherwise.
describe("Dependabot auto-merge: the base branch must enforce the required checks", () => {
  const off = { protected: false, protection: { enabled: false, required_status_checks: { checks: [], contexts: [], enforcement_level: "off" } } };
  const classic = (names) => ({ protected: true, protection: { enabled: true, required_status_checks: { enforcement_level: "everyone", contexts: [], checks: names.map((context) => ({ context, app_id: null })) } } });
  const rule = (id, names) => ({ type: "required_status_checks", ruleset_id: id, parameters: { required_status_checks: names.map((context) => ({ context })) } });
  const api = ({ branch = off, rules = [], enforcement = {} } = {}) => ({
    branch: () => (branch instanceof Error ? (() => { throw branch; })() : branch),
    rules: () => (rules instanceof Error ? (() => { throw rules; })() : rules),
    // a string is the enforcement with no bypass for this token; an object sets both fields
    ruleset: (id) => {
      if (!(id in enforcement)) throw new Error(`ruleset ${id} not found`);
      const e = enforcement[id];
      return typeof e === "string" ? { enforcement: e, current_user_can_bypass: "never" } : e;
    },
  });

  it("names the six required checks", () => {
    expect(REQUIRED_CHECKS).toEqual(["build-and-test", "SAST (CodeQL)", "Secret scan (gitleaks)", "Dependency audit (pnpm)",
      "Image scan and SBOMs (Trivy)", "ui enterprise / all"]);
  });

  it("refuses main as it is today: no protection and no rules (the #759 case)", () => {
    const r = checkEnforced(api());
    expect(r.enforced).toBe(false);
    expect(r.reasons[0]).toContain("does not require: build-and-test");
  });

  it("refuses when only some checks are required", () => {
    expect(checkEnforced(api({ branch: classic(REQUIRED_CHECKS.slice(0, 5)) })).enforced).toBe(false);
    expect(checkEnforced(api({ rules: [rule(1, REQUIRED_CHECKS.slice(1))], enforcement: { 1: "active" } })).enforced).toBe(false);
  });

  it("accepts all six from classic protection, from an active ruleset, or split across both", () => {
    expect(checkEnforced(api({ branch: classic(REQUIRED_CHECKS) }))).toEqual({ enforced: true, reasons: [] });
    expect(checkEnforced(api({ rules: [rule(7, REQUIRED_CHECKS)], enforcement: { 7: "active" } })).enforced).toBe(true);
    expect(checkEnforced(api({ branch: classic(REQUIRED_CHECKS.slice(0, 3)), rules: [rule(7, REQUIRED_CHECKS.slice(3))], enforcement: { 7: "active" } })).enforced).toBe(true);
  });

  it("ignores protection that is off and rulesets in evaluate or disabled mode", () => {
    const disabledClassic = classic(REQUIRED_CHECKS);
    disabledClassic.protection.required_status_checks.enforcement_level = "off";
    expect(checkEnforced(api({ branch: disabledClassic })).enforced).toBe(false);
    const notEnabled = classic(REQUIRED_CHECKS);
    notEnabled.protection.enabled = false;
    expect(checkEnforced(api({ branch: notEnabled })).enforced).toBe(false);
    for (const mode of ["evaluate", "disabled"]) {
      expect(checkEnforced(api({ rules: [rule(3, REQUIRED_CHECKS)], enforcement: { 3: mode } })).enforced).toBe(false);
    }
  });

  it("fails closed when any lookup fails or returns something unreadable", () => {
    expect(checkEnforced(api({ branch: new Error("HTTP 403") })).enforced).toBe(false);
    expect(checkEnforced(api({ rules: new Error("HTTP 500") })).enforced).toBe(false);
    expect(checkEnforced(api({ rules: { message: "Not Found" } })).enforced).toBe(false);
    const r = checkEnforced(api({ rules: [rule(9, REQUIRED_CHECKS)] })); // ruleset 9 cannot be read
    expect(r.enforced).toBe(false);
    expect(r.reasons[0]).toContain("could not be read");
  });

  it("refuses a ruleset this token can bypass, or one that does not say (#761 security review)", () => {
    for (const bypass of ["always", "pull_requests_only", "exempt", undefined]) {
      const r = checkEnforced(api({ rules: [rule(4, REQUIRED_CHECKS)], enforcement: { 4: { enforcement: "active", current_user_can_bypass: bypass } } }));
      expect(r.enforced, String(bypass)).toBe(false);
    }
    expect(checkEnforced(api({ rules: [rule(4, REQUIRED_CHECKS)], enforcement: { 4: { enforcement: "active", current_user_can_bypass: "never" } } })).enforced).toBe(true);
    // a bypassable ruleset does not count even when another, binding one supplies the rest
    expect(checkEnforced(api({ rules: [rule(4, REQUIRED_CHECKS.slice(0, 3)), rule(5, REQUIRED_CHECKS.slice(3))],
      enforcement: { 4: "active", 5: { enforcement: "active", current_user_can_bypass: "pull_requests_only" } } })).enforced).toBe(false);
  });

  it("reads every page of the branch rules, each ruleset once, for the given repository and branch", () => {
    const calls = [];
    const run = (_cmd, args) => {
      const route = args.at(-1);
      calls.push(args.slice(1).join(" "));
      if (route === "repos/o/r/rulesets/5") return JSON.stringify({ enforcement: "active", current_user_can_bypass: "never" });
      if (route === "repos/o/r/rulesets/6") return JSON.stringify({ enforcement: "active", current_user_can_bypass: "never" });
      if (route.includes("/rules/")) return JSON.stringify([[rule(5, REQUIRED_CHECKS.slice(0, 3))], [rule(6, REQUIRED_CHECKS.slice(3)), rule(5, [])]]);
      return JSON.stringify(off);
    };
    const r = checkEnforced(liveApi("o/r", "release/1", run));
    expect(calls).toEqual(["repos/o/r/branches/release%2F1", "--paginate --slurp repos/o/r/rules/branches/release%2F1",
      "repos/o/r/rulesets/5", "repos/o/r/rulesets/6"]);
    expect(r.enforced).toBe(true); // the six checks are split across two pages
  });

  it("fails closed on a ruleset with no enforcement, or rule pages that are not lists", () => {
    const run = (bad) => (_cmd, args) => {
      const route = args.at(-1);
      if (route.startsWith("repos/o/r/rulesets/")) return JSON.stringify(bad === "ruleset" ? {} : { enforcement: "active", current_user_can_bypass: "never" });
      if (route.includes("/rules/")) return JSON.stringify(bad === "pages" ? [{ message: "Not Found" }] : [[rule(5, REQUIRED_CHECKS)]]);
      return JSON.stringify(off);
    };
    expect(checkEnforced(liveApi("o/r", "main", run("none"))).enforced).toBe(true);
    expect(checkEnforced(liveApi("o/r", "main", run("ruleset"))).enforced).toBe(false);
    expect(checkEnforced(liveApi("o/r", "main", run("pages"))).enforced).toBe(false);
  });

  it("wires the gate: base-commit script, runs when eligible, comments once when refused, never merges by itself", () => {
    const gate = step("gate");
    expect(gate.if).toBe("steps.eligible.outputs.patch == 'true'");
    expect(gate.run.trim()).toBe("node scripts/dependabot-required-checks.mjs");
    expect(gate.env).toMatchObject({ REPO: "${{ github.repository }}", BRANCH: "${{ github.event.pull_request.base.ref }}" });
    const ids = job.steps.map((s) => s.id ?? s.name);
    expect(ids.indexOf("gate")).toBeLessThan(ids.indexOf("Queue it"));
    const say = job.steps.find((s) => s.name === "Say why it is not queued");
    expect(say.if).toBe("steps.eligible.outputs.patch == 'true' && steps.gate.outputs.enforced != 'true'");
    expect(say.run).toContain("gh pr comment");
    expect(say.run).not.toMatch(/gh pr merge|sleep|gh pr checks|--watch/);
    const all = Object.values(wf.jobs).flatMap((j) => j.steps).map((s) => s.run ?? "").join("\n");
    expect(all.match(/gh pr merge --auto/g)).toHaveLength(1);
    expect(all).not.toMatch(/sleep |gh pr checks|--watch|gh pr merge (?!--auto|--disable-auto)/);
  });
});
