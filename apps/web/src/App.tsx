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
import AccountPage from "./views/account/AccountPage";
import { RequireAdmin } from "./views/admin/adminKit";
import UsersPage from "./views/admin/identity/UsersPage";
import RolesPage from "./views/admin/identity/RolesPage";
import TeamsPage from "./views/admin/identity/TeamsPage";
import ClientAccessPage from "./views/admin/identity/ClientAccessPage";
import SsoPage from "./views/admin/identity/SsoPage";
import RulesEnginePage from "./views/admin/governance/RulesEnginePage";
import SimulationPage from "./views/admin/governance/SimulationPage";
import ApprovalsAdminPage from "./views/admin/governance/ApprovalsAdminPage";
import AuditLogPage from "./views/admin/governance/AuditLogPage";
import WorkflowTemplatesPage from "./views/admin/governance/WorkflowTemplatesPage";
import AgentsPage from "./views/admin/integrations/AgentsPage";
import ModelCredentialsPage from "./views/admin/integrations/ModelCredentialsPage";
import ConnectorsPage from "./views/admin/integrations/ConnectorsPage";
import McpServersPage from "./views/admin/integrations/McpServersPage";
import GitConnectionsPage from "./views/admin/integrations/GitConnectionsPage";
import PmConnectionsPage from "./views/admin/integrations/PmConnectionsPage";
import DeployTargetsPage from "./views/admin/integrations/DeployTargetsPage";
import CostDashboardPage from "./views/admin/cost/CostDashboardPage";
import OptimizationPage from "./views/admin/cost/OptimizationPage";
import ComplianceProfilesPage from "./views/admin/compliance/ComplianceProfilesPage";
import InfrastructurePage from "./views/admin/compliance/InfrastructurePage";
import OrganizationPage from "./views/admin/settings/OrganizationPage";
import GettingStartedPage from "./views/admin/settings/GettingStartedPage";

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
                        <Route path="rules" element={<RulesEnginePage />} />
                        <Route path="simulation" element={<SimulationPage />} />
                        <Route path="approvals" element={<ApprovalsAdminPage />} />
                        <Route path="audit" element={<AuditLogPage />} />
                        <Route path="workflow-templates" element={<WorkflowTemplatesPage />} />
                        <Route path="agents" element={<AgentsPage />} />
                        <Route path="model-credentials" element={<ModelCredentialsPage />} />
                        <Route path="connectors" element={<ConnectorsPage />} />
                        <Route path="mcp-servers" element={<McpServersPage />} />
                        <Route path="git-connections" element={<GitConnectionsPage />} />
                        <Route path="pm-connections" element={<PmConnectionsPage />} />
                        <Route path="deploy-targets" element={<DeployTargetsPage />} />
                        <Route path="cost" element={<CostDashboardPage />} />
                        <Route path="optimization" element={<OptimizationPage />} />
                        <Route path="compliance" element={<ComplianceProfilesPage />} />
                        <Route path="infrastructure" element={<InfrastructurePage />} />
                        <Route path="organization" element={<OrganizationPage />} />
                        <Route path="setup" element={<GettingStartedPage />} />
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
