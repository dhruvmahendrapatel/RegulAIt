# ADR-0005: Adopt caveman (output compression) and graphify (code knowledge graph), graphify restricted to `--code-only`

- **Status**: Accepted
- **Date**: 2026-07-22

## Context
The user asked to install token-optimization tooling for use while building RegulAIt, to bake
into the scaffold for every future tool RegulAIt builds, and to consider "token optimization" as
a RegulAIt product feature in its own right (tracked as OQ-004). The two named tools —
`caveman` (github.com/JuliusBrussee/caveman) and `graphify` (github.com/Graphify-Labs/graphify,
PyPI package `graphifyy`) — both show unusually large, fast GitHub star growth (91k+ and 93k+
respectively, in a few months) that couldn't be fully explained by independent research, which
is a documented pattern in the 2026 "Claude Code skill" ecosystem generally (GitHub fake-star
farming is well-documented for AI/LLM repos). Three rounds of vetting were run: general
legitimacy (real vs. anonymous maintainers, code inspection, install-script inspection), an
independent-adoption-signal check (Hacker News/Reddit/press vs. content-mill coverage), and a
source-level check of the specific question the user raised directly: does either tool transmit
codebase content anywhere.

Findings:
- **caveman**: real, independently corroborated organic virality (genuine Hacker News threads, a
  ~10k-upvote Reddit post, and independent tech press that fact-checked and *reduced* the
  marketing claim from 65–75% to a real 30–50% output-token savings). Source-level check: 100%
  local in every mode, including the `caveman-shrink` MCP companion (a local stdio process, not
  a network proxy despite the name) — zero code-content exfiltration risk.
- **graphify**: code parsing (`--code-only`) is 100% local tree-sitter AST, no LLM, nothing
  leaves the machine. But its semantic-extraction mode over docs/PDFs/images
  **auto-detects whichever LLM API key happens to be set in the environment** (priority:
  Gemini → Kimi → Claude → OpenAI → DeepSeek → Azure → Bedrock → Ollama) and sends that file
  content to that provider automatically — not per-file confirmed. One fallback (Kimi) routes to
  Moonshot AI servers in China. This is exactly the path that would touch RegulAIt's prose
  product-vision documents (`docs/product/*.md`), which are the most sensitive non-code content
  in this repo. A real Hacker News comparison thread and a genuine `SECURITY.md` with SSRF
  protection and explicit prompt-injection defenses were also found — evidence pointing toward a
  legitimate project despite the unexplained star-growth rate, unlike a third rejected candidate
  (`codegraph`) which had zero independent corroboration anywhere and was skipped entirely.

## Decision
Adopt both:
- **caveman**: installed as a Claude Code plugin, user scope (`claude plugin install
  caveman@caveman`) — no usage restriction needed given the fully-local, zero-exfiltration
  finding above.
- **graphify**: installed project-scoped for Claude Code only (`graphify install --project
  --platform claude`), **with a standing restriction: this repo's `/graphify` and `graphify
  extract` usage must stay in `--code-only` mode (or otherwise ensure no LLM API key is present
  when running against anything other than pure code files).** Never run graphify's semantic
  extraction over `docs/product/*.md` or any other prose/vision content in this repo.

## Consequences
- `graphify-out/` is a regenerable local build artifact (zero-cost to rebuild from `--code-only`
  AST parsing) — gitignored, not committed.
- The graphify installer auto-registered non-blocking `PreToolUse` hooks (`graphify hook-guard`)
  on Bash/Grep/Read/Glob in `.claude/settings.json`, and appended a usage section to `CLAUDE.md`
  — verified these hooks allow-through silently (no `--strict` flag was used, so nothing is
  blocked, just nudged).
- Every future session working in this repo must respect the `--code-only` constraint above —
  it is restated in `CLAUDE.md` directly, not left to this ADR alone, since violating it would
  send prose product-vision content to an external LLM provider whenever any LLM API key happens
  to be present in the environment for unrelated reasons.
- OQ-004 (whether to bake this into the scaffold for future RegulAIt-built tools, and whether to
  make "token optimization" a product feature) remains open — this ADR covers adoption for
  *this* repo only, not the broader template/product questions.
