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
import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../../../api/client";
import { plural } from "../../../api/format";
import { PageHeader } from "../../../shell/AppShell";
import { Badge, Button, Card, EmptyState, InfoButton, Table, Tabs, tabIds, type Tone } from "../../../ui/kit";
import { QueryGate, orgSettingsQuery, useAction } from "../adminKit";
import { BomPostureCard, receiptKeysQuery, type ReceiptSigningKeyPosture } from "./BomPostureCard";
import { bomUnresolved, discoveryUnresolved, isolationUnresolved, orgSettingsUnresolved, tabLabel } from "./postureTabs";
import { OrgSettingsCard } from "./OrgSettingsCard";
import { IsolationSettingsCard } from "../integrations/isolation/IsolationSettings";
import { DiscoveryPostureCard } from "../governance/DiscoveryPostureCard";
import type { DiscoveryPostureView } from "../governance/discoverySourcesModel";
import ps from "./posture.module.css";
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
  /** ADR-0189 R25 item 19: where the receipt key comes from, or that there is none; informational, blocks nothing */
  receiptSigningKey?: ReceiptSigningKeyPosture;
  /** ADR-0195 SD0: active discovery rows (reported, never a control) */
  discovery?: DiscoveryPostureView;
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

const EVIDENCE_KEYS = ["decisionReceiptsMode", "auditAnchorTimestampMode", "vendoredDetectionPacks", "outboundCredentialAudience"] as const;

// I-2: the control matrix — a readable name, where the value comes from, and what fixes it
const CONTROL_LABEL: Record<string, string> = {
  defaultPiiMode: "Personal-data guardrail",
  mcpAdmissionMode: "MCP admission scanning",
  useCaseGateMode: "Use-case gate",
  mrmEnforced: "Model risk management",
  dispatchAttributionRequired: "Dispatch attribution",
  semanticCachePolicy: "Semantic cache",
  auditAnchorTamperResistant: "Write-once audit anchor",
  schedulerEnabled: "In-process scheduler",
  databaseTls: "Database TLS",
};
interface MatrixRow {
  key: string;
  label: string;
  group: string;
  state: { tone: Tone; text: string };
  source: string;
  fix: ReactNode;
  current: string;
  hardened: string;
  refuses: string;
}
function controlRow(c: PostureControl): MatrixRow {
  const tlsOff = c.key === "databaseTls" && !c.satisfied;
  const state: MatrixRow["state"] = c.satisfied
    ? { tone: "ok", text: c.group === "optimisation" ? "on" : "enforcing" }
    : tlsOff
      ? { tone: "danger", text: "disabled" }
      : c.settable
        ? { tone: c.group === "optimisation" ? "neutral" : "warn", text: c.group === "optimisation" ? "off" : "not enforcing" }
        : { tone: "info", text: "needs a deployment change" };
  const fix = c.satisfied ? (
    <span className={v.faint}>Nothing to do</span>
  ) : tlsOff ? (
    <strong>Unset REGULAIT_DATABASE_SSL, or set it to require, and restart the gateway.</strong>
  ) : !c.settable ? (
    <span>Set it in the process environment and restart.</span>
  ) : c.group === "optimisation" ? (
    <span>
      Optional, a cost decision, on the <Link to="/admin/organization">Organization</Link> page
    </span>
  ) : (
    <span>
      Use Harden enforcement controls, or set it on the <Link to="/admin/organization">Organization</Link> page
    </span>
  );
  return {
    key: c.key,
    label: CONTROL_LABEL[c.key] ?? c.key,
    group: c.group === "optimisation" ? "Optimisation" : "Enforcement",
    state,
    source: c.settable ? "Organisation setting" : "Deployment environment",
    fix,
    current: renderValue(c.current),
    hardened: renderValue(c.hardened),
    refuses: c.refuses,
  };
}

