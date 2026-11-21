<!-- fold: state-recap -->
**E33 slice 1 (2026-11-17) - native Bedrock, Vertex, Mistral, Cohere and Qwen adapters ([ADR-0352](../decisions/0352-gateway-parity-provider-breadth-semantic-cache-streaming.md)).**
Five new provider kinds on each vendor's `@ai-sdk/*` implementation, through the ADR-0253 bridge and the one governed
dispatch core (entitlement, budget, cost attribution and audit unchanged; an end-to-end test against a fake Bedrock
endpoint proves it). Bedrock signs with the AWS SDK's signer (`@smithy/signature-v4`) or uses a Bedrock API key; Vertex
takes a service-account key (token minted through the guarded fetch) or an express-mode key. Credentials live in the
existing encrypted, rotatable, audited store and are shape-checked when typed; no SDK ever reads an ambient credential.
Bedrock and Vertex service accounts require an explicit, allow-listed baseUrl (ADR-0062). Mistral, Cohere and Qwen join
the env fallback (still off by default; the new kinds are not in the default allowed list). No migration, no new route.
