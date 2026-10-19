/**
 * Shadow-AI discovery (ADR-0055).
 *
 * Four things this page exists to keep honest, RENDERED rather than merely
 * documented:
 *
 *  - **No collector ships.** The coverage scorecard's own `statement` is
 *    printed at the top of the inventory, so a number can never appear without
 *    the caveat that it derives from evidence the customer supplied.
 *  - **The catalogue is data.** It is edited here, as rows, with `provenance`
 *    and `lastUpdatedAt` on every one — so an admin can see how fresh their
 *    detection surface is and add a private in-house endpoint without a release.
 *  - **Detection is signal, not proof.** Every finding carries a disposition
 *    the operator sets (`sanctioned`, `false_positive`, …) with a required
 *    reason. There is no "resolve" button that silences a row without a record.
 *  - **A finding points at its replacement.** The governed agent that would
 *    replace the ungoverned usage is on the row, because a finding without one
 *    is a complaint rather than a next step.
 *
 * ADR-0071 added a FORMAT-ADAPTER layer under the row-shaped import above, and
 * disclosed that it had no screen. It has one now — the "Import a raw log file"
 * card — and it carries three things the ADR insists on:
 *
 *  - **Each adapter's `verification` sentence is printed VERBATIM.** Several of
 *    them say outright that they implement a published grammar but have never
 *    been run against a real export from any vendor's product. That sentence is
 *    the honest part of the feature and it must reach the operator BEFORE they
 *    trust a parse, not in an ADR afterwards.
 *  - **Every refusal names its 1-based file line**, so a `rows.417` schema path
 *    becomes "line 418 of the file you have open".
 *  - **The default refuses the WHOLE FILE** when any line will not parse. A
 *    quietly smaller inventory that looks complete is the one unrecoverable
 *    failure for a discovery product; `report_and_continue` is the explicit
 *    opt-in and is labelled as such.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import { ago, evidenceLabel, humanize, plural, providerLabel } from "../../../api/format";
import { PageHeader } from "../../../shell/AppShell";
import { Badge, Button, Card, CodeBlock, EmptyState, Field, InfoButton, Input, RowActions, Select, SeverityBadge, Table, Tabs, tabIds, Textarea } from "../../../ui/kit";
import {
  OutcomePanel,
  QueryGate,
  RefusalList,
  Stat,
  optionEls,
  useAction,
  useApiAction,
  type RowRefusal,
} from "../adminKit";
import a from "../admin.module.css";
import { ShadowRemediationPanel } from "./ShadowRemediationPanel";
import { DetailDrawer } from "../../../ui/DetailDrawer";
import { DiscoverySightings } from "./DiscoverySightings";
import type { SightingView } from "./discoverySourcesModel";
import v from "../../views.module.css";
import sh from "./shadowAi.module.css";

interface Signature {
  id: string;
  provider: string;
  kind: string;
  value: string;
  matchType: string;
  minLength: number | null;
  replacementAgentId: string | null;
  replacementNote: string | null;
  provenance: string;
  enabled: boolean;
  lastUpdatedAt: string;
  /** ADR-0195 SD0: scope, tool id, note, confidence */
  os?: string | null;
  ecosystem?: string | null;
  toolId?: string | null;
  note?: string | null;
  confidence?: "high" | "medium" | "low";
}
interface CatalogueResponse {
  signatures: Signature[];
  total: number;
  enabled: number;
  oldestEntryAt: string | null;
  posture: string;
}
interface Finding {
  id: string;
  subjectKind: string;
  subject: string;
  provider: string;
  signalSources: string[];
  severity: string;
  confidence: string;
  disposition: string;
  observationCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  replacementAgent: { id: string; name: string; provider: string; enabled: boolean } | null;
  replacementNote: string | null;
  dispositionStale: boolean;
  /** ADR-0195: the bounded sightings (location, names, actor pseudonym) */
  evidence?: SightingView[];
}
interface FindingsResponse {
  findings: Finding[];
  coverage: {
    sources: Array<{ kind: string; on: boolean; imports: number; rows: number; whatItSees: string; whatItMisses: string }>;
    sourcesOn: number;
    sourcesPossible: number;
    statement: string;
  };
  posture: string;
}
interface ImportRow {
  id: string;
  kind: string;
  mode: string;
  status: string;
  rowCount: number;
  reason: string;
  createdAt: string;
}

// ---- ADR-0071: the format adapters ---------------------------------------

interface EvidenceAdapterInfo {
  id: string;
  displayName: string;
  formats: string[];
  capabilities: {
    destinationHost: boolean;
    sourceIdentity: boolean;
    perRowTimestamp: boolean;
    requestCount: boolean;
    selfDescribing: boolean;
    kinds: string[];
  };
  /** `published-spec` | `declared-format` | `operator-mapped` */
  formatBasis: string;
  /** WHAT HAS AND HAS NOT BEEN CHECKED — printed verbatim, never paraphrased */
  verification: string;
  limits: string;
}

interface AdaptersResponse {
  adapters: EvidenceAdapterInfo[];
  posture: string;
  pipeline: string;
}

// ---- ADR-0083: first-party discovery -------------------------------------

interface DiscoveryCatalogEntry {
  id: string;
  kind: string;
  pattern: string;
  provider: string;
  notes: string;
}
interface DiscoveryCatalogResponse {
  catalogVersion: number;
  total: number;
  endpoints: number;
  sdks: number;
  entries: DiscoveryCatalogEntry[];
  governedHosts: Array<{ host: string; reason: string }>;
  posture: string;
  limits: string;
}
interface DiscoveryHit {
  value: string;
  kind: string;
  entryId: string | null;
  provider: string | null;
  occurrences: number;
  origins?: string[];
  governedReason?: string | null;
}
interface DiscoveryResult {
  mode: string;
  classification: {
    catalogVersion: number;
    sourceKind: string;
    linesScanned: number;
    candidateCount: number;
    shadowCount: number;
    governedCount: number;
    unmatchedCount: number;
    unmatchedOccurrences: number;
    unmatchedSample: string[];
  };
  matches: DiscoveryHit[];
  governed: DiscoveryHit[];
  deploymentCatalogueGaps: Array<{ value: string; kind: string; provider: string | null; entryId: string | null }>;
  gapNote?: string | null;
  ingest: {
    importId: string;
    mode: string;
    observed: number;
    matched: number;
    unmatched: number;
    created?: number;
    updated?: number;
  } | null;
  rawContentStored: boolean;
  retention: string;
  posture: string;
}
interface McpDiscoveryResult {
  posture: string;
  observed: number;
  unregistered: number;
  registryCount: number;
  results: Array<{
    host: string;
    path: string | null;
    indicators: string[];
    confidence: string;
    occurrences: number;
    samples: string[];
    registered: boolean;
    registeredAs: string | null;
    verdict: string;
  }>;
}

const DISCOVERY_KINDS: Array<{ v: string; l: string }> = [
  { v: "dns_log", l: "DNS query log (generic lines)" },
  { v: "proxy_log", l: "Proxy / egress log (generic lines)" },
  { v: "package_json", l: "package.json manifest" },
  { v: "requirements_txt", l: "requirements.txt manifest" },
  { v: "go_mod", l: "go.mod manifest" },
];

