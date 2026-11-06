/**
 * ADR-0208 G8 — row actions for infrastructure resources and policies: Edit, Retire resource (refused while
 * remediations wait on approval or are approved but not applied), Retire policy (the confirm states the fleet
 * policy the resource falls back to). Retire only: a delete would erase the remediation ledgers. A retired row is
 * read-only. Loosening edits and every retire ask the person to confirm it's them (withStepUp). A refusal is shown
 * INSIDE the dialog, which stays open with the typed reason (the ReasonedAction pattern).
 */
import { useState, type ReactNode } from "react";
import { ApiError } from "../../../api/client";
import type { InfraPolicy, InfraPolicyRetireResponse, InfraResource, InfraResourceRetireResponse } from "../../../api/adminTypes";
import { api as stepUpApi, withStepUp } from "../../../stepup/stepUp";
import { Button, Field, Input, Modal, RowActions, Select } from "../../../ui/kit";
import { useToast } from "../../../ui/toast";
import { ReasonModal, useAction, useAdminInvalidate, useComplianceProfiles } from "../adminKit";
import a from "../admin.module.css";
import v from "../../views.module.css";

/** a retired row's place in the actions column */
function ReadOnly(props: { retiredAt?: string | null }) {
  return <span className={v.faint}>Read-only{props.retiredAt ? ` · retired ${props.retiredAt.slice(0, 10)}` : ""}</span>;
}

/** the server's refusal as what the person does next (known codes), else its own sentence */
function refusalText(e: unknown, known: (code: string, payload: ApiError["payload"]) => string | null): string {
  if (e instanceof ApiError && typeof e.payload.error === "string") {
    const said = known(e.payload.error, e.payload);
    if (said) return said;
  }
  return e instanceof Error ? e.message : String(e);
}

/** a reasoned retire: posts the reason through step-up; on refusal the dialog stays open and says why */
function useRetire<T>(path: string, onDone: (out: T) => void, known: (code: string, payload: ApiError["payload"]) => string | null) {
  const [open, setOpen] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const invalidate = useAdminInvalidate();
  return {
    open,
    refused,
    start: () => setOpen(true),
    cancel: () => {
      setOpen(false);
      setRefused(null);
    },
    confirm: (reason: string) => {
      setRefused(null);
      void (async () => {
        try {
          const out = await withStepUp((h) => stepUpApi.post<T>(path, { reason }, h));
          setOpen(false);
          invalidate();
          onDone(out);
        } catch (e) {
          setRefused(refusalText(e, known));
        }
      })();
    },
  };
}

function RefusalLine(props: { text: string | null; testId: string }) {
  if (!props.text) return null;
  return (
    <div className={v.errLine} role="alert" data-testid={props.testId}>
      {props.text}
    </div>
  );
}

const RETIRED_SENTENCE = (code: string): string | null =>
  code === "infra_resource_retired"
    ? "This resource is already retired. Reload to see it."
    : code === "infra_policy_retired"
      ? "This policy is already retired. Reload to see it."
      : null;

export function ResourceActions(props: { resource: InfraResource }) {
  const r = props.resource;
  const [editing, setEditing] = useState(false);
  const { toast } = useToast();
  const retire = useRetire<InfraResourceRetireResponse>(
    `/v1/infra/resources/${r.id}/retire`,
    (out) => {
      const n = out.policiesRetired.length;
      toast(`Resource “${r.name}” retired${n > 0 ? ` with its policy` : ""}`, "success");
    },
    (code, payload) => {
      if (code === "infra_resource_remediations_pending") {
        const n = Number(payload.pendingRemediations ?? (Array.isArray(payload.findingIds) ? payload.findingIds.length : 0));
        return `${n} ${n === 1 ? "remediation is" : "remediations are"} waiting on approval or approved but not applied for this resource. Decide or apply ${n === 1 ? "it" : "them"} first.`;
      }
      return RETIRED_SENTENCE(code);
    },
  );
  if (r.status === "retired") return <ReadOnly retiredAt={r.retiredAt} />;
  return (
    <>
      <RowActions
        slot="5rem"
        primary={
          <Button size="sm" aria-label={`Edit ${r.name}`} onClick={() => setEditing(true)}>
            Edit
          </Button>
        }
        rest={
          <Button size="sm" variant="ghost" aria-label={`Retire resource ${r.name}`} onClick={retire.start}>
            Retire resource
          </Button>
        }
      />
      {editing && <EditResourceModal resource={r} onClose={() => setEditing(false)} />}
      <ReasonModal
        open={retire.open}
        danger
        minLength={10}
        title={`Retire resource “${r.name}”?`}
        confirmLabel="Retire resource"
        body={
          <>
            <p className={v.flush}>
              Scans stop checking ‘{r.name}’ and no new findings are raised; its own policy is retired with it. Its findings, rotations,
              patches and backups stay readable. You will be asked to confirm it's you.
            </p>
            <RefusalLine text={retire.refused} testId="infra-retire-refusal" />
          </>
        }
        onCancel={retire.cancel}
        onConfirm={retire.confirm}
      />
    </>
  );
}

