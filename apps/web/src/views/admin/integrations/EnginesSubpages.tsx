/**
 * The Engines page's long lists, each on its own page (P3, #453 c6527514889): every placement decision (two keyset
 * lists, paged as before) and one executor's self-test history with the shared list control. The Engines page keeps a
 * five-row preview of each, with what needs attention counted in its heading.
 */
import { useEffect, useState } from "react";
import { Route, Routes, useParams } from "react-router-dom";
import EnginesPage from "./EnginesPage";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../api/client";
import { PageHeader } from "../../../shell/AppShell";
import { Card, EmptyState, ErrorState } from "../../../ui/kit";
import { DataList } from "../../../ui/DataList";
import { SubpageTrail } from "../../../ui/ListPreview";
import { PlacementsCard } from "./isolation/IsolationPanel";
import { ATTESTATIONS_NOTE, ATTESTATIONS_SORT, attestationColumns, attestationKey, attestationsEndpoint, executorKeys } from "./isolation/ExecutorDetail";
import { availabilityOf, parseExecutor } from "./isolation/isolationModel";
import v from "../../views.module.css";

const PARENT = { parent: "Engines", parentTo: "/admin/engines" };

export function PlacementDecisionsPage() {
  return (
    <>
      <SubpageTrail {...PARENT} current="Placement decisions" />
      <PageHeader title="Placement decisions" sub="Every isolable call, placed on an executor at or above its required class, or refused." />
      <div className={v.stack}>
        <PlacementsCard />
      </div>
    </>
  );
}

export function ExecutorAttestationsPage() {
  const id = useParams().executorId ?? "";
  const detail = useQuery({ queryKey: executorKeys.detail(id), retry: false, queryFn: () => api.get<unknown>(`/v1/executors/${encodeURIComponent(id)}`) });
  const executor = detail.data === undefined ? null : parseExecutor(detail.data);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);
  const a = detail.isError ? availabilityOf(detail.error) : null;
  return (
    <>
      <SubpageTrail {...PARENT} current={executor ? `Self-test history of ${executor.name}` : "Self-test history"} />
      <PageHeader title={executor ? `Self-test history: ${executor.name}` : "Self-test history"} sub={ATTESTATIONS_NOTE} />
      <div className={v.stack}>
        <Card title="Self-test history">
          {detail.isPending ? (
            <p role="status" className={v.faint}>
              Loading the executor…
            </p>
          ) : detail.isError ? (
            <ErrorState
              title="Executor unavailable"
              access={a?.kind === "forbidden"}
              message={a?.kind === "forbidden" ? "You are not allowed to read this executor." : a?.kind === "failed" ? `The executor could not be read: ${a.message}` : "The executor could not be read. No assurance is shown."}
              onRetry={() => void detail.refetch()}
            />
          ) : !executor ? (
            <EmptyState title="Executor unavailable" body="The gateway sent an executor record this console cannot read. No assurance is shown." />
          ) : (
            <DataList<unknown>
              listId="executor-attestations"
              noun="self-test reports"
              endpoint={attestationsEndpoint(id)}
              exportPath={`/v1/executors/${encodeURIComponent(id)}/attestations/export.xlsx`}
              queryKey={[...executorKeys.attestations(id), "list"]}
              legacyKey="attestations"
              defaultSort={ATTESTATIONS_SORT}
              rowKey={attestationKey}
              empty={<EmptyState title="No self-test reports" body="This executor has not reported a self-test, so none of its classes count." />}
              columns={attestationColumns(executor, now)}
            />
          )}
        </Card>
      </div>
    </>
  );
}

/**
 * The Engines area: the Engines page (with its placement and attestation previews) at the index, the full placement
 * and self-test lists on their own nested routes. One lazy chunk mounted at `engines/*` so it adds nothing to the
 * entry bundle (ADR-0196 U4; the SPA route census follows this module — scripts/ui-spa-routes.mjs).
 */
export function EnginesArea() {
  return (
    <Routes>
      <Route index element={<EnginesPage />} />
      <Route path="placements" element={<PlacementDecisionsPage />} />
      <Route path="executors/:executorId/attestations" element={<ExecutorAttestationsPage />} />
    </Routes>
  );
}
