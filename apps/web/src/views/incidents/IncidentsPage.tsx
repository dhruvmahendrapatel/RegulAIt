/**
 * ADR-0182 (ADR-0175 batch D4) A12 — AI incidents. OWNER: A12 (D4).
 *
 * FOUNDATION STUB (P0): the route and the navigation entry exist (App.tsx and
 * shell/suites.tsx are P0's), so A12 fills in this file and nothing else
 * routes to it. Until then it says, truthfully, that it is not built.
 */
import { PageHeader } from "../../shell/AppShell";
import { Card, EmptyState } from "../../ui/kit";

export default function IncidentsPage() {
  return (
    <>
      <PageHeader title="AI incidents" sub="Incidents involving AI systems, their notification clocks and corrective actions." />
      <Card>
        <EmptyState title="Not built yet" body="This page arrives with batch D4 (A12). Nothing is recorded here yet." />
      </Card>
    </>
  );
}
