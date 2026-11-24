/** ADR-0333 — detection selectors and tool classes on Cedar. */
import { describe, expect, it } from "vitest";
import { matchDetectionSelectors, type DetectionEventFacts } from "./detection-cedar.js";

const base: DetectionEventFacts = {
  objectType: "mcp_tool",
  effect: "allow",
  ruleId: "allow-list",
  toolName: "noop",
  phase: null,
  dataScoped: false,
  addonSeverity: null,
  delegated: false,
};
const one = (selector: Parameters<typeof matchDetectionSelectors>[0][number], e: Partial<DetectionEventFacts>, classes = {}) =>
  matchDetectionSelectors([selector], classes, [{ ...base, ...e }])[0]!.has(0);

describe("ADR-0333 detection selectors on Cedar", () => {
  it("an empty selector matches every event", () => {
    expect(one({}, {})).toBe(true);
  });

  it("each clause holds only when present and satisfied", () => {
    expect(one({ effect: ["deny"] }, { effect: "deny" })).toBe(true);
    expect(one({ effect: ["deny"] }, { effect: "allow" })).toBe(false);
    expect(one({ objectType: ["connector"] }, {})).toBe(false);
    expect(one({ ruleId: ["delegation-scope", "lead-ceiling"] }, { ruleId: "lead-ceiling" })).toBe(true);
    expect(one({ phase: ["delegation"] }, { phase: null })).toBe(false);
    expect(one({ phase: ["delegation"] }, { phase: "delegation" })).toBe(true);
    expect(one({ dataScoped: true }, { dataScoped: false })).toBe(false);
    expect(one({ delegated: true }, { delegated: true })).toBe(true);
    expect(one({ addonSeverityAtLeast: "high" }, { addonSeverity: "critical" })).toBe(true);
    expect(one({ addonSeverityAtLeast: "high" }, { addonSeverity: "medium" })).toBe(false);
    expect(one({ addonSeverityAtLeast: "high" }, { addonSeverity: null })).toBe(false);
    expect(one({ effect: ["allow"], dataScoped: true }, { dataScoped: true })).toBe(true);
  });

  it("tool classes use Cedar's `like`: literal segments in order, case-folded tool names", () => {
    const classes = { secret: ["*secret*", "read_env*"], abc: ["a*b*c"], exact: ["exact"] };
    const cls = (toolClass: string, toolName: string | null) => one({ toolClass }, { toolName }, classes);
    expect(cls("secret", "Vault_Read_SECRET")).toBe(true);
    expect(cls("secret", "read_env_var")).toBe(true);
    expect(cls("secret", "x_read_env")).toBe(false);
    expect(cls("secret", null)).toBe(false);
    expect(cls("abc", "abc")).toBe(true);
    expect(cls("abc", "acb")).toBe(false);
    expect(cls("exact", "exact")).toBe(true);
    expect(cls("exact", "exactly")).toBe(false);
  });

  it("answers per event and per selector position", () => {
    const answers = matchDetectionSelectors([{ effect: ["deny"] }, { effect: ["allow"] }, {}], {}, [base, { ...base, effect: "deny" }]);
    expect(answers.map((s) => [...s].sort())).toEqual([[1, 2], [0, 2]]);
  });

  it("fails closed: a glob outside the admitted charset throws rather than matching nothing", () => {
    expect(() => matchDetectionSelectors([{ toolClass: "x" }], { x: ['a" || true || "'] }, [base])).toThrow();
    expect(() => matchDetectionSelectors([{ toolClass: "x" }], { "X Y": ["a*"] }, [base])).toThrow();
  });
});
