/**
 * ADR-0182 (ADR-0175 batch D4) A13 — THE USE CASE'S FEEDBACK AND APPEALS (and its signed links), as a tab of the use-case record.
 * OWNER: A13 (D4).
 *
 * FOUNDATION STUB (P0): UseCaseOverviewPage.tsx (P0's) already renders this
 * component in its own tab, so A13 fills in this file and nothing else.
 */
import { Card, EmptyState } from "../../../ui/kit";

export function FeedbackTab(_props: { useCaseId: string }) {
  return (
    <Card title="Feedback and appeals">
      <EmptyState title="Not built yet" body="This tab arrives with batch D4 (A13)." />
    </Card>
  );
}
