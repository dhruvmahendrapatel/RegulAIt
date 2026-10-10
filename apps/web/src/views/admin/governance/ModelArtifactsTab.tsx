/**
 * ADR-0187 X28 — the Model artifacts tab of Admission review: upload a model
 * artifact, scan it with modelscan, and read why it is or is not clean.
 *
 *  - The format is decided by the gateway from the file's BYTES; the name is
 *    display only, and a name that disagrees with the content is called out.
 *  - Only a verified safetensors file can be clean (owner decision 105). A
 *    pickle-family or other executable format is at best "no known-unsafe
 *    operator found", never clean. Not-run, unknown and never-scanned are never
 *    clean. `scanStatus` enforces this whatever the server sends.
 *  - Reasons are fixed sentences from structured fields. No file content and
 *    no scanner text is ever shown.
 *  - An artifact can be deleted by its uploader or an admin, after a
 *    confirmation and a step-up (`settings_relax`); the gateway refuses while
 *    a scan of it is cited as model-card evidence or a run on it is unfinished.
 *    Its retention (`modelArtifactRetentionDays`) is stated in the detail.
 *  - The upload respects the org's `modelArtifactMaxMegabytes` before a byte is
 *    sent, shows progress, and can be cancelled; the gateway's own refusals
 *    (413, 503, 415, and anything else) are shown as they arrive.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../../api/client";
import { withStepUp } from "../../../stepup/stepUp";
import { ago } from "../../../api/format";
import { Badge, Button, Card, ConfirmModal, EmptyState, Field, IdChip, SeverityBadge, Table } from "../../../ui/kit";
import { useToast } from "../../../ui/toast";
import v from "../../views.module.css";
import m from "./modelArtifacts.module.css";
import { ScanReasons, ScanStatusBadge } from "./EngineScanChip";
import {
  DEFAULT_MAX_MEGABYTES,
  DEFAULT_RETENTION_DAYS,
  findingKindLabel,
  findingSeverity,
  severityLabel,
  formatBytes,
  formatName,
  isLiveRun,
  chooseScan,
  latestScan,
  nameMismatch,
  preUploadRefusal,
  refusalText,
  retentionText,
  runStatusText,
  safeFindingId,
  scanFindings,
  scanStatus,
  SCAN_ENGINE_ID,
  uploadModelArtifact,
  type ArtifactScan,
  type EngineRunLite,
  type ModelArtifact,
} from "./modelArtifacts";

/** every key here sits under ["admin"], so the admin kit's invalidation refreshes it */
const KEY = ["admin", "model-artifacts"] as const;
/** the list shows at most this many rows, each with its scans */
const SHOWN = 50;

interface EngineLite {
  id: string;
  enabled: boolean;
  version: string | null;
  signature?: string;
}

