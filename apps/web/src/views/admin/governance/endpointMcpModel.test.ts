import { describe, expect, it } from "vitest";
import { endpointMcpUrl, isLinkable, launches, linkIdentity, linkScope, NO_FILTERS } from "./endpointMcpModel";

describe("endpoint MCP inventory model", () => {
  it("builds a bounded page URL with only the filters set and the keyset cursor", () => {
    expect(endpointMcpUrl(NO_FILTERS, null)).toBe("/v1/discovery/endpoint-mcp-servers?limit=25");
    const id = "11111111-1111-4111-8111-111111111111";
    expect(endpointMcpUrl({ status: "unregistered", risky: true, secrets: true, deviceId: id }, id)).toBe(
      `/v1/discovery/endpoint-mcp-servers?limit=25&status=unregistered&risky=true&secrets=true&deviceId=${id}&cursor=${id}`,
    );
  });

  it("says what an entry launches: package with version, then host, then command", () => {
    expect(launches({ package: "acme-mcp", packageVersion: "1.2.0", host: null, command: "npx" })).toBe("acme-mcp@1.2.0");
    expect(launches({ package: "acme-mcp", packageVersion: null, host: null, command: "npx" })).toBe("acme-mcp");
    expect(launches({ package: null, packageVersion: null, host: "mcp.example.test", command: null })).toBe("mcp.example.test");
    expect(launches({ package: null, packageVersion: null, host: null, command: null })).toBe("—");
  });

  it("offers a link only for an identity the gateway accepts", () => {
    expect(linkIdentity({ identity: { kind: "unknown", value: "x" } })).toBeNull();
    expect(linkIdentity({ identity: { kind: "host", value: null } })).toBeNull();
    expect(linkIdentity({ identity: { kind: "package", value: "acme-mcp" } })).toEqual({ identityKind: "package", identity: "acme-mcp" });
  });

  it("warns that a command link approves everything that command launches", () => {
    expect(linkScope("command", "docker")).toMatch(/every server any device launches with 'docker' is approved/);
    expect(linkScope("host", "mcp.example.test")).not.toMatch(/every server any device launches/);
  });

  it("offers only admitted servers as link targets: an allow-list of clean and cleared", () => {
    for (const ok of ["clean", "cleared"]) expect(isLinkable({ admissionState: ok })).toBe(true);
    for (const no of ["unscanned", "held", "grandfathered", "refused", "admitted", ""]) expect(isLinkable({ admissionState: no })).toBe(false);
    expect(isLinkable({})).toBe(false);
  });
});
