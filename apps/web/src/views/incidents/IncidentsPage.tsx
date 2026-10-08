/**
 * ADR-0182 (ADR-0175 batch D4) A12 — AI incidents: the register.
 *
 * Anyone may report an incident. The list shows what the reader may see: an
 * admin sees every incident; anyone else the incidents they own and those on
 * a use case they own (the server filters it). Each row shows the next
 * notification clock and whether it is overdue.
 *
 * Admins also get the three incident settings here (the deploy gate, the
 * Art. 73(6) evidence hold, and which regimes' clocks start), each at its
 * strict default unless relaxed, through the audited `PUT /v1/org/settings`.
 */
import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../api/client";
import { PageHeader } from "../../shell/AppShell";
import { Badge, Button, Card, EmptyState, Field, Select, SeverityBadge, Table } from "../../ui/kit";
import { useSession } from "../../session/SessionContext";
import { QueryGate, useAction } from "../admin/adminKit";
import v from "../views.module.css";
import a from "../admin/admin.module.css";
import { ReportIncidentModal } from "./ReportIncidentModal";
import {
  CLOCK_DISCLAIMER,
  INCIDENT_SETTING_COPY,
  REGIMES,
  STATUS_TONE,
  URGENCY_LABEL,
  URGENCY_TONE,
  settingRelaxed,
  utc,
  type GateMode,
  type IncidentListResponse,
  type IncidentSettings,
} from "./incidentModel";
import { putOrgSettings } from "../../stepup/stepUp";

const ROW = { display: "flex", gap: "var(--s2)", alignItems: "center", minHeight: 32 } as const;
const BOX = { width: 18, height: 18, margin: 0, flex: "none" } as const;

function SettingNote(props: { k: keyof IncidentSettings; value: IncidentSettings[keyof IncidentSettings] }) {
  const copy = INCIDENT_SETTING_COPY[props.k];
  const relaxed = settingRelaxed(props.k, props.value);
  return (
    <div className={v.stackTight}>
      <span className={v.faint}>Strict default — {copy.strict}</span>
      {relaxed && (
        <span>
          <Badge tone="warn">relaxed</Badge> <span className={v.faint}>{copy.relaxed}</span>
        </span>
      )}
    </div>
  );
}

/** the admin's controls for the three incident settings (each write audited with its transition) */
function IncidentSettingsCard() {
  const act = useAction();
  const q = useQuery({
    queryKey: ["incidents", "settings"],
    queryFn: () => api.get<{ settings: IncidentSettings }>("/v1/org/settings"),
  });
  const s = q.data?.settings;
  const save = (patch: Partial<IncidentSettings>, msg: string) =>
    void act.run(() => putOrgSettings(patch), msg).then(() => void q.refetch());
  return (
    <Card title="Incident settings">
      <QueryGate loading={q.isLoading} error={q.error} onRetry={() => void q.refetch()}>
        {s && (
          <div className={v.stack}>
            <p className={v.faint}>
              Each setting starts at its strict value. Relaxing one is recorded in the audit log with the old and new value.
            </p>
            <div className={a.formRow}>
              <Field label={INCIDENT_SETTING_COPY.incidentGateMode.label}>
                <Select
                  value={s.incidentGateMode}
                  disabled={act.busy}
                  onChange={(e) => save({ incidentGateMode: e.target.value as GateMode }, `Incident deploy gate set to ${e.target.value}`)}
                >
                  <option value="enforce">Enforce (hold the gate)</option>
                  <option value="warn">Warn only</option>
                  <option value="off">Off</option>
                </Select>
              </Field>
            </div>
            <SettingNote k="incidentGateMode" value={s.incidentGateMode} />
            <div style={ROW}>
              <input
                type="checkbox"
                style={BOX}
                id="inc-set-hold"
                checked={s.incidentEvidenceHold}
                disabled={act.busy}
                onChange={(e) => save({ incidentEvidenceHold: e.target.checked }, e.target.checked ? "Evidence hold on" : "Evidence hold off")}
              />
              <label htmlFor="inc-set-hold">{INCIDENT_SETTING_COPY.incidentEvidenceHold.label}</label>
            </div>
            <SettingNote k="incidentEvidenceHold" value={s.incidentEvidenceHold} />
            <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
              <legend className={v.faint}>{INCIDENT_SETTING_COPY.incidentClockRegimes.label}</legend>
              {REGIMES.map((r) => (
                <div key={r.id} style={ROW}>
                  <input
                    type="checkbox"
                    style={BOX}
                    id={`inc-set-regime-${r.id}`}
                    checked={s.incidentClockRegimes.includes(r.id)}
                    disabled={act.busy}
                    onChange={(e) => {
                      const next = e.target.checked
                        ? REGIMES.map((x) => x.id).filter((id) => id === r.id || s.incidentClockRegimes.includes(id))
                        : s.incidentClockRegimes.filter((id) => id !== r.id);
                      save({ incidentClockRegimes: next }, `Notification clocks: ${next.length ? next.join(", ") : "none"}`);
                    }}
                  />
                  <label htmlFor={`inc-set-regime-${r.id}`}>{r.label}</label>
                </div>
              ))}
            </fieldset>
            <SettingNote k="incidentClockRegimes" value={s.incidentClockRegimes} />
            {act.error && (
              <div className={v.errLine} role="alert">
                {act.error}
              </div>
            )}
          </div>
        )}
      </QueryGate>
    </Card>
  );
}

