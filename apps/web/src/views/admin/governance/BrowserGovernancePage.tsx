/**
 * ADR-0334 (lane E16, D5; owner-approved on #453) — Browser governance: the managed browser extension's admin page.
 *
 * Strict by default (ADR-0180), and every relaxation says so before it is made: turning governance on, audit only,
 * prompt capture, a longer capture retention, allowing a site and issuing an enrolment token each ask the admin to
 * confirm it's them (a `settings_relax` step-up), and reading a captured prompt is its own `pseudonym_reveal` step-up,
 * bound to that one capture and audited. Denying a site, turning governance off and revoking need no step-up; each is
 * audited by the gateway.
 *
 * An enrolment token and its managed-storage config are answered once: they live in this page's state only while the
 * dialog is open (never the query cache, storage or a log), and closing the dialog drops them. A revealed prompt too.
 */
import { useId, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { fmtDateTime, plural } from "../../../api/format";
import { PageHeader } from "../../../shell/AppShell";
import { api as stepUpApi, withStepUp } from "../../../stepup/stepUp";
import { Badge, Button, Card, CodeBlock, ConfirmModal, EmptyState, Field, Fieldset, Input, Modal, Switch, Table, Textarea, type Column } from "../../../ui/kit";
import { DataList, type DataColumn } from "../../../ui/DataList";
import { useToast } from "../../../ui/toast";
import { QueryGate, useAction } from "../adminKit";
import {
  EVENT_KIND,
  MODE_LABEL,
  RETENTION_MAX_DAYS,
  RETENTION_MIN_DAYS,
  SIGNER_STATE,
  TOKEN_MAX_DAYS,
  TOKEN_MAX_DEVICES,
  TOKEN_STATE,
  eventCodeText,
  isUuid,
  modeBody,
  modeOf,
  parseAccountDomains,
  shortKey,
  tokenState,
  type BrowserDeviceView,
  type BrowserEventView,
  type BrowserGovernanceSettings,
  type BrowserMode,
  type BrowserSite,
  type BrowserTokenView,
  type IssuedToken,
  type PromptCaptureView,
} from "./browserGovernanceModel";
import a from "../admin.module.css";
import v from "../../views.module.css";

const KEY = ["admin", "browser-governance"] as const;
const when = (iso: string | null) => <span style={{ whiteSpace: "nowrap" }}>{fmtDateTime(iso, "never")}</span>;
const mono = (s: ReactNode) => <span className={v.mono}>{s}</span>;
/** the step-up a control asks for, stated beside it before it is used (ADR-0180: no surprise prompts) */
const stepUp = (what: string) => <Badge tone="info">{`${what} asks you to confirm it's you`}</Badge>;
const Err = ({ msg }: { msg: string | null }) =>
  msg ? (
    <p className={v.errLine} role="alert">
      {msg}
    </p>
  ) : null;
const h2 = (t: ReactNode) => <h2 className={v.sectionTitle}>{t}</h2>;

function useCopy() {
  const { toast } = useToast();
  return (text: string) =>
    navigator.clipboard.writeText(text).then(
      () => toast("Copied", "success"),
      () => toast("Clipboard unavailable: select the text and copy it", "error"),
    );
}

export default function BrowserGovernancePage() {
  const settings = useQuery({ queryKey: [...KEY, "s"], queryFn: () => stepUpApi.get<BrowserGovernanceSettings>("/v1/browser-governance") });
  const s = settings.data;
  return (
    <>
      <PageHeader
        title="Browser governance"
        sub="The managed browser extension controls which AI sites people can use, which accounts they must sign in with, and blocks pasting credentials into prompts. Events name people only by pseudonym."
      />
      <div className={v.stack}>
        <QueryGate query={settings}>{s && <ModeCard s={s} />}</QueryGate>
        <SitesCard />
        <Lists blocked={!s ? "Reading the settings…" : !s.enabled ? "Turn browser governance on first." : s.policySigner.state !== "ok" ? "No policy key is usable." : null} captureOn={s?.promptCaptureEnabled ?? false} />
      </div>
    </>
  );
}

// ---- mode, prompt capture and the policy key -----------------------------------------------------------------------

function ModeCard({ s }: { s: BrowserGovernanceSettings }) {
  const act = useAction();
  const copy = useCopy();
  const ids = { cap: useId(), note: useId() };
  const mode = modeOf(s);
  const [offAsk, setOffAsk] = useState(false);
  const [days, setDays] = useState(String(s.promptCaptureRetentionDays));
  const [bad, setBad] = useState<string | null>(null);
  const key = s.policySigner.state === "ok" ? s.policySigner : null;
  const write = (body: Record<string, unknown>) =>
    void act.run(async () => {
      await withStepUp((h) => stepUpApi.put("/v1/browser-governance/settings", body, h));
    });
  const choose = (m: BrowserMode) => {
    if (m === mode || act.busy) return;
    if (m === "off") setOffAsk(true);
    else write(modeBody(m));
  };
  const saveDays = () => {
    const n = Number(days);
    if (!Number.isInteger(n) || n < RETENTION_MIN_DAYS || n > RETENTION_MAX_DAYS) return setBad(`${RETENTION_MIN_DAYS} to ${RETENTION_MAX_DAYS} days.`);
    setBad(null);
    write({ promptCaptureRetentionDays: n });
  };
  return (
    <Card title={h2("Mode")}>
      <div className={v.stack}>
        {s.policySigner.state !== "ok" && (
          <p role="alert" className={v.errLine} data-testid="signer-warning">
            <Badge tone="warn">Policy key unavailable</Badge> {SIGNER_STATE[s.policySigner.state]}
          </p>
        )}
        <div className={v.row} style={{ alignItems: "flex-start", gap: "var(--s3)" }}>
          <div className={v.stackTight}>
            <Fieldset legend="Browser governance mode">
              <div className={v.row}>
                {(["off", "audit", "enforce"] as const).map((m) => (
                  <label key={m} className={v.rowTight}>
                    <input type="radio" name="bg-mode" checked={mode === m} aria-disabled={act.busy || undefined} aria-describedby={ids.note} onChange={() => choose(m)} />
                    {MODE_LABEL[m]}
                  </label>
                ))}
              </div>
            </Fieldset>
            <p id={ids.note} className={v.faint} style={{ maxWidth: "28rem" }}>
              {mode === "off" ? "Off: no browser gets a policy, so enrolled browsers block every governed site." : "Audit only records breaches without blocking them; enforce blocks them."}
            </p>
            {mode !== "audit" && <div>{stepUp(mode === "off" ? "Turning on" : "Audit only")}</div>}
          </div>
          <div className={v.stackTight} style={{ flex: "1 1 20rem" }}>
            <div className={v.rowTight}>
              <Switch checked={s.promptCaptureEnabled} labelledBy={ids.cap} busy={act.busy} onChange={(on) => write({ promptCaptureEnabled: on })} />
              <strong id={ids.cap}>Capture prompts on governed sites</strong>
            </div>
            <p className={v.faint}>
              {s.promptCaptureEnabled ? "On: people see a notice on every governed site that prompts are recorded." : "Off. Turning it on asks you to confirm it's you; people then see a notice on every governed site."} A
              prompt that matched a credential rule is never captured. Each captured prompt is opened one at a time, after a pseudonym-reveal check, and
              every view is audited.
            </p>
            <div className={v.row} style={{ alignItems: "flex-end" }}>
              <Field label="Keep captured prompts (days)" error={bad}>
                <Input inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} />
              </Field>
              <Button busy={act.busy} disabled={days === String(s.promptCaptureRetentionDays)} onClick={saveDays}>
                Save
              </Button>
            </div>
            <p className={v.faint}>Keeping them longer than {plural(s.promptCaptureRetentionDays, "day")} asks you to confirm it&apos;s you; shortening does not.</p>
          </div>
        </div>
        {key && (
          <div className={v.row} data-testid="policy-key">
            <span className={v.faint}>Policy key for managed storage:</span>
            {mono(`${key.activeKeyId} · ${shortKey(key.publishedKeys[0]?.x ?? "")}`)}
            {key.publishedKeys.length > 1 && <Badge tone="info">{`${key.publishedKeys.length} keys published (rotation)`}</Badge>}
            <Button size="sm" onClick={() => void copy(JSON.stringify(key.publishedKeys))}>
              Copy
            </Button>
          </div>
        )}
        <Err msg={act.error} />
      </div>
      <ConfirmModal
        open={offAsk}
        danger
        title="Turn browser governance off?"
        body="No browser gets a policy while it is off, so every enrolled browser blocks every governed site, and no new browser can enrol."
        confirmLabel="Turn off"
        onCancel={() => setOffAsk(false)}
        onConfirm={() => {
          setOffAsk(false);
          write(modeBody("off"));
        }}
      />
    </Card>
  );
}

