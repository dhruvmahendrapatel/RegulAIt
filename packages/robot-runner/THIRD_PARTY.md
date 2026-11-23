# Third-party components — `@regulait/robot-runner`

Open-source components this package ships (ADR-0176 admission rules: MIT, Apache-2.0, BSD or ISC; maintained; pinned;
works air-gapped). npm dependencies are pinned through `pnpm-lock.yaml`. The package runs only inside the robot runner
image (`engines/robot-runner/`), which lists the same rows plus the browser build.

| Component | Version | Licence | Used for, and why |
|---|---|---|---|
| `playwright-core` (npm, github.com/microsoft/playwright, © Microsoft Corporation) | `1.65.1` (exact; released 2026-11-13; npm `latest` on 2026-11-19, verified on the registry) | Apache-2.0 | ADR-0364 §9 / §9a: the browser driver for scripted robot runs (`src/playwright.ts`): Chromium launch through the run's egress proxy, a fresh context, `route`/`routeWebSocket` blocking, locator actions, downloads and masked screenshots. We write no browser driver. No dependencies of its own (a single package with vendored internals); no install script. Air-gapped: the Chromium build is installed at IMAGE build into `PLAYWRIGHT_BROWSERS_PATH` and `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` is set at run time, so nothing is downloaded when a robot runs. Re-checked with each Playwright release (the free-form `@playwright/mcp` server pins a prerelease and never enters this package, §9). |

Workspace packages (`@regulait/shared`, `@regulait/engine-runner`) carry their own `THIRD_PARTY.md`.
