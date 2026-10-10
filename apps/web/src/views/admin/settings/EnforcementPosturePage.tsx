/**
 * Enforcement posture (ADR-0118).
 *
 * NOT the ADR-0082 "Posture" one-pager under Governance, and deliberately not
 * merged into it. That page is a BOARD-SHAPED READ of measured outcomes —
 * pack coverage, open risks, red-team ASR, spend — computed from the ledgers
 * and changing nothing. This page is the OPERATOR'S CONFIGURATION read: which
 * gates are switched on, and a button that switches them on. Putting a control
 * that starts refusing live traffic on a page somebody prints for a meeting
 * would be a bad idea on its own merits, hence Settings and a distinct route.
 *
 * This page exists for the same reason the scheduled-jobs page does: a fact
 * that decides everything was documented in ADRs and visible on no screen.
 * Until ADR-0181 every control this product is sold on shipped OFF, and the
 * consequence was that nobody could answer "so what is enforcing right now?"
 * without reading the schema. Since ADR-0181 every enforcement control ships
 * at its strict value (except the WORM audit anchor, which needs a bucket only
 * the operator can supply); an admin may relax one, the relaxation is audited,
 * and this page is where that relaxed state stays visible.
 *
 * THE READ IS THE POINT, NOT THE BUTTON. The column that earns this page its
 * place is "what turning it on would refuse". A posture screen that lists
 * switches without their blast radius invites an admin to harden a live
 * deployment on a Friday afternoon, and the API deliberately returns that
 * sentence per control so the UI never has to invent one.
 *
 * Three honesty rules the UI keeps rather than leaving to the ADR:
 *
 *  - The environment-backed controls (the WORM audit anchor, the scheduler,
 *    database TLS) render as NOT SETTABLE with their OBSERVED state, never as a
 *    switch. An API call cannot set an environment variable, and a button that
 *    implied otherwise would be a lie with a cursor on it.
 *  - The overall verdict stays "not hardened" while those two are unmet even
 *    when every settable control is satisfied — so the headline can read
 *    "5 of 7" and mean it.
 *  - Optimisation is shown as its own group and is NOT included in the default
 *    harden action. An admin hardening a regulated deployment is not thereby
 *    asking to serve more answers from cache.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../../../api/client";
import { putOrgSettings } from "../../../stepup/stepUp";
import type { OrgSettingsResponse } from "../../../api/adminTypes";
import { PageHeader } from "../../../shell/AppShell";
import { Badge, Button, Card, EmptyState, Field, Input, Modal, Select, Table } from "../../../ui/kit";
import { QueryGate, Stat, StaleAfterWrite, useAction, useSettleAfterWrite, useSingleFlight } from "../adminKit";
import a from "../admin.module.css";
import v from "../../views.module.css";

interface PostureControl {
  key: string;
  group: "enforcement" | "optimisation";
  current: unknown;
  hardened: unknown;
  satisfied: boolean;
  settable: boolean;
  refuses: string;
}

interface PostureReport {
  hardened: boolean;
  summary: {
    enforcementSatisfied: number;
    enforcementTotal: number;
    optimisationSatisfied: number;
    optimisationTotal: number;
    blockedByEnvironment: string[];
  };
  controls: PostureControl[];
  /** ADR-0124 — what is STOPPED right now, as opposed to what is enforcing */
  execution: {
    mode: string;
    reason: string | null;
    setAt: string | null;
    restricted: boolean;
    note: string;
  };
}

/**
 * Values arrive as booleans, strings, or the anchor control's small object.
 * Render them readably without pretending an object is a word — the anchor's
 * observed grade is two facts (where it writes, and whether that medium is
 * tamper-resistant) and collapsing them to one would lose the one that matters.
 */
function renderValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "on" : "off";
  if (typeof value === "string") return value;
  if (typeof value === "object") {
    const o = value as Record<string, unknown>;
    if ("tamperResistant" in o) {
      return `${String(o.destination ?? "?")} · tamper-resistant: ${o.tamperResistant ? "yes" : "no"}`;
    }
  }
  return JSON.stringify(value);
}

