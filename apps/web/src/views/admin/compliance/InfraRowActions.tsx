/**
 * PROTOTYPE (#453 G8) — row actions for infrastructure resources and policies:
 * Edit, Retire resource (refused while remediations wait on approval), Retire
 * policy (the confirm states what the resource falls back to).
 */
import { useState } from "react";
import { ApiError, api } from "../../../api/client";
import type { InfraPolicy, InfraResource } from "../../../api/adminTypes";
import { Button, Field, Input, Modal, RowActions, Select } from "../../../ui/kit";
import { useToast } from "../../../ui/toast";
import { ReasonModal, useAction, useAdminInvalidate, useComplianceProfiles } from "../adminKit";
import a from "../admin.module.css";
import v from "../../views.module.css";

export type ResourceRecord = InfraResource & { status?: "active" | "retired"; retiredAt?: string | null };

export function ResourceActions(props: { resource: ResourceRecord }) {
  const r = props.resource;
  const [editing, setEditing] = useState(false);
  const [retiring, setRetiring] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const { toast } = useToast();
  const invalidate = useAdminInvalidate();
  if (r.status === "retired") return <span className={v.faint}>Read-only{r.retiredAt ? ` · retired ${r.retiredAt.slice(0, 10)}` : ""}</span>;
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
          <Button size="sm" variant="ghost" aria-label={`Retire resource ${r.name}`} onClick={() => setRetiring(true)}>
            Retire resource
          </Button>
        }
      />
      {editing && <EditResourceModal resource={r} onClose={() => setEditing(false)} />}
      <ReasonModal
        open={retiring}
        danger
        minLength={10}
        title={`Retire resource “${r.name}”?`}
        confirmLabel="Retire resource"
        body={
          <>
            <p className={v.flush}>
              Scans stop checking ‘{r.name}’ and no new findings are raised. Its findings, rotations, patches and backups stay readable.
            </p>
            {refusal && (
              <div className={v.errLine} role="alert" data-testid="infra-retire-refusal">
                {refusal}
              </div>
            )}
          </>
        }
        onCancel={() => {
          setRetiring(false);
          setRefusal(null);
        }}
        onConfirm={(reason) => {
          setRefusal(null);
          void (async () => {
            try {
              await api.post(`/v1/infra/resources/${r.id}/retire`, { reason });
              setRetiring(false);
              toast(`Resource “${r.name}” retired`, "success");
              invalidate();
            } catch (e) {
              if (e instanceof ApiError && e.payload.error === "infra_resource_in_use") {
                const n = Number(e.payload.pendingRemediations ?? 0);
                setRefusal(`${n} ${n === 1 ? "remediation is" : "remediations are"} waiting on approval for this resource. Decide them first.`);
              } else setRefusal(e instanceof Error ? e.message : String(e));
            }
          })();
        }}
      />
    </>
  );
}

function EditResourceModal(props: { resource: ResourceRecord; onClose: () => void }) {
  const profiles = useComplianceProfiles();
  const act = useAction();
  const [name, setName] = useState(props.resource.name);
  const [tags, setTags] = useState<string[]>(props.resource.classifications ?? []);
  const tagList = (profiles.data?.profiles ?? []).map((p) => p.tag);
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
            disabled={act.busy}
            onClick={() =>
              void act
                .run(() => api.patch(`/v1/infra/resources/${props.resource.id}`, { name, classifications: tags }), "Resource saved")
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
          <Input value={name} onChange={(e) => setName(e.target.value)} />
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
      <p className={v.faint}>Removing a classification lowers the floors this resource inherits; the change is audited.</p>
    </Modal>
  );
}

export function PolicyActions(props: { policy: InfraPolicy; fleet: InfraPolicy | undefined; resourceName: string }) {
  const p = props.policy;
  const [editing, setEditing] = useState(false);
  const [retiring, setRetiring] = useState(false);
  const act = useAction();
  const fleet = props.fleet;
  const fallback = fleet
    ? `This resource falls back to the fleet policy: patch every ${fleet.patchCadenceDays ?? "—"} days, auto-remediate up to ${fleet.autoRemediateMaxSeverity ?? "nothing (never)"}.`
    : "No fleet policy is set, so this resource falls back to no policy: nothing is auto-remediated.";
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
            <Button size="sm" variant="ghost" aria-label={`Retire policy for ${props.resourceName}`} onClick={() => setRetiring(true)}>
              Retire policy
            </Button>
          ) : (
            <span className={v.faint}>Fleet default: edit, not retire</span>
          )
        }
      />
      {editing && <EditPolicyModal policy={p} scope={props.resourceName} onClose={() => setEditing(false)} />}
      <ReasonModal
        open={retiring}
        danger
        minLength={10}
        title={`Retire the policy for “${props.resourceName}”?`}
        confirmLabel="Retire policy"
        body={
          <p className={v.flush} data-testid="policy-fallback">
            {fallback} The retired policy stays readable in the audit log.
          </p>
        }
        onCancel={() => setRetiring(false)}
        onConfirm={(reason) => {
          setRetiring(false);
          void act.run(() => api.post(`/v1/infra/policies/${p.id}/retire`, { reason }), `Policy retired; “${props.resourceName}” now follows the fleet policy`);
        }}
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
  const n = (x: string) => (x === "" ? null : Number(x));
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
                    api.patch(`/v1/infra/policies/${p.id}`, {
                      patchCadenceDays: n(f.patchCadenceDays),
                      certRotationDaysBeforeExpiry: n(f.certRotationDaysBeforeExpiry),
                      backupSchedule: f.backupSchedule || null,
                      backupRetentionDays: n(f.backupRetentionDays),
                      autoRemediateMaxSeverity: f.autoRemediateMaxSeverity || null,
                    }),
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
          <Input type="number" value={f.patchCadenceDays} onChange={(e) => set("patchCadenceDays", e.target.value)} />
        </Field>
        <Field label="Cert rotation window days">
          <Input type="number" value={f.certRotationDaysBeforeExpiry} onChange={(e) => set("certRotationDaysBeforeExpiry", e.target.value)} />
        </Field>
        <Field label="Backup schedule">
          <Input value={f.backupSchedule} onChange={(e) => set("backupSchedule", e.target.value)} />
        </Field>
        <Field label="Backup retention days">
          <Input type="number" value={f.backupRetentionDays} onChange={(e) => set("backupRetentionDays", e.target.value)} />
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
      <p className={v.faint}>Raising the auto-remediate ceiling lets scans change more without an approver. You will be asked to confirm it's you.</p>
    </Modal>
  );
}
