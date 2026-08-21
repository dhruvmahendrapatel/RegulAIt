/**
 * Grant certification campaigns (ADR-0090, gap L22) — the Saviynt-shaped
 * access-review loop scoped to GATEWAY GRANTS ONLY. Four honesty rules this
 * page renders rather than merely documents:
 *
 *  - **Snapshot, not surveillance.** A campaign reviews the grants that
 *    existed when it opened; the scope preview shows the count BEFORE the
 *    admin commits, and the page says a later grant is out of scope.
 *  - **Decisions ride the one approvals queue.** The keep/revoke controls
 *    call POST /v1/approvals/:id/decide — the same endpoint as every other
 *    decision — and appear only for the item's own named reviewer. Everyone
 *    else sees the decision state, not a button.
 *  - **Revoke is real.** A revoke decision executes the grant removal in the
 *    decision's own transaction; the item then shows what the execution did.
 *  - **Expiry is visible, never silent.** A past-due campaign with undecided
 *    items reads "expired-incomplete" (computed on read — no scheduler), its
 *    items stay undecided forever, and the posture page carries the count.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import { ago } from "../../../api/format";
import { PageHeader } from "../../../shell/AppShell";
import { useSession } from "../../../session/SessionContext";
import { Badge, Button, Card, EmptyState, Field, Input, Select, Table, type Tone } from "../../../ui/kit";
import { QueryGate, useAction } from "../adminKit";
import a from "../admin.module.css";
import v from "../../views.module.css";

type ScopeKind = "all" | "agent_lifecycle" | "agent_owner" | "user" | "from_recommendations";
type CampaignStatus = "open" | "completed" | "expired-incomplete";

interface CampaignListRow {
  id: string;
  name: string;
  scope: { kind: ScopeKind; value: string | null };
  openedBy: { userId: string; name: string | null };
  dueAt: string;
  status: CampaignStatus;
  createdAt: string;
  items: { total: number; keep: number; revoke: number; undecided: number };
}
interface CampaignItem {
  id: string;
  grantKind: string;
  grantId: string;
  holder: { userId: string | null; roleId: string | null; label: string };
  object: { id: string | null; label: string; toolName: string | null };
  reviewer: { userId: string; name: string | null };
  approvalId: string;
  decision: "keep" | "revoke" | null;
  decidedBy: { userId: string; name: string | null } | null;
  decidedAt: string | null;
  revocation: { mechanism: string; removed: boolean } | null;
}
interface CampaignDetail {
  id: string;
  name: string;
  scope: { kind: ScopeKind; value: string | null };
  dueAt: string;
  status: CampaignStatus;
  completedAt: string | null;
  notes: { scope: string; snapshot: string; expiry: string };
  items: CampaignItem[];
}

const statusTone = (s: CampaignStatus): Tone =>
  s === "completed" ? "ok" : s === "expired-incomplete" ? "danger" : "info";

const SCOPE_LABELS: Record<ScopeKind, string> = {
  all: "all gateway grants",
  agent_lifecycle: "grants on agents by lifecycle",
  agent_owner: "grants on one owner's agents",
  user: "one user's direct grants",
  // ADR-0092: opened from the Access recommendations page (which knows the
  // rule ids); listed here for display, not offered in the manual form below
  from_recommendations: "grants flagged by recommendation rules",
};
/** the scopes the manual open-form offers — from_recommendations campaigns
 * are opened from the Access recommendations page, where the flagged set is
 * visible before committing */
const FORM_SCOPES: ScopeKind[] = ["all", "agent_lifecycle", "agent_owner", "user"];

