<!-- fold: state-recap -->
**2026-11-17 - E41 slice 1b: the agent's one-line enrolment and root self-update ([ADR-0360](../decisions/0360-endpoint-fleet-operations-and-edr.md), lane E41, branch `builder/e41-agent-updater`).**
`regulait-agent enrol` reads a one-line token from standard input only, never logs or stores it, and keeps a valid
ticket. `regulait-agent update` (a root system timer on Linux, a LaunchDaemon on macOS) installs only a directive the
device-policy signer signed for this device and a release the separate release keys signed, newer than the running
binary; it hashes a root-only staged copy, runs the staged and installed health checks, keeps `.previous` and rolls
back. Off unless both keyrings are pinned. `golang.org/x/mod` added (semver); go-tuf v2 failed admission.
