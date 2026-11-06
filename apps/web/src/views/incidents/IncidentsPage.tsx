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
import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../api/client";
import { PageHeader } from "../../shell/AppShell";
import { Badge, Button, Card, EmptyState, Field, InfoButton, RowActions, Select, SeverityBadge } from "../../ui/kit";
import { FoldTable } from "../../ui/fold";
import { DataList, type DataColumn } from "../../ui/DataList";
import { humanize } from "../../api/format";
import { useSession } from "../../session/SessionContext";
import { QueryGate, useAction } from "../admin/adminKit";
import v from "../views.module.css";
import a from "../admin/admin.module.css";
import { ReportIncidentModal } from "./ReportIncidentModal";
import { CloseIncidentFromList } from "./CloseIncidentModal";
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
  type IncidentListRow,
  type IncidentSettings,
} from "./incidentModel";
import { putOrgSettings } from "../../stepup/stepUp";

const ROW = { display: "flex", gap: "var(--s2)", alignItems: "center", minHeight: 32 } as const;
const BOX = { width: 18, height: 18, margin: 0, flex: "none" } as const;

/** a setting's state stays visible as a pill; what the strict default does, and what relaxing gives up, is its (i) */
function SettingPill(props: { k: keyof IncidentSettings; value: IncidentSettings[keyof IncidentSettings] }) {
  return settingRelaxed(props.k, props.value) ? <Badge tone="warn">Relaxed</Badge> : <Badge tone="ok">Strict default</Badge>;
}
function settingHelp(k: keyof IncidentSettings, value: IncidentSettings[keyof IncidentSettings]) {
  const copy = INCIDENT_SETTING_COPY[k];
  return (
    <>
      <p>Strict default — {copy.strict}</p>
      {settingRelaxed(k, value) && <p>Relaxed — {copy.relaxed}</p>}
    </>
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
    <Card
      title="Incident settings"
      info={<p>Each setting starts at its strict value. Relaxing one is recorded in the audit log with the old and new value.</p>}
    >
      <QueryGate loading={q.isLoading} error={q.error} onRetry={() => void q.refetch()}>
        {s && (
          <div className={v.stack}>
            <div className={a.formRow}>
              <Field
                label={INCIDENT_SETTING_COPY.incidentGateMode.label}
                help={settingHelp("incidentGateMode", s.incidentGateMode)}
                helpLabel={INCIDENT_SETTING_COPY.incidentGateMode.label}
              >
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
              <span style={{ alignSelf: "flex-end", paddingBottom: "var(--s1)" }}>
                <SettingPill k="incidentGateMode" value={s.incidentGateMode} />
              </span>
            </div>
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
              <InfoButton label={INCIDENT_SETTING_COPY.incidentEvidenceHold.label}>
                {settingHelp("incidentEvidenceHold", s.incidentEvidenceHold)}
              </InfoButton>
              <SettingPill k="incidentEvidenceHold" value={s.incidentEvidenceHold} />
            </div>
            <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
              <legend className={v.faint}>
                {INCIDENT_SETTING_COPY.incidentClockRegimes.label}
                <InfoButton label={INCIDENT_SETTING_COPY.incidentClockRegimes.label}>
                  {settingHelp("incidentClockRegimes", s.incidentClockRegimes)}
                </InfoButton>{" "}
                <SettingPill k="incidentClockRegimes" value={s.incidentClockRegimes} />
              </legend>
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
  // G11: the row's Close opens the incident page's own dialog
  const [closing, setClosing] = useState<string | null>(null);
  const filters = useMemo(
    () => ({ status: status === "all" ? undefined : status, severity: severity || undefined, serious: seriousOnly ? "true" : undefined }),
    [status, severity, seriousOnly],
  );
  const [scope, setScope] = useState<IncidentListResponse["scope"] | null>(null);
  const qc = useQueryClient();
  const refetchList = () => void qc.invalidateQueries({ queryKey: ["incidents", "list"] });
  const canClose = (r: IncidentListRow) => r.status !== "closed" && (isAdmin || (auth?.userId != null && r.ownerUserId === auth.userId));
  const columns = useMemo<Array<DataColumn<IncidentListRow>>>(
    () => [
      {
        key: "ref",
        header: "Incident",
        main: true,
        sortable: true,
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
        main: true,
        sortable: true,
        required: "Severity and the serious flag are always shown",
        render: (r) => (
          <span style={{ display: "inline-flex", gap: "var(--s0)", flexWrap: "wrap" }}>
            <SeverityBadge severity={r.severity} />
            {r.serious && <Badge tone="danger">serious</Badge>}
          </span>
        ),
      },
      { key: "status", header: "Status", main: true, sortable: true, required: "Status is always shown", render: (r) => <Badge tone={STATUS_TONE[r.status]}>{r.status}</Badge> },
      { key: "uc", header: "Use case", main: true, sortable: true, fold: { sm: "ref" }, render: (r) => (r.useCaseId ? <Link to={`/admin/governance/use-cases/${r.useCaseId}`}>{r.useCaseName ?? "use case"}</Link> : <span className={v.faint}>—</span>) },
      { key: "owner", header: "Owner", main: true, sortable: true, fold: { md: "ref" }, render: (r) => r.ownerName ?? <span className={v.faint}>unassigned</span> },
      {
        key: "clock",
        header: "Next clock",
        main: true,
        sortable: true,
        required: "The next notification clock is always shown",
        info: <p>{CLOCK_DISCLAIMER}</p>,
        fold: { sm: "ref" },
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
        main: true,
        sortable: true,
        required: "Open and overdue corrective actions are always shown",
        fold: { md: "ref" },
        render: (r) => (
          <span>
            {r.actions.open} open{r.actions.overdue ? <> · <Badge tone="danger">{r.actions.overdue} overdue</Badge></> : null}
          </span>
        ),
      },
      { key: "aware", header: "Aware", sortable: true, fold: { md: "ref" }, render: (r) => utc(r.awareAt) },
      { key: "created", header: "Reported", sortable: true, fold: { md: "ref" }, render: (r) => utc(r.createdAt) },
      { key: "detection", header: "Detected by", sortable: true, fold: { md: "ref" }, render: (r) => humanize(r.detectionSource) },
      { key: "closed", header: "Closed", sortable: true, fold: { md: "ref" }, render: (r) => (r.closedAt ? utc(r.closedAt) : <span className={v.faint}>—</span>) },
      {
        // who may close is the server's rule for editing (owner or admin, never once closed); the dialog says when it is an admin's
        key: "close",
        header: "",
        srHeader: "Actions",
        align: "right",
        action: true,
        // on a phone it moves into the Incident cell (D5), so the register still fits its card
        fold: { sm: "ref" },
        render: (r) =>
          canClose(r) ? (
            <RowActions
              slot="5rem"
              primary={
                <Button size="sm" aria-label={`Close ${r.ref} ${r.title}`} onClick={() => setClosing(r.id)}>
                  Close…
                </Button>
              }
            />
          ) : null,
      },
    ],
    // canClose reads isAdmin and the signed-in user only
    [isAdmin, auth?.userId], // eslint-disable-line react-hooks/exhaustive-deps
  );
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
            {scope === "all" ? "Showing every incident (admin)." : "Showing the incidents you own or reported, those on use cases you own and those linked to agents you steward."}
            {/* the caveat stays visible as a short qualifier; the full sentence is the Next clock (i) and the title (i) */}
            {" "}Clocks are reminders, not legal advice.
          </p>
          <DataList<IncidentListRow>
            listId="incidents"
            noun="incidents"
            endpoint="/v1/incidents"
            exportPath="/v1/incidents/export.xlsx"
            queryKey={["incidents", "list"]}
            legacyKey="incidents"
            filters={filters}
            defaultSort={{ key: "created", dir: "desc" }}
            columns={columns}
            table={FoldTable}
            rowKey={(r) => r.id}
            onRows={(_rows, raw) => setScope((raw.scope as IncidentListResponse["scope"] | undefined) ?? null)}
            empty={<EmptyState title="No incidents" body="Nothing matches these filters. Report one when an AI system causes or nearly causes harm." />}
          />
        </Card>
        {isAdmin && <IncidentSettingsCard />}
      </div>
      {closing && <CloseIncidentFromList key={closing} id={closing} onClose={() => setClosing(null)} onSaved={refetchList} />}
      <ReportIncidentModal
        open={reporting}
        prefill={{ useCaseId: params.get("useCaseId"), detectionSource: params.get("detectionSource"), sourceRef: params.get("sourceRef") }}
        onClose={closeReport}
      />
    </>
  );
}
