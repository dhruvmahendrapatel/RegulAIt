/**
 * ADR-0222 (P13(a)) — FAIRNESS TESTING, beside Model risk in AI Governance.
 *
 * An admin uploads a labelled evaluation dataset (true outcome, the model's prediction, protected attributes),
 * runs the group fairness metrics against thresholds for one model card, and reads the result. A failing or
 * inconclusive latest run holds that card's sign-off and dispatch while blocking is on. Off until an admin turns
 * it on (with a step-up), because turning it on starts storing sensitive attributes.
 */
import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import { fmtDateTime, plural } from "../../../api/format";
import { PageHeader } from "../../../shell/AppShell";
import { Badge, Button, Card, ConfirmModal, EmptyState, Field, IdChip, Input, RowActions, Select, Table } from "../../../ui/kit";
import { RefusalNotice } from "../../../ui/RefusalNotice";
import { QueryGate, useAction } from "../adminKit";
import { api as stepUpApi, withStepUp } from "../../../stepup/stepUp";
import v from "../../views.module.css";
import ds from "./discoverySources.module.css";
import {
  CHECK_WORDS,
  METRIC_WORDS,
  OUTCOME_WORDS,
  csvHeader,
  fmtMetric,
  useFairness,
  type FairnessDatasetView,
  type FairnessRunView,
  type FairnessSettingsView,
  type FairnessThreshold,
} from "./fairnessModel";

interface CardOption {
  id: string;
  intendedUse: string;
  subjectName?: string | null;
}

function cardLabel(c: CardOption | undefined): string {
  if (!c) return "a model card";
  return c.subjectName ? `${c.subjectName}: ${c.intendedUse}` : c.intendedUse;
}

