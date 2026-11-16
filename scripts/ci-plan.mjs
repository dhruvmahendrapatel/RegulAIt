#!/usr/bin/env node
// ADR-0323: a dry run of what a pull_request runs. It reads the real workflow files and evaluates each job's `if:`
// (and the scope-dependent matrices) against the scope that scripts/ci-scope.mjs gives for a list of changed paths,
// so the job selection is the workflows' own, not a copy of it.
//
// Expressions are parsed and evaluated by GitHub's own library (@actions/expressions), so the dry run follows
// GitHub's coercion and comparison rules. It models the `needs`, `github` (event_name, ref) and `matrix` contexts and
// the job status functions; an expression naming any other context fails to parse, which fails the dry run.
// Workflow-level `paths:` / `paths-ignore:` filters are applied with node's path.matchesGlob.
//
// usage: node scripts/ci-plan.mjs <changed path>...        print the scope and the jobs a PR with those changes runs
//        node scripts/ci-plan.mjs --base origin/main       the same for this branch's diff against a ref
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Evaluator, Lexer, Parser, data } from "@actions/expressions";
import { truthy } from "@actions/expressions/result";
import yaml from "js-yaml";
import { OUTPUTS, scopeOf } from "./ci-scope.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** the workflows a pull_request can start, in the order they are reported */
export const PR_WORKFLOWS = Object.freeze([
  "ci.yml", "ui-enterprise.yml", "security.yml", "import-cycles.yml", "integrations.yml", "client-compat.yml",
  "endpoint-agent.yml", "engine-images-build.yml", "operator.yml", "helm-chart.yml", "infra-terraform.yml",
]);
/** PR-triggered workflows outside the dry run: Dependabot automation, which runs no suite */
export const PR_WORKFLOWS_EXCLUDED = Object.freeze(["dependabot-auto-merge.yml"]);

// ── expressions: GitHub's own evaluator (@actions/expressions, MIT, actions/languageservices) ──────────────────
// The dry run uses the same parser, coercion and comparison rules as GitHub; RegulAIt adds only the context (the
// needs graph and the scope) and the job status functions, which the library leaves to its host.
const CONTEXTS = ["needs", "github", "matrix"];
const STATUS_FNS = ["success", "always", "cancelled", "failure"];

/** evaluate `src` (with or without the `${{ }}` wrapper) against a plain-JS context; returns plain JS */
export function evaluate(src, context, status = {}) {
  const body = String(src).trim().replace(/^\$\{\{([\s\S]*)\}\}$/, "$1").trim();
  const fns = new Map(STATUS_FNS.map((name) => [name, {
    name, minArgs: 0, maxArgs: 0,
    call: () => new data.BooleanData(Boolean(status[name])),
  }]));
  const lexed = new Lexer(body).lex();
  const expr = new Parser(lexed.tokens, CONTEXTS, [...fns.values()]).parse();
  const ctx = new data.Dictionary();
  for (const [k, v] of Object.entries(context)) ctx.add(k, JSON.parse(JSON.stringify(v), data.reviver));
  const result = new Evaluator(expr, ctx, fns).evaluate();
  return { value: JSON.parse(JSON.stringify(result, data.replacer)), truthy: truthy(result) };
}