interface RawImportResult {
  importId?: string;
  adapter: string;
  kind: string;
  rowsParsed: number;
  rowsAccepted: number;
  rowsRefused: number;
  rowsWithoutTimestamp: number;
  refusals: RowRefusal[];
  fieldsUsed: string[];
  limits: string;
  verification: string;
  posture: string;
  [k: string]: unknown;
}

const FORMAT_BASIS_TONE: Record<string, "ok" | "warn" | "info"> = {
  "published-spec": "ok",
  "declared-format": "warn",
  "operator-mapped": "info",
};

const FORMAT_BASIS_WORD: Record<string, string> = {
  "published-spec": "published grammar",
  "declared-format": "declared format (unverified)",
  "operator-mapped": "you mapped it",
};

/** the adapters whose config the operator MUST supply, and why */
const ADAPTER_CONFIG_HINT: Record<string, string> = {
  proxy_common:
    'REQUIRED: {"layout":"squid"} — or "common" / "combined". These formats carry no header, so the layout is an operator assertion and is never sniffed: a mis-declared layout would read the client-IP column as the destination.',
  generic_mapped:
    'REQUIRED: {"kind":"egress_log"} (or code_scan / saas_export / self_reported). Add "mapping" to name the columns yourself; omit it and header inference proposes them and REFUSES on ambiguity.',
};

const EXAMPLE = JSON.stringify(
  {
    kind: "egress_log",
    mode: "dry_run",
    source: "acme forward proxy, week 31",
    rows: [{ observedAt: "2026-07-28T09:00:00Z", destinationHost: "api.openai.com", sourceIdentity: "build-runner-01", requestCount: 412 }],
  },
  null,
  2,
);

