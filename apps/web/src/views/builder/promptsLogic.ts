/**
 * ADR-0173 batch 2b — the pure logic behind the Prompts, Playground and
 * Webhooks screens: variable detection, JSON editors, evaluate rows, the
 * diff view and the webhook event selectors. No React, so it is unit-tested.
 */

/**
 * The gateway's variable rule, restated (packages/shared prompt-registry.ts
 * `extractPromptVariables`): `{{name}}`, double braces, so a JSON example in a
 * prompt is never mistaken for a variable. In order of first appearance, once
 * each. The gateway derives the commit's variable list the same way, so the
 * inputs pane can never disagree with what is stored.
 */
const VARIABLE_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]{0,63})\s*\}\}/g;

export function extractVariables(template: string): string[] {
  const out: string[] = [];
  for (const m of template.matchAll(VARIABLE_RE)) {
    const name = m[1]!;
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

/** the variables with no value yet (an empty string is a value the person chose) */
export function missingVariables(variables: string[], values: Record<string, string>): string[] {
  return variables.filter((v) => typeof values[v] !== "string");
}

/** keep the values of variables still in the template, add empty ones for new variables */
export function syncValues(variables: string[], values: Record<string, string>): Record<string, string> {
  return Object.fromEntries(variables.map((v) => [v, values[v] ?? ""]));
}

export type JsonParse = { ok: true; value: Record<string, unknown> | null } | { ok: false; error: string };

/** a JSON-object editor: blank = none, otherwise it must be one JSON object */
export function parseJsonObject(text: string): JsonParse {
  const t = text.trim();
  if (!t) return { ok: true, value: null };
  let v: unknown;
  try {
    v = JSON.parse(t);
  } catch (e) {
    return { ok: false, error: `Not valid JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return { ok: false, error: "Use a JSON object, like {\"type\": \"object\"}." };
  return { ok: true, value: v as Record<string, unknown> };
}

export const prettyJson = (v: unknown): string => (v === null || v === undefined ? "" : JSON.stringify(v, null, 2));

/** a tool name the gateway accepts */
export const TOOL_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** a tag name the gateway accepts: lower-case, starting with a letter, at most 32 */
export const TAG_RE = /^[a-z][a-z0-9_-]{0,31}$/;

export const PROD_TAG = "prod";

/** the gateway's evaluate-mode cap: each row is one governed call */
export const MAX_EVAL_ROWS = 50;

export const shortHash = (h: string | null | undefined): string => (h ? h.slice(0, 12) : "—");

/** Ctrl+Enter or ⌘+Enter runs the playground */
export function isRunShortcut(e: { key: string; ctrlKey: boolean; metaKey: boolean }): boolean {
  return e.key === "Enter" && (e.ctrlKey || e.metaKey);
}

export interface EditableRow {
  inputs: Record<string, string>;
  reference: string;
}

/** evaluate rows, re-shaped when the template's variables change */
export function syncRows(rows: EditableRow[], variables: string[]): EditableRow[] {
  return rows.map((r) => ({ ...r, inputs: syncValues(variables, r.inputs) }));
}

/** rows as the gateway takes them: a blank reference is none */
export function rowsForRequest(rows: EditableRow[]): Array<{ inputs: Record<string, string>; reference: string | null }> {
  return rows.map((r) => ({ inputs: r.inputs, reference: r.reference.trim() ? r.reference : null }));
}

export interface DiffLine {
  op: "add" | "remove" | "same";
  text: string;
}

/** the gateway's line-diff parts, one entry per line (a part may span several) */
export function diffLinesOf(parts: Array<{ op: "add" | "remove" | "same"; text: string }>): DiffLine[] {
  const out: DiffLine[] = [];
  for (const p of parts) {
    const lines = p.text.endsWith("\n") ? p.text.slice(0, -1).split("\n") : p.text.split("\n");
    for (const text of lines) out.push({ op: p.op, text });
  }
  return out;
}

export function diffStats(lines: DiffLine[]): { added: number; removed: number } {
  return { added: lines.filter((l) => l.op === "add").length, removed: lines.filter((l) => l.op === "remove").length };
}

export const fmtCost = (v: number | null | undefined): string =>
  v === null || v === undefined ? "not priced" : v === 0 ? "$0.00" : v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`;

// ---- webhooks --------------------------------------------------------------

/**
 * A subscription's selectors, from the checked events: a whole family that is
 * fully checked AND marked "every event, including future ones" becomes
 * `<family>.*` (so 2c's new events reach it); otherwise exact names.
 */
export function webhookSelectors(checked: string[], wholeFamilies: string[]): string[] {
  const fams = new Set(wholeFamilies);
  const exact = checked.filter((e) => !fams.has(e.split(".")[0]!));
  return [...[...fams].map((f) => `${f}.*`), ...exact];
}

/** does a subscription's selector list cover this event (exact, or its family) */
export function selectorCovers(selectors: string[], event: string): boolean {
  return selectors.includes(event) || selectors.includes(`${event.split(".")[0]}.*`);
}
