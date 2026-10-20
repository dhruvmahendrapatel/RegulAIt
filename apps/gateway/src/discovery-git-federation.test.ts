/**
 * ADR-0195 A5: the deployment's GitHub App key configuration (a deploy-time PEM file, never in the database).
 * Keys are generated at runtime; nothing here is a real credential.
 */
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { configuredGitHubApp, federatedGitToken, GitFederationError, isAcceptableAppKey } from "./discovery-git-federation.js";

const dir = mkdtempSync(path.join(tmpdir(), "a5-app-key-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const write = (name: string, text: string) => {
  const file = path.join(dir, name);
  writeFileSync(file, text, { mode: 0o600 });
  return file;
};

describe("ADR-0195 A5 GitHub App key configuration", () => {
  it("is off when neither variable is set", () => {
    expect(configuredGitHubApp({})).toBeNull();
  });

  it("reads a PKCS#1 (as GitHub issues it) or PKCS#8 RSA key", () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pkcs1 = write("app1.pem", privateKey.export({ type: "pkcs1", format: "pem" }).toString());
    const pkcs8 = write("app8.pem", privateKey.export({ type: "pkcs8", format: "pem" }).toString());
    expect(configuredGitHubApp({ REGULAIT_GITHUB_APP_ID: "42", REGULAIT_GITHUB_APP_PRIVATE_KEY_FILE: pkcs1 })?.appId).toBe("42");
    expect(configuredGitHubApp({ REGULAIT_GITHUB_APP_ID: "43", REGULAIT_GITHUB_APP_PRIVATE_KEY_FILE: pkcs8 })?.privateKey.asymmetricKeyType).toBe("rsa");
  });

  it("sends the App JWT to the configured GitHub API only, https://api.github.com by default", () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = write("api.pem", privateKey.export({ type: "pkcs1", format: "pem" }).toString());
    expect(configuredGitHubApp({ REGULAIT_GITHUB_APP_ID: "42", REGULAIT_GITHUB_APP_PRIVATE_KEY_FILE: pem })?.apiUrl).toBe("https://api.github.com");
    expect(
      configuredGitHubApp({ REGULAIT_GITHUB_APP_ID: "42", REGULAIT_GITHUB_APP_PRIVATE_KEY_FILE: pem, REGULAIT_GITHUB_APP_API_URL: "https://ghe.example.test/api/v3/" })?.apiUrl,
    ).toBe("https://ghe.example.test/api/v3");
    for (const bad of ["http://ghe.example.test", "https://u:p@ghe.example.test", "https://ghe.example.test/?x=1", "not a url"]) {
      expect(() => configuredGitHubApp({ REGULAIT_GITHUB_APP_ID: "42", REGULAIT_GITHUB_APP_PRIVATE_KEY_FILE: pem, REGULAIT_GITHUB_APP_API_URL: bad }), bad).toThrow(GitFederationError);
    }
  });

  it("fails closed on half a configuration, a missing file, a non-RSA or short key, and never echoes the file", () => {
    const ed = write("ed.pem", generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString());
    const junk = write("junk.pem", "not a key synthetic-content-marker");
    for (const env of [
      { REGULAIT_GITHUB_APP_ID: "42" },
      { REGULAIT_GITHUB_APP_PRIVATE_KEY_FILE: junk },
      { REGULAIT_GITHUB_APP_ID: "x42", REGULAIT_GITHUB_APP_PRIVATE_KEY_FILE: junk },
      { REGULAIT_GITHUB_APP_ID: "42", REGULAIT_GITHUB_APP_PRIVATE_KEY_FILE: path.join(dir, "absent.pem") },
      { REGULAIT_GITHUB_APP_ID: "42", REGULAIT_GITHUB_APP_PRIVATE_KEY_FILE: ed },
      { REGULAIT_GITHUB_APP_ID: "42", REGULAIT_GITHUB_APP_PRIVATE_KEY_FILE: junk },
    ]) {
      const err = (() => {
        try {
          configuredGitHubApp(env);
          return null;
        } catch (e) {
          return e as Error;
        }
      })();
      expect(err, JSON.stringify(env)).toBeInstanceOf(GitFederationError);
      expect(err!.message).not.toContain("synthetic-content-marker");
    }
  });

  it("refuses an RSA key shorter than 2048 bits (no weak key is generated: the check is fed the key's details)", () => {
    expect(isAcceptableAppKey({ asymmetricKeyType: "rsa", asymmetricKeyDetails: { modulusLength: 1024 } })).toBe(false);
    expect(isAcceptableAppKey({ asymmetricKeyType: "rsa", asymmetricKeyDetails: { modulusLength: 2047 } })).toBe(false);
    expect(isAcceptableAppKey({ asymmetricKeyType: "rsa", asymmetricKeyDetails: {} })).toBe(false);
    expect(isAcceptableAppKey({ asymmetricKeyType: "ec", asymmetricKeyDetails: { namedCurve: "prime256v1" } })).toBe(false);
    expect(isAcceptableAppKey({ asymmetricKeyType: "rsa", asymmetricKeyDetails: { modulusLength: 2048 } })).toBe(true);
  });

  it("refuses a kind with no inbound federation before any call", async () => {
    let calls = 0;
    const ctx = {
      source: { kind: "repo_gitlab", target: {} },
      credential: { publicConfig: {} },
      fetch: (async () => {
        calls++;
        return new Response("{}");
      }) as unknown as typeof fetch,
      throttle: async () => {},
      registerSecret: () => {},
      signal: new AbortController().signal,
    };
    await expect(federatedGitToken(ctx)).rejects.toThrow(/GitLab accepts no external OIDC token/);
    expect(calls).toBe(0);
  });
});
