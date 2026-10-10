/** Credential audience checks report rule ids/counts only, never credentials.
 * Consumer supplies an already decoded bounded surface and destination URL.
 * Missing audience hosts grant no exemption. Unrepresentable upstream carrier
 * or path exemptions also grant none; manifest lists each limitation. */
import { VENDORED_SECRET_RULES } from "./index.js";
import { secretCandidateRules, secretRuleSpans, vendoredPackEnabled, type VendoredPackSelection } from "./match.js";
export function credentialAudienceViolations(text: string, target: string, opts: { packs?: VendoredPackSelection } = {}): Array<{ rule: string; count: number }> {
  if (!text || !vendoredPackEnabled(opts.packs, "pipelock-secrets")) return [];
  const url = new URL(target);
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  const hits: Array<{ rule: string; count: number }> = [];
  for (const rule of secretCandidateRules(text, VENDORED_SECRET_RULES)) {
    const permitted = url.protocol === "https:" && (rule.audienceHosts ?? []).some((pattern) => pattern.startsWith("*.") ? host === pattern.slice(2) || host.endsWith(pattern.slice(1)) : host === pattern);
    if (permitted) continue;
    let count = 0; for (const _ of secretRuleSpans(rule, text)) count++;
    if (count) hits.push({ rule: rule.id, count });
  }
  return hits;
}
