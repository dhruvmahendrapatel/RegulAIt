/**
 * ADR-0173 §3 — Model policy: which governed model bindings each product
 * feature may use, the default per feature, and narrower rules for data of a
 * given class.
 *
 * The matrix is a real <table>: features are the columns (each with a
 * "Restrict" switch and a "No default" choice), model bindings are the rows
 * grouped under their provider (logo, and an "every <provider> model" row).
 * A cell is a checkbox ("allowed") plus a radio ("default"), each with its own
 * accessible name, so the whole grid is operable and announced by keyboard.
 *
 * An unrestricted feature allows every binding a person is entitled to — the
 * policy only ever subtracts, and the gateway enforces it in its shared
 * model-access decision, refusing `model_not_allowed_for_feature`.
 */
import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../../../api/client";
import type { AdminAgent } from "../../../api/adminTypes";
import { providerLabel } from "../../models/modelBindings";
import { PageHeader } from "../../../shell/AppShell";
import { Badge, Button, Card, EmptyState, Field, Select } from "../../../ui/kit";
import { ProviderMark } from "../../../ui/ModelPicker";
import { OutcomePanel, QueryGate, useAgents, useApiAction } from "../adminKit";
import {
  MODEL_POLICY_DATA_CLASSES,
  MODEL_POLICY_FEATURES,
  MODEL_POLICY_FEATURE_HINTS,
  MODEL_POLICY_FEATURE_LABELS,
  MODEL_POLICY_KEY,
  useModelPolicy,
  type ModelPolicyDataClass,
  type ModelPolicyFeature,
  type ModelPolicyView,
} from "../../models/modelPolicy";
import {
  cellAllowed,
  draftFrom,
  draftKey,
  featuresAllowingNothing,
  removeClassRule,
  setBindingAllowed,
  setDefault,
  setProviderAllowed,
  setRestricted,
  toRules,
  upsertClassRule,
  type ClassRuleDraft,
  type PolicyDraft,
} from "./modelPolicyDraft";
import v from "../../views.module.css";
import m from "./modelPolicy.module.css";

const L = MODEL_POLICY_FEATURE_LABELS;

export default function ModelPolicyPage() {
  const policyQ = useModelPolicy();
  const agentsQ = useAgents();
  return (
    <>
      <PageHeader
        title="Model policy"
        sub="Which models each feature may use, its default, and stricter rules for sensitive data."
        info={
          <>
            <p>
              Each column is a feature of the product. While a feature is unrestricted, everyone may use every model
              they have been granted there. Restrict it to choose exactly which models are allowed; the gateway then
              refuses any other model for that feature, by name, and records the refusal in the audit log.
            </p>
            <p>
              A data-class rule applies only where the feature knows the class of the data it sends (today: the intake
              assistant), and can only narrow the feature&apos;s own list. A default is a preference: it is used only
              for people who may use that model.
            </p>
          </>
        }
      />
      <QueryGate
        loading={policyQ.isLoading || agentsQ.isLoading}
        error={policyQ.error ?? agentsQ.error}
        onRetry={() => {
          void policyQ.refetch();
          void agentsQ.refetch();
        }}
      >
        {policyQ.data && agentsQ.data ? (
          <PolicyEditor
            key={policyQ.data.updatedAt ?? "empty"}
            policy={policyQ.data}
            bindings={agentsQ.data.agents.filter((a) => a.model)}
          />
        ) : null}
      </QueryGate>
    </>
  );
}

interface ProviderGroup {
  provider: string;
  label: string;
  bindings: AdminAgent[];
}

