/**
 * ADR-0173 §3 — the Model policy page's editable draft, as pure functions so
 * the matrix rules are unit-tested without a browser.
 *
 * The draft holds one BASE entry per feature (restricted?, allowed binding ids,
 * allowed provider kinds, default) and a list of data-class rules. `toRules`
 * turns it into the PUT /v1/model-policy body: a feature that is unrestricted
 * and has no default needs no row at all, which keeps "empty policy = today's
 * behaviour" literally true.
 */
import {
  MODEL_POLICY_FEATURES,
  modelPolicyVerdict,
  type ModelPolicyDataClass,
  type ModelPolicyFeature,
  type ModelPolicyRule,
  type ModelPolicyView,
} from "../../models/modelPolicy";

export interface FeatureDraft {
  restricted: boolean;
  allowedAgentIds: string[];
  allowedProviders: string[];
  defaultAgentId: string | null;
}

export interface ClassRuleDraft {
  feature: ModelPolicyFeature;
  dataClass: ModelPolicyDataClass;
  allowedAgentIds: string[];
  allowedProviders: string[];
  defaultAgentId: string | null;
}

export interface PolicyDraft {
  base: Record<ModelPolicyFeature, FeatureDraft>;
  classes: ClassRuleDraft[];
}

const emptyFeature = (): FeatureDraft => ({ restricted: false, allowedAgentIds: [], allowedProviders: [], defaultAgentId: null });

export function draftFrom(policy: ModelPolicyView | null | undefined): PolicyDraft {
  const base = Object.fromEntries(MODEL_POLICY_FEATURES.map((f) => [f, emptyFeature()])) as Record<ModelPolicyFeature, FeatureDraft>;
  const classes: ClassRuleDraft[] = [];
  for (const r of policy?.rules ?? []) {
    if (r.dataClass === null) {
      base[r.feature] = {
        restricted: r.restricted,
        allowedAgentIds: [...r.allowedAgentIds],
        allowedProviders: [...r.allowedProviders],
        defaultAgentId: r.defaultAgentId,
      };
    } else {
      classes.push({
        feature: r.feature,
        dataClass: r.dataClass,
        allowedAgentIds: [...r.allowedAgentIds],
        allowedProviders: [...r.allowedProviders],
        defaultAgentId: r.defaultAgentId,
      });
    }
  }
  return { base, classes };
}

/** the PUT body's rules, in a stable order */
export function toRules(d: PolicyDraft): ModelPolicyRule[] {
  const out: ModelPolicyRule[] = [];
  for (const f of MODEL_POLICY_FEATURES) {
    const b = d.base[f];
    if (!b.restricted && !b.defaultAgentId) continue;
    out.push({
      feature: f,
      dataClass: null,
      restricted: b.restricted,
      allowedAgentIds: b.restricted ? [...b.allowedAgentIds] : [],
      allowedProviders: b.restricted ? [...b.allowedProviders] : [],
      defaultAgentId: b.defaultAgentId,
    });
  }
  for (const c of d.classes) {
    out.push({
      feature: c.feature,
      dataClass: c.dataClass,
      restricted: true,
      allowedAgentIds: [...c.allowedAgentIds],
      allowedProviders: [...c.allowedProviders],
      defaultAgentId: c.defaultAgentId,
    });
  }
  return out;
}

const toggle = (list: string[], v: string, on: boolean) => (on ? [...new Set([...list, v])] : list.filter((x) => x !== v));

/** is this binding allowed for this feature in the draft (the base rule only)? */
export function cellAllowed(d: PolicyDraft, feature: ModelPolicyFeature, binding: { id: string; provider: string }): boolean {
  return modelPolicyVerdict({ rules: toRules(d) }, feature, binding).allowed;
}

function withBase(d: PolicyDraft, feature: ModelPolicyFeature, next: FeatureDraft): PolicyDraft {
  return { ...d, base: { ...d.base, [feature]: next } };
}

/** turn a feature's restriction on/off; turning it on starts from "nothing allowed" plus the current default */
export function setRestricted(d: PolicyDraft, feature: ModelPolicyFeature, on: boolean): PolicyDraft {
  const cur = d.base[feature];
  if (!on) return withBase(d, feature, { ...cur, restricted: false, allowedAgentIds: [], allowedProviders: [] });
  return withBase(d, feature, {
    ...cur,
    restricted: true,
    allowedAgentIds: cur.defaultAgentId ? [cur.defaultAgentId] : [],
    allowedProviders: [],
  });
}

/** allow/forbid one binding for a feature; forbidding the default clears it */
export function setBindingAllowed(d: PolicyDraft, feature: ModelPolicyFeature, bindingId: string, on: boolean): PolicyDraft {
  const cur = d.base[feature];
  return withBase(d, feature, {
    ...cur,
    allowedAgentIds: toggle(cur.allowedAgentIds, bindingId, on),
    defaultAgentId: !on && cur.defaultAgentId === bindingId ? null : cur.defaultAgentId,
  });
}

/** allow/forbid every binding of a provider for a feature */
export function setProviderAllowed(
  d: PolicyDraft,
  feature: ModelPolicyFeature,
  provider: string,
  on: boolean,
  bindings: ReadonlyArray<{ id: string; provider: string }>,
): PolicyDraft {
  const cur = d.base[feature];
  const next = { ...cur, allowedProviders: toggle(cur.allowedProviders, provider, on) };
  // forbidding a provider whose binding is the default clears a default it no longer allows
  if (!on && cur.defaultAgentId) {
    const dflt = bindings.find((b) => b.id === cur.defaultAgentId);
    if (dflt && dflt.provider === provider && !cur.allowedAgentIds.includes(dflt.id)) next.defaultAgentId = null;
  }
  return withBase(d, feature, next);
}

export function setDefault(d: PolicyDraft, feature: ModelPolicyFeature, bindingId: string | null): PolicyDraft {
  return withBase(d, feature, { ...d.base[feature], defaultAgentId: bindingId });
}

export function upsertClassRule(d: PolicyDraft, rule: ClassRuleDraft): PolicyDraft {
  const rest = d.classes.filter((c) => !(c.feature === rule.feature && c.dataClass === rule.dataClass));
  return { ...d, classes: [...rest, rule] };
}

export function removeClassRule(d: PolicyDraft, feature: ModelPolicyFeature, dataClass: ModelPolicyDataClass): PolicyDraft {
  return { ...d, classes: d.classes.filter((c) => !(c.feature === feature && c.dataClass === dataClass)) };
}

/** a restricted feature that allows nothing refuses every model — said out loud before saving */
export function featuresAllowingNothing(d: PolicyDraft): ModelPolicyFeature[] {
  return MODEL_POLICY_FEATURES.filter(
    (f) => d.base[f].restricted && d.base[f].allowedAgentIds.length === 0 && d.base[f].allowedProviders.length === 0,
  );
}

/** stable JSON of the rules, to tell whether the draft differs from what is saved */
export function draftKey(d: PolicyDraft): string {
  return JSON.stringify(
    toRules(d).map((r) => ({ ...r, allowedAgentIds: [...r.allowedAgentIds].sort(), allowedProviders: [...r.allowedProviders].sort() })),
  );
}
