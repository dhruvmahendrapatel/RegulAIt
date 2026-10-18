/**
 * N4 — `dlp.secret.huggingface_token` (gitleaks `huggingface-access-token` and
 * `huggingface-organization-api-token`) is part of the one shared credential
 * ruleset, so every consumer of it removes a Hugging Face token: audit prose
 * (`scrubAuditText`, which the ADR-0102 prose scrub and the engine detection
 * scrub ARE), error details (`scrubAuditDetail`) and audit rows carrying log
 * lines (`scrubAuditRow`). Unrelated text is byte-identical.
 *
 * The tokens are assembled at runtime from a short alphabet, so this file holds
 * no secret-shaped literal for gitleaks to flag.
 */
import { describe, expect, it } from "vitest";
import { CREDENTIAL_MATERIAL_RULES, semanticDlpDetector } from "./guardrails.js";
import { scrubAuditDetail, scrubAuditRow, scrubAuditText } from "./audit-scrub.js";

const letters = (seed: number, n: number): string => {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let s = seed >>> 0;
  let out = "";
  for (let i = 0; i < n; i++) {
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    out += alphabet[s % alphabet.length];
  }
  return out;
};
const ACCESS = ["hf", letters(0x4e04_0001, 34)].join("_");
const ORG = ["api", "org", letters(0x4e04_0002, 34)].join("_");
const MARKER = /\[redacted:(?:[a-z0-9_.]+\+)*huggingface_token(?:\+[a-z0-9_.]+)*:\d+:[0-9a-f]{12}\]/;

describe("N4: a Hugging Face token is credential material on every shared path", () => {
  it("is one rule in the shared ruleset the audit scrub consumes", () => {
    expect(CREDENTIAL_MATERIAL_RULES.map((r) => r.id)).toContain("dlp.secret.huggingface_token");
    expect(semanticDlpDetector.ruleIds).toContain("dlp.secret.huggingface_token");
  });

  for (const [kind, token] of [["access", ACCESS], ["organization", ORG]] as const) {
    it(`audit prose: the ${kind} token is replaced by a marker, the prose around it kept`, () => {
      const out = scrubAuditText(`rotated after ${token} was pasted in the ticket`);
      expect(out).not.toContain(token);
      expect(out).toMatch(new RegExp(`^rotated after ${MARKER.source} was pasted in the ticket$`));
      expect(out).toContain(`:${token.length}:`);
    });

    it(`errors: the ${kind} token is removed from an error detail at any depth`, () => {
      const detail = {
        error: { code: "upstream_401", message: `401 from the hub: token ${token} is invalid` },
        attempts: [{ stderr: `Authorization: Bearer ${token}` }],
      };
      const out = scrubAuditDetail(detail) as typeof detail;
      expect(JSON.stringify(out)).not.toContain(token);
      expect(out.error.code).toBe("upstream_401");
      expect(out.error.message).toMatch(/^401 from the hub: token \[redacted:/);
    });

    it(`logs: the ${kind} token is removed from a multi-line log in an audit row`, () => {
      const log = `INFO pulling weights\nDEBUG HF_TOKEN=${token}\nINFO done`;
      const row = scrubAuditRow({ reason: log, detail: { log } });
      expect(String(row.reason)).not.toContain(token);
      expect(JSON.stringify(row.detail)).not.toContain(token);
      expect(String(row.reason).startsWith("INFO pulling weights\n")).toBe(true);
      expect(String(row.reason).endsWith("\nINFO done")).toBe(true);
    });
  }

  it("unrelated strings are untouched", () => {
    for (const text of [
      "set hf_transfer=1 before the download",
      "the api_org_settings page lists members",
      `hf_${letters(7, 33)} is one character short`,
      "hf_hub_download(repo_id, filename) returned a path",
      "huggingface.co/models is a public listing",
    ]) {
      expect(scrubAuditText(text), text).toBe(text);
      const detail = { message: text };
      expect(scrubAuditDetail(detail), text).toBe(detail);
    }
  });
});
