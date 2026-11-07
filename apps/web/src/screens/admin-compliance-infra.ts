// ADR-0196 U4: the screens of one chunk, loaded together on the first visit to any of them (see App.tsx).
export { default as CompliancePacksPage } from "../views/admin/compliance/CompliancePacksPage";
export { default as ComplianceProfilesPage } from "../views/admin/compliance/ComplianceProfilesPage";
export { default as FrameworkImportsPage } from "../views/admin/compliance/FrameworkImportsPage";
export { default as InfrastructurePage } from "../views/admin/compliance/InfrastructurePage";
// P3 (#453): the Infrastructure area (overview + each ledger's full list) as one lazy chunk reached through this screen.
export { InfrastructureArea } from "../views/admin/compliance/InfraLedgerPages";
// ADR-0225 (P13 d): Trust publishing sits beside Compliance packs
export { default as TrustPublishingPage } from "../views/trust/TrustPublishingPage";
// ADR-0224 (P13 c): the Privacy group's two pages, in this chunk because they sit beside the compliance pages
export { default as ProcessingRecordsPage } from "../views/admin/compliance/ProcessingRecordsPage";
export { default as DataSubjectRequestsPage } from "../views/admin/compliance/DataSubjectRequestsPage";
