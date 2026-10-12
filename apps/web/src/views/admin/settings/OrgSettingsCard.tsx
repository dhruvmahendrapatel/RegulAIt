/**
 * U3 settings batch — one card of org settings, each row its own control.
 *
 * The pattern is the BOM posture card's (BomPostureCard.tsx), generalised over
 * `orgSettingSpecs.ts`:
 *  - the values come from the one shared read (`orgSettingsQuery`). A failed
 *    read shows the error and its retry; a stored value that is missing or
 *    mistyped shows as unknown and its control stays disabled — never
 *    prefilled with the strict default.
 *  - each row sends ONLY its own key (`PUT /v1/org/settings` is a partial
 *    update), after a confirmation that names old → new, what the new value
 *    gives up (or keeps), and whether a step-up follows. The write goes
 *    through `putOrgSettings`, which asks for the `settings_relax` step-up
 *    when the gateway refuses for one.
 *  - after a write the card stays locked until the current values are read
 *    back (`useSettleAfterWrite`), so it never writes from a stale baseline.
 *  - every refusal is shown under its row in the gateway's own words.
 */
import { useId, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import type { OrgSettingsResponse } from "../../../api/adminTypes";
import { putOrgSettings } from "../../../stepup/stepUp";
import { Badge, Button, Card, Field, Fieldset, Input, Modal, Select } from "../../../ui/kit";
import { adminKeys, orgSettingsQuery, QueryGate, StaleAfterWrite, useAction, useSettleAfterWrite, useSingleFlight } from "../adminKit";
import v from "../../views.module.css";
import {
  describeValue,
  draftOf,
  needsStepUp,
  parseDraft,
  sameValue,
  specsFor,
  storedValue,
  type Draft,
  type OrgSettingSpec,
} from "./orgSettingSpecs";

export function OrgSettingsCard(props: {
  title: string;
  /** the org-settings keys this card edits, in display order */
  keys: readonly string[];
  intro?: ReactNode;
  testId?: string;
}) {
  const specs = specsFor(props.keys);
  const settings = useQuery(orgSettingsQuery<OrgSettingsResponse>());
  const baseline = useSettleAfterWrite(adminKeys.orgSettings);
  const flight = useSingleFlight();
  const save = async (body: Record<string, unknown>) => {
    if (baseline.stale || !flight.enter()) throw new Error("The settings are locked until their current values are reloaded.");
    try {
      await putOrgSettings(body);
      if (!(await baseline.settle())) {
        throw new Error("Saved, but the current values could not be reloaded. Reload them before changing another setting.");
      }
    } finally {
      flight.leave();
    }
  };
  const retry = async () => {
    if (!flight.enter()) return;
    try {
      await baseline.settle();
    } finally {
      flight.leave();
    }
  };
  // a response with no settings object is unknown, never "strict"
  const stored =
    settings.data?.settings && typeof settings.data.settings === "object"
      ? (settings.data.settings as unknown as Record<string, unknown>)
      : null;
  return (
    <Card title={props.title}>
      <div className={v.stack} data-testid={props.testId}>
        {props.intro}
        <p className={v.faint}>
          Each setting ships strict. Every change is audited (old → new); loosening one asks you to confirm it&rsquo;s you.
        </p>
        <QueryGate loading={settings.isLoading} error={settings.error} onRetry={() => void settings.refetch()}>
          {stored ? (
            specs.map((spec) => (
              <SettingRow
                key={`${spec.key}:${JSON.stringify(stored[spec.key])}`}
                spec={spec}
                current={stored[spec.key]}
                locked={baseline.stale || flight.busy}
                onSave={save}
              />
            ))
          ) : settings.data ? (
            <p role="status">This gateway did not report its settings, so these settings are unknown and cannot be changed here.</p>
          ) : null}
        </QueryGate>
        {baseline.stale ? <StaleAfterWrite onRetry={() => void retry()} /> : null}
      </div>
    </Card>
  );
}

interface Pending {
  value: unknown;
  from: string;
  to: string;
  relaxes: boolean;
  stepUp: boolean;
}

function SettingRow(props: {
  spec: OrgSettingSpec;
  current: unknown;
  locked: boolean;
  onSave: (body: Record<string, unknown>) => Promise<void>;
}) {
  const { spec } = props;
  const act = useAction();
  const stored = storedValue(spec, props.current);
  const known = stored !== undefined;
  const [draft, setDraft] = useState<Draft>(() => draftOf(spec, stored));
  const [pending, setPending] = useState<Pending | null>(null);
  const parsed = parseDraft(spec, draft);
  const disabled = props.locked || !known || act.busy || pending !== null;
  const unchanged = parsed.ok && known && sameValue(parsed.value, stored);
  const base = `org-setting-${spec.key}`;
  const helpId = `${base}-help`;
  const problemId = `${base}-problem`;
  const showProblem = known && !parsed.ok;
  const describedBy = showProblem ? `${helpId} ${problemId}` : helpId;
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));

  return (
    <form
      className={v.stack}
      data-testid={base}
      aria-label={spec.label}
      onSubmit={(event) => {
        event.preventDefault();
        if (disabled || !parsed.ok || !known || unchanged) return;
        setPending({
          value: parsed.value,
          from: describeValue(spec, stored),
          to: describeValue(spec, parsed.value),
          relaxes: spec.isRelaxed(parsed.value),
          stepUp: needsStepUp(spec, parsed.value, stored),
        });
      }}
    >
      <SettingControl spec={spec} id={base} draft={draft} set={set} disabled={disabled} known={known} describedBy={describedBy} />
      <div className={v.row}>
        {!known ? (
          <Badge tone="warn">unknown</Badge>
        ) : spec.isRelaxed(stored) ? (
          <Badge tone="warn">relaxed (audited)</Badge>
        ) : (
          <Badge tone="ok">strict</Badge>
        )}
        <span className={v.faint}>
          Current: {describeValue(spec, stored)} · strict default: {describeValue(spec, spec.strictDefault)}
        </span>
        <Button type="submit" size="sm" disabled={disabled || !parsed.ok || unchanged}>
          Review change
        </Button>
      </div>
      <p className={v.faint} id={helpId}>
        {spec.strict} {spec.relaxed}
      </p>
      {showProblem && !parsed.ok ? (
        <p className={v.errLine} id={problemId}>
          {parsed.problem}
        </p>
      ) : null}
      {act.error && (
        <p className={v.errLine} role="alert">
          {act.error}
        </p>
      )}
      <Modal
        open={pending !== null}
        title={`Change ${spec.label.toLowerCase()}?`}
        onClose={() => {
          if (!act.busy) setPending(null);
        }}
        actions={
          <>
            <Button disabled={act.busy} onClick={() => setPending(null)}>
              Cancel
            </Button>
            <Button
              variant={pending?.relaxes ? "danger" : "primary"}
              disabled={act.busy || props.locked}
              onClick={() => {
                if (!pending) return;
                void act.run(() => props.onSave({ [spec.key]: pending.value }), `${spec.label} saved`).finally(() => setPending(null));
              }}
            >
              {act.busy ? "Saving…" : pending?.relaxes ? "Relax setting" : "Save setting"}
            </Button>
          </>
        }
      >
        <p>
          {pending?.from} → {pending?.to}
        </p>
        <p>
          {pending?.relaxes ? (
            <>
              <strong>This is weaker than the strict default.</strong> {spec.relaxed}
            </>
          ) : (
            spec.strict
          )}
        </p>
        <p>The change is audited.{pending?.stepUp ? " It loosens the current value, so you will be asked to confirm it's you." : ""}</p>
      </Modal>
    </form>
  );
}

