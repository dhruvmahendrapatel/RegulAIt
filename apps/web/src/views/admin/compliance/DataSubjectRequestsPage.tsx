/**
 * Privacy — data-subject requests (access, erasure, objection). A request is recorded with its due date; the subject's
 * email address or phone number is never stored, so locating their data and completing an erasure each ask for it
 * again. Locating returns counts per store. Erasure replaces the identifier in conversations and shared project
 * context; the audit trail is tamper-evident and is never edited, so its matching rows are kept until their retention
 * rule prunes them and a tombstone records them.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import { fmtDay } from "../../../api/format";
import { PageHeader } from "../../../shell/AppShell";
import { Badge, Button, Card, EmptyState, Field, Input, Modal, RecordError, RowActions, Select, SkeletonBlock, Table, Textarea } from "../../../ui/kit";
import { RefusalNotice } from "../../../ui/RefusalNotice";
import { optionEls, useAction } from "../adminKit";
import {
  DSR_KIND_LABELS,
  DSR_STATUS_LABELS,
  DSR_STORE_LABELS,
  ERASURE_LABELS,
  identifierProblem,
  isOpen,
  label,
  type DataSubjectRequest,
  type StoreFinding,
  type Tombstone,
} from "./privacyModel";
import p from "./privacy.module.css";
import v from "../../views.module.css";

const REQUESTS_KEY = ["admin", "privacy", "requests"] as const;
const KINDS = Object.entries(DSR_KIND_LABELS).map(([k, l]) => ({ v: k, l }));
const FILTERS = [
  { v: "open", l: "Open" },
  { v: "closed", l: "Closed" },
  { v: "", l: "All" },
];

function StatusBadge(props: { r: DataSubjectRequest }) {
  const { r } = props;
  if (r.overdue) return <Badge tone="danger">Overdue</Badge>;
  const tone = r.status === "completed" ? "ok" : r.status === "rejected" ? "neutral" : "info";
  return <Badge tone={tone}>{label(DSR_STATUS_LABELS, r.status)}</Badge>;
}

export default function DataSubjectRequestsPage() {
  const act = useAction();
  const [filter, setFilter] = useState("open");
  const q = useQuery({
    queryKey: [...REQUESTS_KEY, filter],
    queryFn: () =>
      api.get<{ requests: DataSubjectRequest[]; hasMore: boolean }>(`/v1/privacy/requests?limit=200${filter ? `&status=${filter}` : ""}`),
  });
  const [f, setF] = useState({ kind: "", identifierKind: "email" as "email" | "phone", identifier: "", reference: "", receivedAt: "" });
  const [opened, setOpened] = useState<string | null>(null);
  const problem = f.identifier ? identifierProblem(f.identifierKind, f.identifier) : null;
  const canSubmit = Boolean(f.kind) && Boolean(f.identifier) && !problem;

  return (
    <>
      <PageHeader
        title="Data subject requests"
        sub="Access, erasure and objection requests, each with its due date."
        info={
          <p>
            A request is recorded without the person's email address or phone number: only a keyed fingerprint is kept,
            so it can be matched when you type the identifier again to locate their data or complete an erasure. The
            audit trail is tamper-evident and is never edited; erasure keeps its rows until their retention rule prunes
            them and records a tombstone.
          </p>
        }
      />
      <div className={v.stack}>
        <Card title="Record a request">
          <form
            className={p.formGrid}
            onSubmit={(e) => {
              e.preventDefault();
              if (!canSubmit || act.busy) return;
              const body = {
                kind: f.kind,
                identifierKind: f.identifierKind,
                identifier: f.identifier,
                ...(f.reference.trim() ? { reference: f.reference.trim() } : {}),
                ...(f.receivedAt ? { receivedAt: new Date(`${f.receivedAt}T00:00:00Z`).toISOString() } : {}),
              };
              void act
                .run(() => api.post("/v1/privacy/requests", body), "Request recorded")
                .then(() => setF((s) => ({ ...s, identifier: "" })));
            }}
          >
            <Field label="Request type">
              <Select required value={f.kind} onChange={(e) => setF((s) => ({ ...s, kind: e.target.value }))}>
                {optionEls(KINDS, "Choose a type")}
              </Select>
            </Field>
            <Field label="Identify the person by">
              <Select value={f.identifierKind} onChange={(e) => setF((s) => ({ ...s, identifierKind: e.target.value as "email" | "phone" }))}>
                <option value="email">Email address</option>
                <option value="phone">Phone number</option>
              </Select>
            </Field>
            <Field label={f.identifierKind === "email" ? "Email address" : "Phone number"} error={problem}>
              <Input
                required
                type={f.identifierKind === "email" ? "email" : "tel"}
                autoComplete="off"
                value={f.identifier}
                onChange={(e) => setF((s) => ({ ...s, identifier: e.target.value }))}
              />
            </Field>
            <Field label="Your reference (optional)">
              <Input value={f.reference} maxLength={120} onChange={(e) => setF((s) => ({ ...s, reference: e.target.value }))} placeholder="for example a ticket number" />
            </Field>
            <Field label="Date received (optional)">
              <Input type="date" value={f.receivedAt} onChange={(e) => setF((s) => ({ ...s, receivedAt: e.target.value }))} />
            </Field>
            <div className={p.wide}>
              <p className={v.hint}>The identifier is not stored. Keep it with the request's source; you need it to locate the data and to complete an erasure.</p>
              <Button type="submit" variant="primary" aria-disabled={!canSubmit || act.busy}>
                Record request
              </Button>
            </div>
          </form>
          {act.guidance ? (
            <RefusalNotice guidance={act.guidance} />
          ) : (
            act.error && (
              <div className={v.errLine} role="alert">
                {act.error}
              </div>
            )
          )}
        </Card>

        <Card
          flush
          title="Requests"
          count={q.data?.requests?.length}
          actions={
            <Field label="Show">
              <Select value={filter} onChange={(e) => setFilter(e.target.value)}>
                {optionEls(FILTERS)}
              </Select>
            </Field>
          }
        >
          <Table<DataSubjectRequest>
            columns={[
              { key: "kind", header: "Type", sort: (r) => r.kind, render: (r) => label(DSR_KIND_LABELS, r.kind) },
              { key: "reference", header: "Reference", render: (r) => r.reference ?? "—" },
              { key: "received", header: "Received", sort: (r) => r.receivedAt, render: (r) => fmtDay(r.receivedAt), fold: { md: "kind" } },
              { key: "due", header: "Due", sort: (r) => r.dueAt, render: (r) => fmtDay(r.dueAt) },
              { key: "status", header: "Status", render: (r) => <StatusBadge r={r} /> },
              {
                key: "actions",
                header: "",
                srHeader: "Actions",
                render: (r) => (
                  <RowActions
                    slot="6rem"
                    primary={
                      <Button size="sm" aria-label={`Open ${label(DSR_KIND_LABELS, r.kind).toLowerCase()} request ${r.reference ?? ""}`.trim()} onClick={() => setOpened(r.id)}>
                        Open
                      </Button>
                    }
                  />
                ),
              },
            ]}
            rows={q.data?.requests ?? []}
            rowKey={(r) => r.id}
            loading={q.isLoading}
            error={q.error}
            onRetry={() => void q.refetch()}
            empty={<EmptyState title={filter === "open" ? "No open requests" : "No requests"} body="Record a request above when a person asks to see, erase or object to the processing of their data." />}
          />
        </Card>
      </div>
      {opened && <RequestModal id={opened} onClose={() => setOpened(null)} />}
    </>
  );
}

function Findings(props: { located: StoreFinding[] }) {
  return (
    <Table<StoreFinding>
      columns={[
        { key: "store", header: "Store", render: (f) => label(DSR_STORE_LABELS, f.store) },
        { key: "matches", header: "Matches", align: "right", render: (f) => String(f.matches) },
        { key: "erasure", header: "On erasure", render: (f) => label(ERASURE_LABELS, f.erasure) },
        { key: "note", header: "Why", render: (f) => f.note, fold: { md: "erasure" } },
      ]}
      rows={props.located}
      rowKey={(f) => f.store}
    />
  );
}

function RequestModal(props: { id: string; onClose: () => void }) {
  const act = useAction();
  const q = useQuery({
    queryKey: [...REQUESTS_KEY, "one", props.id],
    queryFn: () => api.get<{ request: DataSubjectRequest }>(`/v1/privacy/requests/${props.id}`),
  });
  const r = q.data?.request;
  const tombs = useQuery({
    queryKey: [...REQUESTS_KEY, "tombstones", props.id],
    enabled: Boolean(r && r.kind === "erasure" && r.status === "completed"),
    queryFn: () => api.get<{ tombstones: Tombstone[] }>(`/v1/privacy/requests/${props.id}/tombstones`),
  });
  const [identifier, setIdentifier] = useState("");
  const [outcome, setOutcome] = useState("");
  const [note, setNote] = useState("");
  const erasing = r?.kind === "erasure" && outcome === "completed";
  const canLocate = Boolean(identifier.trim()) && !act.busy;
  const canClose = Boolean(outcome) && Boolean(note.trim()) && (!erasing || Boolean(identifier.trim())) && !act.busy;

  return (
    <Modal open wide title={r ? `${label(DSR_KIND_LABELS, r.kind)} request${r.reference ? ` ${r.reference}` : ""}` : "Request"} onClose={props.onClose}>
      {q.error ? (
        <RecordError noun="request" error={q.error} onRetry={() => void q.refetch()} />
      ) : !r ? (
        <SkeletonBlock lines={4} />
      ) : (
        <>
          <p>
            <StatusBadge r={r} /> Received {fmtDay(r.receivedAt)}, due {fmtDay(r.dueAt)}
            {r.closedAt ? `, closed ${fmtDay(r.closedAt)}` : ""}.
          </p>
          {r.closeNote && <p className={v.hint}>{r.closeNote}</p>}
          {r.located && (
            <div className={p.section}>
              <strong>Where the person's data was found</strong>
              <Findings located={r.located} />
              <p className={v.hint}>
                Only these four stores are searched, for the identifier exactly as typed. Data in other systems, in
                message metadata, or written in another format is not found.
              </p>
            </div>
          )}
          {(tombs.data?.tombstones?.length ?? 0) > 0 && (
            <div className={p.section}>
              <strong>Kept under a tombstone</strong>
              {(tombs.data?.tombstones ?? []).map((t) => (
                <p key={t.store} className={v.hint}>
                  {label(DSR_STORE_LABELS, t.store)}: {t.rowCount} {t.rowCount === 1 ? "row" : "rows"}. {t.reason}
                </p>
              ))}
            </div>
          )}
          {isOpen(r) && (
            <>
              <div className={p.section}>
                <Field label={r.identifierKind === "email" ? "The person's email address" : "The person's phone number"}>
                  <Input type={r.identifierKind === "email" ? "email" : "tel"} autoComplete="off" value={identifier} onChange={(e) => setIdentifier(e.target.value)} />
                </Field>
                <div>
                  <Button
                    aria-disabled={!canLocate}
                    onClick={() => canLocate && void act.run(() => api.post(`/v1/privacy/requests/${r.id}/locate`, { identifier }), "Located")}
                  >
                    Locate data
                  </Button>
                </div>
              </div>
              <div className={p.section}>
                <strong>Close the request</strong>
                <div className={p.formGrid}>
                  <Field label="Outcome">
                    <Select value={outcome} onChange={(e) => setOutcome(e.target.value)}>
                      {optionEls(
                        [
                          { v: "completed", l: r.kind === "erasure" ? "Completed: erase the data" : "Completed" },
                          { v: "rejected", l: "Rejected" },
                        ],
                        "Choose an outcome",
                      )}
                    </Select>
                  </Field>
                  <div className={p.wide}>
                    <Field label="Note" grow>
                      <Textarea rows={2} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} />
                    </Field>
                  </div>
                </div>
                {erasing && (
                  <p className={v.hint} role="note">
                    Erasure replaces the identifier above in conversations and shared project context. This cannot be undone.
                    Audit trail rows are kept until their retention rule prunes them, and a tombstone records them. Accounts are
                    not deleted; deactivate a person under Users.
                  </p>
                )}
                <div>
                  <Button
                    variant={erasing ? "danger" : "primary"}
                    aria-disabled={!canClose}
                    onClick={() =>
                      canClose &&
                      void act
                        .run(
                          () => api.post(`/v1/privacy/requests/${r.id}/close`, { outcome, note: note.trim(), ...(erasing ? { identifier } : {}) }),
                          erasing ? "Erased and closed" : "Request closed",
                        )
                        .then((ok) => ok && setIdentifier(""))
                    }
                  >
                    {erasing ? "Erase and close" : "Close request"}
                  </Button>
                </div>
              </div>
            </>
          )}
          {act.guidance ? (
            <RefusalNotice guidance={act.guidance} />
          ) : (
            act.error && (
              <div className={v.errLine} role="alert">
                {act.error}
              </div>
            )
          )}
        </>
      )}
    </Modal>
  );
}
