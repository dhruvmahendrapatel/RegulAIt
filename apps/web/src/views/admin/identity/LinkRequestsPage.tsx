/**
 * Account-link requests on their own page (P3, #453 c6527514889; ADR-0174 §5). The SSO overview keeps a five-row
 * preview of the pending ones; this page has the full list, its status filter, and approve and deny.
 */
import { useMemo, useState } from "react";
import { Route, Routes } from "react-router-dom";
import SsoPage from "./SsoPage";
import { api } from "../../../api/client";
import type { LinkRequest } from "../../../api/adminTypes";
import { PageHeader } from "../../../shell/AppShell";
import { Badge, Button, Card, EmptyState, Field, Select } from "../../../ui/kit";
import { useAction } from "../adminKit";
import v from "../../views.module.css";
import { fmtDateTime } from "../../../api/format";
import { DataList } from "../../../ui/DataList";
import { SubpageTrail } from "../../../ui/ListPreview";

export default function LinkRequestsPage() {
  return (
    <>
      <SubpageTrail parent="SSO & sessions" parentTo="/admin/sso" current="Account-link requests" />
      <PageHeader title="Account-link requests" sub="Federated identities waiting to be linked to an account that has its own password." />
      <LinkRequestsCard />
    </>
  );
}

// ---- ADR-0174 §5: account-link requests ------------------------------------

/**
 * A federated identity that matched an account holding its own password never
 * links silently: the person proves the account at sign-in, or an admin
 * approves here. Approving re-points nothing that belongs to somebody else
 * (the gateway refuses), and nobody can approve a link to their own account.
 */
function LinkRequestsCard() {
  const act = useAction();
  const [status, setStatus] = useState("pending");
  const filters = useMemo(() => ({ status }), [status]);
  return (
    <Card title="Account-link requests">
      {act.error && (
        <div className={v.errLine} role="alert">
          {act.error}
        </div>
      )}
      <Field label="Show">
        <Select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="pending">pending</option>
          <option value="approved">approved</option>
          <option value="linked">linked</option>
          <option value="denied">denied</option>
          <option value="all">all</option>
        </Select>
      </Field>
      <DataList<LinkRequest>
        listId="link-requests"
        noun="link requests"
        endpoint="/v1/auth/link-requests"
        exportPath="/v1/auth/link-requests/export.xlsx"
        queryKey={["admin", "link-requests", "list"]}
        legacyKey="requests"
        filters={filters}
        defaultSort={{ key: "when", dir: "desc" }}
        columns={[
          {
            key: "account",
            header: "Existing account",
            main: true,
            sortable: true,
            render: (r) => (
              <span>
                {r.userDisplayName} <span className={v.faint}>{r.userEmail}</span>
              </span>
            ),
          },
          { key: "provider", header: "Identity provider", main: true, sortable: true, render: (r) => `${r.provider} (${r.protocol.toUpperCase()})` },
          { key: "email", header: "Asserted email", main: true, sortable: true, render: (r) => <span className={v.mono}>{r.email}</span> },
          {
            key: "mfa",
            header: "MFA",
            main: true,
            sortable: true,
            required: "Whether the identity provider asserted MFA is a warning, so it is always shown",
            render: (r) => (r.idpMfa ? <Badge tone="ok">asserted</Badge> : <Badge>not asserted</Badge>),
          },
          { key: "when", header: "Requested", main: true, sortable: true, render: (r) => fmtDateTime(r.createdAt) },
          {
            key: "approvals",
            header: "Approvals",
            main: true,
            sortable: true,
            render: (r) => `${r.approvals ?? 0} of ${r.requiredApprovals ?? 1}`,
          },
          {
            key: "status",
            header: "Status",
            sortable: true,
            required: "Status is always shown",
            render: (r) => (r.expired ? <Badge tone="warn">expired</Badge> : <Badge>{r.status ?? "pending"}</Badge>),
          },
          { key: "expires", header: "Expires", sortable: true, render: (r) => (r.expiresAt ? fmtDateTime(r.expiresAt) : "—") },
          {
            key: "actions",
            header: "",
            srHeader: "Actions",
            align: "right",
            action: true,
            render: (r) =>
              r.expired || (r.status && r.status !== "pending") ? null : (
                <span className={v.rowTight}>
                  <Button
                    size="sm"
                    onClick={() =>
                      void act.run(async () => {
                        const res = await api.post<{ status: string; approvals?: number; requiredApprovals?: number }>(
                          `/v1/auth/link-requests/${r.id}/approve`,
                          {},
                        );
                        return res.status === "pending"
                          ? `Approval ${res.approvals ?? 1} of ${res.requiredApprovals ?? 2} recorded — another administrator must also approve (audited)`
                          : "Link approved (audited)";
                      })
                    }
                  >
                    approve
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={() =>
                      void act.run(() => api.post(`/v1/auth/link-requests/${r.id}/deny`, {}), "Link denied (audited)")
                    }
                  >
                    deny
                  </Button>
                </span>
              ),
          },
        ]}
        rowKey={(r) => r.id}
        empty={
          <EmptyState
            title={status === "pending" ? "No pending link requests" : "No link requests"}
            body="When someone signs in with an identity provider whose email matches an account that has its own password, the link waits here (or for them to prove the account) — it is never made silently."
          />
        }
      />
    </Card>
  );
}

/**
 * The SSO area: the SSO page (with its link-requests preview) at the index, the full linking-request queue on its own
 * nested route. One lazy chunk mounted at `sso/*`, reached through the identity screen barrel, so the sub-page adds
 * nothing to the entry bundle (ADR-0196 U4; the SPA route census follows this module — scripts/ui-spa-routes.mjs).
 */
export function SsoArea() {
  return (
    <Routes>
      <Route index element={<SsoPage />} />
      <Route path="link-requests" element={<LinkRequestsPage />} />
    </Routes>
  );
}
