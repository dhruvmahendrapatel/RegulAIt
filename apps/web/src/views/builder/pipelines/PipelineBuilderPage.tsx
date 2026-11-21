/**
 * ADR-0341 slice 2 — the visual pipeline builder: one workflow template's draft, edited on a canvas, in an Outline
 * view and in a property sheet. Admin only (the route sits under RequireAdmin, and the gateway refuses everyone else).
 *
 * The page renders; the state lives in `usePipelineDraft` and every edit is a pure function in
 * `pipelineCanvasModel`. The canvas is a lazy chunk (with @xyflow/react and dagre), so the page's own chunk stays
 * small; at phone width the editor opens in the Outline view and the canvas is read-only.
 */
import { lazy, Suspense, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { PageHeader } from "../../../shell/AppShell";
import { Button, Card, ConfirmModal, EmptyState, RecordError, SkeletonBlock, TabPanel, Tabs } from "../../../ui/kit";
import { useToast } from "../../../ui/toast";
import { ApiError } from "../../../api/client";
import { plural } from "../../../api/format";
import { insertStage, moveStage, newStage, removeStage, updateStage, isStageType, type StageType, type TemplateStage } from "./pipelineCanvasModel";
import { isNoDraft, usePipelineDraft } from "./usePipelineDraft";
import StagePalette from "./StagePalette";
import StageOutline from "./StageOutline";
import StageProperties from "./StageProperties";
import s from "./pipelineBuilder.module.css";

const PipelineCanvas = lazy(() => import("./PipelineCanvas"));

const PHONE_QUERY = "(max-width: 700px)";
const TAB_PREFIX = "pipeline-view";

function usePhone(): boolean {
  const query = () => (typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(PHONE_QUERY) : null);
  const [phone, setPhone] = useState(() => query()?.matches ?? false);
  useEffect(() => {
    const mq = query();
    if (!mq) return;
    const on = () => setPhone(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return phone;
}

const back = (
  <Link to="/admin/workflow-templates">Back to workflow templates</Link>
);

export default function PipelineBuilderPage() {
  const { templateId = "" } = useParams();
  const st = usePipelineDraft(templateId);
  const phone = usePhone();
  const { toast } = useToast();
  const [view, setView] = useState<"canvas" | "outline">(phone ? "outline" : "canvas");
  useEffect(() => {
    if (phone) setView("outline");
  }, [phone]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<unknown>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  const def = st.working;
  const selected = useMemo(() => def?.stages.find((x) => x.id === selectedId) ?? null, [def, selectedId]);
  useEffect(() => {
    if (selectedId && def && !def.stages.some((x) => x.id === selectedId)) setSelectedId(null);
  }, [def, selectedId]);

  const insert = useCallback(
    (type: string, index: number) => {
      if (!def || !isStageType(type)) return;
      const stage = newStage(def, type);
      st.edit((d) => insertStage(d, index, stage));
      setSelectedId(stage.id);
    },
    [def, st],
  );
  const addAfterSelected = useCallback(
    (type: StageType) => {
      if (!def) return;
      const i = selectedId ? def.stages.findIndex((x) => x.id === selectedId) : -1;
      insert(type, i >= 0 ? i + 1 : def.stages.length);
    },
    [def, insert, selectedId],
  );
  const move = useCallback((id: string, to: number) => st.edit((d) => moveStage(d, id, to)), [st]);
  const remove = useCallback(
    (id: string) => {
      st.edit((d) => removeStage(d, id));
      toast(`Stage ${id} removed. Undo puts it back.`, "success");
    },
    [st, toast],
  );

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    if (busy) return;
    setBusy(true);
    setSaveError(null);
    try {
      await fn();
      toast(ok, "success");
    } catch (e) {
      setSaveError(e);
    } finally {
      setBusy(false);
    }
  };

  const header = (actions?: ReactNode) => (
    <PageHeader
      title={st.server ? `Edit ${st.server.template.name}` : "Edit workflow template"}
      crumbs={["Policies & gates", "Workflow templates"]}
      sub="Draw the stages of this workflow. Changes stay in the draft until it is published."
      info={
        <>
          The canvas, the Outline view and the property sheet all edit the same template definition that runs. Every
          change is checked by the server as you work: the plan-only stage must come before anything that changes code,
          and a deploy needs a sign-off and checks before it. Nothing goes live until an admin publishes the draft.
        </>
      }
      actions={actions}
    />
  );

  if (st.draft.isLoading) {
    return (
      <>
        {header()}
        <Card>
          <div role="status" aria-label="Loading the draft">
            <SkeletonBlock lines={6} />
          </div>
        </Card>
      </>
    );
  }

  if (st.draft.error) {
    if (isNoDraft(st.draft.error)) {
      return (
        <>
          {header()}
          <Card>
            <EmptyState
              title="This template has no open draft"
              body="Open a draft to edit a copy of the live definition. The live template keeps running until a draft is published."
              action={
                <Button variant="primary" aria-disabled={busy} onClick={() => void run(() => st.open(), "Draft opened")}>
                  Open a draft
                </Button>
              }
            />
            <SaveProblem error={saveError} />
          </Card>
        </>
      );
    }
    return (
      <>
        {header()}
        <Card>
          <RecordError noun="workflow template" error={st.draft.error} onRetry={() => void st.draft.refetch()} action={back} />
        </Card>
      </>
    );
  }

  if (!st.server || !def) {
    return (
      <>
        {header()}
        <Card>
          <RecordError noun="draft" error={{ status: 500, message: "The answer did not hold a draft." }} onRetry={() => void st.draft.refetch()} action={back} />
        </Card>
      </>
    );
  }

  const v = st.validation;
  const issueCount = v.issues.length;
  const statusText = v.pending
    ? "Checking the draft…"
    : v.error
      ? `The draft could not be checked: ${v.error}`
      : v.valid
        ? "No problems found: the draft can be published."
        : `${plural(issueCount, "problem", "problems")} to fix before publishing.`;
  const general = st.byStage.get("") ?? [];

  return (
    <>
      {header(
        <>
          <Button size="sm" onClick={st.undo} disabled={!st.canUndo}>
            Undo
          </Button>
          <Button size="sm" onClick={st.redo} disabled={!st.canRedo}>
            Redo
          </Button>
          <Button size="sm" variant="danger" onClick={() => setConfirmDiscard(true)}>
            Discard draft
          </Button>
          <Button variant="primary" aria-disabled={busy || !st.dirty} onClick={() => st.dirty && void run(() => st.save(), "Draft saved")}>
            Save draft
          </Button>
        </>,
      )}
      <div className={s.toolbar}>
        <p className={[s.status, v.valid ? s.statusOk : ""].join(" ")} role="status" aria-live="polite">
          {statusText} {st.dirty ? "Unsaved changes." : "All changes saved."} Draft revision {st.server.draft.revision}, from version{" "}
          {st.server.draft.baseVersion ?? "—"}.
        </p>
      </div>
      {st.server.stale && (
        <p className={s.fieldError} role="alert">
          The template was published from elsewhere since this draft was opened. Discard this draft and open a new one to
          publish.
        </p>
      )}
      <SaveProblem error={saveError} onReload={() => void st.reload()} />
      <div className={s.layout}>
        <Card title="Stages">
          <StagePalette onAdd={addAfterSelected} afterLabel={selectedId ? `after ${selectedId}` : "at the end"} readOnly={phone} />
          {phone && <p className={s.dim}>Add and move stages in the Outline view at this width.</p>}
        </Card>
        <div className={s.pane}>
          <Tabs
            idPrefix={TAB_PREFIX}
            label="Builder view"
            active={view}
            onChange={(id) => setView(id as "canvas" | "outline")}
            tabs={[
              { id: "canvas", label: "Canvas" },
              { id: "outline", label: "Outline" },
            ]}
          />
          <TabPanel idPrefix={TAB_PREFIX} id="canvas" active={view} lazy>
            <p id="pipeline-canvas-hint" className={s.dim}>
              {phone
                ? "The canvas is read-only at this width."
                : "Drag a stage left or right to move it. With a stage focused: Enter edits it, Alt and an arrow key moves it, Delete removes it."}
            </p>
            <Suspense
              fallback={
                <div className={s.canvasLoading} role="status" aria-label="Loading the canvas">
                  <SkeletonBlock lines={3} />
                </div>
              }
            >
              <PipelineCanvas
                definition={def}
                issuesByStage={st.byStage}
                selectedId={selectedId}
                onSelect={setSelectedId}
                onMove={move}
                onInsert={insert}
                onRemove={remove}
                label={`Stages of ${st.server.template.name}`}
                describedBy="pipeline-canvas-hint"
                readOnly={phone}
              />
            </Suspense>
          </TabPanel>
          <TabPanel idPrefix={TAB_PREFIX} id="outline" active={view}>
            <StageOutline
              definition={def}
              issuesByStage={st.byStage}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onMove={move}
              onRemove={remove}
              onInsert={insert}
            />
          </TabPanel>
          {general.length > 0 && (
            <Card title="Problems with the whole workflow">
              <ul className={s.issues}>
                {general.map((i, n) => (
                  <li key={n}>{i.message}</li>
                ))}
              </ul>
            </Card>
          )}
          {issueCount > general.length && (
            <Card title="Problems by stage">
              <ul className={s.issues}>
                {v.issues
                  .filter((i) => i.stageId)
                  .map((i, n) => (
                    <li key={n}>
                      <button type="button" className={s.issueLink} onClick={() => setSelectedId(i.stageId)}>
                        {i.stageId}
                      </button>
                      : {i.message}
                    </li>
                  ))}
              </ul>
            </Card>
          )}
        </div>
        <Card title={selected ? `Stage ${selected.id}` : "Stage properties"}>
          {selected ? (
            <StageProperties
              key={selected.id}
              definition={def}
              stage={selected}
              issues={st.byStage.get(selected.id) ?? []}
              onChange={(changes) => {
                try {
                  st.edit((d) => updateStage(d, selected.id, changes));
                  if (typeof changes.id === "string") setSelectedId(changes.id);
                } catch (e) {
                  setSaveError(e);
                }
              }}
              onReplace={(stage: TemplateStage) => {
                st.edit((d) => ({ ...d, stages: d.stages.map((x) => (x.id === selected.id ? stage : x)) }));
                setSelectedId(stage.id);
              }}
              onMove={(delta) => move(selected.id, def.stages.findIndex((x) => x.id === selected.id) + delta)}
              onRemove={() => remove(selected.id)}
            />
          ) : (
            <p className={s.dim}>Choose a stage on the canvas or in the Outline view to edit it.</p>
          )}
        </Card>
      </div>
      <ConfirmModal
        open={confirmDiscard}
        title={`Discard the draft of ${st.server.template.name}?`}
        body="Every change in this draft is lost. The live template is not affected."
        danger
        confirmLabel="Discard draft"
        onCancel={() => setConfirmDiscard(false)}
        onConfirm={() => {
          setConfirmDiscard(false);
          void run(() => st.discard(), "Draft discarded");
        }}
      />
    </>
  );
}

/** a failed save, open or discard, inline with its next step (never only a toast) */
function SaveProblem(props: { error: unknown; onReload?: () => void }) {
  if (!props.error) return null;
  const conflict = props.error instanceof ApiError && props.error.status === 409 && props.error.payload?.error === "draft_revision_conflict";
  const message = props.error instanceof Error ? props.error.message : "Something went wrong.";
  return (
    <div role="alert" className={s.toolbar}>
      <p className={s.fieldError}>{conflict ? "Someone else saved this draft since you loaded it. Reload it to see their changes; your unsaved edits are lost." : message}</p>
      {conflict && props.onReload && (
        <Button size="sm" onClick={props.onReload}>
          Reload the draft
        </Button>
      )}
    </div>
  );
}
