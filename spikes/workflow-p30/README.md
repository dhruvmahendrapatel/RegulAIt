# P30 spike: `vercel/workflow` on Postgres as pillar 2's durable-execution engine

Throwaway research code for backlog item P30. The result is [ADR-0254](../../internal/decisions/0254-workflow-durable-execution-spike.md):
**none fits**, so nothing here is adopted. No workspace package imports this directory, and
`pnpm-workspace.yaml` includes only `apps/*` and `packages/*`.

## What it runs

- `workflows/signoff-stage.ts` has one real pillar-2 stage sequence from the Standard Change Workflow:
  requirements artifact, then the requester's sign-off, then three automated checks. The real
  `@regulait/workflow-kernel` `transition()` runs inside durable steps (`"use step"`). The sign-off is a
  `createHook()` pause that is resumed by `resumeHook()` from a product route. The checks fan out with
  `Promise.all`.
- `workflows/governance.ts` wraps every step body in a default-deny allow-list check and writes a decision
  row. A refusal throws `FatalError`, so it is final and never retried.
- `workflows/bench.ts` has N sequential no-op steps for the per-step overhead.
- `server.mjs` is a fastify 5 host built from the `workflow build --target standalone` output: no framework
  plugin. It pins the World with `setWorld()` and wraps `world.events.create` / `createBatch` with an audit
  write. The World's unauthenticated `/.well-known/workflow/v1/flow` route is refused to non-loopback callers.
- **Default off:** `buildSpike()` refuses to start unless `REGULAIT_WORKFLOW_DURABLE_P30=1`. Any value other
  than 1/true/on or 0/false/off throws.

## Run

You need Node 22+ and a local Postgres role that may create databases. Each run creates
`regulait_p30_<pid>_<time>`, runs the World's own migrations there, and then drops it.

```sh
pnpm install --frozen-lockfile --ignore-scripts --filter @regulait/workflow-kernel...   # zod for the kernel source
npm install --prefix spikes/workflow-p30 --ignore-scripts
npm --prefix spikes/workflow-p30 run build        # writes .well-known/workflow/v1 (git-ignored, ~19 MB)
P30_ADMIN_URL='postgres://USER:PASS@localhost/DB?host=/var/run/postgresql' npm --prefix spikes/workflow-p30 test
```

**No lockfile is committed.** The engine is rejected, and it pins vulnerable `zod`/`undici` (THIRD_PARTY.md), so a
committed `package-lock.json` would be one more closure to keep patched (mistakes.md M-097). The direct dependencies
are exact pins in `package.json`, and `evidence/resolved-2026-11-07.txt` records the tree the evidence ran on.

**Egress proof.** Run the same command inside a network namespace that has only loopback, for example
`unshare -n` followed by bringing `lo` up. Postgres is reached over its unix socket. The suite also patches
`net.Socket.connect` and `dns.lookup` and asserts that every destination it saw was local. The build passes
offline too. `evidence/run-2026-11-07.txt` has both outputs.
