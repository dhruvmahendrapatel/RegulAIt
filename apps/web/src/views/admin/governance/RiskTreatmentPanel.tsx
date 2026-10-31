/**
 * Transferred and avoided risk treatments, inside the risk detail on the Risks
 * page (no section of their own).
 *
 *  - On a live risk (open or mitigating), when the organisation has turned the
 *    treatments on: record a transfer or an avoidance. Both need the evidence
 *    (the contract or policy reference, or the decision that stopped the use)
 *    and an accountable owner, and both are stated at the point of decision.
 *  - On a treated risk: the record (evidence, owner, when), and the two ways
 *    on: reopen it, or close it. Each is an audited move with a reason.
 *
 * The page is in the admin console, so the owner is picked from the people
 * list (the signed-in admin by default); the gateway still lets a risk's own
 * owner record a treatment through the API, naming only themselves.
 * Refusals render inline beside the action that was refused.
 */
import { useState } from "react";
import { api } from "../../../api/client";
import { ago } from "../../../api/format";
import { Button, Card, Field, Input, Select, Textarea } from "../../../ui/kit";
import { RefusalNotice } from "../../../ui/RefusalNotice";
import { optionEls, useAction, useUserPicker } from "../adminKit";
import a from "../admin.module.css";
import v from "../../views.module.css";

export type RiskTreatment = "transferred" | "avoided";

export interface TreatmentRecord {
  treatment: RiskTreatment;
  evidence: string | null;
  ownerUserId: string | null;
  ownerName: string | null;
  treatedAt: string | null;
}

const EVIDENCE_LABEL: Record<RiskTreatment, string> = {
  transferred: "Contract or policy reference — required",
  avoided: "The decision that stopped the use — required",
};
const EVIDENCE_HINT: Record<RiskTreatment, string> = {
  transferred: "Cyber policy CY-2026-114, clause 7",
  avoided: "Change board decision of 12 October: the pilot is withdrawn",
};
const MEANING: Record<RiskTreatment, string> = {
  transferred:
    "An insurer or supplier carries the cost. The risk keeps its rating and stays in the tolerance check: a contract moves who pays, not whether the harm can happen.",
  avoided: "The use that created the risk has stopped. The risk no longer carries a rating; reopen it if the use resumes.",
};

function InlineRefusal(props: { act: ReturnType<typeof useAction> }) {
  if (props.act.guidance) return <RefusalNotice guidance={props.act.guidance} />;
  return props.act.error ? (
    <div className={v.errLine} role="alert">
      {props.act.error}
    </div>
  ) : null;
}

/** the owner picker: active people only */
function OwnerSelect(props: { value: string; onChange: (id: string) => void }) {
  const people = useUserPicker();
  return (
    <Select value={props.value} onChange={(e) => props.onChange(e.target.value)}>
      {optionEls(
        (people.data?.users ?? []).filter((u) => !u.disabledAt).map((u) => ({ v: u.id, l: u.displayName || u.email })),
        "choose a person",
      )}
    </Select>
  );
}

/** record a transfer or an avoidance on a live risk */
export function RecordTreatment(props: {
  riskId: string;
  selfId: string | null;
  onChanged: () => Promise<unknown>;
}) {
  const act = useAction();
  const [treatment, setTreatment] = useState<RiskTreatment>("transferred");
  const [evidence, setEvidence] = useState("");
  const [owner, setOwner] = useState(props.selfId ?? "");
  const ready = evidence.trim().length > 0 && owner.length > 0;
  return (
    <Card title="Transfer or avoid this risk">
      <div className={v.stack}>
        <div className={a.formRow}>
          <Field label="Treatment">
            <Select value={treatment} onChange={(e) => setTreatment(e.target.value as RiskTreatment)}>
              <option value="transferred">Transferred</option>
              <option value="avoided">Avoided</option>
            </Select>
          </Field>
          <Field label="Owner of the arrangement — required">
            <OwnerSelect value={owner} onChange={setOwner} />
          </Field>
        </div>
        <div className={v.faint}>{MEANING[treatment]}</div>
        <Field label={EVIDENCE_LABEL[treatment]}>
          <Textarea rows={2} maxLength={2000} value={evidence} onChange={(e) => setEvidence(e.target.value)} placeholder={EVIDENCE_HINT[treatment]} />
        </Field>
        <div>
          <Button
            disabled={act.busy || !ready}
            onClick={() =>
              void act.run(async () => {
                await api.post(`/v1/risks/${props.riskId}/treatment`, { treatment, evidence: evidence.trim(), ownerUserId: owner });
                setEvidence("");
                await props.onChanged();
              }, treatment === "transferred" ? "Risk recorded as transferred" : "Risk recorded as avoided")
            }
          >
            {treatment === "transferred" ? "Record transfer" : "Record avoidance"}
          </Button>
        </div>
        <InlineRefusal act={act} />
      </div>
    </Card>
  );
}

/** the record on a treated risk, and the audited ways on from it */
export function TreatmentRecordCard(props: { riskId: string; record: TreatmentRecord; onChanged: () => Promise<unknown> }) {
  const act = useAction();
  const [reason, setReason] = useState("");
  const { record } = props;
  const move = (status: "open" | "closed", ok: string) =>
    void act.run(async () => {
      await api.post(`/v1/risks/${props.riskId}/transition`, { status, reason: reason.trim() });
      setReason("");
      await props.onChanged();
    }, ok);
  return (
    <Card title={record.treatment === "transferred" ? "Transfer record" : "Avoidance record"}>
      <div className={v.stack}>
        <div className={v.faint}>{MEANING[record.treatment]}</div>
        <div className={a.formRow}>
          <Field label={record.treatment === "transferred" ? "Contract or policy reference" : "Decision"} grow>
            <Input readOnly value={record.evidence ?? ""} />
          </Field>
          <Field label="Owner">
            <Input readOnly value={record.ownerName ?? "no longer a user"} />
          </Field>
          <Field label="Recorded">
            <Input readOnly value={record.treatedAt ? ago(record.treatedAt) : ""} />
          </Field>
        </div>
        <div className={a.formRow}>
          <Field label="Reason — required and audited" grow>
            <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="the policy lapsed on renewal" />
          </Field>
          <Field label=" ">
            <Button disabled={act.busy || !reason.trim()} onClick={() => move("open", "Risk reopened — the ended record stays on the audit trail")}>
              Reopen risk
            </Button>
          </Field>
          <Field label=" ">
            <Button variant="ghost" disabled={act.busy || !reason.trim()} onClick={() => move("closed", "Risk closed")}>
              Close risk
            </Button>
          </Field>
        </div>
        <InlineRefusal act={act} />
      </div>
    </Card>
  );
}