export default function IncidentsPage() {
  const { auth } = useSession();
  const isAdmin = Boolean(auth?.isAdmin);
  const [params, setParams] = useSearchParams();
  const [status, setStatus] = useState("active");
  const [severity, setSeverity] = useState("");
  const [seriousOnly, setSeriousOnly] = useState(false);
  const reporting = params.get("new") === "1";
  const qs = new URLSearchParams();
  if (status !== "all") qs.set("status", status);
  if (severity) qs.set("severity", severity);
  if (seriousOnly) qs.set("serious", "true");
  const list = useQuery({
    queryKey: ["incidents", "list", status, severity, seriousOnly],
    queryFn: () => api.get<IncidentListResponse>(`/v1/incidents?${qs.toString()}`),
  });
  const rows = list.data?.incidents ?? [];
  const openReport = () => setParams((p) => {
    const n = new URLSearchParams(p);
    n.set("new", "1");
    return n;
  });
  const closeReport = () => setParams(new URLSearchParams());
  return (
    <>
      <PageHeader
        title="AI incidents"
        sub="Incidents involving AI systems, their notification clocks and corrective actions."
        info={
          <>
            <p>
              Record what happened, when you became aware of it, and whether it is serious under the EU AI Act (Article 3(49)) or a breach of protected
              health information. regulAIt starts the notification clocks that apply, holds the use case&apos;s deploy gate while a serious, high or
              critical incident is open, and refuses changes to a linked agent until the authority is told (Article 73(6)), unless an admin overrides
              that change with a reason.
            </p>
            <p>{CLOCK_DISCLAIMER}</p>
          </>
        }
        actions={
          <Button variant="primary" onClick={openReport}>
            Report an incident
          </Button>
        }
      />
      <div className={v.stack}>
        <Card>
          <div className={a.formRow}>
            <Field label="Status">
              <Select value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="active">Not closed</option>
                <option value="open">Open</option>
                <option value="contained">Contained</option>
                <option value="resolved">Resolved</option>
                <option value="closed">Closed</option>
                <option value="all">All</option>
              </Select>
            </Field>
            <Field label="Severity">
              <Select value={severity} onChange={(e) => setSeverity(e.target.value)}>
                <option value="">Any</option>
                <option value="critical">Critical</option>
                <option value="high">High</option>
                <option value="medium">Medium</option>
                <option value="low">Low</option>
              </Select>
            </Field>
            <div style={{ ...ROW, alignSelf: "flex-end" }}>
              <input type="checkbox" style={BOX} id="inc-serious-only" checked={seriousOnly} onChange={(e) => setSeriousOnly(e.target.checked)} />
              <label htmlFor="inc-serious-only">Serious only</label>
            </div>
          </div>
          <p className={v.faint}>
            {list.data?.scope === "all" ? "Showing every incident (admin)." : "Showing the incidents you own or reported, those on use cases you own and those linked to agents you steward."} {CLOCK_DISCLAIMER}
          </p>
          <Table
            rows={rows}
            loading={list.isLoading}
            error={list.error}
            onRetry={() => void list.refetch()}
            rowKey={(r) => r.id}
            empty={<EmptyState title="No incidents" body="Nothing matches these filters. Report one when an AI system causes or nearly causes harm." />}
            columns={[
              {
                key: "ref",
                header: "Incident",
                render: (r) => (
                  <span className={v.stackTight}>
                    <Link to={`/incidents/${r.id}`}>{r.ref}</Link>
                    <span>{r.title}</span>
                  </span>
                ),
              },
              {
                key: "sev",
                header: "Severity",
                render: (r) => (
                  <span style={{ display: "inline-flex", gap: 4, flexWrap: "wrap" }}>
                    <SeverityBadge severity={r.severity} />
                    {r.serious && <Badge tone="danger">serious</Badge>}
                  </span>
                ),
              },
              { key: "status", header: "Status", render: (r) => <Badge tone={STATUS_TONE[r.status]}>{r.status}</Badge> },
              { key: "uc", header: "Use case", render: (r) => (r.useCaseId ? <Link to={`/admin/governance/use-cases/${r.useCaseId}`}>{r.useCaseName ?? "use case"}</Link> : <span className={v.faint}>—</span>) },
              { key: "owner", header: "Owner", render: (r) => r.ownerName ?? <span className={v.faint}>unassigned</span> },
              {
                key: "clock",
                header: "Next clock",
                render: (r) =>
                  r.clocks.nextDue ? (
                    <span className={v.stackTight}>
                      <span>{r.clocks.nextDue.paragraph}</span>
                      <span>
                        <Badge tone={URGENCY_TONE[r.clocks.nextDue.urgency]}>{URGENCY_LABEL[r.clocks.nextDue.urgency]}</Badge>{" "}
                        <span className={v.faint}>due {utc(r.clocks.nextDue.dueAt)}</span>
                      </span>
                    </span>
                  ) : (
                    <span className={v.faint}>{r.clocks.total ? "all final" : "none"}</span>
                  ),
              },
              {
                key: "actions",
                header: "Actions",
                render: (r) => (
                  <span>
                    {r.actions.open} open{r.actions.overdue ? <> · <Badge tone="danger">{r.actions.overdue} overdue</Badge></> : null}
                  </span>
                ),
              },
              { key: "aware", header: "Aware", render: (r) => utc(r.awareAt) },
            ]}
          />
        </Card>
        {isAdmin && <IncidentSettingsCard />}
      </div>
      <ReportIncidentModal
        open={reporting}
        prefill={{ useCaseId: params.get("useCaseId"), detectionSource: params.get("detectionSource"), sourceRef: params.get("sourceRef") }}
        onClose={closeReport}
      />
    </>
  );
}
