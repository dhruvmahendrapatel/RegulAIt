/**
 * Pillar 4 — the shared context store, natively in the SPA.
 *
 * The whole point of this surface is that a cross-team context store is only
 * trustworthy if a write can never silently overwrite someone else's text, so
 * the optimistic-concurrency contract from §9.2 is implemented literally:
 *
 *  (a) opening the editor READS the current accepted revision first, so the
 *      draft is based on something real and the write can name its base;
 *  (b) saving RE-READS at submit time — if the key moved underneath the edit
 *      the write is not sent at all; both texts are shown side by side;
 *  (c) a real `409 base_revision_required` (the key was created by someone
 *      else while a NEW-key draft was open) lands in the same conflict view —
 *      never a silent retry;
 *  (d) the member picks the resolution: REBASE onto the now-accepted revision
 *      (their text becomes the next accepted revision), or ESCALATE by
 *      submitting against their own stale base — which the gateway retains as
 *      a non-current revision and routes to the project's named arbiter.
 *      Nothing is overwritten either way.
 *
 * Writes answer with an OUTCOME OBJECT, not a success boolean: a 201 carrying
 * `accepted:false` / `conflict:true` means "retained, not current, with the
 * arbiter". Every outcome here is reported for what it actually is.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../../api/client";
import type {
  ContextHistoryResponse,
  ContextHistoryRow,
  ContextItem,
  ContextResponse,
  ContextWriteOutcome,
  WorkflowDetailResponse,
  WorkflowListResponse,
} from "../../api/types";
import { ago } from "../../api/format";
import { useToast } from "../../ui/toast";
import {
  Badge,
  Button,
  Card,
  CodeBlock,
  EmptyState,
  ErrorState,
  Field,
  Input,
  Modal,
  SkeletonBlock,
  Textarea,
} from "../../ui/kit";
import { ProjectChrome, useProjectChrome } from "./projectChrome";
import v from "../views.module.css";
import c from "./context.module.css";

interface DirectoryUser {
  id: string;
  name: string;
}

interface PromotableArtifact {
  id: string;
  output: string;
  version: number;
  content: string;
  instanceId: string;
  initiatorUserId: string | null;
  description: string;
}

/** what the editor is doing to the store, in the member's own words */
type WriteMode = "new" | "revise" | "rebase" | "arbiter";

interface Conflict {
  revision: number;
  content: string;
  byName: string | null;
  teamName: string | null;
  at: string | null;
}

/** the last write's real answer, kept on screen (a toast is too fleeting for
 * a governance outcome the member may need to act on) */
interface Outcome {
  tone: "ok" | "warn";
  title: string;
  body: string;
}

