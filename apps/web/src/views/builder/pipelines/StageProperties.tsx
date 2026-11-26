/**
 * ADR-0341 slice 2 — the property sheet for the selected stage.
 *
 * The common fields of each stage type are form controls; everything else a stage can carry (eval, engine and review
 * bindings, a nested run graph, a retry policy) is edited as the stage's JSON behind "Advanced", so no field of the
 * template is out of reach and nothing is dropped. Text commits on blur or Enter (inline validation on blur keeps what
 * the person typed); selects and checkboxes commit at once. The server validates every change.
 */
import { useEffect, useId, useState, type ReactNode } from "react";
import { Button, Field, Input, Select, Textarea } from "../../../ui/kit";
import { STAGE_TYPE_INFO, isStageType, stageTypeLabel, type TemplateDefinition, type TemplateStage } from "./pipelineCanvasModel";
import type { BuilderIssue } from "./pipelineBuilderApi";
import s from "./pipelineBuilder.module.css";

export interface StagePropertiesProps {
  definition: TemplateDefinition;
  stage: TemplateStage;
  issues: readonly BuilderIssue[];
  /** set (or, with `undefined`, remove) fields of the stage; `id` renames it */
  onChange: (changes: Record<string, unknown>) => void;
  /** replace the whole stage (the Advanced JSON) */
  onReplace: (stage: TemplateStage) => void;
  onMove: (delta: -1 | 1) => void;
  onRemove: () => void;
  readOnly?: boolean;
}

/** a list typed one entry per line (or comma-separated) as the array the template holds; empty = the field removed */
export function linesToList(text: string): string[] | undefined {
  const items = text
    .split(/[\n,]/)
    .map((x) => x.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}

/** the stage's JSON as typed back into a stage, or the reason it cannot be */
export function parseStageJson(text: string, currentId: string, otherIds: ReadonlySet<string>): { stage: TemplateStage } | { error: string } {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return { error: "This is not valid JSON." };
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return { error: "A stage is a JSON object." };
  const o = v as Record<string, unknown>;
  if (typeof o.id !== "string" || o.id.trim() === "") return { error: "A stage needs an id." };
  if (typeof o.type !== "string") return { error: "A stage needs a type." };
  if (o.id !== currentId && otherIds.has(o.id)) return { error: `Another stage is already called ${o.id}.` };
  return { stage: o as TemplateStage };
}

/** a text control that commits on blur or Enter, and shows what was typed until then */
function CommitText(props: {
  label: string;
  value: string;
  onCommit: (v: string) => void;
  multiline?: boolean;
  help?: ReactNode;
  error?: string | null;
  readOnly?: boolean;
}) {
  const [text, setText] = useState(props.value);
  useEffect(() => setText(props.value), [props.value]);
  const commit = () => {
    if (text !== props.value) props.onCommit(text);
  };
  return (
    <Field label={props.label} help={props.help} error={props.error}>
      {props.multiline ? (
        <Textarea value={text} rows={3} readOnly={props.readOnly} onChange={(e) => setText(e.target.value)} onBlur={commit} />
      ) : (
        <Input
          value={text}
          readOnly={props.readOnly}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
          }}
        />
      )}
    </Field>
  );
}

const str = (v: unknown) => (typeof v === "string" ? v : "");
const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").join("\n") : "");
const orUndefined = (v: string) => (v.trim() === "" ? undefined : v.trim());

export default function StageProperties(props: StagePropertiesProps) {
  const { stage, definition, readOnly } = props;
  const others = new Set(definition.stages.filter((x) => x.id !== stage.id).map((x) => x.id));
  const [idError, setIdError] = useState<string | null>(null);
  useEffect(() => setIdError(null), [stage.id]);
  const set = (key: string) => (v: unknown) => props.onChange({ [key]: v });
  const index = definition.stages.findIndex((x) => x.id === stage.id);
  const outputs = definition.stages.filter((x) => x.type === "artifact_generation" && typeof x.output === "string").map((x) => x.output as string);
  const rollbacks = definition.stages.filter((x) => x.type === "rollback").map((x) => x.id);

  return (
    <div className={s.props}>
      <p className={s.dim}>
        {stageTypeLabel(stage.type)}
        {isStageType(stage.type) ? ` — ${STAGE_TYPE_INFO[stage.type].description}` : ""}
      </p>
      {props.issues.length > 0 && (
        <ul className={s.issues} aria-label="Problems with this stage">
          {props.issues.map((i, n) => (
            <li key={n} className={s.fieldError}>
              {i.message}
            </li>
          ))}
        </ul>
      )}
      <CommitText
        label="Stage id"
        value={stage.id}
        readOnly={readOnly}
        error={idError}
        help="A short name, unique in this workflow. Checks and sign-offs refer to stages by it."
        onCommit={(v) => {
          const next = v.trim();
          if (!next) return setIdError("A stage needs an id.");
          if (others.has(next)) return setIdError(`Another stage is already called ${next}.`);
          setIdError(null);
          props.onChange({ id: next });
        }}
      />
      <TypeFields stage={stage} set={set} change={props.onChange} outputs={outputs} rollbacks={rollbacks} readOnly={readOnly} />
      {!readOnly && (
        <div className={s.toolbar}>
          <Button size="sm" onClick={() => props.onMove(-1)} disabled={index <= 0}>
            Move earlier
          </Button>
          <Button size="sm" onClick={() => props.onMove(1)} disabled={index >= definition.stages.length - 1}>
            Move later
          </Button>
          <Button size="sm" variant="danger" onClick={props.onRemove}>
            Remove stage
          </Button>
        </div>
      )}
      <AdvancedJson stage={stage} others={others} onReplace={props.onReplace} readOnly={readOnly} />
    </div>
  );
}

