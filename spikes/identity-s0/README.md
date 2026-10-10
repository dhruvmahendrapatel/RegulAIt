# ADR-0188 S0 identity-library spike

Throwaway research code for X32. No workspace package imports it, and `pnpm-workspace.yaml` includes only `apps/*` and `packages/*`. It does not install product OAuth routes or implement the delegation budget kernel.

Run from the repository root with Node24 and local Postgres:

```sh
pnpm install --frozen-lockfile
pnpm --filter '@regulait/gateway...' build
npm ci --prefix spikes/identity-s0 --ignore-scripts
REGULAIT_DATABASE_SSL=disable S0_DATABASE_URL=postgres://regulait:regulait@127.0.0.1:5432/regulait npm --prefix spikes/identity-s0 test
npm --prefix spikes/identity-s0 run licences
```

The database URL must use loopback and an account allowed to create databases. Each run creates a unique `regulait_s0_<pid>_<time>` database, applies the real migrations there, adds fixture tables, and drops only that scratch database afterward. It never resets the base database. All client keys, certificates, users, assertions and workload records are synthetic. Private fixture keys are generated in memory, sent to the two child processes through local IPC, and never written into the repository.

`licence-inventory.json` records every locked runtime package, including installed optional dependencies, its tarball integrity and notice hash. `THIRD_PARTY.md` preserves the installed licence texts and the provider's bundled-code notices. `notices/SOURCES.md` records the primary-source reconstruction for a package whose tarball links its licence instead of shipping the text. Regenerate intentionally with `node spikes/identity-s0/licences.mjs --write`; the normal command fails on inventory or notice drift.

The real gateway `buildApp` supplies the hooks, body limit, Postgres rate limiter and chained audit writer. The test-only `/oauth/token` mount runs after its existing authentication, session CSRF and admin hooks; the bounded form body is then reconstructed for the provider. Requests send a synthetic bootstrap credential solely to enter the existing gateway, and the mount consumes that header before Koa performs separate workload client authentication. Likewise `/s0/resource` uses a clearly named fixture header to exercise the proposed resource wrapper after existing gateway admission. These bridges do **not** establish that an external workload credential already passes the product's human authentication path; S5 must install its specific route class and verifier.

The suite includes two provider instances and two independently forked OS processes, with distinct gateway listeners and independent Postgres pools. No replay map is shared in JavaScript. Both processes use one uploaded signing key and nonce secret.

The proposed resource wrapper checks the issued-token binding and rereads fixture grant ancestors, identities, authentication credentials and sponsor status. These fixture tables establish library feasibility only. S1/S3/S4 supply the actual constraints, scope intersection, edge budget accounting, charge idempotency, audit-v2 cutover and full revocation provenance.

The TLS test uses an actual Node HTTPS handshake and the same offline PKIJS validator. Proxy-header tests inject trusted-peer/authenticated-proxy facts; establishing those facts through the deployment's proxy and configuring its strip rules remain S5 integration work.

See [R11](../../docs/research/R11-identity-s0-spike.md) for the GO decision, evidence and integration requirements.
