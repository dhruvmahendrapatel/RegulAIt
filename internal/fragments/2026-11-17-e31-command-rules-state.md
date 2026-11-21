<!-- fold: state-decisions -->
**ADR-0350 (builder lane E31, 2026-11-17, Proposed; slice 1 built, default off): on-device command, file and package rules.**
- **What:** the hook adapters gain a neutral `Command` decision for built-in shell commands, file reads and writes and
  package installs. A closed rule list (argv globs over a bash parse by `mvdan.cc/sh`, path globs, ecosystem and name)
  returns allow, ask or deny; the strictest wins; anything unparsable is ask or deny. Ask uses each agent's own prompt,
  or is a deny where the agent has none. Policy schema 2 makes the `commands` section required.
- **Honest matrix:** Claude Code sees shell, reads and writes; Cursor shell and reads (no pre-write hook); Copilot CLI
  shell only; Codex shell and `apply_patch` writes, deny only. A guardrail, not containment.
- **Next slices:** the compiler from the gateway's own entitlements, signed by the B4 signer (#867); device groups that
  only narrow, and step-up-approved, expiring per-device exceptions with a declared lifecycle.
