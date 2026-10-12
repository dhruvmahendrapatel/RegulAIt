/**
 * ADR-0017 — one certificate's rotation ledger (`GET /v1/infra/certs/:id/rotations`):
 * every proposed rotation, its approval, and how it ended (rotated, denied or
 * failed), with the serials either side.
 */
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import { ago, fmtAt } from "../../../api/format";
import { Badge, Button, Card, Table, type Tone } from "../../../ui/kit";
import { QueryGate } from "../adminKit";
import { withRefusalCopy } from "../governance/refusalCopy";
import v from "../../views.module.css";

interface CertRotation {
  id: string;
  certId: string;
  findingId: string | null;
  approvalId: string | null;
  oldSerial: string | null;
  newSerial: string | null;
  newNotAfter: string | null;
  status: "proposed" | "rotated" | "denied" | "failed";
  reason: string | null;
  rotatedAt: string | null;
  createdAt: string;
}

const TONE: Record<CertRotation["status"], Tone> = { proposed: "info", rotated: "ok", denied: "warn", failed: "danger" };

export function CertRotationsCard(props: { certId: string; commonName: string; onClose: () => void }) {
  const rotations = useQuery({
    queryKey: ["admin", "infra-cert-rotations", props.certId],
    queryFn: () =>
      withRefusalCopy(
        () => api.get<{ rotations: CertRotation[] }>(`/v1/infra/certs/${props.certId}/rotations`),
        { unknown_cert: "That certificate is no longer tracked." },
      ),
  });
  return (
    <Card
      title={`Rotation history — ${props.commonName}`}
      actions={
        <Button size="sm" variant="ghost" onClick={props.onClose}>
          Close
        </Button>
      }
    >
      <QueryGate loading={rotations.isLoading} error={rotations.error} onRetry={() => void rotations.refetch()}>
        <Table<CertRotation>
          rows={rotations.data?.rotations ?? []}
          rowKey={(r) => r.id}
          empty={<span className={v.faint}>No rotation has been proposed for this certificate.</span>}
          columns={[
            { key: "proposed", header: "Proposed", render: (r) => ago(r.createdAt), sort: (r) => r.createdAt },
            { key: "status", header: "Outcome", render: (r) => <Badge tone={TONE[r.status] ?? "neutral"}>{r.status}</Badge> },
            { key: "serials", header: "Serial", render: (r) => <span className={v.mono}>{`${r.oldSerial ?? "—"} → ${r.newSerial ?? "—"}`}</span> },
            { key: "notAfter", header: "New not-after", render: (r) => (r.newNotAfter ? fmtAt(r.newNotAfter) : "—") },
            { key: "rotated", header: "Rotated", render: (r) => (r.rotatedAt ? fmtAt(r.rotatedAt) : "—") },
            { key: "reason", header: "Reason", render: (r) => r.reason ?? <span className={v.faint}>—</span> },
          ]}
        />
      </QueryGate>
    </Card>
  );
}
