// P3 (#453 c6527514889): the identity-and-access long pages' full lists, each on its own route, loaded together in one
// chunk of their own (the ADR-0196 U4 pattern: one chunk per group of screens; see App.tsx).
export { WorkloadIdentitiesListPage, GrantProposalsPage } from "../views/admin/identity/WorkloadIdentitySubpages";
export { default as LinkRequestsPage } from "../views/admin/identity/LinkRequestsPage";
export { default as ChatIdentityLinksPage } from "../views/admin/governance/ChatIdentityLinksPage";
export { default as AgentCatalogPage } from "../views/admin/integrations/AgentCatalogPage";
export { default as AgentStewardshipPage } from "../views/admin/integrations/AgentStewardshipPage";
export { default as LicenceVerificationsPage } from "../views/admin/settings/LicenceVerificationsPage";
