<!-- fold: pending -->

- **ADR-0352 follow-ups (lane E33 slice 1).** (a) Admin screens: the Model credentials and Register an agent forms do
  not yet offer `bedrock`, `vertex`, `mistral`, `cohere` or `qwen`, and a Bedrock/Vertex secret is a JSON document that
  needs its own input (design builder, #453; the API is complete). (b) BYOC workload identity: an opt-in, audited org
  setting to let Bedrock use the AWS default credential chain (instance role, IRSA) and Vertex use workload identity
  instead of a stored key; ambient by nature, so off by default like the env fallback. (c) Verify `thinking` and
  structured output per vendor against live endpoints, then add each to the ADR-0020 capability sets.
