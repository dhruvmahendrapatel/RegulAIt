// ADR-0196 U4: the screens of one chunk, loaded together on the first visit to any of them (see App.tsx).
export { default as ClientAccessPage } from "../views/admin/identity/ClientAccessPage";
export { default as CredentialsPage } from "../views/admin/identity/CredentialsPage";
export { default as GroupMappingsPage } from "../views/admin/identity/GroupMappingsPage";
export { default as RolesPage } from "../views/admin/identity/RolesPage";
export { default as ScimPage } from "../views/admin/identity/ScimPage";
export { default as SsoPage } from "../views/admin/identity/SsoPage";
export { default as TeamsPage } from "../views/admin/identity/TeamsPage";
export { default as UsersPage } from "../views/admin/identity/UsersPage";
export { default as VirtualKeysPage } from "../views/admin/identity/VirtualKeysPage";
export { default as WorkloadIdentitiesPage } from "../views/admin/identity/WorkloadIdentitiesPage";
// P3 (#453): the SSO and workload-identities areas (overview + full lists) as lazy chunks reached through this screen,
// each owning its nested <Routes>, so the sub-pages add nothing to the entry bundle (see App.tsx).
export { SsoArea } from "../views/admin/identity/LinkRequestsPage";
export { WorkloadIdentitiesArea } from "../views/admin/identity/WorkloadIdentitySubpages";
