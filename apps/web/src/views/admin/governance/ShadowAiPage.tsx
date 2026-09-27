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
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import { ago } from "../../../api/format";
import { PageHeader } from "../../../shell/AppShell";
import { Badge, Button, Card, CodeBlock, EmptyState, Field, Input, Select, SeverityBadge, Table, Textarea } from "../../../ui/kit";
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
import v from "../../views.module.css";

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

  const [evidence, setEvidence] = useState(EXAMPLE);
  const [preview, setPreview] = useState<unknown>(null);
  const [dispositionFor, setDispositionFor] = useState<string | null>(null);
  const [disposition, setDisposition] = useState("sanctioned");
  const [reason, setReason] = useState("");

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

  return (
    <>
      <PageHeader
        title="Shadow-AI discovery"
        sub="Inventory ungoverned LLM usage from evidence you already have — and pull it into governance."
      />

      <Card title="What this does, and what it cannot do">
        <p className={v.faint}>
          regulAIt ships no collector. Everything below analyzes evidence you export and upload.
        </p>
        <p className={v.dim}>{findings.data?.coverage.statement ?? "Loading coverage…"}</p>
        <p className={v.dim}>{findings.data?.posture}</p>
      </Card>

      <div className={a.statRow}>
        <Stat value={bySeverity.critical} label="Critical (leaked credential)" />
        <Stat value={bySeverity.high} label="High (observed model traffic)" />
        <Stat value={(bySeverity.medium ?? 0) + (bySeverity.low ?? 0)} label="Medium / low" />
        <Stat
          value={`${findings.data?.coverage.sourcesOn ?? 0} / ${findings.data?.coverage.sourcesPossible ?? 4}`}
          label="Evidence classes supplied"
        />
      </div>

      <Card title="Coverage scorecard">
        <p className={v.faint}>Gaps are shown, never papered over.</p>
        <QueryGate loading={findings.isLoading} error={findings.error} onRetry={refresh}>
          <Table<FindingsResponse["coverage"]["sources"][number]>
            rows={findings.data?.coverage.sources ?? []}
            rowKey={(r) => r.kind}
            columns={[
              { key: "evidence_class", header: "Evidence class", render: (r) => <code>{r.kind}</code> },
              { key: "supplied", header: "Supplied", render: (r) => <Badge tone={r.on ? "ok" : "neutral"}>{r.on ? "on" : "off"}</Badge> },
              { key: "imports", header: "Imports", render: (r) => r.imports },
              { key: "rows", header: "Rows", render: (r) => r.rows },
              { key: "what_it_sees", header: "What it sees", render: (r) => <span className={v.dim}>{r.whatItSees}</span> },
              { key: "what_it_misses", header: "What it misses", render: (r) => <span className={v.dim}>{r.whatItMisses}</span> },
            ]}
          />
        </QueryGate>
      </Card>

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
                <p className={a.snippet} data-testid="raw-verification">
                  {selectedAdapter.verification}
                </p>
                <div className={v.sectionTitle}>What this adapter cannot do</div>
                <p className={a.snippet} data-testid="raw-limits">
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
                placeholder="CEF:0|Acme|Proxy|1.0|100|allowed|3|dhost=api.openai.com suser=alice"
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
                    : "Aug 20 10:00:01 dnsmasq[812]: query[A] api.openai.com from 10.1.2.3"
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
                        { key: "kind", header: "Kind", render: (r) => r.kind },
                        { key: "provider", header: "Provider", render: (r) => r.provider ?? "—" },
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

      <Card title="Import evidence (rows already in regulAIt's shape)">
        <p className={v.faint}>
          An evidence file is untrusted input: size-bounded, schema-checked, and refused outright if it carries a
          governance-shaped field. The most it can ever do is write findings.
        </p>
        <Field label="Evidence JSON" grow>
          <Textarea rows={10} value={evidence} onChange={(e) => setEvidence(e.target.value)} spellCheck={false} />
        </Field>
        {act.error ? <p className={v.errLine}>{act.error}</p> : null}
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

      <Card title="Inventory">
        <p className={v.faint}>Every row is a lead for triage, not a verdict.</p>
        <QueryGate loading={findings.isLoading} error={findings.error} onRetry={refresh}>
          {(findings.data?.findings.length ?? 0) === 0 ? (
            <EmptyState title="No findings yet" body="Import an egress-log, code-scan, SaaS or self-reported evidence file above." />
          ) : (
            <Table<Finding>
              rows={findings.data?.findings ?? []}
              rowKey={(r) => r.id}
              columns={[
                { key: "severity", header: "Severity", render: (r) => <SeverityBadge severity={r.severity} /> },
                { key: "subject", header: "Subject", render: (r) => <span title={r.subjectKind}>{r.subject}</span> },
                { key: "provider", header: "Provider", render: (r) => r.provider },
                { key: "sources", header: "Sources", render: (r) => r.signalSources.join(", ") },
                { key: "confidence", header: "Confidence", render: (r) => r.confidence },
                { key: "observations", header: "Observations", render: (r) => r.observationCount },
                { key: "last_seen", header: "Last seen", render: (r) => ago(r.lastSeenAt) },
                {
                  key: "replacement",
                  header: "Governed replacement",
                  render: (r) =>
                    r.replacementAgent ? (
                      <Badge tone="ok">{r.replacementAgent.name}</Badge>
                    ) : (
                      <span className={v.dim}>{r.replacementNote ?? "none registered"}</span>
                    ),
                },
                {
                  key: "disposition",
                  header: "Disposition",
                  render: (r) => (
                    <>
                      <Badge tone={r.disposition === "open" ? "warn" : "neutral"}>{r.disposition}</Badge>
                      {r.dispositionStale ? <Badge tone="danger">seen again since</Badge> : null}
                    </>
                  ),
                },
                {
                  key: "triage",
                  header: "",
                  render: (r) => (
                    <Button onClick={() => { setDispositionFor(r.id); setReason(""); }}>Triage</Button>
                  ),
                },
              ]}
            />
          )}
        </QueryGate>

        {dispositionFor ? (
          <Card title="Record a disposition">
            <p className={v.faint}>
              Moving a finding off &lsquo;open&rsquo; requires a reason — a later reviewer has to be able to audit the
              judgement.
            </p>
            <Field label="Disposition">
              <Select value={disposition} onChange={(e) => setDisposition(e.target.value)}>
                {["confirmed", "sanctioned", "false_positive", "remediated", "open"].map((d) => (
                  <option key={d} value={d}>{d}</option>
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
          </Card>
        ) : null}
      </Card>

      <Card title="Detection catalogue">
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
          <Table<Signature>
            rows={catalogue.data?.signatures ?? []}
            rowKey={(r) => r.id}
            columns={[
              { key: "provider", header: "Provider", render: (r) => r.provider },
              { key: "kind", header: "Kind", render: (r) => <code>{r.kind}</code> },
              { key: "value", header: "Value", render: (r) => <code>{r.value}</code> },
              { key: "match", header: "Match", render: (r) => r.matchType + (r.minLength ? ` (≥${r.minLength})` : "") },
              { key: "provenance", header: "Provenance", render: (r) => r.provenance },
              { key: "updated", header: "Updated", render: (r) => ago(r.lastUpdatedAt) },
              { key: "enabled", header: "Enabled", render: (r) => <Badge tone={r.enabled ? "ok" : "neutral"}>{r.enabled ? "yes" : "no"}</Badge> },
              {
                key: "remove",
                header: "",
                render: (r) => (
                  <Button
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

      <Card title="Import history">
        <p className={v.faint}>
          Including refusals — an evidence file that tried to carry a privilege field is recorded, not discarded.
        </p>
        <QueryGate loading={imports.isLoading} error={imports.error} onRetry={refresh}>
          <Table<ImportRow>
            rows={imports.data?.imports ?? []}
            rowKey={(r) => r.id}
            columns={[
              { key: "when", header: "When", render: (r) => ago(r.createdAt) },
              { key: "kind", header: "Kind", render: (r) => <code>{r.kind}</code> },
              { key: "mode", header: "Mode", render: (r) => r.mode },
              { key: "status", header: "Status", render: (r) => <Badge tone={r.status === "refused" ? "danger" : "ok"}>{r.status}</Badge> },
              { key: "rows", header: "Rows", render: (r) => r.rowCount },
              { key: "outcome", header: "Outcome", render: (r) => <span className={v.dim}>{r.reason}</span> },
            ]}
          />
        </QueryGate>
      </Card>
    </>
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
  const [kind, setKind] = useState<"hostname" | "sdk_package" | "api_key_prefix" | "web_app">("hostname");
  const [value, setValue] = useState("");
  const [hostMatch, setHostMatch] = useState<"exact_host" | "host_suffix">("host_suffix");
  const [minLength, setMinLength] = useState("20");

  // the one pairing the gateway will accept for this kind
  const matchType =
    kind === "sdk_package" ? "package" : kind === "api_key_prefix" ? "key_prefix" : hostMatch;

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
        </Select>
      </Field>
      <Field label={kind === "sdk_package" ? "Package name" : kind === "api_key_prefix" ? "Key prefix" : "Hostname"}>
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

