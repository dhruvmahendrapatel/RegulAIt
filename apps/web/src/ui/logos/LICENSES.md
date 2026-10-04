# Vendored logos — sources and licences

These SVG files identify third-party services (model providers, apps, integrations) in the console.
Trademarks belong to their owners; using a mark to name the service it represents does not imply
endorsement. Files are copied, not fetched at runtime, so the console works air-gapped.

| Files | Source | Licence |
|---|---|---|
| AI provider marks: anthropic, aws, azure, azureai, bedrock, claude, cohere, deepseek, fireworks, gemini, google, grok, groq, huggingface, meta, mistral, ollama, openai, perplexity, qwen, together, vertexai, xai | `@lobehub/icons-static-svg` 1.95.1 (Lobe Icons) | MIT |
| App and integration marks: every other file in `svg/` | `@iconify-json/logos` 1.2.15 (SVG Logos by Gil Barbara) | CC0-1.0 |

To add one: copy the SVG into `svg/` named by its key, add the key to `mono.json` if it is a
single-colour mark, and add a row here.
