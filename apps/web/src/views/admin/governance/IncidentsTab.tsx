/**
 * ADR-0182 (ADR-0175 batch D4) A12 — THE USE CASE'S AI INCIDENTS (and its EU AI Act role), as a tab of the use-case record.
 * OWNER: A12 (D4).
 *
 * FOUNDATION STUB (P0): UseCaseOverviewPage.tsx (P0's) already renders this
 * component in its own tab, so A12 fills in this file and nothing else.
 */
import { Card, EmptyState } from "../../../ui/kit";

export function IncidentsTab(_props: { useCaseId: string }) {
  return (
    <Card title="Incidents">
      <EmptyState title="Not built yet" body="This tab arrives with batch D4 (A12)." />
    </Card>
  );
}
