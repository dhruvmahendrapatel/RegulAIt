/**
 * One operation of an MCP definition's patch on the re-approval screen: a bounded summary line that says when a value
 * was cut, and a disclosure with the full before and after values, the differing text marked. Every value is a
 * React text child, never markup, so instruction-like text in a definition reads as data.
 */
import { useState } from "react";
import { plural } from "../../../api/format";
import { clip, splitDifference, type DiffLine, type DifferenceSplit } from "./mcpPinningModel";
import v from "../../views.module.css";
import m from "./mcpPinning.module.css";

function Summary({ text }: { text: string | null }) {
  if (text === null) return <>—</>;
  const c = clip(text);
  return (
    <>
      <span className={`${v.mono} ${m.value}`}>
        {c.shown}
        {c.cut && "…"}
      </span>
      {c.cut && <span className={v.dim}> (showing {c.shown.length} of {plural(c.total, "character")})</span>}
    </>
  );
}

/** one full value; with `head`/`mid`/`tail` the differing middle is marked */
function FullValue({ title, text, part }: { title: string; text: string | null; part: { head: string; mid: string; tail: string } | null }) {
  if (text === null) return <p className={m.fullTitle}>{title}: nothing.</p>;
  return (
    <div>
      <p className={m.fullTitle}>
        {title} ({plural(text.length, "character")})
      </p>
      <pre className={`${v.mono} ${m.value} ${m.fullText}`}>
        {part ? (
          <>
            {part.head}
            {part.mid ? <mark className={m.changed}>{part.mid}</mark> : <span className={m.gap} aria-hidden="true" />}
            {part.tail}
          </>
        ) : (
          text
        )}
      </pre>
    </div>
  );
}

function FullValues({ line, split }: { line: DiffLine; split: DifferenceSplit | null }) {
  const moved = line.action === "Move" || line.action === "Copy";
  const marked = split && split.at !== null ? split : null;
  return (
    <div className={m.fullBody}>
      {marked && <p>They first differ at character {marked.at}; the differing text is marked in both.</p>}
      {split && split.at === null && <p>Both values are the same text.</p>}
      <FullValue title={moved ? "From" : "Approved"} text={line.before} part={marked && { head: marked.head, mid: marked.before, tail: marked.tail }} />
      <FullValue title={moved ? "To" : "Now served"} text={line.after} part={marked && { head: marked.head, mid: marked.after, tail: marked.tail }} />
    </div>
  );
}

/** a list item: "what, where: approved → now served", then the full values on request */
export function DiffLineItem({ line }: { line: DiffLine }) {
  const [open, setOpen] = useState(false);
  const split = line.before !== null && line.after !== null ? splitDifference(line.before, line.after) : null;
  const cut = [line.before, line.after].some((t) => t !== null && clip(t).cut);
  return (
    <li className={m.line}>
      {line.action} <span className={v.mono}>{line.path}</span>: <Summary text={line.before} /> → <Summary text={line.after} />
      {cut && split?.at != null && <> They first differ at character {split.at}.</>}
      <details className={m.full} onToggle={(e) => setOpen(e.currentTarget.open)}>
        <summary className={m.fullSummary}>
          {open ? "Hide full values" : "Show full values"}
          <span className={m.srOnly}>
            {" "}
            of {line.action.toLowerCase()} {line.path}
          </span>
        </summary>
        {open && <FullValues line={line} split={split} />}
      </details>
    </li>
  );
}
