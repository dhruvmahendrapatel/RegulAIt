/**
 * Execution control — the kill switch and safe modes (ADR-0124).
 *
 * THIS IS THE PAGE SOMEBODY OPENS WHEN SOMETHING IS GOING WRONG, and every
 * decision below follows from that.
 *
 *  - The CURRENT STATE IS THE HEADLINE. An operator arriving here is usually
 *    answering "is it stopped, and why?" — not browsing. That answer is the
 *    first thing on the page, in the largest thing on the page, with the
 *    reason and the clock beside it.
 *  - EVERY ACTION IS ONE CLICK FROM THE TOP, and every one of them opens a
 *    reason box before it does anything. The reason is required by the server
 *    and by the modal, in both directions: throwing a stop without saying why
 *    produces an outage of unknown cause, and lifting one without saying why
 *    destroys the record of why it was safe to resume.
 *  - IT SAYS WHAT KEEPS WORKING. The biggest risk with a kill switch is not
 *    that somebody throws it by accident; it is that somebody who should throw
 *    it hesitates. So the page states plainly that reading, discovery and the
 *    approvals queue survive a halt, and that nothing queued is destroyed.
 *  - IT SAYS WHAT IT CANNOT DO. `require_approval` genuinely behaves
 *    differently per path, and the mode card says so rather than leaving it to
 *    be discovered mid-incident.
 *
 * Deliberately a SEPARATE PAGE from the enforcement-posture screen. That one
 * answers "what is enforcing?" and is read at leisure; this one answers "what
 * is stopped?" and is read in a hurry. The posture page links here when the
 * deployment is restricted.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import { PageHeader } from "../../../shell/AppShell";
import { Badge, Button, Card, EmptyState, Field, Select, Table } from "../../../ui/kit";
import {
  QueryGate,
  ReasonModal,
  Stat,
  useAction,
  useAgents,
  useServerTools,
  useServers,
  useUsers,
} from "../adminKit";
import a from "../admin.module.css";
import v from "../../views.module.css";
import { api as stepUpApi, withStepUp } from "../../../stepup/stepUp";

type Mode = "normal" | "read_only" | "require_approval" | "halted";

interface HaltedAgent {
  id: string;
  name: string;
  haltedAt: string;
  reason: string | null;
}
interface HaltedTool {
  serverId: string;
  name: string;
  haltedAt: string;
  reason: string | null;
}
interface ExecutionState {
  mode: Mode;
  meaning: string;
  reason: string | null;
  setAt: string | null;
  setByUserId: string | null;
  haltedAgents: HaltedAgent[];
  haltedTools: HaltedTool[];
  summary: string;
  note: string;
  scheduledSweepsNote: string;
}

/**
 * The dial, in the order it degrades. `blastRadius` is what the operator is
 * actually choosing between, so it is on the button rather than in a tooltip.
 */
const MODES: Array<{
  mode: Mode;
  label: string;
  tone: "ok" | "warn" | "danger";
  blastRadius: string;
}> = [
  {
    mode: "normal",
    label: "Normal",
    tone: "ok",
    blastRadius:
      "Every governed call is decided by the ordinary rules. This is the correct steady state, including on a fully hardened deployment.",
  },
  {
    mode: "read_only",
    label: "Read-only",
    tone: "warn",
    blastRadius:
      "Reads keep being served; anything that writes is refused — a write MCP tool, a connector write, or a dispatch in a mutating mode. Plan, review, chat, ask and read still run.",
  },
  {
    mode: "require_approval",
    label: "Require approval",
    tone: "warn",
    blastRadius:
      "Nothing runs unattended. An MCP tool call or a connector write is QUEUED for the named approver; model dispatch and connector reads are REFUSED instead, because those paths have no per-call approval queue. Use read-only if reads should keep flowing.",
  },
  {
    mode: "halted",
    label: "Halt everything",
    tone: "danger",
    blastRadius:
      "Every governed call is refused. Nothing in flight is cancelled and nothing queued is destroyed — when you lift it, the queue is where you left it.",
  },
];

/** minimum the server also enforces, checked in the modal so a terse reason is
 * rejected while the box is still open rather than after the round trip */
const REASON_MIN = 10;

