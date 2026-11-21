/**
 * ADR-0341 slice 3 — what a draft or an older version changes against the live template: the stage summary, the
 * relaxations the server found (named in words, never colour alone), and every RFC 6902 operation as text.
 * Values are rendered as text (never HTML), and long values are cut with the length stated.
 */
import { plural } from "../../../api/format";
import type { BuilderDiff, JsonPatchOp } from "./pipelineBuilderApi";
import s from "./pipelineBuilder.module.css";

const MAX_VALUE = 160;

/** one patch operation as a sentence a reviewer can read */
export function patchOpText(op: JsonPatchOp): string {
  const where = op.path === "" ? "the whole definition" : op.path;
  const raw = op.value === undefined ? "" : JSON.stringify(op.value);
  const value = raw.length > MAX_VALUE ? `${raw.slice(0, MAX_VALUE)}… (${raw.length} characters)` : raw;
  switch (op.op) {
    case "add":
      return `Add ${where}: ${value}`;
    case "remove":
      return `Remove ${where}`;
    case "replace":
      return `Set ${where} to ${value}`;
    case "move":
      return `Move ${op.from ?? "?"} to ${where}`;
    case "copy":
      return `Copy ${op.from ?? "?"} to ${where}`;
    default:
      return `${op.op} ${where}`;
  }
}

function IdList(props: { label: string; ids: string[] }) {
  if (props.ids.length === 0) return null;
  return (
    <li>
      {props.label}: <span className={s.code}>{props.ids.join(", ")}</span>
    </li>
  );
}

export default function DiffView(props: { diff: BuilderDiff; against: string }) {
  const { diff } = props;
  const st = diff.stages;
  if (diff.patch.length === 0) return <p className={s.dim}>No change against {props.against}.</p>;
  return (
    <div className={s.props}>
      {st ? (
        <ul className={s.issues} aria-label="Stages changed">
          <IdList label="Added" ids={st.added} />
          <IdList label="Removed" ids={st.removed} />
          <IdList label="Changed" ids={st.changed} />
          <IdList label="Moved" ids={st.moved} />
          {st.topLevel.length > 0 && <IdList label="Workflow settings" ids={st.topLevel} />}
        </ul>
      ) : (
        <p className={s.dim}>One side does not pass the schema, so only the raw changes are listed.</p>
      )}
      {diff.relaxations.length > 0 && (
        <div role="note" aria-label="Relaxations">
          <p className={s.fieldError}>
            This weakens the workflow in {plural(diff.relaxations.length, "way", "ways")}:
          </p>
          <ul className={s.issues}>
            {diff.relaxations.map((r, i) => (
              <li key={i}>{r.message}</li>
            ))}
          </ul>
        </div>
      )}
      <details>
        <summary>Every change ({plural(diff.patch.length, "operation", "operations")})</summary>
        <ol className={s.issues}>
          {diff.patch.map((op, i) => (
            <li key={i} className={s.code}>
              {patchOpText(op)}
            </li>
          ))}
        </ol>
      </details>
    </div>
  );
}