// ---- governed AI sites ---------------------------------------------------------------------------------------------

function SitesCard() {
  const q = useQuery({ queryKey: [...KEY, "sites"], queryFn: () => stepUpApi.get<{ sites: BrowserSite[] }>("/v1/browser-governance/sites") });
  const [edit, setEdit] = useState<BrowserSite | null>(null);
  const rows = q.data?.sites;
  const on = rows?.filter((s) => s.effective === "allow").length ?? 0;
  const cols: Array<Column<BrowserSite>> = [
    { key: "site", header: "Site", render: (s) => <>{mono(<strong>{s.host}</strong>)}<div className={v.faint}>{s.provider}</div></> },
    { key: "rule", header: "Rule", render: (s) => (s.effective === "allow" ? <Badge tone="ok">Allowed</Badge> : <Badge tone="danger">{s.decision ? "Denied" : "Denied (no rule)"}</Badge>) },
    { key: "dom", header: "Required account domains", render: (s) => (s.accountDomains.length ? mono(s.accountDomains.join(", ")) : s.effective === "allow" ? "any account" : "—") },
    {
      key: "act",
      header: "",
      srHeader: "Actions",
      align: "right",
      render: (s) => {
        const verb = s.effective === "allow" ? "Edit" : "Allow";
        return (
          <Button size="sm" aria-label={`${verb} ${s.host}`} onClick={() => setEdit(s)}>
            {verb}…
          </Button>
        );
      },
    },
  ];
  return (
    <Card flush title={h2(<>Governed AI sites {rows && <span className={v.faint}>{`${rows.length} · ${on} allowed · ${rows.length - on} denied`}</span>}</>)} footer={<p className={v.faint}>Allowing a site asks you to confirm it&apos;s you; denying one does not. Both are audited.</p>}>
      <div data-testid="browser-sites">
        <Table columns={cols} rows={rows} rowKey={(s) => s.siteId} loading={q.isLoading} error={q.error} onRetry={() => void q.refetch()} empty={<EmptyState title="No governed site" />} />
      </div>
      {edit && <SiteModal site={edit} close={() => setEdit(null)} />}
    </Card>
  );
}

