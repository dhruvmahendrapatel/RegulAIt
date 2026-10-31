// ADR-0196 U4: the screens of one chunk, loaded together on the first visit to any of them (see App.tsx).
export { default as CompliancePacksPage } from "../views/admin/compliance/CompliancePacksPage";
export { default as ComplianceProfilesPage } from "../views/admin/compliance/ComplianceProfilesPage";
export { default as InfrastructurePage } from "../views/admin/compliance/InfrastructurePage";
// P3 (#453): the Infrastructure area (overview + each ledger's full list) as one lazy chunk reached through this screen.
export { InfrastructureArea } from "../views/admin/compliance/InfraLedgerPages";
