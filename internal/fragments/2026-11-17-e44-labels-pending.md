<!-- fold: pending -->
- **E44 follow-up (ADR-0363): sensitivity labels on the other content paths.** MCP tool results (`decodeMcpBlobs`),
  browser-extension uploads and endpoint hooks reuse `readEmbeddedLabels` and `decideLabels` unchanged; only the
  model-dispatch path is gated today. Also a Google Workspace (Drive labels) `LabelProvider`, and the screen for the four
  `/v1/sensitivity-labels` routes (#453).
