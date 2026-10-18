/**
 * ADR-0167 N8 R1 (2026-10-17) — no raw error text reaches a log line or a stored
 * copy of one.
 *
 * A failed query's message is drizzle's `Failed query: …\nparams: <every bound
 * value>`, and a `SyntaxError`'s quotes what it parsed. A `console.*` or an
 * injected `log(...)` skips pino's `redact` and the `streamWrite` scrubber, and
 * a message stored in a job row or an audit `detail` is a durable copy. Twice a
 * sweep by hand missed sites (the message reached the console through an
 * injected `log`, or was stored before it was printed), so this source scan pins
 * the rule: in every non-CLI gateway module,
 *  - the generic forms `x instanceof Error ? x.message : …` (or
 *    `` `${x.name}: ${x.message}` ``) and `(x as Error).message` /
 *    `(x as Error)?.message` / `(x as { message?: … })?.message` / `(x as any).message` /
 *    `(x as Error & { … }).message` and `String(err)` are refused anywhere: an error of unknown shape goes
 *    through `safeErrorMessage` / `safeErrorText` (gateway-logger.ts);
 *  - `err.stack ?? err.message` is refused (a stack's first line is the message);
 *  - inside a `console.*(…)`, `process.std{err,out}.write(…)`, `log(…)` or
 *    `*.log.<level>(…)` call, an error's `.message` / `.stack`, `${err}` and a
 *    raw error argument are refused;
 *  - `const m = err.message` is refused (an assignment that later feeds a line).
 * A typed error whose message we wrote ourselves may be exempted with a
 * `// log-safe: <why>` comment on the line or the line above.
 *
 * CLI scripts (seed, demo, first-admin, reencrypt, key init, main) print to an
 * operator's terminal and are out of scope.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = path.dirname(fileURLToPath(import.meta.url));

const CLI = /^(?:main|first-admin|first-admin-lib|demo-[a-z-]+|seed[a-z-]*|reencrypt[a-z-]*|identity-key-init|receipt-key-init)\.ts$/;

/** every non-test, non-CLI gateway source */
function sources(): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name !== "node_modules" && e.name !== "testing") walk(p);
      } else if (
        e.name.endsWith(".ts") &&
        !e.name.endsWith(".test.ts") &&
        !e.name.endsWith(".d.ts") &&
        !CLI.test(e.name) &&
        e.name !== "gateway-logger.ts"
      ) {
        out.push(p);
      }
    }
  };
  walk(SRC);
  return out;
}

/** code only, line structure kept: a comment that quotes `err.message` is not a use */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:"'`\\])\/\/(?! log-safe:).*$/gm, "$1");
}

/** an identifier that holds a caught error */
const ERR = String.raw`(?:e|ex|err|error|cause|\w+Err|\w+Error)`;

const ANYWHERE: ReadonlyArray<readonly [string, RegExp]> = [
  // the true branch of the ternary, up to its end: catches `x.message` and the
  // template `${x.name}: ${x.message}` alike (S2)
  ["generic instanceof message", new RegExp(String.raw`\b(\w+)\s+instanceof\s+Error\s*\?[^;\n]{0,200}?\b\1\.(?:message|stack)\b`)],
  // `(e as Error).message`, `(e as Error)?.message`, `(e as { message?: string } | null)?.message` (S1),
  // `(e as any).message`, `(e as Error & { code?: string }).message` (#413 recheck L1)
  ["cast message", new RegExp(String.raw`\(\s*\w+\s+as\s+(?:Error(?:\s*&\s*\{[^}]*\})?|any|\{[^}]*\})(?:\s*\|\s*(?:null|undefined))*\s*\)\s*\??\.(?:message|stack)\b`)],
  ["stack-or-message", new RegExp(String.raw`\.stack\s*\?\?\s*\w+\.message\b`)],
  ["raw message assignment", new RegExp(String.raw`\b(?:const|let|var)\s+\w+\s*=\s*${ERR}\.message\b`)],
  // `Error.prototype.toString` is `name: message`, so `String(err)` stored in a field (`error: String(e).slice(…)`)
  // is the raw message too; in a log call it is the same leak (#413 recheck L1). `new Error(String(e))` only wraps a
  // non-Error throw into an Error value and is judged where that value is used
  ["String(err)", new RegExp(String.raw`(?<!\bnew Error\()\bString\(\s*${ERR}\s*\)`)],
];

const IN_LOG_CALL: ReadonlyArray<readonly [string, RegExp]> = [
  ["error message in a log call", new RegExp(String.raw`\b${ERR}\.(?:message|stack)\b`)],
  ["${err} in a log call", new RegExp(String.raw`\$\{\s*${ERR}\s*\}`)],
  ["raw error argument", new RegExp(String.raw`,\s*${ERR}\s*\)$`)],
];

