/**
 * Per-asset posture scores. PRESENTATION ONLY: every figure arrives computed by the server.
 *
 * - `AssetScoreCard` reads one asset's score (`GET /v1/reports/posture/assets/:kind/:assetId`); it sits on the use-case
 *   page and in the Posture page's drawer.
 * - `AssetScoresSection` pages the scores of one kind (`GET /v1/reports/posture/assets`) on the Posture page, with a
 *   keyset "Load more"; a row opens that asset's card in a drawer.
 *
 * Honesty rules, rendered: the figure is labelled an estimate with its disclaimer on its face, an unmeasured objective
 * says unmeasured (never its zero), a not-applicable objective shows its reason and no score, and the ranked actions
 * keep their links. The server decides which assets a caller may read; a 404 is "No such asset".
 */
import { useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../../../api/client";
import { DetailDrawer } from "../../../ui/DetailDrawer";
import { Badge, Button, Card, EmptyState, Meter, RecordError, SkeletonBlock, Table, Tabs, tabIds } from "../../../ui/kit";
import {
  ASSET_KINDS,
  assetDetailPath,
  assetListPath,
  objectiveScoreText,
  parseAssetPage,
  parseAssetScore,
  pointsText,
  shareText,
  type AssetKind,
  type AssetScoreDoc,
  type AssetScoreObjective,
} from "./assetScoreModel";
import v from "../../views.module.css";
import p from "./posture.module.css";

export function AssetScoreView(props: { doc: AssetScoreDoc }) {
  const d = props.doc;
  return (
    <div className={v.stack}>
      <div>
        <span className={p.score}>{d.score}</span>
        <span className={p.oneLiner}> out of {d.scale.max}</span> <Badge tone="warn">Estimate</Badge>
      </div>
      <Meter value={d.score} max={d.scale.max} warn={d.score < 50} label={`Estimate: ${d.score} out of ${d.scale.max}`} />
      <p className={p.oneLiner}>{d.disclaimer}</p>
      <Table
        columns={[
          { key: "objective", header: "Objective", render: (o: AssetScoreObjective) => o.title },
          { key: "measure", header: "Measure", render: (o: AssetScoreObjective) => `${o.metric.label}: ${o.metric.value}` },
          { key: "share", header: "Share", align: "right", render: (o: AssetScoreObjective) => shareText(d, o.id) },
          {
            key: "score",
            header: "Score",
            align: "right",
            render: (o: AssetScoreObjective) => (o.measured ? objectiveScoreText(o) : <Badge tone="warn">{objectiveScoreText(o)}</Badge>),
          },
        ]}
        rows={d.objectives}
        rowKey={(o) => o.id}
      />
      {d.notApplicable.length > 0 && (
        <ul className={p.inputs}>
          {d.notApplicable.map((n) => (
            <li key={n.objective} className={p.oneLiner}>
              {n.title}: not applicable, {n.why}.
            </li>
          ))}
        </ul>
      )}
      <details className={p.details}>
        <summary>How this is calculated</summary>
        <p className={p.oneLiner}>{d.method}</p>
      </details>
      <strong>What to fix first</strong>
      {d.actions.length === 0 ? (
        <p className={p.oneLiner}>Nothing to fix.</p>
      ) : (
        <ol className={p.actions}>
          {d.actions.map((a) => (
            <li key={a.key}>
              <strong>{a.title}</strong> <Badge>{`+${pointsText(a.points)}`}</Badge>
              <div className={p.oneLiner}>{a.reason}</div>
              <Link to={a.link.to} className={p.sectionLink}>
                {a.link.label}
              </Link>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** one asset's score, read from the detail route */
export function AssetScoreCard(props: { kind: AssetKind; assetId: string; bare?: boolean }) {
  const q = useQuery({
    queryKey: ["posture", "asset", props.kind, props.assetId],
    queryFn: async () => parseAssetScore(await api.get<unknown>(assetDetailPath(props.kind, props.assetId))),
    retry: false,
  });
  const body = q.isPending ? (
    <SkeletonBlock lines={4} />
  ) : q.isError ? (
    <RecordError noun="asset" error={q.error} onRetry={() => void q.refetch()} />
  ) : (
    <AssetScoreView doc={q.data} />
  );
  if (props.bare) return body;
  return (
    <Card title="Posture score">
      {body}
    </Card>
  );
}

/** the Posture page's per-asset list: one kind at a time, name order, keyset pages */
export function AssetScoresSection() {
  const [kind, setKind] = useState<AssetKind>("agent");
  const [open, setOpen] = useState<AssetScoreDoc["asset"] | null>(null);
  const q = useInfiniteQuery({
    queryKey: ["posture", "assets", kind],
    queryFn: async ({ pageParam }) => parseAssetPage(await api.get<unknown>(assetListPath(kind, pageParam))),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    retry: false,
  });
  const rows = q.data?.pages.flatMap((pg) => pg.items);
  const ids = tabIds("asset-scores", kind);
  const noun = kind === "agent" ? "agent" : "use case";
  return (
    <section aria-labelledby="asset-scores-heading" className={v.stack}>
      <h2 id="asset-scores-heading" className={p.sectionHeading}>
        Scores by asset
      </h2>
      <Tabs tabs={ASSET_KINDS.map((k) => ({ id: k.id, label: k.label }))} active={kind} onChange={(id) => setKind(id as AssetKind)} idPrefix="asset-scores" label="Asset kind" />
      <div role="tabpanel" id={ids.panel} aria-labelledby={ids.tab}>
        <Card>
          <div className={v.stack}>
            {q.data && <p className={p.oneLiner}>{q.data.pages[0]?.disclaimer}</p>}
            <Table
              columns={[
                { key: "name", header: "Name", render: (d: AssetScoreDoc) => d.asset.name },
                { key: "score", header: "Estimate", align: "right", render: (d: AssetScoreDoc) => `${d.score} of ${d.scale.max}` },
              ]}
              rows={rows}
              rowKey={(d) => d.asset.id}
              loading={q.isPending}
              error={q.isError && !q.isFetchNextPageError ? q.error : undefined}
              onRetry={() => void q.refetch()}
              empty={<EmptyState title={`No ${noun} you can read`} />}
              onRowClick={(d) => setOpen(d.asset)}
              rowLabel={(d) => `Open the posture score of ${d.asset.name}`}
            />
            {q.isFetchNextPageError && (
              <p className={v.errLine} role="alert">
                The next page could not be loaded.
              </p>
            )}
            {q.hasNextPage && (
              <div>
                {/* after a failed page the same button retries it */}
                <Button size="sm" aria-disabled={q.isFetchingNextPage} onClick={() => !q.isFetchingNextPage && void q.fetchNextPage()}>
                  {q.isFetchingNextPage ? "Loading…" : q.isFetchNextPageError ? "Retry" : "Load more"}
                </Button>
              </div>
            )}
          </div>
        </Card>
      </div>
      {open && (
        <DetailDrawer type="Posture score" title={open.name} subjectKey={open.id} onClose={() => setOpen(null)}>
          <AssetScoreCard kind={open.kind} assetId={open.id} bare />
        </DetailDrawer>
      )}
    </section>
  );
}
