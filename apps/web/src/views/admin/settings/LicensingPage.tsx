/**
 * Licensing & seats (ADR-0052).
 *
 * Four things this page exists to keep honest, RENDERED rather than merely
 * documented:
 *
 *  - **Verification is offline.** `phoneHome: false` and the pinned keyring
 *    come from the API and are shown. There is no license server to reach.
 *  - **Expiry degrades, it does not stop.** The three action classes are
 *    rendered with their actual decisions, so an admin can SEE that governance
 *    is still permitted while expansion is refused.
 *  - **A missing license is not an error.** The unlicensed state is shown as an
 *    explicit, calm state with every tier feature closed — not as a failure.
 *  - **Nothing runs on a timer.** `lastVerifiedAt` and `schedulerPresent` are
 *    on the page, so a deployment that never wires the cron sees that.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import { ago } from "../../../api/format";
import { PageHeader } from "../../../shell/AppShell";
import { Badge, Button, Card, EmptyState, Field, Table, Textarea } from "../../../ui/kit";
import { KV, QueryGate, Stat, useAction } from "../adminKit";
import a from "../admin.module.css";
import v from "../../views.module.css";

interface ActionDecision {
  allowed: boolean;
  ruleId: string;
  reason: string;
}
interface Status {
  licensed: boolean;
  state: "absent" | "not_yet_valid" | "valid" | "grace" | "expired";
  reason: string;
  tenant: string | null;
  tier: string | null;
  deploymentMode: string | null;
  expiresAt: string | null;
  graceEndsAt: string | null;
  daysRemaining: number | null;
  hardStopOnExpiry: boolean;
  seats: {
    active: number;
    cap: number | null;
    remaining: number | null;
    canProvision: boolean;
    ruleId: string;
    reason: string;
    definition: string;
  };
  features: Record<string, boolean>;
  actionClasses: { read: ActionDecision; governance: ActionDecision; expansion: ActionDecision };
  inventory: Array<{ action: string; class: string; why: string }>;
  keyring: { dir: string; pinnedKeyIds: string[] };
  lastVerifiedAt: string | null;
  schedulerPresent: boolean;
  phoneHome: boolean;
  enforcementPointsWired: string[];
  posture: string;
  note: string;
}
interface LicenseRow {
  id: string;
  licenseId: string;
  tenant: string;
  tier: string;
  seatCap: number;
  deploymentMode: string;
  status: string;
  signingKeyId: string;
  expiresAt: string;
  installedAt: string;
}
interface VerificationRow {
  id: string;
  at: string;
  trigger: string;
  ok: boolean;
  state: string;
  ruleId: string;
  reason: string;
  signingKeyId: string | null;
}

const stateTone = (s: Status["state"]) =>
  s === "valid" ? "ok" : s === "grace" ? "warn" : s === "absent" ? "neutral" : "danger";

export default function LicensingPage() {
  const act = useAction();
  const [artifact, setArtifact] = useState("");

  const status = useQuery({
    queryKey: ["admin", "license-status"],
    queryFn: () => api.get<Status>("/v1/licenses/status"),
  });
  const history = useQuery({
    queryKey: ["admin", "license-history"],
    queryFn: () => api.get<{ licenses: LicenseRow[] }>("/v1/licenses"),
  });
  const checks = useQuery({
    queryKey: ["admin", "license-verifications"],
    queryFn: () => api.get<{ verifications: VerificationRow[] }>("/v1/licenses/verifications"),
  });

  const s = status.data;

  return (
    <>
      <PageHeader
        title="Licensing & seats"
        sub="The commercial ceiling that sits on top of the governance ceiling."
        info={<p>A license is a COMMERCIAL ceiling on top of the governance ceiling — it caps how many entitled users exist and which tier features are available, and can never grant an entitlement the governance layer denies. It is a signed file verified locally against a pinned public key, with no phone-home of any kind, because the flagship deployment is air-gapped and there is no home to phone.</p>}
      />
      <div className={v.stack}>
        <QueryGate loading={status.isLoading} error={status.error} onRetry={() => void status.refetch()}>
          <Card title="Current state">
            <div className={a.statRow}>
              <Stat value={<Badge tone={stateTone(s?.state ?? "absent")}>{s?.state ?? "—"}</Badge>} label="license state" />
              <Stat value={s?.tenant ?? <span className={v.faint}>unlicensed</span>} label="tenant" />
              <Stat value={s?.tier ?? <span className={v.faint}>—</span>} label="tier" />
              <Stat value={s?.deploymentMode ?? <span className={v.faint}>—</span>} label="deployment mode grant" />
              <Stat
                value={`${s?.seats.active ?? 0}${s?.seats.cap == null ? "" : ` / ${s.seats.cap}`}`}
                label="active seats"
              />
              <Stat
                value={<Badge tone={s?.phoneHome ? "danger" : "ok"}>{s?.phoneHome ? "yes" : "no"}</Badge>}
                label="phones home"
              />
            </div>
            <div className={v.faint}>{s?.reason}</div>
            {s && !s.licensed && (
              <EmptyState
                title="This deployment is UNLICENSED — and that is a state, not a failure"
                body="Governance, approvals, guardrails and audit logging are fully operational. Every tier feature is closed and no seat cap is enforced, because there is no authoritative number to enforce. Install a signed license below to make seats and tier features real."
              />
            )}
            {s?.state === "grace" && (
              <div className={v.faint}>
                <Badge tone="warn">grace</Badge> This license expired on {s.expiresAt} and the grace window ends{" "}
                {s.graceEndsAt}. Everything still works. When the window closes the deployment freezes at its current
                footprint and keeps enforcing it.
              </div>
            )}
            {s?.hardStopOnExpiry && (
              <div className={v.faint}>
                <Badge tone="danger">hardStopOnExpiry</Badge> This license carries the opt-in total-shutdown flag.
                That is never our default — the default for a governance product is "stay governed" — and it is only
                present because it was explicitly requested.
              </div>
            )}
          </Card>

          <Card title="What still works, and what does not">
            {s && (
              <Table
                rows={[
                  { k: "read", label: "Reads (console, audit, reports)", d: s.actionClasses.read },
                  {
                    k: "governance",
                    label: "Governance / safety / audit (policy evaluation, entitlement checks, approvals, guardrails, audit logging)",
                    d: s.actionClasses.governance,
                  },
                  {
                    k: "expansion",
                    label: "Commercial expansion (new seats, agents, connectors, providers, tier features)",
                    d: s.actionClasses.expansion,
                  },
                ]}
                rowKey={(r) => r.k}
                columns={[
                  { key: "c", header: "Action class", render: (r) => r.label },
                  {
                    key: "a",
                    header: "Now",
                    render: (r) => (
                      <Badge tone={r.d.allowed ? "ok" : "danger"}>{r.d.allowed ? "permitted" : "refused"}</Badge>
                    ),
                  },
                  { key: "why", header: "Why", render: (r) => <span className={v.faint}>{r.d.reason}</span> },
                ]}
              />
            )}
            <div className={v.faint}>{s?.posture}</div>
          </Card>

          <Card title="Seats">
            {s && (
              <>
                <KV
                  rows={[
                    ["Active seats", s.seats.active],
                    ["Licensed cap", s.seats.cap ?? <span className={v.faint}>none — unlicensed</span>],
                    [
                      "Remaining",
                      s.seats.remaining == null ? (
                        <span className={v.faint}>n/a</span>
                      ) : (
                        <Badge tone={s.seats.remaining > 0 ? "ok" : "danger"}>{s.seats.remaining}</Badge>
                      ),
                    ],
                    [
                      "Can provision a new user",
                      <Badge tone={s.seats.canProvision ? "ok" : "danger"}>{s.seats.canProvision ? "yes" : "no"}</Badge>,
                    ],
                  ]}
                />
                <div className={v.faint}>{s.seats.reason}</div>
                <div className={v.faint}>{s.seats.definition}</div>
                <div className={v.faint}>
                  Seat enforcement is a <strong>growth</strong> gate, never a service gate. Going over cap — which
                  happens legitimately when a smaller license is installed onto a larger estate — refuses the next
                  provisioning and touches nobody who already exists. Nothing here can revoke, disable or degrade a
                  user for a seat-count reason.
                </div>
              </>
            )}
          </Card>

          <Card title="Tier features">
            {s && (
              <Table
                rows={Object.entries(s.features).map(([k, on]) => ({ k, on }))}
                rowKey={(r) => r.k}
                columns={[
                  { key: "f", header: "Feature", render: (r) => r.k },
                  {
                    key: "s",
                    header: "",
                    render: (r) => <Badge tone={r.on ? "ok" : "neutral"}>{r.on ? "granted" : "closed"}</Badge>,
                  },
                ]}
              />
            )}
            <div className={v.faint}>
              Any flag absent from the license defaults <strong>closed</strong>, so an older license simply does not
              unlock newer paid features rather than failing. A flag may cap how many model providers or PM adapters a
              tier connects — never <em>which</em>: the license never encodes a preferred vendor at any layer.
            </div>
          </Card>

          <Card title="Install a license">
            <div className={v.stack}>
              <Field label="Signed artifact (the JSON scripts/sign-license.sh emits)">
                <Textarea
                  rows={6}
                  value={artifact}
                  onChange={(e) => setArtifact(e.target.value)}
                  placeholder='{"documentBase64":"...","signature":"...","signingKeyId":"regulait-license-2026"}'
                />
              </Field>
              <div className={a.formRow}>
                <Button
                  disabled={act.busy || !artifact.trim()}
                  onClick={() =>
                    void act.run(async () => {
                      await api.post("/v1/licenses", JSON.parse(artifact));
                      setArtifact("");
                      await Promise.all([status.refetch(), history.refetch(), checks.refetch()]);
                      return "License installed";
                    })
                  }
                >
                  Install
                </Button>
                <Button
                  variant="ghost"
                  disabled={act.busy}
                  onClick={() =>
                    void act.run(async () => {
                      const r = await api.post<{ ok: boolean; state: string }>("/v1/licenses/verify", {});
                      await Promise.all([status.refetch(), checks.refetch()]);
                      return r.ok ? `Verified — ${r.state}` : "VERIFICATION FAILED — see the trail below";
                    })
                  }
                >
                  Re-verify now
                </Button>
              </div>
              <div className={v.faint}>
                Verification is entirely local: the signature is checked against a public key already on this machine.
                A license signed by a key this deployment does not pin is refused <strong>even if its signature is
                internally valid</strong> — that is what pinning means. A tampered or forged artifact is refused
                outright and never displaces the license already in force.
              </div>
              {s && (
                <KV
                  rows={[
                    ["Pinned keyring", <code>{s.keyring.dir}</code>],
                    ["Pinned key ids", s.keyring.pinnedKeyIds.join(", ") || <span className={v.faint}>none</span>],
                    [
                      "Last verified",
                      s.lastVerifiedAt ? ago(s.lastVerifiedAt) : <span className={v.faint}>never</span>,
                    ],
                    [
                      "In-process scheduler",
                      <Badge tone={s.schedulerPresent ? "ok" : "warn"}>{s.schedulerPresent ? "yes" : "no"}</Badge>,
                    ],
                    ["Enforcement points wired", s.enforcementPointsWired.join(", ")],
                  ]}
                />
              )}
              <div className={v.faint}>{s?.note}</div>
            </div>
          </Card>

          <Card title="Action-class inventory">
            <div className={v.faint}>
              Every enforcement point must classify itself as safety (fails open past expiry) or expansion (fails
              closed). A miscategorised path is a real bug, so the classification is data rather than scattered
              conditions, and it is served here so it can be reviewed in one screen.
            </div>
            {s && (
              <Table
                rows={s.inventory}
                rowKey={(r) => r.action}
                columns={[
                  { key: "a", header: "Action", render: (r) => <code>{r.action}</code> },
                  {
                    key: "c",
                    header: "Class",
                    render: (r) => (
                      <Badge tone={r.class === "expansion" ? "warn" : r.class === "governance" ? "ok" : "neutral"}>
                        {r.class}
                      </Badge>
                    ),
                  },
                  { key: "w", header: "Why", render: (r) => <span className={v.faint}>{r.why}</span> },
                ]}
              />
            )}
          </Card>

          <Card title="Installed licenses">
            {(history.data?.licenses.length ?? 0) === 0 ? (
              <EmptyState title="No license has ever been installed" body="The history is append-only: installing a new license supersedes the previous one and deletes nothing." />
            ) : (
              <Table
                rows={history.data!.licenses}
                rowKey={(l) => l.id}
                columns={[
                  { key: "id", header: "License id", render: (l) => l.licenseId },
                  { key: "t", header: "Tenant", render: (l) => l.tenant },
                  { key: "tier", header: "Tier", render: (l) => l.tier },
                  { key: "seats", header: "Seat cap", render: (l) => l.seatCap },
                  { key: "m", header: "Mode", render: (l) => l.deploymentMode },
                  { key: "k", header: "Signed by", render: (l) => <code>{l.signingKeyId}</code> },
                  { key: "e", header: "Expires", render: (l) => l.expiresAt.slice(0, 10) },
                  {
                    key: "s",
                    header: "Status",
                    render: (l) => <Badge tone={l.status === "active" ? "ok" : "neutral"}>{l.status}</Badge>,
                  },
                  { key: "at", header: "Installed", render: (l) => ago(l.installedAt) },
                ]}
              />
            )}
          </Card>

          <Card title="Verification trail">
            {(checks.data?.verifications.length ?? 0) === 0 ? (
              <EmptyState
                title="Nothing has ever been verified on this deployment"
                body="Every install, every operator-driven check and every refusal lands here — including artifacts that were refused and therefore never became a license."
              />
            ) : (
              <Table
                rows={checks.data!.verifications}
                rowKey={(c) => c.id}
                columns={[
                  { key: "at", header: "When", render: (c) => ago(c.at) },
                  { key: "t", header: "Trigger", render: (c) => c.trigger },
                  {
                    key: "ok",
                    header: "",
                    render: (c) => <Badge tone={c.ok ? "ok" : "danger"}>{c.ok ? "ok" : "REFUSED"}</Badge>,
                  },
                  { key: "s", header: "State", render: (c) => c.state },
                  { key: "r", header: "Rule", render: (c) => <code>{c.ruleId}</code> },
                  { key: "why", header: "Reason", render: (c) => <span className={v.faint}>{c.reason}</span> },
                ]}
              />
            )}
          </Card>
        </QueryGate>
      </div>
    </>
  );
}
