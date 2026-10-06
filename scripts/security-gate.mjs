#!/usr/bin/env node
// =============================================================================
// security-gate.mjs — the allow-list gate behind security.yml (ADR-0184)
//
// One gate for three scanners. Each scanner writes its own JSON report; this
// script reads it, keeps the findings at or above the gate's threshold, and
// FAILS unless every one of them is covered by a reviewed allow-list entry
// that has not expired. It also fails on an allow-list entry that covers
// nothing (a stale entry is a hole someone will later fall through) and on a
// malformed allow-list or an unreadable report (fail closed, never open).
//
//   --kind pnpm-audit   `pnpm audit --json` output; HIGH and CRITICAL count.
//   --kind trivy        `trivy image|fs --format json`; HIGH and CRITICAL that
//                       have a fixed version count (unfixable ones cannot be
//                       acted on and are reported, not gated).
//   --kind sarif        SARIF 2.1.0 (CodeQL); a result counts when its rule's
//                       `security-severity` is >= 7.0 (GitHub's "high").
//                       `--report` may repeat (one SARIF per language).
//
// Allow-list file (JSON):
//   { "entries": [ { "id": "GHSA-…" | "CVE-…" | "js/…",
//                    "package": "name"   (pnpm-audit, trivy)  — or —
//                    "path": "repo/relative/file.ts" (sarif),
//                    "reason": "the reachability argument, in full",
//                    "reviewedOn": "YYYY-MM-DD",
//                    "expires": "YYYY-MM-DD" } ] }
// `expires` is at most MAX_DAYS after `reviewedOn`: an exception is re-argued,
// not renewed by default. The day an entry expires, the gate fails.
//
// Exit codes: 0 pass; 1 a finding is not allowed, or an entry is expired or
// stale; 2 the report or the allow-list could not be read or is malformed.
// The open-source search (ADR-0176) for this: Trivy's .trivyignore.yaml has an
// `expired_at`, but an expired entry there silently stops ignoring rather than
// failing, pnpm has `auditConfig.ignoreGhsas` with no expiry or reason, and
// CodeQL has no expiring baseline; none fails on a stale or expired exception,
// which is the property this gate exists for. The parsing is the scanners' own.
// =============================================================================
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const MAX_DAYS = 90;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MIN_REASON = 40;

