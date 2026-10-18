/** ADR-0195 A6: the env-name line scanner is linear (in the serialized `timing` project). */
import { expect, it } from "vitest";
import { ENV_NAME_MAX, envNamePresenceInText } from "./index.js";

it("envNamePresenceInText is linear on a hostile input", () => {
  const hostile = `${"A".repeat(ENV_NAME_MAX)}${" ".repeat(10_000)}\n`.repeat(150);
  const t0 = performance.now();
  for (const f of ["dotenv", "dockerfile", "ci_yaml"] as const) envNamePresenceInText(hostile, f);
  expect(performance.now() - t0).toBeLessThan(2_000);
});
