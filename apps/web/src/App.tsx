import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createBrowserRouter, Navigate, Outlet, Route, RouterProvider, Routes, useLocation } from "react-router-dom";
import { SessionProvider, useSession } from "./session/SessionContext";
import { ToastProvider } from "./ui/toast";
import { SkeletonBlock } from "./ui/kit";
import AppShell from "./shell/AppShell";
import LoginPage from "./views/auth/LoginPage";
import ForcedPasswordChange from "./views/auth/ForcedPasswordChange";
import ForcedMfaEnroll from "./views/auth/ForcedMfaEnroll";
import HomePage from "./views/home/HomePage";
import ChatPage from "./views/chat/ChatPage";
import BuilderChatPage from "./views/builder/BuilderChatPage";
import BuilderInboxPage from "./views/builder/BuilderInboxPage";
import BuilderAgentsPage from "./views/builder/BuilderAgentsPage";
import BuilderAgentEditorPage from "./views/builder/BuilderAgentEditorPage";
import BuilderTemplatesPage from "./views/builder/BuilderTemplatesPage";
import BuilderTemplateDetailPage from "./views/builder/BuilderTemplateDetailPage";
import BuilderIntegrationsPage from "./views/builder/BuilderIntegrationsPage";
import BuilderSkillsPage from "./views/builder/BuilderSkillsPage";
import BuilderUsagePage from "./views/builder/BuilderUsagePage";
// ADR-0173 batch 2b — the governed prompt registry, the playground and outbound webhooks
import BuilderPromptsPage from "./views/builder/BuilderPromptsPage";
import BuilderPromptDetailPage from "./views/builder/BuilderPromptDetailPage";
import BuilderPlaygroundPage from "./views/builder/BuilderPlaygroundPage";
import WebhooksPage from "./views/admin/integrations/WebhooksPage";
import ModelsPage from "./views/models/ModelsPage";
import RunsPage from "./views/runs/RunsPage";
import RunDetailPage from "./views/runs/RunDetailPage";
import WorkflowsPage from "./views/workflows/WorkflowsPage";
import WorkflowDetailPage from "./views/workflows/WorkflowDetailPage";
import InboxPage from "./views/inbox/InboxPage";
// ADR-0173 batch 2c (Q): annotation queues (admin setup) and the reviewer view
import AnnotationReviewPage from "./views/inbox/AnnotationReviewPage";
import AnnotationQueuesPage from "./views/admin/governance/AnnotationQueuesPage";
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
import CredentialsPage from "./views/admin/identity/CredentialsPage";
import GroupMappingsPage from "./views/admin/identity/GroupMappingsPage";
import VirtualKeysPage from "./views/admin/identity/VirtualKeysPage";
import RulesEnginePage from "./views/admin/governance/RulesEnginePage";
import SimulationPage from "./views/admin/governance/SimulationPage";
import AbacPoliciesPage from "./views/admin/governance/AbacPoliciesPage";
import GuardrailsPage from "./views/admin/governance/GuardrailsPage";
import ModelPolicyPage from "./views/admin/governance/ModelPolicyPage";
import EvalsPage from "./views/admin/governance/EvalsPage";
import ModelRiskPage from "./views/admin/governance/ModelRiskPage";
import UseCasesPage from "./views/admin/governance/UseCasesPage";
import IntakeWizardPage from "./views/admin/governance/IntakeWizardPage";
import ReviewPolicyPage from "./views/admin/governance/ReviewPolicyPage";
import TrustDashboardPage from "./views/admin/governance/TrustDashboardPage";
import UseCaseOverviewPage from "./views/admin/governance/UseCaseOverviewPage";
import GovernanceAlertsPage from "./views/admin/governance/GovernanceAlertsPage";
import DependencyGraphPage from "./views/admin/governance/DependencyGraphPage";
import RegulatoryIntelligencePage from "./views/admin/governance/RegulatoryIntelligencePage";
import VendorsPage from "./views/admin/governance/VendorsPage";
import RisksPage from "./views/admin/governance/RisksPage";
import InventoryPage from "./views/admin/governance/InventoryPage";
import CampaignsPage from "./views/admin/governance/CampaignsPage";
import RecommendationsPage from "./views/admin/governance/RecommendationsPage";
import SodRulesPage from "./views/admin/governance/SodRulesPage";
import PosturePage from "./views/admin/governance/PosturePage";
import RedTeamPage from "./views/admin/governance/RedTeamPage";
import AdmissionReviewPage from "./views/admin/governance/AdmissionReviewPage";
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
// ADR-0173 batch 2c (K)
import MonitoringPage from "./views/admin/observability/MonitoringPage";
import WorkflowTemplatesPage from "./views/admin/governance/WorkflowTemplatesPage";
import AgentsPage from "./views/admin/integrations/AgentsPage";
import ModelCredentialsPage from "./views/admin/integrations/ModelCredentialsPage";
import CustomProvidersPage from "./views/admin/integrations/CustomProvidersPage";
import ExternalScorersPage from "./views/admin/integrations/ExternalScorersPage";
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
import EnforcementPosturePage from "./views/admin/settings/EnforcementPosturePage";
import ExecutionControlPage from "./views/admin/settings/ExecutionControlPage";
// ADR-0182 (ADR-0175 batch D4) — each page is its slice's file (P0 stubs)
import DecisionRegressionPage from "./views/admin/governance/DecisionRegressionPage";
import LiteracyPage from "./views/admin/governance/LiteracyPage";
import IncidentsPage from "./views/incidents/IncidentsPage";
import IncidentDetailPage from "./views/incidents/IncidentDetailPage";
import FeedbackPage from "./views/feedback/FeedbackPage";
import FeedbackFormPage from "./views/feedback/FeedbackFormPage";

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

function ApplicationRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      {/* ADR-0182 A13: a PUBLIC signed feedback link — no app chrome, no
          session; the gateway authenticates the link itself (shipped off) */}
      <Route path="/f/:token" element={<FeedbackFormPage public />} />
      <Route element={<Protected />}>
        <Route path="/" element={<HomePage />} />
        <Route path="/chat" element={<ChatPage />} />
        <Route path="/models" element={<ModelsPage />} />
        <Route path="/builder" element={<BuilderChatPage />} />
        <Route path="/builder/inbox" element={<BuilderInboxPage />} />
        <Route path="/builder/agents" element={<BuilderAgentsPage />} />
        <Route path="/builder/agents/:agentId" element={<BuilderAgentEditorPage />} />
        <Route path="/builder/templates" element={<BuilderTemplatesPage />} />
        <Route path="/builder/templates/:templateId" element={<BuilderTemplateDetailPage />} />
        <Route path="/builder/integrations" element={<BuilderIntegrationsPage />} />
        <Route path="/builder/skills" element={<BuilderSkillsPage />} />
        <Route path="/builder/usage" element={<BuilderUsagePage />} />
        <Route path="/builder/prompts" element={<BuilderPromptsPage />} />
        <Route path="/builder/prompts/:promptId" element={<BuilderPromptDetailPage />} />
        <Route path="/builder/playground" element={<BuilderPlaygroundPage />} />
        <Route path="/runs" element={<RunsPage />} />
        <Route path="/runs/:runId" element={<RunDetailPage />} />
        <Route path="/workflows" element={<WorkflowsPage />} />
        <Route path="/workflows/:instanceId" element={<WorkflowDetailPage />} />
        <Route path="/inbox" element={<InboxPage />} />
        {/* ADR-0173 batch 2c (Q): outside RequireAdmin — a named reviewer works here; the server gates the read */}
        <Route path="/inbox/annotations/:itemId" element={<AnnotationReviewPage />} />
        <Route path="/projects" element={<ProjectsPage />} />
        <Route path="/projects/:projectId" element={<ProjectDetailPage />} />
        <Route path="/projects/:projectId/context" element={<ProjectContextPage />} />
        <Route path="/projects/:projectId/context/graph" element={<ContextGraphPage />} />
        <Route path="/context" element={<ContextIndexPage />} />
        <Route path="/spend" element={<SpendPage />} />
        <Route path="/account" element={<AccountPage />} />
        {/* ADR-0182 (D4): outside RequireAdmin — anyone may report an incident
            or a problem; the server filters what each person may see */}
        <Route path="/incidents" element={<IncidentsPage />} />
        <Route path="/incidents/:incidentId" element={<IncidentDetailPage />} />
        <Route path="/feedback" element={<FeedbackPage />} />
        <Route path="/feedback/:useCaseId" element={<FeedbackFormPage />} />
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
                {/* ADR-0175 A7 */}
                <Route path="credentials" element={<CredentialsPage />} />
                <Route path="rules" element={<RulesEnginePage />} />
                <Route path="simulation" element={<SimulationPage />} />
                <Route path="abac-policies" element={<AbacPoliciesPage />} />
                <Route path="guardrails" element={<GuardrailsPage />} />
                {/* ADR-0173 §3 */}
                <Route path="model-policy" element={<ModelPolicyPage />} />
                <Route path="evals" element={<EvalsPage />} />
                {/* ADR-0173 batch 2c (Q) */}
                <Route path="annotation-queues" element={<AnnotationQueuesPage />} />
                <Route path="model-risk" element={<ModelRiskPage />} />
                {/* ADR-0080 */}
                <Route path="use-cases" element={<UseCasesPage />} />
                <Route path="governance/intake" element={<IntakeWizardPage />} />
                <Route path="governance/review-policy" element={<ReviewPolicyPage />} />
                <Route path="governance/trust" element={<TrustDashboardPage />} />
                <Route path="governance/use-cases/:id" element={<UseCaseOverviewPage />} />
                <Route path="governance/use-cases" element={<Navigate to="/admin/use-cases" replace />} />
                <Route path="governance/alerts" element={<GovernanceAlertsPage />} />
                <Route path="governance/graph" element={<DependencyGraphPage />} />
                <Route path="governance/regulatory" element={<RegulatoryIntelligencePage />} />
                {/* ADR-0182 (D4): A11 decision regression, A14 AI literacy */}
                <Route path="governance/decision-regression" element={<DecisionRegressionPage />} />
                <Route path="governance/literacy" element={<LiteracyPage />} />
                {/* ADR-0084 */}
                <Route path="vendors" element={<VendorsPage />} />
                {/* ADR-0081 */}
                <Route path="risks" element={<RisksPage />} />
                {/* ADR-0082 */}
                <Route path="inventory" element={<InventoryPage />} />
                <Route path="certification" element={<CampaignsPage />} />
                <Route path="recommendations" element={<RecommendationsPage />} />
                {/* ADR-0091 */}
                <Route path="sod" element={<SodRulesPage />} />
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
                <Route path="monitoring" element={<MonitoringPage />} />
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
                {/* ADR-0088 */}
                <Route path="external-scorers" element={<ExternalScorersPage />} />
                <Route path="connectors" element={<ConnectorsPage />} />
                <Route path="mcp-servers" element={<McpServersPage />} />
                {/* ADR-0173 batch 2b */}
                <Route path="webhooks" element={<WebhooksPage />} />
                <Route path="admission" element={<AdmissionReviewPage />} />
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
                {/* ADR-0118 — distinct from "posture" above, which is the
                    ADR-0082 executive one-pager: this is the configuration read. */}
                <Route path="enforcement-posture" element={<EnforcementPosturePage />} />
                {/* ADR-0124 — the emergency stop */}
                <Route path="execution" element={<ExecutionControlPage />} />
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
  );
}

// Keep the existing route tree while enabling the router's supported blocker
// for links, programmatic navigation and browser history transitions (X13).
const router = createBrowserRouter(
  [{ path: "*", element: <ApplicationRoutes /> }],
  { basename: "/ui" },
);

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <SessionProvider>
          <RouterProvider router={router} />
        </SessionProvider>
      </ToastProvider>
    </QueryClientProvider>
  );
}
