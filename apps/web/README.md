# @regulait/web — the RegulAIt SPA (phase 1, ADR-0026)

React 18 + TypeScript + Vite + react-router + TanStack Query. Hand-rolled
design system (tokens in `src/theme/tokens.css`, owned kit in `src/ui/`).
Served by the gateway at **/ui** (`apps/gateway/src/web-serving.ts`); the
legacy `/app` and `/admin` shells remain until phase 2.

```bash
pnpm --filter @regulait/web build   # tsc --noEmit + vite build → dist/
pnpm --filter @regulait/web dev     # vite dev server on :5173, proxies the API to :3000

# e2e (real gateway + seeded scratch DB regulait_wt_spa, chromium from a
# provisioned browsers dir — never `playwright install`):
cd apps/web
PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers pnpm e2e
#   E2E_SHOTS_DIR=…  where per-view screenshots land (default e2e/screenshots)
#   E2E_DB / E2E_PORT / E2E_PG  override the scratch database / port / postgres url
```

The SPA holds no credential: the HttpOnly session cookie (ADR-0025) rides
`credentials: "include"`, every mutation carries `x-regulait-csrf: 1`, and a
401 mid-app routes to `/ui/login` with a return-to.
