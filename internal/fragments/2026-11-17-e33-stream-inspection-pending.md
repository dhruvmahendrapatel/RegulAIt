<!-- fold: pending -->

- **ADR-0352 slice 3 follow-ups (lane E33).** (a) Admin screen for `streamOutputInspection` (design builder, #453).
  (b) A windowed path for streamed thinking (today a request that streams thinking keeps the buffer). (c) Cancel the
  provider call on a window block to stop billing the rest of the answer (needs an abort signal on the adapter
  contract). (d) In-flight redaction instead of stop, once ADR-0137's span contract exists.
