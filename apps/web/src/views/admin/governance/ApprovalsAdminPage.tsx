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
import { optionEls, useAction, useUsers, userOpts } from "../adminKit";
import a from "../admin.module.css";
import v from "../../views.module.css";

const labelOf = (r: Approval) => approvalStageLabel(r) ?? r.stageId ?? r.objectType;

export default function ApprovalsAdminPage() {
  const { auth } = useSession();
  const me = auth?.userId ?? null;
  const act = useAction();
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
  const [status, setStatus] = useState<string>("pending");
  const q = useQuery({
    queryKey: ["approvals", status],
    queryFn: () =>
      api.get<{ approvals: Approval[] }>(
        status ? `/v1/approvals?status=${encodeURIComponent(status)}` : "/v1/approvals",
      ),
  });
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});

  const decide = async (row: Approval, decision: "approved" | "denied") => {
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
            <span className={v.faint} style={{ alignSelf: "center" }}>
              {q.data ? `${q.data.approvals.length} shown` : ""}
            </span>
          </div>
          <Table<Approval>
            columns={[
              { key: "type", header: "Type", sort: (r) => r.objectType, render: (r) => r.objectType },
              { key: "stage", header: "Stage", render: (r) => labelOf(r) },
              { key: "governs", header: "Governs", render: (r) => r.objectLabel ?? "—" },
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
                    return r.decisionReason ? (
                      <span className={v.faint} title={r.decisionReason}>
                        “{r.decisionReason.slice(0, 40)}”
                      </span>
                    ) : null;
                  }
                  const override = me !== r.approverUserId && !r.delegatedFrom;
                  return (
                    <span className={v.rowTight} style={{ justifyContent: "flex-end" }}>
                      {override && <Badge tone="warn">override</Badge>}
                      {r.selfReview && <Badge tone="warn">self-review</Badge>}
                      <Input
                        style={{ width: 160, fontSize: "var(--text-xs)" }}
                        placeholder={override ? "reason (override)" : "reason (optional)"}
                        aria-label={`Reason for ${labelOf(r)}`}
                        value={reasons[r.id] ?? ""}
                        onChange={(e) => setReasons((s) => ({ ...s, [r.id]: e.target.value }))}
                      />
                      <Button size="sm" variant="primary" disabled={act.busy} onClick={() => void decide(r, "approved")}>
                        approve
                      </Button>
                      <Button size="sm" variant="danger" disabled={act.busy} onClick={() => void decide(r, "denied")}>
                        deny
                      </Button>
                      {rowErrors[r.id] && (
                        <span className={v.errLine} role="alert">
                          {rowErrors[r.id]}
                        </span>
                      )}
                    </span>
                  );
                },
              },
            ]}
            rows={rows}
            rowKey={(r) => r.id}
            loading={q.isLoading}
            empty={
              <EmptyState
                title="Nothing waiting anywhere"
                body="When any governed action pauses for a decision it appears here — fleet-wide, not just yours."
              />
            }
          />
        </Card>
        <DelegationsCard />
      </div>
    </>
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
