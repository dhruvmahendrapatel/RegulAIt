<!-- fold: pending -->

**P-01c — ABAC v5 follow-ups (ADR-0251 slice 4a, 2026-11-14, lane L1).** (1) An ABAC `require_approval` on a model,
connector or A2A call refuses: queue it once the consent's context digest binds the policy version, as the MCP path
does. (2) The governed core evaluates v5 policies without the request's session facts (`sessionOrigin`,
`mfaCompleted`, `clientIp` read as unknown, false, absent) and as the sponsor only (empty delegation context): thread
them from the routes and the actor chain. (3) Make v5 the default schema version once the policy editor has an action
picker (UI builder, #453).
