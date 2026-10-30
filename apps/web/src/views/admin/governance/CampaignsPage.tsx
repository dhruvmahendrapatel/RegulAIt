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
 *    items reads "expired-incomplete" (computed on read), its items stay
 *    undecided forever, and the posture page carries the count. The B2a
 *    scheduler sweep only RECORDS that fact into the audit log — it decides
 *    nothing, so this page renders exactly what it always did.
 *  - **Reassignment moves the queue, never the decision.** (ADR-0090
 *    amendment, B2b) An admin can move an UNDECIDED item's reviewer with a
 *    recorded reason — riding ADR-0046's one approver-moving write — and
 *    NEVER to the grant's holder: the decider-keyed self-review bar extends
 *    to routing, and the gateway's refusal is rendered verbatim below.
 */
import { withStepUp } from "../../../stepup/stepUp";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import { ago } from "../../../api/format";
import { PageHeader } from "../../../shell/AppShell";
import { useSession } from "../../../session/SessionContext";
import { Badge, Button, Card, EmptyState, Field, Input, Select, Table, type Tone } from "../../../ui/kit";
import { QueryGate, useAction } from "../adminKit";
import { ReasonedAction } from "./ReasonedAction";
import sh from "./shadowAi.module.css";
import a from "../admin.module.css";
import v from "../../views.module.css";

type ScopeKind = "all" | "agent_lifecycle" | "agent_owner" | "user" | "from_recommendations";
type CampaignStatus = "open" | "completed" | "expired-incomplete" | "cancelled";

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
  /** ADR-0208 G9: who cancelled it, when and why; null unless cancelled */
  cancellation: { at: string; reason: string | null; byUserId: string | null } | null;
  notes: { scope: string; snapshot: string; expiry: string };
  items: CampaignItem[];
}

const statusTone = (s: CampaignStatus): Tone =>
  s === "completed" ? "ok" : s === "expired-incomplete" ? "danger" : s === "cancelled" ? "neutral" : "info";
