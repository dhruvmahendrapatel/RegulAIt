/**
 * X19-S01 — the shared scrub removes a known credential in every
 * representation it can take in upstream error material. Synthetic secrets
 * only: this one carries `"`, `\`, `+`, `/`, `=` and a space, so its raw,
 * JSON-escaped, URL-encoded and form-encoded forms all differ.
 */
import { describe, expect, it } from "vitest";
import { scrubSecrets, secretRepresentations } from "./scrub-secrets.js";

const SYN_SECRET = 'syn"th\\etic+secret/=value x';

function leakedForms(text: string, secret: string): string[] {
  const forms = new Set([
    secret,
    JSON.stringify(secret).slice(1, -1),
    encodeURIComponent(secret),
    encodeURIComponent(secret).replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase()),
    new URLSearchParams([["k", secret]]).toString().slice(2),
  ]);
  return [...forms].filter((f) => text.includes(f));
}
function expectNoSecret(text: string, secret: string) {
  expect(leakedForms(text, secret), text).toEqual([]);
  expect(text).not.toMatch(/etic/i);
}
function jsonStrings(v: unknown): string[] {
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.flatMap(jsonStrings);
  if (v && typeof v === "object") return Object.entries(v).flatMap(([k, x]) => [k, ...jsonStrings(x)]);
  return [];
}

describe("X19-S01: the shared scrub covers every representation of a known secret", () => {
  it("secretRepresentations names raw, JSON-escaped, URL-encoded and form-encoded forms", () => {
    const forms = secretRepresentations(SYN_SECRET);
    expect(forms).toContain(SYN_SECRET);
    expect(forms).toContain(JSON.stringify(SYN_SECRET).slice(1, -1));
    expect(forms).toContain(encodeURIComponent(SYN_SECRET));
    expect(forms).toContain(new URLSearchParams([["k", SYN_SECRET]]).toString().slice(2));
  });

  it("removes each form from flat text, a JSON body and a \\u-escaped JSON body", () => {
    const escapedEveryChar = [...SYN_SECRET].map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");
    for (const text of [
      `raw ${SYN_SECRET} json ${JSON.stringify(SYN_SECRET)} uri ${encodeURIComponent(SYN_SECRET)} ` +
        `form ${new URLSearchParams([["client_secret", SYN_SECRET]]).toString()} ` +
        `lower ${encodeURIComponent(SYN_SECRET).toLowerCase()}`,
      JSON.stringify({ error: { code: "E", message: `echo ${SYN_SECRET}` }, [SYN_SECRET]: 1 }),
      `{"error":{"code":"E","message":"echo ${escapedEveryChar}"}}`,
    ]) {
      const out = scrubSecrets(text, [SYN_SECRET]);
      expectNoSecret(out, SYN_SECRET);
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(out);
      } catch {
        /* the flat text is not JSON */
      }
      for (const str of jsonStrings(parsed)) expect(str).not.toContain(SYN_SECRET);
    }
  });
});

describe("X19-S01: the scrub leaves ordinary text alone and keeps its guarantees", () => {
  it("returns text with no secret unchanged, ignores secrets shorter than 4, still strips bearer/JWT/client_secret=", () => {
    expect(scrubSecrets("HTTP 403: Forbidden", [SYN_SECRET])).toBe("HTTP 403: Forbidden");
    expect(scrubSecrets("abc is fine", ["abc"])).toBe("abc is fine");
    const jwt = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl";
    const out = scrubSecrets(`Bearer abc.def ${jwt} client_secret=zzz`, []);
    expect(out).not.toContain("abc.def");
    expect(out).not.toContain(jwt);
    expect(out).not.toContain("zzz");
  });
  it("withholds JSON nested deeper than it walks rather than relaying it unscrubbed", () => {
    let deep: unknown = SYN_SECRET;
    for (let i = 0; i < 100; i++) deep = [deep];
    const out = scrubSecrets(JSON.stringify(deep), [SYN_SECRET]);
    expectNoSecret(out, SYN_SECRET);
    expect(out).toContain("nested too deep");
  });
});