function SettingControl(props: {
  spec: OrgSettingSpec;
  id: string;
  draft: Draft;
  set: (patch: Partial<Draft>) => void;
  disabled: boolean;
  known: boolean;
  describedBy: string;
}) {
  const { spec, id, draft, set, disabled, known, describedBy } = props;
  const c = spec.control;
  const noneId = useId();
  switch (c.kind) {
    case "enum":
    case "boolean": {
      const options = c.kind === "enum" ? c.options : [{ value: "true", label: c.on }, { value: "false", label: c.off }];
      return (
        <Field label={spec.label}>
          <Select id={id} disabled={disabled} value={draft.text} aria-describedby={describedBy} onChange={(e) => set({ text: e.target.value })}>
            {!known ? <option value="">Unknown: not reported</option> : null}
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </Field>
      );
    }
    case "int":
    case "decimal":
      return (
        <div className={v.row}>
          <Field label={`${spec.label}`}>
            <Input
              id={id}
              type="number"
              inputMode={c.kind === "int" ? "numeric" : "decimal"}
              min={c.min}
              max={c.max}
              step={c.kind === "int" ? 1 : c.step}
              required={!(c.kind === "int" && draft.none)}
              disabled={disabled || (c.kind === "int" && draft.none)}
              placeholder={known ? undefined : "Unknown: not reported"}
              value={draft.text}
              aria-describedby={describedBy}
              onChange={(e) => set({ text: e.target.value })}
            />
          </Field>
          {c.kind === "int" && c.noneLabel ? (
            <label className={v.row} htmlFor={noneId}>
              <input id={noneId} type="checkbox" disabled={disabled} checked={draft.none} onChange={(e) => set({ none: e.target.checked })} />
              <span>{c.noneLabel}</span>
            </label>
          ) : null}
        </div>
      );
    case "set":
      return (
        <Fieldset legend={spec.label}>
          {!known ? <p className={v.faint}>Unknown: not reported</p> : null}
          {c.options.map((o) => {
            const optionId = `${id}-${o.value}`;
            return (
              <label key={o.value} className={v.row} htmlFor={optionId}>
                <input
                  id={optionId}
                  type="checkbox"
                  disabled={disabled}
                  checked={draft.set.includes(o.value)}
                  aria-describedby={describedBy}
                  onChange={(e) => set({ set: e.target.checked ? [...draft.set, o.value] : draft.set.filter((x) => x !== o.value) })}
                />
                <span>{o.label}</span>
              </label>
            );
          })}
        </Fieldset>
      );
    case "modeMap":
      return (
        <Fieldset legend={spec.label}>
          <div className={v.row}>
            {c.modes.map((m) => (
              <Field key={m.value} label={`${m.label} (days, empty = follow the floor)`}>
                <Input
                  id={`${id}-${m.value}`}
                  type="number"
                  inputMode="numeric"
                  min={c.min}
                  step={1}
                  disabled={disabled}
                  value={draft.map[m.value] ?? ""}
                  aria-describedby={describedBy}
                  onChange={(e) => set({ map: { ...draft.map, [m.value]: e.target.value } })}
                />
              </Field>
            ))}
          </div>
        </Fieldset>
      );
  }
}
