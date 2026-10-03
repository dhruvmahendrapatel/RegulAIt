/**
 * Review policy (ADR-0168 amendment, afternoon): configuration, not code.
 * An admin names the reviewer roles and their members, which roles each EU AI
 * Act tier requires (each role is one required review) with the approval's
 * lifetime for that tier, and who may accept residual risk. A tier with no
 * roles keeps the single named approver.
 */
import { useEffect, useId, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../../api/client";
import type { DirectoryUser, ReviewPolicy } from "../../../api/types";
import { PageHeader } from "../../../shell/AppShell";
import { Button, Card, Field, Input, Select } from "../../../ui/kit";
import { useToast } from "../../../ui/toast";
import { QueryGate } from "../adminKit";
import v from "../../views.module.css";
import { shortDate } from "./useCaseLifecycle";
import {
  DEFAULT_VALIDITY,
  REVIEW_POLICY_KEY,
  TIERS,
  blankRole,
  draftFrom,
  policyBody,
  policyHasErrors,
  removeRole,
  validatePolicy,
  type PolicyDraft,
  type PolicyErrors,
  type RoleDraft,
} from "./reviewPolicy";
import p from "./reviewPolicy.module.css";

export default function ReviewPolicyPage() {
  const policy = useQuery({ queryKey: REVIEW_POLICY_KEY, queryFn: () => api.get<ReviewPolicy>("/v1/governance/review-policy") });
  const directory = useQuery({ queryKey: ["directory"], queryFn: () => api.get<{ users: DirectoryUser[] }>("/v1/users/directory") });
  return (
    <>
      <PageHeader
        title="Review policy"
        sub="Who reviews AI use cases, how many reviews each tier needs, and who may accept risk."
        info={<p>Each role a tier lists is one required review, and any member of that role can complete it. Nobody reviews a use case they proposed. A tier with no roles keeps a single named approver.</p>}
      />
      <QueryGate loading={policy.isLoading || directory.isLoading} error={policy.error ?? directory.error} onRetry={() => { void policy.refetch(); void directory.refetch(); }}>
        {policy.data ? <PolicyForm key={policy.data.updatedAt ?? "new"} policy={policy.data} people={directory.data?.users ?? []} /> : null}
      </QueryGate>
    </>
  );
}

function PolicyForm(props: { policy: ReviewPolicy; people: DirectoryUser[] }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<PolicyDraft>(() => draftFrom(props.policy));
  const [errors, setErrors] = useState<PolicyErrors | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const focusRole = useRef<string | null>(null);
  const nameOf = (id: string) => props.people.find((u) => u.id === id)?.name ?? "Unknown person";

  // a role just added gets focus on its name field
  useEffect(() => {
    if (!focusRole.current) return;
    form.current?.querySelector<HTMLInputElement>(`[data-role-name="${focusRole.current}"]`)?.focus();
    focusRole.current = null;
  }, [draft.roles.length]);

  const patchRole = (key: string, patch: Partial<RoleDraft>) =>
    setDraft((d) => ({ ...d, roles: d.roles.map((r) => (r.key === key ? { ...r, ...patch } : r)) }));
  const toggleTierRole = (tier: keyof PolicyDraft["tiers"], key: string, on: boolean) =>
    setDraft((d) => {
      const t = d.tiers[tier];
      return { ...d, tiers: { ...d.tiers, [tier]: { ...t, roleKeys: on ? [...t.roleKeys, key] : t.roleKeys.filter((k) => k !== key) } } };
    });

  const save = async () => {
    const found = validatePolicy(draft);
    if (policyHasErrors(found)) {
      setErrors(found);
      window.setTimeout(() => form.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(), 0);
      return;
    }
    setErrors(null);
    setSubmitError(null);
    setBusy(true);
    try {
      await api.put("/v1/governance/review-policy", policyBody(draft));
      toast("Review policy saved", "success");
      await queryClient.invalidateQueries({ queryKey: REVIEW_POLICY_KEY });
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const roleLabel = (r: RoleDraft, i: number) => r.name.trim() || `Role ${i + 1}`;

  return (
    <form ref={form} className={v.stack} noValidate onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <Card title="Reviewer roles">
        <p className={p.lead}>A role is a group of reviewers; any one member can complete that role&apos;s review.</p>
        {draft.roles.length === 0 ? <p className={p.none}>No reviewer roles yet. Every use case goes to a single named approver.</p> : (
          <ul className={p.roles}>
            {draft.roles.map((role, i) => {
              const err = errors?.roles[role.key];
              return (
                <li key={role.key} className={p.role} aria-label={roleLabel(role, i)}>
                  <Field label="Role name" error={err?.name ?? null}>
                    <Input
                      data-role-name={role.key}
                      value={role.name}
                      maxLength={80}
                      aria-invalid={err?.name ? true : undefined}
                      onChange={(e) => patchRole(role.key, { name: e.target.value })}
                      placeholder="Privacy"
                    />
                  </Field>
                  <PeoplePicker
                    label="Members"
                    group={roleLabel(role, i)}
                    people={props.people}
                    value={role.memberUserIds}
                    onChange={(memberUserIds) => patchRole(role.key, { memberUserIds })}
                    error={err?.members ?? null}
                    nameOf={nameOf}
                  />
                  <Button size="sm" variant="ghost" className={p.roleRemove} aria-label={`Remove role ${roleLabel(role, i)}`} onClick={() => setDraft((d) => removeRole(d, role.key))}>
                    Remove
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
        <div style={{ marginTop: "var(--s2)" }}>
          <Button size="sm" onClick={() => { const role = blankRole(); focusRole.current = role.key; setDraft((d) => ({ ...d, roles: [...d.roles, role] })); }}>
            + Add role
          </Button>
        </div>
      </Card>

      <Card title="Reviews required by tier">
        <p className={p.lead}>Each role listed is one required review. A tier with no roles keeps a single named approver.</p>
        <ul className={p.tiers}>
          {TIERS.map((tier) => {
            const t = draft.tiers[tier.id];
            const count = draft.roles.filter((r) => t.roleKeys.includes(r.key)).length;
            return (
              <li key={tier.id} className={p.tier}>
                <span className={p.tierName}>
                  {tier.label} tier
                  <span className={p.tierHint}>{tier.hint}</span>
                </span>
                <fieldset className={p.tierRoles}>
                  <legend>Required reviews for the {tier.label.toLowerCase()} tier</legend>
                  {draft.roles.length === 0 ? <span className={p.none}>Add a reviewer role first.</span> : (
                    <div className={p.checks}>
                      {draft.roles.map((role, i) => (
                        <label key={role.key} className={p.check}>
                          <input type="checkbox" checked={t.roleKeys.includes(role.key)} onChange={(e) => toggleTierRole(tier.id, role.key, e.target.checked)} />
                          {roleLabel(role, i)}
                        </label>
                      ))}
                    </div>
                  )}
                  <span className={p.tierCount}>{count === 0 ? "One named approver" : `${count} required review${count === 1 ? "" : "s"}`}</span>
                </fieldset>
                <Field label="Approval valid for (months)" error={errors?.tiers[tier.id] ?? null}>
                  <Input
                    aria-label={`${tier.label} tier: approval valid for (months)`}
                    inputMode="numeric"
                    value={t.validity}
                    aria-invalid={errors?.tiers[tier.id] ? true : undefined}
                    placeholder={`Default ${DEFAULT_VALIDITY[tier.id]}`}
                    onChange={(e) => setDraft((d) => ({ ...d, tiers: { ...d.tiers, [tier.id]: { ...d.tiers[tier.id], validity: e.target.value } } }))}
                  />
                </Field>
              </li>
            );
          })}
        </ul>
      </Card>

      <Card title="Risk acceptors">
        <p className={p.lead}>People who may accept a use case&apos;s residual risk when they approve it.</p>
        <PeoplePicker label="Risk acceptors" group="risk acceptors" people={props.people} value={draft.riskAcceptorUserIds} onChange={(riskAcceptorUserIds) => setDraft((d) => ({ ...d, riskAcceptorUserIds }))} nameOf={nameOf} />
      </Card>

      <Card>
        <div className={p.footer}>
          <p className={p.footerNote}>
            {props.policy.updatedAt ? `Last changed ${shortDate(props.policy.updatedAt)}${props.policy.updatedByName ? ` by ${props.policy.updatedByName}` : ""}.` : "Not changed yet."}
          </p>
          {errors && policyHasErrors(errors) ? <p className={p.error} role="alert">Fix the highlighted fields, then save.</p> : null}
          {submitError ? <p className={p.error} role="alert">The policy was not saved: {submitError}</p> : null}
          <Button type="submit" variant="primary" disabled={busy}>{busy ? "Saving…" : "Save policy"}</Button>
        </div>
      </Card>
    </form>
  );
}

/** chosen people as removable chips, and a picker that adds one at a time */
export function PeoplePicker(props: {
  label: string;
  /** what the people belong to, for the controls' names ("Remove Ada from Privacy") */
  group: string;
  people: DirectoryUser[];
  value: string[];
  onChange: (ids: string[]) => void;
  nameOf: (id: string) => string;
  error?: string | null;
}) {
  const labelId = useId();
  const select = useRef<HTMLSelectElement>(null);
  const available = props.people.filter((u) => !props.value.includes(u.id));
  return (
    <div className={p.people} role="group" aria-labelledby={labelId}>
      <span id={labelId} className={p.peopleLabel}>{props.label}</span>
      {props.value.length === 0 ? <span className={p.none}>Nobody yet.</span> : (
        <ul className={p.chips}>
          {props.value.map((id) => (
            <li key={id} className={p.person}>
              {props.nameOf(id)}
              <button
                type="button"
                className={p.personRemove}
                aria-label={`Remove ${props.nameOf(id)} from ${props.group}`}
                onClick={() => { props.onChange(props.value.filter((x) => x !== id)); select.current?.focus(); }}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <Select
        ref={select}
        className={p.addPerson}
        aria-label={`Add a person to ${props.group}`}
        aria-invalid={props.error ? true : undefined}
        value=""
        disabled={available.length === 0}
        onChange={(e) => { if (e.target.value) props.onChange([...props.value, e.target.value]); }}
      >
        <option value="">{available.length === 0 ? "Everyone is added" : "Add a person…"}</option>
        {available.map((u) => <option key={u.id} value={u.id}>{u.name ?? u.id}</option>)}
      </Select>
      {props.error ? <p className={p.error}>{props.error}</p> : null}
    </div>
  );
}
