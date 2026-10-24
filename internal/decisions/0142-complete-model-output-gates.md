# ADR-0142 - Complete model-output gates

- Status: Accepted
- Date: 2026-09-30
- Scope: existing model PII/guardrail output blocking; no new policy mode

## Reproduced gaps

While preparing ADR-0137 integration, the shared dispatch core was found to:

- suppress text deltas only for non-PII guardrail output blocks, relying on
  individual callers for PII streaming suppression;
- forward thinking callbacks even while buffering visible text;
- scan only `result.outputText`, not thinking or model-generated tool calls;
- return tool calls even when another output channel had been withheld;
- flush a separately collected delta transcript after scanning only the final
  result, allowing a faulty provider's deltas and result to disagree.

## Decision

For either a PII block or a guardrail output block, omit both live callbacks
from the provider request. Rely on the model-provider contract that dispatch
returns a complete result. Scan the visible answer plus serialized decoded
thinking/tool-call objects before returning any content. On a block, withhold
thinking and tool calls along with the text; preserve honest usage billing.

On an allowed completion, emit the inspected thinking/signature blocks and
one complete text callback, not the provider's earlier delta transcript.
Report `streamBuffered` on the core result, including clean PII-policy calls
with no guardrail findings. Warn/log mode retains live streaming. Remove the
gateway's duplicate unbounded delta array; this does not impose a provider-side
stream-size limit or guarantee cancellation of upstream work.

The policy text includes signatures and opaque thinking data in their supplied
form. Pattern detectors do not decrypt or decode opaque/binary content, and no
claim of comprehensive PII detection follows. Live policy-change barriers,
bounded provider collection, cancellation, and in-flight redaction remain
ADR-0137 integration work. This change closes the enumerated current block-mode
paths; it does not establish complete deployment-wide output security.

## Verification

13 new gateway tests exercise PII and DLP blocks in text, thinking and tool
arguments; thinking-only subscribers; clean output; non-streaming tool calls;
live warn behavior; provider errors; and mismatching delta/final-result content.
Assertions inspect received callback bytes, returned tool/thinking fields,
provider call counts and billed usage. Existing clean-buffer behavior now
expects one inspected final-text callback, not the old original chunk count.

Negative control: temporarily restore unguarded thinking callbacks and
text-only policy scanning. All four targeted thinking/tool block cases fail
with leaked callback bytes. Restore the safeguards, then run eight gateway
files serially on a fresh disposable database: 204/204 tests pass, including
compatibility, cache/interception and international PII regressions. Gateway
typecheck passes. No real provider credentials or production services were used.
