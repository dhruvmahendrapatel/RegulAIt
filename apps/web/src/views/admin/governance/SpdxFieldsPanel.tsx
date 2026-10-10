/**
 * ADR-0189 slice B9 (OWNER DECISION 13, amendment R51): the SPDX fields of one
 * model card or one dataset version, on that record's existing page.
 *
 * What it keeps honest, rendered rather than documented:
 *  - **Collected, never invented.** A property nobody declared stays missing,
 *    and the banner says the SPDX output is `not_producible` until it is
 *    declared, naming exactly the missing properties.
 *  - **Provenance travels with the value.** Each current value shows its source
 *    (supplier declared or admin entered), who declared it and when (the
 *    database clock), and the history keeps every correction and withdrawal.
 *  - **The source is a choice, never a default.** No radio is pre-selected.
 *  - **The confirmation shows exactly what will be recorded**, in the form the
 *    gateway stores it (UTC whole seconds, an https origin, a sorted type list).
 *  - **A refused value is never shown back.** The refusal names the property
 *    and the rule only, in a live region.
 *  - **Admin only.** A non-admin gets nothing from this panel (the gateway
 *    refuses the routes independently); every write is audited server-side in
 *    the same transaction as the value.
 */
import { useEffect, useId, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../../api/client";
import { actorLabel, ago } from "../../../api/format";
import { useSession } from "../../../session/SessionContext";
import { Badge, Button, Field, Fieldset, Input, Modal, Select, Table } from "../../../ui/kit";
import { useToast } from "../../../ui/toast";
import { QueryGate, useUsers } from "../adminKit";
import v from "../../views.module.css";
import s from "./spdxFields.module.css";
import {
  PROPERTY_HINT,
  PROPERTY_LABEL,
  SOURCE_HELP,
  SOURCE_LABEL,
  SPDX_DATASET_TYPES,
  SPDX_SOURCES,
  SUBJECT_LABEL,
  checkSpdxValue,
  isMandatory,
  refusalSentence,
  spdxFieldPath,
  spdxFieldsPath,
  undeclaredSummary,
  utcSeconds,
  valueText,
  type SpdxDeclarationView,
  type SpdxFieldsResponse,
  type SpdxProperty,
  type SpdxSource,
  type SpdxSubjectKind,
} from "./spdxFields";

const lower = (p: SpdxProperty) => PROPERTY_LABEL[p].toLowerCase();
const isTime = (p: SpdxProperty) => p === "releaseTime" || p === "builtTime";

// ---------------------------------------------------------------------------
// the read-only view (pure: rendered by the component tests without a DOM)
// ---------------------------------------------------------------------------

export interface SpdxFieldsViewProps {
  kind: SpdxSubjectKind;
  data: SpdxFieldsResponse;
  names: Map<string, string>;
  /** the model card's pinned model version (used before a declared package version) */
  pinnedModelVersion?: string | null;
  /** null renders no edit controls at all */
  onSet: ((p: SpdxProperty) => void) | null;
  onWithdraw: ((p: SpdxProperty) => void) | null;
}

export function SpdxBanner(props: { kind: SpdxSubjectKind; undeclared: readonly SpdxProperty[]; pinnedModelVersion?: string | null }) {
  const { blocking, optional } = undeclaredSummary(props.kind, props.undeclared, props.pinnedModelVersion);
  const subject = SUBJECT_LABEL[props.kind];
  return (
    <div className={[s.banner, blocking.length ? s.bannerBlocking : ""].join(" ")} data-testid="spdx-banner" data-producible={blocking.length ? "false" : "true"}>
      {blocking.length ? (
        <div>
          <Badge tone="warn">not_producible</Badge>{" "}
          <strong>
            SPDX output for this {subject} is <code>not_producible</code> until {blocking.length === 1 ? "this property is" : "these properties are"} declared:{" "}
            {blocking.map((p) => PROPERTY_LABEL[p]).join(", ")}.
          </strong>{" "}
          The AI BOM never invents a value for a missing property; CycloneDX output is not affected.
        </div>
      ) : (
        <div>
          <Badge tone="ok">all declared</Badge>{" "}
          <strong>Every property SPDX 3.0.1 needs from this {subject} is declared.</strong> The next AI BOM snapshot renders
          SPDX for it.
        </div>
      )}
      {optional.includes("datasetType") && (
        <div>Dataset type is not declared, so the SPDX output records the standard's own <code>noAssertion</code> for it.</div>
      )}
      {optional.includes("packageVersion") && (
        <div>
          Package version is not declared; the card's pinned model version (<code>{props.pinnedModelVersion}</code>) is used
          instead.
        </div>
      )}
    </div>
  );
}

export function SpdxFieldsView(props: SpdxFieldsViewProps) {
  const { kind, data, names } = props;
  const current = new Map(data.current.map((d) => [d.property, d]));
  const admin = props.onSet !== null && props.onWithdraw !== null;
  const [historyFilter, setHistoryFilter] = useState<SpdxProperty | "">("");
  const history = historyFilter ? data.history.filter((h) => h.property === historyFilter) : data.history;
  return (
    <div className={v.stack}>
      <SpdxBanner kind={kind} undeclared={data.undeclared} pinnedModelVersion={props.pinnedModelVersion} />
      <Table<SpdxProperty>
        rows={[...data.declarable]}
        rowKey={(p) => p}
        columns={[
          {
            key: "field",
            header: "Field",
            render: (p) => (
              <>
                {PROPERTY_LABEL[p]}
                {!isMandatory(kind, p, props.pinnedModelVersion) && <span className={v.faint}> (optional)</span>}
              </>
            ),
          },
          {
            key: "value",
            header: "Current value",
            render: (p) => {
              const d = current.get(p);
              return d ? <code data-testid={`spdx-value-${p}`}>{valueText(d)}</code> : <Badge tone="warn">undeclared</Badge>;
            },
          },
          { key: "source", header: "Source", render: (p) => (current.get(p) ? SOURCE_LABEL[current.get(p)!.source] : "—") },
          { key: "who", header: "Declared by", render: (p) => (current.get(p) ? actorLabel(current.get(p)!.declaredByUserId, names) : "—") },
          {
            key: "when",
            header: "Declared at (UTC)",
            render: (p) => {
              const d = current.get(p);
              return d ? (
                <span title={ago(d.declaredAt)}>
                  <time dateTime={d.declaredAt}>{utcSeconds(d.declaredAt)}</time>
                </span>
              ) : (
                "—"
              );
            },
          },
          ...(admin
            ? [
                {
                  key: "actions",
                  header: "Actions",
                  align: "right" as const,
                  render: (p: SpdxProperty) => (
                    <div className={v.row} style={{ justifyContent: "flex-end" }}>
                      <Button size="sm" onClick={() => props.onSet!(p)}>
                        {current.has(p) ? "Correct" : "Set"} {lower(p)}
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        disabled={!current.has(p)}
                        title={current.has(p) ? undefined : "There is no current value to withdraw."}
                        onClick={() => props.onWithdraw!(p)}
                      >
                        Withdraw {lower(p)}
                      </Button>
                    </div>
                  ),
                },
              ]
            : []),
        ]}
      />
      <details data-testid="spdx-history">
        <summary>
          History ({data.history.length}
          {data.history.length >= data.historyLimit ? `, the newest ${data.historyLimit} only` : ""})
        </summary>
        <div className={v.stack} style={{ marginTop: "var(--s2)" }}>
          <Field label="Show the history of">
            <Select value={historyFilter} onChange={(e) => setHistoryFilter(e.target.value as SpdxProperty | "")}>
              <option value="">every field</option>
              {data.declarable.map((p) => (
                <option key={p} value={p}>
                  {PROPERTY_LABEL[p]}
                </option>
              ))}
            </Select>
          </Field>
          <Table<SpdxDeclarationView>
            rows={history}
            rowKey={(h) => String(h.seq)}
            empty="Nothing has been declared for this record yet."
            columns={[
              { key: "seq", header: "#", render: (h) => <span className={v.num}>{h.seq}</span> },
              { key: "field", header: "Field", render: (h) => PROPERTY_LABEL[h.property] },
              { key: "value", header: "Value", render: (h) => (h.withdrawn ? <Badge tone="neutral">withdrawn</Badge> : <code>{valueText(h)}</code>) },
              { key: "source", header: "Source", render: (h) => (h.withdrawn ? "—" : SOURCE_LABEL[h.source]) },
              { key: "who", header: "By", render: (h) => actorLabel(h.declaredByUserId, names) },
              { key: "when", header: "At (UTC)", render: (h) => <time dateTime={h.declaredAt}>{utcSeconds(h.declaredAt)}</time> },
            ]}
          />
          <p className={v.faint}>
            The history is append-only: a correction is a new row and a withdrawal is a row with no value. Nothing here is ever
            edited or deleted.
          </p>
        </div>
      </details>
    </div>
  );
}

// ---------------------------------------------------------------------------
// the refusal live region (always mounted while its dialog is open)
// ---------------------------------------------------------------------------

interface Refusal {
  code: string | null;
  rule: string | null;
  text: string;
}

function RefusalRegion(props: { id: string; refusal: Refusal | null }) {
  return (
    <div aria-live="assertive" data-testid="spdx-refusal" id={props.id}>
      {props.refusal && (
        <div className={s.refusal} role="alert">
          <div className={v.row}>
            <strong>Refused</strong>
            {props.refusal.rule ? <Badge tone="danger">{props.refusal.rule}</Badge> : props.refusal.code ? <Badge tone="danger">{props.refusal.code}</Badge> : null}
          </div>
          <div data-testid="spdx-refusal-text">{props.refusal.text}</div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// the set / correct dialog: edit, then a confirmation of exactly what is recorded
// ---------------------------------------------------------------------------

function SetDialog(props: {
  kind: SpdxSubjectKind;
  subjectId: string;
  property: SpdxProperty;
  current: SpdxDeclarationView | undefined;
  onClose: () => void;
  onRecorded: () => Promise<void>;
}) {
  const { kind, property } = props;
  const ids = useId();
  const inputId = `${ids}-value`;
  const hintId = `${ids}-hint`;
  const refusalId = `${ids}-refusal`;
  const [text, setText] = useState("");
  const [types, setTypes] = useState<string[]>([]);
  const [source, setSource] = useState<SpdxSource | "">("");
  const [step, setStep] = useState<"edit" | "confirm">("edit");
  const [checked, setChecked] = useState<string | string[] | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const summaryRef = useRef<HTMLDListElement>(null);
  const { toast } = useToast();
  const label = PROPERTY_LABEL[property];
  const subject = SUBJECT_LABEL[kind];

  useEffect(() => {
    if (step === "confirm") summaryRef.current?.focus();
  }, [step]);

  const review = () => {
    const c = checkSpdxValue(kind, property, property === "datasetType" ? types : text);
    if (!c.ok) {
      setRefusal({ code: null, rule: c.rule ?? null, text: `${label} ${c.message} Nothing was sent.` });
      inputRef.current?.focus();
      return;
    }
    if (!source) {
      setRefusal({ code: null, rule: null, text: "Choose where this value comes from: supplier declared or admin entered. Nothing was sent." });
      document.getElementById(`${ids}-source-${SPDX_SOURCES[0]}`)?.focus();
      return;
    }
    setRefusal(null);
    setChecked(c.value!);
    setStep("confirm");
  };

  const record = async () => {
    if (checked === null || !source) return;
    setBusy(true);
    try {
      await api.put(spdxFieldPath(kind, props.subjectId, property), { value: checked, source });
      toast(`${label} recorded and audited`, "success");
      await props.onRecorded();
      props.onClose();
    } catch (e) {
      setRefusal(refusalSentence(property, e));
      setStep("edit");
      // focus returns to the value, the thing to change; the refusal is announced by the live region
      requestAnimationFrame(() => inputRef.current?.focus());
    } finally {
      setBusy(false);
    }
  };

  const describedBy = [hintId, refusal ? refusalId : ""].filter(Boolean).join(" ");
  return (
    <Modal
      open
      title={`${props.current ? "Correct" : "Set"} ${lower(property)}`}
      onClose={props.onClose}
      actions={
        step === "edit" ? (
          <>
            <Button onClick={props.onClose}>Cancel</Button>
            <Button variant="primary" onClick={review}>
              Review
            </Button>
          </>
        ) : (
          <>
            <Button onClick={() => setStep("edit")} disabled={busy}>
              Back
            </Button>
            <Button variant="primary" onClick={() => void record()} disabled={busy}>
              {busy ? "Recording…" : "Record value"}
            </Button>
          </>
        )
      }
    >
      <div className={v.stack} data-testid="spdx-set-dialog">
        {step === "edit" ? (
          <>
            {props.current && (
              <p className={v.faint}>
                The current value stays in the history; the new one becomes current. Current: <code>{valueText(props.current)}</code>.
              </p>
            )}
            {property === "datasetType" ? (
              <Fieldset legend={`${label} (one or more)`}>
                <p className={v.faint} id={hintId}>
                  {PROPERTY_HINT[property]}
                </p>
                <div className={s.typeGrid}>
                  {SPDX_DATASET_TYPES.map((t, i) => (
                    <label key={t} className={s.choice}>
                      <input
                        ref={i === 0 ? inputRef : undefined}
                        type="checkbox"
                        checked={types.includes(t)}
                        aria-describedby={describedBy}
                        onChange={(e) => setTypes(e.target.checked ? [...types, t] : types.filter((x) => x !== t))}
                      />
                      <span>{t}</span>
                    </label>
                  ))}
                </div>
              </Fieldset>
            ) : (
              <div className={v.stackTight} style={{ alignItems: "stretch" }}>
                <Field label={isTime(property) ? `${label} (UTC)` : label}>
                  <Input
                    id={inputId}
                    ref={inputRef}
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    aria-describedby={describedBy}
                    aria-invalid={refusal?.rule ? true : undefined}
                    autoComplete="off"
                    spellCheck={false}
                    inputMode={property === "downloadLocation" ? "url" : "text"}
                    placeholder={isTime(property) ? "YYYY-MM-DDThh:mm:ssZ" : property === "downloadLocation" ? "https://host[:port]" : undefined}
                  />
                </Field>
                <p className={v.faint} id={hintId}>
                  {PROPERTY_HINT[property]}
                </p>
              </div>
            )}
            <Fieldset legend="Source (required)">
              <div className={s.choices}>
                {SPDX_SOURCES.map((src) => (
                  <label key={src} className={s.choice}>
                    <input
                      id={`${ids}-source-${src}`}
                      type="radio"
                      name={`${ids}-source`}
                      value={src}
                      checked={source === src}
                      onChange={() => setSource(src)}
                    />
                    <span>
                      <strong>{SOURCE_LABEL[src]}</strong> <span className={v.faint}>— {SOURCE_HELP[src]}</span>
                    </span>
                  </label>
                ))}
              </div>
            </Fieldset>
            <p className={v.faint}>The gateway writes every value to the audit log in the same transaction as the value.</p>
          </>
        ) : (
          <>
            <p>This will be recorded:</p>
            <dl className={s.summary} ref={summaryRef} tabIndex={-1} data-testid="spdx-confirm" aria-label="What will be recorded">
              <dt>Record</dt>
              <dd>
                This {subject} (<code>{props.subjectId}</code>)
              </dd>
              <dt>Field</dt>
              <dd>{label}</dd>
              <dt>Value</dt>
              <dd>
                <code data-testid="spdx-confirm-value">{Array.isArray(checked) ? checked.join(", ") : checked}</code>
              </dd>
              <dt>Source</dt>
              <dd>{source ? SOURCE_LABEL[source] : ""}</dd>
              <dt>Declared by</dt>
              <dd>you</dd>
              <dt>Declared at</dt>
              <dd>the gateway's database clock when you record it</dd>
            </dl>
            <p className={v.faint}>
              The gateway writes the value and its audit record in one transaction. {props.current ? "The previous value stays in the history. " : ""}
              Who declared it, when and from which source stay in this record and the audit trail; they are never written into SPDX or
              CycloneDX output.
            </p>
          </>
        )}
        <RefusalRegion id={refusalId} refusal={refusal} />
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// the withdraw dialog
// ---------------------------------------------------------------------------

function WithdrawDialog(props: {
  kind: SpdxSubjectKind;
  subjectId: string;
  property: SpdxProperty;
  current: SpdxDeclarationView;
  names: Map<string, string>;
  pinnedModelVersion?: string | null;
  onClose: () => void;
  onRecorded: () => Promise<void>;
}) {
  const { kind, property, current } = props;
  const refusalId = useId();
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [busy, setBusy] = useState(false);
  const { toast } = useToast();
  const label = PROPERTY_LABEL[property];
  const mandatory = isMandatory(kind, property, props.pinnedModelVersion);
  const withdraw = async () => {
    setBusy(true);
    try {
      await api.post(`${spdxFieldPath(kind, props.subjectId, property)}/withdraw`, {});
      toast(`${label} withdrawn and audited`, "success");
      await props.onRecorded();
      props.onClose();
    } catch (e) {
      setRefusal(refusalSentence(property, e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      title={`Withdraw ${lower(property)}`}
      onClose={props.onClose}
      actions={
        <>
          <Button onClick={props.onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="danger" onClick={() => void withdraw()} disabled={busy}>
            {busy ? "Withdrawing…" : "Withdraw value"}
          </Button>
        </>
      }
    >
      <div className={v.stack} data-testid="spdx-withdraw-dialog">
        <p>
          The current {lower(property)} <code>{valueText(current)}</code> ({SOURCE_LABEL[current.source]}, declared by{" "}
          {actorLabel(current.declaredByUserId, props.names)} at {utcSeconds(current.declaredAt)}) stops being current. A withdrawal
          row is appended; the history keeps the earlier value.
        </p>
        <p>
          {mandatory
            ? `SPDX output for this ${SUBJECT_LABEL[kind]} becomes not_producible until a ${lower(property)} is declared again.`
            : property === "datasetType"
              ? "The SPDX output records noAssertion for the dataset type until one is declared again."
              : "The card's pinned model version is used as the package version."}
        </p>
        <p className={v.faint}>The gateway writes the withdrawal and its audit record in one transaction.</p>
        <RefusalRegion id={refusalId} refusal={refusal} />
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// the panel
// ---------------------------------------------------------------------------

type PanelProps = { kind: SpdxSubjectKind; subjectId: string; pinnedModelVersion?: string | null };

/** admin-only: a non-admin is shown nothing here and nothing is fetched; the gateway refuses the routes independently */
export function SpdxFieldsPanel(props: PanelProps) {
  const { auth } = useSession();
  if (auth?.isAdmin !== true) return null;
  return <AdminSpdxFieldsPanel {...props} />;
}

function AdminSpdxFieldsPanel(props: PanelProps) {
  const headingId = useId();
  const qc = useQueryClient();
  const queryKey = ["admin", "spdx-fields", props.kind, props.subjectId] as const;
  const fields = useQuery({
    queryKey,
    queryFn: () => api.get<SpdxFieldsResponse>(spdxFieldsPath(props.kind, props.subjectId)),
  });
  const users = useUsers();
  const [setting, setSetting] = useState<SpdxProperty | null>(null);
  const [withdrawing, setWithdrawing] = useState<SpdxProperty | null>(null);
  const names = new Map((users.data?.users ?? []).map((u) => [u.id, u.displayName || u.email]));
  const current = (p: SpdxProperty | null) => (p ? fields.data?.current.find((d) => d.property === p) : undefined);
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey });
  };
  return (
    <section aria-labelledby={headingId} className={v.stack} data-testid="spdx-fields">
      <h3 id={headingId} className={v.sectionTitle}>
        SPDX fields
      </h3>
      <p className={v.faint}>
        The supplier-declared values an SPDX 3.0.1 AI BOM needs and no other record holds (ADR-0189 R51). Only administrators see or
        change them. Every set and every withdrawal is written to the audit log by the gateway, in the same transaction as the value.
      </p>
      <QueryGate loading={fields.isLoading} error={fields.error} onRetry={() => void fields.refetch()}>
        {fields.data && (
          <SpdxFieldsView
            kind={props.kind}
            data={fields.data}
            names={names}
            pinnedModelVersion={props.pinnedModelVersion}
            onSet={setSetting}
            onWithdraw={setWithdrawing}
          />
        )}
      </QueryGate>
      {setting && (
        <SetDialog
          key={setting}
          kind={props.kind}
          subjectId={props.subjectId}
          property={setting}
          current={current(setting)}
          onClose={() => setSetting(null)}
          onRecorded={refresh}
        />
      )}
      {withdrawing && current(withdrawing) && (
        <WithdrawDialog
          key={withdrawing}
          kind={props.kind}
          subjectId={props.subjectId}
          property={withdrawing}
          current={current(withdrawing)!}
          names={names}
          pinnedModelVersion={props.pinnedModelVersion}
          onClose={() => setWithdrawing(null)}
          onRecorded={refresh}
        />
      )}
    </section>
  );
}
