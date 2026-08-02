/**
 * `@regulait/api-client` — the supported TypeScript client for the RegulAIt
 * public API (ADR-0053).
 *
 * ```ts
 * import { RegulAItClient } from "@regulait/api-client";
 *
 * const client = new RegulAItClient({
 *   baseUrl: "https://regulait.internal.example.com",
 *   apiKey: process.env.REGULAIT_API_KEY!,
 * });
 *
 * const { users } = await client.getV1Users<{ users: Array<{ id: string }> }>();
 * ```
 *
 * SCOPE, STATED PLAINLY. This package covers the routes tagged `public-stable`
 * and `public-beta` in the published spec — not the whole gateway surface. The
 * internal/admin-console routes are deliberately absent and carry no
 * compatibility guarantee; if you need one of them, you are coupling to a
 * surface we reserve the right to change, and you should say so in your own
 * code rather than have an SDK method imply otherwise.
 *
 * Responses are `unknown` with a caller-supplied type parameter. See the header
 * of `generated.ts` for why that is the honest shape today.
 */
export { BaseClient, RegulAItApiError, type RegulAItClientOptions, type RequestOptions } from "./base-client.js";
export { GeneratedRegulAItClient, OPERATIONS } from "./generated.js";
export * from "./generated.js";

import { GeneratedRegulAItClient } from "./generated.js";

/** the client an integrator instantiates */
export class RegulAItClient extends GeneratedRegulAItClient {}
