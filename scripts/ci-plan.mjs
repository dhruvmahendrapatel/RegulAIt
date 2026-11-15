#!/usr/bin/env node
// ADR-0323: a dry run of what a pull_request runs. It reads the real workflow files and evaluates each job's `if:`
// (and the scope-dependent matrices) against the scope that scripts/ci-scope.mjs gives for a list of changed paths,
// so the job selection is the workflows' own, not a copy of it.
//
// It understands the subset of the GitHub expression language our workflows use: string and number literals,
// `needs.<job>.outputs.<name>` and `needs.<job>.result`, `github.event_name` and `github.ref`, `!`, `&&`, `||`, `==`,
// `!=`, parentheses, `fromJSON()`, and the status functions (`!cancelled()`, `always()`, `success()`, `failure()`).
// Anything else throws, so a new construct is a visible failure of the dry run, not a silent wrong answer.
// Workflow-level `paths:` / `paths-ignore:` filters are applied with node's path.matchesGlob.
//
// usage: node scripts/ci-plan.mjs <changed path>...        print the scope and the jobs a PR with those changes runs
//        node scripts/ci-plan.mjs --base origin/main       the same for this branch's diff against a ref
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { scopeOf } from "./ci-scope.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** the workflows a pull_request can start, in the order they are reported */
export const PR_WORKFLOWS = Object.freeze([
  "ci.yml", "ui-enterprise.yml", "security.yml", "import-cycles.yml", "integrations.yml", "client-compat.yml",
  "endpoint-agent.yml", "engine-images-build.yml", "operator.yml",
]);

// ── the expression subset ───────────────────────────────────────────────────
const TOKEN = /\s*(?:(\$\{\{|\}\})|('(?:[^']|'')*')|(-?\d+(?:\.\d+)?)|(&&|\|\||==|!=|[!(),])|([A-Za-z_][A-Za-z0-9_.-]*))/y;

function tokenize(src) {
  const out = [];
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < src.length) {
    if (/^\s*$/.test(src.slice(TOKEN.lastIndex))) break;
    const m = TOKEN.exec(src);
    if (!m) throw new Error(`ci-plan: cannot read the expression at "${src.slice(TOKEN.lastIndex)}"`);
    if (m[1]) continue; // the ${{ }} wrapper
    if (m[2]) out.push({ t: "lit", v: m[2].slice(1, -1).replace(/''/g, "'") });
    else if (m[3]) out.push({ t: "lit", v: Number(m[3]) });
    else if (m[4]) out.push({ t: m[4] });
    else out.push({ t: "id", v: m[5] });
  }
  return out;
}

const truthy = (v) => !(v === false || v === 0 || v === "" || v === null || v === undefined || Number.isNaN(v));
/** GitHub's loose equality: strings compare case-insensitively; a string and a number compare as numbers */
function eq(a, b) {
  if (typeof a === "string" && typeof b === "string") return a.toLowerCase() === b.toLowerCase();
  if (typeof a === "number" || typeof b === "number") return Number(a) === Number(b);
  return a === b;
}

