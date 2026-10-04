/**
 * ADR-0172 — builder Inbox: the threads that need a person. Scheduled runs land
 * here as "needs attention"; reading, replying and marking a thread done all
 * happen in place.
 */
import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ago } from "../../api/format";
import type { BuilderMessage } from "../../api/types";
import { PageHeader } from "../../shell/AppShell";
import { Badge, Button, Card, EmptyState, ErrorState, Input, SkeletonBlock, Tabs } from "../../ui/kit";
import { useToast } from "../../ui/toast";
import { bk, builderApi, chatRefusal } from "./builderApi";
import { filterThreads, SOURCE_LABEL } from "./builderLogic";
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

export default function BuilderInboxPage() {
  const [params, setParams] = useSearchParams();
  const tab = (TABS.find((t) => t.id === params.get("tab"))?.id ?? "needs_attention") as Tab;
  const selected = params.get("thread");
  const [query, setQuery] = useState("");
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const threads = useQuery({ queryKey: bk.threads(tab), queryFn: () => builderApi.listThreads(tab) });
  const visible = useMemo(() => filterThreads(threads.data?.threads ?? [], query), [threads.data, query]);
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
      queryClient.setQueryData(bk.thread(res.thread.id), (prev: { thread: unknown; messages: BuilderMessage[] } | undefined) => ({
        thread: res.thread,
        messages: [...(prev?.messages ?? []), ...res.messages],
      }));
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
          {threads.isLoading ? (
            <div style={{ padding: 16 }}>
              <SkeletonBlock lines={4} />
            </div>
          ) : threads.isError ? (
            <ErrorState title="Couldn't load threads" message={(threads.error as Error).message} onRetry={() => void threads.refetch()} />
          ) : visible.length === 0 ? (
            query ? <EmptyState title="No matching threads" body="Try a different search." /> : <EmptyState title={EMPTY[tab].title} body={EMPTY[tab].body} />
          ) : (
            <ul aria-label="Threads" style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {visible.map((th) => (
                <li key={th.id}>
                  <button
                    type="button"
                    className={th.id === selected ? s.threadRowActive : s.threadRow}
                    aria-current={th.id === selected ? "true" : undefined}
                    onClick={() => pick({ thread: th.id })}
                  >
                    <AgentAvatar name={th.agentName} color={th.agentColor} size={32} />
                    <span className={s.threadMain}>
                      <span className={s.threadTitle}>{th.title}</span>
                      <span className={s.threadPreview}>
                        {th.agentName}
                        {th.lastMessagePreview ? ` · ${th.lastMessagePreview}` : ""}
                      </span>
                    </span>
                    <span className={s.threadMeta}>
                      <span>{ago(th.updatedAt)}</span>
                      <Badge tone={th.source === "schedule" ? "primary" : "neutral"}>{SOURCE_LABEL[th.source]}</Badge>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
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
              <MessageList messages={detail.data?.messages ?? []} agentName={t.agentName} agentColor={t.agentColor} pending={pending} />
              <div className={s.convoFoot}>
                <Composer label="Reply" placeholder={`Reply to ${t.agentName}…`} busy={reply.isPending} onSend={(m) => reply.mutate(m)} />
              </div>
            </div>
          ) : null}
        </Card>
      </div>
    </>
  );
}
