/**
 * ADR-0189 B9 (R51): the browser's hints repeat the gateway's SPDX field rules
 * exactly (`@regulait/shared` normaliseSpdxDeclaration), and no message ever
 * carries the value it refused.
 */
import { describe, expect, it } from "vitest";
import { ApiError } from "../../../api/client";
import {
  RULE_SENTENCE,
  SPDX_SUBJECT_PROPERTIES,
  checkSpdxDatasetType,
  checkSpdxDownloadLocation,
  checkSpdxOriginator,
  checkSpdxPackageVersion,
  checkSpdxTime,
  checkSpdxValue,
  isMandatory,
  refusalSentence,
  spdxFieldPath,
  undeclaredSummary,
  utcSeconds,
  valueText,
} from "./spdxFields";

describe("time: UTC, whole seconds", () => {
  it.each(["2026-01-31T09:30:00Z", "2024-02-29T23:59:59Z"])("accepts %s unchanged", (t) => {
    expect(checkSpdxTime(t)).toEqual({ ok: true, value: t });
  });
  it.each([
    "2026-01-31T09:30:00.500Z", // fractional seconds
    "2026-01-31T09:30Z", // no seconds
    "2026-01-31T09:30:00+01:00", // not UTC: the UI asks for the stored form only
    "2026-01-31 09:30:00Z",
    "2026-02-30T00:00:00Z", // not a real instant
    "2025-02-29T00:00:00Z",
    "2026-01-31T24:00:00Z",
    "2026-01-31",
    "",
  ])("refuses %j", (t) => {
    expect(checkSpdxTime(t)).toMatchObject({ ok: false, rule: "spdx_time_invalid" });
  });
});

describe("download location: an https origin only", () => {
  it.each(["https://models.example.com", "https://models.example.com:8443", "https://10.0.0.1"])("accepts %s", (u) => {
    expect(checkSpdxDownloadLocation(u)).toEqual({ ok: true, value: u });
  });
  it.each([
    ["https://models.example.com/", "download_location_not_origin"],
    ["https://models.example.com/weights.bin", "download_location_not_origin"],
    ["https://models.example.com?token=abc", "download_location_not_origin"],
    ["https://models.example.com#frag", "download_location_not_origin"],
    ["https://Models.Example.com", "download_location_not_origin"],
    ["https://models.example.com:443", "download_location_not_origin"],
    ["https://bücher.example", "download_location_not_origin"],
    ["https://user:pw@models.example.com", "download_location_credentials"],
    ["https://user@models.example.com", "download_location_credentials"],
    ["http://models.example.com", "download_location_not_https"],
    ["ftp://models.example.com", "download_location_not_https"],
    ["models.example.com", "download_location_invalid"],
    ["", "download_location_invalid"],
    [`https://${"a".repeat(2050)}.com`, "download_location_invalid"],
  ])("refuses %s as %s", (u, rule) => {
    expect(checkSpdxDownloadLocation(u)).toMatchObject({ ok: false, rule });
  });
});

describe("package version and originator: bounded plain text", () => {
  it("accepts a version and an originator", () => {
    expect(checkSpdxPackageVersion("2025-06-01.v3")).toEqual({ ok: true, value: "2025-06-01.v3" });
    expect(checkSpdxOriginator("Example Research Lab")).toEqual({ ok: true, value: "Example Research Lab" });
  });
  it.each(["1.0 beta", "", " 1.0", "v@1", "https://x", "a://b", "x".repeat(257), "é1"])("refuses version %j", (t) => {
    expect(checkSpdxPackageVersion(t)).toMatchObject({ ok: false, rule: "package_version_invalid" });
  });
  it.each(["", " Lab", "Lab ", "lab@example.com", "mailto:x", "see https://x", "a\u0007b", "x".repeat(257)])("refuses originator %j", (t) => {
    expect(checkSpdxOriginator(t)).toMatchObject({ ok: false, rule: "originated_by_invalid" });
  });
});

