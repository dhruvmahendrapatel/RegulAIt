/**
 * ADR-0172 — the "Try it" code samples for one model binding, against the
 * gateway's OpenAI-compatible POST /v1/chat/completions and Anthropic-shaped
 * POST /v1/messages (compat-openai.ts / compat-anthropic.ts).
 *
 * Two facts about those routes shape every sample:
 *  - the compat surfaces resolve `model` against the registry's provider model
 *    id (compat-core.ts "model_match"), and several bindings may share one —
 *    so each sample also sends `x-regulait-agent-id`, which pins THIS binding
 *    exactly (the "agent_header" resolution) instead of the tie-break;
 *  - the key is ALWAYS a placeholder read from the environment
 *    (REGULAIT_API_KEY). A sample never carries a real credential.
 */

export type SnippetTab = "curl" | "typescript" | "python" | "anthropic";

export const SNIPPET_TABS: Array<{ id: SnippetTab; label: string }> = [
  { id: "curl", label: "cURL" },
  { id: "typescript", label: "TypeScript" },
  { id: "python", label: "Python" },
  { id: "anthropic", label: "Anthropic SDK" },
];

export const KEY_ENV = "REGULAIT_API_KEY";
export const AGENT_HEADER = "x-regulait-agent-id";

export interface SnippetInput {
  /** the console's own origin, e.g. https://regulait.example.com */
  base: string;
  agentId: string;
  /** the binding's provider model id; null for a routing-only binding */
  model: string | null;
  /** the binding's name — the fallback model string when no model id is set */
  name: string;
  prompt: string;
}

/** a JSON string literal — also a valid TypeScript and Python string literal */
const lit = (s: string) => JSON.stringify(s);
/** text safe inside a POSIX single-quoted shell argument */
const shq = (s: string) => s.replace(/'/g, `'\\''`);

export function buildSnippets(input: SnippetInput): Record<SnippetTab, string> {
  const base = input.base.replace(/\/+$/, "");
  const model = input.model ?? input.name;
  const prompt = input.prompt.trim() || "Hello";
  const body = JSON.stringify({ model, messages: [{ role: "user", content: prompt }] });
  const anthropicBody = JSON.stringify({ model, max_tokens: 1024, messages: [{ role: "user", content: prompt }] });

  const curl =
    `curl ${base}/v1/chat/completions \\\n` +
    `  -H "Authorization: Bearer $${KEY_ENV}" \\\n` +
    `  -H "${AGENT_HEADER}: ${input.agentId}" \\\n` +
    `  -H "content-type: application/json" \\\n` +
    `  -d '${shq(body)}'\n` +
    `\n# Anthropic-shaped instead:\n` +
    `curl ${base}/v1/messages \\\n` +
    `  -H "x-api-key: $${KEY_ENV}" \\\n` +
    `  -H "${AGENT_HEADER}: ${input.agentId}" \\\n` +
    `  -H "content-type: application/json" \\\n` +
    `  -d '${shq(anthropicBody)}'`;

  const typescript =
    `import OpenAI from "openai";\n\n` +
    `const client = new OpenAI({\n` +
    `  apiKey: process.env.${KEY_ENV},\n` +
    `  baseURL: ${lit(`${base}/v1`)},\n` +
    `  defaultHeaders: { ${lit(AGENT_HEADER)}: ${lit(input.agentId)} },\n` +
    `});\n\n` +
    `const completion = await client.chat.completions.create({\n` +
    `  model: ${lit(model)},\n` +
    `  messages: [{ role: "user", content: ${lit(prompt)} }],\n` +
    `});\n\n` +
    `console.log(completion.choices[0]?.message.content);`;

  const python =
    `import os\n` +
    `from openai import OpenAI\n\n` +
    `client = OpenAI(\n` +
    `    api_key=os.environ[${lit(KEY_ENV)}],\n` +
    `    base_url=${lit(`${base}/v1`)},\n` +
    `    default_headers={${lit(AGENT_HEADER)}: ${lit(input.agentId)}},\n` +
    `)\n\n` +
    `completion = client.chat.completions.create(\n` +
    `    model=${lit(model)},\n` +
    `    messages=[{"role": "user", "content": ${lit(prompt)}}],\n` +
    `)\n\n` +
    `print(completion.choices[0].message.content)`;

  const anthropic =
    `import Anthropic from "@anthropic-ai/sdk";\n\n` +
    `const client = new Anthropic({\n` +
    `  apiKey: process.env.${KEY_ENV},\n` +
    `  baseURL: ${lit(base)}, // the SDK appends /v1/messages\n` +
    `  defaultHeaders: { ${lit(AGENT_HEADER)}: ${lit(input.agentId)} },\n` +
    `});\n\n` +
    `const message = await client.messages.create({\n` +
    `  model: ${lit(model)},\n` +
    `  max_tokens: 1024,\n` +
    `  messages: [{ role: "user", content: ${lit(prompt)} }],\n` +
    `});\n\n` +
    `console.log(message.content);`;

  return { curl, typescript, python, anthropic };
}
