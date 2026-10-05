# Third-party components — `@regulait/shared`

Open-source components this package ships or derives from (ADR-0176 admission rules: MIT, Apache-2.0, BSD or ISC;
maintained; pinned; works air-gapped). npm dependencies are pinned through `pnpm-lock.yaml`.

| Component | Version | Licence | Used for, and why |
|---|---|---|---|
| gitleaks default ruleset (`config/gitleaks.toml`, github.com/gitleaks/gitleaks, © 2019 Zachary Rice) | commit `09242ce9c8a60d9b051fc2d166f9e849b88c7ac0` (the latest commit touching `config/gitleaks.toml` when read, 2026-10-05; file sha256 `e163e53b9e7e8a8511e77271e2b323ed057759542a6d988258afe3a1fa329caf`) | MIT | Basis of the credential patterns in `src/guardrails.ts` (`dlp.secret.anthropic_key`, `openai_key`, `github_fine_grained_pat`, `stripe_key`, `google_api_key`, `gitlab_pat`, and the GitHub classic token alternatives of `provider_token`). Rules are DERIVED, not vendored: each cites its gitleaks rule id and states any deviation, so vendoring the full ruleset as pinned data (after the audit-path false-positive policy, ADR-0176) is a mechanical swap. Data only: no runtime code, no network. |