describe("dataset type", () => {
  it("accepts a set and records it sorted", () => {
    expect(checkSpdxDatasetType(["text", "image"])).toEqual({ ok: true, value: ["image", "text"] });
  });
  it.each([[[]], [["text", "text"]], [["prose"]]])("refuses %j", (t) => {
    expect(checkSpdxDatasetType(t)).toMatchObject({ ok: false, rule: "dataset_type_invalid" });
  });
});

describe("which property each record declares", () => {
  it("matches R51", () => {
    expect(SPDX_SUBJECT_PROPERTIES.model_card).toEqual(["releaseTime", "downloadLocation", "packageVersion"]);
    expect(SPDX_SUBJECT_PROPERTIES.training_dataset).toEqual(["builtTime", "originatedBy", "releaseTime", "downloadLocation", "datasetType"]);
    expect(SPDX_SUBJECT_PROPERTIES.eval_dataset).toEqual(SPDX_SUBJECT_PROPERTIES.training_dataset);
  });
  it("refuses a property the record does not declare", () => {
    expect(checkSpdxValue("model_card", "builtTime", "2026-01-31T09:30:00Z")).toMatchObject({ ok: false, rule: "spdx_property_not_allowed" });
  });
  it("a dataset type is optional (noAssertion); a package version is optional only with a pinned version", () => {
    expect(isMandatory("eval_dataset", "datasetType")).toBe(false);
    expect(isMandatory("model_card", "packageVersion")).toBe(true);
    expect(isMandatory("model_card", "packageVersion", "gpt-x-2025-06-01")).toBe(false);
    expect(undeclaredSummary("training_dataset", ["builtTime", "datasetType"])).toEqual({ blocking: ["builtTime"], optional: ["datasetType"] });
  });
  it("builds the gateway's paths", () => {
    expect(spdxFieldPath("eval_dataset", "11111111-0000-4000-8000-000000000001", "releaseTime")).toBe(
      "/v1/ai-bom/spdx-fields/eval_dataset/11111111-0000-4000-8000-000000000001/releaseTime",
    );
  });
});

describe("display", () => {
  it("shows a withdrawal in words and a time in UTC whole seconds", () => {
    expect(valueText({ withdrawn: true, value: null })).toBe("withdrawn (no value)");
    expect(valueText({ withdrawn: false, value: ["image", "text"] })).toBe("image, text");
    expect(utcSeconds("2026-10-10T08:15:30.123Z")).toBe("2026-10-10T08:15:30Z");
  });
});

describe("refusals never carry the value", () => {
  const SECRET = "https://user:hunter2@models.example.com/path?token=sk-live-123";
  it("a client-side refusal is a fixed sentence", () => {
    for (const p of ["releaseTime", "downloadLocation", "packageVersion", "originatedBy"] as const) {
      const c = checkSpdxValue(p === "originatedBy" ? "eval_dataset" : "model_card", p, SECRET);
      expect(c.ok).toBe(false);
      expect(c.message).not.toContain("hunter2");
      expect(c.message).not.toContain("sk-live");
    }
    for (const sentence of Object.values(RULE_SENTENCE)) expect(sentence).not.toContain("hunter2");
  });
  it("a gateway refusal names the property and the rule", () => {
    const e = new ApiError(422, { error: "invalid_spdx_declaration", rule: "credential_shaped", property: "originatedBy", detail: "ai-bom spdx field originatedBy: holds credential-shaped material (refused, never redacted)" });
    const r = refusalSentence("originatedBy", e);
    expect(r).toEqual({ code: "invalid_spdx_declaration", rule: "credential_shaped", text: "Originated by holds credential-shaped material. It is refused, never redacted. Nothing was recorded." });
  });
  it("route refusals have their own sentences", () => {
    expect(refusalSentence("releaseTime", new ApiError(409, { error: "spdx_field_not_declared" })).text).toBe(
      "Release time: There is no current value to withdraw; it may have been withdrawn already.",
    );
    expect(refusalSentence("releaseTime", new ApiError(404, { error: "spdx_subject_not_found" })).text).toContain("no longer exists");
    expect(refusalSentence("releaseTime", new Error("network")).text).toContain("Nothing is known to have been recorded");
  });
});
