/**
 * ADR-0172 — the agent editor's dialogs: add connection, add skill, new
 * schedule, new sub-agent, and use in code.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQueries, useQuery } from "@tanstack/react-query";
import type { BuilderAgentDetail, BuilderAgentSummary, BuilderCadence } from "../../api/types";
import { useSession } from "../../session/SessionContext";
import { Button, EmptyState, ErrorState, Field, Input, Modal, Select, SkeletonBlock, Textarea } from "../../ui/kit";
import { bk, builderApi, mcpToolRefId, myConnectors, myServerTools, type ScheduleBody } from "./builderApi";
import { CADENCES, codeSnippets, isValidTimeUtc, localTime, scheduleSummary } from "./builderLogic";
import { CodeTabs, CopyButton, Icon, Segmented, Switch, ToolLogo } from "./BuilderUi";
import s from "./builder.module.css";

// ---- add connection ---------------------------------------------------------

export interface ToolCandidate {
  kind: "connector" | "mcp_tool";
  refId: string;
  name: string;
  provider: string | null;
  sub: string;
  defaultApproval: boolean;
}

type ToolFilter = "all" | "connector" | "mcp_tool";

/**
 * Lists only what the EDITOR holds a grant for: their connectors, and the MCP
 * tools each server shows them. The server re-checks every one on save.
 */
