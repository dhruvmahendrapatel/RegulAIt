import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evaluate, MAX_DAYS } from "./security-gate.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const TODAY = "2026-10-06";
const REASON = "Reachability: the vulnerable function is only called from a dev-only build script, never at run time.";

// Shapes copied from real tool output (pnpm 10.33 `pnpm audit --json` against a
// lodash 4.17.20 / minimist 1.2.5 fixture; Trivy 0.74 JSON; CodeQL 2.27 SARIF).
const audit = (...advs) => ({
  actions: [],
  advisories: Object.fromEntries(advs.map((a, i) => [String(1000 + i), a])),
  muted: [],
  metadata: { vulnerabilities: {}, dependencies: 3 },
});
const MINIMIST = { id: 1097678, github_advisory_id: "GHSA-xvch-5gv4-984h", module_name: "minimist", severity: "critical", vulnerable_versions: ">=1.0.0 <1.2.6", title: "Prototype Pollution in minimist", url: "https://github.com/advisories/GHSA-xvch-5gv4-984h" };
const MODERATE = { id: 1, github_advisory_id: "GHSA-mod0-0000-0000", module_name: "lodash", severity: "moderate" };
const entry = (over = {}) => ({ id: "GHSA-xvch-5gv4-984h", package: "minimist", reason: REASON, reviewedOn: "2026-10-01", expires: "2026-11-01", ...over });

describe("security-gate: pnpm audit", () => {
  it("passes a clean report with an empty allow-list", () => {
    const r = evaluate({ kind: "pnpm-audit", report: audit(), allowlist: { entries: [] }, today: TODAY });
    expect(r.exitCode).toBe(0);
  });

  it("RED: an unlisted HIGH/CRITICAL advisory fails the gate (vulnerable-version fixture)", () => {
    const r = evaluate({ kind: "pnpm-audit", report: audit(MINIMIST, MODERATE), allowlist: { entries: [] }, today: TODAY });
    expect(r.exitCode).toBe(1);
    expect(r.lines.join("\n")).toContain("NOT ALLOWED: GHSA-xvch-5gv4-984h");
    // moderate is below the gate: not reported as a failure
    expect(r.lines.join("\n")).not.toContain("GHSA-mod0");
  });

  it("an advisory covered by a current entry passes, and the entry is named", () => {
    const r = evaluate({ kind: "pnpm-audit", report: audit(MINIMIST), allowlist: { entries: [entry()] }, today: TODAY });
    expect(r.exitCode).toBe(0);
    expect(r.lines.join("\n")).toContain("allowed until 2026-11-01: GHSA-xvch-5gv4-984h");
  });

  it("an entry for the same advisory on a DIFFERENT package does not cover it", () => {
    const r = evaluate({ kind: "pnpm-audit", report: audit(MINIMIST), allowlist: { entries: [entry({ package: "lodash" })] }, today: TODAY });
    expect(r.exitCode).toBe(1);
    expect(r.lines.join("\n")).toMatch(/NOT ALLOWED[\s\S]*STALE/);
  });

  it("RED: an expired entry fails the gate, on its expiry day and after", () => {
    for (const today of ["2026-11-01", "2027-01-01"]) {
      const r = evaluate({ kind: "pnpm-audit", report: audit(MINIMIST), allowlist: { entries: [entry()] }, today });
      expect(r.exitCode).toBe(1);
      expect(r.lines[0]).toContain("EXPIRED allow-list entry GHSA-xvch-5gv4-984h");
    }
    expect(evaluate({ kind: "pnpm-audit", report: audit(MINIMIST), allowlist: { entries: [entry()] }, today: "2026-10-31" }).exitCode).toBe(0);
  });

  it("RED: an expired entry fails even when the advisory is gone", () => {
    const r = evaluate({ kind: "pnpm-audit", report: audit(), allowlist: { entries: [entry()] }, today: "2026-12-01" });
    expect(r.exitCode).toBe(1);
    expect(r.lines.join("\n")).toContain("EXPIRED");
  });

  it("a stale entry (matches nothing) fails: the list mirrors reality", () => {
    const r = evaluate({ kind: "pnpm-audit", report: audit(), allowlist: { entries: [entry()] }, today: TODAY });
    expect(r.exitCode).toBe(1);
    expect(r.lines[0]).toContain("STALE allow-list entry GHSA-xvch-5gv4-984h");
  });

  it("fails closed (2) on a malformed allow-list entry", () => {
    const bad = [
      { entries: "nope" },
      { entries: [entry({ reason: "unreachable" })] },
      { entries: [entry({ expires: "next month" })] },
      { entries: [entry({ package: undefined })] },
      { entries: [entry({ expires: "2026-09-01" })] },
      { entries: [entry({ reviewedOn: "2026-01-01", expires: "2026-12-31" })] },
    ];
    for (const allowlist of bad) {
      const r = evaluate({ kind: "pnpm-audit", report: audit(), allowlist, today: TODAY });
      expect(r.exitCode, JSON.stringify(allowlist)).toBe(2);
    }
    expect(MAX_DAYS).toBe(90);
  });

  it("fails closed (2) when pnpm audit itself errored or the report is not an audit", () => {
    for (const report of [{ error: { code: "ERR_PNPM_AUDIT_BAD_RESPONSE" } }, {}, null, { advisories: {} }]) {
      expect(evaluate({ kind: "pnpm-audit", report, allowlist: { entries: [] }, today: TODAY }).exitCode).toBe(2);
    }
  });
});