export default function EnforcementPosturePage() {
  const act = useAction();
  const posture = useQuery({
    queryKey: ["admin", "posture"],
    queryFn: () => api.get<PostureReport>("/v1/org/posture"),
  });

  const report = posture.data;
  const controls = report?.controls ?? [];
  const enforcement = controls.filter((c) => c.group === "enforcement");
  const optimisation = controls.filter((c) => c.group === "optimisation");
  const blocked = report?.summary.blockedByEnvironment ?? [];
  // ADR-0181: the database hop's TLS posture (environment-backed, never a switch)
  const dbTls = controls.find((c) => c.key === "databaseTls")?.current as string | undefined;

  const harden = () =>
    void act.run(async () => {
      await api.post("/v1/org/posture/harden", { groups: ["enforcement"] });
      await posture.refetch();
    }, "Enforcement controls hardened");

  const columns = (refusesHeader: string) => [
    {
      key: "control",
      header: "Control",
      render: (c: PostureControl) => (
        <span className={v.row}>
          <span className={v.mono}>{c.key}</span>
          {!c.settable && <Badge tone="neutral">set by deployment</Badge>}
        </span>
      ),
    },
    { key: "current", header: "Current", render: (c: PostureControl) => renderValue(c.current) },
    { key: "hardened", header: "Hardened", render: (c: PostureControl) => renderValue(c.hardened) },
    {
      key: "state",
      header: "State",
      render: (c: PostureControl) =>
        c.satisfied ? (
          <Badge tone="ok">enforcing</Badge>
        ) : c.settable ? (
          <Badge tone="warn">not enforcing</Badge>
        ) : (
          /* An environment-backed control is not a switch somebody forgot to
             flip — it is a property of the install. */
          <Badge tone="info">needs a deployment change</Badge>
        ),
    },
    {
      key: "refuses",
      header: refusesHeader,
      render: (c: PostureControl) => <span className={v.faint}>{c.refuses}</span>,
    },
  ];

  return (
    <>
      <PageHeader
        title="Enforcement posture"
        sub="What is enforcing in this deployment right now. Every enforcement control below ships strict (ADR-0181); a relaxed one is an audited admin decision."
        info={<p>What is enforcing in this deployment right now — and, per control, what turning it on would start refusing. Since ADR-0181 every enforcement control below ships at its strict value, except the WORM audit anchor, which needs a bucket only the operator can supply. An admin may relax a settable control, and that relaxation is audited old → new, so a relaxed posture is always a decision somebody took deliberately rather than one the deployment arrived with. The environment-backed rows (database TLS, the scheduler, the audit anchor) are set by the operator, not here. The optimisation group (the semantic cache) ships off: it changes answers, and turning it on is a cost decision.</p>}
      />
      <div className={v.stack}>
        <QueryGate
          loading={posture.isLoading}
          error={posture.error}
          onRetry={() => void posture.refetch()}
        >
          <Card title="This deployment">
            <div className={a.statRow}>
              <Stat
                value={
                  <Badge tone={report?.hardened ? "ok" : "warn"}>
                    {report?.hardened ? "hardened" : "not hardened"}
                  </Badge>
                }
                label="overall"
              />
              <Stat
                value={
                  <Badge tone={report?.execution.restricted ? "danger" : "ok"}>
                    {report?.execution.mode.replace("_", "-") ?? "—"}
                  </Badge>
                }
                label="execution"
              />
              <Stat
                value={
                  <Badge tone={dbTls === "required" ? "ok" : "danger"}>{dbTls ?? "—"}</Badge>
                }
                label="database TLS"
              />
              <Stat
                value={`${report?.summary.enforcementSatisfied ?? 0} of ${report?.summary.enforcementTotal ?? 0}`}
                label="enforcement controls on"
              />
              <Stat
                value={`${report?.summary.optimisationSatisfied ?? 0} of ${report?.summary.optimisationTotal ?? 0}`}
                label="optimisation controls on"
              />
            </div>

            {/*
              ADR-0124 — THE FIRST THING ON THE PAGE WHEN IT IS TRUE.
              An operator opening this screen mid-incident needs "execution is
              stopped" before anything else, and the reason beside it. When
              nothing is stopped this renders nothing at all: a permanent
              "not halted" banner is noise that trains people to ignore the
              place the real one will appear.
            */}
            {report?.execution.restricted && (
              <EmptyState
                title={`Execution is RESTRICTED — ${report.execution.mode.replace("_", "-")}`}
                body={
                  <>
                    <p>{report.execution.reason ?? "(no reason recorded)"}</p>
                    <p className={v.faint}>
                      {report.execution.note}
                      {report.execution.setAt ? ` Set ${report.execution.setAt}.` : ""}
                    </p>
                  </>
                }
                // the page that can actually DO something about it
                action={<Link to="/admin/execution">Open execution control</Link>}
              />
            )}

            {/* ADR-0181: TLS to Postgres is the default; running without it is
                an explicit, visible relaxation (REGULAIT_DATABASE_SSL=disable). */}
            {dbTls === "relaxed" && (
              <EmptyState
                title="database TLS: relaxed"
                body={
                  "REGULAIT_DATABASE_SSL=disable is set, so the gateway talks to Postgres in plaintext. " +
                  "That is acceptable only for a database on the same host (the local demo, docker-compose). " +
                  "Unset it, or set require, for any other deployment; the gateway also says so loudly at boot."
                }
              />
            )}

            {blocked.length > 0 && (
              <EmptyState
                title={`${blocked.length} control(s) cannot be reached from this screen`}
                body={
                  `${blocked.join(", ")} — these are resolved from the process environment at start-up. ` +
                  "An API call cannot set an environment variable, so they are reported with their " +
                  "OBSERVED state and are never counted as hardened on our say-so. The overall verdict " +
                  "above stays 'not hardened' while they are unmet, even once every settable control is on."
                }
              />
            )}

            <div className={a.formRow}>
              <Button size="sm" onClick={harden} disabled={act.busy}>
                Harden enforcement controls
              </Button>
            </div>
            <div className={v.faint}>
              Applying is idempotent and audited under its own rule id, so the trail distinguishes
              "an admin edited one dial" from "an admin applied the preset". It changes what this
              deployment REFUSES, immediately and with no dry run — read the last column before
              using it on an installation carrying real traffic.
            </div>
            {act.error && <div className={v.errLine}>{act.error}</div>}
          </Card>

          <Card title="Enforcement">
            <Table
              rows={enforcement}
              rowKey={(c) => c.key}
              columns={columns("What turning it on refuses")}
            />
          </Card>

          <Card title="Optimisation">
            <div className={v.faint}>
              Shown separately, and deliberately left out of the button above: these change what the
              platform SPENDS and how it answers, not what it refuses. Hardening a regulated
              deployment is not the same request as serving more answers from cache.
            </div>
            <Table
              rows={optimisation}
              rowKey={(c) => c.key}
              columns={columns("What turning it on changes")}
            />
          </Card>
        </QueryGate>
        <BomSettingsPanel />
      </div>
    </>
  );
}


