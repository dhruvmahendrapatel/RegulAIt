/**
 * ADR-0059 — the blast-radius friction dial (`GET/PUT /v1/policy-simulations/settings`).
 *
 * Strict by default: activating an ABAC policy version that no preview has
 * examined is refused. Turning that off is an audited relaxation, so the form
 * states the consequence in a confirmation and the gateway asks the admin to
 * confirm it is them (a `settings_relax` step-up) before it is written.
 */
import { useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ago } from "../../../api/format";
import { api as stepUpApi, withStepUp } from "../../../stepup/stepUp";
import { Badge, Button, Card, ConfirmModal, Field, Input } from "../../../ui/kit";
import { QueryGate, useAction } from "../adminKit";
import {
  POLICY_SIMULATION_BOUNDS,
  POLICY_SIMULATION_REFUSALS,
  settingsBody,
  settingsFormFrom,
  type PolicySimulationSettingsResponse,
  type SettingsBody,
  type SettingsForm,
} from "./policySimulationModel";
import { withRefusalCopy } from "./refusalCopy";
import a from "../admin.module.css";
import v from "../../views.module.css";

const KEY = ["admin", "policy-simulation-settings"] as const;

export function PolicySimulationSettingsCard() {
  const settings = useQuery({
    queryKey: KEY,
    queryFn: () => stepUpApi.get<PolicySimulationSettingsResponse>("/v1/policy-simulations/settings"),
  });
  return (
    <Card title="Blast-radius settings">
      <QueryGate loading={settings.isLoading} error={settings.error} onRetry={() => void settings.refetch()}>
        {settings.data && !settings.data.settings ? (
          <p className={v.faint}>This gateway does not report the blast-radius settings.</p>
        ) : settings.data ? (
          <SettingsEditor
            key={settings.data.settings.updatedAt ?? "initial"}
            data={settings.data}
            onSaved={() => void settings.refetch()}
          />
        ) : null}
      </QueryGate>
    </Card>
  );
}

function SettingsEditor(props: { data: PolicySimulationSettingsResponse; onSaved: () => void }) {
  const current = props.data.settings;
  const act = useAction();
  const [form, setForm] = useState<SettingsForm>(() => settingsFormFrom(current));
  const [problem, setProblem] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<SettingsBody | null>(null);
  const ids = { note: useId(), window: useId(), cap: useId(), problem: useId() };
  const set = <K extends keyof SettingsForm>(k: K, value: SettingsForm[K]) => {
    setProblem(null);
    setForm((f) => ({ ...f, [k]: value }));
  };

  const save = (body: SettingsBody) =>
    void act
      .run(
        () =>
          withRefusalCopy(
            () => withStepUp((h) => stepUpApi.put("/v1/policy-simulations/settings", body, h)),
            POLICY_SIMULATION_REFUSALS,
          ),
        body.requirePreviewBeforeActivate === false
          ? "Saved — activation no longer requires a preview; every activation still records whether one existed"
          : "Blast-radius settings saved",
      )
      .then((ok) => {
        if (ok) props.onSaved();
      });

  return (
    <form
      aria-label="Blast-radius settings"
      aria-describedby={ids.note}
      className={v.stack}
      onSubmit={(e) => {
        e.preventDefault();
        const built = settingsBody(form, current);
        if (!built.ok) {
          setProblem(built.problem);
          return;
        }
        if (Object.keys(built.body).length === 0) {
          setProblem("Nothing has changed.");
          return;
        }
        if (built.relaxes) setConfirm(built.body);
        else save(built.body);
      }}
    >
      <p className={v.faint} id={ids.note}>
        {props.data.note}
      </p>
      <div className={v.row}>
        <Badge tone={current.requirePreviewBeforeActivate ? "ok" : "warn"}>
          {current.requirePreviewBeforeActivate ? "preview required before activation" : "preview NOT required (relaxed)"}
        </Badge>
        {current.updatedAt ? <span className={v.faint}>last changed {ago(current.updatedAt)}</span> : null}
      </div>
      <label className={v.rowTight}>
        <input
          type="checkbox"
          checked={form.requirePreviewBeforeActivate}
          onChange={(e) => set("requirePreviewBeforeActivate", e.target.checked)}
        />
        <span>Require a blast-radius preview of the exact version before it can be activated (recommended)</span>
      </label>
      <div className={a.formRow}>
        <Field label="Default window (days)">
          <Input
            inputMode="numeric"
            value={form.defaultWindowDays}
            aria-describedby={ids.window}
            onChange={(e) => set("defaultWindowDays", e.target.value)}
          />
        </Field>
        <Field label="Default row cap">
          <Input
            inputMode="numeric"
            value={form.defaultRowCap}
            aria-describedby={ids.cap}
            onChange={(e) => set("defaultRowCap", e.target.value)}
          />
        </Field>
      </div>
      <p className={v.faint}>
        <span id={ids.window}>
          How much recorded history a preview replays when none is given: 1 to {POLICY_SIMULATION_BOUNDS.maxWindowDays} days
          (shipped default {props.data.defaults.windowDays}).
        </span>{" "}
        <span id={ids.cap}>
          The most recorded calls one preview examines: 1 to {POLICY_SIMULATION_BOUNDS.maxRows.toLocaleString("en-US")} (shipped
          default {props.data.defaults.rowCap.toLocaleString("en-US")}). A capped preview reports a lower bound.
        </span>
      </p>
      <div className={v.row}>
        <Button type="submit" variant="primary" disabled={act.busy} aria-describedby={problem ? ids.problem : undefined}>
          Save settings
        </Button>
      </div>
      {problem && (
        <p className={v.errLine} role="alert" id={ids.problem}>
          {problem}
        </p>
      )}
      {act.error && (
        <p className={v.errLine} role="alert">
          {act.error}
        </p>
      )}
      <ConfirmModal
        open={confirm !== null}
        danger
        title="Stop requiring a preview before activation?"
        confirmLabel="Turn off the requirement"
        body={
          <p>
            A policy version can then be activated without anyone having checked whose calls it newly blocks. Each such
            activation is still recorded as un-previewed in the audit log. You will be asked to confirm it is you.
          </p>
        }
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          const body = confirm;
          setConfirm(null);
          if (body) save(body);
        }}
      />
    </form>
  );
}
