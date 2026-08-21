/**
 * Toxic-combination SoD rules (ADR-0091, gap L23) — capability pairs no
 * single identity may hold together, enforced where gateway grants are
 * MINTED. Four honesty rules this page renders rather than merely documents:
 *
 *  - **Concrete pairs, with a reason.** A rule names exactly two id-based
 *    capabilities and REQUIRES a rationale — the refusal it produces quotes
 *    that reason back.
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

type CapKind = "agent" | "connector" | "mcp_tool" | "mcp_server";
type MintKind = "agent" | "connector" | "tool" | "server";

interface Selector {
  kind: CapKind;
  objectId: string;
  toolName: string | null;
  mode: "read" | "readwrite" | null;
  label: string;
}
interface Violator {
  userId: string;
  userLabel: string;
  holdsA: string;
  holdsB: string;
}
interface SodRule {
  id: string;
  name: string;
  reason: string;
  enabled: boolean;
  a: Selector;
  b: Selector;
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

/** one side of the rule form */
function SelectorFields(props: {
  side: "A" | "B";
  kind: CapKind;
  setKind: (k: CapKind) => void;
  objectId: string;
  setObjectId: (v: string) => void;
  toolName: string;
  setToolName: (v: string) => void;
  mode: string;
  setMode: (v: string) => void;
  agents: Opt[];
  connectors: Opt[];
  servers: Opt[];
}) {
  const objectOpts =
    props.kind === "agent" ? props.agents : props.kind === "connector" ? props.connectors : props.servers;
  return (
    <>
      <Field label={`Side ${props.side} kind`}>
        <Select
          value={props.kind}
          onChange={(e) => {
            props.setKind(e.target.value as CapKind);
            props.setObjectId("");
            props.setToolName("");
            props.setMode("");
          }}
        >
          {(Object.keys(KIND_LABELS) as CapKind[]).map((k) => (
            <option key={k} value={k}>
              {KIND_LABELS[k]}
            </option>
          ))}
        </Select>
      </Field>
      <Field label={`Side ${props.side} object`}>
        <Select required value={props.objectId} onChange={(e) => props.setObjectId(e.target.value)}>
          {optionEls(objectOpts, "— select —")}
        </Select>
      </Field>
      {props.kind === "mcp_tool" && (
        <Field label={`Side ${props.side} tool name`}>
          <Input required value={props.toolName} onChange={(e) => props.setToolName(e.target.value)} />
        </Field>
      )}
      {props.kind === "connector" && (
        <Field label={`Side ${props.side} mode`}>
          <Select value={props.mode} onChange={(e) => props.setMode(e.target.value)}>
            <option value="">any mode</option>
            <option value="read">read</option>
            <option value="readwrite">readwrite</option>
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

  // ---- create-rule form ----
  const [name, setName] = useState("");
  const [reason, setReason] = useState("");
  const [aKind, setAKind] = useState<CapKind>("agent");
  const [aObjectId, setAObjectId] = useState("");
  const [aToolName, setAToolName] = useState("");
  const [aMode, setAMode] = useState("");
  const [bKind, setBKind] = useState<CapKind>("agent");
  const [bObjectId, setBObjectId] = useState("");
  const [bToolName, setBToolName] = useState("");
  const [bMode, setBMode] = useState("");

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

  const selectorPayload = (kind: CapKind, objectId: string, toolName: string, mode: string) => ({
    kind,
    objectId,
    ...(kind === "mcp_tool" ? { toolName } : {}),
    ...(kind === "connector" && mode ? { mode } : {}),
  });

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
        sub="Toxic capability combinations — pairs of gateway capabilities (agents, connectors, MCP tools/servers) no single identity may hold together. Enforced where grants are minted: a conflicting grant, role grant or role assignment is refused by name. Creating a rule never revokes anybody — existing violators are listed here and resolved through certification campaigns or revocation. A refused mint can be escalated to the one approvals queue for an arm's-length override."
      />
      <div className={v.stack}>
        {/* ---------------- create ---------------- */}
        <Card title="Declare a toxic combination">
          <form
            className={v.stack}
            onSubmit={(e) => {
              e.preventDefault();
              void act.run(async () => {
                await api.post("/v1/sod/rules", {
                  name,
                  reason,
                  a: selectorPayload(aKind, aObjectId, aToolName, aMode),
                  b: selectorPayload(bKind, bObjectId, bToolName, bMode),
                });
                setName("");
                setReason("");
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
            <div className={a.formRow}>
              <SelectorFields
                side="A"
                kind={aKind}
                setKind={setAKind}
                objectId={aObjectId}
                setObjectId={setAObjectId}
                toolName={aToolName}
                setToolName={setAToolName}
                mode={aMode}
                setMode={setAMode}
                agents={aOpts}
                connectors={cOpts}
                servers={sOpts}
              />
            </div>
            <div className={a.formRow}>
              <SelectorFields
                side="B"
                kind={bKind}
                setKind={setBKind}
                objectId={bObjectId}
                setObjectId={setBObjectId}
                toolName={bToolName}
                setToolName={setBToolName}
                mode={bMode}
                setMode={setBMode}
                agents={aOpts}
                connectors={cOpts}
                servers={sOpts}
              />
            </div>
            <div>
              <Button type="submit" disabled={act.busy}>
                Create rule
              </Button>
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
                    header: "Toxic pair",
                    render: (r) => (
                      <>
                        {r.a.label} <span className={v.faint}>×</span> {r.b.label}
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
                              await api.patch(`/v1/sod/rules/${r.id}`, { enabled: !r.enabled });
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
                              await api.del(`/v1/sod/rules/${r.id}`);
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