export function AddConnectionDialog(props: {
  open: boolean;
  onClose: () => void;
  agent: BuilderAgentDetail;
  onAdd: (c: ToolCandidate) => void;
  busyRef: string | null;
}) {
  const { auth } = useSession();
  const userId = props.open ? (auth?.userId ?? null) : null;
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ToolFilter>("all");
  useEffect(() => {
    if (props.open) {
      setQuery("");
      setFilter("all");
    }
  }, [props.open]);

  const connectors = useQuery({ queryKey: ["builder", "my-connectors", userId], queryFn: () => myConnectors(userId!), enabled: !!userId });
  const integrations = useQuery({ queryKey: bk.integrations, queryFn: builderApi.integrations, enabled: props.open });
  const servers = integrations.data?.custom.mcpServers ?? [];
  const serverTools = useQueries({
    queries: servers.map((sv) => ({
      queryKey: ["builder", "my-server-tools", userId, sv.id],
      queryFn: () => myServerTools(userId!, sv.id),
      enabled: !!userId,
    })),
  });

  const candidates = useMemo<ToolCandidate[]>(() => {
    const out: ToolCandidate[] = [];
    for (const c of connectors.data?.connectors ?? []) {
      if (c.revoked) continue;
      out.push({ kind: "connector", refId: c.connectorId, name: c.name, provider: c.kind, sub: `Connector · ${c.kind}`, defaultApproval: false });
    }
    servers.forEach((sv, i) => {
      for (const t of serverTools[i]?.data?.tools ?? []) {
        out.push({
          kind: "mcp_tool",
          refId: mcpToolRefId(sv.id, t.name),
          name: t.name,
          provider: sv.name,
          sub: `${sv.name} · ${t.kind === "write" ? "can make changes" : "read only"}`,
          defaultApproval: t.kind === "write",
        });
      }
    });
    return out;
  }, [connectors.data, servers, serverTools]);

  const q = query.trim().toLowerCase();
  const shown = candidates.filter((c) => (filter === "all" || c.kind === filter) && (!q || `${c.name} ${c.sub}`.toLowerCase().includes(q)));
  const added = new Set(props.agent.tools.map((t) => `${t.kind}|${t.refId}`));
  const loading = connectors.isLoading || integrations.isLoading || serverTools.some((x) => x.isLoading);
  const failed = connectors.error ?? integrations.error;
  const count = (k: ToolFilter) => candidates.filter((c) => k === "all" || c.kind === k).length;

  return (
    <Modal open={props.open} title="Add connection" onClose={props.onClose} wide actions={<Button onClick={props.onClose}>Done</Button>}>
      <div className={s.pickerLayout}>
        <nav aria-label="Connection types" className={s.pickerNav}>
          <Input type="search" aria-label="Search connections" placeholder="Search" value={query} onChange={(e) => setQuery(e.target.value)} style={{ marginBottom: 8 }} />
          {(
            [
              ["all", "All"],
              ["connector", "Connectors"],
              ["mcp_tool", "MCP tools"],
            ] as Array<[ToolFilter, string]>
          ).map(([id, label]) => (
            <button key={id} type="button" className={s.navItem} aria-pressed={filter === id} onClick={() => setFilter(id)}>
              {label}
              <span className={s.navCount}>{count(id)}</span>
            </button>
          ))}
          <div style={{ marginTop: "auto", paddingTop: 16 }}>
            <Link className={s.helpLink} to="/admin/mcp-servers">
              Add a custom MCP server
            </Link>
          </div>
        </nav>
        <div>
          <p className={s.muted} style={{ marginTop: 0 }}>
            Only connections you have access to are listed. Each person's own access is checked again whenever the agent runs.
          </p>
          {loading ? (
            <SkeletonBlock lines={4} />
          ) : failed ? (
            <ErrorState title="Couldn't load your connections" message={(failed as Error).message} onRetry={() => void connectors.refetch()} />
          ) : shown.length === 0 ? (
            <EmptyState
              title={candidates.length === 0 ? "No connections available to you" : "No matching connections"}
              body={candidates.length === 0 ? "Ask an administrator to grant you a connector or MCP tool, then add it here." : "Try a different search."}
            />
          ) : (
            <ul className={s.catalogGrid} aria-label="Available connections" style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {shown.map((c) => {
                const isAdded = added.has(`${c.kind}|${c.refId}`);
                return (
                  <li key={`${c.kind}|${c.refId}`} className={s.catalogCard}>
                    <ToolLogo tool={c} size={24} />
                    <span className={s.catalogMain}>
                      <span className={s.catalogName}>{c.name}</span>
                      <span className={s.catalogDesc}>{c.sub}</span>
                    </span>
                    <Button size="sm" disabled={isAdded || props.busyRef !== null} aria-label={isAdded ? `${c.name} added` : `Add ${c.name}`} onClick={() => props.onAdd(c)}>
                      {isAdded ? "Added" : props.busyRef === c.refId ? "Adding…" : <>{Icon.plus(14)} Add</>}
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </Modal>
  );
}

// ---- add skill ---------------------------------------------------------------

export function AddSkillDialog(props: { open: boolean; onClose: () => void; agent: BuilderAgentDetail; onSave: (ids: string[]) => void; busy: boolean }) {
  const skills = useQuery({ queryKey: bk.skills, queryFn: builderApi.listSkills, enabled: props.open });
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  useEffect(() => {
    if (props.open) {
      setPicked(new Set(props.agent.skills.map((x) => x.id)));
      setQuery("");
    }
  }, [props.open, props.agent.skills]);
  const q = query.trim().toLowerCase();
  const list = (skills.data?.skills ?? []).filter((k) => !q || `${k.name} ${k.description}`.toLowerCase().includes(q));
  return (
    <Modal
      open={props.open}
      title="Add skills"
      onClose={props.onClose}
      wide
      actions={
        <>
          <Button onClick={props.onClose}>Cancel</Button>
          <Button variant="primary" disabled={props.busy} onClick={() => props.onSave([...picked])}>
            {props.busy ? "Saving…" : "Save skills"}
          </Button>
        </>
      }
    >
      <p className={s.muted} style={{ marginTop: 0 }}>
        Skills are packaged instructions the agent reads when a task calls for them.{" "}
        <Link className={s.helpLink} to="/builder/skills?new=1">
          Create a skill
        </Link>
      </p>
      <Input type="search" aria-label="Search skills" placeholder="Search skills" value={query} onChange={(e) => setQuery(e.target.value)} style={{ marginBottom: 12 }} />
      {skills.isLoading ? (
        <SkeletonBlock lines={3} />
      ) : skills.isError ? (
        <ErrorState title="Couldn't load skills" message={(skills.error as Error).message} onRetry={() => void skills.refetch()} />
      ) : list.length === 0 ? (
        <EmptyState title="No skills in the library yet" body="Create one, or import a SKILL.md file, on the Skills page." />
      ) : (
        <ul className={s.catalogGrid} style={{ listStyle: "none", margin: 0, padding: 0 }} aria-label="Skill library">
          {list.map((k) => (
            <li key={k.id}>
              <label className={s.catalogCard} style={{ cursor: "pointer", alignItems: "flex-start" }}>
                <input
                  type="checkbox"
                  checked={picked.has(k.id)}
                  onChange={(e) =>
                    setPicked((prev) => {
                      const next = new Set(prev);
                      if (e.target.checked) next.add(k.id);
                      else next.delete(k.id);
                      return next;
                    })
                  }
                  style={{ marginTop: 3, accentColor: "var(--rg-signal-700)" }}
                />
                <span className={s.catalogMain}>
                  <span className={s.catalogName}>{k.name}</span>
                  <span className={`${s.catalogDesc} ${s.clamp2}`}>{k.description}</span>
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

// ---- new schedule -----------------------------------------------------------

export function NewScheduleDialog(props: { open: boolean; onClose: () => void; onCreate: (body: ScheduleBody) => void; busy: boolean; error: string | null }) {
  const [name, setName] = useState("");
  const [cadence, setCadence] = useState<BuilderCadence>("weekdays");
  const [time, setTime] = useState("09:00");
  const [prompt, setPrompt] = useState("");
  const [enabled, setEnabled] = useState(true);
  useEffect(() => {
    if (props.open) {
      setName("");
      setCadence("weekdays");
      setTime("09:00");
      setPrompt("");
      setEnabled(true);
    }
  }, [props.open]);
  const valid = name.trim().length > 0 && isValidTimeUtc(time) && prompt.trim().length > 0 && prompt.length <= 4000;
  const local = localTime(time);
  const submit = () => valid && props.onCreate({ name: name.trim(), cadence, timeUtc: time, prompt: prompt.trim(), enabled });
  return (
    <Modal
      open={props.open}
      title="New schedule"
      onClose={props.onClose}
      actions={
        <>
          <Button onClick={props.onClose}>Cancel</Button>
          <Button variant="primary" disabled={!valid || props.busy} onClick={submit}>
            {props.busy ? "Adding…" : "Add schedule"}
          </Button>
        </>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 16, color: "var(--rg-ink)" }}>
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Morning intake sweep" maxLength={120} />
        </Field>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span className={s.subhead} id="cadence-label">
            How often
          </span>
          <Segmented label="How often" value={cadence} onChange={setCadence} options={CADENCES.map((c) => ({ value: c.id, label: c.label }))} />
        </div>
        <Field label={cadence === "hourly" ? "Minute past the hour (UTC)" : "Time (UTC)"}>
          <Input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
        </Field>
        <p className={s.small} style={{ margin: "-8px 0 0" }}>
          {isValidTimeUtc(time) ? `${scheduleSummary(cadence, time)}${cadence !== "hourly" && local ? ` — ${local} your time` : ""}.` : "Enter a time as hours and minutes."} Runs use the
          agent owner's access and land in their inbox.
        </p>
        <Field label="What should the agent do?">
          <Textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={4} placeholder="e.g. Review intake requests submitted since yesterday and list any missing details." />
        </Field>
        <label style={{ display: "flex", alignItems: "center", gap: 10, fontSize: "var(--text-sm)" }}>
          <Switch checked={enabled} onChange={setEnabled} label="Turn on now" />
          Turn on now
        </label>
        {props.error && (
          <p role="alert" style={{ margin: 0, color: "var(--danger)", fontSize: "var(--text-sm)" }}>
            {props.error}
          </p>
        )}
      </div>
    </Modal>
  );
}

// ---- new sub-agent ----------------------------------------------------------

export function NewSubagentDialog(props: {
  open: boolean;
  onClose: () => void;
  agent: BuilderAgentDetail;
  candidates: BuilderAgentSummary[];
  onCreate: (sub: { childId: string; name: string; description: string }) => void;
  busy: boolean;
  error: string | null;
}) {
  const options = props.candidates.filter((c) => c.id !== props.agent.id && !props.agent.subagents.some((x) => x.childId === c.id));
  const [childId, setChildId] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  useEffect(() => {
    if (props.open) {
      setChildId("");
      setName("");
      setDescription("");
    }
  }, [props.open]);
  const valid = !!childId && name.trim().length > 0 && description.trim().length > 0;
  return (
    <Modal
      open={props.open}
      title="New sub-agent"
      onClose={props.onClose}
      actions={
        <>
          <Button onClick={props.onClose}>Cancel</Button>
          <Button variant="primary" disabled={!valid || props.busy} onClick={() => props.onCreate({ childId, name: name.trim(), description: description.trim() })}>
            {props.busy ? "Adding…" : "Add sub-agent"}
          </Button>
        </>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 16, color: "var(--rg-ink)" }}>
        <p className={s.muted} style={{ margin: 0 }}>
          A sub-agent is another agent this one hands focused work to. It keeps its own instructions and tools, and never gets more access than the person using it.
        </p>
        <Field label="Agent to hand work to">
          <Select
            value={childId}
            onChange={(e) => {
              setChildId(e.target.value);
              const picked = options.find((o) => o.id === e.target.value);
              if (picked && !name) setName(picked.name);
              if (picked && !description && picked.description) setDescription(picked.description);
            }}
          >
            <option value="">Choose an agent</option>
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </Select>
        </Field>
        {options.length === 0 && <p className={s.small} style={{ margin: 0 }}>No other agents are available. Create another agent first.</p>}
        <Field label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Evidence collector" maxLength={80} />
        </Field>
        <Field label="When should it be used?">
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} placeholder="e.g. Gathers the documents a control needs as evidence." />
        </Field>
        {props.error && (
          <p role="alert" style={{ margin: 0, color: "var(--danger)", fontSize: "var(--text-sm)" }}>
            {props.error}
          </p>
        )}
      </div>
    </Modal>
  );
}

// ---- use in code -------------------------------------------------------------

export function CodeDialog(props: { open: boolean; onClose: () => void; agentId: string }) {
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const snip = codeSnippets(props.agentId, origin);
  const url = `${origin}/v1/builder/agents/${props.agentId}/chat`;
  const onClose = props.onClose;
  const close = useCallback(() => onClose(), [onClose]);
  return (
    <Modal open={props.open} title="Use this agent in code" onClose={close} wide actions={<Button onClick={close}>Close</Button>}>
      <div style={{ display: "flex", flexDirection: "column", gap: 14, color: "var(--rg-ink)" }}>
        <p className={s.muted} style={{ margin: 0 }}>
          Call the agent from your own code with an API key. Replies run with the key owner's access, budgets and guardrails — exactly as in chat.
        </p>
        <div className={s.list}>
          <div className={s.listRow}>
            <span className={s.listRowMain}>
              <span className={s.listRowSub}>Agent ID</span>
              <span className={s.mono}>{props.agentId}</span>
            </span>
            <CopyButton text={props.agentId} label="Copy agent ID" />
          </div>
          <div className={s.listRow}>
            <span className={s.listRowMain}>
              <span className={s.listRowSub}>Endpoint</span>
              <span className={s.mono} style={{ overflowWrap: "anywhere" }}>
                POST {url}
              </span>
            </span>
            <CopyButton text={url} label="Copy endpoint" />
          </div>
        </div>
        <CodeTabs
          snippets={[
            { id: "curl", label: "cURL", code: snip.curl },
            { id: "ts", label: "TypeScript", code: snip.typescript },
            { id: "py", label: "Python", code: snip.python },
          ]}
        />
        <p className={s.small} style={{ margin: 0 }}>
          Use an API key an administrator issued to you, set as REGULAIT_API_KEY. Never paste a real key into shared code.
        </p>
      </div>
    </Modal>
  );
}
