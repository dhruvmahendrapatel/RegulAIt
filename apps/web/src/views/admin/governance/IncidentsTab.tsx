/**
 * ADR-0182 (ADR-0175 batch D4) A12 — THE USE CASE'S AI INCIDENTS (and its EU
 * AI Act role), as a tab of the use-case record.
 *
 *  - The incidents on this use case (the server scopes them to what the reader
 *    may see), with their next clock; "Report an incident" opens one here.
 *  - The use case's EU AI Act role: `both` (the strict default) starts every
 *    applicable clock. The owner may set it back to `both`; narrowing it to
 *    provider or deployer is an admin's relaxation and needs a reason
 *    (`PUT /v1/use-cases/:id/eu-ai-act-role`, audited with its transition).
 */
import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import { Badge, Button, Card, EmptyState, Field, Select, SeverityBadge } from "../../../ui/kit";
import { DataList, type DataColumn } from "../../../ui/DataList";
import { useSession } from "../../../session/SessionContext";
import { ReasonModal, useAction } from "../adminKit";
import v from "../../views.module.css";
import { ReportIncidentModal } from "../../incidents/ReportIncidentModal";
import { CLOCK_DISCLAIMER, STATUS_TONE, URGENCY_LABEL, URGENCY_TONE, utc, type IncidentListResponse } from "../../incidents/incidentModel";

type Role = "provider" | "deployer" | "both";
const ROLE_LABEL: Record<Role, string> = {
  both: "Provider and deployer (every applicable clock starts)",
  provider: "Provider only (the Article 26(5) 'inform the provider' clock does not start)",
  deployer: "Deployer only",
};

function RoleControl(props: { useCaseId: string }) {
  const { auth } = useSession();
  const isAdmin = Boolean(auth?.isAdmin);
  const act = useAction();
  const uc = useQuery({
    queryKey: ["incidents", "use-case-role", props.useCaseId],
    queryFn: () => api.get<{ useCase: { euAiActRole?: Role; ownerUserId: string | null } }>(`/v1/use-cases/${props.useCaseId}`),
  });
  const [pending, setPending] = useState<Role | null>(null);
  const role = uc.data?.useCase.euAiActRole ?? "both";
  const set = (next: Role, reason?: string) =>
    void act
      .run(() => api.put(`/v1/use-cases/${props.useCaseId}/eu-ai-act-role`, { role: next, ...(reason ? { reason } : {}) }), `EU AI Act role set to ${next}`)
      .then(() => void uc.refetch());
  return (
    <div className={v.stack}>
      <Field
        label="EU AI Act role of the organisation for this system"
        help="Both (the strict default) starts every applicable incident clock. Narrowing it to provider or deployer is an admin's decision, with a reason, and is audited."
      >
        <Select
          value={role}
          disabled={act.busy || uc.isLoading}
          onChange={(e) => {
            const next = e.target.value as Role;
            if (next === "both") set(next);
            else setPending(next);
          }}
        >
          {(Object.keys(ROLE_LABEL) as Role[]).map((r) => (
            <option key={r} value={r} disabled={r !== "both" && !isAdmin && r !== role}>
              {ROLE_LABEL[r]}
            </option>
          ))}
        </Select>
      </Field>
      {role !== "both" && (
        <p className={v.faint}>
          <Badge tone="warn">relaxed</Badge> Fewer clocks start for new incidents on this use case.
        </p>
      )}
      <ReasonModal
        open={pending !== null}
        title={`Narrow the role to ${pending ?? ""}`}
        minLength={10}
        body={<p className={v.faint}>Narrowing the role stops some notification clocks from starting. State why the organisation is only the {pending} of this system.</p>}
        onCancel={() => setPending(null)}
        onConfirm={(reason) => {
          const next = pending!;
          setPending(null);
          set(next, reason);
        }}
      />
      {act.error && (
        <div className={v.errLine} role="alert">
          {act.error}
        </div>
      )}
    </div>
  );
}

type UseCaseIncidentRow = IncidentListResponse["incidents"][number];
/** ADR-0219: a use case's incidents through the register's own list contract (the ids match INCIDENTS_LIST) */
const USE_CASE_INCIDENT_COLUMNS: Array<DataColumn<UseCaseIncidentRow>> = [
  { key: "ref", header: "Incident", main: true, sortable: true, render: (r) => <Link to={`/incidents/${r.id}`}>{`${r.ref} · ${r.title}`}</Link> },
  {
    key: "sev",
    header: "Severity",
    main: true,
    sortable: true,
    required: "Severity is always shown",
    render: (r) => (
      <span style={{ display: "inline-flex", gap: "var(--s0)" }}>
        <SeverityBadge severity={r.severity} />
        {r.serious && <Badge tone="danger">serious</Badge>}
      </span>
    ),
  },
  { key: "status", header: "Status", main: true, sortable: true, required: "Status is always shown", render: (r) => <Badge tone={STATUS_TONE[r.status]}>{r.status}</Badge> },
  {
    key: "clock",
    header: "Next clock",
    main: true,
    sortable: true,
    required: "The next notification clock is always shown",
    render: (r) =>
      r.clocks.nextDue ? (
        <span>
          <Badge tone={URGENCY_TONE[r.clocks.nextDue.urgency]}>{URGENCY_LABEL[r.clocks.nextDue.urgency]}</Badge>{" "}
          <span className={v.faint}>
            {r.clocks.nextDue.paragraph} · due {utc(r.clocks.nextDue.dueAt)}
          </span>
        </span>
      ) : (
        <span className={v.faint}>{r.clocks.total ? "all final" : "none"}</span>
      ),
  },
  { key: "owner", header: "Owner", main: true, sortable: true, render: (r) => r.ownerName ?? <span className={v.faint}>unassigned</span> },
  { key: "created", header: "Reported", sortable: true, render: (r) => utc(r.createdAt) },
  { key: "aware", header: "Aware", sortable: true, render: (r) => utc(r.awareAt) },
];

export function IncidentsTab(props: { useCaseId: string }) {
  const navigate = useNavigate();
  const [reporting, setReporting] = useState(false);
  const filters = useMemo(() => ({ useCaseId: props.useCaseId }), [props.useCaseId]);
  return (
    <Card
      title="Incidents"
      actions={
        <Button size="sm" variant="primary" onClick={() => setReporting(true)}>
          Report an incident
        </Button>
      }
    >
      <div className={v.stack}>
        <p className={v.faint}>
          A serious, high or critical incident holds this use case&apos;s deploy gate until it is closed; marking it resolved does not release it. {CLOCK_DISCLAIMER}
        </p>
        <DataList<UseCaseIncidentRow>
          listId="use-case-incidents"
          noun="incidents"
          endpoint="/v1/incidents"
          exportPath="/v1/incidents/export.xlsx"
          queryKey={["incidents", "use-case", props.useCaseId]}
          legacyKey="incidents"
          filters={filters}
          defaultSort={{ key: "created", dir: "desc" }}
          columns={USE_CASE_INCIDENT_COLUMNS}
          rowKey={(r) => r.id}
          empty={<EmptyState title="No incidents" body="No incident on this use case that you can see." />}
        />
        <RoleControl useCaseId={props.useCaseId} />
      </div>
      <ReportIncidentModal
        open={reporting}
        lockUseCase
        prefill={{ useCaseId: props.useCaseId }}
        onClose={() => setReporting(false)}
        onCreated={(id) => navigate(`/incidents/${id}`)}
      />
    </Card>
  );
}
