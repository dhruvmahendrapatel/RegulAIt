import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Navigate, Outlet, Route, Routes, useLocation } from "react-router-dom";
import { SessionProvider, useSession } from "./session/SessionContext";
import { ToastProvider } from "./ui/toast";
import { SkeletonBlock } from "./ui/kit";
import AppShell from "./shell/AppShell";
import LoginPage from "./views/auth/LoginPage";
import ForcedPasswordChange from "./views/auth/ForcedPasswordChange";
import ForcedMfaEnroll from "./views/auth/ForcedMfaEnroll";
import HomePage from "./views/home/HomePage";
import ChatPage from "./views/chat/ChatPage";
import RunsPage from "./views/runs/RunsPage";
import RunDetailPage from "./views/runs/RunDetailPage";
import WorkflowsPage from "./views/workflows/WorkflowsPage";
import WorkflowDetailPage from "./views/workflows/WorkflowDetailPage";
import InboxPage from "./views/inbox/InboxPage";
import ProjectsPage from "./views/projects/ProjectsPage";
import ProjectDetailPage from "./views/projects/ProjectDetailPage";
import ProjectContextPage from "./views/projects/ProjectContextPage";
import ContextGraphPage from "./views/projects/ContextGraphPage";
import ContextIndexPage from "./views/projects/ContextIndexPage";
import SpendPage from "./views/spend/SpendPage";
import AccountPage from "./views/account/AccountPage";
import { RequireAdmin } from "./views/admin/adminKit";
import UsersPage from "./views/admin/identity/UsersPage";
import RolesPage from "./views/admin/identity/RolesPage";
import TeamsPage from "./views/admin/identity/TeamsPage";
import ClientAccessPage from "./views/admin/identity/ClientAccessPage";
import SsoPage from "./views/admin/identity/SsoPage";
import ScimPage from "./views/admin/identity/ScimPage";
import GroupMappingsPage from "./views/admin/identity/GroupMappingsPage";
import VirtualKeysPage from "./views/admin/identity/VirtualKeysPage";
import RulesEnginePage from "./views/admin/governance/RulesEnginePage";
import SimulationPage from "./views/admin/governance/SimulationPage";
import AbacPoliciesPage from "./views/admin/governance/AbacPoliciesPage";
import GuardrailsPage from "./views/admin/governance/GuardrailsPage";
import EvalsPage from "./views/admin/governance/EvalsPage";
import ModelRiskPage from "./views/admin/governance/ModelRiskPage";
import UseCasesPage from "./views/admin/governance/UseCasesPage";
import VendorsPage from "./views/admin/governance/VendorsPage";
import RisksPage from "./views/admin/governance/RisksPage";
import InventoryPage from "./views/admin/governance/InventoryPage";
import PosturePage from "./views/admin/governance/PosturePage";
import RedTeamPage from "./views/admin/governance/RedTeamPage";
import ReportsPage from "./views/admin/cost/ReportsPage";
import PromptVersionsPage from "./views/admin/governance/PromptVersionsPage";
import ApprovalsAdminPage from "./views/admin/governance/ApprovalsAdminPage";
import ReviewWorkbenchPage from "./views/admin/governance/ReviewWorkbenchPage";
import AuditLogPage from "./views/admin/governance/AuditLogPage";
import ShadowAiPage from "./views/admin/governance/ShadowAiPage";
import CopilotPage from "./views/admin/governance/CopilotPage";
import ChatOpsPage from "./views/admin/governance/ChatOpsPage";
import LineagePage from "./views/admin/governance/LineagePage";
import RegulAItLlmPage from "./views/admin/llm/RegulAItLlmPage";
import TracesPage from "./views/admin/observability/TracesPage";
import WorkflowTemplatesPage from "./views/admin/governance/WorkflowTemplatesPage";
import AgentsPage from "./views/admin/integrations/AgentsPage";
import ModelCredentialsPage from "./views/admin/integrations/ModelCredentialsPage";
import CustomProvidersPage from "./views/admin/integrations/CustomProvidersPage";
import ConnectorsPage from "./views/admin/integrations/ConnectorsPage";
import McpServersPage from "./views/admin/integrations/McpServersPage";
import GitConnectionsPage from "./views/admin/integrations/GitConnectionsPage";
import PmConnectionsPage from "./views/admin/integrations/PmConnectionsPage";
import DeployTargetsPage from "./views/admin/integrations/DeployTargetsPage";
import CostDashboardPage from "./views/admin/cost/CostDashboardPage";
import CostConsolidationPage from "./views/admin/cost/CostConsolidationPage";
import SpendMonitorPage from "./views/admin/cost/SpendMonitorPage";
import BillingPage from "./views/admin/cost/BillingPage";
import OptimizationPage from "./views/admin/cost/OptimizationPage";
import ComplianceProfilesPage from "./views/admin/compliance/ComplianceProfilesPage";
import CompliancePacksPage from "./views/admin/compliance/CompliancePacksPage";
import InfrastructurePage from "./views/admin/compliance/InfrastructurePage";
import OrganizationPage from "./views/admin/settings/OrganizationPage";
import GettingStartedPage from "./views/admin/settings/GettingStartedPage";
import FirstRunPage from "./views/admin/settings/FirstRunPage";
import LicensingPage from "./views/admin/settings/LicensingPage";
import DataKeyPage from "./views/admin/settings/DataKeyPage";
import SchedulerPage from "./views/admin/settings/SchedulerPage";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failureCount, error) => {
        // never retry auth/permission answers; one retry for the transient rest
        const status = (error as { status?: number }).status;
        if (status === 401 || status === 403 || status === 404) return false;
        return failureCount < 1;
      },
      refetchOnWindowFocus: false,
      staleTime: 5_000,
    },
  },
});

