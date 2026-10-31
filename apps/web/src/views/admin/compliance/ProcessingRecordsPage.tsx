/**
 * Privacy — records of processing. Each record says why personal data is processed for an AI system (purpose), on
 * what lawful basis, which data categories, for how long and who receives it, linked to a project or a use case.
 * While the organisation's processing limit is on, an active record is what lets personal data of those categories
 * through a governed dispatch for the linked project; anything else is refused.
 */
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import { api as stepUpApi, putOrgSettings, withStepUp } from "../../../stepup/stepUp";
import { PageHeader } from "../../../shell/AppShell";
import { Badge, Button, Card, EmptyState, Field, Fieldset, Input, Modal, RecordError, RowActions, Select, SkeletonBlock, Table, Textarea } from "../../../ui/kit";
import { RefusalNotice } from "../../../ui/RefusalNotice";
import { optionEls, projectOpts, useAction, useProjects } from "../adminKit";
import {
  categoryList,
  DATA_CATEGORIES,
  DATA_CATEGORY_LABELS,
  label,
  LAWFUL_BASIS_LABELS,
  widens,
  type ProcessingRecord,
} from "./privacyModel";
import p from "./privacy.module.css";
import v from "../../views.module.css";

const RECORDS_KEY = ["admin", "privacy", "records"] as const;
const BASES = Object.entries(LAWFUL_BASIS_LABELS).map(([k, l]) => ({ v: k, l }));

interface Draft {
  name: string;
  purpose: string;
  lawfulBasis: string;
  dataCategories: string[];
  retentionDays: string;
  recipients: string;
  projectId: string;
  useCaseId: string;
}
const EMPTY: Draft = { name: "", purpose: "", lawfulBasis: "", dataCategories: [], retentionDays: "", recipients: "", projectId: "", useCaseId: "" };
const recipientsOf = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);

/** whether the processing limit is on, so the page says what a record does today */
function useLimitOn() {
  return useQuery({
    queryKey: ["admin", "org-settings"],
    queryFn: () => api.get<{ settings: { privacyOpsEnabled?: boolean } }>("/v1/org/settings"),
  });
}

export function LimitStatus() {
  const q = useLimitOn();
  const act = useAction();
  if (q.isLoading) return <SkeletonBlock lines={1} />;
  if (q.error) return <p className={v.errLine} role="alert">Could not read whether the processing limit is on.</p>;
  const on = q.data?.settings?.privacyOpsEnabled === true;
  const toggle = () => {
    if (act.busy) return;
    void act.run(
      () => putOrgSettings({ privacyOpsEnabled: !on }),
      on ? "Processing limit turned off" : "Processing limit turned on",
    );
  };
  return (
    <div className={p.section}>
      <p className={v.hint}>
        <Badge tone={on ? "ok" : "neutral"}>{on ? "Processing limit on" : "Processing limit off"}</Badge>{" "}
        {on
          ? "Personal data in a call is refused unless an active record for its project lists the category. Turning the limit off loosens a security setting, so you will be asked to confirm it's you."
          : "Records are kept but nothing is refused. Turning the limit on refuses personal data in any call whose project has no active record listing its category, including calls that name no project."}
      </p>
      <div>
        <Button aria-disabled={act.busy} onClick={toggle}>
          {on ? "Turn the processing limit off" : "Turn the processing limit on"}
        </Button>
      </div>
      {act.guidance ? (
        <RefusalNotice guidance={act.guidance} />
      ) : (
        act.error && (
          <div className={v.errLine} role="alert">
            {act.error}
          </div>
        )
      )}
    </div>
  );
}

function CategoryChecks(props: { value: string[]; onChange: (next: string[]) => void }) {
  const toggle = (c: string, on: boolean) =>
    props.onChange(on ? [...props.value, c] : props.value.filter((x) => x !== c));
  return (
    <Fieldset legend="Data categories (at least one)">
      <div className={p.categories}>
        {DATA_CATEGORIES.map((c) => (
          <label key={c} className={v.rowTight}>
            <input type="checkbox" checked={props.value.includes(c)} onChange={(e) => toggle(c, e.target.checked)} />
            <span>{DATA_CATEGORY_LABELS[c]}</span>
          </label>
        ))}
      </div>
    </Fieldset>
  );
}

