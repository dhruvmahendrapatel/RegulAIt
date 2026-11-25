<!-- fold: state-recap -->
**E33 slice 3 (2026-11-17) - incremental streaming inspection ([ADR-0352](../decisions/0352-gateway-parity-provider-breadth-semantic-cache-streaming.md)).**
A new org setting `streamOutputInspection` (`buffer` strict default, unchanged behaviour; `incremental` opt-in,
audited). Under an output-phase block policy, incremental mode releases a streamed answer piece by piece: a 256-char
hold-back and 512-char windows scanned by the same PII and guardrail detectors, so no character reaches the client
before a scan that covered it. The whole-result scan stays authoritative, and a block ends the stream with an explicit
error event on every surface (native SSE, OpenAI and Anthropic compat), after the usage and audit rows are written.
Measured: 0.12 ms of PII scanning for a 9.5k-char answer, first byte after about 800 chars instead of the whole
answer. Migration `pending/stream_output_inspection.sql`, numbered at merge. No new route.
