/**
 * Third-party evidence (DefenseClaw) on the Discovery sources page: the ingest sources (off until turned on with a
 * step-up), each source's write-only token (shown once, in component state only), and the newest records a source
 * delivered. Every record is evidence DefenseClaw reported; RegulAIt never enforces it. The gateway stays authoritative.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import { fmtDateTime, humanize } from "../../../api/format";
import { api as stepUpApi, withStepUp } from "../../../stepup/stepUp";
import { Badge, Button, Card, ConfirmModal, EmptyState, Field, IdChip, InfoButton, Input, RowActions, Select, SeverityBadge, Table } from "../../../ui/kit";
import { FoldTable, NewestNote } from "../../../ui/fold";
import { QueryGate, RevealCard, useAction } from "../adminKit";
import v from "../../views.module.css";
import { eventLabel, limitLines, setupNote, type IngestLimits, type IngestRecord, type IngestSource, type IssuedCredential } from "./thirdPartyIngestModel";

export function ThirdPartyIngestCard() {
  const act = useAction();
  const q = useQuery({
    queryKey: ["admin", "third-party-ingest", "sources"],
    queryFn: () => api.get<{ sources: IngestSource[]; limits: IngestLimits }>("/v1/third-party-ingest/sources"),
  });
  const list = q.data?.sources ?? [];
  const limits = q.data?.limits;
  const [name, setName] = useState("");
  const [picked, setPicked] = useState("");
  const sourceId = picked || (list.length === 1 ? list[0]!.id : "");
  const [limit, setLimit] = useState(50);
  // shown once: component state only, gone on Dismiss, on another source, or when the page closes
  const [issued, setIssued] = useState<IssuedCredential | null>(null);
  const [ask, setAsk] = useState<{ s: IngestSource; revoke: boolean } | null>(null);
  const records = useQuery({
    queryKey: ["admin", "third-party-ingest", "records", sourceId, limit],
    enabled: !!sourceId,
    queryFn: () => api.get<{ records: IngestRecord[] }>(`/v1/third-party-ingest/sources/${sourceId}/records?limit=${limit}`),
  });

  const issue = (s: IngestSource) =>
    void act.run(async () => {
      const out = await withStepUp((h) => stepUpApi.post<IssuedCredential>(`/v1/third-party-ingest/sources/${s.id}/credential`, {}, h));
      setIssued(out);
      return `Token issued for '${s.name}'`;
    });
  const confirm = () => {
    const a = ask!;
    setAsk(null);
    if (!a.revoke) return issue(a.s);
    if (issued?.source.id === a.s.id) setIssued(null);
    void act.run(async () => {
      await api.post(`/v1/third-party-ingest/sources/${a.s.id}/credential/revoke`, {});
      return `Token for '${a.s.name}' revoked`;
    });
  };

  return (
    <Card
      title="Third-party evidence (DefenseClaw)"
      info={
        <p>
          DefenseClaw&apos;s log exporter sends its security telemetry here. Each record is kept as evidence DefenseClaw reported, marked third-party;
          RegulAIt never enforces it. A risky record opens a shadow AI finding on the device pseudonym. A new source is off; turning it on or issuing a
          token asks you to confirm it&apos;s you, and every change is audited.
        </p>
      }
      actions={
        <>
          <Badge tone="info">Step-up to turn on · audited</Badge>
          {limits && (
            <InfoButton label="ingest limits" align="end">
              {limitLines(limits).map((l) => <p key={l}>{l}</p>)}
            </InfoButton>
          )}
        </>
      }
    >
      <QueryGate loading={q.isPending} error={q.error} onRetry={() => void q.refetch()}>
        <div className={v.stack}>
          <div className={v.row}>
            <Field label="Source name">
              <Input value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Button
              disabled={act.busy || !name.trim()}
              onClick={() =>
                void act.run(async () => {
                  const out = await api.post<{ source: IngestSource }>("/v1/third-party-ingest/sources", { kind: "defenseclaw", name: name.trim() });
                  setName("");
                  return `Source '${out.source.name}' added; it is off until you turn it on`;
                })
              }
            >
              Add DefenseClaw source
            </Button>
          </div>
          {act.error && <div className={v.errLine} role="alert">{act.error}</div>}
          <Table<IngestSource>
            rows={list}
            rowKey={(s) => s.id}
            empty={<EmptyState title="No DefenseClaw source" body="Add one above. It starts off." />}
            columns={[
              { key: "name", header: "Source", render: (s) => s.name },
              { key: "state", header: "State", render: (s) => <Badge tone={s.enabled ? "ok" : "neutral"}>{s.enabled ? "On" : "Off"}</Badge> },
              { key: "cred", header: "Token", render: (s) => (s.credential ? `Issued ${fmtDateTime(s.credential.issuedAt)}` : "No credential") },
              { key: "created", header: "Created", render: (s) => fmtDateTime(s.createdAt) },
              {
                key: "act",
                header: "",
                srHeader: "Actions",
                render: (s) => (
                  <RowActions
                    slot="7rem"
                    primary={
                      <Button size="sm" aria-label={`${s.enabled ? "Turn off" : "Turn on"} ${s.name}`} disabled={act.busy}
                        onClick={() => void act.run(async () => {
                          await withStepUp((h) => stepUpApi.put(`/v1/third-party-ingest/sources/${s.id}/enabled`, { enabled: !s.enabled }, h));
                          return `'${s.name}' turned ${s.enabled ? "off" : "on"}`;
                        })}
                      >
                        {s.enabled ? "Turn off" : "Turn on"}
                      </Button>
                    }
                    secondary={
                      <Button size="sm" aria-label={`${s.credential ? "Replace token" : "Issue token"} for ${s.name}`} disabled={act.busy} onClick={() => (s.credential ? setAsk({ s, revoke: false }) : issue(s))}>
                        {s.credential ? "Replace token" : "Issue token"}
                      </Button>
                    }
                    rest={s.credential && (
                      <Button size="sm" variant="danger" aria-label={`Revoke token for ${s.name}`} disabled={act.busy} onClick={() => setAsk({ s, revoke: true })}>
                        Revoke token
                      </Button>
                    )}
                  />
                ),
              },
            ]}
          />
          {issued && (
            <RevealCard
              reveal={{ title: `Ingest token for '${issued.source.name}'`, secret: issued.credential.token, note: setupNote(issued.credential, limits?.maxBodyBytes ?? 1_048_576) }}
              onDismiss={() => setIssued(null)}
            />
          )}
          {list.length > 0 && (
            <>
              <div className={v.row}>
                <Field label="Records from">
                  <Select value={sourceId} onChange={(e) => { setPicked(e.target.value); setIssued(null); }}>
                    <option value="">Choose a source</option>
                    {list.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </Select>
                </Field>
                {sourceId && <Button size="sm" onClick={() => setLimit(limit === 50 ? 200 : 50)}>{limit === 50 ? "Show 200" : "Show 50"}</Button>}
              </div>
              {sourceId && (
                <>
                  <p className={v.dim}>Every row is third-party evidence. The action is reported by DefenseClaw, not a RegulAIt decision.</p>
                  <FoldTable<IngestRecord>
                    rows={records.data?.records}
                    loading={records.isPending}
                    error={records.error}
                    onRetry={() => void records.refetch()}
                    rowKey={(r) => r.id}
                    empty={<EmptyState title="No records yet" body="Records appear once DefenseClaw's exporter sends them to this source while it is on." />}
                    columns={[
                      { key: "at", header: "Observed", render: (r) => <>{fmtDateTime(r.observedAt)}<div className={v.dim}>received {fmtDateTime(r.receivedAt)}</div></> },
                      { key: "event", header: "Event", render: (r) => <>{eventLabel(r)} <Badge tone="info">Third-party</Badge></> },
                      { key: "sev", header: "Severity", render: (r) => (r.severity ? <SeverityBadge severity={r.severity} /> : "—"), fold: { sm: "event" } },
                      { key: "action", header: "Reported action", info: "Reported by DefenseClaw, not a RegulAIt decision.", render: (r) => (r.reportedAction ? humanize(r.reportedAction) : "—") },
                      { key: "conn", header: "Connector", render: (r) => r.connector ?? "—", fold: { md: "event" } },
                      { key: "device", header: "Device", render: (r) => <span className={v.mono}>{r.devicePseudonym ?? "—"}</span>, fold: { md: "event" } },
                      { key: "find", header: "Findings", render: (r) => (r.findingIds.length ? r.findingIds.map((id) => <IdChip key={id} id={id} />) : "None") },
                      { key: "hash", header: "Record hash", render: (r) => <IdChip id={r.recordSha256} />, fold: { md: "find" } },
                    ]}
                  />
                  <NewestNote shown={records.data?.records.length ?? 0} limit={limit} noun="records" />
                </>
              )}
            </>
          )}
        </div>
      </QueryGate>
      <ConfirmModal
        open={!!ask}
        title={ask?.revoke ? `Revoke the token for '${ask.s.name}'?` : `Replace the token for '${ask?.s.name}'?`}
        body={<p>The current token stops working{ask?.revoke ? ", and the exporter's batches are refused until you issue a new one." : ". Give the exporter the new one."}</p>}
        confirmLabel={ask?.revoke ? "Revoke token" : "Replace token"}
        danger
        onConfirm={confirm}
        onCancel={() => setAsk(null)}
      />
    </Card>
  );
}
