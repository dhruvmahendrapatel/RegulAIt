/**
 * Continuous red-teaming (ADR-0057).
 *
 * The screen where adversarial testing is authored, run and read. Four things
 * it exists to keep honest, rendered rather than merely documented:
 *
 *  - **Green never means safe.** The coverage disclosure comes back on every
 *    red-team response and is rendered at the top of the page, next to the
 *    numbers rather than in a footnote. A passing run says "no probe in this
 *    library version succeeded", and the page says exactly that.
 *  - **Every attack class states what it CANNOT tell you.** The `limits`
 *    string comes straight from the class's own definition, beside where a
 *    person reads its score.
 *  - **The library is versioned data, and it freezes.** A published library is
 *    an ADR-0044 eval dataset; from then on the probe editor is replaced by
 *    "mint the next version", because a result stamped with a library version
 *    is meaningless if the library can move underneath it.
 *  - **Nothing here schedules anything.** The scheduler admission from the API
 *    is rendered verbatim: an operator or cron drives runs, and a missed
 *    schedule is silent.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import { ago } from "../../../api/format";
import { PageHeader } from "../../../shell/AppShell";
import { Badge, Button, Card, EmptyState, Field, Input, Select, SeverityBadge, Table, Textarea } from "../../../ui/kit";
import { QueryGate, agentOpts, optionEls, projectOpts, useAction, useAgents, useProjects } from "../adminKit";
import a from "../admin.module.css";
import v from "../../views.module.css";

interface AttackClassInfo {
  id: string;
  summary: string;
  limits: string;
}
interface LibraryRow {
  id: string;
  name: string;
  version: number;
  note: string | null;
  status: string;
  evalDatasetId: string | null;
  probeCount: number;
  frozen: boolean;
  createdAt: string;
}
interface ProbeRow {
  id: string;
  probeKey: string;
  attackClass: string;
  severity: string;
  input: string;
  scorerKind: string;
  note: string | null;
}
interface ClassAggregate {
  attackClass: string;
  probes: number;
  resisted: number;
  defeated: number;
  resistRate: number;
  meanScore: number;
  worstDefeatedSeverity: string | null;
}
interface RunRow {
  id: string;
  libraryName: string;
  libraryVersion: number;
  agentName: string;
  trigger: string;
  probes: number;
  resisted: number;
  defeated: number;
  resistRate: number | null;
  gatePassed: boolean | null;
  regression: boolean;
  gateReason: string | null;
  classSummary: ClassAggregate[];
  startedAt: string;
}
interface FindingRow {
  id: string;
  probeKey: string;
  attackClass: string;
  severity: string;
  score: number;
  outputSnippet: string | null;
}

const pct = (n: number | null | undefined) => (n == null ? "—" : `${Math.round(n * 100)}%`);

export default function RedTeamPage() {
  const agents = useAgents();
  const projects = useProjects();
  const act = useAction();

  const classes = useQuery({
    queryKey: ["admin", "redteam-classes"],
    queryFn: () =>
      api.get<{ attackClasses: AttackClassInfo[]; disclosure: string; scheduling: string }>(
        "/v1/redteam/attack-classes",
      ),
  });
  const libraries = useQuery({
    queryKey: ["admin", "redteam-libraries"],
    queryFn: () => api.get<{ libraries: LibraryRow[]; note: string }>("/v1/redteam/libraries"),
  });
  const runs = useQuery({
    queryKey: ["admin", "redteam-runs"],
    queryFn: () => api.get<{ runs: RunRow[] }>("/v1/redteam/runs?limit=100"),
  });

  const [selectedLibrary, setSelectedLibrary] = useState<string>("");
  const [selectedRun, setSelectedRun] = useState<string>("");

  const libDetail = useQuery({
    queryKey: ["admin", "redteam-library", selectedLibrary],
    enabled: Boolean(selectedLibrary),
    queryFn: () =>
      api.get<{ library: LibraryRow; probes: ProbeRow[]; frozen: boolean; disclosure: string }>(
        `/v1/redteam/libraries/${selectedLibrary}`,
      ),
  });
  const runDetail = useQuery({
    queryKey: ["admin", "redteam-run", selectedRun],
    enabled: Boolean(selectedRun),
    queryFn: () =>
      api.get<{ run: RunRow; findings: FindingRow[]; baseline: RunRow | null }>(
        `/v1/redteam/runs/${selectedRun}`,
      ),
  });

  // --- probe form
  const [pKey, setPKey] = useState("");
  const [pClass, setPClass] = useState("prompt_injection");
  const [pSeverity, setPSeverity] = useState("high");
  const [pInput, setPInput] = useState("");
  const [pForbidden, setPForbidden] = useState("");

  // --- run form
  const [runAgent, setRunAgent] = useState("");
  const [runProject, setRunProject] = useState("");

  const refetchAll = async () => {
    await libraries.refetch();
    await libDetail.refetch();
  };

  return (
    <>
      <PageHeader
        title="Red-teaming"
        sub="Adversarial probes run through the SAME governed dispatch as real traffic — entitlements, guardrails, metering and audit all apply — so a run measures the guardrail-plus-model system as deployed. A published attack library is an ordinary evaluation dataset, so a regression blocks promotion through the existing automated-check gate rather than a second mechanism."
      />
      <div className={v.stack}>
        <QueryGate
          loading={classes.isLoading || libraries.isLoading}
          error={classes.error ?? libraries.error}
          onRetry={() => {
            void classes.refetch();
            void libraries.refetch();
          }}
        >
          <Card title="What a green run does and does not mean">
            <div style={{ marginBottom: "var(--s2)" }}>{classes.data?.disclosure}</div>
            <div className={v.faint}>{classes.data?.scheduling}</div>
          </Card>

          <Card title="Attack classes, and what each one cannot tell you">
            <Table
              rows={classes.data?.attackClasses ?? []}
              rowKey={(r) => r.id}
              columns={[
                { key: "id", header: "Class", render: (r) => <code>{r.id}</code> },
                { key: "summary", header: "What it probes", render: (r) => r.summary },
                {
                  key: "limits",
                  header: "What it cannot tell you",
                  render: (r) => <span className={v.faint}>{r.limits}</span>,
                },
              ]}
            />
          </Card>

          <Card title="Attack libraries">
            <div className={v.faint} style={{ marginBottom: "var(--s2)" }}>
              {libraries.data?.note}
            </div>
            <div className={a.formRow} style={{ marginBottom: "var(--s2)" }}>
              <Button
                onClick={() =>
                  void act.run(async () => {
                    await api.post("/v1/redteam/libraries/seed", {});
                    await libraries.refetch();
                  }, "Shipped corpus installed")
                }
              >
                Install the shipped corpus
              </Button>
            </div>
            <Table
              rows={libraries.data?.libraries ?? []}
              rowKey={(r) => r.id}
              onRowClick={(r) => setSelectedLibrary(r.id)}
              columns={[
                { key: "name", header: "Library", render: (r) => `${r.name} v${r.version}` },
                { key: "probes", header: "Probes", render: (r) => r.probeCount },
                {
                  key: "status",
                  header: "Status",
                  render: (r) => (
                    <Badge tone={r.frozen ? "ok" : "info"}>{r.frozen ? "published (frozen)" : "draft"}</Badge>
                  ),
                },
                { key: "created", header: "Created", render: (r) => ago(r.createdAt) },
              ]}
            />
          </Card>

          {selectedLibrary && libDetail.data ? (
            <Card title={`${libDetail.data.library.name} v${libDetail.data.library.version}`}>
              {libDetail.data.frozen ? (
                <div className={v.faint} style={{ marginBottom: "var(--s2)" }}>
                  This version is published and immutable — every result stamped with it stays readable. Mint the
                  next version to add attacks.
                </div>
              ) : (
                <form
                  className={a.formRow}
                  onSubmit={(e) => {
                    e.preventDefault();
                    void act.run(async () => {
                      await api.post(`/v1/redteam/libraries/${selectedLibrary}/probes`, {
                        probeKey: pKey,
                        attackClass: pClass,
                        severity: pSeverity,
                        input: pInput,
                        scorerKind: "contains",
                        scorerConfig: {
                          forbidden: pForbidden
                            .split("\n")
                            .map((s) => s.trim())
                            .filter(Boolean),
                        },
                      });
                      setPKey("");
                      setPInput("");
                      setPForbidden("");
                      await refetchAll();
                    }, "Probe added");
                  }}
                >
                  <Field label="Probe key">
                    <Input value={pKey} onChange={(e) => setPKey(e.target.value)} required />
                  </Field>
                  <Field label="Attack class">
                    <Select value={pClass} onChange={(e) => setPClass(e.target.value)}>
                      {optionEls((classes.data?.attackClasses ?? []).map((c) => ({ v: c.id, l: c.id })))}
                    </Select>
                  </Field>
                  <Field label="Severity">
                    <Select value={pSeverity} onChange={(e) => setPSeverity(e.target.value)}>
                      {optionEls(["low", "medium", "high", "critical"].map((s) => ({ v: s, l: s })))}
                    </Select>
                  </Field>
                  <Field label="Probe prompt" grow>
                    <Textarea value={pInput} onChange={(e) => setPInput(e.target.value)} required rows={3} />
                  </Field>
                  <Field label="Disclosure markers (one per line) — the probe FAILS if any appears" grow>
                    <Textarea value={pForbidden} onChange={(e) => setPForbidden(e.target.value)} rows={3} />
                  </Field>
                  <Button type="submit">Add probe</Button>
                  <Button
                    variant="ghost"
                    onClick={() =>
                      void act.run(async () => {
                        await api.post(`/v1/redteam/libraries/${selectedLibrary}/publish`, {});
                        await refetchAll();
                      }, "Published as an evaluation dataset")
                    }
                  >
                    Publish
                  </Button>
                </form>
              )}
              <Table
                rows={libDetail.data.probes}
                rowKey={(r) => r.id}
                columns={[
                  { key: "key", header: "Probe", render: (r) => <code>{r.probeKey}</code> },
                  { key: "class", header: "Class", render: (r) => r.attackClass },
                  {
                    key: "sev",
                    header: "Severity",
                    render: (r) => <SeverityBadge severity={r.severity} />,
                  },
                  { key: "oracle", header: "Oracle", render: (r) => <code>{r.scorerKind}</code> },
                  { key: "note", header: "Why", render: (r) => <span className={v.faint}>{r.note}</span> },
                ]}
              />
            </Card>
          ) : null}

          <Card title="Run a suite">
            <form
              className={a.formRow}
              onSubmit={(e) => {
                e.preventDefault();
                void act.run(async () => {
                  await api.post("/v1/redteam/runs", {
                    libraryId: selectedLibrary,
                    agentId: runAgent,
                    projectId: runProject || undefined,
                  });
                  await runs.refetch();
                }, "Red-team run completed");
              }}
            >
              <Field label="Library">
                <Select value={selectedLibrary} onChange={(e) => setSelectedLibrary(e.target.value)} required>
                  {optionEls(
                    (libraries.data?.libraries ?? [])
                      .filter((l) => l.frozen)
                      .map((l) => ({ v: l.id, l: `${l.name} v${l.version}` })),
                    "Select a published library",
                  )}
                </Select>
              </Field>
              <Field label="Agent under test">
                <Select value={runAgent} onChange={(e) => setRunAgent(e.target.value)} required>
                  {optionEls(agentOpts(agents.data?.agents), "Select an agent")}
                </Select>
              </Field>
              <Field label="Bill to project">
                <Select value={runProject} onChange={(e) => setRunProject(e.target.value)}>
                  {optionEls(projectOpts(projects.data?.projects), "Unattributed")}
                </Select>
              </Field>
              <Button type="submit">Run</Button>
            </form>
          </Card>

          <Card title="Runs">
            {(runs.data?.runs ?? []).length === 0 ? (
              <EmptyState title="No red-team runs yet" body="Install the shipped corpus, publish it, and run it against an agent." />
            ) : (
              <Table
                rows={runs.data?.runs ?? []}
                rowKey={(r) => r.id}
                onRowClick={(r) => setSelectedRun(r.id)}
                columns={[
                  { key: "agent", header: "Agent", render: (r) => r.agentName },
                  { key: "lib", header: "Library", render: (r) => `${r.libraryName} v${r.libraryVersion}` },
                  { key: "trigger", header: "Trigger", render: (r) => r.trigger },
                  { key: "resist", header: "Resisted", render: (r) => `${r.resisted}/${r.probes} (${pct(r.resistRate)})` },
                  {
                    key: "gate",
                    header: "Gate",
                    render: (r) => (
                      <Badge tone={r.gatePassed === false ? "danger" : "ok"}>
                        {r.gatePassed === false ? (r.regression ? "regression" : "failed") : "no known regression"}
                      </Badge>
                    ),
                  },
                  { key: "when", header: "When", render: (r) => ago(r.startedAt) },
                ]}
              />
            )}
          </Card>

          {selectedRun && runDetail.data ? (
            <Card title="Run detail">
              <div className={v.faint} style={{ marginBottom: "var(--s2)" }}>
                {runDetail.data.run.gateReason}
              </div>
              <Table
                rows={runDetail.data.run.classSummary ?? []}
                rowKey={(r) => r.attackClass}
                columns={[
                  { key: "class", header: "Class", render: (r) => <code>{r.attackClass}</code> },
                  { key: "probes", header: "Probes", render: (r) => r.probes },
                  { key: "resist", header: "Resist rate", render: (r) => pct(r.resistRate) },
                  {
                    key: "worst",
                    header: "Worst defeat",
                    render: (r) =>
                      r.worstDefeatedSeverity ? (
                        <SeverityBadge severity={r.worstDefeatedSeverity} />
                      ) : (
                        <span className={v.faint}>none</span>
                      ),
                  },
                ]}
              />
              <div style={{ marginTop: "var(--s3)" }}>
                <Table
                  rows={runDetail.data.findings}
                  rowKey={(r) => r.id}
                  columns={[
                    { key: "probe", header: "Probe that got through", render: (r) => <code>{r.probeKey}</code> },
                    { key: "class", header: "Class", render: (r) => r.attackClass },
                    {
                      key: "sev",
                      header: "Severity",
                      render: (r) => <SeverityBadge severity={r.severity} />,
                    },
                    {
                      key: "out",
                      header: "What the agent produced",
                      render: (r) => <span className={v.faint}>{(r.outputSnippet ?? "").slice(0, 240)}</span>,
                    },
                  ]}
                />
              </div>
            </Card>
          ) : null}
        </QueryGate>
      </div>
    </>
  );
}
