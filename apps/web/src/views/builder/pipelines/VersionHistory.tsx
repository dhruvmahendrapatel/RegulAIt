/**
 * ADR-0341 slice 3 — a template's published versions, newest first: who published each and when, its content hash,
 * a comparison with the live template, and "Start a draft from this version" (a restore is a publish like any other).
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Badge, Button, RecordError, RowActions, SkeletonBlock, Table } from "../../../ui/kit";
import { fmtDateTime } from "../../../api/format";
import { pipelineBuilderApi, type BuilderVersionSummary } from "./pipelineBuilderApi";
import DiffView from "./DiffView";
import { versionsKey } from "./usePipelineDraft";
import s from "./pipelineBuilder.module.css";

export const originLabel = (o: BuilderVersionSummary["origin"]) => (o === "baseline" ? "Before the builder" : "Published");

export default function VersionHistory(props: { templateId: string; onRestore: (version: number) => void }) {
  const versions = useQuery({ queryKey: versionsKey(props.templateId), queryFn: () => pipelineBuilderApi.versions(props.templateId) });
  const [compare, setCompare] = useState<number | null>(null);
  const one = useQuery({
    queryKey: ["admin", "pipeline-builder", "version", props.templateId, compare],
    queryFn: () => pipelineBuilderApi.version(props.templateId, compare!),
    enabled: compare !== null,
  });
  return (
    <div className={s.pane}>
      <Table<BuilderVersionSummary>
        columns={[
          {
            key: "version",
            header: "Version",
            render: (r) => (
              <>
                {r.version} {r.live && <Badge tone="ok">Live</Badge>}
              </>
            ),
          },
          { key: "origin", header: "Origin", render: (r) => originLabel(r.origin) },
          { key: "by", header: "Published by", render: (r) => r.publishedByName ?? (r.origin === "baseline" ? "—" : "A removed user") },
          { key: "at", header: "When", render: (r) => fmtDateTime(r.publishedAt) },
          { key: "hash", header: "Content hash", render: (r) => <span className={s.code}>{r.contentHash.slice(0, 12)}</span> },
          {
            key: "actions",
            header: "",
            srHeader: "Actions",
            align: "right",
            render: (r) => (
              <RowActions
                primary={
                  r.live ? undefined : (
                    <Button size="sm" onClick={() => setCompare(r.version)} aria-label={`Compare version ${r.version} with live`}>
                      Compare
                    </Button>
                  )
                }
                secondary={
                  r.live ? undefined : (
                    <Button size="sm" onClick={() => props.onRestore(r.version)} aria-label={`Start a draft from version ${r.version}`}>
                      Start a draft
                    </Button>
                  )
                }
              />
            ),
          },
        ]}
        rows={versions.data?.items}
        rowKey={(r) => String(r.version)}
        loading={versions.isLoading}
        error={versions.error}
        onRetry={() => void versions.refetch()}
        empty={<p className={s.dim}>No version is recorded yet. The live definition becomes version 1 when a draft is first opened.</p>}
      />
      {compare !== null && (
        <section aria-label={`Version ${compare} against live`}>
          <h3>Version {compare} against the live template</h3>
          {one.isLoading ? (
            <div role="status" aria-label="Loading the comparison">
              <SkeletonBlock lines={3} />
            </div>
          ) : one.error ? (
            <RecordError noun="version" error={one.error} onRetry={() => void one.refetch()} />
          ) : one.data ? (
            <DiffView diff={one.data.diff} against="the live template" />
          ) : null}
        </section>
      )}
    </div>
  );
}
