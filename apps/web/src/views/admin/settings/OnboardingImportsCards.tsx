/**
 * ADR-0054 — two cards for First-run setup:
 *
 *  - Import group → role mappings (`POST /v1/onboarding/imports/group-roles`).
 *    Preview first (a dry run changes nothing and returns the plan); Apply
 *    writes only the rows the plan says "will be created". An import never
 *    creates a role: a row naming one that does not exist refuses the WHOLE
 *    import, and the refusal names the roles. A mapping onto a role an
 *    approval rule uses widens an approver pool, so Apply may ask you to
 *    confirm it's you (settings_relax).
 *  - Import history (`GET /v1/onboarding/imports`): every preview, apply and
 *    refusal, newest first, filterable by kind and status. Refusals are in the
 *    list on purpose.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import { ago } from "../../../api/format";
import { api as stepUpApi, withStepUp } from "../../../stepup/stepUp";
import { Badge, Button, Card, EmptyState, Field, Input, Select, Table, type Tone } from "../../../ui/kit";
import { OutcomePanel, useApiAction, useRoles } from "../adminKit";
import v from "../../views.module.css";
import {
  ACTION_TEXT,
  GROUP_SOURCES,
  importRows,
  readPlan,
  refusalLines,
  type GroupRoleDraftRow,
  type GroupRolePlan,
  type GroupSource,
  type OnboardingImport,
} from "./onboardingImports";

const blankRow = (): GroupRoleDraftRow => ({ source: "oidc", externalGroup: "", roleName: "" });
const ACTION_TONE: Record<string, Tone> = { create: "ok", unchanged: "neutral", unknown_role: "danger" };

export function GroupRoleImportCard(props: { onImported?: () => void }) {
  const roles = useRoles();
  const act = useApiAction();
  const [rows, setRows] = useState<GroupRoleDraftRow[]>([blankRow()]);
  const [plan, setPlan] = useState<{ mode: string; plan: GroupRolePlan; created?: number } | null>(null);
  const parsed = importRows(rows);
  const listId = "group-role-import-roles";
  const update = (i: number, patch: Partial<GroupRoleDraftRow>) => {
    setPlan(null);
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  };
  const send = async (mode: "dry_run" | "apply") => {
    if (!parsed.ok) return;
    const body = { mode, rows: parsed.rows };
    const out = await act.run(
      () =>
        mode === "apply"
          ? withStepUp((h) => stepUpApi.post<Record<string, unknown>>("/v1/onboarding/imports/group-roles", body, h))
          : api.post<Record<string, unknown>>("/v1/onboarding/imports/group-roles", body),
      mode === "apply" ? "Group mappings imported" : "Preview ready: nothing was changed",
    );
    const read = out ? readPlan(out.plan) : null;
    setPlan(read ? { mode, plan: read, ...(typeof out?.created === "number" ? { created: out.created } : {}) } : null);
    if (out && mode === "apply") props.onImported?.();
  };
  const refusedPlan = act.outcome && !act.outcome.ok ? readPlan(act.outcome.payload?.plan) : null;
  const shown = plan?.plan ?? refusedPlan;
  return (
    <Card title="Import group → role mappings">
      <div className={v.stack} data-testid="group-role-import">
        <p className={v.faint}>
          Map the groups your identity provider sends to roles that already exist. Preview first: it changes nothing.
          An import never creates a role or makes anyone an administrator.
        </p>
        <datalist id={listId}>
          {(roles.data?.roles ?? []).map((r) => (
            <option key={r.id} value={r.name} />
          ))}
        </datalist>
        {rows.map((r, i) => (
          <div className={v.row} key={i} style={{ alignItems: "flex-end" }}>
            <Field label={`Row ${i + 1} source`}>
              <Select value={r.source} onChange={(e) => update(i, { source: e.target.value as GroupSource })}>
                {GROUP_SOURCES.map((s) => (
                  <option key={s} value={s}>
                    {s.toUpperCase()}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={`Row ${i + 1} group`}>
              <Input value={r.externalGroup} maxLength={512} onChange={(e) => update(i, { externalGroup: e.target.value })} />
            </Field>
            <Field label={`Row ${i + 1} role`}>
              <Input list={listId} value={r.roleName} maxLength={200} onChange={(e) => update(i, { roleName: e.target.value })} />
            </Field>
            <Button
              type="button"
              size="sm"
              disabled={rows.length === 1}
              aria-label={`Remove row ${i + 1}`}
              onClick={() => {
                setPlan(null);
                setRows((rs) => rs.filter((_, j) => j !== i));
              }}
            >
              Remove
            </Button>
          </div>
        ))}
        <div className={v.row}>
          <Button type="button" size="sm" disabled={rows.length >= 5000} onClick={() => setRows((rs) => [...rs, blankRow()])}>
            Add row
          </Button>
          <Button type="button" size="sm" disabled={!parsed.ok || act.busy} onClick={() => void send("dry_run")}>
            Preview (changes nothing)
          </Button>
          <Button
            type="button"
            size="sm"
            variant="primary"
            disabled={!parsed.ok || act.busy || !(plan?.mode === "dry_run" && plan.plan.counts.create > 0)}
            onClick={() => void send("apply")}
          >
            Apply previewed mappings
          </Button>
        </div>
        {!parsed.ok ? <p className={v.faint}>{parsed.problem}</p> : null}
        {plan?.mode === "dry_run" && plan.plan.counts.create === 0 ? (
          <p role="status">Nothing to apply: every row is already mapped.</p>
        ) : null}
        <OutcomePanel outcome={act.outcome} testId="group-role-import-outcome">
          {act.outcome && !act.outcome.ok
            ? refusalLines(act.outcome.code, act.outcome.payload).map((line) => (
                <p key={line} className={v.dim}>
                  {line}
                </p>
              ))
            : null}
          {plan?.mode === "apply" && typeof plan.created === "number" ? <p>{plan.created} mapping(s) created.</p> : null}
        </OutcomePanel>
        {shown ? (
          <>
            <p className={v.faint}>
              {shown.counts.create} to create · {shown.counts.unchanged} already mapped · {shown.counts.unknown_role} naming no role
            </p>
            <Table<(typeof shown.entries)[number]>
              rows={shown.entries}
              rowKey={(e) => `${e.source}\u0000${e.externalGroup}\u0000${e.roleName}`}
              columns={[
                { key: "src", header: "Source", render: (e) => e.source.toUpperCase() },
                { key: "group", header: "Group", render: (e) => e.externalGroup },
                { key: "role", header: "Role", render: (e) => e.roleName },
                { key: "action", header: "Result", render: (e) => <Badge tone={ACTION_TONE[e.action] ?? "warn"}>{ACTION_TEXT[e.action] ?? e.action}</Badge> },
              ]}
            />
          </>
        ) : null}
      </div>
    </Card>
  );
}

const KIND_TEXT: Record<string, string> = { users: "Users", group_roles: "Group → role mappings" };
const STATUS_TONE: Record<string, Tone> = { planned: "info", applied: "ok", refused: "danger" };

export function ImportHistoryCard() {
  const [kind, setKind] = useState("");
  const [status, setStatus] = useState("");
  const qs = new URLSearchParams({ limit: "50", ...(kind ? { kind } : {}), ...(status ? { status } : {}) }).toString();
  const q = useQuery({
    queryKey: ["admin", "onboarding-imports", kind, status],
    queryFn: () => api.get<{ imports: OnboardingImport[] }>(`/v1/onboarding/imports?${qs}`),
  });
  return (
    <Card title="Import history">
      <div className={v.stack} data-testid="onboarding-import-history">
        <p className={v.faint}>Every preview, apply and refusal, newest first. A refused import is recorded too, with why.</p>
        <div className={v.row}>
          <Field label="Kind">
            <Select value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="">All</option>
              <option value="users">Users</option>
              <option value="group_roles">Group → role mappings</option>
            </Select>
          </Field>
          <Field label="Status">
            <Select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">All</option>
              <option value="planned">Previewed</option>
              <option value="applied">Applied</option>
              <option value="refused">Refused</option>
            </Select>
          </Field>
        </div>
        <Table<OnboardingImport>
          rows={q.data?.imports ?? []}
          rowKey={(r) => r.id}
          loading={q.isLoading}
          error={q.error}
          onRetry={() => void q.refetch()}
          columns={[
            { key: "at", header: "When", sort: (r) => r.createdAt, render: (r) => ago(r.createdAt) },
            { key: "kind", header: "Kind", render: (r) => KIND_TEXT[r.kind] ?? r.kind },
            { key: "mode", header: "Mode", render: (r) => (r.mode === "dry_run" ? "Preview" : r.mode === "apply" ? "Apply" : r.mode) },
            { key: "status", header: "Status", render: (r) => <Badge tone={STATUS_TONE[r.status] ?? "warn"}>{r.status}</Badge> },
            { key: "rows", header: "Rows", align: "right", render: (r) => r.rowCount },
            { key: "why", header: "What happened", render: (r) => <span className={v.dim}>{r.reason}</span> },
          ]}
          empty={<EmptyState title="No imports yet" body="Previews, applies and refusals appear here." />}
        />
      </div>
    </Card>
  );
}
