/**
 * Audit log — the single trail every pillar writes into. Filterable by user
 * and by A4's deploy-mode dimension, full-trail CSV export (the screen shows
 * the latest 100 rows), and the §8.4 retention floor + governed prune (owned
 * confirm, itself audited).
 *
 * DEPLOY-MODE HONESTY (ADR-0027 §2a). `deploy_mode` is written only by
 * deploy-mode-scoped actions (workflow deploy/rollback executors, governed
 * infra mutations on target-pinned resources). Everything else — and EVERY row
 * written before migration 0044 — carries null, which ADR-0027 states is
 * "un-backfillable by design … an honest absence, never an invented value".
 * So the filter offers `unknown / pre-0044` as an explicit, equal option, the
 * table renders those rows as a plain "unknown" (never a mode, never a dash
 * that reads as "none"), and the card says out loud that unknown is two
 * different real things and cannot be resolved into a mode retroactively.
 */
import { DecisionReceiptsPanel } from "./DecisionReceiptsPanel";
import { anchorsStatus, receiptsStatus, retentionStatus, type EvidenceStatus } from "./auditEvidenceStatus";
import ev from "./auditLog.module.css";
import { AnchorTimestampsPanel } from "./AnchorTimestampsPanel";
import { AUDIT_OBJECT_LINK_TYPES } from "./auditObjectLinks";
import { lazy, Suspense, useMemo, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { api } from "../../../api/client";
import type { AuditEntry } from "../../../api/types";
import { UUID_RE, actorLabel, fmtAt, frameworkLabel, humanize, plural, shortId } from "../../../api/format";
import type { AuditRetention } from "../../../api/adminTypes";
import { PageHeader } from "../../../shell/AppShell";
import { Badge, Button, Card, ConfirmModal, EmptyState, Field, InfoButton, Select, Table, type Tone } from "../../../ui/kit";
import { useToast } from "../../../ui/toast";
import { downloadCsv, optionEls, useAction, useUsers, userOpts } from "../adminKit";
import a from "../admin.module.css";
import v from "../../views.module.css";

// ADR-0189 B6: a decision's Decision BOM, opened from its audit row
const DecisionBomPanel = lazy(() => import("./DecisionBomPanel").then((m) => ({ default: m.DecisionBomPanel })));
/**
 * The object types a receipt-eligible decision can have (`RECEIPT_OBJECT_TYPES`
 * in @regulait/shared). Eligibility also needs `detail.receiptClass =
 * "decision"`, which this list does not carry, so the gateway has the last
 * word (422 `bom_decision_not_eligible`, shown as such).
 */
const RECEIPT_OBJECT_TYPES = new Set(["mcp_tool", "agent", "connector", "approval"]);

const effectTone = (effect: string): Tone =>
  effect === "allow" ? "ok" : effect === "deny" ? "danger" : effect === "require_approval" ? "warn" : "neutral";

/** the four filter values the backend accepts; `unknown` maps to
 * `deploy_mode IS NULL`, which is a first-class bucket, not an "other". */
const MODE_OPTS = [
  { v: "hosted", l: "Hosted" },
  { v: "byoc", l: "BYOC" },
  { v: "air_gapped", l: "Air-gapped" },
  { v: "unknown", l: "None recorded" },
];
const modeLabel = (mode: string) => MODE_OPTS.find((o) => o.v === mode)?.l ?? mode;

/** one page of GET /v1/audit — the server decides the page size */
interface AuditPage {
  entries: AuditEntry[];
  pageSize: number;
  hasMore: boolean;
  nextCursor: string | null;
}

export default function AuditLogPage() {
  const users = useUsers();
  const { toast } = useToast();
  const act = useAction();
  const [userId, setUserId] = useState("");
  const [deployMode, setDeployMode] = useState("");
  const [confirmPrune, setConfirmPrune] = useState(false);
  const [bomAuditId, setBomAuditId] = useState<string | null>(null);
  // ADR-0190 owner decision C (A1): `?id=<audit row>` shows that one row (an evidence link, e.g. from a Decision BOM)
  const [search, setSearch] = useSearchParams();
  const rowParam = search.get("id");
  const onlyRow = rowParam !== null && UUID_RE.test(rowParam) ? rowParam.toLowerCase() : null;
  // owner decision on #453 (2026-10-20): `?objectType=…&objectId=…` shows one object's trail, e.g. a use case's,
  // linked from its Audit tab. Both are needed; a malformed id or a type no console link opens is ignored rather than
  // sent (the gateway refuses an unknown type with 400), and the page says so
  const objectParam = search.get("objectId");
  const objectTypeParam = search.get("objectType");
  const onlyObject = objectParam !== null && UUID_RE.test(objectParam) && objectTypeParam !== null && AUDIT_OBJECT_LINK_TYPES.has(objectTypeParam)
    ? { type: objectTypeParam, id: objectParam.toLowerCase() }
    : null;
  const objectLinkIgnored = !onlyObject && (objectParam !== null || objectTypeParam !== null);

  const qs = useMemo(() => {
    const p = new URLSearchParams();
    if (onlyRow) p.set("id", onlyRow);
    if (onlyObject) {
      p.set("objectType", onlyObject.type);
      p.set("objectId", onlyObject.id);
    }
    if (userId) p.set("userId", userId);
    if (deployMode) p.set("deployMode", deployMode);
    const s = p.toString();
    return s ? `?${s}` : "";
  }, [onlyRow, onlyObject?.type, onlyObject?.id, userId, deployMode]);
  // #465 review L5: one object's trail downloads under its own name, as the gateway's filename does
  const fileStem = `audit-log${onlyObject ? `-${onlyObject.id.slice(0, 8)}` : ""}`;

  const retention = useQuery({
    queryKey: ["admin", "audit-retention"],
    queryFn: () => api.get<AuditRetention>("/v1/audit/retention"),
  });
  // Cursor-paged: the server hands back 100 rows and a cursor for the older
  // ones. The table used to stop at the first page with no sign that 306
  // older rows existed (UIA-02); now it says how many are shown and loads
  // older pages on request.
  const audit = useInfiniteQuery({
    queryKey: ["admin", "audit", onlyRow, onlyObject?.type ?? null, onlyObject?.id ?? null, userId, deployMode],
    queryFn: ({ pageParam }) =>
      api.get<AuditPage>(`/v1/audit${qs}${pageParam ? `${qs ? "&" : "?"}cursor=${encodeURIComponent(pageParam)}` : ""}`),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => (last.hasMore && last.nextCursor ? last.nextCursor : null),
  });

  const nameOf = useMemo(
    () => new Map((users.data?.users ?? []).map((u) => [u.id, u.displayName || u.email])),
    [users.data],
  );
  const rows = useMemo(
    () =>
      (audit.data?.pages ?? [])
        .flatMap((p) => p.entries ?? [])
        .map((e, i) => ({ ...e, rowKey: e.id ?? `${e.at}-${i}` })),
    [audit.data],
  );
  const ret = retention.data;
  // the same reads the folded panels make (same query keys, so one request each), for the summaries' state
  const receipts = useQuery({ queryKey: ["admin", "decision-receipts-status"], retry: false, queryFn: () => api.get<{ state?: string }>("/v1/receipts/status") });
  const anchors = useQuery({ queryKey: ["admin", "anchor-timestamps"], retry: false, queryFn: () => api.get<{ anchors?: Array<{ timestamp?: { status?: string; verified?: boolean } }> }>("/v1/audit/anchors") });

  return (
    <>
      <PageHeader
        title="Audit log"
        sub="Every governed decision, lifecycle action and settings change."
        info={<p>Every governed decision, lifecycle action and settings change lands here — one trail, all eight pillars. Filter by user and by deploy mode; the table loads the newest rows first and older ones on request, and the CSV export carries the full filtered trail.</p>}
        actions={
          <>
            <Button
              variant="ghost"
              onClick={() =>
                void downloadCsv(`/v1/audit.csv${qs}`, `${fileStem}.csv`, (msg) => toast(msg, "error"))
              }
            >
              Download CSV
            </Button>
            <InfoButton label="the CSV export" align="end">
              <p>Downloads the full filtered trail, not only the rows loaded in the table.</p>
            </InfoButton>
            <Button
              variant="primary"
              onClick={() => {
                const join = qs ? "&" : "?";
                void downloadCsv(`/v1/audit.csv${qs}${join}signed=1`, `${fileStem}.signed.tar.gz`, (msg) => toast(msg, "error"));
              }}
            >
              Download signed bundle
            </Button>
            <InfoButton label="the signed bundle" align="end">
              <p>A signed package of the full filtered trail with a manifest, which an auditor can verify offline.</p>
            </InfoButton>
          </>
        }
      />
      <div className={v.stack}>
        {/* G8: the chain's state is the first thing an auditor asks, so it leads; it is never green until a check runs */}
        <ChainIntegrityCard />
        <Card
          title="Entries"
          contain
          // M2: the header says how much of the trail is loaded, and the paging line sits outside the scroll box
          count={rows.length > 0 ? rows.length : undefined}
          countNoun={audit.hasNextPage ? ["newest row loaded, older rows exist", "newest rows loaded, older rows exist"] : ["row", "rows"]}
          footer={rows.length > 0 && (
            <div className={v.row} data-testid="audit-paging">
              <span className={v.dim}>
                {audit.hasNextPage
                  ? `Showing the newest ${plural(rows.length, "row")} — older rows exist`
                  : `Showing all ${plural(rows.length, "row")}`}
              </span>
              {audit.hasNextPage && (
                <Button size="sm" disabled={audit.isFetchingNextPage} onClick={() => void audit.fetchNextPage()}>
                  {audit.isFetchingNextPage ? "Loading…" : "Load older"}
                </Button>
              )}
            </div>
          )}
          actions={
            <div className={a.formRow}>
              <Field label="Filter by user">
                <Select value={userId} onChange={(e) => setUserId(e.target.value)}>
                  {optionEls(userOpts(users.data?.users), "— all users —")}
                </Select>
              </Field>
              <Field
                label="Filter by deploy mode"
                helpLabel="a recorded deploy mode"
                help={
                  <p>
                    Only deploy-scoped actions — workflow deploys and rollbacks, governed infrastructure changes —
                    carry a deploy mode. Other rows (tool calls, membership, settings) show <strong>not recorded</strong>, and
                    older rows recorded before deploy modes existed are never back-filled or guessed.
                  </p>
                }
              >
                <Select value={deployMode} onChange={(e) => setDeployMode(e.target.value)}>
                  {optionEls(MODE_OPTS, "— any mode —")}
                </Select>
              </Field>
            </div>
          }
        >
          {onlyRow && (
            <p role="status" data-testid="audit-only-row">
              Showing one audit row, <code className={v.mono}>{onlyRow}</code>.{" "}
              <Button size="sm" variant="ghost" onClick={() => setSearch((p) => { const n = new URLSearchParams(p); n.delete("id"); return n; })}>
                Show every row
              </Button>
            </p>
          )}
          {objectLinkIgnored && (
            <p role="status" data-testid="audit-object-link-ignored">
              This link&apos;s object filter was not applied: it needs a known object type and an object id. Showing every row.{" "}
              <Button size="sm" variant="ghost" onClick={() => setSearch((p) => { const n = new URLSearchParams(p); n.delete("objectType"); n.delete("objectId"); return n; })}>
                Clear the link
              </Button>
            </p>
          )}
          {onlyObject && (
            <p role="status" data-testid="audit-only-object">
              Showing the audit trail of one {onlyObject.type === "ai_use_case" ? "AI use case" : humanize(onlyObject.type).toLowerCase()},{" "}
              <code className={v.mono}>{onlyObject.id}</code>. The CSV export covers the same rows.{" "}
              <Button size="sm" variant="ghost" onClick={() => setSearch((p) => { const n = new URLSearchParams(p); n.delete("objectType"); n.delete("objectId"); return n; })}>
                Show every row
              </Button>
            </p>
          )}
          <Table<AuditEntry & { rowKey: string }>
            columns={[
              {
                key: "at",
                header: "At",
                sort: (e) => e.at,
                render: (e) => <span className={v.mono} style={{ whiteSpace: "nowrap" }} title={String(e.at)}>{fmtAt(e.at)}</span>,
              },
              {
                key: "user",
                header: "User",
                render: (e) => <span style={{ whiteSpace: "nowrap" }}>{actorLabel(e.userId, nameOf)}</span>,
              },
              {
                // the event: the rule, with the object it touched as a faint prefix
                key: "event",
                header: "Event",
                sort: (e) => `${e.objectType ?? ""} ${e.ruleId}`,
                render: (e) => (
                  <span style={{ whiteSpace: "nowrap" }} title={e.ruleId}>
                    {e.objectType ? <span className={v.faint}>{humanize(e.objectType)} · </span> : null}
                    {UUID_RE.test(e.ruleId) ? `Policy rule ${shortId(e.ruleId)}` : humanize(e.ruleId)}
                  </span>
                ),
              },
              {
                key: "effect",
                header: "Effect",
                sort: (e) => e.effect,
                // the expected outcome is plain text; only a deny or a held action is tagged
                render: (e) => e.effect === "allow"
                  ? <span className={v.dim}>allow</span>
                  : <Badge tone={effectTone(e.effect)}>{e.effect.replaceAll("_", " ")}</Badge>,
              },
              {
                key: "deployMode",
                header: "Deploy mode",
                info: <p>&ldquo;Not recorded&rdquo; means no deploy mode was recorded, because the action is not deploy-scoped or predates deploy modes. It is never back-filled.</p>,
                sort: (e) => e.deployMode ?? "unknown",
                render: (e) =>
                  e.deployMode ? (
                    <span>{modeLabel(e.deployMode)}</span>
                  ) : (
                    <span className={v.dim} style={{ whiteSpace: "nowrap" }}>Not recorded</span>
                  ),
              },
              { key: "reason", header: "Reason", render: (e) => <ReasonCell reason={e.reason} /> },
              {
                key: "bom",
                header: "Evidence",
                render: (e) =>
                  e.id && e.objectType && RECEIPT_OBJECT_TYPES.has(e.objectType) ? (
                    <Button size="sm" variant="ghost" aria-label={`Decision BOM for audit row ${e.id}`} onClick={() => setBomAuditId(e.id!)}>
                      Decision BOM
                    </Button>
                  ) : null,
              },
            ]}
            rows={rows}
            rowKey={(e) => e.rowKey}
            loading={audit.isLoading}
            error={audit.error}
            onRetry={() => void (audit.isFetchNextPageError ? audit.fetchNextPage() : audit.refetch())}
            empty={
              <EmptyState
                title="No audit rows match"
                body={
                  deployMode && deployMode !== "unknown"
                    ? `No row records the ${modeLabel(deployMode)} deploy mode yet — only deploy-scoped actions carry one. Clear the filter to see the full trail.`
                    : "Every governed action writes here — try clearing the filter."
                }
              />
            }
          />
        </Card>
        {bomAuditId && (
          <Suspense fallback={<p role="status">Loading the Decision BOM…</p>}>
            <DecisionBomPanel key={bomAuditId} auditId={bomAuditId} onClose={() => setBomAuditId(null)} />
          </Suspense>
        )}
        {/* the trail first, so the newest decisions are on screen without scrolling; the evidence tools follow it,
            folded, each summary carrying its live state so a warning is never behind the fold (G8 f, #453) */}
        <EvidenceFold title="Signed decision receipts" status={receiptsStatus(receipts)}>
          <DecisionReceiptsPanel bare />
        </EvidenceFold>
        <EvidenceFold title="Anchor timestamps" status={anchorsStatus(anchors)}>
          <AnchorTimestampsPanel bare />
        </EvidenceFold>
        <EvidenceFold title="Retention" status={retentionStatus(ret, retention.isError)}>
        <Card>
          {ret == null ? (
            <span className={v.dim}>Loading retention…</span>
          ) : ret.retainedDays == null ? (
            <p className={v.dim}>
              No compliance profile sets a retention — nothing is eligible for pruning (all rows kept).
            </p>
          ) : (
            <div className={v.row}>
              <span>
                Global floor <strong>{ret.retainedDays} days</strong>{" "}
                <span className={v.dim}>
                  (set by {(ret.floorSource ?? []).map(frameworkLabel).join(", ") || "the organisation default"}) ·{" "}
                  <strong>{plural(ret.prunable, "row")}</strong> older than that
                </span>
              </span>
              <span className={v.grow} />
              <Button disabled={!ret.prunable} onClick={() => setConfirmPrune(true)}>
                Prune audit log
              </Button>
            </div>
          )}
          <p className={v.faint}>
            Retention is the longest period any active compliance profile requires, combined with the
            organisation default — a framework with a shorter period never shortens another framework's
            trail. Pruning is itself audited.
          </p>
        </Card>
        </EvidenceFold>
      </div>

      <ConfirmModal
        open={confirmPrune}
        title={`Delete ${plural(ret?.prunable ?? 0, "audit row")}?`}
        body={`Rows older than the ${ret?.retainedDays ?? "—"}-day global floor are removed permanently. The prune itself writes an audit row.`}
        danger
        confirmLabel="Prune"
        onCancel={() => setConfirmPrune(false)}
        onConfirm={() => {
          setConfirmPrune(false);
          void act.run(async () => {
            const r = await api.post<{ deleted: number; retainedDays: number; floorSource?: string[] }>(
              "/v1/audit/prune",
              {},
            );
            toast(
              `Pruned ${plural(r.deleted, "audit row")} — ${r.retainedDays}-day floor set by ${(r.floorSource ?? []).map(frameworkLabel).join(", ")}`,
              "success",
            );
          }, null);
        }}
      />
    </>
  );
}

/** G8 (f): a folded evidence panel; the summary names it and shows its state, so the fold never hides a warning */
function EvidenceFold(props: { title: string; status: EvidenceStatus; children: React.ReactNode }) {
  return (
    <details className={ev.fold}>
      <summary className={ev.summary}>
        <span className={ev.title}>{props.title}</span>
        <Badge tone={props.status.tone}>{props.status.label}</Badge>
      </summary>
      <div className={ev.body}>{props.children}</div>
    </details>
  );
}

/** G8: a long reason opens in place (Show more) instead of hiding behind a hover-only title */
function ReasonCell({ reason }: { reason?: string | null }) {
  const [open, setOpen] = useState(false);
  if (!reason) return <span className={v.dim}>—</span>;
  if (reason.length <= 90) return <span className={v.dim}>{reason}</span>;
  return (
    <span className={v.dim}>
      {open ? reason : `${reason.slice(0, 80).trimEnd()}…`}{" "}
      <Button size="sm" variant="ghost" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {open ? "Show less" : "Show more"}
      </Button>
    </span>
  );
}

/** ADR-0060 verify report — only the fields this card renders. */
interface VerifyReport {
  status: "ok" | "broken" | "empty";
  scanned: { rows: number; bounded: boolean };
  legacy: { unchainedRowsBeforeGenesis: number; disclosure: string };
  firstBreak: { seq: number; reason: string } | null;
  anchor: {
    checked: boolean;
    source: "caller_supplied" | "worm_sink" | "database" | "none";
    tamperResistant: boolean;
    sinkMode: string | null;
    seq: number | null;
    matches: boolean | null;
    unanchoredRows: number | null;
    disclosure: string;
    /** an anchor in the store past this chain's head: another chain sharing
     * the store, or rows removed after it was taken — reported, never graded
     * as a hash mismatch (UIA-01) */
    aheadOfHead: { seq: number; capturedAt: string; disclosure: string } | null;
  };
}

const ANCHOR_SOURCE_LABEL: Record<VerifyReport["anchor"]["source"], string> = {
  caller_supplied: "supplied by the caller",
  worm_sink: "write-once sink",
  database: "this database",
  none: "none",
};

/**
 * Chain integrity (ADR-0060), on demand rather than on load: verification
 * RECOMPUTES the hash chain over the whole trail, which is deliberate work an
 * admin asks for, not a page-render side effect. What comes back is rendered
 * with the report's own honesty intact — the anchor's tamper resistance is
 * what the MEDIUM answered at runtime (COMPLIANCE-mode Object Lock → true;
 * GOVERNANCE / database / unobserved → false), never what configuration
 * claims, and the residual window (rows newer than the last anchor) is shown
 * every time because bounding it is the operator's job, not this card's.
 */
function ChainIntegrityCard() {
  const [report, setReport] = useState<VerifyReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      setReport(await api.get<VerifyReport>("/v1/audit/verify"));
    } catch (e) {
      setError((e as { message?: string })?.message ?? "verification failed to run");
    } finally {
      setBusy(false);
    }
  };

  const anchorTone: Tone = report
    ? report.anchor.tamperResistant
      ? "ok"
      : report.anchor.source === "none"
        ? "danger"
        : "warn"
    : "neutral";

  return (
    <Card
      title="Chain integrity"
      info={
        <p>
          A tamper-evident hash chain with a write-once anchor. Every chained row commits to the one before it; the
          head is anchored to write-once storage. Verification recomputes the whole chain against the anchor.
        </p>
      }
    >
      <div className={v.row}>
        {!report && !busy && <Badge tone="neutral">Not verified yet</Badge>}
        <span className={v.dim}>Recomputes the whole chain against its anchor when you ask.</span>
        <span className={v.grow} />
        <Button onClick={() => void run()} disabled={busy}>
          {busy ? "Verifying…" : report ? "Re-verify" : "Verify chain"}
        </Button>
      </div>
      {error && (
        <div className={v.errLine} role="alert">
          {error}
        </div>
      )}
      {report && (
        <div className={v.stack} style={{ marginTop: "var(--s2)" }} data-testid="chain-report">
          <div className={v.rowTight}>
            <Badge tone={report.status === "ok" ? "ok" : report.status === "empty" ? "neutral" : "danger"}>
              chain {report.status}
            </Badge>
            <span className={v.dim}>
              {plural(report.scanned.rows, "row")} recomputed{report.scanned.bounded ? " (bounded range)" : ""}
            </span>
            {report.firstBreak && (
              <Badge tone="danger">first break at seq {report.firstBreak.seq}</Badge>
            )}
          </div>
          {report.firstBreak && <p className={v.errLine}>{report.firstBreak.reason}</p>}
          <div className={v.rowTight}>
            <Badge tone={anchorTone}>
              Anchor: {ANCHOR_SOURCE_LABEL[report.anchor.source] ?? humanize(report.anchor.source)}
              {report.anchor.seq != null ? ` at seq ${report.anchor.seq}` : ""}
              {report.anchor.sinkMode ? ` · ${humanize(report.anchor.sinkMode)}` : ""}
            </Badge>
            <Badge tone={report.anchor.tamperResistant ? "ok" : "warn"}>
              {report.anchor.tamperResistant ? "Tamper-resistant (observed)" : "Not tamper-resistant"}
            </Badge>
            {report.anchor.matches === false && <Badge tone="danger">Anchor mismatch</Badge>}
            {report.anchor.matches === true && <Badge tone="ok">Anchor matches</Badge>}
            {report.anchor.matches === null && report.anchor.aheadOfHead && (
              <Badge tone="danger" title={report.anchor.aheadOfHead.disclosure}>
                Not verified — anchor past chain head (seq {report.anchor.aheadOfHead.seq})
              </Badge>
            )}
            {report.anchor.matches !== null && report.anchor.aheadOfHead && (
              <Badge tone="warn" title={report.anchor.aheadOfHead.disclosure}>
                Anchor past chain head (seq {report.anchor.aheadOfHead.seq})
              </Badge>
            )}
            {report.anchor.unanchoredRows != null && report.anchor.unanchoredRows > 0 && (
              <span className={v.dim}>{plural(report.anchor.unanchoredRows, "row")} newer than the last anchor</span>
            )}
          </div>
          <p className={v.faint}>{report.anchor.disclosure}</p>
          {report.anchor.aheadOfHead && (
            <p className={v.faint} data-testid="anchor-ahead">
              {report.anchor.aheadOfHead.disclosure}
            </p>
          )}
          {report.legacy.unchainedRowsBeforeGenesis > 0 && (
            <p className={v.faint}>{report.legacy.disclosure}</p>
          )}
        </div>
      )}
    </Card>
  );
}
