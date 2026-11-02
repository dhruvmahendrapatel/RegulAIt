/**
 * ADR-0189 §7 / §10 / B6: the BOM rows of the Enforcement posture page.
 *
 *  - The receipt signing key, as `GET /v1/org/posture` reports it
 *    (`receiptSigningKey`: install_generated, operator_managed, missing or
 *    invalid). With no usable key every sign-off is refused and no BOM can be
 *    signed, so the page says "Decision BOM: unavailable" rather than
 *    letting the settings below read as if they were working (§10).
 *  - The nine BOM settings, each at its strict default unless an admin
 *    relaxed it. A change goes through `PUT /v1/org/settings` (audited old →
 *    new); a relaxation needs a `settings_relax` step-up, which `putOrgSettings`
 *    prompts for. After a write the form stays locked until the current values
 *    are read back (`useSettleAfterWrite`), so it never writes from a stale
 *    baseline.
 *
 * The copy mirrors `BOM_SETTING_COPY` in @regulait/shared (pinned by
 * BomPostureCard.test.ts); this page invents no sentence about what a setting does.
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../../api/client";
import type { OrgSettingsResponse } from "../../../api/adminTypes";
import { fmtAt } from "../../../api/format";
import { api as stepUpApi, putOrgSettings, withStepUp } from "../../../stepup/stepUp";
import { Badge, Button, Card, ConfirmModal, Field, Input, Modal, Select, Table } from "../../../ui/kit";
import { adminKeys, orgSettingsQuery, QueryGate, StaleAfterWrite, useAction, useSettleAfterWrite, useSingleFlight } from "../adminKit";
import { parseReceiptKeys, receiptKeyRefusal, retireGate, type RecordedReceiptKey } from "./receiptKeysModel";
import v from "../../views.module.css";

export interface ReceiptSigningKeyPosture {
  state: "install_generated" | "operator_managed" | "missing" | "invalid";
  keyId: string | null;
  publicKeyFingerprint: string | null;
  publicKeys: string;
  note: string;
}

type Strict = string | number | readonly string[];
interface BomSetting {
  key: string;
  label: string;
  strictDefault: Strict;
  options?: readonly string[];
  strict: string;
  relaxed: string;
}

/** `BOM_STRICT_DEFAULTS` and `BOM_SETTING_COPY` (packages/shared/src/bom/settings.ts), mirrored */
export const BOM_POSTURE_SETTINGS: readonly BomSetting[] = [
  {
    key: "decisionFactsCapture",
    label: "Decision BOM facts",
    strictDefault: "on",
    options: ["on", "off"],
    strict: "On: every governed decision records the versions, digests and classifications behind it, in its own transaction.",
    relaxed: "Off: decisions made while off have no recorded facts, and their Decision BOM sections say not recorded forever. The posture page shows \"Decision BOM: not captured\".",
  },
  {
    key: "decisionBomFinality",
    label: "When a Decision BOM is final",
    strictDefault: "anchored",
    options: ["anchored", "anchored_unverified_destination", "chain_signed"],
    strict:
      "Anchored: only once the decision is covered by an audit anchor written to storage observed as tamper-resistant, timestamped when timestamps are required, with a lock that covers the retention period.",
    relaxed: "Unverified destination freezes on any flushed anchor (the BOM says the destination was not observed tamper-resistant); chain signed freezes before any anchor exists.",
  },
  {
    key: "bomExportRoles",
    label: "Who may export BOMs",
    strictDefault: "admins_only",
    options: ["admins_only", "admins_and_auditors"],
    strict: "Admins only.",
    relaxed: "Admins and people an admin has given an explicit auditor grant; every grant and export is audited.",
  },
  {
    key: "bomPersonIdentifiers",
    label: "People in AI BOMs",
    strictDefault: "id_only",
    options: ["id_only", "display_name"],
    strict: "Ids only. A Decision BOM is always ids only.",
    relaxed: "AI BOMs may carry the display names read when the snapshot was taken. Email addresses are never included.",
  },
  {
    key: "aiBomSnapshotTriggers",
    label: "Automatic AI BOM snapshots",
    strictDefault: "sign_off_events",
    options: ["sign_off_events", "on_demand_only"],
    strict: "Sign-off events: each approval, promotion, admission and evidence attachment takes a signed snapshot of what was signed off, after it commits.",
    relaxed: "Snapshots are taken only on demand, so a sign-off can pass with no record of what was signed off.",
  },
  {
    key: "aiBomSnapshotWithoutKey",
    label: "Sign-off with no signing key",
    strictDefault: "refuse",
    options: ["refuse", "skip_and_record"],
    strict: "Refuse: an approval or promotion that would take a snapshot is refused while no receipt signing key is configured, and nothing it would have changed is saved.",
    relaxed: "Skip and record: it proceeds, and an audited gap records that no snapshot was taken. No snapshot is taken later.",
  },
  {
    key: "cyclonedxExportVersions",
    label: "CycloneDX export versions",
    strictDefault: ["1.7"],
    options: ["1.7", "1.7,1.6"],
    strict: "1.7 only.",
    relaxed: "Adding 1.6 also renders the previous version for consumers that do not read 1.7 yet.",
  },
  {
    key: "bomExportRateLimitPerMinute",
    label: "BOM exports per minute, per person",
    strictDefault: 30,
    strict: "30 a minute.",
    relaxed: "A higher limit (up to 600) lets one person pull evidence in bulk faster.",
  },
  {
    key: "decisionBomFiniteLockFinality",
    label: "Decision BOMs when audit retention has no end",
    strictDefault: "refuse",
    options: ["refuse", "accept"],
    strict: "Refuse: with no audit retention period, no time-limited lock can cover the evidence, so such a Decision BOM stays pending.",
    relaxed: "Accept: it becomes final when its anchor is locked until a future date; after that date the verifier reports the anchor lock as lapsed.",
  },
];

