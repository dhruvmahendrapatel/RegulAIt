# Trained-detector service (ADR-0220, ADR-0247)

A reference scoring service for the gateway's **trained detectors**: a PII recogniser (Presidio and spaCy), a
prompt-injection classifier (PIGuard by default, ADR-0247) and a harm classifier (toxic-bert, reporting the labels in
`HARM_LABELS.md`). The two classifiers run on ONNX Runtime; there is no PyTorch in the running image. It speaks the ADR-0088 external-scorer contract, so the gateway reaches it exactly as it reaches
any registered external scorer: through the egress allow-list and the DNS-pinned guarded fetch.

```
POST /score   {"input": str, "output": str, "context": [], "scorerKind": "guardrail_pii" | "guardrail_prompt_injection" | "guardrail_harm"}
           -> {"score": 0..1, "reasons": ["email_address", ...]}     reasons are bare labels, never request text
GET  /healthz -> {"ok": true, "serves": [...]}
```

## Build (not in CI)

The image is about 1.7 GB (a ~410 MB Python environment and ~1.1 GB of ONNX weights), so CI does not build it. CI covers the gateway wiring
end to end against a stand-in service (`apps/gateway/src/zz-adr0220-trained-detectors.test.ts`) and this service's
pure core with fake models (`test_detector_core.py`).

```
# from the repository root, on a host that can reach huggingface.co, github.com and PyPI (build time only)
docker build -f agents/trained-detectors/Dockerfile -t regulait/trained-detectors:0.2.0 .
# or the alternative injection classifier (ADR-0247: fewer false positives on AgentDojo, JailbreakBench and web-agent text, far more on NotInject)
docker build -f agents/trained-detectors/Dockerfile --build-arg INJECTION_MODEL=protectai -t regulait/trained-detectors:0.2.0-protectai .
python3 -I -m unittest discover -s agents/trained-detectors -p 'test_*.py'
```

Every model file is verified against `models.lock.json` during the build; a mismatch fails it. The build's `export`
stage then turns each classifier into ONNX (`export_onnx.py`), offline, from stock Transformers classes only (it never
runs code shipped with a model), and fails unless the ONNX path gives the same token ids as Transformers and
probabilities within 1e-4 of PyTorch on fixed probes. The running container has no downloader, no PyTorch and no
Transformers, and sets `HF_HUB_OFFLINE=1` and `TRANSFORMERS_OFFLINE=1` as a second guard. For an air-gapped site, build where the files are reachable (or from a mirror) and move the image.

Updating a pin: change the revision in `models.lock.json`, recompute each file's sha256 from the Hub (the LFS sha256
for weights), regenerate `requirements.txt` and `export-requirements.txt` with the commands in their header comments,
re-run the ADR-0244 measurement (`eval_baselines.py`), and update `THIRD_PARTY.md` and ADR-0247's table.

## Run and connect

```
docker run -d --name trained-detectors -e DETECTOR_API_KEY=<random> -p 8080:8080 regulait/trained-detectors:0.1.0
```

`DETECTOR_MODELS=pii,harm` loads a subset. Then, in the admin console:

1. **Custom LLM providers → egress allow-list:** allow the service's host (private range and plain http only if it
   runs on your internal network without TLS).
2. **Quality & security → External scorers:** register `http://<host>:8080/score` with the same key, tick the guardrail kinds
   it serves, run the connection test, enable it.
3. **Policies & gates → Guardrails → Trained detectors:** turn each detector on and choose the service. The defaults are
   strict: mode `block`, and a failed or slow call is treated as a hit.

## Offline baseline (ADR-0244)

`eval_baselines.py` runs the injection classifier, through `server.load_models` and `detector_core.score_injection`,
over the vendored injection snapshots in `packages/shared/src/eval-datasets/vendor/injection-baselines/` and, with
`--write`, records its precision, recall and FPR in `injection-baselines.expected.json` (not gated in CI, because this
image is not built there). Run it after any change to the model pin, the windowing or the default threshold:

```sh
DETECTOR_MODELS_DIR=<dir filled by fetch_models.py> python3 eval_baselines.py --write
```

## Limits

- Measured on the five ADR-0244 baselines at threshold 0.5 (ADR-0247): PIGuard's pooled recall is 79.4% and its
  pooled benign false-positive rate 19.1% (ProtectAI: 77.8% and 30.0%). PIGuard is far better on NotInject's
  trigger-word prompts (11.5% against 43.4%) but worse on JailbreakBench's benign prompts (26.0% against 1.0%) and on
  RegulAIt's web-agent set (72.0% against 50.0%); no model here is usable on web-agent content as it stands.
- English only. The models catch what they were trained on; they miss novel phrasings and can fire on benign text
  that discusses these topics. The rule-based detectors always run beside them.
- Long text is scored in overlapping windows of about 1,500 characters, so very long inputs take longer; the gateway's
  per-call time limit (2 s by default) turns an overrun into a failure, which fails closed by default.
- Each window is cut at 512 tokens. English text of 1,500 characters fits, but dense text (CJK, long runs of digits or
  symbols) can exceed 512 tokens, and the end of that window is then not scored by the two classifiers. Token-based
  windows with a stride are a recorded follow-up.
- One request at a time per instance (a lock around inference), which limits throughput under load. Scale by running
  more instances behind a load balancer.
- No network at run time, including the PII path: Presidio's email recogniser uses tldextract, whose default extractor
  downloads the Public Suffix List on first use. The service replaces it, before any recogniser is built, with one that
  has no URLs and no cache and so always uses the list bundled in the pinned wheel (`pin_offline_public_suffix_list`,
  tested with every socket refused).
- Groundedness is not served yet (see `THIRD_PARTY.md`).
