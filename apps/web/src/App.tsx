import { lazy, Suspense, type ComponentType } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createBrowserRouter, Navigate, Outlet, Route, RouterProvider, Routes, useLocation } from "react-router-dom";
import { SessionProvider, useSession } from "./session/SessionContext";
import { ToastProvider } from "./ui/toast";
import { SkeletonBlock } from "./ui/kit";
import { RouteFallback } from "./shell/RouteFallback";
import AppShell from "./shell/AppShell";
import { RequireAdmin } from "./views/admin/adminKit";

// ADR-0196 U4: the screens load on demand. Each module under ./screens is one chunk, the screens of one console
// section (the admin groups in shell/suites.tsx) or one workspace area; a section's screens share their code, so
// a chunk per screen would cost more in total than it saves on a first visit. A navigation runs in a transition
// (the router's default), so the current screen stays up while the next one loads; RouteFallback shows only on a
// first load, inside the shell.
const LoginPage = screen(() => import("./screens/auth"), "LoginPage");
const ForcedPasswordChange = screen(() => import("./screens/auth"), "ForcedPasswordChange");
const ForcedMfaEnroll = screen(() => import("./screens/auth"), "ForcedMfaEnroll");
const HomePage = lazy(() => import("./views/home/HomePage"));
const ChatPage = lazy(() => import("./views/chat/ChatPage"));
const BuilderChatPage = screen(() => import("./screens/builder"), "BuilderChatPage");
const BuilderInboxPage = screen(() => import("./screens/builder"), "BuilderInboxPage");
const BuilderAgentsPage = screen(() => import("./screens/builder"), "BuilderAgentsPage");
const BuilderAgentEditorPage = screen(() => import("./screens/builder"), "BuilderAgentEditorPage");
const BuilderTemplatesPage = screen(() => import("./screens/builder"), "BuilderTemplatesPage");
const BuilderTemplateDetailPage = screen(() => import("./screens/builder"), "BuilderTemplateDetailPage");
const BuilderIntegrationsPage = screen(() => import("./screens/builder"), "BuilderIntegrationsPage");
const BuilderSkillsPage = screen(() => import("./screens/builder"), "BuilderSkillsPage");
const BuilderUsagePage = screen(() => import("./screens/builder"), "BuilderUsagePage");
// ADR-0173 batch 2b — the governed prompt registry, the playground and outbound webhooks
const BuilderPromptsPage = screen(() => import("./screens/builder"), "BuilderPromptsPage");
const BuilderPromptDetailPage = screen(() => import("./screens/builder"), "BuilderPromptDetailPage");
const BuilderPlaygroundPage = screen(() => import("./screens/builder"), "BuilderPlaygroundPage");
const WebhooksPage = screen(() => import("./screens/admin-integrations"), "WebhooksPage");
const ModelsPage = lazy(() => import("./views/models/ModelsPage"));
const RunsPage = screen(() => import("./screens/runs"), "RunsPage");
const RunDetailPage = screen(() => import("./screens/runs"), "RunDetailPage");
const WorkflowsPage = screen(() => import("./screens/workflows"), "WorkflowsPage");
const WorkflowDetailPage = screen(() => import("./screens/workflows"), "WorkflowDetailPage");
const InboxPage = screen(() => import("./screens/inbox"), "InboxPage");
// ADR-0173 batch 2c (Q): annotation queues (admin setup) and the reviewer view
const AnnotationReviewPage = screen(() => import("./screens/inbox"), "AnnotationReviewPage");
const AnnotationQueuesPage = screen(() => import("./screens/admin-quality-security"), "AnnotationQueuesPage");
const ProjectsPage = screen(() => import("./screens/projects"), "ProjectsPage");
const ProjectDetailPage = screen(() => import("./screens/projects"), "ProjectDetailPage");
const ProjectContextPage = screen(() => import("./screens/projects"), "ProjectContextPage");
const ContextGraphPage = screen(() => import("./screens/projects"), "ContextGraphPage");
const ContextIndexPage = screen(() => import("./screens/projects"), "ContextIndexPage");
const SpendPage = lazy(() => import("./views/spend/SpendPage"));
const AccountPage = lazy(() => import("./views/account/AccountPage"));
const UsersPage = screen(() => import("./screens/admin-identity-access"), "UsersPage");
const RolesPage = screen(() => import("./screens/admin-identity-access"), "RolesPage");
const TeamsPage = screen(() => import("./screens/admin-identity-access"), "TeamsPage");
const ClientAccessPage = screen(() => import("./screens/admin-identity-access"), "ClientAccessPage");
const SsoPage = screen(() => import("./screens/admin-identity-access"), "SsoPage");
const ScimPage = screen(() => import("./screens/admin-identity-access"), "ScimPage");
const CredentialsPage = screen(() => import("./screens/admin-identity-access"), "CredentialsPage");
const GroupMappingsPage = screen(() => import("./screens/admin-identity-access"), "GroupMappingsPage");
const VirtualKeysPage = screen(() => import("./screens/admin-identity-access"), "VirtualKeysPage");
const WorkloadIdentitiesPage = screen(() => import("./screens/admin-identity-access"), "WorkloadIdentitiesPage");
const RulesEnginePage = screen(() => import("./screens/admin-policies-gates"), "RulesEnginePage");
const SimulationPage = screen(() => import("./screens/admin-policies-gates"), "SimulationPage");
const AbacPoliciesPage = screen(() => import("./screens/admin-policies-gates"), "AbacPoliciesPage");
const GuardrailsPage = screen(() => import("./screens/admin-policies-gates"), "GuardrailsPage");
const ModelPolicyPage = screen(() => import("./screens/admin-policies-gates"), "ModelPolicyPage");
const EvalsPage = screen(() => import("./screens/admin-quality-security"), "EvalsPage");
const ModelRiskPage = screen(() => import("./screens/admin-ai-governance"), "ModelRiskPage");
const UseCasesPage = screen(() => import("./screens/admin-ai-governance"), "UseCasesPage");
const IntakeWizardPage = screen(() => import("./screens/admin-ai-governance"), "IntakeWizardPage");
const ReviewPolicyPage = screen(() => import("./screens/admin-ai-governance"), "ReviewPolicyPage");
const TrustDashboardPage = screen(() => import("./screens/admin-overview"), "TrustDashboardPage");
const UseCaseOverviewPage = screen(() => import("./screens/admin-ai-governance"), "UseCaseOverviewPage");
const GovernanceAlertsPage = screen(() => import("./screens/admin-overview"), "GovernanceAlertsPage");
const DependencyGraphPage = screen(() => import("./screens/admin-ai-governance"), "DependencyGraphPage");
const RegulatoryIntelligencePage = screen(() => import("./screens/admin-ai-governance"), "RegulatoryIntelligencePage");
const VendorsPage = screen(() => import("./screens/admin-ai-governance"), "VendorsPage");
const RisksPage = screen(() => import("./screens/admin-ai-governance"), "RisksPage");
const InventoryPage = screen(() => import("./screens/admin-access-reviews"), "InventoryPage");
const CampaignsPage = screen(() => import("./screens/admin-access-reviews"), "CampaignsPage");
const RecommendationsPage = screen(() => import("./screens/admin-access-reviews"), "RecommendationsPage");
const SodRulesPage = screen(() => import("./screens/admin-access-reviews"), "SodRulesPage");
const PosturePage = screen(() => import("./screens/admin-overview"), "PosturePage");
const RedTeamPage = screen(() => import("./screens/admin-quality-security"), "RedTeamPage");
const AdmissionReviewPage = screen(() => import("./screens/admin-integrations"), "AdmissionReviewPage");
const ReportsPage = screen(() => import("./screens/admin-overview"), "ReportsPage");
const PromptVersionsPage = screen(() => import("./screens/admin-policies-gates"), "PromptVersionsPage");
const ApprovalsAdminPage = screen(() => import("./screens/admin-approvals-audit"), "ApprovalsAdminPage");
const ReviewWorkbenchPage = screen(() => import("./screens/admin-approvals-audit"), "ReviewWorkbenchPage");
const AuditLogPage = screen(() => import("./screens/admin-approvals-audit"), "AuditLogPage");
const ShadowAiPage = screen(() => import("./screens/admin-ai-governance"), "ShadowAiPage");
const DiscoverySourcesPage = screen(() => import("./screens/admin-ai-governance"), "DiscoverySourcesPage");
const CopilotPage = screen(() => import("./screens/admin-overview"), "CopilotPage");
const ChatOpsPage = screen(() => import("./screens/admin-approvals-audit"), "ChatOpsPage");
const LineagePage = screen(() => import("./screens/admin-approvals-audit"), "LineagePage");
const RegulAItLlmPage = screen(() => import("./screens/admin-integrations"), "RegulAItLlmPage");
const TracesPage = screen(() => import("./screens/admin-approvals-audit"), "TracesPage");
// ADR-0173 batch 2c (K)
const MonitoringPage = screen(() => import("./screens/admin-overview"), "MonitoringPage");
const WorkflowTemplatesPage = screen(() => import("./screens/admin-policies-gates"), "WorkflowTemplatesPage");
const AgentsPage = screen(() => import("./screens/admin-integrations"), "AgentsPage");
const ModelCredentialsPage = screen(() => import("./screens/admin-integrations"), "ModelCredentialsPage");
const CustomProvidersPage = screen(() => import("./screens/admin-integrations"), "CustomProvidersPage");
const ExternalScorersPage = screen(() => import("./screens/admin-quality-security"), "ExternalScorersPage");
const ConnectorsPage = screen(() => import("./screens/admin-integrations"), "ConnectorsPage");
const McpServersPage = screen(() => import("./screens/admin-integrations"), "McpServersPage");
const GitConnectionsPage = screen(() => import("./screens/admin-integrations"), "GitConnectionsPage");
const PmConnectionsPage = screen(() => import("./screens/admin-integrations"), "PmConnectionsPage");
const DeployTargetsPage = screen(() => import("./screens/admin-integrations"), "DeployTargetsPage");
const EnginesPage = screen(() => import("./screens/admin-integrations"), "EnginesPage");
const CostDashboardPage = screen(() => import("./screens/admin-cost-optimization"), "CostDashboardPage");
const CostConsolidationPage = screen(() => import("./screens/admin-cost-optimization"), "CostConsolidationPage");
const SpendMonitorPage = screen(() => import("./screens/admin-cost-optimization"), "SpendMonitorPage");
const BillingPage = screen(() => import("./screens/admin-cost-optimization"), "BillingPage");
const OptimizationPage = screen(() => import("./screens/admin-cost-optimization"), "OptimizationPage");
const ComplianceProfilesPage = screen(() => import("./screens/admin-compliance-infra"), "ComplianceProfilesPage");
const CompliancePacksPage = screen(() => import("./screens/admin-compliance-infra"), "CompliancePacksPage");
const InfrastructurePage = screen(() => import("./screens/admin-compliance-infra"), "InfrastructurePage");
const OrganizationPage = screen(() => import("./screens/admin-settings"), "OrganizationPage");
const RetentionPage = screen(() => import("./screens/admin-settings"), "RetentionPage");
const GettingStartedPage = screen(() => import("./screens/admin-settings"), "GettingStartedPage");
const FirstRunPage = screen(() => import("./screens/admin-settings"), "FirstRunPage");
const LicensingPage = screen(() => import("./screens/admin-settings"), "LicensingPage");
const DataKeyPage = screen(() => import("./screens/admin-settings"), "DataKeyPage");
const SchedulerPage = screen(() => import("./screens/admin-settings"), "SchedulerPage");
const EnforcementPosturePage = screen(() => import("./screens/admin-settings"), "EnforcementPosturePage");
const ExecutionControlPage = screen(() => import("./screens/admin-settings"), "ExecutionControlPage");
// ADR-0182 (ADR-0175 batch D4) — each page is its slice's file (P0 stubs)
const DecisionRegressionPage = screen(() => import("./screens/admin-ai-governance"), "DecisionRegressionPage");
const LiteracyPage = screen(() => import("./screens/admin-ai-governance"), "LiteracyPage");
const IncidentsPage = screen(() => import("./screens/incidents"), "IncidentsPage");
const IncidentDetailPage = screen(() => import("./screens/incidents"), "IncidentDetailPage");
const FeedbackPage = screen(() => import("./screens/feedback"), "FeedbackPage");
const FeedbackFormPage = screen(() => import("./screens/feedback"), "FeedbackFormPage");