export default function ProjectContextPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const chrome = useProjectChrome(projectId);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const ctxQ = useQuery({
    queryKey: ["project-context", projectId],
    enabled: Boolean(projectId),
    queryFn: () => api.get<ContextResponse>(`/v1/projects/${projectId}/context`),
  });
  const directoryQ = useQuery({
    queryKey: ["directory"],
    queryFn: () => api.get<{ users: DirectoryUser[] }>("/v1/users/directory"),
  });
  const promotableQ = useQuery({
    queryKey: ["project-promotable", projectId],
    enabled: Boolean(projectId),
    queryFn: async (): Promise<PromotableArtifact[]> => {
      const list = await api
        .get<WorkflowListResponse>("/v1/workflows/instances")
        .catch(() => ({ instances: [] }) as WorkflowListResponse);
      const done = (list.instances ?? [])
        .filter((i) => i.projectId === projectId && i.status === "completed")
        .slice(0, 8);
      const out: PromotableArtifact[] = [];
      for (const inst of done) {
        try {
          const detail = await api.get<WorkflowDetailResponse>(`/v1/workflows/instances/${inst.id}`);
          const latest = new Map<string, { id: string; output: string; version: number; content: string }>();
          for (const a of detail.artifacts ?? []) {
            const seen = latest.get(a.output);
            if (!seen || seen.version < a.version) latest.set(a.output, a);
          }
          for (const a of latest.values()) {
            out.push({
              ...a,
              instanceId: inst.id,
              initiatorUserId: detail.instance?.initiatorUserId ?? null,
              description: detail.instance?.change?.description ?? "",
            });
          }
        } catch {
          // an instance this caller may not open simply isn't promotable here
        }
      }
      return out;
    },
  });

  const [editing, setEditing] = useState<{ key: string | null } | null>(null);
  const [openHistory, setOpenHistory] = useState<Set<string>>(new Set());
  const [openText, setOpenText] = useState<Set<string>>(new Set());
  const [promoteTarget, setPromoteTarget] = useState<PromotableArtifact | null>(null);
  const [promoting, setPromoting] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const items = useMemo(() => ctxQ.data?.context ?? [], [ctxQ.data]);
  const pending = useMemo(() => ctxQ.data?.pending ?? [], [ctxQ.data]);
  const arbiter = ctxQ.data?.arbiter ?? null;
  const arbiterName = arbiter?.name ?? "the project arbiter";
  const pendingByKey = useMemo(() => {
    const map = new Map<string, number>();
    for (const p of pending) map.set(p.key, (map.get(p.key) ?? 0) + 1);
    return map;
  }, [pending]);

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["project-context", projectId] });
    void queryClient.invalidateQueries({ queryKey: ["context-graph", projectId] });
    void queryClient.invalidateQueries({ queryKey: ["context-history", projectId] });
    void queryClient.invalidateQueries({ queryKey: ["approvals"] });
  }, [queryClient, projectId]);

  /** the one place a write outcome is turned into words — never "success" */
  const reportOutcome = useCallback(
    (r: ContextWriteOutcome, what: string) => {
      const retained = r.conflict === true || r.accepted === false;
      const next: Outcome = retained
        ? {
            tone: "warn",
            title: `Revision ${r.revision} of “${r.key}” was retained, but it is NOT the current value`,
            body:
              `It is based on a revision that is no longer the accepted head, so the gateway kept both texts and ` +
              `sent yours to ${arbiterName} to decide. Nothing was overwritten. It becomes current only if the ` +
              `arbiter accepts it.`,
          }
        : {
            tone: "ok",
            title: `Revision ${r.revision} of “${r.key}” is now the current value`,
            body: `${what} — every member of this project reads your text from now on.`,
          };
      setOutcome(next);
      toast(retained ? `Retained as revision ${r.revision} — with ${arbiterName}` : `Revision ${r.revision} accepted`, retained ? "info" : "success");
      refresh();
    },
    [arbiterName, refresh, toast],
  );

  const promote = useCallback(async () => {
    const target = promoteTarget;
    if (!target || !projectId) return;
    setPromoting(true);
    try {
      const r = await api.post<ContextWriteOutcome>(`/v1/projects/${projectId}/context/promote`, {
        artifactId: target.id,
      });
      setPromoteTarget(null);
      reportOutcome(r, `Promoted from the signed-off artifact “${target.output}” v${target.version}`);
    } catch (e) {
      const msg =
        e instanceof ApiError && e.status === 403 && e.payload.error === "not_the_artifact_owner"
          ? "Only the workflow's initiator can promote its artifacts — this one isn't yours to share."
          : e instanceof ApiError && e.status === 409 && e.payload.error === "base_revision_required"
            ? "The key moved between reading it and promoting — reopen the promote and try again."
            : e instanceof Error
              ? e.message
              : "promote failed";
      setPromoteTarget(null);
      setOutcome({ tone: "warn", title: "Nothing was promoted", body: msg });
      toast(msg, "error");
    } finally {
      setPromoting(false);
    }
  }, [promoteTarget, projectId, reportOutcome, toast]);

  const userName = (uid: string | null | undefined) =>
    (uid && (directoryQ.data?.users ?? []).find((u) => u.id === uid)?.name) || null;

  if (chrome.projectsQ.isLoading || ctxQ.isLoading) {
    return (
      <>
        <ProjectChrome
          projectId={projectId}
          project={chrome.project}
          myRole={chrome.myRole}
          tab="context"
        />
        <Card>
          <SkeletonBlock lines={6} />
        </Card>
      </>
    );
  }

  if (ctxQ.isError) {
    const err = ctxQ.error as { status?: number; message?: string };
    return (
      <>
        <ProjectChrome
          projectId={projectId}
          project={chrome.project}
          myRole={chrome.myRole}
          tab="context"
        />
        <Card>
          <ErrorState
            message={err.message ?? "unknown error"}
            access={err.status === 403}
            onRetry={() => void ctxQ.refetch()}
          />
        </Card>
      </>
    );
  }

  return (
    <>
      <ProjectChrome
        projectId={projectId}
        project={chrome.project}
        myRole={chrome.myRole}
        tab="context"
        sub={
          <span className={v.faint}>
            {items.length} key{items.length === 1 ? "" : "s"}
            {arbiter ? ` · arbiter ${arbiter.name ?? "unnamed"}` : " · no arbiter set"}
          </span>
        }
        actions={
          chrome.canWrite ? (
            <Button size="sm" variant="primary" onClick={() => setEditing({ key: null })}>
              Add context
            </Button>
          ) : undefined
        }
      />

      <div className={v.stack}>
        {outcome && (
          <Card>
            <div data-testid="context-outcome" className={v.row} style={{ alignItems: "flex-start" }}>
              <Badge tone={outcome.tone === "ok" ? "ok" : "warn"}>
                {outcome.tone === "ok" ? "accepted" : "retained · with the arbiter"}
              </Badge>
              <div className={v.grow}>
                <div style={{ fontSize: "var(--text-md)", fontWeight: 600 }}>{outcome.title}</div>
                <div className={v.dim} style={{ marginTop: "var(--s0)" }}>
                  {outcome.body}
                </div>
              </div>
              <Button size="sm" variant="ghost" onClick={() => setOutcome(null)}>
                Dismiss
              </Button>
            </div>
          </Card>
        )}

        {pending.length > 0 && (
          <Card title="Conflicting revisions awaiting a decision">
            <div className={v.dim} style={{ marginBottom: "var(--s1)" }}>
              Retained, never current. {arbiter?.userId === chrome.me ? "You are" : `${arbiterName} is`} the named
              arbiter — the decision is taken in{" "}
              {arbiter?.userId === chrome.me ? <Link to="/inbox">your Inbox</Link> : "their Inbox"}.
            </div>
            {pending.map((p) => (
              <div key={p.itemId} className={v.listRow}>
                <div className={v.grow}>
                  <div className={v.rowTight}>
                    <span className={c.entryKey}>{p.key}</span>
                    <Badge tone="warn">rev {p.revision} · awaiting arbiter</Badge>
                    {p.baseRevision != null && <Badge>based on rev {p.baseRevision}</Badge>}
                  </div>
                  <div className={v.faint}>
                    by {p.byName ?? "unknown"}
                    {p.teamName ? ` · ${p.teamName}` : ""} · {ago(p.at)}
                  </div>
                </div>
              </div>
            ))}
          </Card>
        )}

        <Card title="Shared context">
          <div className={v.dim} style={{ marginBottom: "var(--s1)" }}>
            Provenance travels with every revision — who wrote it, on behalf of which team, and which revision it was
            based on. A write always names its base, so no one is ever silently overwritten.
          </div>
          {items.length === 0 ? (
            <EmptyState
              title="No shared context yet"
              body={
                chrome.canWrite
                  ? "Shared context is what every member of this project — across teams — reads before doing anything. Add the first key."
                  : "Nothing has been contributed yet. Contributors and owners can add the first key."
              }
              {...(chrome.canWrite
                ? {
                    action: (
                      <Button size="sm" variant="primary" onClick={() => setEditing({ key: null })}>
                        Add context
                      </Button>
                    ),
                  }
                : {})}
            />
          ) : (
            items.map((item) => (
              <ContextEntry
                key={item.key}
                projectId={projectId!}
                item={item}
                pendingCount={pendingByKey.get(item.key) ?? 0}
                canWrite={chrome.canWrite}
                textOpen={openText.has(item.key)}
                historyOpen={openHistory.has(item.key)}
                onToggleText={() =>
                  setOpenText((prev) => {
                    const next = new Set(prev);
                    if (next.has(item.key)) next.delete(item.key);
                    else next.add(item.key);
                    return next;
                  })
                }
                onToggleHistory={() =>
                  setOpenHistory((prev) => {
                    const next = new Set(prev);
                    if (next.has(item.key)) next.delete(item.key);
                    else next.add(item.key);
                    return next;
                  })
                }
                onEdit={() => setEditing({ key: item.key })}
              />
            ))
          )}
        </Card>

        <Card title="Promote a signed-off artifact">
          <div className={v.dim} style={{ marginBottom: "var(--s1)" }}>
            Opt-in partial sharing: a team&apos;s own workflow output, copied into the shared store with a link back to
            the artifact it came from. Only the workflow&apos;s initiator may share it.
          </div>
          {promotableQ.isLoading ? (
            <SkeletonBlock lines={3} />
          ) : (promotableQ.data ?? []).length === 0 ? (
            <EmptyState
              title="Nothing promotable yet"
              body="An artifact becomes promotable once its workflow has completed — a signed-off output, not a draft. Completed workflows attributed to this project appear here."
            />
          ) : (
            (promotableQ.data ?? []).map((a) => {
              const mine = chrome.isAdmin || a.initiatorUserId === chrome.me;
              return (
                <div
                  key={a.id}
                  className={v.listRow}
                  style={{ alignItems: "center" }}
                  data-testid={`promotable-${a.output}`}
                >
                  <div className={v.grow}>
                    <div className={v.rowTight}>
                      <span className={c.entryKey}>{a.output}</span>
                      <Badge>v{a.version}</Badge>
                    </div>
                    <div className={v.faint}>
                      signed-off artifact of “{a.description || "an untitled change"}”
                      {!mine && (
                        <>
                          {" · "}
                          only {userName(a.initiatorUserId) ?? "its initiator"} can promote it
                        </>
                      )}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    disabled={!mine}
                    title={mine ? undefined : "partial sharing is opt-in — only the workflow's initiator may promote"}
                    onClick={() => setPromoteTarget(a)}
                  >
                    Promote
                  </Button>
                </div>
              );
            })
          )}
        </Card>
      </div>

      {editing && projectId && (
        <ContextEditorModal
          projectId={projectId}
          entryKey={editing.key}
          arbiterName={arbiter ? (arbiter.name ?? "the named arbiter") : null}
          onClose={() => setEditing(null)}
          onOutcome={(r, mode) => {
            setEditing(null);
            reportOutcome(
              r,
              mode === "new"
                ? "First revision of a new key"
                : mode === "rebase"
                  ? "Rebased onto the revision that was accepted while you were editing"
                  : "Saved on top of the revision it was based on",
            );
          }}
        />
      )}

      <Modal
        open={Boolean(promoteTarget)}
        title="Promote into shared context?"
        onClose={() => setPromoteTarget(null)}
        actions={
          <>
            <Button onClick={() => setPromoteTarget(null)}>Cancel</Button>
            <Button variant="primary" disabled={promoting} onClick={() => void promote()}>
              {promoting ? "Promoting…" : "Promote"}
            </Button>
          </>
        }
      >
        {promoteTarget && (
          <div className={v.stack}>
            <div className={v.dim}>
              This copies the artifact <strong>{promoteTarget.output}</strong> v{promoteTarget.version} into{" "}
              <strong>{chrome.project?.name ?? "this project"}</strong>&apos;s shared context under the key{" "}
              <span className={c.entryKey}>{promoteTarget.output}</span>, carrying a provenance link back to the
              artifact. It is written on top of whatever revision of that key is accepted right now — so if the key
              already exists, this becomes its next revision rather than replacing its history.
            </div>
            <div className={v.faint}>
              If the key moves between this read and the write, the gateway retains your revision and routes it to{" "}
              {arbiterName} instead of making it current. The result is reported either way.
            </div>
            <CodeBlock maxHeight="180px">{promoteTarget.content}</CodeBlock>
          </div>
        )}
      </Modal>
    </>
  );
}

