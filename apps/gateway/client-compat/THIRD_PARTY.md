# Third-party clients used by the client compatibility harness (ADR-0257)

**Test-only. Nothing here ships in the gateway image or any product artefact.** These are the off-the-shelf clients
the harness points at the gateway, each in its own image, pinned by lockfile and by the base image's index digest,
and fetched only at image build (ADR-0176 record).

| Image | Direct dependency | Version | Licence | Lockfile |
|---|---|---|---|---|
| `node-sdks` | `openai` | 7.43.0 | Apache-2.0 | `clients/node-sdks/package-lock.json` |
| `node-sdks` | `@anthropic-ai/sdk` | 1.3.0 | Apache-2.0 | same |
| `laravel-ai` | `laravel/ai` | v1.3.0 | MIT | `clients/laravel-ai/composer.lock` |
| `laravel-ai` | `orchestra/testbench` (boots a minimal Laravel app, as laravel/ai's own tests do) | v10.12.0 | MIT | same |
| `dart-mcp` | `dart_mcp` | 0.5.2 | BSD-3-Clause | `clients/dart-mcp/pubspec.lock` |
| `dart-mcp` | `json_rpc_2`, `stream_channel` | 4.1.0, 2.1.4 | BSD-3-Clause | same |

Transitive closures:

- **node-sdks** (9 packages): Apache-2.0 and MIT, plus `fast-sha256` 1.3.0 (Unlicense, a public-domain dedication).
- **laravel-ai** (116 packages, Laravel 12.71.0 and Symfony 7.4): 84 MIT, 29 BSD-3-Clause, 1 Apache-2.0
  (`phpoption/phpoption`). `nette/schema` and `nette/utils` are dual-licensed "BSD-3-Clause OR GPL-2.0-only OR
  GPL-3.0-only"; they are used under BSD-3-Clause.
- **dart-mcp** (9 packages, all from the Dart team): BSD-3-Clause.

Base images (multi-arch index digests): `node:22-alpine@sha256:0e1754758c2d…`, `composer:2@sha256:8de2184c6de2…`,
`php:8.4-cli-alpine@sha256:b58f9a66fe97…`, `dart:3.9@sha256:9db24325a8df…` (full digests in each Dockerfile).