const LOG_CALL = /(?:\bconsole\.(?:log|info|warn|error|debug|trace)|\bprocess\.std(?:err|out)\.write|(?<![\w.$])log|\.log\.(?:warn|error|info|debug|fatal|trace))\s*\(/g;

/** the text of each log call, from its name to its balanced closing paren */
function logCalls(code: string): Array<{ text: string; at: number }> {
  const out: Array<{ text: string; at: number }> = [];
  for (const m of code.matchAll(LOG_CALL)) {
    const start = m.index ?? 0;
    let depth = 0;
    let i = start + m[0].length - 1;
    for (; i < code.length; i++) {
      if (code[i] === "(") depth++;
      else if (code[i] === ")" && --depth === 0) break;
    }
    out.push({ text: code.slice(start, i + 1), at: start });
  }
  return out;
}

const lineOf = (code: string, at: number) => code.slice(0, at).split("\n").length;

function exempt(lines: string[], line: number): boolean {
  return /\/\/ log-safe:/.test(lines[line - 1] ?? "") || /\/\/ log-safe:/.test(lines[line - 2] ?? "");
}

/** `rule @ line` for every violation in one module's source */
function violations(src: string): string[] {
  const code = stripComments(src);
  const lines = code.split("\n");
  const found: string[] = [];
  for (const [name, re] of ANYWHERE) {
    for (const m of code.matchAll(new RegExp(re.source, "g"))) {
      const line = lineOf(code, m.index ?? 0);
      if (!exempt(lines, line)) found.push(`${name} @ ${line}`);
    }
  }
  for (const call of logCalls(code)) {
    for (const [name, re] of IN_LOG_CALL) {
      if (!re.test(call.text)) continue;
      const line = lineOf(code, call.at);
      if (!exempt(lines, line)) found.push(`${name} @ ${line}`);
    }
  }
  return found;
}

describe("no raw error text in a gateway log line or stored copy (ADR-0167 N8 R1)", () => {
  it("scans the gateway's modules (the scan is not vacuous)", () => {
    const names = sources().map((p) => path.relative(SRC, p).split(path.sep).join("/"));
    for (const must of ["scheduler.ts", "scheduler-health.ts", "boot.ts", "condition-metrics.ts", "review-policy.ts", "workflows.ts", "oauth/token-endpoint.ts"]) {
      expect(names).toContain(must);
    }
    expect(names).not.toContain("seed.ts");
  });

  it("no module writes or stores a raw error message", () => {
    const bad: string[] = [];
    for (const p of sources()) {
      for (const v of violations(readFileSync(p, "utf8"))) bad.push(`${path.relative(SRC, p)}: ${v}`);
    }
    expect(bad).toEqual([]);
  });

  it("negative controls: each form is caught, and the safe forms are not", () => {
    expect(violations("const m = err instanceof Error ? err.message : String(err);")).toEqual(["generic instanceof message @ 1", "String(err) @ 1"]);
    expect(violations("x = (e as Error).message;")).toEqual(["cast message @ 1"]);
    expect(violations("x = (e as Error)?.message;")).toEqual(["cast message @ 1"]);
    expect(violations("x = (e as { message?: string })?.message;")).toEqual(["cast message @ 1"]);
    expect(violations("x = (e as { message?: unknown } | null)?.message;")).toEqual(["cast message @ 1"]);
    expect(violations("const m = err instanceof Error ? `${err.name}: ${err.message}` : String(err);")).toEqual(["generic instanceof message @ 1", "String(err) @ 1"]);
    expect(violations("const m = (err instanceof Error ? `${err.name}: ${err.message}` : String(err)).slice(0, 2000);")).toEqual(["generic instanceof message @ 1", "String(err) @ 1"]);
    expect(violations("log(`boom: ${err.stack ?? err.message}`);")).toEqual(["stack-or-message @ 1", "error message in a log call @ 1"]);
    expect(violations("const message = err.message;")).toEqual(["raw message assignment @ 1"]);
    expect(violations("log(`sweep skipped — ${err.message}`);")).toEqual(["error message in a log call @ 1"]);
    expect(violations("console.error(\n  `failed: ${String(err)}`,\n);")).toEqual(["String(err) @ 2"]);
    // #413 recheck L1: a stored field, the `any` and intersection casts, and a raw stream write
    expect(violations("await db.update(jobs).set({ error: String(e).slice(0, 500) });")).toEqual(["String(err) @ 1"]);
    expect(violations("x = (err as any).message;")).toEqual(["cast message @ 1"]);
    expect(violations("x = (err as Error & { code?: string }).message;")).toEqual(["cast message @ 1"]);
    expect(violations("process.stderr.write(`boot failed: ${err.message}\\n`);")).toEqual(["error message in a log call @ 1"]);
    expect(violations("process.stdout.write(`x ${err}`);")).toEqual(["${err} in a log call @ 1"]);
    expect(violations("console.warn(`failed: ${e}`);")).toEqual(["${err} in a log call @ 1"]);
    expect(violations('console.error("failed", err)')).toEqual(["raw error argument @ 1"]);
    expect(violations("app.log.error(`x ${auditErr.message}`);")).toEqual(["error message in a log call @ 1"]);
    // safe forms
    expect(violations("console.error(`failed: ${safeErrorText(err)}`);")).toEqual([]);
    expect(violations("const m = safeErrorMessage(err);\nlog(`skipped — ${m}`);")).toEqual([]);
    expect(violations("const n = err instanceof Error ? err.name : \"unknown\";")).toEqual([]);
    expect(violations("app.log.warn({ err }, \"anchor capture failed\");")).toEqual([]);
    expect(violations("log(`             ${dataKey.message}`);")).toEqual([]);
    expect(violations("// log-safe: our own refusal text\nconst m = err.message;")).toEqual([]);
    expect(violations("// a comment quoting err.message is not a use\nconst a = 1;")).toEqual([]);
    expect(violations("throw new Error(String(reason));")).toEqual([]);
    expect(violations("return e instanceof Error ? e : new Error(String(e));")).toEqual([]);
    expect(violations("x = (err as Error & { code?: string }).code;")).toEqual([]);
    expect(violations("process.stderr.write(`boot failed: ${safeErrorText(err)}\\n`);")).toEqual([]);
  });
});
