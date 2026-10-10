/**
 * VENDORED DATA — promptfoo's OWASP framework mapping tables (ADR-0173 batch 2c;
 * ADR-0177 row 5, option C: "its framework mapping tables").
 *
 * Source:   github.com/promptfoo/promptfoo, file `src/redteam/constants/frameworks.ts`
 * Version:  npm `promptfoo@0.124.1`, release tag `0.124.1` = commit
 *           421e7959642c5d4cc1c983259a268de1c6f847b9 (this release publishes no
 *           gitHead; the tag was read from the upstream repository). The file is
 *           byte-identical at release 0.123.1 (commit
 *           34f74d34e140b5e17d23770dfb2340057b1936b8, first vendored from there);
 *           ADR-0187 decision 176.
 * File sha256 (the whole upstream file at that commit):
 *           9c78fc85fd9ca20d2b5dec59c8c3564663c2b7a6ed4121e5ebc27f22f2e7db45
 * Licence:  MIT (reproduced below). Recorded in packages/shared/THIRD_PARTY.md.
 *
 * WHAT IS VENDORED, AND HOW. Four declarations are copied VERBATIM, comments
 * included: OWASP_LLM_TOP_10_NAMES, OWASP_AGENTIC_NAMES,
 * OWASP_LLM_TOP_10_MAPPING and OWASP_AGENTIC_TOP_10_MAPPING (upstream lines
 * 20-31, 46-64, 74-173 and 221-292). The only edits are the type annotations:
 * upstream's `Record<string, { plugins: Plugin[]; strategies: Strategy[] }>` is
 * written against its own plugin and strategy unions, which are not vendored,
 * so here it is `Readonly<Record<string, PromptfooFrameworkMapping>>` with plain
 * strings. No value is changed.
 *
 * WHAT IT IS USED FOR. The OWASP ids and names (`owasp:llm:01`…`owasp:llm:10`,
 * `owasp:agentic:asi01`…`asi10`) are the vocabulary our evaluator catalog cites
 * (src/evaluator-catalog.ts); a catalog reference to an OWASP id that is not a
 * key here fails a test. The plugin and strategy lists are upstream's own
 * mapping of ITS test plugins onto those ids, kept so the provenance is whole;
 * our catalog maps OUR scorers, detectors and red-team classes itself and does
 * not derive anything from upstream's plugin names. This is data only: no
 * upstream code runs, and nothing here touches the network.
 *
 * Do not edit by hand. To update: re-read the file at a newer pinned release,
 * re-copy the same four declarations, and update the commit, the hash and the
 * THIRD_PARTY.md row together.
 *
 * ---- upstream licence ----
 * Copyright (c) Promptfoo 2025
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

/** upstream's mapping value shape, with its plugin/strategy unions widened to strings */
export interface PromptfooFrameworkMapping {
  plugins: readonly string[];
  strategies: readonly string[];
}

export const PROMPTFOO_FRAMEWORKS_SOURCE = {
  project: "promptfoo",
  repository: "https://github.com/promptfoo/promptfoo",
  file: "src/redteam/constants/frameworks.ts",
  release: "0.124.1",
  commit: "421e7959642c5d4cc1c983259a268de1c6f847b9",
  fileSha256: "9c78fc85fd9ca20d2b5dec59c8c3564663c2b7a6ed4121e5ebc27f22f2e7db45",
  licence: "MIT",
} as const;

export const OWASP_LLM_TOP_10_NAMES: readonly string[] = [
  'Prompt Injection',
  'Sensitive Information Disclosure',
  'Supply Chain',
  'Data and Model Poisoning',
  'Improper Output Handling',
  'Excessive Agency',
  'System Prompt Leakage',
  'Vector and Embedding Weaknesses',
  'Misinformation',
  'Unbounded Consumption',
];

/**
 * OWASP Top 10 for Agentic Applications (December 2025)
 * The official OWASP Top 10 list for AI agent security risks.
 * Announced during Black Hat Europe 2025 and the OWASP Agentic Security Summit.
 *
 * @see https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications/
 */
export const OWASP_AGENTIC_NAMES: readonly string[] = [
  'ASI01: Agent Goal Hijack',
  'ASI02: Tool Misuse and Exploitation',
  'ASI03: Identity and Privilege Abuse',
  'ASI04: Agentic Supply Chain Vulnerabilities',
  'ASI05: Unexpected Code Execution',
  'ASI06: Memory and Context Poisoning',
  'ASI07: Insecure Inter-Agent Communication',
  'ASI08: Cascading Failures',
  'ASI09: Human Agent Trust Exploitation',
  'ASI10: Rogue Agents',
];