/** UTC calendar day as YYYY-MM-DD. */
export function isoDay(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

function dayNumber(s) {
  return Math.floor(Date.parse(`${s}T00:00:00Z`) / 86_400_000);
}

class GateInputError extends Error {}

/** Findings at or above the gate threshold, as {id, scope, detail}. */
export function findingsFrom(kind, report) {
  if (report === null || typeof report !== "object") throw new GateInputError("report is not a JSON object");
  if (kind === "pnpm-audit") {
    if (report.error) throw new GateInputError(`pnpm audit reported an error: ${JSON.stringify(report.error)}`);
    if (!report.advisories || typeof report.advisories !== "object" || !report.metadata) {
      throw new GateInputError("not a pnpm audit report (no advisories/metadata)");
    }
    return Object.values(report.advisories)
      .filter((a) => a.severity === "high" || a.severity === "critical")
      .map((a) => ({
        id: a.github_advisory_id || String(a.id),
        scope: a.module_name,
        detail: `${a.severity} ${a.module_name} ${a.vulnerable_versions ?? ""} — ${a.title ?? ""} ${a.url ?? ""}`.trim(),
      }));
  }
  if (kind === "trivy") {
    if (!("Results" in report) && !("ArtifactName" in report)) throw new GateInputError("not a Trivy JSON report");
    const out = [];
    for (const r of report.Results ?? []) {
      for (const v of r.Vulnerabilities ?? []) {
        if (v.Severity !== "HIGH" && v.Severity !== "CRITICAL") continue;
        if (!v.FixedVersion) continue;
        out.push({
          id: v.VulnerabilityID,
          scope: v.PkgName,
          detail: `${v.Severity} ${v.PkgName} ${v.InstalledVersion} -> ${v.FixedVersion} in ${r.Target}${v.PkgPath ? ` (${v.PkgPath})` : ""}`,
        });
      }
    }
    return out;
  }
  if (kind === "sarif") {
    if (!Array.isArray(report.runs)) throw new GateInputError("not a SARIF report (no runs[])");
    const out = [];
    for (const run of report.runs) {
      if (!run || typeof run !== "object") throw new GateInputError("a SARIF run is not an object");
      const rules = new Map();
      const components = [run.tool?.driver, ...(run.tool?.extensions ?? [])];
      for (const c of components) for (const rule of c?.rules ?? []) rules.set(rule.id, rule);
      for (const res of run.results ?? []) {
        const ruleId = res.ruleId ?? res.rule?.id;
        let rule = rules.get(ruleId);
        if (!rule && res.rule?.toolComponent?.index !== undefined && res.rule?.index !== undefined) {
          rule = components[res.rule.toolComponent.index + 1]?.rules?.[res.rule.index];
        }
        const sev = Number.parseFloat(rule?.properties?.["security-severity"] ?? "");
        if (!(sev >= 7.0)) continue;
        const loc = res.locations?.[0]?.physicalLocation;
        const path = loc?.artifactLocation?.uri ?? "(no location)";
        out.push({
          id: ruleId,
          scope: path,
          detail: `security-severity ${sev} ${ruleId} at ${path}:${loc?.region?.startLine ?? "?"} — ${res.message?.text ?? ""}`,
        });
      }
    }
    return out;
  }
  throw new GateInputError(`unknown --kind ${kind}`);
}

/** Validates the allow-list shape; throws GateInputError on the first problem. */
export function validateAllowlist(kind, allowlist) {
  if (!allowlist || !Array.isArray(allowlist.entries)) throw new GateInputError("allow-list has no entries[] array");
  const scopeKey = kind === "sarif" ? "path" : "package";
  allowlist.entries.forEach((e, i) => {
    const where = `allow-list entry #${i + 1} (${e?.id ?? "no id"})`;
    if (!e || typeof e !== "object") throw new GateInputError(`${where}: not an object`);
    if (typeof e.id !== "string" || !e.id) throw new GateInputError(`${where}: id is required`);
    if (typeof e[scopeKey] !== "string" || !e[scopeKey]) throw new GateInputError(`${where}: ${scopeKey} is required for --kind ${kind}`);
    if (typeof e.reason !== "string" || e.reason.trim().length < MIN_REASON) {
      throw new GateInputError(`${where}: reason must state the reachability argument (at least ${MIN_REASON} characters)`);
    }
    for (const k of ["reviewedOn", "expires"]) {
      if (typeof e[k] !== "string" || !DATE.test(e[k]) || Number.isNaN(Date.parse(`${e[k]}T00:00:00Z`))) {
        throw new GateInputError(`${where}: ${k} must be a YYYY-MM-DD date`);
      }
    }
    const span = dayNumber(e.expires) - dayNumber(e.reviewedOn);
    if (span <= 0) throw new GateInputError(`${where}: expires must be after reviewedOn`);
    if (span > MAX_DAYS) throw new GateInputError(`${where}: expires is ${span} days after reviewedOn; the most is ${MAX_DAYS}`);
  });
  return scopeKey;
}

/**
 * The gate decision. Pure: no I/O, `today` injected.
 * @returns {{ exitCode: 0|1|2, lines: string[] }}
 */
export function evaluate({ kind, report, allowlist, today = isoDay() }) {
  const lines = [];
  let findings;
  let scopeKey;
  try {
    findings = findingsFrom(kind, report);
    scopeKey = validateAllowlist(kind, allowlist);
  } catch (err) {
    if (err instanceof GateInputError) return { exitCode: 2, lines: [`GATE ERROR (${kind}): ${err.message}`] };
    throw err;
  }
  const entries = allowlist.entries;
  const used = new Set();
  const failures = [];
  const todayN = dayNumber(today);

  entries.forEach((e, i) => {
    if (dayNumber(e.expires) <= todayN) {
      failures.push(`EXPIRED allow-list entry ${e.id} (${scopeKey} ${e[scopeKey]}) expired on ${e.expires}: re-review it and set a new expiry, or fix the finding`);
      used.add(i); // reported once, as expired, not again as stale
    }
  });

  for (const f of findings) {
    const idx = entries.findIndex((e) => e.id === f.id && e[scopeKey] === f.scope);
    if (idx === -1) {
      failures.push(`NOT ALLOWED: ${f.id} — ${f.detail}`);
      continue;
    }
    used.add(idx);
    if (dayNumber(entries[idx].expires) > todayN) {
      lines.push(`allowed until ${entries[idx].expires}: ${f.id} (${f.scope})`);
    }
  }

  entries.forEach((e, i) => {
    if (!used.has(i)) failures.push(`STALE allow-list entry ${e.id} (${scopeKey} ${e[scopeKey]}) matches no current finding: remove it`);
  });

  lines.push(`${kind}: ${findings.length} finding(s) at the gate threshold, ${entries.length} allow-list entr${entries.length === 1 ? "y" : "ies"}, ${failures.length} failure(s)`);
  if (failures.length) return { exitCode: 1, lines: [...failures, ...lines, `GATE FAILED (${kind})`] };
  return { exitCode: 0, lines: [...lines, `GATE PASSED (${kind})`] };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i];
    if (!k?.startsWith("--") || argv[i + 1] === undefined) throw new GateInputError(`bad argument near ${k}`);
    if (k === "--report") (out.reports ??= []).push(argv[i + 1]);
    else out[k.slice(2)] = argv[i + 1];
  }
  out.report = out.reports?.[0];
  for (const k of ["kind", "report", "allowlist"]) if (!out[k]) throw new GateInputError(`--${k} is required`);
  if (out.today !== undefined && !DATE.test(out.today)) throw new GateInputError("--today must be YYYY-MM-DD");
  return out;
}

function readJson(path, what) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new GateInputError(`cannot read ${what} ${path}: ${err.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new GateInputError(`${what} ${path} is not JSON: ${err.message}`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let result;
  try {
    const args = parseArgs(process.argv.slice(2));
    const reports = args.reports.map((r) => readJson(r, "report"));
    if (reports.length > 1 && args.kind !== "sarif") throw new GateInputError("only --kind sarif takes more than one --report");
    // several SARIF files (one per CodeQL language) are one report with all their runs
    const report = reports.length === 1 ? reports[0] : { runs: reports.flatMap((r) => (Array.isArray(r?.runs) ? r.runs : [null])) };
    result = evaluate({
      kind: args.kind,
      report,
      allowlist: readJson(args.allowlist, "allow-list"),
      today: args.today ?? isoDay(),
    });
  } catch (err) {
    if (!(err instanceof GateInputError)) throw err;
    result = { exitCode: 2, lines: [`GATE ERROR: ${err.message}`] };
  }
  for (const l of result.lines) (result.exitCode ? console.error : console.log)(l);
  process.exit(result.exitCode);
}