// ---------------------------------------------------------------- entry ----

function ContextEntry(props: {
  projectId: string;
  item: ContextItem;
  pendingCount: number;
  canWrite: boolean;
  textOpen: boolean;
  historyOpen: boolean;
  onToggleText: () => void;
  onToggleHistory: () => void;
  onEdit: () => void;
}) {
  const prov = props.item.provenance ?? {};
  const historyQ = useQuery({
    queryKey: ["context-history", props.projectId, props.item.key],
    enabled: props.historyOpen,
    queryFn: () =>
      api.get<ContextHistoryResponse>(
        `/v1/projects/${props.projectId}/context?key=${encodeURIComponent(props.item.key)}&history=true`,
      ),
  });

  return (
    <div className={c.entry} data-testid={`context-entry-${props.item.key}`}>
      <div className={c.entryHead}>
        <div className={v.grow}>
          <div className={v.rowTight}>
            <span className={c.entryKey}>{props.item.key}</span>
            <Badge tone="ok">rev {props.item.revision} · current</Badge>
            {prov.sourceArtifactId && (
              <Badge tone="info" title="promoted from a signed-off workflow artifact">
                from artifact
              </Badge>
            )}
            {props.pendingCount > 0 && (
              <Badge tone="warn" title="a conflicting revision of this key is with the arbiter">
                {props.pendingCount} awaiting arbiter
              </Badge>
            )}
          </div>
          <div className={v.faint} style={{ marginTop: "var(--s0)" }}>
            by {prov.userName ?? "unknown"}
            {prov.teamName ? ` · ${prov.teamName}` : " · no team"} · {ago(prov.at)}
          </div>
        </div>
        <div className={c.entryActions}>
          <Button size="sm" variant="ghost" onClick={props.onToggleText}>
            {props.textOpen ? "Hide text" : "Show text"}
          </Button>
          <Button size="sm" variant="ghost" onClick={props.onToggleHistory}>
            {props.historyOpen ? "Hide history" : "History"}
          </Button>
          {props.canWrite && (
            <Button
              size="sm"
              onClick={props.onEdit}
              title="edit — reads the current accepted revision first, so your write can name its base"
            >
              Edit
            </Button>
          )}
        </div>
      </div>

      {props.textOpen && (
        <div style={{ marginTop: "var(--s1)" }}>
          <CodeBlock maxHeight="260px">{props.item.content}</CodeBlock>
        </div>
      )}

      {props.historyOpen && (
        <div className={c.drawer}>
          {historyQ.isLoading ? (
            <SkeletonBlock lines={3} />
          ) : historyQ.isError ? (
            <ErrorState
              message={(historyQ.error as Error).message}
              onRetry={() => void historyQ.refetch()}
            />
          ) : (
            [...(historyQ.data?.history ?? [])].reverse().map((row) => <HistoryRow key={row.id} row={row} />)
          )}
        </div>
      )}
    </div>
  );
}

