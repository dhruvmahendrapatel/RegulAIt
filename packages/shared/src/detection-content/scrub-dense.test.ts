import { expect, it } from "vitest";
import { createHash } from "node:crypto";
import { scrubAuditText } from "../audit-scrub.js";
import { CREDENTIAL_MATERIAL_RULES } from "../guardrails.js";

const cases = [
  { name: "Slack", credential: `xoxb-${"a".repeat(12)}`, input: `xoxb-${"a".repeat(12)}.`.repeat(22_223).slice(0, 400_000), separator: ".", markers: 22_222 },
  { name: "Google", credential: "AIza-".repeat(8).slice(0, 39), input: "AIza-".repeat(80_000), separator: "-", markers: 10_000 },
];

it.each(cases)("B4I-02: $name dense synthetic credentials retain the 400k/100ms scrub budget", ({ credential, input, separator, markers }) => {
  let best = Infinity;
  let output = "";
  for (let i = 0; i < 3; i++) {
    const start = performance.now();
    output = scrubAuditText(input);
    best = Math.min(best, performance.now() - start);
  }
  expect(output).not.toContain(credential);
  expect(output.match(/\[redacted:/g)).toHaveLength(markers);
  expect(output.split(`]${separator}`)).toHaveLength(markers + 1);
  expect(best, `400k dense scrub took ${best.toFixed(1)} ms`).toBeLessThan(100);
});

it("native suffix scanning preserves EOF keys and original left/right boundaries", () => {
  const token = `AIza${"A".repeat(35)}`;
  for (const prefix of ["", "prefix-", "-".repeat(400_000)]) {
    const output = scrubAuditText(prefix + token);
    expect(output).toBe(`${prefix}[redacted:google_api_key+pipelock.secrets.google_api_key:39:${createHash("sha256").update(token).digest("hex").slice(0, 12)}]`);
  }
  for (const input of [`word${token}`, `${token}-trailing`]) {
    const output = scrubAuditText(input);
    expect(output).not.toContain(token);
    expect(output).toContain("[redacted:pipelock.secrets.google_api_key:");
    expect(output).not.toContain("[redacted:google_api_key+");
  }
});

it("a changed native rule falls back to scanning the complete input", () => {
  const rule = CREDENTIAL_MATERIAL_RULES.find(rule => rule.id === "dlp.secret.google_api_key")!;
  const original = Object.getOwnPropertyDescriptor(rule, "re")!;
  try {
    // A future longer key would be missed by a stale 39-character suffix.
    Object.defineProperty(rule, "re", { ...original, value: /\bAIza[\w-]{36}(?![\w-])/g });
    const token = `AIza${"A".repeat(36)}`;
    expect(scrubAuditText(`prefix-${token}`)).not.toContain(token);
  } finally { Object.defineProperty(rule, "re", original); }
});

it("bounded scrub caches preserve distinct fingerprints and unseen fragments after saturation", () => {
  const credentials = Array.from({ length: 300 }, (_, i) => `fw_${i.toString(36).padStart(22, "A")}`);
  const input = credentials.map((credential, i) => `${credential} separator-${i} `).join("");
  const output = scrubAuditText(input);
  for (const [i, credential] of credentials.entries()) {
    expect(output).not.toContain(credential);
    expect(output).toContain(createHash("sha256").update(credential).digest("hex").slice(0, 12));
    expect(output).toContain(` separator-${i} `);
  }
  expect(scrubAuditText(output)).toBe(output);
  // A new call must inspect text independently of the previous cache contents.
  expect(scrubAuditText(`${input}password=new-synthetic-secret`)).not.toContain("new-synthetic-secret");
});