export const OWASP_LLM_TOP_10_MAPPING: Readonly<Record<string, PromptfooFrameworkMapping>> = {
  'owasp:llm:01': {
    // Prompt Injection
    plugins: ['ascii-smuggling', 'indirect-prompt-injection', 'prompt-extraction', 'harmful'],
    strategies: ['jailbreak', 'jailbreak-templates', 'jailbreak:composite'],
  },
  'owasp:llm:02': {
    // Sensitive Information Disclosure
    plugins: [
      'pii:api-db',
      'pii:direct',
      'pii:session',
      'pii:social',
      'harmful:privacy',
      'cross-session-leak',
      'prompt-extraction',
    ],
    strategies: ['jailbreak', 'jailbreak-templates', 'jailbreak:composite'],
  },
  'owasp:llm:03': {
    // Supply Chain
    plugins: [],
    strategies: [],
  },
  'owasp:llm:04': {
    // Data and Model Poisoning
    plugins: [
      'harmful:misinformation-disinformation',
      'harmful:hate',
      'bias:age',
      'bias:disability',
      'bias:gender',
      'bias:race',
      'harmful:radicalization',
      'harmful:specialized-advice',
    ],
    strategies: ['jailbreak', 'jailbreak-templates', 'jailbreak:composite'],
  },
  'owasp:llm:05': {
    // Improper Output Handling
    plugins: ['shell-injection', 'sql-injection', 'ssrf', 'debug-access'],
    strategies: ['jailbreak', 'jailbreak-templates'],
  },
  'owasp:llm:06': {
    // Excessive Agency
    plugins: [
      'excessive-agency',
      'rbac',
      'bfla',
      'bola',
      'shell-injection',
      'sql-injection',
      'ssrf',
    ],
    strategies: ['jailbreak', 'jailbreak-templates', 'jailbreak:composite'],
  },
  'owasp:llm:07': {
    // System Prompt Leakage
    plugins: [
      'prompt-extraction',
      'rbac',
      'harmful:privacy',
      'pii:api-db',
      'pii:direct',
      'pii:session',
      'pii:social',
    ],
    strategies: ['jailbreak', 'jailbreak-templates', 'jailbreak:composite'],
  },
  'owasp:llm:08': {
    // Vector and Embedding Weaknesses
    plugins: [
      'cross-session-leak',
      'harmful:privacy',
      'pii:api-db',
      'pii:direct',
      'pii:session',
      'pii:social',
    ],
    strategies: ['jailbreak', 'jailbreak-templates', 'jailbreak:composite'],
  },
  'owasp:llm:09': {
    // Misinformation
    plugins: [
      'hallucination',
      'overreliance',
      'harmful:misinformation-disinformation',
      'harmful:specialized-advice',
    ],
    strategies: ['jailbreak', 'jailbreak-templates', 'jailbreak:composite'],
  },
  'owasp:llm:10': {
    // Unbounded Consumption
    plugins: ['divergent-repetition', 'reasoning-dos'],
    strategies: [],
  },
};

/**
 * OWASP Top 10 for Agentic Applications (December 2025)
 * The official OWASP Top 10 list for AI agent security risks.
 * Announced during Black Hat Europe 2025 and the OWASP Agentic Security Summit.
 *
 * @see https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications/
 */
export const OWASP_AGENTIC_TOP_10_MAPPING: Readonly<Record<string, PromptfooFrameworkMapping>> = {
  'owasp:agentic:asi01': {
    // ASI01: Agent Goal Hijack
    // Occurs when an attacker alters an agent's objectives or decision path through malicious content
    plugins: ['hijacking', 'system-prompt-override', 'indirect-prompt-injection', 'intent'],
    strategies: ['jailbreak', 'jailbreak-templates', 'jailbreak:composite'],
  },
  'owasp:agentic:asi02': {
    // ASI02: Tool Misuse and Exploitation
    // Occurs when an agent uses legitimate tools in unsafe ways
    plugins: ['excessive-agency', 'mcp', 'tool-discovery'],
    strategies: ['jailbreak', 'jailbreak-templates'],
  },
  'owasp:agentic:asi03': {
    // ASI03: Identity and Privilege Abuse
    // Agents inherit user/system identities with high-privilege credentials
    plugins: ['rbac', 'bfla', 'bola', 'imitation'],
    strategies: ['jailbreak', 'jailbreak-templates'],
  },
  'owasp:agentic:asi04': {
    // ASI04: Agentic Supply Chain Vulnerabilities
    // Compromised tools, plugins, prompt templates, and external servers
    plugins: ['indirect-prompt-injection', 'mcp'],
    strategies: ['jailbreak-templates'],
  },
  'owasp:agentic:asi05': {
    // ASI05: Unexpected Code Execution
    // Agents generate or run code/commands unsafely
    plugins: ['shell-injection', 'sql-injection', 'harmful:cybercrime:malicious-code', 'ssrf'],
    strategies: ['jailbreak', 'jailbreak-templates'],
  },
  'owasp:agentic:asi06': {
    // ASI06: Memory and Context Poisoning
    // Attackers poison agent memory systems, embeddings, and RAG databases
    plugins: ['agentic:memory-poisoning', 'cross-session-leak', 'indirect-prompt-injection'],
    strategies: ['jailbreak', 'crescendo'],
  },
  'owasp:agentic:asi07': {
    // ASI07: Insecure Inter-Agent Communication
    // Multi-agent systems face spoofed identities, replayed messages, tampering
    plugins: ['indirect-prompt-injection', 'hijacking', 'imitation'],
    strategies: ['jailbreak-templates'],
  },
  'owasp:agentic:asi08': {
    // ASI08: Cascading Failures
    // Small errors in one agent propagate across planning, execution, memory
    plugins: ['hallucination', 'harmful:misinformation-disinformation', 'divergent-repetition'],
    strategies: ['jailbreak', 'jailbreak-templates'],
  },
  'owasp:agentic:asi09': {
    // ASI09: Human Agent Trust Exploitation
    // Users over-trust agent recommendations or explanations
    plugins: ['overreliance', 'imitation', 'harmful:misinformation-disinformation'],
    strategies: ['crescendo'],
  },
  'owasp:agentic:asi10': {
    // ASI10: Rogue Agents
    // Compromised or misaligned agents act harmfully while appearing legitimate
    plugins: ['excessive-agency', 'hijacking', 'rbac', 'goal-misalignment'],
    strategies: ['jailbreak', 'crescendo'],
  },
};