describe("security-gate: trivy", () => {
  const trivy = (...vulns) => ({ ArtifactName: "regulait:ci", Results: [{ Target: "app (debian 13)", Vulnerabilities: vulns }] });
  const v = (over = {}) => ({ VulnerabilityID: "CVE-2026-0001", PkgName: "perl-base", InstalledVersion: "1", FixedVersion: "2", Severity: "HIGH", ...over });

  it("RED: a fixable HIGH fails; unfixable and MEDIUM do not", () => {
    const r = evaluate({ kind: "trivy", report: trivy(v(), v({ VulnerabilityID: "CVE-2", FixedVersion: "" }), v({ VulnerabilityID: "CVE-3", Severity: "MEDIUM" })), allowlist: { entries: [] }, today: TODAY });
    expect(r.exitCode).toBe(1);
    expect(r.lines.filter((l) => l.startsWith("NOT ALLOWED"))).toEqual([expect.stringContaining("CVE-2026-0001")]);
  });

  it("an allow-listed fixable CRITICAL passes until it expires", () => {
    const allowlist = { entries: [{ id: "CVE-2026-0001", package: "perl-base", reason: REASON, reviewedOn: "2026-10-06", expires: "2026-10-20" }] };
    expect(evaluate({ kind: "trivy", report: trivy(v({ Severity: "CRITICAL" })), allowlist, today: TODAY }).exitCode).toBe(0);
    expect(evaluate({ kind: "trivy", report: trivy(v({ Severity: "CRITICAL" })), allowlist, today: "2026-10-20" }).exitCode).toBe(1);
  });

  it("a report with no Results key (nothing detected) is clean, not malformed", () => {
    expect(evaluate({ kind: "trivy", report: { ArtifactName: "x" }, allowlist: { entries: [] }, today: TODAY }).exitCode).toBe(0);
  });
});

describe("security-gate: sarif", () => {
  const sarif = (sev) => ({
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: { name: "CodeQL", rules: [] },
          extensions: [{ name: "codeql/javascript-queries", rules: [{ id: "js/sql-injection", properties: { "security-severity": sev } }] }],
        },
        results: [
          {
            ruleId: "js/sql-injection",
            rule: { id: "js/sql-injection", index: 0, toolComponent: { index: 0 } },
            message: { text: "This query depends on a user-provided value." },
            locations: [{ physicalLocation: { artifactLocation: { uri: "apps/gateway/src/x.ts" }, region: { startLine: 7 } } }],
          },
        ],
      },
    ],
  });

  it("RED: a security-severity >= 7.0 result fails; 6.9 does not", () => {
    const hi = evaluate({ kind: "sarif", report: sarif("8.8"), allowlist: { entries: [] }, today: TODAY });
    expect(hi.exitCode).toBe(1);
    expect(hi.lines[0]).toContain("js/sql-injection at apps/gateway/src/x.ts:7");
    expect(evaluate({ kind: "sarif", report: sarif("6.9"), allowlist: { entries: [] }, today: TODAY }).exitCode).toBe(0);
  });

  it("is scoped by path: an entry for another file does not cover it", () => {
    const e = { id: "js/sql-injection", path: "apps/gateway/src/x.ts", reason: REASON, reviewedOn: "2026-10-06", expires: "2026-12-01" };
    expect(evaluate({ kind: "sarif", report: sarif("8.8"), allowlist: { entries: [e] }, today: TODAY }).exitCode).toBe(0);
    expect(evaluate({ kind: "sarif", report: sarif("8.8"), allowlist: { entries: [{ ...e, path: "apps/gateway/src/y.ts" }] }, today: TODAY }).exitCode).toBe(1);
  });
});

