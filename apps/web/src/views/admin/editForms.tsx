/**
 * An "Edit" control for each PATCH route that had none. Each one knows its
 * route's schema (packages/shared) and sends only what was edited:
 *
 *  - initiatives: `PATCH /v1/initiatives/:id` (name, cost center; null clears it)
 *  - interception scope rules: `PATCH /v1/interception/scope-rules/:id` (the
 *    override fields; the scope is the rule's identity, so retargeting is
 *    delete + create)
 *  - report schedules: `PATCH /v1/reports/schedules/:id` (cadence, enabled,
 *    recipients)
 *  - passkeys: `PATCH /v1/auth/passkeys/:id` (rename; cosmetic, no step-up)
 *  - external scorers: `PATCH /v1/external-scorers/:id` (moving the endpoint
 *    disables the scorer until a fresh connection test passes)
 *  - vendors: `PATCH /v1/vendors/:id` (only while proposed or under
 *    assessment; status and attestations are never patched)
 */
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../../api/client";
import { Button } from "../../ui/kit";
import { PatchFormModal } from "./PatchFormModal";
import { BOOL, nullableEnum, TRI_STATE, type Choice, type PatchField } from "./patchForm";

function useInvalidate(prefix: readonly unknown[] = ["admin"]) {
  const qc = useQueryClient();
  return () => void qc.invalidateQueries({ queryKey: prefix });
}

