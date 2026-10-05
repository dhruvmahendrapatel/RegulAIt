/**
 * ADR-0173 batch 2b — one prompt: its commit history, the tags pointing into
 * it, a diff between any two commits, its promotions to prod and who can see it.
 *
 * Moving a tag other than prod happens at once. Moving prod sends a promotion
 * to the approvals queue, bound to (prompt, tag, commit hash); the approver
 * is someone other than the commit's author and other than the requester, and
 * the tag moves only when they approve — and only if nothing changed since.
 */
import { useEffect, useId, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ago } from "../../api/format";
import { useSession } from "../../session/SessionContext";
import { PageHeader } from "../../shell/AppShell";
import { Badge, Button, ConfirmModal, EmptyState, ErrorState, Field, Input, Modal, Select, SkeletonBlock, type Tone } from "../../ui/kit";
import { useToast } from "../../ui/toast";
import { useDirectory } from "./builderApi";
import { PromptSharingFields, VISIBILITY_LABEL } from "./BuilderPromptsPage";
import { pk, promptsApi, type PromptCommit, type PromptDetail, type PromptPromotion, type PromptVisibility } from "./promptsApi";
import { diffLinesOf, diffStats, PROD_TAG, prettyJson, shortHash, TAG_RE } from "./promptsLogic";
import s from "./builder.module.css";
import p from "./prompts.module.css";

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

const PROMOTION_LABEL: Record<PromptPromotion["status"], [string, Tone]> = {
  pending_approval: ["waiting for approval", "warn"],
  applied: ["promoted", "ok"],
  denied: ["denied", "danger"],
  stale: ["approved but stale — nothing moved", "neutral"],
};

function MoveTagDialog(props: { detail: PromptDetail; commit: PromptCommit | null; onClose: () => void }) {
  const { auth } = useSession();
  const directory = useDirectory();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const listId = useId();
  const [tag, setTag] = useState("staging");
  const [approver, setApprover] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (props.commit) {
      setTag("staging");
      setApprover("");
      setError(null);
    }
  }, [props.commit]);
  const isProd = tag === PROD_TAG;
  const candidates = (directory.data?.users ?? []).filter((u) => u.id !== auth?.userId && u.id !== props.commit?.authorUserId);
  const move = useMutation({
    mutationFn: () => promptsApi.moveTag(props.detail.prompt.id, tag, { commitHash: props.commit!.hash, ...(isProd ? { approverUserId: approver } : {}) }),
    onSuccess: (res) => {
      void queryClient.invalidateQueries({ queryKey: pk.prompt(props.detail.prompt.id) });
      void queryClient.invalidateQueries({ queryKey: pk.prompts });
      const who = candidates.find((u) => u.id === approver)?.name ?? "the approver";
      toast(res.pendingApproval ? `Sent to ${who} for approval — prod moves when they approve` : `${tag} now points at ${shortHash(props.commit!.hash)}`, "success");
      props.onClose();
    },
    onError: (e) => setError(errText(e)),
  });
  const tagOk = TAG_RE.test(tag);
  return (
    <Modal
      open={props.commit !== null}
      title={`Move a tag to ${shortHash(props.commit?.hash)}`}
      onClose={props.onClose}
      actions={
        <>
          <Button onClick={props.onClose}>Cancel</Button>
          <Button variant="primary" disabled={!tagOk || (isProd && !approver) || move.isPending} onClick={() => move.mutate()}>
            {move.isPending ? "Moving…" : isProd ? "Request promotion" : "Move tag"}
          </Button>
        </>
      }
    >
      <Field label="Tag" error={tag && !tagOk ? "Lower-case letters, digits, - or _, starting with a letter" : null}>
        <Input value={tag} onChange={(e) => setTag(e.target.value.trim())} list={listId} maxLength={32} />
      </Field>
      <datalist id={listId}>
        {[...new Set(["staging", PROD_TAG, ...props.detail.tags.map((t) => t.name)])].map((t) => (
          <option key={t} value={t} />
        ))}
      </datalist>
      {isProd ? (
        <>
          <p className={s.note} style={{ margin: 0 }} data-testid="prod-note">
            Moving prod goes to the approvals queue. The approver can&apos;t be you or the commit&apos;s author, and prod moves only if nothing has changed
            by the time they approve.
          </p>
          <Field label="Approver">
            <Select value={approver} onChange={(e) => setApprover(e.target.value)}>
              <option value="">Choose an approver</option>
              {candidates.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name ?? u.id}
                </option>
              ))}
            </Select>
          </Field>
        </>
      ) : (
        <p className={s.small} style={{ margin: 0 }}>
          Tags other than prod move straight away. Anything that follows this tag picks up the commit at once.
        </p>
      )}
      {error && (
        <p role="alert" className={p.err}>
          {error}
        </p>
      )}
    </Modal>
  );
}

