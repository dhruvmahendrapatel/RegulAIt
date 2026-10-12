/**
 * Retention holds on traces: which traces are being kept past the retention
 * floor, by which rule, until when — and the audited release. A release ends
 * held evidence early, so it names a reference, states its consequence in a
 * confirmation, and the gateway asks the admin to confirm it is them.
 */
import { useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ago, fmtAt } from "../../../api/format";
import { api as stepUpApi, withStepUp } from "../../../stepup/stepUp";
import { Badge, Button, Card, ConfirmModal, Field, Input, Select, Table } from "../../../ui/kit";
import { QueryGate, optionEls, useAction, useUsers, userOpts } from "../adminKit";
import {
  holdsQuery,
  isActiveHold,
  releaseBody,
  releaseConsequence,
  type ReleaseBody,
  type ReleaseForm,
  type RetentionHold,
  type RetentionHoldsResponse,
} from "./retentionHoldsModel";
import a from "../admin.module.css";
import v from "../../views.module.css";

const EMPTY_RELEASE: ReleaseForm = { scope: "selected", erasure: false, userId: "", reference: "" };

export function RetentionHoldsCard() {
  const users = useUsers();
  const act = useAction();
  const [filters, setFilters] = useState({ traceId: "", userId: "" });
  const query = holdsQuery(filters);
  const [lastQs, setLastQs] = useState(() => (query.ok ? query.qs : "limit=200"));
  if (query.ok && query.qs !== lastQs) setLastQs(query.qs);
  const holds = useQuery({
    queryKey: ["admin", "retention-holds", lastQs],
    queryFn: () => stepUpApi.get<RetentionHoldsResponse>(`/v1/retention-holds?${lastQs}`),
  });
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const [form, setForm] = useState<ReleaseForm>(EMPTY_RELEASE);
  const [problem, setProblem] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ReleaseBody | null>(null);
  const [released, setReleased] = useState<string | null>(null);
  const ids = { intro: useId(), ref: useId(), problem: useId() };
  const nameOf = (id: string) => {
    const u = users.data?.users.find((x) => x.id === id);
    return u ? u.displayName || u.email : null;
  };
  const rows = Array.isArray(holds.data?.holds) ? holds.data.holds : [];
  const set = <K extends keyof ReleaseForm>(k: K, value: ReleaseForm[K]) => {
    setProblem(null);
    setForm((f) => ({ ...f, [k]: value }));
  };
  const toggle = (traceId: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(traceId)) next.delete(traceId);
      else next.add(traceId);
      return next;
    });

  return (
    <Card title="Retention holds">
      <p className={v.faint} id={ids.intro}>
        A hold keeps a trace past the retention floor
        {holds.data?.retention ? ` (${holds.data.retention.floorDays} days; a hold lasts at most ${holds.data.retention.maxHoldDays} days)` : ""}.
        Holds are placed by automation rules. Releasing one ends it now and is recorded with your reference.
      </p>
      <div className={a.formRow}>
        <Field label="Filter by trace id">
          <Input value={filters.traceId} onChange={(e) => setFilters((f) => ({ ...f, traceId: e.target.value }))} placeholder="any trace" />
        </Field>
        <Field label="Filter by person">
          <Select value={filters.userId} onChange={(e) => setFilters((f) => ({ ...f, userId: e.target.value }))}>
            {optionEls(userOpts(users.data?.users), "— anyone —")}
          </Select>
        </Field>
      </div>
      {!query.ok && (
        <p className={v.errLine} role="alert">
          {query.problem}
        </p>
      )}
      <QueryGate loading={holds.isLoading} error={holds.error} onRetry={() => void holds.refetch()}>
        <Table<RetentionHold>
          rows={rows}
          rowKey={(h) => h.traceId}
          empty={<span className={v.faint}>No retention holds match. Traces follow the normal retention schedule.</span>}
          columns={[
            {
              key: "pick",
              header: "",
              width: "40px",
              render: (h) =>
                isActiveHold(h) ? (
                  <input
                    type="checkbox"
                    aria-label={`Select the hold on trace ${h.traceId}`}
                    checked={picked.has(h.traceId)}
                    onChange={() => toggle(h.traceId)}
                  />
                ) : null,
            },
            { key: "trace", header: "Trace", render: (h) => <code>{h.traceId}</code> },
            { key: "who", header: "Person", render: (h) => nameOf(h.traceUserId) ?? <code>{h.traceUserId}</code> },
            {
              key: "until",
              header: "Held until",
              render: (h) =>
                h.releasedAt ? (
                  <Badge tone="neutral">released {ago(h.releasedAt)}</Badge>
                ) : isActiveHold(h) ? (
                  fmtAt(h.holdUntil)
                ) : (
                  <Badge tone="neutral">expired {ago(h.holdUntil)}</Badge>
                ),
              sort: (h) => h.holdUntil,
            },
            { key: "rule", header: "Placed by", render: (h) => (h.ruleId ? <code>{h.ruleId}</code> : <span className={v.faint}>a person</span>) },
            { key: "why", header: "Release reason", render: (h) => h.releaseReason ?? <span className={v.faint}>—</span> },
          ]}
        />
      </QueryGate>

      <form
        aria-label="Release retention holds"
        aria-describedby={ids.intro}
        className={v.stack}
        style={{ marginTop: "var(--s2)" }}
        onSubmit={(e) => {
          e.preventDefault();
          const built = releaseBody(form, [...picked]);
          if (!built.ok) {
            setProblem(built.problem);
            return;
          }
          setConfirm(built.body);
        }}
      >
        <div className={v.sectionTitle}>Release</div>
        <div className={a.formRow}>
          <Field label="What to release">
            <Select value={form.scope} onChange={(e) => set("scope", e.target.value as ReleaseForm["scope"])}>
              <option value="selected">The selected traces ({picked.size})</option>
              <option value="person">Every hold on one person's traces</option>
            </Select>
          </Field>
          {form.scope === "person" && (
            <>
              <Field label="Person">
                <Select value={form.userId} onChange={(e) => set("userId", e.target.value)}>
                  {optionEls(userOpts(users.data?.users), "— choose —")}
                </Select>
              </Field>
              <Field label="Why">
                <Select value={form.erasure ? "erasure" : "admin"} onChange={(e) => set("erasure", e.target.value === "erasure")}>
                  <option value="admin">Administrative decision</option>
                  <option value="erasure">Their erasure request</option>
                </Select>
              </Field>
            </>
          )}
          <Field label="Reference (ticket or erasure request)" grow>
            <Input value={form.reference} maxLength={200} aria-describedby={ids.ref} onChange={(e) => set("reference", e.target.value)} />
          </Field>
        </div>
        <p className={v.faint} id={ids.ref}>
          Required. It is stored on the audit record so a later reviewer can find why the evidence was let go.
        </p>
        <div className={v.row}>
          <Button type="submit" variant="danger" disabled={act.busy} aria-describedby={problem ? ids.problem : undefined}>
            Release holds…
          </Button>
        </div>
        {problem && (
          <p className={v.errLine} role="alert" id={ids.problem}>
            {problem}
          </p>
        )}
        {act.error && (
          <p className={v.errLine} role="alert">
            {act.error}
          </p>
        )}
        {released && (
          <p role="status" className={v.dim}>
            {released}
          </p>
        )}
      </form>
      <ConfirmModal
        open={confirm !== null}
        danger
        title="Release these retention holds?"
        confirmLabel="Release"
        body={confirm ? <p>{releaseConsequence(confirm, "userId" in confirm ? nameOf(confirm.userId) : null)} You will be asked to confirm it is you.</p> : null}
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          const body = confirm;
          setConfirm(null);
          if (!body) return;
          void act
            .run(async () => {
              const out = await withStepUp((h) => stepUpApi.post<{ released: number; traceIds: string[] }>("/v1/retention-holds/release", body, h));
              const sentence = `${out.released} ${out.released === 1 ? "hold" : "holds"} released.`;
              setReleased(sentence);
              return sentence;
            })
            .then((ok) => {
              if (ok) {
                setPicked(new Set());
                setForm(EMPTY_RELEASE);
                void holds.refetch();
              }
            });
        }}
      />
    </Card>
  );
}
