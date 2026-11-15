<!-- fold: pending -->

**P18 follow-up — the `iso-42001` impact-assessment ref (ADR-0295).** `iso-42001@1` cites the impact assessment as
`iso-42001:8.3-ai-system-impact-assessment`; ISO/IEC 42001:2023 numbers it 8.4, and `iso-42001@2` uses
`8.4-ai-system-impact-assessment`. intake-assist (`bias_fairness`), the demo regulatory feed and the
decision-regression goldens still cite the v1 ref. Move them to the 8.4 ref when v2 becomes the pack the demo
activates (a golden-expected change, so its own reviewed PR).
