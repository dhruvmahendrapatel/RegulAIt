/**
 * ADR-0182 A12 — "Report an incident": the one form that opens an AI incident,
 * from the register, from a use case's Incidents tab, or pre-filled from a
 * monitor alert, a red-team run or a feedback item (`?new=1&detectionSource=…&sourceRef=…`).
 */
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../api/client";
import { Button, Field, Fieldset, Input, Modal, Select, Textarea } from "../../ui/kit";
import { useAction } from "../admin/adminKit";
import v from "../views.module.css";
import a from "../admin/admin.module.css";
import { CLOCK_DISCLAIMER, CRITERIA, DETECTION_SOURCES, SEVERITIES, impliesSerious, localInputToIso, nowLocalInput, type IncidentDetail } from "./incidentModel";

export interface ReportPrefill {
  useCaseId?: string | null;
  detectionSource?: string | null;
  sourceRef?: string | null;
}

const ROW = { display: "flex", gap: "var(--s2)", alignItems: "center", minHeight: 32 } as const;
const BOX = { width: 18, height: 18, margin: 0, flex: "none" } as const;

export function ReportIncidentModal(props: { open: boolean; prefill?: ReportPrefill; lockUseCase?: boolean; onClose: () => void; onCreated?: (id: string) => void }) {
  const act = useAction();
  const navigate = useNavigate();
  const useCases = useQuery({
    queryKey: ["incidents", "use-case-options"],
    queryFn: () => api.get<{ useCases: Array<{ id: string; name: string }> }>("/v1/use-cases"),
    enabled: props.open && !props.lockUseCase,
    retry: false,
  });
  const [lastKey, setLastKey] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [severity, setSeverity] = useState("high");
  const [source, setSource] = useState("manual");
  const [sourceRef, setSourceRef] = useState("");
  const [useCaseId, setUseCaseId] = useState("");
  const [awareAt, setAwareAt] = useState("");
  const [occurredAt, setOccurredAt] = useState("");
  const [serious, setSerious] = useState(false);
  const [criteria, setCriteria] = useState<string[]>([]);
  const [phi, setPhi] = useState("");
  const key = props.open ? JSON.stringify(props.prefill ?? {}) : null;
  if (key !== lastKey) {
    setLastKey(key);
    setTitle("");
    setSummary("");
    setSeverity("high");
    setSource(props.prefill?.detectionSource ?? "manual");
    setSourceRef(props.prefill?.sourceRef ?? "");
    setUseCaseId(props.prefill?.useCaseId ?? "");
    setAwareAt(nowLocalInput());
    setOccurredAt("");
    setSerious(false);
    setCriteria([]);
    setPhi("");
  }
  const derivedSerious = serious || impliesSerious(criteria);
  const toggle = (id: string) => setCriteria((cs) => (cs.includes(id) ? cs.filter((c) => c !== id) : [...cs, id]));
  const body = () => ({
    title: title.trim(),
    summary: summary.trim(),
    severity,
    detectionSource: source,
    ...(sourceRef.trim() ? { sourceRef: sourceRef.trim() } : {}),
    ...(useCaseId ? { useCaseId } : {}),
    ...(localInputToIso(awareAt) ? { awareAt: localInputToIso(awareAt) } : {}),
    ...(localInputToIso(occurredAt) ? { occurredAt: localInputToIso(occurredAt) } : {}),
    serious: derivedSerious,
    seriousCriteria: criteria,
    ...(criteria.includes("phi_breach") && phi.trim() ? { phiIndividuals: Number(phi) } : {}),
  });
  const ucOptions = useCases.data?.useCases ?? [];
  return (
    <Modal
      open={props.open}
      wide
      title="Report an AI incident"
      onClose={props.onClose}
      actions={
        <>
          <Button onClick={props.onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={act.busy || !title.trim()}
            onClick={() =>
              void (async () => {
                let createdId: string | null = null;
                const ok = await act.run(async () => {
                  const out = await api.post<IncidentDetail>("/v1/incidents", body());
                  createdId = out.incident.id;
                  return `Incident ${out.incident.ref} opened`;
                });
                if (ok && createdId) {
                  props.onClose();
                  if (props.onCreated) props.onCreated(createdId);
                  else navigate(`/incidents/${createdId}`);
                }
              })()
            }
          >
            Open incident
          </Button>
        </>
      }
    >
      <div className={v.stack}>
        <div className={a.formRow}>
          <Field label="Title" grow>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} placeholder="What happened, in a few words" />
          </Field>
          <Field label="Severity">
            <Select value={severity} onChange={(e) => setSeverity(e.target.value)}>
              {SEVERITIES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="What happened">
          <Textarea value={summary} onChange={(e) => setSummary(e.target.value)} rows={4} maxLength={8000} placeholder="Facts first: what the system did, who was affected, what is known so far" />
        </Field>
        <div className={a.formRow}>
          <Field label="Detected by">
            <Select value={source} onChange={(e) => setSource(e.target.value)}>
              {DETECTION_SOURCES.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Source reference (optional)" grow help="The alert, red-team run or feedback item id. Opening from one of those links it to the incident.">
            <Input value={sourceRef} onChange={(e) => setSourceRef(e.target.value)} maxLength={500} />
          </Field>
        </div>
        {!props.lockUseCase && (
          <Field label="Use case" help="An incident on a use case holds its deploy gate while it is open (high, critical or serious), and its EU AI Act tier decides which clocks start.">
            <Select value={useCaseId} onChange={(e) => setUseCaseId(e.target.value)}>
              <option value="">Not about a specific use case</option>
              {useCaseId && !ucOptions.some((u) => u.id === useCaseId) && <option value={useCaseId}>{useCaseId}</option>}
              {ucOptions.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <div className={a.formRow}>
          <Field label="Became aware at (your local time)" help="The notification clocks start here. It cannot be changed later.">
            <Input type="datetime-local" value={awareAt} onChange={(e) => setAwareAt(e.target.value)} />
          </Field>
          <Field label="Occurred at (optional, local time)">
            <Input type="datetime-local" value={occurredAt} onChange={(e) => setOccurredAt(e.target.value)} />
          </Field>
        </div>
        <Fieldset legend="Is it serious?">
          <p className={v.faint}>
            Regulation (EU) 2024/1689, Article 3(49): an incident or malfunctioning of an AI system that directly or indirectly leads to any of
            the harms below is a serious incident. Ticking one marks the incident serious and starts the notification clocks that apply.
          </p>
          {CRITERIA.map((c) => (
            <div key={c.id} style={ROW}>
              <input type="checkbox" style={BOX} id={`inc-crit-${c.id}`} checked={criteria.includes(c.id)} onChange={() => toggle(c.id)} />
              <label htmlFor={`inc-crit-${c.id}`}>
                {c.label} <span className={v.faint}>· {c.cite}</span>
              </label>
            </div>
          ))}
          <div style={ROW}>
            <input type="checkbox" style={BOX} id="inc-serious" checked={derivedSerious} disabled={impliesSerious(criteria)} onChange={(e) => setSerious(e.target.checked)} />
            <label htmlFor="inc-serious">Serious incident (EU AI Act) — the criteria above may still be unclear</label>
          </div>
          {criteria.includes("phi_breach") && (
            <Field label="Individuals affected (if known)" help="Decides which HIPAA notices apply (more than 500 residents of a State: the media; 500 or more: the Secretary at the same time as individuals).">
              <Input type="number" min={0} value={phi} onChange={(e) => setPhi(e.target.value)} placeholder="unknown" />
            </Field>
          )}
          <p className={v.faint}>{CLOCK_DISCLAIMER}</p>
        </Fieldset>
        {act.error && (
          <div className={v.errLine} role="alert">
            {act.error}
          </div>
        )}
      </div>
    </Modal>
  );
}