type BomValue = string | number | string[];

/** a form value as the setting's stored type, or null when the gateway would refuse it */
export function bomPostureValue(setting: BomSetting, input: string): BomValue | null {
  if (setting.key === "bomExportRateLimitPerMinute") {
    if (!/^[0-9]{1,3}$/.test(input)) return null;
    const n = Number(input);
    return n >= 1 && n <= 600 ? n : null;
  }
  if (setting.key === "cyclonedxExportVersions") {
    const parts = input.split(",");
    if (!parts.includes("1.7") || new Set(parts).size !== parts.length || parts.some((p) => p !== "1.7" && p !== "1.6")) return null;
    return ["1.7", "1.6"].filter((p) => parts.includes(p));
  }
  return setting.options?.includes(input) ? input : null;
}

/** the stored value, checked for its type; null (unknown) rather than a guessed strict default */
export function bomStoredValue(setting: BomSetting, value: unknown): BomValue | null {
  if (setting.key === "cyclonedxExportVersions") return Array.isArray(value) && value.every((x) => typeof x === "string") ? bomPostureValue(setting, value.join(",")) : null;
  if (setting.key === "bomExportRateLimitPerMinute") return typeof value === "number" ? bomPostureValue(setting, String(value)) : null;
  return typeof value === "string" ? bomPostureValue(setting, value) : null;
}

const text = (value: BomValue | Strict) => (Array.isArray(value) ? value.join(",") : String(value));

/** `bomSettingRelaxed` (shared), mirrored: is this value looser than the strict default? */
export function bomRelaxed(setting: BomSetting, value: BomValue): boolean {
  if (setting.key === "cyclonedxExportVersions") return Array.isArray(value) && value.some((x) => x !== "1.7");
  if (setting.key === "bomExportRateLimitPerMinute") return typeof value === "number" && value > 30;
  return value !== setting.strictDefault;
}

const FINALITY_RANK: Record<string, number> = { anchored: 3, anchored_unverified_destination: 2, chain_signed: 1 };
/**
 * `bomSettingLooser` (shared), mirrored: is `value` looser than the value stored NOW? This is what the gateway's
 * `settings_relax` step-up is judged on (ADR-0186 decision 26), so it decides whether the dialog says a step-up follows.
 */
