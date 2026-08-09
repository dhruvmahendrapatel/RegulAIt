import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * ADR-0074 — THE STRUCTURAL GUARD.
 *
 * The defect ADR-0074 fixes was not "three handlers had a bug". It was that the
 * four rule tables acquired a SECOND CLASS OF WRITER when ADR-0073 turned them
 * into read-models, and nothing in the codebase prevented a third from
 * appearing. Three handlers were fixed; this file is what stops the fourth.
 *
 * WHY IT IS A SOURCE SCAN AND NOT A RUNTIME ASSERTION. The failure mode is a
 * write that SUCCEEDS and is silently discarded at dispatch — there is no
 * exception to catch, no row to inspect afterwards that looks wrong, and the
 * only artefact is the absence of a `config_versions` row nobody thought to
 * look for. A runtime check would have to be added by the same person who
 * forgot to mint the version. A build-time enumeration does not depend on the
 * author remembering anything: adding a writer makes this test red.
 *
 * WHY IT ENUMERATES EXPRESSIONS RATHER THAN TABLE IDENTIFIERS. The worst writer
 * of the original set — the deploy-mode PATCH — went through a module-local
 * `RULE_TABLES` map, so `db.update(table)`. A `.update(approvalRules)` grep
 * misses it entirely. This scans every `.insert(EXPR)` / `.update(EXPR)` in
 * every file that so much as MENTIONS one of the four tables, and pins the
 * whole (file, method, expression) set. A write through a variable, an alias, a
 * new map or a helper all show up as a new triple.
 *
 * WHAT IT DELIBERATELY DOES NOT PROVE. It does not prove a listed writer is
 * correct — it proves the list is complete and that every entry was looked at
 * by a human who wrote down why it is safe. Correctness is
 * `rule-write-versioning.test.ts`'s job, and it asserts through the kernel.
 */

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)));

/** the four tables ADR-0073 turned into read-models, by the drizzle symbol they
 * are reachable through — `packages/db/src/schema.ts` exports no other handle */
const RULE_TABLE_SYMBOLS = ["approvalRules", "rateLimits", "dataScopeRules", "complianceProfiles"];

/**
 * THE AUDITED WRITER SET. Every entry states, in the `why`, what makes that
 * write safe under ADR-0074. Adding an entry without a reason is possible and
 * pointless: the reason is the whole artefact this test produces.
 *
 * `expr` is the literal argument text of the `.insert(` / `.update(` call.
 */
interface AuditedWriter {
  file: string;
  method: "insert" | "update";
  expr: string;
  why: string;
}

