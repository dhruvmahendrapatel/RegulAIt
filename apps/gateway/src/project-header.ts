/**
 * The request header that attributes a call to a project (`x-regulait-project-id`). A LEAF module on purpose: both
 * `mcp-proxy.ts` and `compat-core.ts` read it at module initialisation, and `compat-core.ts` is reached from
 * `mcp-proxy.ts` through an import chain (executor-stdio, execution-placement, ...), so the constant must not live in
 * either of them (an import cycle would leave it uninitialised for whichever module the loader enters second).
 */
export const PROJECT_HEADER = "x-regulait-project-id";
