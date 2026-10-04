/**
 * ADR-0174 security review — the deployment files, read as text (no daemon,
 * no YAML dependency): the shapes a reviewer would check by eye, pinned.
 *
 *  - finding 10: the bundled Keycloak signs in to Postgres as its OWN role
 *    (`keycloak`), whose password comes from REGULAIT_KC_DB_PASSWORD with no
 *    default, and the init job creates that role as the owner of the keycloak
 *    database only. The gateway's own role is not what Keycloak uses.
 *  - finding 2 (realm half): no upstream IdP in the realm import is trusted to
 *    have verified an email on Keycloak's behalf (`trustEmail` false for
 *    Microsoft, Google and GitHub), the first-broker-login flow is Keycloak's
 *    stock one (existing accounts need email or re-auth confirmation), and the
 *    Google hosted-domain restriction is a deployment setting.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const compose = readFileSync(path.join(root, "docker-compose.yml"), "utf8");
const realm = JSON.parse(readFileSync(path.join(root, "infra/keycloak/realm-regulait.json"), "utf8")) as {
  identityProviders: Array<{ alias: string; trustEmail: boolean; firstBrokerLoginFlowAlias: string; config: Record<string, string> }>;
  authenticationFlows?: Array<{ alias: string }>;
};

/** the text of one top-level service block (two-space indent) */
function service(name: string): string {
  const start = compose.indexOf(`\n  ${name}:\n`);
  expect(start, `service ${name}`).toBeGreaterThan(-1);
  const rest = compose.slice(start + 1);
  const next = rest.slice(3).search(/\n {2}[a-z0-9-]+:\n/);
  return next === -1 ? rest : rest.slice(0, next + 3);
}

describe("finding 10: Keycloak's database role", () => {
  it("keycloak connects as its own role, with a password from the environment and no default", () => {
    const kc = service("keycloak");
    expect(kc).toMatch(/KC_DB_USERNAME: keycloak\n/);
    expect(kc).toMatch(/KC_DB_PASSWORD: \$\{REGULAIT_KC_DB_PASSWORD:-\}\n/);
    expect(kc).not.toMatch(/KC_DB_USERNAME: regulait/);
    expect(kc).not.toContain("REGULAIT_DB_PASSWORD");
    // the entrypoint refuses to start without it
    expect(kc).toContain('[ -z "$$KC_DB_PASSWORD" ]');
  });

  it("the init job creates the keycloak role as owner of the keycloak database only, refusing an empty password", () => {
    const init = service("keycloak-db-init");
    expect(init).toMatch(/KC_DB_ROLE_PASSWORD: \$\{REGULAIT_KC_DB_PASSWORD:-\}\n/);
    expect(init).toContain('[ -z "$$KC_DB_ROLE_PASSWORD" ]');
    expect(init).toContain("CREATE ROLE keycloak LOGIN PASSWORD %L");
    expect(init).toContain("NOSUPERUSER NOCREATEDB NOCREATEROLE");
    expect(init).toContain("CREATE DATABASE keycloak OWNER keycloak");
    expect(init).toContain("ALTER DATABASE keycloak OWNER TO keycloak;");
    // the password never rides a command line
    expect(init).toContain("\\getenv kcpw KC_DB_ROLE_PASSWORD");
    expect(init).not.toMatch(/-v kcpw=/);
    // and the gateway's role is not altered
    expect(init).not.toMatch(/ALTER ROLE regulait/i);
  });
});

describe("finding 2 (realm): brokered emails are not trusted on the upstream's word", () => {
  it("trustEmail is false for every upstream IdP, and each uses the stock first-broker-login flow", () => {
    const aliases = realm.identityProviders.map((p) => p.alias).sort();
    expect(aliases).toEqual(["github", "google", "microsoft"]);
    for (const p of realm.identityProviders) {
      expect(p.trustEmail, p.alias).toBe(false);
      expect(p.firstBrokerLoginFlowAlias, p.alias).toBe("first broker login");
    }
    // the stock flow is Keycloak's own (it confirms an existing account by
    // email or re-authentication) — the import must not replace it
    expect((realm.authenticationFlows ?? []).map((f) => f.alias)).not.toContain("first broker login");
  });

  it("the Google hosted-domain restriction is a deployment setting", () => {
    const google = realm.identityProviders.find((p) => p.alias === "google")!;
    expect(google.config.hostedDomain).toBe("${REGULAIT_KC_GOOGLE_HOSTED_DOMAIN:}");
    const doc = readFileSync(path.join(root, "docs/deployment/SSO_KEYCLOAK.md"), "utf8");
    expect(doc).toContain("REGULAIT_KC_GOOGLE_HOSTED_DOMAIN");
    expect(doc).toContain("REGULAIT_KC_DB_PASSWORD");
  });
});
