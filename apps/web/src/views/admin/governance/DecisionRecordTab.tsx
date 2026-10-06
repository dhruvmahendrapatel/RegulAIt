/**
 * ADR-0182 (ADR-0175 batch D4) A11 — THE DECISION RECORDS (which versions produced each decision), as a tab of the use-case record.
 * OWNER: A11 (D4).
 *
 * FOUNDATION STUB (P0): UseCaseOverviewPage.tsx (P0's) already renders this
 * component in its own tab, so A11 fills in this file and nothing else.
 */
import { Card, EmptyState } from "../../../ui/kit";

export function DecisionRecordTab(_props: { useCaseId: string }) {
  return (
    <Card title="Decision records">
      <EmptyState title="Not built yet" body="This tab arrives with batch D4 (A11)." />
    </Card>
  );
}
