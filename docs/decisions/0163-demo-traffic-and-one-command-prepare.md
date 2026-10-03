# ADR-0163: Governed Demo Traffic and a One-Command Demo Database

Status: Accepted (implemented)
Date: 2026-10-02
Related: ADR-0157 (monitor), ADR-0160 (trace evaluation), ADR-0019 (PII),
ADR-0029/0066 (routing), demo tasks C11/C15/C16, milestone M3
Migration: none

## Context

The Monitor & Respond beats need real traffic — traces, a guardrail-relevant
response, a runtime refusal — produced by the product, not inserted rows.
Milestone M3 needs the demo database reproducible from one command.

## Decision

1. **`demo:traffic`** sends governed calls as Dana through the ONE dispatch
   path (`POST /v1/agents/:id/invoke`) on the keyless mock provider, attributed
   to `demo-project` (the demo posture requires attribution): routine calls to
   the agents of approved use cases; a **leak** — AWS's documented EXAMPLE key,
   which the input PII check does not treat as PII, which the mock echoes into
   the response, which the write-time scrub stores as a redaction marker, and
   which trace evaluation counts as credential material; a **block** — an
   SSN-shaped prompt in `hipaa-project` (PII mode `block`); and an injection
   **attempt**. It then runs trace evaluation and a monitor pass.
2. **Report what happened, never what was intended**: each call's status,
   refusal, and the agent that ACTUALLY served it (`routing.selectedAgentId`),
   including when routing moved it.
3. **`demo:prepare`** runs `seed → demo:setup → demo:intake → demo:traffic →
   demo:check` as separate processes with one environment and stops at the
   first non-zero exit, naming the step. It seeds an EMPTY database; it does
   not reset one.

## Finding recorded, not fixed here

Right-size routing (pillar 6) served a call made for an approved use case's
agent from a cheaper agent OUTSIDE that use case's approved stack. Trace
evaluation then attributed the leak to the served agent, which no approved
use case names, so `agent_output_leakage` did not fire. The demo pins the
leak call with `costSensitivity: quality-sensitive`, as a team pins a
production workload. Follow-up candidates: (a) a routing guard that keeps a
use case's traffic inside its approved stack; (b) attributing traces to use
cases (project or explicit tag) so the monitor sees traffic regardless of
the served agent.

## Tests

`demo:prepare` on an empty database (results in the C15/C16 board entry);
`zz-c11-demo-check.test.ts` keeps every beat green in CI.
