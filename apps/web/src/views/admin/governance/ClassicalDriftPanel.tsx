/**
 * The "Drift and explainability" tab of one model card in Model risk (P13b). Lazy-loaded.
 *
 *  - Off until an admin turns it on (a step-up); the requirements sit beside the switch.
 *  - A drift monitor holds a reference distribution (histograms or category tables) and thresholds. A threshold above
 *    its default alerts later, so the form says it needs a step-up before it is saved.
 *  - Summaries arrive from the customer's pipeline (an admin API key) or as an upload here. Results are per feature:
 *    PSI, the KS distance (numeric features; a lower bound on binned data) and Jensen–Shannon.
 *  - Drift opens an alert on Governance alerts; this tab does not decide anything.
 *  - Explainability artefacts (feature importance, SHAP summaries) come from the customer's tooling and are recorded
 *    as evidence; RegulAIt does not compute them.
 */
import { useState, type ChangeEvent } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import { ago } from "../../../api/format";
import { api as stepUpApi, withStepUp } from "../../../stepup/stepUp";
import { Badge, Button, Card, ConfirmModal, EmptyState, Field, Input, RowActions, Select, SkeletonBlock, Table, Textarea } from "../../../ui/kit";
import { useAction } from "../adminKit";
import a from "../admin.module.css";
import v from "../../views.module.css";
import {
  KIND_LABEL,
  STATUS_LABEL,
  THRESHOLD_FIELDS,
  breachedText,
  fileTooLarge,
  loosenedThresholds,
  parseFeatureFile,
  parseImportanceFile,
  stat,
  statusTone,
  thresholdsText,
  topImportances,
  type DriftMonitor,
  type DriftReport,
  type DriftThresholds,
  type DriftView,
  type ExplainabilityArtefact,
  type FeatureResult,
} from "./classicalDrift";

const readFile = async (e: ChangeEvent<HTMLInputElement>): Promise<{ text: string } | { error: string } | null> => {
  const file = e.target.files?.[0];
  if (!file) return null;
  const big = fileTooLarge(file);
  return big ? { error: big } : { text: await file.text() };
};