export function bomLooserThanStored(setting: BomSetting, value: BomValue, stored: BomValue): boolean {
  switch (setting.key) {
    case "decisionBomFinality":
      return (FINALITY_RANK[String(value)] ?? 0) < (FINALITY_RANK[String(stored)] ?? 0);
    case "cyclonedxExportVersions": {
      const before = new Set(Array.isArray(stored) ? stored.map(String) : []);
      return Array.isArray(value) && value.some((x) => !before.has(String(x)));
    }
    case "bomExportRateLimitPerMinute":
      return typeof value === "number" && typeof stored === "number" && value > stored;
    default:
      return value !== stored && value !== setting.strictDefault;
  }
}

/** a successful write is not a fresh baseline until the follow-up read succeeds */
export async function saveBomPostureAndReload(body: Record<string, unknown>, write: (body: Record<string, unknown>) => Promise<unknown>, settle: () => Promise<boolean>): Promise<boolean> {
  await write(body);
  return settle();
}

const KEY_STATE: Record<ReceiptSigningKeyPosture["state"], { tone: "ok" | "danger"; label: string }> = {
  install_generated: { tone: "ok", label: "install-generated" },
  operator_managed: { tone: "ok", label: "operator-managed" },
  missing: { tone: "danger", label: "missing" },
  invalid: { tone: "danger", label: "invalid" },
};

/** whether the receipt key can sign: null when the gateway does not report it (unknown) */
export function receiptKeyUsable(posture: ReceiptSigningKeyPosture | undefined): boolean | null {
  if (!posture || !(posture.state in KEY_STATE)) return null;
  return posture.state === "install_generated" || posture.state === "operator_managed";
}

export function ReceiptKeyRow({ posture }: { posture: ReceiptSigningKeyPosture | undefined }) {
  if (!posture || !(posture.state in KEY_STATE)) {
    return <p role="status">This gateway does not report its receipt signing key, so whether BOMs can be signed is unknown.</p>;
  }
  const s = KEY_STATE[posture.state];
  const usable = posture.state === "install_generated" || posture.state === "operator_managed";
  return (
    <div className={v.stack} data-testid="receipt-key-posture">
      <div className={v.row}>
        <span>Receipt signing key:</span>
        <Badge tone={s.tone}>{s.label}</Badge>
        {usable ? (
          <span className={v.faint}>
            key <code className={v.mono}>{posture.keyId}</code> · <code className={v.mono}>{posture.publicKeyFingerprint}</code>
          </span>
        ) : (
          <Badge tone="danger">Decision BOM: unavailable (no signing key)</Badge>
        )}
      </div>
      <p className={v.faint}>{posture.note}</p>
      {!usable && (
        <p role="alert">
          Every sign-off that would take an AI BOM snapshot is refused, and no Decision BOM or AI BOM snapshot can be signed, until a usable key is
          configured. This is set by the deployment, not on this page.
        </p>
      )}
    </div>
  );
}

const receiptKeysQueryKey = ["admin", "receipt-keys"] as const;
/** the recorded receipt keys; shared with the posture page's tab label, so both read one cache entry */
export const receiptKeysQuery = () => ({ queryKey: receiptKeysQueryKey, retry: false, queryFn: () => api.get<unknown>("/v1/receipts/keys") });

/**
 * Every receipt signing key the deployment has recorded, with a RETIRE action (admin, step-up, audited by the
 * gateway). A retired key never signs again; receipts it signed keep verifying under its recorded public key.
 * The key this gateway signs with now, and the last active key, cannot be retired; the row says why.
 */