function SiteModal({ site, close }: { site: BrowserSite; close: () => void }) {
  const act = useAction();
  const [allow, setAllow] = useState(site.effective !== "allow");
  const [text, setText] = useState(site.accountDomains.join("\n"));
  const p = parseAccountDomains(text);
  const save = () =>
    void act
      .run(async () => {
        await withStepUp((h) => stepUpApi.put(`/v1/browser-governance/sites/${encodeURIComponent(site.siteId)}`, { decision: allow ? "allow" : "deny", accountDomains: allow ? p.domains : [] }, h));
      })
      .then((ok) => ok && close());
  return (
    <Modal
      open
      title={`Rule for ${site.host}`}
      onClose={close}
      actions={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant={allow ? "primary" : "danger"} busy={act.busy} disabled={allow && Boolean(p.problem)} onClick={save}>
            {allow ? "Allow site" : "Deny site"}
          </Button>
        </>
      }
    >
      <div className={v.stack}>
        <Fieldset legend="Rule">
          <div className={v.row}>
            {[true, false].map((x) => (
              <label key={String(x)} className={v.rowTight}>
                <input type="radio" name="bg-site" checked={allow === x} onChange={() => setAllow(x)} />
                {x ? "Allow" : "Deny"}
              </label>
            ))}
          </div>
        </Fieldset>
        {allow ? (
          <>
            <Field label="Required account domains (optional, at most 20, one per line)" error={p.problem}>
              <Textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} />
            </Field>
            <p className={v.faint}>{p.domains.length ? `Only accounts in ${p.domains.join(", ")} may use it; anyone else is blocked.` : "With no domain, any signed-in account may use it."}</p>
            <div>{stepUp("Allowing")}</div>
          </>
        ) : (
          <p className={v.faint}>Every enrolled browser blocks the site on its next policy. Denying needs no confirmation and is audited.</p>
        )}
        <Err msg={act.error} />
      </div>
    </Modal>
  );
}

