import { PageHeader } from "../../../shell/AppShell";
import { Card } from "../../../ui/kit";
import { DependencyGraphPanel } from "./DependencyGraphPanel";

export default function DependencyGraphPage() {
  return (
    <>
      <PageHeader title="AI dependency graph" sub="See declared and observed dependencies, and trace inherited risk back to its source." />
      <Card title="Governed stack and propagated risk">
        <DependencyGraphPanel />
      </Card>
    </>
  );
}