export default function ClassicalDriftPanel(props: { cardId: string }) {
  const key = ["admin", "model-drift", props.cardId] as const;
  const view = useQuery({ queryKey: key, queryFn: () => api.get<DriftView>(`/v1/mrm/cards/${props.cardId}/drift`) });
  const act = useAction();
  const [selected, setSelected] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ kind: "monitor" | "artefact"; id: string; label: string } | null>(null);

  if (view.isLoading) {
    return (
      <div role="status" aria-label="Loading drift and explainability">
        <SkeletonBlock lines={4} />
      </div>
    );
  }
  if (view.error || !view.data) {
    return (
      <div className={v.stack}>
        <div className={v.errLine} role="alert">
          {view.error instanceof Error ? view.error.message : "Couldn't load drift and explainability."}
        </div>
        <div>
          <Button size="sm" onClick={() => void view.refetch()}>
            Retry
          </Button>
        </div>
      </div>
    );
  }
  const d = view.data;
  const refresh = () => void view.refetch();
  const selectedMonitor = d.monitors.find((m) => m.id === selected) ?? null;

  return (
    <div className={v.stack}>
      {act.error && (
        <div className={v.errLine} role="alert">
          {act.error}
        </div>
      )}
      <Card
        title="Classical model drift"
        info={
          <p>
            Compares production feature summaries from your pipeline with a reference distribution, and records the
            feature importance your tooling produces. Only aggregates are accepted: bin counts and category counts,
            never rows.
          </p>
        }
      >
        <div className={v.stack}>
          <div>
            <Badge tone={d.settings.enabled ? "ok" : "neutral"}>{d.settings.enabled ? "On" : "Off"}</Badge>{" "}
            <span className={v.faint}>
              {d.settings.enabled
                ? `Each monitor accepts up to ${d.settings.maxReportsPerHour} summaries an hour. A feature with fewer than ${d.settings.minSamples} samples is reported as too few samples and does not raise or clear an alert.`
                : "Off by default. While it is off, nothing can be registered or submitted here."}
            </span>
          </div>
          <p className={v.faint}>
            {d.settings.enabled
              ? "Turning it off stops new monitors, summaries and artefacts, and clears open drift alerts on the next monitor pass. What is recorded stays."
              : "Turning it on needs a step-up. Pipelines then send summaries with an admin API key; drift opens an alert on Governance alerts."}
          </p>
          <div>
            <Button
              variant={d.settings.enabled ? "default" : "primary"}
              aria-disabled={act.busy}
              onClick={() => {
                if (act.busy) return;
                void act.run(async () => {
                  await withStepUp((h) => stepUpApi.put("/v1/model-drift/settings", { enabled: !d.settings.enabled }, h));
                  refresh();
                }, d.settings.enabled ? "Classical model drift turned off" : "Classical model drift turned on");
              }}
            >
              {d.settings.enabled ? "Turn off" : "Turn on"}
            </Button>
          </div>
        </div>
      </Card>

      <Card title="Drift monitors">
        <div className={v.stack}>
          <Table
            rows={d.monitors}
            rowKey={(m) => m.id}
            empty={<EmptyState title="No drift monitors" body="Register a reference distribution below to start comparing production summaries." />}
            columns={[
              { key: "name", header: "Monitor", render: (m) => m.name, sort: (m) => m.name },
              { key: "features", header: "Features", align: "right", render: (m) => m.features.length },
              {
                key: "latest",
                header: "Latest result",
                render: (m) =>
                  m.latestReport ? (
                    <span>
                      <Badge tone={statusTone(m.latestReport.status)}>{STATUS_LABEL[m.latestReport.status]}</Badge>{" "}
                      <span className={v.faint}>{ago(m.latestReport.createdAt)}</span>
                    </span>
                  ) : (
                    <span className={v.faint}>No summary yet</span>
                  ),
              },
              { key: "thresholds", header: "Thresholds", render: (m) => <span className={v.faint}>{thresholdsText(m.thresholds)}</span> },
              {
                key: "actions",
                header: "",
                srHeader: "Actions",
                render: (m) => (
                  <RowActions
                    slot="8rem"
                    primary={
                      <Button size="sm" aria-label={`Results for ${m.name}`} onClick={() => setSelected(selected === m.id ? null : m.id)}>
                        {selected === m.id ? "Hide results" : "Results"}
                      </Button>
                    }
                    rest={
                      <Button size="sm" variant="danger" aria-label={`Delete ${m.name}`} onClick={() => setConfirm({ kind: "monitor", id: m.id, label: m.name })}>
                        Delete
                      </Button>
                    }
                  />
                ),
              },
            ]}
          />
          {selectedMonitor && <MonitorResults monitor={selectedMonitor} enabled={d.settings.enabled} onChanged={refresh} />}
          {d.settings.enabled && <RegisterMonitor cardId={props.cardId} strict={d.strictThresholds} onSaved={refresh} />}
        </div>
      </Card>

      <Card
        title="Explainability"
        info={<p>Feature importance and SHAP summaries are produced by your own tooling. RegulAIt records them as evidence on this card with a checksum; it does not compute them.</p>}
      >
        <div className={v.stack}>
          <Table
            rows={d.artefacts}
            rowKey={(x) => x.id}
            empty={<EmptyState title="No explainability evidence" body="Record a feature-importance file from your pipeline below." />}
            columns={[
              { key: "kind", header: "Kind", render: (x) => KIND_LABEL[x.kind] },
              { key: "method", header: "Method", render: (x) => x.method },
              { key: "top", header: "Largest contributions", render: (x) => <TopFeatures artefact={x} /> },
              { key: "when", header: "Recorded", render: (x) => ago(x.createdAt), sort: (x) => x.createdAt },
              {
                key: "actions",
                header: "",
                srHeader: "Actions",
                render: (x) => (
                  <RowActions
                    slot="8rem"
                    rest={
                      <Button size="sm" variant="danger" aria-label={`Delete ${KIND_LABEL[x.kind]} (${x.method})`} onClick={() => setConfirm({ kind: "artefact", id: x.id, label: `${KIND_LABEL[x.kind]} (${x.method})` })}>
                        Delete
                      </Button>
                    }
                  />
                ),
              },
            ]}
          />
          {d.settings.enabled && <RecordArtefact cardId={props.cardId} onSaved={refresh} />}
        </div>
      </Card>

      <ConfirmModal
        open={confirm !== null}
        danger
        title={confirm?.kind === "monitor" ? "Delete this drift monitor?" : "Delete this explainability evidence?"}
        body={
          confirm?.kind === "monitor"
            ? `'${confirm.label}' and every summary recorded against it are removed. This needs a step-up and is recorded in the audit log.`
            : `${confirm?.label ?? ""} is removed from this card. This needs a step-up and is recorded in the audit log.`
        }
        confirmLabel="Delete"
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          const c = confirm;
          setConfirm(null);
          if (!c) return;
          void act.run(async () => {
            const path = c.kind === "monitor" ? `/v1/model-drift/monitors/${c.id}` : `/v1/mrm/cards/${props.cardId}/explainability/${c.id}`;
            await withStepUp((h) => stepUpApi.del(path, undefined, h));
            if (c.kind === "monitor" && selected === c.id) setSelected(null);
            refresh();
          }, "Deleted");
        }}
      />
    </div>
  );
}

