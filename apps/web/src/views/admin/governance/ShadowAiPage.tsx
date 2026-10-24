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
import { ago, evidenceLabel, fmtDateTime, humanize, plural, providerLabel } from "../../../api/format";
import { PageHeader } from "../../../shell/AppShell";
import { Badge, Button, Card, CodeBlock, EmptyState, Field, InfoButton, Input, RowActions, Select, SeverityBadge, Table, Tabs, tabIds, Textarea } from "../../../ui/kit";
import { FoldTable } from "../../../ui/fold";
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
import { DetailDrawer, DrawerActions } from "../../../ui/DetailDrawer";
import { DiscoverySightings } from "./DiscoverySightings";
import { sightingLines, type SightingView } from "./discoverySourcesModel";
import { IMPORT_EXAMPLE } from "./shadowAiExample";
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
  /** issue #522 #30: the use case registered from this finding (absent from an older gateway) */
  linkedUseCase?: { id: string; name: string; status: string } | null;
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
    'Required: {"layout":"squid"} — or "common" / "combined". These formats carry no header, so the layout is an operator assertion and is never sniffed: a mis-declared layout would read the client-IP column as the destination.',
  generic_mapped:
    'Required: {"kind":"egress_log"} (or code_scan / saas_export / self_reported). Add "mapping" to name the columns yourself; omit it and header inference proposes them and refuses on ambiguity.',
};

