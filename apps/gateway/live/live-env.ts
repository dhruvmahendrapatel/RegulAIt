/**
 * ADR-0326 — which live groups have credentials, and how a live test talks about secrets.
 *
 * A group runs only when every one of its variables is set; otherwise its `describe` is skipped and names the
 * missing variables (names only, never values). Values are read here and nowhere else, are never logged, and every
 * string a live test prints goes through `redact`.
 *
 * Use test tenants and low-limit test keys only. In a Claude Code cloud session the proxy can inject a provider key
 * as a header; set the variable to any placeholder there (`proxy-injected`) and the proxy replaces it on the wire.
 */
export const LIVE_GROUPS = {
  anthropic: ["ANTHROPIC_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  gemini: ["GEMINI_API_KEY"],
  // No native routing exists yet (PILOT_READINESS G2-1/G2-2); the groups are declared so the gap shows as a skip.
  bedrock: ["REGULAIT_LIVE_BEDROCK_REGION", "REGULAIT_LIVE_BEDROCK_MODEL"],
  vertex: ["REGULAIT_LIVE_VERTEX_PROJECT", "REGULAIT_LIVE_VERTEX_LOCATION"],
  ado: ["REGULAIT_LIVE_ADO_ORG", "REGULAIT_LIVE_ADO_PROJECT", "REGULAIT_LIVE_ADO_REPO", "REGULAIT_LIVE_ADO_PAT"],
  entra: ["REGULAIT_LIVE_ENTRA_TENANT_ID", "REGULAIT_LIVE_ENTRA_CLIENT_ID", "REGULAIT_LIVE_ENTRA_CLIENT_SECRET"],
} as const;

export type LiveGroup = keyof typeof LIVE_GROUPS;

export function missingFor(group: LiveGroup, env: NodeJS.ProcessEnv = process.env): string[] {
  return LIVE_GROUPS[group].filter((name) => !env[name] || env[name]!.trim() === "");
}

export function liveEnabled(group: LiveGroup, env: NodeJS.ProcessEnv = process.env): boolean {
  return missingFor(group, env).length === 0;
}

/** a describe title that says why a group is skipped, by variable NAME */
export function liveTitle(group: LiveGroup, title: string, env: NodeJS.ProcessEnv = process.env): string {
  const missing = missingFor(group, env);
  return missing.length === 0 ? `[live:${group}] ${title}` : `[live:${group}] ${title} (skipped: ${missing.join(", ")} unset)`;
}

export function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`live harness: ${name} is unset`);
  return v;
}

/** every secret value currently in the environment, for redaction */
function secretValues(env: NodeJS.ProcessEnv): string[] {
  const names = Object.values(LIVE_GROUPS).flat().filter((n) => /KEY|PAT|SECRET|TOKEN/.test(n));
  return names.map((n) => env[n]).filter((v): v is string => typeof v === "string" && v.length >= 4);
}

/** replaces every live secret value (and anything shaped like a bearer/basic credential) with `[redacted]` */
export function redact(text: string, env: NodeJS.ProcessEnv = process.env): string {
  let out = text;
  for (const v of secretValues(env)) out = out.split(v).join("[redacted]");
  return out.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, "$1 [redacted]");
}
