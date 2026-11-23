<!-- fold: state-recap -->
**E35 (2026-11-17) - graduated, agent-steering responses, slice 1 ([ADR-0354](../decisions/0354-graduated-agent-steering-responses.md), migration `pending/abac_agent_responses.sql`, numbered at merge).**
One declared response table (`packages/policy-kernel/src/agent-response.ts`): allow, advise, ask, correct, deny,
block_session, disable, each mapped onto one existing effect, mirrored in the Go endpoint agent and pinned by one
golden file read by both test suites. Cedar policy modes (ADR-0040) now name the responses; strictest wins. Advise and
correct carry static, admin-written guidance validated by `parseAgentGuidance` (plain text, no markup or placeholders,
the shared admission scan) and repeated as DB CHECKs. The MCP path returns correct's alternative in the refusal and
advise's guidance in `_meta` plus a labelled text item; every decision row records `detail.agentResponse`. Relaxing a
live policy's response is a `settings_relax` step-up. Block_session and disable are declared but refused at write time
until slice 2.