function EditButton(props: {
  label: string;
  title: string;
  fields: readonly PatchField[];
  record: Record<string, unknown>;
  save: (body: Record<string, unknown>) => Promise<unknown>;
  onSaved?: () => void;
  intro?: React.ReactNode;
  disabledReason?: string;
  buttonText?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        aria-label={props.label}
        title={props.disabledReason}
        disabled={Boolean(props.disabledReason)}
        onClick={() => setOpen(true)}
      >
        {props.buttonText ?? "Edit"}
      </Button>
      {open ? (
        <PatchFormModal
          title={props.title}
          fields={props.fields}
          record={props.record}
          save={props.save}
          intro={props.intro}
          onSaved={props.onSaved}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

const seg = (id: string) => encodeURIComponent(id);

// ---- initiatives ------------------------------------------------------------

export const INITIATIVE_FIELDS: readonly PatchField[] = [
  { key: "name", label: "Name", kind: "text", maxLength: 200, required: true },
  { key: "costCenter", label: "Cost center (empty = none)", kind: "text", maxLength: 100, nullable: true },
];

export function EditInitiativeButton(props: { initiative: { id: string; name: string; costCenter: string | null } }) {
  const done = useInvalidate();
  const i = props.initiative;
  return (
    <EditButton
      label={`Edit initiative ${i.name}`}
      title={`Edit initiative ${i.name}`}
      fields={INITIATIVE_FIELDS}
      record={{ ...i }}
      save={(body) => api.patch(`/v1/initiatives/${seg(i.id)}`, body)}
      onSaved={done}
    />
  );
}

// ---- interception scope rules -----------------------------------------------

export const RESOLUTION_MODES: readonly Choice[] = [
  { value: "", label: "inherit" },
  { value: "map_by_model", label: "map_by_model" },
  { value: "require_agent", label: "require_agent" },
  { value: "router_decides", label: "router_decides" },
];

export const SCOPE_RULE_FIELDS: readonly PatchField[] = [
  { key: "anthropicCompatEnabled", label: "/v1/messages", kind: "select", options: TRI_STATE.options, decode: TRI_STATE.decode, encode: TRI_STATE.encode },
  { key: "openaiCompatEnabled", label: "/v1/chat/completions", kind: "select", options: TRI_STATE.options, decode: TRI_STATE.decode, encode: TRI_STATE.encode },
  { key: "resolutionMode", label: "Resolution mode", kind: "select", options: RESOLUTION_MODES, decode: nullableEnum.decode, encode: nullableEnum.encode },
  { key: "note", label: "Note (empty = none)", kind: "text", maxLength: 2000, nullable: true },
];

export function EditScopeRuleButton(props: { rule: { id: string; scopeKind: string; scopeName?: string | null; scopeId: string } }) {
  const done = useInvalidate();
  const r = props.rule;
  const who = `${r.scopeKind} ${r.scopeName ?? r.scopeId}`;
  return (
    <EditButton
      label={`Edit scope rule for ${who}`}
      title={`Edit the override for ${who}`}
      fields={SCOPE_RULE_FIELDS}
      record={{ ...r }}
      intro={<p>The scope is the rule&apos;s identity: to move it to another user, project or role, delete it and create a new one. A rule that enables a surface grants nothing by itself.</p>}
      save={(body) => api.patch(`/v1/interception/scope-rules/${seg(r.id)}`, body)}
      onSaved={done}
    />
  );
}

// ---- report schedules -------------------------------------------------------

export const REPORT_CADENCES: readonly Choice[] = ["daily", "weekly", "monthly", "quarterly"].map((c) => ({ value: c, label: c }));

export const reportScheduleFields = (users: readonly Choice[], usersLoading = false): readonly PatchField[] => [
  { key: "cadence", label: "Cadence", kind: "select", options: REPORT_CADENCES },
  { key: "enabled", label: "Enabled", kind: "select", options: [{ value: "true", label: "yes" }, { value: "false", label: "no" }], decode: BOOL.decode, encode: BOOL.encode },
  {
    key: "recipientUserIds",
    label: "Recipients",
    kind: "multi",
    options: users,
    emptyAs: null,
    loading: usersLoading,
    help: "Recorded for the entitlement check on each generated report. No delivery transport is wired: nobody is mailed.",
  },
];

export function EditReportScheduleButton(props: {
  schedule: { id: string; cadence: string; enabled: boolean; recipientUserIds: string[] | null };
  definitionName: string;
  users: readonly Choice[];
  /** the user list is still loading: Save waits, so stored recipients are never judged against an empty list */
  usersLoading?: boolean;
  onSaved?: () => void;
}) {
  const done = useInvalidate();
  const s = props.schedule;
  return (
    <EditButton
      label={`Edit schedule for ${props.definitionName}`}
      title={`Edit the ${s.cadence} schedule for ${props.definitionName}`}
      fields={reportScheduleFields(props.users, props.usersLoading)}
      record={{ ...s }}
      save={(body) => api.patch(`/v1/reports/schedules/${seg(s.id)}`, body)}
      onSaved={() => {
        done();
        props.onSaved?.();
      }}
    />
  );
}

// ---- passkeys (self) ---------------------------------------------------------

export const PASSKEY_FIELDS: readonly PatchField[] = [{ key: "label", label: "Name", kind: "text", maxLength: 100, required: true }];

export function RenamePasskeyButton(props: { passkey: { id: string; label: string }; onSaved: () => void }) {
  const p = props.passkey;
  return (
    <EditButton
      label={`Rename the passkey ${p.label}`}
      title={`Rename the passkey "${p.label}"`}
      buttonText="Rename"
      fields={PASSKEY_FIELDS}
      record={{ ...p }}
      save={(body) => api.patch(`/v1/auth/passkeys/${seg(p.id)}`, body)}
      onSaved={props.onSaved}
    />
  );
}

// ---- external scorers ---------------------------------------------------------

// ADR-0220: the three guardrail kinds a trained-detector service serves
export const SCORER_KINDS: readonly Choice[] = [
  "llm_as_judge",
  "groundedness_judge",
  "answer_relevance_judge",
  "guardrail_pii",
  "guardrail_prompt_injection",
  "guardrail_harm",
].map((k) => ({ value: k, label: k }));

export const EXTERNAL_SCORER_FIELDS: readonly PatchField[] = [
  { key: "name", label: "Name", kind: "text", maxLength: 120, required: true },
  { key: "baseUrl", label: "Endpoint URL", kind: "text", maxLength: 2048, required: true, help: "Moving the endpoint disables the scorer until a fresh connection test passes; the egress guard checks the new host first." },
  { key: "scorerKinds", label: "Claims to serve", kind: "multi", options: SCORER_KINDS, min: 1, max: 6 },
  {
    key: "allowPlaintextHttp",
    label: "Plaintext http",
    kind: "select",
    options: [{ value: "false", label: "refused (https only)" }, { value: "true", label: "allowed for this scorer" }],
    decode: BOOL.decode,
    encode: BOOL.encode,
  },
  { key: "apiKey", label: "API key", kind: "secret", maxLength: 4096, clearLabel: "Remove the stored key (the scorer becomes keyless)" },
];

export function EditExternalScorerButton(props: { scorer: { id: string; name: string } }) {
  const done = useInvalidate();
  const s = props.scorer;
  return (
    <EditButton
      label={`Edit external scorer ${s.name}`}
      title={`Edit external scorer ${s.name}`}
      fields={EXTERNAL_SCORER_FIELDS}
      record={{ ...s }}
      save={(body) => api.patch(`/v1/external-scorers/${seg(s.id)}`, body)}
      onSaved={done}
    />
  );
}

// ---- vendors ----------------------------------------------------------------------

export const VENDOR_CATEGORIES: readonly Choice[] = [
  { value: "model_provider", label: "model provider" },
  { value: "ai_feature_vendor", label: "AI-feature vendor" },
  { value: "data_processor", label: "data processor" },
  { value: "integration", label: "integration" },
];

export const vendorFields = (customProviders: readonly Choice[], providersLoading = false): readonly PatchField[] => [
  { key: "description", label: "Description", kind: "textarea", maxLength: 4000, required: true },
  { key: "category", label: "Category", kind: "select", options: VENDOR_CATEGORIES },
  { key: "linkedCustomProviderIds", label: "Linked custom LLM providers", kind: "multi", options: customProviders, max: 20, loading: providersLoading },
  { key: "linkedAgentProviders", label: "Linked agent providers", kind: "list", maxItems: 20, maxLength: 100, help: "Provider keys as they appear on agents, e.g. anthropic, openai." },
];

/** why a vendor cannot be edited, or null (the gateway refuses the same with 409 vendor_not_editable) */
export function vendorEditBlocked(status: string): string | null {
  return status === "proposed" || status === "under_assessment"
    ? null
    : `This vendor is ${status.replace(/_/g, " ")}: a decided record, so editing it would change what was decided.`;
}

export function EditVendorButton(props: {
  vendor: { id: string; name: string; status: string };
  customProviders: readonly Choice[];
  providersLoading?: boolean;
  onSaved?: () => void;
}) {
  const done = useInvalidate();
  const vd = props.vendor;
  return (
    <EditButton
      label={`Edit vendor ${vd.name}`}
      title={`Edit vendor ${vd.name}`}
      fields={vendorFields(props.customProviders, props.providersLoading)}
      record={{ ...vd }}
      disabledReason={vendorEditBlocked(vd.status) ?? undefined}
      intro={<p>Status follows the linked assessment and attestations are recorded one by one; neither is edited here.</p>}
      save={(body) => api.patch(`/v1/vendors/${seg(vd.id)}`, body)}
      onSaved={() => {
        done();
        props.onSaved?.();
      }}
    />
  );
}