describe("security-gate: CLI and the committed allow-lists", () => {
  const cli = (args) => {
    try {
      return { code: 0, out: execFileSync(process.execPath, [path.join(here, "security-gate.mjs"), ...args], { encoding: "utf8", stdio: "pipe" }) };
    } catch (err) {
      return { code: err.status, out: `${err.stdout}${err.stderr}` };
    }
  };

  it("the CLI exits 1 on a vulnerable report and 2 on a missing file", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "security-gate-"));
    const report = path.join(dir, "audit.json");
    const allow = path.join(dir, "allow.json");
    writeFileSync(report, JSON.stringify(audit(MINIMIST)));
    writeFileSync(allow, JSON.stringify({ entries: [] }));
    const red = cli(["--kind", "pnpm-audit", "--report", report, "--allowlist", allow, "--today", TODAY]);
    expect(red.code).toBe(1);
    expect(red.out).toContain("GATE FAILED (pnpm-audit)");
    expect(cli(["--kind", "pnpm-audit", "--report", path.join(dir, "missing.json"), "--allowlist", allow]).code).toBe(2);
    expect(cli(["--kind", "pnpm-audit"]).code).toBe(2);
  });

  it("the CLI merges several SARIF reports (one per CodeQL language) and refuses several non-SARIF reports", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "security-gate-"));
    const allow = path.join(dir, "allow.json");
    writeFileSync(allow, JSON.stringify({ entries: [] }));
    const clean = path.join(dir, "actions.sarif");
    writeFileSync(clean, JSON.stringify({ version: "2.1.0", runs: [{ tool: { driver: { name: "CodeQL", rules: [] } }, results: [] }] }));
    const hot = path.join(dir, "javascript.sarif");
    writeFileSync(hot, JSON.stringify({
      version: "2.1.0",
      runs: [{
        tool: { driver: { name: "CodeQL", rules: [{ id: "js/path-injection", properties: { "security-severity": "7.5" } }] } },
        results: [{ ruleId: "js/path-injection", locations: [{ physicalLocation: { artifactLocation: { uri: "a.ts" } } }] }],
      }],
    }));
    expect(cli(["--kind", "sarif", "--report", clean, "--allowlist", allow]).code).toBe(0);
    const red = cli(["--kind", "sarif", "--report", clean, "--report", hot, "--allowlist", allow]);
    expect(red.code).toBe(1);
    expect(red.out).toContain("NOT ALLOWED: js/path-injection");
    const audit1 = path.join(dir, "a.json");
    writeFileSync(audit1, JSON.stringify(audit()));
    expect(cli(["--kind", "pnpm-audit", "--report", audit1, "--report", audit1, "--allowlist", allow]).code).toBe(2);
  });

  it("every committed allow-list is well-formed and has no expired entry today", () => {
    for (const [kind, file] of [["pnpm-audit", "audit-allowlist.json"], ["trivy", "image-allowlist.json"], ["sarif", "sast-allowlist.json"]]) {
      const allowlist = JSON.parse(readFileSync(path.join(root, "security", file), "utf8"));
      // Evaluate against a report that holds exactly the allow-listed findings, so stale-ness is not what is tested here.
      const r = evaluate({ kind, report: kind === "pnpm-audit" ? audit() : kind === "trivy" ? { ArtifactName: "x" } : { runs: [] }, allowlist, today: new Date().toISOString().slice(0, 10) });
      expect(r.lines.join("\n")).not.toContain("GATE ERROR");
      expect(r.lines.join("\n")).not.toContain("EXPIRED");
    }
  });
});
