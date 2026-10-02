/**
 * The submitted intake questionnaire, rendered for a reader rather than as the
 * markdown the server stores. The stored artifact is ONE markdown document —
 * prose sections plus a fenced `eu-ai-act-answers` JSON block the server reads
 * the screening tier from — and an approver should never have to read JSON to
 * see what was answered.
 *
 * Deliberately a tiny, closed renderer: headings, paragraphs, quotes, bullet
 * and numbered lists, `code` and **bold** inline, fenced blocks, and the
 * answers block as a labelled list. Every piece of text goes through React as
 * a text node — nothing is ever injected as HTML — so a questionnaire cannot
 * smuggle markup into the page. The raw document stays one click away
 * ("View source") because the stored text is what the sign-off decided on.
 */
import type { CSSProperties, ReactNode } from "react";
import { humanize } from "../../../api/format";
import { CodeBlock } from "../../../ui/kit";
import a from "../admin.module.css";
import v from "../../views.module.css";

// the screening questionnaire vocabulary — mirrors euAiActAnswersSchema in
// @regulait/shared (the server refuses anything else, so drift fails loudly).
// The fill form and the read-back below share it, so a value is labelled the
// same way where it is chosen and where it is shown.
export const EU_DOMAINS = [
  ["general-business", "General business use"],
  ["internal-productivity", "Internal productivity / tooling"],
  ["employment-hr", "Employment / HR (recruitment, evaluation)"],
  ["education", "Education / vocational training"],
  ["essential-services", "Essential services (credit, benefits, insurance)"],
  ["law-enforcement", "Law enforcement"],
  ["migration-border", "Migration / asylum / border control"],
  ["justice-democracy", "Justice / democratic processes"],
  ["critical-infrastructure", "Critical infrastructure"],
] as const;
export const EU_AUTONOMY = [
  ["narrow-procedural", "Narrow procedural task — a human fully decides"],
  ["informs-human", "Informs a human decision"],
  ["human-reviews", "Decides, a human reviews"],
  ["fully-automated", "Fully automated decisions"],
] as const;
export const EU_BIOMETRIC = [
  ["none", "No biometric use"],
  ["verification", "1:1 verification only (unlock/login)"],
  ["remote-identification", "Remote biometric identification"],
] as const;
export const EU_AFFECTED = [
  ["employees", "Employees"],
  ["customers", "Customers"],
  ["general-public", "General public"],
  ["vulnerable-groups", "Vulnerable groups"],
] as const;
export const EU_FLAGS = [
  ["emotionRecognition", "Emotion recognition"],
  ["socialScoring", "Social scoring"],
  ["manipulativeTechniques", "Manipulative or deceptive techniques"],
  ["profilesNaturalPersons", "Profiles natural persons"],
  ["safetyComponent", "Safety component of a regulated product"],
  ["interactsWithHumans", "People interact with it directly"],
  ["generatesSyntheticContent", "Generates synthetic content"],
] as const;

const EU_ANSWERS_FENCE = "eu-ai-act-answers";

export type QuestionnaireBlock =
  | { kind: "heading"; level: 1 | 2 | 3; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "quote"; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "answers"; answers: Record<string, unknown> }
  | { kind: "code"; lang: string; text: string };

/** a platform cross-reference in a heading ("(structured, ADR-0085)") is for
 * the people who built the template, not the people reading the answers */
const ADR_ASIDE_RE = /\s*\([^()]*\bADR-\d+[^()]*\)/g;

/** markdown → blocks. Pure, so the shape is unit-tested without a DOM. */
export function parseQuestionnaire(markdown: string): QuestionnaireBlock[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const out: QuestionnaireBlock[] = [];
  let para: string[] = [];
  let quote: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const flushPara = () => {
    if (para.length) out.push({ kind: "paragraph", text: para.join(" ") });
    para = [];
  };
  const flushQuote = () => {
    if (quote.length) out.push({ kind: "quote", text: quote.join(" ").trim() });
    quote = [];
  };
  const flushList = () => {
    if (list) out.push({ kind: "list", ...list });
    list = null;
  };
  const flushAll = () => {
    flushPara();
    flushQuote();
    flushList();
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = /^\s*```\s*([\w-]*)\s*$/.exec(line);
    if (fence) {
      flushAll();
      const body: string[] = [];
      while (++i < lines.length && !/^\s*```\s*$/.test(lines[i]!)) body.push(lines[i]!);
      const text = body.join("\n");
      const lang = fence[1] ?? "";
      if (lang === EU_ANSWERS_FENCE) {
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = null;
        }
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          out.push({ kind: "answers", answers: parsed as Record<string, unknown> });
          continue;
        }
      }
      out.push({ kind: "code", lang, text });
      continue;
    }
    // a closing run of #s needs a space before it (CommonMark): "Using C#" keeps its #
    const heading = /^\s*(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/.exec(line);
    if (heading) {
      flushAll();
      const level = Math.min(heading[1]!.length, 3) as 1 | 2 | 3;
      out.push({ kind: "heading", level, text: heading[2]!.replace(ADR_ASIDE_RE, "").trim() });
      continue;
    }
    if (!line.trim()) {
      flushAll();
      continue;
    }
    const q = /^\s*>\s?(.*)$/.exec(line);
    if (q) {
      flushPara();
      flushList();
      quote.push(q[1]!);
      continue;
    }
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const numbered = bullet ? null : /^\s*\d+[.)]\s+(.*)$/.exec(line);
    const item = bullet ?? numbered;
    if (item) {
      flushPara();
      flushQuote();
      const ordered = Boolean(numbered);
      if (!list || list.ordered !== ordered) {
        flushList();
        list = { ordered, items: [] };
      }
      list.items.push(item[1]!.trim());
      continue;
    }
    if (list) {
      // a wrapped line continues the item above it, as markdown reads it
      const items: string[] = (list as { items: string[] }).items;
      items[items.length - 1] = `${items[items.length - 1]} ${line.trim()}`;
      continue;
    }
    flushQuote();
    para.push(line.trim());
  }
  flushAll();
  return out;
}

