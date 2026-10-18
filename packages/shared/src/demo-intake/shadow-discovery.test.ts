import { describe, expect, it } from "vitest";
import { DEMO_SHADOW_DISCOVERY as D } from "./shadow-discovery.js";
import { DEMO_INTAKE_FIXTURES } from "./fixtures.js";
import { credentialTargetMatch, publicConfigProblem } from "../discovery/index.js";
import { PRESENCE_SIGNATURES_V1, isEnvName } from "../discovery/presence-signatures.js";

describe("DEMO_SHADOW_DISCOVERY (ADR-0197 decision 7)", () => {
  it("belongs to the intake fixtures' fictional demo company", () => {
    expect(D.company).toBe(DEMO_INTAKE_FIXTURES.company.name);
  });

  it("names every source distinctly, marked as the demo dataset", () => {
    const names = [D.gitlab.name, D.aws.name, D.azure.name, D.inventory.name, D.agent.name];
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) expect(n.endsWith(D.sourceSuffix)).toBe(true);
  });

  it("gives each cloud credential a public config the gateway accepts, matching its target", () => {
    expect(publicConfigProblem("cloud_aws", "federated", { roleArn: D.aws.roleArn })).toBeNull();
    expect(credentialTargetMatch("cloud_aws", { accountId: D.aws.accountId }, { roleArn: D.aws.roleArn })).toBe("match");
    const az = { tenantId: D.azure.tenantId, clientId: D.azure.clientId };
    expect(publicConfigProblem("cloud_azure", "federated", az)).toBeNull();
    expect(credentialTargetMatch("cloud_azure", { tenantId: D.azure.tenantId }, az)).toBe("match");
    expect(D.aws.accountId).toMatch(/^[0-9]{12}$/);
  });

  it("keeps every observation inside its own account or subscription", () => {
    for (const o of D.aws.observations) expect(o.subject).toContain(`:${D.aws.accountId}:`);
    for (const o of D.azure.observations) expect(o.subject.startsWith(`/subscriptions/${D.azure.subscriptionId}/`)).toBe(true);
  });

  it("uses only presence names the v1 presence catalogue knows, so each one is a signature hit, never a stored name", () => {
    const envNames = new Set(PRESENCE_SIGNATURES_V1.filter((s) => s.kind === "env_name").map((s) => s.value));
    const cliNames = new Set(PRESENCE_SIGNATURES_V1.filter((s) => s.kind === "cli").map((s) => s.value));
    const presenceIds = new Set(PRESENCE_SIGNATURES_V1.map((s) => s.id));
    for (const repo of D.gitlab.repos) {
      for (const f of repo.files.filter((x) => x.path === ".env.example")) {
        const names = f.content.split("\n").map((l) => l.split("=")[0]!).filter(Boolean);
        expect(names.some((n) => envNames.has(n))).toBe(true);
        // no value is ever written in the recorded example files
        for (const l of f.content.split("\n").filter(Boolean)) expect(l.endsWith("=") || /=[0-9]+$/.test(l)).toBe(true);
      }
    }
    for (const f of D.agent.facts.filter((x) => x.kind === "cli" || x.kind === "env_name")) {
      expect(presenceIds.has(f.signatureId)).toBe(true);
      expect(f.kind === "cli" ? cliNames.has(f.identifier) : envNames.has(f.identifier) && isEnvName(f.identifier)).toBe(true);
    }
  });

  it("holds no personal data: no e-mail address and no secret-shaped value", () => {
    const all = JSON.stringify(D);
    expect(all).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
    expect(all).not.toMatch(/sk-[A-Za-z0-9-]{16,}|glpat-|AKIA[0-9A-Z]{16}/);
  });

  it("aims the remediation beat at a recorded repository", () => {
    expect(D.gitlab.repos.map((r) => r.fullName)).toContain(D.remediation.repo);
    for (const r of D.gitlab.repos) expect(r.commitSha).toMatch(/^[0-9a-f]{40}$/);
  });
});
