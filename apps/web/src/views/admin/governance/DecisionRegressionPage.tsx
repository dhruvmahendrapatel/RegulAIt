/**
 * ADR-0182 (ADR-0175 batch D4) A11 — Decision regression. OWNER: A11 (D4).
 *
 * FOUNDATION STUB (P0): the route and the navigation entry exist (App.tsx and
 * shell/suites.tsx are P0's), so A11 fills in this file and nothing else
 * routes to it. Until then it says, truthfully, that it is not built.
 */
import { PageHeader } from "../../../shell/AppShell";
import { Card, EmptyState } from "../../../ui/kit";

export default function DecisionRegressionPage() {
  return (
    <>
      <PageHeader title="Decision regression" sub="Golden cases, regression runs and the outcomes a policy change would alter." />
      <Card>
        <EmptyState title="Not built yet" body="This page arrives with batch D4 (A11). Nothing is recorded here yet." />
      </Card>
    </>
  );
}