export default function ShadowAiPage() {
  const catalogue = useQuery({ queryKey: ["shadow-ai", "catalogue"], queryFn: () => api.get<CatalogueResponse>("/v1/shadow-ai/catalogue") });
  const findings = useQuery({ queryKey: ["shadow-ai", "findings"], queryFn: () => api.get<FindingsResponse>("/v1/shadow-ai/findings") });
  const imports = useQuery({ queryKey: ["shadow-ai", "imports"], queryFn: () => api.get<{ imports: ImportRow[] }>("/v1/shadow-ai/imports") });
  const adapters = useQuery({
    queryKey: ["shadow-ai", "adapters"],
    queryFn: () => api.get<AdaptersResponse>("/v1/shadow-ai/adapters"),
  });
  const discovery = useQuery({
    queryKey: ["shadow-ai", "discovery-catalog"],
    queryFn: () => api.get<DiscoveryCatalogResponse>("/v1/shadow-ai/discovery/catalog"),
  });
  const act = useAction();
  /** the raw importer keeps the STRUCTURED refusal — line numbers are the point */
  const rawAct = useApiAction();
  /** first-party discovery keeps the structured classification the same way */
  const discAct = useApiAction();
  const mcpAct = useApiAction();

  const [evidence, setEvidence] = useState(EXAMPLE);
  const [preview, setPreview] = useState<unknown>(null);
  const [dispositionFor, setDispositionFor] = useState<string | null>(null);
  const [remediationFor, setRemediationFor] = useState<string | null>(null);
  const [disposition, setDisposition] = useState("sanctioned");
  const [reason, setReason] = useState("");
  // A2: one tab per job; the tab is in the URL so a link (and a test) can open it directly
  const [params, setParams] = useSearchParams();
  const tab = TAB_IDS.includes(params.get("tab") ?? "") ? params.get("tab")! : "findings";
  const setTab = (next: string) => setParams((prev) => { const out = new URLSearchParams(prev); out.set("tab", next); return out; }, { replace: true });
  const [statusFilter, setStatusFilter] = useState<StatusGroup>("all");
  // A1: triage and the remediation plan open in the shared detail drawer, named after their row
  const dispositionRef = useRef<HTMLElement>(null);
  const closeRemediation = useCallback(() => setRemediationFor(null), []);
  const closeDisposition = useCallback(() => setDispositionFor(null), []);

  // ---- ADR-0071 raw-file import ----
  const [rawAdapter, setRawAdapter] = useState("cef");
  const [rawFormat, setRawFormat] = useState("text");
  const [rawContent, setRawContent] = useState("");
  const [rawSource, setRawSource] = useState("");
  const [rawConfig, setRawConfig] = useState("");
  const [onMalformed, setOnMalformed] = useState<"refuse_file" | "report_and_continue">("refuse_file");
  const [rawResult, setRawResult] = useState<RawImportResult | null>(null);
  const [rawFileError, setRawFileError] = useState<string | null>(null);

  // ---- ADR-0083 first-party discovery ----
  const [discKind, setDiscKind] = useState("dns_log");
  const [discSubject, setDiscSubject] = useState("");
  const [discContent, setDiscContent] = useState("");
  const [discResult, setDiscResult] = useState<DiscoveryResult | null>(null);
  const [mcpContent, setMcpContent] = useState("");
  const [mcpResult, setMcpResult] = useState<McpDiscoveryResult | null>(null);

  const refresh = () => {
    void catalogue.refetch();
    void findings.refetch();
    void imports.refetch();
  };

  const selectedAdapter = (adapters.data?.adapters ?? []).find((x) => x.id === rawAdapter) ?? null;

  const readRawFile = async (file: File | undefined) => {
    setRawFileError(null);
    if (!file) return;
    try {
      setRawContent(await file.text());
      setRawSource(file.name);
      const lower = file.name.toLowerCase();
      if (lower.endsWith(".json")) setRawFormat("json");
      else if (lower.endsWith(".csv")) setRawFormat("csv");
      else setRawFormat("text");
    } catch (e) {
      setRawFileError(e instanceof Error ? e.message : String(e));
    }
  };

  const submitRaw = async (mode: "dry_run" | "apply") => {
    setRawResult(null);
    let parsedConfig: unknown;
    if (rawConfig.trim()) {
      try {
        parsedConfig = JSON.parse(rawConfig) as unknown;
      } catch {
        rawAct.setOutcome({
          ok: false,
          code: "invalid_adapter_config",
          status: null,
          reason: "The adapter configuration box is not valid JSON. Nothing was sent.",
          payload: null,
        });
        return;
      }
    }
    const body: Record<string, unknown> = {
      adapter: rawAdapter,
      format: rawFormat,
      mode,
      content: rawContent,
      onMalformedRow: onMalformed,
    };
    if (rawSource.trim()) body.source = rawSource.trim();
    if (parsedConfig !== undefined) body.config = parsedConfig;

    const res = await rawAct.run<RawImportResult>(
      () => api.post<RawImportResult>("/v1/shadow-ai/imports/raw", body),
      mode === "dry_run"
        ? "File parsed and analyzed — nothing was written."
        : "File parsed and applied to the inventory.",
    );
    if (res) setRawResult(res);
    refresh();
  };

  const discIsManifest = discKind !== "dns_log" && discKind !== "proxy_log";

  const submitDiscovery = async (mode: "dry_run" | "apply") => {
    const body: Record<string, unknown> = { sourceKind: discKind, content: discContent, mode };
    if (discSubject.trim()) body.subject = discSubject.trim();
    const res = await discAct.run<DiscoveryResult>(
      () => api.post<DiscoveryResult>("/v1/shadow-ai/discovery", body),
      mode === "dry_run"
        ? "Classified — nothing was written. Review the split below, then confirm the ingest."
        : "Shadow-classified rows were ingested through the evidence pipeline.",
    );
    if (res) setDiscResult(res);
    if (mode === "apply") refresh();
  };

  const submitMcpDiscovery = async (mode: "preview" | "apply") => {
    const result = await mcpAct.run<McpDiscoveryResult>(
      () => api.post<McpDiscoveryResult>("/v1/shadow-ai/mcp-discovery", { content: mcpContent, mode }),
      mode === "preview" ? "MCP evidence compared with this deployment's registry — nothing was written." : "MCP discovery result recorded in the audit trail.",
    );
    if (result) setMcpResult(result);
  };

  const bySeverity = useMemo(() => {
    const out: Record<string, number> = { critical: 0, high: 0, medium: 0, low: 0 };
    for (const f of findings.data?.findings ?? []) out[f.severity] = (out[f.severity] ?? 0) + 1;
    return out;
  }, [findings.data]);

  const submitEvidence = async (mode: "dry_run" | "apply") => {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(evidence) as Record<string, unknown>;
    } catch {
      act.setError("that is not valid JSON");
      return;
    }
    const ok = await act.run(async () => {
      const res = await api.post<unknown>("/v1/shadow-ai/imports", { ...parsed, mode });
      setPreview(res);
    }, mode === "dry_run" ? "Evidence analyzed (nothing written)" : "Evidence applied to the inventory");
    if (ok) refresh();
  };

  const findingRows = (findings.data?.findings ?? []).filter((f) => statusFilter === "all" || statusGroup(f.disposition) === statusFilter);
  const statusCounts = useMemo(() => {
    const out: Record<string, number> = { all: 0, open: 0, confirmed: 0, closed: 0 };
    for (const f of findings.data?.findings ?? []) {
      out.all = (out.all ?? 0) + 1;
      const g = statusGroup(f.disposition);
      out[g] = (out[g] ?? 0) + 1;
    }
    return out;
  }, [findings.data]);
  const subjectOf = (id: string | null) => findings.data?.findings.find((f) => f.id === id)?.subject ?? "this finding";
  const panel = { id: "shadow", tab: tabIds("shadow", tab) };

  return (
    <>
      <PageHeader
        title="Shadow-AI discovery"
        sub="AI use that nobody registered, found in evidence you already hold. Triage each lead and bring it into governance."
        info={
          <>
            Shadow AI is AI use that is not registered or routed through regulAIt. Findings come from evidence:
            discovery scans and files you import. regulAIt does not watch live traffic, so coverage is only as wide as
            the evidence.
          </>
        }
        actions={
          <div className={v.row}>
            <Link to="/admin/shadow-ai/discovery-sources">Discovery sources</Link>
            <Button variant="primary" onClick={() => setTab("import")}>Import evidence</Button>
          </div>
        }
      />

      {/* five tabs outgrow a phone: the row scrolls on its own instead of widening the page */}
      <div className={sh.tabsScroll}>
      <Tabs
        tabs={[
          { id: "findings", label: `Findings · ${statusCounts.all ?? 0}` },
          { id: "coverage", label: "Coverage" },
          { id: "import", label: "Import evidence" },
          { id: "catalogue", label: "Detection catalogue" },
          { id: "history", label: "Import history" },
        ]}
        active={tab}
        onChange={setTab}
        idPrefix={panel.id}
      />
      </div>

      <div className={v.stack} role="tabpanel" id={panel.tab.panel} aria-labelledby={panel.tab.tab}>
      {tab === "findings" && (
        <>
      {/* what this can and cannot see, stated once, on the face of the page */}
      <div className={sh.callout} role="note">
        <span>
          <strong>What this can see.</strong> {findings.data?.coverage.statement ?? "Loading coverage…"}
          {findings.data?.posture ? <> {findings.data.posture}</> : null}{" "}
          <button type="button" className={sh.linkButton} onClick={() => setTab("coverage")}>See coverage</button>
        </span>
      </div>

      <div className={sh.kpis}>
        <KpiFigure tone="critical" value={bySeverity.critical} label="Critical" hint="Leaked credential"
          info="A live credential for an AI service was found, for example an API key in code or logs. Treat it as exposed: revoke it, then triage the finding." />
        <KpiFigure tone="high" value={bySeverity.high} label="High" hint="Observed model traffic"
          info="Evidence shows traffic to an AI model endpoint from a person, team or system with no registered use case." />
        <KpiFigure tone="medium" value={(bySeverity.medium ?? 0) + (bySeverity.low ?? 0)} label="Medium or low" hint="Looser signals to check" />
        <KpiFigure
          tone="low"
          value={`${findings.data?.coverage.sourcesOn ?? 0} / ${findings.data?.coverage.sourcesPossible ?? 4}`}
          label="Evidence classes supplied"
          info="regulAIt can use four kinds of evidence: network egress logs, code scans, SaaS and identity records, and self-reported use. Each kind not supplied is a blind spot."
        />
      </div>

      {/* the findings are the point of the page: they come straight after the figures */}
      <Card
        title="Inventory"
        contain
        actions={
          <div className={v.row} role="group" aria-label="Filter by status">
            {(["all", "open", "confirmed", "closed"] as const).map((g) => (
              <button key={g} type="button" className={sh.chip} aria-pressed={statusFilter === g} onClick={() => setStatusFilter(g)}>
                {STATUS_GROUP_LABEL[g]} {statusCounts[g] ?? 0}
              </button>
            ))}
          </div>
        }
      >
        <p className={v.faint}>Every row is a lead for triage, not a verdict.</p>
        <QueryGate loading={findings.isLoading} error={findings.error} onRetry={refresh}>
          {(findings.data?.findings.length ?? 0) === 0 ? (
            <EmptyState title="No findings yet" body="Import an egress-log, code-scan, SaaS or self-reported evidence file under Import evidence." />
          ) : findingRows.length === 0 ? (
            <EmptyState title="No finding has this status" body="Choose another status above." />
          ) : (
            <Table<Finding>
              rows={findingRows}
              rowKey={(r) => r.id}
              columns={[
                { key: "severity", header: "Severity", render: (r) => <SeverityBadge severity={r.severity} /> },
                { key: "subject", header: "Subject", // a floor so a name never wraps to one word per line
                  render: (r) => (
                    <span title={r.subjectKind} style={{ display: "inline-block", minWidth: "14ch" }}>
                      <strong>{r.subject}</strong>
                      <span className={v.dim} style={{ display: "block" }}>
                        {providerLabel(r.provider)}
                        {r.replacementAgent ? <> · alternative: {r.replacementAgent.name}</> : r.replacementNote ? <> · {r.replacementNote}</> : null}
                      </span>
                    </span>
                  ) },
                { key: "sources", header: "Evidence", render: (r) => (
                  <span className={v.row}>{r.signalSources.map((src) => <Badge key={src}>{evidenceLabel(src)}</Badge>)}</span>
                ) },
                { key: "confidence", header: "Confidence", info: CONFIDENCE_HELP,
                  render: (r) => <Badge tone={r.confidence === "high" ? "ok" : r.confidence === "medium" ? "warn" : "info"}>{humanize(r.confidence)}</Badge> },
                { key: "observations", header: "Seen", render: (r) => (
                  <span style={{ whiteSpace: "nowrap" }}>
                    {plural(r.observationCount, "time")}
                    <span className={v.dim} style={{ display: "block" }}>{ago(r.lastSeenAt)}</span>
                  </span>
                ) },
                // ADR-0195 SD0: where scanners saw it (path, line, commit), names seen, and who (as a pseudonym)
                { key: "sightings", header: "Where seen",
                  info: "Where the evidence was seen: file and line, commit, or log source, and the pseudonymised person involved.",
                  render: (r) => <DiscoverySightings evidence={r.evidence} collapsed /> },
                {
                  key: "disposition",
                  header: "Status",
                  info: DISPOSITION_HELP,
                  render: (r) => (
                    <span className={v.row}>
                      <Badge tone={r.disposition === "remediated" ? "ok" : r.disposition === "confirmed" ? "info" : "neutral"}>{DISPOSITION_LABEL[r.disposition] ?? humanize(r.disposition)}</Badge>
                      {r.dispositionStale ? (
                        <Badge tone="danger" info="New evidence arrived after this finding was closed. Review the disposition again.">Seen again</Badge>
                      ) : null}
                    </span>
                  ),
                },
                {
                  key: "triage",
                  header: "Next step",
                  render: (r) => {
                    const plan = (
                      <Button
                        variant={r.disposition === "open" || r.disposition === "confirmed" ? "primary" : "default"}
                        aria-label={`Remediation plan for ${r.subject}`}
                        aria-pressed={remediationFor === r.id}
                        onClick={() => { setDispositionFor(null); setRemediationFor(remediationFor === r.id ? null : r.id); }}
                      >
                        Remediation plan
                      </Button>
                    );
                    const triage = r.dispositionStale ? (
                      <Button onClick={() => { setRemediationFor(null); setDispositionFor(r.id); setReason(""); }}>Review again</Button>
                    ) : (
                      <Button variant="ghost" onClick={() => { setRemediationFor(null); setDispositionFor(r.id); setReason(""); }}>Triage</Button>
                    );
                    return (
                      <RowActions
                        slot="11rem"
                        stacked
                        primary={r.disposition === "open" || r.disposition === "confirmed" || r.dispositionStale ? plan : null}
                        secondary={triage}
                        rest={
                          <span className={v.stackTight} style={{ alignItems: "flex-start" }}>
                            {r.disposition === "open" || r.disposition === "confirmed" || r.dispositionStale ? null : plan}
                            <Link to={`/admin/governance/intake?source=shadow-ai&findingId=${encodeURIComponent(r.id)}&title=${encodeURIComponent(`Govern ${r.subject}`)}&description=${encodeURIComponent(`Register and govern the ${providerLabel(r.provider)} usage observed for ${r.subject}. Evidence: ${r.signalSources.map(evidenceLabel).join(", ")}.`)}`}>Register as use case</Link>
                          </span>
                        }
                      />
                    );
                  },
                },
              ]}
            />
          )}
        </QueryGate>
      </Card>

        {/* A1: a finding's remediation plan and its triage open in the one shared detail drawer */}
        {remediationFor ? (
          <DetailDrawer
            type="Remediation plan"
            title={subjectOf(remediationFor)}
            subjectKey={remediationFor}
            closeLabel="Close plan"
            meta={
              <InfoButton label="a remediation plan">
                A remediation plan turns a finding into tracked work: a governed workflow with a separate approver. Nothing
                changes until the workflow is approved.
              </InfoButton>
            }
            onClose={closeRemediation}
          >
            <ShadowRemediationPanel
              key={remediationFor}
              findingId={remediationFor}
              onClose={closeRemediation}
              onLinked={refresh}
              inDrawer
            />
          </DetailDrawer>
        ) : null}

        {dispositionFor ? (
          <DetailDrawer type="Triage" title={subjectOf(dispositionFor)} subjectKey={dispositionFor} closeLabel="Close triage" onClose={closeDisposition}>
          <section ref={dispositionRef} aria-label={`Record a disposition for ${subjectOf(dispositionFor)}`}>
            <p className={v.faint}>
              Moving a finding off &lsquo;open&rsquo; requires a reason — a later reviewer has to be able to audit the
              judgement.
            </p>
            <Field label="Disposition" help={DISPOSITION_HELP}>
              <Select value={disposition} onChange={(e) => setDisposition(e.target.value)}>
                {["confirmed", "sanctioned", "false_positive", "remediated", "open"].map((d) => (
                  <option key={d} value={d}>{DISPOSITION_LABEL[d]}</option>
                ))}
              </Select>
            </Field>
            <Field label="Reason">
              <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="why this judgement" />
            </Field>
            <div className={v.row}>
              <Button
                variant="primary"
                disabled={act.busy}
                onClick={() =>
                  void act
                    .run(
                      () =>
                        api.post(`/v1/shadow-ai/findings/${dispositionFor}/disposition`, {
                          disposition,
                          ...(reason.trim() ? { reason: reason.trim() } : {}),
                        }),
                      "Disposition recorded",
                    )
                    .then((ok) => {
                      if (ok) {
                        setDispositionFor(null);
                        refresh();
                      }
                    })
                }
              >
                Record
              </Button>
              <Button onClick={() => setDispositionFor(null)}>Cancel</Button>
            </div>
          </section>
          </DetailDrawer>
        ) : null}
        </>
      )}

      {tab === "coverage" && (
      <Card title="Coverage" info="For each kind of evidence: whether you supplied it, and what it can and cannot see. Use it to explain gaps, not to claim full coverage.">
        <p className={v.faint}>Gaps are shown, never papered over.</p>
        <QueryGate loading={findings.isLoading} error={findings.error} onRetry={refresh}>
          <ul className={sh.tiles} aria-label="Coverage by evidence class">
            {(findings.data?.coverage.sources ?? []).map((r) => (
              <li key={r.kind} className={r.on ? sh.tile : sh.tileMissing}>
                <span className={v.row} style={{ justifyContent: "space-between" }}>
                  <strong>{evidenceLabel(r.kind)}</strong>
                  <Badge tone={r.on ? "ok" : "warn"}>{r.on ? "Supplied" : "Missing"}</Badge>
                </span>
                <span className={v.dim}>{plural(r.imports, "import")} · {plural(r.rows, "row")}</span>
                <span>Sees: {r.whatItSees}</span>
                <span>Misses: {r.whatItMisses}</span>
                {r.on ? null : <button type="button" className={sh.linkButton} onClick={() => setTab("import")}>Import this evidence</button>}
              </li>
            ))}
          </ul>
        </QueryGate>
      </Card>
      )}

      {tab === "import" && (
        <>
      {/* ================= ADR-0071 — the format adapters ================= */}
      <Card title="Import a raw log file (format adapters)">
        <QueryGate loading={adapters.isLoading} error={adapters.error} onRetry={() => void adapters.refetch()}>
          <div className={v.stack}>
            <p className={v.dim}>{adapters.data?.posture}</p>
            <p className={v.faint}>{adapters.data?.pipeline}</p>

            <div className={a.formRow}>
              <Field label="Adapter">
                <Select
                  value={rawAdapter}
                  onChange={(e) => setRawAdapter(e.target.value)}
                  data-testid="raw-adapter"
                >
                  {optionEls(
                    (adapters.data?.adapters ?? []).map((x) => ({ v: x.id, l: x.displayName })),
                  )}
                </Select>
              </Field>
              <Field label="File format">
                <Select
                  value={rawFormat}
                  onChange={(e) => setRawFormat(e.target.value)}
                  data-testid="raw-format"
                >
                  {(selectedAdapter?.formats ?? ["text", "csv", "json"]).map((f) => (
                    <option key={f} value={f}>
                      {f}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Where this came from (provenance)">
                <Input
                  value={rawSource}
                  onChange={(e) => setRawSource(e.target.value)}
                  placeholder="e.g. squid-access-2026-07-28.log"
                  data-testid="raw-source"
                />
              </Field>
              <Field label="If a line will not parse">
                <Select
                  value={onMalformed}
                  onChange={(e) => setOnMalformed(e.target.value as "refuse_file" | "report_and_continue")}
                  data-testid="raw-malformed"
                >
                  <option value="refuse_file">refuse the WHOLE file (default)</option>
                  <option value="report_and_continue">accept readable lines, list every refusal</option>
                </Select>
              </Field>
            </div>

            {onMalformed === "report_and_continue" && (
              <div className={v.errLine} role="alert">
                You have opted out of the safe default. The resulting inventory will be SMALLER than the
                file, and a smaller inventory that looks complete is the one failure this feature exists to
                avoid. Every refused line is still listed with its number below.
              </div>
            )}

            {selectedAdapter && (
              <div className={v.stack}>
                <div className={v.row}>
                  <Badge tone={FORMAT_BASIS_TONE[selectedAdapter.formatBasis] ?? "info"}>
                    {FORMAT_BASIS_WORD[selectedAdapter.formatBasis] ?? selectedAdapter.formatBasis}
                  </Badge>
                  <span className={v.faint}>
                    produces: {selectedAdapter.capabilities.kinds.join(", ")}
                  </span>
                  <Badge tone={selectedAdapter.capabilities.selfDescribing ? "ok" : "warn"}>
                    {selectedAdapter.capabilities.selfDescribing
                      ? "the file declares its own fields"
                      : "positional — the file declares nothing"}
                  </Badge>
                  <Badge tone={selectedAdapter.capabilities.requestCount ? "ok" : "warn"}>
                    {selectedAdapter.capabilities.requestCount
                      ? "rows may carry an aggregate count"
                      : "one line = one request"}
                  </Badge>
                </div>
                <div className={v.sectionTitle}>What has and has not been checked</div>
                {/* VERBATIM — several of these say outright that the adapter has
                    never been run against a real vendor export. */}
                <p className={`${a.snippet} ${a.snippetProse}`} data-testid="raw-verification">
                  {selectedAdapter.verification}
                </p>
                <div className={v.sectionTitle}>What this adapter cannot do</div>
                <p className={`${a.snippet} ${a.snippetProse}`} data-testid="raw-limits">
                  {selectedAdapter.limits}
                </p>
                {ADAPTER_CONFIG_HINT[selectedAdapter.id] && (
                  <p className={v.dim}>{ADAPTER_CONFIG_HINT[selectedAdapter.id]}</p>
                )}
              </div>
            )}

            <div className={a.formRow}>
              <Field label="Upload a file">
                <input
                  type="file"
                  accept=".log,.txt,.csv,.json,text/plain,text/csv,application/json"
                  onChange={(e) => void readRawFile(e.target.files?.[0])}
                  data-testid="raw-file"
                />
              </Field>
            </div>
            {rawFileError && (
              <div className={v.errLine} role="alert">
                {rawFileError}
              </div>
            )}

            <Field label="…or paste the log here" grow>
              <Textarea
                rows={8}
                value={rawContent}
                onChange={(e) => setRawContent(e.target.value)}
                spellCheck={false}
                placeholder="CEF:0|Acme|Proxy|1.0|100|allowed|3|dhost=llm.example suser=psn:4d2e"
                data-testid="raw-content"
              />
            </Field>

            <Field label="Adapter configuration (JSON) — required by some adapters" grow>
              <Textarea
                rows={2}
                value={rawConfig}
                onChange={(e) => setRawConfig(e.target.value)}
                spellCheck={false}
                placeholder='{"layout":"squid"}'
                data-testid="raw-config"
              />
            </Field>

            <div className={v.row}>
              <Button
                disabled={rawAct.busy || !rawContent.trim()}
                onClick={() => void submitRaw("dry_run")}
                data-testid="raw-dry-run"
              >
                Parse &amp; analyze (dry run)
              </Button>
              <Button
                variant="primary"
                disabled={rawAct.busy || !rawContent.trim()}
                onClick={() => void submitRaw("apply")}
                data-testid="raw-apply"
              >
                Apply to inventory
              </Button>
            </div>

            <OutcomePanel outcome={rawAct.outcome} testId="raw-outcome">
              {rawAct.outcome && !rawAct.outcome.ok && Array.isArray(rawAct.outcome.payload?.refusals) && (
                <RefusalList
                  refusals={rawAct.outcome.payload.refusals as RowRefusal[]}
                  testId="raw-outcome-refusals"
                />
              )}
            </OutcomePanel>

            {rawResult && (
              <div className={v.stack} data-testid="raw-result">
                <div className={a.statRow}>
                  <Stat value={rawResult.rowsParsed} label="Lines read" />
                  <Stat value={rawResult.rowsAccepted} label="Lines accepted" />
                  <Stat value={rawResult.rowsRefused} label="Lines refused" />
                  <Stat value={rawResult.rowsWithoutTimestamp} label="Accepted with no timestamp" />
                </div>
                <p className={v.faint}>
                  <code>accepted + refused = lines read</code>, always — that identity is the whole claim
                  that nothing was silently dropped.
                </p>
                {rawResult.rowsWithoutTimestamp > 0 && (
                  <p className={v.dim}>
                    {rawResult.rowsWithoutTimestamp} accepted line(s) carried no timestamp of their own and
                    were stamped with the import time. That is not when the traffic happened.
                  </p>
                )}
                <RefusalList refusals={rawResult.refusals} testId="raw-result-refusals" />
                <p className={v.faint}>
                  Fields actually read: {rawResult.fieldsUsed.join(", ") || "none"} — everything else in the
                  file was DISCARDED and is stored nowhere.
                </p>
                <CodeBlock maxHeight="280px">{JSON.stringify(rawResult, null, 2)}</CodeBlock>
              </div>
            )}

            {(adapters.data?.adapters ?? []).length > 0 && (
              <>
                <div className={v.sectionTitle}>Every adapter, and what it claims</div>
                <Table<EvidenceAdapterInfo>
                  rows={adapters.data?.adapters ?? []}
                  rowKey={(r) => r.id}
                  columns={[
                    { key: "id", header: "Adapter", render: (r) => <code>{r.id}</code> },
                    { key: "name", header: "Reads", render: (r) => r.displayName },
                    {
                      key: "basis",
                      header: "Basis",
                      render: (r) => (
                        <Badge tone={FORMAT_BASIS_TONE[r.formatBasis] ?? "info"}>
                          {FORMAT_BASIS_WORD[r.formatBasis] ?? r.formatBasis}
                        </Badge>
                      ),
                    },
                    {
                      key: "verification",
                      header: "What has been checked",
                      render: (r) => <span className={v.dim}>{r.verification}</span>,
                    },
                  ]}
                />
                <p className={v.faint}>
                  No vendor-named preset ships, deliberately. A CASB or SSO export has no published format
                  at all, and the vendor&apos;s name is the part a buyer trusts — so{" "}
                  <code>generic_mapped</code> is the honest answer there instead of a{" "}
                  <code>zscaler</code> adapter nobody has tested against Zscaler.
                </p>
              </>
            )}
          </div>
        </QueryGate>
      </Card>

      {/* ================= ADR-0083 — first-party discovery ================= */}
      <Card title="First-party discovery (classify what you already hold)">
        <QueryGate loading={discovery.isLoading} error={discovery.error} onRetry={() => void discovery.refetch()}>
          <div className={v.stack}>
            <p className={v.dim}>{discovery.data?.posture}</p>
            <p className={v.faint}>{discovery.data?.limits}</p>
            <p className={v.faint}>
              Compiled catalogue v{discovery.data?.catalogVersion}: {discovery.data?.endpoints} endpoint and{" "}
              {discovery.data?.sdks} SDK signatures, frozen. This deployment currently fronts{" "}
              {discovery.data?.governedHosts.length ?? 0} governed host(s) — hits on those are labelled{" "}
              <code>governed_via_gateway</code>, not shadow.
            </p>

            <div className={a.formRow}>
              <Field label="Input kind">
                <Select value={discKind} onChange={(e) => setDiscKind(e.target.value)} data-testid="disc-kind">
                  {optionEls(DISCOVERY_KINDS)}
                </Select>
              </Field>
              <Field label={discIsManifest ? "Belongs to (repo/service) — required" : "Belongs to (label, optional)"}>
                <Input
                  value={discSubject}
                  onChange={(e) => setDiscSubject(e.target.value)}
                  placeholder={discIsManifest ? "e.g. acme/checkout-service" : "e.g. office-dns-resolver"}
                  data-testid="disc-subject"
                />
              </Field>
            </div>

            <Field label="Paste the log excerpt or manifest here" grow>
              <Textarea
                rows={8}
                value={discContent}
                onChange={(e) => setDiscContent(e.target.value)}
                spellCheck={false}
                placeholder={
                  discIsManifest
                    ? '{"dependencies": {"openai": "^4.0.0"}}'
                    : "Aug 20 10:00:01 dnsmasq[812]: query[A] llm.example from laptop-07.example"
                }
                data-testid="disc-content"
              />
            </Field>

            <div className={v.row}>
              <Button
                disabled={discAct.busy || !discContent.trim() || (discIsManifest && !discSubject.trim())}
                onClick={() => void submitDiscovery("dry_run")}
                data-testid="disc-classify"
              >
                Classify (writes nothing)
              </Button>
              <Button
                variant="primary"
                disabled={
                  discAct.busy ||
                  !discContent.trim() ||
                  (discIsManifest && !discSubject.trim()) ||
                  !discResult ||
                  discResult.classification.shadowCount === 0
                }
                onClick={() => void submitDiscovery("apply")}
                data-testid="disc-ingest"
              >
                Confirm ingest of shadow rows
              </Button>
            </div>

            <OutcomePanel outcome={discAct.outcome} testId="disc-outcome" />

            {discResult && (
              <div className={v.stack} data-testid="disc-result">
                <div className={a.statRow}>
                  <Stat value={discResult.classification.shadowCount} label="Shadow candidates" />
                  <Stat value={discResult.classification.governedCount} label="Governed via gateway" />
                  <Stat value={discResult.classification.unmatchedCount} label="Unmatched" />
                  <Stat value={discResult.classification.linesScanned} label="Lines scanned" />
                </div>
                <p className={v.faint}>{discResult.retention}</p>

                {discResult.matches.length > 0 && (
                  <>
                    <div className={v.sectionTitle}>Shadow candidates (compiled catalogue hits the gateway does not front)</div>
                    <Table<DiscoveryHit>
                      rows={discResult.matches}
                      rowKey={(r) => r.value}
                      columns={[
                        { key: "value", header: "Host / package", render: (r) => <code>{r.value}</code> },
                        { key: "kind", header: "Kind", render: (r) => evidenceLabel(r.kind) },
                        { key: "provider", header: "Provider", render: (r) => (r.provider ? providerLabel(r.provider) : "—") },
                        { key: "sig", header: "Signature", render: (r) => <code>{r.entryId ?? "—"}</code> },
                        { key: "n", header: "Occurrences", render: (r) => r.occurrences },
                        { key: "class", header: "Class", render: () => <Badge tone="warn">shadow</Badge> },
                      ]}
                    />
                  </>
                )}

                {discResult.governed.length > 0 && (
                  <>
                    <div className={v.sectionTitle}>Governed via gateway (this deployment's own configuration fronts these)</div>
                    <Table<DiscoveryHit>
                      rows={discResult.governed}
                      rowKey={(r) => r.value}
                      columns={[
                        { key: "value", header: "Host", render: (r) => <code>{r.value}</code> },
                        { key: "reason", header: "Why not shadow", render: (r) => <span className={v.dim}>{r.governedReason}</span> },
                        { key: "n", header: "Occurrences", render: (r) => r.occurrences },
                        { key: "class", header: "Class", render: () => <Badge tone="ok">governed_via_gateway</Badge> },
                      ]}
                    />
                  </>
                )}

                {discResult.classification.unmatchedCount > 0 && (
                  <p className={v.faint} data-testid="disc-unmatched">
                    {discResult.classification.unmatchedCount} distinct name(s) matched nothing (sample:{" "}
                    {discResult.classification.unmatchedSample.slice(0, 8).join(", ")}). Unmatched names are
                    counted, never ingested and never listed in full.
                  </p>
                )}

                {discResult.gapNote && (
                  <div className={v.errLine} role="alert" data-testid="disc-gap">
                    {discResult.gapNote}{" "}
                    {discResult.deploymentCatalogueGaps.map((g) => (
                      <code key={g.value}>{g.value} </code>
                    ))}
                  </div>
                )}

                {discResult.ingest ? (
                  <p className={v.dim} data-testid="disc-ingest-summary">
                    {discResult.ingest.mode === "apply"
                      ? `Ingested: ${discResult.ingest.observed} shadow row(s) through the evidence pipeline — ${
                          (discResult.ingest.created ?? 0) + (discResult.ingest.updated ?? 0)
                        } finding(s) written by the admin catalogue.`
                      : `Preview: ${discResult.ingest.observed} shadow row(s) would be ingested; the admin catalogue matched ${discResult.ingest.matched} of them.`}
                  </p>
                ) : (
                  <p className={v.dim} data-testid="disc-ingest-summary">
                    Nothing shadow-classified — there is nothing to ingest, and that result was audited.
                  </p>
                )}
              </div>
            )}
          </div>
        </QueryGate>
      </Card>

      <Card title="MCP server discovery (operator-supplied evidence)">
        <div className={v.stack}>
          <p className={v.dim}>Paste logs that contain MCP transport paths, protocol headers, or JSON-RPC methods. regulAIt compares observed hosts with this deployment’s MCP registry; it does not scan, connect to, or crawl your estate.</p>
          <Field label="MCP log evidence"><Textarea rows={7} value={mcpContent} onChange={(event) => setMcpContent(event.target.value)} spellCheck={false} placeholder={'POST https://tools.example/mcp MCP-Protocol-Version: 2025-06-18 {"method":"tools/list"}'} /></Field>
          <div className={v.row}>
            <Button disabled={mcpAct.busy || !mcpContent.trim()} onClick={() => void submitMcpDiscovery("preview")}>Compare with registry (writes nothing)</Button>
            <Button variant="primary" disabled={mcpAct.busy || !mcpContent.trim() || !mcpResult || mcpResult.unregistered === 0} onClick={() => void submitMcpDiscovery("apply")}>Record unregistered hosts</Button>
          </div>
          <OutcomePanel outcome={mcpAct.outcome} />
          {mcpResult ? <div className={v.stack}>
            <div className={v.kpiStrip}><KpiFigure value={mcpResult.observed} label="Observed MCP hosts" /><KpiFigure value={mcpResult.unregistered} label="Unregistered" /><KpiFigure value={mcpResult.registryCount} label="Registry entries" /></div>
            {mcpResult.results.length === 0 ? <EmptyState title="No MCP indicators found" body="No supported MCP transport path, protocol header, or JSON-RPC method appeared in the supplied text." /> : <Table rows={mcpResult.results} rowKey={(row) => row.host} columns={[
              { key: "host", header: "Host", render: (row) => <><code>{row.host}</code>{row.path ? <span className={v.faint}> {row.path}</span> : null}</> },
              { key: "confidence", header: "Confidence", render: (row) => row.confidence },
              { key: "registry", header: "Registry", render: (row) => <Badge tone={row.registered ? "ok" : "danger"}>{row.registered ? row.registeredAs ?? "registered" : "unregistered"}</Badge> },
              { key: "evidence", header: "Evidence", render: (row) => <span className={v.dim}>{row.indicators.join(", ")} · {row.occurrences} line(s)</span> },
              { key: "verdict", header: "Verdict", render: (row) => <span className={v.dim}>{row.verdict}</span> },
            ]} />}
            <p className={v.faint}>{mcpResult.posture}</p>
          </div> : null}
        </div>
      </Card>

      <Card title="Import evidence (rows already in regulAIt's shape)">
        <p className={v.faint}>
          An evidence file is untrusted input: size-bounded, schema-checked, and refused outright if it carries a
          governance-shaped field. The most it can ever do is write findings.
        </p>
        <Field label="Evidence JSON" grow>
          <Textarea rows={10} value={evidence} onChange={(e) => setEvidence(e.target.value)} spellCheck={false} />
        </Field>
        {act.error ? <p className={v.errLine} role="alert">{act.error}</p> : null}
        <div className={v.row}>
          <Button disabled={act.busy} onClick={() => void submitEvidence("dry_run")}>
            Analyze (dry run)
          </Button>
          <Button variant="primary" disabled={act.busy} onClick={() => void submitEvidence("apply")}>
            Apply to inventory
          </Button>
        </div>
        {preview ? (
          <CodeBlock maxHeight="280px">{JSON.stringify(preview, null, 2)}</CodeBlock>
        ) : null}
      </Card>

        </>
      )}

      {tab === "catalogue" && (
        <>
      <Card title="Detection catalogue" info="The signatures evidence is matched against: AI service hostnames, SDK package names and API key formats. You can add your own.">
        <p className={v.faint}>{catalogue.data?.posture ?? ""}</p>
        <QueryGate loading={catalogue.isLoading} error={catalogue.error} onRetry={refresh}>
          <div className={v.row}>
            <Button
              disabled={act.busy}
              onClick={() => void act.run(() => api.post("/v1/shadow-ai/catalogue/seed", {}), "Seed installed").then((ok) => ok && refresh())}
            >
              Install / refresh shipped seed
            </Button>
          </div>
          <AddSignatureForm onAdded={refresh} />
        </QueryGate>
      </Card>

      <Card title="Signatures" contain>
        <QueryGate loading={catalogue.isLoading} error={catalogue.error} onRetry={refresh}>
          <Table<Signature>
            rows={catalogue.data?.signatures ?? []}
            rowKey={(r) => r.id}
            columns={[
              { key: "provider", header: "Provider", render: (r) => providerLabel(r.provider) },
              { key: "kind", header: "Kind", render: (r) => evidenceLabel(r.kind) },
              { key: "value", header: "Value", render: (r) => <code>{r.value}</code> },
              { key: "match", header: "Match", render: (r) => evidenceLabel(r.matchType) + (r.minLength ? ` (≥${r.minLength})` : "") },
              {
                key: "scope",
                header: "Scope",
                render: (r) => [r.os, r.ecosystem].filter(Boolean).join(" · ") || <span className={v.dim}>any</span>,
              },
              {
                key: "confidence",
                header: "Confidence",
                render: (r) => <Badge tone={r.confidence === "low" ? "warn" : r.confidence === "medium" ? "info" : "ok"}>{r.confidence ?? "high"}</Badge>,
              },
              { key: "tool", header: "Tool / note", render: (r) => <span className={v.dim}>{[r.toolId, r.note].filter(Boolean).join(" — ") || "—"}</span> },
              { key: "provenance", header: "Provenance", render: (r) => r.provenance },
              { key: "updated", header: "Updated", render: (r) => ago(r.lastUpdatedAt) },
              { key: "enabled", header: "Enabled", render: (r) => <Badge tone={r.enabled ? "ok" : "neutral"}>{r.enabled ? "yes" : "no"}</Badge> },
              {
                key: "remove",
                header: "",
                render: (r) => (
                  <Button
                    variant="ghost"
                    disabled={act.busy}
                    onClick={() => void act.run(() => api.del(`/v1/shadow-ai/catalogue/${r.id}`), "Signature removed").then((ok) => ok && refresh())}
                  >
                    Remove
                  </Button>
                ),
              },
            ]}
          />
        </QueryGate>
      </Card>
        </>
      )}

      {tab === "history" && (
      <Card title="Import history" contain>
        <p className={v.faint}>
          Including refusals — an evidence file that tried to carry a privilege field is recorded, not discarded.
        </p>
        <QueryGate loading={imports.isLoading} error={imports.error} onRetry={refresh}>
          <Table<ImportRow>
            rows={imports.data?.imports ?? []}
            rowKey={(r) => r.id}
            columns={[
              { key: "when", header: "When", render: (r) => ago(r.createdAt) },
              { key: "kind", header: "Kind", render: (r) => evidenceLabel(r.kind) },
              { key: "mode", header: "Mode", render: (r) => r.mode },
              { key: "status", header: "Status", render: (r) => <Badge tone={r.status === "refused" ? "danger" : "ok"}>{r.status}</Badge> },
              { key: "rows", header: "Rows", render: (r) => r.rowCount },
              { key: "outcome", header: "Outcome", render: (r) => <span className={v.dim}>{r.reason}</span> },
            ]}
          />
        </QueryGate>
      </Card>
      )}
      </div>
    </>
  );
}

const TAB_IDS = ["findings", "coverage", "import", "catalogue", "history"];

type StatusGroup = "all" | "open" | "confirmed" | "closed";
const statusGroup = (d: string): Exclude<StatusGroup, "all"> => (d === "open" ? "open" : d === "confirmed" ? "confirmed" : "closed");
const STATUS_GROUP_LABEL: Record<StatusGroup, string> = { all: "All", open: "Open", confirmed: "Confirmed", closed: "Closed" };

const DISPOSITION_LABEL: Record<string, string> = {
  open: "Open",
  confirmed: "Confirmed",
  sanctioned: "Sanctioned",
  false_positive: "False positive",
  remediated: "Remediated",
};
const DISPOSITION_HELP =
  "Your triage decision. Open: not reviewed. Confirmed: real ungoverned use. Sanctioned: allowed as it is. False positive: not AI use. Remediated: fixed. Every change needs a reason.";
const CONFIDENCE_HELP =
  "How sure the match is. High means an exact endpoint or key format matched. Medium and low are looser signals, such as a package name, and need a human check.";

/** a figure tile; `tone` paints the severity stripe, so the tile that needs attention reads first */
function KpiFigure(props: { value: ReactNode; label: string; hint?: string; info?: ReactNode; tone?: "critical" | "high" | "medium" | "low" }) {
  return (
    <div className={`${v.stat} ${props.tone ? sh[props.tone] : ""}`}>
      <span className={v.statValue}>{props.value}</span>
      <span className={v.statLabel}>
        {props.label}
        {props.info != null && <InfoButton label={props.label}>{props.info}</InfoButton>}
      </span>
      {props.hint ? <span className={v.faint}>{props.hint}</span> : null}
    </div>
  );
}

/**
 * ADD A SIGNATURE the shipped seed does not carry.
 *
 * The catalogue could be seeded and its rows deleted, and a custom signature
 * could not be added from anywhere — which is the wrong way round for this
 * feature in particular. The shipped seed covers the well-known providers;
 * the ones a specific customer actually needs to detect are, by definition,
 * the ones nobody shipped. An internal LLM gateway on a private hostname is
 * exactly the shadow AI a governance team wants found, and it was the one
 * thing the catalogue could not be told about.
 *
 * MATCH TYPE IS DERIVED, NOT ASKED. The gateway refuses any pairing other than
 * sdk_package↔package and api_key_prefix↔key_prefix, so offering both as free
 * choices means offering combinations that can only be rejected. Kind is the
 * real question; for a hostname the remaining choice (exact vs suffix) is a
 * genuine one and is the only place a match type is asked for.
 */
function AddSignatureForm(props: { onAdded: () => void }) {
  const act = useAction();
  const [provider, setProvider] = useState("");
  const [kind, setKind] = useState<string>("hostname");
  const [os, setOs] = useState("");
  const [ecosystem, setEcosystem] = useState("");
  const [toolId, setToolId] = useState("");
  const [note, setNote] = useState("");
  const [confidence, setConfidence] = useState<"high" | "medium" | "low">("high");
  const isArtifact = ["cloud_ai_service", "desktop_app", "ide_extension", "browser_extension", "local_runtime", "assistant_config"].includes(kind);
  const [value, setValue] = useState("");
  const [hostMatch, setHostMatch] = useState<"exact_host" | "host_suffix">("host_suffix");
  const [minLength, setMinLength] = useState("20");

  // the one pairing the gateway will accept for this kind
  const matchType =
    kind === "sdk_package" ? "package" : kind === "api_key_prefix" ? "key_prefix" : isArtifact ? "identifier" : hostMatch;

  return (
    <form
      className={a.formRow}
      onSubmit={(e) => {
        e.preventDefault();
        void act
          .run(
            () =>
              api.post("/v1/shadow-ai/catalogue", {
                provider,
                kind,
                value,
                matchType,
                // An api_key_prefix with no length bound matches every string
                // that happens to start with it, so the gateway requires one.
                ...(kind === "api_key_prefix" ? { minLength: Number(minLength) } : {}),
                provenance: "admin",
                // ADR-0195 SD0: optional OS / ecosystem scope, tool id, note and confidence
                ...(os ? { os } : {}),
                ...(ecosystem.trim() ? { ecosystem: ecosystem.trim().toLowerCase() } : {}),
                ...(toolId.trim() ? { toolId: toolId.trim().toLowerCase() } : {}),
                ...(note.trim() ? { note: note.trim() } : {}),
                confidence,
              }),
            "Signature added",
          )
          .then((ok) => {
            if (ok) {
              setProvider("");
              setValue("");
              props.onAdded();
            }
          });
      }}
    >
      <Field label="Provider">
        <Input required value={provider} onChange={(e) => setProvider(e.target.value)} placeholder="e.g. Acme LLM" />
      </Field>
      <Field label="Detect by">
        <Select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
          <option value="hostname">hostname</option>
          <option value="web_app">web app</option>
          <option value="sdk_package">SDK package</option>
          <option value="api_key_prefix">API key prefix</option>
          <option value="cloud_ai_service">cloud AI service</option>
          <option value="desktop_app">desktop app</option>
          <option value="ide_extension">IDE extension</option>
          <option value="browser_extension">browser extension</option>
          <option value="local_runtime">local model runtime</option>
          <option value="assistant_config">assistant config file</option>
        </Select>
      </Field>
      <Field label="OS (optional)">
        <Select value={os} onChange={(e) => setOs(e.target.value)}>
          <option value="">any</option>
          <option value="macos">macOS</option>
          <option value="windows">Windows</option>
          <option value="linux">Linux</option>
        </Select>
      </Field>
      <Field label="Ecosystem (optional)">
        <Input value={ecosystem} maxLength={64} onChange={(e) => setEcosystem(e.target.value)} placeholder="npm" />
      </Field>
      <Field label="Tool id (optional)">
        <Input value={toolId} maxLength={128} onChange={(e) => setToolId(e.target.value)} />
      </Field>
      <Field label="Note (optional)">
        <Input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
      </Field>
      <Field label="Confidence">
        <Select value={confidence} onChange={(e) => setConfidence(e.target.value as typeof confidence)}>
          <option value="high">high</option>
          <option value="medium">medium</option>
          <option value="low">low</option>
        </Select>
      </Field>
      <Field label={kind === "sdk_package" ? "Package name" : kind === "api_key_prefix" ? "Key prefix" : isArtifact ? "Identifier (exact)" : "Hostname"}>
        <Input
          required
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={
            kind === "sdk_package" ? "acme-llm-sdk" : kind === "api_key_prefix" ? "acme-" : "llm.internal.acme.example"
          }
        />
      </Field>
      {kind === "hostname" || kind === "web_app" ? (
        <Field label="Match">
          <Select value={hostMatch} onChange={(e) => setHostMatch(e.target.value as typeof hostMatch)}>
            <option value="host_suffix">suffix — this host and anything under it</option>
            <option value="exact_host">exact — only this host</option>
          </Select>
        </Field>
      ) : null}
      {kind === "api_key_prefix" ? (
        <Field label="Min key length">
          <Input
            required
            type="number"
            min={1}
            max={512}
            value={minLength}
            onChange={(e) => setMinLength(e.target.value)}
          />
        </Field>
      ) : null}
      <Field label="&nbsp;">
        <Button type="submit" variant="primary" disabled={act.busy || !provider || !value}>
          Add signature
        </Button>
      </Field>
      {act.error && (
        <span className={v.errLine} role="alert">
          {act.error}
        </span>
      )}
    </form>
  );
}

