/**
 * The edit form behind every PATCH that had none (initiatives, interception
 * scope rules, report schedules, passkeys, external scorers, vendors). Pure:
 * a field list, the record as loaded, the draft — and the body to send.
 *
 * Only edited fields are sent. A PATCH is a partial update on every one of
 * these routes, so re-sending an untouched field from the loaded snapshot
 * would silently revert another admin's change made since.
 */

export interface Choice {
  value: string;
  label: string;
}

export type PatchField = {
  key: string;
  label: string;
  /** optional help under the field */
  help?: string;
} & (
  | { kind: "text"; maxLength: number; required?: boolean; nullable?: boolean; placeholder?: string }
  | { kind: "textarea"; maxLength: number; required?: boolean }
  /** `decode` turns the option value into what is sent (e.g. "" -> null, "true" -> true) */
  | { kind: "select"; options: readonly Choice[]; decode?: (raw: string) => unknown; encode?: (value: unknown) => string }
  /** a subset of `options`; `min`/`max` entries; `emptyAs` is what an empty selection sends */
  | { kind: "multi"; options: readonly Choice[]; min?: number; max?: number; emptyAs?: null | [] }
  /** a comma-separated list of short strings */
  | { kind: "list"; maxItems: number; maxLength: number }
  /** a write-only secret: blank keeps the stored one; `clearLabel` offers sending null */
  | { kind: "secret"; maxLength: number; clearLabel?: string }
);

export interface PatchDraft {
  text: Record<string, string>;
  set: Record<string, string[]>;
  clear: Record<string, boolean>;
}

const encodeSelect = (f: Extract<PatchField, { kind: "select" }>, v: unknown) => (f.encode ? f.encode(v) : v == null ? "" : String(v));

/** the draft a record opens with */
export function draftFromRecord(fields: readonly PatchField[], record: Record<string, unknown>): PatchDraft {
  const d: PatchDraft = { text: {}, set: {}, clear: {} };
  for (const f of fields) {
    const v = record[f.key];
    switch (f.kind) {
      case "text":
      case "textarea":
        d.text[f.key] = typeof v === "string" ? v : "";
        break;
      case "select":
        d.text[f.key] = encodeSelect(f, v);
        break;
      case "multi":
        d.set[f.key] = Array.isArray(v) ? v.map(String) : [];
        break;
      case "list":
        d.text[f.key] = Array.isArray(v) ? v.map(String).join(", ") : "";
        break;
      case "secret":
        d.text[f.key] = "";
        d.clear[f.key] = false;
        break;
    }
  }
  return d;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const sortedSame = (a: unknown, b: unknown) => {
  const s = (x: unknown) => (Array.isArray(x) ? [...x].map(String).sort() : x);
  return same(s(a), s(b));
};

export type PatchResult = { ok: true; body: Record<string, unknown> } | { ok: false; problem: string };

/** the PATCH body: only fields whose value changed, each in the shape the route's schema takes */
export function patchBody(fields: readonly PatchField[], record: Record<string, unknown>, draft: PatchDraft): PatchResult {
  const body: Record<string, unknown> = {};
  for (const f of fields) {
    const before = record[f.key];
    switch (f.kind) {
      case "text":
      case "textarea": {
        const t = (draft.text[f.key] ?? "").trim();
        const nullable = f.kind === "text" && f.nullable;
        if (t === "" && !nullable && (f.required ?? true)) return { ok: false, problem: `${f.label} is required.` };
        if (t.length > f.maxLength) return { ok: false, problem: `${f.label} is at most ${f.maxLength} characters.` };
        const value = t === "" ? (nullable ? null : undefined) : t;
        if (value !== undefined && !same(value, before)) body[f.key] = value;
        break;
      }
      case "select": {
        const raw = draft.text[f.key] ?? "";
        if (!f.options.some((o) => o.value === raw)) return { ok: false, problem: `Choose a value for ${f.label}.` };
        if (raw === encodeSelect(f, before)) break;
        body[f.key] = f.decode ? f.decode(raw) : raw;
        break;
      }
      case "multi": {
        const known = f.options.map((o) => o.value);
        const picked = known.filter((v) => (draft.set[f.key] ?? []).includes(v));
        if (f.min !== undefined && picked.length < f.min) return { ok: false, problem: `Choose at least ${f.min} for ${f.label}.` };
        if (f.max !== undefined && picked.length > f.max) return { ok: false, problem: `Choose at most ${f.max} for ${f.label}.` };
        const value = picked.length === 0 && f.emptyAs !== undefined ? f.emptyAs : picked;
        if (!sortedSame(value, before ?? (f.emptyAs === null ? null : []))) body[f.key] = value;
        break;
      }
      case "list": {
        const items = [...new Set((draft.text[f.key] ?? "").split(",").map((x) => x.trim()).filter(Boolean))];
        if (items.length > f.maxItems) return { ok: false, problem: `${f.label} holds at most ${f.maxItems} entries.` };
        const long = items.find((x) => x.length > f.maxLength);
        if (long) return { ok: false, problem: `${f.label}: "${long.slice(0, 20)}…" is longer than ${f.maxLength} characters.` };
        if (!same(items, Array.isArray(before) ? before : [])) body[f.key] = items;
        break;
      }
      case "secret": {
        const t = draft.text[f.key] ?? "";
        if (draft.clear[f.key]) body[f.key] = null;
        else if (t !== "") {
          if (t.length > f.maxLength) return { ok: false, problem: `${f.label} is at most ${f.maxLength} characters.` };
          body[f.key] = t;
        }
        break;
      }
    }
  }
  if (Object.keys(body).length === 0) return { ok: false, problem: "Nothing has changed." };
  return { ok: true, body };
}

/** tri-state select codecs: "" = inherit (null), "true", "false" */
export const TRI_STATE = {
  options: [
    { value: "", label: "inherit" },
    { value: "true", label: "enabled" },
    { value: "false", label: "disabled" },
  ] as const,
  decode: (raw: string): boolean | null => (raw === "true" ? true : raw === "false" ? false : null),
  encode: (v: unknown): string => (v === true ? "true" : v === false ? "false" : ""),
};
/** a nullable enum: "" = inherit (null) */
export const nullableEnum = {
  decode: (raw: string): string | null => (raw === "" ? null : raw),
  encode: (v: unknown): string => (typeof v === "string" ? v : ""),
};
/** a boolean as a select */
export const BOOL = {
  decode: (raw: string): boolean => raw === "true",
  encode: (v: unknown): string => (v === true ? "true" : "false"),
};
