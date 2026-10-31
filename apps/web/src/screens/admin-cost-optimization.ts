// ADR-0196 U4: the screens of one chunk, loaded together on the first visit to any of them (see App.tsx).
export { default as BillingPage } from "../views/admin/cost/BillingPage";
export { default as CostConsolidationPage } from "../views/admin/cost/CostConsolidationPage";
export { default as CostDashboardPage } from "../views/admin/cost/CostDashboardPage";
export { default as OptimizationPage } from "../views/admin/cost/OptimizationPage";
export { default as SpendMonitorPage } from "../views/admin/cost/SpendMonitorPage";
// P3 (#453): the consolidation area (overview + full import lists) as one lazy chunk reached through this screen.
export { CostConsolidationArea } from "../views/admin/cost/CostImportsPages";