export default function CampaignsPage() {
  const act = useAction();
  const { auth } = useSession();
  const myUserId = auth?.userId ?? null;

  const list = useQuery({
    queryKey: ["admin", "certification"],
    queryFn: () =>
      api.get<{ campaigns: CampaignListRow[]; notes: { scope: string } }>("/v1/certification-campaigns"),
  });
  const usersQ = useQuery({
    queryKey: ["admin", "certification", "users"],
    queryFn: () => api.get<{ users: Array<{ id: string; email: string; displayName: string | null }> }>("/v1/users"),
  });

  const [openId, setOpenId] = useState<string | null>(null);
  const detail = useQuery({
    queryKey: ["admin", "certification", openId],
    queryFn: () => api.get<CampaignDetail>(`/v1/certification-campaigns/${openId}`),
    enabled: Boolean(openId),
  });

  // open-a-campaign form
  const [name, setName] = useState("");
  const [scopeKind, setScopeKind] = useState<ScopeKind>("all");
  const [scopeValue, setScopeValue] = useState("");
  const [dueAt, setDueAt] = useState("");
  const [previewCount, setPreviewCount] = useState<number | null>(null);

  const scopePayload = () => ({
    kind: scopeKind,
    ...(scopeKind === "all" ? {} : { value: scopeValue }),
  });

  const refreshAll = async () => {
    await Promise.all([list.refetch(), openId ? detail.refetch() : Promise.resolve(null)]);
  };
  const d = detail.data;

  return (
    <>
      <PageHeader
        title="Certification campaigns"
        sub="Periodic re-attestation of GATEWAY GRANTS ONLY — the agent, connector and MCP tool/server grant rows this gateway enforces, direct and role-bundled. Items are a snapshot taken at open; each keep/revoke is a decision on the one Approvals queue by the item's named reviewer; a revoke executes the real grant removal; a past-due campaign reads expired-incomplete and its undecided items stay undecided forever."
      />
      <div className={v.stack}>
        {/* ---------------- open ---------------- */}
        <Card title="Open a campaign">
          <form
            className={v.stack}
            onSubmit={(e) => {
              e.preventDefault();
              void act.run(async () => {
                await api.post("/v1/certification-campaigns", {
                  name,
                  scope: scopePayload(),
                  dueAt: new Date(dueAt).toISOString(),
                });
                setName("");
                setPreviewCount(null);
                await refreshAll();
              }, "Campaign opened — a snapshot of the grants in scope; each item is routed to its reviewer");
            }}
          >
            <div className={a.formRow}>
              <Field label="Campaign name" grow>
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Q3 grant re-attestation" required />
              </Field>
              <Field label="Scope">
                <Select
                  value={scopeKind}
                  onChange={(e) => {
                    setScopeKind(e.target.value as ScopeKind);
                    setScopeValue("");
                    setPreviewCount(null);
                  }}
                >
                  {FORM_SCOPES.map((k) => (
                    <option key={k} value={k}>
                      {SCOPE_LABELS[k]}
                    </option>
                  ))}
                </Select>
              </Field>
              {scopeKind === "agent_lifecycle" && (
                <Field label="Lifecycle status">
                  <Select value={scopeValue} onChange={(e) => { setScopeValue(e.target.value); setPreviewCount(null); }}>
                    <option value="">choose…</option>
                    <option value="active">active</option>
                    <option value="deprecated">deprecated</option>
                    <option value="retired">retired</option>
                  </Select>
                </Field>
              )}
              {(scopeKind === "agent_owner" || scopeKind === "user") && (
                <Field label={scopeKind === "agent_owner" ? "Agent owner" : "Grant holder"}>
                  <Select value={scopeValue} onChange={(e) => { setScopeValue(e.target.value); setPreviewCount(null); }}>
                    <option value="">choose…</option>
                    {(usersQ.data?.users ?? []).map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.displayName || u.email}
                      </option>
                    ))}
                  </Select>
                </Field>
              )}
              <Field label="Due date">
                <Input type="datetime-local" value={dueAt} onChange={(e) => setDueAt(e.target.value)} required />
              </Field>
            </div>
            <div>
              <Button
                type="button"
                variant="ghost"
                disabled={act.busy || (scopeKind !== "all" && !scopeValue)}
                onClick={() =>
                  void act.run(async () => {
                    const res = await api.post<{ count: number }>("/v1/certification-campaigns/preview", {
                      scope: scopePayload(),
                    });
                    setPreviewCount(res.count);
                  })
                }
              >
                Preview scope
              </Button>{" "}
              {previewCount !== null && (
                <span className={v.faint}>
                  {previewCount} grant(s) would be snapshotted at open — grants created later stay out of scope.
                </span>
              )}{" "}
              <Button type="submit" disabled={act.busy}>Open campaign</Button>
            </div>
          </form>
        </Card>

        {/* ---------------- list ---------------- */}
        <QueryGate loading={list.isLoading} error={list.error} onRetry={() => void list.refetch()}>
          <Card title="Campaigns">
            {(list.data?.campaigns ?? []).length === 0 ? (
              <EmptyState
                title="No certification campaign has ever been run"
                body="Gateway grants have never been re-attested. Open one above — the posture page states this fact outright until then."
              />
            ) : (
              <Table
                rows={list.data?.campaigns ?? []}
                rowKey={(r) => r.id}
                onRowClick={(r) => setOpenId(openId === r.id ? null : r.id)}
                columns={[
                  { key: "name", header: "Campaign", render: (r) => r.name },
                  {
                    key: "status",
                    header: "Status",
                    render: (r) => <Badge tone={statusTone(r.status)}>{r.status}</Badge>,
                  },
                  { key: "scope", header: "Scope", render: (r) => SCOPE_LABELS[r.scope.kind] },
                  {
                    key: "progress",
                    header: "Items",
                    render: (r) => (
                      <>
                        {r.items.total} — {r.items.keep} keep, {r.items.revoke} revoke,{" "}
                        {r.items.undecided > 0 ? <strong>{r.items.undecided} undecided</strong> : "0 undecided"}
                      </>
                    ),
                  },
                  { key: "due", header: "Due", render: (r) => ago(r.dueAt) },
                  { key: "opened", header: "Opened by", render: (r) => r.openedBy.name ?? r.openedBy.userId },
                ]}
              />
            )}
          </Card>
        </QueryGate>

        {/* ---------------- detail ---------------- */}
        {openId && (
          <QueryGate loading={detail.isLoading} error={detail.error} onRetry={() => void detail.refetch()}>
            {d && (
              <Card
                title={`Campaign: ${d.name}`}
                actions={<Button variant="ghost" onClick={() => setOpenId(null)}>Close</Button>}
              >
                <div className={v.stack}>
                  <div>
                    <Badge tone={statusTone(d.status)}>{d.status}</Badge>{" "}
                    <span className={v.faint}>
                      {d.status === "expired-incomplete"
                        ? "past due with undecided items — they stay undecided forever; this is a posture fact, open a new campaign to review these grants"
                        : d.status === "completed"
                          ? `every item decided${d.completedAt ? ` (${ago(d.completedAt)})` : ""}`
                          : `due ${ago(d.dueAt)} — undecided items after that stay undecided forever`}
                    </span>
                  </div>
                  <Table
                    rows={d.items}
                    rowKey={(r) => r.id}
                    columns={[
                      { key: "holder", header: "Holder", render: (r) => r.holder.label },
                      { key: "object", header: "Grant", render: (r) => r.object.label },
                      { key: "kind", header: "Kind", render: (r) => r.grantKind.replace(/_/g, " ") },
                      {
                        key: "reviewer",
                        header: "Reviewer",
                        render: (r) => (
                          <>
                            {r.reviewer.name ?? r.reviewer.userId}
                            {r.reviewer.userId === myUserId && (
                              <>
                                {" "}
                                <Badge tone="info">you</Badge>
                              </>
                            )}
                          </>
                        ),
                      },
                      {
                        key: "decision",
                        header: "Decision",
                        render: (r) =>
                          r.decision ? (
                            <>
                              <Badge tone={r.decision === "keep" ? "ok" : "danger"}>{r.decision}</Badge>{" "}
                              <span className={v.faint}>
                                by {r.decidedBy?.name ?? r.decidedBy?.userId}
                                {r.decision === "revoke" && r.revocation
                                  ? r.revocation.removed
                                    ? " — grant row removed"
                                    : " — grant row was already gone"
                                  : ""}
                              </span>
                            </>
                          ) : d.status === "open" && r.reviewer.userId === myUserId ? (
                            <>
                              <Button
                                disabled={act.busy}
                                onClick={() =>
                                  void act.run(async () => {
                                    await api.post(`/v1/approvals/${r.approvalId}/decide`, { decision: "approved" });
                                    await refreshAll();
                                  }, "Kept — the attestation is recorded; the grant is untouched")
                                }
                              >
                                Keep
                              </Button>{" "}
                              <Button
                                variant="danger"
                                disabled={act.busy}
                                onClick={() =>
                                  void act.run(async () => {
                                    await api.post(`/v1/approvals/${r.approvalId}/decide`, {
                                      decision: "denied",
                                      reason: "revoked in certification review",
                                    });
                                    await refreshAll();
                                  }, "Revoked — the grant row was removed in the decision's own transaction")
                                }
                              >
                                Revoke
                              </Button>
                            </>
                          ) : (
                            <span className={v.faint}>
                              {d.status === "open" ? "awaiting its named reviewer" : "undecided — stays undecided"}
                            </span>
                          ),
                      },
                    ]}
                  />
                  <div className={v.faint}>{d.notes.scope}</div>
                  <div className={v.faint}>{d.notes.snapshot} {d.notes.expiry}</div>
                </div>
              </Card>
            )}
          </QueryGate>
        )}
      </div>
    </>
  );
}
