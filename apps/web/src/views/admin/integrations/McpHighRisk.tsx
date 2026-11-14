/**
 * Offensive MCP tooling as high-risk: on a selected server, its classification, whether the policy template (a
 * quorum approval rule and a rate limit) is applied, "Mark as high-risk" and "Apply high-risk policy" (both only
 * tighten, so neither asks for a step-up); and the authorised-targets list every high-risk call is held to. Adding a
 * target widens it, so it goes through `withStepUp`; removing one narrows it and asks for a confirmation only.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, ApiError } from "../../../api/client";
import type { McpServer } from "../../../api/adminTypes";
import { fmtAt } from "../../../api/format";
import { api as stepUpApi, withStepUp } from "../../../stepup/stepUp";
import { RefusalNotice } from "../../../ui/RefusalNotice";
import { Badge, Button, Card, ConfirmModal, EmptyState, Field, IdChip, Input, RecordError, RowActions, Select, SkeletonBlock, Table, Textarea } from "../../../ui/kit";
import { optionEls, roleOpts, useAction, useRoles, useUsers, userOpts } from "../adminKit";
import { TARGET_KIND_LABEL, findingWords, type AuthorisedTarget, type AuthorisedTargetKind, type HighRiskPolicyView } from "./mcpPinningModel";
import v from "../../views.module.css";
import m from "./mcpPinning.module.css";

export function ActionError(props: { act: ReturnType<typeof useAction> }) {
  return (
    <>
      {props.act.error && (
        <p className={v.errLine} role="alert">
          {props.act.error}
        </p>
      )}
      <RefusalNotice guidance={props.act.guidance} />
    </>
  );
}

const on = (iso: string | null) => (iso ? ` on ${fmtAt(iso)}` : "");

export function McpHighRiskCard(props: { server: McpServer | undefined }) {
  return props.server ? <HighRiskBody key={props.server.id} server={props.server} /> : null;
}

function HighRiskBody({ server: { id, name } }: { server: McpServer }) {
  const q = useQuery({
    queryKey: ["admin", "mcp-high-risk", id],
    queryFn: () => api.get<HighRiskPolicyView>(`/v1/servers/${id}/high-risk-policy`),
  });
  const act = useAction();
  const users = useUsers();
  const roles = useRoles();
  const [reason, setReason] = useState("");
  const [confirmMark, setConfirmMark] = useState(false);
  const [approver, setApprover] = useState("");
  const [role, setRole] = useState("");
  const [checked, setChecked] = useState(false);

  const view = q.data;
  if (!view) {
    return <Card title="High-risk tooling">{q.isLoading ? <SkeletonBlock lines={3} /> : <RecordError noun="server" error={q.error} onRetry={() => void q.refetch()} />}</Card>;
  }
  const high = view.riskClass === "high";
  const words = findingWords(view);
  const mark = () => {
    setConfirmMark(false);
    void act.run(() => api.post(`/v1/servers/${id}/risk-class`, { reason: reason.trim() }), `${name} marked as high-risk`).then((ok) => {
      if (!ok) return;
      setReason("");
      setChecked(false);
    });
  };
  const apply = () => {
    setChecked(true);
    if (!approver) return;
    // the template's own defaults are its strictest: 2 approvals, 20 calls an hour
    const body = { approverUserId: approver, approverRoleId: role || null };
    void act.run(() => api.post(`/v1/servers/${id}/high-risk-policy`, body), `High-risk policy applied to ${name}`);
  };

  return (
    <Card
      title="High-risk tooling"
      actions={<Badge tone={high ? "danger" : "neutral"}>{high ? "High risk" : "Standard"}</Badge>}
    >
      <p>
        {!high
          ? "No offensive tooling found. Mark it high-risk if its tools scan, exploit or attack under neutral names."
          : words.length
            ? `Classified high-risk${on(view.riskClassifiedAt)} for ${words.join(", ")}.`
            : `Marked high-risk by an admin${on(view.riskClassifiedAt)}.`}
      </p>
      {view.mode === "off" && (
        <p role="note" className={v.errLine}>
          High-risk enforcement is off for this organisation: the policy and the target list are not applied.
        </p>
      )}
      {high && (
        <p className={v.row}>
          Policy: <Badge tone={view.policyApplied ? "ok" : "danger"}>{view.policyApplied ? "Applied" : "Not applied: every call is refused"}</Badge>
          {view.approvalRuleId && <>approval rule <IdChip id={view.approvalRuleId} /></>}
          {view.rateLimitId && <>rate limit <IdChip id={view.rateLimitId} /></>}
        </p>
      )}
      {!high ? (
        <form
          aria-label={`Mark ${name} as high-risk`}
          onSubmit={(e) => {
            e.preventDefault();
            setChecked(true);
            if (reason.trim()) setConfirmMark(true);
          }}
        >
          <Field label="Why it is high-risk (required, audited)" error={checked && !reason.trim() ? "Say why" : null} grow>
            <Textarea value={reason} maxLength={2000} rows={2} onChange={(e) => setReason(e.target.value)} />
          </Field>
          <Button type="submit" variant="primary" disabled={act.busy}>
            Mark as high-risk
          </Button>
        </form>
      ) : (
        !view.policyApplied && (
          <form
            aria-label={`Apply high-risk policy to ${name}`}
            onSubmit={(e) => {
              e.preventDefault();
              apply();
            }}
          >
            <div className={v.row}>
              <Field label="Approver" error={checked && !approver ? "Choose who approves" : null}>
                <Select value={approver} onChange={(e) => setApprover(e.target.value)}>
                  {optionEls(userOpts(users.data?.users), "Choose a person")}
                </Select>
              </Field>
              <Field label="Approver role (optional)">
                <Select value={role} onChange={(e) => setRole(e.target.value)}>
                  {optionEls(roleOpts(roles.data?.roles), "No role")}
                </Select>
              </Field>
            </div>
            <p className={v.dim}>Each call then needs 2 approvals (never the requester's own), and at most 20 calls an hour run.</p>
            <Button type="submit" variant="primary" disabled={act.busy}>
              Apply high-risk policy
            </Button>
          </form>
        )
      )}
      <ActionError act={act} />
      <ConfirmModal
        open={confirmMark}
        danger
        title={`Mark ${name} as high-risk?`}
        confirmLabel="Mark as high-risk"
        body={<p>Every call is refused until the policy is applied, and must name an authorised target. It cannot be lowered back to standard.</p>}
        onCancel={() => setConfirmMark(false)}
        onConfirm={mark}
      />
    </Card>
  );
}

/** The authorised targets of every high-risk MCP server. */
export function McpAuthorisedTargetsCard() {
  const q = useQuery({
    queryKey: ["admin", "mcp-authorised-targets"],
    queryFn: () => api.get<{ targets: AuthorisedTarget[] }>("/v1/mcp/authorised-targets"),
  });
  const users = useUsers();
  const act = useAction();
  const [kind, setKind] = useState<AuthorisedTargetKind>("host");
  const [value, setValue] = useState("");
  const [note, setNote] = useState("");
  const [checked, setChecked] = useState(false);
  const [shown, setShown] = useState(25);
  const [removing, setRemoving] = useState<AuthorisedTarget | null>(null);
  const rows = q.data?.targets;
  const who = (id: string | null) => users.data?.users.find((u) => u.id === id)?.displayName ?? "an admin";

  const add = () => {
    setChecked(true);
    const body = { kind, value: value.trim(), note: note.trim() };
    if (!body.value || !body.note) return;
    void act
      .run(async () => {
        try {
          await withStepUp((h) => stepUpApi.post("/v1/mcp/authorised-targets", body, h));
        } catch (e) {
          throw e instanceof ApiError && e.status === 409 ? new Error(`${body.value} is already on the list. Nothing was added.`) : e;
        }
      }, `${body.value} added`)
      .then((ok) => {
        if (!ok) return;
        setValue("");
        setNote("");
        setChecked(false);
      });
  };
  const remove = (t: AuthorisedTarget) => {
    setRemoving(null);
    void act.run(() => api.del(`/v1/mcp/authorised-targets/${t.id}`), `${t.value} removed`);
  };

  return (
    <Card
      title="Authorised targets"
      count={rows ? rows.length : null}
      countNoun={["target", "targets"]}
    >
      <Table<AuthorisedTarget>
        columns={[
          { key: "target", header: "Target", render: (t) => <><span className={v.mono}>{t.value}</span> <span className={v.dim}>{TARGET_KIND_LABEL[t.kind]}</span></> },
          { key: "note", header: "Note", render: (t) => t.note },
          { key: "added", header: "Added", render: (t) => `${who(t.createdBy)}, ${fmtAt(t.createdAt)}` },
          {
            key: "actions",
            header: <span className={m.srOnly}>Actions</span>,
            render: (t) => (
              <RowActions
                secondary={
                  <Button size="sm" variant="danger" disabled={act.busy} aria-label={`Remove ${t.value}`} onClick={() => setRemoving(t)}>
                    Remove
                  </Button>
                }
              />
            ),
          },
        ]}
        rows={rows?.slice(0, shown)}
        rowKey={(t) => t.id}
        loading={q.isLoading}
        error={q.error}
        onRetry={() => void q.refetch()}
        empty={<EmptyState title="No authorised targets" body="Calls to a high-risk server are refused until their targets are listed." />}
      />
      {(rows?.length ?? 0) > shown && (
        <Button size="sm" onClick={() => setShown(shown + 25)}>
          Show more targets
        </Button>
      )}
      <form
        aria-label="Add an authorised target"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <div className={v.row}>
          <Field label="Kind">
            <Select value={kind} onChange={(e) => setKind(e.target.value as AuthorisedTargetKind)}>
              {optionEls(Object.entries(TARGET_KIND_LABEL).map(([k, l]) => ({ v: k, l })))}
            </Select>
          </Field>
          <Field label="Target" error={checked && !value.trim() ? "Enter the target" : null}>
            <Input value={value} placeholder="scan-lab.example.test" spellCheck={false} autoComplete="off" onChange={(e) => setValue(e.target.value)} />
          </Field>
          <Field label="Note (required, audited)" error={checked && !note.trim() ? "Say why it may be targeted" : null} grow>
            <Input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
          </Field>
        </div>
        <Button type="submit" variant="primary" disabled={act.busy}>
          Add target
        </Button>
        <p className={v.dim}>Adding a target widens what high-risk servers may reach, so you will be asked to confirm it's you.</p>
        <ActionError act={act} />
      </form>
      <ConfirmModal
        open={!!removing}
        danger
        title={`Remove ${removing?.value}?`}
        confirmLabel="Remove target"
        body={<p>Calls that name it are refused from then on.</p>}
        onCancel={() => setRemoving(null)}
        onConfirm={() => removing && remove(removing)}
      />
    </Card>
  );
}