function TypeFields(props: {
  stage: TemplateStage;
  set: (key: string) => (v: unknown) => void;
  change: (changes: Record<string, unknown>) => void;
  outputs: string[];
  rollbacks: string[];
  readOnly?: boolean;
}) {
  const { stage, set, readOnly } = props;
  const quorumId = useId();
  switch (stage.type) {
    case "artifact_generation":
      return <CommitText label="Artifact name" value={str(stage.output)} readOnly={readOnly} onCommit={(v) => set("output")(orUndefined(v))} />;
    case "human_approval":
      return (
        <>
          <CommitText
            label="Approvers"
            multiline
            value={list(stage.approvers)}
            readOnly={readOnly}
            help="One per line: a user id, or requesting_user for the person who started the change."
            onCommit={(v) => set("approvers")(linesToList(v))}
          />
          <Field label="Who must approve">
            <Select id={quorumId} value={str(stage.quorum)} disabled={readOnly} onChange={(e) => set("quorum")(orUndefined(e.target.value))}>
              <option value="">The organisation default</option>
              <option value="all">Every approver</option>
              <option value="any">Any one approver</option>
            </Select>
          </Field>
        </>
      );
    case "automated_build":
      return (
        <Field label="Scoped to artifact">
          <Select value={str(stage.scope)} disabled={readOnly} onChange={(e) => set("scope")(orUndefined(e.target.value))}>
            <option value="">No scope</option>
            {props.outputs.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </Select>
        </Field>
      );
    case "automated_check":
      return (
        <>
          <CommitText
            label="Named checks"
            multiline
            value={list(stage.checks)}
            readOnly={readOnly}
            help="One per line. With no named checks the stage waits for a person to mark it done."
            onCommit={(v) => set("checks")(linesToList(v))}
          />
          <Field label="When a check fails">
            <Select
              value={stage.onFailure === "rollback" ? `rollback:${str(stage.rollbackStageId)}` : ""}
              disabled={readOnly}
              onChange={(e) => {
                const v = e.target.value;
                props.change(
                  v === ""
                    ? { onFailure: undefined, rollbackStageId: undefined }
                    : { onFailure: "rollback", rollbackStageId: v.slice("rollback:".length) || undefined },
                );
              }}
            >
              <option value="">Block until fixed</option>
              {props.rollbacks.map((r) => (
                <option key={r} value={`rollback:${r}`}>
                  Roll back through {r}
                </option>
              ))}
            </Select>
          </Field>
        </>
      );
    case "git_operation":
      return (
        <>
          <Field label="Operation">
            <Select value={str(stage.action)} disabled={readOnly} onChange={(e) => set("action")(orUndefined(e.target.value))}>
              <option value="create_branch">Create a branch</option>
              <option value="open_pr">Open a pull request</option>
              <option value="merge">Merge</option>
            </Select>
          </Field>
          <CommitText label="Git connection" value={str(stage.connection)} readOnly={readOnly} onCommit={(v) => set("connection")(orUndefined(v))} />
          <CommitText label="Repository (owner/name)" value={str(stage.repo)} readOnly={readOnly} onCommit={(v) => set("repo")(orUndefined(v))} />
        </>
      );
    case "deployment":
      return (
        <>
          <CommitText label="Deploy target" value={str(stage.connection)} readOnly={readOnly} onCommit={(v) => set("connection")(orUndefined(v))} />
          <CommitText label="Environment" value={str(stage.environment)} readOnly={readOnly} onCommit={(v) => set("environment")(orUndefined(v))} />
        </>
      );
    case "rollback":
      return <CommitText label="Deploy target" value={str(stage.connection)} readOnly={readOnly} onCommit={(v) => set("connection")(orUndefined(v))} />;
    default:
      return null;
  }
}

function AdvancedJson(props: { stage: TemplateStage; others: ReadonlySet<string>; onReplace: (s: TemplateStage) => void; readOnly?: boolean }) {
  const pretty = JSON.stringify(props.stage, null, 2);
  const [text, setText] = useState(pretty);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setText(pretty);
    setError(null);
  }, [pretty]);
  return (
    <details>
      <summary>Advanced: the stage as JSON</summary>
      <div className={s.props}>
        <p className={s.dim}>Bindings to evaluations, engines and reviews, a nested run and a retry policy are edited here.</p>
        <Field label="Stage JSON" error={error}>
          <Textarea className={s.code} value={text} rows={10} readOnly={props.readOnly} spellCheck={false} onChange={(e) => setText(e.target.value)} />
        </Field>
        {!props.readOnly && (
          <div className={s.toolbar}>
            <Button
              size="sm"
              onClick={() => {
                const out = parseStageJson(text, props.stage.id, props.others);
                if ("error" in out) return setError(out.error);
                setError(null);
                props.onReplace(out.stage);
              }}
            >
              Apply JSON
            </Button>
          </div>
        )}
      </div>
    </details>
  );
}