export function ReceiptKeysTable({ inUseKeyId }: { inUseKeyId: string | null }) {
  const qc = useQueryClient();
  const keys = useQuery(receiptKeysQuery());
  const act = useAction();
  const [pending, setPending] = useState<RecordedReceiptKey | null>(null);
  const parsed = keys.data === undefined ? undefined : parseReceiptKeys(keys.data);
  const retire = (keyId: string) =>
    act.run(async () => {
      try {
        await withStepUp((h) => stepUpApi.post(`/v1/receipts/keys/${encodeURIComponent(keyId)}/retire`, {}, h));
      } catch (e) {
        const text = receiptKeyRefusal(e);
        throw text ? new Error(text) : e;
      } finally {
        await qc.invalidateQueries({ queryKey: receiptKeysQueryKey });
      }
    }, `Receipt signing key ${keyId} retired`);
  return (
    <div className={v.stack} data-testid="receipt-keys">
      <p>
        <strong>Recorded receipt signing keys</strong>
      </p>
      <p className={v.faint}>
        Retiring a key stops anything signing with it again. Its public key stays recorded, so receipts and BOMs it signed keep verifying.
        Retiring is audited and asks you to confirm it&rsquo;s you.
      </p>
      {parsed === null ? (
        <p role="status">This gateway did not report its recorded receipt keys, so none can be retired here.</p>
      ) : (
        <Table<RecordedReceiptKey>
          rows={parsed}
          rowKey={(k) => k.keyId}
          loading={keys.isLoading}
          error={keys.error}
          onRetry={() => void keys.refetch()}
          empty="No receipt signing key is recorded yet. A key is recorded when it first signs."
          columns={[
            { key: "keyId", header: "Key", render: (k) => <code className={v.mono}>{k.keyId}</code> },
            { key: "firstUsedAt", header: "First signed", render: (k) => (k.firstUsedAt ? fmtAt(k.firstUsedAt) : "Not yet") },
            {
              key: "state",
              header: "State",
              render: (k) =>
                k.retiredAt ? (
                  <Badge tone="neutral">retired {fmtAt(k.retiredAt)}</Badge>
                ) : k.keyId === inUseKeyId ? (
                  <Badge tone="ok">active, signing now</Badge>
                ) : (
                  <Badge tone="ok">active</Badge>
                ),
            },
            {
              key: "retire",
              header: "Retire",
              render: (k) => {
                const gate = retireGate(k, parsed ?? [], inUseKeyId);
                if (k.retiredAt) return <span className={v.faint}>Retired</span>;
                return gate.ok ? (
                  <Button size="sm" variant="danger" disabled={act.busy} aria-label={`Retire receipt signing key ${k.keyId}`} onClick={() => setPending(k)}>
                    Retire
                  </Button>
                ) : (
                  <span className={v.faint}>{gate.reason}</span>
                );
              },
            },
          ]}
        />
      )}
      {act.error && (
        <p className={v.errLine} role="alert">
          {act.error}
        </p>
      )}
      <ConfirmModal
        open={pending !== null}
        title={`Retire receipt signing key ${pending?.keyId ?? ""}?`}
        confirmLabel="Retire key"
        danger
        body={
          <>
            <p>Nothing signs with this key again, on any gateway. Receipts and BOMs it already signed keep verifying under its recorded public key.</p>
            <p>This cannot be undone. It is audited, and you will be asked to confirm it&rsquo;s you.</p>
          </>
        }
        onCancel={() => setPending(null)}
        onConfirm={() => {
          const k = pending;
          setPending(null);
          if (k) void retire(k.keyId);
        }}
      />
    </div>
  );
}