const labelFrom = (vocab: ReadonlyArray<readonly [string, string]>, value: string) =>
  vocab.find(([k]) => k === value)?.[1] ?? humanize(value);

/** `purposeDomain` → "Purpose domain", for a key this page has no label for */
const keyLabel = (key: string) => humanize(key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase());

const show = (value: unknown, vocab?: ReadonlyArray<readonly [string, string]>): string => {
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "string") return vocab ? labelFrom(vocab, value) : humanize(value);
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.length ? value.map((x) => show(x, vocab)).join(", ") : "None";
  if (value == null) return "—";
  return JSON.stringify(value);
};

/** the screening answers as label/value rows, in the order the form asks them */
export function answerRows(answers: Record<string, unknown>): Array<[string, string]> {
  const rows: Array<[string, string]> = [];
  const seen = new Set<string>();
  const add = (key: string, label: string, value: string) => {
    if (!(key in answers)) return;
    seen.add(key);
    rows.push([label, value]);
  };
  add("purposeDomain", "Purpose domain", show(answers.purposeDomain, EU_DOMAINS));
  add(
    "affectedPersons",
    "Affected persons",
    Array.isArray(answers.affectedPersons) && answers.affectedPersons.length === 0
      ? "No natural persons affected"
      : show(answers.affectedPersons, EU_AFFECTED),
  );
  add("decisionAutonomy", "Decision autonomy", show(answers.decisionAutonomy, EU_AUTONOMY));
  add("biometricUse", "Biometric use", show(answers.biometricUse, EU_BIOMETRIC));
  for (const [key, label] of EU_FLAGS) add(key, label, show(answers[key]));
  for (const [key, value] of Object.entries(answers)) {
    if (!seen.has(key)) rows.push([keyLabel(key), show(value)]);
  }
  return rows;
}

/** `code` and **bold** only — rendered as elements, never as HTML */
function inline(text: string): ReactNode[] {
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith("`") && part.endsWith("`") && part.length > 1 ? (
      <code key={i} className={v.mono}>{part.slice(1, -1)}</code>
    ) : part.startsWith("**") && part.endsWith("**") && part.length > 3 ? (
      <strong key={i}>{part.slice(2, -2)}</strong>
    ) : (
      part
    ),
  );
}

const prose: CSSProperties = { margin: 0, fontSize: "var(--text-sm)", lineHeight: 1.6 };
const headingStyle: Record<1 | 2 | 3, CSSProperties> = {
  1: { margin: 0, fontSize: "var(--text-md)", fontWeight: 650 },
  2: { margin: "var(--s1) 0 0", fontSize: "var(--text-sm)", fontWeight: 650 },
  3: { margin: "var(--s1) 0 0", fontSize: "var(--text-sm)", fontWeight: 600, color: "var(--text-dim)" },
};

export function QuestionnaireView(props: { content: string }) {
  const blocks = parseQuestionnaire(props.content);
  return (
    <div className={v.stack}>
      {blocks.map((b, i) => {
        switch (b.kind) {
          case "heading": {
            const H = b.level === 1 ? "h3" : b.level === 2 ? "h4" : "h5";
            return <H key={i} style={headingStyle[b.level]}>{inline(b.text)}</H>;
          }
          case "paragraph":
            return <p key={i} style={prose}>{inline(b.text)}</p>;
          case "quote":
            return (
              <blockquote
                key={i}
                className={v.dim}
                style={{ margin: 0, paddingLeft: "var(--s2)", borderLeft: "3px solid var(--border)" }}
              >
                {inline(b.text)}
              </blockquote>
            );
          case "list": {
            const L = b.ordered ? "ol" : "ul";
            return (
              <L key={i} style={{ ...prose, paddingLeft: "1.25rem" }}>
                {b.items.map((it, j) => <li key={j}>{inline(it)}</li>)}
              </L>
            );
          }
          case "answers":
            return (
              <div key={i} className={a.subCard}>
                <div className={v.faint}>Screening answers</div>
                <dl className={a.review}>
                  {answerRows(b.answers).map(([label, value], j) => (
                    <div key={j}>
                      <dt>{label}</dt>
                      <dd>{value}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            );
          case "code":
            return (
              <div key={i} className={v.stackTight}>
                {b.lang === EU_ANSWERS_FENCE && (
                  <span className={v.faint}>These screening answers could not be read — shown as submitted.</span>
                )}
                <CodeBlock maxHeight="16rem">{b.text}</CodeBlock>
              </div>
            );
        }
      })}
      <details>
        <summary className={v.faint} style={{ cursor: "pointer" }}>View source</summary>
        <div style={{ marginTop: "var(--s1)" }}>
          <CodeBlock maxHeight="24rem">{props.content}</CodeBlock>
        </div>
      </details>
    </div>
  );
}
