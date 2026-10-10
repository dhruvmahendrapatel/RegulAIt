/**
 * ADR-0190 I1 — every pattern the isolation contract runs on caller input finishes in linear time on
 * adversarial input (CodeQL js/redos). Each case feeds a 100k-character string built to make a backtracking
 * pattern explode (a valid prefix, many repetitions of an ambiguous character, then a character that forces a
 * mismatch) through the real schema, and must be refused well inside 100 ms. Listed in TIMING_FILES.
 */
import { describe, expect, it } from "vitest";
import {
  EXECUTION_PROFILE_NAME_RE,
  executionProfileBodySchema,
  isExactHost,
  isSandboxPath,
  registerExecutorSchema,
  RESTRICTED_EXECUTION_PROFILE,
  type ExecutionProfileBody,
} from "./index.js";

const N = 100_000;
const BUDGET_MS = 100;
function variant(mutate: (b: ExecutionProfileBody) => void): ExecutionProfileBody {
  const b = structuredClone(RESTRICTED_EXECUTION_PROFILE) as ExecutionProfileBody;
  mutate(b);
  return b;
}
function timed(fn: () => boolean): { ok: boolean; ms: number } {
  const t0 = performance.now();
  const ok = fn();
  return { ok, ms: performance.now() - t0 };
}

const adversarial: Array<[string, () => boolean]> = [
  // the CodeQL finding: '/' followed by many '-' (and the mixes a repeated path group splits ambiguously)
  ["sandbox path: '/' + '-'*N + '!'", () => isSandboxPath("/" + "-".repeat(N) + "!")],
  ["sandbox path: '/a' * N + '!'", () => isSandboxPath("/a".repeat(N) + "!")],
  ["sandbox path: '/' + 'a/'*N + '//'", () => isSandboxPath("/" + "a/".repeat(N) + "//")],
  ["work dir through the schema", () => executionProfileBodySchema.safeParse(variant((b) => (b.filesystem.workDir.path = "/" + "-".repeat(N) + "!"))).success],
  ["input mount through the schema", () =>
    executionProfileBodySchema.safeParse(variant((b) => (b.filesystem.inputs = [{ name: "x", mountPath: "/" + "a-".repeat(N) + "!" }]))).success],
  ["host: 'a-'*N + '!'", () => isExactHost("a-".repeat(N) + "!")],
  ["host: 'a.'*N + '-'", () => isExactHost("a.".repeat(N) + "-")],
  ["host: '[' + ':'*N", () => isExactHost("[" + ":".repeat(N))],
  ["allow-list host through the schema", () =>
    executionProfileBodySchema.safeParse(variant((b) => (b.network = { mode: "allow_list", entries: [{ host: "a-".repeat(N) + "!", port: 443 }] }))).success],
  ["profile name", () => EXECUTION_PROFILE_NAME_RE.test("a" + "-".repeat(N) + "!")],
  ["seccomp profile name", () =>
    executionProfileBodySchema.safeParse(variant((b) => (b.process.seccomp = { type: "Localhost", profile: "a" + "._-".repeat(N) + "!" }))).success],
  ["input name", () => executionProfileBodySchema.safeParse(variant((b) => (b.filesystem.inputs = [{ name: "a" + "_-".repeat(N) + "!", mountPath: "/in" }]))).success],
  ["executor name and runtime version", () =>
    registerExecutorSchema.safeParse({
      workloadIdentityId: "7b0b1c2e-0000-4000-8000-000000000001",
      name: "a" + "-".repeat(N) + "!",
      backend: "gvisor",
      runtimeVersion: "1" + ".+-".repeat(N) + "!",
      classesDeclared: ["user_space_kernel"],
    }).success],
];

describe("ADR-0190 isolation contract patterns are linear on adversarial input", () => {
  it.each(adversarial)("%s is refused within the budget", (_label, fn) => {
    fn(); // warm the JIT so the budget measures the pattern, not compilation
    const { ok, ms } = timed(fn);
    expect(ok).toBe(false);
    expect(ms).toBeLessThan(BUDGET_MS);
  });
});
