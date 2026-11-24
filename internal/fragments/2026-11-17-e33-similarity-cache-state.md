<!-- fold: state-recap -->
**E33 slice 2 (2026-11-17) - a meaning-based cache tier behind the exact semantic cache ([ADR-0352](../decisions/0352-gateway-parity-provider-breadth-semantic-cache-streaming.md)).**
Off by default (three new org settings; turning it on needs an enabled `text_embedding` embedder). The partition is
mandatory: the same user, agent, project, options and serving configuration, with only the input compared by meaning
(cosine ≥ 0.95 by default). Every hit runs the live gates through the same governed hit path as an exact hit. The
embedder is the ADR-0247 ONNX sidecar with a new opt-in model (all-MiniLM-L6-v2) and `/embed` route, registered as an
external scorer; the gateway refuses any embedder that does not resolve to private or loopback addresses. Vectors live
in the existing Postgres (`semantic_cache_embeddings`, purged with their cache row). Migration
`pending/semantic_cache_similarity.sql`, numbered at merge. No new route.