function CommitView({ commit }: { commit: PromptCommit }) {
  return (
    <section className={p.pane} aria-label={`Commit ${shortHash(commit.hash)}`}>
      <h2 className={p.paneTitle}>
        Commit <span className={p.hash}>{shortHash(commit.hash)}</span>
      </h2>
      <p className={s.small} style={{ margin: 0 }}>
        {commit.message} · {commit.authorName ?? "someone"} · {ago(commit.createdAt)}
        {commit.parentHash ? <> · edited from <span className={p.hash}>{shortHash(commit.parentHash)}</span></> : " · first commit"}
      </p>
      <pre className={p.output} aria-label="Template">
        {commit.template}
      </pre>
      <div className={p.row}>
        <span className={s.small}>Variables</span>
        {commit.variables.length ? (
          <ul className={p.chips} aria-label="Variables">
            {commit.variables.map((v) => (
              <li key={v} className={p.chip}>
                {v}
              </li>
            ))}
          </ul>
        ) : (
          <span className={s.small}>none</span>
        )}
      </div>
      <p className={s.small} style={{ margin: 0 }}>
        Model: {commit.modelConfig.agentId ? <span className={p.hash}>{commit.modelConfig.agentId}</span> : "not pinned"}
        {commit.modelConfig.maxTokens ? ` · up to ${commit.modelConfig.maxTokens} output tokens` : ""}
      </p>
      {commit.outputSchema && (
        <>
          <span className={s.small}>Output schema</span>
          <pre className={p.output}>{prettyJson(commit.outputSchema)}</pre>
        </>
      )}
      {commit.tools.length > 0 && (
        <p className={s.small} style={{ margin: 0 }}>
          Tools: {commit.tools.map((t) => t.name).join(", ")}
        </p>
      )}
    </section>
  );
}

function DiffView(props: { promptId: string; commits: PromptCommit[] }) {
  const [from, setFrom] = useState(props.commits[1]?.hash ?? "");
  const [to, setTo] = useState(props.commits[0]?.hash ?? "");
  const ready = !!from && !!to && from !== to;
  const diff = useQuery({ queryKey: pk.diff(props.promptId, from, to), queryFn: () => promptsApi.diff(props.promptId, from, to), enabled: ready });
  const lines = useMemo(() => (diff.data ? diffLinesOf(diff.data.template) : []), [diff.data]);
  const stats = diffStats(lines);
  const opts = props.commits.map((c) => (
    <option key={c.hash} value={c.hash}>
      {shortHash(c.hash)} — {c.message.slice(0, 60)}
    </option>
  ));
  return (
    <section className={p.pane} aria-labelledby="compare-title">
      <h2 className={p.paneTitle} id="compare-title">
        Compare commits
      </h2>
      <div className={p.row}>
        <Field label="From">
          <Select value={from} onChange={(e) => setFrom(e.target.value)}>
            {opts}
          </Select>
        </Field>
        <Field label="To">
          <Select value={to} onChange={(e) => setTo(e.target.value)}>
            {opts}
          </Select>
        </Field>
      </div>
      {!ready ? (
        <p className={s.small} style={{ margin: 0 }}>
          Choose two different commits.
        </p>
      ) : diff.isLoading ? (
        <SkeletonBlock lines={4} />
      ) : diff.isError ? (
        <p role="alert" className={p.err}>
          {errText(diff.error)}
        </p>
      ) : diff.data ? (
        <>
          <p className={s.small} style={{ margin: 0 }} data-testid="diff-stats">
            Template: {stats.added} line{stats.added === 1 ? "" : "s"} added, {stats.removed} removed
          </p>
          <ol className={p.diff} aria-label="Template changes">
            {lines.map((l, i) => (
              <li key={i} className={`${p.diffLine} ${l.op === "add" ? p.diffAdd : l.op === "remove" ? p.diffRemove : ""}`}>
                <span className={p.diffSign} aria-hidden>
                  {l.op === "add" ? "+" : l.op === "remove" ? "−" : " "}
                </span>
                {l.op !== "same" && <span className={s.srOnly}>{l.op === "add" ? "Added: " : "Removed: "}</span>}
                <span>{l.text || " "}</span>
              </li>
            ))}
          </ol>
          <ul className={s.small} style={{ margin: 0, paddingLeft: 18 }} aria-label="Other changes">
            {(diff.data.variables.added.length > 0 || diff.data.variables.removed.length > 0) && (
              <li>
                Variables: {diff.data.variables.added.map((v) => `+${v}`).concat(diff.data.variables.removed.map((v) => `−${v}`)).join(", ")}
              </li>
            )}
            {diff.data.modelConfig && <li>Model settings changed</li>}
            {diff.data.outputSchema && <li>Output schema changed</li>}
            {(diff.data.tools.added.length > 0 || diff.data.tools.removed.length > 0 || diff.data.tools.changed.length > 0) && (
              <li>
                Tools:{" "}
                {[
                  ...diff.data.tools.added.map((t) => `added ${t}`),
                  ...diff.data.tools.removed.map((t) => `removed ${t}`),
                  ...diff.data.tools.changed.map((t) => `changed ${t}`),
                ].join(", ")}
              </li>
            )}
          </ul>
        </>
      ) : null}
    </section>
  );
}

