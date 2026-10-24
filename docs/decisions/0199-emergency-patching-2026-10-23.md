# ADR-0199: Emergency patching of 2026-10-23/24: Node 22.23.4, transitive overrides and the engine closures

- **Status**: Accepted
- **Date**: 2026-10-24
- **Decision owner**: owner, 2026-10-23 ("Let's patch asap before the demo") and 2026-10-24 (the garak fix, #453
  comment 6378601196, which supersedes comment 6378502293); the master took the rest under ADR-0180 (secure by default)
  and ADR-0176 (open source first)

## Context
Between 2026-10-21 and 2026-10-24, five weeks before the code freeze (2026-10-29) and ten days before the external demo
(2026-11-03), several upstream security releases landed:

- **Node.js 2026-10-21 security release.** Seven of its ten CVEs affect 22.x, three of them high, including
  CVE-2026-111497 (a Brotli out-of-bounds write) and two TLS bypasses (CVE-2026-106069 high, CVE-2026-106072 medium).
  Every Node image we build (gateway, engines, sandbox executor, stdio base) was on 22.23.3. The gateway decompresses
  Brotli from outbound servers (`apps/gateway/src/pinned-fetch.ts`) and relies on the default TLS hostname check.
- **npm advisories that fail the `pnpm audit` gate on main and on every PR**: zod GHSA-mrhx-c7xc-m3w5 (<4.6.6),
  body-parser GHSA-27r3-jxmh-p828 (2.0.0 to <2.4.0, through express 5.2.1 in the MCP SDK) and `@azure/msal-node`
  GHSA-xcx6-jx8p-x3h5 (5.0.0-beta.0 to <7.1.0, through `@azure/identity`).
- **Engine closure advisories, found by the Trivy image gate (ADR-0184) on the first lock PR after the fixes (#544)**:
  the promptfoo image's own npm closure (`engines/promptfoo/package-lock.json`) still had body-parser 2.3.0, zod 4.6.5
  and undici 6.29.0, 7.30.0 and 8.11.2 (CVE-2026-109869), and garak's Python closure had filelock 3.32.7
  (CVE-2026-112940, fixed only in 4.2.1+).
- Not affected: PHP2Shell (CVE-2026-109618/109619, no PHP anywhere) and the LiteLLM 1.107.0 backdoor (garak pins
  litellm 1.106.1 by hash).

## Decision

### 1. Patch, do not allow-list (ADR-0180)
Every advisory above is fixed by moving to the upstream fixed release, even where our exposure is low (msal-node's
authorization-code flow and body-parser's compressed bodies are not on any path we use). No allow-list entry was added.

### 2. Node 22.23.4 everywhere (#536)
All 13 `FROM` lines in 7 Dockerfiles move to `node:22-trixie-slim@sha256:8eb619e4…742ddf` (Node 22.23.4, published
2026-10-21T11:36Z), with the THIRD_PARTY records updated. ADR-0184's historical digest is left as written.

### 3. Transitive overrides in the workspace (#537, #542)
- zod 4.6.6 (Dependabot #532, carried by #537).
- `express>body-parser: ^2.4.0`. express declares `^2.2.1`, so this is in range; pnpm only needs the override because
  it does not move a transitive dependency on update.
- `@azure/identity>@azure/msal-node: ^7.1.1`. This is **past identity's declared `^6.0.0`**: no identity release
  accepts 7.x yet. It is acceptable because every runtime export and `acquireToken*` method identity calls exists in
  7.1.1, msal-node 7's only breaking change is interactive-only, and `DefaultAzureCredential` and
  `ClientSecretCredential` were exercised end to end by the reviewer. **Remove the override when an identity release
  declares msal-node 7.**

### 4. The engine closures (#545)
- promptfoo: npm `overrides` in `engines/promptfoo/package.json` (as the existing `basic-ftp` entry): body-parser
  2.4.0, zod 4.6.6, and undici per major (`undici@6` 6.29.1, `undici@7` 7.30.1, `undici@8` 8.12.2), so each consumer
  stays inside its declared range.
- garak (owner decision 2026-10-24, #453 comment 6378601196): **"litellm 1.103.7 re-resolve"**. garak's closure is
  re-resolved with litellm 1.103.7 (released 2026-10-21, no known advisories; garak 0.17.1 needs `litellm>=1.84.0`),
  the line that declares no filelock cap, so the hub client moves to 2.x and filelock to ≥4.2.1. Every declared range
  is honoured and the image's `pip check` guard stays whole. This reverses the 2026-10-21 choice (ADR-0187) of the
  newest litellm. litellm 1.107.0 is never taken (the backdoored release). Built in its own PR after #545.
- The first answer (comment 6378502293, "pin filelock 4.2.4" past litellm 1.106.1's `filelock<4.0`) is superseded.
  The master offered it on the premise that the `--no-deps` install would not enforce the cap. The Dockerfile's
  `pip check` does enforce it, and the build failed on #545 (M-101). The commit was reverted on #545, which now carries
  only the promptfoo fix. The alternatives offered with the revised question were a narrow `pip check` exception and a
  time-boxed allow-list entry.

### 5. One engine lock record after the last image-input change
The lock PR from the `c4670a7f` publish (#544) was closed unmerged, because its promptfoo and garak images failed the
image gate. The lock is recorded once, from the publish after #545 merges.

## Consequences
- The demo hosts must be rebuilt after the new lock merges (`git pull`, `docker compose pull`,
  `docker compose up -d --build`, `demo:check`), and native Node on the laptop must be 22.23.4.
- One declared-range violation is now deliberate and recorded: msal-node 7 under identity. It must be re-checked
  when identity ships a release that allows msal-node 7.
- The engine closures are separate lockfiles that the workspace `pnpm audit` gate does not see. Until the follow-up
  below lands, an advisory in them is found only by the image gate on a lock PR, one publish cycle late.

## Follow-ups (after 2026-11-03)
1. Run the engine image scan (or an npm/OSV audit of `engines/*/package-lock.json` and `engines/garak/requirements.txt`)
   on every PR that changes those files and on main, so closure advisories are found before a publish.
2. Remove the msal-node override when `@azure/identity` declares msal-node 7, and unify the gateway's `@azure/identity`
   (4.13.3) with cloud-discovery's (4.14.0).
3. Move garak back to the newest litellm once a release drops the `filelock<4.0` cap (re-resolve, pre-seed re-proof).
4. The two moderate advisories left in the promptfoo closure (fast-uri, ip-address; Dependabot #538 and #515).
5. Widen the DPoP "from the future (6 s)" test margin, which raced once on a slow runner (#542).
