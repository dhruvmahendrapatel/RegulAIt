/**
 * P3 (owner, #453 c6527514889): the Discovery sources page's record lists — recent runs, enrolment tokens and
 * endpoint devices. The overview keeps a short preview of each (at most five rows and a count, with anything that
 * needs attention counted in the heading, and "View all →"); each full list has its own page under the parent's path
 * with the shared list control (ADR-0226). The columns are declared once here, for the preview and the page alike.
 */
import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import { fmtDateTime, humanize, plural } from "../../../api/format";
import { Badge, Button, Card, ConfirmModal, Table, type Column, type TableProps } from "../../../ui/kit";
import type { DataColumn } from "../../../ui/DataList";
import { normalisePage } from "../../../ui/listState";
import { useAction } from "../adminKit";
import { couldNotRead, describeGap, type DiscoveryRunView } from "./discoverySourcesModel";
import l from "./discoveryLists.module.css";
import v from "../../views.module.css";

export const DISCOVERY_SOURCES_PATH = "/admin/shadow-ai/discovery-sources";
export const PREVIEW_ROWS = 5;

const nowrap = { whiteSpace: "nowrap" } as const;
const when = (iso: string | null) => <span style={nowrap}>{fmtDateTime(iso, "never")}</span>;
const RUN_TONE = { queued: "neutral", running: "info", succeeded: "ok", failed: "danger" } as const;

export interface TokenView {
  id: string;
  label: string;
  deviceCap: number;
  devicesEnrolled: number;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  /** ADR-0197 Q14: devices it enrolled that are not revoked (absent from a gateway before Q14) */
  devicesActive?: number;
}
export interface IdentityView {
  identityId: string;
  deviceUserPseudonym: string;
  keyProtection: "hardware" | "software";
  keyProvider: string;
  status: string;
  lastReportAt: string | null;
}
export interface DeviceView {
  id: string;
  devicePseudonym: string;
  os: string;
  arch: string;
  agentVersion: string;
  identitiesRegistered: number;
  identityCap: number;
  lastReportAt: string | null;
  revokedAt: string | null;
  identities: IdentityView[];
}
export interface DeviceSummary {
  devices: number;
  revoked: number;
  softwareKeys: number;
}

const tokenExpired = (t: TokenView) => !t.revokedAt && new Date(t.expiresAt).getTime() <= Date.now();

// ---- columns -------------------------------------------------------------------------------------------------------

/** the runs list's columns; the ids and sortable ones match the gateway's DISCOVERY_RUNS_LIST */
export function runColumns(sourceName: (id: string) => string): Array<DataColumn<DiscoveryRunView>> {
  return [
    // below 1000 px of table width, Queued folds under Source, Observed / matched under Findings and Reads
    // under Status; on a phone Findings and Catalogue gaps fold under Source too
    { key: "source", main: true, sortable: true, header: "Source", render: (r) => sourceName(r.sourceId) },
    {
      key: "status",
      main: true,
      sortable: true,
      required: "Status, and a failed scan, are always shown",
      header: "Status",
      render: (r) => (
        <>
          <Badge tone={RUN_TONE[r.status]}>{r.status}</Badge>
          {/* A20: the reason in words, the code as secondary text under it */}
          {r.errorCode && (
            <>
              <div>{humanize(r.errorCode)}{r.errorDetail ? `: ${r.errorDetail}` : ""}</div>
              <div className={`${v.faint} ${v.mono}`} style={{ overflowWrap: "anywhere" }}>{r.errorCode}</div>
            </>
          )}
        </>
      ),
    },
    { key: "when", main: true, sortable: true, header: "Queued", fold: { md: "source" }, render: (r) => <><span style={nowrap}>{fmtDateTime(r.createdAt)}</span><div className={v.faint}>{r.trigger === "schedule" ? "Scheduled" : "Manual"} · attempt {r.attempt}</div></> },
    { key: "counts", main: true, sortable: true, header: "Observed / matched", fold: { md: "findings" }, render: (r) => `${r.observed} / ${r.matched}` },
    { key: "findings", main: true, sortable: true, header: "Findings", fold: { sm: "source" }, render: (r) => `${r.findingsCreated} new, ${r.findingsUpdated} updated` },
    {
      key: "gaps",
      header: "Catalogue gaps",
      main: true,
      sortable: true,
      fold: { sm: "source" },
      render: (r) =>
        r.catalogueGaps.length ? (
          <div className={v.stackTight}>
            {r.catalogueGaps.map((g) => {
              const d = describeGap(g);
              return (
                <div key={d.code} data-testid="catalogue-gap">
                  {d.kind}: <strong>{d.name}</strong>
                  <div className={`${v.faint} ${v.mono}`}>{d.code}</div>
                </div>
              );
            })}
          </div>
        ) : (
          "none"
        ),
    },
    { key: "reads", header: "Reads", main: true, required: "A source the scan could not read is always shown", fold: { md: "status" }, render: (r) => couldNotRead(r.readOutcomes) ?? <span className={v.faint} style={nowrap}>all read</span> },
  ];
}

