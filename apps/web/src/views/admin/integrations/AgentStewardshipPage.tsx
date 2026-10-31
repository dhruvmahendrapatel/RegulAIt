/**
 * Agent stewardship on its own page (P3, #453 c6527514889; ADR-0168 item 6): every agent's steward, successor,
 * lifecycle and review, with its filters and the edit dialog. The agents overview keeps a five-row preview with the
 * orphaned and review-overdue counts in its heading.
 */
import { PageHeader } from "../../../shell/AppShell";
import { ErrorState } from "../../../ui/kit";
import { SubpageTrail } from "../../../ui/ListPreview";
import { useAgents, useUsers } from "../adminKit";
import { StewardshipCard } from "./AgentStewardship";

export default function AgentStewardshipPage() {
  const agents = useAgents();
  const users = useUsers();
  return (
    <>
      <SubpageTrail parent="Agents" parentTo="/admin/agents" current="Stewardship" />
      <PageHeader title="Agent stewardship" sub="Who answers for each agent, who takes over, and when it is next reviewed." />
      {agents.error && !agents.data ? (
        <ErrorState message="The agents could not be read. No stewardship state is inferred." onRetry={() => void agents.refetch()} />
      ) : null}
      <StewardshipCard agents={agents.data?.agents} users={users.data?.users} loading={agents.isLoading} failed={!!agents.error && !agents.data} />
    </>
  );
}
