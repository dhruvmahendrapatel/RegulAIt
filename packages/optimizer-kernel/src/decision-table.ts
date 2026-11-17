/**
 * ADR-0327 addendum (decision tables): a person writes a simple table of
 * conditions and outcomes; it compiles to the SAME exact-match rule the
 * detector induces (`InducedRule`), so `applyInducedRule` and `tallyShadow`
 * run it unchanged. There is no second engine and no expression language:
 * a condition is one value or a short list of values for a field, a row's
 * outcome is a fixed string, and an input the table does not cover falls
 * back to the AI, exactly as an induced rule does.
 *
 * Open source (ADR-0176, compared in the slice's PR): DMN evaluators
 * (`@hbtgmbh/dmn-eval-js`, `js-feel`) are stale with open advisories,
 * `json-rules-engine` is outside the maintenance window and evaluates rules at
 * runtime, and GoRules ZEN evaluates its own expression language in a native
 * binary. None compiles to an exact-match lookup, which is the property this
 * engine exists for, so the compiler is ours (a list expansion and an overlap
 * check). DMN XML import/export through `dmn-moddle` (MIT) can map onto this
 * shape later.
 *
 * Pure and zero-I/O: the shape is validated by the gateway's zod schema first;
 * this function re-checks the limits it relies on and reports every problem,
 * so a business user sees all of them at once.
 */
import {
  RULE_INDUCTION_CEILINGS,
  normalizeStepOutput,
  type FieldValue,
  type InducedRule,
  type RuleCell,
} from "./rule-induction.js";

/** one condition: a single value, or any of a short list of values */
export type DecisionCondition = FieldValue | readonly FieldValue[];

export interface DecisionRow {
  /** one condition per table field, keyed by field name; every field must be given */
  when: Readonly<Record<string, DecisionCondition>>;
  then: string;
}

export interface DecisionTableBody {
  /** the input fields the table keys on (same names `extractStepFields` produces, e.g. `ticket.severity`) */
  fields: readonly string[];
  rows: readonly DecisionRow[];
}

export const DECISION_TABLE_LIMITS = Object.freeze({
  maxFields: RULE_INDUCTION_CEILINGS.maxFields,
  maxRows: 200,
  maxValuesPerCondition: 20,
  /** the compiled table is held to the detector's cell ceiling, so both run at the same bounded cost */
  maxCells: RULE_INDUCTION_CEILINGS.maxCells,
  maxOutputLength: 200,
});

export type DecisionTableProblem =
  | { code: "no_fields" | "too_many_fields" | "duplicate_field" | "no_rows" | "too_many_rows" | "too_many_cells"; detail: string }
  | { code: "missing_condition" | "unknown_field" | "empty_condition" | "too_many_values" | "invalid_value"; row: number; field: string; detail: string }
  | { code: "empty_outcome" | "outcome_too_long"; row: number; detail: string }
  | { code: "duplicate_row" | "conflicting_rows"; row: number; otherRow: number; detail: string };

export type DecisionTableCompilation =
  | { ok: true; rule: InducedRule; rows: number; cells: number }
  | { ok: false; problems: DecisionTableProblem[] };

const MAX_PROBLEMS = 50;

/**
 * Compile a table to an exact-match rule. Hit policy is UNIQUE (DMN's term):
 * each input combination is covered by at most one row. Two rows covering the
 * same combination are refused, with the same outcome (`duplicate_row`) or a
 * different one (`conflicting_rows`), so a published table never depends on
 * row order.
 */