const usesStatus = (expr) => /\b(cancelled|always|success|failure)\s*\(/.test(String(expr));

// ── one pull_request run ────────────────────────────────────────────────────
/** the scope action's outputs as a workflow step sees them: the strings 'true' / 'false', and only for the outputs
 *  .github/actions/ci-scope/action.yml DECLARES. GitHub drops an output the action does not declare, so it reads as
 *  '' in `needs.scope.outputs`; modelling that is what lets the dry run catch an undeclared output (#851). */
export function scopeStepOutputs(scope) {
  const action = yaml.load(readFileSync(path.join(repo, ".github/actions/ci-scope/action.yml"), "utf8"));
  const out = {};
  for (const [k, def] of Object.entries(action.outputs ?? {})) {
    const m = /^\$\{\{\s*steps\.scope\.outputs\.([A-Za-z0-9_-]+)\s*\}\}$/.exec(String(def.value).trim());
    out[k] = m && m[1] in scope && m[1] !== "reason" ? String(scope[m[1]]) : "";
  }
  return out;
}

/** a job's `outputs:` map, each `${{ steps.scope.outputs.X }}` read from the scope action's step outputs */
function jobScopeOutputs(job, scope) {
  const step = scopeStepOutputs(scope);
  return Object.fromEntries(Object.entries(job.outputs ?? {}).map(([k, v]) => {
    const m = /^\$\{\{\s*steps\.scope\.outputs\.([A-Za-z0-9_-]+)\s*\}\}$/.exec(String(v).trim());
    return [k, m ? (step[m[1]] ?? "") : "unknown"];
  }));
}

/** the outputs a job writes, for the jobs whose outputs other jobs read */
function outputsOf(file, id, job, scope) {
  if (id === "scope") return jobScopeOutputs(job, scope);
  if (file === "security.yml" && id === "engines") {
    const names = readdirSync(path.join(repo, "engines"), { withFileTypes: true })
      .filter((e) => e.isDirectory() && readdirSync(path.join(repo, "engines", e.name)).includes("Dockerfile"))
      .map((e) => e.name);
    const step = scopeStepOutputs(scope);
    // the find step's rule: only an exact 'false' builds no engine
    return { ...jobScopeOutputs(job, scope), engines: JSON.stringify(step.engines === "false" ? [] : names) };
  }
  return Object.fromEntries(Object.keys(job.outputs ?? {}).map((k) => [k, "unknown"]));
}

/** how many runners a job takes: its matrix's size (a scope-dependent matrix is evaluated), 1 without one */
function runnersOf(job, context, file) {
  if (job.uses) {
    // a reusable workflow in this repository: the sum of its jobs' runners
    const called = yaml.load(readFileSync(path.join(repo, job.uses.replace(/^\.\//, "")), "utf8"));
    return Object.values(called.jobs).reduce((n, j) => n + runnersOf(j, context, file), 0);
  }
  const matrix = job.strategy?.matrix;
  if (!matrix) return 1;
  if (typeof matrix === "string") return [].concat(evaluate(matrix, context).value).length;
  return Object.entries(matrix)
    .filter(([k]) => k !== "include" && k !== "exclude")
    .reduce((n, [, v]) => n * (typeof v === "string" ? [].concat(evaluate(v, context).value).length : v.length), 1);
}

/** does a workflow-level path filter let a PR with these files start the workflow? */
export function pathsAllow(on, files) {
  const pr = on?.pull_request;
  if (on && !("pull_request" in on)) return false;
  if (!pr || (!pr.paths && !pr["paths-ignore"])) return true;
  if (pr["paths-ignore"]) return files.some((f) => !pr["paths-ignore"].some((g) => path.matchesGlob(f, g)));
  // `paths`: a file matches when the last pattern that applies to it is a positive one
  return files.some((f) => {
    let hit = false;
    for (const g of pr.paths) {
      if (g.startsWith("!")) { if (path.matchesGlob(f, g.slice(1))) hit = false; }
      else if (path.matchesGlob(f, g)) hit = true;
    }
    return hit;
  });
}

/** the plan for one workflow: each job's result ('run' or 'skipped') and how many runners it takes */
export function planWorkflow(file, scope, files) {
  const wf = yaml.load(readFileSync(path.join(repo, ".github/workflows", file), "utf8"));
  const on = typeof wf.on === "string" || Array.isArray(wf.on) ? Object.fromEntries([].concat(wf.on).map((e) => [e, null])) : wf.on;
  if (!pathsAllow(on, files)) return { file, started: false, jobs: {} };
  const results = {};
  const jobs = {};
  const pending = Object.entries(wf.jobs);
  while (pending.length) {
    const idx = pending.findIndex(([, j]) => [].concat(j.needs ?? []).every((n) => n in results));
    if (idx < 0) throw new Error(`ci-plan: ${file} has a needs cycle or an unknown need`);
    const [id, job] = pending.splice(idx, 1)[0];
    const needs = [].concat(job.needs ?? []);
    for (const n of needs) if (!(n in results)) throw new Error(`ci-plan: ${file} ${id} needs unknown job ${n}`);
    // what `needs` holds on GitHub: each needed job's result and outputs; a skipped job's outputs read as ''
    const context = {
      needs: Object.fromEntries(needs.map((n) => [n, { result: results[n].ran ? "success" : "skipped", outputs: results[n].outputs }])),
      github: { event_name: "pull_request", ref: "refs/pull/0/merge" },
    };
    const allNeedsRan = needs.every((n) => results[n].ran);
    const status = { cancelled: false, always: true, success: allNeedsRan, failure: false };
    let ran;
    if (job.if === undefined) ran = allNeedsRan;
    else ran = evaluate(job.if, context, status).truthy && (usesStatus(job.if) || allNeedsRan);
    const skippedOutputs = Object.fromEntries(Object.keys(job.outputs ?? {}).map((k) => [k, ""]));
    results[id] = { ran, outputs: ran ? outputsOf(file, id, job, scope) : skippedOutputs };
    jobs[id] = { name: job.name ?? id, ran, runners: ran ? runnersOf(job, context, file) : 0 };
  }
  return { file, started: true, jobs };
}

/** the scope and every PR workflow's plan for a list of changed paths */
export function planFor(files) {
  const scope = scopeOf(files);
  return { scope, workflows: PR_WORKFLOWS.map((f) => planWorkflow(f, scope, files ?? [])) };
}

/** job ids that run, as "<workflow>:<job>" */
export const ranJobs = (plan) => plan.workflows.flatMap((w) => Object.entries(w.jobs).filter(([, j]) => j.ran).map(([id]) => `${w.file.replace(/\.yml$/, "")}:${id}`));
/** runners (jobs, a matrix counted per entry) that start */
export const runnerCount = (plan) => plan.workflows.reduce((n, w) => n + Object.values(w.jobs).reduce((m, j) => m + j.runners, 0), 0);

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  let files = args;
  if (args[0] === "--base") {
    files = execFileSync("git", ["diff", "--name-only", "--no-renames", `${args[1]}...HEAD`], { encoding: "utf8" }).split("\n").filter(Boolean);
  }
  const plan = planFor(files);
  const s = plan.scope;
  console.log(`scope: ${OUTPUTS.map((k) => `${k}=${s[k]}`).join(" ")}${s.reason ? ` (full run: ${s.reason})` : ""}`);
  for (const w of plan.workflows) {
    if (!w.started) { console.log(`${w.file}: not started (path filter)`); continue; }
    for (const [id, j] of Object.entries(w.jobs)) console.log(`${w.file}: ${j.ran ? "RUN " : "skip"} ${id}${j.runners > 1 ? ` x${j.runners}` : ""}`);
  }
  console.log(`runners started: ${runnerCount(plan)}`);
}
