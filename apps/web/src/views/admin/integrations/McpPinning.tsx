/**
 * ADR-0246 (P27): the definition-pin and high-risk screens, loaded together on demand through `loadMcpPinning` in
 * McpServersPage, so the MCP servers area pays for one lazy import rather than one per card (ADR-0344 per-route budgets).
 */
import type { McpServer } from "../../../api/adminTypes";
import { McpChangedSinceApprovalCard } from "./McpDefinitionPins";
import { McpAuthorisedTargetsCard, McpHighRiskCard } from "./McpHighRisk";

export { default as McpDefinitionPinsPage } from "./McpDefinitionPins";

/** the MCP servers tab's pinning and high-risk cards in one place: changed definitions, the selected server's policy, targets */
export function McpPinningPanel(props: { server: McpServer | undefined }) {
  return (
    <>
      <McpChangedSinceApprovalCard />
      <McpHighRiskCard server={props.server} />
      <McpAuthorisedTargetsCard />
    </>
  );
}
