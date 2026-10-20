import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ApiError } from "../../../../api/client";
import {
  adminFieldRaises,
  parsePersonStdioRelaxations,
  parseProjectSensitivities,
  PERSON_STDIO_SCOPES,
  projectSensitivityBody,
  relaxationFor,
  SENSITIVITIES,
  SUBJECT_REFUSALS,
  subjectRefusal,
} from "./isolationModel";

const relaxation = (over: Record<string, unknown> = {}) => ({
  id: "r1",
  kind: "person_stdio_l2",
  subjectKind: "interactive_person",
  scopeKind: "mcp_server",
  scopeId: "s1",
  scopeName: "files",
  from: "microvm",
  to: "user_space_kernel",
  createdByUserId: "u1",
  createdAt: "2026-10-17T10:00:00.000Z",
  ...over,
});
const envelope = (relaxations: unknown[], over: Record<string, unknown> = {}) => ({ relaxations, default: "microvm", relaxedTo: "user_space_kernel", ...over });

const project = (over: Record<string, unknown> = {}) => ({
  projectId: "p1",
  name: "Claims",
  useCaseCount: 1,
  useCaseSensitivity: "internal",
  adminSensitivity: null,
  effectiveSensitivity: "internal",
  personStdioRelaxationId: null,
  ...over,
});

describe("parity with the shared contract (owner decisions C and D)", () => {
  it("scopes and sensitivities match @regulait/shared", async () => {
    // runtime-only import: the SPA does not depend on @regulait/shared
    const sharedPath = new URL("../../../../../../../packages/shared/src/isolation/index.ts", import.meta.url).pathname;
    const shared = (await import(/* @vite-ignore */ sharedPath)) as { PERSON_STDIO_RELAXATION_SCOPES: readonly string[]; PLACEMENT_SENSITIVITIES: readonly string[] };
    expect([...PERSON_STDIO_SCOPES]).toEqual([...shared.PERSON_STDIO_RELAXATION_SCOPES]);
    expect([...SENSITIVITIES]).toEqual([...shared.PLACEMENT_SENSITIVITIES]);
  });

  it("names the gateway's own refusal codes, and nothing it does not send", () => {
    const routes = readFileSync(new URL("../../../../../../gateway/src/isolation-subject-routes.ts", import.meta.url), "utf8");
    const stepUp = readFileSync(new URL("../../../../../../gateway/src/step-up.ts", import.meta.url), "utf8");
    expect(Object.keys(SUBJECT_REFUSALS).filter((code) => !(routes + stepUp).includes(`error: "${code}"`))).toEqual([]);
    expect(subjectRefusal(new ApiError(409, { error: "not_a_stdio_server" }))).toMatch(/stdio/);
    expect(subjectRefusal(new ApiError(500, { error: "internal" }))).toBeNull();
  });
});

describe("person's own stdio call relaxations", () => {
  it("reads the active rows; a scope with none reads null", () => {
    const list = parsePersonStdioRelaxations(envelope([relaxation(), relaxation({ id: "r2", scopeKind: "project", scopeId: "p1", scopeName: null })]));
    expect(list).toHaveLength(2);
    expect(relaxationFor(list, "mcp_server", "s1")?.id).toBe("r1");
    expect(relaxationFor(list, "project", "p1")?.id).toBe("r2");
    expect(relaxationFor(list, "mcp_server", "other")).toBeNull();
    expect(relaxationFor(parsePersonStdioRelaxations(envelope([])), "mcp_server", "s1")).toBeNull();
  });

  it.each([
    ["no envelope", null],
    ["a list", []],
    ["another default", envelope([], { default: "user_space_kernel" })],
    ["another relaxed class", envelope([], { relaxedTo: "hardened_container" })],
    ["an org scope", envelope([relaxation({ scopeKind: "org" })])],
    ["a relaxation to L1", envelope([relaxation({ to: "hardened_container" })])],
    ["no id", envelope([relaxation({ id: "" })])],
    ["no time", envelope([relaxation({ createdAt: "yesterday" })])],
  ])("%s is unmeasured (null), never 'none relaxed'", (_name, value) => {
    const list = parsePersonStdioRelaxations(value);
    expect(list).toBeNull();
    expect(relaxationFor(list, "mcp_server", "s1")).toBeUndefined();
  });
});

describe("ADR-0197 Q3: a relaxation's expiry", () => {
  it("reads the expiry and whether it has passed; a gateway before Q3 reports none (null)", () => {
    const list = parsePersonStdioRelaxations(
      envelope([
        relaxation({ expiresAt: "2026-11-16T10:00:00.000Z", expired: false }),
        relaxation({ id: "r2", scopeKind: "project", scopeId: "p1", expiresAt: "2026-10-18T09:00:00.000Z", expired: true }),
        relaxation({ id: "r3", scopeId: "s3" }),
      ]),
    );
    expect(relaxationFor(list, "mcp_server", "s1")).toMatchObject({ expiresAt: Date.parse("2026-11-16T10:00:00.000Z"), expired: false });
    expect(relaxationFor(list, "project", "p1")).toMatchObject({ expired: true });
    expect(relaxationFor(list, "mcp_server", "s3")).toMatchObject({ expiresAt: null, expired: false });
  });

  it.each([
    ["an expiry with no state", relaxation({ expiresAt: "2026-11-16T10:00:00.000Z" })],
    ["a state with no expiry", relaxation({ expired: true })],
    ["an unreadable expiry", relaxation({ expiresAt: "soon", expired: false })],
    ["an expiry before it was set", relaxation({ expiresAt: "2026-10-01T00:00:00.000Z", expired: true })],
  ])("%s is unmeasured (null)", (_name, row) => {
    expect(parsePersonStdioRelaxations(envelope([row]))).toBeNull();
  });
});

describe("project sensitivity", () => {
  it("reads every project; an unresolved project reads effective null", () => {
    const list = parseProjectSensitivities({ projects: [project(), project({ projectId: "p2", useCaseCount: 0, useCaseSensitivity: null, effectiveSensitivity: null })] });
    expect(list).toHaveLength(2);
    expect(list![1]!.effectiveSensitivity).toBeNull();
  });

  it.each([
    ["no envelope", undefined],
    ["no list", { projects: null }],
    ["an unknown sensitivity", { projects: [project({ adminSensitivity: "secret" })] }],
    ["a negative count", { projects: [project({ useCaseCount: -1 })] }],
    ["no name", { projects: [project({ name: "" })] }],
  ])("%s is unmeasured (null)", (_name, value) => {
    expect(parseProjectSensitivities(value)).toBeNull();
  });

  it("the body: a sensitivity, or null to clear; nothing else", () => {
    expect(projectSensitivityBody("")).toEqual({ sensitivity: null });
    expect(projectSensitivityBody("regulated")).toEqual({ sensitivity: "regulated" });
    expect(projectSensitivityBody("secret")).toBeNull();
  });

  it("the field only raises: below the use cases it has no effect", () => {
    expect(adminFieldRaises({ useCaseSensitivity: "confidential", adminSensitivity: "public" })).toBe(false);
    expect(adminFieldRaises({ useCaseSensitivity: "confidential", adminSensitivity: "confidential" })).toBe(false);
    expect(adminFieldRaises({ useCaseSensitivity: "internal", adminSensitivity: "regulated" })).toBe(true);
    expect(adminFieldRaises({ useCaseSensitivity: null, adminSensitivity: "public" })).toBe(true);
    expect(adminFieldRaises({ useCaseSensitivity: "internal", adminSensitivity: null })).toBe(false);
  });
});
