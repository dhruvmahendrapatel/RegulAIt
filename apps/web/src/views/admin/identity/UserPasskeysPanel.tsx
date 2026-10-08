/**
 * ADR-0186 A — an admin's view of one user's passkeys, with revoke (a lost or
 * compromised device). The revoke is audited and needs the ADMIN's own
 * `passkey_manage` step-up; a revoked passkey is kept on record, never deleted.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ago } from "../../../api/format";
import { Badge, Table, EmptyState } from "../../../ui/kit";
import { api, withStepUp } from "../../../stepup/stepUp";
import { RemoveButton } from "../adminKit";
import v from "../../views.module.css";

interface AdminPasskey {
  id: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
  backedUp: boolean;
  revokedAt: string | null;
  revokeReason: string | null;
}

export default function UserPasskeysPanel(props: { userId: string; userName: string }) {
  const qc = useQueryClient();
  const key = ["admin", "passkeys", props.userId];
  const q = useQuery({
    queryKey: key,
    queryFn: () => api.get<{ passkeys: AdminPasskey[] }>(`/v1/users/${props.userId}/passkeys`),
  });
  return (
    <div className={v.stack}>
      <div className={v.dim}>
        Revoke a passkey when its device is lost or compromised. It stops working at once; you'll confirm it's you
        first, and the revoke is audited.
      </div>
      <Table<AdminPasskey>
        columns={[
          { key: "label", header: "Passkey", render: (p) => p.label },
          { key: "created", header: "Added", render: (p) => ago(p.createdAt) },
          { key: "used", header: "Last used", render: (p) => (p.lastUsedAt ? ago(p.lastUsedAt) : "never") },
          {
            key: "status",
            header: "Status",
            render: (p) =>
              p.revokedAt ? (
                <Badge tone="danger" title={p.revokeReason ?? undefined}>
                  revoked
                </Badge>
              ) : (
                <Badge tone="ok">active</Badge>
              ),
          },
          {
            key: "actions",
            header: "",
            render: (p) =>
              p.revokedAt ? null : (
                <RemoveButton
                  label="Revoke"
                  what={`${props.userName}'s passkey "${p.label}"`}
                  consequence="It stops working immediately. You'll confirm it's you first; the revoke is audited and the passkey stays on record as revoked."
                  onRemove={() =>
                    withStepUp((h) =>
                      api.del(`/v1/users/${props.userId}/passkeys/${p.id}`, { reason: "revoked by an admin from the Users page" }, h),
                    )
                  }
                  onDone={() => void qc.invalidateQueries({ queryKey: key })}
                />
              ),
          },
        ]}
        rows={q.data?.passkeys}
        rowKey={(p) => p.id}
        loading={q.isLoading}
        error={q.error}
        onRetry={() => void q.refetch()}
        empty={<EmptyState title="No passkeys" body="This user hasn't added a passkey." />}
      />
    </div>
  );
}