export default function ProcessingRecordsPage() {
  const act = useAction();
  const records = useQuery({
    queryKey: [...RECORDS_KEY],
    queryFn: () => api.get<{ records: ProcessingRecord[]; hasMore: boolean }>("/v1/privacy/processing-records?limit=200"),
  });
  const projects = useProjects();
  const useCases = useQuery({
    queryKey: ["admin", "privacy", "use-cases"],
    queryFn: () => api.get<{ useCases?: Array<{ id: string; name: string }> }>("/v1/use-cases"),
  });
  const [f, setF] = useState<Draft>(EMPTY);
  const [editing, setEditing] = useState<string | null>(null);
  const set = <K extends keyof Draft>(k: K, val: Draft[K]) => setF((s) => ({ ...s, [k]: val }));
  const linkMissing = !f.projectId && !f.useCaseId;
  const canSubmit = f.name.trim() && f.purpose.trim() && f.lawfulBasis && f.dataCategories.length > 0 && Number(f.retentionDays) > 0 && !linkMissing;

  const retire = (r: ProcessingRecord, status: "active" | "retired") =>
    void act.run(
      () =>
        status === "active"
          ? withStepUp((h) => stepUpApi.patch(`/v1/privacy/processing-records/${r.id}`, { status }, h))
          : api.patch(`/v1/privacy/processing-records/${r.id}`, { status }),
      status === "active" ? `“${r.name}” is active again` : `“${r.name}” retired`,
    );

  return (
    <>
      <PageHeader
        title="Records of processing"
        sub="Why each AI system processes personal data, on what basis, and what it may process."
        info={
          <p>
            A record of processing names the purpose, lawful basis, data categories, retention and recipients for an AI
            system, linked to a project or a use case. While the processing limit is on, personal data in a governed call
            is checked against the active records for the call's project, using the same detector as the PII handling mode.
          </p>
        }
      />
      <div className={v.stack}>
        <Card title="Add a record">
          <LimitStatus />
          <form
            className={p.formGrid}
            onSubmit={(e) => {
              e.preventDefault();
              if (!canSubmit || act.busy) return;
              const body = {
                name: f.name.trim(),
                purpose: f.purpose.trim(),
                lawfulBasis: f.lawfulBasis,
                dataCategories: f.dataCategories,
                retentionDays: Number(f.retentionDays),
                recipients: recipientsOf(f.recipients),
                ...(f.projectId ? { projectId: f.projectId } : {}),
                ...(f.useCaseId ? { useCaseId: f.useCaseId } : {}),
              };
              void act
                .run(() => withStepUp((h) => stepUpApi.post("/v1/privacy/processing-records", body, h)), `Record “${body.name}” added`)
                .then((ok) => ok && setF(EMPTY));
            }}
          >
            <Field label="Name">
              <Input required value={f.name} maxLength={160} onChange={(e) => set("name", e.target.value)} placeholder="for example Support reply drafting" />
            </Field>
            <Field label="Lawful basis">
              <Select required value={f.lawfulBasis} onChange={(e) => set("lawfulBasis", e.target.value)}>
                {optionEls(BASES, "Choose a basis")}
              </Select>
            </Field>
            <Field label="Retention (days)">
              <Input required type="number" min={1} max={36500} value={f.retentionDays} onChange={(e) => set("retentionDays", e.target.value)} />
            </Field>
            <Field label="Project">
              <Select value={f.projectId} onChange={(e) => set("projectId", e.target.value)}>
                {optionEls(projectOpts(projects.data?.projects), "No project")}
              </Select>
            </Field>
            <Field label="Use case">
              <Select value={f.useCaseId} onChange={(e) => set("useCaseId", e.target.value)}>
                {optionEls((useCases.data?.useCases ?? []).map((u) => ({ v: u.id, l: u.name })), "No use case")}
              </Select>
            </Field>
            <Field label="Recipients (comma separated)">
              <Input value={f.recipients} onChange={(e) => set("recipients", e.target.value)} placeholder="for example Support team, Hosting provider" />
            </Field>
            <div className={p.wide}>
              <Field label="Purpose" grow>
                <Textarea required rows={2} maxLength={2000} value={f.purpose} onChange={(e) => set("purpose", e.target.value)} />
              </Field>
            </div>
            <div className={p.wide}>
              <CategoryChecks value={f.dataCategories} onChange={(next) => set("dataCategories", next)} />
            </div>
            <div className={p.wide}>
              <p className={v.hint}>
                {linkMissing
                  ? "Link the record to a project, a use case or both."
                  : "Adding a record lets personal data of these categories through, so you will be asked to confirm it's you."}
              </p>
              <Button type="submit" variant="primary" aria-disabled={!canSubmit || act.busy}>
                Add record
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

        <Card flush title="Records" count={records.data?.records?.length}>
          <Table<ProcessingRecord>
            columns={[
              { key: "name", header: "Name", sort: (r) => r.name, render: (r) => r.name },
              {
                key: "link",
                header: "Linked to",
                render: (r) => [r.projectName && `Project ${r.projectName}`, r.useCaseName && `Use case ${r.useCaseName}`].filter(Boolean).join(" · ") || "—",
              },
              { key: "basis", header: "Lawful basis", render: (r) => label(LAWFUL_BASIS_LABELS, r.lawfulBasis) },
              { key: "categories", header: "Data categories", render: (r) => categoryList(r.dataCategories), fold: { md: "name" } },
              { key: "retention", header: "Retention", align: "right", render: (r) => `${r.retentionDays} days`, fold: { md: "basis" } },
              {
                key: "status",
                header: "Status",
                render: (r) => <Badge tone={r.status === "active" ? "ok" : "neutral"}>{r.status === "active" ? "Active" : "Retired"}</Badge>,
              },
              {
                key: "actions",
                header: "",
                srHeader: "Actions",
                render: (r) => (
                  <RowActions
                    slot="7rem"
                    primary={
                      <Button size="sm" aria-label={`Edit record ${r.name}`} onClick={() => setEditing(r.id)}>
                        Edit
                      </Button>
                    }
                    rest={
                      r.status === "active" ? (
                        <Button size="sm" variant="danger" aria-label={`Retire record ${r.name}`} disabled={act.busy} onClick={() => retire(r, "retired")}>
                          Retire
                        </Button>
                      ) : (
                        <Button size="sm" aria-label={`Reactivate record ${r.name}`} disabled={act.busy} onClick={() => retire(r, "active")}>
                          Reactivate
                        </Button>
                      )
                    }
                  />
                ),
              },
            ]}
            rows={records.data?.records ?? []}
            rowKey={(r) => r.id}
            loading={records.isLoading}
            error={records.error}
            onRetry={() => void records.refetch()}
            empty={
              <EmptyState
                title="No records of processing"
                body="Add the first record above. While the processing limit is on, personal data in a call is refused until a record for its project permits it."
              />
            }
          />
        </Card>
      </div>
      {editing && <EditRecordModal id={editing} onClose={() => setEditing(null)} />}
    </>
  );
}

