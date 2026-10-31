/**
 * P3 (owner, #453 c6527514889): the Discovery sources page's full record lists, each on its own page under the
 * parent's path — recent runs, a source's enrolment tokens and its endpoint devices — with a breadcrumb back to the
 * parent, the shared list control (ADR-0219) and the list's filters. Admin-only like the parent (the gateway's
 * default gate). The overview keeps a preview of each.
 */
import { useMemo, useState } from "react";
import { Link, Route, Routes, useSearchParams } from "react-router-dom";
import DiscoverySourcesPage from "./DiscoverySourcesPage";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import { plural } from "../../../api/format";
import { PageHeader } from "../../../shell/AppShell";
import { Card, EmptyState, Field, Select } from "../../../ui/kit";
import { DataList } from "../../../ui/DataList";
import { FoldTable } from "../../../ui/fold";
import {
  DISCOVERY_SOURCES_PATH,
  deviceColumns,
  runColumns,
  tokenColumns,
  useEndpointRevoke,
  type DeviceSummary,
  type DeviceView,
  type TokenView,
} from "./discoveryLists";
import type { DiscoveryRunView, DiscoverySourceView } from "./discoverySourcesModel";
import l from "./discoveryLists.module.css";
import a from "../admin.module.css";
import v from "../../views.module.css";

function useSources() {
  return useQuery({
    queryKey: ["admin", "discovery", "sources"],
    queryFn: () => api.get<{ sources: DiscoverySourceView[] }>("/v1/discovery/sources"),
  });
}

/** Discovery / Discovery sources / <this list>, the parent a link back */
function Crumbs(props: { here: string }) {
  return (
    <nav aria-label="Breadcrumb">
      <ol className={l.crumbs}>
        <li>Discovery</li>
        <li>
          <Link to={DISCOVERY_SOURCES_PATH}>Discovery sources</Link>
        </li>
        <li aria-current="page">{props.here}</li>
      </ol>
    </nav>
  );
}