function TopFeatures(props: { artefact: ExplainabilityArtefact }) {
  const top = topImportances(props.artefact.importances);
  return (
    <span>
      {top.map((t) => `${t.feature} (${t.value.toFixed(3)})`).join(", ")}
      {props.artefact.featureCount > top.length && <span className={v.faint}> and {props.artefact.featureCount - top.length} more</span>}
    </span>
  );
}

function ResultsTable(props: { results: FeatureResult[] }) {
  return (
    <Table
      rows={props.results}
      rowKey={(r) => r.feature}
      columns={[
        { key: "feature", header: "Feature", render: (r) => r.feature, sort: (r) => r.feature },
        {
          key: "status",
          header: "Status",
          render: (r) => (
            <span>
              <Badge tone={statusTone(r.status)}>{STATUS_LABEL[r.status]}</Badge> <span className={v.faint}>{breachedText(r.breached)}</span>
            </span>
          ),
          sort: (r) => r.status,
        },
        { key: "psi", header: "PSI", align: "right", render: (r) => stat(r.psi), sort: (r) => r.psi },
        {
          key: "ks",
          header: "KS distance",
          align: "right",
          info: <p>Numeric features only. On binned data this is a lower bound on the distance between the raw samples.</p>,
          render: (r) => (r.ksD === null ? "—" : `${stat(r.ksD)} (p ${stat(r.ksP)})`),
        },
        { key: "js", header: "Jensen–Shannon", align: "right", render: (r) => stat(r.js), sort: (r) => r.js },
        { key: "samples", header: "Samples", align: "right", render: (r) => r.samples.toLocaleString("en-GB") },
      ]}
    />
  );
}