export function compileDecisionTable(table: DecisionTableBody): DecisionTableCompilation {
  const problems: DecisionTableProblem[] = [];
  const add = (p: DecisionTableProblem) => {
    if (problems.length < MAX_PROBLEMS) problems.push(p);
  };
  const L = DECISION_TABLE_LIMITS;

  if (table.fields.length === 0) add({ code: "no_fields", detail: "a table needs at least one input field" });
  if (table.fields.length > L.maxFields) add({ code: "too_many_fields", detail: `at most ${L.maxFields} input fields` });
  if (new Set(table.fields).size !== table.fields.length) add({ code: "duplicate_field", detail: "each input field is listed once" });
  if (table.rows.length === 0) add({ code: "no_rows", detail: "a table needs at least one row" });
  if (table.rows.length > L.maxRows) add({ code: "too_many_rows", detail: `at most ${L.maxRows} rows` });
  if (problems.length > 0) return { ok: false, problems };

  // the kernel's key order is the sorted field list (InducedRule.fields is sorted)
  const fields = [...table.fields].sort();
  const known = new Set(fields);
  const cells: RuleCell[] = [];
  const firstRowFor = new Map<string, { row: number; output: string }>();

  table.rows.forEach((r, i) => {
    const row = i + 1;
    let valid = true;
    for (const f of Object.keys(r.when)) {
      if (!known.has(f)) {
        add({ code: "unknown_field", row, field: f, detail: `'${f}' is not one of the table's fields` });
        valid = false;
      }
    }
    const values: FieldValue[][] = [];
    for (const f of fields) {
      if (!Object.hasOwn(r.when, f)) {
        add({ code: "missing_condition", row, field: f, detail: `row ${row} gives no value for '${f}'` });
        valid = false;
        continue;
      }
      const c = r.when[f]!;
      const list: readonly FieldValue[] = Array.isArray(c) ? c : [c as FieldValue];
      if (list.length === 0) {
        add({ code: "empty_condition", row, field: f, detail: `row ${row} lists no values for '${f}'` });
        valid = false;
      } else if (list.length > L.maxValuesPerCondition) {
        add({ code: "too_many_values", row, field: f, detail: `at most ${L.maxValuesPerCondition} values per condition` });
        valid = false;
      } else if (!list.every(isScalar)) {
        add({ code: "invalid_value", row, field: f, detail: "a value is text, a finite number, true, false or null" });
        valid = false;
      }
      values.push([...new Set(list)]);
    }
    const output = normalizeStepOutput(r.then);
    if (output.length === 0) {
      add({ code: "empty_outcome", row, detail: `row ${row} has no outcome` });
      valid = false;
    } else if (output.length > L.maxOutputLength) {
      add({ code: "outcome_too_long", row, detail: `an outcome is at most ${L.maxOutputLength} characters` });
      valid = false;
    }
    if (!valid) return;

    const combos = values.reduce((n, v) => n * v.length, 1);
    if (cells.length + combos > L.maxCells) {
      add({ code: "too_many_cells", detail: `the table expands to more than ${L.maxCells} input combinations` });
      return;
    }
    for (const key of product(values)) {
      const k = JSON.stringify(key.map(encodeValue));
      const seen = firstRowFor.get(k);
      if (seen) {
        if (seen.row !== row) {
          add({
            code: seen.output === output ? "duplicate_row" : "conflicting_rows",
            row,
            otherRow: seen.row,
            detail:
              seen.output === output
                ? `rows ${seen.row} and ${row} both cover ${describe(fields, key)}`
                : `rows ${seen.row} and ${row} give different outcomes for ${describe(fields, key)}`,
          });
        }
        continue;
      }
      firstRowFor.set(k, { row, output });
      // an authored cell has no recorded runs behind it
      cells.push({ key, output, support: 0 });
    }
  });

  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, rule: { fields, cells }, rows: table.rows.length, cells: cells.length };
}

/** Render a table as readable lines, one per row, in the author's row order, plus the fallback line. */
export function renderDecisionTable(table: DecisionTableBody): string[] {
  const show = (c: DecisionCondition) =>
    Array.isArray(c) ? `one of ${c.map((v) => JSON.stringify(v)).join(", ")}` : JSON.stringify(c);
  const fields = [...table.fields].sort();
  const lines = table.rows.map(
    (r) => `when ${fields.map((f) => `${f} = ${Object.hasOwn(r.when, f) ? show(r.when[f]!) : "(missing)"}`).join(" and ")} -> ${JSON.stringify(normalizeStepOutput(r.then))}`,
  );
  lines.push("otherwise -> ask the AI (input not covered by this table)");
  return lines;
}

function* product(lists: readonly FieldValue[][]): Generator<FieldValue[]> {
  if (lists.length === 0) {
    yield [];
    return;
  }
  const [head, ...rest] = lists;
  for (const v of head!) for (const tail of product(rest)) yield [v, ...tail];
}

function describe(fields: readonly string[], key: readonly FieldValue[]): string {
  return fields.map((f, i) => `${f} = ${JSON.stringify(key[i])}`).join(" and ");
}

// the same encoding the rule engine keys on (`rule-induction.ts`): the type is part of the key, so "1" and 1 never collide
function encodeValue(v: FieldValue): string {
  return `${typeof v}:${String(v)}`;
}

function isScalar(v: unknown): v is FieldValue {
  return v === null || typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v));
}
