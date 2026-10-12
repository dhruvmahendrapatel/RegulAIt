/**
 * Batch U4 — one initiative with its child projects and their measured spend
 * (`GET /v1/initiatives/:initiativeId`), opened from the Initiatives card.
 *
 * An initiative is a reporting-only rollup: the dialog lists the projects it
 * groups and what each has spent (a project with no spend is listed at $0, not
 * left out), and the total is the sum of exactly those rows.
 */
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../../../api/client";
import { fmtAt, fmtUsd } from "../../../api/format";
import { EmptyState, Table } from "../../../ui/kit";
import { KV } from "../adminKit";
import { DetailDialog } from "../DetailDialog";
import v from "../../views.module.css";

interface InitiativeDetailResponse {
  initiative: { id: string; name: string; costCenter: string | null; createdAt: string };
  projects: Array<{ id: string; name: string; spentUsd: number }>;
  projectCount: number;
  spentUsd: number;
}

export function InitiativeDetail(props: { initiativeId: string; onClose: () => void }) {
  const q = useQuery({
    queryKey: ["admin", "initiative", props.initiativeId],
    retry: false,
    queryFn: () => api.get<InitiativeDetailResponse>(`/v1/initiatives/${encodeURIComponent(props.initiativeId)}`),
  });
  return (
    <DetailDialog
      title={q.data ? `Initiative — ${q.data.initiative.name}` : "Initiative"}
      noun="initiative"
      query={q}
      refusals={{ unknown_initiative: "This initiative no longer exists. It may have been deleted; its projects are then ungrouped." }}
      onClose={props.onClose}
    >
      {(d) => (
        <div className={v.stack}>
          <KV
            rows={[
              ["Cost center", d.initiative.costCenter ?? "none"],
              ["Projects", d.projectCount],
              ["Measured spend, all time", <span className={v.num}>{fmtUsd(d.spentUsd)}</span>],
              ["Created", fmtAt(d.initiative.createdAt)],
            ]}
          />
          <Table
            rows={[...d.projects].sort((x, y) => y.spentUsd - x.spentUsd)}
            rowKey={(p) => p.id}
            empty={<EmptyState title="No projects roll up to this initiative" body="Group a project under it on the project edit form." />}
            columns={[
              { key: "name", header: "Project", render: (p) => <Link to={`/projects/${p.id}`}>{p.name}</Link> },
              { key: "spend", header: "Measured spend", align: "right", render: (p) => <span className={v.num}>{fmtUsd(p.spentUsd)}</span> },
            ]}
          />
          <p className={v.faint}>
            Spend is the metered ledger (usage events) for each project, all time. An initiative has no budget or enforcement of its own; each project
            keeps its own.
          </p>
        </div>
      )}
    </DetailDialog>
  );
}