/** Browser-safe copy of ADR-0189 settings; no shared barrel/runtime import (node crypto). */
export const BOM_POSTURE_SETTINGS = [
  { key: "decisionFactsCapture", column: "decision_facts_capture", label: "Decision BOM facts", strict: "on", options: ["on", "off"], consequence: "Off leaves decisions made while off with facts not recorded forever." },
  { key: "decisionBomFinality", column: "decision_bom_finality", label: "Decision BOM finality", strict: "anchored", options: ["anchored", "anchored_unverified_destination", "chain_signed"], consequence: "An unverified destination is not observed tamper-resistant. Chain signed freezes before an anchor exists." },
  { key: "bomExportRoles", column: "bom_export_roles", label: "BOM export roles", strict: "admins_only", options: ["admins_only", "admins_and_auditors"], consequence: "Adding auditors allows only people with an explicit auditor grant. Membership or sponsorship alone grants no export access." },
  { key: "bomPersonIdentifiers", column: "bom_person_identifiers", label: "People in AI BOMs", strict: "id_only", options: ["id_only", "display_name"], consequence: "Display names may be recorded in AI BOM snapshots. Decision BOMs always use IDs; emails are never included." },
  { key: "aiBomSnapshotTriggers", column: "ai_bom_snapshot_triggers", label: "Automatic AI BOM snapshots", strict: "sign_off_events", options: ["sign_off_events", "on_demand_only"], consequence: "On demand only allows sign-offs with no snapshot of what was signed off." },
  { key: "aiBomSnapshotWithoutKey", column: "ai_bom_snapshot_without_key", label: "Sign-off with no signing key", strict: "refuse", options: ["refuse", "skip_and_record"], consequence: "Skip and record proceeds with an audited evidence gap. No snapshot is queued or taken later." },
  { key: "cyclonedxExportVersions", column: "cyclonedx_export_versions", label: "CycloneDX export versions", strict: ["1.7"], options: ["1.7", "1.7,1.6"], consequence: "Adding 1.6 provides a previous-version rendering. Version 1.7 remains required." },
  { key: "bomExportRateLimitPerMinute", column: "bom_export_rate_limit_per_minute", label: "BOM exports per minute, per person", strict: 30, consequence: "Above 30 permits faster bulk evidence extraction, up to 600 per minute." },
  { key: "decisionBomFiniteLockFinality", column: "decision_bom_finite_lock_finality", label: "Finality with unbounded audit retention", strict: "refuse", options: ["refuse", "accept"], consequence: "Accept permits a finite lock while retention has no end. The verifier reports the lock as lapsed after its expiry." },
] as const;
type BomPostureSetting = (typeof BOM_POSTURE_SETTINGS)[number];

