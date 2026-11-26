/**
 * ADR-0341 slice 2 — the Outline view: the same stages and order as the canvas, as an ordered list. It is the
 * screen-reader, keyboard and phone path, and every action the canvas offers is here (select, move, remove, add at a
 * position).
 */
import { useId, useState } from "react";
import { Button, Field, Select } from "../../../ui/kit";
import { plural } from "../../../api/format";
import { STAGE_TYPES, STAGE_TYPE_INFO, stageTypeLabel, type StageType, type TemplateDefinition } from "./pipelineCanvasModel";
import type { BuilderIssue } from "./pipelineBuilderApi";
import s from "./pipelineBuilder.module.css";

export default function StageOutline(props: {
  definition: TemplateDefinition;
  issuesByStage: ReadonlyMap<string, readonly BuilderIssue[]>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onMove: (id: string, toIndex: number) => void;
  onRemove: (id: string) => void;
  onInsert: (type: StageType, index: number) => void;
  readOnly?: boolean;
}) {
  const stages = props.definition.stages;
  const [type, setType] = useState<StageType>("automated_check");
  const [at, setAt] = useState<number>(stages.length);
  const where = Math.min(at, stages.length);
  const typeId = useId();
  const atId = useId();
  return (
    <div className={s.pane}>
      <ol className={s.outline} aria-label="Stages in order">
        {stages.map((st, i) => {
          const issues = props.issuesByStage.get(st.id)?.length ?? 0;
          const selected = st.id === props.selectedId;
          return (
            <li key={st.id} className={[s.outlineRow, selected ? s.outlineRowSelected : ""].join(" ")} aria-current={selected ? "step" : undefined}>
              <span className={s.outlineName}>
                {i + 1}. {stageTypeLabel(st.type)} <span className={s.code}>{st.id}</span>
                {issues > 0 && <span className={s.outlineIssues}> — {plural(issues, "problem", "problems")}</span>}
              </span>
              <Button size="sm" onClick={() => props.onSelect(st.id)} aria-label={`Edit stage ${st.id}`}>
                Edit
              </Button>
              {!props.readOnly && (
                <>
                  <Button size="sm" disabled={i === 0} onClick={() => props.onMove(st.id, i - 1)} aria-label={`Move ${st.id} earlier`}>
                    Earlier
                  </Button>
                  <Button size="sm" disabled={i === stages.length - 1} onClick={() => props.onMove(st.id, i + 1)} aria-label={`Move ${st.id} later`}>
                    Later
                  </Button>
                  <Button size="sm" variant="danger" onClick={() => props.onRemove(st.id)} aria-label={`Remove ${st.id}`}>
                    Remove
                  </Button>
                </>
              )}
            </li>
          );
        })}
      </ol>
      {!props.readOnly && (
        <div className={s.toolbar}>
          <Field label="Stage to add">
            <Select id={typeId} value={type} onChange={(e) => setType(e.target.value as StageType)}>
              {STAGE_TYPES.map((t) => (
                <option key={t} value={t}>
                  {STAGE_TYPE_INFO[t].label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Position">
            <Select id={atId} value={String(where)} onChange={(e) => setAt(Number(e.target.value))}>
              {stages.map((st, i) => (
                <option key={st.id} value={i}>
                  Before {st.id}
                </option>
              ))}
              <option value={stages.length}>At the end</option>
            </Select>
          </Field>
          <Button size="sm" onClick={() => props.onInsert(type, where)}>
            Add stage
          </Button>
        </div>
      )}
    </div>
  );
}
