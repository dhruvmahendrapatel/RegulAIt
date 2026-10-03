/**
 * ADR-0062 — the posture resolver and the compiled-default decision, as pure
 * functions. No database, no DNS, no network: the allow-list arrives as data
 * and the environment is injected, exactly like `egress-guard.test.ts`.
 *
 * The property this file exists to pin is the CEILING: `org_settings` may
 * tighten and may never loosen. That is asserted from both directions, and by
 * exhausting the whole (mode × org policy) matrix rather than sampling it —
 * a security ceiling with an untested cell is a ceiling with a hole.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_DEPLOY_MODE,
  DEPLOY_MODES,
  DEPLOY_MODE_ENV,
  EGRESS_COMPILED_DEFAULT_POLICIES,
  describeEgressPosture,
  modeEgressPosture,
  resolveDeployMode,
  resolveEgressPosture,
  strictestPosture,
  type DeployMode,
  type EgressCompiledDefaultPolicy,
} from "./deploy-posture.js";
import { decideCompiledDefault } from "./compiled-egress.js";
import type { EgressAllowEntry } from "./egress-guard.js";
import { defaultBaseUrlFor } from "@regulait/model-provider";
import { connectorDefaultBaseUrl } from "@regulait/connector-provider";
import { gitDefaultBaseUrl } from "@regulait/git-provider";
import { pmDefaultBaseUrl } from "@regulait/pm-provider";

const entry = (host: string): EgressAllowEntry => ({
  host,
  allowPrivateRanges: false,
  allowPlaintextHttp: false,
});

describe("ADR-0062 resolveDeployMode — the deployment-shape fact, from the environment", () => {
  it("defaults to hosted when the variable is absent, so every existing deployment is unchanged", () => {
    expect(resolveDeployMode({})).toBe("hosted");
    expect(DEFAULT_DEPLOY_MODE).toBe("hosted");
  });

  it("treats an empty value as unset rather than as an error", () => {
    expect(resolveDeployMode({ [DEPLOY_MODE_ENV]: "" })).toBe("hosted");
    expect(resolveDeployMode({ [DEPLOY_MODE_ENV]: "   " })).toBe("hosted");
  });

  it("accepts every mode, case- and whitespace-insensitively, plus the hyphenated spelling", () => {
    for (const m of DEPLOY_MODES) {
      expect(resolveDeployMode({ [DEPLOY_MODE_ENV]: m })).toBe(m);
      expect(resolveDeployMode({ [DEPLOY_MODE_ENV]: `  ${m.toUpperCase()}  ` })).toBe(m);
    }
    expect(resolveDeployMode({ [DEPLOY_MODE_ENV]: "air-gapped" })).toBe("air_gapped");
  });

  it("THROWS on a typo rather than silently degrading to hosted", () => {
    // the quiet failure mode this exists to prevent: an operator who believes
    // the box is air-gapped while it runs the permissive posture
    expect(() => resolveDeployMode({ [DEPLOY_MODE_ENV]: "airgapped" })).toThrow(/not a deployment mode/);
    expect(() => resolveDeployMode({ [DEPLOY_MODE_ENV]: "air gapped" })).toThrow();
    expect(() => resolveDeployMode({ [DEPLOY_MODE_ENV]: "strict" })).toThrow();
    expect(() => resolveDeployMode({ [DEPLOY_MODE_ENV]: "prod" })).toThrow();
  });
});

describe("ADR-0062 the posture lattice", () => {
  it("air_gapped is strict; hosted and byoc are permissive", () => {
    expect(modeEgressPosture("air_gapped")).toBe("strict");
    expect(modeEgressPosture("hosted")).toBe("permissive");
    expect(modeEgressPosture("byoc")).toBe("permissive");
  });

  it("strictestPosture is MAX over {permissive < strict} in both argument orders", () => {
    expect(strictestPosture("permissive", "permissive")).toBe("permissive");
    expect(strictestPosture("permissive", "strict")).toBe("strict");
    expect(strictestPosture("strict", "permissive")).toBe("strict");
    expect(strictestPosture("strict", "strict")).toBe("strict");
  });

  it("THE WHOLE (mode × org policy) MATRIX — org tightens, org never loosens", () => {
    const expected: Record<DeployMode, Record<EgressCompiledDefaultPolicy | "unset", string>> = {
      hosted: { unset: "permissive", inherit: "permissive", strict: "strict" },
      byoc: { unset: "permissive", inherit: "permissive", strict: "strict" },
      // THE POINT OF THE ADR: no column value produces "permissive" here.
      air_gapped: { unset: "strict", inherit: "strict", strict: "strict" },
    };
    for (const mode of DEPLOY_MODES) {
      expect(resolveEgressPosture({ mode })).toBe(expected[mode].unset);
      expect(resolveEgressPosture({ mode, orgPolicy: null })).toBe(expected[mode].unset);
      for (const orgPolicy of EGRESS_COMPILED_DEFAULT_POLICIES) {
        expect(resolveEgressPosture({ mode, orgPolicy })).toBe(expected[mode][orgPolicy]);
      }
    }
  });

  it("the enum has NO loosening member — the ceiling holds by construction, not by validation", () => {
    expect([...EGRESS_COMPILED_DEFAULT_POLICIES]).toEqual(["inherit", "strict"]);
  });

  it("the boot line names the mode and says what it refuses", () => {
    expect(describeEgressPosture("air_gapped")).toMatch(/STRICT egress/);
    expect(describeEgressPosture("air_gapped")).toMatch(/cannot loosen/);
    expect(describeEgressPosture("hosted")).toMatch(/NOT adjudicated/);
  });
});

describe("ADR-0062 decideCompiledDefault — the admission decision", () => {
  it("PERMISSIVE IS A NO-OP: nothing is adjudicated, even with an empty allow-list", () => {
    for (const kind of ["anthropic", "openai", "google", "xai", "snowflake", "nonsense"]) {
      const d = decideCompiledDefault({
        posture: "permissive",
        surface: "model",
        kind,
        defaultBaseUrl: defaultBaseUrlFor(kind, {}),
        allowList: [],
      });
      expect(d.ok).toBe(true);
    }
  });

  it("STRICT + empty allow-list refuses every built-in model vendor, and names the host", () => {
    const cases: Array<[string, string]> = [
      ["anthropic", "api.anthropic.com"],
      ["openai", "api.openai.com"],
      ["google", "generativelanguage.googleapis.com"],
      ["xai", "api.x.ai"],
    ];
    for (const [kind, host] of cases) {
      const d = decideCompiledDefault({
        posture: "strict",
        surface: "model",
        kind,
        defaultBaseUrl: defaultBaseUrlFor(kind, {}),
        allowList: [],
      });
      expect(d.ok).toBe(false);
      if (d.ok) throw new Error("unreachable");
      expect(d.code).toBe("compiled_default_not_allowlisted");
      expect(d.host).toBe(host);
      expect(d.reason).toContain(host);
    }
  });

  it("STRICT + the vendor host allow-listed ALLOWS — this is a guard, not a ban", () => {
    const d = decideCompiledDefault({
      posture: "strict",
      surface: "model",
      kind: "anthropic",
      defaultBaseUrl: defaultBaseUrlFor("anthropic", {}),
      allowList: [entry("api.anthropic.com")],
    });
    expect(d.ok).toBe(true);
    expect(d.ok && d.host).toBe("api.anthropic.com");
  });

  it("an allow entry for a DIFFERENT host does not open this one", () => {
    const d = decideCompiledDefault({
      posture: "strict",
      surface: "model",
      kind: "openai",
      defaultBaseUrl: defaultBaseUrlFor("openai", {}),
      allowList: [entry("api.anthropic.com"), entry("openai.com"), entry("evil.api.openai.com")],
    });
    expect(d.ok).toBe(false);
  });

  it("host matching is normalized, so a trailing dot or different case cannot be a second host", () => {
    for (const stored of ["API.ANTHROPIC.COM", "api.anthropic.com."]) {
      const d = decideCompiledDefault({
        posture: "strict",
        surface: "model",
        kind: "anthropic",
        defaultBaseUrl: defaultBaseUrlFor("anthropic", {}),
        allowList: [entry(stored)],
      });
      expect(d.ok).toBe(true);
    }
  });

  it("mock and custom have NOTHING to adjudicate in either posture", () => {
    for (const kind of ["mock", "custom"]) {
      expect(defaultBaseUrlFor(kind, {})).toBeNull();
      const d = decideCompiledDefault({
        posture: "strict",
        surface: "model",
        kind,
        defaultBaseUrl: defaultBaseUrlFor(kind, {}),
        allowList: [],
      });
      expect(d.ok).toBe(true);
      expect(d.ok && d.host).toBeNull();
    }
  });

  it("a destination we cannot NAME is refused under strict, never assumed safe", () => {
    // `snowflake` derives its endpoint from the decrypted credential, so this
    // registry genuinely cannot say where it goes.
    expect(connectorDefaultBaseUrl("snowflake")).toBeUndefined();
    const d = decideCompiledDefault({
      posture: "strict",
      surface: "connector",
      kind: "snowflake",
      defaultBaseUrl: connectorDefaultBaseUrl("snowflake"),
      allowList: [],
    });
    expect(d.ok).toBe(false);
    if (d.ok) throw new Error("unreachable");
    expect(d.code).toBe("compiled_default_unknown");
    expect(d.reason).toContain("statically knowable");
  });

  it("an unrecognised kind is also 'cannot name it', on every surface", () => {
    for (const surface of ["model", "connector", "git_connection", "pm_connection"] as const) {
      const d = decideCompiledDefault({
        posture: "strict",
        surface,
        kind: "a-provider-shipped-after-this-was-written",
        defaultBaseUrl: undefined,
        allowList: [entry("api.anthropic.com")],
      });
      expect(d.ok).toBe(false);
      expect(!d.ok && d.code).toBe("compiled_default_unknown");
    }
  });

  it("an unparseable compiled default refuses rather than being treated as hostless", () => {
    const d = decideCompiledDefault({
      posture: "strict",
      surface: "model",
      kind: "weird",
      defaultBaseUrl: "not a url",
      allowList: [],
    });
    expect(d.ok).toBe(false);
    expect(!d.ok && d.code).toBe("compiled_default_unknown");
  });
});

describe("ADR-0062 the compiled-default registries name what the adapters actually reach", () => {
  it("model providers", () => {
    expect(defaultBaseUrlFor("anthropic", {})).toBe("https://api.anthropic.com");
    expect(defaultBaseUrlFor("openai", {})).toBe("https://api.openai.com/v1");
    expect(defaultBaseUrlFor("google", {})).toBe("https://generativelanguage.googleapis.com/v1beta");
    expect(defaultBaseUrlFor("xai", {})).toBe("https://api.x.ai/v1");
  });

  it("the SDKs read their own *_BASE_URL env var, so the registry reads it too", () => {
    // Otherwise the guard would adjudicate `api.anthropic.com` while the SDK
    // quietly went somewhere else entirely.
    expect(defaultBaseUrlFor("anthropic", { ANTHROPIC_BASE_URL: "https://bridge.internal/v1" })).toBe(
      "https://bridge.internal/v1",
    );
    expect(defaultBaseUrlFor("openai", { OPENAI_BASE_URL: "https://bridge.internal/v1" })).toBe(
      "https://bridge.internal/v1",
    );
    const d = decideCompiledDefault({
      posture: "strict",
      surface: "model",
      kind: "anthropic",
      defaultBaseUrl: defaultBaseUrlFor("anthropic", { ANTHROPIC_BASE_URL: "https://bridge.internal/v1" }),
      allowList: [entry("api.anthropic.com")],
    });
    expect(d.ok).toBe(false);
    expect(!d.ok && d.host).toBe("bridge.internal");
  });

  it("connectors", () => {
    expect(connectorDefaultBaseUrl("slack")).toBe("https://slack.com/api");
    expect(connectorDefaultBaseUrl("github")).toBe("https://api.github.com");
    // the two Microsoft couriers reach a compiled vendor host with no baseUrl
    // (AER-015: outlook used to be the `undefined` strict refused as unnameable)
    expect(connectorDefaultBaseUrl("teams")).toBe("https://smba.trafficmanager.net/teams");
    expect(connectorDefaultBaseUrl("outlook")).toBe("https://graph.microsoft.com");
    // every kind whose adapter throws without an explicit baseUrl reaches no
    // compiled destination at all
    for (const k of ["http", "generic", "webhook", "jira", "mock"]) {
      expect(connectorDefaultBaseUrl(k)).toBeNull();
    }
  });

  it("git providers", () => {
    expect(gitDefaultBaseUrl("github")).toBe("https://api.github.com");
    expect(gitDefaultBaseUrl("gitlab")).toBe("https://gitlab.com/api/v4");
    expect(gitDefaultBaseUrl("bitbucket")).toBe("https://api.bitbucket.org/2.0");
    expect(gitDefaultBaseUrl("azure_devops")).toBeNull();
    expect(gitDefaultBaseUrl("mock")).toBeNull();
  });

  it("PM providers", () => {
    expect(pmDefaultBaseUrl("linear")).toBe("https://api.linear.app");
    expect(pmDefaultBaseUrl("asana")).toBe("https://app.asana.com/api/1.0");
    expect(pmDefaultBaseUrl("monday")).toBe("https://api.monday.com");
    for (const k of ["azure_devops", "jira", "generic_webhook", "mock"]) {
      expect(pmDefaultBaseUrl(k)).toBeNull();
    }
  });
});
