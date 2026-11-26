# Third-party components — the robot runner image (`engines/robot-runner`)

Open-source components the robot runner image ships (ADR-0176 admission rules: MIT, Apache-2.0, BSD or ISC, or a
public-domain dedication; maintained; pinned; works air-gapped). ADR-0364 §5, §9, §9a. Versions verified on
2026-11-19 against the npm registry and Playwright's own installer.

**Admission status: NOT PUBLISHED.** The image is registered as unpublished in the engine-image pipeline (built twice
and compared, scanned by Trivy, never pushed or locked). No digest is recorded, so no robot_browser placement can name
it yet.

| Component | Version | Licence | Used for, and why |
|---|---|---|---|
| `playwright-core` (npm, github.com/microsoft/playwright, © Microsoft Corporation) | `1.65.1` (exact, `pnpm-lock.yaml`; released 2026-11-13, npm `latest` on 2026-11-19) | Apache-2.0 | The browser driver (`packages/robot-runner/src/playwright.ts`). No dependencies, no install script. Its CLI installs the browser below at image build and its system libraries (`install-deps`); neither runs at run time. |
| Chrome Headless Shell (Chromium, Chrome for Testing build `159.0.8154.6`, Playwright revision `1255`, © The Chromium Authors) | the build playwright-core 1.65.1 names (`browsers.json`), from `cdn.playwright.dev/builds/cft/159.0.8154.6/linux64/chrome-headless-shell-linux64.zip` | BSD-3-Clause (Chromium), with its bundled third-party components under their own licences, listed in the build's `LICENSE.headless_shell` | The browser a robot run drives (headless only; ADR-0364 §9 chose Playwright with its Chromium build baked in). Installed at BUILD time into `PLAYWRIGHT_BROWSERS_PATH=/ms-playwright`; the Dockerfile checks the executable's sha256 (`24eb0a14…23b9b`), so a changed download fails the build. `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` at run time. Playwright's ffmpeg build (LGPL-2.1, video recording only) is installed alongside by the installer and **removed**: robots never record video. |
| Debian trixie system libraries for the headless shell | as Debian trixie ships them at build time (playwright-core's `install-deps chromium-headless-shell` list) | various (Debian packages; reported by the image's Trivy licence scan, security.yml) | The shared libraries Chromium links (fonts, NSS, X/GBM stubs). Re-scanned on every image build; a fixable HIGH or CRITICAL fails the image gate. |
| npm closure of `@regulait/shared` and `@regulait/engine-runner` | as `pnpm-lock.yaml` pins it | MIT, Apache-2.0, BSD-3-Clause, ISC (each package listed in those packages' `THIRD_PARTY.md`) | Shipped through the workspace dependencies. `licence-gate.mjs` judges every installed package of the deployed tree inside the build (34 packages on 2026-11-19, all on the ADR-0176 list, `licence-allow.json` empty). |
