/**
 * ADR-0363 slice 1 — the "Sensitivity labels" page: map the organisation's own labels to what RegulAIt does with a
 * labelled file sent to a model, and set the fallbacks.
 *
 *  - The labels are read from the tenant by the identity-provider discovery scan; this page cannot add or rename one.
 *  - Every choice starts at "block". Loosening a fallback or a mapping is confirmed here first, then the gateway asks
 *    the admin to confirm it is them (settings_relax step-up) and audits it. Tightening needs neither.
 *  - A new mapping opens on the strictest choice, never a permissive one.
 *
 * The rules are in `sensitivityLabelsModel.ts`.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../../../api/client";
import { ago } from "../../../api/format";
import { PageHeader } from "../../../shell/AppShell";
import { api as stepUpApi, withStepUp } from "../../../stepup/stepUp";
import { Badge, Button, Card, ConfirmModal, EmptyState, Field, Modal, RowActions, Select, Table } from "../../../ui/kit";
import { RefusalNotice } from "../../../ui/RefusalNotice";
import { useAction, useComplianceProfiles } from "../adminKit";
import { withRefusalCopy } from "./refusalCopy";
import {
  ACTION_WORDS,
  effectiveAction,
  FALLBACKS,
  fallbackChange,
  fallbackDraft,
  LABEL_ACTIONS,
  LABEL_REFUSALS,
  LABEL_SENSITIVITIES,
  labelTree,
  removalRelaxes,
  ruleBody,
  ruleDraft,
  ruleRelaxes,
  SENSITIVITY_WORDS,
  type FallbackDraft,
  type LabelAction,
  type LabelList,
  type LabelSensitivity,
  type RuleDraft,
  type SensitivityLabel,
} from "./sensitivityLabelsModel";
import a from "../admin.module.css";
import v from "../../views.module.css";

const KEY = ["admin", "sensitivity-labels"] as const;
const PATH = "/v1/sensitivity-labels";

function ActionBadge({ action }: { action: LabelAction }) {
  return <Badge tone={ACTION_WORDS[action].tone}>{ACTION_WORDS[action].label}</Badge>;
}

export default function SensitivityLabelsPage() {
  const list = useQuery({ queryKey: KEY, queryFn: () => api.get<LabelList>(PATH) });
  const profiles = useComplianceProfiles();
  const act = useAction();
  const [fallbacks, setFallbacks] = useState<FallbackDraft | null>(null);
  const [confirmFallbacks, setConfirmFallbacks] = useState(false);
  const [editing, setEditing] = useState<{ label: SensitivityLabel; draft: RuleDraft } | null>(null);
  const [confirmRule, setConfirmRule] = useState(false);
  const [removing, setRemoving] = useState<SensitivityLabel | null>(null);
  const data = list.data;
  const settings = data?.settings;
  const draft = fallbacks ?? (settings ? fallbackDraft(settings) : null);
  const change = settings && draft ? fallbackChange(settings, draft) : { changed: {}, relaxes: false };
  const dirty = Object.keys(change.changed).length > 0;
  const activeProfiles = (profiles.data?.profiles ?? []).filter((p) => p.status === "active");
  const profileTag = (id: string | null) => (id ? (profiles.data?.profiles.find((p) => p.id === id)?.tag ?? "a compliance profile") : null);
  const run = (fn: () => Promise<unknown>, ok: string) => act.run(() => withRefusalCopy(fn, LABEL_REFUSALS), ok).then((done) => (done && void list.refetch(), done));

  const saveFallbacks = () => {
    if (!dirty || act.busy) return;
    void run(() => withStepUp((h) => stepUpApi.put(`${PATH}/settings`, change.changed, h)), "Fallbacks saved.").then((done) => done && setFallbacks(null));
  };
  const saveRule = () => {
    const e = editing;
    if (!e || act.busy) return;
    void run(() => withStepUp((h) => stepUpApi.put(`${PATH}/${e.label.id}/rule`, ruleBody(e.draft), h)), `${e.label.name} is mapped to ${ACTION_WORDS[e.draft.action].label.toLowerCase()}.`).then(
      (done) => done && setEditing(null),
    );
  };
  const removeRule = (l: SensitivityLabel) =>
    void run(() => withStepUp((h) => stepUpApi.del(`${PATH}/${l.id}/rule`, undefined, h)), `${l.name} has no mapping now. It follows the fallback for unmapped labels.`);

  const rows = data ? labelTree(data.labels) : undefined;
  return (
    <>
      <PageHeader
        title="Sensitivity labels"
        sub="Decide what happens when a file carrying one of your sensitivity labels is sent to a model."
        info={
          <p>
            The labels come from your tenant, read by the identity-provider discovery scan. A labelled file can be allowed,
            redacted (replaced by a short note) or blocked. A compliance profile on a label can only raise the PII handling
            and guardrails for that call. Anything you have not mapped is blocked until you decide.
          </p>
        }
      />
      <div className={v.stack}>
        {act.error && (
          <div className={v.errLine} role="alert">
            {act.error}
          </div>
        )}
        <RefusalNotice guidance={act.guidance} />

        <Card title="Fallbacks">
          {!settings || !draft ? (
            list.isError ? null : (
              <div className={v.faint} role="status">
                Loading…
              </div>
            )
          ) : (
            <form
              className={v.stack}
              noValidate
              onSubmit={(e) => {
                e.preventDefault();
                if (change.relaxes) setConfirmFallbacks(true);
                else saveFallbacks();
              }}
            >
              <div className={a.formRow}>
                {FALLBACKS.map((f) => (
                  <Field key={f.key} label={f.label} help={f.help}>
                    <Select value={draft[f.key]} onChange={(e) => setFallbacks({ ...draft, [f.key]: e.target.value as LabelAction })}>
                      {[...LABEL_ACTIONS].reverse().map((x) => (
                        <option key={x} value={x}>
                          {ACTION_WORDS[x].label}
                        </option>
                      ))}
                    </Select>
                  </Field>
                ))}
              </div>
              <div className={v.row}>
                <Button type="submit" variant="primary" disabled={!dirty || act.busy}>
                  Save fallbacks
                </Button>
                {dirty && (
                  <Button type="button" variant="ghost" disabled={act.busy} onClick={() => setFallbacks(null)}>
                    Discard changes
                  </Button>
                )}
                <span className={v.faint}>
                  {settings.strictDefault ? "All three block, which is the strict default." : "At least one fallback is looser than the strict default (block)."}
                </span>
              </div>
            </form>
          )}
        </Card>

        <Card title="Labels" count={data?.labels.length}>
          <Table<(typeof rows & object)[number]>
            rows={rows}
            loading={list.isLoading}
            error={list.error}
            onRetry={() => void list.refetch()}
            rowKey={(r) => r.label.id}
            empty={
              <EmptyState
                title="No labels synced yet"
                body="Labels arrive when the identity-provider scan reads your tenant. Until then every labelled file is blocked."
                action={<Link to="/admin/shadow-ai/discovery-sources">Set up the identity-provider scan</Link>}
              />
            }
            columns={[
              {
                key: "name",
                header: "Label",
                render: (r) => (
                  <div className={r.depth ? a.childRow : undefined}>
                    <div>
                      {r.label.name} {!r.label.active && <Badge tone="neutral">Retired in the tenant</Badge>}
                    </div>
                    <div className={v.faint}>{r.parentName ? `under ${r.parentName} · ` : ""}synced {ago(r.label.syncedAt)}</div>
                  </div>
                ),
              },
              {
                key: "mapping",
                header: "When a file carries it",
                render: (r) =>
                  r.label.rule ? (
                    <>
                      <ActionBadge action={r.label.rule.action} />
                      <div className={v.faint}>
                        {SENSITIVITY_WORDS[r.label.rule.sensitivity]}
                        {r.label.rule.complianceProfileId ? ` · profile ${profileTag(r.label.rule.complianceProfileId)}` : ""}
                      </div>
                    </>
                  ) : (
                    <>
                      {settings && <ActionBadge action={effectiveAction(r.label, settings)} />}
                      <div className={v.faint}>Not mapped: follows the fallback</div>
                    </>
                  ),
              },
              {
                key: "actions",
                header: "",
                srHeader: "Actions",
                render: (r) => (
                  <RowActions
                    primary={
                      <Button size="sm" aria-label={`${r.label.rule ? "Edit" : "Map"} ${r.label.name}`} disabled={act.busy} onClick={() => setEditing({ label: r.label, draft: ruleDraft(r.label) })}>
                        {r.label.rule ? "Edit" : "Map"}
                      </Button>
                    }
                    rest={
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Remove the mapping of ${r.label.name}`}
                        disabled={!r.label.rule || act.busy}
                        title={r.label.rule ? undefined : "This label has no mapping to remove."}
                        onClick={() => setRemoving(r.label)}
                      >
                        Remove mapping
                      </Button>
                    }
                  />
                ),
              },
            ]}
          />
        </Card>
      </div>

      <Modal
        open={editing !== null}
        title={editing ? `Map ${editing.label.name}` : "Map this label"}
        onClose={() => setEditing(null)}
        actions={
          <>
            <Button variant="ghost" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={act.busy}
              onClick={() => {
                if (editing && settings && ruleRelaxes(editing.label, settings, editing.draft)) setConfirmRule(true);
                else saveRule();
              }}
            >
              Save mapping
            </Button>
          </>
        }
      >
        {editing && (
          <div className={v.stack}>
            <Field label="What happens" help={ACTION_WORDS[editing.draft.action].help}>
              <Select value={editing.draft.action} onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, action: e.target.value as LabelAction } })}>
                {[...LABEL_ACTIONS].reverse().map((x) => (
                  <option key={x} value={x}>
                    {ACTION_WORDS[x].label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Data sensitivity" help="Recorded with each call that carries this label.">
              <Select value={editing.draft.sensitivity} onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, sensitivity: e.target.value as LabelSensitivity } })}>
                {[...LABEL_SENSITIVITIES].reverse().map((x) => (
                  <option key={x} value={x}>
                    {SENSITIVITY_WORDS[x]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Compliance profile" help="Optional. It can only raise the PII handling and guardrails for a call that carries this label.">
              <Select value={editing.draft.complianceProfileId} onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, complianceProfileId: e.target.value } })}>
                <option value="">None</option>
                {activeProfiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.tag}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        )}
      </Modal>

      <ConfirmModal
        open={confirmFallbacks}
        title="Loosen the fallbacks?"
        body={<p>Some files that are blocked today will reach the model. The change is recorded in the audit trail, and you will be asked to confirm it is you.</p>}
        confirmLabel="Loosen and save"
        onConfirm={() => {
          setConfirmFallbacks(false);
          saveFallbacks();
        }}
        onCancel={() => setConfirmFallbacks(false)}
      />
      <ConfirmModal
        open={confirmRule}
        title={editing ? `Loosen the mapping of ${editing.label.name}?` : "Loosen this mapping?"}
        body={<p>Files with this label will be handled less strictly than today. The change is recorded in the audit trail, and you will be asked to confirm it is you.</p>}
        confirmLabel="Loosen and save"
        onConfirm={() => {
          setConfirmRule(false);
          saveRule();
        }}
        onCancel={() => setConfirmRule(false)}
      />
      <ConfirmModal
        open={removing !== null}
        danger
        title={removing ? `Remove the mapping of ${removing.name}?` : "Remove this mapping?"}
        body={
          <p>
            The label will follow the fallback for unmapped labels
            {settings ? ` (${ACTION_WORDS[settings.unmappedAction].label.toLowerCase()})` : ""}
            {removing?.rule?.complianceProfileId ? " and lose its compliance profile" : ""}.
            {removing && settings && removalRelaxes(removing, settings) ? " That is looser than today, so you will be asked to confirm it is you." : ""}
          </p>
        }
        confirmLabel="Remove mapping"
        onConfirm={() => {
          const l = removing;
          setRemoving(null);
          if (l) removeRule(l);
        }}
        onCancel={() => setRemoving(null)}
      />
    </>
  );
}
