/**
 * X19-S01 — every PM adapter that relays upstream error text scrubs the
 * credential it holds, in every form a reflecting upstream or proxy could echo
 * it (raw, JSON-escaped, URL-encoded, form-encoded, and a Basic header's
 * base64). Synthetic credentials only: `"`, `\`, `+`, `/`, `=` and a space
 * make each form differ.
 */
import { describe, expect, it } from "vitest";
import {
  AsanaProvider,
  AzureDevOpsProvider,
  GenericWebhookProvider,
  JiraProvider,
  LinearProvider,
  MondayProvider,
  PmProviderError,
  type PmProvider,
} from "./index.js";

const SYN = 'tok"en\\with+special/=chars y';

type Fetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) =>
  Promise<{ status: number; json(): Promise<unknown>; text(): Promise<string> }>;

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

/** an upstream answering `status` and echoing the credential it received (or,
 * for the HMAC-signed webhook, the shared secret it knows) in several encodings */
function reflecting(status: number, shape: (echo: string, header: string) => unknown, known?: string): Fetch {
  return async (_url, init) => {
    const header = String(init?.headers?.authorization ?? "");
    const cred = header.replace(/^(Bearer|Basic) /, "");
    const decoded = known ?? (header.startsWith("Basic ") ? Buffer.from(cred, "base64").toString("utf8") : cred);
    const echo = `${decoded} uri=${encodeURIComponent(decoded)} ${new URLSearchParams([["token", decoded]]).toString()}`;
    const text = JSON.stringify(shape(echo, header));
    return { status, text: async () => text, json: async () => JSON.parse(text) as unknown };
  };
}

async function failure(p: Promise<unknown>): Promise<PmProviderError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(PmProviderError);
    return err as PmProviderError;
  }
  throw new Error("expected a PmProviderError");
}

const httpError = (echo: string, header: string) => ({ message: `bad credential ${echo}`, header });
const cases: Array<{ name: string; token: string; status: number | undefined; make: () => PmProvider }> = [
  { name: "azure_devops", token: SYN, status: 401, make: () => new AzureDevOpsProvider({ token: SYN, baseUrl: "https://pm.example.test/org", fetchImpl: reflecting(401, httpError) }) },
  { name: "jira", token: `ana@acme.test:${SYN}`, status: 401, make: () => new JiraProvider({ token: `ana@acme.test:${SYN}`, baseUrl: "https://pm.example.test", fetchImpl: reflecting(401, httpError) }) },
  { name: "linear (HTTP error)", token: SYN, status: 401, make: () => new LinearProvider({ token: SYN, baseUrl: "https://pm.example.test", fetchImpl: reflecting(401, httpError) }) },
  { name: "linear (GraphQL errors[])", token: SYN, status: undefined, make: () => new LinearProvider({ token: SYN, baseUrl: "https://pm.example.test", fetchImpl: reflecting(200, (e) => ({ errors: [{ message: `bad key ${e}` }] })) }) },
  { name: "asana", token: SYN, status: 401, make: () => new AsanaProvider({ token: SYN, baseUrl: "https://pm.example.test", fetchImpl: reflecting(401, httpError) }) },
  { name: "monday (HTTP error)", token: SYN, status: 401, make: () => new MondayProvider({ token: SYN, baseUrl: "https://pm.example.test", fetchImpl: reflecting(401, httpError) }) },
  { name: "monday (GraphQL errors[])", token: SYN, status: undefined, make: () => new MondayProvider({ token: SYN, baseUrl: "https://pm.example.test", fetchImpl: reflecting(200, (e) => ({ errors: [{ message: `bad token ${e}` }] })) }) },
  { name: "monday (error_message)", token: SYN, status: undefined, make: () => new MondayProvider({ token: SYN, baseUrl: "https://pm.example.test", fetchImpl: reflecting(200, (e) => ({ error_message: `bad token ${e}` })) }) },
  { name: "generic_webhook", token: SYN, status: 401, make: () => new GenericWebhookProvider({ token: SYN, baseUrl: "https://pm.example.test/hook", fetchImpl: reflecting(401, httpError, SYN) }) },
];

describe("X19-S01: PM adapters scrub a reflected credential from the error they relay", () => {
  for (const c of cases) {
    it(`${c.name}: no form of the credential (nor its Basic base64) survives; the status is kept`, async () => {
      const err = await failure(c.make().getWorkItem("PROJ", "PROJ-1"));
      expect(err.status).toBe(c.status);
      expect(err.message).toContain("[redacted]");
      expect(leaks(err.message, SYN), err.message).toEqual([]);
      expect(err.message).not.toContain(Buffer.from(c.token).toString("base64"));
      expect(err.message).not.toContain(Buffer.from(`:${c.token}`).toString("base64"));
    });
  }
});
