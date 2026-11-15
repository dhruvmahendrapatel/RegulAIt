/**
 * Spend by person (lane UI-D, D3; ADR-0312 pilot addendum): each person's spend budget, where their metered spend
 * stands against it, and their budget alerts.
 *
 * Task: an admin sets a monthly spend budget for a person, sees who is past their alert threshold, and opens the
 * person's alerts. The budget is alert-only: nothing is refused on it. Setting or tightening one is audited; removing
 * one is a relaxation, so the gateway asks for a step-up (withStepUp) and the removal sits behind a confirmation.
 *
 * Reads: the budget list (one request), and one person's spend only when their drawer opens (no request per row).
 * Metered spend is compared with the budget; imported spend is shown beside it and never added (ADR-0069).
 * The model is personBudgetModel.ts.
 */
import { useDeferredValue, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import { fmtAt, fmtUsd } from "../../../api/format";
import { PageHeader } from "../../../shell/AppShell";
import { api as stepUpApi, withStepUp } from "../../../stepup/stepUp";
import { DetailDrawer, DrawerActions } from "../../../ui/DetailDrawer";
import { RefusalNotice } from "../../../ui/RefusalNotice";
import { Badge, Button, Card, ConfirmModal, EmptyState, Field, Input, Modal as KitModal, RecordError, RowActions, Select, SkeletonBlock, Table } from "../../../ui/kit";
import { QueryGate, useAction, useUserPicker } from "../adminKit";
import {
  DEFAULT_THRESHOLD_PCT,
  PERIOD_WORDS,
  STANDING_TONE,
  STANDING_WORDS,
  amountProblem,
  budgetBody,
  budgetLine,
  matchesName,
  pctWords,
  peopleWithoutBudget,
  periodWords,
  standing,
  thresholdProblem,
  type BudgetPeriod,
  type PersonBudget,
  type PersonBudgetView,
} from "./personBudgetModel";
import v from "../../views.module.css";

const KEYS = {
  list: ["admin", "user-spend-budgets"] as const,
  one: (userId: string) => ["admin", "user-spend-budget", userId] as const,
};

export default function PersonBudgetsPage() {
  const list = useQuery({
    queryKey: KEYS.list,
    queryFn: () => api.get<{ budgets: PersonBudget[]; limit: number }>("/v1/user-spend-budgets"),
  });
  const [filter, setFilter] = useState("");
  const deferred = useDeferredValue(filter);
  const [openId, setOpenId] = useState<string | null>(null);
  const [editing, setEditing] = useState<PersonBudget | "new" | null>(null);

  const budgets = list.data?.budgets ?? [];
  const shown = useMemo(() => budgets.filter((b) => matchesName(b, deferred)), [budgets, deferred]);
  const open = budgets.find((b) => b.userId === openId) ?? null;

  return (
    <>
      <PageHeader
        title="Spend by person"
        crumbs={["Cost & optimisation", "Spend by person"]}
        sub="Each person's spend budget, and whether their metered spend has crossed its alert threshold."
        info={
          <p>
            A person's budget raises an alert when their metered spend in the budget window reaches the alert
            threshold, and a high alert at 100%. It never blocks a call. Spend imported from vendor exports is shown
            beside metered spend and is never added to it. Alerts appear with every other governance alert.
          </p>
        }
      />
      <div className={v.stack}>
        <Card
          title="Budgets"
          count={list.data ? shown.length : null}
          total={list.data && deferred.trim() ? budgets.length : undefined}
          countNoun={["person", "people"]}
          actions={
            <Button variant="primary" onClick={() => setEditing("new")}>
              Set a budget
            </Button>
          }
        >
          <div className={v.row} style={{ marginBottom: "var(--s1)" }}>
            <Field label="Filter by name">
              <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Name" />
            </Field>
            <span className={v.dim}>
              <Link to="/admin/governance/alerts">Open budget alerts</Link>
              {" · "}
              <Link to="/admin/cost-consolidation">Spend by person across vendors</Link>
            </span>
          </div>
          <Table<PersonBudget>
            loading={list.isLoading}
            error={list.error}
            onRetry={() => void list.refetch()}
            rows={shown}
            rowKey={(b) => b.id}
            rowLabel={(b) => `Open spend for ${b.displayName ?? "this person"}`}
            onRowClick={(b) => setOpenId(b.userId)}
            empty={
              deferred.trim() ? (
                <EmptyState title="No one matches that name" />
              ) : (
                <EmptyState
                  title="No spend budgets yet"
                  body="Set a budget for a person to be alerted when their spend reaches it."
                />
              )
            }
            columns={[
              { key: "name", header: "Person", render: (b) => b.displayName ?? "Unnamed person", sort: (b) => b.displayName ?? "" },
              { key: "budget", header: "Budget", render: (b) => budgetLine(b), sort: (b) => b.budgetUsd, align: "right" },
              { key: "period", header: "Window", render: (b) => periodWords(b.budgetPeriod) },
              { key: "updated", header: "Last changed", render: (b) => (b.updatedAt ? fmtAt(b.updatedAt) : "—") },
              {
                key: "actions",
                header: "",
                srHeader: "Actions",
                render: (b) => (
                  <RowActions
                    slot="person-budget"
                    primary={
                      <Button
                        size="sm"
                        aria-label={`View spend for ${b.displayName ?? "this person"}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          setOpenId(b.userId);
                        }}
                      >
                        View spend
                      </Button>
                    }
                    secondary={
                      <Button
                        size="sm"
                        aria-label={`Change budget for ${b.displayName ?? "this person"}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          setEditing(b);
                        }}
                      >
                        Change budget
                      </Button>
                    }
                  />
                ),
              },
            ]}
          />
        </Card>
      </div>

      {open && <PersonSpendDrawer budget={open} onClose={() => setOpenId(null)} onEdit={() => setEditing(open)} />}
      {editing && (
        <BudgetFormModal
          existing={editing === "new" ? null : editing}
          budgets={budgets}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}

function PersonSpendDrawer(props: { budget: PersonBudget; onClose: () => void; onEdit: () => void }) {
  const { budget } = props;
  const name = budget.displayName ?? "this person";
  const q = useQuery({
    queryKey: KEYS.one(budget.userId),
    queryFn: () => api.get<PersonBudgetView>(`/v1/users/${budget.userId}/spend-budget`),
    retry: false,
  });
  const act = useAction();
  const [confirmRemove, setConfirmRemove] = useState(false);
  const view = q.data;
  const st = view ? standing(view) : null;

  const remove = () => {
    setConfirmRemove(false);
    void act
      .run(() => withStepUp((h) => stepUpApi.del(`/v1/users/${budget.userId}/spend-budget`, undefined, h)), `Budget for ${name} removed`)
      .then((ok) => {
        if (ok) props.onClose();
      });
  };

  return (
    <DetailDrawer
      type="Spend budget"
      title={name}
      subjectKey={budget.userId}
      onClose={props.onClose}
      meta={st ? <Badge tone={STANDING_TONE[st]}>{STANDING_WORDS[st]}</Badge> : null}
    >
      {q.isLoading ? (
        <SkeletonBlock lines={4} />
      ) : q.isError || !view ? (
        <RecordError noun="spend budget" error={q.error} onRetry={() => void q.refetch()} />
      ) : (
        <div className={v.stack}>
          <p>{budgetLine(view.budget)}. {periodWords(view.budget.budgetPeriod)}.</p>
          <dl className={v.stackTight}>
            <div>
              <dt className={v.dim}>Metered spend{view.window.period !== "lifetime" ? ` in ${view.window.period}` : ""}</dt>
              <dd>
                {fmtUsd(view.metered.usd)} · {pctWords(view.metered.pctOfBudget)}
              </dd>
            </div>
            <div>
              <dt className={v.dim}>Imported spend (vendor exports, not added)</dt>
              <dd>
                {fmtUsd(view.imported.usd)}
                {view.imported.nonUsdLines > 0
                  ? ` · ${view.imported.nonUsdLines === 1 ? "1 line" : `${view.imported.nonUsdLines} lines`} in another currency not shown`
                  : ""}
              </dd>
            </div>
          </dl>
          <p className={v.dim}>The alert compares metered spend with the budget.</p>
          <p>
            <Link to="/admin/governance/alerts">Open budget alerts</Link>
          </p>
          {act.error && (
            <p className={v.errLine} role="alert">
              {act.error}
            </p>
          )}
          <RefusalNotice guidance={act.guidance} />
        </div>
      )}
      <DrawerActions>
        <RowActions
          primary={
            <Button variant="primary" onClick={props.onEdit}>
              Change budget
            </Button>
          }
          secondary={
            <Button variant="danger" disabled={act.busy} onClick={() => setConfirmRemove(true)}>
              Remove budget
            </Button>
          }
        />
      </DrawerActions>
      <ConfirmModal
        open={confirmRemove}
        danger
        title={`Remove the spend budget for ${name}?`}
        confirmLabel="Remove budget"
        body={<p>{name}'s spend stops raising budget alerts. You will be asked to confirm it's you.</p>}
        onCancel={() => setConfirmRemove(false)}
        onConfirm={remove}
      />
    </DetailDrawer>
  );
}

function BudgetFormModal(props: { existing: PersonBudget | null; budgets: PersonBudget[]; onClose: () => void }) {
  const { existing } = props;
  const people = useUserPicker();
  const act = useAction();
  const [userId, setUserId] = useState(existing?.userId ?? "");
  const [amount, setAmount] = useState(existing ? String(existing.budgetUsd) : "");
  const [period, setPeriod] = useState<BudgetPeriod>(existing?.budgetPeriod === "none" ? "none" : "monthly");
  const [threshold, setThreshold] = useState(String(existing?.alertThresholdPct ?? DEFAULT_THRESHOLD_PCT));
  const [checked, setChecked] = useState(false);

  const choices = useMemo(
    () => peopleWithoutBudget((people.data?.users ?? []).filter((u) => !u.disabledAt), props.budgets),
    [people.data, props.budgets],
  );
  const amountError = checked ? amountProblem(amount) : null;
  const thresholdError = checked ? thresholdProblem(threshold) : null;
  const personError = checked && !userId ? "Choose a person." : null;
  const name = existing?.displayName ?? choices.find((u) => u.id === userId)?.displayName ?? "this person";

  const save = () => {
    setChecked(true);
    if (!userId || amountProblem(amount) || thresholdProblem(threshold)) return;
    void act
      .run(() => api.put(`/v1/users/${userId}/spend-budget`, budgetBody(amount, period, threshold)), `Budget for ${name} saved`)
      .then((ok) => {
        if (ok) props.onClose();
      });
  };

  return (
    <ModalShell title={existing ? `Change the budget for ${name}` : "Set a spend budget"} onClose={props.onClose} busy={act.busy} onSave={save}>
      <form
        aria-label={existing ? `Budget for ${name}` : "New spend budget"}
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
        className={v.stack}
      >
        {!existing && (
          <QueryGate loading={people.isLoading} error={people.error} onRetry={() => void people.refetch()}>
            <Field label="Person" error={personError}>
              <Select value={userId} onChange={(e) => setUserId(e.target.value)} onBlur={() => setChecked(true)}>
                <option value="">Choose a person</option>
                {choices.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.displayName || u.email}
                  </option>
                ))}
              </Select>
            </Field>
            {people.data && !people.data.complete && (
              <p className={v.dim}>Only the first part of the directory loaded; a person not listed was not loaded.</p>
            )}
          </QueryGate>
        )}
        <Field label="Budget (US dollars)" error={amountError}>
          <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} onBlur={() => setChecked(true)} />
        </Field>
        <Field label="Window">
          <Select value={period} onChange={(e) => setPeriod(e.target.value === "none" ? "none" : "monthly")}>
            <option value="monthly">{PERIOD_WORDS.monthly}</option>
            <option value="none">{PERIOD_WORDS.none}</option>
          </Select>
        </Field>
        <Field label="Alert at (% of the budget)" error={thresholdError}>
          <Input inputMode="numeric" value={threshold} onChange={(e) => setThreshold(e.target.value)} onBlur={() => setChecked(true)} />
        </Field>
        {act.error && (
          <p className={v.errLine} role="alert">
            {act.error}
          </p>
        )}
        <RefusalNotice guidance={act.guidance} />
        <button type="submit" hidden />
      </form>
    </ModalShell>
  );
}

/** the kit Modal with this form's two actions */
function ModalShell(props: { title: string; onClose: () => void; onSave: () => void; busy: boolean; children: ReactNode }) {
  return (
    <KitModal
      open
      title={props.title}
      onClose={props.onClose}
      actions={
        <>
          <Button onClick={props.onClose}>Cancel</Button>
          <Button variant="primary" aria-disabled={props.busy} onClick={() => !props.busy && props.onSave()}>
            Save budget
          </Button>
        </>
      }
    >
      {props.children}
    </KitModal>
  );
}
