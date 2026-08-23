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

/** the tables the versioning layer turned into read-models, by the drizzle
 * symbol they are reachable through — `packages/db/src/schema.ts` exports no
 * other handle. The four rule tables are ADR-0073's; `agents` joined in batch
 * B1 when `agent_config` gained a dispatch-time resolver, because its
 * `model`/`costPerMTokIn`/`costPerMTokOut` columns are now versioned and a
 * bare write to them on a versioned agent would be the same silently-discarded
 * edit ADR-0074 closed for rules. */
const RULE_TABLE_SYMBOLS = ["approvalRules", "rateLimits", "dataScopeRules", "complianceProfiles", "agents"];

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
  /** how many occurrences of this exact triple are expected. Defaults to 1.
   * Present because `file|method|expr` is NOT unique — three entries carry the
   * generic expression `table` — so without a count a second writer reusing an
   * audited triple is invisible. See `foundWriterCounts`. */
  count?: number;
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
    // THREE occurrences — one per branch of `applyRuleEdit` (minted /
    // no_change / row). The count is stated because the set-based version of
    // this guard collapsed all three into one entry and would not have noticed
    // a fourth being added.
    count: 3,
    expr: "table",
    why:
      "`applyRuleEdit` — the choke point. It writes the row DIRECTLY only for columns that are not versionable " +
      "(selection/identity), or for an artifact with no version rows at all (invariant 4: byte-identical " +
      "pre-ADR-0073 behaviour). On the `mint` branch it never writes the enforcing columns — " +
      "`activateVersion`/`writeRuleReadModel` does, which is what makes 'the row agrees with the served body' " +
      "a property of the code path.",
  },
  {
    file: "rule-creates.ts",
    method: "insert",
    expr: "approvalRules",
    why:
      "`createApprovalRuleRow` — CREATE ONLY, moved out of app.ts in B8c (ADR-0056 amendment) so " +
      "POST /v1/rules/approvals and the copilot's rule_to_approval applier share ONE implementation on the " +
      "grant-revocation.ts pattern. A pure insert with a defaultRandom id and no ON CONFLICT clause " +
      "(approval_rules carries no unique constraint one could target), so the row is brand new and " +
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
    file: "compliance-packs.ts",
    method: "insert",
    expr: "complianceProfiles",
    why:
      "batch B1 `ensureCascadeProfile` — the CREATE half only, `onConflictDoNothing` on the unique tag: a " +
      "pack activation FIND-OR-CREATES its cascade profile and NEVER writes an existing one (there is no " +
      "edit fall-through here at all — an existing profile is reported 'exists_preserved' and left " +
      "untouched, because a pack activation silently replacing an admin's tuned floors would be this guard's " +
      "own defect class arriving through a wizard). A brand-new row cannot have config_versions rows, so " +
      "nothing needs minting.",
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
  // --- batch B1: the `agents` writer set (agent_config's read-model) --------
  {
    file: "config-versions.ts",
    method: "update",
    expr: "agents",
    why:
      "`activateVersion`'s agent_system_prompt read-model write — refreshes `agents.systemPrompt` from the " +
      "newly-active PROMPT version, inside the activation transaction (ADR-0074). `systemPrompt` is versioned " +
      "as its own artifact type and is deliberately NOT an agent_config field, so this writer cannot touch " +
      "the batch-B1 versioned columns (model/costPerMTokIn/costPerMTokOut); those are written only by " +
      "`writeRuleReadModel` through the VERSIONED_RULE_FIELDS filter.",
  },
  {
    file: "agents-connectors.ts",
    method: "update",
    expr: "agents",
    count: 3,
    why:
      "POST /v1/agents/:id/enabled, /owner and /lifecycle — three audited governance routes that write ONLY " +
      "`enabled`, `ownerUserId` and the three lifecycle columns. None of those is an agent_config versioned " +
      "field (the batch-B1 scope line refuses them from version bodies for exactly this reason: they are " +
      "governance gates and accountability records with their own routes, not dispatch config), so no " +
      "read-model divergence is possible. A fourth `.update(agents)` writing model or a price column must go " +
      "through `applyRuleEdit` and raises this count.",
  },
  {
    file: "agents-connectors.ts",
    method: "insert",
    expr: "agents",
    why:
      "POST /v1/agents — CREATE ONLY, `defaultRandom()` id, no ON CONFLICT: a brand-new agent cannot have an " +
      "agent_config version at the instant it is written, so the raw row is served (the same reasoning as the " +
      "three rule create routes).",
  },
  {
    file: "regulait-llm.ts",
    method: "insert",
    expr: "agents",
    why:
      "the RegulAIt-LLM bootstrap registration — CREATE ONLY, same shape as POST /v1/agents: a fresh row with " +
      "a random id and no ON CONFLICT, which cannot yet have versions.",
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
/** comments stripped, so prose describing a write (`db.update(...).set(...)` in
 * a doc block) is not mistaken for one. Strings are left alone: a table name
 * inside a string is raw SQL, which the raw-SQL assertion below already covers. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

function writesIn(raw: string): Array<{ method: "insert" | "update"; expr: string }> {
  const src = stripComments(raw);
  const imports = dbImports(src);
  const out: Array<{ method: "insert" | "update"; expr: string }> = [];
  // ADR-0074 AMENDMENT (2026-08-09) — the ARGUMENT is captured as ANY
  // expression, not as a bare identifier.
  //
  // The first cut required `([A-Za-z_$][\w$]*)`, so it could only see
  // `.update(approvalRules)` and `.update(table)`. Three ordinary shapes were
  // invisible to it — `.update(schema.complianceProfiles)` (valid: the db
  // package re-exports `schema`), `.update(RULE_TABLES[kind])`, and
  // `.update(tableFor(kind))` — and the middle one is EXACTLY the shape the
  // original ADR-0073 defect had. A scan that cannot see the shape of the bug
  // it was written for is not a guard.
  const re = /\b[A-Za-z_$][\w$]*\s*\.\s*(insert|update)\(\s*([^()]*(?:\([^()]*\))?[^()]*?)\s*\)/g;
  for (const m of src.matchAll(re)) {
    const method = m[1] as "insert" | "update";
    const expr = m[2]!.trim().replace(/\s+/g, " ");
    if (!expr) continue;
    const direct = RULE_TABLE_SYMBOLS.includes(expr);
    if (!direct) {
      // A bare identifier imported from @regulait/db that is NOT one of the
      // four is a different, statically-named table — genuinely uninteresting.
      // This is the ONLY exemption, and it requires the name to resolve.
      if (/^[A-Za-z_$][\w$]*$/.test(expr) && imports.has(expr)) continue;
      const tail = src.slice(m.index! + m[0].length, m.index! + m[0].length + 240);
      if (!/\.\s*(set|values|returning)\(/.test(tail)) continue; // not a drizzle builder
      // Everything else reaching here is an expression this scan CANNOT
      // statically resolve to a table — `schema.x`, `MAP[k]`, `f(k)`, a
      // ternary. It is pinned as if it were a rule-table write.
      //
      // FAIL CLOSED, deliberately, and for the same reason ADR-0072 inverted
      // `classifyDispatchFailure` from a deny-list to an allow-list: an
      // unrecognised thing treated as safe is a fail-OPEN in a safety check.
      // The cost of this direction is a spurious audit entry for a write that
      // turns out to be harmless; the cost of the other direction is the bug
      // this file exists to prevent, back and invisible.
    }
    out.push({ method, expr });
  }
  return out;
}

const FILES = sourceFiles(SRC);

/**
 * ADR-0074 AMENDMENT (2026-08-09) — writers are COUNTED, not set-deduplicated.
 *
 * The first cut built a Set of `file|method|expr` triples and reported the set
 * difference against the audited list. That detects a new SHAPE and is blind to
 * a new WRITER: three audited entries carry the generic expression text
 * `table`, so a SECOND `db.update(table)` added to a file that already has one
 * — say a new `PATCH /v1/rules/:kind/:id/tool-name` writing a VERSIONED field
 * through a module-local map — collided with an existing triple and passed
 * untouched. That is not a hypothetical: it is the attack an adversarial
 * verifier actually performed against this file.
 *
 * Counting closes it in both directions. An added writer raises the count and
 * fails; a removed one lowers it and fails as a stale entry, so the audit list
 * cannot rot into a wish.
 */
function foundWriterCounts(): Map<string, number> {
  const found = new Map<string, number>();
  for (const file of FILES) {
    const src = readFileSync(file, "utf8");
    for (const w of writesIn(src)) {
      const key = `${path.basename(file)}|${w.method}|${w.expr}`;
      found.set(key, (found.get(key) ?? 0) + 1);
    }
  }
  return found;
}

function auditedCounts(): Map<string, number> {
  const audited = new Map<string, number>();
  for (const w of AUDITED_WRITERS) {
    const key = `${w.file}|${w.method}|${w.expr}`;
    audited.set(key, (audited.get(key) ?? 0) + (w.count ?? 1));
  }
  return audited;
}

describe("ADR-0074 — the rule tables have an ENUMERATED writer set", () => {
  it("every direct or dynamic write against the four rule tables is audited", () => {
    const audited = auditedCounts();
    const found = foundWriterCounts();
    // An UNAUDITED writer is now either a triple nobody declared, or MORE
    // occurrences of a declared triple than were declared. The second case is
    // the one the set-based version could not see.
    const unaudited = [...found.entries()]
      .filter(([key, n]) => n > (audited.get(key) ?? 0))
      .map(([key, n]) => `${key} (found ${n}, audited ${audited.get(key) ?? 0})`)
      .sort();
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
    const found = foundWriterCounts();
    const audited = auditedCounts();
    const stale = [...audited.entries()]
      .filter(([key, n]) => n > (found.get(key) ?? 0))
      .map(([key, n]) => `${key} (audited ${n}, found ${found.get(key) ?? 0})`)
      .sort();
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

  it("no raw SQL statement writes the watched tables behind the ORM's back", () => {
    const offenders: string[] = [];
    const tables = ["approval_rules", "rate_limits", "data_scope_rules", "compliance_profiles", "agents"];
    for (const file of FILES) {
      // batch B1: comments stripped, exactly as `writesIn` already does — two
      // files carry the historical sentence "used to be a straight `UPDATE
      // agents SET system_prompt`" in a doc block, and prose about a write is
      // not a write. Raw SQL lives in sql`` template strings, which survive
      // the strip.
      const src = stripComments(readFileSync(file, "utf8"));
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
