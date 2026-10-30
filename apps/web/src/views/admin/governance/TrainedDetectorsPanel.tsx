/**
 * Trained detectors (ADR-0220) — on the Guardrails page, beside the heuristic
 * detector modes. Each row is one trained model (PII recogniser, injection
 * classifier, harm classifier) served by a scoring service registered on the
 * External scorers page. Off by default; every loosening goes through step-up.
 * What a detector needs before it can be turned on stays visible in the form,
 * and a refusal is shown inline.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../../../api/client";
import { ago } from "../../../api/format";
import { Badge, Button, Card, Field, Input, RowActions, Select, Table } from "../../../ui/kit";
import { RefusalNotice } from "../../../ui/RefusalNotice";
import { optionEls, useAction } from "../adminKit";
import { api as stepUpApi, withStepUp } from "../../../stepup/stepUp";
import a from "../admin.module.css";
import v from "../../views.module.css";
import s from "./trainedDetectors.module.css";

type TrainedMode = "log" | "warn" | "block";
type OnFailure = "block" | "heuristic";

interface TrainedDetector {
  kind: string;
  label: string;
  summary: string;
  reportsAs: string;
  phases: string[];
  scorerKind: string;
  enabled: boolean;
  scorerId: string | null;
  scorerName: string | null;
  mode: TrainedMode;
  threshold: number;
  onFailure: OnFailure;
  timeoutMs: number;
  updatedAt: string | null;
}
interface Scorer {
  id: string;
  name: string;
  enabled: boolean;
  scorerKinds: string[];
}

const modeTone = (m: TrainedMode) => (m === "block" ? "danger" : m === "warn" ? "warn" : "info");
const failureWords: Record<OnFailure, string> = {
  block: "Treat as a hit (recommended)",
  heuristic: "Use the rule-based result only",
};

export function TrainedDetectorsPanel() {
  const act = useAction();
  const query = useQuery({
    queryKey: ["admin", "guardrail-trained-detectors"],
    queryFn: () => api.get<{ detectors: TrainedDetector[]; scorers: Scorer[] }>("/v1/guardrails/trained-detectors"),
  });
  const [editing, setEditing] = useState<TrainedDetector | null>(null);
  const [draft, setDraft] = useState<{
    enabled: boolean;
    scorerId: string;
    mode: TrainedMode;
    threshold: string;
    onFailure: OnFailure;
    timeoutMs: string;
  } | null>(null);

  const open = (d: TrainedDetector) => {
    setEditing(d);
    setDraft({
      enabled: d.enabled,
      scorerId: d.scorerId ?? "",
      mode: d.mode,
      threshold: String(d.threshold),
      onFailure: d.onFailure,
      timeoutMs: String(d.timeoutMs),
    });
  };
  const eligible = (query.data?.scorers ?? []).filter((x) => editing && x.scorerKinds.includes(editing.scorerKind));

  return (
    <Card
      title="Trained detectors"
      info={
        <p>
          Trained models that run beside the rule-based detectors: a PII recogniser, a prompt-injection classifier and a
          harm classifier. Each runs in a scoring service you host, with its model files built into the service, so
          nothing is downloaded at run time. They only add findings: the rule-based detectors always run. Results are
          recorded as counts, never as the text that was scanned.
        </p>
      }
    >
      <Table
        rows={query.data?.detectors}
        loading={query.isLoading}
        error={query.error}
        onRetry={() => void query.refetch()}
        rowKey={(d) => d.kind}
        empty="No trained detectors are reported by this gateway."
        columns={[
          {
            key: "label",
            header: "Detector",
            render: (d) => (
              <div className={v.stack} style={{ gap: "var(--s0)" }}>
                <strong>{d.label}</strong>
                <span className={v.faint}>{d.summary}</span>
                <span>
                  <Badge tone="neutral">{d.phases.join(" + ")}</Badge>{" "}
                  <Badge tone="neutral">reports as {d.reportsAs.replace(/_/g, " ")}</Badge>
                </span>
              </div>
            ),
          },
          {
            key: "status",
            header: "Status",
            render: (d) => (d.enabled ? <Badge tone="ok">On</Badge> : <Badge tone="neutral">Off</Badge>),
          },
          {
            key: "service",
            header: "Scoring service",
            render: (d) => d.scorerName ?? <span className={v.faint}>none chosen</span>,
          },
          {
            key: "mode",
            header: "Mode",
            render: (d) => (
              <span>
                <Badge tone={modeTone(d.mode)}>{d.mode}</Badge> at {d.threshold}
              </span>
            ),
          },
          {
            key: "failure",
            header: "If the service fails",
            render: (d) => failureWords[d.onFailure],
          },
          {
            key: "updated",
            header: "Updated",
            render: (d) => (d.updatedAt ? ago(d.updatedAt) : <span className={v.faint}>never</span>),
          },
          {
            key: "actions",
            header: <span className={s.srOnly}>Actions</span>,
            align: "right",
            render: (d) => (
              <RowActions
                slot="7rem"
                primary={
                  <Button size="sm" onClick={() => open(d)} aria-label={`Edit ${d.label}`}>
                    Edit
                  </Button>
                }
              />
            ),
          },
        ]}
      />

      {editing && draft && (
        <form
          className={v.stack}
          style={{ marginTop: "var(--s3)" }}
          aria-label={`Edit ${editing.label}`}
          onSubmit={(e) => {
            e.preventDefault();
            void act.run(async () => {
              await withStepUp((h) =>
                stepUpApi.put(
                  `/v1/guardrails/trained-detectors/${editing.kind}`,
                  {
                    enabled: draft.enabled,
                    scorerId: draft.scorerId || null,
                    mode: draft.mode,
                    threshold: Number(draft.threshold),
                    onFailure: draft.onFailure,
                    timeoutMs: Number(draft.timeoutMs),
                  },
                  h,
                ),
              );
              setEditing(null);
              setDraft(null);
              await query.refetch();
            }, `${editing.label} saved`);
          }}
        >
          <strong>{editing.label}</strong>
          <p className={v.faint}>
            To turn this on you need a scoring service that has passed its connection test, is enabled, and serves{" "}
            <code>{editing.scorerKind}</code>. Register one on the <Link to="/admin/external-scorers">External scorers</Link>{" "}
            page. Loosening any setting asks you to confirm your identity again, and every change is recorded in the
            audit log.
          </p>
          <div className={a.formRow}>
            <Field label="Status">
              <Select
                value={draft.enabled ? "on" : "off"}
                onChange={(e) => setDraft({ ...draft, enabled: e.target.value === "on" })}
              >
                <option value="off">Off</option>
                <option value="on">On</option>
              </Select>
            </Field>
            <Field label="Scoring service" grow>
              <Select value={draft.scorerId} onChange={(e) => setDraft({ ...draft, scorerId: e.target.value })}>
                {optionEls(
                  eligible.map((x) => ({ v: x.id, l: x.enabled ? x.name : `${x.name} (not enabled yet)` })),
                  eligible.length ? "— pick one —" : "— none serves this detector yet —",
                )}
              </Select>
            </Field>
            <Field label="Mode" help="The detector also inherits the mode of the rule-based detector it reports as; the stricter one applies.">
              <Select value={draft.mode} onChange={(e) => setDraft({ ...draft, mode: e.target.value as TrainedMode })}>
                <option value="block">block</option>
                <option value="warn">warn</option>
                <option value="log">log</option>
              </Select>
            </Field>
            <Field label="Threshold" help="A score at or above this counts as a hit. Between 0 and 1; lower catches more.">
              <Input
                type="number"
                min={0.01}
                max={1}
                step={0.01}
                required
                value={draft.threshold}
                onChange={(e) => setDraft({ ...draft, threshold: e.target.value })}
              />
            </Field>
            <Field label="If the service fails" help="Treating a failure as a hit means a slow or unavailable service never lets a call through unchecked.">
              <Select
                value={draft.onFailure}
                onChange={(e) => setDraft({ ...draft, onFailure: e.target.value as OnFailure })}
              >
                <option value="block">{failureWords.block}</option>
                <option value="heuristic">{failureWords.heuristic}</option>
              </Select>
            </Field>
            <Field label="Time limit (ms)" help="Between 200 and 10,000 milliseconds per call. A call that runs over counts as a failure.">
              <Input
                type="number"
                min={200}
                max={10000}
                step={100}
                required
                value={draft.timeoutMs}
                onChange={(e) => setDraft({ ...draft, timeoutMs: e.target.value })}
              />
            </Field>
          </div>
          <RefusalNotice guidance={act.guidance} />
          {act.error && !act.guidance && (
            <div className={v.errLine} role="alert">
              {act.error}
            </div>
          )}
          <div className={v.row}>
            <Button type="submit" variant="primary" disabled={act.busy || (draft.enabled && !draft.scorerId)}>
              Save
            </Button>
            <Button
              type="button"
              onClick={() => {
                setEditing(null);
                setDraft(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      )}
    </Card>
  );
}
