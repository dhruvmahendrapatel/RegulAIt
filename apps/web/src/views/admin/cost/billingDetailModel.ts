/**
 * Batch U4 — billing detail and full-history reads (ADR-0051).
 *
 * A statement's `payload` is the derivation it froze when it was cut (the same
 * shape `POST /v1/billing/periods/:id/statements` returns as `report`). It is
 * stored JSON, so it is read defensively here: a line the payload does not
 * carry is not invented, and an UNPRICED line stays unpriced (never $0).
 */

export interface StatementLine {
  dimension: string;
  matchKey: string;
  events: number;
  inputTokens: number;
  outputTokens: number;
  billedUsd: number | null;
  unpriced: boolean;
  rateNote: string;
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** the usage lines a statement payload froze, or [] when it carries none */
export function statementLines(payload: unknown): StatementLine[] {
  const lines = obj(obj(payload).usage).lines;
  if (!Array.isArray(lines)) return [];
  return lines.map((raw) => {
    const l = obj(raw);
    const billed = typeof l.billedUsd === "number" && Number.isFinite(l.billedUsd) ? l.billedUsd : null;
    return {
      dimension: typeof l.dimension === "string" ? l.dimension : "?",
      matchKey: typeof l.matchKey === "string" ? l.matchKey : "*",
      events: n(l.events),
      inputTokens: n(l.inputTokens),
      outputTokens: n(l.outputTokens),
      billedUsd: billed,
      unpriced: l.unpriced === true || billed === null,
      rateNote: typeof l.rateNote === "string" ? l.rateNote : "",
    };
  });
}

/** the period label and disclaimer a payload froze, when it has them */
export function statementHeadline(payload: unknown): { periodLabel: string | null; disclaimer: string | null } {
  const p = obj(payload);
  return {
    periodLabel: typeof p.periodLabel === "string" ? p.periodLabel : null,
    disclaimer: typeof p.disclaimer === "string" ? p.disclaimer : null,
  };
}

/** the statements list's own bound (`limit` 1–200) */
export const STATEMENT_LIMITS = [50, 100, 200] as const;

export const BILLING_REFUSALS: Readonly<Record<string, string>> = {
  unknown_rate_card: "There is no rate card with this ID. Reload the page.",
  unknown_billing_statement: "This statement no longer exists. Reload the page.",
  billing_scope_not_entitled:
    "This statement covers projects outside what you can see, so it is not shown. The refused read is recorded in the audit log.",
};
