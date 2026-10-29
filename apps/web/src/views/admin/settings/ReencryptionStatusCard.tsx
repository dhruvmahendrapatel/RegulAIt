/**
 * ADR-0063 — the data-key re-encryption walk, from
 * `GET /v1/security/data-key/reencryption`. Read-only by design: the walk runs
 * as a CLI (`resumeCommand`), never over HTTP, where a proxy timeout mid-walk
 * and a retry racing the first attempt are live risks. The page shows the
 * latest walk, per column, and every row that decrypted under neither key.
 *
 * A walk that is still `running` means ciphertext exists under two keys right
 * now; that is shown as an alarm with the command that resumes it.
 */
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import { ago } from "../../../api/format";
import { Badge, Card, CodeBlock, EmptyState, InfoButton, Table, type Tone } from "../../../ui/kit";
import { KV, QueryGate } from "../adminKit";
import v from "../../views.module.css";

export interface ReencryptionColumn {
  table: string;
  column: string;
  watermark: string | null;
  done: boolean;
  reencrypted: number;
  alreadyCurrent: number;
  failed: number;
}
export interface ReencryptionFailure {
  table: string;
  column: string;
  rowId: string;
  detail: string | null;
  recordedAt: string;
}
export interface ReencryptionStatus {
  run: {
    id: string;
    fromFingerprint: string;
    toFingerprint: string;
    status: string;
    startedAt: string;
    finishedAt: string | null;
    perColumn: ReencryptionColumn[];
    failures: ReencryptionFailure[];
  } | null;
  resumeCommand: string;
  note: string;
}

/** the walk's state in words; an unknown status is shown as it is, never as complete */
export function walkState(status: string): { tone: Tone; label: string } {
  switch (status) {
    case "running":
      return { tone: "danger", label: "incomplete: data is under two keys" };
    case "completed_with_failures":
      return { tone: "warn", label: "finished, some rows unrecoverable" };
    case "completed":
      return { tone: "ok", label: "completed" };
    default:
      return { tone: "warn", label: `status: ${status}` };
  }
}

export function ReencryptionStatusCard() {
  const q = useQuery({
    queryKey: ["admin", "data-key", "reencryption"],
    queryFn: () => api.get<ReencryptionStatus>("/v1/security/data-key/reencryption"),
  });
  const run = q.data?.run ?? null;
  const columns = Array.isArray(run?.perColumn) ? run!.perColumn : [];
  const failures = Array.isArray(run?.failures) ? run!.failures : [];
  const state = run ? walkState(run.status) : null;
  return (
    <Card title="Re-encryption after a key rotation">
      <div className={v.stack} data-testid="data-key-reencryption">
        <QueryGate loading={q.isLoading} error={q.error} onRetry={() => void q.refetch()}>
          {q.data ? (
            <>
              {run && state ? (
                <>
                  <div className={v.row}>
                    <Badge tone={state.tone}>{state.label}</Badge>
                    <span className={v.faint}>
                      started {ago(run.startedAt)}
                      {run.finishedAt ? ` · finished ${ago(run.finishedAt)}` : ""}
                    </span>
                  </div>
                  <KV
                    rows={[
                      ["From key", <code key="from">{run.fromFingerprint}</code>],
                      ["To key", <code key="to">{run.toFingerprint}</code>],
                      ["Walk id", <code key="id">{run.id}</code>],
                    ]}
                  />
                  {run.status === "running" ? (
                    <p role="alert">
                      This walk has not finished, so some stored secrets are still under the old key. Resume it from the
                      gateway host with the command below; it continues from where it stopped and processes no row twice.
                    </p>
                  ) : null}
                  <Table<ReencryptionColumn>
                    rows={columns}
                    rowKey={(c) => `${c.table}.${c.column}`}
                    columns={[
                      { key: "col", header: "Column", render: (c) => <code>{`${c.table}.${c.column}`}</code> },
                      { key: "done", header: "State", render: (c) => (c.done ? <Badge tone="ok">done</Badge> : <Badge tone="warn">in progress</Badge>) },
                      { key: "re", header: "Re-encrypted", align: "right", render: (c) => c.reencrypted },
                      { key: "cur", header: "Already current", align: "right", render: (c) => c.alreadyCurrent },
                      { key: "fail", header: "Failed", align: "right", render: (c) => (c.failed > 0 ? <Badge tone="danger">{c.failed}</Badge> : 0) },
                    ]}
                    empty={<EmptyState title="No columns recorded" body="The walk has not reached any encrypted column yet." />}
                  />
                  {failures.length > 0 ? (
                    <>
                      <p className={v.errLine}>
                        {failures.length} row(s) decrypted under neither key. They cannot be recovered without the key they
                        were written under.
                      </p>
                      <Table<ReencryptionFailure>
                        rows={failures}
                        rowKey={(f) => `${f.table}.${f.column}.${f.rowId}`}
                        columns={[
                          { key: "col", header: "Column", render: (f) => <code>{`${f.table}.${f.column}`}</code> },
                          { key: "row", header: "Row", render: (f) => <code>{f.rowId}</code> },
                          { key: "detail", header: "Detail", render: (f) => f.detail ?? <span className={v.faint}>none</span> },
                          { key: "at", header: "Recorded", render: (f) => ago(f.recordedAt) },
                        ]}
                      />
                    </>
                  ) : null}
                </>
              ) : (
                <EmptyState
                  title="No re-encryption walk has run"
                  body={
                    <>
                      A walk is needed only after the data key is rotated.{" "}
                      {/* the gateway's note opens with the same fact as the title: only its reason is kept */}
                      {q.data.note ? (
                        <InfoButton label="the re-encryption walk">
                          {q.data.note.replace(/^No re-encryption walk has ever run on this deployment\.\s*/, "")}
                        </InfoButton>
                      ) : null}
                    </>
                  }
                />
              )}
              {run ? <p className={v.faint}>{q.data.note}</p> : null}
              <div>
                <span className={v.faint}>Run or resume from the gateway host:</span>
                <CodeBlock>{q.data.resumeCommand}</CodeBlock>
              </div>
            </>
          ) : null}
        </QueryGate>
      </div>
    </Card>
  );
}
