// ADR-0196 U4: the screens of one chunk, loaded together on the first visit to any of them (see App.tsx).
export { default as ApprovalsAdminPage } from "../views/admin/governance/ApprovalsAdminPage";
export { default as AuditLogPage } from "../views/admin/governance/AuditLogPage";
export { default as ChatOpsPage } from "../views/admin/governance/ChatOpsPage";
export { default as LineagePage } from "../views/admin/governance/LineagePage";
export { default as ReviewWorkbenchPage } from "../views/admin/governance/ReviewWorkbenchPage";
export { default as TracesPage } from "../views/admin/observability/TracesPage";
// P3 (#453): the ChatOps area (overview + full chat-identity-links list) as one lazy chunk reached through this screen.
export { ChatOpsArea } from "../views/admin/governance/ChatIdentityLinksPage";
