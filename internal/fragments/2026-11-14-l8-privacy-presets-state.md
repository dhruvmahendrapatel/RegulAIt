<!-- fold: state-recap -->

**2026-11-14 - P18 B2 part 2: privacy-law presets and packs ([ADR-0296](../decisions/0296-privacy-and-cyber-incident-clocks-and-presets.md), builder lane L8).**
GDPR, CCPA/CPRA, DPDP and LGPD presets on the ADR-0224 machinery (request period, PII identifiers, processing limit;
`privacyPresetPatch` only tightens, applied through the existing settings route) and `gdpr@1`, `ccpa@1`, `dpdp@1`,
`lgpd@1` packs on the privacy audit evidence the gateway writes. No migration, no new route.