export default function FairnessTestingPage() {
  const fairness = useFairness();
  const cards = useQuery({
    queryKey: ["admin", "mrm-cards"],
    queryFn: () => api.get<{ cards: CardOption[] }>("/v1/mrm/cards"),
  });
  const [params, setParams] = useSearchParams();
  const openRunId = params.get("run");
  const settings = fairness.data?.settings;

  return (
    <>
      <PageHeader
        title="Fairness testing"
        info={
          <p>
            Measure group fairness for a model card on a labelled evaluation dataset you upload: for each row, the true outcome, the model&apos;s
            prediction and one or more protected attributes. The metrics are computed on the predictions in the file; regulAIt does not run the
            model. A failing or inconclusive latest test holds the card&apos;s sign-off and its use while blocking is on.
          </p>
        }
      />
      <div className={v.stack}>
        <QueryGate loading={fairness.isLoading} error={fairness.error} onRetry={() => void fairness.refetch()}>
          {fairness.data && !settings && (
            <EmptyState title="Fairness testing settings unavailable" body="The settings could not be read. Reload the page, or try again later." />
          )}
          {settings && <SettingsCard settings={settings} />}
          {settings && !settings.enabled && (
            <EmptyState
              title="Fairness testing is off"
              body="Turn it on above to upload evaluation datasets and run tests. Datasets hold protected attributes, so they are kept encrypted and deleted at the retention date."
            />
          )}
          {settings?.enabled && fairness.data && (
            <>
              <RunCard settings={settings} datasets={fairness.data.datasets} cards={cards.data?.cards ?? []} cardsLoading={cards.isLoading} onRun={(id) => setParams({ run: id })} />
              <RunsCard
                runs={fairness.data.runs}
                datasets={fairness.data.datasets}
                cards={cards.data?.cards ?? []}
                openRunId={openRunId}
                onOpen={(id) => setParams(id ? { run: id } : {})}
              />
              <UploadCard settings={settings} />
              <DatasetsCard datasets={fairness.data.datasets} />
            </>
          )}
        </QueryGate>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function SettingsCard({ settings }: { settings: FairnessSettingsView }) {
  const act = useAction();
  const [days, setDays] = useState<string | null>(null);
  const put = (body: Record<string, unknown>, ok: string) =>
    void act.run(() => withStepUp((h) => stepUpApi.put("/v1/mrm/fairness/settings", body, h)), ok);
  const daysValue = days ?? String(settings.datasetRetentionDays);
  const daysNum = Number(daysValue);
  const daysValid = Number.isInteger(daysNum) && daysNum >= settings.limits.retentionDays.min && daysNum <= settings.limits.retentionDays.max;

  return (
    <Card
      title="Fairness testing settings"
      info={
        <p>
          Off by default. Turning it on, turning blocking off or keeping datasets for longer asks you to confirm it&apos;s you, and each change is
          recorded in the audit log.
        </p>
      }
    >
      <div className={v.stack}>
        <p className={v.faint}>
          When on, uploaded datasets keep only the outcome, prediction and protected attribute columns, encrypted, and are deleted after the
          retention period. Results keep group counts and rates only.
        </p>
        <div className={v.row}>
          <Field label="Fairness testing">
            <Select
              value={settings.enabled ? "on" : "off"}
              aria-busy={act.busy}
              onChange={(e) => put({ enabled: e.target.value === "on" }, e.target.value === "on" ? "Fairness testing turned on" : "Fairness testing turned off")}
            >
              <option value="off">Off (default)</option>
              <option value="on">On: store evaluation datasets and run tests</option>
            </Select>
          </Field>
          <Field label="A failing or inconclusive test">
            <Select
              value={settings.blockOnFail ? "block" : "record"}
              aria-busy={act.busy}
              onChange={(e) => put({ blockOnFail: e.target.value === "block" }, "Blocking updated")}
            >
              <option value="block">Holds the model card&apos;s sign-off and use (default)</option>
              <option value="record">Is recorded only</option>
            </Select>
          </Field>
          <Field
            label={`Keep datasets for (days, ${settings.limits.retentionDays.min} to ${settings.limits.retentionDays.max})`}
            error={daysValid ? null : `Enter a whole number from ${settings.limits.retentionDays.min} to ${settings.limits.retentionDays.max}.`}
          >
            <Input inputMode="numeric" value={daysValue} onChange={(e) => setDays(e.target.value)} />
          </Field>
        </div>
        <div className={v.row}>
          <Button
            disabled={act.busy || !daysValid || daysNum === settings.datasetRetentionDays}
            onClick={() => {
              put({ datasetRetentionDays: daysNum }, "Retention updated");
              setDays(null);
            }}
          >
            Save retention
          </Button>
        </div>
        <RefusalNotice guidance={act.guidance} />
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

function UploadCard({ settings }: { settings: FairnessSettingsView }) {
  const act = useAction();
  const [name, setName] = useState("");
  const [csv, setCsv] = useState("");
  const [fileError, setFileError] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [prediction, setPrediction] = useState("");
  const [favourable, setFavourable] = useState("1");
  const [attributes, setAttributes] = useState<string[]>([]);
  const header = useMemo(() => csvHeader(csv), [csv]);
  const maxMb = (settings.limits.maxCsvBytes / (1024 * 1024)).toFixed(0);

  const readFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > settings.limits.maxCsvBytes) {
      setCsv("");
      return setFileError(`The file is larger than ${maxMb} MB. Upload a sample or split it.`);
    }
    setFileError(null);
    setCsv(await file.text());
    if (!name) setName(file.name.replace(/\.csv$/i, "").slice(0, 120));
    setLabel("");
    setPrediction("");
    setAttributes([]);
  };

  const toggle = (c: string) => setAttributes((a) => (a.includes(c) ? a.filter((x) => x !== c) : [...a, c].slice(0, settings.limits.maxAttributes)));
  const ready = name.trim() && csv && label && prediction && favourable.trim() && attributes.length > 0 && label !== prediction;

  const upload = () =>
    void act.run(async () => {
      await api.post("/v1/mrm/fairness/datasets", {
        name: name.trim(),
        csv,
        labelColumn: label,
        predictionColumn: prediction,
        favourableLabel: favourable.trim(),
        protectedAttributes: attributes.filter((a) => a !== label && a !== prediction),
      });
      setCsv("");
      setName("");
      setAttributes([]);
      return "Dataset uploaded";
    });

  return (
    <Card
      title="Upload an evaluation dataset"
      info={
        <p>
          A CSV with a header row, up to {settings.limits.maxRows.toLocaleString()} rows and {maxMb} MB. Outcomes must be binary. Only the
          columns you choose here are kept; every other column is dropped before anything is stored.
        </p>
      }
    >
      <div className={v.stack}>
        <div className={v.row}>
          <Field label="Name">
            <Input value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="CSV file" error={fileError}>
            <input type="file" accept=".csv,text/csv" aria-label="Evaluation dataset file" onChange={(e) => void readFile(e.target.files?.[0])} />
          </Field>
        </div>
        {header.length > 0 && (
          <>
            <div className={v.row}>
              <Field label="True outcome column">
                <Select value={label} onChange={(e) => setLabel(e.target.value)}>
                  <option value="">Choose a column</option>
                  {header.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </Select>
              </Field>
              <Field label="Model prediction column">
                <Select value={prediction} onChange={(e) => setPrediction(e.target.value)}>
                  <option value="">Choose a column</option>
                  {header.map((c) => (
                    <option key={c} value={c} disabled={c === label}>{c}</option>
                  ))}
                </Select>
              </Field>
              <Field label="Value that means the favourable outcome">
                <Input value={favourable} maxLength={200} onChange={(e) => setFavourable(e.target.value)} />
              </Field>
            </div>
            <fieldset className={v.stack}>
              <legend>{`Protected attributes (up to ${settings.limits.maxAttributes})`}</legend>
              <div className={v.row}>
                {header
                  .filter((c) => c !== label && c !== prediction)
                  .map((c) => (
                    <label key={c} className={v.row}>
                      <input type="checkbox" checked={attributes.includes(c)} onChange={() => toggle(c)} />
                      {c}
                    </label>
                  ))}
              </div>
            </fieldset>
          </>
        )}
        <div className={v.row}>
          <Button disabled={act.busy || !ready} aria-busy={act.busy} onClick={upload}>
            Upload dataset
          </Button>
          {!ready && <span className={v.faint}>Choose a file, the outcome and prediction columns, and at least one protected attribute.</span>}
        </div>
        <RefusalNotice guidance={act.guidance} />
        {act.error && !act.guidance && <p role="alert">{act.error}</p>}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Datasets
// ---------------------------------------------------------------------------

function DatasetsCard({ datasets }: { datasets: FairnessDatasetView[] }) {
  const act = useAction();
  const [deleting, setDeleting] = useState<FairnessDatasetView | null>(null);
  return (
    <Card title="Evaluation datasets" count={datasets.length} countNoun={["dataset", "datasets"]} contain>
      <Table<FairnessDatasetView>
        rows={datasets}
        rowKey={(d) => d.id}
        empty={<EmptyState title="No datasets yet" body="Upload a labelled evaluation dataset above." />}
        columns={[
          { key: "name", header: "Dataset", render: (d) => d.name, sort: (d) => d.name },
          { key: "rows", header: "Rows", render: (d) => d.rowCount.toLocaleString(), sort: (d) => d.rowCount },
          { key: "attrs", header: "Protected attributes", render: (d) => d.protectedAttributes.join(", ") },
          {
            key: "kept",
            header: "Stored until",
            render: (d) =>
              d.rowsStored ? (
                fmtDateTime(d.expiresAt)
              ) : (
                <Badge tone="neutral">{d.purgeReason === "deleted" ? "Rows deleted" : "Rows deleted at retention"}</Badge>
              ),
          },
          { key: "uploaded", header: "Uploaded", render: (d) => fmtDateTime(d.createdAt), sort: (d) => d.createdAt },
          {
            key: "actions",
            header: <span className={ds.srOnly}>Actions</span>,
            render: (d) => (
              <RowActions
                slot="2rem"
                rest={
                  d.rowsStored ? (
                    <Button size="sm" variant="danger" aria-label={`Delete rows of ${d.name}`} disabled={act.busy} onClick={() => setDeleting(d)}>
                      Delete rows
                    </Button>
                  ) : null
                }
              />
            ),
          },
        ]}
      />
      <ConfirmModal
        open={deleting !== null}
        danger
        title={`Delete the rows of ${deleting?.name ?? "this dataset"}?`}
        body="The rows are deleted now and cannot be recovered. The dataset's fingerprint and every test result that used it are kept."
        confirmLabel="Delete rows"
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          const d = deleting;
          setDeleting(null);
          if (d) void act.run(() => api.del(`/v1/mrm/fairness/datasets/${d.id}`), "Dataset rows deleted");
        }}
      />
      <RefusalNotice guidance={act.guidance} />
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

function RunCard(props: {
  settings: FairnessSettingsView;
  datasets: FairnessDatasetView[];
  cards: CardOption[];
  cardsLoading: boolean;
  onRun: (runId: string) => void;
}) {
  const act = useAction();
  const [params] = useSearchParams();
  const [cardId, setCardId] = useState(params.get("card") ?? "");
  const [datasetId, setDatasetId] = useState("");
  const [thresholds, setThresholds] = useState<FairnessThreshold[]>(() => props.settings.defaultThresholds.map((t) => ({ ...t })));
  const [minGroup, setMinGroup] = useState(String(props.settings.limits.minGroupSize.default));
  const usable = props.datasets.filter((d) => d.rowsStored && new Date(d.expiresAt).getTime() > Date.now());
  const mg = Number(minGroup);
  const mgValid = Number.isInteger(mg) && mg >= props.settings.limits.minGroupSize.min && mg <= props.settings.limits.minGroupSize.max;
  const limitsValid = thresholds.every((t) => Number.isFinite(t.limit) && t.limit >= 0 && t.limit <= 1);
  const ready = cardId && datasetId && mgValid && limitsValid;

  const run = () =>
    void act.run(async () => {
      const out = await api.post<{ run: FairnessRunView }>("/v1/mrm/fairness/runs", { cardId, datasetId, thresholds, minGroupSize: mg });
      props.onRun(out.run.id);
      return `Test recorded: ${OUTCOME_WORDS[out.run.outcome].label.toLowerCase()}`;
    });

  return (
    <Card title="Run a fairness test" info={<p>Each threshold either fails the test (the strict default) or only flags it. A ratio is checked as a minimum; a difference as a maximum.</p>}>
      <div className={v.stack}>
        <div className={v.row}>
          <Field label="Model card">
            <Select value={cardId} aria-busy={props.cardsLoading} onChange={(e) => setCardId(e.target.value)}>
              <option value="">{props.cardsLoading ? "Loading model cards…" : "Choose a model card"}</option>
              {props.cards.map((c) => (
                <option key={c.id} value={c.id}>{cardLabel(c)}</option>
              ))}
            </Select>
          </Field>
          <Field label="Dataset">
            <Select value={datasetId} onChange={(e) => setDatasetId(e.target.value)}>
              <option value="">{usable.length ? "Choose a dataset" : "No dataset with stored rows"}</option>
              {usable.map((d) => (
                <option key={d.id} value={d.id}>{`${d.name} (${plural(d.rowCount, "row")})`}</option>
              ))}
            </Select>
          </Field>
          <Field
            label="Smallest group to include"
            error={mgValid ? null : `Enter a whole number from ${props.settings.limits.minGroupSize.min} to ${props.settings.limits.minGroupSize.max}.`}
          >
            <Input inputMode="numeric" value={minGroup} onChange={(e) => setMinGroup(e.target.value)} />
          </Field>
        </div>
        <Table<FairnessThreshold>
          rows={thresholds}
          rowKey={(t) => t.metric}
          columns={[
            { key: "metric", header: "Metric", render: (t) => METRIC_WORDS[t.metric].label },
            {
              key: "limit",
              header: "Threshold",
              render: (t) => (
                <Input
                  aria-label={`Threshold for ${METRIC_WORDS[t.metric].label}`}
                  inputMode="decimal"
                  value={String(t.limit)}
                  onChange={(e) => setThresholds((all) => all.map((x) => (x.metric === t.metric ? { ...x, limit: Number(e.target.value) } : x)))}
                />
              ),
            },
            { key: "direction", header: "Checked as", render: (t) => (t.metric === "disparate_impact_ratio" ? "at least" : "at most") },
            {
              key: "action",
              header: "On a breach",
              render: (t) => (
                <Select
                  aria-label={`On a breach of ${METRIC_WORDS[t.metric].label}`}
                  value={t.action}
                  onChange={(e) => setThresholds((all) => all.map((x) => (x.metric === t.metric ? { ...x, action: e.target.value as "fail" | "flag" } : x)))}
                >
                  <option value="fail">Fail the test (default)</option>
                  <option value="flag">Flag only</option>
                </Select>
              ),
            },
          ]}
        />
        {!limitsValid && <p role="alert">Each threshold is a number from 0 to 1.</p>}
        <div className={v.row}>
          <Button variant="primary" disabled={act.busy || !ready} aria-busy={act.busy} onClick={run}>
            Run fairness test
          </Button>
        </div>
        <RefusalNotice guidance={act.guidance} />
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

function RunsCard(props: {
  runs: FairnessRunView[];
  datasets: FairnessDatasetView[];
  cards: CardOption[];
  openRunId: string | null;
  onOpen: (id: string | null) => void;
}) {
  const cardOf = (id: string) => props.cards.find((c) => c.id === id);
  const datasetOf = (id: string) => props.datasets.find((d) => d.id === id);
  // the detail read, so a link to a run older than the list's window still opens it
  const openRun = useQuery({
    queryKey: ["admin", "mrm-fairness-run", props.openRunId],
    enabled: props.openRunId !== null,
    queryFn: () => api.get<{ run: FairnessRunView }>(`/v1/mrm/fairness/runs/${props.openRunId}`),
  });
  const open = openRun.data?.run.id === props.openRunId ? openRun.data.run : null;
  return (
    <>
      <Card title="Test results" count={props.runs.length} countNoun={["result", "results"]} contain>
        <Table<FairnessRunView>
          rows={props.runs}
          rowKey={(r) => r.id}
          empty={<EmptyState title="No tests yet" body="Run a fairness test above." />}
          columns={[
            { key: "card", header: "Model card", render: (r) => cardLabel(cardOf(r.cardId)) },
            { key: "dataset", header: "Dataset", render: (r) => datasetOf(r.datasetId)?.name ?? <IdChip id={r.datasetId} /> },
            {
              key: "outcome",
              header: "Outcome",
              render: (r) => <Badge tone={OUTCOME_WORDS[r.outcome].tone}>{OUTCOME_WORDS[r.outcome].label}</Badge>,
              sort: (r) => r.outcome,
            },
            { key: "at", header: "Run", render: (r) => fmtDateTime(r.createdAt), sort: (r) => r.createdAt },
            {
              key: "actions",
              header: <span className={ds.srOnly}>Actions</span>,
              render: (r) => (
                <RowActions
                  slot="7rem"
                  primary={
                    <Button size="sm" aria-label={`View result for ${cardLabel(cardOf(r.cardId))}`} onClick={() => props.onOpen(r.id)}>
                      View result
                    </Button>
                  }
                />
              ),
            },
          ]}
        />
      </Card>
      {props.openRunId !== null && (
        <QueryGate loading={openRun.isLoading} error={openRun.error} onRetry={() => void openRun.refetch()}>
          {open && <RunDetail run={open} cardLabelText={cardLabel(cardOf(open.cardId))} onClose={() => props.onOpen(null)} />}
        </QueryGate>
      )}
    </>
  );
}

function RunDetail({ run, cardLabelText, onClose }: { run: FairnessRunView; cardLabelText: string; onClose: () => void }) {
  const words = OUTCOME_WORDS[run.outcome];
  return (
    <Card title={`Result: ${cardLabelText}`} actions={<Button size="sm" onClick={onClose}>Close result</Button>}>
      <div className={v.stack} data-testid="fairness-run-detail">
        <p>
          <Badge tone={words.tone}>{words.label}</Badge>{" "}
          {run.blocks
            ? "While blocking is on, this result holds the model card's sign-off and use until a later test passes or flags."
            : "This result does not hold the model card."}
        </p>
        <p>
          <Link to="/admin/model-risk">Open Model risk</Link>
        </p>
        <p className={v.faint}>
          {`${plural(run.result.rowCount, "row")}; groups smaller than ${run.minGroupSize} are left out of the metrics. Computed on the predictions in the file.`}
        </p>
        {run.result.attributes.map((attr) => (
          <section key={attr.attribute} className={v.stack} aria-label={`Protected attribute ${attr.attribute}`}>
            <h3>{attr.attribute}</h3>
            <Table
              rows={run.result.evaluations.filter((e) => e.attribute === attr.attribute)}
              rowKey={(e) => e.metric}
              columns={[
                { key: "metric", header: "Metric", render: (e) => METRIC_WORDS[e.metric].label },
                { key: "value", header: "Value", render: (e) => <span className={v.mono}>{fmtMetric(e.value)}</span> },
                { key: "limit", header: "Threshold", render: (e) => `${e.direction === "min" ? "at least" : "at most"} ${e.limit}` },
                {
                  key: "verdict",
                  header: "Verdict",
                  render: (e) => (
                    <Badge tone={e.status === "pass" ? "ok" : e.status === "breach" && e.action === "fail" ? "danger" : "warn"}>
                      {CHECK_WORDS[e.status]}
                    </Badge>
                  ),
                },
                { key: "why", header: "Note", render: (e) => attr.metrics[e.metric]?.reason ?? (e.status === "breach" && e.action === "flag" ? "flag only" : "") },
              ]}
            />
            <Table
              rows={attr.groups}
              rowKey={(g) => g.group}
              columns={[
                { key: "group", header: "Group", render: (g) => g.group },
                { key: "n", header: "Rows", render: (g) => g.n.toLocaleString() },
                { key: "sel", header: "Favourable predictions", render: (g) => <span className={v.mono}>{fmtMetric(g.selectionRate)}</span> },
                { key: "tpr", header: "True positive rate", render: (g) => <span className={v.mono}>{fmtMetric(g.truePositiveRate)}</span> },
                { key: "fpr", header: "False positive rate", render: (g) => <span className={v.mono}>{fmtMetric(g.falsePositiveRate)}</span> },
                { key: "in", header: "In the metrics", render: (g) => (g.included ? "Yes" : "No, too few rows") },
              ]}
            />
          </section>
        ))}
      </div>
    </Card>
  );
}
