/**
 * Batch U4 — one training job (`GET /v1/llm/jobs/:id`): its settings, the
 * EXACT dataset version it trained on (not "the dataset", which may since have
 * moved on), and the artifact it produced, if any.
 *
 * `refused` (nothing was attempted) and `failed` (it was tried and broke) are
 * different facts and are worded apart, as on the jobs table.
 */
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../../../api/client";
import { fmtAt, fmtDur, fmtUsd } from "../../../api/format";
import { Badge, CodeBlock, Meter } from "../../../ui/kit";
import { KV } from "../adminKit";
import { DetailDialog } from "../DetailDialog";
import v from "../../views.module.css";

interface JobDetailResponse {
  job: {
    id: string;
    name: string;
    datasetId: string;
    datasetVersion: number;
    backend: string;
    method: string;
    baseModel: string | null;
    hyperparameters: Record<string, unknown>;
    status: string;
    progress: number;
    externalJobId: string | null;
    error: string | null;
    estimatedCostUsd: number;
    costUsd: number | null;
    approvalId: string | null;
    createdAt: string;
    startedAt: string | null;
    finishedAt: string | null;
    durationMs: number | null;
  };
  trainedOn: { id: string; name: string; version: number; format: string; rowCount: number; checksum: string; piiVerdict: string; status?: string } | null;
  artifact: { id: string; name: string; kind: string; location: string | null; agentId: string | null; modelCardId: string | null; createdAt: string; queryable: boolean } | null;
  inProcess: boolean;
}

const STATUS_WORDS: Record<string, string> = {
  refused: "Refused — the backend declined before any work happened; nothing was attempted.",
  failed: "Failed — the job was attempted and broke.",
  cancelled: "Cancelled.",
  succeeded: "Succeeded.",
  running: "Running.",
  queued: "Queued.",
  pending_approval: "Waiting for approval in the Approvals Queue.",
};

export function TrainingJobDetail(props: { jobId: string; onClose: () => void }) {
  const q = useQuery({
    queryKey: ["admin", "llm-job", props.jobId],
    retry: false,
    queryFn: () => api.get<JobDetailResponse>(`/v1/llm/jobs/${encodeURIComponent(props.jobId)}`),
  });
  return (
    <DetailDialog
      title={q.data ? `Training job — ${q.data.job.name}` : "Training job"}
      noun="training job"
      query={q}
      refusals={{ unknown_training_job: "There is no training job with this ID. Reload the jobs list." }}
      onClose={props.onClose}
    >
      {(d) => (
        <div className={v.stack}>
          <p role="status">
            <Badge tone={d.job.status === "succeeded" ? "ok" : d.job.status === "failed" ? "danger" : d.job.status === "refused" ? "warn" : "neutral"}>
              {d.job.status}
            </Badge>{" "}
            {STATUS_WORDS[d.job.status] ?? ""}
            {d.job.error ? ` ${d.job.error}` : ""}
          </p>
          {d.job.status === "running" && <Meter value={d.job.progress} max={1} label="Progress" />}
          <KV
            rows={[
              ["Backend", <code>{d.job.backend}</code>],
              ["Method", <code>{d.job.method}</code>],
              ["Runs", d.inProcess ? "in the gateway process" : "on the remote backend"],
              ["Base model", d.job.baseModel ?? "none"],
              ["Backend job ID", d.job.externalJobId ? <code>{d.job.externalJobId}</code> : "none"],
              ["Cost", d.job.costUsd === null ? `estimated ${fmtUsd(d.job.estimatedCostUsd)} (not yet measured)` : fmtUsd(d.job.costUsd)],
              ["Approval", d.job.approvalId ? <Link to="/admin/approvals">in the Approvals Queue</Link> : "not required"],
              ["Created", fmtAt(d.job.createdAt)],
              ["Started", d.job.startedAt ? fmtAt(d.job.startedAt) : "not started"],
              ["Finished", d.job.finishedAt ? fmtAt(d.job.finishedAt) : "not finished"],
              ["Duration", d.job.durationMs === null ? "—" : fmtDur(d.job.durationMs)],
            ]}
          />
          <div className={v.sectionTitle}>Trained on</div>
          {d.trainedOn ? (
            <KV
              rows={[
                ["Dataset", `${d.trainedOn.name} v${d.trainedOn.version}`],
                ["Format", d.trainedOn.format],
                ["Rows", d.trainedOn.rowCount],
                ["Ingest scan", d.trainedOn.piiVerdict],
                ["Checksum", <code style={{ wordBreak: "break-all" }}>{d.trainedOn.checksum || "not recorded"}</code>],
              ]}
            />
          ) : (
            <p className={v.faint}>
              The pinned dataset version (v{d.job.datasetVersion}) is no longer stored. The job row still records which version it was.
            </p>
          )}
          <div className={v.sectionTitle}>Artifact</div>
          {d.artifact ? (
            <KV
              rows={[
                ["Name", d.artifact.name],
                ["Kind", d.artifact.kind],
                ["Location", d.artifact.location ?? "held inline"],
                ["Registered for inference", d.artifact.agentId ? <Link to="/admin/agents">as an agent</Link> : "no"],
                ["Model card", d.artifact.modelCardId ? <Link to="/admin/model-risk">on Model risk</Link> : "none"],
                ["Created", fmtAt(d.artifact.createdAt)],
              ]}
            />
          ) : (
            <p className={v.faint}>No artifact: the job has not produced one{d.job.status === "succeeded" ? "" : " (it has not succeeded)"}.</p>
          )}
          <details>
            <summary>Hyperparameters</summary>
            <CodeBlock maxHeight="220px">{JSON.stringify(d.job.hyperparameters ?? {}, null, 2)}</CodeBlock>
          </details>
        </div>
      )}
    </DetailDialog>
  );
}