const AUDITED_WRITERS: AuditedWriter[] = [
  {
    file: "config-versions.ts",
    method: "update",
    expr: "table",
    why:
      "`writeRuleReadModel` — THE canonical writer. It filters the body through VERSIONED_RULE_FIELDS (so it " +
      "can never touch a selection or identity column) and runs only inside `activateVersion`'s transaction, " +
      "after the demote-prev / promote-target / ledger writes. Every other writer's job is to produce a call " +
      "to this one rather than to write a row itself.",
  },
  {
    file: "rule-writes.ts",
    method: "update",
    expr: "table",
    why:
      "`applyRuleEdit` — the choke point. It writes the row DIRECTLY only for columns that are not versionable " +
      "(selection/identity), or for an artifact with no version rows at all (invariant 4: byte-identical " +
      "pre-ADR-0073 behaviour). On the `mint` branch it never writes the enforcing columns — " +
      "`activateVersion`/`writeRuleReadModel` does, which is what makes 'the row agrees with the served body' " +
      "a property of the code path.",
  },
  {
    file: "app.ts",
    method: "insert",
    expr: "approvalRules",
    why:
      "POST /v1/rules/approvals — CREATE ONLY. A pure insert with a defaultRandom id and no ON CONFLICT " +
      "clause (approval_rules carries no unique constraint one could target), so the row is brand new and " +
      "cannot have a config_versions row at the instant it is written: resolveForShadow returns served=null " +
      "and the raw row is served. `create-only routes stay create-only` is pinned by " +
      "rule-write-versioning.test.ts; if this ever gains an upsert or an edit sibling it must go through " +
      "applyRuleEdit.",
  },
  {
    file: "app.ts",
    method: "insert",
    expr: "dataScopeRules",
    why: "POST /v1/rules/data-scopes — CREATE ONLY, identical reasoning to the approvals insert above.",
  },
  {
    file: "app.ts",
    method: "insert",
    expr: "rateLimits",
    why: "POST /v1/rules/rate-limits — CREATE ONLY, identical reasoning to the approvals insert above.",
  },
  {
    file: "projects.ts",
    method: "insert",
    expr: "complianceProfiles",
    why:
      "POST /v1/compliance/profiles — the CREATE half only. ADR-0074 split the old onConflictDoUpdate into " +
      "`onConflictDoNothing` (a genuine create, which cannot have versions) plus an explicit edit path through " +
      "applyRuleEdit. The DoNothing is what closes the race: a concurrent create makes this statement return " +
      "nothing and the request falls through to the edit path instead of clobbering it.",
  },
  {
    file: "onboarding.ts",
    method: "insert",
    expr: "complianceProfiles",
    why:
      "POST /v1/onboarding/compliance-pack — the CREATE half only, split the same way as the profiles route. " +
      "A pack RE-APPLY over an existing profile goes through applyRuleEdit, which is what makes the wizard's " +
      "documented idempotence honest rather than a silent overwrite of a versioned profile.",
  },
  {
    file: "org-settings.ts",
    method: "update",
    expr: "table",
    why:
      "PATCH /v1/revocations/:kind/:id/scope, through the module-local REVOCATION_TABLES map. It targets " +
      "`revocations` / `connectorRevocations`, NOT a rule table — neither is versioned by ADR-0048/0073, so " +
      "there is no read-model to diverge. Listed because the scan cannot tell which table a dynamic reference " +
      "resolves to, and a human confirming that is the entire point of the list. If a revocation type is ever " +
      "versioned, this becomes a defect of the same shape and must move to applyRuleEdit.",
  },
];

// ---------------------------------------------------------------------------

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "dist" || name === "node_modules") continue;
      out.push(...sourceFiles(p));
      continue;
    }
    if (!name.endsWith(".ts")) continue;
    if (name.endsWith(".test.ts")) continue; // fixtures, not product code — see the ADR
    out.push(p);
  }
  return out;
}

/** the identifiers a file imports from `@regulait/db` — i.e. the drizzle table
 * symbols it can name STATICALLY. Anything else passed to `.insert`/`.update`
 * is a DYNAMIC table reference, which is how the original defect hid. */
function dbImports(src: string): Set<string> {
  const out = new Set<string>();
  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*"@regulait\/db"/gs)) {
    for (const raw of m[1]!.split(",")) {
      const name = raw.trim().split(/\s+as\s+/).pop()?.trim();
      if (name) out.add(name.replace(/^type\s+/, ""));
    }
  }
  return out;
}

/**
 * Every drizzle write in a file, as (method, expression). Two categories are
 * collected and both are pinned:
 *
 *   DIRECT   `.insert(approvalRules)` — one of the four, named outright.
 *   DYNAMIC  `.insert(table)` — an expression this scan CANNOT resolve to a
 *            table. Pinned regardless of which table it turns out to be,
 *            because a human confirming which one is exactly the check that was
 *            missing: `PATCH /v1/rules/:kind/:id/deploy-mode` wrote through a
 *            module-local map and a `.update(approvalRules)` grep never saw it.
 *
 * The `.set(` / `.values(` / `.returning(` lookahead is what separates a drizzle
 * builder from `hash.update(bytes)`.
 */
