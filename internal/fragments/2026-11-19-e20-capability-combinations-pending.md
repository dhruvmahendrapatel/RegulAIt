<!-- fold: pending -->

- **Capability-combination follow-ups (ADR-0339 addendum, lane E20).**
  - Show the legs and the ranked fix options on the agent risk screen (UI builder, #453; the data is in
    `toxicCombinations[].legs` and `fixOptions`).
  - Owner questions:
    - Should the ADR-0193 write floor count as a mitigation once it also gates calls made without a run context?
    - Should per-call approval rules count as Ask-first for registry agents? Today neither counts (strict default).