export default function ExecutionControlPage() {
  const act = useAction();
  const state = useQuery({
    queryKey: ["admin", "execution"],
    queryFn: () => api.get<ExecutionState>("/v1/execution"),
  });
  const agents = useAgents();
  const servers = useServers();
  const users = useUsers();

  /** which confirmation is open, if any */
  const [pending, setPending] = useState<
    | { kind: "mode"; mode: Mode }
    | { kind: "halt-agent"; agentId: string; label: string }
    | { kind: "unhalt-agent"; agentId: string; label: string }
    | { kind: "halt-tool"; serverId: string; toolName: string }
    | { kind: "unhalt-tool"; serverId: string; toolName: string }
    | null
  >(null);

  // the "stop something specific" picker
  const [agentPick, setAgentPick] = useState("");
  const [serverPick, setServerPick] = useState("");
  const [toolPick, setToolPick] = useState("");
  const tools = useServerTools(serverPick || null);

  const s = state.data;
  const restricted = s ? s.mode !== "normal" : false;
  const anythingStopped = restricted || (s?.haltedAgents.length ?? 0) > 0 || (s?.haltedTools.length ?? 0) > 0;

  const refresh = async () => {
    await state.refetch();
  };

  const confirm = (reason: string) => {
    const p = pending;
    setPending(null);
    if (!p) return;
    void act.run(async () => {
      if (p.kind === "mode") {
        await withStepUp((h) =>
          stepUpApi.put(
            "/v1/execution/mode",
            {
              mode: p.mode,
              reason,
              // require_approval must name who is attending — the server refuses
              // it otherwise, so the picker below is not optional decoration
              ...(p.mode === "require_approval" ? { approverUserId: approver } : {}),
            },
            h,
          ),
        );
      } else if (p.kind === "halt-agent") {
        await api.post(`/v1/agents/${p.agentId}/halt`, { reason });
      } else if (p.kind === "unhalt-agent") {
        await withStepUp((h) => stepUpApi.post(`/v1/agents/${p.agentId}/unhalt`, { reason }, h));
      } else if (p.kind === "halt-tool") {
        await api.post(
          `/v1/servers/${p.serverId}/tools/${encodeURIComponent(p.toolName)}/halt`,
          { reason },
        );
      } else {
        await withStepUp((h) =>
          stepUpApi.post(`/v1/servers/${p.serverId}/tools/${encodeURIComponent(p.toolName)}/unhalt`, { reason }, h),
        );
      }
      await refresh();
    }, "Recorded");
  };

  // require_approval needs an approver; reuse the agents' owner list is wrong,
  // so pick from users — kept simple: the current admin is the default target
  const [approver, setApprover] = useState("");

  const modalCopy = (): { title: string; body: string; danger: boolean; confirmLabel: string } => {
    const p = pending;
    if (!p) return { title: "", body: "", danger: false, confirmLabel: "Confirm" };
    if (p.kind === "mode") {
      const m = MODES.find((x) => x.mode === p.mode)!;
      return {
        title:
          p.mode === "normal" ? "Resume normal execution" : `Switch to ${m.label.toLowerCase()}`,
        body:
          p.mode === "normal"
            ? "This resumes ordinary execution. The reason is the record of why it was safe to resume — the question an auditor asks afterwards."
            : m.blastRadius,
        danger: p.mode === "halted",
        confirmLabel: p.mode === "normal" ? "Resume" : m.label,
      };
    }
    if (p.kind === "halt-agent")
      return {
        title: `Halt agent ${p.label}`,
        body: "Every dispatch to this agent will be refused, and it can no longer be selected as a routing or fallback target. This is separate from disabling it in the registry: lifting the halt will not put a deliberately-disabled agent back into service.",
        danger: true,
        confirmLabel: "Halt agent",
      };
    if (p.kind === "unhalt-agent")
      return {
        title: `Lift the halt on ${p.label}`,
        body: "The agent becomes dispatchable again for anyone already granted it. The reason is recorded beside the original halt.",
        danger: false,
        confirmLabel: "Lift halt",
      };
    if (p.kind === "halt-tool")
      return {
        title: `Halt tool ${p.toolName}`,
        body: "Every call to this tool will be refused. Its server, its sibling tools and every other agent are unaffected.",
        danger: true,
        confirmLabel: "Halt tool",
      };
    return {
      title: `Lift the halt on ${p.toolName}`,
      body: "The tool becomes callable again by anyone already granted it.",
      danger: false,
      confirmLabel: "Lift halt",
    };
  };
  const copy = modalCopy();

  return (
    <>
      <PageHeader
        title="Execution control"
        sub="The emergency stop — deployment-wide, per agent, or per tool. Nothing here trips on its own."
        info={<p>The emergency stop. One dial for the whole deployment, plus a halt on a single agent or a single tool — because an incident confined to one tool should not cost you the business. Every position is an operator's deliberate act: nothing here trips on its own.</p>}
      />
      <div className={v.stack}>
        <QueryGate loading={state.isLoading} error={state.error} onRetry={() => void refresh()}>
          {/* ── the headline: what is stopped, right now ──────────────── */}
          <Card title="Right now">
            <div className={a.statRow}>
              <Stat
                value={
                  <Badge tone={restricted ? "danger" : "ok"}>
                    {s?.mode.replace("_", "-") ?? "—"}
                  </Badge>
                }
                label="deployment"
              />
              <Stat
                value={
                  <Badge tone={(s?.haltedAgents.length ?? 0) > 0 ? "danger" : "ok"}>
                    {s?.haltedAgents.length ?? 0}
                  </Badge>
                }
                label="agents halted"
              />
              <Stat
                value={
                  <Badge tone={(s?.haltedTools.length ?? 0) > 0 ? "danger" : "ok"}>
                    {s?.haltedTools.length ?? 0}
                  </Badge>
                }
                label="tools halted"
              />
            </div>

            {anythingStopped ? (
              <EmptyState
                title={s?.summary ?? "Execution is restricted"}
                body={
                  <>
                    {s?.reason && (
                      <p>
                        <strong>Reason given:</strong> {s.reason}
                      </p>
                    )}
                    {s?.setAt && <p className={v.faint}>Set {s.setAt}.</p>}
                    <p className={v.faint}>{s?.meaning}</p>
                  </>
                }
              />
            ) : (
              <div className={v.faint}>{s?.summary}</div>
            )}

            {/* The hesitation problem: say what survives, prominently. */}
            <div className={v.faint}>{s?.note}</div>
            <div className={v.faint}>{s?.scheduledSweepsNote}</div>
          </Card>

          {/* ── the dial ──────────────────────────────────────────────── */}
          <Card title="Deployment-wide">
            <Table
              rows={MODES}
              rowKey={(m) => m.mode}
              columns={[
                {
                  key: "mode",
                  header: "Mode",
                  render: (m) => (
                    <>
                      <Badge tone={s?.mode === m.mode ? m.tone : "neutral"}>{m.label}</Badge>
                      {s?.mode === m.mode && <span className={v.faint}> — current</span>}
                    </>
                  ),
                },
                {
                  key: "radius",
                  header: "What this does",
                  render: (m) => <span className={v.faint}>{m.blastRadius}</span>,
                },
                {
                  key: "go",
                  header: "",
                  render: (m) => (
                    <Button
                      size="sm"
                      variant={m.mode === "halted" ? "danger" : "ghost"}
                      // require_approval without a named approver is refused by
                      // the server; disabling here says so before the click
                      // rather than after the round trip
                      disabled={
                        act.busy ||
                        s?.mode === m.mode ||
                        (m.mode === "require_approval" && !approver)
                      }
                      title={
                        m.mode === "require_approval" && !approver
                          ? "pick an approver first — a queued approval has to name a person"
                          : undefined
                      }
                      onClick={() => setPending({ kind: "mode", mode: m.mode })}
                    >
                      {s?.mode === m.mode ? "current" : m.mode === "normal" ? "Resume" : "Switch"}
                    </Button>
                  ),
                },
              ]}
            />
            {/* require_approval cannot be set without naming who signs off —
                the server refuses it, so the field lives beside the button */}
            <div className={a.formRow}>
              <Field label="Approver for 'require approval' mode">
                <Select
                  aria-label="Approver for require-approval mode"
                  value={approver}
                  onChange={(e) => setApprover(e.target.value)}
                >
                  <option value="">— pick the human who will sign off —</option>
                  {(users.data?.users ?? []).map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.displayName || u.email}
                    </option>
                  ))}
                </Select>
              </Field>
              <span className={v.faint}>
                Required only for <strong>require approval</strong>: a queued approval names a
                person, and one nobody is named on is one nobody is accountable for deciding.
              </span>
            </div>
          </Card>

          {/* ── stop one thing ────────────────────────────────────────── */}
          <Card title="Stop one agent or one tool">
            <div className={v.faint}>
              The scope that lets you stop the thing that is actually wrong. A halted subject is
              refused even while the deployment as a whole is normal.
            </div>
            <div className={a.formRow}>
              <Field label="Agent">
                <Select
                  aria-label="Agent to halt"
                  value={agentPick}
                  onChange={(e) => setAgentPick(e.target.value)}
                >
                  <option value="">— choose an agent —</option>
                  {(agents.data?.agents ?? []).map((ag) => (
                    <option key={ag.id} value={ag.id}>
                      {ag.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Button
                size="sm"
                variant="danger"
                disabled={!agentPick || act.busy}
                onClick={() =>
                  setPending({
                    kind: "halt-agent",
                    agentId: agentPick,
                    label:
                      (agents.data?.agents ?? []).find((x) => x.id === agentPick)?.name ?? agentPick,
                  })
                }
              >
                Halt agent
              </Button>
            </div>
            <div className={a.formRow}>
              <Field label="Server">
                <Select
                  aria-label="Server"
                  value={serverPick}
                  onChange={(e) => {
                    setServerPick(e.target.value);
                    setToolPick("");
                  }}
                >
                  <option value="">— choose a server —</option>
                  {(servers.data?.servers ?? []).map((sv) => (
                    <option key={sv.id} value={sv.id}>
                      {sv.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Tool">
                <Select
                  aria-label="Tool to halt"
                  value={toolPick}
                  onChange={(e) => setToolPick(e.target.value)}
                  disabled={!serverPick}
                >
                  <option value="">— choose a tool —</option>
                  {(tools.data?.tools ?? []).map((t) => (
                    <option key={t.id} value={t.name}>
                      {t.name} ({t.kind})
                    </option>
                  ))}
                </Select>
              </Field>
              <Button
                size="sm"
                variant="danger"
                disabled={!serverPick || !toolPick || act.busy}
                onClick={() =>
                  setPending({ kind: "halt-tool", serverId: serverPick, toolName: toolPick })
                }
              >
                Halt tool
              </Button>
            </div>
          </Card>

          {/* ── what is halted, and how to lift it ────────────────────── */}
          {(s?.haltedAgents.length ?? 0) > 0 && (
            <Card title="Halted agents">
              <Table
                rows={s?.haltedAgents ?? []}
                rowKey={(r) => r.id}
                columns={[
                  { key: "name", header: "Agent", render: (r) => r.name },
                  {
                    key: "reason",
                    header: "Reason",
                    render: (r) => <span className={v.faint}>{r.reason ?? "—"}</span>,
                  },
                  { key: "since", header: "Since", render: (r) => r.haltedAt },
                  {
                    key: "lift",
                    header: "",
                    render: (r) => (
                      <Button
                        size="sm"
                        disabled={act.busy}
                        onClick={() =>
                          setPending({ kind: "unhalt-agent", agentId: r.id, label: r.name })
                        }
                      >
                        Lift
                      </Button>
                    ),
                  },
                ]}
              />
            </Card>
          )}

          {(s?.haltedTools.length ?? 0) > 0 && (
            <Card title="Halted tools">
              <Table
                rows={s?.haltedTools ?? []}
                rowKey={(r) => `${r.serverId}|${r.name}`}
                columns={[
                  { key: "tool", header: "Tool", render: (r) => r.name },
                  {
                    key: "server",
                    header: "Server",
                    render: (r) => (
                      <span className={v.faint}>
                        {(servers.data?.servers ?? []).find((sv) => sv.id === r.serverId)?.name ??
                          r.serverId}
                      </span>
                    ),
                  },
                  {
                    key: "reason",
                    header: "Reason",
                    render: (r) => <span className={v.faint}>{r.reason ?? "—"}</span>,
                  },
                  { key: "since", header: "Since", render: (r) => r.haltedAt },
                  {
                    key: "lift",
                    header: "",
                    render: (r) => (
                      <Button
                        size="sm"
                        disabled={act.busy}
                        onClick={() =>
                          setPending({
                            kind: "unhalt-tool",
                            serverId: r.serverId,
                            toolName: r.name,
                          })
                        }
                      >
                        Lift
                      </Button>
                    ),
                  },
                ]}
              />
            </Card>
          )}

          {act.error && <div className={v.errLine}>{act.error}</div>}
        </QueryGate>
      </div>

      <ReasonModal
        open={pending !== null}
        title={copy.title}
        body={
          <>
            <p>{copy.body}</p>
            <p className={v.faint}>
              The reason is audited and is what whoever undoes this will read. Both throwing and
              lifting require one.
            </p>
          </>
        }
        confirmLabel={copy.confirmLabel}
        danger={copy.danger}
        minLength={REASON_MIN}
        placeholder="why — e.g. 'vendor advisory VA-2026-11, tool returning injected content'"
        onConfirm={confirm}
        onCancel={() => setPending(null)}
      />
    </>
  );
}
