# GitLab demo fixtures (fictional company: Larkfield Outfitters)

Seed content for the demo GitLab group that `infra/environments/demo-sandbox/gitlab`
creates. One directory per project. Everything here is fictional: no real company,
person, key or value.

Each project uses AI SDKs and names AI-related environment variables, so RegulAIt's
repo scanner (ADR-0195 SD1 and lane A6) has something real to find:

| Project | What the scanner should see |
|---|---|
| `support-assistant` | Python `openai` and `anthropic` dependencies and imports; `.env.example` names; the `api.openai.com` host in config |
| `invoice-summariser` | npm `@anthropic-ai/sdk` and `openai` dependencies and imports; `.env.example` and Dockerfile names |
| `catalog-enrichment` | Python `mistralai` and `cohere` dependencies and imports; `.env.example` and `.gitlab-ci.yml` names |
| `ops-toolkit` | `.mcp.json` (an MCP server config), `AGENTS.md`, and IDE extension recommendations for AI assistants; Python `ollama` |

Environment templates list variable NAMES only, with empty values. Never put a value,
real or fake, in these files: gitleaks runs on every push.
