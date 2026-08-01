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
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import type { AuditEntry } from "../../../api/types";
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
  { v: "hosted", l: "hosted" },
  { v: "byoc", l: "byoc" },
  { v: "air_gapped", l: "air_gapped" },
  { v: "unknown", l: "unknown / pre-0044" },
];

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
  const audit = useQuery({
    queryKey: ["admin", "audit", userId, deployMode],
    queryFn: () => api.get<{ entries: AuditEntry[] }>(`/v1/audit${qs}`),
  });

  const nameOf = useMemo(
    () => new Map((users.data?.users ?? []).map((u) => [u.id, u.displayName || u.email])),
    [users.data],
  );
  const rows = useMemo(
    () => (audit.data?.entries ?? []).map((e, i) => ({ ...e, rowKey: e.id ?? `${e.at}-${i}` })),
    [audit.data],
  );
  const ret = retention.data;

  return (
    <>
      <PageHeader
        title="Audit log"
        sub="Every governed decision, lifecycle action and settings change lands here — one trail, all eight pillars. Filter by user and by deploy mode; the table shows the latest 100 rows, and the CSV export carries the full filtered trail."
      />
      <div className={v.stack}>
        <Card title="Retention (§8.4) — a single global floor">
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
                  (from {(ret.floorSource ?? []).join(", ") || "—"}) · <strong>{ret.prunable}</strong>{" "}
                  row(s) older than the floor
                </span>
              </span>
              <span className={v.grow} />
              <Button variant="danger" disabled={!ret.prunable} onClick={() => setConfirmPrune(true)}>
                Prune audit log
              </Button>
            </div>
          )}
          <p className={v.faint}>
            Retention is the longest auditRetentionDays across every compliance profile
            (longest-floor-wins) composed with the org default — a shorter-retention framework can never
            shorten another framework's trail. The prune itself is audited.
          </p>
        </Card>

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
              title="Download the FULL filtered trail (the table shows the latest 100 rows)"
              onClick={() =>
                void downloadCsv(`/v1/audit.csv${qs}`, "audit-log.csv", (msg) => toast(msg, "error"))
              }
            >
              Download CSV
            </Button>
          </div>
          <p className={v.faint}>
            A row carries a deploy mode only when the action was deploy-mode-scoped — a workflow
            deploy/rollback, or a governed infra change on a target-pinned resource. Everything else
            (MCP calls, membership, settings edits) has <strong>no mode to have</strong>, and every row
            written before migration 0044 has none either: that mode was never recorded, so it is{" "}
            <strong>un-backfillable</strong> and is not inferred here. Both land in one honest{" "}
            <strong>unknown / pre-0044</strong> bucket — it is <em>not</em> a fourth mode and{" "}
            <em>not</em> a synonym for “hosted”. Per-mode retention only differentiates rows written
            after 0044 for the same reason.
          </p>
          <Table<AuditEntry & { rowKey: string }>
            columns={[
              {
                key: "at",
                header: "At",
                sort: (e) => e.at,
                render: (e) => <span className={v.mono}>{String(e.at).slice(0, 19).replace("T", " ")}</span>,
              },
              {
                key: "user",
                header: "User",
                render: (e) => nameOf.get(e.userId) ?? e.userId.slice(0, 8) + "…",
              },
              { key: "object", header: "Object", sort: (e) => e.objectType ?? "", render: (e) => e.objectType ?? "—" },
              {
                key: "effect",
                header: "Effect",
                sort: (e) => e.effect,
                render: (e) => <Badge tone={effectTone(e.effect)}>{e.effect.replaceAll("_", " ")}</Badge>,
              },
              { key: "rule", header: "Rule", render: (e) => <span className={v.mono}>{e.ruleId}</span> },
              {
                key: "deployMode",
                header: "Deploy mode",
                sort: (e) => e.deployMode ?? "unknown",
                render: (e) =>
                  e.deployMode ? (
                    <Badge tone="info">{e.deployMode}</Badge>
                  ) : (
                    <span
                      className={v.dim}
                      title="No mode was recorded for this row — either it is not a deploy-mode-scoped action, or it predates migration 0044. Un-backfillable by design; never assume a mode."
                    >
                      unknown
                    </span>
                  ),
              },
              { key: "reason", header: "Reason", render: (e) => <span className={v.dim}>{e.reason ?? "—"}</span> },
            ]}
            rows={rows}
            rowKey={(e) => e.rowKey}
            loading={audit.isLoading}
            empty={
              <EmptyState
                title="No audit rows match"
                body={
                  deployMode && deployMode !== "unknown"
                    ? `No row records a ${deployMode} deploy mode yet — only deploy-mode-scoped actions written after migration 0044 carry one. Clear the filter to see the full trail.`
                    : "Every governed action writes here — try clearing the filter."
                }
              />
            }
          />
        </Card>
      </div>

      <ConfirmModal
        open={confirmPrune}
        title={`Delete ${ret?.prunable ?? 0} audit row(s)?`}
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
              `Pruned ${r.deleted} audit row(s) — floor ${r.retainedDays}d from ${(r.floorSource ?? []).join(", ")}`,
              "success",
            );
          }, null);
        }}
      />
    </>
  );
}
