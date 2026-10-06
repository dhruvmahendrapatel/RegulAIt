/**
 * ADR-0182 (ADR-0175 batch D4) A13 — Feedback and appeals. OWNER: A13 (D4).
 *
 * FOUNDATION STUB (P0): the route and the navigation entry exist (App.tsx and
 * shell/suites.tsx are P0's), so A13 fills in this file and nothing else
 * routes to it. Until then it says, truthfully, that it is not built.
 */
import { PageHeader } from "../../shell/AppShell";
import { Card, EmptyState } from "../../ui/kit";

export default function FeedbackPage() {
  return (
    <>
      <PageHeader title="Feedback and appeals" sub="Problem reports and appeals about the use cases you own, with their response times." />
      <Card>
        <EmptyState title="Not built yet" body="This page arrives with batch D4 (A13). Nothing is recorded here yet." />
      </Card>
    </>
  );
}
