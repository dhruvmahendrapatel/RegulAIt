<!-- fold: pending -->
**E43 follow-ups (ADR-0362 §Cost, 2026-11-24).**
1. Give the `contentextract` runner a short idle interval or a long-poll lease. Today an idle runner polls every 5 s,
   and that wait dominates an inspected dispatch's latency. Extraction itself takes about 40–130 ms for text formats
   and about 350 ms per scanned page.
2. Once the image is admissible, time it end to end under gVisor.
