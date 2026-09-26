/**
 * ADR-0069 — CROSS-VENDOR COST CONSOLIDATION, given the surface the ADR
 * disclosed it did not have. No contract changes here; this is the screen.
 *
 * THE ONE RULE THIS PAGE EXISTS TO ENFORCE VISUALLY:
 *
 *   `metered` (RegulAIt saw the call and priced it) and `imported` (RegulAIt
 *   was TOLD, by a file somebody exported) are two different kinds of number
 *   and are NEVER added together. The API has no field for a blended total —
 *   deliberately, and asserted by four tests — so this page has no cell for
 *   one either. The two bases are rendered in separate, differently-ruled
 *   columns with the basis word printed on each, and the subject's own
 *   `coverage` sentence states the split in words underneath.
 *
 * The other four things it exists to keep honest:
 *
 *  - **An adapter's `limits` string is printed verbatim**, next to where it is
 *    picked. Three of the five presets were built against DECLARED header sets
 *    that have never been checked against a live console, and the operator has
 *    to read that before trusting the parse — not after.
 *  - **A refusal names its file line.** A dry run reports rows accepted vs rows
 *    refused, and every refusal carries the 1-based line number in the file the
 *    operator has open. `rows_parsed = accepted + refused` is a database CHECK;
 *    this page shows all three so a shrinking number cannot pass for a clean one.
 *  - **Unattributed spend is shown, never hidden and never spread.** A vendor
 *    account that resolved to nobody is its own subject row, labelled as such.
 *  - **The imported side is exactly as fresh as the last file somebody
 *    uploaded.** There is no scheduled re-import — RegulAIt holds no vendor
 *    billing-API credential — so per-vendor staleness is on the page.
 *
 * House pattern: react-router + TanStack Query + the owned kit.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import { ago, fmtUsd, shortId } from "../../../api/format";
import { PageHeader } from "../../../shell/AppShell";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  Select,
  Table,
  Textarea,
} from "../../../ui/kit";
import {
  KV,
  OutcomePanel,
  QueryGate,
  ReasonModal,
  RefusalList,
  Stat,
  downloadCsv,
  optionEls,
  useApiAction,
  useNameMaps,
  useUsers,
  userOpts,
  type RowRefusal,
} from "../adminKit";
import a from "../admin.module.css";
import v from "../../views.module.css";

// ---------------------------------------------------------------------------
// mirrors of the gateway's read projections
// ---------------------------------------------------------------------------

interface AdapterInfo {
  id: string;
  displayName: string;
  vendor: string;
  formats: string[];
  capabilities: {
    accountIdentifier: boolean;
    accountIsEmail: boolean;
    perLinePeriod: boolean;
    quantity: boolean;
    service: boolean;
    currency: boolean;
    amountFromFile: boolean;
  };
  limits: string;
}

interface AdaptersResponse {
  adapters: AdapterInfo[];
  basisStatement: string;
  piiPosture: string;
  posture: string;
}

interface ImportResult {
  importId: string;
  mode: "dry_run" | "apply";
  basis: "imported";
  adapter: string;
  adapterLimits: string;
  rowsParsed: number;
  rowsAccepted: number;
  rowsRefused: number;
  refusals: RowRefusal[];
  refusalsTruncated: boolean;
  currencies: string[];
  totalUsd: number | null;
  totalUsdNote: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  resolution: {
    byMethod: { exact_email: number; admin_alias: number; domain_rule: number; unresolved: number };
    unattributedLines: number;
    unattributedAmount: number;
    note: string;
  };
  ingestScan: { mode: string; verdict: string; findings: unknown };
  piiPosture: string;
  basisStatement: string;
}

interface ImportBatch {
  id: string;
  adapter: string;
  vendor: string;
  format: string;
  mode: string;
  status: string;
  source: string | null;
  rowsParsed: number;
  rowsAccepted: number;
  rowsRefused: number;
  totalUsd: number | null;
  reason: string;
  createdAt: string;
}

interface AliasRow {
  id: string;
  vendor: string;
  accountKey: string;
  userId: string;
  reason: string;
  createdAt: string;
}
interface DomainRuleRow {
  id: string;
  vendor: string;
  fromDomain: string;
  toDomain: string;
  enabled: boolean;
  reason: string;
  createdAt: string;
}
interface MappingsResponse {
  aliases: AliasRow[];
  domainRules: DomainRuleRow[];
  posture: string;
}

interface Subject {
  subjectKind: "user" | "cost_center";
  subjectId: string | null;
  label: string;
  attributed: boolean;
  metered: { basis: "metered"; usd: number; events: number; unpricedEvents: number };
  imported: {
    basis: "imported";
    usd: number | null;
    lines: number;
    byCurrency: Array<{ currency: string; amount: number; lines: number }>;
    byVendor: Array<{ vendor: string; currency: string; amount: number; lines: number }>;
    byBillingKind: Array<{ billingKind: string; currency: string; amount: number; lines: number }>;
    usdNote: string | null;
  };
  coverage: string;
}

interface ConsolidatedResponse {
  window: { from: string; to: string };
  groupedBy: "user" | "cost_center";
  subjects: Subject[];
  basisStatement: string;
  /** ADR-0076: what the reconciliation excluded from this very response */
  reconciliation: {
    supersededLinesExcluded: number;
    lastReconciledAt: string | null;
    note: string;
  };
  staleness: {
    vendors: Array<{
      vendor: string;
      lastImportedAt: string | null;
      appliedBatches: number;
      daysSinceLastImport: number | null;
    }>;
    note: string;
  };
  note: string;
}

// ---- ADR-0076: reconciliation + roster projections -------------------------

interface ReconciliationRun {
  id: string;
  trigger: "manual" | "schedule";
  startedAt: string;
  finishedAt: string | null;
  outcome: "running" | "ok" | "failed";
  scannedLines: number;
  duplicateGroups: number;
  supersededLines: number;
  ambiguousGroups: number;
  overlapWarnings: number;
  warnings: Array<{ kind: string; detail: string }>;
  error: string | null;
}