function MonitorResults(props: { monitor: DriftMonitor; enabled: boolean; onChanged: () => void }) {
  const m = props.monitor;
  const act = useAction();
  const [upload, setUpload] = useState<{ features: unknown[]; windowStart: string; windowEnd: string } | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [thresholds, setThresholds] = useState<DriftThresholds>(m.thresholds);
  const [older, setOlder] = useState<DriftReport[]>([]);
  const [nextBefore, setNextBefore] = useState<string | null | undefined>(undefined);
  const loosened = loosenedThresholds(thresholds, m.thresholds);
  const latest = m.latestReport;

  return (
    <Card title={`Results — ${m.name}`}>
      <div className={v.stack}>
        {act.error && (
          <div className={v.errLine} role="alert">
            {act.error}
          </div>
        )}
        {latest ? (
          <>
            <div>
              <Badge tone={statusTone(latest.status)}>{STATUS_LABEL[latest.status]}</Badge>{" "}
              <span className={v.faint}>
                window {new Date(latest.windowStart).toLocaleString("en-GB")} to {new Date(latest.windowEnd).toLocaleString("en-GB")} ·{" "}
                {latest.source === "upload" ? "uploaded" : "pushed"} {ago(latest.createdAt)}
              </span>
            </div>
            {latest.status === "drift" && (
              <p>
                An alert is open on <Link to="/admin/governance/alerts">Governance alerts</Link> until a later summary is back within thresholds.
              </p>
            )}
            <ResultsTable results={latest.results} />
          </>
        ) : (
          <EmptyState title="No summary yet" body="Push a summary from your pipeline, or upload one below." />
        )}

        <div>
          <Button
            size="sm"
            variant="default"
            aria-disabled={act.busy}
            onClick={() =>
              void act.run(async () => {
                const q = nextBefore ? `?before=${encodeURIComponent(nextBefore)}` : "";
                const page = await api.get<{ reports: DriftReport[]; nextBefore: string | null }>(`/v1/model-drift/monitors/${m.id}/reports${q}`);
                setOlder((o) => [...o, ...page.reports.filter((r) => !o.some((x) => x.id === r.id))]);
                setNextBefore(page.nextBefore);
              }, null)
            }
          >
            {nextBefore === undefined ? "Show history" : nextBefore === null ? "No older summaries" : "Load older"}
          </Button>
        </div>
        {older.length > 0 && (
          <Table
            rows={older}
            rowKey={(r) => r.id}
            columns={[
              { key: "when", header: "Recorded", render: (r) => new Date(r.createdAt).toLocaleString("en-GB") },
              { key: "status", header: "Status", render: (r) => <Badge tone={statusTone(r.status)}>{STATUS_LABEL[r.status]}</Badge> },
              { key: "drifted", header: "Features in drift", align: "right", render: (r) => r.driftedFeatures },
              { key: "samples", header: "Samples", align: "right", render: (r) => r.sampleCount.toLocaleString("en-GB") },
              { key: "source", header: "Source", render: (r) => (r.source === "upload" ? "Upload" : "Pipeline") },
            ]}
          />
        )}

        {props.enabled && (
          <>
            <Field label="Upload a production summary (JSON)" help="The same features and bin edges as the reference, with windowStart and windowEnd. Aggregates only.">
              <Input
                type="file"
                accept="application/json,.json"
                onChange={(e) =>
                  void readFile(e).then((r) => {
                    setFileError(null);
                    setUpload(null);
                    if (!r) return;
                    if ("error" in r) return setFileError(r.error);
                    const parsed = parseFeatureFile(r.text);
                    if (!parsed.ok) return setFileError(parsed.error);
                    if (!parsed.value.windowStart || !parsed.value.windowEnd) return setFileError("The file needs windowStart and windowEnd (ISO 8601 times).");
                    setUpload({ features: parsed.value.features, windowStart: parsed.value.windowStart, windowEnd: parsed.value.windowEnd });
                  })
                }
              />
            </Field>
            {fileError && (
              <div className={v.errLine} role="alert">
                {fileError}
              </div>
            )}
            <div>
              <Button
                aria-disabled={act.busy || !upload}
                onClick={() => {
                  if (act.busy || !upload) return;
                  void act.run(async () => {
                    const r = await api.post<{ report: DriftReport; alertRaised: boolean }>(`/v1/model-drift/monitors/${m.id}/reports`, { source: "upload", ...upload });
                    setUpload(null);
                    props.onChanged();
                    return `Summary checked: ${STATUS_LABEL[r.report.status]}${r.alertRaised ? " — an alert was opened" : ""}`;
                  });
                }}
              >
                Check summary
              </Button>
            </div>

            <div className={a.formRow}>
              {THRESHOLD_FIELDS.map((f) => (
                <Field key={f.key} label={f.label}>
                  <Input
                    type="number"
                    step="0.01"
                    min="0"
                    value={thresholds[f.key]}
                    onChange={(e) => setThresholds({ ...thresholds, [f.key]: Number(e.target.value) })}
                  />
                </Field>
              ))}
            </div>
            {loosened.length > 0 && <p className={v.faint}>Raising {loosened.join(", ")} makes this monitor alert later, so saving needs a step-up.</p>}
            <div>
              <Button
                variant="default"
                aria-disabled={act.busy}
                onClick={() => {
                  if (act.busy) return;
                  void act.run(async () => {
                    await withStepUp((h) => stepUpApi.patch(`/v1/model-drift/monitors/${m.id}`, { thresholds }, h));
                    props.onChanged();
                  }, "Thresholds saved");
                }}
              >
                Save thresholds
              </Button>
            </div>
          </>
        )}
      </div>
    </Card>
  );
}