/** the state of a token or a device, with its Revoke where the list offers one */
const stateCell = (revokedAt: string | null, expired: boolean, revoke?: () => void, busy?: boolean, name?: string) =>
  revokedAt ? (
    <Badge tone="neutral">revoked</Badge>
  ) : (
    <span className={v.rowTight}>
      {expired ? <Badge tone="warn">expired</Badge> : !revoke ? <Badge tone="ok">active</Badge> : null}
      {/* an expired token can still be revoked, to revoke the devices it enrolled */}
      {revoke && (
        <Button size="sm" disabled={busy} aria-label={name ? `Revoke ${name}` : undefined} onClick={revoke}>
          Revoke
        </Button>
      )}
    </span>
  );

/** the enrolment tokens' columns (never a secret, hash or prefix); the ids match ENROLMENT_TOKENS_LIST */
export function tokenColumns(revoke?: (t: TokenView) => void, busy?: boolean): Array<DataColumn<TokenView>> {
  return [
    { key: "label", header: "Token", main: true, sortable: true, render: (t) => t.label },
    { key: "devices", header: "Devices", main: true, sortable: true, render: (t) => `${t.devicesEnrolled} / ${t.deviceCap}` },
    { key: "expires", header: "Expires", main: true, sortable: true, render: (t) => when(t.expiresAt) },
    {
      key: "state",
      header: "State",
      main: true,
      sortable: true,
      required: "A token's state is always shown",
      render: (t) => stateCell(t.revokedAt, tokenExpired(t), revoke ? () => revoke(t) : undefined, busy, `token ${t.label}`),
    },
    { key: "active", header: "Devices active", sortable: true, render: (t) => t.devicesActive ?? "—" },
    { key: "created", header: "Issued", sortable: true, render: (t) => when(t.createdAt) },
  ];
}

/** the endpoint devices' columns (pseudonyms only); the ids match ENDPOINT_DEVICES_LIST */
export function deviceColumns(revoke?: (d: DeviceView) => void, busy?: boolean): Array<DataColumn<DeviceView>> {
  return [
    { key: "device", header: "Device", main: true, sortable: true, render: (d) => <span className={v.mono}>{d.devicePseudonym}</span> },
    { key: "platform", header: "Platform", main: true, sortable: true, render: (d) => `${d.os}/${d.arch}, agent ${d.agentVersion}` },
    {
      key: "users",
      header: "Users (self-reported)",
      main: true,
      required: "A software key is a warning and is always shown",
      render: (d) =>
        d.identities.length === 0
          ? "none registered"
          : d.identities.map((i) => (
              <div key={i.identityId}>
                <span className={v.mono}>{i.deviceUserPseudonym}</span>{" "}
                <Badge tone={i.keyProtection === "hardware" ? "ok" : "warn"}>{`${i.keyProtection} key`}</Badge>
              </div>
            )),
    },
    { key: "last", header: "Last report", main: true, sortable: true, render: (d) => when(d.lastReportAt) },
    {
      key: "state",
      header: "State",
      main: true,
      sortable: true,
      required: "A device's state is always shown",
      render: (d) => stateCell(d.revokedAt, false, revoke ? () => revoke(d) : undefined, busy, `device ${d.devicePseudonym}`),
    },
    { key: "identities", header: "Identities", sortable: true, render: (d) => `${d.identitiesRegistered} / ${d.identityCap}` },
  ];
}