function writesIn(src: string): Array<{ method: "insert" | "update"; expr: string }> {
  const imports = dbImports(src);
  const out: Array<{ method: "insert" | "update"; expr: string }> = [];
  const re = /\b[A-Za-z_$][\w$]*\s*\.\s*(insert|update)\(\s*([A-Za-z_$][\w$]*)\s*\)/g;
  for (const m of src.matchAll(re)) {
    const method = m[1] as "insert" | "update";
    const expr = m[2]!;
    const direct = RULE_TABLE_SYMBOLS.includes(expr);
    if (!direct) {
      if (imports.has(expr)) continue; // a different, statically-named table
      const tail = src.slice(m.index! + m[0].length, m.index! + m[0].length + 240);
      if (!/\.\s*(set|values|returning)\(/.test(tail)) continue; // not a drizzle builder
    }
    out.push({ method, expr });
  }
  return out;
}

const FILES = sourceFiles(SRC);

function foundWriters(): Set<string> {
  const found = new Set<string>();
  for (const file of FILES) {
    const src = readFileSync(file, "utf8");
    for (const w of writesIn(src)) found.add(`${path.basename(file)}|${w.method}|${w.expr}`);
  }
  return found;
}

describe("ADR-0074 — the rule tables have an ENUMERATED writer set", () => {
  it("every direct or dynamic write against the four rule tables is audited", () => {
    const audited = new Set(AUDITED_WRITERS.map((w) => `${w.file}|${w.method}|${w.expr}`));
    const unaudited = [...foundWriters()].filter((f) => !audited.has(f)).sort();
    expect(
      unaudited,
      "A NEW WRITE against one of the four rule tables — or through a table reference this scan cannot " +
        "resolve — appeared. ADR-0073 made those tables a READ-MODEL: a write to a VERSIONED column that does " +
        "not mint a version is SILENTLY DISCARDED at dispatch, and the admin is shown their edit anyway. Route " +
        "it through `applyRuleEdit` (apps/gateway/src/rule-writes.ts), then add it to AUDITED_WRITERS with the " +
        "reason it is safe.",
    ).toEqual([]);
  });

  it("...and every audited entry still exists, so the list cannot rot into a wish", () => {
    const found = foundWriters();
    const stale = AUDITED_WRITERS.filter((w) => !found.has(`${w.file}|${w.method}|${w.expr}`)).map(
      (w) => `${w.file}|${w.method}|${w.expr}`,
    );
    expect(stale, "an audited writer no longer exists — delete its entry rather than leaving a stale claim").toEqual(
      [],
    );
  });

  it("every audited entry states WHY it is safe — an entry with no reason is not an audit", () => {
    for (const w of AUDITED_WRITERS) {
      expect(w.why.length, `${w.file}|${w.expr} has no stated reason`).toBeGreaterThan(80);
    }
  });

  it("the four tables are never imported under an ALIAS, which would defeat the scan", () => {
    const aliased: string[] = [];
    const re = new RegExp(`\\b(${RULE_TABLE_SYMBOLS.join("|")})\\s+as\\s+`, "g");
    for (const file of FILES) {
      const src = readFileSync(file, "utf8");
      if (re.test(src)) aliased.push(path.basename(file));
      re.lastIndex = 0;
    }
    expect(aliased).toEqual([]);
  });

  it("no raw SQL statement writes the four tables behind the ORM's back", () => {
    const offenders: string[] = [];
    const tables = ["approval_rules", "rate_limits", "data_scope_rules", "compliance_profiles"];
    for (const file of FILES) {
      const src = readFileSync(file, "utf8");
      for (const t of tables) {
        const re = new RegExp(`(insert\\s+into|update)\\s+${t}\\b`, "i");
        if (re.test(src)) offenders.push(`${path.basename(file)}:${t}`);
      }
    }
    expect(
      offenders,
      "a raw SQL write to a rule table bypasses `applyRuleEdit` entirely and cannot be versioned",
    ).toEqual([]);
  });

  it("the choke point is the only module that imports `newVersion` for a RULE artifact type", () => {
    // `newVersion` itself is legitimately imported by the config-version routes
    // and by the agent system-prompt route (a non-rule artifact). Any OTHER
    // importer is a second minting path, which is how the class comes back.
    const importers = FILES.filter((f) => /import\s*{[^}]*\bnewVersion\b[^}]*}\s*from\s*"\.\/config-versions\.js"/.test(readFileSync(f, "utf8")))
      .map((f) => path.basename(f))
      .sort();
    expect(importers).toEqual(["agents-connectors.ts", "rule-writes.ts"]);
  });
});