function PolicyEditor(props: { policy: ModelPolicyView; bindings: AdminAgent[] }) {
  const qc = useQueryClient();
  const act = useApiAction();
  const [draft, setDraft] = useState<PolicyDraft>(() => draftFrom(props.policy));
  const saved = useMemo(() => draftKey(draftFrom(props.policy)), [props.policy]);
  const dirty = draftKey(draft) !== saved;
  const empty = featuresAllowingNothing(draft);

  const groups = useMemo<ProviderGroup[]>(() => {
    const by = new Map<string, ProviderGroup>();
    for (const b of [...props.bindings].sort((x, y) => x.name.localeCompare(y.name))) {
      const g = by.get(b.provider) ?? { provider: b.provider, label: providerLabel(b.provider), bindings: [] };
      g.bindings.push(b);
      by.set(b.provider, g);
    }
    return [...by.values()].sort((x, y) => x.label.localeCompare(y.label));
  }, [props.bindings]);

  const save = async () => {
    const out = await act.run(() => api.put<{ changed: boolean }>("/v1/model-policy", { rules: toRules(draft) }), "Model policy saved");
    if (out) await qc.invalidateQueries({ queryKey: MODEL_POLICY_KEY });
  };

  if (props.bindings.length === 0) {
    return (
      <Card>
        <EmptyState title="No model bindings yet" body="Register a model in Integrations → Agents first; the matrix lists every binding with a model id." />
      </Card>
    );
  }

  return (
    <div className={v.stack}>
      <Card>
        <div className={m.scroll} tabIndex={0} role="region" aria-label="Model allow-list matrix">
          <table className={m.matrix} data-testid="model-policy-matrix">
            <caption className={m.caption}>Allowed models per feature</caption>
            <thead>
              <tr>
                <th scope="col" className={m.corner}>
                  Model
                </th>
                {MODEL_POLICY_FEATURES.map((f) => (
                  <th key={f} scope="col" className={m.featureHead}>
                    <span className={m.featureName} title={MODEL_POLICY_FEATURE_HINTS[f]}>
                      {L[f]}
                    </span>
                    <label className={m.restrict}>
                      <input
                        type="checkbox"
                        checked={draft.base[f].restricted}
                        onChange={(e) => setDraft(setRestricted(draft, f, e.target.checked))}
                      />
                      <span>Restrict</span>
                    </label>
                    <label className={m.cellRadio}>
                      <input
                        type="radio"
                        name={`default-${f}`}
                        checked={draft.base[f].defaultAgentId === null}
                        onChange={() => setDraft(setDefault(draft, f, null))}
                        aria-label={`No default for ${L[f]}`}
                      />
                      <span aria-hidden>No default</span>
                    </label>
                  </th>
                ))}
              </tr>
            </thead>
            {groups.map((g) => (
              <tbody key={g.provider}>
                <tr className={m.providerRow}>
                  <th scope="row">
                    <ProviderMark provider={g.provider} label={g.label}>
                      Every {g.label} model
                    </ProviderMark>
                  </th>
                  {MODEL_POLICY_FEATURES.map((f) => {
                    const b = draft.base[f];
                    return (
                      <td key={f}>
                        {b.restricted ? (
                          <input
                            type="checkbox"
                            checked={b.allowedProviders.includes(g.provider)}
                            onChange={(e) => setDraft(setProviderAllowed(draft, f, g.provider, e.target.checked, props.bindings))}
                            aria-label={`Allow every ${g.label} model for ${L[f]}`}
                          />
                        ) : (
                          <span className={m.any}>any</span>
                        )}
                      </td>
                    );
                  })}
                </tr>
                {g.bindings.map((a) => (
                  <tr key={a.id}>
                    <th scope="row" className={m.bindingHead}>
                      <span className={m.bindingName}>{a.name}</span>
                      <span className={m.bindingModel}>{a.model}</span>
                    </th>
                    {MODEL_POLICY_FEATURES.map((f) => {
                      const b = draft.base[f];
                      const viaProvider = b.restricted && b.allowedProviders.includes(a.provider);
                      const allowed = cellAllowed(draft, f, a);
                      return (
                        <td key={f} className={allowed ? m.cellOn : m.cellOff}>
                          <span className={m.cell}>
                            {b.restricted ? (
                              <input
                                type="checkbox"
                                checked={allowed}
                                disabled={viaProvider}
                                onChange={(e) => setDraft(setBindingAllowed(draft, f, a.id, e.target.checked))}
                                aria-label={`Allow ${a.name} for ${L[f]}${viaProvider ? " (allowed with every " + providerLabel(a.provider) + " model)" : ""}`}
                              />
                            ) : (
                              <span className={m.any} aria-hidden>
                                any
                              </span>
                            )}
                            <input
                              type="radio"
                              name={`default-${f}`}
                              checked={b.defaultAgentId === a.id}
                              disabled={!allowed}
                              onChange={() => setDraft(setDefault(draft, f, a.id))}
                              aria-label={`Default for ${L[f]}: ${a.name}`}
                              className={m.defaultRadio}
                            />
                          </span>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            ))}
          </table>
        </div>
        <p className={v.hint}>
          A checked box allows the model; the round button makes it the feature&apos;s default. &ldquo;any&rdquo; means
          the feature is unrestricted.
        </p>
      </Card>

      <ClassRules draft={draft} setDraft={setDraft} bindings={props.bindings} groups={groups} />

      <Card>
        <div className={v.row}>
          <Button variant="primary" onClick={() => void save()} disabled={!dirty || act.busy}>
            {act.busy ? "Saving…" : "Save policy"}
          </Button>
          <Button onClick={() => setDraft(draftFrom(props.policy))} disabled={!dirty || act.busy}>
            Discard changes
          </Button>
          {dirty ? <span className={v.faint}>Unsaved changes</span> : <span className={v.faint}>Saved</span>}
        </div>
        {empty.length > 0 && (
          <p className={m.warn} role="status">
            {empty.map((f) => L[f]).join(", ")} {empty.length === 1 ? "is" : "are"} restricted with no model allowed — every
            call there will be refused.
          </p>
        )}
        <OutcomePanel outcome={act.outcome} testId="model-policy-outcome" />
      </Card>
    </div>
  );
}

function ClassRules(props: {
  draft: PolicyDraft;
  setDraft: (d: PolicyDraft) => void;
  bindings: AdminAgent[];
  groups: ProviderGroup[];
}) {
  const { draft, setDraft } = props;
  const [feature, setFeature] = useState<ModelPolicyFeature>("intake_assist");
  const [dataClass, setDataClass] = useState<ModelPolicyDataClass>("regulated");
  const existing = draft.classes.find((c) => c.feature === feature && c.dataClass === dataClass) ?? null;
  const editing: ClassRuleDraft = existing ?? { feature, dataClass, allowedAgentIds: [], allowedProviders: [], defaultAgentId: null };
  const nameOf = (id: string) => props.bindings.find((b) => b.id === id)?.name ?? "a removed model";
  const update = (next: ClassRuleDraft) => setDraft(upsertClassRule(draft, next));
  const toggle = (list: string[], val: string, on: boolean) => (on ? [...new Set([...list, val])] : list.filter((x) => x !== val));

  return (
    <Card>
      <h2 className={v.sectionTitle}>Rules for sensitive data</h2>
      <p className={v.hint}>
        Narrow a feature further for data of one class. Applied where the feature knows the class of what it sends; it can
        never allow a model the feature itself forbids.
      </p>
      {draft.classes.length > 0 ? (
        <ul className={m.classList} aria-label="Data-class rules">
          {draft.classes.map((c) => (
            <li key={`${c.feature}-${c.dataClass}`} className={m.classItem}>
              <Badge tone="info">{L[c.feature]}</Badge>
              <Badge tone="warn">{c.dataClass} data</Badge>
              <span className={m.classSummary}>
                {[...c.allowedProviders.map((p) => `every ${providerLabel(p)} model`), ...c.allowedAgentIds.map(nameOf)].join(", ") ||
                  "no model allowed"}
                {c.defaultAgentId ? ` · default ${nameOf(c.defaultAgentId)}` : ""}
              </span>
              <Button size="sm" onClick={() => setDraft(removeClassRule(draft, c.feature, c.dataClass))} aria-label={`Remove the ${L[c.feature]} rule for ${c.dataClass} data`}>
                Remove
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className={v.faint}>No data-class rules.</p>
      )}

      <div className={v.row}>
        <Field label="Feature">
          <Select value={feature} onChange={(e) => setFeature(e.target.value as ModelPolicyFeature)}>
            {MODEL_POLICY_FEATURES.map((f) => (
              <option key={f} value={f}>
                {L[f]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Data class">
          <Select value={dataClass} onChange={(e) => setDataClass(e.target.value as ModelPolicyDataClass)}>
            {MODEL_POLICY_DATA_CLASSES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <fieldset className={m.classFieldset}>
        <legend className={m.classLegend}>
          Models allowed for {L[feature]} with {dataClass} data{existing ? "" : " (no rule yet — checking a model adds one)"}
        </legend>
        {props.groups.map((g) => (
          <div key={g.provider} className={m.classGroup}>
            <label className={m.classCheck}>
              <input
                type="checkbox"
                checked={editing.allowedProviders.includes(g.provider)}
                onChange={(e) => update({ ...editing, allowedProviders: toggle(editing.allowedProviders, g.provider, e.target.checked) })}
              />
              <ProviderMark provider={g.provider} label={g.label}>
                Every {g.label} model
              </ProviderMark>
            </label>
            {g.bindings.map((a) => (
              <label key={a.id} className={m.classCheck}>
                <input
                  type="checkbox"
                  checked={editing.allowedAgentIds.includes(a.id) || editing.allowedProviders.includes(a.provider)}
                  disabled={editing.allowedProviders.includes(a.provider)}
                  onChange={(e) => {
                    const ids = toggle(editing.allowedAgentIds, a.id, e.target.checked);
                    update({ ...editing, allowedAgentIds: ids, defaultAgentId: !e.target.checked && editing.defaultAgentId === a.id ? null : editing.defaultAgentId });
                  }}
                />
                {a.name}
              </label>
            ))}
          </div>
        ))}
      </fieldset>
      <Field label="Default for this data class">
        <Select
          value={editing.defaultAgentId ?? ""}
          onChange={(e) => update({ ...editing, defaultAgentId: e.target.value || null })}
        >
          <option value="">The feature&apos;s default</option>
          {props.bindings
            .filter((a) => editing.allowedAgentIds.includes(a.id) || editing.allowedProviders.includes(a.provider))
            .map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
        </Select>
      </Field>
    </Card>
  );
}
