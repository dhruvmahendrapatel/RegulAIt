// ADR-0196 U4: the screens of one chunk, loaded together on the first visit to any of them (see App.tsx).
export { default as DecisionRegressionPage } from "../views/admin/governance/DecisionRegressionPage";
export { default as DependencyGraphPage } from "../views/admin/governance/DependencyGraphPage";
export { default as DiscoverySourcesPage } from "../views/admin/governance/DiscoverySourcesPage";
export { default as IntakeWizardPage } from "../views/admin/governance/IntakeWizardPage";
export { default as LiteracyPage } from "../views/admin/governance/LiteracyPage";
export { default as ModelRiskPage } from "../views/admin/governance/ModelRiskPage";
export { default as RegulatoryIntelligencePage } from "../views/admin/governance/RegulatoryIntelligencePage";
export { default as ReviewPolicyPage } from "../views/admin/governance/ReviewPolicyPage";
export { default as RisksPage } from "../views/admin/governance/RisksPage";
export { default as ShadowAiPage } from "../views/admin/governance/ShadowAiPage";
export { default as UseCaseOverviewPage } from "../views/admin/governance/UseCaseOverviewPage";
export { default as UseCasesPage } from "../views/admin/governance/UseCasesPage";
export { default as VendorsPage } from "../views/admin/governance/VendorsPage";
// P3 (#453): the Discovery sources area (overview + full runs/tokens/devices lists) as one lazy chunk reached through
// this screen, so the sub-pages add nothing to the entry bundle (its module owns the nested <Routes>; see App.tsx).
export { DiscoverySourcesArea } from "../views/admin/governance/DiscoveryListPages";