interface ReconciliationReport {
  liveLines: number;
  supersededLines: number;
  lastRun: ReconciliationRun | null;
  recentRuns: ReconciliationRun[];
  supersededSample: Array<{
    id: string;
    vendor: string;
    accountKey: string;
    amount: number;
    currency: string;
    supersededAt: string;
    supersededReason: string;
  }>;
  scheduler: { jobName: string; note: string };
  posture: string;
}

interface RosterResult {
  mode: "dry_run" | "apply";
  dialect: "scim" | "rows";
  rowsParsed: number;
  rowsAccepted: number;
  rowsRefused: number;
  duplicateRows: number;
  refusals: RowRefusal[];
  refusalsTruncated: boolean;
  counts: {
    aliasesToCreate: number;
    aliasesToUpdate: number;
    aliasesUnchanged: number;
    aliasesUnnecessary: number;
    costCentersToSet: number;
    costCentersUnchanged: number;
  };
  actions: Array<{
    row: number;
    accountRef: string;
    vendor: string;
    userEmail: string;
    aliasAction: "create" | "update" | "unchanged" | "unnecessary";
    costCenter: string | null;
    costCenterAction: "set" | "unchanged" | "none";
  }>;
  applied: boolean;
  aliasesCreated?: number;
  aliasesUpdated?: number;
  costCentersSet?: number;
  reresolved?: { changed: number; scanned: number };
  ingestScan: { mode: string; verdict: string };
  piiPosture: string;
  posture: string;
}

// ---------------------------------------------------------------------------

/** what an operator has to be told about each adapter before they pick it */
const ADAPTER_HINT: Record<string, string> = {
  generic_mapped:
    "Leave the configuration blank to let regulAIt infer the column mapping from the header row — it REFUSES on ambiguity rather than guessing. Supply {\"mapping\":{\"account\":\"…\",\"amount\":\"…\"}} to name the columns yourself.",
  seat_roster:
    "This format carries no money. The per-seat price is an OPERATOR ASSERTION and is stamped on every line as `derivedFrom` — supply it in the configuration below.",
};

const METHOD_LABEL: Record<string, string> = {
  exact_email: "exact email match",
  admin_alias: "an admin's alias",
  domain_rule: "a domain rule",
  unresolved: "NOBODY — unattributed",
};

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * The two bases, rendered apart. There is deliberately no third cell: the API
 * has no blended field and neither does this component.
 */
