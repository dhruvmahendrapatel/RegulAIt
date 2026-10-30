/**
 * ADR-0193 (I4) P0/P1 — content provenance and trust tiers (`/admin/content-trust`).
 *
 * The trust-tier policy is what turns injection DETECTION into a defense: every MCP server and connector is
 * `untrusted` until an admin sets its tier, and a write whose run or builder thread already holds content from a
 * source below the write floor is refused. Every tier change (up or down) and every floor change asks the admin to
 * confirm it is them (a `settings_relax` step-up) and is audited.
 *
 * The evidence card lists the provenance records under the shared list control (ADR-0219): the label and both digests (what upstream returned, what
 * was delivered) of each governed result, never its content, with the audit anchor that covers it.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ago, humanize } from "../../../api/format";
import { PageHeader } from "../../../shell/AppShell";
import { api as stepUpApi, withStepUp } from "../../../stepup/stepUp";
import { Badge, Button, Card, Field, IdChip, Select, Table, type Column } from "../../../ui/kit";
import { QueryGate, useAction } from "../adminKit";
import { DataList, type DataColumn } from "../../../ui/DataList";
import {
  CONTENT_TRUST_TIERS,
  CONTENT_TRUST_WRITE_FLOORS,
  DIGEST_COPY,
  shortDigest,
  TIER_COPY,
  tierTone,
  type ContentProvenanceRecordView,
  type ContentTrustResponse,
  type ContentTrustSource,
  type ContentTrustTier,
  type ContentTrustWriteFloor,
} from "./contentTrustModel";
import v from "../../views.module.css";

const KEY = ["admin", "content-trust"] as const;
const RECORDS_KEY = ["admin", "content-provenance-records"] as const;

export default function ContentTrustPage() {
  const trust = useQuery({ queryKey: KEY, queryFn: () => stepUpApi.get<ContentTrustResponse>("/v1/content-trust") });
  return (
    <>
      <PageHeader
        title="Content trust"
        sub="Which sources' content may drive a write. Every source starts untrusted."
        info={
          <p>
            Each MCP server and connector has a trust tier. A write is refused when the run or builder thread it belongs to
            already holds content from a source below the write floor, so text from a low-trust tool cannot make an agent
            change something. Every governed result is also recorded as provenance evidence: its source, tier and the
            digests of what upstream returned and what was delivered, never the content itself. This page makes no claim
            about any legal content-marking duty.
          </p>
        }
      />
      <div className={v.stack}>
        <QueryGate loading={trust.isLoading} error={trust.error} onRetry={() => void trust.refetch()}>
          {trust.data && !Array.isArray(trust.data.sources) ? (
            <Card title="Content trust">
              <p className={v.faint}>This gateway does not report content trust tiers.</p>
            </Card>
          ) : trust.data ? (
            <>
              <WriteFloorCard key={trust.data.writeFloor} floor={trust.data.writeFloor} onSaved={() => void trust.refetch()} />
              <SourcesCard sources={trust.data.sources} onSaved={() => void trust.refetch()} />
            </>
          ) : null}
        </QueryGate>
        <RecordsCard />
      </div>
    </>
  );
}

function WriteFloorCard(props: { floor: ContentTrustWriteFloor; onSaved: () => void }) {
  const act = useAction();
  const [floor, setFloor] = useState<ContentTrustWriteFloor>(props.floor);
  const save = () =>
    void act
      .run(
        () => withStepUp((h) => stepUpApi.put("/v1/content-trust/settings", { writeFloor: floor }, h)),
        floor === "standard" ? "Saved: standard sources' content can now drive writes" : "Saved: only trusted content can drive writes",
      )
      .then((ok) => {
        if (ok) props.onSaved();
      });
  return (
    <Card title="Write floor">
      <form
        aria-label="Write floor"
        className={v.stack}
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <div className={v.row}>
          <Badge tone={props.floor === "trusted" ? "ok" : "warn"}>
            {props.floor === "trusted" ? "only trusted content drives writes" : "standard content drives writes (relaxed)"}
          </Badge>
        </div>
        <Field
          label="Write floor"
          helpLabel="the write floor setting"
          help={
            <>
              The lowest tier whose content may drive a write. Trusted is the default; relaxing it to standard lets
              standard sources' content drive writes too. Untrusted content can never drive a write. Changing it asks you
              to confirm it is you, and it is audited.
            </>
          }
        >
          <Select value={floor} onChange={(e) => setFloor(e.target.value as ContentTrustWriteFloor)}>
            {CONTENT_TRUST_WRITE_FLOORS.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </Select>
        </Field>
        <div className={v.row}>
          <Button type="submit" variant="primary" disabled={act.busy || floor === props.floor}>
            Save write floor
          </Button>
        </div>
        {act.error && (
          <p className={v.errLine} role="alert">
            {act.error}
          </p>
        )}
      </form>
    </Card>
  );
}

function SourcesCard(props: { sources: ContentTrustSource[]; onSaved: () => void }) {
  const columns: Array<Column<ContentTrustSource>> = [
    { key: "name", header: "Source", render: (s) => s.name, sort: (s) => s.name },
    { key: "kind", header: "Kind", render: (s) => (s.sourceKind === "mcp_server" ? "MCP server" : "Connector"), sort: (s) => s.sourceKind },
    {
      key: "tier",
      header: "Tier",
      render: (s) => (
        // D6: the tier's meaning sits behind an (i) button, not a hover-only title
        <Badge tone={tierTone(s.tier)} info={TIER_COPY[s.tier]} infoLabel={`what ${s.tier} means`}>
          {humanize(s.tier)}
          {s.explicit ? "" : " (default)"}
        </Badge>
      ),
      sort: (s) => s.tier,
    },
    { key: "set", header: "Last set", render: (s) => (s.setAt ? ago(s.setAt) : "never") },
    { key: "change", header: "Change", render: (s) => <TierEditor source={s} onSaved={props.onSaved} /> },
  ];
  return (
    <Card title="Source tiers">
      <Table
        columns={columns}
        rows={props.sources}
        rowKey={(s) => `${s.sourceKind}:${s.sourceId}`}
        empty="No MCP servers or connectors are registered yet."
      />
    </Card>
  );
}

function TierEditor(props: { source: ContentTrustSource; onSaved: () => void }) {
  const act = useAction();
  const [tier, setTier] = useState<ContentTrustTier>(props.source.tier);
  const unchanged = tier === props.source.tier && props.source.explicit;
  return (
    <form
      className={v.rowTight}
      aria-label={`Trust tier of ${props.source.name}`}
      onSubmit={(e) => {
        e.preventDefault();
        void act
          .run(
            () =>
              withStepUp((h) =>
                stepUpApi.put(`/v1/content-trust/sources/${props.source.sourceKind}/${props.source.sourceId}`, { tier }, h),
              ),
            `${props.source.name} is now ${tier}`,
          )
          .then((ok) => {
            if (ok) props.onSaved();
          });
      }}
    >
      <Select aria-label={`New tier for ${props.source.name}`} value={tier} onChange={(e) => setTier(e.target.value as ContentTrustTier)}>
        {CONTENT_TRUST_TIERS.map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </Select>
      <Button type="submit" disabled={act.busy || unchanged}>
        Set tier
      </Button>
    </form>
  );
}

/** ADR-0219: the provenance records' columns; the ids and sortable ones match the gateway's PROVENANCE_LIST */
const RECORD_COLUMNS: Array<DataColumn<ContentProvenanceRecordView>> = [
  { key: "at", header: "Recorded", main: true, sortable: true, render: (r) => ago(r.createdAt) },
  {
    key: "source",
    header: "Source",
    main: true,
    sortable: true,
    render: (r) => `${r.sourceKind === "mcp_server" ? "MCP" : "Connector"} ${r.sourceDetail ?? ""}`.trim(),
  },
  { key: "tier", header: "Tier", main: true, sortable: true, required: "The trust tier is always shown", render: (r) => <Badge tone={tierTone(r.trustTier)}>{humanize(r.trustTier)}</Badge> },
  { key: "class", header: "Classification", main: true, sortable: true, render: (r) => humanize(r.classification) },
  { key: "digest", header: "Digest", main: true, sortable: true, render: (r) => DIGEST_COPY[r.digestAlg] },
  {
    key: "delivered",
    header: "Delivered",
    main: true,
    sortable: true,
    render: (r) => (
      // the kit chip copies the full digest; a missing one says so
      r.deliveredDigest ? <IdChip id={r.deliveredDigest} /> : <span className={v.faint}>{shortDigest(null)}</span>
    ),
  },
  {
    key: "changed",
    header: "Transformed",
    main: true,
    sortable: true,
    render: (r) => (r.upstreamDigest && r.deliveredDigest ? (r.upstreamDigest === r.deliveredDigest ? "No" : "Yes") : "Unknown"),
  },
  {
    key: "anchor",
    header: "Anchor",
    render: (r) => (r.anchor ? `#${r.anchor.anchorSeq}, timestamp ${humanize(r.anchor.tsaStatus).toLowerCase()}` : "Not yet anchored"),
  },
];

function RecordsCard() {
  return (
    <Card
      title="Provenance evidence"
      flush
      info={
        <p>
          Content scanned clean has a plain SHA-256; content with PII, or never scanned, has a keyed digest under this
          deployment's own key, so it cannot be matched by guessing.
        </p>
      }
    >
      <DataList<ContentProvenanceRecordView>
        listId="content-provenance"
        noun="provenance records"
        endpoint="/v1/content-provenance/records"
        exportPath="/v1/content-provenance/records/export.xlsx"
        queryKey={RECORDS_KEY}
        legacyKey="records"
        count="estimate"
        defaultSort={{ key: "at", dir: "desc" }}
        columns={RECORD_COLUMNS}
        rowKey={(r) => r.id}
        empty="No governed results have been recorded yet."
      />
    </Card>
  );
}
