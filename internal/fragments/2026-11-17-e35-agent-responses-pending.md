<!-- fold: pending -->

- **E35 slice 2: block_session and disable side effects (ADR-0354 §7).** Disable through `haltAgentInTx`
  (narrowing only, applies under every dial, as #881's `kill_switch_narrowing_only`); block_session ends the
  orchestration run of a delegated worker, and is recorded with `sessionEnded: false` where no session exists. Then
  lift the route's `response_not_yet_enforced` refusal. Also render advise/correct on the model, connector and A2A
  refusal bodies (`governedEvaluateResource`, ADR-0251).
- **E35 slice 3: endpoint hook adapters (ADR-0354 §8), after lane E31 (on-device command rules) merges.** Map a signed policy's
  graduated response onto the Go `Decision`; render guidance only into each agent's documented plain-text fields;
  Claude Code `continue: false` for block_session.
- **UI (design builder, #453): the ABAC policy editor** needs the six response modes and the guidance message and
  alternative fields, with the validator's errors shown inline.