function RegisterMonitor(props: { cardId: string; strict: DriftThresholds; onSaved: () => void }) {
  const act = useAction();
  const [name, setName] = useState("");
  const [reference, setReference] = useState<unknown[] | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [thresholds, setThresholds] = useState<DriftThresholds>(props.strict);
  const loosened = loosenedThresholds(thresholds, props.strict);
  return (
    <fieldset className={v.stack}>
      <legend>Register a drift monitor</legend>
      <Field label="Name">
        <Input value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Reference distribution (JSON)" help="Per feature: name, kind (numeric with edges and counts, or categorical with categories and counts). Aggregates only; names and labels that look like personal data are refused.">
        <Input
          type="file"
          accept="application/json,.json"
          onChange={(e) =>
            void readFile(e).then((r) => {
              setFileError(null);
              setReference(null);
              if (!r) return;
              if ("error" in r) return setFileError(r.error);
              const parsed = parseFeatureFile(r.text);
              if (!parsed.ok) return setFileError(parsed.error);
              setReference(parsed.value.features);
            })
          }
        />
      </Field>
      {fileError && (
        <div className={v.errLine} role="alert">
          {fileError}
        </div>
      )}
      <div className={a.formRow}>
        {THRESHOLD_FIELDS.map((f) => (
          <Field key={f.key} label={`${f.label} (default ${props.strict[f.key]})`}>
            <Input type="number" step="0.01" min="0" value={thresholds[f.key]} onChange={(e) => setThresholds({ ...thresholds, [f.key]: Number(e.target.value) })} />
          </Field>
        ))}
      </div>
      {loosened.length > 0 && <p className={v.faint}>{loosened.join(", ")} above the default alerts later, so registering needs a step-up.</p>}
      <div>
        <Button
          variant="primary"
          aria-disabled={act.busy || !reference || name.trim() === ""}
          onClick={() => {
            if (act.busy || !reference || name.trim() === "") return;
            void act.run(async () => {
              await withStepUp((h) => stepUpApi.post(`/v1/mrm/cards/${props.cardId}/drift-monitors`, { name: name.trim(), reference, thresholds }, h));
              setName("");
              setReference(null);
              setThresholds(props.strict);
              props.onSaved();
            }, "Drift monitor registered");
          }}
        >
          Register monitor
        </Button>
      </div>
    </fieldset>
  );
}

function RecordArtefact(props: { cardId: string; onSaved: () => void }) {
  const act = useAction();
  const [kind, setKind] = useState<ExplainabilityArtefact["kind"]>("global_importance");
  const [method, setMethod] = useState("");
  const [note, setNote] = useState("");
  const [importances, setImportances] = useState<Array<{ feature: string; value: number }> | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  return (
    <fieldset className={v.stack}>
      <legend>Record explainability evidence</legend>
      <div className={a.formRow}>
        <Field label="Kind">
          <Select value={kind} onChange={(e) => setKind(e.target.value as ExplainabilityArtefact["kind"])}>
            <option value="global_importance">{KIND_LABEL.global_importance}</option>
            <option value="shap_summary">{KIND_LABEL.shap_summary}</option>
          </Select>
        </Field>
        <Field label="Method" help="For example: mean absolute SHAP value, permutation importance.">
          <Input value={method} maxLength={120} onChange={(e) => setMethod(e.target.value)} />
        </Field>
      </div>
      <Field label="Importances (JSON)" help="A list of { feature, value }: one value per feature.">
        <Input
          type="file"
          accept="application/json,.json"
          onChange={(e) =>
            void readFile(e).then((r) => {
              setFileError(null);
              setImportances(null);
              if (!r) return;
              if ("error" in r) return setFileError(r.error);
              const parsed = parseImportanceFile(r.text);
              if (!parsed.ok) return setFileError(parsed.error);
              setImportances(parsed.value);
            })
          }
        />
      </Field>
      {fileError && (
        <div className={v.errLine} role="alert">
          {fileError}
        </div>
      )}
      <Field label="Note (optional)">
        <Textarea value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} />
      </Field>
      <div>
        <Button
          aria-disabled={act.busy || !importances || method.trim() === ""}
          onClick={() => {
            if (act.busy || !importances || method.trim() === "") return;
            void act.run(async () => {
              await api.post(`/v1/mrm/cards/${props.cardId}/explainability`, { kind, method: method.trim(), importances, ...(note.trim() ? { note: note.trim() } : {}) });
              setMethod("");
              setNote("");
              setImportances(null);
              props.onSaved();
            }, "Explainability evidence recorded");
          }}
        >
          Record evidence
        </Button>
      </div>
    </fieldset>
  );
}
