/**
 * ADR-0195 lane A6 (review of #419, F2): what a matched SD3 sighting carries as evidence. An env-variable or CLI
 * name travels as its presence signature id, never as an artifact value; any other sighting stays an artifact.
 */
import { describe, expect, it } from "vitest";
import type { EndpointArtifactSighting } from "@regulait/shared";
import { sightingEvidence } from "./endpoint-import-routes.js";

const sighting = (over: Partial<EndpointArtifactSighting>): EndpointArtifactSighting => ({
  device: "tmp_dev",
  user: null,
  os: "linux",
  ecosystem: null,
  kind: "assistant_config",
  value: "env.openai.api-key",
  provider: "openai",
  count: 1,
  observedAt: null,
  ...over,
});

describe("sightingEvidence", () => {
  it("sends a presence sighting as presence, never as an artifact", () => {
    expect(sightingEvidence(sighting({ presenceSignatureId: "env.openai.api-key" }))).toEqual({ presence: ["env.openai.api-key"] });
  });

  it("sends any other sighting as its artifact", () => {
    expect(sightingEvidence(sighting({ kind: "desktop_app", value: "com.anthropic.claudefordesktop", provider: "anthropic" }))).toEqual({
      artifact: { kind: "desktop_app", value: "com.anthropic.claudefordesktop" },
    });
  });
});