export function DiscoveryRunsPage() {
  const sources = useSources();
  const list = sources.data?.sources ?? [];
  const [sourceId, setSourceId] = useState("");
  const [status, setStatus] = useState("");
  const filters = useMemo(() => ({ sourceId: sourceId || undefined, status: status || undefined }), [sourceId, status]);
  const columns = useMemo(() => runColumns((sid) => list.find((s) => s.id === sid)?.name ?? sid), [list]);
  return (
    <>
      <Crumbs here="Recent runs" />
      <PageHeader title="Recent runs" sub="Every discovery scan, newest first: what it read, what it found and what it could not see." />
      <div className={v.stack}>
        <Card flush title="Runs">
          <div className={a.formRow} style={{ padding: "var(--s1) var(--s2) 0" }}>
            <Field label="Source">
              <Select value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
                <option value="">Any</option>
                {list.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Status">
              <Select value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="">Any</option>
                <option value="queued">queued</option>
                <option value="running">running</option>
                <option value="succeeded">succeeded</option>
                <option value="failed">failed</option>
              </Select>
            </Field>
          </div>
          <DataList<DiscoveryRunView>
            listId="discovery-runs"
            noun="runs"
            endpoint="/v1/discovery/runs"
            exportPath="/v1/discovery/runs/export.xlsx"
            queryKey={["admin", "discovery", "runs", "list"]}
            legacyKey="runs"
            count="estimate"
            filters={filters}
            defaultSort={{ key: "when", dir: "desc" }}
            table={FoldTable}
            rowKey={(r) => r.id}
            empty={
              sourceId || status ? (
                <EmptyState title="No runs match" body="No scan matches this source and status. Choose Any to see them all." />
              ) : (
                <EmptyState title="No scan has run" body="Runs appear here once an enabled source is scanned." />
              )
            }
            columns={columns}
          />
        </Card>
      </div>
    </>
  );
}

/** the endpoint agent source the page is for: `?source=`, or the only one there is */
function useAgentSource() {
  const sources = useSources();
  const [params, setParams] = useSearchParams();
  const targets = (sources.data?.sources ?? []).filter((s) => s.kind === "endpoint_agent");
  const asked = params.get("source");
  const sourceId = asked && targets.some((s) => s.id === asked) ? asked : targets.length === 1 ? targets[0]!.id : "";
  const picker = (
    <Field label="Endpoint agent source">
      <Select
        value={sourceId}
        onChange={(e) =>
          setParams((p) => {
            const n = new URLSearchParams(p);
            n.set("source", e.target.value);
            return n;
          }, { replace: true })
        }
      >
        <option value="">Choose a source</option>
        {targets.map((s) => (
          <option key={s.id} value={s.id}>
            {`${s.name}${s.enabled ? "" : " (disabled)"}`}
          </option>
        ))}
      </Select>
    </Field>
  );
  return { sourceId, picker, loading: sources.isLoading, none: !sources.isLoading && targets.length === 0 };
}

export function EnrolmentTokensPage() {
  const src = useAgentSource();
  const revoke = useEndpointRevoke();
  const columns = useMemo(() => tokenColumns(revoke.revokeToken, revoke.busy), [revoke.revokeToken, revoke.busy]);
  return (
    <>
      <Crumbs here="Enrolment tokens" />
      <PageHeader title="Enrolment tokens" sub="The tokens your MDM's enrolment files carry. A token's secret is shown once, when it is issued, and never again." />
      <div className={v.stack}>
        <Card flush title="Tokens">
          <div className={a.formRow} style={{ padding: "var(--s1) var(--s2) 0" }}>{src.picker}</div>
          {revoke.error && (
            <p className={v.errLine} role="alert">
              {revoke.error}
            </p>
          )}
          {src.sourceId ? (
            <DataList<TokenView>
              key={src.sourceId}
              listId="enrolment-tokens"
              noun="enrolment tokens"
              endpoint={`/v1/discovery/sources/${src.sourceId}/enrolment-tokens`}
              exportPath={`/v1/discovery/sources/${src.sourceId}/enrolment-tokens/export.xlsx`}
              queryKey={["admin", "discovery", "enrolment-tokens", src.sourceId]}
              legacyKey="tokens"
              defaultSort={{ key: "created", dir: "desc" }}
              rowKey={(t) => t.id}
              columns={columns}
              empty={<EmptyState title="No enrolment token" body="Issue one on Discovery sources to enrol devices." />}
            />
          ) : (
            <EmptyState title={src.none ? "No endpoint agent source" : "Choose a source"} body={src.none ? "Add and enable a regulAIt endpoint agent source on Discovery sources." : "Choose the endpoint agent source whose tokens to list."} />
          )}
        </Card>
      </div>
      {revoke.modal}
    </>
  );
}

export function EndpointDevicesPage() {
  const src = useAgentSource();
  const revoke = useEndpointRevoke();
  const [summary, setSummary] = useState<DeviceSummary | null>(null);
  const columns = useMemo(() => deviceColumns(revoke.revokeDevice, revoke.busy), [revoke.revokeDevice, revoke.busy]);
  return (
    <>
      <Crumbs here="Endpoint devices" />
      <PageHeader title="Endpoint devices" sub="The devices that enrolled, and the users who registered on each, as pseudonyms." />
      <div className={v.stack}>
        <Card flush title="Devices">
          <div className={a.formRow} style={{ padding: "var(--s1) var(--s2) 0" }}>{src.picker}</div>
          {summary && (
            <p className={v.faint} style={{ padding: "0 var(--s2)" }}>
              {`${plural(summary.devices, "device")}, ${summary.revoked} revoked, ${plural(summary.softwareKeys, "agent identity", "agent identities")} with a software key (no key hardware on the device).`}
            </p>
          )}
          {revoke.error && (
            <p className={v.errLine} role="alert">
              {revoke.error}
            </p>
          )}
          {src.sourceId ? (
            <DataList<DeviceView>
              key={src.sourceId}
              listId="endpoint-devices"
              noun="devices"
              endpoint={`/v1/discovery/sources/${src.sourceId}/endpoint-devices`}
              exportPath={`/v1/discovery/sources/${src.sourceId}/endpoint-devices/export.xlsx`}
              queryKey={["admin", "discovery", "endpoint-devices", src.sourceId]}
              legacyKey="devices"
              defaultSort={{ key: "created", dir: "desc" }}
              rowKey={(d) => d.id}
              onRows={(_rows, raw) => setSummary((raw.summary as DeviceSummary | undefined) ?? null)}
              columns={columns}
              empty={<EmptyState title="No device has enrolled" body="Devices appear here once their install step redeems an enrolment token." />}
            />
          ) : (
            <EmptyState title={src.none ? "No endpoint agent source" : "Choose a source"} body={src.none ? "Add and enable a regulAIt endpoint agent source on Discovery sources." : "Choose the endpoint agent source whose devices to list."} />
          )}
        </Card>
      </div>
      {revoke.modal}
    </>
  );
}

/**
 * The Discovery sources area: the Discovery sources page (with its five-row previews) at the index, the full runs,
 * enrolment-token and device lists each on their own nested route. One lazy chunk mounted at
 * `shadow-ai/discovery-sources/*`, reached through the Shadow AI screen barrel, so the sub-pages add nothing to the
 * entry bundle (ADR-0196 U4; the SPA route census follows this module — scripts/ui-spa-routes.mjs).
 */
export function DiscoverySourcesArea() {
  return (
    <Routes>
      <Route index element={<DiscoverySourcesPage />} />
      <Route path="runs" element={<DiscoveryRunsPage />} />
      <Route path="tokens" element={<EnrolmentTokensPage />} />
      <Route path="devices" element={<EndpointDevicesPage />} />
    </Routes>
  );
}