function BasisPair(props: { subject: Subject }) {
  const s = props.subject;
  return (
    <div className={a.basisSplit}>
      <div className={[a.basisCell, a.basisCellMetered].join(" ")}>
        <div className={a.basisLabel}>metered — regulAIt observed and priced these calls</div>
        <div className={a.basisMoney}>{fmtUsd(s.metered.usd)}</div>
        <div className={v.faint}>
          {s.metered.events} call(s)
          {s.metered.unpricedEvents > 0
            ? ` · ${s.metered.unpricedEvents} unpriced (counted, never valued at zero)`
            : ""}
        </div>
      </div>
      <div className={[a.basisCell, a.basisCellImported].join(" ")}>
        <div className={a.basisLabel}>imported — restated from a file you supplied</div>
        <div className={a.basisMoney}>
          {s.imported.usd === null ? "no single figure" : fmtUsd(s.imported.usd)}
        </div>
        <div className={v.faint}>
          {s.imported.lines} line(s)
          {s.imported.byVendor.length > 0
            ? ` · ${s.imported.byVendor.map((x) => `${x.vendor} ${x.amount.toFixed(2)} ${x.currency}`).join(", ")}`
            : ""}
        </div>
        {s.imported.usdNote && <div className={v.dim}>{s.imported.usdNote}</div>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

export default function CostConsolidationPage() {
  const act = useApiAction();
  const users = useUsers();
  const names = useNameMaps();

  const adapters = useQuery({
    queryKey: ["admin", "cost-import-adapters"],
    queryFn: () => api.get<AdaptersResponse>("/v1/cost-imports/adapters"),
  });
  const history = useQuery({
    queryKey: ["admin", "cost-imports"],
    queryFn: () => api.get<{ imports: ImportBatch[]; basisStatement: string }>("/v1/cost-imports"),
  });
  const mappings = useQuery({
    queryKey: ["admin", "cost-import-mappings"],
    queryFn: () => api.get<MappingsResponse>("/v1/cost-imports/mappings"),
  });
  const reconciliation = useQuery({
    queryKey: ["admin", "cost-reconciliation"],
    queryFn: () => api.get<ReconciliationReport>("/v1/cost-imports/reconciliation"),
  });

  // ---- import form ----
  const [adapterId, setAdapterId] = useState("generic_mapped");
  const [format, setFormat] = useState<"csv" | "json">("csv");
  const [content, setContent] = useState("");
  const [source, setSource] = useState("");
  const [config, setConfig] = useState("");
  const [result, setResult] = useState<ImportResult | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);

  // ---- consolidated view ----
  const [by, setBy] = useState<"user" | "cost_center">("user");
  const [from, setFrom] = useState(isoDay(new Date(Date.now() - 30 * 24 * 3600 * 1000)));
  const [to, setTo] = useState(isoDay(new Date(Date.now() + 24 * 3600 * 1000)));

  const consolidatedQs = useMemo(() => {
    const qs = new URLSearchParams({ by });
    if (from) qs.set("from", new Date(from).toISOString());
    if (to) qs.set("to", new Date(to).toISOString());
    return qs.toString();
  }, [by, from, to]);

  const consolidated = useQuery({
    queryKey: ["admin", "cost-consolidated", consolidatedQs],
    queryFn: () => api.get<ConsolidatedResponse>(`/v1/cost-consolidated?${consolidatedQs}`),
  });

  // ---- identity mapping forms ----
  const [aliasVendor, setAliasVendor] = useState("*");
  const [aliasAccount, setAliasAccount] = useState("");
  const [aliasUser, setAliasUser] = useState("");
  const [aliasReason, setAliasReason] = useState("");
  const [ruleVendor, setRuleVendor] = useState("*");
  const [ruleFrom, setRuleFrom] = useState("");
  const [ruleTo, setRuleTo] = useState("");
  const [ruleReason, setRuleReason] = useState("");
  const [ccUser, setCcUser] = useState("");
  const [ccValue, setCcValue] = useState("");

  // ---- ADR-0076: roster upload form ----
  const [rosterContent, setRosterContent] = useState("");
  const [rosterFormat, setRosterFormat] = useState<"csv" | "json">("json");
  const [rosterSource, setRosterSource] = useState("");
  const [rosterVendor, setRosterVendor] = useState("*");
  const [rosterReason, setRosterReason] = useState("");
  const [rosterResult, setRosterResult] = useState<RosterResult | null>(null);
  const [rosterFileError, setRosterFileError] = useState<string | null>(null);

  const [revoking, setRevoking] = useState<ImportBatch | null>(null);

  const adapter = (adapters.data?.adapters ?? []).find((x) => x.id === adapterId) ?? null;

  const refreshAll = () => {
    void history.refetch();
    void mappings.refetch();
    void consolidated.refetch();
    void reconciliation.refetch();
  };

  const readRosterFile = async (file: File | undefined) => {
    setRosterFileError(null);
    if (!file) return;
    try {
      const text = await file.text();
      setRosterContent(text);
      setRosterSource(file.name);
      if (file.name.toLowerCase().endsWith(".json")) setRosterFormat("json");
      else if (file.name.toLowerCase().endsWith(".csv")) setRosterFormat("csv");
    } catch (e) {
      setRosterFileError(e instanceof Error ? e.message : String(e));
    }
  };

  const submitRoster = async (mode: "dry_run" | "apply") => {
    setRosterResult(null);
    const body: Record<string, unknown> = {
      format: rosterFormat,
      mode,
      content: rosterContent,
      vendor: rosterVendor.trim() || "*",
      reason: rosterReason.trim(),
    };
    if (rosterSource.trim()) body.source = rosterSource.trim();
    const res = await act.run<RosterResult>(
      () => api.post<RosterResult>("/v1/cost-imports/roster", body),
      mode === "dry_run"
        ? "Roster dry run complete — nothing was written."
        : "Roster applied through the existing alias and cost-centre write paths.",
    );
    if (res) setRosterResult(res);
    refreshAll();
  };

  const runReconciliation = async () => {
    await act.run(
      () => api.post("/v1/cost-imports/reconcile", {}),
      "Reconciliation pass complete — duplicates marked, never deleted.",
    );
    refreshAll();
  };

  const readFile = async (file: File | undefined) => {
    setFileError(null);
    if (!file) return;
    try {
      const text = await file.text();
      setContent(text);
      setSource(file.name);
      if (file.name.toLowerCase().endsWith(".json")) setFormat("json");
      else if (file.name.toLowerCase().endsWith(".csv")) setFormat("csv");
    } catch (e) {
      setFileError(e instanceof Error ? e.message : String(e));
    }
  };

  const submitImport = async (mode: "dry_run" | "apply") => {
    setResult(null);
    let parsedConfig: unknown;
    if (config.trim()) {
      try {
        parsedConfig = JSON.parse(config) as unknown;
      } catch {
        act.setOutcome({
          ok: false,
          code: "invalid_adapter_config",
          status: null,
          reason: "The adapter configuration box is not valid JSON. Nothing was sent.",
          payload: null,
        });
        return;
      }
    }
    const body: Record<string, unknown> = { adapter: adapterId, format, mode, content };
    if (source.trim()) body.source = source.trim();
    if (parsedConfig !== undefined) body.config = parsedConfig;

    const res = await act.run<ImportResult>(
      () => api.post<ImportResult>("/v1/cost-imports", body),
      mode === "dry_run"
        ? "Dry run complete — nothing was written."
        : "Import applied. These figures are IMPORTED, not metered.",
    );
    if (res) setResult(res);
    refreshAll();
  };

  const revokeBatch = async (reason: string) => {
    if (!revoking) return;
    const target = revoking;
    setRevoking(null);
    await act.run(
      () => api.del(`/v1/cost-imports/${target.id}`, { reason }),
      "Batch revoked — its lines are withdrawn and the batch row remains as a record.",
    );
    refreshAll();
  };

  const subjects = consolidated.data?.subjects ?? [];

  return (
    <>
      <PageHeader
        title="Cross-vendor cost consolidation"
        sub={
          "One human's Claude Code seat, Copilot seat, raw API key and cloud AI spend, on one line — because per-seat " +
          "SaaS spend is invoice-side, not call-side, and no gateway can meter a bill it never saw."
        }
      />
      <div className={v.stack}>
        {/* --- THE HONESTY RULE. Leads the page. --------------------------- */}
        <Card title="Two kinds of number, never added">
          <div className={v.stack}>
            <p>
              <strong>metered</strong> means regulAIt saw the call and priced it.{" "}
              <strong>imported</strong> means regulAIt was <em>told</em>, by a file you exported. Nothing
              on this page adds them together, and{" "}
              <strong>no combined total exists to render</strong> — the API has no field for one.
            </p>
            <p className={v.dim}>{adapters.data?.basisStatement ?? "Loading the basis statement…"}</p>
            <p className={v.faint}>{adapters.data?.posture}</p>
            <p className={v.faint}>
              Imported figures are <strong>reporting-only</strong>: they never enter a billing statement,
              a budget, a forecast, the optimizer or any enforcement path. We will not block someone&apos;s
              work on a number we could not verify.
            </p>
          </div>
        </Card>

        {/* --- import ------------------------------------------------------ */}
        <Card title="Import a vendor export">
          <QueryGate
            loading={adapters.isLoading}
            error={adapters.error}
            onRetry={() => void adapters.refetch()}
          >
            <div className={v.stack}>
              <div className={a.formRow}>
                <Field label="Adapter">
                  <Select
                    value={adapterId}
                    onChange={(e) => setAdapterId(e.target.value)}
                    data-testid="ci-adapter"
                  >
                    {optionEls(
                      (adapters.data?.adapters ?? []).map((x) => ({
                        v: x.id,
                        l: `${x.displayName} · ${x.vendor}`,
                      })),
                    )}
                  </Select>
                </Field>
                <Field label="File format">
                  <Select
                    value={format}
                    onChange={(e) => setFormat(e.target.value as "csv" | "json")}
                    data-testid="ci-format"
                  >
                    {(adapter?.formats ?? ["csv", "json"]).map((f) => (
                      <option key={f} value={f}>
                        {f}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Where this came from (provenance)">
                  <Input
                    value={source}
                    onChange={(e) => setSource(e.target.value)}
                    placeholder="e.g. copilot-seats-2026-07.csv"
                    data-testid="ci-source"
                  />
                </Field>
              </div>

              {adapter && (
                <div className={v.stack}>
                  <div className={v.sectionTitle}>What this adapter cannot do</div>
                  {/* VERBATIM. The adapter's own sentence, not a paraphrase. */}
                  <p className={a.snippet} data-testid="ci-adapter-limits">
                    {adapter.limits}
                  </p>
                  <div className={v.row}>
                    <Badge tone={adapter.capabilities.amountFromFile ? "ok" : "warn"}>
                      {adapter.capabilities.amountFromFile
                        ? "the file carries the money"
                        : "the money is an operator assertion"}
                    </Badge>
                    <Badge tone={adapter.capabilities.accountIsEmail ? "ok" : "warn"}>
                      {adapter.capabilities.accountIsEmail
                        ? "account column is an email — resolves without an alias"
                        : "account column is not an email — an admin alias may be needed"}
                    </Badge>
                    <Badge tone={adapter.capabilities.currency ? "ok" : "neutral"}>
                      {adapter.capabilities.currency ? "currency from file" : "currency assumed"}
                    </Badge>
                  </div>
                  {ADAPTER_HINT[adapter.id] && <p className={v.dim}>{ADAPTER_HINT[adapter.id]}</p>}
                </div>
              )}

              <div className={a.formRow}>
                <Field label="Upload a file">
                  <input
                    type="file"
                    accept=".csv,.json,text/csv,application/json,text/plain"
                    onChange={(e) => void readFile(e.target.files?.[0])}
                    data-testid="ci-file"
                  />
                </Field>
              </div>
              {fileError && (
                <div className={v.errLine} role="alert">
                  {fileError}
                </div>
              )}

              <Field label="…or paste the export here" grow>
                <Textarea
                  rows={10}
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  spellCheck={false}
                  placeholder="account,amount,period&#10;alice@acme.com,19.00,2026-07"
                  data-testid="ci-content"
                />
              </Field>

              <Field label="Adapter configuration (JSON) — optional" grow>
                <Textarea
                  rows={3}
                  value={config}
                  onChange={(e) => setConfig(e.target.value)}
                  spellCheck={false}
                  placeholder='{"mapping":{"account":"user","amount":"cost"}}'
                  data-testid="ci-config"
                />
              </Field>

              <div className={v.row}>
                <Button
                  disabled={act.busy || !content.trim()}
                  onClick={() => void submitImport("dry_run")}
                  data-testid="ci-dry-run"
                >
                  Dry run (writes nothing)
                </Button>
                <Button
                  variant="primary"
                  disabled={act.busy || !content.trim()}
                  onClick={() => void submitImport("apply")}
                  data-testid="ci-apply"
                >
                  Apply
                </Button>
                <span className={v.faint}>
                  Re-applying the exact same bytes is refused with a 409 — applying twice would double every
                  figure the file contributed to.
                </span>
              </div>

              <OutcomePanel outcome={act.outcome} testId="ci-outcome">
                {/* A 4xx from the importer carries the refused LINE NUMBERS.
                    Dropping them is precisely what this slice was built not to
                    do, so they are rendered from the error body too. */}
                {act.outcome && !act.outcome.ok && Array.isArray(act.outcome.payload?.refusals) && (
                  <RefusalList
                    refusals={act.outcome.payload.refusals as RowRefusal[]}
                    testId="ci-outcome-refusals"
                  />
                )}
              </OutcomePanel>
            </div>
          </QueryGate>
        </Card>

        {/* --- the dry-run / apply result ---------------------------------- */}
        {result && (
          <Card
            title={result.mode === "dry_run" ? "Dry run — nothing was written" : "Applied"}
            actions={
              <Button size="sm" variant="ghost" onClick={() => setResult(null)}>
                Close
              </Button>
            }
          >
            <div className={v.stack} data-testid="ci-result">
              <div className={v.grid}>
                <Stat value={result.rowsParsed} label="Rows parsed" />
                <Stat value={result.rowsAccepted} label="Rows accepted" />
                <Stat value={result.rowsRefused} label="Rows refused" />
                <Stat
                  value={
                    result.totalUsd === null ? "no single figure" : fmtUsd(result.totalUsd)
                  }
                  label="Imported total in this file"
                />
              </div>
              <p className={v.faint}>
                <code>rows parsed = accepted + refused</code> is a database CHECK constraint, not a
                convention — a corrupt file returns fewer accepted rows <em>and says so</em>, rather than
                quietly returning less money.
              </p>
              {result.totalUsdNote && <p className={v.dim}>{result.totalUsdNote}</p>}

              <RefusalList
                refusals={result.refusals}
                truncated={result.refusalsTruncated}
                testId="ci-refusals"
              />

              <div className={v.sectionTitle}>How each accepted line found its human</div>
              <Table<{ method: string; n: number }>
                rows={Object.entries(result.resolution.byMethod).map(([method, n]) => ({ method, n }))}
                rowKey={(r) => r.method}
                columns={[
                  {
                    key: "method",
                    header: "Resolved by",
                    render: (r) => METHOD_LABEL[r.method] ?? r.method,
                  },
                  { key: "n", header: "Lines", render: (r) => <span className={v.num}>{r.n}</span> },
                ]}
              />
              {result.resolution.unattributedLines > 0 && (
                <div className={v.errLine} role="alert" data-testid="ci-unattributed">
                  {result.resolution.unattributedLines} accepted line(s), worth{" "}
                  {fmtUsd(result.resolution.unattributedAmount)}, resolved to no regulAIt user. They are
                  retained and reported as <strong>unattributed spend</strong>. Map the account below to
                  attribute them.
                </div>
              )}
              <p className={v.faint}>{result.resolution.note}</p>
              <KV
                rows={[
                  ["Import id", <span className={v.mono}>{result.importId}</span>],
                  ["Adapter", <code>{result.adapter}</code>],
                  ["Basis", <Badge tone="warn">imported — we were told, we did not observe</Badge>],
                  ["Currencies in the file", result.currencies.join(", ") || "—"],
                  [
                    "Period covered",
                    result.periodStart && result.periodEnd
                      ? `${result.periodStart.slice(0, 10)} → ${result.periodEnd.slice(0, 10)}`
                      : "not stated by the file",
                  ],
                  [
                    "Ingest scan",
                    `${result.ingestScan.verdict} at mode '${result.ingestScan.mode}'`,
                  ],
                ]}
              />
              <p className={v.faint}>{result.piiPosture}</p>
            </div>
          </Card>
        )}

        {/* --- consolidated view -------------------------------------------- */}
        <Card
          title="Consolidated view"
          actions={
            <Button
              size="sm"
              onClick={() =>
                void downloadCsv(
                  `/v1/cost-consolidated?${consolidatedQs}&format=csv`,
                  `regulait-consolidated-${by}-${from}.csv`,
                  (m) =>
                    act.setOutcome({ ok: false, code: null, status: null, reason: m, payload: null }),
                )
              }
            >
              Download CSV
            </Button>
          }
        >
          <div className={v.stack}>
            <div className={a.formRow}>
              <Field label="Group by">
                <Select
                  value={by}
                  onChange={(e) => setBy(e.target.value as "user" | "cost_center")}
                  data-testid="cc-by"
                >
                  <option value="user">person</option>
                  <option value="cost_center">cost centre</option>
                </Select>
              </Field>
              <Field label="From">
                <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} data-testid="cc-from" />
              </Field>
              <Field label="To">
                <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} data-testid="cc-to" />
              </Field>
            </div>

            <QueryGate
              loading={consolidated.isLoading}
              error={consolidated.error}
              onRetry={() => void consolidated.refetch()}
            >
              {subjects.length === 0 ? (
                <EmptyState
                  title="No spend of either basis in this window"
                  body="Widen the dates, or import a vendor export above."
                />
              ) : (
                <div className={v.stack} data-testid="cc-subjects">
                  {subjects.map((s) => (
                    <Card
                      key={`${s.subjectKind}:${s.subjectId ?? "null"}`}
                      title={
                        <span className={v.row}>
                          <span>{s.label}</span>
                          {!s.attributed && (
                            <Badge tone="danger" title="nobody was resolved for this spend">
                              unattributed
                            </Badge>
                          )}
                        </span>
                      }
                    >
                      <div className={v.stack}>
                        <BasisPair subject={s} />
                        {/* the API's own sentence about the split, in words */}
                        <p className={v.dim}>{s.coverage}</p>
                        {s.imported.byBillingKind.length > 0 && (
                          <p className={v.faint}>
                            Imported by kind:{" "}
                            {s.imported.byBillingKind
                              .map((k) => `${k.billingKind} ${k.amount.toFixed(2)} ${k.currency}`)
                              .join(", ")}
                          </p>
                        )}
                      </div>
                    </Card>
                  ))}
                </div>
              )}
            </QueryGate>

            <p className={v.dim} data-testid="cc-note">
              {consolidated.data?.note}
            </p>

            <div className={v.sectionTitle}>How fresh is the imported side?</div>
            {(consolidated.data?.staleness.vendors ?? []).length === 0 ? (
              <p className={v.faint}>
                No vendor export has been applied yet, so the imported side of every figure above is empty
                — not zero-spend, simply un-supplied.
              </p>
            ) : (
              <Table<{ vendor: string; lastImportedAt: string | null; appliedBatches: number; daysSinceLastImport: number | null }>
                rows={consolidated.data?.staleness.vendors ?? []}
                rowKey={(r) => r.vendor}
                columns={[
                  { key: "vendor", header: "Vendor", render: (r) => r.vendor },
                  { key: "batches", header: "Applied batches", render: (r) => r.appliedBatches },
                  {
                    key: "last",
                    header: "Last import",
                    render: (r) => (r.lastImportedAt ? ago(r.lastImportedAt) : "never"),
                  },
                  {
                    key: "stale",
                    header: "Days stale",
                    render: (r) =>
                      r.daysSinceLastImport === null ? (
                        <span className={v.faint}>unknown</span>
                      ) : (
                        <Badge tone={r.daysSinceLastImport > 45 ? "danger" : r.daysSinceLastImport > 14 ? "warn" : "ok"}>
                          {r.daysSinceLastImport}
                        </Badge>
                      ),
                  },
                ]}
              />
            )}
            <p className={v.faint}>{consolidated.data?.staleness.note}</p>
            {consolidated.data && consolidated.data.reconciliation.supersededLinesExcluded > 0 && (
              <p className={v.dim} data-testid="cc-reconciliation-note">
                {consolidated.data.reconciliation.supersededLinesExcluded} superseded duplicate line(s) are
                excluded from the imported side above — marked by a reconciliation pass, never deleted. The
                full list is in the reconciliation card below.
              </p>
            )}
          </div>
        </Card>

        {/* --- ADR-0076: scheduled reconciliation --------------------------- */}
        <Card
          title="Reconciliation — the same vendor line, never counted twice"
          actions={
            <Button
              size="sm"
              variant="primary"
              disabled={act.busy}
              onClick={() => void runReconciliation()}
              data-testid="rc-run-now"
            >
              Run now
            </Button>
          }
        >
          <QueryGate
            loading={reconciliation.isLoading}
            error={reconciliation.error}
            onRetry={() => void reconciliation.refetch()}
          >
            <div className={v.stack} data-testid="rc-card">
              <p className={v.dim}>{reconciliation.data?.posture}</p>
              <div className={v.grid}>
                <Stat value={reconciliation.data?.liveLines ?? 0} label="Live imported lines" />
                <Stat
                  value={reconciliation.data?.supersededLines ?? 0}
                  label="Superseded (marked, kept)"
                />
                <Stat
                  value={
                    reconciliation.data?.lastRun
                      ? ago(reconciliation.data.lastRun.startedAt)
                      : "never"
                  }
                  label="Last pass"
                />
                <Stat
                  value={reconciliation.data?.lastRun?.ambiguousGroups ?? 0}
                  label="Ambiguous groups (left alone)"
                />
              </div>
              {reconciliation.data?.lastRun && (
                <KV
                  rows={[
                    [
                      "Last pass outcome",
                      <Badge
                        tone={reconciliation.data.lastRun.outcome === "ok" ? "ok" : "danger"}
                      >
                        {reconciliation.data.lastRun.outcome}
                      </Badge>,
                    ],
                    ["Trigger", reconciliation.data.lastRun.trigger],
                    ["Lines scanned", String(reconciliation.data.lastRun.scannedLines)],
                    ["Duplicate groups marked", String(reconciliation.data.lastRun.duplicateGroups)],
                    [
                      "Overlapping windows reported (not touched)",
                      String(reconciliation.data.lastRun.overlapWarnings),
                    ],
                  ]}
                />
              )}
              {(reconciliation.data?.lastRun?.warnings ?? []).length > 0 && (
                <div className={v.stack} data-testid="rc-warnings">
                  <div className={v.sectionTitle}>What the last pass refused to decide</div>
                  {reconciliation.data!.lastRun!.warnings.slice(0, 10).map((w, i) => (
                    <p key={i} className={v.errLine} role="alert">
                      {w.detail}
                    </p>
                  ))}
                </div>
              )}
              {(reconciliation.data?.supersededSample ?? []).length > 0 && (
                <>
                  <div className={v.sectionTitle}>Superseded lines (marked, never deleted)</div>
                  <Table<ReconciliationReport["supersededSample"][number]>
                    rows={reconciliation.data?.supersededSample ?? []}
                    rowKey={(r) => r.id}
                    columns={[
                      { key: "vendor", header: "Vendor", render: (r) => r.vendor },
                      {
                        key: "account",
                        header: "Account",
                        render: (r) => <span className={v.mono}>{r.accountKey}</span>,
                      },
                      {
                        key: "amount",
                        header: "Amount",
                        render: (r) => `${r.amount.toFixed(2)} ${r.currency}`,
                      },
                      { key: "when", header: "Marked", render: (r) => ago(r.supersededAt) },
                      {
                        key: "why",
                        header: "Why",
                        render: (r) => <span className={v.dim}>{r.supersededReason}</span>,
                      },
                    ]}
                  />
                </>
              )}
              <p className={v.faint}>{reconciliation.data?.scheduler.note}</p>
            </div>
          </QueryGate>
        </Card>

        {/* --- identity mapping --------------------------------------------- */}
        <Card title="Identity mapping — which vendor account is which person">
          <QueryGate
            loading={mappings.isLoading}
            error={mappings.error}
            onRetry={() => void mappings.refetch()}
          >
            <div className={v.stack}>
              <p className={v.dim}>{mappings.data?.posture}</p>

              <div className={v.sectionTitle}>Admin aliases (highest precedence)</div>
              <div className={a.formRow}>
                <Field label="Vendor (* = any)">
                  <Input value={aliasVendor} onChange={(e) => setAliasVendor(e.target.value)} data-testid="al-vendor" />
                </Field>
                <Field label="Vendor account, exactly as the file spells it" grow>
                  <Input
                    value={aliasAccount}
                    onChange={(e) => setAliasAccount(e.target.value)}
                    placeholder="e.g. a.smith@contractor.example"
                    data-testid="al-account"
                  />
                </Field>
                <Field label="Is this person">
                  <Select value={aliasUser} onChange={(e) => setAliasUser(e.target.value)} data-testid="al-user">
                    {optionEls(userOpts(users.data?.users), "pick a user")}
                  </Select>
                </Field>
                <Field label="Reason for this alias (audited)" grow>
                  <Input value={aliasReason} onChange={(e) => setAliasReason(e.target.value)} data-testid="al-reason" />
                </Field>
                <Button
                  disabled={act.busy || !aliasAccount.trim() || !aliasUser || !aliasReason.trim()}
                  onClick={() =>
                    void act
                      .run(
                        () =>
                          api.post("/v1/cost-imports/mappings", {
                            vendor: aliasVendor.trim() || "*",
                            accountRef: aliasAccount.trim(),
                            userId: aliasUser,
                            reason: aliasReason.trim(),
                          }),
                        "Alias saved — every stored line was re-resolved against it.",
                      )
                      .then(() => {
                        setAliasAccount("");
                        setAliasReason("");
                        refreshAll();
                      })
                  }
                  data-testid="al-save"
                >
                  Assert
                </Button>
              </div>
              <Table<AliasRow>
                rows={mappings.data?.aliases ?? []}
                rowKey={(r) => r.id}
                empty={<EmptyState title="No aliases yet" body="Only needed where the account column is not already a matching email." />}
                columns={[
                  { key: "vendor", header: "Vendor", render: (r) => <code>{r.vendor}</code> },
                  { key: "account", header: "Account", render: (r) => <span className={v.mono}>{r.accountKey}</span> },
                  {
                    key: "user",
                    header: "Is",
                    render: (r) => names.userEmail.get(r.userId) ?? shortId(r.userId),
                  },
                  { key: "reason", header: "Reason", render: (r) => <span className={v.dim}>{r.reason}</span> },
                  {
                    key: "rm",
                    header: "",
                    render: (r) => (
                      <Button
                        size="sm"
                        variant="danger"
                        disabled={act.busy}
                        onClick={() =>
                          void act
                            .run(
                              () => api.del(`/v1/cost-imports/mappings/${r.id}`),
                              "Alias removed — stored lines were re-resolved without it.",
                            )
                            .then(refreshAll)
                        }
                      >
                        Remove
                      </Button>
                    ),
                  },
                ]}
              />

              <div className={v.sectionTitle}>Domain rules (lowest precedence)</div>
              <div className={a.formRow}>
                <Field label="Vendor (* = any)">
                  <Input value={ruleVendor} onChange={(e) => setRuleVendor(e.target.value)} data-testid="dr-vendor" />
                </Field>
                <Field label="Accounts at this domain…">
                  <Input
                    value={ruleFrom}
                    onChange={(e) => setRuleFrom(e.target.value)}
                    placeholder="acme-legacy.com"
                    data-testid="dr-from"
                  />
                </Field>
                <Field label="…resolve against this one">
                  <Input
                    value={ruleTo}
                    onChange={(e) => setRuleTo(e.target.value)}
                    placeholder="acme.com"
                    data-testid="dr-to"
                  />
                </Field>
                <Field label="Reason for this domain rule (audited)" grow>
                  <Input value={ruleReason} onChange={(e) => setRuleReason(e.target.value)} data-testid="dr-reason" />
                </Field>
                <Button
                  disabled={act.busy || !ruleFrom.trim() || !ruleTo.trim() || !ruleReason.trim()}
                  onClick={() =>
                    void act
                      .run(
                        () =>
                          api.post("/v1/cost-imports/domain-rules", {
                            vendor: ruleVendor.trim() || "*",
                            fromDomain: ruleFrom.trim(),
                            toDomain: ruleTo.trim(),
                            reason: ruleReason.trim(),
                          }),
                        "Domain rule saved — every stored line was re-resolved against it.",
                      )
                      .then(() => {
                        setRuleFrom("");
                        setRuleTo("");
                        setRuleReason("");
                        refreshAll();
                      })
                  }
                  data-testid="dr-save"
                >
                  Add rule
                </Button>
              </div>
              <Table<DomainRuleRow>
                rows={mappings.data?.domainRules ?? []}
                rowKey={(r) => r.id}
                empty={<EmptyState title="No domain rules yet" />}
                columns={[
                  { key: "vendor", header: "Vendor", render: (r) => <code>{r.vendor}</code> },
                  { key: "rule", header: "Rule", render: (r) => <span className={v.mono}>{r.fromDomain} → {r.toDomain}</span> },
                  { key: "enabled", header: "Enabled", render: (r) => <Badge tone={r.enabled ? "ok" : "neutral"}>{r.enabled ? "yes" : "no"}</Badge> },
                  { key: "reason", header: "Reason", render: (r) => <span className={v.dim}>{r.reason}</span> },
                  {
                    key: "rm",
                    header: "",
                    render: (r) => (
                      <Button
                        size="sm"
                        variant="danger"
                        disabled={act.busy}
                        onClick={() =>
                          void act
                            .run(
                              () => api.del(`/v1/cost-imports/domain-rules/${r.id}`),
                              "Domain rule removed — stored lines were re-resolved without it.",
                            )
                            .then(refreshAll)
                        }
                      >
                        Remove
                      </Button>
                    ),
                  },
                ]}
              />
              <p className={v.faint}>
                Two rules that resolve one account to two different people resolve it to{" "}
                <strong>nobody</strong>. Ambiguity is never broken by guessing, and an unmatched account is
                never spread pro-rata across the people who did resolve.
              </p>

              <div className={v.sectionTitle}>Cost centre for a person</div>
              <p className={v.faint}>
                <code>projects.cost_center</code> covers governed work. A Copilot seat is not a project, so
                a human needs one too — this is the key the &ldquo;by cost centre&rdquo; view groups on.
              </p>
              <div className={a.formRow}>
                <Field label="Person">
                  <Select value={ccUser} onChange={(e) => setCcUser(e.target.value)} data-testid="cc-user">
                    {optionEls(userOpts(users.data?.users), "pick a user")}
                  </Select>
                </Field>
                <Field label="Cost centre (blank clears it)">
                  <Input value={ccValue} onChange={(e) => setCcValue(e.target.value)} data-testid="cc-value" />
                </Field>
                <Button
                  disabled={act.busy || !ccUser}
                  onClick={() =>
                    void act
                      .run(
                        () =>
                          api.put(`/v1/users/${ccUser}/cost-center`, {
                            costCenter: ccValue.trim() === "" ? null : ccValue.trim(),
                          }),
                        "Cost centre saved.",
                      )
                      .then(refreshAll)
                  }
                  data-testid="cc-save"
                >
                  Save
                </Button>
              </div>
            </div>
          </QueryGate>
        </Card>

        {/* --- ADR-0076: roster upload --------------------------------------- */}
        <Card title="Roster upload — bulk identity mapping from your directory">
          <div className={v.stack}>
            <p className={v.dim}>
              Consume a SCIM-style user export (JSON) or a CSV roster to assert vendor-account aliases and
              person-level cost centres <strong>in bulk, through the same write paths</strong> as the forms
              above. An account mapped to two people — or one person given two cost centres — is refused
              loudly, never resolved by guessing.
            </p>
            <div className={a.formRow}>
              <Field label="Format">
                <Select
                  value={rosterFormat}
                  onChange={(e) => setRosterFormat(e.target.value as "csv" | "json")}
                  data-testid="ro-format"
                >
                  <option value="json">JSON (SCIM or rows)</option>
                  <option value="csv">CSV</option>
                </Select>
              </Field>
              <Field label="Vendor for asserted aliases (* = any)">
                <Input value={rosterVendor} onChange={(e) => setRosterVendor(e.target.value)} data-testid="ro-vendor" />
              </Field>
              <Field label="Where this came from (provenance)" grow>
                <Input
                  value={rosterSource}
                  onChange={(e) => setRosterSource(e.target.value)}
                  placeholder="e.g. okta-export-2026-08.json"
                  data-testid="ro-source"
                />
              </Field>
            </div>
            <div className={a.formRow}>
              <Field label="Upload a file">
                <input
                  type="file"
                  accept=".csv,.json,text/csv,application/json,text/plain"
                  onChange={(e) => void readRosterFile(e.target.files?.[0])}
                  data-testid="ro-file"
                />
              </Field>
            </div>
            {rosterFileError && (
              <div className={v.errLine} role="alert">
                {rosterFileError}
              </div>
            )}
            <Field label="…or paste the export here" grow>
              <Textarea
                rows={8}
                value={rosterContent}
                onChange={(e) => setRosterContent(e.target.value)}
                spellCheck={false}
                placeholder='{"Resources":[{"userName":"a.smith@vendorbill.example","emails":[{"value":"alice@acme.com","primary":true}]}]}'
                data-testid="ro-content"
              />
            </Field>
            <Field label="Reason for this bulk assertion (audited, stamped on every alias)" grow>
              <Input value={rosterReason} onChange={(e) => setRosterReason(e.target.value)} data-testid="ro-reason" />
            </Field>
            <div className={v.row}>
              <Button
                disabled={act.busy || !rosterContent.trim() || !rosterReason.trim()}
                onClick={() => void submitRoster("dry_run")}
                data-testid="ro-dry-run"
              >
                Dry run (writes nothing)
              </Button>
              <Button
                variant="primary"
                disabled={act.busy || !rosterContent.trim() || !rosterReason.trim()}
                onClick={() => void submitRoster("apply")}
                data-testid="ro-apply"
              >
                Apply
              </Button>
              <span className={v.faint}>
                Identity columns are join keys (PII-exempt by disclosed construction); the cost-centre column
                is scanned. Unmapped columns are discarded at parse.
              </span>
            </div>
            <OutcomePanel outcome={act.outcome} testId="ro-outcome" />
            {rosterResult && (
              <div className={v.stack} data-testid="ro-result">
                <div className={v.grid}>
                  <Stat value={rosterResult.rowsParsed} label="Rows parsed" />
                  <Stat value={rosterResult.rowsAccepted} label="Rows accepted" />
                  <Stat value={rosterResult.rowsRefused} label="Rows refused" />
                  <Stat
                    value={
                      rosterResult.applied
                        ? `${rosterResult.aliasesCreated ?? 0} / ${rosterResult.aliasesUpdated ?? 0}`
                        : `${rosterResult.counts.aliasesToCreate} / ${rosterResult.counts.aliasesToUpdate}`
                    }
                    label={rosterResult.applied ? "Aliases created / updated" : "Aliases to create / update"}
                  />
                </div>
                <KV
                  rows={[
                    ["Dialect", rosterResult.dialect === "scim" ? "SCIM user export" : "column-mapped rows"],
                    [
                      "Unnecessary aliases (account already the directory address)",
                      String(rosterResult.counts.aliasesUnnecessary),
                    ],
                    [
                      "Cost centres",
                      rosterResult.applied
                        ? `${rosterResult.costCentersSet ?? 0} set, ${rosterResult.counts.costCentersUnchanged} unchanged`
                        : `${rosterResult.counts.costCentersToSet} to set, ${rosterResult.counts.costCentersUnchanged} unchanged`,
                    ],
                    [
                      "Stored lines re-attributed",
                      rosterResult.reresolved ? String(rosterResult.reresolved.changed) : "— (dry run)",
                    ],
                    ["Ingest scan", `${rosterResult.ingestScan.verdict} at mode '${rosterResult.ingestScan.mode}'`],
                  ]}
                />
                <RefusalList
                  refusals={rosterResult.refusals}
                  truncated={rosterResult.refusalsTruncated}
                  testId="ro-refusals"
                />
                <p className={v.faint}>{rosterResult.posture}</p>
                <p className={v.faint}>{rosterResult.piiPosture}</p>
              </div>
            )}
          </div>
        </Card>

        {/* --- import history ------------------------------------------------ */}
        <Card title="Import history">
          <QueryGate
            loading={history.isLoading}
            error={history.error}
            onRetry={() => void history.refetch()}
          >
            <Table<ImportBatch>
              rows={history.data?.imports ?? []}
              rowKey={(r) => r.id}
              empty={<EmptyState title="Nothing imported yet" />}
              columns={[
                { key: "when", header: "When", render: (r) => ago(r.createdAt) },
                { key: "adapter", header: "Adapter", render: (r) => <code>{r.adapter}</code> },
                { key: "vendor", header: "Vendor", render: (r) => r.vendor },
                { key: "mode", header: "Mode", render: (r) => r.mode },
                {
                  key: "status",
                  header: "Status",
                  render: (r) => (
                    <Badge
                      tone={
                        r.status === "refused"
                          ? "danger"
                          : r.status === "applied"
                            ? "ok"
                            : r.status === "revoked"
                              ? "warn"
                              : "neutral"
                      }
                    >
                      {r.status}
                    </Badge>
                  ),
                },
                {
                  key: "rows",
                  header: "Parsed / accepted / refused",
                  render: (r) => (
                    <span className={v.num}>
                      {r.rowsParsed} / {r.rowsAccepted} / {r.rowsRefused}
                    </span>
                  ),
                },
                {
                  key: "usd",
                  header: "Imported",
                  render: (r) =>
                    r.totalUsd === null ? <span className={v.faint}>no single figure</span> : fmtUsd(r.totalUsd),
                },
                { key: "reason", header: "Outcome", render: (r) => <span className={v.dim}>{r.reason}</span> },
                {
                  key: "act",
                  header: "",
                  render: (r) =>
                    r.status === "applied" ? (
                      <Button size="sm" variant="danger" onClick={() => setRevoking(r)}>
                        Revoke
                      </Button>
                    ) : null,
                },
              ]}
            />
            <p className={v.faint}>
              A refused import is recorded, not discarded — &ldquo;somebody tried to import July&apos;s
              invoice and it would not parse&rdquo; is exactly the kind of thing an auditor asks about
              later. Revoking withdraws a batch&apos;s lines and keeps the batch row.
            </p>
          </QueryGate>
        </Card>
      </div>

      <ReasonModal
        open={revoking !== null}
        title={revoking ? `Withdraw the lines from this ${revoking.vendor} import?` : ""}
        danger
        confirmLabel="Revoke batch"
        placeholder="why this batch is being withdrawn (required, audited)"
        body={
          <p>
            The imported cost lines are deleted and every consolidated figure they contributed to changes.
            The batch row itself is <strong>kept</strong>, marked revoked, with your reason attached. This
            is the correction path: revoke, then re-import the corrected file.
          </p>
        }
        onConfirm={(reason) => void revokeBatch(reason)}
        onCancel={() => setRevoking(null)}
      />
    </>
  );
}
