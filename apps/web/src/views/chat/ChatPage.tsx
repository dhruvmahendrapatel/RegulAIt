/**
 * Chat / Playground — the governed multi-turn surface. Parity with the legacy
 * /app playground on the same endpoints: threads live server-side
 * (/v1/conversations), each send streams over the invoke SSE path
 * (delta/result/error), and the reply wears its governance facts as badges —
 * routing, savings, cost, model, whose key paid, PII enforcement, compaction.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, errMessage, readSse, ssePost } from "../../api/client";
import type {
  ConversationDetail,
  ConversationSummary,
  GrantedAgent,
  InvokeResult,
  MyAgentsResponse,
  PiiInfo,
  Project,
  ProviderStatusResponse,
} from "../../api/types";
import { ago, fmtBytes, fmtUsd, UUID_RE, shortId } from "../../api/format";
import { useSession } from "../../session/SessionContext";
import { PageHeader } from "../../shell/AppShell";
import {
  Badge,
  Button,
  Card,
  CodeBlock,
  ConfirmModal,
  EmptyState,
  Field,
  Input,
  Select,
  SkeletonBlock,
  Textarea,
} from "../../ui/kit";
import { ModelPicker } from "../../ui/ModelPicker";
import { useToast } from "../../ui/toast";
import { LITERACY_REFUSAL_CODE, REFUSAL_GUIDANCE } from "../../api/refusals";
import { RefusalNotice } from "../../ui/RefusalNotice";
import { bindingsFromGranted } from "../models/modelBindings";
import { modelPolicyDefault, modelPolicyVerdict, useModelPolicy } from "../models/modelPolicy";
import v from "../views.module.css";
import s from "./chat.module.css";

// ---- local render model (mirrors the legacy exchange shape) ---------------

interface AttachView {
  name: string;
  kind: string;
  thumb: string | null;
}
interface PendingAttachment {
  id: number;
  mode: "attachment" | "text";
  kind?: "image" | "document";
  name: string;
  mediaType?: string;
  dataBase64?: string;
  text?: string;
  thumb: string | null;
  size: number;
}
interface Exchange {
  prompt: string;
  agentName: string;
  text: string;
  streaming: boolean;
  attachments?: AttachView[];
  result?: InvokeResult;
  denied?: { effect?: string; ruleId: string; reason?: string };
  error?: string;
  pii?: PiiInfo;
  note?: string;
  compactedBoundary?: { summary?: string | null; summaryTokens?: number | null };
}

const IMG_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

function readAs(file: File, how: "text" | "dataurl"): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result));
    r.onerror = () => rej(r.error ?? new Error("read failed"));
    if (how === "text") r.readAsText(file);
    else r.readAsDataURL(file);
  });
}

export default function ChatPage() {
  const { auth, me } = useSession();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const userId = auth?.userId ?? null;

  const maxAttach = me?.limits?.maxAttachmentsPerDispatch ?? 8;
  const maxBytes = me?.limits?.maxAttachmentBytes ?? 6 * 1024 * 1024;

  // ---- workspace data -----------------------------------------------------
  const agentsQ = useQuery({
    queryKey: ["my-agents", userId],
    enabled: Boolean(userId),
    queryFn: () => api.get<MyAgentsResponse>(`/v1/users/${userId}/agents`),
  });
  const projectsQ = useQuery({
    queryKey: ["projects"],
    queryFn: () => api.get<{ projects: Project[] }>("/v1/projects"),
  });
  const credsQ = useQuery({
    queryKey: ["my-credentials", userId],
    enabled: Boolean(userId),
    queryFn: () =>
      api.get<{ credentials: Array<{ provider: string }> }>(`/v1/users/${userId}/model-credentials`),
  });
  const providerStatusQ = useQuery({
    queryKey: ["provider-status"],
    queryFn: () => api.get<ProviderStatusResponse>("/v1/model-providers/status"),
  });
  const convosQ = useQuery({
    queryKey: ["conversations"],
    queryFn: () => api.get<{ conversations: ConversationSummary[] }>("/v1/conversations"),
  });

  const agents = useMemo(
    () => (agentsQ.data?.agents ?? []).filter((a) => !a.revoked),
    [agentsQ.data],
  );
  const agentNames = useMemo(
    () => Object.fromEntries(agents.map((a) => [a.agentId, a.name])),
    [agents],
  );
  const projects = projectsQ.data?.projects ?? [];
  const myProviders = (credsQ.data?.credentials ?? []).map((c) => c.provider);
  const providerStatus = providerStatusQ.data?.providers ?? {};
  const conversations = convosQ.data?.conversations ?? [];

  // ADR-0172: the picker's tiles (logo, model id, tier, readiness)
  const pickerAgents = useMemo(
    () =>
      bindingsFromGranted(agents, {
        providerStatus: providerStatusQ.data?.providers ?? {},
        myProviders: (credsQ.data?.credentials ?? []).map((c) => c.provider),
      }),
    [agents, providerStatusQ.data, credsQ.data],
  );

  const providerConfigured = useCallback(
    (provider: string) => provider === "mock" || Boolean(providerStatus[provider]?.configured),
    [providerStatus],
  );

  // ADR-0173 §3 — the org's model allow-list for Chat: its default wins, and a
  // binding it forbids is never picked by default (the picker shows it disabled)
  const policyQ = useModelPolicy();
  const policy = policyQ.data ?? null;

  // fresh chats open on the policy's Chat default when there is one, else the
  // best LIVE real provider (Claude first), mirroring the legacy pickDefaultAgentId
  const defaultAgentId = useMemo(() => {
    if (!agents.length) return "";
    const chatAllowed = (a: { agentId: string; provider: string }) =>
      modelPolicyVerdict(policy, "chat", { id: a.agentId, provider: a.provider }).allowed;
    const policyDefault = modelPolicyDefault(policy, "chat");
    if (policyDefault && agents.some((a) => a.agentId === policyDefault && chatAllowed(a))) return policyDefault;
    const usable = agents.filter(chatAllowed);
    if (!usable.length) return agents[0]!.agentId;
    const live = usable.filter((a) => a.provider !== "mock" && providerConfigured(a.provider));
    if (live.length) {
      const best = [...live].sort((a, b) => {
        const ap = a.provider === "anthropic" ? 1 : 0;
        const bp = b.provider === "anthropic" ? 1 : 0;
        if (ap !== bp) return bp - ap;
        return (b.tier ?? 0) - (a.tier ?? 0);
      })[0]!;
      return best.agentId;
    }
    const def = agentsQ.data?.defaultAgentId;
    if (def && usable.some((a) => a.agentId === def)) return def;
    return usable[0]!.agentId;
  }, [agents, agentsQ.data?.defaultAgentId, providerConfigured, policy]);

  // ---- chat state ---------------------------------------------------------
  const [agentId, setAgentId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [costSensitivity, setCostSensitivity] = useState("standard");
  const [input, setInput] = useState("");
  const [exchanges, setExchanges] = useState<Exchange[]>([]);
  const [convoId, setConvoId] = useState<string | null>(
    () => sessionStorage.getItem("regulait.convo") || null,
  );
  const [freshChat, setFreshChat] = useState(false);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [attach, setAttach] = useState<PendingAttachment[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ConversationSummary | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const attachSeq = useRef(0);
  const logRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // agent select follows the computed default until the user (or an opened
  // thread) picks one explicitly
  useEffect(() => {
    if (!agentId && defaultAgentId) setAgentId(defaultAgentId);
  }, [agentId, defaultAgentId]);

  const setConvo = useCallback((id: string | null) => {
    setConvoId(id);
    if (id) sessionStorage.setItem("regulait.convo", id);
    else sessionStorage.removeItem("regulait.convo");
  }, []);

  // fresh sign-in lands in the newest thread (unless the user asked for fresh)
  useEffect(() => {
    if (!convoId && !freshChat && !streaming && conversations.length) {
      setConvo(conversations[0]!.id);
    }
  }, [convoId, freshChat, streaming, conversations, setConvo]);

  // restore the open thread's history from the server
  useEffect(() => {
    if (!convoId || streaming || loadedFor === convoId) return;
    let cancelled = false;
    void (async () => {
      try {
        const detail = await api.get<ConversationDetail>(`/v1/conversations/${convoId}`);
        if (cancelled) return;
        setExchanges(exchangesFromMessages(detail, agentNames));
        setLoadedFor(convoId);
        if (detail.agentId && agents.some((a) => a.agentId === detail.agentId)) {
          setAgentId(detail.agentId);
        }
        setProjectId(detail.projectId && projects.some((p) => p.id === detail.projectId) ? detail.projectId : "");
      } catch {
        if (!cancelled) {
          // stale id (deleted / another account's) clears silently
          setConvo(null);
          setExchanges([]);
          setLoadedFor(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [convoId, streaming, loadedFor, agentNames, agents, projects, setConvo]);

  // autoscroll while streaming / after sends
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [exchanges]);

  const refreshRail = useCallback(
    () => queryClient.invalidateQueries({ queryKey: ["conversations"] }),
    [queryClient],
  );

  // ---- attachments --------------------------------------------------------
  const addFiles = useCallback(
    async (files: FileList | File[]) => {
      const next: PendingAttachment[] = [];
      for (const file of Array.from(files)) {
        if (attach.length + next.length >= maxAttach) {
          toast(`Up to ${maxAttach} files per message.`, "error");
          break;
        }
        if (file.size > maxBytes) {
          toast(`${file.name} is over the ${fmtBytes(maxBytes)} limit.`, "error");
          continue;
        }
        const isImg = IMG_TYPES.includes(file.type);
        const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
        try {
          if (isImg || isPdf) {
            const dataUrl = await readAs(file, "dataurl");
            next.push({
              id: ++attachSeq.current,
              mode: "attachment",
              kind: isImg ? "image" : "document",
              name: file.name,
              mediaType: isImg ? file.type : "application/pdf",
              dataBase64: dataUrl.slice(dataUrl.indexOf(",") + 1),
              thumb: isImg ? dataUrl : null,
              size: file.size,
            });
          } else {
            next.push({
              id: ++attachSeq.current,
              mode: "text",
              name: file.name,
              text: await readAs(file, "text"),
              thumb: null,
              size: file.size,
            });
          }
        } catch {
          toast(`Couldn't read ${file.name}`, "error");
        }
      }
      if (next.length) setAttach((xs) => [...xs, ...next]);
    },
    [attach.length, maxAttach, maxBytes, toast],
  );

  const onDrop = (e: DragEvent) => {
    setDragOver(false);
    if (e.dataTransfer?.files?.length) {
      e.preventDefault();
      void addFiles(e.dataTransfer.files);
    }
  };
  const onPaste = (e: ClipboardEvent) => {
    const files = Array.from(e.clipboardData?.items ?? [])
      .filter((it) => it.kind === "file")
      .map((it) => it.getAsFile())
      .filter((f): f is File => Boolean(f));
    if (files.length) {
      e.preventDefault();
      void addFiles(files);
    }
  };

  // ---- send ---------------------------------------------------------------
  const send = useCallback(async () => {
    if (streaming) return;
    const prompt = input.trim();
    if (!prompt && !attach.length) return;
    if (!agentId) {
      toast("No agents granted to your account — ask an admin.", "error");
      return;
    }

    let activeConvo = convoId;
    if (!activeConvo) {
      try {
        const row = await api.post<{ id: string }>("/v1/conversations", {
          agentId,
          ...(projectId ? { projectId } : {}),
        });
        activeConvo = row.id;
        setFreshChat(false);
        setConvo(row.id);
        setLoadedFor(row.id);
      } catch (e) {
        toast(`Couldn't start a conversation — ${e instanceof Error ? e.message : e}`, "error");
        return;
      }
    }

    setInput("");
    const pending = attach;
    setAttach([]);
    const attachments = pending
      .filter((a) => a.mode === "attachment")
      .map((a) => ({ kind: a.kind, name: a.name, mediaType: a.mediaType, dataBase64: a.dataBase64 }));
    const textFiles = pending.filter((a) => a.mode === "text");
    const referenceContent = textFiles.length
      ? textFiles.map((a) => `----- FILE: ${a.name} -----\n${a.text}`).join("\n\n")
      : undefined;
    const attachViews: AttachView[] = pending.map((a) => ({
      name: a.name,
      kind: a.mode === "attachment" ? (a.kind ?? "document") : "text",
      thumb: a.thumb,
    }));

    const x: Exchange = {
      prompt,
      agentName: agentNames[agentId] ?? "agent",
      text: "",
      streaming: true,
      ...(attachViews.length ? { attachments: attachViews } : {}),
    };
    setExchanges((xs) => [...xs, x]);
    const patch = (fn: (draft: Exchange) => void) =>
      setExchanges((xs) => {
        const copy = [...xs];
        const cur = { ...copy[copy.length - 1]! };
        fn(cur);
        copy[copy.length - 1] = cur;
        return copy;
      });

    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setStreaming(true);
    let compacted = false;
    try {
      const res = await ssePost(
        `/v1/agents/${agentId}/invoke`,
        {
          mode: "execute",
          input: prompt,
          dispatch: true,
          stream: true,
          costSensitivity,
          conversationId: activeConvo,
          ...(projectId ? { projectId } : {}),
          ...(attachments.length ? { attachments } : {}),
          ...(referenceContent ? { referenceContent } : {}),
        },
        ctrl.signal,
      );
      if (!res.ok || !res.headers.get("content-type")?.includes("event-stream")) {
        // buffered JSON: a denial, a block-mode PII project (streaming
        // suppressed — success), or an error. All are expected outcomes.
        type Buffered = InvokeResult & { error?: string; pii?: PiiInfo; decision?: Exchange["denied"] };
        let j: Buffered | null = null;
        try {
          j = (await res.json()) as Buffered;
        } catch {
          j = null;
        }
        patch((d) => {
          d.streaming = false;
          if (j?.decision && j.decision.effect !== "allow") {
            d.denied = j.decision;
            d.text = j.decision.reason ?? "";
          } else if (res.ok && j?.dispatch) {
            d.result = j;
            d.text = j.dispatch.refusal
              ? "The model declined this request."
              : (j.dispatch.outputText ?? "");
            if (j.dispatch.pii) d.pii = j.dispatch.pii;
            if (j.streamingSuppressed) {
              d.note =
                "Streaming is disabled here: an output control (the PII mode or a guardrail) is in block mode, so output is checked in full before any of it is sent.";
            }
          } else {
            d.error = j?.error ?? `HTTP ${res.status}`;
            d.text = errMessage(res.status, (j ?? {}) as Parameters<typeof errMessage>[1]);
          }
          if (j?.pii) d.pii = j.pii;
        });
        return;
      }
      await readSse(res, (ev, raw) => {
        const payload = raw as InvokeResult & {
          text?: string;
          error?: string;
          detail?: string;
          pii?: PiiInfo;
          decision?: Exchange["denied"];
        };
        if (ev === "delta") patch((d) => (d.text += payload.text ?? ""));
        if (ev === "result") {
          compacted = Boolean(payload.compaction?.compacted);
          patch((d) => {
            d.result = payload;
            d.streaming = false;
            const servedId = payload.routing?.selectedAgentId ?? payload.dispatch?.servedAgentId;
            if (servedId && agentNames[servedId]) d.agentName = agentNames[servedId]!;
            if (payload.dispatch?.refusal) d.text = "The model declined this request.";
            if (payload.dispatch?.pii?.withheld) d.text = payload.dispatch.outputText ?? "";
            if (payload.dispatch?.pii) d.pii = payload.dispatch.pii;
          });
        }
        if (ev === "error") {
          patch((d) => {
            const msg = errMessage(res.status, payload as Parameters<typeof errMessage>[1]);
            d.error = payload.error ?? "error";
            d.text = d.text ? `${d.text}\n\n${msg}` : msg;
            if (payload.pii) d.pii = payload.pii;
            if (payload.decision) {
              d.result = {
                ...(payload.decision ? { decision: payload.decision as InvokeResult["decision"] } : {}),
                ...(payload.routing ? { routing: payload.routing } : {}),
              };
            }
            d.streaming = false;
          });
        }
      });
      patch((d) => (d.streaming = false));
    } catch (e) {
      patch((d) => {
        d.streaming = false;
        if ((e as Error).name === "AbortError") {
          d.error = "stopped";
          d.text =
            (d.text ? d.text + "\n\n" : "") +
            "(stream stopped — the dispatch itself already ran and was metered)";
        } else {
          d.error = "request_failed";
          d.text = e instanceof Error ? e.message : String(e);
        }
      });
    } finally {
      abortRef.current = null;
      setStreaming(false);
      if (compacted) {
        // reload the thread so the compaction divider appears in place
        setLoadedFor(null);
      }
      void refreshRail();
    }
  }, [
    streaming,
    input,
    attach,
    agentId,
    convoId,
    projectId,
    costSensitivity,
    agentNames,
    setConvo,
    refreshRail,
    toast,
  ]);

  // ---- guards -------------------------------------------------------------
  if (agentsQ.isLoading || convosQ.isLoading) {
    return (
      <>
        <PageHeader title="Chat" sub="Every message goes through governance, routing and metered dispatch." />
        <Card>
          <SkeletonBlock lines={5} />
        </Card>
      </>
    );
  }
  if (!userId) {
    return (
      <>
        <PageHeader title="Chat" />
        <Card>
          <EmptyState
            title="This session has no user identity"
            body="The bootstrap operator can administer but not chat — sign in as a real user."
          />
        </Card>
      </>
    );
  }

  const noAgents = agents.length === 0;
  const selAgent = agents.find((a) => a.agentId === agentId);

  return (
    <>
      <PageHeader
        title="Chat"
        sub="Every message goes through governance, routing and metered dispatch."
        info={<p>Every message goes through governance, routing and metered dispatch — the trace shows what actually happened. Conversations remember: each turn carries the whole thread.</p>}
      />
      <div className={s.split}>
        <Card className={s.rail} title="Conversations">
          <Button
            size="sm"
            onClick={() => {
              if (streaming) {
                toast("A reply is still streaming — Stop it or let it finish first.");
                return;
              }
              setFreshChat(true);
              setConvo(null);
              setExchanges([]);
              setLoadedFor(null);
            }}
          >
            + New conversation
          </Button>
          {conversations.length === 0 ? (
            <EmptyState
              title="No conversations yet"
              body="Send a message and a thread starts itself."
            />
          ) : (
            conversations.map((c) => (
              <div key={c.id} className={c.id === convoId ? s.railItemActive : s.railItem}>
                <button
                  className={v.grow}
                  style={{ all: "unset", cursor: "pointer", flex: 1, minWidth: 0 }}
                  onClick={() => {
                    if (streaming) {
                      toast("A reply is still streaming — Stop it or let it finish first.");
                      return;
                    }
                    if (c.id === convoId) return;
                    setFreshChat(false);
                    setConvo(c.id);
                    setLoadedFor(null);
                  }}
                  title={c.title ?? "Untitled"}
                >
                  <div className={s.railTitle}>{c.title ?? "Untitled"}</div>
                  <div className={s.railMeta}>
                    {c.agentName ?? "agent"} · {ago(c.updatedAt)} · {c.messageCount ?? 0} msg
                    {(c.messageCount ?? 0) === 1 ? "" : "s"}
                  </div>
                </button>
                <button
                  className={s.railDelete}
                  aria-label={`Delete conversation ${c.title ?? "Untitled"}`}
                  title="Delete this conversation — its history is removed for good"
                  onClick={() => setDeleteTarget(c)}
                >
                  ×
                </button>
              </div>
            ))
          )}
        </Card>

        <div className={v.stack}>
          <Card>
            <div className={v.row}>
              {noAgents ? (
                <span className={v.dim}>
                  No agents are granted to your account — ask an admin to grant you one.
                </span>
              ) : (
                <ModelPicker
                  label="Agent"
                  agents={pickerAgents}
                  value={agentId}
                  onChange={setAgentId}
                  testId="chat-agent"
                  feature="chat"
                  policy={policy}
                />
              )}
              <Field label="Bill to">
                <Select value={projectId} onChange={(e) => setProjectId(e.target.value)} aria-label="Bill to project">
                  <option value="">no project</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Priority">
                <Select
                  value={costSensitivity}
                  onChange={(e) => setCostSensitivity(e.target.value)}
                  aria-label="Priority"
                >
                  <option value="standard">standard</option>
                  <option value="cost-sensitive">cost-sensitive</option>
                  <option value="quality-sensitive">quality-sensitive</option>
                </Select>
              </Field>
            </div>
            {selAgent && (
              <KeyHintBanner
                agent={selAgent}
                myProviders={myProviders}
                providerConfigured={providerConfigured}
              />
            )}
          </Card>

          <Card>
            <div className={s.log} ref={logRef} aria-live="polite">
              {exchanges.length === 0 ? (
                <EmptyState
                  title={noAgents ? "Nothing to send to yet" : "Start the conversation"}
                  body={
                    noAgents
                      ? "An admin has to grant your account an agent first."
                      : "Pick an agent and say something — the first message starts a thread. Mock agents reply instantly with no external keys; type «<<refuse>>» to see refusal handling."
                  }
                />
              ) : (
                exchanges.map((x, i) => (
                  <ExchangeView key={i} x={x} me={auth?.user?.displayName ?? "You"} />
                ))
              )}
            </div>

            <div
              className={[s.composer, dragOver ? s.composerDrag : ""].join(" ")}
              onDragEnter={(e) => {
                if (e.dataTransfer?.types?.includes("Files")) {
                  e.preventDefault();
                  setDragOver(true);
                }
              }}
              onDragOver={(e) => {
                if (e.dataTransfer?.types?.includes("Files")) {
                  e.preventDefault();
                  setDragOver(true);
                }
              }}
              onDragLeave={(e) => {
                if (e.target === e.currentTarget) setDragOver(false);
              }}
              onDrop={onDrop}
            >
              {attach.length > 0 && (
                <div className={s.tray}>
                  {attach.map((a) => (
                    <span key={a.id} className={s.attachChip}>
                      {a.thumb ? (
                        <img className={s.attachThumb} src={a.thumb} alt="" />
                      ) : (
                        <span aria-hidden>{a.mode === "attachment" ? "📄" : "📝"}</span>
                      )}
                      <span style={{ minWidth: 0 }}>
                        <span className={s.attachName}>{a.name}</span>
                        <br />
                        <span className={s.attachMeta}>
                          {fmtBytes(a.size)} · {a.mode === "attachment" ? a.kind : "text → reference"}
                        </span>
                      </span>
                      <button
                        className={s.attachRemove}
                        aria-label={`Remove ${a.name}`}
                        onClick={() => setAttach((xs) => xs.filter((x) => x.id !== a.id))}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <div className={s.composerRow}>
                <input
                  ref={fileRef}
                  type="file"
                  multiple
                  style={{ display: "none" }}
                  accept="image/png,image/jpeg,image/gif,image/webp,application/pdf,text/*,.md,.markdown,.csv,.json,.yaml,.yml,.txt,.log,.ts,.tsx,.js,.jsx,.py,.go,.rb,.java,.rs,.c,.h,.cpp,.sql,.sh,.html,.css"
                  onChange={(e) => {
                    if (e.target.files?.length) void addFiles(e.target.files);
                    e.target.value = "";
                  }}
                />
                <Button
                  aria-label="Attach files"
                  title="Attach images, PDFs, or text/code files"
                  disabled={noAgents}
                  onClick={() => fileRef.current?.click()}
                >
                  📎
                </Button>
                <Textarea
                  aria-label="Message"
                  rows={2}
                  style={{ flex: 1 }}
                  placeholder={
                    noAgents
                      ? "No agent granted to your account yet…"
                      : convoId
                        ? "Continue the conversation…"
                        : "Ask the agent to do something…"
                  }
                  disabled={noAgents}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      void send();
                    }
                  }}
                  onPaste={onPaste}
                />
                <Button variant="primary" disabled={noAgents || streaming} onClick={() => void send()}>
                  Send
                </Button>
                {streaming && (
                  <Button
                    title="Close the stream — the dispatch already ran, anything streamed stays"
                    onClick={() => abortRef.current?.abort()}
                  >
                    Stop
                  </Button>
                )}
              </div>
              <div className={v.faint} style={{ marginTop: "var(--s0)" }}>
                Attach images &amp; PDFs (a vision-capable agent reads them), or text/code files
                (fed as reference). Up to {maxAttach} files · {fmtBytes(maxBytes)} each.
              </div>
            </div>
          </Card>
        </div>
      </div>

      <ConfirmModal
        open={Boolean(deleteTarget)}
        title="Delete conversation?"
        body={
          deleteTarget
            ? `“${deleteTarget.title ?? "Untitled"}” and its history will be removed for good.`
            : undefined
        }
        confirmLabel="Delete"
        danger
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => {
          const target = deleteTarget;
          setDeleteTarget(null);
          if (!target) return;
          void (async () => {
            try {
              await api.del(`/v1/conversations/${target.id}`);
              if (convoId === target.id) {
                setConvo(null);
                setExchanges([]);
                setLoadedFor(null);
              }
              toast("Conversation deleted", "success");
              void refreshRail();
            } catch (e) {
              toast(`✗ ${e instanceof Error ? e.message : e}`, "error");
            }
          })();
        }}
      />
    </>
  );
}

// ---- sub-components -------------------------------------------------------

function KeyHintBanner(props: {
  agent: GrantedAgent;
  myProviders: string[];
  providerConfigured: (p: string) => boolean;
}) {
  const { agent } = props;
  if (agent.provider === "mock") {
    return (
      <div className={v.faint} style={{ marginTop: "var(--s1)" }}>
        Mock provider — runs with no credential at all. Replies are simulated and spend is $0; an
        admin can connect a real provider from the admin console.
      </div>
    );
  }
  const label = agent.provider.charAt(0).toUpperCase() + agent.provider.slice(1);
  if (props.providerConfigured(agent.provider)) {
    return (
      <div className={s.live}>
        ● Live: {agent.name}
        {agent.model ? ` (${agent.model})` : ""} ·{" "}
        {props.myProviders.includes(agent.provider)
          ? "runs on your own key"
          : "runs on the platform credential"}
      </div>
    );
  }
  return (
    <div className={s.banner} role="note">
      {label} isn't configured yet — this agent will error on send. Add your own key under Account
      security, or ask an admin to configure the platform credential. Pick a mock agent to try the
      flow now.
    </div>
  );
}

function PiiBadge(props: { pii: PiiInfo }) {
  const { pii } = props;
  const cats = [...(pii.inputHits ?? []), ...(pii.outputHits ?? [])].map((h) => h.category).join(", ");
  const tip = `compliance PII policy '${pii.mode}' — categories: ${cats || "none"}${pii.withheld ? " · output withheld and billed" : ""}`;
  if (pii.action === "block") {
    return (
      <Badge tone="danger" title={tip}>
        PII blocked{pii.withheld ? " · output withheld" : ""}
      </Badge>
    );
  }
  if (pii.action === "warn") {
    return (
      <Badge tone="warn" title={tip}>
        PII warning: {cats}
      </Badge>
    );
  }
  return <Badge title={tip}>PII logged: {cats}</Badge>;
}

function ExchangeView(props: { x: Exchange; me: string }) {
  const { x } = props;
  const r = x.result;
  const badges: React.ReactNode[] = [];
  if (r?.routing?.effect === "routed") {
    badges.push(
      <Badge key="routed" tone="primary">
        routed
      </Badge>,
    );
    if ((r.routing.estimatedCostSavedUsd ?? 0) > 0) {
      badges.push(
        <Badge key="saved" tone="ok">
          est. saved {fmtUsd(r.routing.estimatedCostSavedUsd)}
        </Badge>,
      );
    }
  }
  if (r?.dispatch) {
    const d = r.dispatch;
    if (d.refusal)
      badges.push(
        <Badge key="refused" tone="danger">
          refused
        </Badge>,
      );
    if (d.costUsd != null)
      badges.push(
        <Badge key="cost">
          {fmtUsd(d.costUsd)}
          {d.usage ? ` · ${d.usage.inputTokens}→${d.usage.outputTokens} tok` : ""}
        </Badge>,
      );
    if (d.model) badges.push(<Badge key="model">{d.model}</Badge>);
    if (d.credentialSource === "user")
      badges.push(
        <Badge key="cred" tone="info">
          your key
        </Badge>,
      );
    if (d.credentialSource === "platform") badges.push(<Badge key="cred">platform key</Badge>);
    if (d.projectBudgetAlerted)
      badges.push(
        <Badge key="budget" tone="warn">
          budget alert
        </Badge>,
      );
  }
  const pii = r?.dispatch?.pii ?? x.pii;
  if (pii) badges.push(<PiiBadge key="pii" pii={pii} />);
  const compaction = r?.compaction;
  if (compaction?.compacted)
    badges.push(
      <Badge
        key="compacted"
        tone="primary"
        title="This turn pushed the thread past the compaction threshold — older turns were summarized by a governed, metered dispatch; stored history is untouched"
      >
        history compacted
      </Badge>,
    );
  if (compaction?.active)
    badges.push(
      <Badge
        key="compact-active"
        tone="info"
        title={`The model received a summary of the older turns plus the recent window — est. ${compaction.savedTokensEst ?? 0} tokens saved`}
      >
        summary context · ~{compaction.savedTokensEst ?? 0} tok saved
      </Badge>,
    );
  if (compaction?.failOpen)
    badges.push(
      <Badge key="compact-fail" tone="warn" title={compaction.failOpen.error ?? ""}>
        compaction failed open
      </Badge>,
    );
  if (x.denied) {
    const rid = UUID_RE.test(x.denied.ruleId) ? shortId(x.denied.ruleId) : x.denied.ruleId;
    badges.push(
      <Badge key="denied" tone="danger" title={x.denied.ruleId}>
        denied · {rid}
      </Badge>,
    );
  }
  if (x.error)
    badges.push(
      <Badge key="err" tone="danger">
        {x.error}
      </Badge>,
    );

  const dec = x.denied ?? r?.decision;
  const traceObj = x.denied ?? {
    ...(r?.decision ? { decision: r.decision } : {}),
    ...(r?.routing ? { routing: r.routing } : {}),
    ...(compaction ? { compaction } : {}),
  };
  const hasTrace = Boolean(x.denied || r?.decision || r?.routing || compaction);

  return (
    <>
      <div className={s.msgUser}>
        <span className={s.who}>{props.me}</span>
        {x.attachments && x.attachments.length > 0 && (
          <div className={s.attRow}>
            {x.attachments.map((a, i) => (
              <span key={i} className={s.attPill}>
                {a.thumb ? <img src={a.thumb} alt="" /> : <span aria-hidden>{a.kind === "document" ? "📄" : "📝"}</span>}
                {a.name}
              </span>
            ))}
          </div>
        )}
        {x.prompt && <div className={s.bubbleUser}>{x.prompt}</div>}
      </div>
      <div className={s.msgAgent}>
        <span className={s.who}>{x.agentName}</span>
        <div className={s.bubbleAgent}>
          {x.text}
          {x.streaming && <span className={s.caret} aria-label="streaming" />}
        </div>
        {x.note && <div className={s.note}>{x.note}</div>}
        {x.denied?.ruleId === LITERACY_REFUSAL_CODE && <RefusalNotice guidance={REFUSAL_GUIDANCE.literacy} />}
        <div className={s.meta}>{badges}</div>
        {hasTrace && (
          <details className={s.trace}>
            <summary>governance trace</summary>
            <div style={{ marginTop: "var(--s1)", display: "flex", flexDirection: "column", gap: "var(--s1)" }}>
              {dec && (
                <div className={v.rowTight}>
                  <Badge tone={dec.effect === "allow" ? "ok" : "danger"}>{dec.effect ?? "deny"}</Badge>
                  <span className={v.faint}>{dec.reason ?? dec.ruleId}</span>
                </div>
              )}
              <CodeBlock maxHeight="200px">{JSON.stringify(traceObj, null, 2)}</CodeBlock>
            </div>
          </details>
        )}
      </div>
      {x.compactedBoundary && (
        <details className={s.compactDivider}>
          <summary>
            — older turns above are compacted into a summary — full history retained
            {x.compactedBoundary.summaryTokens ? ` (~${x.compactedBoundary.summaryTokens} tok)` : ""} —
          </summary>
          <CodeBlock maxHeight="160px">{x.compactedBoundary.summary ?? ""}</CodeBlock>
        </details>
      )}
    </>
  );
}

/** server history → the exact exchange shape the live path draws */
function exchangesFromMessages(
  detail: ConversationDetail,
  agentNames: Record<string, string>,
): Exchange[] {
  const out: Exchange[] = [];
  for (const m of detail.messages ?? []) {
    if (m.role === "user") {
      const x: Exchange = {
        prompt: m.content,
        agentName: detail.agentName ?? "agent",
        text: "",
        streaming: false,
      };
      if (m.detail?.denied) {
        x.denied = { ruleId: "denied", ...(m.detail.reason ? { reason: m.detail.reason } : {}) };
        x.text = m.detail.reason ?? "";
      }
      out.push(x);
    } else if (m.role === "assistant") {
      const x = out[out.length - 1];
      if (!x || x.denied || x.result) continue;
      const d = m.detail ?? {};
      x.text = m.content;
      if (d.servedAgentId && agentNames[d.servedAgentId]) x.agentName = agentNames[d.servedAgentId]!;
      x.result = {
        dispatch: {
          ...(d.modelUsed ? { model: d.modelUsed } : {}),
          ...(d.costUsd != null ? { costUsd: d.costUsd } : {}),
          ...(d.refusal != null ? { refusal: d.refusal } : {}),
          ...(d.credentialSource ? { credentialSource: d.credentialSource } : {}),
        },
        ...(d.compaction ? { compaction: d.compaction } : {}),
      };
    }
    if (detail.summaryThroughMessageId && m.id === detail.summaryThroughMessageId && out.length) {
      out[out.length - 1]!.compactedBoundary = {
        summary: detail.summary ?? null,
        summaryTokens: detail.summaryTokens ?? null,
      };
    }
  }
  return out;
}
