// ADR-0196 U4: the screens of one chunk, loaded together on the first visit to any of them (see App.tsx).
export { default as AdmissionReviewPage } from "../views/admin/governance/AdmissionReviewPage";
export { default as AgentsPage } from "../views/admin/integrations/AgentsPage";
export { default as ConnectorsPage } from "../views/admin/integrations/ConnectorsPage";
export { default as CustomProvidersPage } from "../views/admin/integrations/CustomProvidersPage";
export { default as DeployTargetsPage } from "../views/admin/integrations/DeployTargetsPage";
export { default as EnginesPage } from "../views/admin/integrations/EnginesPage";
export { default as GitConnectionsPage } from "../views/admin/integrations/GitConnectionsPage";
export { default as McpServersPage } from "../views/admin/integrations/McpServersPage";
export { default as ModelCredentialsPage } from "../views/admin/integrations/ModelCredentialsPage";
export { default as PmConnectionsPage } from "../views/admin/integrations/PmConnectionsPage";
export { default as RegulAItLlmPage } from "../views/admin/llm/RegulAItLlmPage";
export { default as WebhooksPage } from "../views/admin/integrations/WebhooksPage";
// P3 (#453): each long area is one lazy chunk whose module owns its nested <Routes> (overview at the index, each full
// list on its own page), reached through this screen so the sub-pages add nothing to the entry bundle.
export { McpServersArea } from "../views/admin/integrations/McpRegistrySubpages";
export { EnginesArea } from "../views/admin/integrations/EnginesSubpages";