/** Auth boundary: probe → login redirect (with return-to) → forced gates → shell. */
function Protected() {
  const { auth } = useSession();
  const location = useLocation();

  if (auth === undefined) {
    return (
      <div style={{ padding: "var(--s5)", maxWidth: 720, margin: "0 auto" }}>
        <SkeletonBlock lines={5} />
      </div>
    );
  }
  if (auth === null) {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }
  if (auth.mustChangePassword) return <ForcedPasswordChange />;
  if (auth.mfaSetupRequired) return <ForcedMfaEnroll />;
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <SessionProvider>
          <BrowserRouter basename="/ui">
            <Routes>
              <Route path="/login" element={<LoginPage />} />
              <Route element={<Protected />}>
                <Route path="/" element={<HomePage />} />
                <Route path="/chat" element={<ChatPage />} />
                <Route path="/runs" element={<RunsPage />} />
                <Route path="/runs/:runId" element={<RunDetailPage />} />
                <Route path="/workflows" element={<WorkflowsPage />} />
                <Route path="/workflows/:instanceId" element={<WorkflowDetailPage />} />
                <Route path="/inbox" element={<InboxPage />} />
                <Route path="/projects" element={<ProjectsPage />} />
                <Route path="/projects/:projectId" element={<ProjectDetailPage />} />
                <Route path="/projects/:projectId/context" element={<ProjectContextPage />} />
                <Route path="/projects/:projectId/context/graph" element={<ContextGraphPage />} />
                <Route path="/context" element={<ContextIndexPage />} />
                <Route path="/spend" element={<SpendPage />} />
                <Route path="/account" element={<AccountPage />} />
                <Route
                  path="/admin/*"
                  element={
                    <RequireAdmin>
                      <Routes>
                        <Route path="users" element={<UsersPage />} />
                        <Route path="roles" element={<RolesPage />} />
                        <Route path="teams" element={<TeamsPage />} />
                        <Route path="client-access" element={<ClientAccessPage />} />
                        <Route path="sso" element={<SsoPage />} />
                        <Route path="provisioning" element={<ScimPage />} />
                        <Route path="group-mappings" element={<GroupMappingsPage />} />
                        {/* ADR-0066 */}
                        <Route path="virtual-keys" element={<VirtualKeysPage />} />
                        <Route path="rules" element={<RulesEnginePage />} />
                        <Route path="simulation" element={<SimulationPage />} />
                        <Route path="abac-policies" element={<AbacPoliciesPage />} />
                        <Route path="guardrails" element={<GuardrailsPage />} />
                        <Route path="evals" element={<EvalsPage />} />
                        <Route path="model-risk" element={<ModelRiskPage />} />
                        {/* ADR-0080 */}
                        <Route path="use-cases" element={<UseCasesPage />} />
                        {/* ADR-0084 */}
                        <Route path="vendors" element={<VendorsPage />} />
                        {/* ADR-0081 */}
                        <Route path="risks" element={<RisksPage />} />
                        {/* ADR-0082 */}
                        <Route path="inventory" element={<InventoryPage />} />
                        <Route path="posture" element={<PosturePage />} />
                        <Route path="redteam" element={<RedTeamPage />} />
                        <Route path="reports" element={<ReportsPage />} />
                        <Route path="prompt-versions" element={<PromptVersionsPage />} />
                        <Route path="approvals" element={<ApprovalsAdminPage />} />
                        <Route path="review-workbench" element={<ReviewWorkbenchPage />} />
                        <Route path="audit" element={<AuditLogPage />} />
                        <Route path="lineage" element={<LineagePage />} />
                        {/* ADR-0070 */}
                        <Route path="traces" element={<TracesPage />} />
                        {/* ADR-0065 */}
                        <Route path="regulait-llm" element={<RegulAItLlmPage />} />
                        {/* ADR-0055 */}
                        <Route path="shadow-ai" element={<ShadowAiPage />} />
                        {/* ADR-0056 */}
                        <Route path="copilot" element={<CopilotPage />} />
                        {/* ADR-0061 */}
                        <Route path="chatops" element={<ChatOpsPage />} />
                        <Route path="workflow-templates" element={<WorkflowTemplatesPage />} />
                        <Route path="agents" element={<AgentsPage />} />
                        <Route path="model-credentials" element={<ModelCredentialsPage />} />
                        <Route path="custom-providers" element={<CustomProvidersPage />} />
                        <Route path="connectors" element={<ConnectorsPage />} />
                        <Route path="mcp-servers" element={<McpServersPage />} />
                        <Route path="git-connections" element={<GitConnectionsPage />} />
                        <Route path="pm-connections" element={<PmConnectionsPage />} />
                        <Route path="deploy-targets" element={<DeployTargetsPage />} />
                        <Route path="cost" element={<CostDashboardPage />} />
                        {/* ADR-0069 */}
                        <Route path="cost-consolidation" element={<CostConsolidationPage />} />
                        <Route path="spend-monitor" element={<SpendMonitorPage />} />
                        <Route path="billing" element={<BillingPage />} />
                        <Route path="optimization" element={<OptimizationPage />} />
                        <Route path="compliance" element={<ComplianceProfilesPage />} />
                        {/* ADR-0058 */}
                        <Route path="compliance-packs" element={<CompliancePacksPage />} />
                        <Route path="infrastructure" element={<InfrastructurePage />} />
                        <Route path="organization" element={<OrganizationPage />} />
                        <Route path="licensing" element={<LicensingPage />} />
                        {/* ADR-0063 */}
                        <Route path="data-key" element={<DataKeyPage />} />
                        {/* ADR-0064 */}
                        <Route path="scheduler" element={<SchedulerPage />} />
                        <Route path="setup" element={<GettingStartedPage />} />
                        {/* ADR-0054: the ordered, resumable first-run FLOW. Distinct from
                            "setup" above, which is a read-only readiness mirror. */}
                        <Route path="first-run" element={<FirstRunPage />} />
                        <Route path="*" element={<Navigate to="/admin/users" replace />} />
                      </Routes>
                    </RequireAdmin>
                  }
                />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Route>
            </Routes>
          </BrowserRouter>
        </SessionProvider>
      </ToastProvider>
    </QueryClientProvider>
  );
}