export function bomPostureValue(setting: BomPostureSetting, input: string): string | string[] | number | null {
  if (setting.key === "bomExportRateLimitPerMinute") {
    if (!/^[0-9]+$/.test(input)) return null;
    const value = Number(input);
    return Number.isSafeInteger(value) && value >= 1 && value <= 600 ? value : null;
  }
  if (setting.key === "cyclonedxExportVersions") {
    const versions = input.split(",");
    if (!versions.includes("1.7") || new Set(versions).size !== versions.length || versions.some((value) => value !== "1.7" && value !== "1.6")) return null;
    return ["1.7", "1.6"].filter((value) => versions.includes(value));
  }
  return setting.options.some((value: string) => value === input) ? input : null;
}
function bomValueText(value: unknown): string | null {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value.join(",");
  return null;
}
export function bomStoredValue(setting: BomPostureSetting, value: unknown): string | string[] | number | null {
  if (setting.key === "cyclonedxExportVersions" ? !Array.isArray(value) : setting.key === "bomExportRateLimitPerMinute" ? typeof value !== "number" : typeof value !== "string") return null;
  const text=bomValueText(value); return text===null ? null : bomPostureValue(setting,text);
}
/** A successful write is not a fresh baseline until the follow-up read succeeds. */
export async function saveBomPostureAndReload(body: Record<string, unknown>, write: (body: Record<string, unknown>) => Promise<unknown>, settle: () => Promise<boolean>): Promise<boolean> {
  await write(body);
  return settle();
}
function BomSettingsPanel() {
  const settings = useQuery({ queryKey: ["admin", "org-settings"], retry: false, queryFn: () => api.get<OrgSettingsResponse>("/v1/org/settings") });
  const baseline = useSettleAfterWrite(["admin", "org-settings"]);
  const flight = useSingleFlight();
  const save = async (body: Record<string, unknown>) => {
    if (baseline.stale || !flight.enter()) throw new Error("The settings are locked until their current values are reloaded.");
    try {
      const fresh = await saveBomPostureAndReload(body, putOrgSettings, baseline.settle);
      if (!fresh) throw new Error("Saved, but the current values could not be reloaded. Retry loading before changing another setting.");
    } finally { flight.leave(); }
  };
  const retry = async () => {
    if (!flight.enter()) return;
    try { await baseline.settle(); } finally { flight.leave(); }
  };
  return <Card title="BOM evidence posture"><div className={v.stack}>
    <p>Strict defaults record digests and classifications, never raw content. Exports require an admin or an explicitly granted auditor and are audited. Changing settings requires admin access; relaxing one requires settings step-up.</p>
    <QueryGate loading={settings.isLoading} error={settings.error} onRetry={() => void settings.refetch()}>
      {settings.data ? BOM_POSTURE_SETTINGS.map((setting) => <BomSettingRow key={`${setting.key}:${JSON.stringify(settings.data.settings[setting.key])}`} setting={setting} current={settings.data.settings[setting.key]} locked={baseline.stale || flight.busy} onSave={save} />) : null}
    </QueryGate>
    {baseline.stale ? <StaleAfterWrite onRetry={() => void retry()} /> : null}
  </div></Card>;
}
function BomSettingRow({ setting, current, locked, onSave }: { setting: BomPostureSetting; current: unknown; locked: boolean; onSave: (body: Record<string, unknown>) => Promise<void> }) {
  const act = useAction();
  const currentValue = bomStoredValue(setting,current);
  const currentText = bomValueText(currentValue);
  const [draft, setDraft] = useState(currentValue === null ? "" : bomValueText(currentValue)!);
  const [pending, setPending] = useState<{ body: Record<string, unknown>; oldValue: string; newValue: string } | null>(null);
  const parsed = bomPostureValue(setting, draft);
  const known = currentValue !== null;
  const relaxed = known && (setting.key === "bomExportRateLimitPerMinute" ? Number(currentValue) > 30 : JSON.stringify(currentValue) !== JSON.stringify(setting.strict));
  const save = (body: Record<string, unknown>) => void act.run(async () => { await onSave(body); }, "BOM evidence setting saved and current values reloaded").finally(() => setPending(null));
  return <div className={v.stack}>
    <form className={v.stack} onSubmit={(event) => {
      event.preventDefault();
      if (locked || act.busy || !known || parsed === null) return;
      const body = { [setting.key]: Array.isArray(parsed) ? [...parsed] : parsed };
      setPending({ body, oldValue: currentText!, newValue: bomValueText(parsed)! });
    }}>
      <Field label={setting.label}>
        {setting.key === "bomExportRateLimitPerMinute" ? <Input type="number" min={1} max={600} step={1} required disabled={locked || !known || act.busy || pending !== null} value={draft} onChange={(event) => setDraft(event.target.value)} /> : <Select disabled={locked || !known || act.busy || pending !== null} value={draft} onChange={(event) => setDraft(event.target.value)}>{!known ? <option value="">Unknown — setting not reported</option> : null}{setting.options.map((option) => <option key={option} value={option}>{option.replaceAll("_", " ")}</option>)}</Select>}
      </Field>
      <p>Current: {known ? currentText : "unknown — no stored setting reported"}. Strict default: {bomValueText(setting.strict)}. {known ? <Badge tone={relaxed ? "warn" : "ok"}>{relaxed ? "audited relaxation" : "strict"}</Badge> : <Badge tone="warn">unknown</Badge>}</p>
      {setting.key === "decisionFactsCapture" && currentValue === "off" ? <p role="status">Decision BOM: not captured</p> : null}
      <p className={v.faint}>{setting.consequence}</p>
      <Button type="submit" size="sm" disabled={locked || !known || act.busy || pending !== null || parsed === null || JSON.stringify(parsed) === JSON.stringify(currentValue)}>Review change</Button>
      {act.error ? <p role="alert">{act.error}</p> : null}
    </form>
    <Modal open={pending !== null} title={`Change ${setting.label.toLowerCase()}?`} onClose={() => { if (!act.busy && !locked) setPending(null); }} actions={<><Button disabled={act.busy || locked} onClick={() => setPending(null)}>Cancel</Button><Button disabled={act.busy || locked} onClick={() => { if (pending && !act.busy && !locked) save(pending.body); }}>{act.busy ? "Saving…" : "Save setting"}</Button></>}><p>Stored value: {pending?.oldValue} → New value: {pending?.newValue}</p><p>{setting.consequence}</p><p>Every change is audited. A relaxation requires a fresh settings step-up.</p></Modal>
  </div>;
}
