/**
 * ADR-0172 — builder Chat: a calm "Ask anything" start, a strip of the
 * workspace's connected integrations, a composer with an agent picker, and
 * recent threads. Sending opens the thread in place (?thread=…); every reply
 * goes through the governed invoke path as the person sending it.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ago } from "../../api/format";
import type { BuilderMessage } from "../../api/types";
import { PageHeader } from "../../shell/AppShell";
import { Badge, Button, Card, EmptyState, ErrorState, Select, SkeletonBlock } from "../../ui/kit";
import { bk, builderApi, useAgents } from "./builderApi";
import { SOURCE_LABEL } from "./builderLogic";
import { AgentAvatar, Composer, Icon, LogoStrip, MessageList, NewAgentDialog } from "./BuilderUi";
import s from "./builder.module.css";

export default function BuilderChatPage() {
  const [params, setParams] = useSearchParams();
  const threadId = params.get("thread");
  const queryClient = useQueryClient();
  const agents = useAgents();
  const integrations = useQuery({ queryKey: bk.integrations, queryFn: builderApi.integrations });
  const recent = useQuery({ queryKey: bk.threads("all"), queryFn: () => builderApi.listThreads("all") });
  const thread = useQuery({ queryKey: bk.thread(threadId ?? ""), queryFn: () => builderApi.getThread(threadId!), enabled: !!threadId });
  const [agentId, setAgentId] = useState(params.get("agent") ?? "");
  const [pending, setPending] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const closeNew = useCallback(() => setNewOpen(false), []);

  const list = agents.data?.agents ?? [];
  useEffect(() => {
    if (thread.data) setAgentId(thread.data.thread.agentId);
    else if (!agentId && list[0]) setAgentId(list[0].id);
  }, [thread.data, list, agentId]);
  const agent = list.find((a) => a.id === agentId) ?? null;

  const connectedLogos = useMemo(() => {
    const keys: string[] = [];
    const labels: Record<string, string> = {};
    for (const g of integrations.data?.groups ?? [])
      for (const i of g.items)
        if (i.status === "connected" && !keys.includes(i.key)) {
          keys.push(i.key);
          labels[i.key] = i.name;
        }
    return { keys: keys.slice(0, 10), labels };
  }, [integrations.data]);

  const send = useMutation({
    mutationFn: (message: string) => builderApi.chat(agentId, message, threadId ?? undefined),
    onMutate: (message) => {
      setPending(message);
      setSendError(null);
    },
    onSuccess: (res) => {
      queryClient.setQueryData(bk.thread(res.thread.id), (prev: { thread: unknown; messages: BuilderMessage[] } | undefined) => ({
        thread: res.thread,
        messages: [...(prev?.messages ?? []), ...res.messages],
      }));
      void queryClient.invalidateQueries({ queryKey: ["builder", "threads"] });
      if (res.thread.id !== threadId) setParams({ thread: res.thread.id });
    },
    onError: (e) => setSendError(e instanceof Error ? e.message : String(e)),
    onSettled: () => setPending(null),
  });

  const picker = (
    <Select
      aria-label="Agent"
      className={s.composerSelect}
      value={agentId}
      disabled={!!threadId || list.length === 0}
      onChange={(e) => setAgentId(e.target.value)}
    >
      {list.map((a) => (
        <option key={a.id} value={a.id}>
          {a.name}
        </option>
      ))}
    </Select>
  );

  if (threadId) {
    const t = thread.data?.thread;
    return (
      <>
        <PageHeader
          title={t?.title ?? "Agent chat"}
          crumbs={["Agent builder", "Agent chat"]}
          actions={
            <Button onClick={() => setParams({})}>
              {Icon.plus()} New chat
            </Button>
          }
        />
        <Card>
          {thread.isLoading ? (
            <SkeletonBlock lines={4} />
          ) : thread.isError ? (
            <ErrorState title="Couldn't open this thread" message={(thread.error as Error).message} onRetry={() => void thread.refetch()} />
          ) : (
            <div className={s.convo} style={{ padding: 0, minHeight: 360 }}>
              {t && (
                <div className={s.agentFacts}>
                  <AgentAvatar name={t.agentName} color={t.agentColor} size={24} />
                  <Link className={s.helpLink} to={`/builder/agents/${t.agentId}`}>
                    {t.agentName}
                  </Link>
                  <Badge>{SOURCE_LABEL[t.source]}</Badge>
                </div>
              )}
              <MessageList messages={thread.data?.messages ?? []} agentName={t?.agentName ?? "Agent"} agentColor={t?.agentColor} pending={pending} />
              <div className={s.convoFoot}>
                {sendError && (
                  <p role="alert" className={s.note} style={{ color: "var(--danger)", margin: 0 }}>
                    {sendError}
                  </p>
                )}
                <Composer label="Message" placeholder={`Reply to ${t?.agentName ?? "the agent"}…`} busy={send.isPending} onSend={(m) => send.mutate(m)} />
              </div>
            </div>
          )}
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader title="Agent chat" crumbs={["Agent builder"]} sub="Talk to your agents. Each reply runs with your own access, budgets and guardrails." />
      <section className={`${s.glass} ${s.chatHero}`} aria-labelledby="ask-title">
        <h2 id="ask-title" className={s.chatHeroTitle}>
          Ask anything
        </h2>
        {connectedLogos.keys.length > 0 && (
          <div aria-label="Connected integrations" role="group">
            <LogoStrip keys={connectedLogos.keys} labels={connectedLogos.labels} />
          </div>
        )}
        {agents.isLoading ? (
          <SkeletonBlock lines={2} />
        ) : agents.isError ? (
          <ErrorState title="Couldn't load your agents" message={(agents.error as Error).message} onRetry={() => void agents.refetch()} />
        ) : list.length === 0 ? (
          <EmptyState
            title="Create your first agent"
            body="An agent is a set of instructions, a model and the tools it may use. Start from scratch or from a template."
            action={
              <div className={s.toolbar} style={{ margin: 0, justifyContent: "center" }}>
                <Button variant="primary" onClick={() => setNewOpen(true)}>
                  New agent
                </Button>
                <Link className={s.helpLink} to="/builder/templates">
                  Browse templates
                </Link>
              </div>
            }
          />
        ) : (
          <>
            <Composer
              label="Message"
              placeholder={agent ? `Message ${agent.name}…` : "Write your message…"}
              busy={send.isPending}
              disabled={!agentId}
              leading={picker}
              onSend={(m) => send.mutate(m)}
              autoFocus
            />
            {pending && (
              <p role="status" className={s.muted} style={{ margin: 0 }}>
                Sending to {agent?.name}…
              </p>
            )}
            {sendError && (
              <p role="alert" className={s.note} style={{ color: "var(--danger)", margin: 0, width: "100%" }}>
                {sendError}
              </p>
            )}
          </>
        )}
      </section>

      <section className={s.recent} aria-labelledby="recent-title">
        <Card title={<span id="recent-title">Recent threads</span>} flush>
          {recent.isLoading ? (
            <div style={{ padding: 16 }}>
              <SkeletonBlock lines={3} />
            </div>
          ) : recent.isError ? (
            <ErrorState title="Couldn't load recent threads" message={(recent.error as Error).message} onRetry={() => void recent.refetch()} />
          ) : (recent.data?.threads ?? []).length === 0 ? (
            <EmptyState title="No threads yet" body="Your conversations with agents appear here." />
          ) : (
            <div>
              {(recent.data?.threads ?? []).slice(0, 8).map((t) => (
                <Link key={t.id} to={`/builder?thread=${t.id}`} className={s.threadRow}>
                  <AgentAvatar name={t.agentName} color={t.agentColor} size={32} />
                  <span className={s.threadMain}>
                    <span className={s.threadTitle}>{t.title}</span>
                    <span className={s.threadPreview}>
                      {t.agentName}
                      {t.lastMessagePreview ? ` · ${t.lastMessagePreview}` : ""}
                    </span>
                  </span>
                  <span className={s.threadMeta}>
                    <span>{ago(t.updatedAt)}</span>
                    {t.status === "needs_attention" && <Badge tone="warn">Needs you</Badge>}
                  </span>
                </Link>
              ))}
            </div>
          )}
        </Card>
      </section>
      <NewAgentDialog open={newOpen} onClose={closeNew} />
    </>
  );
}
