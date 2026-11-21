/**
 * ADR-0315 slice 2 (E3, #1117): the "Issued credentials" tab of the Agent credentials page.
 *
 *  - A `DataList` of every credential issued to an agent (ADR-0226 list contract), filtered by audience, grant and
 *    state, with the gateway's Excel export of the same filtered list.
 *  - Revoke one credential by jti, with a required reason. It is a tightening: free (no step-up) and audited. It cannot
 *    be undone, and an outside verifier sees it within about a minute (the status list's refresh window).
 *  - The state shown is only the stored revocation; the helper text says what else stops a credential working, rather
 *    than showing a derived status.
 *
 * Its own lazy chunk, loaded the first time the tab opens. The rules are in `issuedCredentialsModel.ts`.
 */
import { useEffect, useMemo, useReducer, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../../../api/client";
import { fmtDateTime } from "../../../api/format";
import { Badge, Button, EmptyState, Field, Input, Modal, Select, Textarea } from "../../../ui/kit";
import { DataList } from "../../../ui/DataList";
import { RefusalNotice } from "../../../ui/RefusalNotice";
import { useAction } from "../adminKit";
import { withRefusalCopy } from "../governance/refusalCopy";
import {
  grantProblem,
  issuedFilters,
  NO_FILTERS,
  REASON_MAX,
  reasonProblem,
  REVOKE_CLOSED,
  REVOKE_REFUSALS,
  revokeBlockedReason,
  revokeReducer,
  shortJti,
  stateWords,
  type IssuedCredential,
  type IssuedFilterDraft,
} from "./issuedCredentialsModel";
import a from "../admin.module.css";
import v from "../../views.module.css";

const LIST_KEY = ["admin", "agent-credentials-issued", "list"] as const;
const GRANT_DEBOUNCE_MS = 300;

export default function IssuedCredentialsPanel(props: { audiences: ReadonlyArray<{ id: string; name: string }> }) {
  const act = useAction();
  const qc = useQueryClient();
  const [draft, setDraft] = useState<IssuedFilterDraft>(NO_FILTERS);
  // the grant id is typed: the list reads it once typing pauses, so each keystroke is not a request
  const [grantText, setGrantText] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDraft((d) => (d.grantId === grantText ? d : { ...d, grantId: grantText })), GRANT_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [grantText]);
  const filters = useMemo(() => issuedFilters(draft), [draft]);
  const [flow, send] = useReducer(revokeReducer, REVOKE_CLOSED);

  const audienceName = (id: string) => props.audiences.find((x) => x.id === id)?.name ?? "Unknown audience";

  useEffect(() => {
    if (flow.kind !== "revoking") return;
    const { jti, reason } = flow;
    void act
      .run(
        () => withRefusalCopy(() => api.post(`/v1/agent-credentials/issued/${encodeURIComponent(jti)}/revoke`, { reason }), REVOKE_REFUSALS),
        `Credential ${shortJti(jti)} revoked. Outside verifiers see it within about a minute.`,
      )
      .then((done) => {
        send({ type: done ? "done" : "failed" });
        // a refusal may mean it was already revoked: read the list again either way
        if (!done) void qc.invalidateQueries({ queryKey: LIST_KEY });
      });
    // run once per entry into "revoking"
  }, [flow.kind]);

  const asking = flow.kind === "asking" || flow.kind === "revoking" ? flow : null;
  const reasonError = flow.kind === "asking" && flow.tried ? reasonProblem(flow.reason) : null;
  const grantError = grantProblem(grantText);

  return (
    <div className={v.stack}>
      <p className={v.faint}>
        The state here is only a revocation made on this page. A credential also stops working when its grant is revoked,
        its agent is halted or the kill switch is on, without showing as revoked here.
      </p>
      {act.error && flow.kind === "closed" && (
        <div className={v.errLine} role="alert">
          {act.error}
        </div>
      )}
      <div className={a.formRow} role="group" aria-label="Filter issued credentials">
        <Field label="Audience">
          <Select value={draft.audienceId} onChange={(e) => setDraft({ ...draft, audienceId: e.target.value })}>
            <option value="">All audiences</option>
            {props.audiences.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="State">
          <Select value={draft.state} onChange={(e) => setDraft({ ...draft, state: e.target.value as IssuedFilterDraft["state"] })}>
            <option value="issued">Issued</option>
            <option value="revoked">Revoked</option>
            <option value="">All</option>
          </Select>
        </Field>
        <Field label="Grant id" grow error={grantError}>
          <Input value={grantText} onChange={(e) => setGrantText(e.target.value)} placeholder="Any grant" spellCheck={false} autoComplete="off" />
        </Field>
      </div>

      <DataList<IssuedCredential>
        listId="agent-credentials-issued"
        noun="issued credentials"
        endpoint="/v1/agent-credentials/issued"
        exportPath="/v1/agent-credentials/issued/export.xlsx"
        queryKey={LIST_KEY}
        legacyKey="credentials"
        filters={filters}
        defaultSort={{ key: "issued", dir: "desc" }}
        rowKey={(c) => c.jti}
        columns={[
          { key: "jti", header: "Credential", main: true, render: (c) => <span className={v.mono}>{c.jti}</span> },
          { key: "audience", header: "Audience", main: true, render: (c) => audienceName(c.audienceId) },
          { key: "grant", header: "Grant", main: true, render: (c) => <span className={v.mono}>{c.grantId}</span> },
          {
            key: "state",
            header: "State",
            main: true,
            required: "Whether a credential is revoked is always shown",
            render: (c) => {
              const w = stateWords(c);
              return (
                <>
                  <Badge tone={w.tone}>{w.label}</Badge>
                  {c.revokedAt ? <div className={v.faint}>{fmtDateTime(c.revokedAt)}</div> : null}
                </>
              );
            },
          },
          { key: "issued", header: "Issued", main: true, sortable: true, render: (c) => fmtDateTime(c.issuedAt) },
          { key: "expires", header: "Expires", main: true, sortable: true, render: (c) => fmtDateTime(c.expiresAt) },
          { key: "index", header: "Status index", render: (c) => String(c.statusIndex) },
          {
            key: "actions",
            header: "",
            srHeader: "Actions",
            align: "right",
            action: true,
            render: (c) => {
              if (c.state !== "issued") return null;
              const blocked = revokeBlockedReason(c, flow);
              return (
                <Button
                  size="sm"
                  variant="danger"
                  aria-label={`Revoke credential ${c.jti}`}
                  disabled={blocked !== null}
                  title={blocked ?? undefined}
                  onClick={() => send({ type: "open", jti: c.jti })}
                >
                  Revoke
                </Button>
              );
            },
          },
        ]}
        empty={
          <EmptyState
            title={draft.state === "revoked" ? "No revoked credential" : "No credential issued yet"}
            body="An agent gets a credential at the token endpoint, for a registered audience and within its grant. Each one appears here."
          />
        }
      />

      <Modal
        open={asking !== null}
        title={asking ? `Revoke credential ${shortJti(asking.jti)}?` : "Revoke this credential?"}
        onClose={() => send({ type: "cancel" })}
        actions={
          <>
            <Button onClick={() => send({ type: "cancel" })} disabled={flow.kind === "revoking"}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => send({ type: "submit" })}
              disabled={flow.kind === "revoking"}
              aria-describedby={flow.kind === "revoking" ? "revoke-busy" : undefined}
            >
              {flow.kind === "revoking" ? "Revoking…" : "Revoke"}
            </Button>
          </>
        }
      >
        <form
          className={v.stack}
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            send({ type: "submit" });
          }}
        >
          <p>
            The agent can no longer use it. This cannot be undone. A verifier outside RegulAIt sees the change within about a
            minute, when it next reads the status list. It is recorded in the audit trail.
          </p>
          <Field label="Reason" error={reasonError} help={`Required, up to ${REASON_MAX} characters. Kept in the audit trail.`}>
            <Textarea
              value={asking?.reason ?? ""}
              rows={3}
              maxLength={REASON_MAX + 50}
              disabled={flow.kind === "revoking"}
              onChange={(e) => send({ type: "type", reason: e.target.value })}
            />
          </Field>
          {flow.kind === "revoking" ? (
            <p id="revoke-busy" className={v.faint} role="status">
              Revoking the credential; wait for it to finish.
            </p>
          ) : null}
          {act.error && flow.kind === "asking" ? (
            <div className={v.errLine} role="alert">
              {act.error}
            </div>
          ) : null}
          <RefusalNotice guidance={act.guidance} />
        </form>
      </Modal>
    </div>
  );
}
