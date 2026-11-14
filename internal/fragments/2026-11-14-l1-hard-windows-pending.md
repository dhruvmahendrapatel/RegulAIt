<!-- fold: pending -->

**P-01b — Hard windows for model and MCP tool rate limits (ADR-0251, 2026-11-14, lane L1).** Connector and A2A limits
are hard since slice 3 (a reservation under a lock). `model_rate_limits` (counted from `usage_events`, written after
the call) and the MCP path's `rate_limits` are still soft under concurrency: calls decided at the same moment can each
see the same count, bounded by the calls in flight. Apply the same reservation pattern, with its own latency
measurement.
