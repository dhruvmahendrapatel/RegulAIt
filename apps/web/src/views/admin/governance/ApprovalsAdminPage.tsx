/**
 * Approvals queue (admin) — the one inbox, fleet-wide: MCP pauses, workflow
 * sign-offs, run escalations, budget overages, context conflicts,
 * reclassifications. The named approver decides; an admin may decide in
 * anyone's place only with a recorded reason (audit-marked override); a
 * self-review requires a reason too. Plus delegation windows (vacation /
 * offboarding coverage).
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { api } from "../../../api/client";
import type { Approval } from "../../../api/types";
import type { Delegation } from "../../../api/adminTypes";
import { ago, approvalStageLabel } from "../../../api/format";
import { useSession } from "../../../session/SessionContext";
import { PageHeader } from "../../../shell/AppShell";
import {
  Badge,
  Button,
  Card,
  ConfirmModal,
  EmptyState,
  Field,
  Input,
  Select,
  StatusBadge,
  Table,
} from "../../../ui/kit";
import { OutcomePanel, RemoveButton, optionEls, useAction, useApiAction, useUsers, userOpts } from "../adminKit";
import { McpActionReview } from "../../approvals/McpActionReview";
import { inspectApprovalAction, isBoundAction } from "../../approvals/approvalReview";
import { ReviewPanel } from "../../approvals/ReviewPanel";
import { intakeUseCaseName, isIntakeSignoff } from "../../approvals/reviewDecision";
import a from "../admin.module.css";
import v from "../../views.module.css";

const labelOf = (r: Approval) => isIntakeSignoff(r) ? "AI use case sign-off" : r.objectType === "mcp_tool" ? r.toolName ?? "MCP action" : r.objectType === "connector_call" ? r.toolName ?? "Connector write" : approvalStageLabel(r) ?? r.stageId ?? r.objectType;

/**
 * Mirrors `APPROVAL_OBJECT_TYPES` in @regulait/shared — the kinds THE ONE
 * QUEUE holds. The SPA deliberately does not import the shared package (the
 * convention used for every other mirrored enum here), and the gateway parses
 * this parameter with that exact enum, so a value drifting out of the shared
 * list fails LOUDLY with a 400.
 *
 * The other direction is quieter and worth naming: a kind added server-side and
 * forgotten here is simply missing from this select. It is still in the queue and
 * still decidable — only unfilterable — so the failure is a narrowing that cannot
 * be reached, not a row that cannot be seen.
 */
const OBJECT_TYPES: Array<[string, string]> = [
  ["mcp_tool", "MCP tool call"],
  ["workflow", "workflow stage sign-off"],
  ["run", "agent run escalation"],
  ["project", "project budget overage"],
  ["infra_operation", "infrastructure operation"],
  ["model_card", "model-card sign-off (MRM)"],
  ["copilot_proposal", "governance-copilot proposal"],
  ["training_job", "RegulAIt-LLM training run"],
  ["grant_certification", "certification-campaign item"],
  ["sod_override", "separation-of-duties override"],
  ["remediation", "governance-alert remediation"],
  ["prompt_promotion", "prompt promotion to prod"],
  ["connector_call", "connector write (execution hold)"],
];

