<!-- fold: pending -->

- **ADR-0352 slice 2 follow-ups (lane E33).** (a) Admin screen for the meaning-based tier's three org settings and the
  `text_embedding` embedder registration (design builder, #453; API complete). (b) Decide whether the OpenAI/Anthropic
  compat path gets the tier, and which part of a message list is compared by meaning (its key commits to the whole
  request, ADR-0136). (c) Bring `semantic_cache` and `semantic_cache_embeddings` under row-level security in the
  ADR-0234 user-owned batch. (d) Measure hit rate and false-match rate on a real paraphrase set before recommending a
  bar below 0.95.
