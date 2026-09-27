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
 * Every control this product is sold on ships OFF — each default deliberate,
 * because an existing deployment must behave identically across an upgrade —
 * and the consequence was that nobody could answer "so what is enforcing right
 * now?" without reading the schema.
 *
 * THE READ IS THE POINT, NOT THE BUTTON. The column that earns this page its
 * place is "what turning it on would refuse". A posture screen that lists
 * switches without their blast radius invites an admin to harden a live
 * deployment on a Friday afternoon, and the API deliberately returns that
 * sentence per control so the UI never has to invent one.
 *
 * Three honesty rules the UI keeps rather than leaving to the ADR:
 *
 *  - The two environment-backed controls (the WORM audit anchor, the
 *    scheduler) render as NOT SETTABLE with their OBSERVED state, never as a
 *    switch. An API call cannot set an environment variable, and a button that
 *    implied otherwise would be a lie with a cursor on it.
 *  - The overall verdict stays "not hardened" while those two are unmet even
 *    when every settable control is satisfied — so the headline can read
 *    "5 of 7" and mean it.
 *  - Optimisation is shown as its own group and is NOT included in the default
 *    harden action. An admin hardening a regulated deployment is not thereby
 *    asking to serve more answers from cache.
 */
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../../../api/client";
import { PageHeader } from "../../../shell/AppShell";
import { Badge, Button, Card, EmptyState, Table } from "../../../ui/kit";
import { QueryGate, Stat, useAction } from "../adminKit";
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
        sub="What is enforcing in this deployment right now. Every control below ships OFF."
        info={<p>What is enforcing in this deployment right now — and, per control, what turning it on would start refusing. Every control below ships OFF so that an existing install behaves identically across an upgrade; that makes a fresh deployment's posture a decision somebody has to take deliberately rather than one it arrives with.</p>}
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
      </div>
    </>
  );
}
