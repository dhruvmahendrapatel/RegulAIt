/** Types for ui-spa-routes.mjs (imported by the enterprise UI harness, apps/web/e2e/enterprise). */
export interface SpaRoute {
  path: string;
  url: string;
  /** outside every SIGNED_IN_LAYOUTS layout: the harness opens it signed out */
  public: boolean;
}
export const APP_FILE: string;
export const PARAM_FIXTURE: string;
export const SIGNED_IN_LAYOUTS: Set<string>;
export function spaRoutes(src?: string): SpaRoute[];
export function routeSlug(routePath: string): string;
