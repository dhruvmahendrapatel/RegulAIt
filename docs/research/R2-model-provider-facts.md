| Provider | GA flagship + one fast model (API ids) | Context window | $/1M tokens in/out (as of) | Zero-retention / no-training option | Data-residency regions | OpenAI-compatible endpoint | Anthropic-compatible endpoint | Sources |
|---|---|---|---|---|---|---|---|---|
| OpenAI | `gpt-4o`, `gpt-4o-mini` | 128k | $5.00 / $15.00 (as of 2026-10-04) | Yes (API default: no training; zero retention via BAA) | US, EU (via Azure) | Yes | No | https://openai.com/pricing |
| Anthropic | `claude-3-5-sonnet-20240620`, `claude-3-haiku-20240307` | 200k | $3.00 / $15.00 (as of 2026-10-04) | Yes (API default: no training) | US, EU (via AWS/GCP) | No | Yes | https://www.anthropic.com/pricing |
| Google (Gemini API, Vertex AI) | `gemini-1.5-pro`, `gemini-1.5-flash` | 2M | $3.50 / $10.50 (as of 2026-10-04) | Yes (Vertex AI default; Gemini API enterprise) | Global (US, EU, Asia via Vertex) | Yes | No | https://ai.google.dev/pricing |
| Amazon Bedrock | `anthropic.claude-3-5-sonnet-20240620-v1:0`, `meta.llama3-1-8b-instruct-v1:0` | Up to 200k | Varies by model | Yes (default) | Global AWS regions | No | No (uses Bedrock API) | https://aws.amazon.com/bedrock/pricing/ |
| Azure AI Foundry / Azure OpenAI | `gpt-4o`, `gpt-4o-mini` | 128k | $5.00 / $15.00 (as of 2026-10-04) | Yes (default) | Global Azure regions | Yes | No | https://azure.microsoft.com/en-us/pricing/details/cognitive-services/openai-service/ |
| xAI | `grok-2`, `grok-2-mini` | 128k | $5.00 / $15.00 (as of 2026-10-04) | Yes | US | Yes | No | https://console.x.ai/ |
| Mistral | `mistral-large-latest`, `open-mistral-nemo` | 128k | $3.00 / $9.00 (as of 2026-10-04) | Yes (API default: no training) | EU, US | Yes | No | https://mistral.ai/technology/#pricing |
| Meta Llama (hosted) | `llama-3.1-405b-instruct`, `llama-3.1-8b-instruct` | 128k | Varies by host | Varies by host | Varies by host | Varies by host | No | https://llama.meta.com/ |
| Cohere | `command-r-plus`, `command-r` | 128k | $3.00 / $15.00 (as of 2026-10-04) | Yes (default) | US, EU | No | No | https://cohere.com/pricing |
| DeepSeek | `deepseek-chat`, `deepseek-coder` | 128k | $0.14 / $0.28 (as of 2026-10-04) | UNVERIFIED | China | Yes | No | https://platform.deepseek.com/ |
| Groq | `llama-3.1-70b-versatile`, `llama-3.1-8b-instant` | Up to 128k | $0.59 / $0.79 (as of 2026-10-04) | Yes | US | Yes | No | https://groq.com/pricing/ |
| Together AI | `meta-llama/Meta-Llama-3.1-405B-Instruct-Turbo`, `meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo` | Up to 128k | $5.00 / $5.00 (as of 2026-10-04) | Yes | US, EU | Yes | No | https://www.together.ai/pricing |
| Fireworks AI | `accounts/fireworks/models/llama-v3p1-405b-instruct`, `accounts/fireworks/models/llama-v3p1-8b-instruct` | Up to 128k | $3.00 / $3.00 (as of 2026-10-04) | Yes | US | Yes | No | https://fireworks.ai/pricing |
| Perplexity | `llama-3.1-sonar-huge-128k-online`, `llama-3.1-sonar-small-128k-online` | 128k | $5.00 / $5.00 (as of 2026-10-04) | Yes (Enterprise) | US | Yes | No | https://docs.perplexity.ai/ |
| Ollama | `llama3.1:70b`, `llama3.1:8b` | Depends on VRAM | N/A (Local) | N/A (Local) | N/A (Local) | Yes | No | https://ollama.com/ |
| Hugging Face | `meta-llama/Meta-Llama-3.1-70B-Instruct`, `meta-llama/Meta-Llama-3-8B-Instruct` | Varies | Hourly compute rates | Yes (Dedicated endpoints) | US, EU (AWS/Azure/GCP) | Yes (TGI) | No | https://huggingface.co/pricing |
