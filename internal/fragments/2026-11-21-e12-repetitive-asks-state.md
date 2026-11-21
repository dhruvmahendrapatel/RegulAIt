<!-- fold: state-recap -->

**2026-11-21 - E12: repetitive-ask detector ([ADR-0328](../decisions/0328-repetitive-ask-to-smaller-model.md), builder lane E12).**
`findRepetitiveAsks` in `@regulait/optimizer-kernel` finds clusters of near-duplicate prompts. It masks numeric tokens
and fingerprints each prompt with SimHash over the shared tokenizer. Candidate pairs come from banding, and each pair
is confirmed on both Hamming distance and TF-IDF cosine. The strict defaults are 3 bits, 0.9 cosine and 20 asks.
It runs locally and returns only ids, fingerprints and counts. Pure and read-only: no route, no migration.
Next slices: scan and suggestion with savings, the eval gate and shadow period, and the approval switch and revert.