export default function ModelArtifactsTab(props: {
  selected: string | null;
  /** B5W-01: the scan (and run) a model card cites; shown instead of the newest, never replaced by it */
  citedScanId?: string | null;
  citedRunId?: string | null;
  onSelect: (id: string | null) => void;
}) {
  const qc = useQueryClient();
  const settings = useQuery({
    queryKey: [...KEY, "limit"],
    queryFn: () => api.get<{ settings?: { modelArtifactMaxMegabytes?: number; modelArtifactRetentionDays?: number } }>("/v1/org/settings"),
    retry: false,
  });
  const declared = settings.data?.settings?.modelArtifactMaxMegabytes;
  // until the org's value is read (or if it cannot be), the strict shipped default applies
  const maxMegabytes = typeof declared === "number" && declared > 0 ? declared : DEFAULT_MAX_MEGABYTES;
  const declaredRetention = settings.data?.settings?.modelArtifactRetentionDays;
  const retentionKnown = typeof declaredRetention === "number" && declaredRetention > 0;
  const retentionDays = retentionKnown ? declaredRetention : DEFAULT_RETENTION_DAYS;

  const artifacts = useQuery({ queryKey: [...KEY, "list"], queryFn: () => api.get<{ artifacts: ModelArtifact[] }>("/v1/model-artifacts") });
  const rows = useMemo(() => (artifacts.data?.artifacts ?? []).slice(0, SHOWN), [artifacts.data]);
  const details = useQueries({
    queries: rows.map((a) => ({
      queryKey: [...KEY, "detail", a.id],
      queryFn: () => api.get<{ artifact: ModelArtifact; scans: ArtifactScan[] }>(`/v1/model-artifacts/${a.id}`),
    })),
  });
  const scansOf = new Map(rows.map((a, i) => [a.id, details[i]] as const));

  const engine = useQuery({
    queryKey: [...KEY, "engine"],
    queryFn: () => api.get<EngineLite>(`/v1/engines/${SCAN_ENGINE_ID}`),
    retry: false,
  });
  const runs = useQuery({
    queryKey: [...KEY, "runs"],
    queryFn: () => api.get<{ runs: EngineRunLite[] }>(`/v1/engine-runs?engineId=${SCAN_ENGINE_ID}&limit=100`),
    refetchInterval: (q) => ((q.state.data?.runs ?? []).some((r) => isLiveRun(r.status)) ? 5000 : false),
  });
  const liveRunOf = useMemo(() => {
    const out = new Map<string, EngineRunLite>();
    for (const r of runs.data?.runs ?? []) if (r.targetArtifactId && isLiveRun(r.status) && !out.has(r.targetArtifactId)) out.set(r.targetArtifactId, r);
    return out;
  }, [runs.data]);
  // a run that was live and has ended has written its scan: re-read that artifact
  const wasLive = useRef<Set<string>>(new Set());
  useEffect(() => {
    const now = new Set(liveRunOf.keys());
    for (const id of wasLive.current) if (!now.has(id)) void qc.invalidateQueries({ queryKey: [...KEY, "detail", id] });
    wasLive.current = now;
  }, [liveRunOf, qc]);

  const selected = props.selected ? (artifacts.data?.artifacts ?? []).find((a) => a.id === props.selected) ?? null : null;

  return (
    <div className={v.stack}>
      <UploadCard
        maxMegabytes={maxMegabytes}
        limitKnown={typeof declared === "number"}
        onUploaded={(a) => {
          void qc.invalidateQueries({ queryKey: KEY });
          props.onSelect(a.id);
        }}
      />

      <Card title="Model artifacts">
        <p className={v.dim} style={{ marginTop: 0 }}>
          Only a verified safetensors file can be clean. A pickle or any other executable format is never clean, whatever
          the scan finds: loading it can run code. Not scanned and inconclusive are not clean.
        </p>
        <Table<ModelArtifact>
          rows={rows}
          loading={artifacts.isLoading}
          error={artifacts.error}
          onRetry={() => void artifacts.refetch()}
          rowKey={(a) => a.id}
          empty={<EmptyState title="No model artifacts" body="Upload a model file to scan it before it is admitted." />}
          columns={[
            { key: "name", header: "File name", render: (a) => a.filename },
            {
              key: "format",
              header: "Format (from content)",
              render: (a) => (
                <span className={m.status}>
                  <span>{formatName(a.format)}</span>
                  {a.executable ? <Badge tone="warn">Executable</Badge> : <Badge tone="neutral">Holds no code</Badge>}
                </span>
              ),
            },
            { key: "size", header: "Size", align: "right", render: (a) => formatBytes(a.sizeBytes) },
            { key: "at", header: "Uploaded", render: (a) => ago(a.createdAt) },
            {
              key: "scan",
              header: "Scan",
              render: (a) => {
                const live = liveRunOf.get(a.id);
                const d = scansOf.get(a.id);
                if (live) return <Badge tone="info">{runStatusText(live)}</Badge>;
                if (!d || d.isLoading) return <span className={v.dim}>Loading…</span>;
                if (d.error) return <span className={v.dim}>Couldn't read the scans</span>;
                return <ScanStatusBadge status={scanStatus(latestScan(d.data?.scans), a)} />;
              },
            },
            {
              key: "open",
              header: "",
              align: "right",
              render: (a) => (
                <Button size="sm" aria-label={`Open ${a.filename}`} aria-pressed={props.selected === a.id} onClick={() => props.onSelect(props.selected === a.id ? null : a.id)}>
                  {props.selected === a.id ? "Close" : "Open"}
                </Button>
              ),
            },
          ]}
        />
        {(artifacts.data?.artifacts.length ?? 0) > SHOWN && (
          <p className={v.dim}>
            Showing the newest {SHOWN} of {artifacts.data!.artifacts.length}.
          </p>
        )}
      </Card>

      {props.selected && !selected && !artifacts.isLoading && (
        <Card title="Artifact">
          <div className={v.errLine} role="alert">
            This artifact isn't in your list. It may not exist, or it may have been uploaded by someone else.
          </div>
        </Card>
      )}
      {selected && (
        <ArtifactDetail
          artifact={selected}
          engine={engine.data ?? null}
          engineError={engine.error}
          liveRun={liveRunOf.get(selected.id) ?? null}
          onScanStarted={() => void qc.invalidateQueries({ queryKey: [...KEY, "runs"] })}
          citedScanId={props.citedScanId ?? null}
          citedRunId={props.citedRunId ?? null}
          onShowLatest={() => props.onSelect(selected.id)}
          retentionDays={retentionDays}
          retentionKnown={retentionKnown}
          onDeleted={() => {
            props.onSelect(null);
            void qc.invalidateQueries({ queryKey: KEY });
          }}
        />
      )}
    </div>
  );
}