function SharingPane({ detail }: { detail: PromptDetail }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [visibility, setVisibility] = useState<PromptVisibility>(detail.prompt.visibility);
  const [people, setPeople] = useState<string[]>(detail.prompt.sharedUsers.map((u) => u.id));
  const save = useMutation({
    mutationFn: () => promptsApi.patch(detail.prompt.id, { visibility, sharedUserIds: visibility === "people" ? people : [] }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: pk.prompt(detail.prompt.id) });
      void queryClient.invalidateQueries({ queryKey: pk.prompts });
      toast("Sharing saved", "success");
    },
    onError: (e) => toast(errText(e), "error"),
  });
  const ro = !detail.prompt.canEdit;
  return (
    <section className={p.pane} aria-labelledby="sharing-title">
      <h2 className={p.paneTitle} id="sharing-title">
        Sharing
      </h2>
      {ro ? (
        <p className={s.small} style={{ margin: 0 }}>
          {VISIBILITY_LABEL[detail.prompt.visibility]}. Only the owner or an admin can change who sees it.
        </p>
      ) : (
        <>
          <PromptSharingFields visibility={visibility} onVisibility={setVisibility} people={people} onPeople={setPeople} ownerUserId={detail.prompt.ownerUserId} />
          <div>
            <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending}>
              {save.isPending ? "Saving…" : "Save sharing"}
            </Button>
          </div>
        </>
      )}
    </section>
  );
}

