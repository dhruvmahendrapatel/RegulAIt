// ADR-0196 U4: the screens of one chunk, loaded together on the first visit to any of them (see App.tsx).
export { default as DataKeyPage } from "../views/admin/settings/DataKeyPage";
export { default as EnforcementPosturePage } from "../views/admin/settings/EnforcementPosturePage";
export { default as ExecutionControlPage } from "../views/admin/settings/ExecutionControlPage";
export { default as FirstRunPage } from "../views/admin/settings/FirstRunPage";
export { default as GettingStartedPage } from "../views/admin/settings/GettingStartedPage";
export { default as LicensingPage } from "../views/admin/settings/LicensingPage";
export { default as OrganizationPage } from "../views/admin/settings/OrganizationPage";
export { default as RetentionPage } from "../views/admin/settings/RetentionPage";
export { default as SchedulerPage } from "../views/admin/settings/SchedulerPage";
// P3 (#453): the licensing area (Licensing page + full verification history) as one lazy chunk reached through this screen.
export { LicensingArea } from "../views/admin/settings/LicenceVerificationsPage";