// ADR-0208 G9: status chips (a cancelled campaign is read-only)
const CHIPS: Array<[CampaignStatus, string]> = [
  ["open", "Open"],
  ["completed", "Completed"],
  ["expired-incomplete", "Expired"],
  ["cancelled", "Cancelled"],
];

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
  const reassignAct = useAction();
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

  // reassign-a-review form (B2b)
  const [reassignItemId, setReassignItemId] = useState("");
  const [reassignReviewerId, setReassignReviewerId] = useState("");
  const [reassignReason, setReassignReason] = useState("");

  const scopePayload = () => ({
    kind: scopeKind,
    ...(scopeKind === "all" ? {} : { value: scopeValue }),
  });

  const refreshAll = async () => {
    await Promise.all([list.refetch(), openId ? detail.refetch() : Promise.resolve(null)]);
  };
  const d = detail.data;
  const [chip, setChip] = useState<CampaignStatus>("open");
  const allCampaigns = list.data?.campaigns ?? [];

  return (
    <>
      <PageHeader
        title="Certification campaigns"
        info={<p>Periodic re-attestation of GATEWAY GRANTS ONLY — the agent, connector and MCP tool/server grant rows this gateway enforces, direct and role-bundled. Items are a snapshot taken at open; each keep/revoke is a decision on the one Approvals queue by the item's named reviewer; a revoke executes the real grant removal; a past-due campaign reads expired-incomplete and its undecided items stay undecided forever.</p>}
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
          <Card
            title="Campaigns"
            actions={
              <div className={v.row} role="group" aria-label="Filter by status">
                {CHIPS.map(([k, l]) => (
                  <button key={k} type="button" className={sh.chip} aria-pressed={chip === k} onClick={() => setChip(k)}>
                    {l} {allCampaigns.filter((c) => c.status === k).length}
                  </button>
                ))}
              </div>
            }
          >
            {allCampaigns.length === 0 ? (
              <EmptyState
                title="No certification campaign has ever been run"
                body="Gateway grants have never been re-attested. Open one above."
              />
            ) : (
              <Table
                rows={allCampaigns.filter((c) => c.status === chip)}
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
                actions={
                  <div className={v.row}>
                    {d.status === "open" && (() => {
                      const undecided = d.items.filter((i) => i.decision === null).length;
                      const decided = d.items.length - undecided;
                      return (
                        <ReasonedAction
                          label="Cancel campaign"
                          variant="danger"
                          title={`Cancel campaign “${d.name}”?`}
                          confirmLabel="Cancel campaign"
                          body={
                            <p className={v.flush}>
                              The {undecided} undecided {undecided === 1 ? "review is" : "reviews are"} withdrawn from reviewers’ queues and those grants stay
                              unattested. The {decided} {decided === 1 ? "decision" : "decisions"} already made, including revocations, stand. You will be
                              asked to confirm it's you.
                            </p>
                          }
                          cancelLabel="Keep campaign"
                          submit={(reason) => withStepUp((h) => api.postWithHeaders(`/v1/certification-campaigns/${d.id}/cancel`, { reason }, h))}
                          done={`Campaign “${d.name}” cancelled; ${undecided} reviews withdrawn`}
                          refusal={(code, payload) =>
                            code === "campaign_not_open"
                              ? `This campaign is no longer open (it reads ‘${String(payload.status ?? "closed")}’), so it cannot be cancelled. Refresh the page.`
                              : null
                          }
                        />
                      );
                    })()}
                    {d.status === "cancelled" && <span className={v.faint}>Read-only</span>}
                    <Button variant="ghost" onClick={() => setOpenId(null)}>Close</Button>
                  </div>
                }
              >
                <div className={v.stack}>
                  <div>
                    <Badge tone={statusTone(d.status)}>{d.status}</Badge>{" "}
                    <span className={v.faint}>
                      {d.status === "cancelled"
                        ? `cancelled${d.cancellation ? ` ${ago(d.cancellation.at)}` : ""} — undecided reviews were withdrawn and those grants stay unattested; decisions already made stand${d.cancellation?.reason ? `. Reason: ${d.cancellation.reason}` : ""}`
                        : d.status === "expired-incomplete"
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
                  {d.status === "open" && d.items.some((i) => i.decision === null) && (
                    <form
                      className={v.stack}
                      onSubmit={(e) => {
                        e.preventDefault();
                        void reassignAct.run(async () => {
                          await api.post(`/v1/certification-campaigns/${d.id}/items/${reassignItemId}/reassign`, {
                            reviewerUserId: reassignReviewerId,
                            reason: reassignReason,
                          });
                          setReassignItemId("");
                          setReassignReviewerId("");
                          setReassignReason("");
                          await refreshAll();
                        }, "Review reassigned — the item moved to the new reviewer's queue; nothing was decided");
                      }}
                    >
                      <div className={a.formRow}>
                        <Field label="Item to reassign">
                          <Select required value={reassignItemId} onChange={(e) => setReassignItemId(e.target.value)}>
                            <option value="">— select —</option>
                            {d.items
                              .filter((i) => i.decision === null)
                              .map((i) => (
                                <option key={i.id} value={i.id}>
                                  {i.holder.label} · {i.object.label} (now: {i.reviewer.name ?? i.reviewer.userId})
                                </option>
                              ))}
                          </Select>
                        </Field>
                        <Field label="New reviewer">
                          <Select required value={reassignReviewerId} onChange={(e) => setReassignReviewerId(e.target.value)}>
                            <option value="">— select —</option>
                            {(usersQ.data?.users ?? []).map((u) => (
                              <option key={u.id} value={u.id}>
                                {u.displayName || u.email}
                              </option>
                            ))}
                          </Select>
                        </Field>
                        <Field label="Reassignment reason" grow>
                          <Input
                            required
                            value={reassignReason}
                            onChange={(e) => setReassignReason(e.target.value)}
                            placeholder="why the review is moving — recorded in the audit trail"
                          />
                        </Field>
                        <Button type="submit" size="sm" disabled={reassignAct.busy}>
                          Reassign review
                        </Button>
                      </div>
                      {reassignAct.error && (
                        <span className={v.errLine} role="alert">
                          {reassignAct.error}
                        </span>
                      )}
                      <p className={v.faint}>
                        Reassignment moves whose queue the item shows in, never who may decide — and never to the
                        grant's holder: routing them their own item would set up the self-certification the decide
                        path refuses. No reason unlocks that bar.
                      </p>
                    </form>
                  )}
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