export default function BuilderPromptDetailPage() {
  const { promptId = "" } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const detail = useQuery({ queryKey: pk.prompt(promptId), queryFn: () => promptsApi.get(promptId) });
  const [viewing, setViewing] = useState<string | null>(null);
  const [moving, setMoving] = useState<PromptCommit | null>(null);
  const [archiving, setArchiving] = useState(false);
  const archive = useMutation({
    mutationFn: () => promptsApi.archive(promptId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: pk.prompts });
      toast("Prompt archived", "success");
      navigate("/builder/prompts");
    },
    onError: (e) => toast(errText(e), "error"),
  });

  if (detail.isLoading) {
    return (
      <>
        <PageHeader title="Prompt" crumbs={["Agent builder", "Prompts"]} />
        <div className={s.glass} style={{ padding: 24 }}>
          <SkeletonBlock lines={6} />
        </div>
      </>
    );
  }
  if (detail.isError || !detail.data) {
    return (
      <>
        <PageHeader title="Prompt" crumbs={["Agent builder", "Prompts"]} />
        <div className={s.glass}>
          <ErrorState title="Couldn't open this prompt" message={errText(detail.error)} onRetry={() => void detail.refetch()} />
        </div>
      </>
    );
  }
  const d = detail.data;
  const latest = d.commits[0] ?? null;
  const shown = d.commits.find((c) => c.hash === viewing) ?? latest;
  const tagsAt = (hash: string) => d.tags.filter((t) => t.commitHash === hash);
  const playgroundHref = (hash?: string) => `/builder/playground?prompt=${d.prompt.id}${hash ? `&commit=${hash}` : ""}`;

  return (
    <>
      <PageHeader
        title={d.prompt.name}
        crumbs={["Agent builder", "Prompts"]}
        sub={d.prompt.description || undefined}
        actions={
          <div className={s.toolbar} style={{ margin: 0 }}>
            <Link to={playgroundHref(latest?.hash)} className={s.helpLink}>
              Open in playground
            </Link>
            {d.prompt.canEdit && (
              <Button variant="danger" onClick={() => setArchiving(true)}>
                Archive
              </Button>
            )}
          </div>
        }
      />
      <div className={p.detailGrid}>
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--s3)", minWidth: 0 }}>
          <section className={p.pane} aria-labelledby="history-title">
            <h2 className={p.paneTitle} id="history-title">
              History
            </h2>
            {d.commits.length === 0 ? (
              <EmptyState
                title="No commits yet"
                body="Write the template in the playground, try it, then save it as this prompt's first commit."
                action={
                  <Link to={playgroundHref()} className={s.helpLink}>
                    Open the playground
                  </Link>
                }
              />
            ) : (
              <ol className={s.list} aria-label="Commits" style={{ margin: 0, padding: 0, listStyle: "none" }}>
                {d.commits.map((c) => (
                  <li key={c.hash} className={s.listRow}>
                    <span className={s.listRowMain}>
                      <span className={s.listRowTitle}>
                        <span className={p.hash}>{shortHash(c.hash)}</span>
                        {c.message}
                        {tagsAt(c.hash).map((t) => (
                          <Badge key={t.name} tone={t.name === PROD_TAG ? "ok" : "info"}>
                            {t.name}
                          </Badge>
                        ))}
                      </span>
                      <span className={s.listRowSub}>
                        {c.authorName ?? "someone"} · {ago(c.createdAt)} · {c.variables.length} variable{c.variables.length === 1 ? "" : "s"}
                      </span>
                    </span>
                    <Button size="sm" variant="ghost" aria-label={`View commit ${shortHash(c.hash)}`} aria-pressed={shown?.hash === c.hash} onClick={() => setViewing(c.hash)}>
                      View
                    </Button>
                    <Link to={playgroundHref(c.hash)} className={s.helpLink} aria-label={`Open commit ${shortHash(c.hash)} in the playground`}>
                      Playground
                    </Link>
                    {d.prompt.canEdit && (
                      <Button size="sm" aria-label={`Move a tag to commit ${shortHash(c.hash)}`} onClick={() => setMoving(c)}>
                        Move tag here
                      </Button>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </section>
          {shown && <CommitView commit={shown} />}
          {d.commits.length >= 2 && <DiffView promptId={d.prompt.id} commits={d.commits} />}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--s3)", minWidth: 0 }}>
          <section className={p.pane} aria-labelledby="tags-title">
            <h2 className={p.paneTitle} id="tags-title">
              Tags
            </h2>
            {d.tags.length === 0 ? (
              <p className={s.small} style={{ margin: 0 }}>
                No tags yet. Use “Move tag here” on a commit.
              </p>
            ) : (
              <ul className={s.list} aria-label="Tags" style={{ margin: 0, padding: 0, listStyle: "none" }}>
                {d.tags.map((t) => (
                  <li key={t.name} className={s.listRow}>
                    <span className={s.listRowMain}>
                      <span className={s.listRowTitle}>
                        <Badge tone={t.name === PROD_TAG ? "ok" : "info"}>{t.name}</Badge>
                        <span className={p.hash}>{shortHash(t.commitHash)}</span>
                      </span>
                      <span className={s.listRowSub}>
                        moved by {t.movedByName ?? "someone"} · {ago(t.movedAt)}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className={p.pane} aria-labelledby="promotions-title">
            <h2 className={p.paneTitle} id="promotions-title">
              Promotions to prod
            </h2>
            {d.promotions.length === 0 ? (
              <p className={s.small} style={{ margin: 0 }}>
                None yet. Moving prod asks someone other than the commit&apos;s author to approve it in the approvals queue.
              </p>
            ) : (
              <ul className={s.list} aria-label="Promotions" style={{ margin: 0, padding: 0, listStyle: "none" }}>
                {d.promotions.map((pr) => {
                  const [label, tone] = PROMOTION_LABEL[pr.status];
                  return (
                    <li key={pr.id} className={s.listRow}>
                      <span className={s.listRowMain}>
                        <span className={s.listRowTitle}>
                          <span className={p.hash}>{shortHash(pr.commitHash)}</span>
                          <Badge tone={tone}>{label}</Badge>
                        </span>
                        <span className={s.listRowSub}>
                          asked by {pr.requestedByName ?? "someone"} · approver {pr.approverName ?? "someone"} · {ago(pr.createdAt)}
                          {pr.status === "stale" && typeof pr.result?.reason === "string" ? ` · ${pr.result.reason.replace(/_/g, " ")}` : ""}
                        </span>
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
          <SharingPane key={d.prompt.updatedAt} detail={d} />
          <section className={p.pane} aria-labelledby="about-title">
            <h2 className={p.paneTitle} id="about-title">
              About
            </h2>
            <p className={s.small} style={{ margin: 0 }}>
              Owner: {d.prompt.ownerName ?? "someone"} · created {ago(d.prompt.createdAt)}
            </p>
            <p className={s.small} style={{ margin: 0 }}>
              Refer to a tagged version as <code>{d.prompt.name}@prod</code> (or any other tag).
            </p>
          </section>
        </div>
      </div>
      <MoveTagDialog detail={d} commit={moving} onClose={() => setMoving(null)} />
      <ConfirmModal
        open={archiving}
        danger
        title={`Archive ${d.prompt.name}?`}
        body="It disappears from every list and its tags stop resolving. Its history stays in the audit log. A prompt with a promotion waiting for approval can't be archived until that's decided."
        confirmLabel="Archive prompt"
        onCancel={() => setArchiving(false)}
        onConfirm={() => {
          setArchiving(false);
          archive.mutate();
        }}
      />
    </>
  );
}