export function BomPostureCard({ receiptKey }: { receiptKey: ReceiptSigningKeyPosture | undefined }) {
  const settings = useQuery(orgSettingsQuery<OrgSettingsResponse>());
  const baseline = useSettleAfterWrite(adminKeys.orgSettings);
  const flight = useSingleFlight();
  const save = async (body: Record<string, unknown>) => {
    if (baseline.stale || !flight.enter()) throw new Error("The settings are locked until their current values are reloaded.");
    try {
      if (!(await saveBomPostureAndReload(body, putOrgSettings, baseline.settle))) {
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
  const stored = settings.data?.settings && typeof settings.data.settings === "object" ? settings.data.settings : null;
  const factsOff = stored?.decisionFactsCapture === "off";
  return (
    <Card title="BOM evidence">
      <div className={v.stack} data-testid="bom-posture">
        <ReceiptKeyRow posture={receiptKey} />
        <ReceiptKeysTable inUseKeyId={receiptKey && (receiptKey.state === "install_generated" || receiptKey.state === "operator_managed") ? receiptKey.keyId : null} />
        {factsOff && (
          <p role="status">
            <Badge tone="warn">Decision BOM: not captured</Badge> Decision fact capture is off; decisions made now will say &ldquo;not recorded&rdquo; forever.
          </p>
        )}
        <p className={v.faint}>
          Each setting ships strict. Changing one is audited (old → new); loosening one asks you to confirm it&rsquo;s you.
        </p>
        <QueryGate loading={settings.isLoading} error={settings.error} onRetry={() => void settings.refetch()}>
          {stored ? (
            BOM_POSTURE_SETTINGS.map((setting) => (
              <BomSettingRow
                key={`${setting.key}:${JSON.stringify(stored[setting.key])}`}
                setting={setting}
                current={stored[setting.key]}
                locked={baseline.stale || flight.busy}
                onSave={save}
              />
            ))
          ) : settings.data ? (
            <p role="status">This gateway did not report its settings, so the BOM settings are unknown and cannot be changed here.</p>
          ) : null}
        </QueryGate>
        {baseline.stale ? <StaleAfterWrite onRetry={() => void retry()} /> : null}
      </div>
    </Card>
  );
}

function BomSettingRow({ setting, current, locked, onSave }: { setting: BomSetting; current: unknown; locked: boolean; onSave: (body: Record<string, unknown>) => Promise<void> }) {
  const act = useAction();
  const stored = bomStoredValue(setting, current);
  const [draft, setDraft] = useState(stored === null ? "" : text(stored));
  const [pending, setPending] = useState<{ body: Record<string, unknown>; from: string; to: string; relaxes: boolean; stepUp: boolean } | null>(null);
  const parsed = bomPostureValue(setting, draft);
  const disabled = locked || stored === null || act.busy || pending !== null;
  const unchanged = parsed !== null && stored !== null && text(parsed) === text(stored);
  const inputId = `bom-setting-${setting.key}`;
  return (
    <form
      className={v.stack}
      data-testid={inputId}
      onSubmit={(event) => {
        event.preventDefault();
        if (disabled || parsed === null || stored === null || unchanged) return;
        setPending({ body: { [setting.key]: parsed }, from: text(stored), to: text(parsed), relaxes: bomRelaxed(setting, parsed), stepUp: bomLooserThanStored(setting, parsed, stored) });
      }}
    >
      <Field label={setting.label}>
        {setting.options ? (
          <Select id={inputId} disabled={disabled} value={draft} onChange={(e) => setDraft(e.target.value)}>
            {stored === null ? <option value="">Unknown: not reported</option> : null}
            {setting.options.map((o) => (
              <option key={o} value={o}>
                {o.replace(/_/g, " ")}
              </option>
            ))}
          </Select>
        ) : (
          <Input id={inputId} type="number" min={1} max={600} step={1} required disabled={disabled} value={draft} onChange={(e) => setDraft(e.target.value)} />
        )}
      </Field>
      <div className={v.row}>
        {stored === null ? (
          <Badge tone="warn">unknown</Badge>
        ) : bomRelaxed(setting, stored) ? (
          <Badge tone="warn">relaxed (audited)</Badge>
        ) : (
          <Badge tone="ok">strict</Badge>
        )}
        <span className={v.faint}>
          Current: {stored === null ? "not reported" : text(stored)} · strict default: {text(setting.strictDefault)}
        </span>
        <Button type="submit" size="sm" disabled={disabled || parsed === null || unchanged}>
          Review change
        </Button>
      </div>
      <p className={v.faint}>
        {setting.strict} {setting.relaxed}
      </p>
      {act.error && (
        <p className={v.errLine} role="alert">
          {act.error}
        </p>
      )}
      <Modal
        open={pending !== null}
        title={`Change ${setting.label.toLowerCase()}?`}
        onClose={() => {
          if (!act.busy) setPending(null);
        }}
        actions={
          <>
            <Button disabled={act.busy} onClick={() => setPending(null)}>
              Cancel
            </Button>
            <Button
              disabled={act.busy || locked}
              onClick={() => {
                if (!pending) return;
                void act.run(() => onSave(pending.body), "BOM setting saved").finally(() => setPending(null));
              }}
            >
              {act.busy ? "Saving…" : "Save setting"}
            </Button>
          </>
        }
      >
        <p>
          {pending?.from} → {pending?.to}
        </p>
        <p>{pending?.relaxes ? setting.relaxed : setting.strict}</p>
        <p>The change is audited.{pending?.stepUp ? " It loosens the current value, so you will be asked to confirm it's you." : ""}</p>
      </Modal>
    </form>
  );
}
