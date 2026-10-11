/**
 * ADR-0190 decision 11: the isolation org settings, on the published
 * `GET`/`PUT /v1/org/settings`.
 *
 *  - Enforcement is fixed: `enforce` is its only value (owner decision A). It
 *    is shown, never sent. To run where a class is unavailable, an admin lowers
 *    a floor instead (each relaxation audited, with a step-up).
 *  - Unknown input stays unmeasured: a missing or malformed envelope, or any of
 *    the eight values missing or out of range, makes the whole card read-only.
 *    Nothing is filled in from the strict defaults.
 *  - Only edited fields are sent, re-derived against the values stored at
 *    save time. A relaxation is confirmed first and goes through `withStepUp`
 *    (`putOrgSettings`), so the gateway's `settings_relax` step-up is asked for.
 *  - If the read after a write fails, the form locks (`StaleAfterWrite`).
 */
import { useId, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../../api/client";
import { putOrgSettings } from "../../../../stepup/stepUp";
import { Badge, Button, Card, ConfirmModal, Field, Input, Select } from "../../../../ui/kit";
import { QueryGate, reconfirmNeeded, StaleAfterWrite, useAction, useSettleAfterWrite, useSingleFlight } from "../../adminKit";
import {
  CLASSES,
  CLASS_LABEL,
  draftFrom,
  EDITABLE_KEYS,
  LIFETIME_LIMITS,
  SETTING_DEFAULTS,
  SETTING_LABEL,
  settingChanges,
  settingRelaxed,
  settingsComplete,
  settingsFromEnvelope,
  type EditableKey,
  type SettingsDraft,
} from "./isolationModel";
import v from "../../../views.module.css";

/** the same key and raw envelope as the other org-settings readers */
const ORG_SETTINGS_KEY = ["admin", "org-settings"] as const;

/** the values stored now; null when they cannot be read or are incomplete */
async function readStored(): Promise<Record<string, unknown> | null> {
  try {
    const settings = settingsFromEnvelope(await api.get<unknown>("/v1/org/settings"));
    return settingsComplete(settings) ? settings : null;
  } catch {
    return null;
  }
}

export function IsolationSettingsCard() {
  const q = useQuery({ queryKey: ORG_SETTINGS_KEY, queryFn: () => api.get<unknown>("/v1/org/settings") });
  const loaded = q.data !== undefined;
  const settings = loaded ? settingsFromEnvelope(q.data) : null;
  const complete = settingsComplete(settings);
  return (
    <Card title="Isolation settings">
      <QueryGate loading={q.isLoading} error={loaded ? null : q.error} onRetry={() => void q.refetch()}>
        {loaded && q.isError && (
          <p role="alert">The current settings could not be reloaded. The last loaded values are shown.</p>
        )}
        {loaded && <IsolationSettingsForm key={complete ? JSON.stringify(EDITABLE_KEYS.map((k) => settings[k])) : "unmeasured"} settings={complete ? settings : null} />}
      </QueryGate>
    </Card>
  );
}

const defaultText = (key: EditableKey) =>
  key === "executorAttestationMaxAgeMinutes" ? `${SETTING_DEFAULTS[key]} minutes` : CLASS_LABEL[SETTING_DEFAULTS[key]];

function IsolationSettingsForm({ settings }: { settings: Record<string, unknown> | null }) {
  const act = useAction();
  const flight = useSingleFlight();
  const baseline = useSettleAfterWrite(ORG_SETTINGS_KEY);
  const [draft, setDraft] = useState<SettingsDraft>(() => draftFrom(settings ?? {}));
  const confirming = useRef(false);
  const [pending, setPending] = useState<{ intent: SettingsDraft; relaxed: string[]; changed: boolean; current: Record<string, unknown> } | null>(null);
  const unavailable = settings === null;
  const unmeasuredId = useId();
  /** while unmeasured, every disabled control is described by the reason it is disabled */
  const describedBy = unavailable ? unmeasuredId : undefined;

  const write = async (body: Record<string, unknown>) => {
    if (await act.run(() => putOrgSettings(body), "Isolation settings saved")) await baseline.settle();
  };

  const submit = async () => {
    if (!settings || baseline.stale || !flight.enter()) return;
    let keep = false;
    try {
      const current = await readStored();
      if (!current) return act.setError("The current isolation settings could not be read. Nothing was saved.");
      const change = settingChanges(settings, draft, current);
      if ("error" in change) return act.setError(change.error);
      if (!Object.keys(change.body).length) return act.setError("No isolation setting changed.");
      if (change.relaxed.length) {
        keep = true;
        setPending({ intent: { ...draft }, relaxed: change.relaxed, changed: false, current });
        return;
      }
      await write(change.body);
    } finally {
      if (!keep) flight.leave();
    }
  };

  const confirm = async () => {
    if (confirming.current || !settings) return;
    confirming.current = true;
    const intent = pending;
    setPending(null);
    let keep = false;
    try {
      if (!intent) return;
      const current = await readStored();
      if (!current) return act.setError("The current isolation settings could not be read. Nothing was saved.");
      const change = settingChanges(settings, intent.intent, current);
      if ("error" in change) return act.setError(change.error);
      if (!Object.keys(change.body).length) return act.setError("The stored settings already match. Nothing was saved.");
      // anything newly relaxed, or a stored value under this change that moved, is shown again before it is sent
      const moved = Object.keys(change.body).some((key) => current[key] !== intent.current[key]);
      if (moved || reconfirmNeeded(intent.relaxed, { adds: change.relaxed.length > 0, added: change.relaxed })) {
        keep = true;
        setPending({ ...intent, relaxed: change.relaxed, changed: true, current });
        return;
      }
      await write(change.body);
    } finally {
      confirming.current = false;
      if (!keep) flight.leave();
    }
  };

  const busy = act.busy || flight.busy || baseline.stale;
  const locked = busy || unavailable;
  return (
    <form
      className={v.stack}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <p className={v.dim}>
        The strict defaults require an L2 user-space kernel sandbox for public, internal and confidential projects, local (stdio) MCP
        servers and engine workers, an L3 microVM sandbox for regulated projects, and a passing executor self-test no older than two
        hours. A floor never goes below an L1 hardened container. Each relaxation asks you to confirm it is you and is audited. A saved
        setting is policy; it does not show that any workload ran under it.
      </p>
      <p>
        <strong>{SETTING_LABEL.isolationEnforcement}:</strong>{" "}
        {unavailable ? (
          <Badge tone="neutral">Not reported</Badge>
        ) : (
          <>
            <Badge tone="ok">Always on</Badge> <span className={v.dim}>Not relaxable. A call is never placed below its required isolation; to run where a class is unavailable, lower a floor below.</span>
          </>
        )}
      </p>
      {unavailable && (
        <p role="status" id={unmeasuredId}>
          Isolation settings are unmeasured: the gateway has not reported all eight values. Editing is unavailable, and no value is
          filled in from the defaults.
        </p>
      )}
      <div className={v.grid3}>
        {EDITABLE_KEYS.map((key) => {
          const stored = settings?.[key];
          const relaxed = settings !== null && settingRelaxed(key, stored as string | number, SETTING_DEFAULTS[key]);
          return (
            <div key={key} className={v.stackTight}>
              <Field label={SETTING_LABEL[key]}>
                {key === "executorAttestationMaxAgeMinutes" ? (
                  <Input
                    type="number"
                    inputMode="numeric"
                    min={LIFETIME_LIMITS.min}
                    max={LIFETIME_LIMITS.max}
                    step={1}
                    required
                    value={draft[key]}
                    disabled={locked}
                    aria-describedby={describedBy}
                    onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
                  />
                ) : (
                  <Select value={draft[key]} disabled={locked} aria-describedby={describedBy} onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}>
                    {!draft[key] && <option value="">Not reported</option>}
                    {CLASSES.map((c) => (
                      <option key={c} value={c}>
                        {CLASS_LABEL[c]}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <span className={v.faint}>Strict default: {defaultText(key)}</span>
              {settings !== null && <Badge tone={relaxed ? "warn" : "neutral"}>{relaxed ? "Relaxed · audited" : "At least as strict as the default"}</Badge>}
            </div>
          );
        })}
      </div>
      <p className={v.dim}>
        A lower floor lets those calls run with weaker isolation, and the evidence records the class each call actually ran under. A
        longer attestation lifetime (up to 24 hours) lets a host that drifted keep serving longer before it is caught.
      </p>
      <div>
        <Button type="submit" variant="primary" disabled={locked} aria-describedby={describedBy}>
          Save isolation settings
        </Button>
      </div>
      {act.error && <p role="alert">{act.error}</p>}
      {baseline.stale && <StaleAfterWrite onRetry={() => void baseline.settle()} />}
      <ConfirmModal
        open={pending !== null}
        title="Relax isolation controls?"
        confirmLabel="Save audited relaxation"
        onCancel={() => {
          setPending(null);
          flight.leave();
        }}
        onConfirm={() => void confirm()}
        body={
          <div className={v.stackTight}>
            {pending?.changed && <p>The stored settings changed while this was open. Review the relaxation again.</p>}
            <ul>
              {pending?.relaxed.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
            <p>
              These changes allow weaker isolation or older executor reports. The gateway asks you to confirm it is you and records the
              change in its audit log.
            </p>
          </div>
        }
      />
    </form>
  );
}

