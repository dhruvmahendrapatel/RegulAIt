/**
 * G1 (ADR-0206): the archive and unarchive dialogs, loaded only when an admin opens one.
 *
 * Archive (danger, reason recorded) lists the engine keys pinned to the project, which stop working once it is
 * archived, from GET /v1/projects/:id/archive-impact. A 409 from the archive names what to close first. Unarchive
 * asks for a step-up (`withStepUp`).
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../../api/client";
import type { Project, ProjectArchiveImpact } from "../../api/types";
import { fmtDay, plural } from "../../api/format";
import { withStepUp } from "../../stepup/stepUp";
import { ConfirmModal } from "../../ui/kit";
import { useToast } from "../../ui/toast";
import { ReasonModal } from "../admin/adminKit";
import a from "../admin/admin.module.css";
import v from "../views.module.css";

interface ArchiveRefusal {
  code: string;
  message: string;
  ids: string[];
}

const itThem = (n: number) => (n === 1 ? "it" : "them");

/** a 409 from archive, in words the admin can act on (the ids say what to go and close) */
function archiveRefusal(e: unknown): ArchiveRefusal | null {
  if (!(e instanceof ApiError) || e.status !== 409) return null;
  const code = String(e.payload.error ?? "");
  const count = (rows: unknown[] | undefined) => Number(e.payload.count ?? rows?.length ?? 0);
  if (code === "project_has_open_approvals") {
    const rows = (e.payload.approvals as Array<{ id: string }> | undefined) ?? [];
    const n = count(rows);
    return {
      code,
      message: `This project still has ${plural(n, "open approval")}. Decide or withdraw ${itThem(n)} first.`,
      ids: rows.map((r) => r.id),
    };
  }
  if (code === "project_has_running_work") {
    const rows = (e.payload.runs as Array<{ id: string }> | undefined) ?? [];
    const n = count(rows);
    return {
      code,
      message: `${plural(n, "workflow")} ${n === 1 ? "is" : "are"} still running. Wait for ${itThem(n)} to finish or cancel ${itThem(n)} first.`,
      ids: rows.map((r) => r.id),
    };
  }
  if (code === "project_has_open_delegations") {
    const rows = (e.payload.delegations as Array<{ id: string }> | undefined) ?? [];
    const n = count(rows);
    return {
      code,
      message: `This project still has ${plural(n, "live delegation")}. Revoke ${itThem(n)} first.`,
      ids: rows.map((r) => r.id),
    };
  }
  if (code === "project_already_archived") {
    return { code, message: "This project is already archived.", ids: [] };
  }
  return null;
}

/** the engine keys the archive will stop, read before the admin confirms */
function PinnedKeys(props: { projectId: string }) {
  const q = useQuery({
    queryKey: ["project-archive-impact", props.projectId],
    queryFn: () => api.get<ProjectArchiveImpact>(`/v1/projects/${props.projectId}/archive-impact`),
  });
  if (q.isLoading) return <div className={v.faint}>Checking engine keys pinned to this project…</div>;
  if (q.isError) {
    return (
      <div className={v.errLine} role="alert">
        Could not list the engine keys pinned to this project: {(q.error as Error).message}
      </div>
    );
  }
  const impact = q.data;
  if (!impact || impact.pinnedEngineKeyCount === 0) {
    return (
      <div className={v.faint} data-testid="archive-pinned-keys">
        No engine keys are pinned to this project.
      </div>
    );
  }
  const more = impact.pinnedEngineKeyCount - impact.pinnedEngineKeys.length;
  return (
    <div data-testid="archive-pinned-keys">
      <strong>
        {plural(impact.pinnedEngineKeyCount, "engine key")} pinned to this project will stop working:
      </strong>
      <ul className={v.flush} style={{ paddingLeft: "var(--s3)" }}>
        {impact.pinnedEngineKeys.map((k) => (
          <li key={k.id}>
            {k.name} <span className={v.mono}>{k.id}</span>
            {k.expiresAt ? <span className={v.faint}> · expires {fmtDay(k.expiresAt)}</span> : null}
          </li>
        ))}
        {more > 0 && <li className={v.faint}>and {plural(more, "more key")}</li>}
      </ul>
    </div>
  );
}

export function ArchiveProjectDialog(props: { project: Project; onClose: () => void }) {
  const p = props.project;
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [refusal, setRefusal] = useState<ArchiveRefusal | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <ReasonModal
      open
      title={`Archive project “${p.name}”?`}
      danger
      minLength={10}
      confirmLabel="Archive project"
      body={
        <>
          <span className={v.dim}>
            New spend can no longer be attributed to it, its budget stops being enforced and members can no longer add
            context. Spend, approvals and audit history are kept and stay visible. The reason is recorded in the audit
            log.
          </span>
          <PinnedKeys projectId={p.id} />
          {refusal && (
            <div className={`${a.outcome} ${a.outcomeDeny}`} role="alert" data-testid="archive-refusal" data-refusal={refusal.code}>
              <strong>{refusal.message}</strong>
              {refusal.ids.length > 0 && (
                <ul className={v.flush} style={{ paddingLeft: "var(--s3)" }}>
                  {refusal.ids.map((id) => (
                    <li key={id}>
                      <span className={v.mono}>{id}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {error && (
            <div className={v.errLine} role="alert">
              {error}
            </div>
          )}
        </>
      }
      onCancel={props.onClose}
      onConfirm={(reason) => {
        setRefusal(null);
        setError(null);
        void (async () => {
          try {
            await api.post(`/v1/projects/${p.id}/archive`, { reason });
            props.onClose();
            toast("Project archived", "success");
            void queryClient.invalidateQueries({ queryKey: ["projects"] });
          } catch (e) {
            const r = archiveRefusal(e);
            if (r) setRefusal(r);
            else setError(e instanceof Error ? e.message : String(e));
          }
        })();
      }}
    />
  );
}

export function UnarchiveProjectDialog(props: { project: Project; onClose: () => void }) {
  const p = props.project;
  const { toast } = useToast();
  const queryClient = useQueryClient();
  return (
    <ConfirmModal
      open
      title={`Unarchive project “${p.name}”?`}
      body="Spend can be attributed to it again and its budget is enforced again. You will be asked to confirm it's you."
      confirmLabel="Unarchive project"
      onCancel={props.onClose}
      onConfirm={() => {
        props.onClose();
        void (async () => {
          try {
            await withStepUp((h) => api.postWithHeaders(`/v1/projects/${p.id}/unarchive`, {}, h));
            toast("Project unarchived", "success");
          } catch (e) {
            toast(e instanceof Error ? e.message : String(e), "error");
          } finally {
            void queryClient.invalidateQueries({ queryKey: ["projects"] });
          }
        })();
      }}
    />
  );
}
