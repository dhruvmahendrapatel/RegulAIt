/**
 * The connectors area: the Connectors page at the index and the governed connector catalogue (ADR-0255) on its own
 * nested route, mounted at `connectors/*` through the admin-integrations screen. The catalogue page is its own lazy
 * chunk, loaded only when opened, so it adds nothing to the entry bundle or to admin-integrations (ADR-0196 U4,
 * ADR-0344 per-route budgets; the SPA route census follows this module).
 */
import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import ConnectorsPage from "./ConnectorsPage";

const ConnectorCataloguePage = lazy(() => import("./ConnectorCataloguePage"));

export function ConnectorsArea() {
  return (
    <Routes>
      <Route index element={<ConnectorsPage />} />
      <Route
        path="catalogue"
        element={
          <Suspense fallback={<p role="status">Loading the connector catalogue…</p>}>
            <ConnectorCataloguePage />
          </Suspense>
        }
      />
      {/* an unknown sub-path goes back to the area's own page, never a blank page */}
      <Route path="*" element={<Navigate to="/admin/connectors" replace />} />
    </Routes>
  );
}