const EXAMPLE = JSON.stringify(IMPORT_EXAMPLE, null, 2);
/** a signature's OS scope as the add form names it */
const OS_LABEL: Record<string, string> = { macos: "macOS", windows: "Windows", linux: "Linux" };

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
  // A5: the drawer never opens on the permissive outcome; every Triage and Review again resets it to "Confirmed", which keeps the finding in view
  const [disposition, setDisposition] = useState("confirmed");
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
  /** Triage and Review again open the drawer fresh: Confirmed, with no reason */
  const openTriage = (id: string) => {
    setRemediationFor(null);
    setDispositionFor(id);
    setDisposition("confirmed");
    setReason("");
  };

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
        ? "File parsed and analysed — nothing was written."
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
    }, mode === "dry_run" ? "Evidence analysed (nothing written)" : "Evidence applied to the inventory");
    if (ok) refresh();
  };

  const criticalOpen = (findings.data?.findings ?? []).filter((f) => f.severity === "critical" && statusGroup(f.disposition) !== "closed").length;
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
  const seenAgain = (findings.data?.findings ?? []).filter((f) => f.dispositionStale);
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
          info="The four kinds of evidence you can import: network egress logs, code scans, SaaS and identity records, and self-reported use. Each kind not supplied is a blind spot. Findings from discovery sources (repository, cloud and endpoint scans) are not counted here."
        />
      </div>

      {/* ADR-0180: a warning never sits only inside a scroll box, so every finding seen again after it was closed is
          also listed here, above the contained Inventory, with its review action */}
      {seenAgain.length > 0 ? (
        <div className={sh.callout} role="note" aria-label="Seen again after closing" data-testid="shadow-seen-again" style={{ flexWrap: "wrap", alignItems: "center" }}>
          <span>
            <Badge tone="danger">Seen again {seenAgain.length}</Badge>{" "}
            New evidence arrived after {seenAgain.length === 1 ? "this finding was" : "these findings were"} closed. Review the disposition again.
          </span>
          <span className={v.row}>
            {seenAgain.map((f) => (
              <Button key={f.id} size="sm" aria-label={`Review ${f.subject} again`} onClick={() => openTriage(f.id)}>
                {f.subject}
              </Button>
            ))}
          </span>
        </div>
      ) : null}

      {/* the findings are the point of the page: they come straight after the figures */}
      <Card
        title="Inventory"
        contain
        caption="Every row is a lead for triage, not a verdict."
        foldable
        // L2: the header counts what the filtered body shows, out of every finding
        count={findingRows.length}
        total={findings.data?.findings.length}
        countNoun={["finding", "findings"]}
        attention={criticalOpen > 0 ? <Badge tone="danger">{criticalOpen} critical</Badge> : undefined}
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
        <QueryGate loading={findings.isLoading} error={findings.error} onRetry={refresh}>
          {(findings.data?.findings.length ?? 0) === 0 ? (
            <EmptyState title="No findings yet" body="Import an egress-log, code-scan, SaaS or self-reported evidence file under Import evidence." />
          ) : findingRows.length === 0 ? (
            <EmptyState title="No finding has this status" body="Choose another status above." />
          ) : (
            <FoldTable<Finding>
              rows={findingRows}
              rowKey={(r) => r.id}
              columns={[
                // F6/F21 (#453): below 1000 px of table width, Evidence and Seen fold into Subject and Confidence under
                // Severity; on a phone every column folds into Subject, one labelled line each
                { key: "severity", header: "Severity", fold: { sm: "subject" }, render: (r) => <SeverityBadge severity={r.severity} /> },
                { key: "subject", header: "Subject", // a floor so a name never wraps to one word per line
                  render: (r) => (
                    <span style={{ display: "inline-block", minWidth: "14ch" }}>
                      {/* a long resource path breaks rather than widening the table (F6) */}
                      <strong style={{ overflowWrap: "anywhere" }}>{r.subject}</strong>
                      <span className={v.dim} style={{ display: "block" }}>
                        {humanize(r.subjectKind)} · {providerLabel(r.provider)}
                        {r.replacementAgent ? <> · alternative: {r.replacementAgent.name}</> : r.replacementNote ? <> · {r.replacementNote}</> : null}
                      </span>
                    </span>
                  ) },
                // ADR-0195 SD0: where scanners saw it (path, line, commit), names seen, and who (as a pseudonym), under
                // the evidence badges (F6: Where seen joined Evidence)
                { key: "sources", header: "Evidence", fold: { md: "subject" },
                  info: "The kinds of evidence behind the finding, then where it was seen: file and line, commit, or log source, and the pseudonymised person involved.",
                  render: (r) => (
                    <span className={v.stackTight} style={{ alignItems: "flex-start" }}>
                      <span className={v.row}>{r.signalSources.map((src) => <Badge key={src}>{evidenceLabel(src)}</Badge>)}</span>
                      {sightingLines(r.evidence).length > 0 ? <DiscoverySightings evidence={r.evidence} collapsed /> : null}
                    </span>
                  ) },
                { key: "confidence", header: "Confidence", info: CONFIDENCE_HELP, fold: { md: "severity" },
                  render: (r) => <Badge tone={r.confidence === "high" ? "ok" : r.confidence === "medium" ? "warn" : "info"}>{humanize(r.confidence)}</Badge> },
                { key: "observations", header: "Seen", fold: { md: "subject" }, render: (r) => (
                  <span style={{ whiteSpace: "nowrap" }}>
                    {plural(r.observationCount, "time")}
                    <span className={v.dim} style={{ display: "block" }}>{ago(r.lastSeenAt)}</span>
                  </span>
                ) },
                {
                  key: "disposition",
                  header: "Status",
                  info: DISPOSITION_HELP,
                  fold: { sm: "subject" },
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
                  fold: { sm: "subject" },
                  render: (r) => {
                    const plan = (
                      <Button
                        variant={r.disposition === "open" || r.disposition === "confirmed" ? "primary" : "default"}
                        aria-label={`Plan remediation for ${r.subject}`}
                        aria-pressed={remediationFor === r.id}
                        onClick={() => { setDispositionFor(null); setRemediationFor(remediationFor === r.id ? null : r.id); }}
                      >
                        Plan remediation
                      </Button>
                    );
                    const triage = r.dispositionStale ? (
                      <Button aria-label={`Review again: ${r.subject}`} onClick={() => openTriage(r.id)}>Review again</Button>
                    ) : (
                      <Button variant="ghost" aria-label={`Triage ${r.subject}`} onClick={() => openTriage(r.id)}>Triage</Button>
                    );
                    return (
                      <RowActions
                        slot="11rem"
                        stacked
                        // X7 (owner): the plan button sits in the primary slot on every row, so it aligns on every row; a
                        // closed finding shows it at default weight instead of moving it
                        primary={plan}
                        secondary={triage}
                        rest={
                          <span className={v.stackTight} style={{ alignItems: "flex-start" }}>
                            {r.linkedUseCase ? (
                              <span>Registered as <Link to={`/admin/governance/use-cases/${r.linkedUseCase.id}`}>{r.linkedUseCase.name}</Link></span>
                            ) : (
                              <Link to={`/admin/governance/intake?source=shadow-ai&findingId=${encodeURIComponent(r.id)}&title=${encodeURIComponent(`Govern ${r.subject}`)}&description=${encodeURIComponent(`Register and govern the ${providerLabel(r.provider)} usage observed for ${r.subject}. Evidence: ${r.signalSources.map(evidenceLabel).join(", ")}.`)}`} aria-label={`Register as use case: ${r.subject}`}>Register as use case</Link>
                            )}
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
            data-testid="shadow-remediation"
            meta={
              <InfoButton label="a remediation plan">
                A remediation plan turns a finding into tracked work: a governed workflow with a separate approver. The
                workflow tracks the change and its sign-off. It does not change systems by itself.
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
              <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="for example SDK import confirmed in src/billing" />
            </Field>
            <DrawerActions className={v.row}>
              <Button
                variant="primary"
                // the gateway refuses a move off "open" without a reason; the button says so before the call does
                disabled={act.busy || (disposition !== "open" && !reason.trim())}
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
            </DrawerActions>
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
                  placeholder="for example squid-access-2026-07-28.log"
                  data-testid="raw-source"
                />
              </Field>
              <Field label="If a line will not parse">
                <Select
                  value={onMalformed}
                  onChange={(e) => setOnMalformed(e.target.value as "refuse_file" | "report_and_continue")}
                  data-testid="raw-malformed"
                >
                  <option value="refuse_file">Refuse the whole file (default)</option>
                  <option value="report_and_continue">Accept readable lines, list every refusal</option>
                </Select>
              </Field>
            </div>

            {onMalformed === "report_and_continue" && (
              <div className={v.errLine} role="alert">
                You have opted out of the safe default. The resulting inventory will be smaller than the
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
                Parse &amp; analyse (dry run)
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
                    {plural(rawResult.rowsWithoutTimestamp, "accepted line")} carried no timestamp of their own and
                    were stamped with the import time. That is not when the traffic happened.
                  </p>
                )}
                <RefusalList refusals={rawResult.refusals} testId="raw-result-refusals" />
                <p className={v.faint}>
                  Fields actually read: {rawResult.fieldsUsed.join(", ") || "none"} — everything else in the
                  file was discarded and is stored nowhere.
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
                  vendor-named adapter nobody has tested against that vendor&apos;s export.
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
              {plural(discovery.data?.governedHosts.length ?? 0, "governed host")}. Hits on those are labelled Governed via
              gateway, not shadow.
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
                  placeholder={discIsManifest ? "for example acme/checkout-service" : "for example office-dns-resolver"}
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
                    ? '{"dependencies": {"acme-llm-sdk": "^4.0.0"}}'
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
                        { key: "class", header: "Class", render: () => <><Badge tone="ok">Governed via gateway</Badge><div className={`${v.faint} ${v.mono}`}>governed_via_gateway</div></> },
                      ]}
                    />
                  </>
                )}

                {discResult.classification.unmatchedCount > 0 && (
                  <p className={v.faint} data-testid="disc-unmatched">
                    {plural(discResult.classification.unmatchedCount, "distinct name")} matched nothing (sample:{" "}
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
                      ? `Ingested: ${plural(discResult.ingest.observed, "shadow row")} through the evidence pipeline — ${plural(
                          (discResult.ingest.created ?? 0) + (discResult.ingest.updated ?? 0),
                          "finding",
                        )} written by the admin catalogue.`
                      : `Preview: ${plural(discResult.ingest.observed, "shadow row")} would be ingested; the admin catalogue matched ${discResult.ingest.matched} of them.`}
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
              { key: "evidence", header: "Evidence", render: (row) => <span className={v.dim}>{row.indicators.join(", ")} · {plural(row.occurrences, "line")}</span> },
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
            Analyse (dry run)
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
          <FoldTable<Signature>
            rows={catalogue.data?.signatures ?? []}
            rowKey={(r) => r.id}
            columns={[
              // A12: paired values share a cell (the second as dim text under the first), so eleven fields fit a
              // 1440 px card without one word per line; below 1000 px of table width Scope and Provenance fold under
              // Value, and on a phone Kind folds under Provider
              { key: "provider", header: "Provider", render: (r) => providerLabel(r.provider) },
              {
                key: "kind",
                header: "Kind / match",
                fold: { sm: "provider" },
                render: (r) => <>{evidenceLabel(r.kind)}<div className={v.dim}>{evidenceLabel(r.matchType) + (r.minLength ? ` (≥${r.minLength})` : "")}</div></>,
              },
              { key: "value", header: "Value", render: (r) => <code>{r.value}</code> },
              {
                key: "scope",
                header: "Scope / tool",
                fold: { md: "value" },
                render: (r) => {
                  const tool = [r.toolId, r.note].filter(Boolean).join(" — ");
                  return (
                    <>
                      {[r.os && (OS_LABEL[r.os] ?? r.os), r.ecosystem].filter(Boolean).join(" · ") || <span className={v.dim}>Any</span>}
                      {tool ? <div className={v.dim}>{tool}</div> : null}
                    </>
                  );
                },
              },
              {
                key: "confidence",
                header: "Confidence",
                // a signature without a confidence says so, rather than claiming "high"
                render: (r) => (r.confidence ? <Badge tone={r.confidence === "low" ? "warn" : r.confidence === "medium" ? "info" : "ok"}>{humanize(r.confidence)}</Badge> : <span className={v.dim}>—</span>),
              },
              {
                key: "provenance",
                header: "Provenance",
                fold: { md: "value" },
                render: (r) => <>{humanize(r.provenance)}<div className={v.dim} style={{ whiteSpace: "nowrap" }}>updated {ago(r.lastUpdatedAt)}</div></>,
              },
              { key: "enabled", header: "Enabled", render: (r) => <Badge tone={r.enabled ? "ok" : "neutral"}>{r.enabled ? "yes" : "no"}</Badge> },
              {
                key: "remove",
                header: <span className={sh.srOnly}>Actions</span>,
                render: (r) => (
                  <Button
                    variant="ghost"
                    aria-label={`Remove signature ${r.value}`}
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
              { key: "when", header: "When", render: (r) => <><span style={{ whiteSpace: "nowrap" }}>{fmtDateTime(r.createdAt)}</span><div className={v.faint}>{ago(r.createdAt)}</div></> },
              { key: "kind", header: "Kind", render: (r) => evidenceLabel(r.kind) },
              { key: "mode", header: "Mode", render: (r) => (r.mode === "dry_run" ? "Dry run" : r.mode === "apply" ? "Applied" : humanize(r.mode)) },
              { key: "status", header: "Status", render: (r) => <Badge tone={r.status === "refused" ? "danger" : "ok"}>{humanize(r.status)}</Badge> },
              { key: "rows", header: "Rows", render: (r) => r.rowCount.toLocaleString() },
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
  "Your triage decision. Open: not reviewed. Confirmed: real ungoverned use. Sanctioned: allowed as it is. False positive: not AI use. Remediated: fixed. Moving a finding off Open needs a reason.";
const CONFIDENCE_HELP =
  "How many independent kinds of evidence agree. High: three or more. Medium: two. Low: one, so check it by hand.";

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
        <Input required value={provider} onChange={(e) => setProvider(e.target.value)} placeholder="for example Acme LLM" />
      </Field>
      <Field label="Detect by">
        <Select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
          <option value="hostname">Hostname</option>
          <option value="web_app">Web app</option>
          <option value="sdk_package">SDK package</option>
          <option value="api_key_prefix">API key prefix</option>
          <option value="cloud_ai_service">Cloud AI service</option>
          <option value="desktop_app">Desktop app</option>
          <option value="ide_extension">IDE extension</option>
          <option value="browser_extension">Browser extension</option>
          <option value="local_runtime">Local model runtime</option>
          <option value="assistant_config">Assistant config file</option>
        </Select>
      </Field>
      <Field label="OS (optional)">
        <Select value={os} onChange={(e) => setOs(e.target.value)}>
          <option value="">Any</option>
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
          <option value="high">High</option>
          <option value="medium">Medium</option>
          <option value="low">Low</option>
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
            <option value="host_suffix">Suffix — this host and anything under it</option>
            <option value="exact_host">Exact — only this host</option>
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

