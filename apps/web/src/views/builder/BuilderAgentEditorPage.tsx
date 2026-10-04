/**
 * ADR-0172 — the agent editor. Left: a conversation with the agent — a setup
 * walk-through right after creation (instructions, skills, channels), then
 * test threads. Right: the Configure panel. Anything that touches access
 * (channels, connections, schedules, sharing) waits for a person to choose it.
 */
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ago } from "../../api/format";
import { PageHeader } from "../../shell/AppShell";
import { Badge, Button, Card, EmptyState, RecordError, SkeletonBlock } from "../../ui/kit";
import { useToast } from "../../ui/toast";
import { ChannelRows, ConfigurePanel } from "./AgentConfigure";
import { bk, builderApi, chatRefusal, mergeTurn, type ChatResponse } from "./builderApi";
import { AgentAvatar, Composer, Icon, MessageList, ModelChip } from "./BuilderUi";
import { SharingBadge } from "./BuilderAgentsPage";
import s from "./builder.module.css";

export default function BuilderAgentEditorPage() {
  const { agentId = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const setup = params.get("setup") === "1";
  const threadId = params.get("thread");
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [panelOpen, setPanelOpen] = useState(true);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const openSkills = useCallback(() => setSkillsOpen(true), []);
  const closeSkills = useCallback(() => setSkillsOpen(false), []);

  const detail = useQuery({ queryKey: bk.agent(agentId), queryFn: () => builderApi.getAgent(agentId), enabled: !!agentId });
  const threads = useQuery({ queryKey: bk.threads("all", agentId), queryFn: () => builderApi.listThreads("all", agentId), enabled: !!agentId });
  const thread = useQuery({ queryKey: bk.thread(threadId ?? ""), queryFn: () => builderApi.getThread(threadId!), enabled: !!threadId });
  const agent = detail.data?.agent;

  const [pending, setPending] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const send = useMutation({
    mutationFn: (m: string) => builderApi.chat(agentId, m, threadId ?? undefined),
    onMutate: (m) => {
      setPending(m);
      setSendError(null);
    },
    onSuccess: (res) => {
      queryClient.setQueryData(bk.thread(res.thread.id), (prev: ChatResponse | undefined) => mergeTurn(prev, res));
      void queryClient.invalidateQueries({ queryKey: ["builder", "threads"] });
      void queryClient.invalidateQueries({ queryKey: bk.agent(agentId) });
      if (res.thread.id !== threadId) setParams({ thread: res.thread.id });
    },
    onError: (e) => {
      const r = chatRefusal(e);
      setSendError(r.message);
      if (r.threadId) {
        void queryClient.invalidateQueries({ queryKey: bk.thread(r.threadId) });
        void queryClient.invalidateQueries({ queryKey: ["builder", "threads"] });
        if (r.threadId !== threadId) setParams({ thread: r.threadId });
      }
    },
    onSettled: () => setPending(null),
  });

  const agentThreads = useMemo(() => (threads.data?.threads ?? []).slice(0, 6), [threads.data]);

  if (detail.isLoading) {
    return (
      <>
        <PageHeader title="Agent" crumbs={["Agent builder", "Your agents"]} />
        <Card>
          <SkeletonBlock lines={6} />
        </Card>
      </>
    );
  }
  if (detail.isError || !agent) {
    return (
      <>
        <PageHeader title="Agent" crumbs={["Agent builder", "Your agents"]} />
        <Card>
          <RecordError noun="agent" error={detail.error} onRetry={() => void detail.refetch()} action={<Link className={s.helpLink} to="/builder/agents">Back to your agents</Link>} />
        </Card>
      </>
    );
  }

  const finishSetup = (msg?: string) => {
    setParams({});
    if (msg) toast(msg, "success");
  };

  return (
    <>
      <PageHeader title={agent.name} crumbs={["Agent builder", "Your agents"]} />
      <div className={`${s.glass} ${s.editorBar}`}>
        <AgentAvatar name={agent.name} color={agent.color} size={40} />
        <div className={s.editorTitle}>
          <div className={s.agentFacts}>
            <ModelChip model={agent.modelAgent} />
            <span className={s.dot} aria-hidden />
            <SharingBadge sharing={agent.sharing} />
            <span className={s.dot} aria-hidden />
            <span>{agent.ownerName ?? "Unknown owner"}</span>
          </div>
          <span className={`${s.small} ${s.clamp2}`}>{agent.description || "No description yet."}</span>
        </div>
        {threadId && (
          <Button onClick={() => setParams({})}>
            {Icon.plus()} New thread
          </Button>
        )}
        <Button aria-pressed={panelOpen} aria-controls="configure-panel" onClick={() => setPanelOpen((o) => !o)}>
          {Icon.sliders()} {panelOpen ? "Hide settings" : "Configure"}
        </Button>
      </div>

      <div className={panelOpen ? s.editor : s.editorSolo}>
        <section aria-label="Conversation" className={`${s.glass} ${s.convo}`}>
          {threadId ? (
            thread.isLoading ? (
              <SkeletonBlock lines={4} />
            ) : thread.isError ? (
              <RecordError noun="thread" error={thread.error} onRetry={() => void thread.refetch()} />
            ) : (
              <MessageList
                messages={thread.data?.messages ?? []}
                agentName={agent.name}
                agentColor={agent.color}
                pending={pending}
                waiting={thread.data?.pending ?? null}
                threadId={threadId}
              />
            )
          ) : setup ? (
            <SetupWalkthrough
              agentName={agent.name}
              description={agent.description}
              instructions={agent.instructions}
              skills={agent.skills}
              canEdit={agent.canEdit}
              onAddSkill={openSkills}
              channelRows={<ChannelRows agent={agent} disabled={!agent.canEdit} />}
              onSkip={() => finishSetup()}
              onDone={() => finishSetup("Setup saved — try the agent below")}
            />
          ) : (
            <>
              <div>
                <h2 className={s.subhead} style={{ fontSize: 16 }}>
                  Try {agent.name}
                </h2>
                <p className={s.muted} style={{ margin: "4px 0 0" }}>
                  Send a message to test the agent. It answers with your own access, budgets and guardrails.{" "}
                  {agent.canEdit && (
                    <button type="button" className={s.disclosure} style={{ color: "var(--rg-signal-700)" }} onClick={() => setParams({ setup: "1" })}>
                      Show setup steps
                    </button>
                  )}
                </p>
              </div>
              {threads.isError ? null : agentThreads.length > 0 ? (
                <div className={s.list}>
                  {agentThreads.map((t) => (
                    <Link key={t.id} to={`/builder/agents/${agent.id}?thread=${t.id}`} className={s.threadRow}>
                      <span className={s.threadMain}>
                        <span className={s.threadTitle}>{t.title}</span>
                        <span className={s.threadPreview}>{t.lastMessagePreview ?? ""}</span>
                      </span>
                      <span className={s.threadMeta}>
                        <span>{ago(t.updatedAt)}</span>
                        {t.status === "needs_attention" && <Badge tone="warn">Needs you</Badge>}
                      </span>
                    </Link>
                  ))}
                </div>
              ) : (
                <EmptyState icon={Icon.chat(32)} title="No conversations yet" body="Ask the agent something to see how it responds." />
              )}
            </>
          )}
          <div className={s.convoFoot}>
            {sendError && (
              <p role="alert" className={s.note} style={{ color: "var(--danger)", margin: 0 }}>
                {sendError}
              </p>
            )}
            <Composer
              label={`Message ${agent.name}`}
              placeholder={threadId && thread.data?.pending ? "Answer the tool request above first" : `Message ${agent.name}…`}
              busy={send.isPending}
              disabled={!!(threadId && thread.data?.pending)}
              onSend={(m) => send.mutate(m)}
            />
          </div>
        </section>
        {panelOpen && (
          <div id="configure-panel">
            <ConfigurePanel agent={agent} skillsOpen={skillsOpen} onOpenSkills={openSkills} onCloseSkills={closeSkills} />
          </div>
        )}
      </div>
    </>
  );
}

function SetupWalkthrough(props: {
  agentName: string;
  description: string | null;
  instructions: string;
  skills: Array<{ id: string; name: string; description: string }>;
  canEdit: boolean;
  onAddSkill: () => void;
  channelRows: ReactNode;
  onSkip: () => void;
  onDone: () => void;
}) {
  return (
    <div className={s.messages} aria-label="Agent setup" role="group">
      {props.description && <div className={s.msgUser}>{props.description}</div>}
      <div className={s.msgAgent}>
        <AgentAvatar name={props.agentName} color={null} size={28} />
        <div className={s.msgAgentBody}>
          I've drafted my instructions from your description. Review them, add any skills I should know, and choose where people can reach me. Anything that touches access waits for you.
        </div>
      </div>
      <div className={s.setupCard}>
        <div className={s.setupHead}>
          {Icon.book()} Instructions
        </div>
        <div className={s.setupBody}>
          {props.instructions.trim() ? (
            <pre className={s.instructionsPreview}>{props.instructions}</pre>
          ) : (
            <span className={s.muted}>No instructions yet — write them under Knowledge in the settings panel.</span>
          )}
        </div>
      </div>
      <div className={s.setupCard}>
        <div className={s.setupHead}>
          {Icon.spark()} Skills
        </div>
        <div className={s.setupBody} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <span>Skills are packaged instructions the agent pulls in only when a task needs them.</span>
          {props.skills.length > 0 && (
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {props.skills.map((k) => (
                <li key={k.id}>
                  <strong>{k.name}</strong> — {k.description}
                </li>
              ))}
            </ul>
          )}
          <button type="button" className={s.addRow} disabled={!props.canEdit} onClick={props.onAddSkill}>
            {Icon.plus(14)} Add skill
          </button>
        </div>
      </div>
      <div className={s.setupCard}>
        <div className={s.setupHead}>
          {Icon.chat()} Channels
        </div>
        <div className={s.setupBody} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <span>Connect the places people will talk to this agent. Each needs a chat connection your administrator has set up.</span>
          {props.channelRows}
        </div>
      </div>
      <div className={s.toolbar} style={{ justifyContent: "flex-end", margin: 0 }}>
        <Button variant="ghost" onClick={props.onSkip}>
          Skip for now
        </Button>
        <Button variant="primary" onClick={props.onDone}>
          Save and continue
        </Button>
      </div>
    </div>
  );
}
