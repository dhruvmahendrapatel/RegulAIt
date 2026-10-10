/**
 * ADR-0172 — the agent editor's Configure panel: collapsible sections for
 * channels, sharing, connections, knowledge, memory, schedules, sub-agents,
 * advanced settings and "use in code". Every change is a single call the
 * gateway audits; nothing here widens what the agent can do beyond what the
 * person using it holds.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ago, fmtUsd, providerLabel } from "../../api/format";
import type { BuilderAgentDetail, BuilderChannelProvider, BuilderSharing } from "../../api/types";
import { useSession } from "../../session/SessionContext";
import { Badge, Button, ConfirmModal, Field, Input, Meter, Select, Textarea } from "../../ui/kit";
import { Logo } from "../../ui/logos/Logo";
import { providerLogoKey } from "../../ui/logos/providerLogo";
import { ModelPicker, type ModelPickerAgent } from "../../ui/ModelPicker";
import { useToast } from "../../ui/toast";
import { AddConnectionDialog, AddSkillDialog, CodeDialog, NewScheduleDialog, NewSubagentDialog, type ToolCandidate } from "./AgentDialogs";
import { bk, builderApi, useAgents, useDirectory, useMyModelTiles, useMyProjects, type PatchAgentBody, type ScheduleBody } from "./builderApi";
import { AGENT_COLORS, bundleFileName, parseLimitInput, scheduleSummary, skillPrivateOnSharedAgentCopy, skillWithheldCopy, spendState } from "./builderLogic";
import { AgentAvatar, Icon, Section, Segmented, Switch, ToolLogo } from "./BuilderUi";
import { ExecutionProfileSelector } from '../admin/integrations/isolation/IsolationPanel';
import { AutonomyPanel } from "./AutonomyPanel";
import s from "./builder.module.css";

export const CHANNELS: Array<{ provider: BuilderChannelProvider; name: string; logo: string | null; sub: string }> = [
  { provider: "slack", name: "Slack", logo: "slack", sub: "Chat with the agent in Slack" },
  { provider: "teams", name: "Microsoft Teams", logo: "teams", sub: "Chat with the agent in Teams" },
  { provider: "outlook", name: "Outlook", logo: "microsoft", sub: "Send-only: an incoming email can't prove who sent it, so it never starts the agent" },
  { provider: "email", name: "Email", logo: null, sub: "Send-only: an incoming email can't prove who sent it, so it never starts the agent" },
];

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** one place that applies an agent-returning change to the cache */
export function useAgentChange(agentId: string) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  return useCallback(
    (res: { agent?: BuilderAgentDetail } | unknown, message?: string) => {
      const agent = (res as { agent?: BuilderAgentDetail } | undefined)?.agent;
      if (agent) queryClient.setQueryData(bk.agent(agentId), { agent });
      else void queryClient.invalidateQueries({ queryKey: bk.agent(agentId) });
      void queryClient.invalidateQueries({ queryKey: bk.agents });
      if (message) toast(message, "success");
    },
    [agentId, queryClient, toast],
  );
}

