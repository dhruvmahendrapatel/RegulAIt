/**
 * The connectors area: the Connectors page at the index and the governed connector catalogue (ADR-0255) on its own
 * nested route. One lazy chunk mounted at `connectors/*`, reached through the admin-integrations screen, so the
 * catalogue adds nothing to the entry bundle (ADR-0196 U4; the SPA route census follows this module).
 */
import { Navigate, Route, Routes } from "react-router-dom";
import ConnectorsPage from "./ConnectorsPage";
import ConnectorCataloguePage from "./ConnectorCataloguePage";

export function ConnectorsArea() {
  return (
    <Routes>
      <Route index element={<ConnectorsPage />} />
      <Route path="catalogue" element={<ConnectorCataloguePage />} />
      {/* an unknown sub-path goes back to the area's own page, never a blank page */}
      <Route path="*" element={<Navigate to="/admin/connectors" replace />} />
    </Routes>
  );
}
