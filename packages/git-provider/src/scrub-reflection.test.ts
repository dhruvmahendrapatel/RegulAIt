/**
 * X19-S01 — every git adapter that relays upstream error text scrubs the
 * credential it put on the wire, in every form a reflecting upstream or proxy
 * could echo it (raw, JSON-escaped, URL-encoded, form-encoded, and the Basic
 * header's base64). Synthetic credentials only: `"`, `\`, `+`, `/`, `=` and a
 * space make each form differ.
 */
import { describe, expect, it } from "vitest";
import { GitHubProvider } from "./index.js";
import { GitLabProvider } from "./gitlab.js";
import { BitbucketProvider } from "./bitbucket.js";
import { AzureDevOpsProvider } from "./azure-devops.js";
import { GitProviderError, type FetchLike, type GitProvider } from "./types.js";

const SYN = 'tok"en\\with+special/=chars y';

function leaks(text: string, secret: string): string[] {
  const forms = new Set([
    secret,
    JSON.stringify(secret).slice(1, -1),
    encodeURIComponent(secret),
    encodeURIComponent(secret).toLowerCase(),
    new URLSearchParams([["k", secret]]).toString().slice(2),
  ]);
  return [...forms].filter((f) => text.includes(f));
}

/** an upstream that answers 403 echoing whatever credential it received, in several encodings */
function reflecting(): FetchLike {
  return async (_url, init) => {
    const h = init?.headers ?? {};
    const header = String(h.authorization ?? h["private-token"] ?? "");
    const cred = header.replace(/^(Bearer|Basic) /, "");
    const decoded = header.startsWith("Basic ") ? Buffer.from(cred, "base64").toString("utf8") : cred;
    const text = JSON.stringify({
      message: `bad credential ${decoded}`,
      header,
      uri: encodeURIComponent(decoded),
      form: new URLSearchParams([["token", decoded]]).toString(),
    });
    return { status: 403, text: async () => text, json: async () => JSON.parse(text) as unknown };
  };
}

async function failure(p: Promise<unknown>): Promise<GitProviderError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(GitProviderError);
    return err as GitProviderError;
  }
  throw new Error("expected a GitProviderError");
}

const cases: Array<{ name: string; token: string; secret: string; make: (f: FetchLike) => GitProvider; repo: string }> = [
  { name: "github", token: SYN, secret: SYN, repo: "o/r", make: (f) => new GitHubProvider({ token: SYN, baseUrl: "https://git.example.test", fetchImpl: f }) },
  { name: "gitlab", token: SYN, secret: SYN, repo: "o/r", make: (f) => new GitLabProvider({ token: SYN, baseUrl: "https://git.example.test", fetchImpl: f }) },
  { name: "bitbucket (Basic)", token: `ana:${SYN}`, secret: SYN, repo: "w/r", make: (f) => new BitbucketProvider({ token: `ana:${SYN}`, baseUrl: "https://git.example.test", fetchImpl: f }) },
  { name: "bitbucket (Bearer)", token: SYN, secret: SYN, repo: "w/r", make: (f) => new BitbucketProvider({ token: SYN, baseUrl: "https://git.example.test", fetchImpl: f }) },
  { name: "azure_devops", token: SYN, secret: SYN, repo: "p/r", make: (f) => new AzureDevOpsProvider({ token: SYN, baseUrl: "https://git.example.test/org", fetchImpl: f }) },
];

describe("X19-S01: git adapters scrub a reflected credential from the error they relay", () => {
  for (const c of cases) {
    it(`${c.name}: no form of the credential (nor its Basic base64) survives; the status is kept`, async () => {
      const err = await failure(c.make(reflecting()).getPullRequest(c.repo, "1"));
      expect(err.status).toBe(403);
      expect(err.message).toContain("[redacted]");
      expect(leaks(err.message, c.secret), err.message).toEqual([]);
      expect(err.message).not.toContain(Buffer.from(c.token).toString("base64"));
      expect(err.message).not.toContain(Buffer.from(`:${c.token}`).toString("base64"));
    });
  }
});
