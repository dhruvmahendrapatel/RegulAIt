/**
 * ADR-0172 — builder Inbox: the threads that need a person. Scheduled runs land
 * here as "needs attention"; reading, replying and marking a thread done all
 * happen in place.
 */
import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ago } from "../../api/format";
import { PageHeader } from "../../shell/AppShell";
import { Badge, Button, Card, EmptyState, ErrorState, Input, SkeletonBlock, Tabs } from "../../ui/kit";
import { DataList, type DataColumn } from "../../ui/DataList";
import type { BuilderThreadSummary } from "../../api/types";
import { useToast } from "../../ui/toast";
import { bk, builderApi, chatRefusal, mergeTurn, type ChatResponse } from "./builderApi";
import { SOURCE_LABEL } from "./builderLogic";
import { AgentAvatar, Composer, Icon, MessageList } from "./BuilderUi";
import s from "./builder.module.css";

type Tab = "needs_attention" | "completed" | "all";
const TABS: Array<{ id: Tab; label: string }> = [
  { id: "needs_attention", label: "Needs attention" },
  { id: "completed", label: "Completed" },
  { id: "all", label: "All" },
];
const EMPTY: Record<Tab, { title: string; body: string }> = {
  needs_attention: { title: "Nothing needs you right now", body: "When a scheduled run or a conversation is waiting on you, it shows up here." },
  completed: { title: "No completed threads yet", body: "Threads you mark as done are kept here." },
  all: { title: "No threads yet", body: "Start a conversation with one of your agents to see it here." },
};

/** ADR-0219: the inbox's columns; the ids and sortable ones match the gateway's BUILDER_THREADS_LIST */
export const THREAD_COLUMNS: Array<DataColumn<BuilderThreadSummary>> = [
  {
    key: "title",
    header: "Thread",
    main: true,
    sortable: true,
    render: (th) => (
      <span className={s.threadMain} style={{ display: "inline-flex", gap: "var(--s1)", alignItems: "center" }}>
        <AgentAvatar name={th.agentName} color={th.agentColor} size={28} />
        <span className={s.threadMain}>
          <span className={s.threadTitle}>{th.title}</span>
          <span className={s.threadPreview}>
            {th.agentName}
            {th.lastMessagePreview ? ` · ${th.lastMessagePreview}` : ""}
          </span>
        </span>
      </span>
    ),
  },
  {
    key: "waiting",
    header: "Waiting on",
    main: true,
    sortable: true,
    required: "A thread waiting on you is always shown",
    render: (th) =>
      th.pendingStep ? <Badge tone="warn">{th.pendingStep.status === "pending_confirmation" ? "Needs your OK" : "Awaiting approval"}</Badge> : <span className={s.threadPreview}>—</span>,
  },
  { key: "updated", header: "Last activity", main: true, sortable: true, render: (th) => ago(th.updatedAt) },
  { key: "source", header: "Source", sortable: true, render: (th) => <Badge tone={th.source === "schedule" ? "primary" : "neutral"}>{SOURCE_LABEL[th.source]}</Badge> },
  { key: "agent", header: "Agent", sortable: true, render: (th) => th.agentName },
  { key: "status", header: "Status", sortable: true, render: (th) => th.status.replaceAll("_", " ") },
];

