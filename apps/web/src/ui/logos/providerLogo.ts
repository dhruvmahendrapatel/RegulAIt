/**
 * The logo key for a model provider kind (agents.provider), shared by every
 * model picker. Unknown kinds (custom endpoints, the mock provider) return
 * null, which <Logo> renders as a monogram from the label.
 */
const PROVIDER_LOGO: Record<string, string> = {
  anthropic: "anthropic",
  openai: "openai",
  google: "gemini",
  gemini: "gemini",
  vertex: "vertexai",
  vertexai: "vertexai",
  bedrock: "bedrock",
  aws: "aws",
  azure: "azureai",
  azure_openai: "azureai",
  xai: "xai",
  grok: "grok",
  mistral: "mistral",
  meta: "meta",
  llama: "meta",
  cohere: "cohere",
  deepseek: "deepseek",
  ollama: "ollama",
  huggingface: "huggingface",
  perplexity: "perplexity",
  groq: "groq",
  together: "together",
  fireworks: "fireworks",
  qwen: "qwen",
};

export function providerLogoKey(provider: string | null | undefined): string | null {
  if (!provider) return null;
  return PROVIDER_LOGO[provider.toLowerCase()] ?? null;
}
