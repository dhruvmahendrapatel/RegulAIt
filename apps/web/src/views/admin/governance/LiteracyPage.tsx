/**
 * ADR-0182 (ADR-0175 batch D4) A14 — AI literacy. OWNER: A14 (D4).
 *
 * FOUNDATION STUB (P0): the route and the navigation entry exist (App.tsx and
 * shell/suites.tsx are P0's), so A14 fills in this file and nothing else
 * routes to it. Until then it says, truthfully, that it is not built.
 */
import { PageHeader } from "../../../shell/AppShell";
import { Card, EmptyState } from "../../../ui/kit";

export default function LiteracyPage() {
  return (
    <>
      <PageHeader title="AI literacy" sub="AI policies and trainings, their versions, and who has acknowledged them." />
      <Card>
        <EmptyState title="Not built yet" body="This page arrives with batch D4 (A14). Nothing is recorded here yet." />
      </Card>
    </>
  );
}
