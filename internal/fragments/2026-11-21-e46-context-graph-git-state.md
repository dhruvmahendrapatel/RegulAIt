<!-- fold: state-recap -->
**2026-11-21 - lane E46, context graph slice 3: a git source ([ADR-0365](../decisions/0365-live-synced-context-graph.md), amended).**
- **Source:** an admin binds an existing discovery repo source (GitHub, GitLab, Bitbucket, Azure DevOps). Its
  credential, guarded fetch and write-scope refusal are reused; no token is stored. A write-scope credential is
  refused and recorded on the discovery credential, as a scan does.
- **Strict scope:** each repository is mapped to a project; an unmapped repository is never read into the graph.
  Remapping re-scopes at once; unmapping removes its facts and nodes.
- **Graph:** repository and pull request nodes (no author stored), `contains` edges, missing marks. The hourly and
  daily jobs sync git sources too, reading the provider before the write transaction. `RepoReader.listPullRequests`
  added for all four providers. Migration `pending/shared_context_graph_slice3_git.sql`, numbered at merge; seven
  API-only admin routes; no new RLS reason.
