/**
 * Toxic-combination SoD rules (ADR-0091, gap L23) — capability pairs no
 * single identity may hold together, enforced where gateway grants are
 * MINTED. Four honesty rules this page renders rather than merely documents:
 *
 *  - **Sides are data, with a reason.** A rule names 2..8 sides — concrete
 *    id-based capabilities and/or PATTERN selectors over the three
 *    enumerable dimensions the schema actually has (agent lifecycle status,
 *    agent provider kind, connector mode; the ADR-0091 B2c amendment — no
 *    free-regex anywhere) — and REQUIRES a rationale the refusal quotes
 *    back. An identity must hold ALL sides to conflict; any N-1 subset is
 *    allowed.
 *  - **Preventive, never retroactive.** Creating or enabling a rule strips
 *    nobody. Current violators are computed live and listed on the rule; the
 *    admin resolves them through a certification campaign or revocation.
 *  - **The refusal is the product.** A conflicting mint gets a named 409
 *    (`sod_conflict`) wherever grants are minted — this page is where the
 *    rules and their violators live, not a second enforcement point.
 *  - **Overrides ride the one approvals queue.** An escalated refusal is one
 *    ordinary queue row for an arm's-length approver (never the requester);
 *    approval mints the refused grant with the rule recorded as overridden.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import { ago } from "../../../api/format";
import { PageHeader } from "../../../shell/AppShell";
import { Badge, Button, Card, EmptyState, Field, Input, Select, Table, type Tone } from "../../../ui/kit";
import {
  QueryGate,
  agentOpts,
  connectorOpts,
  optionEls,
  serverOpts,
  useAction,
  useAgents,
  useConnectors,
  useServers,
  useUsers,
  userOpts,
  type Opt,
} from "../adminKit";
import a from "../admin.module.css";
import v from "../../views.module.css";
import { api as stepUpApi, withStepUp } from "../../../stepup/stepUp";

type CapKind = "agent" | "connector" | "mcp_tool" | "mcp_server";
type MintKind = "agent" | "connector" | "tool" | "server";

interface Selector {
  kind: CapKind;
  objectId: string | null;
  toolName: string | null;
  mode: "read" | "readwrite" | null;
  /** B2c: non-null for a pattern side */
  pattern: { dimension: "lifecycle_status" | "provider" | "mode"; value: string } | null;
  label: string;
}
interface Violator {
  userId: string;
  userLabel: string;
  holdsA: string;
  holdsB: string;
  /** B2c: one holding per side, in side order */
  holds: string[];
}
interface SodRule {
  id: string;
  name: string;
  reason: string;
  enabled: boolean;
  /** every side in order — 2 for a pre-amendment rule, up to 8 since B2c */
  sides: Selector[];
  createdAt: string;
  currentViolators: Violator[];
}
interface OverrideRow {
  id: string;
  ruleName: string | null;
  mintKind: string;
  label: string;
  status: "pending" | "approved" | "denied";
  decidedBy: { name: string | null } | null;
  minted: { table: string } | null;
  createdAt: string;
}

const KIND_LABELS: Record<CapKind, string> = {
  agent: "agent",
  connector: "connector",
  mcp_tool: "MCP tool",
  mcp_server: "MCP server",
};

const statusTone = (s: OverrideRow["status"]): Tone =>
  s === "approved" ? "ok" : s === "denied" ? "danger" : "info";

/** B2c: what one side of the rule form selects by — a concrete object, or a
 * pattern over one of the three ENUMERABLE dimensions (never free text) */
type SelectorType = "concrete" | "lifecycle_status" | "provider" | "mode";
interface SideState {
  kind: CapKind;
  selectorType: SelectorType;
  objectId: string;
  toolName: string;
  mode: string;
  patternValue: string;
}
const emptySide = (): SideState => ({
  kind: "agent",
  selectorType: "concrete",
  objectId: "",
  toolName: "",
  mode: "",
  patternValue: "",
});
/** the closed vocabularies each pattern dimension admits — mirrors the
 * gateway's own validation (which is the authority; this is a picker) */