// ---- the preview ---------------------------------------------------------------------------------------------------

export interface PreviewSource {
  endpoint: string;
  /** the route's older response key, so an older gateway's answer still previews */
  legacyKey: string;
  sort: { key: string; dir: "asc" | "desc" };
  queryKey: readonly unknown[];
  /** "estimate" for a list that can grow past an exact count's cost (the runs) */
  count?: "exact" | "estimate";
}

/** the one small page a preview reads (the page that holds the preview can read the same figures, one request) */
export function usePreviewPage<T>(p: PreviewSource) {
  const count = p.count ?? "exact";
  return useQuery({
    queryKey: [...p.queryKey, "preview", count],
    queryFn: async () => normalisePage<T>(await api.get<unknown>(`${p.endpoint}?limit=10&sort=${p.sort.key}&dir=${p.sort.dir}&count=${count}`), p.legacyKey),
  });
}

/**
 * One list, previewed: the newest few rows, the list's true total and what needs attention in the heading, and a
 * link to the list's own page. It reads one small page of the same list contract the full page uses.
 */
export function ListPreview<T>(
  props: PreviewSource & {
    title: string;
    testId: string;
    noun: [string, string];
    /** the heading's attention counts, from the page's response (its figures across every row) */
    attention?: (raw: Record<string, unknown>, rows: T[]) => Array<string | null>;
    columns: Array<Column<T>>;
    rowKey: (row: T) => string;
    viewAll: string;
    empty: ReactNode;
    info?: ReactNode;
    /** the kit Table, or FoldTable where columns fold on narrow widths */
    table?: (props: TableProps<T>) => ReactNode;
  },
) {
  const TableOf = props.table ?? Table;
  const q = usePreviewPage<T>(props);
  const rows = q.data?.items.slice(0, PREVIEW_ROWS);
  const total = q.data ? (q.data.total ?? q.data.items.length) : null;
  const parts = q.data && props.attention ? props.attention(q.data.raw, q.data.items).filter((x): x is string => Boolean(x)) : [];
  const counted = total === null ? null : q.data?.totalIsEstimate ? `${total.toLocaleString("en-GB")}+ ${props.noun[1]}` : plural(total, props.noun[0], props.noun[1]);
  const summary = counted === null ? null : [counted, ...parts].join(" · ");
  return (
    <Card
      flush
      title={
        <h2 className={l.previewTitle}>
          {props.title} {summary ? <span className={l.previewCount}>{summary}</span> : null}
        </h2>
      }
      info={props.info}
      actions={
        <Link to={props.viewAll} className={l.viewAll}>
          View all →
        </Link>
      }
    >
      <div data-testid={props.testId}>
        <TableOf
          columns={props.columns}
          rows={rows}
          rowKey={props.rowKey}
          loading={q.isLoading}
          error={q.error}
          onRetry={() => void q.refetch()}
          empty={props.empty}
        />
      </div>
    </Card>
  );
}

// ---- the attention counts ------------------------------------------------------------------------------------------

