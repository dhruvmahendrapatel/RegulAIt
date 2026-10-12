import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  IDENTITY_ASSERTION_HEADER,
  IDENTITY_ASSERTION_TYP,
  IDENTITY_PROPAGATION_OPTIONS,
  VERIFY_EXAMPLE,
  canonicalAudience,
  identityPropagationOf,
} from "./mcpIdentityModel";

const repo = (rel: string) => readFileSync(new URL(`../../../../../../${rel}`, import.meta.url), "utf8");

describe("ADR-0188 S8 — the outbound identity screen model", () => {
  it("shows the doc's verification example byte for byte (the gateway suite runs that block against a live JWKS)", () => {
    const doc = repo("docs/api/MCP_IDENTITY_ASSERTION.md");
    const block = doc.slice(doc.indexOf("<!-- verify-example:start -->"), doc.indexOf("<!-- verify-example:end -->"));
    const code = block.slice(block.indexOf("```js\n") + "```js\n".length, block.lastIndexOf("```"));
    expect(code.length).toBeGreaterThan(100);
    expect(VERIFY_EXAMPLE).toBe(code);
  });

  it("restates the gateway's header, typ and audience rule exactly", () => {
    const shared = repo("packages/shared/src/identity/mcp-identity-assertion.ts");
    expect(shared).toContain(`IDENTITY_ASSERTION_HEADER = "${IDENTITY_ASSERTION_HEADER}"`);
    expect(shared).toContain(`IDENTITY_ASSERTION_TYP = "${IDENTITY_ASSERTION_TYP}"`);
    expect(canonicalAudience("https://MCP.Example.com:443/mcp?key=s3cret#x")).toBe("https://mcp.example.com/mcp");
    expect(canonicalAudience("https://user:pw@mcp.example.com/a/b")).toBe("https://mcp.example.com/a/b");
    expect(canonicalAudience("stdio:files")).toBeNull();
  });

  it("defaults to none (the strict value) and offers it first", () => {
    expect(identityPropagationOf({})).toBe("none");
    expect(identityPropagationOf({ identityPropagation: null })).toBe("none");
    expect(identityPropagationOf({ identityPropagation: "signed_assertion" })).toBe("signed_assertion");
    expect(IDENTITY_PROPAGATION_OPTIONS[0]!.value).toBe("none");
  });
});
