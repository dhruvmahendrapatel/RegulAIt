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
import { useMemo, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import type { AuditEntry } from "../../../api/types";
import { UUID_RE, actorLabel, fmtAt, frameworkLabel, humanize, plural, shortId } from "../../../api/format";
import type { AuditRetention } from "../../../api/adminTypes";
import { PageHeader } from "../../../shell/AppShell";
import { Badge, Button, Card, ConfirmModal, EmptyState, Field, Select, Table, type Tone } from "../../../ui/kit";
import { useToast } from "../../../ui/toast";
import { downloadCsv, optionEls, useAction, useUsers, userOpts } from "../adminKit";
import a from "../admin.module.css";
import v from "../../views.module.css";

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

  const qs = useMemo(() => {
    const p = new URLSearchParams();
    if (userId) p.set("userId", userId);
    if (deployMode) p.set("deployMode", deployMode);
    const s = p.toString();
    return s ? `?${s}` : "";
  }, [userId, deployMode]);

  const retention = useQuery({
    queryKey: ["admin", "audit-retention"],
    queryFn: () => api.get<AuditRetention>("/v1/audit/retention"),
  });
  // Cursor-paged: the server hands back 100 rows and a cursor for the older
  // ones. The table used to stop at the first page with no sign that 306
  // older rows existed (UIA-02); now it says how many are shown and loads
  // older pages on request.
  const audit = useInfiniteQuery({
    queryKey: ["admin", "audit", userId, deployMode],
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

  return (
    <>
      <PageHeader
        title="Audit log"
        sub="Every governed decision, lifecycle action and settings change."
        info={<p>Every governed decision, lifecycle action and settings change lands here — one trail, all eight pillars. Filter by user and by deploy mode; the table loads the newest rows first and older ones on request, and the CSV export carries the full filtered trail.</p>}
      />
      <div className={v.stack}>
        <Card title="Retention">
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
              <Button variant="danger" disabled={!ret.prunable} onClick={() => setConfirmPrune(true)}>
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

        <ChainIntegrityCard />

        <Card>
          <div className={a.formRow}>
            <Field label="Filter by user">
              <Select value={userId} onChange={(e) => setUserId(e.target.value)}>
                {optionEls(userOpts(users.data?.users), "— all users —")}
              </Select>
            </Field>
            <Field label="Filter by deploy mode">
              <Select value={deployMode} onChange={(e) => setDeployMode(e.target.value)}>
                {optionEls(MODE_OPTS, "— any mode —")}
              </Select>
            </Field>
            <span className={v.grow} />
            <Button
              size="sm"
              title="Download the FULL filtered trail, not only the rows loaded in the table"
              onClick={() =>
                void downloadCsv(`/v1/audit.csv${qs}`, "audit-log.csv", (msg) => toast(msg, "error"))
              }
            >
              Download CSV
            </Button>
            <Button
              size="sm"
              variant="primary"
              title="Download an offline-verifiable bundle containing the full filtered audit CSV, manifest, and signature"
              onClick={() => {
                const join = qs ? "&" : "?";
                void downloadCsv(`/v1/audit.csv${qs}${join}signed=1`, "audit-log.signed.tar.gz", (msg) => toast(msg, "error"));
              }}
            >
              Download signed bundle
            </Button>
          </div>
          <p className={v.faint}>
            Only deploy-scoped actions — workflow deploys and rollbacks, governed infrastructure changes —
            carry a deploy mode. Other rows (tool calls, membership, settings) show <strong>none</strong>, and
            older rows recorded before deploy modes existed are never back-filled or guessed.
          </p>
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
                render: (e) => actorLabel(e.userId, nameOf),
              },
              { key: "object", header: "Object", sort: (e) => e.objectType ?? "", render: (e) => (e.objectType ? humanize(e.objectType) : "—") },
              {
                key: "effect",
                header: "Effect",
                sort: (e) => e.effect,
                render: (e) => <Badge tone={effectTone(e.effect)}>{e.effect.replaceAll("_", " ")}</Badge>,
              },
              { key: "rule", header: "Rule", render: (e) => <span style={{ whiteSpace: "nowrap" }} title={e.ruleId}>{UUID_RE.test(e.ruleId) ? `Policy rule ${shortId(e.ruleId)}` : humanize(e.ruleId)}</span> },
              {
                key: "deployMode",
                header: "Deploy mode",
                sort: (e) => e.deployMode ?? "unknown",
                render: (e) =>
                  e.deployMode ? (
                    <Badge tone="info">{modeLabel(e.deployMode)}</Badge>
                  ) : (
                    <span
                      className={v.dim}
                      title="No deploy mode was recorded: the action is not deploy-scoped, or it predates deploy modes. Never back-filled."
                    >
                      none
                    </span>
                  ),
              },
              { key: "reason", header: "Reason", render: (e) => <span className={v.dim}>{e.reason ?? "—"}</span> },
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
          {rows.length > 0 && (
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
        </Card>
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
    <Card title="Chain integrity — tamper-evident hash chain with a write-once anchor">
      <div className={v.row}>
        <span className={v.dim}>
          Every chained row commits to the one before it; the head is anchored to write-once storage.
          Verification recomputes the whole chain against the anchor.
        </span>
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