/** the modal's footer error, kept beside the form (a toast disappears) */
function ActError(props: { error: string | null }) {
  if (!props.error) return null;
  return (
    <p className={v.errLine} role="alert">
      {props.error}
    </p>
  );
}

function EditResourceModal(props: { resource: InfraResource; onClose: () => void }) {
  const profiles = useComplianceProfiles();
  const act = useAction();
  const [name, setName] = useState(props.resource.name);
  const [tags, setTags] = useState<string[]>(props.resource.classifications ?? []);
  // the resource's own tags stay choosable even when no profile names them any more
  const tagList = [...new Set([...(profiles.data?.profiles ?? []).map((p) => p.tag), ...(props.resource.classifications ?? [])])];
  return (
    <Modal
      open
      title={`Edit resource “${props.resource.name}”`}
      onClose={props.onClose}
      actions={
        <>
          <Button onClick={props.onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={act.busy || !name.trim()}
            onClick={() =>
              void act
                .run(
                  () => withStepUp((h) => stepUpApi.patch(`/v1/infra/resources/${props.resource.id}`, { name: name.trim(), classifications: tags }, h)),
                  "Resource saved",
                )
                .then((ok) => ok && props.onClose())
            }
          >
            Save resource
          </Button>
        </>
      }
    >
      <div className={a.formRow}>
        <Field label="Name">
          <Input value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Classifications">
          <Select multiple size={3} value={tags} onChange={(e) => setTags(Array.from(e.target.selectedOptions).map((o) => o.value))}>
            {tagList.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <p className={v.faint}>Removing a classification lowers the floors this resource inherits. You will be asked to confirm it's you; the change is audited.</p>
      <ActError error={act.error} />
    </Modal>
  );
}

/** what a resource follows once its own policy is retired */
export function fallbackSentence(fleet: Pick<InfraPolicy, "patchCadenceDays" | "autoRemediateMaxSeverity"> | null | undefined): string {
  return fleet
    ? `This resource falls back to the fleet policy: patch every ${fleet.patchCadenceDays ?? "—"} days, auto-remediate up to ${fleet.autoRemediateMaxSeverity ?? "nothing (never)"}.`
    : "No fleet policy is set, so this resource falls back to no policy: nothing is auto-remediated.";
}

export function PolicyActions(props: { policy: InfraPolicy; fleet: InfraPolicy | undefined; resourceName: string }) {
  const p = props.policy;
  const [editing, setEditing] = useState(false);
  const { toast } = useToast();
  const retire = useRetire<InfraPolicyRetireResponse>(
    `/v1/infra/policies/${p.id}/retire`,
    (out) =>
      toast(
        out.fallback ? `Policy retired; “${props.resourceName}” now follows the fleet policy` : `Policy retired; “${props.resourceName}” now has no policy`,
        "success",
      ),
    (code) =>
      code === "infra_fleet_policy_not_retirable" ? "The fleet policy is every resource's fallback: edit it instead." : RETIRED_SENTENCE(code),
  );
  if (p.status === "retired") return <ReadOnly retiredAt={p.retiredAt} />;
  const body: ReactNode = (
    <>
      <p className={v.flush} data-testid="policy-fallback">
        {fallbackSentence(props.fleet)} The retired policy stays readable in the audit log. You will be asked to confirm it's you.
      </p>
      <RefusalLine text={retire.refused} testId="policy-retire-refusal" />
    </>
  );
  return (
    <>
      <RowActions
        slot="5rem"
        primary={
          <Button size="sm" aria-label={`Edit policy for ${props.resourceName}`} onClick={() => setEditing(true)}>
            Edit
          </Button>
        }
        rest={
          p.resourceId ? (
            <Button size="sm" variant="ghost" aria-label={`Retire policy for ${props.resourceName}`} onClick={retire.start}>
              Retire policy
            </Button>
          ) : (
            <span className={v.faint}>Fleet default: edit, not retire</span>
          )
        }
      />
      {editing && <EditPolicyModal policy={p} scope={props.resourceName} onClose={() => setEditing(false)} />}
      <ReasonModal
        open={retire.open}
        danger
        minLength={10}
        title={`Retire the policy for “${props.resourceName}”?`}
        confirmLabel="Retire policy"
        body={body}
        onCancel={retire.cancel}
        onConfirm={retire.confirm}
      />
    </>
  );
}

function EditPolicyModal(props: { policy: InfraPolicy; scope: string; onClose: () => void }) {
  const act = useAction();
  const p = props.policy;
  const str = (n: number | null) => (n == null ? "" : String(n));
  const [f, setF] = useState({
    patchCadenceDays: str(p.patchCadenceDays),
    certRotationDaysBeforeExpiry: str(p.certRotationDaysBeforeExpiry),
    backupSchedule: p.backupSchedule ?? "",
    backupRetentionDays: str(p.backupRetentionDays),
    autoRemediateMaxSeverity: p.autoRemediateMaxSeverity ?? "",
  });
  const set = (k: keyof typeof f, val: string) => setF((s) => ({ ...s, [k]: val }));
  const n = (x: string) => (x.trim() === "" ? null : Number(x));
  return (
    <Modal
      open
      wide
      title={`Edit policy: ${props.scope}`}
      onClose={props.onClose}
      actions={
        <>
          <Button onClick={props.onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={act.busy}
            onClick={() =>
              void act
                .run(
                  () =>
                    withStepUp((h) =>
                      stepUpApi.patch(
                        `/v1/infra/policies/${p.id}`,
                        {
                          patchCadenceDays: n(f.patchCadenceDays),
                          certRotationDaysBeforeExpiry: n(f.certRotationDaysBeforeExpiry),
                          backupSchedule: f.backupSchedule.trim() || null,
                          backupRetentionDays: n(f.backupRetentionDays),
                          autoRemediateMaxSeverity: f.autoRemediateMaxSeverity || null,
                        },
                        h,
                      ),
                    ),
                  "Policy saved",
                )
                .then((ok) => ok && props.onClose())
            }
          >
            Save policy
          </Button>
        </>
      }
    >
      <div className={a.formRow}>
        <Field label="Patch cadence days">
          <Input type="number" min={1} max={3650} value={f.patchCadenceDays} onChange={(e) => set("patchCadenceDays", e.target.value)} />
        </Field>
        <Field label="Cert rotation window days">
          <Input type="number" min={1} max={3650} value={f.certRotationDaysBeforeExpiry} onChange={(e) => set("certRotationDaysBeforeExpiry", e.target.value)} />
        </Field>
        <Field label="Backup schedule">
          <Input value={f.backupSchedule} maxLength={200} onChange={(e) => set("backupSchedule", e.target.value)} />
        </Field>
        <Field label="Backup retention days">
          <Input type="number" min={1} max={36500} value={f.backupRetentionDays} onChange={(e) => set("backupRetentionDays", e.target.value)} />
        </Field>
        <Field label="Auto-remediate ceiling">
          <Select value={f.autoRemediateMaxSeverity} onChange={(e) => set("autoRemediateMaxSeverity", e.target.value)}>
            <option value="">— never auto-remediate —</option>
            <option value="low">low</option>
            <option value="medium">medium</option>
            <option value="high">high</option>
          </Select>
        </Field>
      </div>
      <p className={v.faint}>
        A change that loosens this policy (a higher auto-remediate ceiling, a slower patch cadence, shorter backup retention, a shorter cert
        rotation window, or clearing one of those numbers) asks you to confirm it's you.
      </p>
      <ActError error={act.error} />
    </Modal>
  );
}