/** evaluate an expression; ctx.lookup(name) resolves identifiers, ctx.status(fn) the status functions */
export function evaluate(src, ctx) {
  const toks = tokenize(String(src));
  let i = 0;
  const peek = () => toks[i];
  const take = (t) => {
    if (toks[i]?.t !== t) throw new Error(`ci-plan: expected ${t} in "${src}"`);
    return toks[i++];
  };
  const or = () => {
    let v = and();
    while (peek()?.t === "||") { i++; const r = and(); v = truthy(v) ? v : r; }
    return v;
  };
  const and = () => {
    let v = cmp();
    while (peek()?.t === "&&") { i++; const r = cmp(); v = truthy(v) ? r : v; }
    return v;
  };
  const cmp = () => {
    let v = unary();
    while (peek()?.t === "==" || peek()?.t === "!=") {
      const op = toks[i++].t;
      const r = unary();
      v = op === "==" ? eq(v, r) : !eq(v, r);
    }
    return v;
  };
  const unary = () => {
    if (peek()?.t === "!") { i++; return !truthy(unary()); }
    return primary();
  };
  const primary = () => {
    const tok = toks[i++];
    if (!tok) throw new Error(`ci-plan: unexpected end of "${src}"`);
    if (tok.t === "lit") return tok.v;
    if (tok.t === "(") { const v = or(); take(")"); return v; }
    if (tok.t === "id" && peek()?.t === "(") {
      i++;
      const args = [];
      while (peek()?.t !== ")") { args.push(or()); if (peek()?.t === ",") i++; }
      take(")");
      if (tok.v === "fromJSON") return JSON.parse(args[0]);
      if (["cancelled", "always", "success", "failure"].includes(tok.v)) return ctx.status(tok.v);
      throw new Error(`ci-plan: unsupported function ${tok.v}() in "${src}"`);
    }
    if (tok.t === "id") {
      if (tok.v === "true") return true;
      if (tok.v === "false") return false;
      return ctx.lookup(tok.v);
    }
    throw new Error(`ci-plan: unexpected ${tok.t} in "${src}"`);
  };
  const v = or();
  if (i !== toks.length) throw new Error(`ci-plan: trailing tokens in "${src}"`);
  return v;
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
function runnersOf(job, lookup, file) {
  if (job.uses) {
    // a reusable workflow in this repository: the sum of its jobs' runners
    const called = yaml.load(readFileSync(path.join(repo, job.uses.replace(/^\.\//, "")), "utf8"));
    return Object.values(called.jobs).reduce((n, j) => n + runnersOf(j, lookup, file), 0);
  }
  const matrix = job.strategy?.matrix;
  if (!matrix) return 1;
  if (typeof matrix === "string") return [].concat(evaluate(matrix, { lookup, status: () => true })).length;
  return Object.entries(matrix)
    .filter(([k]) => k !== "include" && k !== "exclude")
    .reduce((n, [, v]) => n * (typeof v === "string" ? [].concat(evaluate(v, { lookup, status: () => true })).length : v.length), 1);
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
    const lookup = (name) => {
      const m = /^needs\.([A-Za-z0-9_-]+)\.(outputs\.([A-Za-z0-9_-]+)|result)$/.exec(name);
      if (m) {
        if (!needs.includes(m[1])) throw new Error(`ci-plan: ${file} ${id} reads needs.${m[1]} without needing it`);
        const r = results[m[1]];
        return m[3] ? (r.ran ? (r.outputs[m[3]] ?? "") : "") : (r.ran ? "success" : "skipped");
      }
      if (name === "github.event_name") return "pull_request";
      if (name === "github.ref") return "refs/pull/0/merge";
      throw new Error(`ci-plan: ${file} ${id} reads ${name}, which the dry run does not model`);
    };
    const allNeedsRan = needs.every((n) => results[n].ran);
    const status = (fn) => ({ cancelled: false, always: true, success: allNeedsRan, failure: false })[fn];
    let ran;
    if (job.if === undefined) ran = allNeedsRan;
    else ran = truthy(evaluate(job.if, { lookup, status })) && (usesStatus(job.if) || allNeedsRan);
    results[id] = { ran, outputs: ran ? outputsOf(file, id, job, scope) : {} };
    jobs[id] = { name: job.name ?? id, ran, runners: ran ? runnersOf(job, lookup, file) : 0 };
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
  console.log(`scope: ${["full", "code", "web", "image", "engines", "gateway"].map((k) => `${k}=${s[k]}`).join(" ")}${s.reason ? ` (full run: ${s.reason})` : ""}`);
  for (const w of plan.workflows) {
    if (!w.started) { console.log(`${w.file}: not started (path filter)`); continue; }
    for (const [id, j] of Object.entries(w.jobs)) console.log(`${w.file}: ${j.ran ? "RUN " : "skip"} ${id}${j.runners > 1 ? ` x${j.runners}` : ""}`);
  }
  console.log(`runners started: ${runnerCount(plan)}`);
}