export default function EnforcementPosturePage() {
  const [tab, setTab] = useState("evidence");
  const act = useAction();
  const posture = useQuery({
    queryKey: ["admin", "posture"],
    queryFn: () => api.get<PostureReport>("/v1/org/posture"),
  });

  // the tab labels read the same cache entries the cards render from
  const settings = useQuery(orgSettingsQuery());
  const keys = useQuery(receiptKeysQuery());
  const settingsRead = { data: settings.data, failed: settings.isError };
  const keysRead = { data: keys.data, failed: keys.isError };

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


  return (
    <>
      <PageHeader
        title="Enforcement posture"
        info={<p>What is enforcing in this deployment right now — and, per control, what turning it on would start refusing. Every enforcement control below ships at its strict value, except the WORM audit anchor, which needs a bucket only the operator can supply. An admin may relax a settable control, and that relaxation is audited old → new, so a relaxed posture is always a decision somebody took deliberately rather than one the deployment arrived with. The environment-backed rows (database TLS, the scheduler, the audit anchor) are set by the operator, not here. The optimisation group (the semantic cache) ships off: it changes answers, and turning it on is a cost decision.</p>}
      />
      <div className={v.stack}>
        <QueryGate
          loading={posture.isLoading}
          error={posture.error}
          onRetry={() => void posture.refetch()}
        >
          {/* I-2: the verdict line, then the one finding that must not be missed */}
          <div className={v.row} role="group" aria-label="This deployment">
            <Badge tone={report?.hardened ? "ok" : "warn"}>{report?.hardened ? "Hardened" : "Not hardened"}</Badge>
            <Badge tone={report?.execution.restricted ? "danger" : "ok"}>
              {`Execution: ${report?.execution.mode.replace("_", "-") ?? "—"}`}
            </Badge>
            <Badge tone="neutral">{`Enforcement ${report?.summary.enforcementSatisfied ?? 0} of ${report?.summary.enforcementTotal ?? 0} on`}</Badge>
            <Badge tone="neutral">{`Optimisation ${report?.summary.optimisationSatisfied ?? 0} of ${report?.summary.optimisationTotal ?? 0} on`}</Badge>
            {dbTls !== "relaxed" && (
              <Badge tone={dbTls === "required" ? "ok" : "danger"}>{`DB TLS: ${dbTls ?? "not reported"}`}</Badge>
            )}
          </div>

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
              action={<Link to="/admin/execution">Open execution control</Link>}
            />
          )}

          {dbTls === "relaxed" && (
            <div className={`${a.effectBanner} ${a.effectBannerDeny}`} role="alert">
              <Badge
                tone="danger"
                info={
                  <p>
                    REGULAIT_DATABASE_SSL=disable is set, so the gateway talks to Postgres in plaintext. That is
                    acceptable only for a database on the same host (the local demo, docker-compose). Unset it, or set
                    require, for any other deployment; the gateway also says so loudly at boot.
                  </p>
                }
              >
                DB TLS: disabled
              </Badge>
              <span>
                The gateway talks to Postgres in plaintext. That is acceptable only for a database on the same host.{" "}
                <strong>Fix: unset REGULAIT_DATABASE_SSL, or set it to require, and restart.</strong>
              </span>
            </div>
          )}

          <Card
            title="Control matrix"
            info={
              <p>
                Every enforcement control ships at its strict value. A settable control relaxed by an admin is audited
                old to new; a deployment-environment control is reported with its observed state and is never counted as
                hardened on our say-so. The optimisation rows change what the platform spends and how it answers, not
                what it refuses, so the harden button leaves them alone.
              </p>
            }
            actions={
              <div className={v.row}>
                <Badge
                  tone="warn"
                  infoLabel="hardening"
                  info={
                    <p>
                      Applying is idempotent and audited. It changes what this deployment refuses, immediately and with
                      no dry run: read the last column first on an installation carrying real traffic.
                    </p>
                  }
                >
                  Takes effect immediately · no dry run
                </Badge>
                <Button size="sm" onClick={harden} disabled={act.busy}>
                  Harden enforcement controls
                </Button>
              </div>
            }
          >
            {/* inlineLinks: a link inside a Fix sentence is underlined, so it is not told apart by colour alone */}
            <div className={`${v.stack} ${ps.inlineLinks}`}>
              <Table<MatrixRow>
                rows={[...enforcement, ...optimisation].map(controlRow)}
                rowKey={(r) => r.key}
                columns={[
                  {
                    key: "control",
                    header: "Control",
                    render: (r) => (
                      <span className={v.stackTight}>
                        <strong>{r.label}</strong>
                        <span className={v.faint}>
                          {r.group} · <span className={v.mono}>{r.key}</span>
                        </span>
                      </span>
                    ),
                  },
                  {
                    key: "state",
                    header: "State",
                    render: (r) => (
                      <span className={v.stackTight}>
                        <Badge tone={r.state.tone}>{r.state.text}</Badge>
                        <span className={v.faint}>
                          now <span className={v.mono}>{r.current}</span> · hardened <span className={v.mono}>{r.hardened}</span>
                        </span>
                      </span>
                    ),
                  },
                  { key: "source", header: "Source", render: (r) => <span className={v.dim}>{r.source}</span> },
                  { key: "fix", header: "Fix", render: (r) => r.fix },
                  {
                    key: "refuses",
                    header: "What turning it on refuses or changes",
                    render: (r) => <span className={v.faint}>{r.refuses}</span>,
                  },
                ]}
              />
              {blocked.length > 0 && (
                <p>
                  {`${plural(blocked.length, "control")} set by the deployment cannot be changed from this screen (${blocked.map((k) => CONTROL_LABEL[k] ?? k).join(", ")}), so the verdict stays "not hardened" until ${blocked.length === 1 ? "it is" : "they are"} met.`}{" "}
                  <InfoButton label="controls set by the deployment">
                    These are resolved from the process environment at start-up. An API call cannot set an environment
                    variable, so they are reported with their observed state and are never counted as hardened on our
                    say-so.
                  </InfoButton>
                </p>
              )}
              {act.error && <div className={v.errLine}>{act.error}</div>}
            </div>
          </Card>

          {/* I-2 (owner amendment): each tab names what is unresolved inside it, so a tab never hides a warning */}
          <Tabs
            label="More posture settings"
            idPrefix="posture"
            tabs={[
              { id: "evidence", label: tabLabel("Evidence and detection", orgSettingsUnresolved(EVIDENCE_KEYS, settingsRead)) },
              { id: "bom", label: tabLabel("BOM evidence", bomUnresolved(settingsRead, report?.receiptSigningKey, keysRead)) },
              { id: "isolation", label: tabLabel("Isolation", isolationUnresolved(settingsRead)) },
              { id: "discovery", label: tabLabel("Discovery", report ? discoveryUnresolved(report.discovery) : null) },
            ]}
            active={tab}
            onChange={setTab}
          />
          {/* every panel stays mounted (hidden when not selected), so an unsaved draft in one card survives a save in another */}
          {/* ADR-0186 R / S / V: receipts, anchor timestamps, vendored detection content, outbound credential audience */}
          <PosturePanel id="evidence" tab={tab}>
            <OrgSettingsCard title="Evidence and detection" keys={EVIDENCE_KEYS} testId="evidence-detection-settings" />
          </PosturePanel>
          {/* ADR-0189 §7 / §10: the receipt key and the BOM settings */}
          <PosturePanel id="bom" tab={tab}>
            <BomPostureCard receiptKey={report?.receiptSigningKey} />
          </PosturePanel>
          {/* ADR-0190 decision 11 (owner decision A, enforce-only): the isolation settings, the same card as under Engines */}
          <PosturePanel id="isolation" tab={tab}>
            <IsolationSettingsCard />
          </PosturePanel>
          {/* ADR-0195 SD0: sources enabled, static credentials, stale credentials, write scope unverified */}
          <PosturePanel id="discovery" tab={tab}>
            {report?.discovery ? (
              <DiscoveryPostureCard posture={report.discovery} />
            ) : (
              <Card title="Shadow-AI active discovery">
                <p role="status">This gateway did not report its discovery posture, so it is unknown.</p>
              </Card>
            )}
          </PosturePanel>
        </QueryGate>
      </div>
    </>
  );
}

function PosturePanel(props: { id: string; tab: string; children: ReactNode }) {
  const ids = tabIds("posture", props.id);
  return (
    <div role="tabpanel" id={ids.panel} aria-labelledby={ids.tab} hidden={props.tab !== props.id}>
      {props.children}
    </div>
  );
}
