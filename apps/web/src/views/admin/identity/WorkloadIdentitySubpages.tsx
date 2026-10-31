/**
 * The workload identities' full lists on their own pages (P3, #453 c6527514889; ADR-0188 S6): every identity with the
 * shared list control and its filters, and one identity's grant proposals with the selection and Accept. The
 * overview keeps a preview of each, with what needs attention counted in the heading.
 */
import { useMemo, useState } from "react";
import { Link, Route, Routes, useParams } from "react-router-dom";
import WorkloadIdentitiesPage from "./WorkloadIdentitiesPage";
import { useQuery } from "@tanstack/react-query";
import { PageHeader } from "../../../shell/AppShell";
import { Card, EmptyState, ErrorState, Field, Select, SkeletonBlock } from "../../../ui/kit";
import { DataList } from "../../../ui/DataList";
import { SubpageTrail } from "../../../ui/ListPreview";
import { useAgents, useConnectors, useServers } from "../adminKit";
import { getWorkloadIdentity, workloadIdentityKeys } from "./workloadIdentityApi";
import { workloadKindLabels, type WorkloadIdentityView } from "./workloadIdentityModel";
import { GrantProposals, IdentityConfirm, StatusBadge, useIdentityWrite, type Confirmation } from "./WorkloadIdentitiesPage";
import { fmtDateTime } from "../../../api/format";
import s from "./workloadIdentities.module.css";

type WorkloadIdentityRow = WorkloadIdentityView & { stewardNames?: string | null };

export function WorkloadIdentitiesListPage() {
  const [status, setStatus] = useState("");
  const [kind, setKind] = useState("");
  const filters = useMemo(() => ({ status: status || undefined, kind: kind || undefined }), [status, kind]);
  return (
    <>
      <SubpageTrail parent="Workload identities" parentTo="/admin/workload-identities" current="Identities" />
      <PageHeader title="Identities" sub="Every agent principal's own identity, its stewards, environments and status." />
      <Card flush>
        <div className={s.actions} style={{ padding: "var(--s1) var(--s2) 0" }}>
          <Field label="Status">
            <Select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">Any</option>
              <option value="active">active</option>
              <option value="suspended">suspended</option>
              <option value="revoked">revoked</option>
            </Select>
          </Field>
          <Field label="Kind">
            <Select value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="">Any</option>
              {Object.entries(workloadKindLabels).map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <DataList<WorkloadIdentityRow>
          listId="workload-identities"
          noun="workload identities"
          endpoint="/v1/workload-identities"
          exportPath="/v1/workload-identities/export.xlsx"
          queryKey={workloadIdentityKeys.list}
          legacyKey="items"
          errorMessage="Workload identities could not be read. No empty or active state is inferred."
          filters={filters}
          defaultSort={{ key: "created", dir: "desc" }}
          rowKey={(i) => i.id}
          empty={
            <EmptyState title="No workload identities" body="No agent has an identity of its own yet. Nothing is granted to an agent by default." />
          }
          columns={[
            { key: "identifier", header: "Identifier", main: true, sortable: true, render: (i) => <span className={s.identifier}>{i.identifier}</span> },
            { key: "kind", header: "Kind", main: true, sortable: true, render: (i) => workloadKindLabels[i.kind] ?? i.kind },
            { key: "stewards", header: "Stewards", main: true, sortable: true, render: (i) => i.stewardNames ?? "No steward recorded" },
            { key: "environments", header: "Environments", main: true, sortable: true, render: (i) => i.environments.join(", ") || "None allowed" },
            { key: "status", header: "Status", main: true, sortable: true, required: "Status is always shown", render: (i) => <StatusBadge status={i.status} /> },
            { key: "created", header: "Created", sortable: true, render: (i) => fmtDateTime(i.createdAt) },
            { key: "updated", header: "Updated", sortable: true, render: (i) => fmtDateTime(i.updatedAt) },
            {
              key: "manage",
              header: "Manage",
              action: true,
              render: (i) => (
                <Link to={`/admin/workload-identities?identity=${encodeURIComponent(i.id)}`} aria-label={`Manage ${i.identifier}`}>
                  Manage
                </Link>
              ),
            },
          ]}
        />
      </Card>
    </>
  );
}

export function GrantProposalsPage() {
  const { identityId = "" } = useParams();
  const write = useIdentityWrite();
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const detail = useQuery({ queryKey: workloadIdentityKeys.detail(identityId), queryFn: () => getWorkloadIdentity(identityId) });
  const servers = useServers();
  const agents = useAgents();
  const connectors = useConnectors();
  const targetName = (id: string) => {
    const named: Array<{ id: string; name: string }> = [...(servers.data?.servers ?? []), ...(agents.data?.agents ?? []), ...(connectors.data?.connectors ?? [])];
    return named.find((t) => t.id === id)?.name ?? `Not loaded (${id})`;
  };
  const identity = detail.data;
  return (
    <>
      <SubpageTrail parent="Workload identities" parentTo={`/admin/workload-identities?identity=${encodeURIComponent(identityId)}`} current="Grant proposals" />
      <PageHeader title="Grant proposals" sub={identity ? identity.identifier : "Proposed own grants from an identity's observed use."} />
      {write.failure && <ErrorState title="Change not recorded" message={write.failure} onRetry={() => write.setFailure(null)} />}
      <Card>
        {detail.isPending ? (
          <SkeletonBlock lines={4} />
        ) : detail.isError || !identity ? (
          <ErrorState message="This identity could not be read. Nothing is proposed." onRetry={() => void detail.refetch()} />
        ) : identity.status !== "active" ? (
          <p>
            <StatusBadge status={identity.status} /> Only an active identity&apos;s grants can be changed, so nothing is proposed.
          </p>
        ) : (
          <GrantProposals
            identity={identity}
            busy={write.busy}
            targetName={targetName}
            ask={(c) => {
              write.setFailure(null);
              setConfirmation(c);
            }}
          />
        )}
      </Card>
      <IdentityConfirm confirmation={confirmation} onClose={() => setConfirmation(null)} write={write} />
    </>
  );
}

/**
 * The workload-identities area: the overview (with its identities and proposal previews) at the index, the full
 * identities list and one identity's grant proposals each on their own nested route. One lazy chunk mounted at
 * `workload-identities/*`, reached through the identity screen barrel, so the sub-pages add nothing to the entry
 * bundle (ADR-0196 U4; the SPA route census follows this module — scripts/ui-spa-routes.mjs).
 */
export function WorkloadIdentitiesArea() {
  return (
    <Routes>
      <Route index element={<WorkloadIdentitiesPage />} />
      <Route path="identities" element={<WorkloadIdentitiesListPage />} />
      <Route path=":identityId/proposals" element={<GrantProposalsPage />} />
    </Routes>
  );
}
