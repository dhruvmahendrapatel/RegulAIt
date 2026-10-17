/** Types for ui-spa-routes.mjs (imported by the enterprise UI harness, apps/web/e2e/enterprise). */
export interface SpaRoute {
  path: string;
  url: string;
}
export const APP_FILE: string;
export const PARAM_FIXTURE: string;
export function spaRoutes(src?: string): SpaRoute[];
export function routeSlug(routePath: string): string;