const PATTERN_TYPES: Record<CapKind, Array<{ value: SelectorType; label: string }>> = {
  agent: [
    { value: "concrete", label: "concrete object" },
    { value: "lifecycle_status", label: "pattern: lifecycle status" },
    { value: "provider", label: "pattern: provider kind" },
  ],
  connector: [
    { value: "concrete", label: "concrete object" },
    { value: "mode", label: "pattern: any connector at mode" },
  ],
  mcp_tool: [{ value: "concrete", label: "concrete object" }],
  mcp_server: [{ value: "concrete", label: "concrete object" }],
};
const PATTERN_VALUES: Record<Exclude<SelectorType, "concrete">, string[]> = {
  lifecycle_status: ["active", "deprecated", "retired"],
  provider: ["anthropic", "openai", "google", "xai", "custom", "regulait_llm", "mock"],
  mode: ["read", "readwrite"],
};
const SIDE_LETTERS = ["A", "B", "C", "D", "E", "F", "G", "H"] as const;

/** one side of the rule form */
function SelectorFields(props: {
  side: string;
  state: SideState;
  onChange: (patch: Partial<SideState>) => void;
  agents: Opt[];
  connectors: Opt[];
  servers: Opt[];
}) {
  const { state } = props;
  const objectOpts =
    state.kind === "agent" ? props.agents : state.kind === "connector" ? props.connectors : props.servers;
  return (
    <>
      <Field label={`Side ${props.side} kind`}>
        <Select
          value={state.kind}
          onChange={(e) =>
            props.onChange({
              kind: e.target.value as CapKind,
              selectorType: "concrete",
              objectId: "",
              toolName: "",
              mode: "",
              patternValue: "",
            })
          }
        >
          {(Object.keys(KIND_LABELS) as CapKind[]).map((k) => (
            <option key={k} value={k}>
              {KIND_LABELS[k]}
            </option>
          ))}
        </Select>
      </Field>
      <Field label={`Side ${props.side} selector`}>
        <Select
          value={state.selectorType}
          onChange={(e) =>
            props.onChange({ selectorType: e.target.value as SelectorType, objectId: "", toolName: "", mode: "", patternValue: "" })
          }
        >
          {PATTERN_TYPES[state.kind].map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </Select>
      </Field>
      {state.selectorType === "concrete" ? (
        <>
          <Field label={`Side ${props.side} object`}>
            <Select required value={state.objectId} onChange={(e) => props.onChange({ objectId: e.target.value })}>
              {optionEls(objectOpts, "— select —")}
            </Select>
          </Field>
          {state.kind === "mcp_tool" && (
            <Field label={`Side ${props.side} tool name`}>
              <Input required value={state.toolName} onChange={(e) => props.onChange({ toolName: e.target.value })} />
            </Field>
          )}
          {state.kind === "connector" && (
            <Field label={`Side ${props.side} mode`}>
              <Select value={state.mode} onChange={(e) => props.onChange({ mode: e.target.value })}>
                <option value="">any mode</option>
                <option value="read">read</option>
                <option value="readwrite">readwrite</option>
              </Select>
            </Field>
          )}
        </>
      ) : (
        <Field label={`Side ${props.side} pattern value`}>
          <Select required value={state.patternValue} onChange={(e) => props.onChange({ patternValue: e.target.value })}>
            <option value="">— select —</option>
            {PATTERN_VALUES[state.selectorType].map((val) => (
              <option key={val} value={val}>
                {val}
              </option>
            ))}
          </Select>
        </Field>
      )}
    </>
  );
}

export default function SodRulesPage() {
  const act = useAction();
  const escalate = useAction();
  const usersQ = useUsers();
  const agentsQ = useAgents();
  const connectorsQ = useConnectors();
  const serversQ = useServers();

  const rules = useQuery({
    queryKey: ["admin", "sod", "rules"],
    queryFn: () => api.get<{ rules: SodRule[]; notes: { enforcement: string } }>("/v1/sod/rules"),
  });
  const overrides = useQuery({
    queryKey: ["admin", "sod", "overrides"],
    queryFn: () => api.get<{ overrides: OverrideRow[] }>("/v1/sod/overrides"),
  });

  // ---- create-rule form (2..8 sides, concrete and/or pattern — B2c) ----
  const [name, setName] = useState("");
  const [reason, setReason] = useState("");
  const [sides, setSides] = useState<SideState[]>([emptySide(), emptySide()]);
  const setSide = (i: number, patch: Partial<SideState>) =>
    setSides((s) => s.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  // ---- escalation form ----
  const [escKind, setEscKind] = useState<MintKind>("agent");
  const [escUserId, setEscUserId] = useState("");
  const [escObjectId, setEscObjectId] = useState("");
  const [escToolName, setEscToolName] = useState("");
  const [escMode, setEscMode] = useState<"read" | "readwrite">("readwrite");
  const [escApproverId, setEscApproverId] = useState("");
  const [escJustification, setEscJustification] = useState("");

  const uOpts = userOpts(usersQ.data?.users);
  const aOpts = agentOpts(agentsQ.data?.agents);
  const cOpts = connectorOpts(connectorsQ.data?.connectors);
  const sOpts = serverOpts(serversQ.data?.servers);

  const sidePayload = (s: SideState) =>
    s.selectorType === "concrete"
      ? {
          kind: s.kind,
          objectId: s.objectId,
          ...(s.kind === "mcp_tool" ? { toolName: s.toolName } : {}),
          ...(s.kind === "connector" && s.mode ? { mode: s.mode } : {}),
        }
      : { kind: s.kind, pattern: { dimension: s.selectorType, value: s.patternValue } };

  const escalationPayload = (): Record<string, unknown> => {
    switch (escKind) {
      case "agent":
        return { userId: escUserId, agentId: escObjectId };
      case "connector":
        return { userId: escUserId, connectorId: escObjectId, mode: escMode };
      case "tool":
        return { userId: escUserId, serverId: escObjectId, toolName: escToolName };
      case "server":
        return { userId: escUserId, serverId: escObjectId };
    }
  };
  const escObjectOpts = escKind === "agent" ? aOpts : escKind === "connector" ? cOpts : sOpts;

  const refreshAll = async () => {
    await Promise.all([rules.refetch(), overrides.refetch()]);
  };

  return (
    <>
      <PageHeader
        title="SoD rules"
        sub="Toxic capability combinations, and who may hold them anyway."
        info={<p>Toxic capability combinations — sets of 2..8 gateway capabilities (agents, connectors, MCP tools/servers — concrete objects or enumerable patterns by agent lifecycle status, provider kind, or connector mode) no single identity may hold together in full. Enforced where grants are minted: a grant, role grant or role assignment that would complete the whole set is refused by name; any subset short of it is allowed. Creating a rule never revokes anybody — existing violators are listed here and resolved through certification campaigns or revocation. A refused mint can be escalated to the one approvals queue for an arm's-length override.</p>}
      />
      <div className={v.stack}>
        {/* ---------------- create ---------------- */}
        <Card title="Declare a toxic combination">
          <form
            className={v.stack}
            onSubmit={(e) => {
              e.preventDefault();
              void act.run(async () => {
                // the original two-concrete-sided shape rides the original
                // payload; N-way and/or pattern rules ride the sides array —
                // one gateway check either way
                const legacyPair = sides.length === 2 && sides.every((s) => s.selectorType === "concrete");
                await api.post(
                  "/v1/sod/rules",
                  legacyPair
                    ? { name, reason, a: sidePayload(sides[0]!), b: sidePayload(sides[1]!) }
                    : { name, reason, sides: sides.map(sidePayload) },
                );
                setName("");
                setReason("");
                setSides([emptySide(), emptySide()]);
                await refreshAll();
              }, "Rule created — enforced at mint time from now on; existing violators (if any) are listed on the rule, never auto-revoked");
            }}
          >
            <div className={a.formRow}>
              <Field label="Rule name" grow>
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="payment vs vendor-master" required />
              </Field>
              <Field label="Reason (required)" grow>
                <Input
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="why this pair is toxic — quoted back in every refusal"
                  required
                />
              </Field>
            </div>
            {sides.map((state, i) => (
              <div className={a.formRow} key={i}>
                <SelectorFields
                  side={SIDE_LETTERS[i] ?? String(i + 1)}
                  state={state}
                  onChange={(patch) => setSide(i, patch)}
                  agents={aOpts}
                  connectors={cOpts}
                  servers={sOpts}
                />
              </div>
            ))}
            <div>
              <Button
                type="button"
                variant="ghost"
                disabled={act.busy || sides.length >= 8}
                onClick={() => setSides((s) => [...s, emptySide()])}
              >
                Add another side
              </Button>{" "}
              {sides.length > 2 && (
                <Button type="button" variant="ghost" disabled={act.busy} onClick={() => setSides((s) => s.slice(0, -1))}>
                  Remove last side
                </Button>
              )}{" "}
              <Button type="submit" disabled={act.busy}>
                Create rule
              </Button>{" "}
              <span className={v.faint}>
                2–8 sides; the rule refuses only an identity that would hold ALL of them — any subset short of the
                full set is allowed. Patterns match by enumerable dimension only and resolve at check time.
              </span>
            </div>
          </form>
        </Card>

        {/* ---------------- rules ---------------- */}
        <QueryGate loading={rules.isLoading} error={rules.error} onRetry={() => void rules.refetch()}>
          <Card title="Rules">
            {(rules.data?.rules ?? []).length === 0 ? (
              <EmptyState
                title="No SoD rule is defined"
                body="No capability combination is declared toxic — the posture page states this fact outright until one exists."
              />
            ) : (
              <Table
                rows={rules.data?.rules ?? []}
                rowKey={(r) => r.id}
                columns={[
                  { key: "name", header: "Rule", render: (r) => r.name },
                  {
                    key: "pair",
                    header: "Toxic set",
                    render: (r) => (
                      <>
                        {r.sides.map((s, i) => (
                          <span key={i}>
                            {i > 0 && <span className={v.faint}> × </span>}
                            {s.label}
                          </span>
                        ))}
                      </>
                    ),
                  },
                  { key: "reason", header: "Reason", render: (r) => <span className={v.faint}>{r.reason}</span> },
                  {
                    key: "enabled",
                    header: "Enforced",
                    render: (r) => <Badge tone={r.enabled ? "ok" : "warn"}>{r.enabled ? "enabled" : "disabled"}</Badge>,
                  },
                  {
                    key: "violators",
                    header: "Current violators",
                    render: (r) =>
                      !r.enabled ? (
                        <span className={v.faint}>not computed (disabled)</span>
                      ) : r.currentViolators.length === 0 ? (
                        <span className={v.faint}>none</span>
                      ) : (
                        <>
                          <Badge tone="danger">{r.currentViolators.length}</Badge>{" "}
                          <span className={v.faint}>
                            {r.currentViolators.map((x) => x.userLabel).join(", ")} — surfaced, never auto-revoked
                          </span>
                        </>
                      ),
                  },
                  {
                    key: "actions",
                    header: "",
                    align: "right",
                    render: (r) => (
                      <span className={v.rowTight} style={{ justifyContent: "flex-end" }}>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={act.busy}
                          onClick={() =>
                            void act.run(async () => {
                              await withStepUp((h) => stepUpApi.patch(`/v1/sod/rules/${r.id}`, { enabled: !r.enabled }, h));
                              await refreshAll();
                            }, r.enabled ? "Rule disabled — the combination is no longer refused at mint time" : "Rule enabled — enforcement resumes; violators surfaced, never auto-revoked")
                          }
                        >
                          {r.enabled ? "Disable" : "Enable"}
                        </Button>
                        <Button
                          size="sm"
                          variant="danger"
                          disabled={act.busy}
                          onClick={() =>
                            void act.run(async () => {
                              await withStepUp((h) => api.delWithHeaders(`/v1/sod/rules/${r.id}`, h));
                              await refreshAll();
                            }, "Rule deleted — the combination is no longer declared toxic")
                          }
                        >
                          Delete
                        </Button>
                      </span>
                    ),
                  },
                ]}
              />
            )}
            {rules.data && <div className={v.faint}>{rules.data.notes.enforcement}</div>}
          </Card>
        </QueryGate>

        {/* ---------------- escalate ---------------- */}
        <Card title="Escalate a refused mint">
          <form
            className={v.stack}
            onSubmit={(e) => {
              e.preventDefault();
              void escalate.run(async () => {
                await api.post("/v1/sod/overrides", {
                  mintKind: escKind,
                  payload: escalationPayload(),
                  approverUserId: escApproverId,
                  ...(escJustification ? { justification: escJustification } : {}),
                });
                setEscJustification("");
                await refreshAll();
              }, "Escalated — one row in the approvals queue; nothing is minted unless the arm's-length approver approves");
            }}
          >
            <div className={a.formRow}>
              <Field label="Mint kind">
                <Select
                  value={escKind}
                  onChange={(e) => {
                    setEscKind(e.target.value as MintKind);
                    setEscObjectId("");
                    setEscToolName("");
                  }}
                >
                  <option value="agent">agent grant</option>
                  <option value="connector">connector grant</option>
                  <option value="tool">MCP tool grant</option>
                  <option value="server">MCP server grant</option>
                </Select>
              </Field>
              <Field label="Grant holder">
                <Select required value={escUserId} onChange={(e) => setEscUserId(e.target.value)}>
                  {optionEls(uOpts, "— select —")}
                </Select>
              </Field>
              <Field label="Granted object">
                <Select required value={escObjectId} onChange={(e) => setEscObjectId(e.target.value)}>
                  {optionEls(escObjectOpts, "— select —")}
                </Select>
              </Field>
              {escKind === "tool" && (
                <Field label="Tool name">
                  <Input required value={escToolName} onChange={(e) => setEscToolName(e.target.value)} />
                </Field>
              )}
              {escKind === "connector" && (
                <Field label="Mode">
                  <Select value={escMode} onChange={(e) => setEscMode(e.target.value as "read" | "readwrite")}>
                    <option value="read">read</option>
                    <option value="readwrite">readwrite</option>
                  </Select>
                </Field>
              )}
              <Field label="Arm's-length approver">
                <Select required value={escApproverId} onChange={(e) => setEscApproverId(e.target.value)}>
                  {optionEls(uOpts, "— select —")}
                </Select>
              </Field>
              <Field label="Justification" grow>
                <Input value={escJustification} onChange={(e) => setEscJustification(e.target.value)} />
              </Field>
              <Button type="submit" size="sm" disabled={escalate.busy}>
                Escalate
              </Button>
            </div>
            {escalate.error && (
              <span className={v.errLine} role="alert">
                {escalate.error}
              </span>
            )}
            <p className={v.faint}>
              The conflict is re-computed server-side — a mint no enabled rule refuses cannot be escalated. The
              requester can never approve their own escalation, not through delegation and not with an admin
              override: the bar is keyed on who actually signs.
            </p>
          </form>
        </Card>

        {/* ---------------- overrides ---------------- */}
        <QueryGate loading={overrides.isLoading} error={overrides.error} onRetry={() => void overrides.refetch()}>
          <Card title="Override requests">
            {(overrides.data?.overrides ?? []).length === 0 ? (
              <EmptyState
                title="No override has been requested"
                body="A refused mint escalated above appears here with its queue decision."
              />
            ) : (
              <Table
                rows={overrides.data?.overrides ?? []}
                rowKey={(r) => r.id}
                columns={[
                  { key: "label", header: "Request", render: (r) => r.label },
                  { key: "rule", header: "Overrides rule", render: (r) => r.ruleName ?? "—" },
                  { key: "kind", header: "Mint", render: (r) => r.mintKind.replace(/_/g, " ") },
                  {
                    key: "status",
                    header: "Status",
                    render: (r) => (
                      <>
                        <Badge tone={statusTone(r.status)}>{r.status}</Badge>{" "}
                        {r.status === "approved" && (
                          <span className={v.faint}>
                            minted{r.minted ? ` into ${r.minted.table}` : ""} with the rule recorded as overridden
                          </span>
                        )}
                        {r.status === "denied" && <span className={v.faint}>nothing minted</span>}
                      </>
                    ),
                  },
                  { key: "when", header: "Requested", render: (r) => ago(r.createdAt) },
                ]}
              />
            )}
          </Card>
        </QueryGate>
      </div>
    </>
  );
}