function UploadCard(props: { maxMegabytes: number; limitKnown: boolean; onUploaded: (a: ModelArtifact) => void }) {
  const { toast } = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [inputKey, setInputKey] = useState(0);
  const [progress, setProgress] = useState<{ sent: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const refusal = file ? preUploadRefusal(file.size, props.maxMegabytes) : null;
  const busy = progress !== null;

  const start = async () => {
    if (!file || refusal) return;
    setError(null);
    const ctl = new AbortController();
    abort.current = ctl;
    setProgress({ sent: 0, total: file.size });
    try {
      const out = await uploadModelArtifact(file, {
        filename: file.name,
        signal: ctl.signal,
        onProgress: (sent, total) => setProgress({ sent, total }),
      });
      toast(`Uploaded ${out.artifact.filename}: its content is ${formatName(out.artifact.format)}`, "success");
      setFile(null);
      setInputKey((k) => k + 1);
      props.onUploaded(out.artifact);
    } catch (e) {
      setError(refusalText(e));
    } finally {
      abort.current = null;
      setProgress(null);
    }
  };

  const pct = progress && progress.total > 0 ? Math.min(100, Math.round((progress.sent / progress.total) * 100)) : 0;
  return (
    <Card title="Upload a model artifact">
      <p className={v.dim} style={{ marginTop: 0 }}>
        The file's format is decided from its content, never its name. Size limit: {props.maxMegabytes} MiB
        {props.limitKnown ? "" : " (the strict default; the organisation's setting could not be read)"}.
      </p>
      <div style={{ display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap" }}>
        <Field label="Model file">
          <input
            key={inputKey}
            type="file"
            aria-label="Model file"
            data-testid="artifact-file"
            disabled={busy}
            onChange={(e) => {
              setError(null);
              setFile(e.target.files?.[0] ?? null);
            }}
          />
        </Field>
        <Button variant="primary" disabled={!file || refusal !== null || busy} onClick={() => void start()}>
          Upload
        </Button>
        {busy && (
          <Button onClick={() => abort.current?.abort()} aria-label="Cancel upload">
            Cancel
          </Button>
        )}
      </div>
      {file && !busy && !refusal && (
        <p className={v.dim}>
          {file.name} · {formatBytes(file.size)}
        </p>
      )}
      {refusal && (
        <div className={v.errLine} role="alert">
          {refusal}
        </div>
      )}
      {progress && (
        <div>
          <progress className={m.progress} max={100} value={pct} aria-label="Upload progress" />
          <div className={v.dim} aria-live="polite">
            Uploading: {formatBytes(progress.sent)} of {formatBytes(progress.total)} ({pct}%)
          </div>
        </div>
      )}
      {error && (
        <div className={v.errLine} role="alert" data-testid="upload-error">
          {error}
        </div>
      )}
    </Card>
  );
}

function ArtifactDetail(props: {
  artifact: ModelArtifact;
  engine: EngineLite | null;
  engineError: unknown;
  liveRun: EngineRunLite | null;
  onScanStarted: () => void;
  citedScanId: string | null;
  citedRunId: string | null;
  onShowLatest: () => void;
  retentionDays: number;
  retentionKnown: boolean;
  onDeleted: () => void;
}) {
  const a = props.artifact;
  const { toast } = useToast();
  const detail = useQuery({
    queryKey: [...KEY, "detail", a.id],
    queryFn: () => api.get<{ artifact: ModelArtifact; scans: ArtifactScan[] }>(`/v1/model-artifacts/${a.id}`),
  });
  const scans = useMemo(() => {
    const list = Array.isArray(detail.data?.scans) ? detail.data!.scans : [];
    const at = (s: ArtifactScan) => (Number.isFinite(Date.parse(s?.createdAt)) ? Date.parse(s.createdAt) : -Infinity);
    return [...list].sort((x, y) => at(y) - at(x));
  }, [detail.data]);
  const choice = chooseScan(scans, { scanId: props.citedScanId, runId: props.citedRunId });
  // the scan this view is about: the cited one when a model card links here, else the newest
  const latest = choice.kind === "cited_missing" ? null : choice.scan;
  const status = scanStatus(latest, a);
  const findings = scanFindings(latest);
  const run = useQuery({
    queryKey: [...KEY, "run", latest?.engineRunId ?? null],
    enabled: Boolean(latest?.engineRunId),
    retry: false,
    queryFn: () => api.get<{ run: EngineRunLite }>(`/v1/engine-runs/${latest!.engineRunId}`),
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mismatch = nameMismatch(a);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const doDelete = async () => {
    setConfirmDelete(false);
    setDeleting(true);
    setDeleteError(null);
    try {
      // the gateway asks for a step-up (`settings_relax`); the dialog answers it and the same DELETE is resent once
      const out = await withStepUp((h) =>
        // the shared client with the grant header: its session-loss handling and refusal reading, as every write
        api.delWithHeaders<{ deleted?: { object?: "deleted" | "shared" | "queued" } }>(`/v1/model-artifacts/${encodeURIComponent(a.id)}`, h),
      );
      const obj = out?.deleted?.object;
      toast(
        `Deleted ${a.filename}` +
          (obj === "shared"
            ? "; its stored bytes are kept because another artifact has the same content"
            : obj === "queued"
              ? "; its stored bytes will be removed by the retention sweep"
              : ""),
        "success",
      );
      props.onDeleted();
    } catch (e) {
      setDeleteError(refusalText(e));
    } finally {
      setDeleting(false);
    }
  };

  const engineOff = props.engine !== null && !props.engine.enabled;
  const scanBlocked = engineOff || props.liveRun !== null;
  const startScan = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post("/v1/engine-runs", { engineId: SCAN_ENGINE_ID, target: { artifactId: a.id }, config: { sets: ["scan"] } });
      toast(`Scan of ${a.filename} queued`, "success");
      props.onScanStarted();
    } catch (e) {
      setError(refusalText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title={`Artifact: ${a.filename}`}>
      <div className={v.stack}>
        <dl className={m.dl}>
          <dt>File name</dt>
          <dd>{a.filename} <span className={v.faint}>(display only)</span></dd>
          <dt>Format (from content)</dt>
          <dd>
            {formatName(a.format)} {a.executable ? <Badge tone="warn">Executable</Badge> : <Badge tone="neutral">Holds no code</Badge>}
            {a.formatDescription && <div className={v.dim}>{a.formatDescription}</div>}
          </dd>
          <dt>Size</dt>
          <dd>{formatBytes(a.sizeBytes)}</dd>
          <dt>SHA-256</dt>
          <dd className={v.mono}>{a.sha256}</dd>
          <dt>Uploaded</dt>
          <dd>{ago(a.createdAt)}</dd>
          <dt>Retention</dt>
          <dd data-testid="artifact-retention">{retentionText(a.createdAt, props.retentionDays, props.retentionKnown)}</dd>
        </dl>
        {mismatch && (
          <div role="note" data-testid="name-mismatch">
            <Badge tone="warn">Name and content disagree</Badge> {mismatch}
          </div>
        )}

        <div>
          <div className={v.sectionTitle}>{choice.kind === "latest" ? "Latest scan" : "Cited scan"}</div>
          {detail.isLoading ? (
            <span className={v.dim}>Loading…</span>
          ) : detail.error ? (
            <div className={v.errLine} role="alert">
              Couldn't read this artifact's scans — {refusalText(detail.error)}
            </div>
          ) : choice.kind === "cited_missing" ? (
            <div data-testid="cited-scan-missing">
              <div role="alert" className={v.errLine}>
                The cited scan is unavailable: no scan of this artifact matches it. It may have been deleted. The newest scan is not
                shown in its place.
              </div>
              <span className={m.status}>
                <Badge tone="warn">Not clean</Badge>
                <span>Scan record unavailable</span>
              </span>{" "}
              <Button size="sm" onClick={props.onShowLatest}>
                Show the latest scan
              </Button>
            </div>
          ) : (
            <div data-testid="latest-scan">
              {choice.kind === "cited" && (
                <p className={v.dim} style={{ marginTop: 0 }} data-testid="cited-note">
                  This is the scan a model card cites. It may not be the newest scan of this artifact.{" "}
                  <Button size="sm" onClick={props.onShowLatest}>
                    Show the latest scan
                  </Button>
                </p>
              )}
              <ScanStatusBadge status={status} />{" "}
              <Badge tone={status.admissible ? "ok" : "neutral"}>{status.admissible ? "Admissible" : "Not admissible"}</Badge>
              <ScanReasons status={status} />
            </div>
          )}
        </div>

        {findings.length > 0 && (
          <Table<{ i: number; kind: string; id: string; severity: unknown }>
            rows={findings.map((f, i) => ({ i, kind: f.kind, id: f.id, severity: f.severity }))}
            rowKey={(f) => String(f.i)}
            columns={[
              { key: "kind", header: "Finding", render: (f) => findingKindLabel(f.kind) },
              { key: "id", header: "Identifier", render: (f) => <code>{safeFindingId(f.id)}</code> },
              {
                key: "sev",
                header: "Severity",
                // B5W-08: only a known severity reaches the badge; anything else is fixed words, never the raw value
                render: (f) => {
                  const sev = findingSeverity(f.severity);
                  return sev ? <SeverityBadge severity={sev} /> : <Badge tone="warn">{severityLabel(f.severity)}</Badge>;
                },
              },
            ]}
          />
        )}

        {latest && (
          <div data-testid="scan-run">
            <div className={v.sectionTitle}>Scan run</div>
            <dl className={m.dl}>
              <dt>Engine</dt>
              <dd>
                {SCAN_ENGINE_ID} {latest.scannerVersion ? `v${latest.scannerVersion}` : "(version not recorded)"}
              </dd>
              <dt>Scanned</dt>
              <dd>{ago(latest.createdAt)}</dd>
              <dt>Scan ID</dt>
              <dd>
                <IdChip id={latest.id} /> <span className={v.faint}>cite it as evidence on a model card (Model risk)</span>
              </dd>
              <dt>Run</dt>
              <dd>
                {latest.engineRunId ? (
                  <>
                    <IdChip id={latest.engineRunId} />{" "}
                    {run.data ? runStatusText(run.data.run) : run.isLoading ? "…" : run.error ? "the run record could not be read" : ""}
                  </>
                ) : (
                  "no run recorded"
                )}
              </dd>
            </dl>
          </div>
        )}

        <div>
          <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <Button variant="primary" disabled={busy || scanBlocked} onClick={() => void startScan()}>
              {scans.length ? "Scan again with modelscan" : "Scan with modelscan"}
            </Button>
            {props.liveRun && <Badge tone="info">{runStatusText(props.liveRun)}</Badge>}
          </div>
          {engineOff && (
            <p className={v.dim} data-testid="engine-off">
              The modelscan engine is switched off on this deployment, so no scan can start. An admin can enable it on the
              Engines page once its self-test passes. Until then this artifact stays not clean.
            </p>
          )}
          {props.engine === null && props.engineError != null && (
            <p className={v.dim}>Couldn't check whether the modelscan engine is on; starting a scan will say if it is not.</p>
          )}
          {error && (
            <div className={v.errLine} role="alert" data-testid="scan-error">
              {error}
            </div>
          )}
        </div>

        <div>
          <div className={v.sectionTitle}>Delete</div>
          <Button variant="danger" disabled={deleting} onClick={() => setConfirmDelete(true)} aria-label={`Delete ${a.filename}`}>
            Delete artifact…
          </Button>
          {deleteError && (
            <div className={v.errLine} role="alert" data-testid="delete-error">
              {deleteError}
            </div>
          )}
          <ConfirmModal
            open={confirmDelete}
            danger
            title={`Delete ${a.filename}?`}
            confirmLabel="Delete"
            body={
              <div className={v.stack}>
                <p style={{ margin: 0 }}>
                  The artifact and its scans are deleted. The stored bytes are removed once no other artifact has the same
                  content. The deletion is recorded in the audit log under your name; the audit records of the upload and
                  its scans are kept.
                </p>
                <p style={{ margin: 0 }}>You'll be asked to confirm it's you (a step-up) before anything is deleted.</p>
                <p style={{ margin: 0 }}>
                  It can't be deleted while a scan of it is cited as model-card evidence or a run on it has not finished.
                </p>
              </div>
            }
            onConfirm={() => void doDelete()}
            onCancel={() => setConfirmDelete(false)}
          />
        </div>

        {scans.filter((s) => s !== latest).length > 0 && (
          <div>
            <div className={v.sectionTitle}>{choice.kind === "latest" ? "Earlier scans" : "Other scans of this artifact"}</div>
            <Table<ArtifactScan>
              rows={scans.filter((s) => s !== latest)}
              rowKey={(s) => s.id}
              columns={[
                { key: "at", header: "Scanned", render: (s) => ago(s.createdAt) },
                { key: "status", header: "Result", render: (s) => <ScanStatusBadge status={scanStatus(s, a)} /> },
                { key: "v", header: "Engine version", render: (s) => s.scannerVersion ?? "—" },
                { key: "id", header: "Scan ID", render: (s) => <IdChip id={typeof s.id === "string" ? s.id : null} /> },
              ]}
            />
          </div>
        )}
      </div>
    </Card>
  );
}
