/**
 * ADR-0341 slice 2 — the stage palette. Each entry can be dragged onto the canvas (dropped at a position), or
 * activated with a click, Enter or Space, which adds the stage after the selected one (or at the end).
 */
import type { DragEvent } from "react";
import { STAGE_TYPES, STAGE_TYPE_INFO, type StageType } from "./pipelineCanvasModel";
import { STAGE_DRAG_TYPE } from "./stageDrag";
import s from "./pipelineBuilder.module.css";

const GROUPS = ["Start", "Plan and approve", "Build and check", "Ship"] as const;

export default function StagePalette(props: { onAdd: (type: StageType) => void; afterLabel: string; readOnly?: boolean }) {
  if (props.readOnly) return null;
  const onDragStart = (type: StageType) => (e: DragEvent<HTMLButtonElement>) => {
    e.dataTransfer.setData(STAGE_DRAG_TYPE, type);
    e.dataTransfer.effectAllowed = "copy";
  };
  return (
    <nav aria-label="Stage palette">
      <p className={s.dim}>Drag a stage onto the canvas, or choose one to add it {props.afterLabel}.</p>
      {GROUPS.map((g) => (
        <div key={g}>
          <p className={s.paletteCaption}>{g}</p>
          <ul className={s.paletteGroup}>
            {STAGE_TYPES.filter((t) => STAGE_TYPE_INFO[t].group === g).map((t) => (
              <li key={t}>
                <button type="button" className={s.paletteItem} draggable onDragStart={onDragStart(t)} onClick={() => props.onAdd(t)}>
                  <span className={s.paletteLabel}>Add {STAGE_TYPE_INFO[t].label.toLowerCase()}</span>
                  <span className={s.paletteDesc}>{STAGE_TYPE_INFO[t].description}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}