export default function BuilderInboxPage() {
  const [params, setParams] = useSearchParams();
  const tab = (TABS.find((t) => t.id === params.get("tab"))?.id ?? "needs_attention") as Tab;
  const selected = params.get("thread");
  const [query, setQuery] = useState("");
  // the search runs on the server, a moment after typing stops
  const [q, setQ] = useState("");
  useEffect(() => {
    const t = window.setTimeout(() => setQ(query.trim()), 300);
    return () => window.clearTimeout(t);
  }, [query]);
  const filters = useMemo(() => ({ status: tab, q: q || undefined }), [tab, q]);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const detail = useQuery({ queryKey: bk.thread(selected ?? ""), queryFn: () => builderApi.getThread(selected!), enabled: !!selected });
  const t = detail.data?.thread;

  const setStatus = useMutation({
    mutationFn: (status: "completed" | "needs_attention") => builderApi.patchThread(selected!, status),
    onSuccess: (_res, status) => {
      toast(status === "completed" ? "Marked as done" : "Moved back to needs attention", "success");
      void queryClient.invalidateQueries({ queryKey: ["builder", "threads"] });
      void queryClient.invalidateQueries({ queryKey: bk.thread(selected!) });
    },
    onError: (e) => toast(e instanceof Error ? e.message : String(e), "error"),
  });
  const [pending, setPending] = useState<string | null>(null);
  const reply = useMutation({
    mutationFn: (message: string) => builderApi.chat(t!.agentId, message, t!.id),
    onMutate: (m) => setPending(m),
    onSuccess: (res) => {
      queryClient.setQueryData(bk.thread(res.thread.id), (prev: ChatResponse | undefined) => mergeTurn(prev, res));
      void queryClient.invalidateQueries({ queryKey: ["builder", "threads"] });
    },
    onError: (e) => {
      const r = chatRefusal(e);
      toast(r.message, "error");
      // the refusal was recorded in this thread: show its note
      if (r.threadId) void queryClient.invalidateQueries({ queryKey: bk.thread(r.threadId) });
    },
    onSettled: () => setPending(null),
  });

  const pick = (next: Partial<{ tab: Tab; thread: string | null }>) => {
    const p = new URLSearchParams(params);
    if (next.tab) p.set("tab", next.tab);
    if (next.thread === null) p.delete("thread");
    else if (next.thread) p.set("thread", next.thread);
    setParams(p);
  };

  return (
    <>
      <PageHeader title="Agent inbox" crumbs={["Agent builder"]} sub="Threads waiting on you — scheduled runs, questions and finished work." />
      <div className={s.toolbar}>
        <Tabs tabs={TABS} active={tab} onChange={(id) => pick({ tab: id as Tab, thread: null })} />
        <span style={{ flex: 1 }} />
        <Input className={s.search} type="search" aria-label="Search threads" placeholder="Search threads" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      <div className={s.inbox}>
        <Card flush>
          <DataList<BuilderThreadSummary>
            listId="builder-threads"
            noun="threads"
            endpoint="/v1/builder/threads"
            exportPath="/v1/builder/threads/export.xlsx"
            queryKey={["builder", "threads", "list"]}
            legacyKey="threads"
            count="estimate"
            filters={filters}
            defaultSort={{ key: "updated", dir: "desc" }}
            columns={THREAD_COLUMNS}
            rowKey={(th) => th.id}
            onRowClick={(th) => pick({ thread: th.id })}
            rowLabel={(th) => `Open thread ${th.title}${th.id === selected ? " (open)" : ""}`}
            empty={q ? <EmptyState title="No matching threads" body="Try a different search." /> : <EmptyState title={EMPTY[tab].title} body={EMPTY[tab].body} />}
          />
        </Card>

        <Card>
          {!selected ? (
            <EmptyState icon={Icon.inbox(32)} title="Choose a thread" body="Pick a thread on the left to read it and reply." />
          ) : detail.isLoading ? (
            <SkeletonBlock lines={5} />
          ) : detail.isError ? (
            <ErrorState title="Couldn't open this thread" message={(detail.error as Error).message} onRetry={() => void detail.refetch()} />
          ) : t ? (
            <div className={s.threadPane} style={{ padding: 0 }}>
              <div className={s.agentHead} style={{ alignItems: "center" }}>
                <AgentAvatar name={t.agentName} color={t.agentColor} size={36} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <h2 className={s.agentName} style={{ fontSize: 17 }}>
                    {t.title}
                  </h2>
                  <div className={s.agentFacts}>
                    <Link className={s.helpLink} to={`/builder/agents/${t.agentId}`}>
                      {t.agentName}
                    </Link>
                    <span className={s.dot} aria-hidden />
                    <span>{SOURCE_LABEL[t.source]}</span>
                    <span className={s.dot} aria-hidden />
                    <span>{ago(t.updatedAt)}</span>
                  </div>
                </div>
                {t.status === "completed" ? (
                  <Button disabled={setStatus.isPending} onClick={() => setStatus.mutate("needs_attention")}>
                    Reopen
                  </Button>
                ) : (
                  <Button variant="primary" disabled={setStatus.isPending} onClick={() => setStatus.mutate("completed")}>
                    Mark as done
                  </Button>
                )}
              </div>
              <MessageList
                messages={detail.data?.messages ?? []}
                agentName={t.agentName}
                agentColor={t.agentColor}
                pending={pending}
                waiting={detail.data?.pending ?? null}
                threadId={t.id}
              />
              <div className={s.convoFoot}>
                <Composer
                  label="Reply"
                  placeholder={detail.data?.pending ? "Answer the tool request above first" : `Reply to ${t.agentName}…`}
                  busy={reply.isPending}
                  disabled={!!detail.data?.pending}
                  onSend={(m) => reply.mutate(m)}
                />
              </div>
            </div>
          ) : null}
        </Card>
      </div>
    </>
  );
}