export function ChannelRows(props: { agent: BuilderAgentDetail; disabled: boolean }) {
  const { agent } = props;
  const applied = useAgentChange(agent.id);
  const { toast } = useToast();
  const { auth } = useSession();
  const isAdmin = Boolean(auth?.isAdmin);
  const add = useMutation({
    mutationFn: (p: BuilderChannelProvider) => builderApi.addChannel(agent.id, p),
    onSuccess: (ch, p) => {
      const label = CHANNELS.find((c) => c.provider === p)?.name;
      applied(
        undefined,
        ch.status === "connected"
          ? `${label} connected`
          : isAdmin
            ? `${label} added — no matching chat connection yet`
            : `${label} added — an admin connects it to the workspace's chat connection`,
      );
    },
    onError: (e) => toast(errText(e), "error"),
  });
  const remove = useMutation({
    mutationFn: (id: string) => builderApi.deleteChannel(agent.id, id),
    onSuccess: () => applied(undefined, "Channel removed"),
    onError: (e) => toast(errText(e), "error"),
  });
  return (
    <div className={s.list}>
      {CHANNELS.map((c) => {
        const bound = agent.channels.find((x) => x.provider === c.provider);
        return (
          <div key={c.provider} className={s.listRow}>
            {c.logo ? (
              <Logo name={c.logo} label={c.name} size={22} />
            ) : (
              <span className={s.logoChipSm} aria-hidden>
                {Icon.mail(14)}
              </span>
            )}
            <span className={s.listRowMain}>
              <span className={s.listRowTitle}>
                {c.name}
                {bound && (bound.status === "connected" ? <Badge tone="ok">Connected</Badge> : <Badge tone="warn">Needs setup</Badge>)}
              </span>
              <span className={s.listRowSub}>
                {bound?.connectionName
                  ? `Uses ${bound.connectionName}`
                  : bound && bound.status === "needs_setup"
                    ? "Waiting for an admin to connect it to a workspace chat connection"
                    : c.sub}
              </span>
            </span>
            {bound ? (
              <button type="button" className={s.iconBtn} aria-label={`Remove ${c.name}`} disabled={props.disabled || remove.isPending} onClick={() => remove.mutate(bound.id)}>
                {Icon.trash()}
              </button>
            ) : (
              <Button size="sm" aria-label={`Set up ${c.name}`} disabled={props.disabled || add.isPending} onClick={() => add.mutate(c.provider)}>
                Set up
              </Button>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function ConfigurePanel(props: { agent: BuilderAgentDetail; onOpenSkills: () => void; skillsOpen: boolean; onCloseSkills: () => void }) {
  const { agent } = props;
  const ro = !agent.canEdit;
  const navigate = useNavigate();
  const { toast } = useToast();
  const { auth } = useSession();
  const applied = useAgentChange(agent.id);
  const isOwner = auth?.userId === agent.ownerUserId;
  const models = useMyModelTiles(auth?.userId ?? null);
  const projectsQ = useMyProjects();
  // the agent's current project stays listed even if it is not one of yours
  const projectOptions = useMemo(() => {
    const mine = projectsQ.data?.projects ?? [];
    const cur = agent.project;
    return cur && !mine.some((p) => p.id === cur.id) ? [cur, ...mine] : mine;
  }, [projectsQ.data, agent.project]);
  // the agent's current model stays on show even when it is not one the
  // editor may choose (an admin editing someone else's agent, say)
  const modelTiles = useMemo<ModelPickerAgent[]>(() => {
    const m = agent.modelAgent;
    if (!m || models.tiles.some((t) => t.id === m.id)) return models.tiles;
    return [
      { id: m.id, name: m.name, provider: m.provider, providerLabel: providerLabel(m.provider), model: m.model, logoKey: providerLogoKey(m.provider), readinessLabel: "Not available to you", readinessTone: "neutral" },
      ...models.tiles,
    ];
  }, [agent.modelAgent, models.tiles]);
  const directory = useDirectory();
  const allAgents = useAgents();
  const queryClient = useQueryClient();

  // ---- details
  const [name, setName] = useState(agent.name);
  const [description, setDescription] = useState(agent.description ?? "");
  const [instructions, setInstructions] = useState(agent.instructions);
  const [limit, setLimit] = useState(agent.monthlyLimitUsd != null ? String(agent.monthlyLimitUsd) : "");
  const [limitErr, setLimitErr] = useState<string | null>(null);
  const [memory, setMemory] = useState("");
  const [person, setPerson] = useState("");
  useEffect(() => {
    setName(agent.name);
    setDescription(agent.description ?? "");
  }, [agent.name, agent.description]);
  useEffect(() => setInstructions(agent.instructions), [agent.instructions]);
  useEffect(() => setLimit(agent.monthlyLimitUsd != null ? String(agent.monthlyLimitUsd) : ""), [agent.monthlyLimitUsd]);

  const patch = useMutation({
    mutationFn: (v: { body: PatchAgentBody; msg: string }) => builderApi.patchAgent(agent.id, v.body),
    onSuccess: (res, v) => applied(res, v.msg),
    onError: (e) => toast(errText(e), "error"),
  });

  // ---- tools
  const [connOpen, setConnOpen] = useState(false);
  const closeConn = useCallback(() => setConnOpen(false), []);
  const [addingRef, setAddingRef] = useState<string | null>(null);
  const putTools = useMutation({
    mutationFn: (tools: BuilderAgentDetail["tools"]) =>
      builderApi.putTools(agent.id, tools.map((t) => ({ kind: t.kind, refId: t.refId, requiresApproval: t.requiresApproval }))),
    onSuccess: (res) => applied(res, "Connections saved"),
    onError: (e) => toast(errText(e), "error"),
    onSettled: () => setAddingRef(null),
  });
  const addTool = (c: ToolCandidate) => {
    setAddingRef(c.refId);
    putTools.mutate([...agent.tools, { kind: c.kind, refId: c.refId, name: c.name, provider: c.provider, requiresApproval: c.defaultApproval, entitledForYou: true }]);
  };

  // ---- skills
  const putSkills = useMutation({
    mutationFn: (ids: string[]) => builderApi.putSkills(agent.id, ids),
    onSuccess: (res) => {
      applied(res, "Skills saved");
      props.onCloseSkills();
    },
    onError: (e) => toast(errText(e), "error"),
  });

  const reattach = useMutation({
    mutationFn: (skillId: string) => builderApi.reattachSkill(agent.id, skillId),
    onSuccess: (res) => applied(res, "Skill updated to the newest version"),
    onError: (e) => toast(errText(e), "error"),
  });

  // ---- memory
  const addMemory = useMutation({
    mutationFn: (content: string) => builderApi.addMemory(agent.id, content),
    onSuccess: () => {
      setMemory("");
      applied(undefined, "Added to memory");
    },
    onError: (e) => toast(errText(e), "error"),
  });
  const delMemory = useMutation({
    mutationFn: (id: string) => builderApi.deleteMemory(agent.id, id),
    onSuccess: () => applied(undefined, "Removed from memory"),
    onError: (e) => toast(errText(e), "error"),
  });

  // ---- schedules
  const [schedOpen, setSchedOpen] = useState(false);
  const closeSched = useCallback(() => setSchedOpen(false), []);
  const addSchedule = useMutation({
    mutationFn: (body: ScheduleBody) => builderApi.addSchedule(agent.id, body),
    onSuccess: (sc) => {
      setSchedOpen(false);
      applied(undefined, sc.awaitingOwner ? "Schedule added — it stays off until the owner turns it on" : "Schedule added");
    },
  });
  const toggleSchedule = useMutation({
    mutationFn: (v: { id: string; enabled: boolean }) => builderApi.patchSchedule(agent.id, v.id, { enabled: v.enabled }),
    onSuccess: (_r, v) => applied(undefined, v.enabled ? "Schedule turned on" : "Schedule turned off"),
    onError: (e) => toast(errText(e), "error"),
  });
  const delSchedule = useMutation({
    mutationFn: (id: string) => builderApi.deleteSchedule(agent.id, id),
    onSuccess: () => applied(undefined, "Schedule removed"),
    onError: (e) => toast(errText(e), "error"),
  });

  // ---- sub-agents
  const [subOpen, setSubOpen] = useState(false);
  const closeSub = useCallback(() => setSubOpen(false), []);
  const putSubs = useMutation({
    mutationFn: (subs: Array<{ childId: string; name: string; description: string }>) => builderApi.putSubagents(agent.id, subs),
    onSuccess: (res) => {
      setSubOpen(false);
      applied(res, "Sub-agents saved");
    },
  });
  const currentSubs = agent.subagents.map((x) => ({ childId: x.childId, name: x.name, description: x.description }));

  // ---- advanced
  const [codeOpen, setCodeOpen] = useState(false);
  const closeCode = useCallback(() => setCodeOpen(false), []);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const del = useMutation({
    mutationFn: () => builderApi.deleteAgent(agent.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: bk.agents });
      toast(`Deleted ${agent.name}`, "success");
      navigate("/builder/agents");
    },
    onError: (e) => toast(errText(e), "error"),
  });
  const exportAgent = async () => {
    try {
      const { bundle } = await builderApi.exportAgent(agent.id);
      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = bundleFileName(agent.name);
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast("Export downloaded", "success");
    } catch (e) {
      toast(errText(e), "error");
    }
  };

  // the radio answers at once; a refused change snaps back to what the server holds
  const [sharing, setSharingDraft] = useState<BuilderSharing>(agent.sharing);
  useEffect(() => setSharingDraft(agent.sharing), [agent.sharing]);
  const setSharing = (next: BuilderSharing) => {
    setSharingDraft(next);
    patch.mutate(
      { body: { sharing: next }, msg: next === "private" ? "Only you can use this agent now" : next === "workspace" ? "Shared with the workspace" : "Shared with specific people" },
      { onError: () => setSharingDraft(agent.sharing) },
    );
  };
  const people = (directory.data?.users ?? []).filter((u) => u.id !== agent.ownerUserId && !agent.sharedUserIds.includes(u.id));
  const state = spendState(agent.spentThisMonthUsd, agent.monthlyLimitUsd);
  const detailsDirty = name.trim() !== agent.name || description.trim() !== (agent.description ?? "");

  return (
    <aside aria-label="Configure agent" className={`${s.glass} ${s.panel}`}>
      <div className={s.panelHead}>
        <AgentAvatar name={agent.name} color={agent.color} size={36} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className={s.subhead}>Configure</div>
          <div className={s.small}>{ro ? "View only — the owner or an admin can change this agent." : "Changes save as you make them."}</div>
        </div>
      </div>

      <Section title="Details" icon={Icon.sliders()} defaultOpen={false}>
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} disabled={ro} />
        </Field>
        <Field label="Description">
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} maxLength={500} disabled={ro} />
        </Field>
        <div>
          <div className={s.subhead} id="colour-label" style={{ marginBottom: 6 }}>
            Colour
          </div>
          <div role="radiogroup" aria-labelledby="colour-label" className={s.swatches}>
            {AGENT_COLORS.map((c, i) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={agent.color.toLowerCase() === c}
                aria-label={`Colour ${i + 1}`}
                className={s.swatch}
                style={{ background: c }}
                disabled={ro}
                onClick={() => patch.mutate({ body: { color: c }, msg: "Colour saved" })}
              />
            ))}
          </div>
        </div>
        <div>
          <Button size="sm" variant="primary" disabled={ro || !detailsDirty || !name.trim() || patch.isPending} onClick={() => patch.mutate({ body: { name: name.trim(), description: description.trim() }, msg: "Details saved" })}>
            Save details
          </Button>
        </div>
      </Section>

      <Section title="Channels" icon={Icon.chat()} count={agent.channels.length || undefined}>
        <p className={s.small} style={{ margin: 0 }}>
          Choose where people can reach this agent. A channel uses one of the workspace's chat connections. In Slack and Teams, people whose chat account an admin has linked can mention the agent and get a reply in the thread; it runs with their own access, and anything needing a confirmation is finished here in RegulAIt. Email is send-only.
        </p>
        <ChannelRows agent={agent} disabled={ro} />
      </Section>

      <Section title="Sharing" icon={Icon.globe()}>
        <Segmented
          label="Who can use this agent"
          value={sharing}
          onChange={setSharing}
          disabled={ro || patch.isPending}
          options={[
            { value: "private", label: <>{Icon.lock(13)} Private</> },
            { value: "workspace", label: "Workspace" },
            { value: "people", label: "Specific people" },
          ]}
        />
        <p className={s.small} style={{ margin: 0 }}>
          {sharing === "private"
            ? "Only you (and admins) can see and use it."
            : sharing === "workspace"
              ? "Everyone in the workspace can use it. Each person's own access still applies."
              : "Only the people below can use it. Each person's own access still applies."}
        </p>
        {sharing === "people" && (
          <>
            {agent.sharedUsers.length > 0 && (
              <div className={s.list}>
                {agent.sharedUsers.map((u) => (
                  <div key={u.id} className={s.listRow}>
                    <span className={s.listRowMain}>
                      <span className={s.listRowTitle}>{u.name}</span>
                    </span>
                    <button
                      type="button"
                      className={s.iconBtn}
                      aria-label={`Stop sharing with ${u.name}`}
                      disabled={ro}
                      onClick={() => patch.mutate({ body: { sharing: "people", sharedUserIds: agent.sharedUserIds.filter((x) => x !== u.id) }, msg: `Stopped sharing with ${u.name}` })}
                    >
                      {Icon.close(14)}
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className={s.toolbar} style={{ margin: 0 }}>
              <Select aria-label="Person to share with" value={person} onChange={(e) => setPerson(e.target.value)} disabled={ro} style={{ flex: 1 }}>
                <option value="">Choose a person</option>
                {people.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name ?? u.id}
                  </option>
                ))}
              </Select>
              <Button
                size="sm"
                disabled={ro || !person}
                onClick={() => {
                  const who = people.find((u) => u.id === person);
                  patch.mutate({ body: { sharing: "people", sharedUserIds: [...agent.sharedUserIds, person] }, msg: `Shared with ${who?.name ?? "them"}` });
                  setPerson("");
                }}
              >
                Add
              </Button>
            </div>
          </>
        )}
      </Section>

      <Section title="Connections" icon={Icon.link()} count={agent.tools.length || undefined}>
        <div className={s.list}>
          <div className={s.listRow}>
            <span className={s.choiceIcon}>{agent.connectionFormat === "shared" ? Icon.users() : Icon.user()}</span>
            <span className={s.listRowMain}>
              <span className={s.listRowTitle}>{agent.connectionFormat === "shared" ? "Shared" : "Per person"}</span>
              <span className={s.listRowSub}>{agent.connectionFormat === "shared" ? "Everyone uses the connections below." : "Each person uses their own connected accounts."}</span>
            </span>
            <Badge>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                {Icon.lock(12)} Locked
              </span>
            </Badge>
          </div>
        </div>
        <div className={s.subhead}>Toolbox</div>
        {agent.tools.length > 0 ? (
          <ul className={s.list} aria-label="Toolbox" style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {agent.tools.map((t) => (
              <li key={`${t.kind}|${t.refId}`} className={s.listRow}>
                <ToolLogo tool={t} />
                <span className={s.listRowMain}>
                  <span className={s.listRowTitle}>
                    {t.name}
                    {!t.entitledForYou && <Badge tone="warn">Not available to you</Badge>}
                  </span>
                  <span className={s.listRowSub}>
                    {t.kind === "connector" ? "Connector" : "MCP tool"}
                    {t.provider ? ` · ${t.provider}` : ""}
                  </span>
                </span>
                <label className={s.small} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                  Ask first
                  <Switch
                    checked={t.requiresApproval}
                    label={`Ask before ${t.name} runs`}
                    disabled={ro || putTools.isPending}
                    onChange={(v) => putTools.mutate(agent.tools.map((x) => (x.kind === t.kind && x.refId === t.refId ? { ...x, requiresApproval: v } : x)))}
                  />
                </label>
                <button
                  type="button"
                  className={s.iconBtn}
                  aria-label={`Remove ${t.name}`}
                  disabled={ro || putTools.isPending}
                  onClick={() => putTools.mutate(agent.tools.filter((x) => !(x.kind === t.kind && x.refId === t.refId)))}
                >
                  {Icon.trash()}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className={s.small} style={{ margin: 0 }}>
            No connections yet. Add one to give the agent tools it can use — like a ticketing system or a document store.
          </p>
        )}
        <button type="button" className={s.addRow} disabled={ro} onClick={() => setConnOpen(true)}>
          {Icon.plus(14)} Add connection
        </button>
        <p className={s.small} style={{ margin: 0 }}>
          The agent calls these tools on its own during a conversation. Every call runs as the person chatting, with their own access and your
          organisation's policies; a connection marked Ask first waits for that person to approve the exact call, and organisation approval rules
          still apply.
        </p>
      </Section>

      <Section title="Knowledge" icon={Icon.book()}>
        <Field label="Instructions" error={instructions.length > 20000 ? "Use 20,000 characters or fewer" : null}>
          <Textarea className={s.bodyEditor} style={{ minHeight: 200 }} value={instructions} onChange={(e) => setInstructions(e.target.value)} disabled={ro} placeholder="What the agent is for, how it should behave, and what it must never do." />
        </Field>
        <div className={s.toolbar} style={{ margin: 0 }}>
          <Button
            size="sm"
            variant="primary"
            disabled={ro || instructions === agent.instructions || instructions.length > 20000 || patch.isPending}
            onClick={() => patch.mutate({ body: { instructions }, msg: "Instructions saved" })}
          >
            Save instructions
          </Button>
          {instructions !== agent.instructions && <span className={s.small}>Unsaved changes</span>}
        </div>
        <div className={s.subhead}>Skills</div>
        {agent.skills.length > 0 && (
          <ul className={s.list} aria-label="Attached skills" style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {agent.skills.map((k) => (
              <li key={k.id} className={s.listRow}>
                <span className={s.sectionIcon}>{Icon.spark(15)}</span>
                <span className={s.listRowMain}>
                  <span className={s.listRowTitle}>
                    {k.pinnedName ?? k.name}
                    {k.withheld ? (
                      <Badge tone="warn">{skillWithheldCopy(k.withheld).badge}</Badge>
                    ) : k.unavailable ? (
                      <Badge tone="warn">No longer shared</Badge>
                    ) : k.updateAvailable ? (
                      <Badge tone="info">Update available</Badge>
                    ) : null}
                    {k.withheldFromOthers && !k.withheld && !k.unavailable ? (
                      <Badge tone="info">{skillPrivateOnSharedAgentCopy(!!k.visibilityRequested).badge}</Badge>
                    ) : null}
                  </span>
                  <span className={`${s.listRowSub} ${s.clamp2}`}>
                    {k.withheld
                      ? skillWithheldCopy(k.withheld).sub
                      : k.unavailable
                      ? "Its author stopped sharing it, so the agent no longer uses it."
                      : k.updateAvailable
                        ? "The library copy changed. The agent keeps the version it has until you take the new one."
                        : k.withheldFromOthers
                          ? skillPrivateOnSharedAgentCopy(!!k.visibilityRequested).sub
                          : k.description}
                  </span>
                </span>
                {k.updateAvailable && !k.unavailable && (
                  <Button size="sm" aria-label={`Take the new version of ${k.name}`} disabled={ro || reattach.isPending} onClick={() => reattach.mutate(k.id)}>
                    Update
                  </Button>
                )}
                <button
                  type="button"
                  className={s.iconBtn}
                  aria-label={`Remove skill ${k.name}`}
                  disabled={ro || putSkills.isPending}
                  onClick={() => putSkills.mutate(agent.skills.filter((x) => x.id !== k.id).map((x) => x.id))}
                >
                  {Icon.close(14)}
                </button>
              </li>
            ))}
          </ul>
        )}
        <button type="button" className={s.addRow} disabled={ro} onClick={props.onOpenSkills}>
          {Icon.plus(14)} Add skill
        </button>
      </Section>

      <Section title="Memory" icon={Icon.brain()} count={agent.memory.length || undefined}>
        <p className={s.small} style={{ margin: 0 }}>
          Lasting facts and preferences the agent is given in every conversation (the newest 20; an agent keeps up to 500).
        </p>
        {agent.memory.length > 0 && (
          <ul className={s.list} aria-label="Memory" style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {agent.memory.map((m) => (
              <li key={m.id} className={s.listRow}>
                <span className={s.listRowMain}>
                  <span className={s.listRowTitle} style={{ fontWeight: 500 }}>
                    {m.content}
                  </span>
                  <span className={s.listRowSub}>
                    {m.createdByName ?? "Someone"} · {ago(m.createdAt)}
                  </span>
                </span>
                <button type="button" className={s.iconBtn} aria-label="Remove from memory" disabled={ro || delMemory.isPending} onClick={() => delMemory.mutate(m.id)}>
                  {Icon.trash()}
                </button>
              </li>
            ))}
          </ul>
        )}
        <Field label="Something to remember">
          <Textarea value={memory} onChange={(e) => setMemory(e.target.value)} rows={2} maxLength={2000} disabled={ro} placeholder="e.g. Our review board meets on Thursdays." />
        </Field>
        <div>
          <Button size="sm" disabled={ro || !memory.trim() || addMemory.isPending} onClick={() => addMemory.mutate(memory.trim())}>
            Add to memory
          </Button>
        </div>
      </Section>

      <Section title="Schedules" icon={Icon.clock()} count={agent.schedules.length || undefined}>
        {agent.schedules.length > 0 ? (
          <ul className={s.list} aria-label="Schedules" style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {agent.schedules.map((sc) => (
              <li key={sc.id} className={s.listRow}>
                <span className={s.listRowMain}>
                  <span className={s.listRowTitle}>
                    {sc.name}
                    {sc.awaitingOwner ? <Badge tone="warn">Waiting for the owner</Badge> : !sc.enabled && <Badge>Off</Badge>}
                  </span>
                  <span className={s.listRowSub}>
                    {scheduleSummary(sc.cadence, sc.timeUtc)}
                    {sc.enabled
                      ? sc.nextRunAt
                        ? ` · next ${new Date(sc.nextRunAt).toLocaleString()}`
                        : ""
                      : sc.awaitingOwner
                        ? // it runs, and spends, as the owner — so only the owner switches it on
                          ` · changed by ${sc.lastEditedByName ?? "someone else"}; only the owner can turn it on`
                        : isOwner
                          ? // template- and import-seeded schedules start off: nothing spends until the owner says so
                            " · turn it on to start running"
                          : " · only the owner can turn it on"}
                  </span>
                </span>
                <Switch
                  checked={sc.enabled}
                  label={`${sc.name} on`}
                  disabled={ro || toggleSchedule.isPending || (!isOwner && !sc.enabled)}
                  onChange={(v) => toggleSchedule.mutate({ id: sc.id, enabled: v })}
                />
                <button type="button" className={s.iconBtn} aria-label={`Remove schedule ${sc.name}`} disabled={ro || delSchedule.isPending} onClick={() => delSchedule.mutate(sc.id)}>
                  {Icon.trash()}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className={s.small} style={{ margin: 0 }}>
            Run the agent automatically on a regular schedule. Each run uses the owner's access and lands in their inbox, so only the owner can turn a schedule on.
          </p>
        )}
        <button type="button" className={s.addRow} disabled={ro} onClick={() => setSchedOpen(true)}>
          {Icon.plus(14)} New schedule
        </button>
      </Section>

      <Section title="Sub-agents" icon={Icon.tree()} count={agent.subagents.length || undefined} defaultOpen={false}>
        {agent.subagents.length > 0 ? (
          <ul className={s.list} aria-label="Sub-agents" style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {agent.subagents.map((x) => (
              <li key={x.childId} className={s.listRow}>
                <AgentAvatar name={x.childName} color={null} size={26} />
                <span className={s.listRowMain}>
                  <span className={s.listRowTitle}>{x.name}</span>
                  <span className={`${s.listRowSub} ${s.clamp2}`}>
                    {x.childName} · {x.description}
                  </span>
                </span>
                <button
                  type="button"
                  className={s.iconBtn}
                  aria-label={`Remove sub-agent ${x.name}`}
                  disabled={ro || putSubs.isPending}
                  onClick={() => putSubs.mutate(currentSubs.filter((c) => c.childId !== x.childId), { onError: (e) => toast(errText(e), "error") })}
                >
                  {Icon.trash()}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className={s.small} style={{ margin: 0 }}>
            Hand focused work to another agent — for example, a dedicated evidence collector.
          </p>
        )}
        <button type="button" className={s.addRow} disabled={ro} onClick={() => setSubOpen(true)}>
          {Icon.plus(14)} New sub-agent
        </button>
      </Section>

      {/* ADR-0180 A8 — the steward's view: only the owner or an admin may read it */}
      {!ro && (
        <Section title="Autonomy" icon={Icon.check()} defaultOpen={false}>
          <AutonomyPanel agent={agent} />
          <ExecutionProfileSelector context="agent" />
        </Section>
      )}

      <Section title="Advanced" icon={Icon.shield()} defaultOpen={false}>
        <ModelPicker
          label="Model"
          agents={modelTiles}
          value={agent.modelAgent?.id ?? ""}
          onChange={(id) => id !== agent.modelAgent?.id && patch.mutate({ body: { modelAgentId: id }, msg: "Model saved" })}
          placeholder="Your default model"
          {...(ro ? { disabledReason: "Only the owner or an admin can change the model." } : {})}
          testId="agent-model"
          feature="builder"
        />
        <Field label="Bill spend to project">
          <Select
            value={agent.project?.id ?? ""}
            disabled={ro || patch.isPending}
            onChange={(e) => {
              const next = e.target.value;
              // owner rule: a project can be changed, never cleared
              if (!next || next === agent.project?.id) return;
              const label = projectOptions.find((p) => p.id === next)?.name;
              patch.mutate({ body: { projectId: next }, msg: `Spend now bills to ${label ?? "the project"}` });
            }}
          >
            {!agent.project && (
              <option value="" disabled>
                Choose a project
              </option>
            )}
            {projectOptions.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>
        <p className={s.small} style={{ margin: 0 }}>
          Every agent bills to a project: its replies and tool calls count toward that project&apos;s spend and budget. You can choose projects you&apos;re a member of; people who chat with it must be members too.
        </p>
        <Field label="Monthly spend limit (USD)" error={limitErr}>
          <Input inputMode="decimal" value={limit} onChange={(e) => setLimit(e.target.value)} placeholder="No limit" disabled={ro} />
        </Field>
        <div className={s.spendRow}>
          <span>Spent this month</span>
          <span>
            {fmtUsd(agent.spentThisMonthUsd)}
            {agent.monthlyLimitUsd != null ? ` of ${fmtUsd(agent.monthlyLimitUsd)}` : ""}
          </span>
        </div>
        {agent.monthlyLimitUsd != null && <Meter value={agent.spentThisMonthUsd} max={agent.monthlyLimitUsd} warn={state === "warn"} over={state === "over"} label="Spend against the monthly limit" />}
        <div>
          <Button
            size="sm"
            disabled={ro || patch.isPending}
            onClick={() => {
              const parsed = parseLimitInput(limit);
              if (!parsed.ok) {
                setLimitErr(parsed.error);
                return;
              }
              setLimitErr(null);
              patch.mutate({ body: { monthlyLimitUsd: parsed.value }, msg: parsed.value == null ? "Spend limit removed" : "Spend limit saved" });
            }}
          >
            Save limit
          </Button>
        </div>
        <p className={s.small} style={{ margin: 0 }}>
          When the limit is reached, the agent stops answering until next month. Your own budgets apply as well.
        </p>
        <div className={s.listRow} style={{ padding: 0 }}>
          <span className={s.listRowMain}>
            <span className={s.listRowTitle}>Use a computer</span>
            <span className={s.listRowSub}>Recorded for this agent. A secure computer isn't available in this workspace yet.</span>
          </span>
          <Switch checked={agent.computerUse} label="Use a computer" disabled={ro || patch.isPending} onChange={(v) => patch.mutate({ body: { computerUse: v }, msg: v ? "Computer use recorded" : "Computer use turned off" })} />
        </div>
        <div className={s.subhead}>Developer</div>
        <div className={s.toolbar} style={{ margin: 0 }}>
          <Button size="sm" onClick={() => setCodeOpen(true)}>
            {Icon.code(14)} Use in code
          </Button>
          {/* export carries the instructions and skill bodies: an editor act */}
          {!ro && (
            <Button size="sm" onClick={() => void exportAgent()}>
              {Icon.download(14)} Export
            </Button>
          )}
        </div>
        {!ro && (
          <div className={s.danger}>
            <p className={s.dangerTitle}>Delete agent</p>
            <p className={s.small} style={{ margin: 0 }}>
              Removes the agent with its memory, schedules and channels. Its history stays in the audit log.
            </p>
            <div>
              <Button size="sm" variant="danger" onClick={() => setConfirmDelete(true)}>
                {Icon.trash(14)} Delete agent
              </Button>
            </div>
          </div>
        )}
      </Section>

      <AddConnectionDialog open={connOpen} onClose={closeConn} agent={agent} onAdd={addTool} busyRef={addingRef} />
      <AddSkillDialog open={props.skillsOpen} onClose={props.onCloseSkills} agent={agent} onSave={(ids) => putSkills.mutate(ids)} busy={putSkills.isPending} />
      <NewScheduleDialog
        open={schedOpen}
        onClose={closeSched}
        onCreate={(b) => addSchedule.mutate(b)}
        busy={addSchedule.isPending}
        error={addSchedule.error ? errText(addSchedule.error) : null}
      />
      <NewSubagentDialog
        open={subOpen}
        onClose={closeSub}
        agent={agent}
        candidates={allAgents.data?.agents ?? []}
        onCreate={(x) => putSubs.mutate([...currentSubs, x])}
        busy={putSubs.isPending}
        error={putSubs.error ? errText(putSubs.error) : null}
      />
      <CodeDialog open={codeOpen} onClose={closeCode} agentId={agent.id} />
      <ConfirmModal
        open={confirmDelete}
        title={`Delete ${agent.name}?`}
        body="People it's shared with lose access, and its schedules stop. This can't be undone here."
        confirmLabel="Delete agent"
        danger
        onConfirm={() => {
          setConfirmDelete(false);
          del.mutate();
        }}
        onCancel={() => setConfirmDelete(false)}
      />
    </aside>
  );
}