function EditRecordModal(props: { id: string; onClose: () => void }) {
  const act = useAction();
  const q = useQuery({
    queryKey: [...RECORDS_KEY, props.id],
    queryFn: () => api.get<{ record: ProcessingRecord }>(`/v1/privacy/processing-records/${props.id}`),
  });
  const rec = q.data?.record;
  const [f, setF] = useState<Draft | null>(null);
  useEffect(() => {
    if (rec && !f) {
      setF({
        name: rec.name,
        purpose: rec.purpose,
        lawfulBasis: rec.lawfulBasis,
        dataCategories: rec.dataCategories,
        retentionDays: String(rec.retentionDays),
        recipients: rec.recipients.join(", "),
        projectId: rec.projectId ?? "",
        useCaseId: rec.useCaseId ?? "",
      });
    }
  }, [rec, f]);
  const set = <K extends keyof Draft>(k: K, val: Draft[K]) => setF((s) => (s ? { ...s, [k]: val } : s));
  const widening = rec && f ? widens(rec, f.dataCategories, rec.status) : false;
  const valid = f && f.name.trim() && f.purpose.trim() && f.dataCategories.length > 0 && Number(f.retentionDays) > 0;

  const save = () => {
    if (!rec || !f || !valid || act.busy) return;
    const body = {
      name: f.name.trim(),
      purpose: f.purpose.trim(),
      lawfulBasis: f.lawfulBasis,
      dataCategories: f.dataCategories,
      retentionDays: Number(f.retentionDays),
      recipients: recipientsOf(f.recipients),
    };
    const url = `/v1/privacy/processing-records/${rec.id}`;
    void act
      .run(() => (widening ? withStepUp((h) => stepUpApi.patch(url, body, h)) : api.patch(url, body)), `Record “${body.name}” saved`)
      .then((ok) => ok && props.onClose());
  };

  return (
    <Modal
      open
      wide
      title={rec ? `Edit record “${rec.name}”` : "Edit record"}
      onClose={props.onClose}
      actions={
        <>
          <Button onClick={props.onClose}>Cancel</Button>
          <Button variant="primary" aria-disabled={!valid || act.busy} onClick={save}>
            Save record
          </Button>
        </>
      }
    >
      {q.error ? (
        <RecordError error={q.error} noun="record" onRetry={() => void q.refetch()} />
      ) : !f ? (
        <SkeletonBlock lines={4} />
      ) : (
        <div className={p.formGrid}>
          <Field label="Name">
            <Input required value={f.name} maxLength={160} onChange={(e) => set("name", e.target.value)} />
          </Field>
          <Field label="Lawful basis">
            <Select value={f.lawfulBasis} onChange={(e) => set("lawfulBasis", e.target.value)}>
              {optionEls(BASES)}
            </Select>
          </Field>
          <Field label="Retention (days)">
            <Input type="number" min={1} max={36500} value={f.retentionDays} onChange={(e) => set("retentionDays", e.target.value)} />
          </Field>
          <Field label="Recipients (comma separated)">
            <Input value={f.recipients} onChange={(e) => set("recipients", e.target.value)} />
          </Field>
          <div className={p.wide}>
            <Field label="Purpose" grow>
              <Textarea rows={2} maxLength={2000} value={f.purpose} onChange={(e) => set("purpose", e.target.value)} />
            </Field>
          </div>
          <div className={p.wide}>
            <CategoryChecks value={f.dataCategories} onChange={(next) => set("dataCategories", next)} />
          </div>
          <p className={`${v.hint} ${p.wide}`}>
            {widening
              ? "Adding a category lets more personal data through, so you will be asked to confirm it's you."
              : "Removing a category only narrows what is let through."}
          </p>
          {act.guidance ? (
            <div className={p.wide}>
              <RefusalNotice guidance={act.guidance} />
            </div>
          ) : (
            act.error && (
              <div className={`${v.errLine} ${p.wide}`} role="alert">
                {act.error}
              </div>
            )
          )}
        </div>
      )}
    </Modal>
  );
}
