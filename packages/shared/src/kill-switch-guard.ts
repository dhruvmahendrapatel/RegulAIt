/**
 * ADR-0338 §5 and §7 (owner decision 2, 2026-11-17): the kill switch lets narrowing through and stops widening.
 *
 * While the org's execution dial (ADR-0124) is anything other than `normal`, an action that takes access AWAY (a
 * quarantine, a disable) still runs, and an action that gives access BACK (a release, a re-enable, an automatic
 * expiry) does not. The guard is generic: it knows no vendor, device or action, only the dial and the direction the
 * caller declares. A caller takes the guarded transition only when this returns `null`.
 *
 * The dial values equal `EXECUTION_MODES` in @regulait/policy-kernel (the shared package does not depend on the
 * kernel); kill-switch-guard.test.ts holds the two lists equal.
 */
export const KILL_SWITCH_DIALS = ["normal", "read_only", "require_approval", "halted"] as const;
export type KillSwitchDial = (typeof KILL_SWITCH_DIALS)[number];
export type ChangeDirection = "narrowing" | "widening";

/** `null` when the change may run under this dial; otherwise a fixed sentence a person or an agent can act on */
export function killSwitchNarrowingOnly(args: { dial: KillSwitchDial; direction: ChangeDirection }): string | null {
  if (args.direction === "narrowing") return null;
  if (args.dial === "normal") return null;
  return `the execution dial is ${args.dial}: a change that widens access waits until an admin sets the dial back to normal (ADR-0338 §7)`;
}