export default function ApprovalsAdminPage() {
  const [searchParams] = useSearchParams();
  const { auth } = useSession();
  const me = auth?.userId ?? null;
  const act = useAction();
  const users = useUsers();
  // The queue shipped unfiltered, and `GET /v1/approvals` has supported a
  // `status` filter all along — the UI simply never sent one. On a fleet-wide
  // inbox that is the difference between "the one inbox" and a list nobody can
  // work: a decided approval never leaves, so the pending items an approver is
  // actually accountable for sink under months of settled ones.
  //
  // The filter is SERVER-SIDE (a query parameter, not a client-side array
  // filter) on purpose: the queue's materialization and visibility rules run
  // inside that endpoint, so filtering after the fact would be filtering a list
  // the server already decided you could see, one page at a time.
  //
  // B9b widened it from one dimension to three, and the reason is the row cap
  // rather than convenience: the queue is fleet-wide and returns at most 100
  // rows, so with only `status` the copilot proposals waiting on one person may
  // not be IN the response at all. `objectType` and `approverUserId` narrow in
  // the endpoint for the same reason `status` does.
  const [status, setStatus] = useState<string>(() => searchParams.get("status") ?? "pending");
  const [objectType, setObjectType] = useState<string>(() => searchParams.get("objectType") ?? "");
  const [approver, setApprover] = useState<string>(() => searchParams.get("approverUserId") ?? "");
  const filters = { status, objectType, approverUserId: approver };
  const queueUrl = () => {
    const p = new URLSearchParams();
    if (status) p.set("status", status);
    if (objectType) p.set("objectType", objectType);
    if (approver) p.set("approverUserId", approver);
    const qs = p.toString();
    return qs ? `/v1/approvals?${qs}` : "/v1/approvals";
  };
  const q = useQuery({
    queryKey: ["approvals", status, objectType, approver],
    queryFn: () => api.get<{ approvals: Approval[] }>(queueUrl()),
  });
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});

  const decide = async (row: Approval, decision: "approved" | "denied") => {
    if (decision === "approved" && isBoundAction(row)) {
      const blocked = inspectApprovalAction(row).blockedReason;
      if (blocked) { setRowErrors((errors) => ({ ...errors, [row.id]: blocked })); return; }
    }
    const reason = (reasons[row.id] ?? "").trim();
    const override = me !== row.approverUserId && !row.delegatedFrom;
    setRowErrors((e) => ({ ...e, [row.id]: "" }));
    if (override && !reason) {
      setRowErrors((e) => ({
        ...e,
        [row.id]: "You are not the named approver — an admin override requires a recorded reason.",
      }));
      return;
    }
    if (row.selfReview && !reason) {
      setRowErrors((e) => ({
        ...e,
        [row.id]: "This is a self-review (the decider would be approving their own request) — a reason is required.",
      }));
      return;
    }
    await act.run(
      () => api.post(`/v1/approvals/${row.id}/decide`, { decision, ...(reason ? { reason } : {}) }),
      "Decision recorded",
    );
  };

  const rows = q.data?.approvals ?? [];
  return (
    <>
      <PageHeader
        title="Approvals queue"
        sub="The one inbox, fleet-wide."
        info={<p>The one inbox, fleet-wide. The named approver decides; an active delegation lets the delegate decide on-behalf-of (both audited); an admin may decide in anyone's place only with a recorded reason (audit-marked as an override).</p>}
      />
      <div className={v.stack}>
        <Card flush>
          <div className={a.formRow} style={{ padding: "var(--s2) var(--s2) 0" }}>
            <Field label="Status">
              <Select value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="pending">pending — awaiting a decision</option>
                <option value="approved">approved</option>
                <option value="denied">denied</option>
                <option value="consumed">consumed — the approved call has since run</option>
                <option value="superseded">superseded</option>
                <option value="">— every status —</option>
              </Select>
            </Field>
            <Field label="Kind">
              <Select value={objectType} onChange={(e) => setObjectType(e.target.value)}>
                <option value="">— every kind —</option>
                {OBJECT_TYPES.map(([value, label]) => (
                  <option key={value} value={value}>
                    {value} — {label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Approver">
              <Select value={approver} onChange={(e) => setApprover(e.target.value)}>
                {optionEls(userOpts(users.data?.users), "— anyone —")}
              </Select>
            </Field>
            <span className={v.faint} style={{ alignSelf: "center" }}>
              {q.data ? `${q.data.approvals.length} shown` : ""}
              {q.data && q.data.approvals.length === 100 ? " (the cap — narrow further)" : ""}
            </span>
          </div>
          <Table<Approval>
            columns={[
              { key: "type", header: "Type", sort: (r) => r.objectType, render: (r) => r.objectType },
              { key: "stage", header: "Stage", render: (r) => labelOf(r) },
              { key: "governs", header: "Governs", render: (r) => (isIntakeSignoff(r) ? intakeUseCaseName(r) : r.objectLabel) ?? "—" },
              { key: "requestedBy", header: "Requested by", render: (r) => r.requestedByName ?? "—" },
              {
                key: "approver",
                header: "Approver",
                render: (r) => r.approverName ?? r.approverUserId,
              },
              {
                key: "status",
                header: "Status",
                sort: (r) => r.status,
                render: (r) => <StatusBadge status={r.status} />,
              },
              {
                key: "requested",
                header: "Requested",
                sort: (r) => r.requestedAt,
                render: (r) => ago(r.requestedAt),
              },
              {
                key: "decide",
                header: "",
                align: "right",
                render: (r) => {
                  if (r.status !== "pending") {
                    if (isBoundAction(r)) return <McpActionReview approval={r} />;
                    return r.decisionReason ? (
                      <span className={v.faint} title={r.decisionReason}>
                        “{r.decisionReason.slice(0, 40)}”
                      </span>
                    ) : null;
                  }
                  // an AI use-case sign-off is decided as a task, with its evidence beside it
                  if (isIntakeSignoff(r)) return <ReviewPanel approval={r} onDecided={() => void q.refetch()} />;
                  const override = me !== r.approverUserId && !r.delegatedFrom;
                  const controls = (blockedReason: string | null) => (
                    <span className={v.rowTight} style={{ justifyContent: "flex-end", flexWrap: "wrap" }}>
                      {override && <Badge tone="warn">override</Badge>}
                      {r.selfReview && <Badge tone="warn">self-review</Badge>}
                      <Input
                        style={{ width: 160, fontSize: "var(--text-xs)" }}
                        placeholder={override ? "reason (override)" : "reason (optional)"}
                        aria-label={`Reason for ${labelOf(r)}`}
                        value={reasons[r.id] ?? ""}
                        onChange={(e) => setReasons((s) => ({ ...s, [r.id]: e.target.value }))}
                      />
                      <Button size="sm" disabled={act.busy || !!blockedReason} onClick={() => void decide(r, "approved")}>
                        approve
                      </Button>
                      <Button size="sm" variant="ghost" disabled={act.busy} onClick={() => void decide(r, "denied")}>
                        deny
                      </Button>
                      {rowErrors[r.id] && (
                        <span className={v.errLine} role="alert">
                          {rowErrors[r.id]}
                        </span>
                      )}
                      {isBoundAction(r) && act.error && <span role="alert">{act.error}</span>}
                    </span>
                  );
                  return isBoundAction(r)
                    ? <McpActionReview approval={r} controls={controls} />
                    : controls(null);
                },
              },
            ]}
            rows={rows}
            rowKey={(r) => r.id}
            loading={q.isLoading}
            error={q.error}
            onRetry={() => void q.refetch()}
            empty={
              <EmptyState
                title="Nothing waiting anywhere"
                body="When any governed action pauses for a decision it appears here — fleet-wide, not just yours."
              />
            }
          />
        </Card>
        <SavedViewsCard
          filters={filters}
          onApply={(f) => {
            setStatus(typeof f.status === "string" ? f.status : "");
            setObjectType(typeof f.objectType === "string" ? f.objectType : "");
            setApprover(typeof f.approverUserId === "string" ? f.approverUserId : "");
          }}
        />
        <DelegationsCard />
      </div>
    </>
  );
}

/**
 * SAVED VIEWS — the ADR-0046 feature that shipped with no UI at all.
 *
 * `GET/POST/DELETE /v1/approvals/views` have existed since migration 0058 and
 * nothing in the portal called them, which the affordance census caught from the
 * DELETE side. On a fleet-wide queue this is not a nicety: the three filters
 * above are how an approver finds their own work, and retyping them on every
 * visit is how a queue tool stops being used.
 *
 * Two properties are rendered rather than documented, because both are decisions
 * the gateway makes and a UI can quietly contradict:
 *
 *  - **A SHARED view is an admin act.** `POST` refuses `shared: true` from a
 *    non-admin by name (`shared_view_admin_only`), so the control is offered and
 *    the refusal is surfaced verbatim rather than the checkbox being hidden — a
 *    hidden control reads as a missing feature.
 *  - **A shared view is not yours to delete unless you are an admin.** `DELETE`
 *    refuses with `not_your_view`. `RemoveButton`'s blocked state states that on
 *    the row instead of the button being absent.
 *
 * The stored `filters` object holds exactly the three parameters the page sends
 * to the endpoint, and nothing else. A saved view carrying a filter the queue
 * endpoint cannot apply would be a view that silently does less than it says.
 */
function SavedViewsCard(props: {
  filters: Record<string, string>;
  onApply: (filters: Record<string, unknown>) => void;
}) {
  const { auth } = useSession();
  const isAdmin = auth?.isAdmin ?? false;
  const act = useApiAction();
  const q = useQuery({
    queryKey: ["approvals", "views"],
    queryFn: () =>
      api.get<{ views: Array<{ id: string; name: string; filters: Record<string, unknown>; sort: string; shared: boolean; userId: string | null }> }>(
        "/v1/approvals/views",
      ),
  });
  const [name, setName] = useState("");
  const [shared, setShared] = useState(false);

  const describe = (f: Record<string, unknown>): string => {
    const parts = [
      f.status ? `status ${String(f.status)}` : "every status",
      f.objectType ? `kind ${String(f.objectType)}` : "every kind",
      f.approverUserId ? "one approver" : "any approver",
    ];
    return parts.join(" · ");
  };

  const save = () =>
    void act
      .run(
        () =>
          api.post("/v1/approvals/views", {
            name: name.trim(),
            // exactly the three parameters the queue endpoint applies — empty
            // strings dropped, so an unset filter is absent rather than ""
            filters: Object.fromEntries(Object.entries(props.filters).filter(([, val]) => val !== "")),
            sort: "requested_at_desc",
            shared,
          }),
        shared ? "View published for everyone" : "View saved (private to you)",
      )
      .then((res) => {
        if (res) {
          setName("");
          void q.refetch();
        }
      });

  return (
    <Card title="Saved views">
      <p className={v.faint}>
        A view stores the three filters above — the ones the queue endpoint itself applies. Saving one changes nothing
        about who may see or decide anything; it is a bookmark over the same visibility rules.
      </p>
      <form
        className={a.formRow}
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <Field label="Name this view" grow>
          <Input required value={name} onChange={(e) => setName(e.target.value)} maxLength={200} placeholder="My pending copilot proposals" />
        </Field>
        <label style={{ display: "inline-flex", gap: 6, alignItems: "center", whiteSpace: "nowrap" }}>
          <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} />
          <span>share with everyone</span>
        </label>
        <Button type="submit" size="sm" disabled={act.busy || name.trim() === ""}>
          Save current filters
        </Button>
      </form>
      <p className={v.dim}>Currently: {describe(props.filters)}</p>
      {/* the gateway's own refusal, verbatim — a non-admin ticking "share" gets
          `shared_view_admin_only` and needs to read it, not guess */}
      <OutcomePanel outcome={act.outcome} testId="saved-view-outcome" />
      {(q.data?.views ?? []).length === 0 ? (
        <EmptyState
          title="No saved views yet"
          body="Set the filters above to the slice you work, then name and save it."
        />
      ) : (
        <Table<{ id: string; name: string; filters: Record<string, unknown>; shared: boolean }>
          rows={q.data?.views ?? []}
          rowKey={(r) => r.id}
          columns={[
            { key: "name", header: "View", render: (r) => r.name },
            {
              key: "shared",
              header: "Visibility",
              render: (r) =>
                r.shared ? <Badge tone="info">shared</Badge> : <Badge tone="neutral">private to you</Badge>,
            },
            { key: "what", header: "Shows", render: (r) => <span className={v.dim}>{describe(r.filters)}</span> },
            {
              key: "apply",
              header: "",
              render: (r) => (
                <Button size="sm" onClick={() => props.onApply(r.filters)}>
                  Apply
                </Button>
              ),
            },
            {
              key: "remove",
              header: "",
              align: "right",
              render: (r) => (
                <RemoveButton
                  what={`the view ${r.name}`}
                  // The endpoint refuses `not_your_view` for a shared view a
                  // non-admin does not own. Saying so on the row is the point:
                  // an absent button is indistinguishable from an absent feature.
                  disabledReason={
                    r.shared && !isAdmin
                      ? "this view was published for everyone, so only an admin can withdraw it — save your own private copy instead"
                      : undefined
                  }
                  consequence={
                    <p>
                      The view is deleted for {r.shared ? "everyone" : "you"}. No approval, decision or visibility rule
                      changes — a view is a saved filter, not a permission.
                    </p>
                  }
                  onRemove={() => api.del(`/v1/approvals/views/${r.id}`)}
                  onDone={() => void q.refetch()}
                />
              ),
            },
          ]}
        />
      )}
    </Card>
  );
}

function DelegationsCard() {
  const users = useUsers();
  const act = useAction();
  const q = useQuery({
    queryKey: ["admin", "delegations"],
    queryFn: () => api.get<{ delegations: Delegation[] }>("/v1/delegations"),
  });
  const [fromUserId, setFrom] = useState("");
  const [toUserId, setTo] = useState("");
  const [startsAt, setStarts] = useState("");
  const [endsAt, setEnds] = useState("");
  const [reason, setReason] = useState("");
  const [endNow, setEndNow] = useState<Delegation | null>(null);

  const status = (d: Delegation) =>
    d.active ? "active" : new Date(d.endsAt).getTime() < Date.now() ? "expired" : "scheduled";

  return (
    <Card title="Approver delegations — vacation / offboarding coverage">
      <form
        className={a.formRow}
        onSubmit={(e) => {
          e.preventDefault();
          void act.run(
            () =>
              api.post("/v1/delegations", {
                fromUserId,
                toUserId,
                startsAt: new Date(startsAt).toISOString(),
                endsAt: new Date(endsAt).toISOString(),
                ...(reason ? { reason } : {}),
              }),
            "Delegation created",
          );
        }}
      >
        <Field label="Delegator (from)">
          <Select required value={fromUserId} onChange={(e) => setFrom(e.target.value)}>
            {optionEls(userOpts(users.data?.users), "— select —")}
          </Select>
        </Field>
        <Field label="Delegate (to)">
          <Select required value={toUserId} onChange={(e) => setTo(e.target.value)}>
            {optionEls(userOpts(users.data?.users), "— select —")}
          </Select>
        </Field>
        <Field label="Starts">
          <Input required type="datetime-local" value={startsAt} onChange={(e) => setStarts(e.target.value)} />
        </Field>
        <Field label="Ends">
          <Input required type="datetime-local" value={endsAt} onChange={(e) => setEnds(e.target.value)} />
        </Field>
        <Field label="Reason (recorded)">
          <Input value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        <Button type="submit" size="sm" disabled={act.busy}>
          Create delegation
        </Button>
      </form>
      {act.error && (
        <div className={v.errLine} role="alert">
          {act.error}
        </div>
      )}
      <Table<Delegation>
        columns={[
          { key: "from", header: "From", render: (d) => d.fromName ?? d.fromUserId },
          { key: "to", header: "To", render: (d) => d.toName ?? d.toUserId },
          {
            key: "window",
            header: "Window",
            render: (d) => (
              <span className={v.mono}>
                {String(d.startsAt).slice(0, 16).replace("T", " ")} →{" "}
                {String(d.endsAt).slice(0, 16).replace("T", " ")}
              </span>
            ),
          },
          {
            key: "status",
            header: "Status",
            render: (d) => {
              const s = status(d);
              return <Badge tone={s === "active" ? "ok" : s === "expired" ? "neutral" : "info"}>{s}</Badge>;
            },
          },
          { key: "reason", header: "Reason", render: (d) => d.reason ?? "—" },
          {
            key: "actions",
            header: "",
            align: "right",
            render: (d) => (
              <Button size="sm" variant="danger" onClick={() => setEndNow(d)}>
                end now
              </Button>
            ),
          },
        ]}
        rows={q.data?.delegations ?? []}
        rowKey={(d) => d.id}
        loading={q.isLoading}
        error={q.error}
        onRetry={() => void q.refetch()}
        empty={<EmptyState title="No delegation windows" />}
      />
      <p className={v.faint}>
        While a window is active, the delegate's inbox additionally shows the delegator's PENDING approvals
        and the delegate may decide them; the decision records the real decider plus an on-behalf-of audit
        row. Ending a delegation takes effect immediately. The org-wide master switch lives in Settings →
        Organization.
      </p>
      <ConfirmModal
        open={endNow !== null}
        title="End this delegation now?"
        body="The delegate immediately stops seeing the delegator's pending approvals."
        danger
        confirmLabel="End now"
        onCancel={() => setEndNow(null)}
        onConfirm={() => {
          const d = endNow;
          setEndNow(null);
          if (d) void act.run(() => api.del(`/v1/delegations/${d.id}`), "Delegation ended");
        }}
      />
    </Card>
  );
}
