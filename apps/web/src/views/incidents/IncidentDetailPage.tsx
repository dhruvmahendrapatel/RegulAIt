/**
 * ADR-0182 (ADR-0175 batch D4) A12 — AI incident. OWNER: A12 (D4).
 *
 * FOUNDATION STUB (P0): the route and the navigation entry exist (App.tsx and
 * shell/suites.tsx are P0's), so A12 fills in this file and nothing else
 * routes to it. Until then it says, truthfully, that it is not built.
 */
import { PageHeader } from "../../shell/AppShell";
import { Card, EmptyState } from "../../ui/kit";

export default function IncidentDetailPage() {
  return (
    <>
      <PageHeader title="AI incident" sub="The incident's timeline, links, actions and notification clocks." />
      <Card>
        <EmptyState title="Not built yet" body="This page arrives with batch D4 (A12). Nothing is recorded here yet." />
      </Card>
    </>
  );
}