// ---- enrolment tokens, enrolled browsers and breach events ---------------------------------------------------------

type Revoking = { run: () => Promise<unknown>; title: string; body: string };

function Lists({ blocked, captureOn }: { blocked: string | null; captureOn: boolean }) {
  const act = useAction();
  const copy = useCopy();
  const [form, setForm] = useState<{ label: string; cap: string; days: string } | null>(null);
  const [bad, setBad] = useState<string | null>(null);
  // shown once: held only while its dialog is open, dropped when it closes
  const [issued, setIssued] = useState<IssuedToken | null>(null);
  const [revoking, setRevoking] = useState<Revoking | null>(null);
  const [capId, setCapId] = useState("");
  const [capBad, setCapBad] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<PromptCaptureView | null>(null);

  const issue = () => {
    if (!form) return;
    const deviceCap = Number(form.cap);
    const expiresInDays = Number(form.days);
    if (!form.label.trim()) return setBad("Name the token, for example the group it is for.");
    if (!Number.isInteger(deviceCap) || deviceCap < 1 || deviceCap > TOKEN_MAX_DEVICES) return setBad(`Set a device cap of 1 to ${TOKEN_MAX_DEVICES}.`);
    if (!Number.isInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > TOKEN_MAX_DAYS) return setBad(`A token lasts 1 to ${TOKEN_MAX_DAYS} days.`);
    setBad(null);
    void act
      .run(async () => setIssued(await withStepUp((h) => stepUpApi.post<IssuedToken>("/v1/browser-governance/enrolment-tokens", { label: form.label.trim(), deviceCap, expiresInDays }, h))))
      .then((ok) => ok && setForm(null));
  };
  const reveal = () => {
    const id = capId.trim();
    if (!isUuid(id)) return setCapBad("Enter the capture id from its audit log entry.");
    setCapBad(null);
    void act.run(async () => {
      setPrompt(await withStepUp((h) => stepUpApi.get<PromptCaptureView>(`/v1/browser-governance/prompt-captures/${encodeURIComponent(id)}`, h)));
      setCapId("");
    });
  };
  const revokeBtn = (label: string, r: Revoking, danger?: boolean) => (
    <Button size="sm" variant={danger ? "danger" : "default"} busy={act.busy} aria-label={label} onClick={() => setRevoking(r)}>
      Revoke
    </Button>
  );

  const tokenCols: Array<DataColumn<BrowserTokenView>> = [
    { key: "label", header: "Label", main: true, sortable: true, render: (t) => t.label },
    { key: "devices", header: "Devices", main: true, render: (t) => `${t.devicesEnrolled} / ${t.deviceCap} (${t.devicesActive} active)` },
    {
      key: "state",
      header: "State",
      main: true,
      required: "A token's state is always shown",
      render: (t) => {
        const st = TOKEN_STATE[tokenState(t)];
        return <Badge tone={st.tone}>{st.label}</Badge>;
      },
    },
    { key: "expires", header: "Expires", main: true, sortable: true, render: (t) => when(t.expiresAt) },
    { key: "created", header: "Issued", sortable: true, render: (t) => when(t.createdAt) },
    {
      key: "act",
      header: "",
      srHeader: "Actions",
      action: true,
      render: (t) =>
        !t.revokedAt &&
        revokeBtn(`Revoke token ${t.label}`, {
          run: () => stepUpApi.post(`/v1/browser-governance/enrolment-tokens/${t.tokenId}/revoke`, {}),
          title: "Revoke this enrolment token?",
          body: "No new browser enrols with it. Browsers it already enrolled stay enrolled; revoke them under Enrolled browsers.",
        }),
    },
  ];
  const deviceCols: Array<DataColumn<BrowserDeviceView>> = [
    { key: "device", header: "Device", main: true, render: (d) => mono(d.deviceId.slice(0, 8)) },
    { key: "os", header: "OS", main: true, sortable: true, render: (d) => d.os },
    { key: "version", header: "Browser", main: true, sortable: true, render: (d) => `Browser ${d.browserMajor}, extension ${d.extensionVersion}` },
    { key: "bound", header: "Account", main: true, required: "An unbound browser is a warning", render: (d) => (d.bound ? mono(d.boundSubject) : <Badge tone="warn">not bound yet</Badge>) },
    { key: "lastSeen", header: "Last proof", main: true, render: (d) => when(d.lastSeenAt) },
    { key: "state", header: "State", main: true, required: "A browser's state is always shown", render: (d) => (d.revokedAt ? <Badge>Revoked</Badge> : <Badge tone="ok">Active</Badge>) },
    { key: "registered", header: "Registered", sortable: true, render: (d) => when(d.registeredAt) },
    {
      key: "act",
      header: "",
      srHeader: "Actions",
      action: true,
      render: (d) =>
        !d.revokedAt &&
        revokeBtn(
          `Revoke browser ${d.deviceId.slice(0, 8)}`,
          { run: () => stepUpApi.post(`/v1/browser-governance/devices/${d.deviceId}/revoke`, {}), title: "Revoke this browser?", body: "Its proofs are refused from now on and it blocks every governed site. Enrolling it again needs a token." },
          true,
        ),
    },
  ];
  const eventCols: Array<DataColumn<BrowserEventView>> = [
    { key: "occurred", header: "When", main: true, sortable: true, render: (e) => when(e.occurredAt) },
    { key: "subject", header: "Person (pseudonym)", main: true, render: (e) => mono(e.subject) },
    { key: "site", header: "Site", main: true, sortable: true, render: (e) => mono(e.siteId) },
    {
      key: "kind",
      header: "Block",
      main: true,
      required: "What was blocked is always shown",
      render: (e) => (
        <span className={v.rowTight}>
          <Badge tone={e.kind === "dlp_blocked" ? "danger" : e.kind === "account_blocked" ? "warn" : "neutral"}>{EVENT_KIND[e.kind] ?? e.kind}</Badge>
          {e.outcome === "would_block" && <Badge tone="info">audit only: not blocked</Badge>}
        </span>
      ),
    },
    { key: "code", header: "Detail", main: true, render: (e) => <>{eventCodeText(e.code)}{e.ruleIds.length > 0 && <div className={v.faint}>{mono(e.ruleIds.join(", "))}</div>}</> },
    { key: "received", header: "Received", sortable: true, render: (e) => when(e.receivedAt) },
  ];
  const list = <T,>(endpoint: string, noun: string, rowKey: (r: T) => string, columns: Array<DataColumn<T>>, sortKey: string, empty: string) => (
    <DataList<T>
      listId={`browser-${noun.replace(/ /g, "-")}`}
      noun={noun}
      endpoint={endpoint}
      queryKey={[...KEY, noun]}
      legacyKey="items"
      defaultSort={{ key: sortKey, dir: "desc" }}
      rowKey={rowKey}
      columns={columns}
      empty={<EmptyState title={empty} />}
    />
  );

  return (
    <>
      <Err msg={act.error} />
      <Card
        flush
        title={h2("Enrolment tokens")}
        actions={
          <span className={v.rowTight}>
            {blocked && <span className={v.faint}>{blocked}</span>}
            <Button variant="primary" disabled={Boolean(blocked)} onClick={() => setForm({ label: "", cap: "", days: String(TOKEN_MAX_DAYS) })}>
              Issue token
            </Button>
          </span>
        }
        footer={<p className={v.faint}>Issuing a token asks you to confirm it&apos;s you. Revoking one stops new browsers enrolling with it; browsers already enrolled stay enrolled.</p>}
      >
        {list("/v1/browser-governance/enrolment-tokens", "enrolment tokens", (t: BrowserTokenView) => t.tokenId, tokenCols, "created", "No enrolment token")}
      </Card>
      <Card flush title={h2("Enrolled browsers")} footer={<p className={v.faint}>A revoked browser&apos;s proofs are refused, so it blocks every governed site.</p>}>
        {list("/v1/browser-governance/devices", "enrolled browsers", (d: BrowserDeviceView) => d.deviceId, deviceCols, "registered", "No browser has enrolled")}
      </Card>
      <Card flush title={h2("Breach events")} footer={<p className={v.faint}>Events name people only by pseudonym and never carry prompt text.</p>}>
        {list("/v1/browser-governance/events", "breach events", (e: BrowserEventView) => e.id, eventCols, "received", "No breach recorded")}
        <div className={v.stack} style={{ padding: "var(--s2)" }} data-testid="reveal-prompt">
          <h3 className={v.sectionTitle}>Reveal a captured prompt</h3>
          <p className={v.faint}>
            {captureOn ? "Prompt capture is on. " : "Prompt capture is off; earlier captures are kept until their retention ends. "}
            Find the capture id on its <Link to="/admin/audit" style={{ textDecoration: "underline" }}>audit log</Link> entry. Each reveal is audited and shows that one prompt only.
          </p>
          <div className={v.row} style={{ alignItems: "flex-end" }}>
            <Field label="Capture id" error={capBad}>
              <Input value={capId} onChange={(e) => setCapId(e.target.value)} />
            </Field>
            <Button busy={act.busy} onClick={reveal}>
              Reveal prompt…
            </Button>
            {stepUp("Reveal prompt")}
          </div>
        </div>
      </Card>

      <Modal
        open={form !== null}
        title="Issue an enrolment token"
        onClose={() => setForm(null)}
        actions={
          <>
            <Button onClick={() => setForm(null)}>Cancel</Button>
            <Button variant="primary" busy={act.busy} onClick={issue}>
              Issue token
            </Button>
          </>
        }
      >
        {form && (
          <div className={v.stack}>
            <Field label="Label">
              <Input value={form.label} maxLength={120} onChange={(e) => setForm({ ...form, label: e.target.value })} />
            </Field>
            <Field label={`Device cap (1 to ${TOKEN_MAX_DEVICES})`}>
              <Input inputMode="numeric" value={form.cap} onChange={(e) => setForm({ ...form, cap: e.target.value })} />
            </Field>
            <Field label={`Expires in (days, at most ${TOKEN_MAX_DAYS})`} error={bad}>
              <Input inputMode="numeric" value={form.days} onChange={(e) => setForm({ ...form, days: e.target.value })} />
            </Field>
            <div>{stepUp("Issuing")}</div>
            <p className={v.faint}>The token enrols up to its cap of browsers with no further check, and is shown once.</p>
            <Err msg={act.error} />
          </div>
        )}
      </Modal>
      {issued && (
        <Modal open wide title="Enrolment token issued" onClose={() => setIssued(null)} actions={<Button variant="primary" onClick={() => setIssued(null)}>I have copied it</Button>}>
          <div className={v.stack}>
            <p role="status">
              <Badge tone="warn">Shown once</Badge> Copy the token and the managed-storage config into your browser management now. regulAIt keeps only a
              hash, so it cannot be shown again.
            </p>
            <div className={a.secretRow}>
              <code className={a.secretCode} data-testid="issued-secret">
                {issued.managedConfig.enrolmentToken}
              </code>
              <Button size="sm" onClick={() => void copy(issued.managedConfig.enrolmentToken)}>
                Copy token
              </Button>
            </div>
            <CodeBlock>{JSON.stringify(issued.managedConfig, null, 2)}</CodeBlock>
            <div>
              <Button size="sm" onClick={() => void copy(JSON.stringify(issued.managedConfig, null, 2))}>
                Copy config
              </Button>
            </div>
            <p className={v.faint}>{`'${issued.token.label}' enrols up to ${plural(issued.token.deviceCap, "browser")} until ${fmtDateTime(issued.token.expiresAt)}.`}</p>
          </div>
        </Modal>
      )}
      {prompt && (
        <Modal open wide title="Captured prompt" onClose={() => setPrompt(null)} actions={<Button onClick={() => setPrompt(null)}>Close</Button>}>
          <div className={v.stack}>
            <p className={v.faint}>
              Captured {fmtDateTime(prompt.capturedAt)} on {mono(prompt.siteId)} by {mono(prompt.subject)}. This view was audited.
            </p>
            <CodeBlock>{prompt.text}</CodeBlock>
          </div>
        </Modal>
      )}
      <ConfirmModal
        open={revoking !== null}
        danger
        title={revoking?.title ?? ""}
        body={revoking?.body}
        confirmLabel="Revoke"
        onCancel={() => setRevoking(null)}
        onConfirm={() => {
          const r = revoking;
          setRevoking(null);
          if (r) void act.run(r.run);
        }}
      />
    </>
  );
}
