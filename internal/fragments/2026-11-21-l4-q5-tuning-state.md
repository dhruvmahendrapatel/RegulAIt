<!-- fold: state-recap -->
**2026-11-21, L4 Q5 skill-scanner tuning (ADR-0242 L4.8).** Measured, and no rule is narrowed. With the image built
from the committed Dockerfile (rules digest `1fce40df…` unchanged), 1 of the 19 `anthropics/skills` SKILL.md files
(pinned `2c5958ec`) is held at the `medium` line: `docx`, by `compound_extract_execute` (high), a false positive.
Full bundles, for information only: 10 of 19 do not pass (8 held, 2 over the driver's 64-file cap). Four crafted
"extract an archive, then run what came out" SKILL.md probes are held by that rule and by nothing else, so every
upstream knob that clears `docx` (`severity_overrides`, a `suppressions` entry scoped to SKILL.md, `disabled_rules`,
the `quiet` preset) also lets all four through, and a skill-name scope keys on author-controlled frontmatter. A
driver-side override would be evadable (by renaming a zip) or a hand-written shell parser. F×S = 4, so it is a
`triage-low` issue for the master to file. The audited skill admit route clears the one false hold per digest.
