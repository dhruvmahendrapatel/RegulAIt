<!-- fold: state-recap -->
**E35 slice 2 (2026-11-21): block_session and disable now act ([ADR-0354](../decisions/0354-graduated-agent-steering-responses.md), migration `pending/abac_agent_responses_session_effects.sql`, numbered at merge).**
For a delegated or in-process agent, `block_session` revokes its leaf delegation grant with the new reason
`policy_response`, which ends its session. `disable` also suspends its workload identity, narrowing only
(`active → suspended`); reinstating stays a step-up change. A person's or an A2A call has no agent session, so it is a
plain deny with the outcome audited. The response now rides on model, connector and A2A decisions and refusal bodies
too. The write-time refusal of the two modes is lifted.