/** one screen of a ./screens chunk, as a lazy component */
function screen<M extends Record<K, ComponentType<any>>, K extends keyof M & string>(load: () => Promise<M>, name: K) {
  return lazy(() => load().then((m) => ({ default: m[name] })));
}

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
      <Suspense fallback={<RouteFallback />}>
        <Outlet />
      </Suspense>
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
                {/* ADR-0188 S6 preview: routed but deliberately NOT in the navigation
                    (suites.tsx) until creating/revoking an identity and binding a
                    credential stop answering 501 — see the page's header comment */}
                <Route path="workload-identities" element={<WorkloadIdentitiesPage />} />
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
                {/* ADR-0195 SD0 */}
                <Route path="shadow-ai/discovery-sources" element={<DiscoverySourcesPage />} />
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
                {/* ADR-0187 (X26) */}
                <Route path="engines" element={<EnginesPage />} />
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
                <Route path="retention" element={<RetentionPage />} />
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
// The outer boundary covers the screens outside the shell (sign-in, the public feedback link, the forced gates);
// a signed-in screen suspends to the one in Protected, so the shell and its focus stay put while it loads.
const router = createBrowserRouter(
  [
    {
      path: "*",
      element: (
        <Suspense fallback={<RouteFallback />}>
          <ApplicationRoutes />
        </Suspense>
      ),
    },
  ],
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