function HistoryRow(props: { row: ContextHistoryRow }) {
  const [open, setOpen] = useState(false);
  const r = props.row;
  return (
    <div className={c.drawerRow}>
      <div className={v.rowTight}>
        <span className={v.mono}>rev {r.revision}</span>
        {r.accepted ? (
          <Badge tone="ok">accepted</Badge>
        ) : r.pendingApprovalId ? (
          <Badge tone="warn">awaiting arbiter</Badge>
        ) : (
          <Badge tone="danger">rejected · retained</Badge>
        )}
        {r.sourceArtifactId && <Badge tone="info">from artifact</Badge>}
      </div>
      <div className={v.faint}>
        by {r.byName ?? "unknown"}
        {r.teamName ? ` · ${r.teamName}` : ""}
        {r.baseRevision != null ? ` · based on rev ${r.baseRevision}` : " · first write of this key"} ·{" "}
        {ago(r.createdAt)}
      </div>
      <div>
        <Button size="sm" variant="ghost" onClick={() => setOpen((o) => !o)}>
          {open ? "Hide text" : "Show text"}
        </Button>
      </div>
      {open && <CodeBlock maxHeight="220px">{r.content}</CodeBlock>}
    </div>
  );
}

// --------------------------------------------------------------- editor ----

function ContextEditorModal(props: {
  projectId: string;
  /** null = a brand-new key */
  entryKey: string | null;
  /** null when the project has no arbiter — escalation is then impossible */
  arbiterName: string | null;
  onClose: () => void;
  onOutcome: (outcome: ContextWriteOutcome, mode: WriteMode) => void;
}) {
  const [loading, setLoading] = useState(props.entryKey !== null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [keyName, setKeyName] = useState(props.entryKey ?? "");
  const [keyLocked, setKeyLocked] = useState(props.entryKey !== null);
  const [base, setBase] = useState<number | undefined>(undefined);
  const [draft, setDraft] = useState("");
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const readCurrent = useCallback(
    async (key: string) => {
      const cur = await api.get<ContextResponse>(
        `/v1/projects/${props.projectId}/context?key=${encodeURIComponent(key)}`,
      );
      return (cur.context ?? [])[0] ?? null;
    },
    [props.projectId],
  );

  // (a) read-before-write: the editor never opens on a guess
  const load = useCallback(async () => {
    if (props.entryKey === null) return;
    setLoading(true);
    setLoadError(null);
    try {
      const item = await readCurrent(props.entryKey);
      setBase(item ? item.revision : undefined);
      setDraft(item ? item.content : "");
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "could not read the current revision");
    } finally {
      setLoading(false);
    }
  }, [props.entryKey, readCurrent]);

  useEffect(() => {
    void load();
  }, [load]);

  const toConflict = (item: ContextItem): Conflict => ({
    revision: item.revision,
    content: item.content,
    byName: item.provenance?.userName ?? null,
    teamName: item.provenance?.teamName ?? null,
    at: item.provenance?.at ?? null,
  });

  const submit = useCallback(
    async (mode: "auto" | "rebase" | "arbiter") => {
      const key = (props.entryKey ?? keyName).trim();
      setError(null);
      if (!key) {
        setError("key: a key is required");
        return;
      }
      if (!draft.trim()) {
        setError("content: nothing to save");
        return;
      }
      const payload: { key: string; content: string; baseRevision?: number } = { key, content: draft };
      let effective: WriteMode = base === undefined ? "new" : "revise";

      if (mode === "arbiter") {
        if (base === undefined) {
          setError("there is no base revision to submit against — rebase instead");
          return;
        }
        payload.baseRevision = base; // deliberately the STALE base → arbiter
        effective = "arbiter";
      } else if (mode === "rebase") {
        if (!conflict) return;
        payload.baseRevision = conflict.revision; // rebase onto what is accepted now
        effective = "rebase";
      } else {
        // (b) re-read at submit time — never write against a stale read
        setBusy(true);
        let latest: ContextItem | null = null;
        try {
          latest = await readCurrent(key);
        } catch (e) {
          setBusy(false);
          setError(e instanceof Error ? e.message : "could not re-read the current revision");
          return;
        }
        setBusy(false);
        if (latest && base !== undefined && latest.revision === base) {
          payload.baseRevision = base;
        } else if (latest) {
          // it moved underneath this edit — show both texts, submit nothing
          setKeyName(key);
          setKeyLocked(true);
          setConflict(toConflict(latest));
          return;
        }
        // no accepted revision at all → a genuinely new key, no baseRevision
      }

      setBusy(true);
      try {
        const r = await api.post<ContextWriteOutcome>(`/v1/projects/${props.projectId}/context`, payload);
        props.onOutcome(r, effective);
      } catch (e) {
        if (
          e instanceof ApiError &&
          e.status === 409 &&
          e.payload.error === "base_revision_required"
        ) {
          // (c) the key was created by someone else while this draft was open —
          // the SAME conflict view, never a silent retry
          try {
            const latest = await readCurrent(key);
            if (latest) {
              setKeyName(key);
              setKeyLocked(true);
              setConflict(toConflict(latest));
              setError(null);
              return;
            }
          } catch {
            /* fall through to the generic message */
          }
          setError(
            "this key already exists — reopen it from the list so the write can name the revision it is based on",
          );
          return;
        }
        if (e instanceof ApiError && e.status === 422 && e.payload.error === "no_arbiter") {
          setError(
            "this project has no named arbiter, so a revision based on a stale head cannot be retained — ask an owner to name one, or rebase instead",
          );
          return;
        }
        setError(e instanceof Error ? e.message : "save failed");
      } finally {
        setBusy(false);
      }
    },
    [base, conflict, draft, keyName, props, readCurrent],
  );

  const title = conflict
    ? "This key changed while you were editing"
    : props.entryKey === null
      ? "Add shared context"
      : `Edit “${props.entryKey}”`;

  return (
    <Modal
      open
      wide
      title={title}
      onClose={props.onClose}
      actions={
        loading || loadError ? (
          <Button onClick={props.onClose}>Close</Button>
        ) : conflict ? (
          <>
            <Button onClick={props.onClose}>Cancel</Button>
            {base !== undefined && (
              <Button
                disabled={busy || !props.arbiterName}
                title={
                  props.arbiterName
                    ? undefined
                    : "this project has no named arbiter — an owner must name one before a stale-base revision can be retained"
                }
                onClick={() => void submit("arbiter")}
              >
                Escalate to {props.arbiterName ?? "an arbiter"}
              </Button>
            )}
            <Button variant="primary" disabled={busy} onClick={() => void submit("rebase")}>
              Rebase on rev {conflict.revision} &amp; save
            </Button>
          </>
        ) : (
          <>
            <Button onClick={props.onClose}>Cancel</Button>
            <Button variant="primary" disabled={busy} onClick={() => void submit("auto")}>
              {busy ? "Saving…" : "Save revision"}
            </Button>
          </>
        )
      }
    >
      {loading ? (
        <SkeletonBlock lines={4} />
      ) : loadError ? (
        <ErrorState message={loadError} onRetry={() => void load()} />
      ) : conflict ? (
        <div className={v.stack} data-testid="context-conflict">
          <div className={c.conflictNote}>
            <strong>
              “{keyName}” is now at revision {conflict.revision}
              {conflict.byName ? ` by ${conflict.byName}` : ""}
              {conflict.teamName ? ` (${conflict.teamName})` : ""}
            </strong>
            {base !== undefined ? (
              <> — your edit was based on revision {base}.</>
            ) : (
              <> — you were writing this key as new, but it already exists.</>
            )}{" "}
            Nothing has been sent. Compare both texts and choose how this resolves; neither option overwrites the
            other one.
          </div>

          <div className={c.bothTexts}>
            <div>
              <div className={c.sideLabel}>
                <Badge tone="ok">theirs · rev {conflict.revision}</Badge>
                <span>accepted now</span>
              </div>
              <CodeBlock maxHeight="300px">{conflict.content}</CodeBlock>
            </div>
            <div>
              <div className={c.sideLabel}>
                <Badge tone="info">yours</Badge>
                <span>unsent draft</span>
              </div>
              <CodeBlock maxHeight="300px">{draft}</CodeBlock>
            </div>
          </div>

          <div className={c.resolution}>
            <div style={{ fontSize: "var(--text-md)", fontWeight: 600 }}>How this resolves</div>
            <div className={c.resolutionWhy}>
              <strong>Rebase on rev {conflict.revision}</strong> — your text is written as the next revision on top of
              theirs and becomes the current value immediately. Their revision stays in the history.
            </div>
            <div className={c.resolutionWhy}>
              {base === undefined ? (
                <>
                  <strong>Escalating is not available here</strong> — you had no base revision to submit against, so
                  there is no stale-base claim for an arbiter to weigh. Rebase, or cancel and reopen the key.
                </>
              ) : props.arbiterName ? (
                <>
                  <strong>Escalate to {props.arbiterName}</strong> — your text is submitted against revision {base}{" "}
                  anyway. The gateway keeps it as a retained, non-current revision and puts the decision in{" "}
                  {props.arbiterName}&apos;s Inbox. Theirs stays current until the arbiter says otherwise.
                </>
              ) : (
                <>
                  <strong>Escalation is unavailable</strong> — this project has no named arbiter, so a stale-base
                  revision cannot be retained. An owner must name one first.
                </>
              )}
            </div>
          </div>

          {error && (
            <div className={v.errLine} role="alert">
              {error}
            </div>
          )}
        </div>
      ) : (
        <div className={v.stack}>
          {!keyLocked && (
            <Field label="Key">
              <Input
                value={keyName}
                placeholder="e.g. coding-standards"
                onChange={(e) => setKeyName(e.target.value)}
              />
            </Field>
          )}
          {keyLocked && (
            <div className={v.rowTight}>
              <span className={c.entryKey}>{keyName}</span>
              {base !== undefined && <Badge tone="ok">editing from rev {base}</Badge>}
            </div>
          )}
          <Field label="Content" grow>
            <Textarea
              rows={10}
              spellCheck={false}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              aria-label="Context content"
            />
          </Field>
          <div className={v.faint}>
            {base !== undefined ? (
              <>
                This write names revision {base} as its base, so it can never silently overwrite someone else. If the
                key moves before you save, you will be shown both texts and asked to choose
                {props.arbiterName ? ` — rebasing, or escalating to ${props.arbiterName}` : ""}.
              </>
            ) : (
              <>First revision of a new key. It has no base revision because nothing exists to be based on yet.</>
            )}
          </div>
          {error && (
            <div className={v.errLine} role="alert">
              {error}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