export const runsAttention = (raw: Record<string, unknown>, rows: DiscoveryRunView[]) => {
  const failed = typeof raw.failed === "number" ? raw.failed : rows.filter((r) => r.status === "failed").length;
  return [failed > 0 ? `${failed} failed` : null];
};
export const tokensAttention = (raw: Record<string, unknown>, rows: TokenView[]) => {
  const s = raw.summary as { expired?: number; revoked?: number } | undefined;
  const expired = s?.expired ?? rows.filter(tokenExpired).length;
  const revoked = s?.revoked ?? rows.filter((t) => t.revokedAt).length;
  return [expired > 0 ? `${expired} expired` : null, revoked > 0 ? `${revoked} revoked` : null];
};
export const devicesAttention = (raw: Record<string, unknown>, rows: DeviceView[]) => {
  const s = raw.summary as DeviceSummary | undefined;
  const software = s?.softwareKeys ?? rows.filter((d) => d.identities.some((i) => i.keyProtection === "software")).length;
  const revoked = s?.revoked ?? rows.filter((d) => d.revokedAt).length;
  return [software > 0 ? plural(software, "software key") : null, revoked > 0 ? `${revoked} revoked` : null];
};

// ---- revoking a token or a device (the full pages) ----------------------------------------------------------------

/** ADR-0197 Q14: revoking a token stops new enrolments; revoking the devices it enrolled is a separate, unchecked choice */
export function useEndpointRevoke() {
  const act = useAction();
  const [revoking, setRevoking] = useState<{ kind: "token"; row: TokenView } | { kind: "device"; row: DeviceView } | null>(null);
  // ADR-0197 Q14: off by default each time the dialog opens
  const [alsoDevices, setAlsoDevices] = useState(false);
  const confirmRevoke = () => {
    const r = revoking;
    const revokeDevices = alsoDevices;
    setRevoking(null);
    setAlsoDevices(false);
    if (!r) return;
    // the action's own refresh reloads the token and device lists (their query keys sit under "admin")
    void act.run(async () => {
      if (r.kind === "token") {
        const out = await api.post<{ devicesRevoked?: number }>(`/v1/discovery/enrolment-tokens/${r.row.id}/revoke`, { revokeDevices });
        return revokeDevices ? `Enrolment token '${r.row.label}' revoked with ${plural(out.devicesRevoked ?? 0, "device")}` : `Enrolment token '${r.row.label}' revoked`;
      }
      const out = await api.post<{ identitiesRevoked: number }>(`/v1/discovery/endpoint-devices/${r.row.id}/revoke`, {});
      return `Device ${r.row.devicePseudonym} revoked (${plural(out.identitiesRevoked, "agent identity", "agent identities")})`;
    });
  };
  const modal = (
    <ConfirmModal
      open={revoking !== null}
      danger
      title={revoking?.kind === "device" ? "Revoke this device?" : "Revoke this enrolment token?"}
      body={
        revoking?.kind === "device" ? (
          "Its agent identities, keys and tokens are revoked and it uploads nothing more. Enrolling it again needs a new ticket."
        ) : (
          <div className={v.stackTight}>
            <p>
              It redeems no new device ticket, and its unexpired tickets register no new user.{" "}
              {alsoDevices ? "The devices it enrolled are revoked too." : "Devices already enrolled keep reporting."}
            </p>
            <label className={v.rowTight}>
              <input type="checkbox" checked={alsoDevices} onChange={(e) => setAlsoDevices(e.target.checked)} />
              <span>
                {revoking?.kind === "token" && revoking.row.devicesActive !== undefined
                  ? `Also revoke the ${plural(revoking.row.devicesActive, "device")} it enrolled`
                  : "Also revoke the devices it enrolled"}
                {" "}(their agent identities, keys and tokens; they upload nothing more)
              </span>
            </label>
          </div>
        )
      }
      confirmLabel={revoking?.kind === "token" && alsoDevices ? "Revoke token and devices" : "Revoke"}
      onConfirm={confirmRevoke}
      onCancel={() => {
        setRevoking(null);
        setAlsoDevices(false);
      }}
    />
  );
  return {
    busy: act.busy,
    error: act.error,
    revokeToken: (row: TokenView) => setRevoking({ kind: "token", row }),
    revokeDevice: (row: DeviceView) => setRevoking({ kind: "device", row }),
    modal,
  };
}
